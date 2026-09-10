/**
 * The health record shapes, normalised for storage and display.
 *
 * These mirror `RingProtocol.java`'s `HourlyRecord` / `StepsRecord` /
 * `SleepRecord` (on the `ring-health-protocol` branch) but deliberately are
 * NOT the same types: the Java types are wire-shaped - raw hour indices, raw
 * stage ids, ring-relative timestamps, a per-page anchor that may be absent.
 * Everything here is already resolved into wall-clock time, or explicitly
 * marked as not resolvable. The conversion is `fromRingRecords()` in
 * `health-ingest.ts`, which is the only place that has to know about the wire.
 *
 * Keeping the two apart is what lets this app's storage and UI be built and
 * tested with no BLE anywhere near them.
 */

/** The five metrics the phone view can graph. */
export type SeriesMetric = "heartRate" | "spo2" | "hrv" | "steps" | "sleep";

/** Metrics stored as bucketed samples. Sleep is per-session and excluded. */
export type SampleMetric = "heartRate" | "spo2" | "hrv" | "steps" | "calories";

export const SAMPLE_METRICS: readonly SampleMetric[] = [
  "heartRate",
  "spo2",
  "hrv",
  "steps",
  "calories",
];

/** Metrics whose bucket value is a SUM over the bucket, not a measurement. */
export const CUMULATIVE_METRICS: readonly SampleMetric[] = ["steps", "calories"];

export function isCumulative(metric: SampleMetric): boolean {
  return CUMULATIVE_METRICS.includes(metric);
}

export const HOUR_MS = 3_600_000;
export const TEN_MINUTES_MS = 600_000;
export const DAY_MS = 86_400_000;

/**
 * One stored bucket.
 *
 * `min`/`max`/`avg` are what the ring reports for the physiological metrics.
 * For the cumulative ones (steps, calories) the ring reports a single count
 * per bucket, so all three carry that count and `total` carries it as well -
 * which keeps one shape for everything and lets a rollup sum `total` while
 * banding `min`/`max` without special-casing the reader.
 *
 * `startMs` is the LOCAL wall-clock start of the bucket. A record whose time
 * could not be resolved (a backlog page with no anchor; see the decode doc's
 * section 4) is not stored at all rather than stored with an invented time -
 * see `health-ingest.ts`.
 */
export type HealthSample = {
  metric: SampleMetric;
  startMs: number;
  spanMs: number;
  min: number;
  max: number;
  avg: number;
  total: number;
};

/**
 * One sleep session.
 *
 * All five duration fields come from NAMED byte offsets in the record and need
 * no stage-id mapping (see `sleep-stages.ts`). `segments` is the hypnogram and
 * carries RAW stage ids - resolve them through `stageNameForId`, never inline.
 *
 * `timeResolved` matters and is not decoration: the decode found that the
 * ring's `start_ts`/`end_ts` are ring-relative seconds, not Unix time, and
 * that nothing in the record dates the session (decode section 6, "genuinely
 * unresolved"). Even's own app gets this wrong - one exported row is stamped
 * 1979. When we cannot anchor a session we say so rather than plotting it at a
 * time we made up.
 */
export type SleepSession = {
  /** Local midnight of the day the session is attributed to (the wake-up day). */
  dayStartMs: number;
  startMs: number;
  endMs: number;
  totalSec: number;
  wakeSec: number;
  remSec: number;
  lightSec: number;
  deepSec: number;
  segments: readonly SleepSegment[];
  /** False when startMs/endMs are ring-relative and could not be anchored. */
  timeResolved: boolean;
};

export type SleepSegment = {
  /** RAW ring stage id, 0-3. Resolve via `stageNameForId`. */
  stageId: number;
  halfMinutes: number;
};

/** A min/max/avg/sum rollup over some window. `count` is buckets contributing. */
export type Rollup = {
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
};

/** A rollup positioned on the time axis - what the charts actually plot. */
export type RollupPoint = Rollup & {
  /** Local wall-clock start of the window this rollup covers. */
  startMs: number;
  spanMs: number;
};

export function emptyRollup(): Rollup {
  return { min: 0, max: 0, avg: 0, sum: 0, count: 0 };
}

/** Combine samples into one rollup. Returns null when nothing contributed. */
export function rollupOf(samples: readonly HealthSample[]): Rollup | null {
  if (samples.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let weighted = 0;
  for (const sample of samples) {
    if (sample.min < min) min = sample.min;
    if (sample.max > max) max = sample.max;
    sum += sample.total;
    weighted += sample.avg;
  }
  return {
    min,
    max,
    avg: weighted / samples.length,
    sum,
    count: samples.length,
  };
}

export const METRIC_LABELS: Readonly<Record<SeriesMetric, string>> = {
  heartRate: "Heart rate",
  spo2: "Blood oxygen",
  hrv: "HRV",
  steps: "Steps",
  sleep: "Sleep",
};

export const METRIC_UNITS: Readonly<Record<SeriesMetric, string>> = {
  heartRate: "bpm",
  spo2: "%",
  hrv: "ms",
  steps: "",
  sleep: "h",
};

/** Local midnight of the day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local top-of-hour containing `ms`. */
export function startOfLocalHour(ms: number): number {
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/** `YYYY-MM`, in local time - the storage shard key. */
export function monthKey(ms: number): string {
  const date = new Date(ms);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}
