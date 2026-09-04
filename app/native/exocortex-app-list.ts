/**
 * Which apps Exocortex's PRIMARY app list shows, and in what order.
 *
 * Two of Chris's field-feedback items land on the same piece of state:
 *
 *  - The per-app visibility toggle. His reasoning was "the menu is way too
 *    long": faceclaw ships ~20 stock apps and every one of them shares the
 *    single navigable run on the glasses with the curated Exocortex ones.
 *
 *    HIDDEN MEANS "NOT IN THE PRIMARY LIST", AND NOTHING ELSE. Confirmed
 *    directly with Chris: faceclaw's own apps stay installed and fully
 *    launchable, he only wants them out of the curated list. So this module
 *    is read in exactly one place — the home screen's app run — and nowhere
 *    that decides whether an app can run. Launching is untouched: the
 *    assistant's apps.* tools, the watch remote, open-app restore and the
 *    phone's own app screen all resolve straight through ALL_APPS. The phone
 *    screen (phone-ui/exocortex-apps-page) doubles as the launcher for
 *    everything, hidden apps included, so nothing here can strand an app.
 *
 *  - Drag-and-drop reordering from the design pilot (session 0140), which was
 *    always meant to be shared state — the glasses' own list picks the order
 *    up for free because both surfaces read this module rather than keeping
 *    their own copies.
 *
 * DEFAULTS ARE CURATED, NOT ALL-ON. Chris: the primary list should show only
 * the curated apps by default. So visibility is stored as explicit OVERRIDES
 * and the default comes from CURATED_APP_IDS below — which also means a
 * faceclaw app added by a future upstream merge stays out of the list until
 * it is deliberately let in, rather than silently lengthening the menu again.
 *
 * Order is stored as a partial list. Anything not named in it keeps its
 * registry position after everything that is, so a newly installed app
 * appears at the end instead of vanishing, and clearing the setting restores
 * the registry's own order exactly.
 */
import { getStringSetting, onSettingsStoreChanged, setStringSetting } from "./settings-store";

/** Per-appId true/false overrides. Absence means "use the curated default". */
export const EXOCORTEX_APP_VISIBILITY_KEY = "exocortex.appList.visibility";
export const EXOCORTEX_APP_ORDER_KEY = "exocortex.appList.order";

/**
 * The built-in apps the primary list shows unless told otherwise.
 *
 * Mapped from Chris's own curated six (Ghost, News, Subtitles, Translation,
 * Golf, Health Summary) onto what actually exists in this build, rather than
 * onto the names:
 *
 *   exocortex     the home screen itself, listed as of round 2 so there is a
 *                 named way to get back to its bare notification view. See
 *                 the swap note below.
 *   ghost         Ghost — the real app, already on hardware.
 *   microphones   Subtitles AND Translation AND the voice signature: one
 *                 AppDefinition covering all three (captions-layer.ts,
 *                 translate.ts, speakers.ts).
 *   weather       the one stock app Chris explicitly asked to KEEP
 *                 ("better form than the one in Even's stock app").
 *
 * News, Golf and Health Summary have no app in this build — Golf was an
 * EvenHub package, and EvenHub packages default to visible below because
 * installing one is already a deliberate act.
 *
 * ROUND 2 SWAPPED `notifications` FOR `exocortex`, AND THAT SWAP IS BUILT ON
 * AN UNCONFIRMED READING OF WHAT CHRIS MEANT. His words: "I think Exocortex
 * is basically just 'notifications' — so we can hide the notification option
 * in the menu and maybe have exocortex as one of the apps." The reading: the
 * standalone Notifications entry duplicates what Exocortex's own home screen
 * already shows at rest, while Exocortex itself had no entry at all.
 *
 * What is actually lost is narrower than "notifications": the LIST view
 * (ui/notifications.ts's NotificationsListLayer, several notifications on one
 * screen). The home screen shows one at a time and scrolls through all of
 * them, click still opens the same detail card with its quick actions, and
 * long-press still clears the tray. Nothing about the popup, the ignore list
 * or the top-bar icons touches this.
 *
 * And nothing here uninstalls anything. Hiding means OUT OF THE PRIMARY LIST
 * AND NOTHING ELSE (see the header) — the Notifications app stays registered
 * and launchable from the phone's app screen, the assistant and the watch,
 * and one switch on that screen puts it back in the glasses list. That is why
 * this was safe to build on a reading rather than a confirmation: the cost of
 * being wrong is one toggle, not a rebuild.
 *
 * EDIT THIS LIST to change what a fresh install shows; per-app overrides made
 * on the phone win over it either way.
 */
