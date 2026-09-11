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
 * 1. **It pulls, it does not subscribe.** `getRingHealthRecords()` returns the
 *    communicator's in-memory accumulation for the current process. There is no
 *    push event for health records, so both surfaces call this when they open
 *    and on their existing refresh tick. The store dedupes, so re-reading the
 *    same records is free — see `HealthStore.ingestSamples`, which was written
 *    for exactly this re-read pattern.
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
  type WireHourlyRecord,
  type WireRecord,
  type WireSleepRecord,
  type WireStepsRecord,
} from "./health-ingest";
import { markLiveData, purgeFixtureData } from "./health-seed";
import { healthStore } from "./health-store-files";
import type { SleepSegment } from "./health-types";

/** `RingProtocol.UNKNOWN_TIME` — the decoder's "I will not guess" sentinel. */
const UNKNOWN_TIME = -1;

/** `RingProtocol.CMD_HI_*`. */
const CMD_HEART_RATE = 0x01;
const CMD_SPO2 = 0x02;
const CMD_HRV = 0x04;
const CMD_STEPS = 0x05;
const CMD_SLEEP = 0x06;

/** `SleepRecord.recordState`: 2 is the empty end-of-list marker, not a night. */
const SLEEP_STATE_EMPTY = 2;

const HOURLY_METRIC: { [cmdHi: number]: WireHourlyRecord["metric"] } = {
  [CMD_HEART_RATE]: "heartRate",
  [CMD_SPO2]: "spo2",
  [CMD_HRV]: "hrv",
};

function activeCommunicator(): any {
  try {
    return (com as any).faceclaw.app.FaceclawBleCommunicator.getActive() ?? null;
  } catch {
    return null;
  }
}

function anchorToMs(anchorUnixSeconds: number): number | null {
  // The decoder hands this out already normalised: our own live pull decoded
  // 1789099200, which is exactly local midnight read as a plain Unix epoch.
  // No timezone correction belongs here.
  return anchorUnixSeconds === UNKNOWN_TIME ? null : anchorUnixSeconds * 1000;
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
    return { kind: "hourly", metric, anchorMs: anchorToMs(Number(record.anchorUnixSeconds)), groups };
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
    return { kind: "steps", anchorMs: anchorToMs(Number(record.anchorUnixSeconds)), buckets };
  }

  if (cmdHi === CMD_SLEEP) {
    if (Number(record.recordState) === SLEEP_STATE_EMPTY) return null;
    const segments: SleepSegment[] = [];
    const raw = record.segments;
    for (let i = 0; i < raw.length; i++) {
      const segment = raw[i];
      // Java calls it `stage`, the domain type calls it `stageId` - both are
      // the same raw 0-3 ring id, deliberately unresolved here (see sleep-stages.ts).
      segments.push({ stageId: Number(segment.stage), halfMinutes: Number(segment.halfMinutes) });
    }
    return {
      kind: "sleep",
      startTs: Number(record.startTs),
      endTs: Number(record.endTs),
      totalSec: Number(record.totalTime),
      wakeSec: Number(record.wakeTime),
      remSec: Number(record.remTime),
      lightSec: Number(record.lightTime),
      deepSec: Number(record.deepTime),
      segments,
      receivedAtMs: Number(record.receivedAtMs),
    };
  }

  return null;
}

export type LiveSyncResult = {
  /** Records the communicator was holding. 0 means no pull has landed yet. */
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
 * Read the communicator's decoded records into the durable store.
 *
 * Safe to call on every open and every refresh: the store dedupes, and an
 * absent communicator (no glasses process, preview build) is a no-op rather
 * than an error.
 */
export function syncLiveRecords(): LiveSyncResult {
  const communicator = activeCommunicator();
  if (!communicator) return EMPTY;

  let records: any;
  try {
    records = communicator.getRingHealthRecords();
  } catch (error) {
    console.warn("health live: could not read ring records", error);
    return EMPTY;
  }
  if (!records || !records.size || records.size() === 0) return EMPTY;

  const wire: WireRecord[] = [];
  const size = records.size();
  for (let i = 0; i < size; i++) {
    try {
      const converted = toWire(records.get(i));
      if (converted) wire.push(converted);
    } catch (error) {
      console.warn("health live: skipped an undecodable record", error);
    }
  }
  if (wire.length === 0) return { ...EMPTY, seen: size };

  const { samples, sleep, skipped } = convertRecords(wire);
  if (samples.length === 0 && sleep.length === 0) {
    return { seen: size, samplesWritten: 0, sleepWritten: 0, skipped };
  }

  // First real data wins the store outright — see the header.
  purgeFixtureData();

  const store = healthStore();
  const samplesWritten = store.ingestSamples(samples);
  const sleepWritten = store.ingestSleep(sleep);
  if (samplesWritten > 0 || sleepWritten > 0) markLiveData();

  console.log(
    `health live: ${size} records -> ${samplesWritten} samples, ${sleepWritten} sleep` +
      (skipped.length ? `, ${skipped.length} skipped` : ""),
  );
  return { seen: size, samplesWritten, sleepWritten, skipped };
}
