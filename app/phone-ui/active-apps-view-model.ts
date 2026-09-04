/**
 * "Active Apps" — every window currently open on the glasses, with a Close
 * action per closeable entry.
 *
 * The independent, phone-side kill path (built 2026-09-04, after a hung
 * Transcribe window left Chris with no working in-app exit and no way to
 * tell whether the glasses' own escape menu would even open): reachable
 * from Settings with no glasses interaction required, and wired straight to
 * dashboardController.closeWindowFromPhone() -> shell.closeWindow() — the
 * same in-process object, not a second IPC/BLE path, and not gated by
 * whatever state the hung app or the shell's own overlay stack are in.
 *
 * LIVE, not a one-shot reload like ExocortexAppsViewModel's catalogue: this
 * subscribes to dashboardController directly (openWindows rides the same
 * onWindowsChanged re-emit as foregroundAppId/foregroundAppTitle), so a
 * window that closes — from here, from the glasses' own menu, or because
 * the app closed itself — drops off the list without leaving the page and
 * coming back. The catalogue page doesn't need this because it edits static
 * configuration, not live state.
 */
import { Observable } from "@nativescript/core";

import { dashboardController } from "../g2/dashboard-controller";

export type ActiveAppRow = {
  windowId: string;
  appId: string;
  title: string;
  closeable: boolean;
  /** "Tap Close to end it" for a closeable window; explains itself when not. */
  meta: string;
  closeButtonVisibility: "visible" | "collapse";
  onCloseTap: () => void;
};

export class ActiveAppsViewModel extends Observable {
  private _rows: ActiveAppRow[] = [];
  private _status = "";
  private unsubscribe: (() => void) | null = null;

  get rows(): ActiveAppRow[] {
    return this._rows;
  }

  get emptyMessageVisibility(): "visible" | "collapse" {
    return this._rows.length === 0 ? "visible" : "collapse";
  }

  get status(): string {
    return this._status;
  }

  get statusVisibility(): "visible" | "collapse" {
    return this._status ? "visible" : "collapse";
  }

  /** Idempotent — the page calls this from navigatingTo. */
  attach(): void {
    if (this.unsubscribe) return;
    // subscribe() delivers the current snapshot immediately, then again on
    // every onWindowsChanged emission — this rebuild is the whole of how the
    // list stays live.
    this.unsubscribe = dashboardController.subscribe((snapshot) => {
      this._rows = snapshot.openWindows.map((window) => ({
        windowId: window.windowId,
        appId: window.appId,
        title: window.title,
        closeable: window.closeable,
        meta: window.closeable ? "Tap Close to end it on the glasses" : "Open on the glasses — not closeable",
        closeButtonVisibility: window.closeable ? "visible" : "collapse",
        onCloseTap: () => this.close(window.windowId, window.title),
      }));
      this.notifyPropertyChange("rows", this._rows);
      this.notifyPropertyChange("emptyMessageVisibility", this.emptyMessageVisibility);
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private close(windowId: string, title: string): void {
    dashboardController.closeWindowFromPhone(windowId);
    this.setStatus(`Closed ${title}.`);
  }

  private setStatus(status: string): void {
    this._status = status;
    this.notifyPropertyChange("status", this._status);
    this.notifyPropertyChange("statusVisibility", this.statusVisibility);
  }
}
