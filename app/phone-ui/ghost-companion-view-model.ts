/**
 * Ghost's phone-side companion: the four-pane carousel from the design pilot
 * (Terminal · Rich view · Doc viewer · Settings) with the compose box docked
 * below the three content panes.
 *
 * It is a VIEW OF THE GLASSES' OWN SESSION for the glasses-facing state
 * (open/cursor/status) — that part still comes from ghost-companion-store,
 * which GhostLayer fills from the poll it already runs; nothing here opens a
 * second connection for THAT. Round 4 (2026-09-02) added a second, genuinely
 * separate poll (see "Transcript + files" below) for Rich view and Doc
 * viewer's own content, because the digest that store carries can't serve
 * either — see transcript-turns.ts's header for exactly why.
 *
 * Where the pilot's four panes landed on what Ghost actually has:
 *
 *   Rich view   the REAL transcript (round 4): every turn, not just the
 *               authored <glasses> HUD lines the lens pages through. The
 *               lens's own cursor is still marked, matched by uuid. Default
 *               pane.
 *   Terminal    the glasses' own digest UNDIGESTED — every field of every
 *               DIGEST item in a monospace dump, plus poll diagnostics. Left
 *               exactly as it was; round 4's instruction scoped the new
 *               transcript data path to Rich view and Doc viewer only. Named
 *               for what it shows on screen, not for what Rich view now is.
 *   Doc viewer  round 4: the current turn's real file reference when it has
 *               one — an actual project file, fetched and shown, not an
 *               echo of the turn's own text (0138's spec, never built before
 *               now). Falls back to the turn's own text (glasses-block
 *               stripped) when it doesn't reference a file. Tapping a row in
 *               Rich view opens it here.
 *   Settings    Ghost's real settings (host, token, session, auto-follow,
 *               speak), the same ConfigSetting objects the glasses menu edits.
 */
import { FormattedString, Observable, ScrollView, Span } from "@nativescript/core";
import {
  looksLikeMarkdown,
  parseMarkdownBlocks,
  preformattedBlocks,
  type MdBlock,
} from "./markdown-render";
import {
  fetchFileManifest,
  fetchFileText,
  fetchTranscript,
  ghostAutoFollowSetting,
  ghostHostSetting,
  ghostSessionSetting,
  ghostSpeakSetting,
  ghostTokenSetting,
  sendInput,
  type GhostItem,
  type GhostTurn,
} from "../apps/ghost/ghost-client";
import {
  ghostCompanionState,
  onGhostCompanionChanged,
  type GhostCompanionState,
} from "../apps/ghost/ghost-companion-store";
import { formatErrorMessage } from "../util/format-error";
import {
  buildBasenameIndex,
  findFileReference,
  groupTranscript,
  isTextRenderableReference,
  splitHeadlineBody,
  stripGlassesBlock,
  turnWhoLabel,
} from "./transcript-turns";

type PaneId = "terminal" | "rich" | "doc" | "settings";

const PANES: PaneId[] = ["terminal", "rich", "doc", "settings"];
const PANE_NAMES: Record<PaneId, string> = {
  terminal: "Terminal",
  rich: "Rich view",
  doc: "Doc viewer",
  settings: "Settings",
};
/**
 * Rich view is the default and sits second: one pane to its left, two to its
 * right. Chris called it the "central default" in the pilot and gave no
 * explicit order, so this placement carries over from the pilot rather than
 * being re-decided here.
 */
const DEFAULT_PANE_INDEX = 1;

/** How often the transcript + file manifest are polled while this pane is on
 * screen — same cadence GhostLayer already uses for the glasses digest poll,
 * kept identical so nothing here ever looks staler than the lens. This is a
 * SEPARATE poll (see the file header): the digest and the full transcript
 * are different payloads for different consumers, not two copies of one. */
const TRANSCRIPT_POLL_MS = 3000;
/** The file manifest changes far less often than the transcript; refetching
 * it every 3s would be pure waste (it walks the whole working tree). */
const MANIFEST_TTL_MS = 30000;
/** /api/transcript returns the whole session unbounded, and Rich view's
 * <Repeater> is not virtualized (see `turns` below) — cap what renders. */
const RICH_VIEW_MAX_ROWS = 300;
/** How close to the end still counts as "reading the newest content", and so
 * keeps Rich view following new arrivals. Same intent as cc-web's own 40px
 * check, in device-independent pixels against a bigger phone line height. */
const AT_BOTTOM_SLACK = 80;
/** Doc viewer's <Repeater> is not virtualized either (same reason Rich view's
 * row count is capped): one native Label per block, so a 2000-line wiki page
 * would otherwise mean 2000 live views. The 20000-char fetch cap above already
 * bounds this loosely; this bounds it exactly. */
const DOC_MAX_BLOCKS = 400;

/**
 * One row of the Rich view — one SEGMENT of a logical turn, not one transcript
 * entry (see transcript-turns.ts's groupTranscript() for the bug that
 * distinction fixes). A row is either prose or a compact tool marker, never
 * both, and only the first row of a logical turn carries the speaker label:
 * the rest run straight on so a reply reads as one continuous block.
 */
