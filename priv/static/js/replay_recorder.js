// Records a rolling buffer of rrweb DOM events (≈2.5–5 min) so the
// feedback widget can attach it to a bug report. The recorder runs only
// when the `rrweb` global is present (loaded via the vendored UMD script
// in the `<HiPulse.Components.pulse_widget />` component).
//
// `installReplayRecorder()` is idempotent. `getReplayBlob()` returns a
// gzipped Blob ready for upload, or `null` if no events were captured.
//
// The rrweb console-record plugin is also enabled when available, so
// console output (log/info/warn/error) is captured inline with the event
// timeline. `extractConsoleBuffer()` derives a flat list of console
// entries from the buffer for the feedback report's `console_buffer` field.
//
// Pause/resume: when the user opens the feedback widget, the widget calls
// `pauseRecorder()` to freeze the current buffer (so the modal-filling
// activity isn't recorded). On submit, that frozen snapshot is what gets
// uploaded. On cancel, `resumeRecorder()` discards the snapshot and
// resumes a fresh recording.
//
// Buffer model: rrweb only emits a fullSnapshot at startup, then
// incremental mutations referencing those node ids. A naive timestamp
// trim drops the snapshot but keeps later incrementals — at replay the
// player can't resolve those ids and floods "Node with id 'X' not found"
// warnings. We use `checkoutEveryNms` so rrweb takes a fresh fullSnapshot
// every CHECKOUT_MS, and we keep two epochs (one prior + the current
// one), each anchored at a meta+fullSnapshot pair. The retained buffer
// always begins with a complete snapshot.

const CHECKOUT_MS = 2.5 * 60 * 1000;
const FULL_SNAPSHOT_TYPE = 2;
const META_TYPE = 4;
const CONSOLE_PLUGIN_NAME = "rrweb/console@1";
// rrweb loads via a deferred <script> emitted by the pulse_widget
// component. The LiveView hook's mounted() can fire before that
// script has executed on the very first page load, so installReplayRecorder
// polls briefly for the global instead of silently giving up.
const INSTALL_POLL_MS = 50;
const INSTALL_MAX_ATTEMPTS = 100;

let events = [];
let prevEpoch = [];
let stopFn = null;
let frozenSnapshot = null;
let installAttempts = 0;
let installTimer = null;

function consolePlugins() {
  if (typeof window === "undefined") return [];
  const factory = window.rrwebConsoleRecord?.getRecordConsolePlugin;
  if (typeof factory !== "function") return [];

  return [
    factory({
      level: ["log", "info", "warn", "error", "debug"],
      lengthThreshold: 1000,
      stringifyOptions: {
        stringLengthLimit: 1000,
        numOfKeysLimit: 50,
        depthOfLimit: 4,
      },
    }),
  ];
}

export function installReplayRecorder() {
  if (stopFn) return;
  if (typeof window === "undefined") return;

  if (!window.rrweb) {
    if (installAttempts >= INSTALL_MAX_ATTEMPTS) return;
    installAttempts += 1;
    installTimer = setTimeout(installReplayRecorder, INSTALL_POLL_MS);
    return;
  }
  installAttempts = 0;
  installTimer = null;

  try {
    stopFn = window.rrweb.record({
      emit(event, isCheckout) {
        events.push(event);
        // Anchor a new epoch on the fullSnapshot of every checkout (rrweb
        // emits Meta then FullSnapshot at each checkout; we anchor on the
        // FullSnapshot and pull the preceding Meta in with it).
        if (isCheckout && event.type === FULL_SNAPSHOT_TYPE) {
          const fsIdx = events.length - 1;
          const anchor =
            fsIdx > 0 && events[fsIdx - 1].type === META_TYPE ? fsIdx - 1 : fsIdx;
          prevEpoch = events.slice(0, anchor);
          events = events.slice(anchor);
        }
      },
      checkoutEveryNms: CHECKOUT_MS,
      sampling: { mousemove: 50, scroll: 100 },
      // Skip <script> + comment nodes in the recorded DOM. The replay player
      // iframe is sandboxed without `allow-scripts`, so any captured inline
      // scripts log a noisy "blocked script execution" error during replay.
      slimDOMOptions: { script: true, comment: true },
      plugins: consolePlugins(),
    });
  } catch (err) {
    // Never crash the app over instrumentation.
    console.warn("[hi-pulse] replay recorder failed to install", err);
    stopFn = null;
  }
}

// Freezes the current buffer and stops recording. The frozen snapshot is
// what `getReplayBlob()` returns until `resumeRecorder()` is called.
export function pauseRecorder() {
  if (stopFn) {
    try {
      stopFn();
    } catch (_e) {
      // ignore
    }
    stopFn = null;
  }
  frozenSnapshot = prevEpoch.concat(events);
}

// Discards the frozen snapshot and resumes recording from a clean slate.
export function resumeRecorder() {
  frozenSnapshot = null;
  events = [];
  prevEpoch = [];
  // Re-arm the install polling budget — a tab can be open long enough for
  // a previous load-race to have exhausted INSTALL_MAX_ATTEMPTS even though
  // rrweb has since loaded.
  installAttempts = 0;
  if (installTimer) {
    clearTimeout(installTimer);
    installTimer = null;
  }
  installReplayRecorder();
}

function activeBuffer() {
  return frozenSnapshot || prevEpoch.concat(events);
}

// Walks the active rrweb buffer and returns console plugin entries in the
// flat shape persisted on the feedback report (`{level, message, timestamp}`).
// Returns [] when the plugin isn't loaded or no console events were emitted.
export function extractConsoleBuffer() {
  return activeBuffer()
    .filter(
      (e) => e?.type === 6 && e?.data?.plugin === CONSOLE_PLUGIN_NAME,
    )
    .map((e) => {
      const payload = e.data.payload || {};
      const args = Array.isArray(payload.payload) ? payload.payload : [];
      return {
        level: payload.level || "log",
        message: args.join(" "),
        timestamp: new Date(e.timestamp).toISOString(),
      };
    });
}

export function getReplayDurationMs() {
  const buf = activeBuffer();
  if (buf.length < 2) return 0;
  return buf[buf.length - 1].timestamp - buf[0].timestamp;
}

// Returns a gzipped JSON Blob of the buffered events, or null if there is
// nothing to ship. Uses the native CompressionStream API — no external dep.
export async function getReplayBlob() {
  const buf = activeBuffer();
  if (buf.length === 0) return null;
  if (typeof CompressionStream === "undefined") return null;

  try {
    const json = JSON.stringify(buf);
    const stream = new Blob([json]).stream().pipeThrough(
      new CompressionStream("gzip"),
    );
    return await new Response(stream).blob();
  } catch (err) {
    console.warn("[hi-pulse] replay gzip failed", err);
    return null;
  }
}