export const CURATED_APP_IDS: readonly string[] = [
  "exocortex",
  "ghost",
  "microphones",
  "weather",
];

/**
 * `settings` LEFT THIS LIST ON 2026-09-03, and left the launcher entirely
 * (apps/settings/index.ts's showInLauncher). It used to be listed as "the only
 * way to change anything from the glasses alone" — which stopped being true
 * when every one of its settings became editable on the phone, from the gear,
 * with no glasses interaction at all. That was Chris's explicit ask, and the
 * separate glasses-side app was the thing he asked to remove.
 */
export function isCuratedAppId(appId: string): boolean {
  return CURATED_APP_IDS.includes(appId);
}

/**
 * The minimum an entry needs for this module to place it. `defaultVisible`
 * is the caller's answer to "should this be in the list if the wearer has
 * never said": built-ins pass isCuratedAppId, EvenHub packages pass true.
 */
type AppLike = { appId: string; defaultVisible?: boolean };

let overridesCache: Map<string, boolean> | null = null;
let orderCache: string[] | null = null;
let invalidationInstalled = false;

function installInvalidation(): void {
  if (invalidationInstalled) return;
  invalidationInstalled = true;
  onSettingsStoreChanged((key) => {
    if (key === EXOCORTEX_APP_VISIBILITY_KEY) overridesCache = null;
    if (key === EXOCORTEX_APP_ORDER_KEY) orderCache = null;
  });
}

function readStringArray(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(getStringSetting(key, "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => String(entry ?? "")).filter(Boolean);
  } catch {
    // A corrupt value means "no preference", which is the state the app
    // shipped in — never an empty app list.
    return [];
  }
}

function readOverrides(): Map<string, boolean> {
  installInvalidation();
  if (overridesCache) return overridesCache;
  const map = new Map<string, boolean>();
  try {
    const parsed: unknown = JSON.parse(getStringSetting(EXOCORTEX_APP_VISIBILITY_KEY, "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [appId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (appId) map.set(appId, Boolean(value));
      }
    }
  } catch {
    // No preference rather than an empty list: a corrupt value falls back to
    // the curated defaults, which is a working app list either way.
  }
  overridesCache = map;
  return map;
}

function readOrder(): string[] {
  installInvalidation();
  if (!orderCache) orderCache = readStringArray(EXOCORTEX_APP_ORDER_KEY);
  return orderCache;
}

/**
 * Whether this app appears in the PRIMARY list. Never consulted by anything
 * that launches an app — see the header.
 */
export function isAppVisibleInExocortex(appId: string, defaultVisible = isCuratedAppId(appId)): boolean {
  const override = readOverrides().get(appId);
  return override === undefined ? defaultVisible : override;
}

export function setAppVisibleInExocortex(appId: string, visible: boolean): void {
  if (!appId) return;
  const overrides = new Map(readOverrides());
  if (overrides.get(appId) === visible) return;
  overrides.set(appId, visible);
  overridesCache = overrides;
  const object: Record<string, boolean> = {};
  for (const [id, value] of overrides) object[id] = value;
  setStringSetting(EXOCORTEX_APP_VISIBILITY_KEY, JSON.stringify(object));
}

/** Persist a complete ordering. Ids not currently registered are kept. */
export function setExocortexAppOrder(appIds: readonly string[]): void {
  const order = appIds.map((id) => String(id ?? "")).filter(Boolean);
  orderCache = order;
  setStringSetting(EXOCORTEX_APP_ORDER_KEY, JSON.stringify(order));
}

/**
 * Apply the stored order to a registry-ordered list. Stable and total: named
 * entries first in the stored sequence, everything else after in the order it
 * arrived. Never drops or duplicates an entry, whatever the setting contains.
 */
export function sortByExocortexOrder<T extends AppLike>(apps: readonly T[]): T[] {
  const order = readOrder();
  if (!order.length) return apps.slice();
  const rank = new Map<string, number>();
  for (let index = 0; index < order.length; index++) {
    if (!rank.has(order[index]!)) rank.set(order[index]!, index);
  }
  const fallback = order.length;
  return apps
    .map((app, index) => ({ app, index, rank: rank.get(app.appId) ?? fallback }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.app);
}

/** Ordered and filtered: exactly what the home screen's app run should show. */
export function applyExocortexAppList<T extends AppLike>(apps: readonly T[]): T[] {
  return sortByExocortexOrder(apps).filter((app) =>
    isAppVisibleInExocortex(app.appId, app.defaultVisible ?? isCuratedAppId(app.appId)),
  );
}
