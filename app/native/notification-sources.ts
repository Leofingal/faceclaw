/**
 * The notification ignore list: which Android apps are allowed to put a
 * notification in front of the wearer.
 *
 * Chris's complaint this exists for: persistent/ongoing notifications
 * (Tailscale's connection status, the Tesla app) keep resurfacing and eat the
 * field of view. Muting one has to actually stop it reaching the glasses, not
 * just grey out a row in a settings screen.
 *
 * THE LIST IS DISCOVERED, NOT DECLARED. Android has no "apps that might
 * notify you" query worth using, and a hand-typed catalogue would go stale the
 * first time a new app is installed. So a source is recorded the first time it
 * actually posts something, which is also the only moment we know its display
 * name. New sources default to enabled — "shown until you say otherwise" —
 * which is what makes muting a deliberate act and keeps a brand-new app from
 * being silently swallowed.
 *
 * Two settings rather than one blob, because they change at very different
 * rates: `seen` grows on its own as notifications arrive, `muted` only when
 * the wearer touches a toggle. Keeping them apart means the passive discovery
 * write can never clobber a toggle made a moment earlier from the other
 * surface.
 */
import { getStringSetting, onSettingsStoreChanged, setStringSetting } from "./settings-store";

/** packageName -> display name, everything that has ever posted a notification. */
export const NOTIFICATION_SOURCES_SEEN_KEY = "exocortex.notifSources.seen";
/** packageNames the wearer has muted. Absence means enabled. */
export const NOTIFICATION_SOURCES_MUTED_KEY = "exocortex.notifSources.muted";

/** How many discovered sources are kept. Oldest-seen are dropped past this. */
const MAX_REMEMBERED_SOURCES = 200;

export type NotificationSource = {
  packageName: string;
  /** The app's display name, as the notification reported it. */
  appName: string;
  /** False when muted: nothing from this package reaches the glasses. */
  enabled: boolean;
};

/** Anything carrying the two fields a source is identified by. */
type SourceLike = { packageName: string; appName: string };

// --- Cache, invalidated by the settings broadcast -------------------------

let seenCache: Map<string, string> | null = null;
let mutedCache: Set<string> | null = null;
let invalidationInstalled = false;

function installInvalidation(): void {
  if (invalidationInstalled) return;
  invalidationInstalled = true;
  onSettingsStoreChanged((key) => {
    if (key === NOTIFICATION_SOURCES_SEEN_KEY) seenCache = null;
    if (key === NOTIFICATION_SOURCES_MUTED_KEY) mutedCache = null;
  });
}

function readSeen(): Map<string, string> {
  installInvalidation();
  if (seenCache) return seenCache;
  const map = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(getStringSetting(NOTIFICATION_SOURCES_SEEN_KEY, "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [packageName, appName] of Object.entries(parsed as Record<string, unknown>)) {
        if (packageName) map.set(packageName, String(appName ?? packageName));
      }
    }
  } catch {
    // A corrupt value is treated as "nothing discovered yet"; it refills from
    // the live feed within one notification rather than needing a repair step.
  }
  seenCache = map;
  return map;
}

function readMuted(): Set<string> {
  installInvalidation();
  if (mutedCache) return mutedCache;
  const set = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(getStringSetting(NOTIFICATION_SOURCES_MUTED_KEY, "[]"));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const packageName = String(entry ?? "");
        if (packageName) set.add(packageName);
      }
    }
  } catch {
    // Same reasoning as readSeen, with the safer failure direction: an
    // unreadable mute list shows everything rather than hiding everything.
  }
  mutedCache = set;
  return set;
}

function writeSeen(map: Map<string, string>): void {
  const object: Record<string, string> = {};
  for (const [packageName, appName] of map) object[packageName] = appName;
  seenCache = map;
  setStringSetting(NOTIFICATION_SOURCES_SEEN_KEY, JSON.stringify(object));
}

function writeMuted(set: Set<string>): void {
  mutedCache = set;
  setStringSetting(NOTIFICATION_SOURCES_MUTED_KEY, JSON.stringify(Array.from(set)));
}

// --- API ------------------------------------------------------------------

/**
 * Learn from a batch of live notifications. Called on every read of the feed,
 * so it must stay cheap: the common case is a map lookup per notification and
 * no write at all. Only a genuinely new package (or one whose display name
 * changed, e.g. after a locale switch) touches the settings store.
 */
export function recordNotificationSources(notifications: readonly SourceLike[]): void {
  if (!notifications.length) return;
  const seen = readSeen();
  let changed = false;
  for (const notification of notifications) {
    const packageName = notification.packageName;
    if (!packageName) continue;
    const appName = notification.appName || packageName;
    if (seen.get(packageName) === appName) continue;
    seen.set(packageName, appName);
    changed = true;
  }
  if (!changed) return;
  // Map iteration order is insertion order, so trimming from the front drops
  // the longest-ago-discovered sources first.
  while (seen.size > MAX_REMEMBERED_SOURCES) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  writeSeen(seen);
}

/** True unless the wearer has explicitly muted this package. */
export function isNotificationSourceEnabled(packageName: string): boolean {
  if (!packageName) return true;
  return !readMuted().has(packageName);
}

export function setNotificationSourceEnabled(packageName: string, enabled: boolean): void {
  if (!packageName) return;
  const muted = new Set(readMuted());
  if (enabled) {
    if (!muted.delete(packageName)) return;
  } else {
    if (muted.has(packageName)) return;
    muted.add(packageName);
  }
  writeMuted(muted);
}

/**
 * Every source discovered so far, enabled ones and muted ones alike, sorted by
 * display name. This is what the phone's "Notification sources" screen lists;
 * a muted source has to stay listed or there would be no way to unmute it.
 */
export function listNotificationSources(): NotificationSource[] {
  const muted = readMuted();
  const sources: NotificationSource[] = [];
  for (const [packageName, appName] of readSeen()) {
    sources.push({ packageName, appName, enabled: !muted.has(packageName) });
  }
  // A muted package that has not posted since the app was installed would
  // otherwise vanish from the list and become unmutable.
  for (const packageName of muted) {
    if (!sources.some((source) => source.packageName === packageName)) {
      sources.push({ packageName, appName: packageName, enabled: false });
    }
  }
  return sources.sort((a, b) => a.appName.localeCompare(b.appName));
}

/** Drop everything from a muted source. The one function the HUD paths call. */
export function filterEnabledNotifications<T extends { packageName: string }>(
  notifications: readonly T[],
): T[] {
  const muted = readMuted();
  if (!muted.size) return notifications.slice();
  return notifications.filter((notification) => !muted.has(notification.packageName));
}

/** How many discovered sources are currently muted, for a settings summary line. */
export function mutedNotificationSourceCount(): number {
  return readMuted().size;
}
