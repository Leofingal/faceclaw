import { shell } from "../../ui/shell/shell";
import { type AppDefinition } from "../app-definition";
import {
  createSettingsAppWindow,
  SETTINGS_SURFACE_ID,
  SETTINGS_WINDOW_ID,
  type SettingsAppWindow,
} from "./settings-app";

// The Settings app is a singleton; tracked so a relaunch with a section
// deep-link can focus that section in the open window.
let activeSettingsApp: SettingsAppWindow | null = null;

const settingsApp: AppDefinition = {
  appId: "settings",
  title: "Settings",
  icon: "settings",
  /**
   * NOT IN THE APP MENU ANY MORE (2026-09-03). Chris, having gone looking for
   * where settings live: "there's the settings app that is in the menu of
   * apps, in the exocortex menu. I want those settings to be settings so they
   * should be under the gear, instead of being a separate app that opens on
   * the glasses" — and "they should be all editable on the phone side without
   * any glasses interaction."
   *
   * Everything this app shows is now on the phone's own Settings page
   * (phone-ui/exocortex-settings-*), generated from the same ui/settings-
   * catalogue this app's panel renders from, so nothing was lost in the move.
   *
   * The app itself is deliberately still REGISTERED rather than deleted: the
   * assistant's openSettings(section) deep link goes through launchApp, and an
   * unlisted app is exactly what that flag means everywhere else in this
   * registry (terminal, calculator, evenhub). Unlisting is also the reversible
   * version of the decision — putting it back is this one line.
   */
  showInLauncher: false,
  launch: async (ctx, params) => {
    if (activeSettingsApp) {
      if (params?.section) activeSettingsApp.focusSection(params.section);
      shell.focusWindow(SETTINGS_WINDOW_ID);
      ctx.requestShellRender();
      return;
    }
    await ctx.launchInProcessApp(SETTINGS_WINDOW_ID, SETTINGS_SURFACE_ID, (options) => {
      const app = createSettingsAppWindow({
        ...options,
        onClosed: () => {
          // Closing mid-edit must not leave the phone-side editor dangling.
          void options.actions.endTextSettingEdit();
          ctx.setTextEditorHost(null);
          activeSettingsApp = null;
          options.onClosed();
        },
      });
      activeSettingsApp = app;
      // The controller echoes phone-side edits into the glasses editor.
      ctx.setTextEditorHost(app);
      return app.inProcess;
    });
    if (params?.section) activeSettingsApp?.focusSection(params.section);
  },
};

export default settingsApp;
