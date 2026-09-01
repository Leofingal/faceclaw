import { shell } from "../../ui/shell/shell";
import { isNotificationListenerEnabled, requestNotificationListenerAccess } from "../../native/notification-access";
import { type AppDefinition } from "../app-definition";
import {
  createExocortexWindow,
  EXOCORTEX_SURFACE_ID,
  EXOCORTEX_WINDOW_ID,
  resetExocortexHomeView,
} from "./exocortex-app";
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
  /**
   * LISTED, as of round 2. It used to hide itself on the reasoning that
   * "Exocortex is the app run itself, not an entry in it" — which is true of
   * the app run, and turned out to be false of the wearer's experience.
   *
   * Chris: "we need a way to get to bare Exocortex on the glasses." There was
   * none. The home screen's resting view is its notification view, but the
   * cursor stays wherever it was left (see resetToRestingView), so after one
   * trip into the app list every later return to home lands in the app list
   * again. And because this app hid itself from the launcher, it appeared in
   * NEITHER the glasses' own list NOR the phone's app screen — both filter on
   * showInLauncher — so nothing anywhere could ask for it by name.
   *
   * Being listed fixes both surfaces at once, and `launch` below is what makes
   * the entry mean "the bare view" rather than "the window you are already in".
   */
  showInLauncher: true,
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
        // Apps that hide themselves (the stock launcher) fall out on
        // `showInLauncher`. The self-check that used to sit beside it is
        // GONE, which is what puts an "Exocortex" row in the home screen's
        // own app run: tapping it re-anchors the run to the newest
        // notification, i.e. scrolls this screen back to its own top. That
        // reads as redundant on paper and is the only reset gesture the home
        // screen has — the app run and the notification view are one
        // continuous list, so "go back to the top of it" is a real
        // destination, not a self-reference.
        // applyExocortexAppList is the shared state behind two of Chris's
        // asks: the per-app "show this in the list" checkbox, and the
        // reordering done on the phone. The glasses read the same setting the
        // phone writes, so the order and the hidden set need no syncing —
        // this is the pilot's "reorder is shared state" property, kept.
        apps: () => applyExocortexAppList([
          ...ctx.apps
            .filter((app) => app.showInLauncher !== false)
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
   * plus, as of round 2, RESETTING THE VIEW. That is the whole point of the
   * entry: focusing alone would land the wearer wherever the cursor happened
   * to be left, which for anyone who has opened an app is the app list, and
   * "bare Exocortex" is the notification view at the top of that same run.
   *
   * Reset first, then focus, so the window's next paint is already the
   * resting view rather than a frame of the old cursor position.
   *
   * This is also the one place that can ask for notification access: without
   * the listener the feed is empty, and the blank screen says so but cannot
   * open the phone's settings by itself.
   */
  launch: async (ctx) => {
    if (!isNotificationListenerEnabled()) {
      requestNotificationListenerAccess();
    }
    resetExocortexHomeView();
    shell.focusWindow(EXOCORTEX_WINDOW_ID);
    ctx.requestShellRender();
  },
};

export default exocortexApp;
