/**
 * A small, dependency-free markdown reader for the phone's Doc viewer.
 *
 * WHY NOT `marked` + DOMPurify, which is what solved this exact problem in
 * cc-web (session 0144): both of those render to HTML for a browser. There is
 * no DOM here — the Doc pane is native Android views built by NativeScript —
 * so the HTML pipeline has nothing to render into, and the sanitiser it is
 * paired with guards an injection surface this pane does not have (a Label and
 * a Span cannot execute anything). The equivalent fix for a native pane is to
 * parse the markdown into blocks and inline runs and let the view layer style
 * them, which is what this file does.
 *
 * Deliberately NOT a full CommonMark implementation. The corpus is the same
 * one Chris actually opens from Rich view: project notes, wiki pages, session
 * logs and Ghost's own replies. Headings, lists, fenced and indented code,
 * block quotes, rules, tables-as-preformatted, and inline bold/italic/code/
 * links cover all of it; anything unrecognised falls through as a paragraph,
 * which is exactly the raw-text behaviour this replaces, so an unhandled
 * construct degrades to what the pane did before rather than to nothing.
 *
 * Pure TypeScript with no imports on purpose: tests/markdown-render.test.cjs
 * compiles it standalone (tests/tsconfig.json), which is the only way any of
 * this gets checked without a phone in hand.
 */

export type MdBlockKind =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "p"
  | "code"
  | "quote"
  | "li"
  | "rule";

/** One inline run inside a block: text plus the marks that apply to it. */
export type MdSpan = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline `code`, and the whole body of a fenced block. */
  code?: boolean;
  /** A link's visible text, so the view can underline it. */
  link?: boolean;
};

