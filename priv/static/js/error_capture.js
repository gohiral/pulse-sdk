// Browser-side error capture for the hi_pulse SDK.
//
// Hooks `window.error` and `unhandledrejection`, batches events with a
// 1s debounce / 100-event cap, scrubs sensitive values out of stack
// traces, and ships to `POST /api/v1/events/error` on the configured
// hi_pulse_server. Self-protects against transport-failure loops by
// dropping any event whose stack mentions our own bundle.
//
// Wired by `pulse-widget.js` when the widget div carries
// `data-capture-errors="true"` (set by `HiPulse.Components` from the
// `:capture_errors` config key — see `HiPulse.Application`).
//
// No JS unit tests; covered by manual e2e in Phase G of v2.

const DEBOUNCE_MS = 1000;
const MAX_BATCH = 100;

const SENSITIVE_KEYS = [
  "password",
  "passwd",
  "password_hash",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "api-secret",
  "secret",
  "secret_key",
  "authorization",
  "auth",
  "cookie",
  "set-cookie",
  "session",
  "session_id",
  "sessionid",
  "bearer",
];

let installed = false;

/**
 * Install the global error listeners. Idempotent — safe to call from
 * the LiveView hook's `mounted()` which can fire multiple times across
 * a page lifecycle.
 *
 * @param {object} opts
 * @param {string} opts.serverUrl   - e.g. "https://pulse.hiral.io"
 * @param {string} opts.token       - per-project bearer token
 * @param {string} [opts.projectSlug]
 * @param {object} [opts.reporter]  - identity stamped on every event
 * @param {object} [opts.context]   - extra key/value pairs
 */
export function installErrorCapture(opts) {
  if (installed) return;
  if (typeof window === "undefined") return;
  if (!opts || !opts.serverUrl || !opts.token) return;

  installed = true;

  const { serverUrl, token, reporter = {}, context = {} } = opts;
  const queue = [];
  let flushTimer = null;

  function scheduleFlush() {
    if (queue.length >= MAX_BATCH) {
      flush();
      return;
    }
    if (!flushTimer) flushTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (queue.length === 0) return;
    const batch = queue.splice(0, MAX_BATCH);
    ship(batch);
    // If more came in past the cap, drain again on the next tick.
    if (queue.length > 0) scheduleFlush();
  }

  function ship(events) {
    const body = JSON.stringify({ events });
    // `keepalive: true` lets the request survive page unload — sendBeacon
    // would too, but it can't carry a custom Authorization header, so
    // fetch+keepalive is the cleanest single path.
    try {
      fetch(`${serverUrl}/api/v1/events/error`, {
        method: "POST",
        keepalive: true,
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body,
      }).catch(() => {
        // Network error — drop. The loop guard ensures we don't retry
        // forever; lost telemetry is the right trade vs. cascading on
        // an offline browser.
      });
    } catch (_e) {
      // Synchronous throws (extremely rare; e.g. hostile page CSP) —
      // also drop.
    }
  }

  function capture(payload) {
    // Self-protection: never re-submit errors that originated in our
    // own bundle. Without this, a transport failure logged via
    // `console.error` (or a syntax error in the bundle itself) would
    // produce events that loop right back through this handler.
    if (
      payload.stack_trace &&
      /error_capture\.js|pulse-widget\.js|hi_pulse/i.test(payload.stack_trace)
    ) {
      return;
    }
    queue.push(payload);
    scheduleFlush();
  }

  function payloadFromError(ev) {
    const err = ev.error;
    return {
      error_class: (err && err.name) || "Error",
      error_message: (err && err.message) || ev.message || "",
      error_origin: "javascript",
      stack_trace: scrubStack((err && err.stack) || ""),
      url: window.location.href,
      user_agent: navigator.userAgent,
      reporter,
      context,
      occurred_at: new Date().toISOString(),
    };
  }

  function payloadFromRejection(ev) {
    const reason = ev.reason;
    const isError = reason instanceof Error;
    return {
      error_class: isError ? reason.name : "UnhandledRejection",
      error_message: isError ? reason.message : safeString(reason),
      error_origin: "javascript",
      stack_trace: scrubStack(isError ? reason.stack || "" : ""),
      url: window.location.href,
      user_agent: navigator.userAgent,
      reporter,
      context,
      occurred_at: new Date().toISOString(),
    };
  }

  window.addEventListener("error", (ev) => capture(payloadFromError(ev)));
  window.addEventListener("unhandledrejection", (ev) => capture(payloadFromRejection(ev)));
  // Best-effort flush on page unload — fetch keepalive carries the
  // request even after the page is gone.
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
}

/**
 * Scrub sensitive values out of a stack-trace string. Mirrors the
 * Elixir `HiPulse.Scrubber` rules so server-side and client-side
 * error reports get the same redaction guarantees.
 */
export function scrubStack(stack) {
  if (!stack || typeof stack !== "string") return "";

  let out = stack;

  // Inline `key: "value"`, `key: 'value'`, `key: :atom`, `"key": "value"`.
  for (const k of SENSITIVE_KEYS) {
    const escaped = k.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re = new RegExp(
      `("?${escaped}"?)\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|:[A-Za-z0-9_]+)`,
      "gi"
    );
    out = out.replace(re, '$1: "[REDACTED]"');
  }

  // Bearer tokens.
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]");

  // Cookie / Set-Cookie header values.
  out = out.replace(/(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]");

  // 50-frame / 10kB cap. Frame split on newlines is approximate — JS
  // stacks have one frame per line for the engines we care about
  // (V8, JavaScriptCore, Gecko).
  const frames = out.split("\n").slice(0, 50).join("\n");
  if (frames.length > 10000) {
    return frames.slice(0, 10000) + "\n…[truncated]";
  }
  return frames;
}

function safeString(value) {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch (_e) {
    return String(value);
  }
}
