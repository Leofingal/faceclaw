/**
 * Wire records -> stored samples. The one place that knows what the ring's
 * decoded records mean in wall-clock terms.
 *
 * ## This is written but NOT wired up, on purpose
 *
 * The live BLE path lives on the `ring-health-protocol` branch, which this one
 * deliberately does not touch. What is here is the whole conversion - the part
 * with the judgement calls in it - written against a structural description of
 * `RingProtocol.java`'s record types rather than an import of them, so that
 * branch and this one can be joined later without either having been built
 * around the other.
 *
 * ## WHERE THE LIVE WIRING GOES - the follow-up, in full
 *
 * `FaceclawBleCommunicator` already accumulates decoded records into a capped
 * in-memory list with a `getRingHealthRecords()` getter (implement-return,
 * section 2). The bridge already exposes the native object to TypeScript:
 * `FaceclawCommunicatorBridge.getNativeCommunicator()`. So the follow-up is:
 *
 *   1. In `dashboard-controller.ts`, after `connect()` succeeds, poll
 *      `communicator.getNativeCommunicator().getRingHealthRecords()` on the
 *      same 30-minute cadence the Java side already throttles health pulls to.
 *   2. Map each Java record onto the `Wire*` shapes below - a field-for-field
 *      copy; the names were chosen to match.
 *   3. Hand the result to `convertRecords()` and pass its `samples`/`sleep`
 *      straight to `healthStore().ingestSamples()` / `.ingestSleep()`.
 *
 * Doing it as a poll rather than a callback is what keeps it a small change:
 * adding a method to `FaceclawBleCommunicatorListener` forces an edit on every
 * implementer, which is exactly the reasoning that put the records in a getter
 * in the first place.
 *
 * A note for whoever does it: ingest is idempotent (`HealthStore` dedupes on
 * metric + bucket start), so re-reading the same capped list every poll is
 * correct and costs one no-op per record. Do NOT drain the list on read - it
 * is the only copy until this store has written it.
 *
 * No NativeScript imports here, so it runs under plain node in `tests/`.
 */

import {
  DAY_MS,
  HOUR_MS,
  type HealthSample,
  type SleepSession,
  type SleepSegment,
  startOfLocalDay,
} from "./health-types";

/** `RingProtocol.HourlyRecord`, for heart rate (`01:01`), SpO2 (`02:01`), HRV (`04:01`). */
export type WireHourlyRecord = {
  kind: "hourly";
  metric: "heartRate" | "spo2" | "hrv";
  /**
   * Absolute local ms the page's group index 0 refers to, from the record's
   * own six-byte ANCHOR field, or null on a backlog page that carried six
   * zero bytes instead.
   */
  anchorMs: number | null;
  groups: readonly { hourIndex: number; avg: number; max: number; min: number }[];
};

/** `RingProtocol.StepsRecord` (`05:01`). */
export type WireStepsRecord = {
  kind: "steps";
  /** The day anchor. Steps pages always carried one in the capture. */
  anchorMs: number | null;
  /** Raw buckets. `index` is the ring's own, whose meaning is NOT known. */
  buckets: readonly { index: number; steps: number; activeCalories: number; totalCalories: number }[];
};

/** `RingProtocol.SleepRecord` (`06:01`). */
export type WireSleepRecord = {
  kind: "sleep";
  /** Ring-relative seconds - NOT Unix time. See `convertSleep`. */
  startTs: number;
  endTs: number;
  totalSec: number;
  wakeSec: number;
  remSec: number;
  lightSec: number;
  deepSec: number;
  segments: readonly SleepSegment[];
  /** Wall-clock ms the record was received; the only real time in it. */
  receivedAtMs: number;
};

export type WireRecord = WireHourlyRecord | WireStepsRecord | WireSleepRecord;

export type ConversionResult = {
  samples: HealthSample[];
  sleep: SleepSession[];
  /** Every record or group deliberately not stored, with the reason. */
  skipped: { what: string; why: string }[];
};

export function convertRecords(records: readonly WireRecord[]): ConversionResult {
  const result: ConversionResult = { samples: [], sleep: [], skipped: [] };
  for (const record of records) {
    if (record.kind === "hourly") convertHourly(record, result);
    else if (record.kind === "steps") convertSteps(record, result);
    else convertSleep(record, result);
  }
  return result;
}

/**
 * Hourly pages. An ANCHORED page dates itself exactly: group `i` is
 * `anchor + i hours`, which the decode verified against every group that had a
 * row to check against.
 *
 * An UNANCHORED (backlog) page is dropped rather than placed. The decode did
 * solve where one such page landed, but explicitly could not derive the rule
 * that produced it and warned that a future page anchored elsewhere would
 * break it. `RingProtocol.java` already made the matching call - it hands
 * backlog groups out with `UNKNOWN_TIME` rather than an invented time - and a
 * health chart is exactly the wrong place to be the first component that
 * guesses. Dropping loses a page; guessing corrupts the history silently.
 */
