/**
 * "Apps" — one unified list of everything faceclaw exposes, curated Exocortex
 * apps and faceclaw's own stock apps alike, each row doing three things:
 *
 *   TAP THE ROW      launch it on the glasses. Always available, for every
 *                    app, whether or not it is in the primary list.
 *   THE SWITCH       whether it appears in the glasses' PRIMARY app list.
 *   ∧ / ∨            where it sits in that list.
 *
 * Confirmed with Chris directly (2026-08-31), correcting the narrower reading
 * this started from: faceclaw's stock apps stay installed and fully
 * launchable — he only wants them out of the curated list, which by default
 * shows the curated apps alone ("the menu is way too long"). So the switch
 * controls list membership and nothing else, and THIS SCREEN IS THE LAUNCH
 * PATH that makes hiding safe. Also confirmed: one list covering everything,
 * not a curated list for reordering plus a separate stock list for toggling.
 *
 * Both controls are shared state with the glasses
 * (native/exocortex-app-list.ts), so a change here shows on the lens with no
 * syncing step.
 *
 * REORDERING IS DONE WITH MOVE BUTTONS, NOT A TOUCH DRAG — a deliberate
 * substitution for the pilot's drag handle, flagged rather than passed off as
 * the same thing. NativeScript has no reorderable list; a real drag means
 * hand-rolling long-press-to-lift, autoscroll and drop-target maths, and I
 * have no way to put a finger on this screen before it ships. The buttons
 * deliver what the ask is actually for — the order, shared with the lens —
 * with behaviour that can be read off the code. Worth revisiting with the
 * real phone in hand.
 */
import { Observable } from "@nativescript/core";

import { ALL_APPS } from "../apps/all-apps";
import { dashboardController } from "../g2/dashboard-controller";
import { getInstalledEvenHubApps, installedEvenHubAppId } from "../apps/evenhub/installed-apps";
import {
  isAppVisibleInExocortex,
  isCuratedAppId,
  setAppVisibleInExocortex,
  setExocortexAppOrder,
  sortByExocortexOrder,
} from "../native/exocortex-app-list";

export type ExocortexAppRow = {
  appId: string;
  title: string;
  visible: boolean;
  /** Sub-line: where it currently is, and that tapping opens it either way. */
  meta: string;
  upVisibility: "visible" | "hidden";
  downVisibility: "visible" | "hidden";
  onRowTap: () => void;
  onCheckedChange: (args: { object: { checked: boolean } }) => void;
  onMoveUpTap: () => void;
  onMoveDownTap: () => void;
};

type Candidate = { appId: string; title: string; defaultVisible: boolean };

export class ExocortexAppsViewModel extends Observable {
  private _rows: ExocortexAppRow[] = [];
  private _status = "";

  get rows(): ExocortexAppRow[] {
    return this._rows;
  }

  get status(): string {
    return this._status;
  }

  get statusVisibility(): "visible" | "collapse" {
    return this._status ? "visible" : "collapse";
  }

  /**
   * Everything launchable, in the current list order. Same two runs the home
   * screen builds from (apps/exocortex/index.ts): the built-ins that opt into
   * a launcher listing, then the installed EvenHub packages. An app that
   * hides itself from the launcher — Exocortex itself, the stock grid — is
   * not the wearer's to place, so it is not here either.
   */
  private orderedApps(): Candidate[] {
    const builtIns: Candidate[] = ALL_APPS.filter((app) => app.showInLauncher !== false).map((app) => ({
      appId: app.appId,
      title: app.title,
      defaultVisible: isCuratedAppId(app.appId),
    }));
    const packages: Candidate[] = getInstalledEvenHubApps().map((app) => ({
      appId: installedEvenHubAppId(app.packageId),
      title: app.name,
      defaultVisible: true,
    }));
    return sortByExocortexOrder([...builtIns, ...packages]);
  }

  reload(): void {
    const apps = this.orderedApps();
    this._rows = apps.map((app, index) => {
      const visible = isAppVisibleInExocortex(app.appId, app.defaultVisible);
      return {
        appId: app.appId,
        title: app.title,
        visible,
        meta: visible
          ? `#${index + 1} in the glasses list · tap to open`
          : "Not in the glasses list · tap to open",
        upVisibility: index === 0 ? "hidden" : "visible",
        downVisibility: index === apps.length - 1 ? "hidden" : "visible",
        onRowTap: () => this.launch(app.appId, app.title),
        onCheckedChange: (args) => {
          const checked = Boolean(args?.object?.checked);
          // The Switch fires on programmatic assignment too, and reload()
          // rebuilds every row — so writing only on a real change keeps a
          // reload from looping back through here as a fake user toggle.
          if (checked === isAppVisibleInExocortex(app.appId, app.defaultVisible)) return;
          setAppVisibleInExocortex(app.appId, checked);
          this.reload();
        },
        onMoveUpTap: () => this.move(app.appId, -1),
        onMoveDownTap: () => this.move(app.appId, 1),
      };
    });
    this.notifyPropertyChange("rows", this._rows);
  }

  /** Open an app on the glasses. The path that keeps hiding safe. */
  private launch(appId: string, title: string): void {
    this.setStatus(`Opening ${title} on the glasses…`);
    void dashboardController
      .launchAppFromPhone(appId)
      .then(() => this.setStatus(`${title} is open on the glasses.`))
      .catch(() => this.setStatus(`Could not open ${title}.`));
  }

  private setStatus(status: string): void {
    this._status = status;
    this.notifyPropertyChange("status", this._status);
    this.notifyPropertyChange("statusVisibility", this.statusVisibility);
  }

  /**
   * Move one app one place. The whole current order is written back, not just
   * the pair that swapped, so the stored list stays a complete ordering and a
   * later registry change cannot reshuffle everything around a partial one.
   */
  private move(appId: string, delta: number): void {
    const ids = this.orderedApps().map((app) => app.appId);
    const from = ids.indexOf(appId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    setExocortexAppOrder(ids);
    this.reload();
  }
}
