/**
 * Live ring → store. The producer side of `health-ingest.ts`.
 *
 * `health-ingest.ts` was built with a complete wire→domain conversion and no
 * caller; this is the caller. It reads whatever `FaceclawBleCommunicator` has
 * decoded off the ring this session, marshals the Java records into the
 * `WireRecord` shapes that module already expects, and writes the result
 * through the store's own deduping ingest.
 *
 * Three things worth knowing:
 *
 * 1. **It pulls, it does not subscribe, and it CONSUMES.** There is no push
 *    event for health records, so both surfaces call this when they open and on
 *    their existing refresh tick. Since 2026-09-16 the source is the ring page
 *    journal (`RingPageJournal.java`, `files/health/ring-pages.jsonl`): every
 *    page is appended there and fsynced BEFORE its ACK tells the ring it may
 *    discard it. `readBatch()` hands over every page above the committed
 *    watermark, decoded, and once both store writes have returned `commit()`
 *    advances the watermark. A store write that throws leaves the watermark
 *    where it was, so the next tick retries. Cut and paste, not copy paste.
 *    (Before the journal this read the communicator's in-memory buffer, which
 *    an app kill between ACK and store emptied for good; that buffer is now
 *    only drained here.)
 *
 *    It used to be a pure copy, and nothing ever cleared the Java-side list, so
 *    every 60s tick re-processed the whole session's history. Measured
 *    2026-09-12: `samples-2026-09.jsonl` grew 22,505 -> 28,552 lines in eight
 *    hours, the buffer climbing 12 -> 24 records and samples-written-per-cycle
 *    8 -> 14. The store's dedupe kept the DATA right the whole time; it was the
 *    work and the file that grew without bound.
 *
 * 2. **Fixtures are purged, not just unlabelled, before the first real write.**
 *    `clearFixtureMarker()` only drops the badge; the 45 days of generated
 *    samples would stay in the store and become indistinguishable from real
 *    data the moment the badge went away. That is precisely the artefact
 *    `health-seed.ts`' own header warns about, so the first genuine record
 *    wipes the store files outright.
 *
 * 3. **Records the decode could not date are dropped, not placed.**
 *    `RingProtocol` hands out `UNKNOWN_TIME` (-1) for an unanchored backlog
 *    page rather than inventing a time; that maps to `anchorMs: null` here and
 *    `convertRecords` skips it with a reason. Do not "fix" this by substituting
 *    now() — a health chart is the wrong place to guess a timestamp.
 */

import {
  convertRecords,
  ringClockOffsetMs,
  sleepWireFromRing,
  type WireHourlyRecord,
  type WireRecord,
  type WireStepsRecord,
} from "./health-ingest";
import { Utils } from "@nativescript/core";
import { markLiveData, purgeFixtureData } from "./health-seed";
import { healthStore } from "./health-store-files";
import { startOfLocalDay } from "./health-types";
import { File, knownFolders } from "@nativescript/core";
import { onAlignedTick, startAlignedTick, __alignedTickInternals } from "../util/aligned-tick";
import type { RingPullProgress } from "./health-open-refresh";

/** `RingProtocol.UNKNOWN_TIME` — the decoder's "I will not guess" sentinel. */
const UNKNOWN_TIME = -1;

/** `RingProtocol.CMD_HI_*`. */
const CMD_HEART_RATE = 0x01;
const CMD_SPO2 = 0x02;
const CMD_HRV = 0x04;
const CMD_STEPS = 0x05;
const CMD_SLEEP = 0x06;

const HOURLY_METRIC: { [cmdHi: number]: WireHourlyRecord["metric"] } = {
  [CMD_HEART_RATE]: "heartRate",
  [CMD_SPO2]: "spo2",
  [CMD_HRV]: "hrv",
};

declare const java: any;

/**
 * The ring page journal under files/health. Built from the same
 * `getFilesDir()` + "health" the communicator uses, and the Java side keys its
 * shared instance by canonical path, so both reach one instance and one lock.
 * Works without a communicator: pages journaled before an app kill are
 * ingested on the next launch, before the glasses connect.
 */
