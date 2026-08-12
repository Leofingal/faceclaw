/**
 * EvenHub compatibility host: runs apps built for Even Realities' EvenHub
 * API (webview apps talking to the glasses through the phone) inside
 * Faceclaw. Launched by picking an .ehpk file in the Files app; the app gets
 * a phone WebView (its runtime + phone UI) and a 576x288 glasses window
 * composited by Faceclaw instead of the stock firmware.
 *
 * Design notes: notes/evenhub_compatibility.txt.
 */
import { type AppContext, type AppDefinition } from "../app-definition";
import { shell } from "../../ui/shell/shell";
import { EvenHubStoreLayer } from "./store-layer";
import { launchPackage } from "./manager";
import { createInProcessWindow, type InProcessWindow } from "../../ui/shell/in-process-window";

const EVENHUB_STORE_WINDOW_ID = "evenhub:store";
const EVENHUB_STORE_SURFACE_ID = "window:evenhub:store";

/**
 * Unpack an .ehpk and launch it as a concurrent EvenHub app (own glasses
 * window + persistent WebView). The phone stays on the dashboard; see manager.
 */
export function openEvenHubPackage(ctx: AppContext, ehpkPath: string): Promise<void> {
  return launchPackage(ctx, ehpkPath);
}

const evenhubApp: AppDefinition = {
  appId: "evenhub",
  title: "EvenHub",
  icon: "package",
  launch: async (ctx) => {
    const existing = shell.getWindows().find((window) => window.windowId === EVENHUB_STORE_WINDOW_ID);
    if (existing) {
      shell.focusWindow(existing.windowId);
      ctx.requestShellRender();
      return;
    }
    let created: InProcessWindow | null = null;
    const store = new EvenHubStoreLayer({
      openPackage: (path) => openEvenHubPackage(ctx, path),
      openSettings: () => ctx.launchApp("settings", { section: "EvenHub" }),
      appendLog: ctx.appendLog,
    });
    await ctx.launchInProcessApp(EVENHUB_STORE_WINDOW_ID, EVENHUB_STORE_SURFACE_ID, (options) => {
      created = createInProcessWindow({
        appId: "evenhub",
        windowId: EVENHUB_STORE_WINDOW_ID,
        title: "EvenHub",
        iconLetter: "EH",
        icon: "package",
        closeable: true,
        menuItems: () => (created?.stack.isAtBase() ? store.buildMenuItems() : []),
        actions: options.actions,
        baseLayer: store,
        submitFrame: options.submitFrame,
        setSurfaceVisible: options.setSurfaceVisible,
        removeSurface: options.removeSurface,
        onClosed: options.onClosed,
      });
      return created;
    });
  },
};

export default evenhubApp;
