/**
 * "Notification sources" — Chris's explicit top priority from the 2026-08-31
 * field feedback: persistent notifications (his examples: Tailscale's
 * connection status, the Tesla app) keep resurfacing and eating the field of
 * view, and there was no way to stop them.
 *
 * This screen is the pilot's design (session 0142) on the real feed. The list
 * is DISCOVERED, not declared: a source appears here the first time it
 * actually posts a notification, which is also the only moment its display
 * name is known. That is why a brand-new install shows a short list that
 * grows over the first day of use rather than every app on the phone.
 *
 * Toggling a source off is enforced in native/notification-sources.ts and
 * applies at every point a notification could reach the glasses — the popup,
 * the home screen's run, the Notifications app, and the top bar's icon row.
 * Muting is not a UI state here; it is the thing that stops the interrupt.
 */
import { Observable } from "@nativescript/core";

import {
  listNotificationSources,
  setNotificationSourceEnabled,
} from "../native/notification-sources";
// Reading the tray is what populates the list, so opening this screen with a
// notification sitting in the shade discovers its source immediately rather
// than at the next paint on the glasses.
import { readAllActiveNotifications } from "../native/notification-icons";

export type NotificationSourceRow = {
  packageName: string;
  appName: string;
  /** Sub-line: the package id, which is what disambiguates two similar names. */
  meta: string;
  enabled: boolean;
  onCheckedChange: (args: { object: { checked: boolean } }) => void;
};

export class NotificationSourcesViewModel extends Observable {
  private _rows: NotificationSourceRow[] = [];

  get rows(): NotificationSourceRow[] {
    return this._rows;
  }

  get emptyVisibility(): "visible" | "collapse" {
    return this._rows.length ? "collapse" : "visible";
  }

  get emptyMessage(): string {
    return (
      "No sources discovered yet. This list fills in as apps actually post " +
      "notifications — it is built from what arrives, not from a fixed list of " +
      "installed apps, so give it a little ordinary use and come back."
    );
  }

  reload(): void {
    readAllActiveNotifications();
    this._rows = listNotificationSources().map((source) => ({
      packageName: source.packageName,
      appName: source.appName,
      meta: source.appName === source.packageName ? "" : source.packageName,
      enabled: source.enabled,
      onCheckedChange: (args) => {
        const checked = Boolean(args?.object?.checked);
        // The Switch fires on programmatic assignment too, so writing only on
        // a real change keeps a reload from looking like a user toggle.
        setNotificationSourceEnabled(source.packageName, checked);
      },
    }));
    this.notifyPropertyChange("rows", this._rows);
    this.notifyPropertyChange("emptyVisibility", this.emptyVisibility);
  }
}
