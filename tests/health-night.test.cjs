// Sleep: the ring clock correction's known-good windows, and night assembly.
//
// Pinned to America/New_York. The known-goods are wall-clock readings Chris
// confirmed in EDT, and the correction is computed from the zone offset, so
// they are only meaningful there. Setting TZ here (each test file is its own
// node process under `node --test`) means they run everywhere instead of
// skipping off the box they were measured on.
process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  convertRecords,
  ringClockOffsetMs,
  sleepClockOffsetMs,
  sleepIdentityHolds,
  sleepWireFromRing,
} = require("../.test-build/app/health/health-ingest.js");
const {
  assembleNight,
  assembleNights,
  dailySummary,
  hypnogram,
  sleepNights,
  sleepSummary,
} = require("../.test-build/app/health/health-derive.js");
const { twoBlockNightFixture } = require("../.test-build/app/health/health-fixtures.js");
const { sleepNightDayStartMs, DAY_MS, HOUR_MS } = require("../.test-build/app/health/health-types.js");

const local = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "America/New_York" });
const midnight = (y, m, d) => new Date(y, m - 1, d).getTime();

// ---------------------------------------------------------------------------
// The stored rows, verbatim from files/health/sleep.jsonl on the phone,
// pulled 2026-09-13 10:35 EDT.

// Night of 09-11 -> 12. Stored RAW (pre-correction build): ring-clock 10:21:01.
const ROW_0912 = {"dayStartMs":1789185600000,"startMs":1789222861000,"endMs":1789233931000,"totalSec":10440,"wakeSec":630,"remSec":1620,"lightSec":5880,"deepSec":2940,"segments":[{"stageId":0,"halfMinutes":21},{"stageId":2,"halfMinutes":42},{"stageId":3,"halfMinutes":36},{"stageId":2,"halfMinutes":40},{"stageId":1,"halfMinutes":36},{"stageId":2,"halfMinutes":42},{"stageId":3,"halfMinutes":62},{"stageId":2,"halfMinutes":46},{"stageId":1,"halfMinutes":18},{"stageId":2,"halfMinutes":26}],"timeResolved":false};

// Night of 09-12 -> 13. Both stored under the -8h build; same start, the block
// delivered once part-grown and once at wake.
const ROW_0913_PARTIAL = {"dayStartMs":1789272000000,"startMs":1789266908000,"endMs":1789283738000,"totalSec":15660,"wakeSec":1170,"remSec":2340,"lightSec":9660,"deepSec":3660,"segments":[{"stageId":0,"halfMinutes":39},{"stageId":2,"halfMinutes":12},{"stageId":3,"halfMinutes":10},{"stageId":2,"halfMinutes":18},{"stageId":3,"halfMinutes":28},{"stageId":2,"halfMinutes":24},{"stageId":1,"halfMinutes":30},{"stageId":2,"halfMinutes":64},{"stageId":3,"halfMinutes":72},{"stageId":2,"halfMinutes":62},{"stageId":3,"halfMinutes":12},{"stageId":2,"halfMinutes":12},{"stageId":1,"halfMinutes":20},{"stageId":2,"halfMinutes":52},{"stageId":1,"halfMinutes":24},{"stageId":2,"halfMinutes":54},{"stageId":1,"halfMinutes":4},{"stageId":2,"halfMinutes":24}],"timeResolved":true};
const ROW_0913 = {"dayStartMs":1789272000000,"startMs":1789266908000,"endMs":1789290578000,"totalSec":22260,"wakeSec":1410,"remSec":3780,"lightSec":14100,"deepSec":4380,"segments":[{"stageId":0,"halfMinutes":39},{"stageId":2,"halfMinutes":12},{"stageId":3,"halfMinutes":10},{"stageId":2,"halfMinutes":18},{"stageId":3,"halfMinutes":28},{"stageId":2,"halfMinutes":24},{"stageId":1,"halfMinutes":30},{"stageId":2,"halfMinutes":58},{"stageId":3,"halfMinutes":84},{"stageId":2,"halfMinutes":56},{"stageId":3,"halfMinutes":12},{"stageId":2,"halfMinutes":12},{"stageId":1,"halfMinutes":20},{"stageId":2,"halfMinutes":52},{"stageId":1,"halfMinutes":24},{"stageId":2,"halfMinutes":54},{"stageId":1,"halfMinutes":4},{"stageId":2,"halfMinutes":30},{"stageId":0,"halfMinutes":8},{"stageId":2,"halfMinutes":50},{"stageId":3,"halfMinutes":12},{"stageId":2,"halfMinutes":26},{"stageId":1,"halfMinutes":20},{"stageId":2,"halfMinutes":30},{"stageId":1,"halfMinutes":12},{"stageId":2,"halfMinutes":48},{"stageId":1,"halfMinutes":16}],"timeResolved":true};

