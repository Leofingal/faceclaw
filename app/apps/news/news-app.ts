/**
 * News's window: the walk layer, its tap-then-hold menu, and the fetch that
 * loads today's deck.
 *
 * Unlike Ghost's window, there is no poll loop here. News fetches once, on
 * open (and on the menu's Refresh) — a judgment call, flagged in the return
 * doc: a live poll mid-walk risks mutating the deck array under an active
 * narration, and the old app's own "News" menu item was already a one-shot
 * fetch (openNewsFromServer, session 0130), not a continuous poll. Chris
 * reopening the app, or Refresh, are the two ways to see a newer deck.
 */
import { type MenuItem } from "../../ui/menu";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { ghostSpeakSetting } from "../ghost/ghost-client";
import { NewsLayer } from "./news-layer";

export const NEWS_WINDOW_ID = "news";
export const NEWS_SURFACE_ID = "window:news";

export function createNewsAppWindow(options: InProcessAppOptions): InProcessWindow {
  const layer = new NewsLayer(options.actions);

  const menuItems = (): MenuItem[] => [
    {
      label: "Refresh",
      onSelect: (ctx) => {
        ctx.stack.pop();
        void layer.load();
      },
    },
    {
      label: ghostSpeakSetting.get() ? "Sound off" : "Sound on",
      onSelect: (ctx) => {
        ctx.stack.pop();
        layer.toggleSpeech();
      },
    },
  ];

  let app: InProcessWindow;
  app = createInProcessWindow({
    appId: "news",
    windowId: NEWS_WINDOW_ID,
    title: "News",
    iconLetter: "N",
    icon: "file-text",
    closeable: true,
    menuItems,
    actions: options.actions,
    // The window menu's "Voice input" entry is pushed unconditionally
    // (in-process-window.ts) and delivers via receiveTextInput?.(text) — a
    // silent no-op without this. Wiring it routes both that and phone-typed
    // text into the discuss depth's own confirm screen (NewsLayer.receiveTextInput).
    receiveTextInput: (text) => {
      if (app.stack.receiveTextInput(text)) app.requestRender();
    },
    baseLayer: layer,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      options.onClosed();
    },
  });
  layer.requestRender = () => app.requestRender();
  void layer.load();
  return app;
}
