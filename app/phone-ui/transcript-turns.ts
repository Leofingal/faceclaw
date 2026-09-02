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
};

/** One row of Rich view, built from a real transcript turn (not the digest). */
export function turnWhoLabel(turn: TurnLike): string {
  if (turn.kind === "tool") return "Tool";
  if (turn.kind === "question") return "Ghost";
  if (turn.kind === "answer") return "Chris";
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