function ringPageJournal(): any {
  try {
    const dir = new java.io.File(Utils.android.getApplicationContext().getFilesDir(), "health");
    return (com as any).faceclaw.app.RingPageJournal.forDirectory(dir);
  } catch (error) {
    console.warn("health live: ring page journal unavailable", error);
    return null;
  }
}

function activeCommunicator(): any {
  try {
    return (com as any).faceclaw.app.FaceclawBleCommunicator.getActive() ?? null;
  } catch {
    return null;
  }
}

// The ring clock corrections (`ringClockOffsetMs`, `sleepClockOffsetMs`) live in
// `health-ingest.ts`, with their evidence, so tests can run them under node.

function anchorToMs(anchorUnixSeconds: number, applyClockOffset: boolean): number | null {
  if (anchorUnixSeconds === UNKNOWN_TIME) return null;
  const ms = anchorUnixSeconds * 1000;
  return applyClockOffset ? ms - ringClockOffsetMs(ms) : ms;
}

/**
 * Per-day step-bucket ledger.
 *
 * **Why this has to exist.** The ring does not resend the whole day: a pull
 * delivers only the buckets new since the last successful one, the same
 * watermark model every other record type uses. Measured 2026-09-11:
 * 25 buckets / 222 steps, then 3 / 0, then 2 / 0, then 2 / 70. A cumulative
 * day total cannot go 222 → 0 → 70.
 *
 * `convertSteps()` sums the buckets it is handed and emits that as the day's
 * total, which was right for the offline captures it was written against —
 * there, one sync carried everything. Live, it means each pull overwrites the
 * day with just that pull's increment, so the step count reads as "since the
 * last pull" and lurches downward. So this keeps the day's buckets and hands
 * `convertSteps()` the accumulated set, leaving that function pure.
 *
 * **Merge is max-by-index, not addition and not last-write-wins.** A bucket is
 * a time window's own total, so a window redelivered later carries a larger
 * value, not an increment to add — addition would double-count every open
 * window. Taking the max rather than the last value makes the merge
 * ORDER-INDEPENDENT, which matters because a single sync pass merges several
 * records that overlap: measured 2026-09-12, four steps records in one pass
 * agreed on every bucket's step count but disagreed on its calorie fields, so
 * last-write-wins made the day's calorie total ping-pong 643 ↔ 671 forever,
 * appending two lines to the sample shard every cycle. Max is consistent with
 * the documented model (a window's total only grows as it fills) and settles.
 *
 * **The ledger holds MANY days, not one.** It used to hold exactly one, and
 * kept it only while the incoming day matched — so the moment a record from
 * another ring-day arrived, the whole accumulated day was discarded and
 * rebuilt from that one pull. With `syncLiveRecords()` re-processing the
 * communicator's entire record history every 60s, that produced a repeating
 * cycle of partial sums, each written to the store as a genuine day total
 * (measured: a 12-state cycle, repeated 132 times, 22k lines in a day).
 * Holding every day makes the replay idempotent instead of destructive — and
 * no theory about WHY records replay is needed for that to hold.
 *
 * The day key is `startOfLocalDay(corrected anchor)`, which is the ring's own
 * day start, not calendar midnight — the ring's day begins at 20:00 local
 * because its clock runs 4h fast. That is fine: the key is an identity, and
 * the per-bucket timestamps carry the real wall-clock placement.
 */
type StepDayBuckets = { [index: string]: { steps: number; active: number; total: number } };

type StepBucketLedger = {
  /** `dayStartMs` (as a string key) -> that day's buckets. */
  days: { [dayStartMs: string]: StepDayBuckets };
};

/** The pre-2026-09-12 single-day shape, migrated on read rather than dropped. */
type LegacyStepBucketLedger = { dayStartMs: number; buckets: StepDayBuckets };

/** How many ring-days to keep. Enough for a weekly chart, bounded on disk. */
const LEDGER_DAYS_KEPT = 7;

function ledgerPath(): string {
  return `${knownFolders.documents().getFolder("health").path}/steps-ledger.json`;
}

