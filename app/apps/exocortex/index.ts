import { isNotificationListenerEnabled, requestNotificationListenerAccess } from "../../native/notification-access";
import { type AppDefinition } from "../app-definition";
import { createExocortexWindow, EXOCORTEX_SURFACE_ID, EXOCORTEX_WINDOW_ID } from "./exocortex-app";

/**
 * Exocortex: a notification-first home screen for the glasses — one vertical
 * run of the most recent notification, older ones, then the app list, with no
 * 2D grid to navigate.
 *
 * For now this is an ordinary app in the stock launcher's grid, so it can be
 * tried on hardware without giving up a known-good boot screen. Becoming the
 * actual launcher is a follow-up: set showInLauncher false here, move the
 * window to a pinned boot registration (a `boot` callback, as launcher/index.ts
 * does), make its window uncloseable, and retire the stock launcher.
 */
const exocortexApp: AppDefinition = {
  appId: "exocortex",
  title: "Exocortex",
  icon: "bell",
  launch: (ctx) => {
    // Without notification-listener access the home screen has no feed at
    // all; prompt on the phone so the on-glasses message is actionable, the
    // same way the Notifications app does.
    if (!isNotificationListenerEnabled()) {
      requestNotificationListenerAccess();
    }
    return ctx.launchInProcessApp(EXOCORTEX_WINDOW_ID, EXOCORTEX_SURFACE_ID, (options) =>
      createExocortexWindow({
        ...options,
        // The same apps the stock launcher grid shows, minus Exocortex
        // itself: it is the surface doing the listing, so a row that
        // re-focuses it would just be a dead entry.
        apps: () =>
          ctx.apps
            .filter((app) => app.showInLauncher !== false && app.appId !== ctx.appId)
            .map((app) => ({
              appId: app.appId,
              label: app.title,
              icon: app.icon,
              renderIcon: app.renderIcon,
            })),
        launchApp: (appId) => ctx.launchApp(appId),
      }),
    );
  },
};

export default exocortexApp;
