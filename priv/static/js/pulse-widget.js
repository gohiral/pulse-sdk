// Feedback widget — floating button that opens a two-column form panel.
// Left column is the screenshot canvas (empty-state dashed dropzone, or the
// captured thumb); right column carries an optional topic picker, then
// title / description / type / priority.
// Clicking the dropzone triggers the browser's share-tab prompt and opens
// the annotation overlay. Submitting POSTs a multipart form to the configured
// hi_pulse_server's `POST /api/v1/events` with the (optional) annotated
// screenshot and the rrweb replay buffer.
//
// DOM contract: mount on a single empty <div id="hi-pulse-widget"
// phx-hook="HiPulse" data-reporter="..." data-context="..."
// data-project-slug="..." data-server-url="..."> — see
// HiPulse.Components.pulse_widget/1. With `data-reporter-token` (signed
// from HI_PULSE_SECRET) the widget also shows reporter updates; see
// reporter_updates.js.
//
// String table is kept inline for v1 (German). Phase 2: pull from
// data-i18n="..." JSON when the widget is enabled for non-DE tenants.

import { Annotator } from "./annotator.js";
import { installErrorCapture } from "./error_capture.js";
import {
  extractConsoleBuffer,
  getReplayBlob,
  getReplayDurationMs,
  installReplayRecorder,
  pauseRecorder,
  resumeRecorder,
} from "./replay_recorder.js";
import { ReporterUpdates } from "./reporter_updates.js";
import { titleize } from "./reporter_view.js";

// Defaults for the type/priority dropdowns when the server-side config
// hasn't loaded yet (or fails to load). Match the server's defaults so a
// fresh project works without admin intervention.
const DEFAULT_TYPES = ["bug", "suggestion", "question", "praise"];
const DEFAULT_PRIORITIES = ["low", "medium", "high", "urgent"];

// All user-facing strings. Override at runtime by overwriting any key
// before LiveSocket.connect() — e.g.
//   import { T } from "hi_pulse/pulse-widget"
//   T.fab = "Send feedback"
const T = {
  fab: "Feedback",
  fabTooltip: "Send feedback\nRight-click to move",
  panelTitle: "New feedback",
  fieldTitle: "Title",
  fieldDescription: "Description",
  fieldTopic: "Topic",
  fieldType: "Type",
  fieldPriority: "Priority",
  fieldScreenshot: "Screenshot",
  // Optional topic picker, off by default. Each entry renders as a
  // segment button and the reporter must pick one before sending; the key
  // ships as `topic` and the server attaches the Linear label of that name.
  //   T.topic = { app: { label: "App", sub: "Editor, controls" } }
  topic: {},
  topicMissing: "Please pick a topic",
  type: {
    bug: "Bug",
    suggestion: "Suggestion",
    question: "Question",
    praise: "Praise",
  },
  priority: { low: "Low", medium: "Medium", urgent: "Urgent" },
  cancel: "Cancel",
  send: "Send",
  sending: "Sending…",
  addScreenshot: "Take a screenshot",
  screenshotHint: "Often easier than describing",
  editScreenshot: "Edit",
  replaceScreenshot: "Retake",
  screenshotAttached: "Screenshot attached",
  removeScreenshot: "Remove",
  annotatorDone: "Done",
  annotatorCancel: "Cancel",
  toolCursor: "Cursor",
  toolRect: "Rectangle",
  toolArrow: "Arrow",
  toolText: "Text",
  toolCrop: "Crop",
  toolApplyCrop: "Apply",
  toolUndo: "Undo",
  toolDelete: "Delete",
  toastSuccess: "Feedback sent",
  toastFail: "Couldn't send feedback",
  toastLinear: "Open in Linear",
  titlePlaceholder: "Title",
  descriptionPlaceholder: "Anything else? (optional)",
  cornerHeader: "Position",
  corner: {
    "top-left": "Top left",
    "top-right": "Top right",
    "bottom-left": "Bottom left",
    "bottom-right": "Bottom right",
  },
  // Reporter updates (on when the host sets HI_PULSE_SECRET). `{name}`
  // marks a value filled in at runtime; keep it when translating.
  fabUpdate: "Feedback, 1 update",
  fabUpdates: "Feedback, {count} updates",
  yourReports: "Your reports",
  newReport: "New report",
  back: "Back",
  close: "Close",
  reconnecting: "Reconnecting…",
  reportsEmpty: "No reports yet",
  unread: "new update",
  status: {
    received: "Received",
    in_progress: "In progress",
    needs_info: "Needs info",
    fixed: "Fixed",
    closed: "Closed",
  },
  stepQuestion: "Team asked",
  // Shown under the current step.
  stepHint: {
    received: "Your report reached the team",
    in_progress: "The team is working on it",
    fixed: "Live now. Try it and tell us if it works.",
    closed: "No further work planned",
  },
  stepTodoFixed: "We'll tell you once the fix is live",
  reportedOn: "reported {date}",
  newTag: "New",
  you: "You",
  worksNow: "Works now",
  stillBroken: "Still broken",
  // After "Works now": reopens the report like "Still broken".
  reopen: "Still broken after all? Reopen",
  brokenPlaceholder: "What's still wrong? (optional)",
  replyPlaceholder: "Add a detail for the team…",
  answerPlaceholder: "Answer the team…",
  replyFailed: "Couldn't send your message",
  peekFixed: "Fixed: {title}",
  peekFixedSub: "Live now · try it and tell us if it works",
  peekQuestion: "The team asked about your report",
  peekQuestionSub: "click to answer",
  peekMany: "{count} updates on your reports",
  peekManySub: "Open your reports",
  // Fills <HiPulse.Components.release_note /> in the host's reload banner.
  releaseNote: "Includes your fix: {title}",
  time: {
    justNow: "just now",
    minutes: "{n} min ago",
    hours: "{n}h ago",
    yesterday: "Yesterday",
  },
  // Dates like "2 Oct"; any BCP 47 tag Intl.DateTimeFormat accepts.
  locale: "en-GB",
};

