import { shell } from "../../ui/shell/shell";
import { isNotificationListenerEnabled, requestNotificationListenerAccess } from "../../native/notification-access";
import { type AppDefinition } from "../app-definition";
import { createExocortexWindow, EXOCORTEX_SURFACE_ID, EXOCORTEX_WINDOW_ID } from "./exocortex-app";
import { applyExocortexAppList, isCuratedAppId } from "../../native/exocortex-app-list";
import {
  getInstalledEvenHubApps,
  installedEvenHubAppId,
  renderInstalledEvenHubIcon,
} from "../evenhub/installed-apps";

/**
 * Exocortex: the glasses' home screen and launcher — one vertical run of the
 * most recent notification, older ones, then the app list, with no 2D grid to
 * navigate.
 *
 * This is the boot screen. Its window is registered from `boot` rather than
 * opened through launchInProcessApp, and exocortexApp is first in ALL_APPS,
 * which the controller's boot loop walks in order — so Exocortex's is the
 * first window pushed onto the shell's registry, landing at index 0, where
 * selectedIndex starts. That is what makes it the boot foreground. It is
 * uncloseable: there is nothing behind it and nothing that would re-open it.
 *
 * The stock icon-grid launcher this replaced still exists but no longer
 * registers at boot and is listed nowhere; see ../launcher/index.ts.
 */
const exocortexApp: AppDefinition = {
  appId: "exocortex",
  title: "Exocortex",
  icon: "bell",
  // Exocortex is the app run itself, not an entry in it.
  showInLauncher: false,
  boot: (ctx) => {
    shell.registerWindow(
      createExocortexWindow({
        actions: {
          ...ctx.actions,
          requestRender: () => shell.foregroundWindow()?.requestRender(),
        },
        // Everything launchable: the built-in apps that opt into a launcher
        // listing, then the EvenHub packages installed right now. Both runs
        // are what the stock grid used to show — Exocortex is the only home
        // screen now, so dropping the installed packages would strand them.
        // Apps that hide themselves (the stock launcher, and Exocortex
        // itself) fall out on `showInLauncher`; the explicit self-check is
        // belt-and-braces for a future pass that unhides this app.
        // applyExocortexAppList is the shared state behind two of Chris's
        // asks: the per-app "show this in the list" checkbox, and the
        // reordering done on the phone. The glasses read the same setting the
        // phone writes, so the order and the hidden set need no syncing —
        // this is the pilot's "reorder is shared state" property, kept.
        apps: () => applyExocortexAppList([
          ...ctx.apps
            .filter((app) => app.showInLauncher !== false && app.appId !== ctx.appId)
            .map((app) => ({
              appId: app.appId,
              label: app.title,
              icon: app.icon,
              renderIcon: app.renderIcon,
              // Curated apps are in the list on a fresh install; the rest of
              // faceclaw's stock apps are not, until let in from the phone.
              // They stay installed and launchable either way.
              defaultVisible: isCuratedAppId(app.appId),
            })),
          ...getInstalledEvenHubApps().map((app) => ({
            appId: installedEvenHubAppId(app.packageId),
            label: app.name,
            icon: "package" as const,
            renderIcon: (size: number) => renderInstalledEvenHubIcon(app.packageId, size, app),
            // Installing an EvenHub package is already a deliberate act, so
            // it earns its place in the list without being asked for twice.
            defaultVisible: true,
          })),
        ]),
        launchApp: (appId) => ctx.launchApp(appId),
        submitFrame: (planes, paintMs, frameId) =>
          ctx.submitWindowFrame(EXOCORTEX_SURFACE_ID, planes, paintMs, frameId),
        setSurfaceVisible: (visible) => ctx.setWindowSurfaceVisible(EXOCORTEX_SURFACE_ID, visible),
      }),
    );
  },
  /**
   * The home window is pinned and always open, so launching means focusing —
   * the same shape as the stock launcher's old launch. Reached only by an
   * explicit launchApp("exocortex") (nothing lists a hidden app), which is
   * also the one place left that can ask for notification access: without the
   * listener the feed is empty, and the blank screen says so but cannot open
   * the phone's settings by itself.
   */
  launch: async (ctx) => {
    if (!isNotificationListenerEnabled()) {
      requestNotificationListenerAccess();
    }
    shell.focusWindow(EXOCORTEX_WINDOW_ID);
    ctx.requestShellRender();
  },
};

export default exocortexApp;
