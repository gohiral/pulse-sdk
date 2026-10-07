// Reporter updates — tests for the pure helpers in reporter_view.js.
// Run from the repo root: node --test sdk/test/js/

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  canReact,
  changedReports,
  dotStatus,
  escapeHTML,
  filterEmoji,
  firstEmoji,
  fmt,
  formatDate,
  freshTeamReactions,
  hasUpdate,
  isTypingTarget,
  joinPeek,
  labelFor,
  latestTeamMessage,
  livePeek,
  mergePeek,
  openQuestion,
  peekKind,
  reactionGroups,
  readDeepLink,
  stripDeepLink,
  relativeTime,
  resolvePeek,
  socketUrl,
  sortReports,
  timeline,
  unseenCount,
  unshownTeamReactions,
  upsertReport,
  verdictNodeKey,
  withoutStep,
  withStep,
} from "../../priv/static/js/reporter_view.js";

const T = {
  time: { justNow: "just now", minutes: "{n} min ago", hours: "{n}h ago", yesterday: "Yesterday" },
  locale: "en-GB",
};

let seq = 0;
const step = (attrs) => ({
  id: `s${++seq}`,
  kind: "status",
  status: null,
  body: null,
  detail: null,
  author: "team",
  author_name: null,
  at: "2026-10-06T09:00:00Z",
  seen: true,
  ...attrs,
});

const received = (attrs = {}) => step({ status: "received", ...attrs });

const report = (attrs = {}) => ({
  id: "r1",
  title: "CSV export drops umlauts",
  type: "bug",
  linear_identifier: "HI-412",
  reported_at: "2026-10-02T14:20:00Z",
  status: "received",
  status_at: "2026-10-02T14:20:00Z",
  verdict: null,
  unseen: false,
  steps: [received()],
  ...attrs,
});

describe("escapeHTML", () => {
  test("escapes markup and quotes", () => {
    assert.equal(
      escapeHTML(`<img src=x onerror="alert('x')">&`),
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;",
    );
  });

  test("renders nullish as empty", () => {
    assert.equal(escapeHTML(null), "");
    assert.equal(escapeHTML(undefined), "");
  });
});

describe("fmt, labelFor", () => {
  test("fills placeholders and leaves unknown ones", () => {
    assert.equal(fmt("{count} updates on {what}", { count: 2 }), "2 updates on {what}");
  });

  test("labelFor falls back to a titleized key", () => {
    assert.equal(labelFor({ bug: "Fehler" }, "bug"), "Fehler");
    assert.equal(labelFor({}, "feature-request"), "Feature request");
    assert.equal(labelFor(undefined, "in_progress"), "In progress");
  });
});

describe("unseen updates and the FAB dot", () => {
  test("a received step never counts as an update", () => {
    const r = report({ unseen: true, steps: [received({ seen: false })] });
    assert.equal(hasUpdate(r), false);
    assert.equal(dotStatus([r]), null);
  });

  test("reporter steps never count", () => {
    const r = report({ steps: [received(), step({ kind: "reply", author: "reporter", seen: false })] });
    assert.equal(hasUpdate(r), false);
  });

  test("dot colour follows the most important unseen update", () => {
    const progress = report({ id: "a", steps: [step({ status: "in_progress", seen: false })] });
    const note = report({ id: "b", steps: [step({ kind: "note", body: "Looking", seen: false })] });
    const fixed = report({ id: "c", steps: [step({ status: "fixed", seen: false })] });
    const question = report({ id: "d", steps: [step({ kind: "question", body: "Which?", seen: false })] });
    const closed = report({ id: "e", steps: [step({ status: "closed", seen: false })] });

    assert.equal(dotStatus([]), null);
    assert.equal(dotStatus([note]), "neutral");
    assert.equal(dotStatus([closed]), "neutral");
    assert.equal(dotStatus([note, progress]), "in_progress");
    assert.equal(dotStatus([progress, fixed, note]), "fixed");
    assert.equal(dotStatus([fixed, question]), "needs_info");
    assert.equal(unseenCount([note, progress, fixed, report({ id: "f" })]), 3);
  });
});

