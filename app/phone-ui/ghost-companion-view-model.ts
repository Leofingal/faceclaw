/**
 * Ghost's phone-side companion: the four-pane carousel from the design pilot
 * (Terminal · Rich view · Doc viewer · Settings) with the compose box docked
 * below the three content panes.
 *
 * It is a VIEW OF THE GLASSES' OWN SESSION. Everything it shows comes from
 * ghost-companion-store, which GhostLayer fills from the poll it is already
 * running; nothing here opens a second connection to the box. The one thing
 * this screen does that the lens cannot is write — a paragraph typed with two
 * thumbs, instead of dictated a sentence at a time through the ring.
 *
 * Where the pilot's four panes landed on what Ghost actually has:
 *
 *   Rich view   the feed, headline + body, exactly the items the lens pages
 *               through, with the lens's own cursor marked. The default pane.
 *   Terminal    the same feed UNDIGESTED — every field of every item in a
 *               monospace dump, plus the poll diagnostics. It is not a live
 *               PTY: the glasses client talks to /api/glasses, which serves
 *               the digested feed and nothing else, so a real terminal would
 *               need a new route on the box. Named for what it is on screen.
 *   Doc viewer  the full prose behind one turn, from /api/glasses/:id/prose/
 *               :uuid — the tier-3 fetch the lens offers on demand. Tapping a
 *               row in Rich view opens it here.
 *   Settings    Ghost's real settings (host, token, session, auto-follow,
 *               speak), the same ConfigSetting objects the glasses menu edits.
 */
import { Observable } from "@nativescript/core";
import {
  fetchProse,
  ghostAutoFollowSetting,
  ghostHostSetting,
  ghostSessionSetting,
  ghostSpeakSetting,
  ghostTokenSetting,
  sendInput,
  type GhostItem,
} from "../apps/ghost/ghost-client";
import {
  ghostCompanionState,
  onGhostCompanionChanged,
  type GhostCompanionState,
} from "../apps/ghost/ghost-companion-store";
import { formatErrorMessage } from "../util/format-error";

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

/** One row of the Rich view. */
export type GhostTurnRow = {
  who: string;
  headline: string;
  body: string;
  bodyVisibility: "visible" | "collapse";
  /** Marks the item the lens has under its cursor right now. */
  rowClass: string;
  index: number;
  onRowTap: () => void;
};

export class GhostCompanionViewModel extends Observable {
  private _paneIndex = DEFAULT_PANE_INDEX;
  private _state: GhostCompanionState = ghostCompanionState();
  private _composeText = "";
  private _sending = false;
  private _composeStatus = "";

  /**
   * Which item the Doc viewer is on. Null means "follow the lens" — the doc
   * pane then shows whatever the glasses are showing, which is what you want
   * when you unfold the phone mid-session. Tapping a row pins it instead.
   */
  private _pinnedUuid: string | null = null;
  private _docText = "";
  private _docUuid: string | null = null;
  private _docLoading = false;
  private _docError = "";

  private unsubscribe: (() => void) | null = null;

