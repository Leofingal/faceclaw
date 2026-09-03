/**
 * Round 4, P1: turning the box's real, undigested transcript
 * (`GET /api/transcript/:sessionId`, `ghost-client.ts`'s `fetchTranscript`)
 * into what Rich view renders and what Doc viewer scans for a real file
 * reference. Split out of ghost-companion-view-model.ts because both this
 * app's Rich view and its Doc viewer need it, and because the manifest-
 * verified path-resolution rule here has to stay identical to cc-web's own
 * (apps/claude-code-web/src/public/app.js's `_resolvePath`) — a real file on
 * one client and not the other would be a confusing, silent divergence.
 *
 * WHY THIS EXISTS AT ALL (the actual P1 gap, not a chrome change):
 * Chris's own report was that Doc viewer "just shows that same response" and
 * Rich view shows "just the glasses short responses" instead of the real
 * conversation. Both trace to the same root cause: everything the phone had
 * before this was the GLASSES DIGEST (`ghost-client.ts`'s `GhostItem`,
 * `/api/glasses/...`) — headline + body extracted from the authored
 * <glasses> HUD block, deliberately never the model's actual full reply
 * (`digestTurns()` in the box's own `glasses.js`, and its own doc comment:
 * "the glasses client must never parse... a transcript"). The existing
 * tier-3 fetch (`fetchProse`, `/api/glasses/:id/prose/:uuid`) does return the
 * full reply, but its OWN server-side markdown stripping
 * (`stripMarkdown()` in glasses.js) throws the path back out of a markdown
 * link -- `[label](path)` becomes just `label` -- so it can't be used to
 * find a file reference either. The only source that still has the real
 * path is the raw turn text this module reads from `/api/transcript`.
 */
/**
 * The subset of ghost-client.ts's real GhostTurn this file actually reads.
 * Declared locally (structurally identical, not imported) so this stays a
 * dependency-free pure-logic module: ghost-client.ts pulls in
 * dashboard-settings.ts and its whole native-settings/platform graph, which
 * tests/tsconfig.json's minimal `lib`/no-`~` -alias setup can't resolve — the
 * same reason every other file in that test config (pairing-candidates.ts,
 * sentiment.ts, ...) stays free of app-wide imports. A real GhostTurn from
 * ghost-client.ts satisfies this structurally, so call sites need no cast.
 */
export type TurnLike = {
  role: "user" | "assistant";
  text: string;
  kind?: string;
  /** Present on a real GhostTurn; optional here so the pure-logic tests can
   * build fixtures without one. The Rich-view cursor highlight matches on it. */
  uuid?: string;
};

/** One row of Rich view, built from a real transcript turn (not the digest). */
export function turnWhoLabel(turn: TurnLike): string {
  if (turn.kind === "tool") return "Tool";
  if (turn.kind === "question") return "Ghost";
  if (turn.kind === "answer") return "Chris";
  return turn.role === "user" ? "Chris" : "Ghost";
}

/**
 * Who owns a whole LOGICAL turn — role only, deliberately unlike
 * turnWhoLabel() above. A logical turn that happens to open with a tool call
 * is still Ghost speaking; labelling that block "TOOL" is the inversion this
 * whole grouping pass exists to remove.
 */
function blockWhoLabel(turn: TurnLike): string {
  return turn.role === "user" ? "Chris" : "Ghost";
}

/**
 * Cut everything from the <glasses> block onward, the same anchor the box's
 * own `stripGlassesBlock()` (glasses.js) trusts: a line that is ONLY the
 * opening tag, case-insensitive. Reusing a looser match would let a turn
 * that merely mentions the tag in prose start truncating at the mention —
 * the exact bug session 0109 fixed server-side; the anchor can't be relaxed
 * here either.
 */
export function stripGlassesBlock(text: string): string {
  const openerRe = /^[ \t]*<glasses>[ \t]*$/im;
  const m = openerRe.exec(text || "");
  return m ? text.slice(0, m.index) : text || "";
}

/** First non-empty line (a readable one-line summary) and the rest. */
export function splitHeadlineBody(text: string): { headline: string; body: string } {
  const lines = text.split("\n").map((l) => l.trim());
  const firstIndex = lines.findIndex((l) => l.length > 0);
  if (firstIndex < 0) return { headline: "", body: "" };
  const headlineRaw = lines[firstIndex];
  const headline = headlineRaw.length > 140 ? `${headlineRaw.slice(0, 139)}…` : headlineRaw;
  const body = lines
    .slice(firstIndex + 1)
    .filter((l) => l.length > 0)
    .join("\n");
  return { headline, body };
}

