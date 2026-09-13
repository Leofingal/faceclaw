/**
 * Every derived number the two health surfaces show, in one place, with no
 * NativeScript imports so it runs under plain node in `tests/`.
 *
 * The rule this file follows throughout: show what the ring actually said, or
 * say we do not know. Nothing here invents a value to fill a gap, and the one
 * composite score a health app is expected to have - a 0-100 "sleep quality" -
 * is deliberately absent. See `sleepSummary` for why.
 */

import {
  DAY_MS,
  HOUR_MS,
  type HealthSample,
  type Rollup,
  type RollupPoint,
  type SampleMetric,
  type SleepNight,
  type SleepSegment,
  type SleepSession,
  isCumulative,
  rollupOf,
  sleepNightDayStartMs,
  startOfLocalDay,
  startOfLocalHour,
} from "./health-types";
import { STAGE_DISPLAY_ORDER, type SleepStageName, stageNameForId } from "./sleep-stages";

export type Granularity = "hour" | "day";

/** How far back a chart looks. Hour granularity only makes sense within a day. */
export type RangeKey = "day" | "week" | "month" | "quarter";

export const RANGE_DAYS: Readonly<Record<RangeKey, number>> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
};

export const RANGE_LABELS: Readonly<Record<RangeKey, string>> = {
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "3 months",
};

/**
 * Bucket samples into a series of rollups on a fixed grid.
 *
 * The grid is built first and then filled, so a window with no data comes back
 * as a gap (`count === 0`) at its real position rather than being silently
 * dropped - a chart that closes over its gaps lies about continuity, which for
 * a ring that is taken off to charge is the common case, not an edge case.
 */
export function rollupSeries(
  samples: readonly HealthSample[],
  options: {
    metric: SampleMetric;
    granularity: Granularity;
    /** Inclusive local start of the plotted window. */
    startMs: number;
    /** Exclusive local end. */
    endMs: number;
  },
): RollupPoint[] {
  const { metric, granularity, startMs, endMs } = options;
  const spanMs = granularity === "hour" ? HOUR_MS : DAY_MS;
  const align = granularity === "hour" ? startOfLocalHour : startOfLocalDay;

  const buckets = new Map<number, HealthSample[]>();
  for (const sample of samples) {
    if (sample.metric !== metric) continue;
    if (sample.startMs < startMs || sample.startMs >= endMs) continue;
    const key = align(sample.startMs);
    const list = buckets.get(key);
    if (list) list.push(sample);
    else buckets.set(key, [sample]);
  }

  const points: RollupPoint[] = [];
  // Walk by calendar step rather than adding spanMs, so a DST change does not
  // shift every later bucket by an hour.
  let cursor = align(startMs);
  let guard = 0;
  while (cursor < endMs && guard < 4000) {
    guard += 1;
    const inBucket = buckets.get(cursor) ?? [];
    const rolled = rollupOf(inBucket);
    points.push({
      startMs: cursor,
      spanMs,
      ...(rolled ?? { min: 0, max: 0, avg: 0, sum: 0, count: 0 }),
    });
    cursor = nextBucketStart(cursor, granularity);
  }
  return points;
}

