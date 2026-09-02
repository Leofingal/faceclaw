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