export type GhostTurnRow = {
  who: string;
  /** Visible on the first row of a logical turn only. */
  whoVisibility: "visible" | "collapse";
  proseText: string;
  proseVisibility: "visible" | "collapse";
  /** Carries the question/answer tint; prose otherwise. */
  proseClass: string;
  toolText: string;
  toolVisibility: "visible" | "collapse";
  /** Marks the item the lens has under its cursor, and the end of a turn. */
  rowClass: string;
  index: number;
  onRowTap: () => void;
};

/**
 * One rendered markdown block in the Doc viewer: a styled Label's worth.
 * `formatted` carries the inline runs (bold / italic / code / link text);
 * `blockClass` carries the block-level treatment (heading size, code
 * background, list indent, quote bar) so app.css keeps the styling.
 */
export type DocBlockRow = {
  formatted: FormattedString;
  blockClass: string;
};

/** Android's built-in monospace family; there is no bundled mono TTF on the
 * phone side, and this is the same name the platform resolves for `<tt>`. */
const MONO_FAMILY = "monospace";

function docBlockRow(block: MdBlock): DocBlockRow {
  const formatted = new FormattedString();
  const classes = ["doc-md", `doc-md-${block.kind}`];
  if (block.kind === "li") {
    classes.push(`doc-md-li-d${block.depth}`);
    const marker = new Span();
    marker.text = `${block.marker ?? "•"}  `;
    formatted.spans.push(marker);
  }
  const heading = block.kind === "h1" || block.kind === "h2" || block.kind === "h3" || block.kind === "h4";
  for (const run of block.spans) {
    const span = new Span();
    span.text = run.text;
    // A heading's own weight is set here as well as in CSS: a Span with no
    // fontWeight of its own does not always pick the Label's up on Android,
    // and a heading that renders at body weight is the whole bug again.
    if (run.bold || heading) span.fontWeight = "bold";
    if (run.italic) span.fontStyle = "italic";
    if (run.code) span.fontFamily = MONO_FAMILY;
    if (run.link) span.textDecoration = "underline";
    formatted.spans.push(span);
  }
  return { formatted, blockClass: classes.join(" ") };
}

export class GhostCompanionViewModel extends Observable {
  private _paneIndex = DEFAULT_PANE_INDEX;
  private _state: GhostCompanionState = ghostCompanionState();
  private _composeText = "";
  private _sending = false;
  private _composeStatus = "";

  // ── Transcript + files (round 4) ─────────────────────────────────────────
  // Powers Rich view directly and Doc viewer's file-reference detection.
  // Polled only while this view model is attached (i.e. the phone is
  // actually showing the Ghost companion) — see attach()/dispose().
  private _transcript: GhostTurn[] = [];
  private _transcriptError = "";
  private transcriptTimer: ReturnType<typeof setInterval> | null = null;
  private _fileList: string[] = [];
  private _fileBaseIndex: Map<string, string | null> = new Map();
  private manifestSessionId: string | null = null;
  private manifestAt = 0;

  /**
   * Which item the Doc viewer is on. Null means "follow the lens" — the doc
   * pane then shows whatever the glasses are showing, which is what you want
   * when you unfold the phone mid-session. Tapping a row pins it instead.
   */
  private _pinnedUuid: string | null = null;
  /** The current doc turn's resolved file reference, once one is found. */
  private _docFileRef: string | null = null;
  private _docFileText = "";
  private _docFileLoading = false;
  private _docFileError = "";
  /** Doc viewer's rendered markdown, cached on the source text it was built
   * from — see buildDocBlocks() for why the poll must not rebuild it. */
  private _docBlocksSource: string | null = null;
  private _docBlocksCache: DocBlockRow[] = [];

  /** Rich view's ScrollView, handed over by its own `loaded` event — the only
   * way to drive scroll position from here (see scrollRichToBottom). */
  private richScroll: ScrollView | null = null;

  private unsubscribe: (() => void) | null = null;

  attach(): void {
    if (this.unsubscribe) return;
    this._state = ghostCompanionState();
    this.unsubscribe = onGhostCompanionChanged((state) => {
      this._state = state;
      this.refreshFeed();
    });
    this.refreshFeed();
    this.startTranscriptPoll();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopTranscriptPoll();
  }

  // ── Transcript + files polling (round 4) ───────────────────────────────

  private startTranscriptPoll(): void {
    if (this.transcriptTimer) return;
    this.pollTranscript();
    this.transcriptTimer = setInterval(() => this.pollTranscript(), TRANSCRIPT_POLL_MS);
  }

  private stopTranscriptPoll(): void {
    if (this.transcriptTimer) {
      clearInterval(this.transcriptTimer);
      this.transcriptTimer = null;
    }
  }

