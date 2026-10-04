/**
 * Local calendar arithmetic in the phone's CURRENT time zone (2026-10-04).
 *
 * ## Why not `new Date(ms).getHours()`
 *
 * The JS engine keeps the zone its process started in. Measured on the trip
 * home from Japan (ring-clock-fix return, Step 0): hours after landing in the
 * US, receipts written from JS were still stamped `+09:00` while Java's, in the
 * same process at the same moments, said `-0400`. Every `Date` local-time call
 * (`getHours`, `setHours(0, 0, 0, 0)`, `getDate`) answered in Japan time, so
 * the day and night buckets were Japan's: Saturday's plane nap was filed as
 * "last night" and Saturday evening's steps at 10 AM Sunday.
 *
 * Android's Java default zone does follow the phone: the system resets every
 * running process's `TimeZone.getDefault()` when the zone changes. So the
 * offset is read from Java, fresh, and all local-time arithmetic in the health
 * views goes through this module instead of `Date`'s local getters.
 *
 * ## Chris's day rule (2026-10-04)
 *
 * Store everything in absolute time; compute day totals at display time, the
 * way they display, relative to the phone's current clock and zone. Steps,
 * heart rate, HRV, SpO2: local midnight -> midnight. Sleep: 20:00 -> 20:00
 * local, a block belonging to the night its END falls in. The boundaries
 * below are those, and nothing stores a day key computed from them except as
 * a cache that is rebuilt when the zone changes (`health-store.ts`).
 *
 * ## Cost
 *
 * A Java call per instant would be thousands of bridge crossings for one
 * rollup rebuild. So the zone is re-read at most once a second, and the
 * offset is memoised per quarter-hour of UTC while the zone id is unchanged.
 * Every real zone's transitions fall on a quarter hour.
 *
 * No NativeScript imports: under node (tests) there is no `java` global and
 * the JS engine's own zone is used, which there is `process.env.TZ`.
 */

declare const java: any;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const QUARTER_HOUR_MS = 900_000;
/** How long a read of the zone is trusted before Java is asked again. */
const ZONE_REFRESH_MS = 1000;

type ZoneReader = { id: string; offsetMs: (utcMs: number) => number };

let cachedReader: ZoneReader | null = null;
let cachedAtMs = Number.NEGATIVE_INFINITY;
const offsetMemo = new Map<number, number>();

function javaReader(): ZoneReader | null {
  try {
    if (typeof java === "undefined" || !java?.util?.TimeZone) return null;
    const zone = java.util.TimeZone.getDefault();
    const id = String(zone.getID());
    return { id, offsetMs: (utcMs: number) => Number(zone.getOffset(utcMs)) };
  } catch {
    return null;
  }
}

function engineReader(): ZoneReader {
  let id = "engine";
  try {
    id = `engine:${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  } catch {
    // An engine without Intl still answers getTimezoneOffset.
  }
  return { id, offsetMs: (utcMs: number) => -new Date(utcMs).getTimezoneOffset() * MINUTE_MS };
}

function reader(): ZoneReader {
  const now = Date.now();
  if (cachedReader && now - cachedAtMs < ZONE_REFRESH_MS && now >= cachedAtMs) return cachedReader;
  const next = javaReader() ?? engineReader();
  if (!cachedReader || cachedReader.id !== next.id) offsetMemo.clear();
  cachedReader = next;
  cachedAtMs = now;
  return next;
}

/** The phone's current zone id (Java's), e.g. "America/New_York". */
export function currentZoneId(): string {
  return reader().id;
}

/** Milliseconds the current zone is ahead of UTC at instant `utcMs`. */
export function zoneOffsetMs(utcMs: number): number {
  const zone = reader();
  const key = Math.floor(utcMs / QUARTER_HOUR_MS);
  const held = offsetMemo.get(key);
  if (held !== undefined) return held;
  const offset = zone.offsetMs(key * QUARTER_HOUR_MS);
  if (offsetMemo.size > 20000) offsetMemo.clear();
  offsetMemo.set(key, offset);
  return offset;
}

export type LocalFields = {
  year: number;
  /** 0-11, as `Date`. */
  month: number;
  date: number;
  /** 0 = Sunday, as `Date`. */
  weekday: number;
  hours: number;
  minutes: number;
};

/** The wall-clock reading of `ms` in the current zone. */
export function localFields(ms: number): LocalFields {
  const wall = new Date(ms + zoneOffsetMs(ms));
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth(),
    date: wall.getUTCDate(),
    weekday: wall.getUTCDay(),
    hours: wall.getUTCHours(),
    minutes: wall.getUTCMinutes(),
  };
}

/**
 * The instant a local wall-clock reading names, in the current zone. Fields
 * overflow as `Date.UTC` does (`date + 1` past month end is fine). A reading
 * inside a spring-forward gap resolves to the instant after the gap.
 */
export function localToMs(year: number, month: number, date: number, hours = 0, minutes = 0): number {
  const wall = Date.UTC(year, month, date, hours, minutes);
  const first = wall - zoneOffsetMs(wall);
  const second = wall - zoneOffsetMs(first);
  if (first === second) return first;
  // Across a transition: take the reading that maps back to `wall`, else the later.
  if (second + zoneOffsetMs(second) === wall) return second;
  if (first + zoneOffsetMs(first) === wall) return first;
  return Math.max(first, second);
}

/** Local midnight of the day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const f = localFields(ms);
  return localToMs(f.year, f.month, f.date);
}

/** Local top-of-hour containing `ms` (exact, also in a repeated DST hour). */
export function startOfLocalHour(ms: number): number {
  const wall = ms + zoneOffsetMs(ms);
  return ms - (((wall % HOUR_MS) + HOUR_MS) % HOUR_MS);
}

/** Local midnight `days` calendar days after the local day containing `dayMs`. */
export function addLocalDays(dayMs: number, days: number): number {
  const f = localFields(dayMs);
  return localToMs(f.year, f.month, f.date + days);
}

/** The next local top-of-hour after the hour containing `ms`. */
export function nextLocalHour(ms: number): number {
  return startOfLocalHour(startOfLocalHour(ms) + HOUR_MS);
}

/** Local midnight of the first day of the month containing `ms`, `months` later. */
export function addLocalMonths(ms: number, months: number): number {
  const f = localFields(ms);
  return localToMs(f.year, f.month + months, 1);
}

/** For tests: forget the cached zone so the next call reads it again. */
export function __resetZoneCache(): void {
  cachedReader = null;
  cachedAtMs = Number.NEGATIVE_INFINITY;
  offsetMemo.clear();
}

export const __zoneInternals = { ZONE_REFRESH_MS };
