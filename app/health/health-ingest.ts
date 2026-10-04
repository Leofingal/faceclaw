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
 * ⚠ HISTORICAL. This section is the plan, and it has since been built:
 * `health-live.ts` is the caller. One detail of it is now WRONG - the live path
 * must NOT use `getRingHealthRecords()`, which is a pure copy and left the
 * Java-side buffer growing forever. It uses `takeRingHealthBatch()` and hands
 * the records back with `clearRingHealthRecordsBelow()` once the store write
 * has succeeded. Since 2026-09-16 it reads neither: it ingests from the ring
 * page journal (`RingPageJournal.java`), see `health-live.ts`. Kept below for
 * the reasoning, not as instructions.
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
  HOUR_MS,
  TEN_MINUTES_MS,
  type HealthSample,
  type SleepSession,
  type SleepSegment,
  sleepNightDayStartMs,
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
  /**
   * `startMs`, when present, is the group's own true start (2026-10-04): during
   * the clock slew the offset changes inside a ring-day, so each group is
   * undone with the offset in force at its own ring hour. Absent, the group is
   * `anchorMs + hourIndex h`, as before.
   */
  groups: readonly { hourIndex: number; avg: number; max: number; min: number; startMs?: number }[];
};

/** `RingProtocol.StepsRecord` (`05:01`). */
export type WireStepsRecord = {
  kind: "steps";
  /** The day anchor. Steps pages always carried one in the capture. */
  anchorMs: number | null;
  /** Raw buckets. `index` is the ring's own, whose meaning is NOT known. */
  /** `startMs` as for hourly groups: the bucket's own true start, when known. */
  buckets: readonly { index: number; steps: number; activeCalories: number; totalCalories: number; startMs?: number }[];
};

/** `RingProtocol.SleepRecord` (`06:01`). */
export type WireSleepRecord = {
  kind: "sleep";
  /**
   * The ring's own `start_ts`/`end_ts`, in seconds.
   *
   * These were documented here as "ring-relative seconds - NOT Unix time",
   * because nothing in the offline capture proved otherwise. The first real
   * record off the hardware (2026-09-12) falsified that: `start_ts` decodes to
   * a plain Unix timestamp kept on the RING'S clock, which runs ahead of real
   * time. `clockCorrectionMs` is how a caller says by how much.
   *
   * Left as raw seconds here rather than corrected upstream so a caller with
   * no correction to offer (an offline capture, a fixture) still gets the old,
   * honestly-unresolved behaviour instead of a confidently wrong date.
   */
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
  /**
   * How far AHEAD of real wall-clock time `startTs`/`endTs` run, in ms, or
   * omitted when the caller cannot say. Supplying it is what promotes the
   * session from `timeResolved: false` to a real placement - see
   * `convertSleep`. The value itself is the producer's problem, not this
   * module's: `sleepWireFromRing` takes it from the ring clock history.
   */
  clockCorrectionMs?: number;
};

export type WireRecord = WireHourlyRecord | WireStepsRecord | WireSleepRecord;

export type ConversionResult = {
  samples: HealthSample[];
  sleep: SleepSession[];
  /** Every record or group deliberately not stored, with the reason. */
  skipped: { what: string; why: string }[];
};

// ===========================================================================
// The ring's clock
//
// Moved here from `health-live.ts` on 2026-09-13 so the corrections run under
// plain node: the known-good sleep windows are asserted THROUGH these functions
// in `tests/health-night.test.cjs`, not against a restated constant.