describe("peek decisions", () => {
  const fixedReport = (id, seen = false) =>
    report({ id, status: "fixed", steps: [received(), step({ status: "fixed", seen })] });
  const questionReport = (id) =>
    report({ id, status: "needs_info", steps: [received(), step({ kind: "question", body: "Which?", seen: false })] });

  test("peekKind: only open questions and unseen fixes peek", () => {
    assert.equal(peekKind(fixedReport("a")), "fixed");
    assert.equal(peekKind(fixedReport("a", true)), null);
    assert.equal(peekKind(questionReport("b")), "needs_info");
    assert.equal(peekKind(report({ status: "in_progress", steps: [step({ status: "in_progress", seen: false })] })), null);
    // Answered (status moved on) — the question alone doesn't peek.
    const answered = { ...questionReport("c"), status: "in_progress" };
    assert.equal(peekKind(answered), null);
  });

  test("joinPeek: none, one, or many", () => {
    assert.equal(joinPeek([report()]), null);
    assert.deepEqual(joinPeek([report(), fixedReport("a")]), { kind: "fixed", id: "a" });
    assert.deepEqual(joinPeek([fixedReport("a"), questionReport("b")]), { kind: "many" });
  });

  test("livePeek: a new question peeks", () => {
    const prev = report({ id: "b", status: "in_progress" });
    assert.equal(livePeek(prev, questionReport("b"), "update"), "needs_info");
  });

  test("livePeek: a fresh fix peeks, or goes to the release note on a release", () => {
    const prev = report({ id: "a", status: "in_progress" });
    const next = fixedReport("a");
    assert.equal(livePeek(prev, next, "update"), "fixed");
    assert.equal(livePeek(prev, next, "release"), "release");
    assert.equal(livePeek(undefined, next, "release"), "release");
  });

  test("livePeek: nothing new, nothing to peek", () => {
    const next = fixedReport("a");
    assert.equal(livePeek(next, next, "release"), null);
    assert.equal(livePeek(report({ id: "a" }), fixedReport("a", true), "release"), null);
    const progress = report({ status: "in_progress", steps: [step({ status: "in_progress", seen: false })] });
    assert.equal(livePeek(report(), progress, "update"), null);
  });

  test("mergePeek: one report stays single, two become many", () => {
    assert.deepEqual(mergePeek(null, { kind: "fixed", id: "a" }), { kind: "fixed", id: "a" });
    assert.deepEqual(mergePeek({ kind: "fixed", id: "a" }, { kind: "needs_info", id: "a" }), {
      kind: "needs_info",
      id: "a",
    });
    assert.deepEqual(mergePeek({ kind: "fixed", id: "a" }, { kind: "fixed", id: "b" }), { kind: "many" });
    assert.deepEqual(mergePeek({ kind: "many" }, { kind: "fixed", id: "b" }), { kind: "many" });
  });

  test("resolvePeek: drops updates seen meanwhile", () => {
    const fixed = fixedReport("a");
    assert.deepEqual(resolvePeek({ kind: "fixed", id: "a" }, [fixed]), { kind: "fixed", report: fixed });
    assert.equal(resolvePeek({ kind: "fixed", id: "a" }, [fixedReport("a", true)]), null);
    assert.equal(resolvePeek({ kind: "fixed", id: "gone" }, [fixed]), null);
    assert.equal(resolvePeek(null, [fixed]), null);
  });

  test("resolvePeek: many counts unseen reports and stays for questions", () => {
    const progress = report({ id: "c", status: "in_progress", steps: [step({ status: "in_progress", seen: false })] });
    assert.deepEqual(resolvePeek({ kind: "many" }, [fixedReport("a"), progress]), {
      kind: "many",
      count: 2,
      stays: false,
    });
    assert.deepEqual(resolvePeek({ kind: "many" }, [fixedReport("a"), questionReport("b")]), {
      kind: "many",
      count: 2,
      stays: true,
    });
  });

  test("resolvePeek: many shrinks to the one report left", () => {
    const question = questionReport("b");
    assert.deepEqual(resolvePeek({ kind: "many" }, [fixedReport("a", true), question]), {
      kind: "needs_info",
      report: question,
    });
  });
});

