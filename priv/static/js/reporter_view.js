// Reporter updates — pure helpers behind the widget's reports panel, peek
// and FAB dot. No DOM, no network, no imports: everything here takes plain
// data (Reports and Steps as sent by hi_pulse_server) and returns plain
// data, so `node --test` can cover it without a browser.
//
// A Report carries `status` (received / in_progress / needs_info / fixed /
// closed), `verdict`, `unseen` and `steps`, oldest first. Each Step has a
// `kind` (status / note / question / reply / verdict), an `author` (team /
// reporter) and `seen`.

// Order of the dot colours on the FAB: the most important unseen update
// wins. "neutral" covers notes, closed reports and anything else unseen.
const DOT_RANK = { needs_info: 3, fixed: 2, in_progress: 1, neutral: 0 };

// The happy path a report walks. Steps not reached yet render as hollow
// "todo" nodes after the current one.
const FLOW = ["received", "in_progress", "fixed"];

// Input types the user doesn't type into; focus on these never holds the peek.
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// "{count} updates" + {count: 2} → "2 updates". Unknown keys stay as-is so
// a translation typo shows up instead of vanishing.
export function fmt(template, vars = {}) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match,
  );
}

// "feature-request" → "Feature request" — fallback for keys the host
// hasn't translated in T.
export function titleize(key) {
  return String(key ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

export function labelFor(map, key) {
  return (map && map[key]) || titleize(key);
}

// ---------------------------------------------------------------------------
// Unseen updates
// ---------------------------------------------------------------------------

// Team-side steps the reporter hasn't seen and should be told about. A
// "received" status step never counts: it only appears unseen when the
// reporter's own "Still broken" sent the issue back to triage.
export function unseenSteps(report) {
  return (report?.steps || []).filter(
    (s) => s.author === "team" && !s.seen && !(s.kind === "status" && s.status === "received"),
  );
}

export function hasUpdate(report) {
  return unseenSteps(report).length > 0;
}

export function unseenCount(reports) {
  return (reports || []).filter(hasUpdate).length;
}

function stepDot(step) {
  if (step.kind === "question") return "needs_info";
  if (step.kind === "status" && step.status in DOT_RANK) return step.status;
  return "neutral";
}

// Colour key for the FAB dot, or null when there is nothing unseen.
export function dotStatus(reports) {
  let best = null;
  for (const report of reports || []) {
    for (const step of unseenSteps(report)) {
      const dot = stepDot(step);
      if (best === null || DOT_RANK[dot] > DOT_RANK[best]) best = dot;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Peek decisions
// ---------------------------------------------------------------------------

// Whether a report deserves a peek right now: an open question, or a fix
// the reporter hasn't seen. Everything else only lights the dot.
export function peekKind(report) {
  const unseen = unseenSteps(report);
  if (report.status === "needs_info" && unseen.some((s) => s.kind === "question")) {
    return "needs_info";
  }
  if (report.status === "fixed" && unseen.some((s) => s.kind === "status" && s.status === "fixed")) {
    return "fixed";
  }
  return null;
}

// Peek to show after joining (page load): one report, several, or none.
export function joinPeek(reports) {
  const candidates = (reports || []).filter(peekKind);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { kind: peekKind(candidates[0]), id: candidates[0].id };
  return { kind: "many" };
}

// What a live push of `next` (previously `prev`) should trigger: a question
// or fix that wasn't there before. "release" marks a fix that just shipped,
// which goes to the host's release-note slot when it has one.
export function livePeek(prev, next, cause) {
  const known = new Set((prev?.steps || []).map((s) => s.id));
  const fresh = unseenSteps(next).filter((s) => !known.has(s.id));
  if (next.status === "needs_info" && fresh.some((s) => s.kind === "question")) {
    return "needs_info";
  }
  if (next.status === "fixed" && fresh.some((s) => s.kind === "status" && s.status === "fixed")) {
    return cause === "release" ? "release" : "fixed";
  }
  return null;
}

// Several updates collapse into one peek: a second report turns the
// pending peek into "many".
export function mergePeek(pending, next) {
  if (!pending) return next;
  if (pending.kind !== "many" && next.kind !== "many" && pending.id === next.id) return next;
  return { kind: "many" };
}

// Turns a pending peek into what to show, against the current reports
// (the update may have been seen in another tab meanwhile). Returns
// `{kind, report}`, `{kind: "many", count, stays}` or null.
export function resolvePeek(pending, reports) {
  if (!pending) return null;
  const list = reports || [];
  if (pending.kind === "many") {
    const peekable = list.filter(peekKind);
    const count = unseenCount(list);
    if (count >= 2 && peekable.length > 0) {
      // A waiting question keeps the peek up; fixes alone slide back.
      return { kind: "many", count, stays: peekable.some((r) => peekKind(r) === "needs_info") };
    }
    return peekable.length === 1 ? { kind: peekKind(peekable[0]), report: peekable[0] } : null;
  }
  const report = list.find((r) => r.id === pending.id);
  const kind = report && peekKind(report);
  return kind ? { kind, report } : null;
}

// ---------------------------------------------------------------------------
// Report state
// ---------------------------------------------------------------------------

// Newest report first, like the server's join reply.
export function sortReports(reports) {
  return [...(reports || [])].sort((a, b) =>
    String(b.reported_at).localeCompare(String(a.reported_at)),
  );
}

export function upsertReport(reports, report) {
  return sortReports([...(reports || []).filter((r) => r.id !== report.id), report]);
}

export function withStep(report, step) {
  return { ...report, steps: [...(report.steps || []), step] };
}

export function withoutStep(report, stepId) {
  return { ...report, steps: (report.steps || []).filter((s) => s.id !== stepId) };
}

// After a rejoin (reconnect), the reports that changed while the socket
// was down, paired with their previous version (undefined when new).
export function changedReports(prev, next) {
  const byId = new Map((prev || []).map((r) => [r.id, r]));
  return (next || [])
    .map((report) => ({ prev: byId.get(report.id), next: report }))
    .filter(({ prev: before, next: after }) => !before || signature(before) !== signature(after));
}

function signature(report) {
  const steps = report.steps || [];
  const last = steps[steps.length - 1];
  return [report.status, report.status_at, report.verdict, report.unseen, steps.length, last?.id].join("|");
}

// Latest note or question from the team, for list excerpts and the peek.
export function latestTeamMessage(report) {
  return [...(report?.steps || [])].reverse().find((s) => s.kind === "note" || s.kind === "question") || null;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

// Builds the Variant 3 timeline: one node per status change or question,
// with notes, replies and verdicts as bubbles on the node they followed,
// then hollow "todo" nodes for the statuses still ahead. Each node:
// `{key, status, question, at, state: "done" | "now" | "todo", stepIds, bubbles}`.
export function timeline(report) {
  const nodes = [];
  const node = (key, status, at, extra = {}) => ({
    key,
    status,
    question: false,
    at,
    state: "done",
    stepIds: [],
    bubbles: [],
    ...extra,
  });

  for (const step of report.steps || []) {
    if (step.kind === "status") {
      // The question node already shows "needs info".
      if (step.status === "needs_info") continue;
      nodes.push(node(step.id, step.status, step.at, { stepIds: [step.id] }));
    } else if (step.kind === "question") {
      nodes.push(
        node(step.id, "needs_info", step.at, { question: true, stepIds: [step.id], bubbles: [step] }),
      );
    } else {
      if (nodes.length === 0) nodes.push(node("received", "received", report.reported_at));
      const last = nodes[nodes.length - 1];
      last.bubbles.push(step);
      last.stepIds.push(step.id);
    }
  }

  if (nodes.length === 0) nodes.push(node("received", "received", report.reported_at));
  // The server may clear a status without its own step (a reply ends
  // "needs info"); show where the report stands now regardless.
  if (report.status && nodes[nodes.length - 1].status !== report.status) {
    nodes.push(node(`now-${report.status}`, report.status, report.status_at));
  }
  nodes[nodes.length - 1].state = "now";

  if (report.status !== "fixed" && report.status !== "closed") {
    const reached = [...nodes].reverse().find((n) => FLOW.includes(n.status))?.status || "received";
    for (const status of FLOW.slice(FLOW.indexOf(reached) + 1)) {
      nodes.push(node(`todo-${status}`, status, null, { state: "todo" }));
    }
  }
  return nodes;
}

// The fixed node "Works now" / "Still broken" belongs to, or null when the
// reporter already answered or the report isn't fixed.
export function verdictNodeKey(report, nodes) {
  if (report.status !== "fixed" || report.verdict != null) return null;
  const now = nodes.find((n) => n.state === "now");
  return now && now.status === "fixed" ? now.key : null;
}

// ---------------------------------------------------------------------------
// Time, links, focus
// ---------------------------------------------------------------------------

// "just now", "5 min ago", "3h ago", "Yesterday", "2 Oct" (with the year
// when it differs). Strings and locale come from the host-overridable T.
export function relativeTime(iso, now, T) {
  const then = new Date(iso);
  if (!iso || Number.isNaN(then.getTime())) return "";
  const diff = now - then;
  if (diff < 60_000) return T.time.justNow;
  if (diff < 3_600_000) return fmt(T.time.minutes, { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return fmt(T.time.hours, { n: Math.floor(diff / 3_600_000) });
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return T.time.yesterday;
  return formatDate(iso, now, T.locale);
}

export function formatDate(iso, now, locale) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  const options = { day: "numeric", month: "short" };
  if (date.getFullYear() !== new Date(now).getFullYear()) options.year = "numeric";
  return new Intl.DateTimeFormat(locale, options).format(date);
}

// `https://pulse.example.com/` → `wss://pulse.example.com/widget`.
export function socketUrl(serverUrl) {
  if (!serverUrl) return null;
  return serverUrl.replace(/\/+$/, "").replace(/^http/, "ws") + "/widget";
}

// `#hi-pulse-report=<id>` → id, else null.
export function readDeepLink(hash) {
  const match = /^#hi-pulse-report=([^&]+)$/.exec(hash || "");
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch (_e) {
    return null;
  }
}

// Whether focus sits in something the user types into. Takes an element
// (or any object with the same fields).
export function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return !NON_TEXT_INPUTS.has(String(el.type || "text").toLowerCase());
  return false;
}
