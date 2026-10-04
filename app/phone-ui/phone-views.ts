/**
 * Which phone view each Exocortex app has, and so which body main-page shows.
 *
 * Design rule 1 (Chris): the phone and the glasses mirror each other, both
 * ways, for every app. Picking an app on either side moves both screens. The
 * glasses half was already general: a phone tap goes through
 * `dashboardController.launchAppFromPhone`, and whatever window the shell has
 * in the foreground comes back to the phone as the snapshot's
 * `foregroundAppId`. The phone half was a hardcoded `=== "ghost"`, so only
 * Ghost moved the phone (audit F1). This table replaces that test.
 *
 * Adding an app's phone view is one row here plus its body in main-page.xml
 * (and a `<id>BodyVisibility` member on MainViewModel to bind it). An app with
 * no row leaves the phone on the app list, which is where it fell back before.
 *
 * Pure on purpose (no NativeScript imports), so tests/phone-body-choice can
 * load it from source.
 */

import type { CompanionDisplayClass } from "../native/fold-state";

/** An app's phone view, by the body that shows it in main-page.xml. */
export type PhoneViewId = "ghost" | "health";

/** Every body main-page can show: the cover glance, an app's view, or the app list. */
export type PhoneBody = "cover" | PhoneViewId | "list";

export type PhoneView = {
  id: PhoneViewId;
  /** The way-back row's title, on the app list after "Exocortex" peeks away. */
  name: string;
  /** The way-back row's second line. */
  returnMeta: string;
};

/** Keyed by registry app id (the shell window's `appId`). */
const PHONE_VIEWS: Readonly<Record<string, PhoneView>> = {
  ghost: {
    id: "ghost",
    name: "Ghost",
    returnMeta: "Back to the companion for the session on the glasses",
  },
  // The graphs that were only a Settings row (audit F5's phone half). The
  // glasses Health app is the one-day glance; these are the history.
  health: {
    id: "health",
    name: "Health",
    returnMeta: "Back to the graphs",
  },
};

export function phoneViewFor(appId: string | null): PhoneView | null {
  if (appId === null) return null;
  // Own keys only: an app id like "constructor" must not find Object.prototype.
  return Object.prototype.hasOwnProperty.call(PHONE_VIEWS, appId) ? PHONE_VIEWS[appId] : null;
}

/**
 * The one body that is up. The fold decides first (shut means the cover
 * glance, whatever the glasses show); then the foreground app's view, unless
 * "Exocortex" in the header is peeking at the app list; otherwise the list.
 */
export function choosePhoneBody(
  displayClass: CompanionDisplayClass,
  foregroundAppId: string | null,
  homeOverride: boolean,
): PhoneBody {
  if (displayClass === "compact") return "cover";
  const view = phoneViewFor(foregroundAppId);
  if (view && !homeOverride) return view.id;
  return "list";
}