  private pollTranscript(): void {
    const sessionId = this._state.sessionId;
    if (!sessionId) return;
    fetchTranscript(sessionId)
      .then((turns) => {
        this._transcript = turns;
        this._transcriptError = "";
        this.refreshTranscriptViews();
        this.refreshFileManifestIfStale(sessionId);
      })
      .catch((error) => {
        // Keep whatever transcript we already have on screen; only surface
        // the error where nothing has ever loaded (feedEmptyMessage below).
        this._transcriptError = formatErrorMessage(error, 160);
        this.refreshTranscriptViews();
      });
  }

  private refreshFileManifestIfStale(sessionId: string): void {
    const now = Date.now();
    if (this.manifestSessionId === sessionId && now - this.manifestAt < MANIFEST_TTL_MS) return;
    this.manifestAt = now;
    this.manifestSessionId = sessionId;
    fetchFileManifest(sessionId)
      .then((files) => {
        this._fileList = files;
        this._fileBaseIndex = buildBasenameIndex(files);
        // A reference may have been sitting in the current turn's text
        // before the manifest loaded; re-check now that it has.
        this.loadDocFileIfNeeded();
        this.notifyDocChange();
      })
      .catch(() => {
        // Manifest failures just mean file-reference detection stays off
        // for now (findFileReference returns null on an empty list) — the
        // doc pane still falls back to the turn's own text, so this is a
        // silent degradation, not a broken pane.
      });
  }

  // ── Panes ───────────────────────────────────────────────────────────────

  private get paneId(): PaneId {
    return PANES[this._paneIndex] ?? "rich";
  }

  /**
   * NOT BOUND BY ghost-companion.xml ANY MORE, and deliberately kept.
   *
   * Round 2 removed this companion's own header entirely: the one row of
   * chrome now comes from phone-ui/exocortex-header.xml and is shared with
   * every other app's companion view. The pane name was already redundant
   * with the highlighted tab directly below it, which is why round 1 had
   * already shrunk it to 14pt before Chris asked for the row itself to go.
   *
   * These two stay as public members because they are a correct, cheap
   * description of the pane's state that a later pass (a per-pane subtitle,
   * an accessibility label, a narrower phone layout) would otherwise have to
   * rewrite from scratch. They cost nothing while nothing binds them.
   */
  get paneName(): string {
    return PANE_NAMES[this.paneId];
  }

  /** See paneName: kept, not currently bound. */
  get paneStatusVisibility(): "visible" | "collapse" {
    return this.paneStatus ? "visible" : "collapse";
  }

  /**
   * What this pane is showing, or why it isn't. Chris named this row's Rich-
   * view text ("20 in the feed - session id: ...") as one of the two lines to
   * remove; the same two facts are the Terminal pane's first three lines, so
   * they are still one tab away rather than gone.
   */
  get paneStatus(): string {
    if (this._state.status) return this._state.status;
    switch (this.paneId) {
      case "rich":
        return `${this._transcript.length} in the transcript · session ${this.sessionLabel}`;
      case "terminal":
        return `raw feed · session ${this.sessionLabel}`;
      case "doc":
        return this._docFileLoading ? "loading the referenced file…" : this.docSubtitle;
      default:
        return "host, session and voice — the same settings the glasses menu edits";
    }
  }

  private get sessionLabel(): string {
    return this._state.sessionId || "(none set)";
  }

  get terminalTabClass(): string {
    return this.tabClass("terminal");
  }

  get richTabClass(): string {
    return this.tabClass("rich");
  }

  get docTabClass(): string {
    return this.tabClass("doc");
  }

  get settingsTabClass(): string {
    return this.tabClass("settings");
  }

  private tabClass(id: PaneId): string {
    return this.paneId === id ? "ghost-tab ghost-tab-active" : "ghost-tab";
  }

  get terminalPaneVisibility(): "visible" | "collapse" {
    return this.paneVisibility("terminal");
  }

  get richPaneVisibility(): "visible" | "collapse" {
    return this.paneVisibility("rich");
  }

  get docPaneVisibility(): "visible" | "collapse" {
    return this.paneVisibility("doc");
  }

  get settingsPaneVisibility(): "visible" | "collapse" {
    return this.paneVisibility("settings");
  }

  private paneVisibility(id: PaneId): "visible" | "collapse" {
    return this.paneId === id ? "visible" : "collapse";
  }

  /**
   * The compose box is docked below the three views OF the conversation, and
   * absent on Settings — composing a message on a screen of toggles is the one
   * place it would read as a stray control (the pilot landed on the same rule
   * after Chris used the first pass).
   */
  get composeVisibility(): "visible" | "collapse" {
    return this.paneId === "settings" ? "collapse" : "visible";
  }

  onTerminalTabTap(): void {
    this.setPane(0);
  }

  onRichTabTap(): void {
    this.setPane(1);
  }

  onDocTabTap(): void {
    this.setPane(2);
  }

  onSettingsTabTap(): void {
    this.setPane(3);
  }

