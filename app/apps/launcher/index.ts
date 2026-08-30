import { type AppDefinition } from "../app-definition";
import { createLauncherWindow, LAUNCHER_SURFACE_ID, LAUNCHER_WINDOW_ID } from "./launcher-app";
import {
  getInstalledEvenHubApps,
  installedEvenHubAppId,
  renderInstalledEvenHubIcon,
} from "../evenhub/installed-apps";

/**
 * The stock icon-grid launcher — retired as the boot screen in favour of
 * Exocortex (../exocortex), which now owns the pinned boot window.
 *
 * Retired, not deleted: the grid is still the only UI that can uninstall an
 * installed EvenHub package, and the only view of the folder grouping the
 * assistant's apps.* tools manage. Nothing lists it any more — `showInLauncher:
 * false` keeps it out of Exocortex's app run, and the controller's
 * LAUNCHABLE_APPS filters on the same flag, so neither the assistant's launch
 * tool nor the watch remote offers it. The only way in is an explicit
 * launchApp("launcher") from code. To put it back on the home screen as an
 * ordinary app, delete the `showInLauncher: false` line below; nothing else
 * needs changing.
 */
const launcherApp: AppDefinition = {
  appId: "launcher",
  title: "Apps",
  icon: "layout-grid",
  showInLauncher: false,
  /**
   * No `boot` any more — that is what made this the boot foreground, and it
   * is Exocortex's now. The grid opens on demand like any other in-process
   * app instead, which also gets it a compositor surface: a window registered
   * straight onto the shell after connect would never have one configured.
   * The window itself is still uncloseable (see createLauncherWindow), so
   * once opened it stays for the rest of the run.
   */
  launch: async (ctx) => {
    await ctx.launchInProcessApp(LAUNCHER_WINDOW_ID, LAUNCHER_SURFACE_ID, (options) =>
      createLauncherWindow({
        actions: options.actions,
        apps: () => [
          ...ctx.apps
            .filter((app) => app.showInLauncher !== false)
            .map((app) => ({
              appId: app.appId,
              label: app.title,
              icon: app.icon,
              renderIcon: app.renderIcon,
            })),
          ...getInstalledEvenHubApps().map((app) => ({
            appId: installedEvenHubAppId(app.packageId),
            label: app.name,
            icon: "package" as const,
            renderIcon: (size: number) => renderInstalledEvenHubIcon(app.packageId, size, app),
            iconKey: `${app.installedAt}:${app.iconFile ?? ""}`,
            uninstallable: true,
          })),
        ],
        launchApp: (appId) => ctx.launchApp(appId),
        uninstallApp: (appId) => ctx.uninstallApp(appId),
        submitFrame: options.submitFrame,
        setSurfaceVisible: options.setSurfaceVisible,
      }),
    );
  },
};

export default launcherApp;