function readLedger(): StepBucketLedger | null {
  try {
    if (!File.exists(ledgerPath())) return null;
    const parsed = JSON.parse(File.fromPath(ledgerPath()).readTextSync()) as
      | StepBucketLedger
      | LegacyStepBucketLedger;
    if (parsed && (parsed as StepBucketLedger).days) return parsed as StepBucketLedger;
    // Migrate the single-day shape rather than discarding it: the file on the
    // phone holds real step data the ring may not re-deliver.
    //
    // ⚠ RE-KEY IT. The legacy `dayStartMs` was `startOfLocalDay(RAW anchor)`,
    // computed before the anchor was offset-corrected, so carrying it across
    // verbatim files the day 4h too late — under a key the corrected code will
    // never write to again. The accumulated buckets would sit there stranded
    // while the same ring-day restarted empty beside them. Measured doing
    // exactly that on 2026-09-12: a ledger with "2 days" that were one day.
    const legacy = parsed as LegacyStepBucketLedger;
    if (typeof legacy?.dayStartMs === "number" && legacy.buckets) {
      const corrected = legacy.dayStartMs - ringClockOffsetMs(legacy.dayStartMs);
      return { days: { [String(startOfLocalDay(corrected))]: legacy.buckets } };
    }
    return null;
  } catch {
    return null;
  }
}

/** Keep the ledger bounded. Newest `LEDGER_DAYS_KEPT` days survive. */
function pruneLedger(ledger: StepBucketLedger): void {
  const keys = Object.keys(ledger.days).sort((a, b) => Number(b) - Number(a));
  for (const key of keys.slice(LEDGER_DAYS_KEPT)) delete ledger.days[key];
}

function writeLedger(ledger: StepBucketLedger): void {
  try {
    File.fromPath(ledgerPath()).writeTextSync(JSON.stringify(ledger));
  } catch (error) {
    console.warn("health live: steps ledger write failed", error);
  }
}

/** Merge this pull's buckets into that ring-day's ledger and return its full set. */
function accumulateStepBuckets(
  dayStartMs: number,
  delivered: readonly { index: number; steps: number; activeCalories: number; totalCalories: number }[],
): { index: number; steps: number; activeCalories: number; totalCalories: number }[] {
  const ledger: StepBucketLedger = readLedger() ?? { days: {} };
  const dayKey = String(dayStartMs);
  const day: StepDayBuckets = ledger.days[dayKey] ?? {};
  ledger.days[dayKey] = day;
  for (const bucket of delivered) {
    const existing = day[String(bucket.index)];
    // Max, not overwrite — see the type's header. Keeps the merge order-independent.
    day[String(bucket.index)] = {
      steps: Math.max(existing?.steps ?? 0, bucket.steps),
      active: Math.max(existing?.active ?? 0, bucket.activeCalories),
      total: Math.max(existing?.total ?? 0, bucket.totalCalories),
    };
  }
  pruneLedger(ledger);
  writeLedger(ledger);
  const merged = Object.keys(day).map((key) => ({
    index: Number(key),
    steps: day[key]!.steps,
    activeCalories: day[key]!.active,
    totalCalories: day[key]!.total,
  }));
  const steps = merged.reduce((acc, b) => acc + b.steps, 0);
  const calories = merged.reduce((acc, b) => acc + b.totalCalories, 0);
  console.log(
    `health live: steps ledger +${delivered.length} delivered -> ${merged.length} buckets held ` +
      `for ring-day ${new Date(dayStartMs).toISOString()}, ${steps} steps / ${calories} cal, ` +
      `${Object.keys(ledger.days).length} days in ledger`,
  );
  return merged;
}

