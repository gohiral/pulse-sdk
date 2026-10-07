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

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

// The picker's one-click emoji, in order.
export const QUICK_REACTIONS = ["👍", "🙏", "🎉", "👀"];

// The picker's grid behind "…": each emoji with English and German
// keywords to search by. Any other emoji can be typed or pasted.
export const EMOJI = [
  ["👍", "thumbs up yes ok daumen hoch ja gut"],
  ["👎", "thumbs down no daumen runter nein"],
  ["🙏", "thanks please pray danke bitte"],
  ["🎉", "party tada congrats feier glückwunsch"],
  ["👀", "eyes looking checking augen schaue nach"],
  ["✅", "check done yes erledigt fertig haken"],
  ["❤️", "heart love herz liebe"],
  ["😂", "laugh joy lol lachen"],
  ["😀", "grin happy smile grinsen fröhlich"],
  ["🙂", "smile lächeln"],
  ["😊", "blush happy freude"],
  ["😍", "love eyes verliebt"],
  ["🤔", "thinking hmm nachdenken überlegen"],
  ["😅", "sweat phew puh schweiß"],
  ["😬", "grimace oops hoppla"],
  ["😮", "wow surprised überrascht"],
  ["😢", "sad cry traurig weinen"],
  ["🙃", "upside down kopfüber ironie"],
  ["😎", "cool lässig"],
  ["🥳", "celebrate party feiern"],
  ["😴", "sleep tired schlafen müde"],
  ["🤷", "shrug dunno keine ahnung schulterzucken"],
  ["🤞", "fingers crossed hope daumen drücken hoffen"],
  ["👏", "clap applause klatschen applaus"],
  ["🙌", "hooray raised hands hurra"],
  ["💪", "strong flex stark"],
  ["👋", "wave hi hello bye winken hallo tschüss"],
  ["🤝", "handshake deal abgemacht"],
  ["👌", "ok perfect perfekt"],
  ["🫡", "salute salut zu befehl"],
  ["💯", "hundred perfect hundert"],
  ["🔥", "fire hot feuer heiß"],
  ["🚀", "rocket ship launch rakete start"],
  ["⭐", "star stern"],
  ["💡", "idea bulb idee glühbirne"],
  ["🐛", "bug fehler käfer"],
  ["🛠️", "tools fix wrench werkzeug reparieren"],
  ["🔍", "search magnifier suche lupe"],
  ["📌", "pin stecknadel merken"],
  ["⏳", "waiting hourglass warten sanduhr"],
  ["☕", "coffee kaffee"],
  ["🍀", "luck clover glück kleeblatt"],
  ["❓", "question frage"],
  ["❗", "exclamation important wichtig ausrufezeichen"],
  ["⚠️", "warning warnung achtung"],
  ["❌", "cross no wrong nein falsch"],
  ["➕", "plus add dazu"],
  ["🎯", "target bullseye ziel treffer"],
];

// The grid's emoji whose keywords contain `query` (all of them for an
// empty one). Case-insensitive.
export function filterEmoji(query) {
  const q = String(query ?? "").trim().toLowerCase();
  return EMOJI.filter(([, keywords]) => !q || keywords.includes(q)).map(([emoji]) => emoji);
}