  /**
   * Swipe between panes. The pilot leaned on edge arrows because it was a
   * mouse-driven browser mockup; on the real phone the tab bar is the explicit
   * control and the swipe is the one that costs nothing to reach for.
   */
  onPaneSwipe(args: { direction?: number }): void {
    // SwipeDirection.right === 1, .left === 2 in @nativescript/core.
    const step = args?.direction === 2 ? 1 : args?.direction === 1 ? -1 : 0;
    if (step === 0) return;
    this.setPane(this._paneIndex + step);
  }

  private setPane(index: number): void {
    const next = Math.max(0, Math.min(PANES.length - 1, index));
    if (next === this._paneIndex) return;
    this._paneIndex = next;
    this.notifyPaneChange();
    if (this.paneId === "doc") this.loadDocFileIfNeeded();
    // Arriving on Rich view always lands on the newest turn — including the
    // hop onSendTap() makes after a send, where the whole point is to watch
    // the reply arrive.
    if (this.paneId === "rich") this.scrollRichToBottom(true);
  }

  private notifyPaneChange(): void {
    this.notifyPropertyChange("paneName", this.paneName);
    this.notifyPropertyChange("paneStatus", this.paneStatus);
    this.notifyPropertyChange("paneStatusVisibility", this.paneStatusVisibility);
    this.notifyPropertyChange("terminalTabClass", this.terminalTabClass);
    this.notifyPropertyChange("richTabClass", this.richTabClass);
    this.notifyPropertyChange("docTabClass", this.docTabClass);
    this.notifyPropertyChange("settingsTabClass", this.settingsTabClass);
    this.notifyPropertyChange("terminalPaneVisibility", this.terminalPaneVisibility);
    this.notifyPropertyChange("richPaneVisibility", this.richPaneVisibility);
    this.notifyPropertyChange("docPaneVisibility", this.docPaneVisibility);
    this.notifyPropertyChange("settingsPaneVisibility", this.settingsPaneVisibility);
    this.notifyPropertyChange("composeVisibility", this.composeVisibility);
  }

  // ── Rich view (round 4: the real transcript, not the digest) ───────────

  /** Which transcript turn the lens's own cursor corresponds to, by uuid —
   * the digest and the raw transcript are read from the same JSONL, so an
   * assistant digest item's uuid is the same turn's uuid here (confirmed
   * against the box's own digestTurns(), glasses.js: `uuid: t.uuid`). Falls
   * back to no match (no row highlighted) rather than guessing, on a user
   * turn or anything digestTurns() didn't preserve identically. */
  private cursorTurnUuid(): string | null {
    const items = this._state.items;
    const cursor = this._state.cursor;
    if (cursor >= 0 && cursor < items.length) return items[cursor].uuid ?? null;
    return null;
  }

  /**
   * Rich view's rows. NOT one row per transcript entry any more — that was the
   * bug (see groupTranscript()'s header for Chris's own field report). The
   * entries are first grouped into logical turns, consecutive prose is
   * concatenated, and tool activity collapses to compact marker rows BETWEEN
   * the prose rather than into equally-weighted boxes of its own.
   *
   * splitHeadlineBody() is deliberately NOT used here any more. It is the
   * GLASSES digest's convention — first line as a bold headline, the rest
   * smaller — and applying it to a real reply both re-weighted the opening
   * sentence as a heading and dropped every blank line, destroying the
   * paragraph structure of the prose it was meant to show. It stays in use for
   * docTitle(), where a genuine one-line summary is what's wanted.
   */
  get turns(): GhostTurnRow[] {
    const cursorUuid = this.cursorTurnUuid();
    // /api/transcript returns the WHOLE session, unbounded (unlike the
    // digest's own `limit` param) -- and this XML's <Repeater> is not
    // virtualized, so an unbounded row count on a long-running session would
    // mean hundreds of live native views. Cap what actually RENDERS; doc
    // viewer / cursor matching below still search the full `_transcript`
    // array, so an older turn stays reachable by pin/cursor even once its
    // row has scrolled out of this list. The cap counts raw ENTRIES, not
    // grouped rows, so olderTurnsHiddenMessage stays true and the grouping
    // can only ever reduce the live view count from here.
    const start = Math.max(0, this._transcript.length - RICH_VIEW_MAX_ROWS);
    return groupTranscript(this._transcript.slice(start)).map((segment) => {
      const index = start + segment.index;
      const isTool = segment.kind === "tool";
      const current = !!cursorUuid && segment.sources.some((t) => t.uuid === cursorUuid);
      const classes = ["ghost-seg"];
      // The separator (and the gap) belongs at the END of a logical turn, so
      // the segments inside one read as continuous.
      if (segment.last) classes.push("ghost-seg-end");
      if (current) classes.push("ghost-seg-current");
      const proseClasses = ["ghost-seg-prose"];
      if (segment.kind === "question") proseClasses.push("ghost-seg-question");
      if (segment.kind === "answer") proseClasses.push("ghost-seg-answer");
      return {
        who: segment.who,
        whoVisibility: segment.first ? "visible" : "collapse",
        proseText: isTool ? "" : segment.text,
        proseVisibility: isTool ? "collapse" : "visible",
        proseClass: proseClasses.join(" "),
        toolText: isTool ? segment.text : "",
        toolVisibility: isTool ? "visible" : "collapse",
        rowClass: classes.join(" "),
        index,
        onRowTap: () => this.openDocFor(index),
      } as GhostTurnRow;
    });
  }

