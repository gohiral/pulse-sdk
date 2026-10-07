// Reporter updates — tests for the pure helpers in reporter_view.js.
// Run from the repo root: node --test sdk/test/js/

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  changedReports,
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
  peekKind,
  readDeepLink,
  relativeTime,
  resolvePeek,
  socketUrl,
  sortReports,
  timeline,
  unseenCount,
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

describe("timeline", () => {
  const shape = (nodes) => nodes.map((n) => [n.status, n.state, n.bubbles.map((b) => b.kind)]);

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

  test("fixed: no steps ahead, verdict on the fixed step until answered", () => {
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
    assert.equal(verdictNodeKey(answered, answeredNodes), null);
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

  test("readDeepLink reads only our fragment", () => {
    assert.equal(readDeepLink("#hi-pulse-report=0b6c-11ef"), "0b6c-11ef");
    assert.equal(readDeepLink("#hi-pulse-report=a%20b"), "a b");
    assert.equal(readDeepLink("#settings"), null);
    assert.equal(readDeepLink(""), null);
    assert.equal(readDeepLink("#hi-pulse-report=%E0%A4%A"), null);
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
