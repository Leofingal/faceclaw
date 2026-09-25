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
import { closeCaptionsApp, openCaptionsApp } from "../microphones/mic-session-owners";

export const CAPTIONS_WINDOW_ID = "captions";
export const CAPTIONS_SURFACE_ID = "window:captions";

/**
 * Captions as its own app (Chris, 2026-09-25): opening it turns captions on
 * and lands straight in the captions view, in whatever "Languages I'll hear"
 * was last set to; leaving it (double-click, or Close this app) closes the
 * window, which turns captions off and releases the mic unless Microphones is
 * still open. The Microphones app's own Captions toggle and view are
 * unchanged. The on/off logic lives in mic-session-owners.ts, tested by
 * tests/captions-app.test.cjs.
 */
export function createCaptionsAppWindow(options: InProcessAppOptions): InProcessWindow {
  const captions = new CaptionsLayer();
  let closed = false;
  const app = createInProcessWindow({
    appId: "captions",
    windowId: CAPTIONS_WINDOW_ID,
    title: "Captions",
    iconLetter: "Cc",
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
      closeCaptionsApp(micSession, micSessionOwners);
      options.onClosed();
    },
  });
  openCaptionsApp(micSession, micSessionOwners);
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
      shell.closeWindow(CAPTIONS_WINDOW_ID);
      // Home, like other apps' double-click, but without backOutToHome's
      // "already home means sleep" rule (home may be foreground after close).
      shell.focusHomeScreen();
      return;
    }
    this.inner.handleInput(event, ctx);
  }
}