  attach(): void {
    if (this.unsubscribe) return;
    this._state = ghostCompanionState();
    this.unsubscribe = onGhostCompanionChanged((state) => {
      this._state = state;
      this.refreshFeed();
    });
    this.refreshFeed();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ── Panes ───────────────────────────────────────────────────────────────

  private get paneId(): PaneId {
    return PANES[this._paneIndex] ?? "rich";
  }

  get paneName(): string {
    return PANE_NAMES[this.paneId];
  }

  /** The one line under the title: what this pane is showing, or why it isn't. */
  get paneStatus(): string {
    if (this._state.status) return this._state.status;
    switch (this.paneId) {
      case "rich":
        return `${this._state.items.length} in the feed · session ${this.sessionLabel}`;
      case "terminal":
        return `raw feed · session ${this.sessionLabel}`;
      case "doc":
        return this._docLoading ? "loading the full reply…" : this.docSubtitle;
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
    if (this.paneId === "doc") this.loadDocIfNeeded();
  }

  private notifyPaneChange(): void {
    this.notifyPropertyChange("paneName", this.paneName);
    this.notifyPropertyChange("paneStatus", this.paneStatus);
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

  // ── Rich view ───────────────────────────────────────────────────────────

  get turns(): GhostTurnRow[] {
    return this._state.items.map((item, index) => ({
      who: whoLabel(item),
      headline: item.headline ?? "",
      body: (item.body ?? []).join("\n"),
      bodyVisibility: (item.body ?? []).length > 0 ? "visible" : "collapse",
      rowClass: index === this._state.cursor ? "ghost-turn ghost-turn-current" : "ghost-turn",
      index,
      onRowTap: () => this.openDocFor(index),
    }));
  }

  get feedEmptyVisibility(): "visible" | "collapse" {
    return this._state.items.length === 0 ? "visible" : "collapse";
  }

  get feedEmptyMessage(): string {
    if (this._state.status) return this._state.status;
    if (!this._state.open) return "Ghost is not open on the glasses.";
    return "Nothing in the feed yet.";
  }

  // ── Terminal ────────────────────────────────────────────────────────────

  /**
   * The undigested feed. Deliberately verbose — this pane exists for the
   * moment the Rich view looks wrong and the question is what actually
   * arrived, so it prints the fields the digest drops (uuid, kind, role, the
   * approval options) rather than a prettier version of the same thing.
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

  // ── Doc viewer ──────────────────────────────────────────────────────────

  /** The item the doc pane is on: the pinned one, else whatever the lens shows. */
  private currentDocItem(): GhostItem | null {
    const items = this._state.items;
    if (this._pinnedUuid) {
      const pinned = items.find((item) => item.uuid === this._pinnedUuid);
      if (pinned) return pinned;
    }
    if (this._state.cursor >= 0 && this._state.cursor < items.length) {
      return items[this._state.cursor];
    }
    return items.length ? items[items.length - 1] : null;
  }

  get docTitle(): string {
    const item = this.currentDocItem();
    return item ? item.headline : "Nothing open";
  }

  private get docSubtitle(): string {
    if (this._docError) return this._docError;
    const item = this.currentDocItem();
    if (!item) return "a turn's full text opens here";
    return this._pinnedUuid ? "pinned · tap ✕ to follow the glasses again" : "following the glasses";
  }

  get docText(): string {
    if (this._docLoading) return "Loading…";
    if (this._docError) return this._docError;
    if (this._docText) return this._docText;
    const item = this.currentDocItem();
    if (!item) return "A turn's full text opens here. Tap a row in Rich view.";
    // The digested body is a real, useful fallback: the tier-3 prose only
    // exists for turns Ghost wrote above a <glasses> block.
    return (item.body ?? []).join("\n") || item.headline;
  }

  get docUnpinVisibility(): "visible" | "collapse" {
    return this._pinnedUuid ? "visible" : "collapse";
  }

  onDocUnpinTap(): void {
    this._pinnedUuid = null;
    this._docText = "";
    this._docUuid = null;
    this._docError = "";
    this.notifyDocChange();
    this.loadDocIfNeeded();
  }

  private openDocFor(index: number): void {
    const item = this._state.items[index];
    if (!item) return;
    this._pinnedUuid = item.uuid ?? null;
    this._docText = "";
    this._docUuid = null;
    this._docError = "";
    this.setPane(2);
    this.notifyDocChange();
    this.loadDocIfNeeded();
  }

  /**
   * Fetch the full prose for the doc pane's item, once per uuid. Only while
   * the pane is actually showing: this is a network call, and Rich view is
   * where the session normally sits.
   */
  private loadDocIfNeeded(): void {
    if (this.paneId !== "doc") return;
    const item = this.currentDocItem();
    const sessionId = this._state.sessionId;
    if (!item || !item.uuid || !sessionId) return;
    if (this._docUuid === item.uuid || this._docLoading) return;
    this._docUuid = item.uuid;
    this._docLoading = true;
    this._docError = "";
    this.notifyDocChange();
    const requestedUuid = item.uuid;
    fetchProse(sessionId, requestedUuid)
      .then((prose) => {
        // The pane may have moved on while the request was in flight.
        if (this._docUuid !== requestedUuid) return;
        this._docText = prose.join("\n");
        this._docLoading = false;
        this.notifyDocChange();
      })
      .catch((error) => {
        if (this._docUuid !== requestedUuid) return;
        this._docLoading = false;
        // Not a failure worth shouting about: most turns have no tier-3 prose,
        // and the digested body below is still the real content.
        this._docError = "";
        this._docText = "";
        console.warn(`ghost prose fetch failed: ${formatErrorMessage(error, 200)}`);
        this.notifyDocChange();
      });
  }

  private notifyDocChange(): void {
    this.notifyPropertyChange("docTitle", this.docTitle);
    this.notifyPropertyChange("docText", this.docText);
    this.notifyPropertyChange("docUnpinVisibility", this.docUnpinVisibility);
    this.notifyPropertyChange("paneStatus", this.paneStatus);
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

  private refreshFeed(): void {
    this.notifyPropertyChange("turns", this.turns);
    this.notifyPropertyChange("terminalText", this.terminalText);
    this.notifyPropertyChange("feedEmptyVisibility", this.feedEmptyVisibility);
    this.notifyPropertyChange("feedEmptyMessage", this.feedEmptyMessage);
    this.notifyPropertyChange("paneStatus", this.paneStatus);
    this.notifyPropertyChange("sendEnabled", this.sendEnabled);
    this.notifyPropertyChange("ghostSession", this.ghostSession);
    this.notifyPropertyChange("autoFollow", this.autoFollow);
    this.notifyDocChange();
    this.loadDocIfNeeded();
  }

  /** One line for the cover screen: what Ghost has on the lens right now. */
  glanceHeadline(): string {
    if (this._state.status) return this._state.status;
    const item = this.currentDocItem();
    return item ? `${whoLabel(item)}: ${item.headline}` : "Nothing in the feed yet.";
  }
}

function whoLabel(item: GhostItem): string {
  if (item.kind === "approval") return "Approval";
  return item.role === "user" ? "Chris" : "Ghost";
}
