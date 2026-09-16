/**
 * The expensive half of the home screen's status-line contract.
 *
 * `statusLine()` runs in the menu's paint path and must be cheap and
 * synchronous (see `app-definition.ts`). Anything that has to read a file,
 * call the network or ask the ring lives in `refreshStatus()` — and this is
 * what calls it, on the shared wall-clock-aligned :01/:31 tick from
 * `util/aligned-tick.ts`.
 *
 * Chris, 2026-09-12 and again 2026-09-15: the refresh behind those lines runs
 * on the aligned 30-minute cycle and refreshes *everything* with a menu line,
 * not just the ring — so this walks the whole registry rather than naming the
 * apps it knows about. An app opts in by defining `refreshStatus`; the rest
 * cost nothing.
 *
 * Boots from `app.ts`, next to the ring pull that rides the same tick.
 */

import { ALL_APPS } from "./all-apps";
import { onAlignedTick, runAlignedTick, startAlignedTick } from "../util/aligned-tick";

/**
 * Refresh every app that has something to refresh.
 *
 * One app's failure must not cost the others theirs, so each is wrapped. The
 * warning names the app, because a silent catch here would turn "Weather's
 * line is missing" into an unexplainable observation on the glasses.
 */
export function refreshAllStatusLines(): void {
  for (const app of ALL_APPS) {
    if (!app.refreshStatus) continue;
    try {
      app.refreshStatus();
    } catch (error) {
      console.warn(`status refresh failed for ${app.appId}`, error);
    }
  }
}

let started = false;

/**
 * Start refreshing the home screen's status lines. Idempotent.
 *
 * ⚠ IT REFRESHES ONCE AT BOOT, not only on the next slot. Without that, a
 * process that started at :02 would show a bare menu until :31 — half an hour
 * of the feature looking broken on every restart, which is exactly when
 * someone is most likely to be looking at it. The cost is one store read and
 * (if the weather app has permission) one forecast fetch at startup.
 */
export function startStatusLineRefresh(): void {
  if (started) return;
  started = true;
  startAlignedTick();
  onAlignedTick(refreshAllStatusLines);
  runAlignedTick();
}