  // ── Rich view scroll position ──────────────────────────────────────────
  /**
   * Chris, same field report: the pane opens "almost inverted" — a ScrollView
   * starts at offset 0, so a long session opened on its OLDEST content and he
   * had to scroll the whole way down to find the reply he had just read on the
   * lens. The newest turn is what the pane is for.
   *
   * The follow rule is cc-web's (app.js's renderRichView): jump on open, and
   * afterwards only keep following when the reader is ALREADY at the bottom —
   * yanking the view down while someone is reading history is the opposite bug.
   */
  onRichScrollLoaded(args: { object?: unknown }): void {
    this.richScroll = (args?.object as ScrollView) ?? null;
    this.scrollRichToBottom(true);
  }

  private scrollRichToBottom(force: boolean): void {
    const view = this.richScroll;
    if (!view || this.paneId !== "rich") return;
    if (!force && view.scrollableHeight - view.verticalOffset > AT_BOTTOM_SLACK) return;
    // The Repeater's new rows are not measured yet on this tick (and on a pane
    // switch the ScrollView was collapsed a moment ago, so scrollableHeight is
    // still 0). Re-issue the jump as layout settles rather than guessing one
    // delay that works on every content size.
    const jump = (): void => {
      const target = this.richScroll;
      if (!target || this.paneId !== "rich") return;
      try {
        target.scrollToVerticalOffset(target.scrollableHeight, false);
      } catch {
        // A ScrollView that is between layouts throws rather than no-opping;
        // the next staged attempt below covers it.
      }
    };
    jump();
    setTimeout(jump, 60);
    setTimeout(jump, 250);
  }

  /** Surfaces the RICH_VIEW_MAX_ROWS cap rather than silently dropping
   * history — see `turns` above for why the cap exists. Older turns stay
   * reachable via Doc viewer's pin/cursor matching even though their row
   * isn't rendered here. */
  get olderTurnsHiddenVisibility(): "visible" | "collapse" {
    return this._transcript.length > RICH_VIEW_MAX_ROWS ? "visible" : "collapse";
  }

  get olderTurnsHiddenMessage(): string {
    const hidden = this._transcript.length - RICH_VIEW_MAX_ROWS;
    return hidden > 0 ? `${hidden} earlier turn${hidden === 1 ? "" : "s"} not shown here` : "";
  }

  get feedEmptyVisibility(): "visible" | "collapse" {
    return this._transcript.length === 0 ? "visible" : "collapse";
  }

  get feedEmptyMessage(): string {
    if (this._transcriptError && this._transcript.length === 0) return this._transcriptError;
    if (this._state.status) return this._state.status;
    if (!this._state.open) return "Ghost is not open on the glasses.";
    return "Nothing in the transcript yet.";
  }

  // ── Terminal (unchanged — still the glasses' own digest, undigested) ───

  /**
   * The digest feed, undigested. Deliberately verbose — this pane exists for
   * the moment the Rich view looks wrong and the question is what actually
   * arrived on the LENS specifically, so it prints the digest's own fields
   * (uuid, kind, role, the approval options) rather than the full
   * transcript Rich view now shows. Left untouched by round 4 on purpose:
   * the instruction scoped the new transcript data path to Rich view and
   * Doc viewer, and this pane's whole reason to exist is showing the
   * glasses' own, smaller payload — widening it to the full transcript would
   * make it a second Rich view, not a diagnostic tool.
   */
  get terminalText(): string {
    const lines: string[] = [];
    lines.push(`host    ${ghostHostSetting.get()}`);
    lines.push(`session ${this.sessionLabel}`);
    lines.push(`feed    ${this._state.items.length} item(s)${this._state.status ? ` · ${this._state.status}` : " · ok"}`);
    lines.push("");
    for (const [index, item] of this._state.items.entries()) {
      const marker = index === this._state.cursor ? ">" : " ";
      const tags = [item.role, item.kind].filter(Boolean).join(" ");
      lines.push(`${marker} [${index}] ${tags || "turn"}  ${item.uuid ?? ""}`);
      lines.push(`    ${item.headline ?? ""}`);
      for (const line of item.body ?? []) lines.push(`      ${line}`);
      for (const option of item.options ?? []) lines.push(`      (${option.n}) ${option.label}`);
    }
    if (!this._state.items.length) lines.push("(empty)");
    return lines.join("\n");
  }

  // ── Doc viewer (round 4: a real file reference, or the turn's own text) ─

