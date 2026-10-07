// Reporter updates — the reporter sees what happened to their feedback
// without leaving the app: a dot on the FAB, a one-line peek for questions
// and fixes, and a reports panel (list + timeline with replies and the
// "Works now" / "Still broken" verdict).
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
  dotStatus,
  escapeHTML,
  fmt,
  formatDate,
  hasUpdate,
  isTypingTarget,
  joinPeek,
  labelFor,
  latestTeamMessage,
  livePeek,
  mergePeek,
  readDeepLink,
  stripDeepLink,
  relativeTime,
  resolvePeek,
  socketUrl,
  sortReports,
  timeline,
  unseenCount,
  unseenSteps,
  upsertReport,
  verdictNodeKey,
  withoutStep,
  withStep,
  changedReports,
} from "./reporter_view.js";

const JOIN_PEEK_DELAY_MS = 2000;
const PEEK_AUTO_HIDE_MS = 10000;
const TYPING_GRACE_MS = 1000;
// Phoenix's default reconnect schedule.
const RECONNECT_MS = [10, 50, 100, 150, 200, 250, 500, 1000, 2000];
const WIDGET_SURFACES = ".fb-form-panel, .fb-reports-panel, .fb-peek, .fb-overlay";

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
    this.verdict = null;
    this.pendingPeek = null;
    this.shownPeek = null;
    this.releaseTitles = new Set();
    this.timers = {};
    this.listeners = [];

    this._buildDot();
    this._buildPeek();
    this._listen(document, "focusin", (e) => {
      if (isTypingTarget(e.target)) this._clearTimer("typing");
    });
    this._listen(document, "focusout", () => {
      if (this.pendingPeek) this._setTimer("typing", () => this._tryShowPeek(), TYPING_GRACE_MS);
    });
    this._listen(document, "visibilitychange", () => this._onAttention());
    this._listen(window, "focus", () => this._onAttention());
    this._listen(document, "keydown", (e) => this._onKeydown(e));
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
    this.peekEl?.remove();
    this.dot?.remove();
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
    } else {
      this.joined = true;
      if (!this._openDeepLink()) {
        const peek = joinPeek(this.reports);
        if (peek) this._setTimer("joinPeek", () => this._queuePeek(peek), JOIN_PEEK_DELAY_MS);
      }
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

  // Back in the tab: a held peek can rise, an open timeline marks itself seen.
  _onAttention() {
    this._tryShowPeek();
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
    this.pulseNow = true;
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
    this.newStepIds.clear();
    this.fab.setAttribute("aria-expanded", "false");
    const back = this.returnFocus;
    this.returnFocus = null;
    this.host.onChange();
    if (handoff) return;
    if (hadFocus && back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
    this._tryShowPeek();
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
    this.pendingPeek = null;
    this.host.closeForm();
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
    });
    this.returnFocus = document.activeElement;
    document.body.appendChild(panel);
    this.panel = panel;
    this.applyCorner();
  }

  _onKeydown(e) {
    if (e.key !== "Escape") return;
    if (this.panel) {
      if (this.verdict?.mode === "detail") {
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
    const action = e.target.closest("[data-action]")?.dataset.action;
    switch (action) {
      case "close":
        return this.closePanel();
      case "back":
        this._saveDraft();
        this.verdict = null;
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
    }
  }

  // Reply field when answering a question, else the first control.
  _focusInitial(focusReply) {
    if (!this.panel) return;
    const selectors =
      this.view.name === "list"
        ? ["[data-report-id]", "[data-action='new-report']"]
        : [focusReply ? ".fb-rp-reply textarea" : "[data-action='back']"];
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
    const report = this.view.name === "report" ? this._report(this.view.id) : null;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;

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
    if (focusKey) this.panel.querySelector(focusKey)?.focus({ preventScroll: true });
    if (report && (fresh || nearBottom)) body.scrollTop = body.scrollHeight;
    else if (fresh) body.scrollTop = 0;
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

    const form = this.panel.querySelector(".fb-rp-reply");
    form.hidden = false;
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

  _bubbleHTML(step) {
    const { T } = this;
    if (step.author === "reporter") {
      const text =
        step.kind === "verdict" ? (step.body === "works" ? T.worksNow : T.stillBroken) : step.body;
      const detail = step.kind === "verdict" && step.detail ? `<span class="fb-bubble-detail">${escapeHTML(step.detail)}</span>` : "";
      return `<div class="fb-bubble fb-bubble-mine${step.pending ? " pending" : ""}"><span class="fb-bubble-by">${escapeHTML(T.you)} · </span>${escapeHTML(text)}${detail}</div>`;
    }
    const by = step.author_name ? ` <span class="fb-bubble-by">${escapeHTML(step.author_name)}</span>` : "";
    return `<div class="fb-bubble">${escapeHTML(step.body)}${by}</div>`;
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
    const local = {
      id: `local-${Date.now()}`,
      kind: "reply",
      author: "reporter",
      body,
      at: new Date().toISOString(),
      seen: true,
      pending: true,
    };
    field.value = "";
    this.drafts.delete(report.id);
    this.reports = upsertReport(this.reports, withStep(report, local));
    this._changed();
    this._push("reply", { id: report.id, body })
      .then((updated) => this._accept(updated))
      .catch(() => {
        const current = this._report(report.id);
        if (current) this.reports = upsertReport(this.reports, withoutStep(current, local.id));
        if (this._viewing(report.id) && !field.value) field.value = body;
        else if (!this.drafts.has(report.id)) this.drafts.set(report.id, body);
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

// Selector that finds the same control again after a re-render.
function focusSelector(el) {
  if (el.dataset.reportId) return `[data-report-id="${CSS.escape(el.dataset.reportId)}"]`;
  if (el.dataset.action) return `[data-action="${CSS.escape(el.dataset.action)}"]`;
  if (el.matches(".fb-verdict-detail")) return ".fb-verdict-detail";
  return null;
}

function backIcon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>`;
}

function closeIcon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
}