function convertHourly(record: WireHourlyRecord, result: ConversionResult): void {
  if (record.anchorMs === null) {
    result.skipped.push({
      what: `${record.metric} page, ${record.groups.length} groups`,
      why: "backlog page with no anchor - no verified rule for dating it",
    });
    return;
  }
  for (const group of record.groups) {
    const startMs = record.anchorMs + group.hourIndex * HOUR_MS;
    result.samples.push({
      metric: record.metric,
      startMs,
      spanMs: HOUR_MS,
      min: group.min,
      max: group.max,
      avg: group.avg,
      total: group.avg,
    });
  }
}

/**
 * Steps and calories, at DAY resolution - which is all the wire honestly
 * supports today.
 *
 * The decode proved the record's per-bucket step values sum to exactly the
 * day's real total (it matched the export's total for the capture day, and
 * that total was unique across the whole 34-day export). What it explicitly
 * did NOT crack is which wall-clock window each bucket covers: the bucket
 * index runs 0-34 and then jumps to 130-132, the distribution does not line up
 * with the export's ten-minute rows at any base time or bucket width tried,
 * and the note is emphatic that the index is not a plain counter.
 *
 * So the proven quantity - the daily total - is what gets stored, as one
 * day-span sample. Per-bucket detail is deliberately discarded rather than
 * spread evenly across the day, which would produce an hour-by-hour step chart
 * that looks real and is fiction.
 *
 * WHEN THE INDEX IS CRACKED this is the only function that changes: emit
 * ten-minute samples with `startMs` from the resolved index and everything
 * downstream - store, rollups, both charts - already handles them, because the
 * fixtures exercise exactly that shape today.
 */
function convertSteps(record: WireStepsRecord, result: ConversionResult): void {
  if (record.anchorMs === null) {
    result.skipped.push({
      what: `steps page, ${record.buckets.length} buckets`,
      why: "no day anchor - cannot date the total",
    });
    return;
  }
  let steps = 0;
  let calories = 0;
  for (const bucket of record.buckets) {
    steps += bucket.steps;
    calories += bucket.totalCalories;
  }
  const dayStart = startOfLocalDay(record.anchorMs);
  result.samples.push({
    metric: "steps",
    startMs: dayStart,
    spanMs: DAY_MS,
    min: steps,
    max: steps,
    avg: steps,
    total: steps,
  });
  result.samples.push({
    metric: "calories",
    startMs: dayStart,
    spanMs: DAY_MS,
    min: calories,
    max: calories,
    avg: calories,
    total: calories,
  });
  result.skipped.push({
    what: `${record.buckets.length} step buckets`,
    why: "bucket index -> wall clock is not decoded; only the daily total is proven",
  });
}

/**
 * Sleep sessions.
 *
 * The durations are exact and need no anchoring - they come from named byte
 * offsets and the decode reproduced a whole exported row from them. The
 * SESSION TIME is the problem: `start_ts`/`end_ts` are ring-relative seconds,
 * nothing in the record carries an absolute date, and the two unidentified
 * fields that might have carried one were not cracked. Even's own app gets
 * this wrong - one exported row is stamped 1979.
 *
 * ⚠ FLAGGED GUESS. The session is attributed to the local day it was RECEIVED
 * on, and `timeResolved` is set false to say so. That is a guess, and it is
 * made rather than avoided because "last night's sleep" is half of what the
 * glasses glance is for, and a record with no day at all cannot appear there.
 * It is right whenever the ring is synced the same day it is worn, which is
 * the normal case, and wrong for a backlog session pulled days later - which
 * is why the UI never prints a date for an unresolved session, only "last
 * night", and shows the unresolved marker.
 *
 * The clean fix is upstream: decode `pay[3:9]` or `pay[9:13]`, one of which
 * the decode expects carries the session date. Then set `timeResolved` true
 * and take the day from there.
 */
function convertSleep(record: WireSleepRecord, result: ConversionResult): void {
  const durationSec = Math.max(0, record.endTs - record.startTs);
  result.sleep.push({
    dayStartMs: startOfLocalDay(record.receivedAtMs),
    // Relative seconds are kept as-is so the pair still describes the night's
    // length and ordering; `timeResolved` is what says not to read them as
    // wall-clock time.
    startMs: record.startTs * 1000,
    endMs: (record.startTs + durationSec) * 1000,
    totalSec: record.totalSec,
    wakeSec: record.wakeSec,
    remSec: record.remSec,
    lightSec: record.lightSec,
    deepSec: record.deepSec,
    segments: record.segments,
    timeResolved: false,
  });
}

/**
 * The consistency check the decode found holds on every real record: the
 * segment run must account for exactly the time in bed. Worth running on
 * ingest - a record that fails it is a decode fault, not a strange night.
 */
export function sleepIdentityHolds(record: {
  totalSec: number;
  wakeSec: number;
  segments: readonly SleepSegment[];
}): boolean {
  let half = 0;
  for (const segment of record.segments) half += segment.halfMinutes;
  return half * 30 === record.totalSec + record.wakeSec;
}