  /** The transcript turn the Doc pane is on: the pinned one, else whatever
   * the lens's cursor points at, else the newest turn. */
  private currentDocTurn(): GhostTurn | null {
    const turns = this._transcript;
    if (this._pinnedUuid) {
      const pinned = turns.find((t) => t.uuid === this._pinnedUuid);
      if (pinned) return pinned;
    }
    const cursorUuid = this.cursorTurnUuid();
    if (cursorUuid) {
      const atCursor = turns.find((t) => t.uuid === cursorUuid);
      if (atCursor) return atCursor;
    }
    return turns.length ? turns[turns.length - 1] : null;
  }

  /** The one thing glanceHeadline() (below, for the cover glance) needs: the
   * digest item the lens is currently on. Kept separate from
   * currentDocTurn() above — the cover glance must stay cheap and
   * synchronous, with no dependency on the transcript poll having run yet. */
  private currentGlanceItem(): GhostItem | null {
    const items = this._state.items;
    if (this._state.cursor >= 0 && this._state.cursor < items.length) {
      return items[this._state.cursor];
    }
    return items.length ? items[items.length - 1] : null;
  }

  /** The current doc turn's resolved file reference, if any — null while the
   * manifest hasn't loaded, or when nothing in the turn's text resolves. */
  private currentFileRef(): string | null {
    const turn = this.currentDocTurn();
    if (!turn) return null;
    return findFileReference(turn.text, this._fileList, this._fileBaseIndex);
  }

  get docTitle(): string {
    const fileRef = this.currentFileRef();
    if (fileRef) return fileRef;
    const turn = this.currentDocTurn();
    if (!turn) return "Nothing open";
    const { headline } = splitHeadlineBody(stripGlassesBlock(turn.text));
    return headline || turnWhoLabel(turn);
  }

  private get docSubtitle(): string {
    if (this._docFileError) return this._docFileError;
    const fileRef = this.currentFileRef();
    if (fileRef) return this._pinnedUuid ? `pinned · file: ${fileRef}` : `following the glasses · file: ${fileRef}`;
    const turn = this.currentDocTurn();
    if (!turn) return "a turn opens here, or the file it references";
    return this._pinnedUuid ? "pinned · tap ✕ to follow the glasses again" : "following the glasses";
  }

  get docText(): string {
    const fileRef = this.currentFileRef();
    if (fileRef) {
      if (this._docFileLoading) return `Loading ${fileRef}…`;
      if (this._docFileError) return this._docFileError;
      if (this._docFileText) return this._docFileText;
    }
    const turn = this.currentDocTurn();
    if (!turn) return "A turn's full text opens here — or the real file it references, if it names one. Tap a row in Rich view.";
    const stripped = stripGlassesBlock(turn.text).trim();
    return stripped || turn.text;
  }

  /**
   * The doc pane's real content, as RENDERED MARKDOWN rather than the raw
   * source (Chris, 2026-09-03: autolinking opened `knowledge/current-state.md`
   * in this pane correctly and then "renders as raw unformatted text").
   *
   * Same fix cc-web's pinned-preview pane got in session 0144, in the form a
   * native pane can take: cc-web pipes the text through marked + DOMPurify
   * into a DOM, and there is no DOM here, so markdown-render.ts parses to
   * blocks and inline runs and this turns each block into one styled Label.
   * See that file's header for why the HTML pipeline is not portable.
   *
   * A file that is not markdown (a log, a JSON dump, source code) renders as
   * one preformatted block instead — joining ITS lines into paragraphs is the
   * one thing that would make it less readable than the raw text it replaces.
   */
  get docBlocks(): DocBlockRow[] {
    const text = this.docText;
    if (text !== this._docBlocksSource) {
      this._docBlocksSource = text;
      this._docBlocksCache = this.buildDocBlocks(text);
    }
    return this._docBlocksCache;
  }

  /**
   * Cached on the source text, and re-notified only when that text actually
   * changes. The transcript poll calls notifyDocChange() every 3 seconds; a
   * Repeater rebuild on every one of those would re-parse the whole file, throw
   * away and recreate hundreds of native Labels, and lose the reader's scroll
   * position in a document he is in the middle of.
   */
  private buildDocBlocks(text: string): DocBlockRow[] {
    const fileRef = this.currentFileRef();
    // THE PREFORMATTED FALLBACK IS FOR FILES ONLY. Caught on the phone before
    // this shipped: a turn's own prose has no markdown markers in it, so the
    // content check alone sent every ordinary Ghost reply down the
    // not-markdown path and rendered it in a monospace code box. A turn is
    // always prose — parse it. Only a fetched FILE that is genuinely not
    // markdown (a log, a JSON dump, source) wants its line breaks preserved
    // verbatim instead of being joined into paragraphs.
    const showingFile =
      !!fileRef && !!this._docFileText && !this._docFileLoading && !this._docFileError;
    const blocks =
      !showingFile || looksLikeMarkdown(text, fileRef ?? undefined)
        ? parseMarkdownBlocks(text)
        : preformattedBlocks(text);
    const shown = blocks.slice(0, DOC_MAX_BLOCKS);
    if (blocks.length > shown.length) {
      const notice = `[${blocks.length - shown.length} more blocks not shown]`;
      shown.push({ kind: "p", text: notice, spans: [{ text: notice, italic: true }], depth: 0 });
    }
    return shown.map((block) => docBlockRow(block));
  }