// ── Rich view: grouping segments into logical turns ────────────────────────
/**
 * THE BUG THIS EXISTS TO FIX (Chris, live against round 4's own build,
 * 2026-09-02): *"each of your sends are getting their own box, so your prose
 * is... listing too much information"* / *"what I see on the screen is 80%
 * tool use, and almost no prose responses... the Rich view on the companion
 * app is doing it backward"*.
 *
 * The transcript the box returns is NOT one entry per conversational turn.
 * One Ghost reply is a RUN of entries — prose, then a `kind:'tool'` marker
 * entry, then more prose, then another marker. (`readTurns()` in cc-web's
 * `transcript-reader.js` pushes one turn per assistant JSONL message, plus a
 * separate `uuid + '-t'` turn carrying that message's tool markers.) Round 4
 * mapped that array 1:1 onto rows and gave every entry the same bordered card
 * with a bold 16pt headline — so a one-line `Read foo.ts` marker rendered
 * heavier than the prose around it, and a single reply arrived as a dozen
 * disconnected boxes.
 *
 * cc-web's own rich view already solves this, and its CSS says why
 * (`apps/claude-code-web/src/public/style.css`, `.rich-tool-lines`): "compact
 * tool-activity markers between prose — so the rich view reads as a full
 * transcript (actions + words), muted so prose stays primary." This function
 * is that behaviour in native terms.
 *
 * WHERE THE TURN BOUNDARY COMES FROM — a judgment call, documented because
 * the payload does NOT carry one. Each entry has only `role`, `kind`, `uuid`
 * and `ts`; there is no logical-turn id to read. A logical turn is therefore
 * inferred as **a maximal run of consecutive same-`role` entries**, which is
 * exactly what one is: Ghost keeps talking (and acting) until Chris says
 * something. Two deliberate exceptions:
 *   - a surfaced AskUserQuestion (`kind` 'question' / 'answer') never merges
 *     into a neighbouring run. cc-web gives those their own tinted card
 *     because they are a side channel; folding one into the prose above would
 *     read as Ghost having said it mid-sentence.
 *   - `uuid` is NOT used to infer boundaries. It looks like it could ('-t'
 *     suffixes a tool turn), but that only ties a marker to the ONE message
 *     it came from, not to the reply — so it can't see a turn boundary at all.
 */

export type RichSegmentKind = "prose" | "tool" | "question" | "answer";

/** One rendered piece of Rich view. A logical turn is a run of these, marked
 * by `first` (where the speaker label goes) and `last` (where the separator
 * goes) — everything between reads as one continuous block. */
export type RichSegment<T extends TurnLike = TurnLike> = {
  kind: RichSegmentKind;
  /** "Ghost" / "Chris" — rendered only where `first` is true. */
  who: string;
  first: boolean;
  last: boolean;
  /** Already concatenated: consecutive prose entries joined by a blank line. */
  text: string;
  /** Index, into the array passed in, of the first entry behind this segment. */
  index: number;
  /** Every entry behind this segment — the cursor highlight matches on these. */
  sources: T[];
};