/**
 * The ring's clock, 2026-10-04: an OFFSET HISTORY, not a zone.
 *
 * Until 2026-10-04 the handshake set the ring to `now - zone offset` (UTC+4 h
 * in EDT, UTC-9 h in JST: the sign was inverted) and this module undid it with
 * `ringClockOffsetMs()`, the JS zone offset at the record's raw instant. Two
 * faults: the sign error itself, and the JS zone, which in a long-running app
 * process is the zone the process STARTED in. On 10-03 the app still stamped
 * JST (+09:00) receipts hours after landing in the US, and stored the
 * in-flight nap 9 h late (`sleep.jsonl` row 10-04 11:15Z, ring 02:55:30Z).
 *
 * Now the handshake holds the ring's offset when it is at or ahead of UTC
 * (never a backward step), writes plain UTC when the ring is behind or has
 * just reset (forward), and, only with the developer setting
 * `developer.ringClockRestoreUtc`, slews it to UTC at most 170 s back per
 * connect. Every committed change is recorded in
 * `files/health/ring-clock.json` (`RingClockState.java`) as
 * `[ring second, offset]` segments. A ring timestamp is undone with the
 * offset in force when the ring STAMPED it, read from those segments: no zone
 * is involved, so the two sides cannot drift apart again.
 *
 * A reset under the hold rule moves the ring from UTC+4 h to UTC, so its clock
 * re-lives 4 h of ring seconds and a ring second alone no longer names one
 * offset. The record's arrival time settles it: a segment written after the
 * record arrived is not the one it was stamped under (a segment's write time
 * is `start - offset`, since the write was `now + offset`), and a reading that
 * would put the record well after its own arrival belongs to the segment
 * before.
 *
 * The known-good EDT windows in `tests/health-night.test.cjs` still hold
 * through this path with the history the old build implies, `[[0, 14400]]`.
 */
export type RingClockSegments = readonly (readonly [number, number])[];

/**
 * Seconds the ring's clock ran ahead of true UTC when it stamped `ringSec`.
 * The last segment starting at or before `ringSec` wins (mirrors
 * `RingProtocol.clockOffsetSecAt`); before the first, the first; none, 0.
 */
export function ringClockOffsetSecAt(segments: RingClockSegments, ringSec: number, receivedAtMs?: number): number {
  if (!segments || segments.length === 0) return 0;
  const rxSec = receivedAtMs === undefined || !Number.isFinite(receivedAtMs) ? null : Math.floor(receivedAtMs / 1000);
  for (let i = segments.length - 1; i >= 0; i--) {
    const [start, offset] = segments[i]!;
    if (start > ringSec) continue;
    if (i > 0 && rxSec !== null) {
      // Written after this record arrived: not the offset it was stamped under.
      if (start - offset > rxSec) continue;
      // Would date the record after its own arrival: stamped under an older segment.
      if (ringSec - offset > rxSec + RING_CLOCK_FUTURE_SLACK_SEC) continue;
    }
    return offset;
  }
  return segments[0]![1];
}

/** Mirrors `RingProtocol.CLOCK_FUTURE_SLACK_SEC`: ring drift plus one slew step, well under a reset's 4 h. */
export const RING_CLOCK_FUTURE_SLACK_SEC = 600;

/** A ring timestamp (seconds, ring clock) as true epoch ms; `receivedAtMs` is the record's arrival. */
export function ringSecToRealMs(segments: RingClockSegments, ringSec: number, receivedAtMs?: number): number {
  return (ringSec - ringClockOffsetSecAt(segments, ringSec, receivedAtMs)) * 1000;
}

/**
 * Which clock epoch a record that arrived at `receivedAtMs` belongs to: the
 * true second (`start - offset`) of the latest segment, written by then, that
 * moved the ring's clock BACK by more than `RING_CLOCK_FUTURE_SLACK_SEC` (a
 * reset from UTC+4 h to UTC), or 0 when there is none. Inside one epoch a ring
 * second names one instant; across epochs it may not, so the step ledger keys
 * a ring-day by (anchor, epoch). A slew step (170 s) or a forward jump never
 * starts an epoch, so existing ledgers keep their keys.
 */
export function ringClockEpochAt(segments: RingClockSegments, receivedAtMs: number): number {
  if (!segments || segments.length < 2) return 0;
  const rxSec = Math.floor(receivedAtMs / 1000);
  for (let i = segments.length - 1; i >= 1; i--) {
    const [start, offset] = segments[i]!;
    const written = start - offset;
    if (written > rxSec) continue;
    if (segments[i - 1]![1] - offset > RING_CLOCK_FUTURE_SLACK_SEC) return written;
  }
  return 0;
}

