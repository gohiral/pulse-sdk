// Reporter updates — the reporter sees what happened to their feedback
// without leaving the app: a dot on the FAB, a one-line peek for questions
// and fixes, and a reports panel (list + timeline with replies, emoji
// reactions on the team's messages and the "Works now" / "Still broken"
// verdict).
//
// Runs only when the host signs the reporter (`data-reporter-token`, from
// HI_PULSE_SECRET). Holds one Phoenix socket to `<server>/widget`, joins
// "reports" and keeps the reporter's reports in memory; the server pushes
// a "report" event whenever one changes. Phoenix reconnects on its own.
//
// `import { Socket } from "phoenix"` resolves through the host's esbuild
// NODE_PATH (stock Phoenix apps include deps/). Decisions about what to show
// live in reporter_view.js so they can be tested without a browser.

import { Socket } from "phoenix";
import {
  EMOJI,
  QUICK_REACTIONS,
  canReact,
  clip,
  dotStatus,
  escapeHTML,
  filterEmoji,
  firstEmoji,
  fmt,
  formatDate,
  freshTeamReactions,
  teamReactions,
  hasUpdate,
  isTypingTarget,
  joinPeek,
  labelFor,
  latestTeamMessage,
  livePeek,
  mergePeek,
  openQuestion,
  reactionGroups,
  readDeepLink,
  stripDeepLink,
  relativeTime,
  resolvePeek,
  socketUrl,
  sortReports,
  stepReactions,
  timeline,
  toggleReaction,
  unseenCount,
  unseenSteps,
  unshownTeamReactions,
  upsertReport,
  verdictNodeKey,
  withoutStep,
  withReactions,
  withStep,
  changedReports,
} from "./reporter_view.js";

const JOIN_PEEK_DELAY_MS = 2000;
const PEEK_AUTO_HIDE_MS = 10000;
const TYPING_GRACE_MS = 1000;
// Phoenix's default reconnect schedule.
const RECONNECT_MS = [10, 50, 100, 150, 200, 250, 500, 1000, 2000];
const WIDGET_SURFACES = ".fb-form-panel, .fb-reports-panel, .fb-peek, .fb-overlay";
// A team reaction stays on the FAB this long (hover pauses it).
const REACTION_MS = 5000;
const REACTION_LEAVE_MS = 260;
const REACTION_GAP_MS = 600;
// Team reactions the FAB already showed, so a page load doesn't replay them.
const SHOWN_REACTIONS_KEY = "hi-pulse-shown-reactions";

export class ReporterUpdates {
  // `host` is the PulseWidgetHook seam: corner(), formOpen(), closeForm(),
  // openForm(), toast(message), keepScroll(fn), onChange().
  constructor({ serverUrl, token, reporterToken, fab, T, host }) {
    this.T = T;
    this.fab = fab;
    this.host = host;
    this.reports = [];
    this.joined = false;
    this.connected = false;
    this.everConnected = false;
    this.panel = null;
    this.view = null;
    this.newStepIds = new Set();
    this.drafts = new Map();
    // Drafts of the answer field inside an open question, by report id.
    this.answerDrafts = new Map();
    // The answer field last scrolled into view ("<report id>|<question id>").
    this.revealedAnswer = null;
    this.verdict = null;
    // The emoji picker, open on one team message:
    // `{stepId, more, query}` ("…" expanded, the search text).
    this.picking = null;
    this.pendingPeek = null;
    this.shownPeek = null;
    this.releaseTitles = new Set();
    this.timers = {};
    this.listeners = [];
    // Team reactions waiting for the FAB, and the one on it now.
    this.reactionQueue = [];
    this.reaction = null;
    this.shownReactions = loadShownReactions();

    this._buildDot();
    this._buildPeek();
    this._buildAnnouncer();
    this._listen(fab, "mouseenter", () => this._pauseReaction());
    this._listen(fab, "mouseleave", () => this._resumeReaction());
    this._listen(fab, "focus", () => this._pauseReaction());
    this._listen(fab, "blur", () => this._resumeReaction());
    this._listen(document, "focusin", (e) => {
      if (isTypingTarget(e.target)) this._clearTimer("typing");
    });
    this._listen(document, "focusout", () => {
      if (this.pendingPeek) this._setTimer("typing", () => this._tryShowPeek(), TYPING_GRACE_MS);
    });
    this._listen(document, "visibilitychange", () => this._onAttention());
    this._listen(window, "focus", () => this._onAttention());
    this._listen(window, "blur", () => this._onAttention());
    this._listen(document, "keydown", (e) => this._onKeydown(e));
    // A click anywhere outside the open picker closes it.
    this._listen(document, "click", (e) => {
      if (this.picking && !e.target.closest(".fb-pick, [data-action='rx-open']")) this._closePicker(false);
    });
    this._connect(serverUrl, token, reporterToken);
  }

  destroy() {
    this.pendingPeek = null;
    Object.keys(this.timers).forEach((name) => this._clearTimer(name));
    this.listeners.forEach(([target, type, fn]) => target.removeEventListener(type, fn));
    this.listeners = [];
    if (this.socket) this.socket.disconnect();
    this.socket = null;
    this.channel = null;
    this.closePanel({ handoff: true });
    this._endReaction({ animate: false });
    this.reactionQueue = [];
    this.peekEl?.remove();
    this.dot?.remove();
    this.announcer?.remove();
  }

  // ---------------------------------------------------------------------------
  // Queries for the hook
  // ---------------------------------------------------------------------------

  get panelOpen() {
    return this.panel !== null;
  }

  hasReports() {
    return this.reports.length > 0;
  }

  unseenCount() {
    return unseenCount(this.reports);
  }

  // The FAB dot's colour key, or null without unseen updates. The form's
  // "Your reports" button repeats it, since the FAB hides its dot while
  // a panel is open.
  dotStatus() {
    return dotStatus(this.reports);
  }

