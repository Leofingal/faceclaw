// Round 4, P1: file-reference detection and turn formatting for the phone
// companion's Rich view / Doc viewer. The load-bearing property here is
// findFileReference's manifest verification — a false positive would open
// "a file" that doesn't exist or isn't the one meant, and a false negative
// is the exact bug this round fixes (Doc viewer echoing chat text back).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  turnWhoLabel,
  stripGlassesBlock,
  splitHeadlineBody,
  buildBasenameIndex,
  findFileReference,
  isImageReference,
  isTextRenderableReference,
  groupTranscript,
} = require("../.test-build/app/phone-ui/transcript-turns.js");

test("turnWhoLabel distinguishes tool/question/answer from ordinary role", () => {
  assert.equal(turnWhoLabel({ role: "assistant", text: "", kind: "tool" }), "Tool");
  assert.equal(turnWhoLabel({ role: "assistant", text: "", kind: "question" }), "Ghost");
  assert.equal(turnWhoLabel({ role: "user", text: "", kind: "answer" }), "Chris");
  assert.equal(turnWhoLabel({ role: "assistant", text: "" }), "Ghost");
  assert.equal(turnWhoLabel({ role: "user", text: "" }), "Chris");
});

test("stripGlassesBlock cuts only a line-anchored opening tag, not a mention in prose", () => {
  const withBlock = "Real reply text.\n\n<glasses>\nHeadline\nBody\n</glasses>";
  assert.equal(stripGlassesBlock(withBlock), "Real reply text.\n\n");
  const mentionOnly = "I should wrap this in a <glasses> tag next time.";
  assert.equal(stripGlassesBlock(mentionOnly), mentionOnly);
});

test("splitHeadlineBody takes the first non-empty line as the headline", () => {
  const { headline, body } = splitHeadlineBody("\n  First line.  \n\nSecond.\nThird.\n");
  assert.equal(headline, "First line.");
  assert.equal(body, "Second.\nThird.");
});

test("splitHeadlineBody caps a very long first line with an ellipsis", () => {
  const long = "x".repeat(200);
  const { headline } = splitHeadlineBody(long);
  assert.equal(headline.length, 140);
  assert.ok(headline.endsWith("…"));
});

test("buildBasenameIndex maps a unique basename, and nulls out an ambiguous one", () => {
  const index = buildBasenameIndex(["wiki/seeds/foo.md", "knowledge/staging/bar.md", "wiki/other/bar.md"]);
  assert.equal(index.get("foo.md"), "wiki/seeds/foo.md");
  assert.equal(index.get("bar.md"), null); // two files share this basename
});

test("findFileReference resolves a markdown link target against the manifest", () => {
  const files = ["knowledge/outbox/report.md", "wiki/seeds/other.md"];
  const index = buildBasenameIndex(files);
  const text = "See [the report](knowledge/outbox/report.md) for details.";
  assert.equal(findFileReference(text, files, index), "knowledge/outbox/report.md");
});

test("findFileReference resolves a bare unique-basename mention", () => {
  const files = ["knowledge/outbox/report.md"];
  const index = buildBasenameIndex(files);
  assert.equal(findFileReference("I wrote report.md just now.", files, index), "knowledge/outbox/report.md");
});

test("findFileReference never false-positives on an ordinary word or URL", () => {
  const files = ["knowledge/outbox/report.md"];
  const index = buildBasenameIndex(files);
  assert.equal(findFileReference("Check claude.ai for the session log.", files, index), null);
  assert.equal(findFileReference("Nothing file-shaped in this sentence at all.", files, index), null);
});

test("findFileReference returns null on an empty manifest (not yet loaded)", () => {
  assert.equal(findFileReference("report.md", [], new Map()), null);
});

test("findFileReference skips an ambiguous bare basename", () => {
  const files = ["wiki/a/notes.md", "wiki/b/notes.md"];
  const index = buildBasenameIndex(files);
  assert.equal(findFileReference("See notes.md.", files, index), null);
});

test("isImageReference / isTextRenderableReference classify by extension", () => {
  assert.equal(isImageReference("a/b.png"), true);
  assert.equal(isImageReference("a/b.md"), false);
  assert.equal(isTextRenderableReference("a/b.md"), true);
  assert.equal(isTextRenderableReference("a/b.png"), false);
  assert.equal(isTextRenderableReference("README"), true); // extension-less
  assert.equal(isTextRenderableReference("a/b.wav"), false);
});

// ── groupTranscript: the round-4 Rich-view inversion ───────────────────────
// The property under test is the one Chris reported broken on real hardware:
// a Ghost reply arrives as several transcript ENTRIES (prose, tool marker,
// prose, tool marker, prose) and must render as ONE logical turn — the prose
// continuous, the markers compact and between it — not as five equal boxes.

/** The canonical shape of one real reply, as /api/transcript actually emits
 * it (see cc-web's transcript-reader.js readTurns(): one entry per assistant
 * JSONL message, plus a separate `uuid + '-t'` entry for that message's
 * tools). */