/** A stored row back into the shape the Java bridge hands `sleepWireFromRing`. */
function asRingRecord(row, startTs, endTs) {
  return {
    recordState: 1,
    startTs,
    endTs,
    totalTime: row.totalSec,
    wakeTime: row.wakeSec,
    remTime: row.remSec,
    lightTime: row.lightSec,
    deepTime: row.deepSec,
    segments: row.segments.map((s) => ({ stage: s.stageId, halfMinutes: s.halfMinutes })),
    receivedAtMs: row.endMs,
  };
}

/** Through the shipping path: Java-shaped record -> wire -> stored session. */
function shipped(ringRecord) {
  const wire = sleepWireFromRing(ringRecord);
  const { sleep } = convertRecords([wire]);
  assert.equal(sleep.length, 1);
  return sleep[0];
}

// ---------------------------------------------------------------------------
// The clock correction

test("this file really is running in EDT", () => {
  assert.equal(new Date(ROW_0913.startMs).getTimezoneOffset(), 240);
});

test("sleep takes the same clock correction as hourly samples: 1x, -4h in EDT", () => {
  const at = ROW_0913.startMs;
  assert.equal(sleepClockOffsetMs(at), ringClockOffsetMs(at));
  assert.equal(sleepClockOffsetMs(at), 4 * HOUR_MS);
});

test("known-good, night of 09-12 -> 13: the 6h34m block is 02:35:08 -> 09:09:38", () => {
  // Stored under -8h, so the raw ring seconds are the stored instant + 8h.
  const rawStartTs = ROW_0913.startMs / 1000 + 8 * 3600;
  const rawEndTs = ROW_0913.endMs / 1000 + 8 * 3600;
  const night = shipped(asRingRecord(ROW_0913, rawStartTs, rawEndTs));

  assert.equal(local(night.startMs), "2026-09-13 02:35:08");
  assert.equal(local(night.endMs), "2026-09-13 09:09:38");
  assert.equal(night.endMs - night.startMs, (6 * 3600 + 34 * 60 + 30) * 1000);
  assert.equal(night.timeResolved, true);
  assert.equal(night.dayStartMs, midnight(2026, 9, 13));
  // And the repair for the row already on the phone is exactly +4h.
  assert.equal(ROW_0913.startMs + 4 * HOUR_MS, night.startMs);
  assert.equal(ROW_0913.endMs + 4 * HOUR_MS, night.endMs);
});

test("known-good, night of 09-11 -> 12: the 3h04m block is 06:21:01 -> 09:25:31", () => {
  // Stored RAW (timeResolved: false) at ring-clock 10:21:01.
  assert.equal(local(ROW_0912.startMs), "2026-09-12 10:21:01");
  const night = shipped(asRingRecord(ROW_0912, ROW_0912.startMs / 1000, ROW_0912.endMs / 1000));

  assert.equal(local(night.startMs), "2026-09-12 06:21:01");
  assert.equal(local(night.endMs), "2026-09-12 09:25:31");
  assert.equal(night.endMs - night.startMs, (3 * 3600 + 4 * 60 + 30) * 1000);
  assert.equal(night.dayStartMs, midnight(2026, 9, 12));
  assert.equal(ROW_0912.startMs - 4 * HOUR_MS, night.startMs);
});

test("the RECSTATE=2 end-of-list marker is not a night", () => {
  assert.equal(sleepWireFromRing({ ...asRingRecord(ROW_0913, 0, 0), recordState: 2 }), null);
});

// ---------------------------------------------------------------------------
// The night window

test("a night is 20:00 -> 20:00, labelled by the day it ends in", () => {
  const sep13 = midnight(2026, 9, 13);
  assert.equal(sleepNightDayStartMs(sep13 + 30 * 60 * 1000), sep13, "00:30 -> that day");
  assert.equal(sleepNightDayStartMs(sep13 + 9 * HOUR_MS), sep13, "09:00 -> that day");
  assert.equal(sleepNightDayStartMs(sep13 + 20 * HOUR_MS - 1000), sep13, "19:59:59 -> that day");
  assert.equal(sleepNightDayStartMs(sep13 + 20 * HOUR_MS), midnight(2026, 9, 14), "20:00 -> the next");
  assert.equal(sleepNightDayStartMs(sep13 + 23 * HOUR_MS), midnight(2026, 9, 14), "23:00 -> the next");
});

test("a block belongs to the night its END falls in, whatever it was stored with", () => {
  const sep13 = midnight(2026, 9, 13);
  const block = {
    ...ROW_0913,
    dayStartMs: sep13, // the old midnight rule's label
    startMs: sep13 + 19 * HOUR_MS,
    endMs: sep13 + 20 * HOUR_MS + 30 * 60 * 1000,
  };
  const nights = assembleNights([block]);
  assert.equal(nights.length, 1);
  assert.equal(nights[0].dayStartMs, midnight(2026, 9, 14));
});