/**
 * The step ledger's key for a ring-day: the raw anchor second, plus `@epoch`
 * once a reset has started a clock epoch (`ringClockEpochAt`). Epoch 0 keeps
 * the plain anchor, so a ledger written before this build keeps its keys.
 */
export function stepLedgerDayKey(anchorSec: number, epoch: number): string {
  return epoch ? `${anchorSec}@${epoch}` : String(anchorSec);
}

/**
 * `ring-clock.json` (or `RingClockState.historyJson()`) -> segments, or null
 * when it cannot be read. A caller with no history must not guess: the sync
 * skips and retries rather than date records with a made-up offset.
 */
export function parseRingClockSegments(json: string | null | undefined): RingClockSegments | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { segments?: unknown };
    const raw = parsed?.segments;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const out: [number, number][] = [];
    for (const pair of raw) {
      if (!Array.isArray(pair) || pair.length !== 2) return null;
      const from = Number(pair[0]);
      const offset = Number(pair[1]);
      if (!Number.isFinite(from) || !Number.isFinite(offset)) return null;
      out.push([from, offset]);
    }
    return out;
  } catch {
    return null;
  }
}

// ===========================================================================
// Clock-less records (2026-10-04)
//
// After a reset the ring has no clock until a connect sets it, and records it
// closes meanwhile carry its UPTIME in seconds where a Unix time would go.
// Measured on the 10-03 -> 04 night (ring-clock-fix return, addendum §3): a
// sleep block stamped 9270 -> 33510, delivered at the 11:31 EDT connect after
// a reset at 01:31:39 EDT, i.e. 04:06:09 -> 10:50:09 EDT. Stored as a 1970 row
// before this, so it never showed.

/** The firmware's floor for a real ring time (2000-01-01 or so): below it is uptime. */
export const RING_TIME_FLOOR_SEC = 946080000;

/** One `ringBoot` receipt: when it was seen, and the dated reset (null when undated). */
export type RingBootDate = { atMs: number; bootAtMs: number | null };