const MULTI_SEGMENT_TURN = [
  { role: "user", text: "fix the rich view", uuid: "u1" },
  { role: "assistant", text: "Let me read the view model.", uuid: "a1" },
  { role: "assistant", text: "Read ghost-companion-view-model.ts", uuid: "a1-t", kind: "tool" },
  { role: "assistant", text: "The grouping is missing.", uuid: "a2" },
  { role: "assistant", text: "Grep rich-tool-lines\nRead style.css", uuid: "a2-t", kind: "tool" },
  { role: "assistant", text: "Here is the fix, and why it works.", uuid: "a3" },
  { role: "user", text: "ship it", uuid: "u2" },
];

test("groupTranscript renders a multi-segment reply as ONE logical turn", () => {
  const segments = groupTranscript(MULTI_SEGMENT_TURN);
  // Three logical turns: Chris, Ghost, Chris.
  const firsts = segments.filter((s) => s.first);
  const lasts = segments.filter((s) => s.last);
  assert.equal(firsts.length, 3);
  assert.equal(lasts.length, 3);
  assert.deepEqual(firsts.map((s) => s.who), ["Chris", "Ghost", "Chris"]);

  // Ghost's turn is the five entries in the middle, and the speaker label is
  // shown exactly once across all of them — that is what makes it read as one
  // block instead of five boxes.
  const ghost = segments.slice(1, segments.length - 1);
  assert.equal(ghost.length, 5);
  assert.equal(ghost.filter((s) => s.first).length, 1);
  assert.equal(ghost[0].first, true);
  assert.equal(ghost[ghost.length - 1].last, true);
  // ...and no separator anywhere inside it.
  assert.deepEqual(ghost.slice(0, -1).map((s) => s.last), [false, false, false, false]);

  // Prose and tool markers alternate, prose first and last — markers sit
  // BETWEEN prose, never replacing it.
  assert.deepEqual(ghost.map((s) => s.kind), ["prose", "tool", "prose", "tool", "prose"]);
});

test("groupTranscript concatenates consecutive prose entries into one block", () => {
  const segments = groupTranscript([
    { role: "assistant", text: "First half.", uuid: "a1" },
    { role: "assistant", text: "Second half.", uuid: "a2" },
    { role: "assistant", text: "Third half.", uuid: "a3" },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, "First half.\n\nSecond half.\n\nThird half.");
  // Every source entry is still reachable, so the lens cursor can match any.
  assert.deepEqual(segments[0].sources.map((t) => t.uuid), ["a1", "a2", "a3"]);
});

test("groupTranscript merges a run of tool entries into one compact marker", () => {
  const segments = groupTranscript([
    { role: "assistant", text: "Read a.ts", uuid: "a1-t", kind: "tool" },
    { role: "assistant", text: "Read b.ts", uuid: "a2-t", kind: "tool" },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "tool");
  assert.equal(segments[0].text, "Read a.ts\nRead b.ts");
  // A turn that is all action still says who acted.
  assert.equal(segments[0].who, "Ghost");
});

test("groupTranscript keeps the <glasses> HUD block out, and drops an empty turn", () => {
  const segments = groupTranscript([
    { role: "assistant", text: "Real prose.\n\n<glasses>\nHeadline\n</glasses>", uuid: "a1" },
    { role: "assistant", text: "<glasses>\nHUD only, no prose\n</glasses>", uuid: "a2" },
    { role: "assistant", text: "More prose.", uuid: "a3" },
  ]);
  // The HUD-only entry renders nothing rather than an empty box — but it must
  // not split the turn either.
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, "Real prose.\n\nMore prose.");
});

test("groupTranscript never folds a surfaced question/answer into neighbouring prose", () => {
  const segments = groupTranscript([
    { role: "assistant", text: "Before.", uuid: "a1" },
    { role: "assistant", text: "> Which one?", uuid: "a1-q", kind: "question" },
    { role: "user", text: "> Chris chose B", uuid: "u1-a0", kind: "answer" },
    { role: "assistant", text: "After.", uuid: "a2" },
  ]);
  assert.deepEqual(segments.map((s) => s.kind), ["prose", "question", "answer", "prose"]);
  // Each is its own logical turn — a side channel, not something said
  // mid-sentence.
  assert.deepEqual(segments.map((s) => s.first), [true, true, true, true]);
  assert.deepEqual(segments.map((s) => s.last), [true, true, true, true]);
  assert.deepEqual(segments.map((s) => s.who), ["Ghost", "Ghost", "Chris", "Ghost"]);
});

test("groupTranscript reports the source index so a row still opens the right turn", () => {
  const segments = groupTranscript(MULTI_SEGMENT_TURN);
  assert.deepEqual(segments.map((s) => s.index), [0, 1, 2, 3, 4, 5, 6]);
});

test("groupTranscript handles an empty transcript", () => {
  assert.deepEqual(groupTranscript([]), []);
});
