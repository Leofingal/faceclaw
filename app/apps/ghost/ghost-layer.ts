/**
 * Ghost on the glasses: a pager onto the one session the box already hosts.
 *
 * This is a FACE, not a Ghost. It holds no conversation and runs no model. It
 * polls a digested feed, puts a headline on the glass, and sends dictation
 * back — the smallest possible client of a session every other device is also
 * a client of.
 *
 * Ported from the EvenHub build (TheLimitCase apps/ghost/src/main.ts, 2450
 * lines). What survives is the interaction design, which was worked out over
 * a dozen sessions on real hardware; what does not is the whole EvenHub bridge
 * — storage, gestures, page containers, PCM capture and audio all reach real
 * faceclaw APIs here instead.
 *
 * ── The gesture vocabulary, and why it is the way it is ────────────────────
 *
 *   scroll   pages the feed; one step below the newest item is the reply slot
 *   click    expands, descends, commits
 *   d-click  goes UP one layer; at the top it hands focus to the sidebar
 *   l-press  the window menu (owned by the window, never seen here)
 *
 * ARRIVING IS THE INTENT (Chris, session 0112). Scrolling onto the reply slot
 * already means "I want to say something", so charging a further tap for it
 * spends the device's least reliable gesture on a decision that has been made.
 * The slot starts listening on arrival; tap is the committing gesture, and it
 * has exactly one meaning there.
 */
import { GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import {
  gestureHints,
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
  GESTURE_SCROLL_DOWN,
  GESTURE_SCROLL_UP,
} from "../../ui/gestures";
import { drawSelectionHighlight } from "../../ui/menu";
import { LIST_ROW_TEXT_INSET, lineStep, listRowHeight } from "../../ui/metrics";
import { type Layer, type LayerActions, type LayerContext } from "../../ui/layers";
import { type InputEvent } from "../../ui/gestures";
import { shell } from "../../ui/shell/shell";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { clamp } from "../../util/numeric-util";
import {
  fetchActiveSessionId,
  fetchFeed,
  fetchProse,
  ghostAuthHeaders,
  ghostAutoFollowSetting,
  ghostSessionId,
  ghostSessionSetting,
  ghostSpeakSetting,
  sendApproval,
  sendInput,
  ttsUrl,
  type GhostItem,
} from "./ghost-client";
import { speakGhost, stopGhostSpeech } from "./ghost-speech";

const PAGE_X = 20;
const TITLE_Y = 10;
const ROW_X = 12;
const FEED_LIMIT = 20;

/**
 * How long to wait for the final transcript after the mic is committed before
 * calling it a failure. Cloud STT commits in ~2-4s measured; anything past
 * this is a dead request, and a screen that says "Sending…" forever is
 * indistinguishable from a hang.
 */
const TRANSCRIPT_TIMEOUT_MS = 20_000;

/**
 * A slow-rotating glyph, evaluated fresh at paint time rather than driven by
 * its own timer. Chris, 2026-09-01: wanted this — until now only shown while
 * actively dictating (paintMic, below) — on the ordinary feed screen's meta
 * line too, "a low bandwidth still alive heartbeat": proof the render loop is
 * genuinely ticking even when nothing in the feed has changed, distinct from
 * a real hang. It only visibly advances as often as something actually
 * repaints the meta line (every poll on the feed screen, every ~250ms in the
 * mic screen), which is the honest signal - a faked independent clock here
 * would tick even if the poll loop had actually died.
 */
function heartbeatChar(): string {
  return "|/-\\"[Math.floor(Date.now() / 250) % 4]!;
}

export type GhostMicState =
  | "idle"
  | "listening"
  | "sending"
  | "confirming"
  | "failed";

export class GhostLayer implements Layer {
  /** Rebound by the window factory once the window exists. */
  requestRender: () => void = () => {};

  // -- the feed -------------------------------------------------------------
  private items: GhostItem[] = [];
  private cursor = -1;
  private expanded = false;
  /** Newest arrival takes the screen unless Chris has paged back. */
  private follow = true;
  private status = "Ghost — connecting...";
  private bodyScroll = 0;
  /** Set during paint: how many body lines did not fit. Drives scroll-past-end. */
  private bodyOverflow = 0;

  // -- speech ---------------------------------------------------------------
  /**
   * "Mark as read, never re-read it" (Chris, session 0135). Every spoken line
   * is a live, billed request, so an item already heard is shown rather than
   * re-spoken. `expanded` resets on every navigation away, so without these
   * two sets, backing out and tapping back in re-reads the same body.
   */
  private lastSpokenUuid: string | null = null;
  /**
   * A prompt/waiting item is synthetic and ephemeral — derived from live
   * screen state, not a transcript turn. It rides at the end of the feed like
   * a real message, so tracking it in lastSpokenUuid meant that once it
   * vanished, the real last message read as unheard and got re-announced.
   */
  private lastSpokenEphemeralUuid: string | null = null;
  private readonly spokenBodies = new Set<string>();

  // -- tier 3: the full prose reply, on demand ------------------------------
  private proseOpen = false;
  private proseUuid: string | null = null;
  private proseLines: string[] | null = null;
  private proseLoading = false;
  private proseError: string | null = null;

  // -- approval mode --------------------------------------------------------
  private inApproval = false;
  private approvalItem: GhostItem | null = null;
  private approvalIdx = 0;

  // -- dictation ------------------------------------------------------------
  private micState: GhostMicState = "idle";
  private heard = "";
  private interim = "";
  private micStatus = "";
  /** True while this layer is the holder of the shared voice capture. */
  private capturing = false;
  /** The untouched first transcript, kept so a bad merge stays checkable. */
  private pendingRaw = "";
  /** This capture is an ADDITION to text already on the confirm screen. */
  private addingToRaw = false;
  /**
   * Every utterance captured for the message in progress, in order. Chris,
   * 2026-09-02: refining twice in a row produced "Send 1: Send 1: ..." with
   * TWO "Send 2 (addendum):" lines - a real bug, not a garbled dictation.
   * The old design stored only the two most recent PARTS as a single
   * already-labeled STRING (refineBase), so a second refine wrapped
   * (base = the first refine's own labeled output) in a fresh label pair
   * instead of extending the original list. Keeping the raw parts here and
   * rendering labels fresh each time (renderCaptured()) is what lets a
   * third, fourth, etc. refine number correctly instead of nesting.
   */
  private capturedParts: string[] = [];
  private refineOk = true;
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;

  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private closed = false;

  constructor(private readonly actions: LayerActions) {
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => this.onTranscript(event));
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      if (!this.capturing) return;
      this.micStatus = state.status;
      this.requestRender();
    });
  }

  onRemoved(): void {
    this.closed = true;
    this.abortCapture();
    stopGhostSpeech();
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = null;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  /**
   * What the phone's companion screen shows: the feed, where the lens cursor
   * is, and the failure sentence when there is one.
   *
   * A read-only projection of state this layer already holds, published by the
   * window factory on every render — the phone is a second view of this
   * session, never a second client of it. The reply slot (cursor ===
   * items.length) is reported as "no item selected" rather than as an index
   * the phone would have to know is special.
   */
  companionState(): { items: GhostItem[]; cursor: number; status: string; sessionId: string } {
    const onFeedItem = this.cursor >= 0 && this.cursor < this.items.length;
    return {
      items: this.items,
      cursor: onFeedItem ? this.cursor : -1,
      status: this.status,
      sessionId: ghostSessionId(),
    };
  }

  // =========================================================================
  // Cursor geometry
  //
  // The reply slot sits one step past the newest item, so it is always exactly
  // one scroll-down from wherever the feed has settled. That is what buys
  // dictation without spending a gesture on it.

  private micIndex(): number {
    return this.items.length;
  }

  private onMic(): boolean {
    return !this.inApproval && this.cursor === this.micIndex();
  }

  private approvalOptions(): { n: number; label: string }[] {
    return this.approvalItem?.options ?? [];
  }

  private onApprovalMic(): boolean {
    return this.inApproval && this.approvalIdx >= this.approvalOptions().length;
  }

  /**
   * Is a mic screen ACTUALLY on the glass? Two surfaces render one, and only
   * one of them is onMic() — the approval's freeform slot does not move
   * `cursor` at all. Asking the wrong one here is a real bug the EvenHub build
   * shipped for a session: every dictation from an approval was discarded on
   * arrival because the guard tested onMic() and was always false there.
   */
  private onMicSurface(): boolean {
    return this.onMic() || this.onApprovalMic();
  }

  private feedSlot(): number {
    return Math.max(0, this.items.length - 1);
  }

  private currentItem(): GhostItem | null {
    if (this.onMic()) return null;
    return this.cursor >= 0 && this.cursor < this.items.length ? this.items[this.cursor]! : null;
  }

  // =========================================================================
  // Painting

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    if (this.onApprovalMic()) {
      this.paintMic(image, width, height);
    } else if (this.inApproval && this.approvalItem) {
      this.paintApproval(image, this.approvalItem, ctx.stack.isFocused(), width, height);
    } else if (this.onMic()) {
      this.paintMic(image, width, height);
    } else {
      const item = this.currentItem();
      if (!item) {
        this.paintPage(image, width, height, { meta: "ghost", headline: this.status, body: [] });
      } else if (this.proseOpen) {
        this.paintProse(image, item, width, height);
      } else {
        this.paintFeedItem(image, item, width, height);
      }
    }
    return image;
  }

  /**
   * The one page painter every screen goes through: a dim meta line, the
   * headline in the medium face, body text beneath it, and a hint line pinned
   * to the bottom. Returns how many body lines did not fit, which is what
   * makes "scroll past the end of the text moves to the next item" possible
   * without the layer having to guess at the viewport.
   */
  private paintPage(
    image: GrayImage,
    width: number,
    height: number,
    opts: { meta: string; metaRight?: string; headline: string; body: string[]; hint?: string; scroll?: number },
  ): number {
    const font = getDefaultSmallFont();
    const headlineFont = getDefaultMediumFont();
    const step = lineStep(font);
    const contentWidth = width - 2 * PAGE_X;

    const rightWidth = opts.metaRight ? font.measureText(opts.metaRight) : 0;
    image.drawText(
      font,
      PAGE_X,
      TITLE_Y,
      truncateText(font, opts.meta, contentWidth - rightWidth - 12),
      150,
    );
    if (opts.metaRight) {
      image.drawText(font, width - PAGE_X - rightWidth, TITLE_Y, opts.metaRight, 140);
    }

    let cursorY = TITLE_Y + font.lineHeight + 10;
    const headlineLines = wrapText(headlineFont, opts.headline, contentWidth).slice(0, 3);
    for (const line of headlineLines) {
      image.drawText(headlineFont, PAGE_X, cursorY, line, 240);
      cursorY += headlineFont.lineHeight + 2;
    }

    // The hint line owns the bottom band; body text stops above it rather than
    // being drawn under it.
    const hintHeight = opts.hint ? step : 0;
    if (opts.hint) {
      image.drawText(font, PAGE_X, height - 4 - font.lineHeight, opts.hint, 110);
    }
    if (!opts.body.length) return 0;

    cursorY += 6;
    const bodyLines: string[] = [];
    for (const paragraph of opts.body) {
      if (!paragraph) {
        bodyLines.push("");
        continue;
      }
      for (const line of wrapText(font, paragraph, contentWidth)) bodyLines.push(line);
    }
    const maxLines = Math.max(0, Math.floor((height - cursorY - hintHeight - 4) / step));
    const overflow = Math.max(0, bodyLines.length - maxLines);
    const scroll = clamp(opts.scroll ?? 0, 0, overflow);
    for (let index = 0; index < Math.min(maxLines, bodyLines.length - scroll); index++) {
      image.drawText(font, PAGE_X, cursorY + index * step, bodyLines[scroll + index]!, 195);
    }
    return overflow;
  }

  private paintFeedItem(image: GrayImage, item: GhostItem, width: number, height: number): void {
    // NO HINT LINE HERE. Chris, 2026-08-31: the caption pinned to the bottom
    // of this screen "renders as a visible green line low in my field of
    // view" and does not earn that. It said the same five words on every
    // item of every session, to someone who has used this app daily for
    // weeks — the gesture reference is still there on demand (the phone's
    // Settings > Interface, and the glasses' own reference row), which is
    // the distinction he drew: an on-demand PAGE yes, a passive caption no.
    //
    // The live-decision screens below (approval, dictation) deliberately KEEP
    // their hints: there the line names the choice being made right now, not
    // a fact about the app. That split is a judgment call, flagged for Chris
    // rather than decided silently — removing those too is a one-line change
    // in each if he wants the bottom band clear on every screen.
    // Chris's own lines are marked with plain ASCII, not a glyph: a structural
    // marker is the one thing that must not become a box on the glass.
    const tag = item.role === "user" ? "You: " : "";
    // A user turn's headline is capped at 3 wrapped lines (paintPage) with no
    // overflow indicator and no scroll - fine for a short message, but Chris,
    // 2026-09-01: "needs to skip straight to full text on my replies", after
    // tapping expanded on a longer one and finding it "just sits there."
    // Root cause: item.body only ever holds text AFTER Chris's first '\n'
    // (server.js's digestUserTurn splits on newlines, not on render width),
    // which is empty for the ordinary single-paragraph dictated message -
    // expanding revealed nothing because there was nothing in body to reveal.
    // The headline itself IS the full text, just cut off at render time. So
    // for a user item, expanding pulls the headline OUT of the capped title
    // slot and into the same scrollable body path the prose view already
    // uses for arbitrary-length content, rather than trying to show body.
    const isUserItem = item.role === "user";
    this.bodyOverflow = this.paintPage(image, width, height, {
      meta: `ghost — ${this.cursor + 1}/${this.items.length}${item.kind ? ` · ${item.kind}` : ""} ${heartbeatChar()}`,
      metaRight: ghostSpeakSetting.get() ? "voice" : "",
      headline: this.expanded && isUserItem ? "You said:" : tag + item.headline,
      body: this.expanded ? (isUserItem ? [item.headline, ...item.body] : item.body) : [],
      scroll: this.bodyScroll,
    });
  }

  private paintProse(image: GrayImage, item: GhostItem, width: number, height: number): void {
    const body = this.proseLoading
      ? ["Loading full reply..."]
      : this.proseError
        ? ["Could not load full reply.", this.proseError]
        : this.proseLines && this.proseLines.length
          ? this.proseLines
          : ["(nothing more in this reply)"];
    this.bodyOverflow = this.paintPage(image, width, height, {
      meta: "ghost — full reply",
      headline: (item.role === "user" ? "You: " : "") + item.headline,
      body,
      // No hint line: this is a reading screen, see paintFeedItem.
      scroll: this.bodyScroll,
    });
  }

  /**
   * A live permission prompt, with the same scroll-and-tap pattern everything
   * else here uses. Scrolling PAST the last option lands on a freeform slot
   * rather than dead-ending — Chris's own requirement: a listed option is
   * never the only way to answer.
   */
  private paintApproval(
    image: GrayImage,
    item: GhostItem,
    focused: boolean,
    width: number,
    height: number,
  ): void {
    const font = getDefaultSmallFont();
    const headlineFont = getDefaultMediumFont();
    const contentWidth = width - 2 * PAGE_X;

    image.drawText(font, PAGE_X, TITLE_Y, "ghost — approval", 150);
    let cursorY = TITLE_Y + font.lineHeight + 8;
    for (const line of wrapText(headlineFont, item.headline, contentWidth).slice(0, 2)) {
      image.drawText(headlineFont, PAGE_X, cursorY, line, 240);
      cursorY += headlineFont.lineHeight + 2;
    }

    const options = this.approvalOptions();
    const rows = [...options.map((option) => `${option.n}. ${option.label}`), "(say your own answer)"];
    const rowH = listRowHeight(font);
    const hintY = height - 4 - font.lineHeight;
    const visibleRows = Math.max(1, Math.floor((hintY - cursorY - 4) / rowH));
    const first = clamp(this.approvalIdx - visibleRows + 1, 0, Math.max(0, rows.length - visibleRows));
    for (let index = first; index < Math.min(rows.length, first + visibleRows); index++) {
      const y = cursorY + (index - first) * rowH;
      const selected = index === this.approvalIdx;
      if (selected) {
        drawSelectionHighlight(image, ROW_X, y, width - 2 * ROW_X, rowH - 2, focused);
      }
      image.drawText(
        font,
        ROW_X + 8,
        y + LIST_ROW_TEXT_INSET,
        truncateText(font, rows[index]!, width - 2 * ROW_X - 16),
        selected ? 235 : 190,
      );
    }
    image.drawText(
      font,
      PAGE_X,
      hintY,
      gestureHints([
        [GESTURE_SCROLL, "move"],
        [GESTURE_CLICK, "select"],
        [GESTURE_DOUBLE_CLICK, "back"],
      ]),
      110,
    );
  }

  private paintMic(image: GrayImage, width: number, height: number): void {
    const spinner = heartbeatChar();
    let headline: string;
    let body: string[] = [];
    let hint = "";
    switch (this.micState) {
      case "listening": {
        // Chris, 2026-09-01: the live word-by-word interim text "was trying to
        // update my screen live as I type" - a repaint on every partial STT
        // chunk, real trouble before too. Screen now stays static through the
        // whole capture; the transcript only ever appears once, on the confirm
        // screen, after a tap ends it. (this.interim is still tracked in
        // onTranscript in case something else ever wants it, just not painted
        // here or used to build the headline.)
        //
        // "Adding" rather than "Listening" when this capture supplements a
        // transcript already waiting on the confirm screen. The two captures
        // are one scroll apart and produce an identical screen otherwise, so
        // the label is the only thing telling Chris whether what he says next
        // is MERGED INTO what he already said or REPLACES it.
        const verb = this.addingToRaw ? "Adding" : "Listening";
        headline = `${verb}...  ${spinner}`;
        body = [this.micStatus || "Speak, then tap to send."];
        hint = gestureHints([[GESTURE_CLICK, "send"]]);
        break;
      }
      case "sending":
        headline = `Sending...  ${spinner}`;
        break;
      case "confirming":
        // Chris's own three options (session 0135): "Send as is, let the agent
        // refine or I resend." Three gestures on a four-gesture device.
        //
        // Chris, 2026-09-01, twice: first found the hint's single undirected
        // glyph genuinely ambiguous between refine and discard (fixed by
        // splitting the two directions out); then, on trying it, said the
        // split itself had refine and cancel backwards — scroll-up already
        // means "abandon" everywhere else in the mic flow (see step()), so it
        // should mean that here too, freeing scroll-down for refine. Two
        // gestures now do the same discard (scroll up, double-click) — both
        // listed rather than picking one, since surfacing both beats
        // assuming he already knows one.
        headline = this.heard;
        hint = `${GESTURE_CLICK} send   ${GESTURE_SCROLL_DOWN} refine   ${GESTURE_SCROLL_UP}${GESTURE_DOUBLE_CLICK} discard`;
        break;
      case "failed":
        headline = "Did not catch that.";
        body = ["Scroll up and back down", "to try again."];
        break;
      default:
        headline = "Scroll down to speak.";
        break;
    }
    this.bodyOverflow = this.paintPage(image, width, height, {
      meta: this.onApprovalMic() ? "ghost — your own answer" : "ghost — reply",
      headline,
      body,
      hint,
      scroll: 0,
    });
  }

  // =========================================================================
  // Input

  async handleInput(event: InputEvent, _ctx: LayerContext): Promise<void> {
    switch (event.type) {
      case "scroll-up":
        this.step(-1);
        return;
      case "scroll-down":
        this.step(1);
        return;
      case "click":
        await this.tap();
        return;
      case "double-click":
        this.back();
        return;
      default:
        return;
    }
  }

  /** Text from the phone keyboard or the shell's voice input: send it as a reply. */
  receiveTextInput(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    void this.commitText(trimmed, trimmed);
  }

  private step(delta: number): void {
    // CANCEL: scroll UP while confirming. Chris, 2026-09-01: this used to be
    // refine, which he flagged as backwards - scroll-up already means
    // "abandon" everywhere else in the mic interaction (it is what the
    // fallthrough below does while actively LISTENING, no special case
    // needed there), so confirming should not be the one place it means
    // something else. Same resetMic() the double-click discard already uses
    // - two gestures, one action, not a new mechanism. Checked above the
    // per-surface routing because it has to mean the same thing on both mic
    // surfaces (see onMicSurface()'s own doc comment on why that matters).
    if (delta < 0 && this.micState === "confirming" && this.onMicSurface()) {
      this.resetMic();
      this.requestRender();
      return;
    }
    if (this.inApproval) {
      this.approvalStep(delta);
      return;
    }
    // REFINE: scroll DOWN while confirming, parked on the reply slot -
    // otherwise an inert repeat of the gesture that opened it, so free real
    // estate. Chris's own reasoning for putting refine here instead of on
    // scroll-up: the old one-gesture "say it again" (full discard + redo) is
    // still reachable, just as a two-step now - scroll up to cancel (above),
    // then down again to arrive fresh on the reply slot, which starts a new
    // capture on its own (ARRIVING IS THE INTENT, this file's own header
    // comment). That freed the single down-gesture for the more differentiated
    // action.
    if (this.onMic() && this.micState === "confirming" && delta > 0) {
      this.startListening(true);
      return;
    }
    // NOTE: there is deliberately no early return for the reply slot here.
    // Scrolling UP off it must fall through to the clamp below, which is what
    // moves back to the newest item and abandons the capture; scrolling DOWN
    // hits the same clamp as a no-op. An early return would strand Chris on
    // the mic slot with no gesture that leaves it.

    // Reading tiers scroll their own text first and only page the feed once
    // there is nothing left to read in that direction. On a 288px lens a full
    // reply does not fit, so without this the tier would be a truncated page
    // with no way to see the rest.
    if ((this.expanded || this.proseOpen) && this.bodyOverflow > 0) {
      const next = clamp(this.bodyScroll + delta, 0, this.bodyOverflow);
      if (next !== this.bodyScroll) {
        this.bodyScroll = next;
        this.requestRender();
        return;
      }
    }

    // Upper bound is micIndex(), not items.length - 1: the mic is a reachable
    // slot one below the newest.
    const was = this.cursor;
    this.cursor = clamp(this.cursor + delta, 0, this.micIndex());
    if (this.cursor === was) return;
    this.follow = this.cursor >= this.items.length - 1;
    this.expanded = false;
    this.proseOpen = false;
    this.bodyScroll = 0;
    // Paging is a new intent; stop talking about the old one.
    stopGhostSpeech();
    if (this.onMic()) this.startListening(false);
    else this.resetMic();
    this.requestRender();
  }

  /**
   * Tap on either mic surface. One re-entry guard covers both ways a duplicate
   * can arrive: a second tap during the transcription wait, and one physical
   * tap delivered as two events by the input layer. Guarding the STATE fixes
   * both at once and does not require the gesture layer to be perfect — the
   * EvenHub build learned this the expensive way, by sending Chris's message
   * into the session twice, identically.
   */
  private async micTap(): Promise<void> {
    if (this.micState === "confirming") {
      await this.confirmSend();
      return;
    }
    if (this.micState === "listening") {
      this.commitCapture();
      return;
    }
    // A transcription is in flight; the tap that would start a fresh capture
    // has to wait for it. (Refine is synchronous now - see refineNow - so
    // there is no separate in-flight state for it to wait on any more.)
    if (this.micState === "sending") return;
    this.startListening(false);
  }

  /** Drop any capture AND the dictation state it left on the glass. */
  private resetMic(): void {
    this.abortCapture();
    this.micState = "idle";
    this.heard = "";
    this.interim = "";
    this.pendingRaw = "";
    this.capturedParts = [];
    this.refineOk = true;
  }

  private async tap(): Promise<void> {
    if (this.inApproval) {
      await this.approvalTap();
      return;
    }
    if (this.onMic()) {
      await this.micTap();
      return;
    }
    const item = this.currentItem();
    if (!item) return;
    if (item.kind === "approval" && item.options?.length) {
      this.openApproval(item);
      return;
    }
    /*
     * Three tiers, one tap each, cycling: headline -> the authored summary ->
     * the full prose reply -> back to the headline. Tap rather than scroll
     * because scroll already means "move to a different item" everywhere else
     * here; extending tap reuses the depth model the app already has.
     */
    if (!this.expanded) {
      this.expanded = true;
      this.bodyScroll = 0;
      if (item.uuid && !this.spokenBodies.has(item.uuid)) {
        this.spokenBodies.add(item.uuid);
        this.speak(item.body.join(" "));
      }
      this.requestRender();
      return;
    }
    if (!this.proseOpen) {
      if (item.role === "user") {
        // Chris, 2026-09-01: digging into one of his own messages hit
        // "Could not load full reply, server said 404." Root cause: tier 2's
        // body above IS already the complete text he typed - nothing was
        // ever summarized, so there is no separate tier-3 prose to fetch.
        // The server's own /api/glasses/:sessionId/prose/:uuid route 404s on
        // a user turn on purpose (see its comment in server.js) - the bug
        // was this client offering the same third tap on an item where it
        // can never succeed. Cycle straight back to the headline instead.
        this.expanded = false;
        this.bodyScroll = 0;
        stopGhostSpeech();
        this.requestRender();
        return;
      }
      await this.openProse(item);
      return;
    }
    this.proseOpen = false;
    this.expanded = false;
    this.bodyScroll = 0;
    stopGhostSpeech();
    this.requestRender();
  }

  /**
   * Double-click means one thing everywhere: go up one layer. At the top of
   * Ghost's own hierarchy there is nothing to ascend to, so it does what every
   * other faceclaw app's root double-click does and hands focus to the
   * sidebar. (This is why the layer is NOT wrapped in YieldAtRootLayer: that
   * wrapper would take the gesture before the inner layers ever saw it.)
   */
  private back(): void {
    if (this.micState === "confirming" && this.onMicSurface()) {
      this.resetMic();
      this.requestRender();
      return;
    }
    if (this.inApproval) {
      this.closeApproval(this.feedSlot());
      return;
    }
    if (this.proseOpen) {
      this.proseOpen = false;
      this.bodyScroll = 0;
      this.requestRender();
      return;
    }
    if (this.expanded) {
      this.expanded = false;
      this.bodyScroll = 0;
      stopGhostSpeech();
      this.requestRender();
      return;
    }
    shell.backOutToHome();
  }

  /** A mirror touch: treated as a plain select, which is what tapping a card means. */
  async hitTest(_x: number, _y: number, _ctx: LayerContext): Promise<boolean> {
    await this.tap();
    return true;
  }

  // =========================================================================
  // Approval mode

  private openApproval(item: GhostItem): void {
    if (!item.options?.length) return;
    stopGhostSpeech();
    this.inApproval = true;
    this.approvalItem = item;
    this.approvalIdx = 0;
    this.requestRender();
  }

  private closeApproval(landCursor: number): void {
    this.resetMic();
    this.inApproval = false;
    this.approvalItem = null;
    this.cursor = clamp(landCursor, 0, this.micIndex());
    this.follow = this.cursor >= this.items.length - 1;
    this.expanded = false;
    this.proseOpen = false;
    this.bodyScroll = 0;
    this.requestRender();
  }

  /**
   * Scrolling UP off the top backs out to the feed. Scrolling DOWN past the
   * last option arrives on the freeform slot and — same rule as the feed's own
   * reply slot — arriving there IS the intent to speak.
   */
  private approvalStep(delta: number): void {
    const max = this.approvalOptions().length;
    const next = this.approvalIdx + delta;
    if (next < 0) {
      this.closeApproval(this.feedSlot());
      return;
    }
    if (next > max) return;
    if (next === this.approvalIdx) return;
    this.approvalIdx = next;
    if (this.approvalIdx >= max) {
      this.startListening(false);
      return;
    }
    this.resetMic();
    this.requestRender();
  }

  private async approvalTap(): Promise<void> {
    if (this.onApprovalMic()) {
      await this.micTap();
      return;
    }
    const option = this.approvalOptions()[this.approvalIdx];
    if (!option) return;
    const sessionId = ghostSessionId();
    // Optimistic close either way: the prompt is gone from the screen the
    // moment it is answered, whether or not the call is confirmed by the time
    // the tap returns.
    void sendApproval(sessionId, option.n);
    this.closeApproval(this.feedSlot());
  }

  // =========================================================================
  // Tier 3

  private async openProse(item: GhostItem): Promise<void> {
    this.proseOpen = true;
    this.bodyScroll = 0;
    // Deliberately never spoken: tiers 1-2 are read aloud, but a full reply
    // over the hearing aids would be two streams at once. This is a reading
    // tier, not a listening one.
    stopGhostSpeech();
    if (this.proseUuid === item.uuid && (this.proseLines || this.proseError)) {
      this.requestRender();
      return;
    }
    this.proseLines = null;
    this.proseError = null;
    this.proseLoading = true;
    this.requestRender();
    try {
      const lines = await fetchProse(ghostSessionId(), item.uuid);
      if (this.closed || !this.proseOpen || this.currentItem()?.uuid !== item.uuid) return;
      this.proseUuid = item.uuid;
      this.proseLines = lines;
      this.proseLoading = false;
    } catch (error) {
      if (this.closed || !this.proseOpen) return;
      this.proseError = String((error as Error)?.message ?? error).slice(0, 60);
      this.proseLoading = false;
    }
    this.requestRender();
  }

  // =========================================================================
  // Dictation
  //
  // faceclaw already owns the hard half: the G2's four microphones over BLE,
  // and a realtime cloud transcriber behind them (native/elevenlabs-stt.ts,
  // the same ElevenLabs account the EvenHub build used). So this holds no PCM
  // and speaks no protocol — it acquires the shared capture, renders what the
  // bridge reports, and commits on a tap.

  private startListening(asAddition: boolean): void {
    // Barge-in: never let the microphone hear our own voice.
    stopGhostSpeech();
    // No snapshot needed here any more - capturedParts already holds every
    // prior utterance; refineNow() below just pushes onto it.
    this.addingToRaw = asAddition;
    this.heard = "";
    this.interim = "";
    this.micStatus = "";
    this.micState = "listening";
    if (!this.capturing) {
      this.capturing = true;
      // endpointing false: this is push-to-talk with a committing tap, which
      // is Ghost's contract. Letting the mic end itself would take the commit
      // decision away from the gesture that means it.
      void this.actions.startVoiceCapture(false);
    }
    this.requestRender();
  }

  /** Tap while listening: stop the mic and wait for the final transcript. */
  private commitCapture(): void {
    if (!this.capturing) return;
    this.micState = "sending";
    void this.actions.stopVoiceCapture();
    this.armTranscriptTimeout();
    this.requestRender();
  }

  private abortCapture(): void {
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = null;
    if (this.capturing) {
      this.capturing = false;
      void this.actions.stopVoiceCapture();
    }
    this.addingToRaw = false;
    this.interim = "";
  }

  private armTranscriptTimeout(): void {
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = null;
      if (this.micState !== "sending") return;
      this.capturing = false;
      // A refine whose addition never transcribed is not a lost dictation:
      // put the confirm screen back with the text he already had. Nothing
      // was pushed onto capturedParts for this failed attempt, so
      // re-rendering it is exactly the pre-attempt state.
      if (this.addingToRaw) {
        this.addingToRaw = false;
        this.heard = this.renderCaptured();
        this.refineOk = false;
        this.micState = "confirming";
      } else {
        this.micState = "failed";
      }
      this.requestRender();
    }, TRANSCRIPT_TIMEOUT_MS);
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (!this.capturing) return;
    if (!event.isFinal) {
      if (this.micState !== "listening") return;
      // Tracked (REPLACE semantics, not a delta), but paintMic's "listening"
      // case no longer reads this.interim - the static headline is just
      // "Listening...  <spinner>". So the render this triggers can't leak
      // live text back onto the screen; it only advances the spinner. Chris,
      // 2026-09-01, caught the real cost of over-removing this: with NO
      // render at all during listening, the spinner itself froze too -
      // "the little spinner is not spinning" was a real, self-inflicted
      // regression from the first pass at this fix, not a separate bug.
      this.interim = event.text;
      this.requestRender();
      return;
    }
    if (this.micState !== "listening" && this.micState !== "sending") return;
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = null;
    this.capturing = false;
    void this.actions.stopVoiceCapture();
    const text = event.text.trim();
    const asAddition = this.addingToRaw;
    this.addingToRaw = false;
    this.interim = "";

    // Checked BEFORE the empty branch on purpose: an addition that transcribed
    // to nothing is not a failed dictation, it is "refine with no addition" —
    // he triggered a refine and stayed quiet.
    if (asAddition) {
      this.refineNow(text);
      return;
    }
    if (!text) {
      // Heard nothing. Say so and stay put rather than sending silence — an
      // empty capture is a normal outcome, not an error worth a red screen.
      this.micState = "failed";
      this.requestRender();
      return;
    }
    this.pendingRaw = text;
    this.capturedParts = [text];
    this.heard = text;
    this.refineOk = true;
    this.micState = "confirming";
    this.requestRender();
  }

  /**
   * Render every captured utterance as one message. A single part goes out
   * exactly as spoken, unlabeled - the label scheme only exists to mark
   * MULTIPLE utterances as separate passes rather than one continuous one.
   */
  private renderCaptured(): string {
    if (this.capturedParts.length <= 1) return this.capturedParts[0] ?? "";
    return this.capturedParts
      .map((part, index) => `Send ${index + 1}${index > 0 ? " (addendum)" : ""}: ${part}`)
      .join("\n");
  }

  /**
   * Add a follow-up capture to the message in progress. Chris, 2026-09-01,
   * after the box's own Haiku merge (refineDictation) failed him twice in
   * one evening: it dropped his first transcript wholesale rather than
   * merging when that transcript read as too garbled to be "missing a
   * detail" (a real edge case in the merge prompt's own instructions, not a
   * fluke), and it seemed to stop working while the interactive session was
   * busy — plausible, since it spawned its own claude process on the box,
   * competing for capacity. His own fix, not a guess: "we must be doing
   * something too complicated... stop trying to interpret the text and just
   * send it... you can just get the two parts and interpret them." So this
   * no longer calls the box at all — pure, local, synchronous string
   * assembly, nothing left to be unreliable. Labeled "Send 1" / "Send 2 /
   * Send 3 / ..." rather than silently space-joined (his own suggestion), so
   * whoever reads it downstream — the live conversation, not a separate
   * model call — can tell this was several passes, not one utterance.
   *
   * 2026-09-02: refining a SECOND time used to wrap the first refine's own
   * already-labeled output in a fresh "Send 1: .../Send 2: ..." pair,
   * producing "Send 1: Send 1: ..." with duplicate "Send 2" lines - a real
   * bug Chris hit live. capturedParts (an array of raw utterances, never
   * itself re-labeled) plus rendering fresh from it every time is what makes
   * a third, fourth, etc. addition number correctly instead of nesting.
   */
  private refineNow(addition: string): void {
    const add = addition.trim();
    // No addition is not this function's job to relabel — he triggered a
    // refine and stayed quiet, so nothing about the captured parts changes.
    if (add) this.capturedParts.push(add);
    this.heard = this.renderCaptured();
    this.refineOk = true;
    this.micState = "confirming";
    this.requestRender();
  }

  /** The ONLY place a glasses dictation actually reaches the session. */
  private async confirmSend(): Promise<void> {
    if (this.micState !== "confirming") return;
    await this.commitText(this.heard, this.pendingRaw);
  }

  private async commitText(text: string, raw: string): Promise<void> {
    const wasApproval = this.inApproval;
    this.micState = "sending";
    this.requestRender();
    const ok = await sendInput(ghostSessionId(), text);
    if (!ok) {
      // Nothing sent, nothing lost: the same recovery gesture as a failed
      // transcription rather than a new state the app has to teach.
      this.micState = "failed";
      this.requestRender();
      return;
    }
    /*
     * Echo what was sent as HIS line in the feed. The box will carry the
     * canonical version on the next poll; this just closes the loop instantly.
     * When a refine changed something, the FIRST transcript rides along in the
     * body so a bad merge is checkable rather than merely trusted.
     */
    const body: string[] = [];
    if (!this.refineOk) body.push("(refine unavailable — sent unrefined)");
    if (raw.trim() && raw.trim() !== text.trim()) body.push(`raw: ${raw}`);
    this.items = [
      ...this.items,
      { uuid: `said-${Date.now()}`, role: "user", headline: text, body },
    ];
    this.micState = "idle";
    this.heard = "";
    this.interim = "";
    this.pendingRaw = "";
    this.capturedParts = [];
    this.refineOk = true;
    if (wasApproval) {
      // A freeform answer is sent as ordinary text, same as any other reply —
      // it just also has to close the prompt it was opened from.
      this.closeApproval(this.items.length - 1);
      return;
    }
    this.cursor = this.items.length - 1;
    this.follow = true;
    this.expanded = false;
    this.proseOpen = false;
    this.bodyScroll = 0;
    this.requestRender();
  }

  // =========================================================================
  // Speech

  private speak(text: string, onEnd?: () => void): void {
    if (!ghostSpeakSetting.get() || !text.trim()) {
      onEnd?.();
      return;
    }
    const sessionId = ghostSessionId();
    if (!sessionId) {
      onEnd?.();
      return;
    }
    speakGhost(ttsUrl(sessionId, text), ghostAuthHeaders(), onEnd);
  }

  /** The window menu's Sound entry, so it can confirm itself out loud. */
  toggleSpeech(): void {
    const next = !ghostSpeakSetting.get();
    ghostSpeakSetting.set(next);
    if (next) this.speak("Sound on.");
    else stopGhostSpeech();
    this.requestRender();
  }

  // =========================================================================
  // The poll
  //
  // Stateless GETs rather than a held socket: a dropped poll costs one
  // interval, and nothing has to be reconnected when the phone comes back.

  async poll(): Promise<void> {
    if (this.closed) return;
    await this.checkAutoFollow();
    const sessionId = ghostSessionId();
    if (!sessionId) {
      this.status = "Ghost — set a session in the app menu";
      this.requestRender();
      return;
    }
    const result = await fetchFeed(sessionId, FEED_LIMIT);
    if (this.closed) return;
    const feed = result.feed;
    if (!feed) {
      this.status =
        result.failure === "unauthorized"
          ? "Ghost — token rejected (set it in the app menu)"
          : result.failure === "http"
            ? `Ghost — server said ${result.detail}`
            : "Ghost — cannot reach the box";
      this.requestRender();
      return;
    }

    // A spoken "turn voice on/off": the live session recognises the phrase and
    // the box carries the value out on one poll and forgets it. The test is
    // `typeof === boolean` and not truthiness — `speak: false` is a real
    // instruction. Applied before the arrival-speak below, so this same tick
    // already obeys it.
    if (typeof feed.speak === "boolean" && feed.speak !== ghostSpeakSetting.get()) {
      ghostSpeakSetting.set(feed.speak);
      if (!feed.speak) stopGhostSpeech();
    }

    const next = feed.items;
    const grew =
      next.length > 0 &&
      (this.items.length === 0 || next[next.length - 1]!.uuid !== this.items[this.items.length - 1]?.uuid);
    // Captured BEFORE the swap: micIndex() is derived from items.length, and
    // a wake below needs to tell a genuine arrival from a boot-time restore
    // (an empty->populated jump for a window persisted open across a
    // restart, where nothing is actually new).
    const parkedOnMic = this.onMic();
    const hadItemsBefore = this.items.length > 0;
    this.items = next;
    if (!this.items.length) {
      this.status = "Ghost — no answers yet";
      this.requestRender();
      return;
    }

    // Wake the glasses on any genuine new arrival, Chris's own request
    // (2026-09-01): the display should turn on for a new message in either
    // direction — his own or Ghost's — not just for the cases the speak
    // logic below cares about (Ghost's turns only, never on mic, never
    // Chris's own words read back). Runs regardless of follow/approval/mic
    // state; shell.wake() is a no-op if the screen is already on.
    if (grew && hadItemsBefore) shell.wake("window");

    if (this.inApproval) {
      // The prompt is modal; an arriving reply must not move the cursor under
      // it. If the prompt itself is gone from the feed, so is the overlay.
      if (this.approvalItem && !this.items.some((item) => item.uuid === this.approvalItem!.uuid)) {
        this.closeApproval(this.feedSlot());
      }
    } else if (parkedOnMic) {
      // Recording is MODAL, for two reasons: micIndex() === items.length, so
      // the clamp below would read the reply slot as out of range and reset it
      // every few seconds; and a reply arriving mid-sentence would yank the
      // screen away while Chris is still talking.
      this.cursor = this.micIndex();
    } else {
      if (this.follow && grew) {
        this.cursor = this.items.length - 1;
        this.expanded = false;
        this.proseOpen = false;
        this.bodyScroll = 0;
      }
      if (this.cursor < 0 || this.cursor >= this.items.length) this.cursor = this.items.length - 1;
    }
    this.status = "";
    this.requestRender();

    // Speak an arrival once, keyed on the uuid because indices shift. Only
    // Ghost's turns: reading Chris's own sentence back to him would be absurd,
    // and never while the microphone is open — the glasses would be talking
    // straight into their own four mics.
    const current = this.items[this.cursor];
    if (!grew || !this.follow || this.onMic() || this.inApproval || !current || current.role === "user") return;
    const ephemeral = current.kind === "approval" || current.kind === "waiting";
    if (ephemeral) {
      if (current.uuid === this.lastSpokenEphemeralUuid) return;
      this.lastSpokenEphemeralUuid = current.uuid;
      // An approval's real question is deliberately NOT read out — only
      // announced. The question itself stays on the lens. "Approval Request"
      // is a fixed string on purpose: the box's /tts route caches an
      // exact-text repeat, so it is synthesized once, ever.
      this.speak(current.kind === "approval" ? "Approval Request" : current.headline);
      return;
    }
    if (current.uuid === this.lastSpokenUuid) return;
    this.lastSpokenUuid = current.uuid;
    this.speak(current.headline);
  }

  private async checkAutoFollow(): Promise<void> {
    if (!ghostAutoFollowSetting.get()) return;
    const next = await fetchActiveSessionId();
    if (!next || next === ghostSessionId() || this.closed) return;
    // Everything cached below is scoped to the OLD session's feed. Carrying it
    // across would show a stale headline captioned as if it belonged to the
    // new session.
    ghostSessionSetting.set(next);
    this.items = [];
    this.cursor = -1;
    this.follow = true;
    this.expanded = false;
    this.proseOpen = false;
    this.bodyScroll = 0;
    this.inApproval = false;
    this.approvalItem = null;
    this.lastSpokenUuid = null;
    this.lastSpokenEphemeralUuid = null;
    this.resetMic();
    stopGhostSpeech();
    this.status = "";
  }
}