describe("report state", () => {
  test("sortReports and upsertReport keep newest first", () => {
    const older = report({ id: "old", reported_at: "2026-09-01T00:00:00Z" });
    const newer = report({ id: "new", reported_at: "2026-10-01T00:00:00Z" });
    assert.deepEqual(sortReports([older, newer]).map((r) => r.id), ["new", "old"]);

    const updated = { ...older, status: "fixed" };
    const list = upsertReport([newer, older], updated);
    assert.deepEqual(list.map((r) => r.id), ["new", "old"]);
    assert.equal(list[1].status, "fixed");

    const added = upsertReport(list, report({ id: "newest", reported_at: "2026-10-07T00:00:00Z" }));
    assert.deepEqual(added.map((r) => r.id), ["newest", "new", "old"]);
  });

  test("withStep / withoutStep add and roll back a local reply", () => {
    const r = report();
    const local = step({ id: "local-1", kind: "reply", author: "reporter", body: "17.6" });
    const sent = withStep(r, local);
    assert.equal(sent.steps.length, 2);
    assert.equal(r.steps.length, 1);
    assert.deepEqual(withoutStep(sent, "local-1").steps, r.steps);
  });

  test("changedReports finds new and changed reports after a rejoin", () => {
    const a = report({ id: "a" });
    const b = report({ id: "b" });
    const bChanged = withStep(b, step({ kind: "note", body: "On it", seen: false }));
    const c = report({ id: "c" });
    const changed = changedReports([a, b], [a, bChanged, c]);
    assert.deepEqual(
      changed.map(({ prev, next }) => [prev?.id, next.id]),
      [
        ["b", "b"],
        [undefined, "c"],
      ],
    );
  });

  test("latestTeamMessage picks the newest note or question", () => {
    const r = report({
      steps: [
        received(),
        step({ kind: "note", body: "First" }),
        step({ kind: "question", body: "Which Safari?" }),
        step({ kind: "reply", author: "reporter", body: "17.6" }),
      ],
    });
    assert.equal(latestTeamMessage(r).body, "Which Safari?");
    assert.equal(latestTeamMessage(report()), null);
  });
});