function nextBucketStart(startMs: number, granularity: Granularity): number {
  const date = new Date(startMs);
  if (granularity === "hour") date.setHours(date.getHours() + 1, 0, 0, 0);
  else date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** The value a chart plots as "the" line for a metric. */
export function primaryValue(point: Rollup, metric: SampleMetric): number {
  return isCumulative(metric) ? point.sum : point.avg;
}

// ===========================================================================
// The glasses status page's numbers

export type MetricSummary = {
  min: number;
  max: number;
  avg: number;
  /** False when nothing was recorded - the UI shows a dash, not a zero. */
  hasData: boolean;
};

export type DailySummary = {
  dayStartMs: number;
  steps: number;
  calories: number;
  heartRate: MetricSummary;
  spo2: MetricSummary;
  /**
   * ⚠ ADDED 2026-09-10. The first pass left HRV off the glance because Chris's
   * original spec listed steps/calories/HR/SpO2/sleep and nothing else, and the
   * return doc flagged the absence as deliberate rather than an oversight. He
   * revised the spec on review: HRV gets a line alongside the others.
   */
  hrv: MetricSummary;
  sleep: SleepSummary | null;
};

const NO_DATA: MetricSummary = { min: 0, max: 0, avg: 0, hasData: false };

function summarise(samples: readonly HealthSample[], metric: SampleMetric): MetricSummary {
  const rolled = rollupOf(samples.filter((sample) => sample.metric === metric));
  if (!rolled) return NO_DATA;
  return { min: rolled.min, max: rolled.max, avg: rolled.avg, hasData: true };
}

function sumOf(samples: readonly HealthSample[], metric: SampleMetric): number {
  let total = 0;
  for (const sample of samples) if (sample.metric === metric) total += sample.total;
  return total;
}

/**
 * Everything the glasses glance shows, for one local day.
 *
 * `sleepSessions` is assembled into the night that ENDED on this day - the
 * "last night's sleep" a morning glance means: every block whose end falls in
 * the 20:00 -> 20:00 window, gaps counted as wake. See `assembleNights`.
 *
 * ⚠ CHANGED 2026-09-13. This used to pick the LONGEST single session of the
 * day, which showed one block of a night that has several.
 */
export function dailySummary(
  samples: readonly HealthSample[],
  sleepSessions: readonly SleepSession[],
  dayStartMs: number,
): DailySummary {
  const dayEndMs = nextBucketStart(dayStartMs, "day");
  const inDay = samples.filter(
    (sample) => sample.startMs >= dayStartMs && sample.startMs < dayEndMs,
  );
  const night = assembleNight(sleepSessions, dayStartMs);
  return {
    dayStartMs,
    steps: Math.round(sumOf(inDay, "steps")),
    calories: Math.round(sumOf(inDay, "calories")),
    heartRate: summarise(inDay, "heartRate"),
    spo2: summarise(inDay, "spo2"),
    hrv: summarise(inDay, "hrv"),
    sleep: night ? sleepSummary(night) : null,
  };
}

// ===========================================================================
// Sleep

export type SleepSummary = {
  totalSec: number;
  /** Whole hours and remaining minutes of `totalSec`, for "6h 42m". */
  hours: number;
  minutes: number;
  wakeSec: number;
  /** Percentages OF TOTAL SLEEP TIME, from the record's named totals. */
  remPercent: number;
  lightPercent: number;
  deepPercent: number;
  /**
   * `total_time / (total_time + wake_time)`, as a percentage.
   *
   * This is sleep efficiency as the AASM's actigraphy scoring defines it -
   * time asleep over time in bed - and it is a decades-old published standard,
   * not something invented here. It is the one number added beyond Chris's
   * stated spec, and it is included precisely because it is the opposite of
   * the thing that was ruled out: it has a definition anyone can look up.
   *
   * Deliberately NOT here: a single 0-100 "sleep quality" score. Every
   * consumer wearable has one, none of them publish the blend, and there is no
   * generally-accepted formula - so it would be a number with the authority of
   * a measurement and the content of an opinion. Stage percentages and
   * efficiency are shown as themselves instead.
   */
  efficiencyPercent: number;
  /** Hypnogram bands, in display order. Empty when the record had no segments. */
  stageBands: readonly SleepStageBand[];
  /** False when the session could not be anchored to real wall-clock time. */
  timeResolved: boolean;
};

export type SleepStageBand = {
  stage: SleepStageName;
  seconds: number;
  /** Share of total-time-in-bed (sleep + wake), so the bands sum to 100%. */
  percentOfBed: number;
};

export function sleepSummary(session: SleepSession): SleepSummary {
  const total = Math.max(0, session.totalSec);
  const wake = Math.max(0, session.wakeSec);
  const inBed = total + wake;
  const pctOfSleep = (value: number): number => (total > 0 ? (value / total) * 100 : 0);
  const bedSeconds: Record<SleepStageName, number> = {
    wake,
    rem: Math.max(0, session.remSec),
    light: Math.max(0, session.lightSec),
    deep: Math.max(0, session.deepSec),
  };
  return {
    totalSec: total,
    hours: Math.floor(total / 3600),
    minutes: Math.round((total % 3600) / 60),
    wakeSec: wake,
    remPercent: pctOfSleep(session.remSec),
    lightPercent: pctOfSleep(session.lightSec),
    deepPercent: pctOfSleep(session.deepSec),
    efficiencyPercent: inBed > 0 ? (total / inBed) * 100 : 0,
    stageBands: STAGE_DISPLAY_ORDER.map((stage) => ({
      stage,
      seconds: bedSeconds[stage],
      percentOfBed: inBed > 0 ? (bedSeconds[stage] / inBed) * 100 : 0,
    })),
    timeResolved: session.timeResolved,
  };
}

/**
 * One stage's seconds, from the summary's own bands.
 *
 * Both surfaces label a stage lane with its duration, and both must take that
 * number from the record's NAMED per-stage fields (which `sleepSummary` already
 * resolved into `stageBands`) rather than by summing the hypnogram's blocks.
 * The two should agree; when they do not it is the segment array that is
 * suspect, because summing blocks depends on the stage-id mapping and the named
 * fields do not. See `sleep-stages.ts`.
 */
export function stageSeconds(stage: SleepStageName, summary: SleepSummary): number {
  return summary.stageBands.find((band) => band.stage === stage)?.seconds ?? 0;
}

// ---------------------------------------------------------------------------
// Night assembly

/**
 * One night built from every sleep block that belongs to it. Shaped as a
 * `SleepSession`, so `sleepSummary` and `hypnogram` take it unchanged.
 */
export type AssembledNight = SleepSession & {
  /** The distinct blocks it was built from, earliest first, after supersession. */
  blocks: readonly SleepSession[];
  /** Gap time between blocks, in seconds, already counted into `wakeSec`. */
  gapSec: number;
};

/** Which night a stored block belongs to. See `assembleNights`. */
function nightKeyOf(session: SleepSession): number {
  return session.timeResolved ? sleepNightDayStartMs(session.endMs) : session.dayStartMs;
}

/**
 * Stored sleep blocks -> nights, newest night first. Chris's spec, 2026-09-13:
 *
 * 1. **A night is the 20:00 -> 20:00 window, labelled by the day it ends in.**
 *    Every block whose END falls in the window belongs to it
 *    (`sleepNightDayStartMs`). Re-derived from `endMs` here rather than read off
 *    the stored `dayStartMs`, so rows stored under the old midnight rule group
 *    correctly with no migration. An UNRESOLVED block has no wall-clock end and
 *    is grouped by its stored `dayStartMs` instead.
 *
 * 2. **Blocks sharing a start time are ONE block that grew.** The ring re-sends
 *    a block as it extends (measured 2026-09-13: the same start delivered
 *    ending 07:15 and then 09:09). The latest/longest supersedes; it never
 *    sums.
 *
 * 3. **Gaps between distinct blocks count as WAKE time**, which is what Even's
 *    app did. A gap is inserted into the segment run as its own wake segment
 *    (`gap: true`) so the hypnogram spans the whole night in order, and added
 *    to `wakeSec` so the lanes, the efficiency and the stage totals all agree.
 *    It is rounded to whole half-minutes, the resolution of every other
 *    segment, which keeps `sum(halfMinutes) * 30 == totalSec + wakeSec` true.
 *
 * Two defensive rules with no measurement behind them, flagged as such: a
 * block wholly inside an earlier one is dropped as a duplicate, and resolved
 * and unresolved blocks are never mixed in one night (the resolved ones win),
 * because their times are on different clocks. A PARTIAL overlap between two
 * blocks is kept as-is with no gap and would double-count the overlap; nothing
 * seen so far produces one.
 */
export function assembleNights(sessions: readonly SleepSession[]): AssembledNight[] {
  const byNight = new Map<number, SleepSession[]>();
  for (const session of sessions) {
    const key = nightKeyOf(session);
    const list = byNight.get(key);
    if (list) list.push(session);
    else byNight.set(key, [session]);
  }
  const nights: AssembledNight[] = [];
  for (const [key, group] of byNight) nights.push(assembleGroup(key, group));
  return nights.sort((a, b) => b.dayStartMs - a.dayStartMs);
}

/** The assembled night that ends on `dayStartMs`, or null when there is none. */
export function assembleNight(
  sessions: readonly SleepSession[],
  dayStartMs: number,
): AssembledNight | null {
  return assembleNights(sessions).find((night) => night.dayStartMs === dayStartMs) ?? null;
}

function assembleGroup(dayStartMs: number, group: readonly SleepSession[]): AssembledNight {
  const resolved = group.filter((session) => session.timeResolved);
  const pool = resolved.length > 0 ? resolved : group;

  // Rule 2: one block per start time, the one that reaches furthest.
  const byStart = new Map<number, SleepSession>();
  for (const session of pool) {
    const held = byStart.get(session.startMs);
    const longer =
      !held ||
      session.endMs > held.endMs ||
      (session.endMs === held.endMs &&
        session.totalSec + session.wakeSec >= held.totalSec + held.wakeSec);
    if (longer) byStart.set(session.startMs, session);
  }
  const ordered = [...byStart.values()].sort((a, b) => a.startMs - b.startMs);
  const blocks: SleepSession[] = [];
  for (const block of ordered) {
    const previous = blocks[blocks.length - 1];
    if (previous && block.endMs <= previous.endMs) continue;
    blocks.push(block);
  }

  // Rule 3: concatenate, with each gap as a wake segment.
  const segments: SleepSegment[] = [];
  let gapSec = 0;
  let totalSec = 0;
  let wakeSec = 0;
  let remSec = 0;
  let lightSec = 0;
  let deepSec = 0;
  blocks.forEach((block, index) => {
    if (index > 0) {
      const gapHalfMinutes = Math.max(0, Math.round((block.startMs - blocks[index - 1]!.endMs) / 30000));
      if (gapHalfMinutes > 0) {
        segments.push({ stageId: -1, halfMinutes: gapHalfMinutes, gap: true });
        gapSec += gapHalfMinutes * 30;
      }
    }
    segments.push(...block.segments);
    totalSec += Math.max(0, block.totalSec);
    wakeSec += Math.max(0, block.wakeSec);
    remSec += Math.max(0, block.remSec);
    lightSec += Math.max(0, block.lightSec);
    deepSec += Math.max(0, block.deepSec);
  });

  const first = blocks[0]!;
  const last = blocks[blocks.length - 1]!;
  return {
    dayStartMs,
    startMs: first.startMs,
    endMs: last.endMs,
    totalSec,
    wakeSec: wakeSec + gapSec,
    remSec,
    lightSec,
    deepSec,
    segments,
    timeResolved: first.timeResolved,
    blocks,
    gapSec,
  };
}

/**
 * One entry per day in the window, carrying that night's four stage totals.
 *
 * Built for the diverging nightly chart (deep/REM/light stacked up, awake
 * down). Like `rollupSeries`, the grid is laid out first and then filled, so a
 * night with no record comes back as `hasData: false` at its real position
 * rather than shifting every later night one column left.
 *
 * ⚠ CHANGED 2026-09-13. Each column is the ASSEMBLED night (`assembleNights`):
 * distinct blocks add, a block re-delivered as it grew counts once, and the
 * gaps between blocks count as awake. It used to sum every stored session on
 * the day, which double-counted a growing block.
 */
export function sleepNights(
  sessions: readonly SleepSession[],
  startMs: number,
  endMs: number,
): SleepNight[] {
  const byDay = new Map<number, SleepNight>();
  for (const night of assembleNights(sessions)) {
    if (night.dayStartMs < startMs || night.dayStartMs >= endMs) continue;
    byDay.set(night.dayStartMs, {
      startMs: night.dayStartMs,
      hasData: true,
      deepSec: night.deepSec,
      remSec: night.remSec,
      lightSec: night.lightSec,
      wakeSec: night.wakeSec,
    });
  }

  const nights: SleepNight[] = [];
  let cursor = startOfLocalDay(startMs);
  let guard = 0;
  while (cursor < endMs && guard < 4000) {
    guard += 1;
    nights.push(
      byDay.get(cursor) ?? {
        startMs: cursor,
        hasData: false,
        deepSec: 0,
        remSec: 0,
        lightSec: 0,
        wakeSec: 0,
      },
    );
    cursor = nextBucketStart(cursor, "day");
  }
  return nights;
}

/**
 * The hypnogram: the night as a run of stage blocks, in order.
 *
 * This is the ONE thing that depends on the raw stage-id mapping, which is why
 * it is separated from `sleepSummary`'s percentages (those come from named
 * fields and are unaffected). A segment whose id is not in the mapping is
 * returned with `stage: null` rather than dropped or guessed at.
 *
 * The gap between two blocks of an assembled night is drawn as wake by its
 * `gap` flag, independent of the mapping - see `assembleNights`.
 */
export function hypnogram(session: SleepSession): { stage: SleepStageName | null; seconds: number }[] {
  return session.segments.map((segment) => ({
    stage: segment.gap ? ("wake" as SleepStageName) : stageNameForId(segment.stageId),
    seconds: segment.halfMinutes * 30,
  }));
}

/**
 * Date formatting, done by hand.
 *
 * ⚠ MEASURED, not a preference: `toLocaleDateString(undefined, { weekday:
 * "short" })` in this NativeScript Android runtime IGNORES the options bag and
 * returns the full `Fri Sep 04 2026`. It is the usual cause - a JS engine
 * built without full ICU quietly falls back instead of failing - and it turned
 * a week chart's axis into seven overlapping full dates. Anything that needs a
 * specific date shape has to build it, so these are the only date formatters
 * either surface uses.
 *
 * The cost is that they are English-only. That is a real limitation and the
 * right place to fix it is the runtime's ICU, not here.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "Fri". */
export function shortWeekday(ms: number): string {
  return WEEKDAYS[new Date(ms).getDay()] ?? "";
}

/** "Thu 10 Sep". */
export function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** "6h 42m", or "--" when there is nothing to show. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** One decimal at most, and never a trailing ".0". */
export function formatValue(value: number, metric: SampleMetric): string {
  if (!Number.isFinite(value)) return "--";
  if (isCumulative(metric)) return `${Math.round(value)}`;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/**
 * Whether a metric's min/max band is worth drawing.
 *
 * Measured against the real export before this was written: heart rate's
 * hourly min and max differ in 98% of buckets, but SpO2's and HRV's are
 * IDENTICAL in 97% of them - the ring reports what amounts to a single reading
 * per hour for those two. Drawing a band there produces a hairline that reads
 * as a rendering fault rather than as "there is no spread", so the charts drop
 * to a plain line when the spread is degenerate across the window.
 */
export function bandIsMeaningful(points: readonly RollupPoint[]): boolean {
  let withData = 0;
  let withSpread = 0;
  for (const point of points) {
    if (point.count === 0) continue;
    withData += 1;
    if (point.max > point.min) withSpread += 1;
  }
  if (withData === 0) return false;
  return withSpread / withData >= 0.25;
}