export type MdBlock = {
  kind: MdBlockKind;
  /** The text with its markers removed — a plain-text fallback, and what a
   * caller that cannot style inline runs should show. */
  text: string;
  spans: MdSpan[];
  /** List nesting depth (0 = top level). Zero for every other kind. */
  depth: number;
  /** The bullet or number a list item is drawn with ("•", "3."). */
  marker?: string;
};

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const FENCE_RE = /^\s*(```+|~~~+)(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const RULE_RE = /^\s*(?:[-*_]\s*){3,}$/;
const TABLE_RE = /^\s*\|.*\|\s*$/;
/** A markdown table's separator row: |---|:--:| etc. */
const TABLE_DIVIDER_RE = /^\s*\|[\s:|-]+\|\s*$/;

/** Nesting: two spaces per level is the convention every doc in this repo
 * uses; a tab counts as one level. Deeper than three reads the same on a
 * phone, so it clamps rather than indenting off the screen. */
function listDepth(indent: string): number {
  const spaces = indent.replace(/\t/g, "  ").length;
  return Math.min(3, Math.floor(spaces / 2));
}

/**
 * Split markdown into renderable blocks.
 *
 * Consecutive non-blank lines join into one paragraph (a hard-wrapped source
 * file must not render as one short line per source line); a blank line ends
 * it. Fenced code keeps its own line breaks verbatim, which is the whole point
 * of it being code.
 */
export function parseMarkdownBlocks(source: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");

  let paragraph: string[] = [];
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text) blocks.push(textBlock("p", text));
  };
  const flushQuote = (): void => {
    if (!quote.length) return;
    const text = quote.join(" ").trim();
    quote = [];
    if (text) blocks.push(textBlock("quote", text));
  };
  const flushAll = (): void => {
    flushParagraph();
    flushQuote();
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";

    // ── fenced code ──────────────────────────────────────────────────────
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushAll();
      const marker = fence[1]!.slice(0, 3);
      const body: string[] = [];
      index++;
      for (; index < lines.length; index++) {
        const inner = lines[index] ?? "";
        if (inner.trimStart().startsWith(marker)) break;
        body.push(inner);
      }
      blocks.push(codeBlock(body.join("\n")));
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    if (RULE_RE.test(line)) {
      flushAll();
      blocks.push({ kind: "rule", text: "", spans: [], depth: 0 });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(4, heading[1]!.length);
      blocks.push(textBlock(`h${level}` as MdBlockKind, heading[2]!.trim()));
      continue;
    }

    // ── tables ───────────────────────────────────────────────────────────
    // Rendered as preformatted rows rather than a real grid: a phone-width
    // Label cannot column-align, and the alternative (dropping the pipes)
    // loses which cell is which. The divider row is dropped because it is
    // pure syntax, and a table that renders as its own rows is legible.
    if (TABLE_RE.test(line)) {
      flushAll();
      const rows: string[] = [];
      for (; index < lines.length && TABLE_RE.test(lines[index] ?? ""); index++) {
        const row = lines[index] ?? "";
        if (!TABLE_DIVIDER_RE.test(row)) rows.push(row.trim());
      }
      index--;
      blocks.push(codeBlock(rows.join("\n")));
      continue;
    }

    // ── indented code (four spaces, outside a list) ──────────────────────
    // A nested list item is also four spaces in, and nested lists are far
    // commoner in this corpus than four-space code (fences dominate), so the
    // list and quote forms win the tie deliberately.
    if (
      /^ {4}\S/.test(line) &&
      !paragraph.length &&
      !quote.length &&
      !BULLET_RE.test(line) &&
      !ORDERED_RE.test(line) &&
      !QUOTE_RE.test(line)
    ) {
      const body: string[] = [];
      for (; index < lines.length; index++) {
        const inner = lines[index] ?? "";
        if (inner.trim() && !/^ {4}/.test(inner)) break;
        body.push(inner.replace(/^ {4}/, ""));
      }
      index--;
      blocks.push(codeBlock(body.join("\n").replace(/\s+$/, "")));
      continue;
    }

    const quoted = QUOTE_RE.exec(line);
    if (quoted) {
      flushParagraph();
      quote.push(quoted[1]!.trim());
      continue;
    }
    flushQuote();

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push(listBlock(listDepth(bullet[1]!), "•", bullet[3]!.trim()));
      continue;
    }
    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      flushParagraph();
      blocks.push(listBlock(listDepth(ordered[1]!), `${ordered[2]}.`, ordered[3]!.trim()));
      continue;
    }

    paragraph.push(line.trim());
  }

  flushAll();
  return blocks;
}

function textBlock(kind: MdBlockKind, raw: string): MdBlock {
  const spans = parseInlineSpans(raw);
  return { kind, text: spansText(spans), spans, depth: 0 };
}

function listBlock(depth: number, marker: string, raw: string): MdBlock {
  const spans = parseInlineSpans(raw);
  return { kind: "li", text: spansText(spans), spans, depth, marker };
}

function codeBlock(body: string): MdBlock {
  return { kind: "code", text: body, spans: [{ text: body, code: true }], depth: 0 };
}

function spansText(spans: MdSpan[]): string {
  return spans.map((span) => span.text).join("");
}

/**
 * Inline marks, in the order they have to be resolved: code first (its content
 * is literal — `**not bold**` inside backticks stays as typed), then links,
 * then bold, then italic. Unmatched markers are left in place rather than
 * eaten, so a stray asterisk in prose still reads as an asterisk.
 */
export function parseInlineSpans(source: string): MdSpan[] {
  const text = String(source ?? "");
  const spans: MdSpan[] = [];
  let plain = "";

  const pushPlain = (): void => {
    if (plain) spans.push({ text: plain });
    plain = "";
  };
  const push = (span: MdSpan): void => {
    pushPlain();
    if (span.text) spans.push(span);
  };

  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);

    // `code`
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      push({ text: code[1]!, code: true });
      index += code[0].length;
      continue;
    }
    // ![alt](src): there is nothing to fetch an image with here, so the alt
    // text is the honest fallback. Checked before the link rule so the '!'
    // does not survive as a stray character in front of the label.
    const image = /^!\[([^\]]*)\]\([^)]*\)/.exec(rest);
    if (image) {
      push({ text: image[1] || "(image)", italic: true });
      index += image[0].length;
      continue;
    }
    // [label](target) — the target is dropped; a phone Label cannot follow it
    // and the URL inline is noise. Autolinking of bare paths is a separate
    // mechanism (transcript-turns.ts) and is untouched by this.
    const link = /^\[([^\]]+)\]\(([^)\s]+)[^)]*\)/.exec(rest);
    if (link) {
      push({ text: link[1]!, link: true });
      index += link[0].length;
      continue;
    }

    // The underscore forms only count at a word boundary. Without that,
    // `snake_case_name`, `_index.md` and `exocortex_app_list` all render as
    // italics — and this corpus is full of file paths and identifiers, so
    // that is the common case, not the edge case.
    const atWordBoundary = index === 0 || !/[A-Za-z0-9_]/.test(text[index - 1] ?? "");
    const bold = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (bold && (bold[1] === "**" || atWordBoundary)) {
      pushPlain();
      for (const span of parseInlineSpans(bold[2]!)) spans.push({ ...span, bold: true });
      index += bold[0].length;
      continue;
    }
    const italic = /^(\*|_)(?=[^\s*_])([\s\S]*?[^\s*_])\1(?!\1)/.exec(rest);
    if (italic && (italic[1] === "*" || atWordBoundary)) {
      pushPlain();
      for (const span of parseInlineSpans(italic[2]!)) spans.push({ ...span, italic: true });
      index += italic[0].length;
      continue;
    }

    plain += text[index];
    index++;
  }
  pushPlain();
  return spans.length ? spans : [{ text: "" }];
}

/**
 * Whether a document is worth parsing at all. A file with no markdown markers
 * (a .log, a .json, a plain .txt) renders better as its own preformatted text
 * than as a wall of "paragraphs" with its line breaks collapsed — and joining
 * lines is exactly what would ruin it.
 */
export function looksLikeMarkdown(source: string, fileName?: string): boolean {
  if (fileName && /\.(md|markdown)$/i.test(fileName)) return true;
  if (fileName && /\.(json|log|csv|ya?ml|xml|html?|css|ts|tsx|js|jsx|mjs|cjs|sh|py|java|c|h|cpp|rs|go|toml|ini|conf)$/i.test(fileName)) {
    return false;
  }
  const text = String(source ?? "");
  return /^\s{0,3}#{1,6}\s+\S/m.test(text) || /^\s*[-*+]\s+\S/m.test(text) || /^\s*\d+[.)]\s+\S/m.test(text) || /```/.test(text);
}

/**
 * The whole document as one preformatted block — the fallback for a file that
 * is not markdown. One block, not one per line: the view renders a code block
 * with its line breaks intact, which is what a log or a JSON file wants.
 */
export function preformattedBlocks(source: string): MdBlock[] {
  return [codeBlock(String(source ?? "").replace(/\s+$/, ""))];
}
