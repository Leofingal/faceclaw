/**
 * The glasses-side window for a running EvenHub app: a layer that paints the
 * session's composited page and forwards gestures to it. heightMode "medium"
 * makes the content area exactly the 576x288 surface EvenHub apps expect.
 */
import { GrayImage } from "../../graphics/image";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import { MenuLayer } from "../../ui/menu";
import { WINDOW_MENU_LAYOUT } from "../../ui/window-menu";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { EvenHubSession } from "./session";

class EvenHubAppLayer implements Layer {
  constructor(private readonly session: EvenHubSession) {}

  paint(ctx: LayerContext): GrayImage {
    const size = ctx.stack.getBaseSize();
    return this.session.paint(size, ctx.stack.isFocused());
  }

  handleInput(event: DashboardInputEvent): void {
    // Everything goes to the app; long-press never reaches here (the window
    // menu intercepts it), which is the guaranteed way out since EvenHub
    // apps own double-click.
    this.session.handleGesture(event);
  }
}

/** The stock exit confirm shown for shutDownPageContainer(1). */
class ExitConfirmLayer extends MenuLayer {
  constructor(session: EvenHubSession, appName: string) {
    let answered = false;
    const answer = (ctx: LayerContext, exit: boolean) => {
      if (answered) return;
      answered = true;
      ctx.stack.pop();
      session.exitDialogAnswer(exit);
    };
    super(`Exit ${appName}?`, [
      { label: "No", onSelect: (ctx) => answer(ctx, false) },
      { label: "Yes", onSelect: (ctx) => answer(ctx, true) },
    ], WINDOW_MENU_LAYOUT);
  }
}

export function createEvenHubWindow(
  windowId: string,
  session: EvenHubSession,
  options: InProcessAppOptions,
): InProcessWindow {
  const created = createInProcessWindow({
    appId: "evenhub",
    windowId,
    title: session.manifest.name,
    iconLetter: session.manifest.name.charAt(0).toUpperCase() || "E",
    closeable: true,
    heightMode: "medium",
    actions: options.actions,
    baseLayer: new EvenHubAppLayer(session),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      options.onClosed();
      session.windowClosed();
    },
  });

  session.attachWindow({
    requestRender: created.requestRender,
    closeWindow: () => shell.closeWindow(windowId),
    openExitDialog: () => {
      if (!created.stack.topMatches((layer) => layer instanceof ExitConfirmLayer)) {
        created.stack.push(new ExitConfirmLayer(session, session.manifest.name));
      }
    },
  });

  // FOREGROUND_ENTER/EXIT for the app on shell focus changes.
  const baseSetForeground = created.window.setForeground;
  created.window.setForeground = (foreground) => {
    baseSetForeground?.(foreground);
    session.setForeground(foreground);
  };

  return created;
}
