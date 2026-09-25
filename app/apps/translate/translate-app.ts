import { type GrayImage } from "../../graphics/image";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext, type PaintBelow } from "../../ui/layers";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { CaptionsLayer } from "../microphones/captions-layer";
import { micSession, micSessionOwners } from "../microphones/mic-session";
import { closeTranslateApp, openTranslateApp } from "../microphones/mic-session-owners";

export const TRANSLATE_WINDOW_ID = "translate";
export const TRANSLATE_SURFACE_ID = "window:translate";

/**
 * Translate (Chris, 2026-09-25; built as "Captions" and renamed the same
 * evening): opening it turns captions on in Japanese/Korean/Chinese
 * (+ English) mode, whatever "Languages I'll hear" says, and lands straight in
 * the captions view, English only on the glasses. Leaving it (double-click, or
 * Close this app) closes the window, which turns captions off, gives the
 * language back to the setting, and releases the mic unless Microphones is
 * still open. The Microphones app's own Captions toggle and view are
 * unchanged. While it is open Ghost holds automatic speech and the ring skips
 * its timed pulls, as for any captions view / mic session. The on/off logic
 * lives in mic-session-owners.ts, tested by tests/translate-app.test.cjs.
 */
export function createTranslateAppWindow(options: InProcessAppOptions): InProcessWindow {
  const captions = new CaptionsLayer("Translate");
  let closed = false;
  const app = createInProcessWindow({
    appId: "translate",
    windowId: TRANSLATE_WINDOW_ID,
    title: "Translate",
    iconLetter: "Tr",
    icon: "type",
    closeable: true,
    actions: options.actions,
    baseLayer: new CloseAtRootLayer(captions),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      if (closed) return;
      closed = true;
      captions.onRemoved();
      closeTranslateApp(micSession, micSessionOwners);
      options.onClosed();
    },
  });
  openTranslateApp(micSession, micSessionOwners);
  captions.start(app.requestRender);
  return app;
}

/**
 * The captions view as a window root: double-click LEAVES the app by closing
 * it (so captions stop and the mic is released), where other apps' roots only
 * hand focus back to the home screen and keep running.
 */
class CloseAtRootLayer implements Layer {
  constructor(private readonly inner: CaptionsLayer) {}

  paint(ctx: LayerContext, _paintBelow: PaintBelow): GrayImage {
    return this.inner.paint(ctx);
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      shell.closeWindow(TRANSLATE_WINDOW_ID);
      // Home, like other apps' double-click, but without backOutToHome's
      // "already home means sleep" rule (home may be foreground after close).
      shell.focusHomeScreen();
      return;
    }
    this.inner.handleInput(event, ctx);
  }
}
