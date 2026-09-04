/**
 * News on the glasses: the three-depth walk over the morning brief, as its
 * own app rather than a mode folded into Ghost's pager.
 *
 * Ported from the retired EvenHub build (TheLimitCase apps/ghost/src/main.ts
 * — see its "THREE DEPTHS" block comment for the original design notes) onto
 * faceclaw's current Layer/gesture model, the same way ghost-layer.ts ported
 * the rest of that app. What survives is the interaction design; what does
 * not is the EvenHub bridge itself — storage, PCM capture, Web-Speech-that-
 * never-existed-on-device, all replaced by real faceclaw APIs, same as Ghost.
 *
 * ── The gesture vocabulary (matches Ghost's own, see ghost-layer.ts) ───────
 *
 *   scroll   pages between cards at depth 0; scrolls body text at depth 1
 *   click    descends: headline -> take & why -> discuss; commits the mic
 *   d-click  ascends one depth; at the top, exits to the shell
 *   l-press  the window menu (owned by the window, never seen here)
 *
 * ── The three depths ────────────────────────────────────────────────────
 *
 *   0  headline, at rest. During an active walk this is narrated (the card's
 *      `speak` line, written for the ear) and auto-advances when the audio
 *      ends. Scrolling to a different card is a deliberate browse: it pages
 *      but does not narrate.
 *   1  Ghost's take and why this card is in the brief. Descending into it
 *      PAUSES the walk and reads this level once (mark-as-read, same rule
 *      Ghost's own tier-2 uses) — "descending reads the level it lands on."
 *      Ascending back to depth 0 RESUMES the walk at the NEXT card: the one
 *      just read is spent.
 *   2  discuss: an open mic to ask a follow-up. Arriving here IS the intent
 *      to speak (same convention as Ghost's own reply slot), so listening
 *      starts immediately. A deliberately SIMPLER send flow than Ghost's own
 *      composer (no refine/addendum) — reuses the same shared push-to-talk
 *      primitives and the same auto-send-after-a-cancel-window convention
 *      Chris approved system-wide (round 5), but does not duplicate Ghost's
 *      full multi-part state machine, which is tuned for its own primary
 *      reply flow. Flagged in the return doc as a real, deliberate scope cut.
 */
import { GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import {
  gestureHints,
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
  GESTURE_SCROLL_UP,
} from "../../ui/gestures";
import { lineStep } from "../../ui/metrics";
import { type Layer, type LayerActions, type LayerContext } from "../../ui/layers";
import { type InputEvent } from "../../ui/gestures";
import { shell } from "../../ui/shell/shell";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { clamp } from "../../util/numeric-util";
import {
  ghostAuthHeaders,
  ghostSessionId,
  ghostSpeakSetting,
  sendInput,
  ttsUrl,
} from "../ghost/ghost-client";
import { speakGhost, stopGhostSpeech } from "../ghost/ghost-speech";
import { fetchNewsToday } from "./news-client";
import { newsReadKey, type NewsCard, type NewsDeck } from "./news-deck";

const PAGE_X = 20;
const TITLE_Y = 10;

/**
 * Mirrors Ghost's own tuned values (ghost-layer.ts) rather than importing
 * them: these are primitive constants, not shared logic, and duplicating
 * three numbers is lower-risk than reaching into Ghost's module for them.
 * If Chris ever retunes one, both call sites need the same eye — worth
 * knowing, flagged in the return doc as a small future extraction.
 */
const TRANSCRIPT_TIMEOUT_MS = 20_000;
const AUTO_SEND_SECONDS = 4;
const AUTO_SEND_TICK_MS = 1000;

type DiscussState = "idle" | "listening" | "sending" | "confirming" | "sent" | "failed";

function heartbeatChar(): string {
  return "|/-\\"[Math.floor(Date.now() / 250) % 4]!;
}

export class NewsLayer implements Layer {
  /** Rebound by the window factory once the window exists. */
  requestRender: () => void = () => {};

  private deck: NewsDeck | null = null;
  private idx = 0;
  private depth: 0 | 1 | 2 = 0;
  private done = false;
  private status = "News — loading...";
  private bodyScroll = 0;
  private bodyOverflow = 0;

  /** The walk: narrating depth 0 in sequence, one card per utterance. */
  private walking = false;
  /** "Mark as read, never re-narrate it" — see news-deck.ts's newsReadKey. */
  private readonly spoken = new Set<string>();

  // -- discuss (depth 2) -----------------------------------------------------
  private micState: DiscussState = "idle";
  private heard = "";
  private micStatus = "";
  private capturing = false;
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSendTimer: ReturnType<typeof setInterval> | null = null;
  private autoSendLeft = 0;

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
    this.walking = false;
    this.abortCapture();
    this.cancelAutoSend();
    stopGhostSpeech();
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = null;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  /** Fetch today's deck and, if voice is on, start the walk. Also the Refresh menu action. */
  async load(): Promise<void> {
    this.status = "News — loading...";
    this.done = false;
    this.requestRender();
    const result = await fetchNewsToday();
    if (this.closed) return;
    if (!result.deck) {
      this.status =
        result.failure === "unauthorized"
          ? "News — token rejected (set it in Ghost settings)"
          : result.failure === "empty"
            ? "News — nothing pushed yet"
            : result.failure === "http"
              ? `News — server said ${result.detail}`
              : "News — cannot reach the box";
      this.requestRender();
      return;
    }
    stopGhostSpeech();
    this.deck = result.deck;
    this.idx = 0;
    this.depth = 0;
    this.bodyScroll = 0;
    this.status = "";
    // Silent walk with no session configured would flash through every card
    // with no audio at all (speak() below no-ops with no sessionId) — worth
    // guarding explicitly rather than letting that happen once and looking
    // like a bug.
    this.walking = ghostSpeakSetting.get() && !!ghostSessionId();
    this.requestRender();
    if (this.walking) this.walkStep(0);
  }

  private currentCard(): NewsCard | null {
    return this.deck?.cards[this.idx] ?? null;
  }

  /**
   * Speak card i's headline, then advance. "Arriving is the walk": entering
   * News with voice on is the request to be read to, the same reasoning
   * Ghost's reply slot uses for starting to listen on arrival (0112) — no
   * gesture is spent to start this.
   */
  private walkStep(i: number): void {
    if (!this.walking || !this.deck || this.closed) return;
    if (i >= this.deck.cards.length) {
      this.walking = false;
      this.done = true;
      this.requestRender();
      return;
    }
    this.idx = i;
    this.depth = 0;
    this.done = false;
    this.bodyScroll = 0;
    this.requestRender();
    const card = this.deck.cards[i]!;
    const key = newsReadKey(this.deck.uuid, card.id, 0);
    if (this.spoken.has(key)) {
      this.walkStep(i + 1);
      return;
    }
    this.spoken.add(key);
    this.speak(card.speak, () => this.walkStep(i + 1));
  }

  // =========================================================================
  // Painting

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    if (this.depth === 2) {
      this.paintDiscuss(image, width, height);
    } else if (!this.deck) {
      this.paintPage(image, width, height, { meta: "news", headline: this.status || "News", body: [] });
    } else if (this.done) {
      this.paintPage(image, width, height, {
        meta: "news",
        headline: "That's the brief.",
        body: ["Nothing else cleared the bar."],
        hint: gestureHints([[GESTURE_SCROLL, "browse again"], [GESTURE_DOUBLE_CLICK, "exit"]]),
      });
    } else if (this.depth === 1) {
      this.paintTake(image, width, height);
    } else {
      this.paintHeadline(image, width, height);
    }
    return image;
  }

  /** The one page painter every screen goes through — mirrors ghost-layer.ts's own paintPage. */
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
    image.drawText(font, PAGE_X, TITLE_Y, truncateText(font, opts.meta, contentWidth - rightWidth - 12), 150);
    if (opts.metaRight) {
      image.drawText(font, width - PAGE_X - rightWidth, TITLE_Y, opts.metaRight, 140);
    }

    let cursorY = TITLE_Y + font.lineHeight + 10;
    const headlineLines = wrapText(headlineFont, opts.headline, contentWidth).slice(0, 3);
    for (const line of headlineLines) {
      image.drawText(headlineFont, PAGE_X, cursorY, line, 240);
      cursorY += headlineFont.lineHeight + 2;
    }

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

  private paintHeadline(image: GrayImage, width: number, height: number): void {
    const card = this.currentCard();
    if (!card || !this.deck) return;
    const pos = `${this.idx + 1}/${this.deck.cards.length}`;
    this.bodyOverflow = this.paintPage(image, width, height, {
      meta: `news — ${pos} ${heartbeatChar()}`,
      metaRight: ghostSpeakSetting.get() ? "voice" : "",
      headline: card.headline,
      body: [],
      hint: gestureHints([
        [GESTURE_SCROLL, "browse"],
        [GESTURE_CLICK, "take & why"],
        [GESTURE_DOUBLE_CLICK, "exit"],
      ]),
    });
  }

  private paintTake(image: GrayImage, width: number, height: number): void {
    const card = this.currentCard();
    if (!card || !this.deck) return;
    const pos = `${this.idx + 1}/${this.deck.cards.length}`;
    this.bodyOverflow = this.paintPage(image, width, height, {
      meta: `news — ${pos} · take`,
      headline: card.headline,
      body: [card.ghost, card.why].filter(Boolean),
      hint: gestureHints([
        [GESTURE_CLICK, "discuss"],
        [GESTURE_DOUBLE_CLICK, "back"],
      ]),
      scroll: this.bodyScroll,
    });
  }

  private paintDiscuss(image: GrayImage, width: number, height: number): void {
    const spinner = heartbeatChar();
    let headline: string;
    let body: string[] = [];
    let hint = "";
    switch (this.micState) {
      case "listening":
        headline = `Listening...  ${spinner}`;
        body = [this.micStatus || "Ask about this card, then tap to send."];
        hint = gestureHints([
          [GESTURE_CLICK, "send"],
          [GESTURE_SCROLL_UP, "cancel"],
        ]);
        break;
      case "sending":
        headline = `Sending...  ${spinner}`;
        break;
      case "confirming":
        headline = this.heard;
        hint = `${GESTURE_SCROLL_UP}${GESTURE_DOUBLE_CLICK} cancel   ${GESTURE_CLICK} send now`;
        break;
      case "sent":
        headline = "Sent to Ghost.";
        body = ["Look for the reply in Ghost's own feed."];
        hint = gestureHints([
          [GESTURE_CLICK, "ask another"],
          [GESTURE_DOUBLE_CLICK, "back"],
        ]);
        break;
      case "failed":
        headline = "Did not catch that.";
        body = ["Tap to try again."];
        hint = gestureHints([
          [GESTURE_CLICK, "retry"],
          [GESTURE_DOUBLE_CLICK, "back"],
        ]);
        break;
      default:
        headline = "Scroll or tap to ask.";
        break;
    }
    this.bodyOverflow = this.paintPage(image, width, height, {
      meta: this.autoSendLeft > 0 ? `news — discuss — sending in ${this.autoSendLeft}s` : "news — discuss",
      headline,
      body,
      hint,
      scroll: 0,
    });
  }

  // =========================================================================
  // Input

  async handleInput(event: InputEvent, _ctx: LayerContext): Promise<void> {
    // Any deliberate gesture dismisses the "brief done" screen (same "any
    // deliberate gesture" rule Ghost uses for its own catch-up hold).
    this.done = false;
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

  async hitTest(_x: number, _y: number, _ctx: LayerContext): Promise<boolean> {
    await this.tap();
    return true;
  }

  /**
   * Text from the phone keyboard or the shell's own voice-input dialog (the
   * window menu's unconditional "Voice input" entry — in-process-window.ts
   * pushes it regardless of whether a window implements this, and delivery
   * is a silent no-op, `receiveTextInput?.(text)`, if it doesn't; wiring this
   * is what makes that menu item actually do something instead of a quiet
   * dead end). Treated the same as a finished discuss-mic transcript: land on
   * depth 2 and offer it on the same confirm/auto-send screen, so a typed
   * answer gets the same one-more-look Chris gets when he speaks it.
   */
  receiveTextInput(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.deck) return;
    stopGhostSpeech();
    this.walking = false;
    this.resetMic();
    this.depth = 2;
    this.heard = trimmed;
    this.enterConfirming();
  }

  private step(delta: number): void {
    if (this.depth === 2) {
      // CANCEL: scroll up while listening/confirming, same convention as
      // Ghost's own mic surfaces — scroll-up already means "abandon" every-
      // where else in a dictation flow.
      if (delta < 0) {
        this.resetMic();
        this.depth = 1;
        this.requestRender();
      }
      return;
    }
    // Reading the take/why tier scrolls its own text first, same as Ghost's
    // tiers, before paging away — a full take doesn't always fit one screen.
    if (this.depth === 1 && this.bodyOverflow > 0) {
      const next = clamp(this.bodyScroll + delta, 0, this.bodyOverflow);
      if (next !== this.bodyScroll) {
        this.bodyScroll = next;
        this.requestRender();
        return;
      }
    }
    if (!this.deck || !this.deck.cards.length) return;
    // Paging is a new intent; a manual browse does not narrate. Stop any
    // in-flight walk narration rather than let it talk over a card Chris
    // just deliberately scrolled away from.
    this.walking = false;
    stopGhostSpeech();
    const was = this.idx;
    this.idx = clamp(this.idx + delta, 0, this.deck.cards.length - 1);
    if (this.idx === was) return;
    this.depth = 0;
    this.bodyScroll = 0;
    this.requestRender();
  }

  private async tap(): Promise<void> {
    if (this.depth === 2) {
      await this.discussTap();
      return;
    }
    const card = this.currentCard();
    if (!card || !this.deck) return;
    if (this.depth === 0) {
      // Descending PAUSES the walk — Chris dug in on purpose, and reading two
      // things at once is the one failure mode this design must never have.
      this.walking = false;
      stopGhostSpeech();
      this.depth = 1;
      this.bodyScroll = 0;
      this.requestRender();
      // Descending READS the level it lands on, once (mark-as-read).
      const key = newsReadKey(this.deck.uuid, card.id, 1);
      if (!this.spoken.has(key)) {
        this.spoken.add(key);
        this.speak([card.ghost, card.why].filter(Boolean).join("  "));
      }
      return;
    }
    // depth === 1: descend into discuss. Arriving there is the intent to
    // speak, so listening starts immediately — no separate tap to begin it.
    stopGhostSpeech();
    this.depth = 2;
    this.requestRender();
    this.startListening();
  }

  /**
   * Double-click: ascend one depth; at the top, exit (same shape as Ghost's
   * own back(), which hands focus to the sidebar once there is nothing left
   * to ascend from — this is why the layer is not wrapped in
   * YieldAtRootLayer, same reasoning as ghost-app.ts).
   */
  private back(): void {
    if (this.depth === 2) {
      this.resetMic();
      this.depth = 1;
      this.requestRender();
      return;
    }
    if (this.depth === 1) {
      stopGhostSpeech();
      this.depth = 0;
      this.bodyScroll = 0;
      // Ascending RESUMES the walk at the NEXT card: the one just read is
      // spent. Only if voice is actually on — otherwise this would silently
      // re-arm a walk that has no audio to give.
      if (this.deck && ghostSpeakSetting.get() && ghostSessionId()) {
        this.walking = true;
        this.walkStep(this.idx + 1);
      } else {
        this.requestRender();
      }
      return;
    }
    this.walking = false;
    stopGhostSpeech();
    shell.backOutToHome();
  }

  // =========================================================================
  // Discuss (depth 2): a deliberately simple send flow — see this file's own
  // header comment for why it does not replicate Ghost's full composer.

  private startListening(): void {
    stopGhostSpeech();
    this.micState = "listening";
    this.heard = "";
    this.micStatus = "";
    if (!this.capturing) {
      this.capturing = true;
      // endpointing false: push-to-talk with a committing tap, same contract
      // as Ghost's own reply slot.
      void this.actions.startVoiceCapture(false);
    }
    this.requestRender();
  }

  private async discussTap(): Promise<void> {
    if (this.micState === "confirming") {
      await this.confirmSend();
      return;
    }
    if (this.micState === "listening") {
      this.commitCapture();
      return;
    }
    if (this.micState === "sending") return;
    // idle / sent / failed: start a fresh capture.
    this.startListening();
  }

  private commitCapture(): void {
    if (!this.capturing) return;
    this.micState = "sending";
    void this.actions.stopVoiceCapture();
    this.armTranscriptTimeout();
    this.requestRender();
  }

  private armTranscriptTimeout(): void {
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = null;
      if (this.micState !== "sending") return;
      this.capturing = false;
      this.micState = "failed";
      this.requestRender();
    }, TRANSCRIPT_TIMEOUT_MS);
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (!this.capturing || this.depth !== 2) return;
    if (!event.isFinal) {
      if (this.micState !== "listening") return;
      // Not painted (matches Ghost: the transcript only ever appears once,
      // on the confirm screen) — this just keeps the spinner ticking.
      this.requestRender();
      return;
    }
    if (this.micState !== "listening" && this.micState !== "sending") return;
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = null;
    this.capturing = false;
    void this.actions.stopVoiceCapture();
    const text = event.text.trim();
    if (!text) {
      this.micState = "failed";
      this.requestRender();
      return;
    }
    this.heard = text;
    this.enterConfirming();
  }

  private enterConfirming(): void {
    this.micState = "confirming";
    this.cancelAutoSend();
    this.autoSendLeft = AUTO_SEND_SECONDS;
    this.autoSendTimer = setInterval(() => {
      if (this.micState !== "confirming" || this.closed) {
        this.cancelAutoSend();
        return;
      }
      this.autoSendLeft--;
      if (this.autoSendLeft > 0) {
        this.requestRender();
        return;
      }
      this.cancelAutoSend();
      void this.confirmSend();
    }, AUTO_SEND_TICK_MS);
    this.requestRender();
  }

  private cancelAutoSend(): void {
    if (this.autoSendTimer) clearInterval(this.autoSendTimer);
    this.autoSendTimer = null;
    this.autoSendLeft = 0;
  }

  private async confirmSend(): Promise<void> {
    if (this.micState !== "confirming") return;
    this.cancelAutoSend();
    const text = this.heard;
    this.micState = "sending";
    this.requestRender();
    const ok = await sendInput(ghostSessionId(), text);
    if (this.closed) return;
    this.micState = ok ? "sent" : "failed";
    if (ok) this.heard = "";
    this.requestRender();
  }

  private resetMic(): void {
    this.abortCapture();
    this.cancelAutoSend();
    this.micState = "idle";
    this.heard = "";
  }

  private abortCapture(): void {
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = null;
    if (this.capturing) {
      this.capturing = false;
      void this.actions.stopVoiceCapture();
    }
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

  /** The window menu's Sound entry. */
  toggleSpeech(): void {
    const next = !ghostSpeakSetting.get();
    ghostSpeakSetting.set(next);
    if (next) {
      this.speak("Sound on.");
    } else {
      stopGhostSpeech();
      this.walking = false;
    }
    this.requestRender();
  }
}