  get docUnpinVisibility(): "visible" | "collapse" {
    return this._pinnedUuid ? "visible" : "collapse";
  }

  onDocUnpinTap(): void {
    this._pinnedUuid = null;
    this.notifyDocChange();
    this.loadDocFileIfNeeded();
  }

  private openDocFor(index: number): void {
    const turn = this._transcript[index];
    if (!turn) return;
    this._pinnedUuid = turn.uuid ?? null;
    this.setPane(2);
    this.notifyDocChange();
    this.loadDocFileIfNeeded();
  }

  /**
   * Fetch the referenced file's real content, once per resolved path, and
   * only while the Doc pane is actually showing — this is a network call,
   * and Rich view is where the session normally sits. Clears the file state
   * (falling back to the turn's own text) the moment the current turn no
   * longer references a file, e.g. the lens moved on to an ordinary reply.
   */
  private loadDocFileIfNeeded(): void {
    if (this.paneId !== "doc") return;
    const fileRef = this.currentFileRef();
    if (!fileRef) {
      if (this._docFileRef !== null) {
        this._docFileRef = null;
        this._docFileText = "";
        this._docFileError = "";
        this.notifyDocChange();
      }
      return;
    }
    if (this._docFileRef === fileRef || this._docFileLoading) return;
    if (!isTextRenderableReference(fileRef)) {
      this._docFileRef = fileRef;
      this._docFileText = `[${fileRef} isn't a text file this pane can render yet — open it on the box to view it.]`;
      this._docFileError = "";
      this.notifyDocChange();
      return;
    }
    const sessionId = this._state.sessionId;
    if (!sessionId) return;
    this._docFileRef = fileRef;
    this._docFileLoading = true;
    this._docFileError = "";
    this.notifyDocChange();
    fetchFileText(sessionId, fileRef)
      .then((text) => {
        if (this._docFileRef !== fileRef) return; // moved on while in flight
        // A generous but real cap: this is a phone Label, not a code editor.
        const MAX = 20000;
        this._docFileText = text.length > MAX ? `${text.slice(0, MAX)}\n\n[truncated — ${text.length} chars total]` : text;
        this._docFileLoading = false;
        this.notifyDocChange();
      })
      .catch((error) => {
        if (this._docFileRef !== fileRef) return;
        this._docFileLoading = false;
        this._docFileError = `Could not load ${fileRef}: ${formatErrorMessage(error, 120)}`;
        this.notifyDocChange();
      });
  }

  private notifyDocChange(): void {
    this.notifyPropertyChange("docTitle", this.docTitle);
    this.notifyPropertyChange("docText", this.docText);
    // Only when the text really changed — see buildDocBlocks().
    const before = this._docBlocksCache;
    if (this.docBlocks !== before) this.notifyPropertyChange("docBlocks", this._docBlocksCache);
    this.notifyPropertyChange("docUnpinVisibility", this.docUnpinVisibility);
    this.notifyPropertyChange("paneStatus", this.paneStatus);
    this.notifyPropertyChange("paneStatusVisibility", this.paneStatusVisibility);
  }

  // ── Settings ────────────────────────────────────────────────────────────

  get ghostHost(): string {
    return ghostHostSetting.get();
  }

  set ghostHost(value: string) {
    if (ghostHostSetting.get() === value) return;
    ghostHostSetting.set(value ?? "");
    this.notifyPropertyChange("ghostHost", this.ghostHost);
  }

  get ghostToken(): string {
    return ghostTokenSetting.get();
  }

  set ghostToken(value: string) {
    if (ghostTokenSetting.get() === value) return;
    ghostTokenSetting.set(value ?? "");
    this.notifyPropertyChange("ghostToken", this.ghostToken);
  }

  get ghostSession(): string {
    return ghostSessionSetting.get();
  }

  set ghostSession(value: string) {
    if (ghostSessionSetting.get() === value) return;
    ghostSessionSetting.set(value ?? "");
    // Typing a session by hand is a force-select, exactly as it is from the
    // glasses menu: it must stick, so auto-follow goes off rather than the
    // next poll overwriting it.
    ghostAutoFollowSetting.set(false);
    this.notifyPropertyChange("ghostSession", this.ghostSession);
    this.notifyPropertyChange("autoFollow", this.autoFollow);
  }

  get autoFollow(): boolean {
    return ghostAutoFollowSetting.get();
  }

  onAutoFollowChange(args: { value?: boolean; object?: { checked?: boolean } }): void {
    const on = typeof args?.value === "boolean" ? args.value : Boolean(args?.object?.checked);
    if (ghostAutoFollowSetting.get() !== on) ghostAutoFollowSetting.set(on);
    this.notifyPropertyChange("autoFollow", this.autoFollow);
  }