  get reactionShowing() {
    return this.reaction !== null;
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  _connect(serverUrl, token, reporterToken) {
    const url = socketUrl(serverUrl);
    if (!url || !token || !reporterToken) return;
    const socket = new Socket(url, {
      params: { token, reporter: reporterToken },
      // A socket that never opened is most likely refused (wrong token or
      // secret): back off to once a minute instead of knocking every 5s.
      reconnectAfterMs: (tries) =>
        this.everConnected
          ? RECONNECT_MS[tries - 1] || 5000
          : Math.min(60_000, 1000 * 2 ** tries),
    });
    socket.onOpen(() => {
      this.everConnected = true;
      this._setConnected(true);
    });
    socket.onError(() => this._setConnected(false));
    socket.onClose(() => this._setConnected(false));

    // A deep-linked report is asked for explicitly: it may be older than
    // the newest reports the join lists.
    const channel = socket.channel("reports", () => {
      const include = readDeepLink(window.location);
      return include ? { include } : {};
    });
    channel.on("report", (payload) => this._onPush(payload));
    channel.join().receive("ok", (reply) => this._onJoin(reply));
    socket.connect();
    this.socket = socket;
    this.channel = channel;
  }

  _setConnected(connected) {
    this.connected = connected;
    const conn = this.panel?.querySelector(".fb-conn");
    if (conn) conn.hidden = connected || !this.everConnected;
  }

  // The join reply carries every report; on a rejoin after a dropped
  // connection, whatever changed meanwhile is treated like a live push.
  _onJoin({ reports } = {}) {
    const previous = this.reports;
    this.reports = sortReports(reports);
    if (this.joined) {
      changedReports(previous, this.reports).forEach(({ prev, next }) =>
        this._notify(prev, next, "update"),
      );
      // A reaction doesn't change a report's signature: catch up on any
      // that came while the socket was down.
      this._queueReactions(unshownTeamReactions(this.reports, this.shownReactions, Date.now()));
    } else {
      this.joined = true;
      if (!this._openDeepLink()) {
        const peek = joinPeek(this.reports);
        if (peek) this._setTimer("joinPeek", () => this._queuePeek(peek), JOIN_PEEK_DELAY_MS);
      }
      this._queueReactions(unshownTeamReactions(this.reports, this.shownReactions, Date.now()));
    }
    this._changed();
  }

  _onPush({ report, cause } = {}) {
    if (!report?.id) return;
    const prev = this.reports.find((r) => r.id === report.id);
    this.reports = upsertReport(this.reports, report);
    this._notify(prev, report, cause);
    this._changed();
  }

  _notify(prev, report, cause) {
    this._queueReactions(freshTeamReactions(prev, report));
    if (this._viewing(report.id)) {
      // Open in front of the reporter: "New" moves to this update (the
      // earlier ones were seen here) and it is marked seen.
      const fresh = unseenSteps(report);
      if (fresh.length) this.newStepIds = new Set(fresh.map((s) => s.id));
      this._markSeen(report);
      return;
    }
    const kind = livePeek(prev, report, cause);
    if (!kind) return;
    if (kind === "release" && this._fillReleaseNote(report)) return;
    this._queuePeek({ kind: kind === "release" ? "fixed" : kind, id: report.id });
  }

  // Promise over a channel push; resolves with the server's Report.
  _push(event, payload) {
    return new Promise((resolve, reject) => {
      if (!this.channel) return reject(new Error("not connected"));
      this.channel
        .push(event, payload)
        .receive("ok", ({ report } = {}) => resolve(report))
        .receive("error", (err) => reject(err))
        .receive("timeout", () => reject(new Error("timeout")));
    });
  }

  _accept(report) {
    if (!report?.id) return;
    this.reports = upsertReport(this.reports, report);
    this._changed();
  }

  _markSeen(report) {
    if (!(report.unseen || hasUpdate(report)) || document.visibilityState !== "visible") return;
    this._push("seen", { id: report.id })
      .then((updated) => this._accept(updated))
      .catch(() => {
        // Stays unseen; the next open retries.
      });
  }

  // Back in the tab: a held peek or reaction can rise, an open timeline
  // marks itself seen.
  _onAttention() {
    this._tryShowPeek();
    // A reaction on the FAB waits while nobody is looking.
    if (document.visibilityState === "visible" && document.hasFocus()) {
      if (!this.fab.matches(":hover")) this._resumeReaction();
    } else {
      this._pauseReaction();
    }
    this._tryPlayReaction();
    if (this.view?.name === "report") {
      const report = this._report(this.view.id);
      if (report) this._markSeen(report);
    }
  }

  // ---------------------------------------------------------------------------
  // State changes → FAB dot, open panel, peek, host link
  // ---------------------------------------------------------------------------

  _changed() {
    this._renderDot();
    if (this.panel) this._renderPanel();
    if (this.shownPeek && !resolvePeek(this.shownPeek, this.reports)) this._hidePeek();
    this.host.onChange();
  }

  _buildDot() {
    const dot = document.createElement("span");
    dot.className = "fb-fab-dot";
    dot.hidden = true;
    dot.setAttribute("aria-hidden", "true");
    this.fab.appendChild(dot);
    this.dot = dot;
  }

  _renderDot() {
    const { T } = this;
    const status = dotStatus(this.reports);
    this.dot.hidden = !status;
    this.dot.dataset.status = status || "";
    const count = unseenCount(this.reports);
    const label = count === 0 ? T.fab : count === 1 ? T.fabUpdate : fmt(T.fabUpdates, { count });
    this.fab.setAttribute("aria-label", label);
  }

  // ---------------------------------------------------------------------------
  // Release note — fills the host's reload banner when a release ships a fix
  // ---------------------------------------------------------------------------

  _fillReleaseNote(report) {
    const slot = document.querySelector("[data-hi-pulse-release-note]");
    if (!slot) return false;
    this.releaseTitles.add(report.title);
    const dot = document.createElement("span");
    dot.className = "fb-status-dot";
    dot.dataset.status = "fixed";
    dot.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = fmt(this.T.releaseNote, { title: [...this.releaseTitles].join(", ") });
    slot.classList.add("fb-release-note");
    slot.replaceChildren(dot, text);
    slot.hidden = false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Peek — one card above the FAB, held while the user types elsewhere
  // ---------------------------------------------------------------------------

  // The live region exists from the start so screen readers announce what
  // gets written into it.
  _buildPeek() {
    const el = document.createElement("div");
    el.className = "fb-peek";
    el.setAttribute("role", "status");
    el.hidden = true;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".fb-peek-card")) this._openPeek();
    });
    el.addEventListener("mouseenter", () => this._clearTimer("peekHide"));
    el.addEventListener("mouseleave", () => this._scheduleAutoHide());
    el.addEventListener("focusin", () => this._clearTimer("peekHide"));
    el.addEventListener("focusout", () => this._scheduleAutoHide());
    document.body.appendChild(el);
    this.peekEl = el;
    this.applyCorner();
  }

  _queuePeek(next) {
    this.pendingPeek = mergePeek(this.pendingPeek || this.shownPeek, next);
    if (this.shownPeek) this._hidePeek();
    this._tryShowPeek();
  }

  // Shows the pending peek once the moment is right: no widget surface
  // open, the tab visible and focused, nobody typing outside the widget.
  // The listeners and flushPeek() call back here when that changes.
  _tryShowPeek() {
    if (!this.pendingPeek || this.panel || this.host.formOpen()) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    if (this.timers.typing || this._typingOutside()) return;
    const peek = resolvePeek(this.pendingPeek, this.reports);
    this.pendingPeek = null;
    if (peek) this._showPeek(peek);
  }

  // Called by the hook when the feedback form closes.
  flushPeek() {
    this._tryShowPeek();
    this._tryPlayReaction();
  }

  _typingOutside() {
    const el = document.activeElement;
    return isTypingTarget(el) && !el.closest(WIDGET_SURFACES);
  }

  _showPeek(peek) {
    const { T } = this;
    const chevron = `<svg class="fb-peek-chev" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>`;
    let dot;
    let body;
    if (peek.kind === "many") {
      dot = dotStatus(this.reports) || "neutral";
      body = `
        <span class="fb-peek-title">${escapeHTML(fmt(T.peekMany, { count: peek.count }))}</span>
        <span class="fb-peek-sub">${escapeHTML(T.peekManySub)}</span>`;
    } else if (peek.kind === "needs_info") {
      dot = "needs_info";
      const question = latestTeamMessage(peek.report);
      const meta = [question?.author_name, relativeTime(question?.at, Date.now(), T), T.peekQuestionSub]
        .filter(Boolean)
        .join(" · ");
      body = `
        <span class="fb-peek-sub">${escapeHTML(T.peekQuestion)}</span>
        <span class="fb-peek-title">${escapeHTML(peek.report.title)}</span>
        ${question?.body ? `<span class="fb-peek-quote">${escapeHTML(question.body)}</span>` : ""}
        <span class="fb-peek-meta">${escapeHTML(meta)}</span>`;
    } else {
      dot = "fixed";
      body = `
        <span class="fb-peek-title">${escapeHTML(fmt(T.peekFixed, { title: peek.report.title }))}</span>
        <span class="fb-peek-sub">${escapeHTML(T.peekFixedSub)}</span>`;
    }
    this.peekEl.innerHTML = `
      <button type="button" class="fb-peek-card">
        <span class="fb-status-dot" data-status="${dot}" aria-hidden="true"></span>
        <span class="fb-peek-text">${body}</span>
        ${chevron}
      </button>`;
    this.shownPeek = peek.kind === "many" ? { kind: "many" } : { kind: peek.kind, id: peek.report.id };
    this.peekAutoHide = peek.kind === "fixed" || (peek.kind === "many" && !peek.stays);
    this.peekEl.hidden = false;
    requestAnimationFrame(() => {
      if (this.shownPeek) this.peekEl.classList.add("visible");
    });
    this._scheduleAutoHide();
  }

  // Fixed peeks slide back after 10s (hover or focus pauses); questions stay.
  _scheduleAutoHide() {
    if (!this.shownPeek || !this.peekAutoHide) return;
    if (this.peekEl.matches(":hover") || this.peekEl.contains(document.activeElement)) return;
    this._setTimer("peekHide", () => this._hidePeek(), PEEK_AUTO_HIDE_MS);
  }

  _hidePeek() {
    this._clearTimer("peekHide");
    if (!this.shownPeek) return;
    this.shownPeek = null;
    this.peekEl.classList.remove("visible");
    this.peekEl.hidden = true;
    this.peekEl.replaceChildren();
  }

  _openPeek() {
    const peek = this.shownPeek;
    this._hidePeek();
    if (!peek) return;
    if (peek.kind === "many") this.openList();
    else this.openReport(peek.id, { focusReply: peek.kind === "needs_info" });
  }

  // ---------------------------------------------------------------------------
  // Team reactions on the FAB — the emoji sits on its corner for 5s, then
  // goes; no dot stays behind
  // ---------------------------------------------------------------------------

  _buildAnnouncer() {
    const el = document.createElement("span");
    el.className = "fb-sr-only";
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
    this.announcer = el;
  }

  // A reaction on the report open in front of the reporter shows on its
  // bubble only.
  _queueReactions(items) {
    for (const item of items) {
      if (this.shownReactions.has(item.key)) continue;
      if (this._viewing(item.reportId)) {
        this._markReactionShown(item);
      } else if (
        this.reaction?.item.key !== item.key &&
        !this.reactionQueue.some((queued) => queued.key === item.key)
      ) {
        this.reactionQueue.push(item);
      }
    }
    this._tryPlayReaction();
  }

  // One at a time, with no panel or form open, in a visible, focused tab.
  _tryPlayReaction() {
    if (this.reaction || this.timers.reactionGap || this.reactionQueue.length === 0) return;
    if (this.panel || this.openingPanel || this.host.formOpen()) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    // The team may have taken a waiting reaction back or replaced it.
    const current = new Set(this.reports.flatMap(teamReactions).map((r) => r.key));
    this.reactionQueue = this.reactionQueue.filter((queued) => current.has(queued.key));
    const item = this.reactionQueue.shift();
    if (!item) return;
    this._markReactionShown(item);

    const el = document.createElement("span");
    el.className = "fb-fab-emoji";
    el.setAttribute("aria-hidden", "true");
    el.textContent = item.emoji;
    this.fab.classList.add("fb-fab-reacting");
    this.fab.appendChild(el);

    // The FAB's tooltip says who reacted while the emoji is up.
    const text = fmt(this.T.fabReaction, { name: item.by || this.T.team, emoji: item.emoji });
    this.reaction = { item, el, tooltip: this.fab.dataset.fbTooltip, remaining: REACTION_MS, timer: null };
    this.fab.dataset.fbTooltip = text;
    this.announcer.textContent = text;
    if (!this.fab.matches(":hover") && document.activeElement !== this.fab) this._resumeReaction();
  }

  _pauseReaction() {
    const r = this.reaction;
    if (!r?.timer) return;
    clearTimeout(r.timer);
    r.timer = null;
    r.remaining -= Date.now() - r.startedAt;
  }

  _resumeReaction() {
    const r = this.reaction;
    if (!r || r.timer) return;
    r.startedAt = Date.now();
    r.timer = setTimeout(() => this._endReaction(), Math.max(r.remaining, 1500));
  }

  // Shrinks the emoji away, then plays the next.
  _endReaction({ animate = true } = {}) {
    const r = this.reaction;
    if (!r) return;
    clearTimeout(r.timer);
    this.reaction = null;
    if (r.tooltip == null) delete this.fab.dataset.fbTooltip;
    else this.fab.dataset.fbTooltip = r.tooltip;
    const finish = () => {
      r.el.remove();
      this.fab.classList.remove("fb-fab-reacting");
    };
    if (!animate) return finish();
    r.el.classList.add("leaving");
    this._setTimer("reactionGap", () => this._tryPlayReaction(), REACTION_LEAVE_MS + REACTION_GAP_MS);
    setTimeout(finish, REACTION_LEAVE_MS);
  }

  // Called by the hook when the feedback form opens: the FAB is busy.
  stopReaction() {
    this._endReaction({ animate: false });
  }

  // Clicking the FAB while it shows a reaction opens that report.
  openReaction() {
    const item = this.reaction?.item;
    this.stopReaction();
    if (item) this.openReport(item.reportId);
  }

  // The report's team reactions show on its bubbles now: they don't play
  // on the FAB later.
  _consumeReactions(report) {
    teamReactions(report).forEach((item) => this._markReactionShown(item));
    this.reactionQueue = this.reactionQueue.filter((queued) => queued.reportId !== report.id);
  }

  _markReactionShown(item) {
    this.shownReactions.add(item.key);
    try {
      localStorage.setItem(SHOWN_REACTIONS_KEY, JSON.stringify([...this.shownReactions].slice(-100)));
    } catch (_e) {
      // Private mode or full storage: it may play again on the next load.
    }
  }

  // ---------------------------------------------------------------------------
  // Reports panel
  // ---------------------------------------------------------------------------

  // FAB with unseen updates: straight into the timeline when only one
  // report changed, otherwise the list.
  openFromFab() {
    const updated = this.reports.filter(hasUpdate);
    if (updated.length === 1) {
      this.openReport(updated[0].id, { focusReply: updated[0].status === "needs_info" });
    } else {
      this.openList();
    }
  }

  openList() {
    this._openPanel({ name: "list" }, {});
  }

  openReport(id, { focusReply = false } = {}) {
    const report = this._report(id);
    if (!report) return this.openList();
    this._saveDraft();
    this.newStepIds = new Set(unseenSteps(report).map((s) => s.id));
    this.verdict = null;
    this.picking = null;
    this.pulseNow = true;
    this._consumeReactions(report);
    this._openPanel({ name: "report", id }, { focusReply });
    this._markSeen(report);
  }

  // `handoff` when another widget surface takes over (the feedback form):
  // focus and held peeks are its business then.
  closePanel({ handoff = false } = {}) {
    if (!this.panel) return;
    this._saveDraft();
    const hadFocus = this.panel.contains(document.activeElement);
    this.panel.remove();
    this.panel = null;
    this.view = null;
    this.verdict = null;
    this.picking = null;
    this.newStepIds.clear();
    this.fab.setAttribute("aria-expanded", "false");
    const back = this.returnFocus;
    this.returnFocus = null;
    this.host.onChange();
    if (handoff) return;
    if (hadFocus && back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
    this._tryShowPeek();
    this._tryPlayReaction();
  }

  applyCorner() {
    const c = this.host.corner();
    // Same anchoring as the form panel: 64px off the FAB's edge.
    for (const el of [this.panel, this.peekEl]) {
      if (!el) continue;
      el.style.top = c.startsWith("top") ? "64px" : "auto";
      el.style.bottom = c.startsWith("bottom") ? "64px" : "auto";
      el.style.left = c.endsWith("left") ? "16px" : "auto";
      el.style.right = c.endsWith("right") ? "16px" : "auto";
    }
  }

  _report(id) {
    return this.reports.find((r) => r.id === id);
  }

  _viewing(id) {
    return this.view?.name === "report" && this.view.id === id;
  }

  _openPanel(view, { focusReply }) {
    // Clear the peek first: closing the form flushes pending peeks.
    this._hidePeek();
    this.stopReaction();
    this.pendingPeek = null;
    // Closing the form flushes waiting reactions too; the panel takes over.
    this.openingPanel = true;
    this.host.closeForm();
    this.openingPanel = false;
    if (!this.panel) this._buildPanel();
    this.view = view;
    this.fab.setAttribute("aria-expanded", "true");
    this._renderPanel({ fresh: true });
    this.host.keepScroll(() => this._focusInitial(focusReply));
  }

  _buildPanel() {
    const { T } = this;
    const panel = document.createElement("div");
    panel.className = "fb-reports-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", T.yourReports);
    panel.innerHTML = `
      <div class="fb-rp">
        <header class="fb-rp-head"></header>
        <div class="fb-rp-body"></div>
        <form class="fb-rp-reply" novalidate hidden>
          <textarea class="fb-textarea" name="body" rows="1" maxlength="5000"></textarea>
          <button type="submit" class="fb-btn-primary">${escapeHTML(T.send)}</button>
        </form>
        <p class="fb-rp-foot" hidden>${escapeHTML(T.answerHint)}</p>
      </div>`;
    panel.addEventListener("click", (e) => this._onPanelClick(e));
    const form = panel.querySelector(".fb-rp-reply");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this._sendReply();
    });
    form.body.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this._sendReply();
      }
    });
    panel.addEventListener("keydown", (e) => {
      if (e.target.matches(".fb-verdict-detail") && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this._sendVerdict(false);
      }
      // The picker's search: Enter reacts with the emoji typed, or the
      // first one found.
      if (e.target.matches(".fb-pick-search") && e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        const emoji = firstEmoji(e.target.value) || filterEmoji(e.target.value)[0];
        if (emoji && this.picking) this._react(this.picking.stepId, emoji);
      }
      // The answer field takes several lines: Cmd/Ctrl+Enter sends.
      if (e.target.matches(".fb-answer-input") && e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
        e.preventDefault();
        this._sendAnswer();
      }
    });
    // The answer field lives in the re-rendered timeline: its draft is
    // kept here so live pushes don't wipe it.
    panel.addEventListener("input", (e) => {
      if (e.target.matches(".fb-pick-search") && this.picking) {
        this.picking.query = e.target.value;
        return this._filterPicker();
      }
      if (!e.target.matches(".fb-answer-input") || this.view?.name !== "report") return;
      const value = e.target.value;
      if (value.trim()) this.answerDrafts.set(this.view.id, value);
      else this.answerDrafts.delete(this.view.id);
      const send = e.target.closest(".fb-answer-form")?.querySelector("[type='submit']");
      if (send) send.disabled = !value.trim();
    });
    panel.addEventListener("submit", (e) => {
      if (!e.target.matches(".fb-answer-form")) return;
      e.preventDefault();
      this._sendAnswer();
    });
    this.returnFocus = document.activeElement;
    document.body.appendChild(panel);
    this.panel = panel;
    this.applyCorner();
  }

  _onKeydown(e) {
    if (e.key !== "Escape") return;
    if (this.panel) {
      if (this.picking) {
        e.preventDefault();
        this._closePicker();
      } else if (this.verdict?.mode === "detail") {
        this.verdict = null;
        this._renderPanel();
        this.panel.querySelector("[data-action='broken']")?.focus();
      } else {
        this.closePanel();
      }
    } else if (this.shownPeek) {
      this._hidePeek();
    }
  }

  _onPanelClick(e) {
    const rowEl = e.target.closest("[data-report-id]");
    if (rowEl) return this.openReport(rowEl.dataset.reportId);
    const target = e.target.closest("[data-action]");
    const action = target?.dataset.action;
    switch (action) {
      case "close":
        return this.closePanel();
      case "back":
        this._saveDraft();
        this.verdict = null;
        this.picking = null;
        this.view = { name: "list" };
        this._renderPanel({ fresh: true });
        return this._focusInitial(false);
      case "new-report":
        return this.host.openForm();
      case "works":
        return this._sendVerdict(true);
      case "broken":
        this.verdict = { id: this.view.id, mode: "detail" };
        this._renderPanel();
        return this.panel.querySelector(".fb-verdict-detail")?.focus();
      case "broken-send":
        return this._sendVerdict(false);
      case "broken-cancel":
        this.verdict = null;
        return this._renderPanel();
      case "rx-open":
        return this._togglePicker(target.dataset.stepId);
      case "rx-more":
        return this._expandPicker();
      case "rx":
      case "rx-pick":
        return this._react(target.dataset.stepId, target.dataset.emoji);
    }
  }

  // Reply field when answering a question, else the first control.
  _focusInitial(focusReply) {
    if (!this.panel) return;
    const selectors =
      this.view.name === "list"
        ? ["[data-report-id]", "[data-action='new-report']"]
        : focusReply
          ? [".fb-answer-input", ".fb-rp-reply:not([hidden]) textarea"]
          : ["[data-action='back']"];
    const target = selectors.map((sel) => this.panel.querySelector(sel)).find(Boolean);
    target?.focus({ preventScroll: true });
  }

  // Re-renders header and body from state. The reply field lives outside
  // the re-rendered part so typing survives live pushes; focus and the
  // verdict detail text are carried across.
  _renderPanel({ fresh = false } = {}) {
    const body = this.panel.querySelector(".fb-rp-body");
    const active = document.activeElement;
    const focusKey = this.panel.contains(active) ? focusSelector(active) : null;
    const detail = this.panel.querySelector(".fb-verdict-detail")?.value;
    const caret =
      focusKey && active.matches(".fb-answer-input, .fb-pick-search") ? [active.selectionStart, active.selectionEnd] : null;
    const report = this.view.name === "report" ? this._report(this.view.id) : null;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    if (fresh) this.revealedAnswer = null;

    if (report) {
      this._renderReport(report, fresh);
    } else {
      this.view = { name: "list" };
      this._renderList();
    }

    if (detail != null) {
      const field = this.panel.querySelector(".fb-verdict-detail");
      if (field) field.value = detail;
    }
    if (focusKey) {
      const el = this.panel.querySelector(focusKey);
      el?.focus({ preventScroll: true });
      if (caret && el?.setSelectionRange) el.setSelectionRange(...caret);
    }
    if (report && (fresh || nearBottom)) body.scrollTop = body.scrollHeight;
    else if (fresh) body.scrollTop = 0;
    if (report) this._revealAnswer(report, body);
    this._placePicker();
  }

  // A question that just arrived (or a timeline opening on one) brings
  // its answer field into view, once.
  _revealAnswer(report, body) {
    const form = body.querySelector(".fb-answer-form");
    const key = form ? `${report.id}|${form.dataset.questionId}` : null;
    if (!form || key === this.revealedAnswer) {
      this.revealedAnswer = key;
      return;
    }
    this.revealedAnswer = key;
    const view = body.getBoundingClientRect();
    const field = form.getBoundingClientRect();
    if (field.bottom > view.bottom - 12) body.scrollTop += field.bottom - view.bottom + 12;
    else if (field.top < view.top) body.scrollTop -= view.top - field.top + 12;
  }

  _renderHead(left) {
    const { T } = this;
    this.panel.querySelector(".fb-rp-head").innerHTML = `
      <div class="fb-rp-head-left">${left}</div>
      <span class="fb-conn" aria-live="polite"${this.connected || !this.everConnected ? " hidden" : ""}>${escapeHTML(T.reconnecting)}</span>
      ${this.view.name === "list" ? `<button type="button" class="fb-btn-secondary fb-btn-sm" data-action="new-report">${escapeHTML(T.newReport)}</button>` : ""}
      <button type="button" class="fb-icon-btn" data-action="close" aria-label="${escapeHTML(T.close)}">${closeIcon()}</button>`;
  }

  _renderList() {
    const { T } = this;
    const now = Date.now();
    this._renderHead(`<h3 class="fb-rp-title">${escapeHTML(T.yourReports)}</h3>`);
    this.panel.querySelector(".fb-rp-reply").hidden = true;
    this.panel.querySelector(".fb-rp-foot").hidden = true;
    const rows = this.reports.map((report) => {
      const unread = hasUpdate(report);
      const message = latestTeamMessage(report);
      return `
        <li>
          <button type="button" class="fb-rp-row${unread ? " unread" : ""}" data-report-id="${escapeHTML(report.id)}">
            <span class="fb-unread" aria-hidden="true"></span>
            <span class="fb-rp-row-main">
              <span class="fb-rp-row-top">
                <span class="fb-status"><span class="fb-status-dot" data-status="${escapeHTML(report.status)}"></span>${escapeHTML(labelFor(T.status, report.status))}</span>
                <span class="fb-rp-time">${escapeHTML(relativeTime(report.status_at || report.reported_at, now, T))}</span>
              </span>
              <span class="fb-rp-row-title">${escapeHTML(report.title)}${unread ? `<span class="fb-sr-only">, ${escapeHTML(T.unread)}</span>` : ""}</span>
              ${message?.body ? `<span class="fb-rp-row-excerpt">${escapeHTML(message.body)}</span>` : ""}
            </span>
          </button>
        </li>`;
    });
    this.panel.querySelector(".fb-rp-body").innerHTML = rows.length
      ? `<ul class="fb-rp-list">${rows.join("")}</ul>`
      : `<p class="fb-rp-empty">${escapeHTML(T.reportsEmpty)}</p>`;
  }

  _renderReport(report, fresh) {
    const { T } = this;
    const now = Date.now();
    this._renderHead(`
      <button type="button" class="fb-icon-btn" data-action="back" aria-label="${escapeHTML(T.back)}">${backIcon()}</button>
      <span class="fb-rp-crumb">${escapeHTML(T.yourReports)}</span>`);

    const meta = [
      escapeHTML(labelFor(T.type, report.type)),
      escapeHTML(fmt(T.reportedOn, { date: formatDate(report.reported_at, now, T.locale) })),
      report.linear_identifier ? `<span class="fb-mono">${escapeHTML(report.linear_identifier)}</span>` : "",
    ].filter(Boolean);

    const nodes = timeline(report);
    const verdictKey = verdictNodeKey(report, nodes);
    this.panel.querySelector(".fb-rp-body").innerHTML = `
      <div class="fb-rp-report-head">
        <h3 class="fb-rp-report-title">${escapeHTML(report.title)}</h3>
        <p class="fb-rp-meta">${meta.join(" · ")}</p>
      </div>
      <ol class="fb-tl">
        ${nodes.map((node) => this._stepHTML(node, report, node.key === verdictKey, now)).join("")}
      </ol>`;
    this.pulseNow = false;

    // While a question waits, it is answered in its own field; the bottom
    // field (and its draft) comes back once it is answered.
    const open = openQuestion(nodes);
    const form = this.panel.querySelector(".fb-rp-reply");
    form.hidden = Boolean(open);
    this.panel.querySelector(".fb-rp-foot").hidden = !open;
    const placeholder = report.status === "needs_info" ? T.answerPlaceholder : T.replyPlaceholder;
    form.body.placeholder = placeholder;
    form.body.setAttribute("aria-label", placeholder);
    if (fresh) form.body.value = this.drafts.get(report.id) || "";
  }

  _stepHTML(node, report, withVerdict, now) {
    const { T } = this;
    const isNew = node.stepIds.some((id) => this.newStepIds.has(id));
    // The fix still ahead reads as the promise alone: a gray "Fixed" title
    // looked as if it were done.
    const promise = node.state === "todo" && node.status === "fixed";
    const label = promise
      ? T.stepTodoFixed
      : node.question
        ? T.stepQuestion
        : labelFor(T.status, node.status);
    const hint = promise ? "" : this._hint(node);
    const pulse = this.pulseNow && node.state === "now" && isNew;
    return `
      <li class="fb-step" data-state="${node.state}" data-status="${escapeHTML(node.status)}">
        <span class="fb-step-node${pulse ? " fb-pulse" : ""}" aria-hidden="true"></span>
        <div class="fb-step-main">
          <p class="fb-step-label">${escapeHTML(label)}${isNew ? `<span class="fb-new-tag">${escapeHTML(T.newTag)}</span>` : ""}</p>
          ${hint ? `<p class="fb-step-hint">${escapeHTML(hint)}</p>` : ""}
          ${node.question ? this._threadHTML(node, report, now) : ""}
          ${node.bubbles.map((step) => this._bubbleHTML(step)).join("")}
          ${withVerdict ? this._verdictHTML(report) : ""}
        </div>
        ${node.at ? `<time class="fb-step-time" datetime="${escapeHTML(node.at)}">${escapeHTML(relativeTime(node.at, now, T))}</time>` : ""}
      </li>`;
  }

  // One line under the current step: what its status means. Past steps
  // speak through their bubbles.
  _hint(node) {
    const { T } = this;
    if (node.state === "todo") return "";
    if (node.state === "now" && !node.question) return T.stepHint?.[node.status] || "";
    return "";
  }

  // A question thread: what the follow-up refers to, the team's
  // question(s), then the reporter's answer on a connector, or the field
  // to answer it while it is open.
  _threadHTML(node, report, now) {
    const { T } = this;
    const parts = [];
    if (node.follows?.answer) {
      const about = fmt(T.aboutYourAnswer, { answer: clip(node.follows.answer.body, 40) });
      parts.push(`<p class="fb-qa-ref">${replyIcon()}<span>${escapeHTML(about)}</span></p>`);
    }
    for (const question of node.questions) parts.push(this._bubbleHTML(question));
    for (const answer of node.answers) {
      const label = fmt(T.yourAnswer, { time: relativeTime(answer.at, now, T) });
      parts.push(`
        <div class="fb-answer">
          <span class="fb-answer-label">${escapeHTML(label)}</span>
          ${this._bubbleHTML(answer, { by: false })}
        </div>`);
    }
    if (node.open) {
      const draft = this.answerDrafts.get(report.id) || "";
      const question = node.questions[node.questions.length - 1];
      const id = `fb-answer-${escapeHTML(node.key)}`;
      parts.push(`
        <form class="fb-answer fb-answer-form" data-question-id="${escapeHTML(question.id)}" novalidate>
          <label class="fb-answer-label" for="${id}">${escapeHTML(T.answerLabel)}</label>
          <textarea id="${id}" class="fb-textarea fb-answer-input" rows="2" maxlength="5000" placeholder="${escapeHTML(T.answerPlaceholder)}">${escapeHTML(draft)}</textarea>
          <div class="fb-answer-bar">
            <span class="fb-answer-hint">${escapeHTML(T.answerFieldHint)}</span>
            <button type="submit" class="fb-btn-primary fb-btn-sm"${draft.trim() ? "" : " disabled"}>${escapeHTML(T.sendAnswer)}</button>
          </div>
        </form>`);
    }
    return `<div class="fb-qa">${parts.join("")}</div>`;
  }

  // A message: its bubble, then the reactions on its bottom edge. The
  // reporter's own bubbles are filled, the team's outlined. `by: false`
  // drops the "You · " prefix where a label already says it.
  _bubbleHTML(step, { by: showBy = true } = {}) {
    const { T } = this;
    let bubble;
    if (step.author === "reporter") {
      const text =
        step.kind === "verdict" ? (step.body === "works" ? T.worksNow : T.stillBroken) : step.body;
      const detail = step.kind === "verdict" && step.detail ? `<span class="fb-bubble-detail">${escapeHTML(step.detail)}</span>` : "";
      const prefix = showBy ? `<span class="fb-bubble-by">${escapeHTML(T.you)} · </span>` : "";
      bubble = `<div class="fb-bubble fb-bubble-mine${step.pending ? " pending" : ""}">${prefix}${escapeHTML(text)}${detail}</div>`;
    } else {
      const by = step.author_name ? ` <span class="fb-bubble-by">${escapeHTML(step.author_name)}</span>` : "";
      bubble = `<div class="fb-bubble">${escapeHTML(step.body)}${by}</div>`;
    }
    return `<div class="fb-msg">${bubble}${this._reactionsHTML(step)}</div>`;
  }

  // Chips overlapping the bubble's bottom edge. On the team's notes and
  // questions the reporter toggles theirs and adds more from the picker;
  // the team's emoji on the reporter's own messages are read-only.
  _reactionsHTML(step) {
    const { T } = this;
    const groups = reactionGroups(step);
    const mine = canReact(step);
    if (!mine && groups.length === 0) return "";
    const id = escapeHTML(step.id);
    const chips = groups.map((g) => {
      const emoji = escapeHTML(g.emoji);
      const count = g.count > 1 ? `<span class="fb-rx-n">${g.count}</span>` : "";
      const from = fmt(T.reactionFrom, { name: listNames(g.names.map((n) => n || T.team), T.locale) });
      if (!mine) {
        return `<span class="fb-rx fb-rx-ro" role="img" aria-label="${escapeHTML(`${g.emoji} ${from}`)}" title="${escapeHTML(from)}"><span class="fb-rx-e" aria-hidden="true">${emoji}</span>${count}</span>`;
      }
      const label = g.mine ? fmt(T.removeReaction, { emoji: g.emoji }) : `${g.emoji} ${from}`;
      return `<button type="button" class="fb-rx${g.mine ? " on" : ""}" data-action="rx" data-step-id="${id}" data-emoji="${emoji}" aria-pressed="${g.mine}" aria-label="${escapeHTML(label)}" title="${escapeHTML(g.mine ? label : from)}"><span class="fb-rx-e" aria-hidden="true">${emoji}</span>${count}</button>`;
    });
    if (mine) {
      const open = this.picking?.stepId === step.id;
      chips.push(
        `<button type="button" class="fb-rx fb-rx-add" data-action="rx-open" data-step-id="${id}" aria-expanded="${open}" aria-haspopup="dialog" aria-label="${escapeHTML(T.addReaction)}" title="${escapeHTML(T.addReaction)}">${smileyPlusIcon()}</button>`,
      );
      if (open) chips.push(this._pickerHTML(step));
    }
    return `<div class="fb-rxs" role="group" aria-label="${escapeHTML(T.reactions)}">${chips.join("")}</div>`;
  }

  // Four one-click emoji and "…", which opens a search over a grid; any
  // emoji typed or pasted there works too.
  _pickerHTML(step) {
    const { T } = this;
    const id = escapeHTML(step.id);
    const mine = new Set(stepReactions(step).filter((r) => r.author === "reporter").map((r) => r.emoji));
    const button = (emoji, cls = "") =>
      `<button type="button" class="${[cls, mine.has(emoji) ? "on" : ""].filter(Boolean).join(" ")}" data-action="rx-pick" data-step-id="${id}" data-emoji="${escapeHTML(emoji)}" aria-pressed="${mine.has(emoji)}" aria-label="${escapeHTML(fmt(T.reactWith, { emoji }))}">${escapeHTML(emoji)}</button>`;
    const { more } = this.picking;
    const search = more
      ? `<div class="fb-pick-x">
          <input type="text" class="fb-pick-search" autocomplete="off" spellcheck="false" placeholder="${escapeHTML(T.emojiSearch)}" aria-label="${escapeHTML(T.emojiSearch)}" value="${escapeHTML(this.picking.query || "")}">
          <div class="fb-pick-grid">${EMOJI.map(([emoji]) => button(emoji)).join("")}</div>
          <p class="fb-pick-hint" aria-live="polite"></p>
        </div>`
      : "";
    return `
      <div class="fb-pick" role="dialog" aria-label="${escapeHTML(T.react)}">
        <div class="fb-pick-q">${QUICK_REACTIONS.map((emoji) => button(emoji)).join("")}<button type="button" class="fb-pick-more" data-action="rx-more" aria-expanded="${more}" aria-label="${escapeHTML(T.moreEmoji)}" title="${escapeHTML(T.moreEmoji)}">${dotsIcon()}</button></div>
        ${search}
      </div>`;
  }

  _verdictHTML(report) {
    const { T } = this;
    const mode = this.verdict?.id === report.id ? this.verdict.mode : "ask";
    const disabled = mode === "sending" ? " disabled" : "";
    if (mode === "detail") {
      return `
        <div class="fb-verdict" data-mode="detail">
          <textarea class="fb-textarea fb-verdict-detail" rows="2" maxlength="5000" placeholder="${escapeHTML(T.brokenPlaceholder)}" aria-label="${escapeHTML(T.brokenPlaceholder)}"></textarea>
          <div class="fb-verdict-actions">
            <button type="button" class="fb-btn-secondary fb-btn-sm" data-action="broken-cancel">${escapeHTML(T.cancel)}</button>
            <button type="button" class="fb-btn-primary fb-btn-sm" data-action="broken-send">${escapeHTML(T.send)}</button>
          </div>
        </div>`;
    }
    if (report.verdict === "works") {
      return `
      <div class="fb-verdict">
        <button type="button" class="fb-link" data-action="broken"${disabled}>${escapeHTML(T.reopen)}</button>
      </div>`;
    }
    return `
      <div class="fb-verdict">
        <button type="button" class="fb-btn-secondary fb-btn-sm" data-action="broken"${disabled}>${escapeHTML(T.stillBroken)}</button>
        <button type="button" class="fb-btn-primary fb-btn-sm" data-action="works"${disabled}>${escapeHTML(T.worksNow)}</button>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Reporter → team: replies and verdicts
  // ---------------------------------------------------------------------------

  _togglePicker(stepId) {
    const opening = this.picking?.stepId !== stepId;
    this.picking = opening ? { stepId, more: false, query: "" } : null;
    this._renderPanel();
    if (opening) this.panel.querySelector(".fb-pick button")?.focus({ preventScroll: true });
  }

  // "…": the search field and the grid.
  _expandPicker() {
    if (!this.picking) return;
    this.picking.more = !this.picking.more;
    this._renderPanel();
    const target = this.picking.more ? ".fb-pick-search" : ".fb-pick-more";
    this.panel.querySelector(target)?.focus({ preventScroll: true });
  }

  // Esc or a click elsewhere; Esc hands focus back to the add chip.
  _closePicker(refocus = true) {
    const stepId = this.picking?.stepId;
    if (!stepId) return;
    this.picking = null;
    this._renderPanel();
    if (refocus) this._focusAddButton(stepId);
  }

  _focusAddButton(stepId) {
    this.panel
      ?.querySelector(`[data-action="rx-open"][data-step-id="${CSS.escape(stepId)}"]`)
      ?.focus({ preventScroll: true });
  }

  // Shows the grid's matches for the search text, and what Enter does.
  _filterPicker() {
    const pick = this.panel?.querySelector(".fb-pick-x");
    if (!pick || !this.picking) return;
    const { T } = this;
    const query = this.picking.query || "";
    const typed = firstEmoji(query);
    const shown = new Set(typed ? EMOJI.map(([emoji]) => emoji) : filterEmoji(query));
    pick.querySelectorAll(".fb-pick-grid button").forEach((b) => {
      b.hidden = !shown.has(b.dataset.emoji);
    });
    const hint = pick.querySelector(".fb-pick-hint");
    if (typed) {
      const [before, after] = T.emojiEnter.split("{emoji}");
      hint.innerHTML = `${escapeHTML(before)}<b>${escapeHTML(typed)}</b>${escapeHTML(after ?? "")}`;
    } else {
      hint.textContent = shown.size ? T.emojiHint : T.emojiNoMatch;
    }
  }

  // The picker opens upwards and flips below when the scroll area has no
  // room above; it stays inside the panel sideways, then scrolls into view.
  _placePicker() {
    const pick = this.panel?.querySelector(".fb-pick");
    if (!pick) return;
    this._filterPicker();
    const body = this.panel.querySelector(".fb-rp-body");
    const area = body.getBoundingClientRect();
    const overflow = pick.getBoundingClientRect().right - (area.right - 8);
    if (overflow > 0) pick.style.left = `${-4 - overflow}px`;
    if (pick.getBoundingClientRect().top < area.top + 8) pick.classList.add("below");
    const box = pick.getBoundingClientRect();
    if (box.bottom > area.bottom - 8) body.scrollTop += box.bottom - area.bottom + 8;
    else if (box.top < area.top + 8) body.scrollTop -= area.top + 8 - box.top;
  }

  // Puts the reporter's emoji on a team message, or takes it off. Shows at
  // once; rolled back with a toast on failure.
  _react(stepId, emoji) {
    if (this.view?.name !== "report" || !emoji) return;
    const report = this._report(this.view.id);
    const step = report?.steps?.find((s) => s.id === stepId);
    if (!step || !canReact(step)) return;
    const before = stepReactions(step);
    const after = toggleReaction(before, emoji);
    this.picking = null;
    this.reports = upsertReport(this.reports, withReactions(report, stepId, after));
    this._changed();
    this._focusAddButton(stepId);
    this._push("toggle_reaction", { id: report.id, step_id: stepId, emoji })
      .then((updated) => this._accept(updated))
      .catch(() => {
        const current = this._report(report.id);
        if (current) this.reports = upsertReport(this.reports, withReactions(current, stepId, before));
        this._changed();
        this.host.toast(this.T.reactFailed);
      });
  }

  _saveDraft() {
    if (this.view?.name !== "report" || !this.panel) return;
    const value = this.panel.querySelector(".fb-rp-reply textarea").value;
    if (value.trim()) this.drafts.set(this.view.id, value);
    else this.drafts.delete(this.view.id);
  }

  // Appears in the timeline at once; rolled back with a toast on failure.
  _sendReply() {
    if (this.view?.name !== "report") return;
    const field = this.panel.querySelector(".fb-rp-reply textarea");
    const body = field.value.trim();
    const report = this._report(this.view.id);
    if (!body || !report) return;
    field.value = "";
    this.drafts.delete(report.id);
    this._postReply(report, body, null, () => {
      if (this._viewing(report.id) && !field.value) field.value = body;
      else if (!this.drafts.has(report.id)) this.drafts.set(report.id, body);
    });
  }

  // The answer field of the open question. It goes the reply's way: the
  // server links a reply to the open question itself; the local copy
  // names it so the answer shows in its place right away.
  _sendAnswer() {
    if (this.view?.name !== "report") return;
    const field = this.panel.querySelector(".fb-answer-input");
    const body = field?.value.trim();
    const report = this._report(this.view.id);
    if (!body || !report) return;
    const questionId = field.closest(".fb-answer-form").dataset.questionId;
    this.answerDrafts.delete(report.id);
    this._postReply(report, body, questionId, () => {
      if (!this.answerDrafts.has(report.id)) this.answerDrafts.set(report.id, body);
    });
  }

  _postReply(report, body, answers, restore) {
    const local = {
      id: `local-${Date.now()}`,
      kind: "reply",
      author: "reporter",
      body,
      answers,
      at: new Date().toISOString(),
      seen: true,
      pending: true,
    };
    this.reports = upsertReport(this.reports, withStep(report, local));
    this._changed();
    this._push("reply", { id: report.id, body })
      .then((updated) => this._accept(updated))
      .catch(() => {
        const current = this._report(report.id);
        if (current) this.reports = upsertReport(this.reports, withoutStep(current, local.id));
        restore();
        this._changed();
        this.host.toast(this.T.replyFailed);
      });
  }

  _sendVerdict(works) {
    if (this.view?.name !== "report" || this.verdict?.mode === "sending") return;
    const id = this.view.id;
    const detail = works ? "" : this.panel.querySelector(".fb-verdict-detail")?.value.trim() || "";
    this.verdict = { id, mode: "sending" };
    this._renderPanel();
    const payload = detail ? { id, works, body: detail } : { id, works };
    this._push("verdict", payload)
      .then((updated) => {
        this.verdict = null;
        this._accept(updated);
      })
      .catch(() => {
        this.verdict = null;
        if (this.panel) this._renderPanel();
        this.host.toast(this.T.replyFailed);
      });
  }

  // ---------------------------------------------------------------------------
  // Deep link, timers, listeners
  // ---------------------------------------------------------------------------

  // `?hi-pulse-report=<id>` (the email button) opens that timeline once
  // the reports are in, then leaves the address. A report that isn't
  // there (deleted, or someone else's) opens the list instead.
  _openDeepLink() {
    const id = readDeepLink(window.location);
    if (!id) return false;
    history.replaceState(history.state, "", stripDeepLink(window.location));
    const report = this._report(id);
    if (report) this.openReport(id, { focusReply: report.status === "needs_info" });
    else this.openList();
    return true;
  }

  _setTimer(name, fn, ms) {
    this._clearTimer(name);
    this.timers[name] = setTimeout(() => {
      delete this.timers[name];
      fn();
    }, ms);
  }

  _clearTimer(name) {
    clearTimeout(this.timers[name]);
    delete this.timers[name];
  }

  _listen(target, type, fn) {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }
}

function loadShownReactions() {
  try {
    const keys = JSON.parse(localStorage.getItem(SHOWN_REACTIONS_KEY) || "[]");
    return new Set(Array.isArray(keys) ? keys : []);
  } catch (_e) {
    return new Set();
  }
}

// Selector that finds the same control again after a re-render.
function focusSelector(el) {
  if (el.dataset.reportId) return `[data-report-id="${CSS.escape(el.dataset.reportId)}"]`;
  if (el.dataset.action) {
    const step = el.dataset.stepId ? `[data-step-id="${CSS.escape(el.dataset.stepId)}"]` : "";
    const emoji = el.dataset.emoji ? `[data-emoji="${CSS.escape(el.dataset.emoji)}"]` : "";
    return `[data-action="${CSS.escape(el.dataset.action)}"]${step}${emoji}`;
  }
  if (el.matches(".fb-verdict-detail")) return ".fb-verdict-detail";
  if (el.matches(".fb-pick-search")) return ".fb-pick-search";
  if (el.matches(".fb-answer-input")) return ".fb-answer-input";
  return null;
}

// "Nico", "Nico and Marc", "Nico, Marc and Lea" in the host's locale.
function listNames(names, locale) {
  try {
    return new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
  } catch (_e) {
    return names.join(", ");
  }
}

function smileyPlusIcon() {
  return `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M16.5 9.5A6.5 6.5 0 1 1 10.5 3.52"/><path d="M7.2 11.6c.7.9 1.7 1.4 2.8 1.4s2.1-.5 2.8-1.4"/><circle cx="7.6" cy="8.2" r=".6" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8.2" r=".6" fill="currentColor" stroke="none"/><path d="M16 2.5v4M14 4.5h4"/></svg>`;
}

function dotsIcon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>`;
}

function replyIcon() {
  return `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 3v5a3 3 0 0 0 3 3h7M10 8l3 3-3 3"/></svg>`;
}

function backIcon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>`;
}

function closeIcon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
}