// ---------------------------------------------------------------------------
// Assembly

test("blocks sharing a start are one growing block: the longest supersedes, never sums", () => {
  for (const order of [[ROW_0913_PARTIAL, ROW_0913], [ROW_0913, ROW_0913_PARTIAL]]) {
    const night = assembleNight(order, midnight(2026, 9, 13));
    assert.ok(night, "the -8h rows still end on the 13th, so they are the 13th's night");
    assert.equal(night.blocks.length, 1);
    assert.equal(night.totalSec, ROW_0913.totalSec);
    assert.equal(night.wakeSec, ROW_0913.wakeSec);
    assert.equal(night.gapSec, 0);
    assert.equal(night.endMs, ROW_0913.endMs);
  }
});

test("two distinct blocks: totals add, the gap counts as wake, the identity still holds", () => {
  const day = midnight(2026, 9, 10);
  const night = assembleNight(twoBlockNightFixture(day), day);
  assert.ok(night);
  assert.equal(night.blocks.length, 2, "block B's early delivery is superseded, not a third block");
  assert.equal(local(night.startMs), "2026-09-09 23:30:00");
  assert.equal(local(night.endMs), "2026-09-10 08:05:00");
  assert.equal(night.gapSec, 35 * 60);
  assert.equal(night.totalSec, 28080, "7h48m asleep: block A + block B as it finally grew");
  assert.equal(night.wakeSec, 2820, "both blocks' own wake plus the 35-minute gap");
  assert.equal(night.segments.length, 16);
  assert.ok(sleepIdentityHolds(night), "sum(halfMinutes) * 30 == totalSec + wakeSec");
  assert.equal(night.endMs - night.startMs, (night.totalSec + night.wakeSec) * 1000);
});

test("the hypnogram runs across the gap as a wake band, in order", () => {
  const day = midnight(2026, 9, 10);
  const night = assembleNight(twoBlockNightFixture(day), day);
  const bands = hypnogram(night);
  assert.equal(bands.length, 16);
  assert.deepEqual(bands[5], { stage: "wake", seconds: 35 * 60 }, "the gap sits between the blocks");
  assert.equal(bands.reduce((sum, band) => sum + band.seconds, 0), 30900);
  assert.ok(bands.every((band) => band.stage !== null), "a gap never renders as an unmapped block");
  const wakeBandSeconds = bands.filter((b) => b.stage === "wake").reduce((sum, b) => sum + b.seconds, 0);
  const summary = sleepSummary(night);
  assert.equal(
    wakeBandSeconds,
    summary.stageBands.find((band) => band.stage === "wake").seconds,
    "the wake lane's label and its blocks agree",
  );
});

test("the glasses summary shows the assembled night, not the longest block", () => {
  const day = midnight(2026, 9, 10);
  const summary = dailySummary([], twoBlockNightFixture(day), day);
  assert.ok(summary.sleep);
  assert.equal(summary.sleep.totalSec, 28080, "not 21060, the longest single block");
  assert.equal(summary.sleep.wakeSec, 2820);
});

test("the nightly chart column is the assembled night", () => {
  const day = midnight(2026, 9, 10);
  const sessions = twoBlockNightFixture(day);
  const nights = sleepNights(sessions, day - DAY_MS, day + DAY_MS);
  assert.equal(nights.length, 2);
  assert.equal(nights[0].hasData, false);
  const night = nights[1];
  const assembled = assembleNight(sessions, day);
  assert.equal(night.hasData, true);
  assert.equal(night.wakeSec, 2820);
  assert.equal(night.lightSec, assembled.lightSec);
  assert.equal(night.deepSec + night.remSec + night.lightSec, 28080, "block B is not counted twice");
});

test("resolved and unresolved blocks are never assembled into one night", () => {
  const sep12 = midnight(2026, 9, 12);
  const resolved = { ...ROW_0913, dayStartMs: sep12, startMs: sep12 + 2 * HOUR_MS, endMs: sep12 + 2 * HOUR_MS + 23670 * 1000 };
  const night = assembleNight([ROW_0912, resolved], sep12);
  assert.ok(night);
  assert.equal(night.blocks.length, 1);
  assert.equal(night.timeResolved, true);
  assert.equal(night.gapSec, 0);
});

test("the raw stored 09-12 row still shows on its own night", () => {
  const night = assembleNight([ROW_0912], midnight(2026, 9, 12));
  assert.ok(night);
  assert.equal(night.timeResolved, false);
  assert.equal(night.totalSec, ROW_0912.totalSec);
});
