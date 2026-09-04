import { GrayImage, type UiFont } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { lineStep } from "../../ui/metrics";
import { writeTextToDownloads } from "../../native/file-access";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { Layer, type LayerContext } from "../../ui/layers";

/**
 * Live transcription view. Continuous mic capture is owned by the app wrapper
 * (createTranscribeAppWindow); this layer accumulates the transcript, shows
 * it, and saves it to Downloads on click.
 */
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
export class TranscribeLayer implements Layer {
  private status = "Listening...";
  // Finalized utterances, plus the live (replace-semantics) partial appended
  // when painting.
  private finalizedText = "";
  private liveText = "";
  private saveNotice = "";
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  start(requestRender: () => void): void {
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => {
      this.onTranscript(event);
      requestRender();
    });
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      this.status = state.status;
      requestRender();
    });
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const text = this.displayText() || "Listening...";
    const wrapped = wrapTranscribeText(font, text, width - 64);

    image.drawText(font, 24, 20, "Transcribe", 200);
    image.drawText(font, 24, 40, this.saveNotice || this.status, 110);

    const step = lineStep(font) + 2;
    const bodyTop = 62;
    const footerY = height - font.lineHeight - 6;
    const bodyLines = Math.max(1, Math.floor((footerY - bodyTop) / step));
    const firstLine = Math.max(0, wrapped.length - bodyLines);
    for (let index = firstLine; index < wrapped.length; index++) {
      const y = bodyTop + (index - firstLine) * step;
      image.drawText(font, 32, y, wrapped[index]!, 230);
    }

    // "leave", not "back": double-click at this window's root is intercepted
    // by YieldAtRootLayer (in-process-window.ts) before it ever reaches this
    // layer's own handleInput below -- it only defocuses to the sidebar
    // (shell.backOutToHome()), it does not close the window. That's the
    // established meaning of double-click-at-root everywhere in this
    // codebase (every in-process app is wrapped the same way; games label
    // the identical action "leave" on their own pause screens) -- capture
    // keeps running in the background exactly like a paused game keeps its
    // board. "back" implied an exit this gesture never performed; "leave"
    // says what actually happens. To really stop transcription, use the
    // window's Close window menu (short-then-long-press, or the escape
    // menu), which does tear the capture down via this window's onClosed.
    image.drawText(font, 24, footerY, `${GESTURE_CLICK} save   ${GESTURE_DOUBLE_CLICK} leave`, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "click") {
      this.saveTranscript();
      ctx.actions.requestRender();
      return;
    }
    if (event.type === "double-click") {
      // Currently unreachable in practice: this window's base layer is
      // always wrapped in YieldAtRootLayer (transcribe-app.ts), which
      // intercepts double-click before it reaches here. Left in place as a
      // harmless fallback for a layer instance ever hosted without that
      // wrapper (e.g. a future test harness), not as live behavior.
      ctx.stack.pop();
    }
  }

  onRemoved(): void {
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  private saveTranscript(): void {
    const text = this.displayText().trim();
    if (!text) {
      this.saveNotice = "Nothing to save yet.";
      return;
    }
    const filename = `transcript-${transcriptTimestamp()}.txt`;
    const path = writeTextToDownloads(filename, `${text}\n`);
    this.saveNotice = path ? `Saved ${filename}` : "Save failed (check file access).";
  }

  private displayText(): string {
    if (!this.finalizedText) return this.liveText;
    if (!this.liveText) return this.finalizedText;
    return `${this.finalizedText} ${this.liveText}`;
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (event.isFinal) {
      const finalText = event.text.trim() || this.liveText.trim();
      if (finalText) {
        this.finalizedText = this.finalizedText ? `${this.finalizedText} ${finalText}` : finalText;
      }
      this.liveText = "";
    } else {
      // Replace semantics: the live partial is the whole current best transcript.
      this.liveText = event.text.trim();
    }
  }
}

function transcriptTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function wrapTranscribeText(font: UiFont, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.measureText(candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.length ? lines : [""];
}