/** `ringBoot` lines out of `ring-sleep-receipts.jsonl`, oldest first. Bad lines are skipped. */
export function parseRingBoots(text: string | null | undefined): RingBootDate[] {
  const out: RingBootDate[] = [];
  if (!text) return out;
  for (const line of text.split("\n")) {
    if (line.indexOf('"ringBoot"') < 0) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; atMs?: unknown; bootAtMs?: unknown };
      if (parsed?.type !== "ringBoot" || typeof parsed.atMs !== "number") continue;
      out.push({
        atMs: parsed.atMs,
        bootAtMs: typeof parsed.bootAtMs === "number" ? parsed.bootAtMs : null,
      });
    } catch {
      // One unreadable line must not cost the rest.
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/**
 * The reset a clock-less record came from: the LAST ringBoot seen at or before
 * the record arrived. Null when that boot is undated (no page trailer or no
 * clock write on its link), when there is none, or when the dated end would lie
 * after the record arrived (then the boot cannot be this record's: a reset we
 * did not see came between). Null means "do not date it", never a guess.
 */
export function clocklessBootAtMs(
  boots: readonly RingBootDate[],
  receivedAtMs: number,
  endUptimeSec: number,
): number | null {
  let latest: RingBootDate | null = null;
  for (const boot of boots) if (boot.atMs <= receivedAtMs) latest = boot;
  if (!latest || latest.bootAtMs === null) return null;
  if (latest.bootAtMs + endUptimeSec * 1000 > receivedAtMs + 60_000) return null;
  return latest.bootAtMs;
}

/** `SleepRecord.recordState`: 2 is the empty end-of-list marker, not a night. */
const SLEEP_STATE_EMPTY = 2;

/**
 * The `RingProtocol.SleepRecord` fields `sleepWireFromRing` reads. The Java
 * object handed over by the bridge satisfies it; so does a plain object in a
 * test.
 */
export type RingSleepRecordLike = {
  recordState: number;
  startTs: number;
  endTs: number;
  totalTime: number;
  wakeTime: number;
  remTime: number;
  lightTime: number;
  deepTime: number;
  segments: { length: number; [index: number]: { stage: number; halfMinutes: number } };
  receivedAtMs: number;
};

/**
 * A live sleep record -> the wire shape, WITH the ring clock correction
 * attached. This is the shipping conversion `health-live.ts` calls; it lives
 * here so the known-good windows can be asserted through it. Returns null for
 * the RECSTATE=2 end-of-list marker.
 */
export function sleepWireFromRing(
  record: RingSleepRecordLike,
  clock: RingClockSegments,
  /**
   * The ringBoot receipts, needed only for a clock-less record (start below
   * `RING_TIME_FLOOR_SEC`). A function so the caller reads the file only then.
   */
  boots: () => readonly RingBootDate[] = () => [],
): WireSleepRecord | null {
  if (Number(record.recordState) === SLEEP_STATE_EMPTY) return null;
  const segments: SleepSegment[] = [];
  const raw = record.segments;
  for (let i = 0; i < raw.length; i++) {
    const segment = raw[i]!;
    // Java calls it `stage`, the domain type calls it `stageId` - both are the
    // same raw 0-3 ring id, deliberately unresolved here (see sleep-stages.ts).
    segments.push({ stageId: Number(segment.stage), halfMinutes: Number(segment.halfMinutes) });
  }
  const startTs = Number(record.startTs);
  const endTs = Number(record.endTs);
  let clockCorrectionMs: number | undefined;
  if (startTs < RING_TIME_FLOOR_SEC) {
    // Uptime seconds: true time = the reset + uptime, so the "correction" is
    // minus the reset instant. No dated reset: left unresolved (shown as an
    // undated "last night"), which is honest; a 1970 row is not.
    const bootAtMs = endTs < RING_TIME_FLOOR_SEC ? clocklessBootAtMs(boots(), Number(record.receivedAtMs), endTs) : null;
    clockCorrectionMs = bootAtMs === null ? undefined : -bootAtMs;
  } else {
    // The offset in force at the session's START, for both ends: the stage
    // segments are ring-clock durations, the hold rule never steps back, and
    // the developer slew never steps back in the quiet hours
    // (RingProtocol.CLOCK_QUIET_*), so a night is not split.
    clockCorrectionMs = ringClockOffsetSecAt(clock, startTs, Number(record.receivedAtMs)) * 1000;
  }
  return {
    kind: "sleep",
    startTs,
    endTs,
    ...(clockCorrectionMs === undefined ? {} : { clockCorrectionMs }),
    totalSec: Number(record.totalTime),
    wakeSec: Number(record.wakeTime),
    remSec: Number(record.remTime),
    lightSec: Number(record.lightTime),
    deepSec: Number(record.deepTime),
    segments,
    receivedAtMs: Number(record.receivedAtMs),
  };
}

// ===========================================================================

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
    const startMs = group.startMs ?? record.anchorMs + group.hourIndex * HOUR_MS;
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
 * Steps and calories, at TEN-MINUTE resolution.
 *
 * ## The index is cracked (2026-09-12)
 *
 * This used to emit one day-span sample holding the day's total, because the
 * bucket index was only trusted as an identity, not as a time. It now resolves:
 * **bucket `i` starts at `anchor + i * 10 minutes`**, with the anchor read
 * offset-corrected like every other record type.
 *
 * Confirmed twice. The decisive check: a live ledger held 25 contiguous buckets
 * (1-25) under a corrected anchor of 20:00, while the file's mtime was 00:18
 * local - and `20:00 + 25 * 10min` is 00:10-00:20, which is the window that was
 * actually being filled. The older "index runs 0-34 then jumps to 130-132"
 * observation came from an offline capture spanning more than one ring-day;
 * indices are per-record and contiguous within one.
 *
 * ## What this changes downstream
 *
 * The day total is no longer readable off any field of a day's rollup - it is
 * `sum`, and only `sum`, because `count` is now ~144 rather than 1. Checked on
 * 2026-09-12: every steps/calories reader already uses the summing path
 * (`dailySummary` -> `sumOf` -> `sample.total`; `rollupSeries` -> `rollupOf` ->
 * `sum`; the phone view model's steps branch reads `point.sum`), so nothing had
 * to change for this. Do not add a reader that takes `max` or `avg` for a step
 * total.
 *
 * A ring-day starts at 20:00 local (the ring's clock runs 4h fast, so its
 * midnight is our 20:00), which means one record's buckets straddle two
 * calendar days. That is correct and is the reason the day figure moves when
 * this lands: the evening buckets stop being filed under tomorrow.
 */
function convertSteps(record: WireStepsRecord, result: ConversionResult): void {
  if (record.anchorMs === null) {
    result.skipped.push({
      what: `steps page, ${record.buckets.length} buckets`,
      why: "no anchor - cannot date the buckets",
    });
    return;
  }
  const anchorMs = record.anchorMs;
  for (const bucket of record.buckets) {
    const startMs = bucket.startMs ?? anchorMs + bucket.index * TEN_MINUTES_MS;
    result.samples.push({
      metric: "steps",
      startMs,
      spanMs: TEN_MINUTES_MS,
      min: bucket.steps,
      max: bucket.steps,
      avg: bucket.steps,
      total: bucket.steps,
    });
    result.samples.push({
      metric: "calories",
      startMs,
      spanMs: TEN_MINUTES_MS,
      min: bucket.totalCalories,
      max: bucket.totalCalories,
      avg: bucket.totalCalories,
      total: bucket.totalCalories,
    });
  }
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
 * RESOLVED, 2026-09-12, by the first real record off the hardware rather than
 * by cracking `pay[3:9]`: `start_ts` is already a Unix timestamp, just kept on
 * the ring's own clock. A caller that knows how far that clock runs ahead
 * passes `clockCorrectionMs` and gets a genuinely placed session.
 *
 * ⚠ THE OLD FLAGGED GUESS SURVIVES for callers that do NOT pass it (offline
 * captures, fixtures): the session is attributed to the local day it was
 * RECEIVED on and `timeResolved` is false to say so. That guess is made rather
 * than avoided because "last night's sleep" is half of what the glasses glance
 * is for, and a record with no day at all cannot appear there. It is right
 * whenever the ring is synced the same day it is worn and wrong for a backlog
 * session pulled days later - which is why the UI never prints a date for an
 * unresolved session, only "last night", and shows the unresolved marker.
 */
function convertSleep(record: WireSleepRecord, result: ConversionResult): void {
  const durationSec = Math.max(0, record.endTs - record.startTs);
  const common = {
    totalSec: record.totalSec,
    wakeSec: record.wakeSec,
    remSec: record.remSec,
    lightSec: record.lightSec,
    deepSec: record.deepSec,
    segments: record.segments,
  };

  if (typeof record.clockCorrectionMs === "number") {
    const startMs = record.startTs * 1000 - record.clockCorrectionMs;
    const endMs = (record.startTs + durationSec) * 1000 - record.clockCorrectionMs;
    result.sleep.push({
      // The night this block ends in (20:00 -> 20:00, labelled by the day it
      // ends in), which is what `assembleNights` groups by. Taken from the END
      // so a night that starts before midnight still belongs to the morning it
      // ends on. Assembly re-derives this from `endMs` anyway, so a stored row
      // is never trusted for it.
      dayStartMs: sleepNightDayStartMs(endMs),
      startMs,
      endMs,
      ...common,
      timeResolved: true,
    });
    return;
  }

  result.sleep.push({
    dayStartMs: startOfLocalDay(record.receivedAtMs),
    // Raw seconds are kept as-is so the pair still describes the night's
    // length and ordering; `timeResolved` is what says not to read them as
    // wall-clock time.
    startMs: record.startTs * 1000,
    endMs: (record.startTs + durationSec) * 1000,
    ...common,
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