describe("reactions", () => {
  test("the reporter reacts only to the team's notes and questions", () => {
    assert.equal(canReact(step({ kind: "note", body: "On it" })), true);
    assert.equal(canReact(step({ kind: "question", body: "Which browser?" })), true);
    assert.equal(canReact(received()), false);
    assert.equal(canReact(step({ kind: "reply", author: "reporter", body: "Firefox" })), false);
    assert.equal(canReact(step({ kind: "verdict", author: "reporter", body: "works" })), false);
    assert.equal(canReact(undefined), false);
  });

  test("reactions group by emoji with counts; the reporter's are mine; legacy reaction falls back", () => {
    const at = "2026-10-07T10:00:00Z";
    const reply = step({
      kind: "reply",
      author: "reporter",
      body: "Firefox",
      reactions: [
        { emoji: "👍", author: "team", author_name: "Nico", at },
        { emoji: "👍", author: "team", author_name: "Marc", at },
        { emoji: "🎉", author: "team", author_name: "Nico", at },
      ],
    });
    assert.deepEqual(reactionGroups(reply), [
      { emoji: "👍", count: 2, mine: false, names: ["Nico", "Marc"] },
      { emoji: "🎉", count: 1, mine: false, names: ["Nico"] },
    ]);

    const note = step({
      kind: "note",
      body: "On it",
      reactions: [
        { emoji: "🙏", author: "reporter", author_name: null, at },
        { emoji: "🦄", author: "reporter", author_name: null, at },
      ],
      reaction: { emoji: "🦄", author_name: null, at },
    });
    assert.deepEqual(
      reactionGroups(note).map(({ emoji, count, mine }) => [emoji, count, mine]),
      [["🙏", 1, true], ["🦄", 1, true]],
      "`reactions` wins over the legacy `reaction`",
    );
    assert.deepEqual(reactionGroups(step({ kind: "note", reactions: [] })), []);

    // An older server sends only `reaction`, always from the other side.
    const legacyNote = step({ kind: "note", reaction: { emoji: "👍", author_name: null, at } });
    assert.deepEqual(reactionGroups(legacyNote), [{ emoji: "👍", count: 1, mine: true, names: [] }]);
    const legacyReply = step({ kind: "reply", author: "reporter", reaction: { emoji: "🙏", author_name: "Nico Fuchs", at } });
    assert.deepEqual(reactionGroups(legacyReply), [{ emoji: "🙏", count: 1, mine: false, names: ["Nico Fuchs"] }]);
    assert.deepEqual(reactionGroups(step({ kind: "note", reaction: null })), []);
  });

  test("the team's reactions on the reporter's messages: fresh on a push, unshown on load", () => {
    const reply = step({ kind: "reply", author: "reporter", body: "Firefox", reaction: null });
    const note = step({ kind: "note", body: "On it", reaction: { emoji: "👍", author_name: null, at: "2026-10-07T09:00:00Z" } });
    const before = report({ steps: [received(), note, reply] });
    assert.deepEqual(freshTeamReactions(before, before), [], "the reporter's own reaction never plays");

    const at = "2026-10-07T10:00:00Z";
    const after = report({ steps: [received(), note, { ...reply, reaction: { emoji: "🙏", author_name: "Nico", at } }] });
    const [fresh] = freshTeamReactions(before, after);
    assert.deepEqual(fresh, { key: `${reply.id}|${at}|🙏`, reportId: "r1", stepId: reply.id, emoji: "🙏", by: "Nico", at });
    assert.deepEqual(freshTeamReactions(after, after), []);
    assert.equal(freshTeamReactions(undefined, after).length, 1, "a new report counts too");

    // Another emoji is a new key, even within the same second.
    const swapped = report({ steps: [received(), note, { ...reply, reaction: { emoji: "👀", author_name: "Nico", at } }] });
    assert.equal(freshTeamReactions(after, swapped)[0].emoji, "👀");

    // Reacting again later with another emoji is a new key too.
    const again = report({ steps: [received(), note, { ...reply, reaction: { emoji: "🎉", author_name: "Marc", at: "2026-10-07T10:05:00Z" } }] });
    assert.equal(freshTeamReactions(after, again)[0].emoji, "🎉");

    // Two people with the same emoji in the same second both play.
    const both = report({ steps: [received(), note, { ...reply, reactions: [
      { emoji: "🙏", author: "team", author_name: "Nico", at },
      { emoji: "🙏", author: "team", author_name: "Marc", at },
    ] }] });
    assert.deepEqual(freshTeamReactions(after, both).map((r) => r.by), ["Marc"]);

    const now = new Date("2026-10-07T12:00:00Z").getTime();
    assert.equal(unshownTeamReactions([after], new Set(), now).length, 1);
    assert.equal(unshownTeamReactions([after], new Set([fresh.key]), now).length, 0);
    assert.equal(unshownTeamReactions([after], new Set(), now + 8 * 86_400_000).length, 0, "older than a week");
  });

  test("the picker's search knows English and German; any emoji typed counts", () => {
    assert.ok(filterEmoji("thumbs").includes("👍"));
    assert.ok(filterEmoji("daumen").includes("👍"));
    assert.ok(filterEmoji(" Daumen ").includes("👍"), "trimmed, any case");
    assert.deepEqual(filterEmoji("rakete"), ["🚀"]);
    assert.deepEqual(filterEmoji("xyzzy"), []);
    assert.equal(filterEmoji("").length, 48, "an empty search shows the whole grid");

    assert.equal(firstEmoji("🦄"), "🦄");
    assert.equal(firstEmoji("❤️"), "❤️");
    assert.equal(firstEmoji("👨‍👩‍👧"), "👨‍👩‍👧", "a joined family stays one emoji");
    assert.equal(firstEmoji("so 🦄 much"), "🦄");
    assert.equal(firstEmoji("abc"), null);
    assert.equal(firstEmoji(""), null);
  });
});