function toWire(record: any): WireRecord | null {
  const cmdHi = Number(record.cmdHi);

  const metric = HOURLY_METRIC[cmdHi];
  if (metric) {
    const groups: { hourIndex: number; avg: number; max: number; min: number }[] = [];
    const raw = record.groups;
    for (let i = 0; i < raw.length; i++) {
      const group = raw[i];
      groups.push({
        hourIndex: Number(group.hourIndex),
        avg: Number(group.avg),
        max: Number(group.max),
        min: Number(group.min),
      });
    }
    return { kind: "hourly", metric, anchorMs: anchorToMs(Number(record.anchorUnixSeconds), true), groups };
  }

  if (cmdHi === CMD_STEPS) {
    const buckets: { index: number; steps: number; activeCalories: number; totalCalories: number }[] = [];
    const raw = record.buckets;
    for (let i = 0; i < raw.length; i++) {
      const bucket = raw[i];
      buckets.push({
        index: Number(bucket.index),
        steps: Number(bucket.steps),
        // UNVERIFIED MAPPING. The decode never resolved which of the record's
        // two calorie-like fields is active vs total burn, which is why the
        // Java side names them calorieLike2/calorieLike3 rather than committing.
        // convertSteps() sums totalCalories, so if the daily calorie figure
        // reads wrong against Even's own export, swap these two — that is the
        // whole fix, and it is the only thing here resting on a guess.
        activeCalories: Number(bucket.calorieLike2),
        totalCalories: Number(bucket.calorieLike3),
      });
    }
    // Offset-corrected like every other record type, as of 2026-09-12.
    //
    // This used to pass `false`, and the reasoning was that flooring the raw
    // anchor to the local day "absorbed" the 4h shift and landed on the right
    // date, where subtracting would push the day boundary back to 20:00 the
    // previous evening. That was solving the wrong problem. The anchor was
    // being asked to carry the DATE LABEL for a single day-blob sample, so it
    // had to be bent until the label came out right.
    //
    // With the bucket index cracked (bucket i starts at anchor + i*10min), the
    // anchor no longer carries a date at all — it is the true start instant of
    // bucket 0, and each bucket now dates itself. So the anchor must simply be
    // correct, and correct means offset-corrected: measured 2026-09-12 00:36,
    // the raw anchor read 00:00 today while the record's own 25 buckets place
    // the series start at 20:00 the previous evening, which is exactly the 4h.
    //
    // The ring's day really does begin at 20:00 local, because its clock runs
    // 4h fast and its day starts at ITS midnight. A ring-day therefore straddles
    // two calendar days, and the buckets land on whichever real day they fall
    // in — which is the point.
    const anchorMs = anchorToMs(Number(record.anchorUnixSeconds), true);
    if (anchorMs === null) return { kind: "steps", anchorMs: null, buckets };
    // Hand convertSteps() the whole day, not just this pull's increment.
    const accumulated = accumulateStepBuckets(startOfLocalDay(anchorMs), buckets);
    return { kind: "steps", anchorMs, buckets: accumulated };
  }

  if (cmdHi === CMD_SLEEP) {
    // The shipping conversion, including the clock correction, is in
    // health-ingest.ts so its known-good windows are tested through it.
    const wire = sleepWireFromRing(record);
    if (!wire) return null;
    const correction = wire.clockCorrectionMs ?? 0;
    // The assertion log for the sleep clock correction. A handful of sleep
    // records a night makes this cheap, and a wrong clock frame is otherwise
    // invisible until someone reads a chart and disbelieves it.
    console.log(
      `health live: sleep raw ${new Date(wire.startTs * 1000).toString()} -> corrected ` +
        `${new Date(wire.startTs * 1000 - correction).toString()} .. ` +
        `${new Date(wire.endTs * 1000 - correction).toString()} (-${correction / 3600000}h)`,
    );
    return wire;
  }

  return null;
}

export type LiveSyncResult = {
  /** Decoded records read from the ring page journal this pass. */
  seen: number;
  /** Samples genuinely new to the store. */
  samplesWritten: number;
  /** Sleep sessions genuinely new to the store. */
  sleepWritten: number;
  /** Conversions deliberately declined, with reasons, from `convertRecords`. */
  skipped: { what: string; why: string }[];
};

const EMPTY: LiveSyncResult = { seen: 0, samplesWritten: 0, sleepWritten: 0, skipped: [] };

/**
 * Empty the communicator's live record buffer. The store no longer reads it
 * (the journal is the source), so this only keeps it from filling to its cap.
 * Deliberately swallows its own failure: nothing stored depends on it.
 */
function drainLiveBuffer(): void {
  const communicator = activeCommunicator();
  if (!communicator) return;
  try {
    const batch = communicator.takeRingHealthBatch();
    if (batch) communicator.clearRingHealthRecordsBelow(batch.getWatermark());
  } catch (error) {
    console.warn("health live: could not drain the live ring buffer", error);
  }
}

