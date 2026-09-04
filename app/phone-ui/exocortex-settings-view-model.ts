/**
 * Exocortex's Settings screen on the phone — and, as of 2026-09-03, the only
 * settings surface there is.
 *
 * Chris, having browsed the live UI to check: "all those things in the
 * settings function, there's the settings app that is in the menu of apps, in
 * the exocortex menu. I want those settings to be settings so they should be
 * under the gear, instead of being a separate app that opens on the glasses"
 * — then, sharpening it: "they should be all editable on the phone side
 * without any glasses interaction."
 *
 * So the hand-written Glasses/Display rows this page started with are gone,
 * replaced by every category in ui/settings-catalog — the same definition the
 * glasses panel renders from, which is what keeps the two in step now that the
 * glasses one is unlisted. phone-ui/settings-rows turns each catalogue entry
 * into a row that WRITES: enums cycle, booleans switch, strings are typed into
 * here rather than deferring to the glasses' own text-edit layer.
 *
 * What is still hand-written below is what has no glasses equivalent at all:
 * the notification ignore list, the app-list screen, and the gesture
 * reference.
 */
import { Frame, Observable } from "@nativescript/core";

import { onAnySettingChanged } from "../ui/dashboard-settings";
import { mutedNotificationSourceCount } from "../native/notification-sources";
import { ALL_APPS } from "../apps/all-apps";
import { isAppVisibleInExocortex, isCuratedAppId } from "../native/exocortex-app-list";
import { buildSettingsRows, type PhoneSettingsRow } from "./settings-rows";

export class ExocortexSettingsViewModel extends Observable {
  private offSettingChanged: (() => void) | null = null;
  /**
   * Built once and kept. The rows are Observables in their own right, so a
   * setting changing re-notifies the one row that shows it — rebuilding this
   * list instead would tear down and recreate every view on the page, which
   * among other things makes the API-key fields impossible to type into (see
   * settings-rows.ts's header).
   */
  private readonly _settingsRows: PhoneSettingsRow[] = buildSettingsRows();

  constructor() {
    super();
    this.attach();
  }

  /**
   * Idempotent, because the page reuses its view model across back
   * navigations: navigatingTo re-attaches what unloaded let go, so a model
   * that has been disposed once still tracks changes the next time the page
   * is opened.
   */
  attach(): void {
    if (!this.offSettingChanged) this.offSettingChanged = onAnySettingChanged(() => this.refresh());
    for (const row of this._settingsRows) row.attach();
  }

  dispose(): void {
    this.offSettingChanged?.();
    this.offSettingChanged = null;
    for (const row of this._settingsRows) row.detach();
  }

  get settingsRows(): PhoneSettingsRow[] {
    return this._settingsRows;
  }

  /** Re-read every displayed value. Cheap: they are all setting reads. */
  refresh(): void {
    for (const row of this._settingsRows) row.refresh();
    for (const property of ["notificationSourcesSummary", "appListSummary"]) {
      this.notifyPropertyChange(property, (this as unknown as Record<string, unknown>)[property]);
    }
  }

  // ---- Notifications ----

  get notificationSourcesSummary(): string {
    const muted = mutedNotificationSourceCount();
    if (!muted) return "Nothing muted";
    return muted === 1 ? "1 app muted" : `${muted} apps muted`;
  }

  onNotificationSourcesTap(): void {
    Frame.topmost()?.navigate("phone-ui/notification-sources-page");
  }

  // ---- Apps ----

  get appListSummary(): string {
    const listable = ALL_APPS.filter((app) => app.showInLauncher !== false);
    const shown = listable.filter((app) =>
      isAppVisibleInExocortex(app.appId, isCuratedAppId(app.appId)),
    ).length;
    return `${shown} of ${listable.length} in the list`;
  }

  onAppListTap(): void {
    Frame.topmost()?.navigate("phone-ui/exocortex-apps-page");
  }
}