  get speakReplies(): boolean {
    return ghostSpeakSetting.get();
  }

  onSpeakChange(args: { value?: boolean; object?: { checked?: boolean } }): void {
    const on = typeof args?.value === "boolean" ? args.value : Boolean(args?.object?.checked);
    if (ghostSpeakSetting.get() !== on) ghostSpeakSetting.set(on);
    this.notifyPropertyChange("speakReplies", this.speakReplies);
  }

  // ── Compose ─────────────────────────────────────────────────────────────

  get composeText(): string {
    return this._composeText;
  }

  set composeText(value: string) {
    const next = value ?? "";
    if (this._composeText === next) return;
    this._composeText = next;
    this.notifyPropertyChange("composeText", next);
    this.notifyPropertyChange("sendEnabled", this.sendEnabled);
  }

  get sendEnabled(): boolean {
    return !this._sending && this._composeText.trim().length > 0 && !!this._state.sessionId;
  }

  get composeStatus(): string {
    return this._composeStatus;
  }

  get composeStatusVisibility(): "visible" | "collapse" {
    return this._composeStatus ? "visible" : "collapse";
  }

  onSendTap(): void {
    const text = this._composeText.trim();
    const sessionId = this._state.sessionId;
    if (!text || !sessionId || this._sending) return;
    this._sending = true;
    this.setComposeStatus("Sending…");
    this.notifyPropertyChange("sendEnabled", this.sendEnabled);
    void sendInput(sessionId, text)
      .then((ok) => {
        this._sending = false;
        if (ok) {
          this.composeText = "";
          // The reply lands in the feed on the next poll (3s), on both the
          // lens and here; land the user in the view where it will appear.
          this.setPane(1);
          this.setComposeStatus("");
        } else {
          this.setComposeStatus("The box did not take that — check the session and token.");
        }
        this.notifyPropertyChange("sendEnabled", this.sendEnabled);
      })
      .catch((error) => {
        this._sending = false;
        this.setComposeStatus(formatErrorMessage(error, 160));
        this.notifyPropertyChange("sendEnabled", this.sendEnabled);
      });
  }

  private setComposeStatus(value: string): void {
    this._composeStatus = value;
    this.notifyPropertyChange("composeStatus", value);
    this.notifyPropertyChange("composeStatusVisibility", this.composeStatusVisibility);
  }

  // ── Feed changes ────────────────────────────────────────────────────────

  /** Digest-store changes: cursor moved, status changed, session/open
   * flipped. Re-renders everything that depends on _state (cursor highlight,
   * doc pane's "which turn"), independent of whether the transcript poll has
   * fired again. */
  private refreshFeed(): void {
    this.notifyPropertyChange("turns", this.turns);
    this.notifyPropertyChange("terminalText", this.terminalText);
    this.notifyPropertyChange("feedEmptyVisibility", this.feedEmptyVisibility);
    this.notifyPropertyChange("feedEmptyMessage", this.feedEmptyMessage);
    this.notifyPropertyChange("paneStatus", this.paneStatus);
    this.notifyPropertyChange("paneStatusVisibility", this.paneStatusVisibility);
    this.notifyPropertyChange("sendEnabled", this.sendEnabled);
    this.notifyPropertyChange("ghostSession", this.ghostSession);
    this.notifyPropertyChange("autoFollow", this.autoFollow);
    this.notifyDocChange();
    this.loadDocFileIfNeeded();
  }

  /** Transcript poll changes: same set, plus this is the one that actually
   * changes `turns`' content (not just which row is highlighted). */
  private refreshTranscriptViews(): void {
    this.notifyPropertyChange("turns", this.turns);
    this.notifyPropertyChange("olderTurnsHiddenVisibility", this.olderTurnsHiddenVisibility);
    this.notifyPropertyChange("olderTurnsHiddenMessage", this.olderTurnsHiddenMessage);
    this.notifyPropertyChange("feedEmptyVisibility", this.feedEmptyVisibility);
    this.notifyPropertyChange("feedEmptyMessage", this.feedEmptyMessage);
    this.notifyPropertyChange("paneStatus", this.paneStatus);
    this.notifyPropertyChange("paneStatusVisibility", this.paneStatusVisibility);
    this.notifyDocChange();
    this.loadDocFileIfNeeded();
    // New turns just landed; follow them down if the reader is already there.
    this.scrollRichToBottom(false);
  }

  /** One line for the cover screen: what Ghost has on the lens right now.
   * Digest-based, deliberately — see currentGlanceItem()'s own comment. */
  glanceHeadline(): string {
    if (this._state.status) return this._state.status;
    const item = this.currentGlanceItem();
    return item ? `${glanceWhoLabel(item)}: ${item.headline}` : "Nothing in the feed yet.";
  }
}

function glanceWhoLabel(item: GhostItem): string {
  if (item.kind === "approval") return "Approval";
  return item.role === "user" ? "Chris" : "Ghost";
}