/** Keep paragraphs, drop the gaps that accumulate at every join. */
function normalizeProse(text: string): string {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function segmentKindOf(turn: TurnLike): RichSegmentKind {
  if (turn.kind === "tool") return "tool";
  if (turn.kind === "question") return "question";
  if (turn.kind === "answer") return "answer";
  return "prose";
}

/** Self-contained cards; they never merge with a neighbouring run. */
function isStandalone(kind: RichSegmentKind): boolean {
  return kind === "question" || kind === "answer";
}

export function groupTranscript<T extends TurnLike>(turns: T[]): RichSegment<T>[] {
  const out: RichSegment<T>[] = [];
  let blockStart = 0; // index in `out` where the logical turn still open began

  const closeBlock = (): void => {
    if (blockStart >= out.length) return; // the block produced nothing renderable
    out[blockStart].first = true;
    out[out.length - 1].last = true;
    blockStart = out.length;
  };

  let prev: T | null = null;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const kind = segmentKindOf(turn);
    // Only ordinary prose carries a <glasses> HUD block; a tool marker or a
    // question card is authored text that must not be cut at a mention.
    const text =
      kind === "prose" ? normalizeProse(stripGlassesBlock(turn.text)) : (turn.text || "").trim();

    if (
      prev === null ||
      turn.role !== prev.role ||
      isStandalone(kind) ||
      isStandalone(segmentKindOf(prev))
    ) {
      closeBlock();
    }
    prev = turn;

    // A reply whose entire text WAS the <glasses> block leaves nothing to
    // render. Drop it rather than opening an empty box — round 4 rendered
    // those as blank cards, which is part of what made the pane look padded
    // out with everything except prose.
    if (!text) continue;

    // Merge into the segment already open when it is the same kind inside the
    // same logical turn: consecutive prose becomes ONE continuous block, and a
    // run of action markers becomes one compact run instead of N boxes.
    const open = out.length > blockStart ? out[out.length - 1] : null;
    if (open && open.kind === kind && (kind === "prose" || kind === "tool")) {
      open.text = kind === "prose" ? `${open.text}\n\n${text}` : `${open.text}\n${text}`;
      open.sources.push(turn);
      continue;
    }

    out.push({
      kind,
      who: blockWhoLabel(turn),
      first: false,
      last: false,
      text,
      index: i,
      sources: [turn],
    });
  }
  closeBlock();
  return out;
}

/** Lookup built once per manifest fetch: basename -> path, or null if ambiguous. */
export function buildBasenameIndex(files: string[]): Map<string, string | null> {
  const base = new Map<string, string | null>();
  for (const f of files) {
    const b = f.split("/").pop() ?? f;
    base.set(b, base.has(b) ? null : f);
  }
  return base;
}

/**
 * Resolve one mentioned token to a real repo-relative path, or null. Exact
 * match wins; a bare filename resolves only if its basename is unique --
 * identical rule to cc-web's `_resolvePath`, on purpose (see file header).
 */
function resolveToken(token: string, fileSet: Set<string>, baseIndex: Map<string, string | null>): string | null {
  const p = token.replace(/^\.\//, "");
  if (fileSet.has(p)) return p;
  if (!p.includes("/")) {
    const hit = baseIndex.get(p);
    if (hit) return hit;
  }
  return null;
}

const MARKDOWN_LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
// A path-looking bare token: has a slash, or ends in a short alnum extension.
const BARE_PATH_RE = /[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-/]*[A-Za-z0-9_\-]|[A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,8}/g;

/**
 * The first real file this turn's raw text references -- a markdown
 * link/image target, or a bare path/filename mention -- verified against the
 * session's real file manifest so an ordinary word (or a URL, a version
 * number) never false-positives into "a file". Returns null when the
 * manifest hasn't loaded yet or nothing resolves; both are the correct,
 * silent fallback to "just show the turn's text" (below).
 */
export function findFileReference(
  text: string,
  files: string[],
  baseIndex: Map<string, string | null>,
): string | null {
  if (!text || !files.length) return null;
  const fileSet = new Set(files);
  MARKDOWN_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKDOWN_LINK_RE.exec(text))) {
    const resolved = resolveToken(m[1], fileSet, baseIndex);
    if (resolved) return resolved;
  }
  BARE_PATH_RE.lastIndex = 0;
  while ((m = BARE_PATH_RE.exec(text))) {
    const token = m[0].replace(/[.,;:)]+$/, "");
    const resolved = resolveToken(token, fileSet, baseIndex);
    if (resolved) return resolved;
  }
  return null;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
// Extensions (or extension-less files, e.g. Dockerfile/LICENSE/README) the
// Doc pane will actually fetch and render as text. Everything else --
// audio/video/pdf/binary -- gets named, not fetched: this is a plain-text
// Label, not a renderer, and decoding an arbitrary binary response as UTF-8
// text is how you get a garbled pane or a needlessly large fetch, not a
// preview.
const TEXT_EXT_RE = /\.(md|markdown|txt|json|ts|tsx|js|jsx|mjs|cjs|csv|ya?ml|xml|html?|css|log|sh|py|java|c|h|cpp|rs|go|toml|ini|conf)$/i;

export function isImageReference(path: string): boolean {
  return IMAGE_EXT_RE.test(path);
}

export function isTextRenderableReference(path: string): boolean {
  if (IMAGE_EXT_RE.test(path)) return false;
  if (!path.includes(".")) return true; // README, LICENSE, Dockerfile, ...
  return TEXT_EXT_RE.test(path);
}