describe("timeline", () => {
  const shape = (nodes) =>
    nodes.map((n) => [n.status, n.state, [...n.questions, ...n.bubbles].map((b) => b.kind)]);

  test("received only: now, then the steps ahead", () => {
    assert.deepEqual(shape(timeline(report())), [
      ["received", "now", []],
      ["in_progress", "todo", []],
      ["fixed", "todo", []],
    ]);
  });

  test("notes ride on the step they followed", () => {
    const r = report({
      status: "in_progress",
      steps: [received(), step({ status: "in_progress" }), step({ kind: "note", body: "Reproduced" })],
    });
    assert.deepEqual(shape(timeline(r)), [
      ["received", "done", []],
      ["in_progress", "now", ["note"]],
      ["fixed", "todo", []],
    ]);
  });

  test("a question is its own step; the reply sits on it; status steps for needs_info are folded in", () => {
    const r = report({
      status: "needs_info",
      steps: [
        received(),
        step({ status: "needs_info" }),
        step({ kind: "question", body: "Which Safari?", author_name: "Nico" }),
      ],
    });
    const nodes = timeline(r);
    assert.deepEqual(shape(nodes), [
      ["received", "done", []],
      ["needs_info", "now", ["question"]],
      ["in_progress", "todo", []],
      ["fixed", "todo", []],
    ]);
    assert.equal(nodes[1].question, true);
  });

  test("a reply that clears needs_info without a status step still shows the current status", () => {
    const r = report({
      status: "in_progress",
      status_at: "2026-10-06T12:00:00Z",
      steps: [
        received(),
        step({ status: "in_progress" }),
        step({ kind: "question", body: "Which Safari?" }),
        step({ kind: "reply", author: "reporter", body: "17.6" }),
      ],
    });
    const nodes = timeline(r);
    assert.deepEqual(shape(nodes), [
      ["received", "done", []],
      ["in_progress", "done", []],
      ["needs_info", "done", ["question", "reply"]],
      ["in_progress", "now", []],
      ["fixed", "todo", []],
    ]);
    assert.equal(nodes[3].at, "2026-10-06T12:00:00Z");
  });

  test("answers nest under their question by id; a free reply stays a bubble", () => {
    const question = step({ kind: "question", body: "Which Safari?" });
    const answer = step({ kind: "reply", author: "reporter", body: "17.6", answers: question.id });
    const detail = step({ kind: "reply", author: "reporter", body: "Also on iPad", answers: null });
    const r = report({
      status: "in_progress",
      steps: [received(), step({ status: "in_progress" }), question, answer, detail],
    });
    const nodes = timeline(r);
    const thread = nodes[2];
    assert.equal(thread.question, true);
    assert.deepEqual(thread.questions.map((q) => q.id), [question.id]);
    assert.deepEqual(thread.answers.map((a) => a.id), [answer.id]);
    assert.deepEqual(thread.bubbles.map((b) => b.id), [detail.id]);
    assert.equal(thread.open, false);
    assert.deepEqual(thread.stepIds, [question.id, answer.id, detail.id]);
    assert.equal(openQuestion(nodes), null);
  });

  test("questions asked before an answer share one thread, open until answered", () => {
    const first = step({ kind: "question", body: "Which Safari?" });
    const second = step({ kind: "question", body: "Which page?" });
    const r = report({ status: "needs_info", steps: [received(), first, second] });
    const nodes = timeline(r);
    assert.deepEqual(shape(nodes), [
      ["received", "done", []],
      ["needs_info", "now", ["question", "question"]],
      ["in_progress", "todo", []],
      ["fixed", "todo", []],
    ]);
    assert.equal(openQuestion(nodes), nodes[1]);

    // The answer goes to the latest question and closes the thread.
    const answer = step({ kind: "reply", author: "reporter", body: "17.6 on /leads", answers: second.id });
    const answered = timeline({ ...withStep(r, answer), status: "received" });
    assert.deepEqual(answered[1].answers, [answer]);
    assert.equal(openQuestion(answered), null);
  });

  test("a follow-up node knows the answer it refers to", () => {
    const question = step({ kind: "question", body: "Which Safari?" });
    const answer = step({ kind: "reply", author: "reporter", body: "17.6", answers: question.id });
    const followUp = step({ kind: "question", body: "Private mode too?", follows: question.id });
    const r = report({ status: "needs_info", steps: [received(), question, answer, followUp] });
    const nodes = timeline(r);
    assert.deepEqual(shape(nodes).slice(0, 3), [
      ["received", "done", []],
      ["needs_info", "done", ["question"]],
      ["needs_info", "now", ["question"]],
    ]);
    assert.deepEqual(nodes[2].follows, { question, answer });
    assert.equal(nodes[2].open, true);
    assert.equal(nodes[1].follows, null);
  });

  test("fixed: no steps ahead, verdict on the fixed step, reopen after works", () => {
    const fixedStep = step({ status: "fixed" });
    const r = report({ status: "fixed", steps: [received(), step({ status: "in_progress" }), fixedStep] });
    const nodes = timeline(r);
    assert.deepEqual(shape(nodes), [
      ["received", "done", []],
      ["in_progress", "done", []],
      ["fixed", "now", []],
    ]);
    assert.equal(verdictNodeKey(r, nodes), fixedStep.id);

    const answered = {
      ...withStep(r, step({ kind: "verdict", author: "reporter", body: "works" })),
      verdict: "works",
    };
    const answeredNodes = timeline(answered);
    assert.deepEqual(answeredNodes[2].bubbles.map((b) => b.body), ["works"]);
    // "Works now" keeps a way to reopen; "Still broken" closes it.
    assert.equal(verdictNodeKey(answered, answeredNodes), fixedStep.id);
    assert.equal(verdictNodeKey({ ...answered, verdict: "broken" }, answeredNodes), null);
  });

  test("still broken sends it back: the flow starts over after the old fix", () => {
    const r = report({
      status: "received",
      verdict: "broken",
      steps: [
        received(),
        step({ status: "fixed" }),
        step({ kind: "verdict", author: "reporter", body: "broken", detail: "Still drops ü" }),
        step({ status: "received", seen: false }),
      ],
    });
    assert.deepEqual(shape(timeline(r)), [
      ["received", "done", []],
      ["fixed", "done", ["verdict"]],
      ["received", "now", []],
      ["in_progress", "todo", []],
      ["fixed", "todo", []],
    ]);
  });

  test("closed: no steps ahead", () => {
    const r = report({ status: "closed", steps: [received(), step({ status: "closed" })] });
    assert.deepEqual(shape(timeline(r)), [
      ["received", "done", []],
      ["closed", "now", []],
    ]);
  });

  test("no steps at all falls back to the report date", () => {
    const nodes = timeline(report({ steps: [] }));
    assert.equal(nodes[0].status, "received");
    assert.equal(nodes[0].at, "2026-10-02T14:20:00Z");
  });
});