// One emoji as the server accepts it (`ReporterUpdates.Emoji`): a
// pictograph with its variation selectors, skin tones, tags and
// zero-width-joined parts, a keycap, or a flag; at most 32 bytes.
const ONE_EMOJI =
  /^(?:\p{Extended_Pictographic}[\p{Extended_Pictographic}\uFE0E\uFE0F\u200D\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]*|[0-9#*]\uFE0F?\u20E3|\p{Regional_Indicator}{2})$/u;
// Splits text into candidates where Intl.Segmenter is missing.
const EMOJI_RUN =
  /\p{Extended_Pictographic}[\p{Extended_Pictographic}\uFE0E\uFE0F\u200D\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]*|[0-9#*]\uFE0F?\u20E3|\p{Regional_Indicator}{2}/gu;

function isOneEmoji(text) {
  return ONE_EMOJI.test(text) && new TextEncoder().encode(text).length <= 32;
}

// The first emoji in typed or pasted text ("ok 🦄" → "🦄"), or null.
export function firstEmoji(text) {
  const value = String(text ?? "");
  const parts =
    typeof Intl !== "undefined" && Intl.Segmenter
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), (s) => s.segment)
      : value.match(EMOJI_RUN) || [];
  return parts.find(isOneEmoji) || null;
}

// The reporter reacts to the team's notes and questions; the team reacts
// to the reporter's replies and verdicts on its side.
export function canReact(step) {
  return step?.author === "team" && (step.kind === "note" || step.kind === "question");
}

// The other side's emoji on a step, `[{emoji, author, author_name, at}]`
// (docs/http-api.md § Step). A server before several reactions sends only
// `reaction`, always from the other side of the step's author.
export function stepReactions(step) {
  if (Array.isArray(step?.reactions)) return step.reactions;
  const legacy = step?.reaction;
  if (!legacy?.emoji) return [];
  const author = step.author === "team" ? "reporter" : "team";
  return [{ emoji: legacy.emoji, author, author_name: legacy.author_name ?? null, at: legacy.at }];
}

// A step's reactions as chips: one per emoji, in the order each was first
// put on, with who put it there. `mine` marks the reporter's own.
export function reactionGroups(step) {
  const groups = [];
  for (const r of stepReactions(step)) {
    let group = groups.find((g) => g.emoji === r.emoji);
    if (!group) groups.push((group = { emoji: r.emoji, count: 0, mine: false, names: [] }));
    group.count += 1;
    if (r.author === "reporter") group.mine = true;
    else group.names.push(r.author_name);
  }
  return groups;
}

// The reporter's `emoji` put on, or taken off when it is already there.
export function toggleReaction(reactions, emoji, at = new Date().toISOString()) {
  const list = reactions || [];
  const mine = (r) => r.author === "reporter" && r.emoji === emoji;
  return list.some(mine)
    ? list.filter((r) => !mine(r))
    : [...list, { emoji, author: "reporter", author_name: null, at }];
}

// The report with `reactions` on step `stepId`, shown at once while the
// server confirms (and put back if it refuses).
export function withReactions(report, stepId, reactions) {
  return {
    ...report,
    steps: (report.steps || []).map((s) => (s.id === stepId ? { ...s, reactions } : s)),
  };
}

// The team's reactions on the reporter's own messages, as
// `{key, reportId, stepId, emoji, by, at}` (`by` is the team member's name). `key` changes when the team
// reacts again, so a new emoji plays even on the same message; it holds
// the emoji too, since `at` is in whole seconds. A second person putting
// the same emoji on in the same second gets their name in the key; the
// first keeps the plain key the widgets before 0.4.0 stored.
export function teamReactions(report) {
  return (report?.steps || [])
    .filter((s) => s.author === "reporter")
    .flatMap((s) => {
      const seen = new Set();
      return stepReactions(s)
        .filter((r) => r.author === "team" && r.emoji)
        .map((r) => {
          const base = `${s.id}|${r.at}|${r.emoji}`;
          const key = seen.has(base) ? `${base}|${r.author_name}` : base;
          seen.add(base);
          return { key, reportId: report.id, stepId: s.id, emoji: r.emoji, by: r.author_name, at: r.at };
        });
    });
}

// Team reactions in `next` that weren't in `prev` (a live push).
export function freshTeamReactions(prev, next) {
  const known = new Set(teamReactions(prev).map((r) => r.key));
  return teamReactions(next).filter((r) => !known.has(r.key));
}

// Team reactions the button hasn't shown yet (keys in `shown`), from the
// last `maxAgeMs`, oldest first. On page load these play once.
export function unshownTeamReactions(reports, shown, now, maxAgeMs = 7 * 86_400_000) {
  return (reports || [])
    .flatMap(teamReactions)
    .filter((r) => !shown.has(r.key) && now - new Date(r.at).getTime() <= maxAgeMs)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Latest note or question from the team, for list excerpts and the peek.
export function latestTeamMessage(report) {
  return [...(report?.steps || [])].reverse().find((s) => s.kind === "note" || s.kind === "question") || null;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

// Builds the Variant 3 timeline: one node per status change or question
// thread, with notes, free replies and verdicts as bubbles on the node
// they followed, then hollow "todo" nodes for the statuses still ahead.
// Each node:
// `{key, status, question, at, state: "done" | "now" | "todo", stepIds,
//   bubbles, questions, answers, follows, open}`.
//
// A question node is a thread: `questions` holds the team's question(s),
// `answers` the reporter's replies that answer one of them (a reply's
// `answers` names the question). Questions asked before an answer join
// one thread; an answer, a status change or a follow-up starts the next.
// `follows` is `{question, answer}` for a follow-up: the earlier question
// and its answer. `open` marks the thread still waiting for an answer.
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
    questions: [],
    answers: [],
    follows: null,
    open: false,
    ...extra,
  });
  // Question id → its thread; `run` is the thread new questions join.
  const threads = new Map();
  let run = null;

  for (const step of report.steps || []) {
    if (step.kind === "status") {
      // The question node already shows "needs info".
      if (step.status === "needs_info") continue;
      nodes.push(node(step.id, step.status, step.at, { stepIds: [step.id] }));
      run = null;
    } else if (step.kind === "question") {
      if (run && !step.follows) {
        run.questions.push(step);
        run.stepIds.push(step.id);
      } else {
        run = node(step.id, "needs_info", step.at, {
          question: true,
          stepIds: [step.id],
          questions: [step],
          follows: followed(threads, step.follows),
        });
        nodes.push(run);
      }
      threads.set(step.id, run);
    } else if (step.kind === "reply" && threads.has(step.answers)) {
      const thread = threads.get(step.answers);
      thread.answers.push(step);
      thread.stepIds.push(step.id);
      if (thread === run) run = null;
    } else {
      if (nodes.length === 0) nodes.push(node("received", "received", report.reported_at));
      const last = nodes[nodes.length - 1];
      last.bubbles.push(step);
      last.stepIds.push(step.id);
    }
  }

  if (run && report.status === "needs_info") run.open = true;
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

// The question a follow-up refers to and the answer it got, or null.
function followed(threads, questionId) {
  const thread = questionId ? threads.get(questionId) : null;
  if (!thread) return null;
  const question = thread.questions.find((q) => q.id === questionId);
  return { question, answer: thread.answers[0] || null };
}

// The question thread waiting for the reporter's answer, or null.
export function openQuestion(nodes) {
  return (nodes || []).find((n) => n.open) || null;
}

// "A long answer" → "A long ans…": one line of at most `max` characters.
export function clip(text, max) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// The fixed node "Works now" / "Still broken" belongs to, or null when the
// report isn't fixed or the reporter already said it is still broken.
// After "Works now" the node keeps a way to reopen it.
export function verdictNodeKey(report, nodes) {
  if (report.status !== "fixed" || report.verdict === "broken") return null;
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

const DEEP_LINK = "hi-pulse-report";

// The report a link asks to open: `?hi-pulse-report=<id>` (what the
// emails send; a query survives a sign-in redirect) or the older
// `#hi-pulse-report=<id>`. Takes `window.location` or the same fields.
export function readDeepLink({ search = "", hash = "" } = {}) {
  const fromQuery = new URLSearchParams(search).get(DEEP_LINK);
  if (fromQuery) return fromQuery;
  const match = /^#hi-pulse-report=([^&]+)$/.exec(hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch (_e) {
    return null;
  }
}

// The address without the deep link, for `history.replaceState`.
export function stripDeepLink({ pathname = "", search = "", hash = "" } = {}) {
  const params = new URLSearchParams(search);
  params.delete(DEEP_LINK);
  const query = params.toString();
  return pathname + (query ? `?${query}` : "") + (hash.startsWith(`#${DEEP_LINK}=`) ? "" : hash);
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