/**
 * Mark the journal's pages up to `watermark` as stored. Swallows its own
 * failure: a commit that does not happen means the same pages are read and
 * deduped again next tick. The bias runs one way throughout - under-committing
 * is cheap, over-committing loses data.
 */
function commitJournal(journal: any, watermark: number): void {
  try {
    journal.commit(watermark);
  } catch (error) {
    console.warn(`health live: journal commit to ${watermark} failed; pages will be re-read`, error);
  }
}

/**
 * Read the ring page journal's new pages into the durable store.
 *
 * Safe to call on every open and every refresh: the store dedupes, and an
 * unavailable journal (preview build) is a no-op rather than an error.
 */
export function syncLiveRecords(): LiveSyncResult {
  drainLiveBuffer();
  const journal = ringPageJournal();
  if (!journal) return EMPTY;

  let batch: any;
  try {
    batch = journal.readBatch();
  } catch (error) {
    console.warn("health live: could not read the ring page journal", error);
    return EMPTY;
  }
  if (!batch || Number(batch.getLines()) === 0) return EMPTY;
  // Identifies exactly this batch. Pages journaled from here on are numbered
  // above it, so this pass's commit can never cover a page it did not read.
  const watermark = Number(batch.getWatermark());
  const records = batch.getRecords();
  const size = records.size();
  const journalNote =
    `journal ${Number(batch.getCommitted()) + 1}..${watermark}` +
    (Number(batch.getUndecoded()) ? `, ${batch.getUndecoded()} undecoded` : "") +
    (Number(batch.getCorrupt()) ? `, ${batch.getCorrupt()} corrupt` : "");

  const wire: WireRecord[] = [];
  for (let i = 0; i < size; i++) {
    try {
      const converted = toWire(records.get(i));
      if (converted) wire.push(converted);
    } catch (error) {
      console.warn("health live: skipped an undecodable record", error);
    }
  }
  const { samples, sleep, skipped } = convertRecords(wire);
  if (samples.length === 0 && sleep.length === 0) {
    // Nothing to store is not a failure: these pages are done with, exactly as
    // records the conversion declined were before the journal.
    commitJournal(journal, watermark);
    console.log(`health live: ${size} records (${journalNote}) -> nothing to store`);
    return { seen: size, samplesWritten: 0, sleepWritten: 0, skipped };
  }

  // First real data wins the store outright — see the header.
  purgeFixtureData();

  const store = healthStore();
  let samplesWritten: number;
  let sleepWritten: number;
  try {
    samplesWritten = store.ingestSamples(samples);
    sleepWritten = store.ingestSleep(sleep);
  } catch (error) {
    // The watermark stays put: the journal keeps these pages and the next tick
    // retries them. Loud, because a store that cannot write is otherwise silent.
    console.error(`health live: STORE WRITE FAILED (${journalNote}); journal not advanced`, error);
    return { seen: size, samplesWritten: 0, sleepWritten: 0, skipped };
  }
  if (samplesWritten > 0 || sleepWritten > 0) markLiveData();

  // ONLY here. Both store writes have returned, so the records are on disk.
  // If the process dies above this line, nothing is committed and the same
  // pages are read again next launch - one repeated ingest (a no-op, the store
  // refuses identical re-writes) instead of losing a night. Note
  // `samplesWritten === 0` is NOT a failure: it means the store already held
  // all of it.
  commitJournal(journal, watermark);

  console.log(
    `health live: ${size} records (${journalNote}) -> ${samplesWritten} samples, ${sleepWritten} sleep` +
      (skipped.length ? `, ${skipped.length} skipped` : ""),
  );
  return { seen: size, samplesWritten, sleepWritten, skipped };
}

/**
 * What is asking for a pull. It rides into the pull receipt as `trigger`, and
 * in "Only when needed" it decides whether the ask is taken at all: that mode
 * refuses the timed "tick" while the glasses are on their charger, and takes a
 * Health open always (Chris, 2026-09-24 revision). The refusal is made in
 * Java, which knows the mode the live communicator was built with and holds
 * the glasses' own charge reading.
 */
export type RingPullTrigger = "health-open" | "tick";

