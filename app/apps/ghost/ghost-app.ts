/**
 * Ghost's window: the layer, its long-press menu, the text plumbing, and the
 * poll loop that feeds it.
 *
 * The poll runs for as long as the window is open, foreground or not. That is
 * deliberate: the whole point of Ghost on the glasses is that an approval
 * request or a finished reply ANNOUNCES itself, and a feed that only advanced
 * while Chris was looking at it would defeat that.
 */
import { openSettingsSubMenu } from "../../ui/dashboard/settings-panel";
import { textSettingMenuItem, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { type MenuItem } from "../../ui/menu";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import {
  ghostAutoFollowSetting,
  ghostHostSetting,
  ghostSessionSetting,
  ghostSpeakSetting,
  ghostTokenSetting,
} from "./ghost-client";
import { GhostLayer } from "./ghost-layer";

export const GHOST_WINDOW_ID = "ghost";
export const GHOST_SURFACE_ID = "window:ghost";

/**
 * Three seconds, the EvenHub build's own interval. Short enough that a reply
 * feels immediate on a device with no push channel; long enough that a phone
 * in a pocket is not doing continuous work.
 */
const POLL_MS = 3000;

export function createGhostAppWindow(options: InProcessAppOptions): InProcessWindow {
  const layer = new GhostLayer(options.actions);

  const menuItems = (): MenuItem[] => [
    {
      label: ghostSpeakSetting.get() ? "Sound off" : "Sound on",
      onSelect: (ctx) => {
        ctx.stack.pop();
        layer.toggleSpeech();
      },
    },
    {
      label: "Refresh now",
      onSelect: (ctx) => {
        ctx.stack.pop();
        void layer.poll();
      },
    },
    {
      label: "Ghost settings",
      onSelect: (ctx) => {
        ctx.stack.pop();
        openSettingsSubMenu(ctx, "Ghost settings", [
          textSettingMenuItem(ghostHostSetting),
          textSettingMenuItem(ghostTokenSetting),
          // Choosing a session by hand is a force-select: it must stick, so it
          // turns auto-follow off rather than being overwritten by the next
          // poll tick's active-session check.
          textSettingMenuItem(ghostSessionSetting, {
            onChange: () => ghostAutoFollowSetting.set(false),
          }),
          toggleSettingMenuItem(ghostAutoFollowSetting, {
            onChange: () => void layer.poll(),
          }),
          toggleSettingMenuItem(ghostSpeakSetting),
        ]);
      },
    },
  ];

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let app: InProcessWindow;
  app = createInProcessWindow({
    appId: "ghost",
    windowId: GHOST_WINDOW_ID,
    title: "Ghost",
    iconLetter: "G",
    icon: "activity",
    closeable: true,
    menuItems,
    actions: options.actions,
    // Supplying this is what tells the shell it can offer "Type Into App" and
    // route the shell's own voice input here.
    receiveTextInput: (text) => {
      if (app.stack.receiveTextInput(text)) app.requestRender();
    },
    // Deliberately NOT wrapped in YieldAtRootLayer: Ghost gives double-click a
    // meaning of its own (up one layer) and hands focus to the sidebar itself
    // once there is nothing left to ascend from. See GhostLayer.back().
    baseLayer: layer,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      options.onClosed();
    },
  });
  layer.requestRender = app.requestRender;
  void layer.poll();
  pollTimer = setInterval(() => void layer.poll(), POLL_MS);
  return app;
}