// Re-export so consumer apps can patch individual strings if they
// need to (e.g. brand voice tweaks). Importing & mutating is a
// supported integration path; we document it in the SDK README.
export { T };
// Re-export for consumers that want to install error capture *before*
// LiveView connects (so JS errors during initial page boot are caught
// instead of lost).
export { installErrorCapture, scrubStack as scrubErrorStack } from "./error_capture.js";

const CORNER_KEYS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const CORNER_STORAGE_KEY = "hi-pulse-fab-corner";

export const PulseWidgetHook = {
  mounted() {
    this.reporter = parseJSON(this.el.dataset.reporter, {});
    this.context = parseJSON(this.el.dataset.context, {});
    this.projectSlug = this.el.dataset.projectSlug || null;
    // `data-server-url` is the configured hi_pulse_server origin (e.g.
    // https://pulse.hiral.io). The widget POSTs cross-origin directly
    // there using the project token bound to that origin.
    this.serverUrl = this.el.dataset.serverUrl || "";
    // Project token issued by the feedback admin UI. Bound to a single
    // project — leaking it lets anyone submit fake feedback to that project,
    // not anything else, so v1 is fine exposing it to the browser.
    this.token = this.el.dataset.token || "";
    // Project's tag config — falls back to defaults until the fetch
    // returns. Lazy: we don't block the FAB on the network round-trip;
    // by the time the user clicks Feedback the fetch has almost
    // certainly resolved.
    this.config = { types: DEFAULT_TYPES, priorities: DEFAULT_PRIORITIES };
    // Topic has no default: when the host defines topics, the reporter
    // must pick one explicitly.
    this.state = {
      type: this.config.types[0],
      topic: null,
      priority: defaultPriority(this.config.priorities),
    };
    this.corner = this._loadCorner();
    this._initTooltipEl();
    this._buildFab();
    this._applyCorner();
    // Start recording immediately on mount so the rolling buffer has
    // pre-incident activity by the time the user clicks Feedback.
    installReplayRecorder();
    // v2 — opt-in automatic error capture. The data attribute is set
    // server-side from `:capture_errors` config, so dev/staging never
    // mount the listeners when the consumer's runtime.exs gates the
    // flag on `config_env() == :prod`.
    if (this.el.dataset.captureErrors === "true") {
      installErrorCapture({
        serverUrl: this.serverUrl,
        token: this.token,
        projectSlug: this.projectSlug,
        reporter: this.reporter,
        context: this.context,
      });
    }
    this._loadConfig();
    if (this.el.dataset.reporterToken) {
      this.updates = new ReporterUpdates({
        serverUrl: this.serverUrl,
        token: this.token,
        reporterToken: this.el.dataset.reporterToken,
        fab: this.fab,
        T,
        host: {
          corner: () => this.corner,
          formOpen: () => Boolean(this.formPanel || this.annotatorOverlay),
          closeForm: () => {
            if (this.formPanel || this.annotatorOverlay) this._close();
          },
          openForm: () => this._open(),
          toast: (message) => this._toast(message),
          keepScroll: (fn) => {
            const snap = this._snapshotScroll();
            fn();
            this._restoreScroll(snap);
          },
          onChange: () => this._syncReportsLink(),
        },
      });
    }
  },

  // Fetch the project's allowed event types + priorities from the
  // server so admins can curate them via the admin UI without an SDK
  // redeploy. Network failure → keep the in-memory defaults; the next
  // panel open uses whatever's in `this.config`.
  async _loadConfig() {
    if (!this.token || !this.serverUrl) return;
    try {
      const r = await fetch(`${this.serverUrl}/api/v1/projects/me/config`, {
        headers: { Authorization: `Bearer ${this.token}` },
        credentials: "omit",
      });
      if (!r.ok) return;
      const cfg = await r.json();
      const types = Array.isArray(cfg.types) && cfg.types.length ? cfg.types : DEFAULT_TYPES;
      const priorities =
        Array.isArray(cfg.priorities) && cfg.priorities.length
          ? cfg.priorities
          : DEFAULT_PRIORITIES;
      this.config = { types, priorities };
      // If the previously-selected default isn't in the new lists,
      // snap to the new first.
      if (!types.includes(this.state.type)) this.state.type = types[0];
      if (!priorities.includes(this.state.priority)) {
        this.state.priority = defaultPriority(priorities);
      }
    } catch (_e) {
      // Offline / blocked — keep defaults.
    }
  },

  destroyed() {
    if (this.updates) this.updates.destroy();
    this.updates = null;
    this._destroyFormPanel();
    this._destroyAnnotator();
    this._closeCornerMenu();
    this._destroyTooltipEl();
    if (this.fab) this.fab.remove();
  },

  _buildFab() {
    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "fb-fab";
    fab.setAttribute("aria-label", T.fab);
    fab.setAttribute("data-fb-tooltip", T.fabTooltip);
    fab.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7l-3 3v-3H3a1 1 0 0 1-1-1V3z"/></svg>`;
    fab.setAttribute("aria-expanded", "false");
    // Keep the host page's focus where it is: a plain button takes focus
    // on pointerdown, which blurs whatever the user was editing (and can
    // close popovers or make editors re-scroll to their cursor).
    fab.addEventListener("pointerdown", (e) => {
      e.preventDefault();
    });
    // With unseen reporter updates the FAB leads to them; otherwise it
    // opens the feedback form as always.
    fab.addEventListener("click", () => {
      if (this.formPanel || this.annotatorOverlay) {
        this._close();
      } else if (this.updates?.panelOpen) {
        this.updates.closePanel();
      } else if (this.updates?.unseenCount()) {
        this.updates.openFromFab();
      } else {
        this._open();
      }
    });
    fab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this._openCornerMenu(e.clientX, e.clientY);
    });
    document.body.appendChild(fab);
    this.fab = fab;
    this._attachTooltip(fab);
  },

  _loadCorner() {
    try {
      const saved = localStorage.getItem(CORNER_STORAGE_KEY);
      if (CORNER_KEYS.includes(saved)) return saved;
    } catch (_e) {
      // localStorage may be unavailable (private mode, sandboxed iframe) — fall through.
    }
    return "bottom-right";
  },

  _applyCorner() {
    if (!this.fab) return;
    const c = this.corner;
    this.fab.style.top = c.startsWith("top") ? "16px" : "auto";
    this.fab.style.bottom = c.startsWith("bottom") ? "16px" : "auto";
    this.fab.style.left = c.endsWith("left") ? "16px" : "auto";
    this.fab.style.right = c.endsWith("right") ? "16px" : "auto";
  },

  _openCornerMenu(x, y) {
    this._closeCornerMenu();
    const menu = document.createElement("div");
    menu.className = "fb-corner-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML = `
      <div class="fb-corner-header">${T.cornerHeader}</div>
      ${CORNER_KEYS.map(
        (key) =>
          `<button type="button" class="fb-corner-item${this.corner === key ? " active" : ""}" data-corner="${key}" role="menuitemradio" aria-checked="${this.corner === key}">${cornerIcon(key)}<span>${T.corner[key]}</span></button>`
      ).join("")}
    `;
    document.body.appendChild(menu);

    // Clamp to viewport so the menu never opens off-screen.
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    menu.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-corner]");
      if (!btn) return;
      this.corner = btn.dataset.corner;
      try {
        localStorage.setItem(CORNER_STORAGE_KEY, this.corner);
      } catch (_e) {
        // Ignore — preference just won't persist.
      }
      this._applyCorner();
      this._applyFormPanelCorner();
      this.updates?.applyCorner();
      this._closeCornerMenu();
    });

    this._cornerMenuClickAway = (e) => {
      if (!menu.contains(e.target)) this._closeCornerMenu();
    };
    this._cornerMenuKey = (e) => {
      if (e.key === "Escape") this._closeCornerMenu();
    };
    // Defer so the contextmenu event that opened us doesn't immediately re-close it.
    setTimeout(() => {
      document.addEventListener("mousedown", this._cornerMenuClickAway);
      document.addEventListener("contextmenu", this._cornerMenuClickAway);
      document.addEventListener("keydown", this._cornerMenuKey);
    }, 0);

    this.cornerMenu = menu;
  },

  _closeCornerMenu() {
    if (this.cornerMenu) {
      this.cornerMenu.remove();
      this.cornerMenu = null;
    }
    if (this._cornerMenuClickAway) {
      document.removeEventListener("mousedown", this._cornerMenuClickAway);
      document.removeEventListener("contextmenu", this._cornerMenuClickAway);
      this._cornerMenuClickAway = null;
    }
    if (this._cornerMenuKey) {
      document.removeEventListener("keydown", this._cornerMenuKey);
      this._cornerMenuKey = null;
    }
  },

  _open() {
    if (this.formPanel || this.annotatorOverlay) return;
    this.updates?.closePanel({ handoff: true });
    // Freeze the rrweb buffer at this moment — we don't want the form-filling
    // or annotation activity in the recording.
    pauseRecorder();
    this.attachedBlob = null;
    this.attachedThumbDataUrl = null;
    this.attachedAspect = null;
    this.capturedImage = null;
    this.capturedScale = 1;
    this.savedAnnotations = [];
    this.savedCrop = null;
    // Focusing the title field blurs the host's active element; hosts that
    // react to blur (e.g. editors re-centring their cursor) would scroll
    // the page away from what the user is reporting. Put it back.
    const scrollSnap = this._snapshotScroll();
    this._buildFormPanel();
    this._restoreScroll(scrollSnap);
    if (this.fab) this.fab.setAttribute("aria-expanded", "true");
  },

  // Records window scroll plus the scroll offsets of every scrollable
  // ancestor of the focused element (crossing shadow-DOM boundaries).
  _snapshotScroll() {
    const elements = [];
    let el = document.activeElement;
    while (el) {
      if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
        elements.push({ el, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft });
      }
      if (el.parentElement) {
        el = el.parentElement;
      } else {
        const root = el.getRootNode?.();
        el = typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root.host : null;
      }
    }
    return { elements, windowX: window.scrollX, windowY: window.scrollY };
  },

  // Two frames: lets the host's blur handlers and any scroll they schedule
  // for the next frame run first, then restores the snapshot.
  _restoreScroll(snap) {
    if (!snap) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        snap.elements.forEach(({ el, scrollTop, scrollLeft }) => {
          if (!el.isConnected) return;
          el.scrollTop = scrollTop;
          el.scrollLeft = scrollLeft;
        });
        window.scrollTo(snap.windowX, snap.windowY);
      });
    });
  },

  _buildFormPanel() {
    const panel = document.createElement("div");
    panel.className = "fb-form-panel";
    panel.innerHTML = `
      <form class="fb-panel" novalidate>
        <aside class="fb-shot-col">
          <span class="fb-section-label">${T.fieldScreenshot}</span>
          <div class="fb-screenshot-zone" data-state="empty"></div>
        </aside>
        <div class="fb-fields-col">
          <header class="fb-panel-head">
            <h3>${T.panelTitle}</h3>
            <button type="button" class="fb-head-link" data-action="your-reports" hidden></button>
          </header>
          <div class="fb-panel-body">
            ${
              topicKeys().length
                ? `<div class="fb-field">
              <span class="fb-section-label">${T.fieldTopic}</span>
              <div class="fb-topic-seg" data-group="topic" role="radiogroup" aria-label="${T.fieldTopic}">
                ${topicKeys().map((key) => topicBtn(key, key === this.state.topic)).join("")}
              </div>
            </div>`
                : ""
            }
            <input name="title" type="text" class="fb-input" required maxlength="200" placeholder="${T.titlePlaceholder}" />
            <textarea name="description" class="fb-textarea" rows="3" maxlength="10000" placeholder="${T.descriptionPlaceholder}"></textarea>
            <div class="fb-field">
              <span class="fb-section-label">${T.fieldType}</span>
              <div class="fb-chips" data-group="type" role="radiogroup" aria-label="${T.fieldType}">
                ${this.config.types
                  .map((key) => chip("type", key, typeLabel(key), key === this.state.type))
                  .join("")}
              </div>
            </div>
            <div class="fb-field">
              <span class="fb-section-label">${T.fieldPriority}</span>
              <div class="fb-chips" data-group="priority" role="radiogroup" aria-label="${T.fieldPriority}">
                ${this.config.priorities
                  .map((key) =>
                    chip("prio", key, priorityLabel(key), key === this.state.priority, key),
                  )
                  .join("")}
              </div>
            </div>
          </div>
          <footer class="fb-panel-foot">
            <p class="fb-error" hidden></p>
            <div class="fb-actions">
              <button type="button" class="fb-btn-secondary" data-action="cancel">${T.cancel}</button>
              <button type="submit" class="fb-btn-primary">${T.send}</button>
            </div>
          </footer>
        </div>
      </form>
    `;
    document.body.appendChild(panel);
    this.formPanel = panel;
    this._applyFormPanelCorner();

    panel.querySelectorAll(".fb-chips").forEach((group) => {
      group.addEventListener("click", (e) => {
        const chipEl = e.target.closest(".fb-chip");
        if (!chipEl) return;
        group.querySelectorAll(".fb-chip").forEach((c) => c.classList.remove("active"));
        chipEl.classList.add("active");
        const key = group.dataset.group;
        this.state[key] = chipEl.dataset.value;
      });
    });

    panel.querySelectorAll(".fb-topic-seg").forEach((group) => {
      group.addEventListener("click", (e) => {
        const btn = e.target.closest(".fb-topic-btn");
        if (!btn) return;
        group.querySelectorAll(".fb-topic-btn").forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-checked", "true");
        this.state.topic = btn.dataset.value;
        // Picking clears the "missing" hint so the reporter sees the gate lift.
        const error = this.formPanel?.querySelector(".fb-error");
        if (error && !error.hidden && error.dataset.kind === "topic") {
          error.hidden = true;
          error.dataset.kind = "";
        }
      });
    });

    panel.querySelector("[data-action='cancel']").addEventListener("click", () => this._close());

    // Opening the reports panel closes this form.
    panel.querySelector("[data-action='your-reports']").addEventListener("click", () => {
      this.updates?.openList();
    });
    this._syncReportsLink();

    panel.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      this._submit();
    });

    this._renderScreenshotZone();

    this._formKeyHandler = (e) => {
      if (e.key === "Escape" && !this._submitting) this._close();
    };
    document.addEventListener("keydown", this._formKeyHandler);

    panel.querySelector("input[name=title]").focus({ preventScroll: true });
  },

  // "Your reports" link in the form header, once the reporter has any.
  _syncReportsLink() {
    const link = this.formPanel?.querySelector("[data-action='your-reports']");
    if (!link) return;
    link.hidden = !this.updates?.hasReports();
    const count = this.updates?.unseenCount() || 0;
    link.textContent = T.yourReports;
    if (count) {
      const badge = document.createElement("span");
      badge.className = "fb-count";
      badge.textContent = String(count);
      link.append(" ", badge);
    }
  },

  _applyFormPanelCorner() {
    if (!this.formPanel) return;
    const c = this.corner;
    // Anchor the panel near the FAB corner, with a 64px gap so it doesn't
    // sit on top of the (now hidden) FAB position.
    this.formPanel.style.top = c.startsWith("top") ? "64px" : "auto";
    this.formPanel.style.bottom = c.startsWith("bottom") ? "64px" : "auto";
    this.formPanel.style.left = c.endsWith("left") ? "16px" : "auto";
    this.formPanel.style.right = c.endsWith("right") ? "16px" : "auto";
  },

  _renderScreenshotZone() {
    const zone = this.formPanel.querySelector(".fb-screenshot-zone");
    if (!zone) return;
    // Drive panel width from screenshot orientation: landscape shots get a
    // wider grid so the preview reads as a 16:9 frame; portrait keeps the
    // compact column.
    if (this.formPanel) {
      if (this.attachedBlob && this.attachedAspect != null && this.attachedAspect >= 1.2) {
        this.formPanel.dataset.shotOrientation = "landscape";
      } else {
        delete this.formPanel.dataset.shotOrientation;
      }
    }
    if (this.attachedBlob && this.attachedThumbDataUrl) {
      zone.dataset.state = "attached";
      zone.innerHTML = `
        <button type="button" class="fb-thumb-btn" data-action="edit-screenshot" aria-label="${T.editScreenshot}">
          <img class="fb-thumb" src="${this.attachedThumbDataUrl}" alt="${T.screenshotAttached}" />
        </button>
        <div class="fb-thumb-actions">
          <button type="button" class="fb-thumb-action" data-action="edit-screenshot">${editIcon()}<span>${T.editScreenshot}</span></button>
          <button type="button" class="fb-thumb-action" data-action="replace-screenshot">${cameraIcon()}<span>${T.replaceScreenshot}</span></button>
          <button type="button" class="fb-thumb-action fb-thumb-remove" data-action="remove-screenshot">${trashIcon()}<span>${T.removeScreenshot}</span></button>
        </div>
      `;
      zone.querySelectorAll("[data-action='edit-screenshot']").forEach((el) =>
        el.addEventListener("click", () => this._editScreenshot())
      );
      zone.querySelector("[data-action='replace-screenshot']").addEventListener("click", () => {
        this.attachedBlob = null;
        this.attachedThumbDataUrl = null;
        this.attachedAspect = null;
        this.capturedImage = null;
        this.savedAnnotations = [];
        this.savedCrop = null;
        this._addScreenshot();
      });
      zone.querySelector("[data-action='remove-screenshot']").addEventListener("click", () => {
        this.attachedBlob = null;
        this.attachedThumbDataUrl = null;
        this.attachedAspect = null;
        this.capturedImage = null;
        this.savedAnnotations = [];
        this.savedCrop = null;
        this._renderScreenshotZone();
      });
    } else {
      zone.dataset.state = "empty";
      zone.innerHTML = `
        <button type="button" class="fb-shot-empty" data-action="add-screenshot">
          ${cameraIcon()}
          <span class="fb-shot-cta">${T.addScreenshot}</span>
          <span class="fb-shot-hint">${T.screenshotHint}</span>
        </button>
      `;
      zone.querySelector("[data-action='add-screenshot']").addEventListener("click", () => {
        this._addScreenshot();
      });
    }
  },

  _editScreenshot() {
    if (!this.capturedImage) return;
    if (this.formPanel) this.formPanel.style.visibility = "hidden";
    this._buildAnnotatorOverlay(this.capturedImage, this.capturedScale, {
      initialAnnotations: this.savedAnnotations,
      initialCrop: this.savedCrop,
    });
  },

  async _addScreenshot() {
    if (this._capturing) return;
    this._capturing = true;
    // Hide the form panel + FAB while the share prompt and annotator are
    // active, so neither shows up in the captured frame.
    if (this.formPanel) this.formPanel.style.visibility = "hidden";

    let captured;
    try {
      // Browser-native screen capture. Pixel-perfect (no CORS), at the cost of
      // a one-click "share this tab" permission prompt.
      captured = await captureDisplay();
    } catch (err) {
      // NotAllowedError = user cancelled the share prompt; bail silently.
      if (err?.name !== "NotAllowedError") {
        console.error("[hi-pulse] screenshot capture failed", err);
      }
      if (this.formPanel) this.formPanel.style.visibility = "";
      this._capturing = false;
      return;
    }

    this._capturing = false;
    // Initial capture — remember the raw bitmap so a later "Bearbeiten" can
    // reopen the annotator without re-prompting for screen share.
    this.capturedImage = captured.canvas;
    this.capturedScale = captured.scale;
    this.savedAnnotations = [];
    this._buildAnnotatorOverlay(captured.canvas, captured.scale);
  },

  _buildAnnotatorOverlay(screenshotCanvas, captureScale = 1, opts = {}) {
    const overlay = document.createElement("div");
    overlay.className = "fb-overlay";
    overlay.innerHTML = `
      <div class="fb-stage">
        <canvas class="fb-canvas"></canvas>
      </div>
      <div class="fb-toolbar" role="toolbar" aria-label="${T.fab}">
        <button type="button" class="fb-tool" data-tool="cursor" data-fb-tooltip="${T.toolCursor}" aria-label="${T.toolCursor}">${arrowSelectIcon()}</button>
        <button type="button" class="fb-tool active" data-tool="rect" data-fb-tooltip="${T.toolRect}" aria-label="${T.toolRect}">${rectIcon()}</button>
        <button type="button" class="fb-tool" data-tool="arrow" data-fb-tooltip="${T.toolArrow}" aria-label="${T.toolArrow}">${arrowIcon()}</button>
        <button type="button" class="fb-tool" data-tool="text" data-fb-tooltip="${T.toolText}" aria-label="${T.toolText}"><span class="fb-tool-letter">T</span></button>
        <button type="button" class="fb-tool" data-tool="crop" data-fb-tooltip="${T.toolCrop}" aria-label="${T.toolCrop}">${cropIcon()}</button>
        <button type="button" class="fb-tool-apply" data-action="apply-crop" aria-label="${T.toolApplyCrop}" hidden disabled>${T.toolApplyCrop}</button>
        <span class="fb-tool-sep" aria-hidden="true"></span>
        <button type="button" class="fb-tool" data-action="undo" data-fb-tooltip="${T.toolUndo}" aria-label="${T.toolUndo}">${undoIcon()}</button>
        <button type="button" class="fb-tool" data-action="delete" data-fb-tooltip="${T.toolDelete}" aria-label="${T.toolDelete}" disabled>${trashIcon()}</button>
        <span class="fb-tool-sep" aria-hidden="true"></span>
        <button type="button" class="fb-btn-secondary" data-action="annotator-cancel">${T.annotatorCancel}</button>
        <button type="button" class="fb-btn-primary" data-action="annotator-done">${T.annotatorDone}</button>
      </div>
    `;
    document.body.appendChild(overlay);
    this.annotatorOverlay = overlay;
    overlay.querySelectorAll("[data-fb-tooltip]").forEach((el) => this._attachTooltip(el));

    const canvasEl = overlay.querySelector(".fb-canvas");
    canvasEl.width = screenshotCanvas.width;
    canvasEl.height = screenshotCanvas.height;
    const deleteBtn = overlay.querySelector("[data-action='delete']");
    const applyBtn = overlay.querySelector("[data-action='apply-crop']");
    const updateApplyVisibility = (tool) => {
      applyBtn.hidden = tool !== "crop";
    };
    this.annotator = new Annotator(canvasEl, screenshotCanvas, {
      scale: captureScale,
      initialAnnotations: opts.initialAnnotations,
      initialCrop: opts.initialCrop,
      onSelectionChange: (hasSelection) => {
        deleteBtn.disabled = !hasSelection;
      },
      onToolChange: (tool) => {
        overlay.querySelectorAll("[data-tool]").forEach((b) => {
          b.classList.toggle("active", b.dataset.tool === tool);
        });
        updateApplyVisibility(tool);
      },
      onCropDraftChange: (hasDraft) => {
        applyBtn.disabled = !hasDraft;
      },
    });
    this.annotator.setTool("rect");
    updateApplyVisibility("rect");

    applyBtn.addEventListener("click", () => {
      this.annotator.commitCropDraft();
    });

    overlay.querySelectorAll("[data-tool]").forEach((btn) => {
      btn.addEventListener("click", () => {
        overlay.querySelectorAll("[data-tool]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.annotator.setTool(btn.dataset.tool);
        // setTool may have re-routed to cursor (auto-commit on crop exit);
        // sync the active-class + apply-visibility to where we actually landed.
        const landed = this.annotator.tool;
        if (landed !== btn.dataset.tool) {
          overlay.querySelectorAll("[data-tool]").forEach((b) => {
            b.classList.toggle("active", b.dataset.tool === landed);
          });
        }
        updateApplyVisibility(landed);
      });
    });

    overlay.querySelector("[data-action='undo']").addEventListener("click", () => {
      this.annotator.undo();
    });

    deleteBtn.addEventListener("click", () => {
      this.annotator.deleteSelected();
    });

    overlay.querySelector("[data-action='annotator-cancel']").addEventListener("click", () =>
      this._closeAnnotator({ keepScreenshot: false })
    );

    overlay.querySelector("[data-action='annotator-done']").addEventListener("click", () =>
      this._closeAnnotator({ keepScreenshot: true })
    );

    this._annotatorKeyHandler = (e) => {
      if (e.key === "Escape") this._closeAnnotator({ keepScreenshot: false });
    };
    document.addEventListener("keydown", this._annotatorKeyHandler);
  },

  async _closeAnnotator({ keepScreenshot }) {
    if (!this.annotator || !this.annotatorOverlay) return;

    if (keepScreenshot) {
      // Auto-commit a pending crop draft on Fertig so the user doesn't lose
      // a half-drawn region they forgot to apply.
      if (this.annotator.cropDraft) {
        this.annotator.commitCropDraft();
      }
      this.attachedBlob = await this.annotator.toBlob();
      // Thumbnail mirrors the export — cropped if a crop is set — so the form
      // shows what will actually be sent. Capture aspect ratio so the panel
      // can widen for landscape shots while staying compact for portrait.
      const rendered = this.annotator.renderToCanvas();
      this.attachedThumbDataUrl = rendered.toDataURL("image/png");
      this.attachedAspect = rendered.height > 0 ? rendered.width / rendered.height : 1;
      // Snapshot full image + annotations + crop so a later "Bearbeiten" round
      // resumes exactly where the user left off, including the crop viewport.
      this.capturedImage = this.annotator.getImage();
      this.savedAnnotations = this.annotator.getAnnotations();
      this.savedCrop = this.annotator.getCrop();
    } else if (!this.attachedBlob) {
      // First-pass cancel — nothing was ever attached, drop the raw capture.
      this.capturedImage = null;
      this.savedAnnotations = [];
      this.savedCrop = null;
    }
    // Re-edit cancel falls through: keep the prior attachedBlob/capturedImage
    // intact so the user can reopen it again later.

    this._destroyAnnotator();

    if (this.formPanel) {
      this.formPanel.style.visibility = "";
      this._renderScreenshotZone();
    }
  },

  _destroyAnnotator() {
    if (this.annotator) {
      this.annotator.destroy();
      this.annotator = null;
    }
    if (this.annotatorOverlay) {
      this.annotatorOverlay.remove();
      this.annotatorOverlay = null;
    }
    if (this._annotatorKeyHandler) {
      document.removeEventListener("keydown", this._annotatorKeyHandler);
      this._annotatorKeyHandler = null;
    }
  },

  _destroyFormPanel() {
    if (this.formPanel) {
      this.formPanel.remove();
      this.formPanel = null;
    }
    if (this._formKeyHandler) {
      document.removeEventListener("keydown", this._formKeyHandler);
      this._formKeyHandler = null;
    }
  },

  async _submit() {
    if (this._submitting || !this.formPanel) return;
    const form = this.formPanel.querySelector("form");

    if (!form.title.value.trim()) {
      form.title.focus();
      return;
    }

    if (topicKeys().length && !topicKeys().includes(this.state.topic)) {
      const error = this.formPanel.querySelector(".fb-error");
      if (error) {
        error.textContent = T.topicMissing;
        error.dataset.kind = "topic";
        error.hidden = false;
      }
      const seg = this.formPanel.querySelector(".fb-topic-seg");
      if (seg) {
        seg.classList.remove("fb-shake");
        // Force a reflow so the same class re-triggers the keyframes.
        void seg.offsetWidth;
        seg.classList.add("fb-shake");
        seg.querySelector(".fb-topic-btn")?.focus();
      }
      return;
    }

    if (!this.config.priorities.includes(this.state.priority)) {
      this.state.priority = defaultPriority(this.config.priorities);
    }

    this._submitting = true;

    // Snapshot all the form data BEFORE closing the panel, since closing
    // tears down the DOM nodes we'd otherwise be reading from.
    const blob = this.attachedBlob || null;
    const replayBlob = await getReplayBlob();
    const payload = {
      title: form.title.value.trim(),
      description: form.description.value.trim() || null,
      type: this.state.type,
      topic: topicKeys().length ? this.state.topic : null,
      priority: this.state.priority,
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      user_agent: navigator.userAgent,
      console_buffer: extractConsoleBuffer(),
      context: this.context || {},
      reporter: this.reporter || {},
      replay_duration_ms: replayBlob ? getReplayDurationMs() : null,
    };

    const fd = new FormData();
    fd.append("payload", JSON.stringify(payload));
    if (blob) fd.append("screenshot", blob, "screenshot.png");
    if (replayBlob) fd.append("replay", replayBlob, "replay.json.gz");

    // Optimistic close — the user gets immediate UI feedback rather than
    // staring at a frozen "Sending …" button while S3 + Linear churn.
    this._close();
    const toast = this._toast(T.sending, null, { sticky: true });

    try {
      const url = (this.serverUrl || "").replace(/\/+$/, "") + "/api/v1/events";
      const headers = {};
      if (this.token) headers["authorization"] = "Bearer " + this.token;
      const res = await fetch(url, {
        method: "POST",
        body: fd,
        headers,
        // No cookies — the server is token-authed and cross-origin cookies
        // would force a CORS preflight on every submission.
        credentials: "omit",
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const linearUrl = data.linear_url || null;
      this._updateToast(toast, T.toastSuccess, linearUrl);
    } catch (err) {
      console.error("[hi-pulse] submit failed", err);
      this._updateToast(toast, T.toastFail, null);
    } finally {
      this._submitting = false;
    }
  },

  _close() {
    this._destroyAnnotator();
    this._destroyFormPanel();
    this.attachedBlob = null;
    this.attachedThumbDataUrl = null;
    this.attachedAspect = null;
    this.capturedImage = null;
    this.savedAnnotations = [];
    this.savedCrop = null;
    if (this.fab) this.fab.setAttribute("aria-expanded", "false");
    // Whether the user submitted or cancelled, recording resumes from a
    // fresh slate so the next bug report can capture activity that follows.
    resumeRecorder();
    // A reporter update that arrived while the form was open can show now.
    this.updates?.flushPeek();
  },

  _toast(message, linkUrl, options = {}) {
    const toast = document.createElement("div");
    toast.className = "fb-toast";
    this._renderToastContents(toast, message, linkUrl);
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));

    if (!options.sticky) {
      this._scheduleToastDismiss(toast, 4000);
    }
    return toast;
  },

  _updateToast(toast, message, linkUrl) {
    if (!toast || !toast.isConnected) {
      this._toast(message, linkUrl);
      return;
    }
    this._renderToastContents(toast, message, linkUrl);
    this._scheduleToastDismiss(toast, 4000);
  },

  _renderToastContents(toast, message, linkUrl) {
    while (toast.firstChild) toast.removeChild(toast.firstChild);
    if (linkUrl) {
      const a = document.createElement("a");
      a.href = linkUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = T.toastLinear;
      toast.append(`${message} · `, a);
    } else {
      toast.textContent = message;
    }
  },

  _scheduleToastDismiss(toast, ms) {
    clearTimeout(toast._dismissTimer);
    toast._dismissTimer = setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 300);
    }, ms);
  },

  // Custom tooltips. Single shared element on body, reused. Show on hover
  // after a 400ms delay (or instantly on focus); hide on mouseout / blur /
  // click. Replaces native `title=` so the chrome matches the design system.
  _initTooltipEl() {
    if (this._tooltipEl) return;
    const el = document.createElement("div");
    el.className = "fb-tooltip";
    el.setAttribute("role", "tooltip");
    document.body.appendChild(el);
    this._tooltipEl = el;
  },

  _destroyTooltipEl() {
    this._cancelTooltipTimer();
    if (this._tooltipEl) {
      this._tooltipEl.remove();
      this._tooltipEl = null;
    }
  },

  _attachTooltip(el) {
    if (!el || el._fbTooltipBound) return;
    el._fbTooltipBound = true;
    el.addEventListener("mouseenter", () => this._scheduleTooltip(el));
    el.addEventListener("mouseleave", () => this._hideTooltip());
    el.addEventListener("focus", () => this._showTooltipNow(el));
    el.addEventListener("blur", () => this._hideTooltip());
    el.addEventListener("click", () => this._hideTooltip());
  },

  _scheduleTooltip(el) {
    this._cancelTooltipTimer();
    this._tooltipTimer = setTimeout(() => this._showTooltipNow(el), 400);
  },

  _cancelTooltipTimer() {
    if (this._tooltipTimer) {
      clearTimeout(this._tooltipTimer);
      this._tooltipTimer = null;
    }
  },

  _showTooltipNow(el) {
    this._cancelTooltipTimer();
    if (!el || !el.dataset || !el.dataset.fbTooltip) return;
    if (!this._tooltipEl) this._initTooltipEl();
    const tt = this._tooltipEl;
    tt.textContent = el.dataset.fbTooltip;
    // Position off-screen to measure, then place.
    tt.style.left = "-9999px";
    tt.style.top = "-9999px";
    tt.classList.add("visible");
    const target = el.getBoundingClientRect();
    const rect = tt.getBoundingClientRect();
    const gap = 8;
    const margin = 8;
    let top = target.top - rect.height - gap;
    if (top < margin) top = target.bottom + gap;
    let left = target.left + (target.width - rect.width) / 2;
    if (left < margin) left = margin;
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - rect.width;
    }
    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;
  },

  _hideTooltip() {
    this._cancelTooltipTimer();
    if (this._tooltipEl) this._tooltipEl.classList.remove("visible");
  },
};

// Capture a single frame of the current tab via the browser's native display
// capture API. Returns the frame as a canvas + the scale ratio between captured
// pixels and CSS pixels (used by the annotator to size strokes consistently).
async function captureDisplay() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("getDisplayMedia not supported in this browser");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    // Chromium-only hints; ignored elsewhere. They tell the picker to default
    // to the current tab and skip the surface-switching toolbar.
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
    monitorTypeSurfaces: "exclude",
  });

  try {
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();

    const bitmap = await grabFrame(stream, track);
    const width = bitmap.width || settings.width;
    const height = bitmap.height || settings.height;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === "function") bitmap.close();

    // Captured frame is in device pixels; window.innerWidth is in CSS pixels.
    // Their ratio is the effective DPR of the capture, which the annotator
    // uses to scale stroke/font sizes consistently across displays.
    const scale = width / window.innerWidth || 1;
    return { canvas, scale };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

async function grabFrame(stream, track) {
  if (typeof ImageCapture !== "undefined") {
    try {
      return await new ImageCapture(track).grabFrame();
    } catch (_e) {
      // Some browsers expose ImageCapture but reject for display streams.
      // Fall through to the <video> path.
    }
  }
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  // Wait for the first painted frame so drawImage has real pixels.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return video;
}

function parseJSON(raw, fallback) {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return fallback;
  }
}

function topicKeys() {
  return Object.keys(T.topic || {});
}

function topicBtn(value, active = false) {
  // Mirrors the chip role contract: the radiogroup parent owns aria-label,
  // each button is a radio. `sub` is an optional second line.
  const t = T.topic[value] || {};
  const label = t.label || value;
  return `<button type="button" class="fb-topic-btn${active ? " active" : ""}" data-value="${value}" role="radio" aria-checked="${active}">
      <span class="fb-topic-label-row"><span class="fb-topic-marker" aria-hidden="true"></span>${label}</span>
      ${t.sub ? `<span class="fb-topic-sub">${t.sub}</span>` : ""}
    </button>`;
}

function typeLabel(key) {
  return (T.type && T.type[key]) || titleize(key);
}

function priorityLabel(key) {
  return (T.priority && T.priority[key]) || titleize(key);
}

// Pick a sensible default priority. "medium" is the conventional pick;
// otherwise the middle of the list, otherwise the first.
function defaultPriority(priorities) {
  if (priorities.includes("medium")) return "medium";
  if (priorities.length === 0) return "medium";
  return priorities[Math.floor(priorities.length / 2)];
}

function chip(key, value, label, active = false, prioVariant = null) {
  // `data-prio` carries the value (low/medium/urgent) for state, while
  // `data-prio-variant` carries the same string for CSS theming so styles
  // don't have to dual-purpose the value attribute.
  const attrs =
    key === "prio"
      ? `data-prio="${value}" data-value="${value}"${prioVariant ? ` data-prio-variant="${prioVariant}"` : ""}`
      : `data-type="${value}" data-value="${value}"`;
  return `<button type="button" class="fb-chip ${active ? "active" : ""}" ${attrs} role="radio" aria-checked="${active}"><span class="fb-dot" aria-hidden="true"></span>${label}</button>`;
}

function rectIcon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.75" y="3.75" width="10.5" height="8.5" rx="0.5"/></svg>`;
}