/**
 * Ask the ring for a fresh pull now, rather than waiting out the automatic
 * 30-minute cycle. Returns immediately; the pull itself takes ~15s on the
 * communicator's worker thread and lands through the next `syncLiveRecords()`.
 *
 * Throttled communicator-side to one a minute — see
 * `requestRingHealthNowFor()`. Calling it on every open is fine.
 */
export function requestFreshPull(trigger: RingPullTrigger): void {
  const communicator = activeCommunicator();
  if (!communicator) return;
  try {
    communicator.requestRingHealthNowFor(trigger);
  } catch (error) {
    console.warn("health live: on-demand pull request failed", error);
  }
}

/**
 * The live communicator's mode and finished-pull count, for the phone Health
 * tab's redraw-on-landing watch (`health-open-refresh.ts`). Two cheap reads of
 * Java fields; null when there is no communicator or the reads fail (preview
 * build, or an APK older than the getters).
 */
export function ringPullProgress(): RingPullProgress | null {
  const communicator = activeCommunicator();
  if (!communicator) return null;
  try {
    return {
      onDemand: Boolean(communicator.isRingLinkOnDemand()),
      pullsFinished: Number(communicator.ringHealthPullsFinished()),
    };
  } catch {
    return null;
  }
}

/**
 * Keep decoded records reaching disk whether or not a surface is open.
 *
 * Without this, records live only in the communicator's memory until the
 * health app or phone page is opened, so a pull that lands while both are
 * closed is lost if the process restarts first. The store dedupes, so this is
 * a no-op whenever there is nothing new.
 *
 * Called once from `app.ts`. Idempotent.
 */
const BACKGROUND_SYNC_INTERVAL_MS = 60 * 1000;
let backgroundSyncTimer: ReturnType<typeof setInterval> | null = null;

export function startLiveHealthSync(): void {
  if (backgroundSyncTimer) return;
  backgroundSyncTimer = setInterval(() => {
    try {
      syncLiveRecords();
    } catch (error) {
      console.warn("health live: background sync failed", error);
    }
  }, BACKGROUND_SYNC_INTERVAL_MS);
}

/**
 * Pull the ring on a wall-clock-aligned cadence: :01 and :31, every hour.
 *
 * Chris, 2026-09-12: *"I think we should be polling the ring on the 30 minute
 * cycle (that was my intent, not a floor honestly)."* The 30-minute value in
 * `RING_HEALTH_MIN_PULL_INTERVAL_MS` was always meant as a collection rhythm
 * and got built as a throttle, so a connected, stable ring pulled never —
 * nothing in the system drives a pull on a timer at all.
 *
 * ⚠ THE SCHEDULER ITSELF NOW LIVES IN `util/aligned-tick.ts`, and this is one
 * of its subscribers. It moved there when the home screen's status lines
 * needed the same cadence: a second timer doing the same arithmetic would
 * have drifted against this one the first time either was re-armed late, and
 * would have put the reasoning in two places. The behaviour is unchanged —
 * same slots, same re-arm-against-the-clock, same one-minute offset, and the
 * arithmetic is still pinned by a test (now `tests/aligned-tick.test.cjs`).
 *
 * This only *requests* a pull. The communicator still applies its own anti-spam
 * floor, so an extra call here can never hammer the ring.
 *
 * In "Only when needed" the communicator refuses these while the glasses are
 * on their charger, with a receipt for each (2026-09-24 revision), and pulls
 * once when they come off it. Otherwise every mode takes them as before.
 */
let alignedPullSubscribed = false;

export function startAlignedRingPull(): void {
  if (alignedPullSubscribed) return;
  alignedPullSubscribed = true;
  startAlignedTick();
  onAlignedTick(() => {
    try {
      requestFreshPull("tick");
    } catch (error) {
      console.warn("health live: aligned ring pull failed", error);
    }
  });
}

/**
 * Exported for tests — the scheduling arithmetic, with no timer attached.
 *
 * Kept as a name so nothing that referenced it has to change; it now forwards
 * to the shared tick's own internals, which is where the arithmetic lives.
 */
export const __alignedPullInternals = {
  msUntilNextAlignedPull: __alignedTickInternals.msUntilNextAlignedTick,
  ALIGNED_PULL_MINUTES: __alignedTickInternals.ALIGNED_TICK_MINUTES,
};
