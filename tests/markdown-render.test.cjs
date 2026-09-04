const test = require("node:test");
const assert = require("node:assert");

const {
  parseMarkdownBlocks,
  parseInlineSpans,
  looksLikeMarkdown,
  preformattedBlocks,
} = require("../.test-build/app/phone-ui/markdown-render.js");

const kinds = (blocks) => blocks.map((block) => block.kind);
const texts = (blocks) => blocks.map((block) => block.text);

test("headings become heading blocks, capped at h4", () => {
  const blocks = parseMarkdownBlocks("# One\n## Two\n### Three\n##### Five");
  assert.deepStrictEqual(kinds(blocks), ["h1", "h2", "h3", "h4"]);
  assert.deepStrictEqual(texts(blocks), ["One", "Two", "Three", "Five"]);
});

test("a hard-wrapped paragraph joins into one block, blank lines split", () => {
  const blocks = parseMarkdownBlocks("first line\nsecond line\n\nnext para");
  assert.deepStrictEqual(kinds(blocks), ["p", "p"]);
  assert.deepStrictEqual(texts(blocks), ["first line second line", "next para"]);
});

test("bullets and ordered items keep their marker and nesting depth", () => {
  const blocks = parseMarkdownBlocks("- top\n  - nested\n1. one\n2) two");
  assert.deepStrictEqual(kinds(blocks), ["li", "li", "li", "li"]);
  assert.deepStrictEqual(
    blocks.map((block) => [block.marker, block.depth]),
    [["•", 0], ["•", 1], ["1.", 0], ["2.", 0]],
  );
});

test("a fenced block keeps its own line breaks and is not re-parsed", () => {
  const blocks = parseMarkdownBlocks("intro\n\n```ts\nconst a = 1;\n# not a heading\n```\nafter");
  assert.deepStrictEqual(kinds(blocks), ["p", "code", "p"]);
  assert.strictEqual(blocks[1].text, "const a = 1;\n# not a heading");
});

test("block quotes group, and a rule is its own block", () => {
  const blocks = parseMarkdownBlocks("> quoted one\n> quoted two\n\n---\n\nafter");
  assert.deepStrictEqual(kinds(blocks), ["quote", "rule", "p"]);
  assert.strictEqual(blocks[0].text, "quoted one quoted two");
});

test("a table renders as preformatted rows with the divider dropped", () => {
  const blocks = parseMarkdownBlocks("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.deepStrictEqual(kinds(blocks), ["code"]);
  assert.strictEqual(blocks[0].text, "| a | b |\n| 1 | 2 |");
});

test("inline bold, italic and code become marked spans", () => {
  const spans = parseInlineSpans("plain **bold** and *slanted* and `code`");
  assert.deepStrictEqual(
    spans.map((span) => [span.text, !!span.bold, !!span.italic, !!span.code]),
    [
      ["plain ", false, false, false],
      ["bold", true, false, false],
      [" and ", false, false, false],
      ["slanted", false, true, false],
      [" and ", false, false, false],
      ["code", false, false, true],
    ],
  );
});

test("markdown inside backticks stays literal", () => {
  const spans = parseInlineSpans("`**not bold**`");
  assert.deepStrictEqual(spans.map((span) => span.text), ["**not bold**"]);
  assert.strictEqual(spans[0].code, true);
});

test("underscores inside identifiers and paths are not italics", () => {
  for (const source of ["snake_case_name", "_index.md is a file", "exocortex_app_list.ts"]) {
    const spans = parseInlineSpans(source);
    assert.strictEqual(spans.map((span) => span.text).join(""), source, source);
    assert.ok(!spans.some((span) => span.italic), source);
  }
});

test("a leading-underscore emphasis at a word boundary still works", () => {
  const spans = parseInlineSpans("say _this_ aloud");
  assert.deepStrictEqual(
    spans.map((span) => [span.text, !!span.italic]),
    [["say ", false], ["this", true], [" aloud", false]],
  );
});

test("links keep their label and drop the target; images fall back to alt text", () => {
  assert.deepStrictEqual(
    parseInlineSpans("see [the page](https://example.com/x) now").map((span) => span.text),
    ["see ", "the page", " now"],
  );
  assert.deepStrictEqual(
    parseInlineSpans("![a chart](chart.png)").map((span) => span.text),
    ["a chart"],
  );
});

test("an unmatched marker is left alone rather than eaten", () => {
  const spans = parseInlineSpans("2 * 3 = 6");
  assert.strictEqual(spans.map((span) => span.text).join(""), "2 * 3 = 6");
});

test("looksLikeMarkdown trusts the extension first, then the content", () => {
  assert.strictEqual(looksLikeMarkdown("no markers here", "notes.md"), true);
  assert.strictEqual(looksLikeMarkdown("# heading", "server.log"), false);
  assert.strictEqual(looksLikeMarkdown('{"a": 1}', "data.json"), false);
  assert.strictEqual(looksLikeMarkdown("## a heading"), true);
  assert.strictEqual(looksLikeMarkdown("just a sentence."), false);
});

test("preformattedBlocks keeps a non-markdown file's line breaks", () => {
  const blocks = preformattedBlocks("line one\nline two\n");
  assert.deepStrictEqual(kinds(blocks), ["code"]);
  assert.strictEqual(blocks[0].text, "line one\nline two");
});

test("every block always carries at least one span, so a row can always render", () => {
  const blocks = parseMarkdownBlocks("# h\n\ntext\n\n- item\n\n> q\n\n---\n\n```\nx\n```");
  for (const block of blocks) {
    assert.ok(Array.isArray(block.spans), block.kind);
    if (block.kind !== "rule") assert.ok(block.spans.length > 0, block.kind);
  }
});