function arrowIcon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12 L13 4"/><path d="M8 4 L13 4 L13 9"/></svg>`;
}

function arrowSelectIcon() {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 2 L13 7.5 L8.5 8.5 L11 13 L9 14 L6.5 9.5 L3 12 Z"/></svg>`;
}

function undoIcon() {
  // Heroicons "arrow-uturn-left" (outline, 24×24).
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"/></svg>`;
}

function cropIcon() {
  // Heroicons-style crop glyph — two L-brackets plus the dashed marquee
  // edges, sized to match the other 14×14 toolbar icons.
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 1.5 V11 a1 1 0 0 0 1 1 H14"/><path d="M11.5 14.5 V5 a1 1 0 0 0 -1 -1 H2"/></svg>`;
}

function cameraIcon() {
  // Heroicons "camera" (outline, 24×24).
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"/><path d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z"/></svg>`;
}

function editIcon() {
  // Heroicons "pencil-square" (outline, 24×24).
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.862 4.487 18.549 2.8a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"/></svg>`;
}

function cornerIcon(corner) {
  // 12×12 frame with a small filled dot in the named corner.
  const cx = corner.endsWith("left") ? 3.5 : 8.5;
  const cy = corner.startsWith("top") ? 3.5 : 8.5;
  return `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="${cx}" cy="${cy}" r="1.5" fill="currentColor"/></svg>`;
}

function trashIcon() {
  // Heroicons "trash" (outline, 24×24).
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>`;
}