describe("time", () => {
  const now = new Date("2026-10-07T10:00:00Z").getTime();
  const ago = (ms) => new Date(now - ms).toISOString();

  test("relativeTime steps from just now to a date", () => {
    assert.equal(relativeTime(ago(30_000), now, T), "just now");
    assert.equal(relativeTime(ago(5 * 60_000), now, T), "5 min ago");
    assert.equal(relativeTime(ago(3 * 3_600_000), now, T), "3h ago");
    assert.equal(relativeTime(ago(30 * 3_600_000), now, T), "Yesterday");
    assert.equal(relativeTime("2026-10-02T14:20:00Z", now, T), "2 Oct");
    assert.equal(relativeTime("2025-12-30T14:20:00Z", now, T), "30 Dec 2025");
  });

  test("relativeTime and formatDate tolerate missing dates", () => {
    assert.equal(relativeTime(null, now, T), "");
    assert.equal(relativeTime("not a date", now, T), "");
    assert.equal(formatDate(undefined, now, "en-GB"), "");
  });

  test("formatDate follows the locale", () => {
    assert.equal(formatDate("2026-10-02T14:20:00Z", now, "de-DE"), "2. Okt.");
  });
});

describe("links and focus", () => {
  test("socketUrl swaps the scheme and appends /widget", () => {
    assert.equal(socketUrl("https://pulse.example.com/"), "wss://pulse.example.com/widget");
    assert.equal(socketUrl("http://localhost:4000"), "ws://localhost:4000/widget");
    assert.equal(socketUrl(""), null);
  });

  test("readDeepLink reads our query parameter or fragment", () => {
    assert.equal(readDeepLink({ search: "?hi-pulse-report=0b6c-11ef" }), "0b6c-11ef");
    assert.equal(readDeepLink({ search: "?tab=x&hi-pulse-report=a%20b" }), "a b");
    assert.equal(readDeepLink({ hash: "#hi-pulse-report=0b6c-11ef" }), "0b6c-11ef");
    assert.equal(readDeepLink({ hash: "#hi-pulse-report=a%20b" }), "a b");
    assert.equal(readDeepLink({ search: "?tab=x", hash: "#settings" }), null);
    assert.equal(readDeepLink({}), null);
    assert.equal(readDeepLink({ hash: "#hi-pulse-report=%E0%A4%A" }), null);
  });

  test("stripDeepLink keeps everything but the deep link", () => {
    const loc = (search, hash = "") => ({ pathname: "/leads", search, hash });
    assert.equal(stripDeepLink(loc("?hi-pulse-report=abc")), "/leads");
    assert.equal(stripDeepLink(loc("?tab=export&hi-pulse-report=abc", "#top")), "/leads?tab=export#top");
    assert.equal(stripDeepLink(loc("", "#hi-pulse-report=abc")), "/leads");
  });

  test("isTypingTarget: text fields and editors, not buttons or checkboxes", () => {
    assert.equal(isTypingTarget({ tagName: "INPUT", type: "text" }), true);
    assert.equal(isTypingTarget({ tagName: "INPUT", type: "email" }), true);
    assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
    assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
    assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
    assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
    assert.equal(isTypingTarget(null), false);
  });
});
