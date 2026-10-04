// Chris's day rule (2026-10-04): store absolute time; cut days at DISPLAY
// time in the phone's CURRENT zone. Steps/HR/HRV/SpO2 midnight -> midnight,
// sleep 20:00 -> 20:00 by the block's END.
//
// The JS engine here is pinned to Asia/Tokyo and never changes: that is the
// fault being fixed (the app's JS runtime kept Japan's zone for a day after
// landing home, ring-clock-fix return Step 0). The PHONE's zone is a fake
// `java.util.TimeZone` the test can move, as Android moves the real one. Every
// assertion below is about which of the two the day boundaries follow.
//
// This file uses only modules that exist on 062fb8a, so it runs there too
// (where the fake Java zone is ignored and every boundary is Tokyo's).
process.env.TZ = "Asia/Tokyo";

const test = require("node:test");
const assert = require("node:assert/strict");

// -- the fake phone zone ------------------------------------------------------

let phoneZone = "America/New_York";

function offsetMsIn(zone, utcMs) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs))) parts[p.type] = Number(p.value);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(utcMs / 1000) * 1000;
}

let javaCalls = 0;
globalThis.java = {
  util: {
    TimeZone: {
      getDefault() {
        javaCalls += 1;
        const zone = phoneZone;
        return { getID: () => zone, getOffset: (ms) => offsetMsIn(zone, ms) };
      },
    },
  },
};

/** Move the phone's zone, then let the zone module's 1 s re-read lapse. */
async function movePhoneTo(zone) {
  phoneZone = zone;
  await new Promise((resolve) => setTimeout(resolve, 1100));
}

const {
  startOfLocalDay,
  startOfLocalHour,
  sleepNightDayStartMs,
} = require("../.test-build/app/health/health-types.js");
const {
  assembleNight,
  dailySummary,
  rollupSeries,
  shortDate,
} = require("../.test-build/app/health/health-derive.js");
const { convertRecords, sleepWireFromRing } = require("../.test-build/app/health/health-ingest.js");
const { HealthStore } = require("../.test-build/app/health/health-store.js");

const HOUR = 3_600_000;
const TEN_MIN = 600_000;

// Instants, all checked by hand against `TZ=America/New_York date -d @...`.
const EDT_MIDNIGHT_1003 = 1791000000000; // 2026-10-03 00:00 EDT
const EDT_MIDNIGHT_1004 = 1791086400000; // 2026-10-04 00:00 EDT
const EDT_2000_1003 = 1791072000000; //     2026-10-03 20:00 EDT
const JST_MIDNIGHT_1004 = 1791039600000; // 2026-10-04 00:00 JST = 10-03 11:00 EDT

function memoryBackend() {
  const files = new Map();
  return {
    files,
    exists: (name) => files.has(name),
    read: (name) => files.get(name) ?? null,
    append(name, text) {
      files.set(name, (files.get(name) ?? "") + text);
    },
    write(name, text) {
      files.set(name, text);
    },
    list: () => [...files.keys()],
  };
}

function steps(startMs, value) {
  return { metric: "steps", startMs, spanMs: TEN_MIN, min: value, max: value, avg: value, total: value };
}

// -- boundaries follow the phone's zone, not the engine's ----------------------

test("the JS engine in this file really is in Tokyo", () => {
  assert.equal(new Date(EDT_MIDNIGHT_1004).getTimezoneOffset(), -540);
});

test("day, hour and night boundaries follow the phone's zone as it changes mid-process", async () => {
  await movePhoneTo("America/New_York");
  const noonEdt1004 = EDT_MIDNIGHT_1004 + 12 * HOUR;
  assert.equal(startOfLocalDay(noonEdt1004), EDT_MIDNIGHT_1004);
  assert.equal(sleepNightDayStartMs(EDT_2000_1003 - 1000), EDT_MIDNIGHT_1003); // 19:59:59 -> 10-03's night
  assert.equal(sleepNightDayStartMs(EDT_2000_1003), EDT_MIDNIGHT_1004); //        20:00:00 -> 10-04's night
  assert.equal(shortDate(EDT_MIDNIGHT_1004 + 3 * HOUR), "Sun 4 Oct");

  // The phone lands in Japan; the engine does not notice (it never does).
  await movePhoneTo("Asia/Tokyo");
  assert.equal(startOfLocalDay(noonEdt1004), EDT_MIDNIGHT_1004 + 11 * HOUR); // 01:00 JST 10-05 -> 10-05 00:00 JST = 15:00Z
  assert.equal(sleepNightDayStartMs(EDT_2000_1003), JST_MIDNIGHT_1004); // 09:00 JST 10-04 -> 10-04
  assert.equal(shortDate(EDT_MIDNIGHT_1004 + 3 * HOUR), "Sun 4 Oct");
  assert.equal(shortDate(EDT_MIDNIGHT_1004 + 12 * HOUR), "Mon 5 Oct");

  // And back.
  await movePhoneTo("America/New_York");
  assert.equal(startOfLocalDay(noonEdt1004), EDT_MIDNIGHT_1004);
  assert.equal(startOfLocalHour(EDT_MIDNIGHT_1004 + 90 * 60_000), EDT_MIDNIGHT_1004 + HOUR);
});

test("the phone zone is read from Java, at most about once a second", async () => {
  await movePhoneTo("America/New_York");
  const before = javaCalls;
  for (let i = 0; i < 5000; i++) startOfLocalDay(EDT_MIDNIGHT_1004 + i * TEN_MIN);
  assert.ok(javaCalls - before <= 2, `${javaCalls - before} Java reads for 5000 boundaries`);
});

test("a DST day is 25 hours long and the hour grid has 25 slots", async () => {
  await movePhoneTo("America/New_York");
  const nov1 = startOfLocalDay(Date.UTC(2026, 10, 1, 16)); // 2026-11-01, fall back
  const nov2 = startOfLocalDay(Date.UTC(2026, 10, 2, 16));
  assert.equal(nov2 - nov1, 25 * HOUR);
  const grid = rollupSeries([], { metric: "heartRate", granularity: "hour", startMs: nov1, endMs: nov2 });
  assert.equal(grid.length, 25);
});

// -- Chris's real Saturday -> Sunday, phone on EDT ------------------------------

// The reset: ringBoot 11:31:01.334 EDT, clock set ~11:31:01.4, trailer 35962 s
// -> boot 1791091899 = 01:31:39 EDT (ring-clock-fix return, addendum §2).
const BOOTS_1004 = [{ atMs: 1791127861334, bootAtMs: 1791091899000 }];

// The block the ring sent in uptime seconds (journal n=2598, receipt
// "startTs":9270,"endTs":33510), durations from the stored 1970 row.
const NIGHT_1004_RING = {
  recordState: 1,
  startTs: 9270,
  endTs: 33510,
  totalTime: 23430,
  wakeTime: 810,
  remTime: 3840,
  lightTime: 14070,
  deepTime: 5520,
  segments: [{ stage: 0, halfMinutes: 27 }],
  receivedAtMs: 1791127869000, // 11:31:09 EDT
};

// The 10-03 in-flight nap: ring 1791080130 with the ring at +7 h (the PDT
// write), 3990 s long -> 12:15:30-13:22:00 PDT = 15:15:30-16:22:00 EDT.
const NAP_1003_RING = {
  ...NIGHT_1004_RING,
  startTs: 1791080130,
  endTs: 1791080130 + 3990,
  totalTime: 3180,
  remTime: 690,
  lightTime: 1890,
  deepTime: 600,
  receivedAtMs: 1791068520000, // the 16:02 PDT pull, 23:02Z
};
const CLOCK_AT_PDT = [[0, 25200]];

function ingestSleep(record, clock, boots) {
  const wire = sleepWireFromRing(record, clock, () => boots);
  return convertRecords([wire]).sleep[0];
}

test("Sun 10-04 sleep day: the 04:06:09-10:50:09 EDT block, dated from the ring reset", async () => {
  await movePhoneTo("America/New_York");
  const night = ingestSleep(NIGHT_1004_RING, [[0, 14400]], BOOTS_1004);
  assert.equal(night.timeResolved, true);
  assert.equal(night.startMs, 1791101169000); // 04:06:09 EDT
  assert.equal(night.endMs, 1791125409000); //   10:50:09 EDT
  const assembled = assembleNight([night], EDT_MIDNIGHT_1004);
  assert.ok(assembled, "the 10-04 night exists");
  assert.equal(assembled.totalSec, 23430);
});

test("Sat 10-03 nap (ends 16:22 EDT) is in the 10-03 sleep day, not 10-04", async () => {
  await movePhoneTo("America/New_York");
  const nap = ingestSleep(NAP_1003_RING, CLOCK_AT_PDT, []);
  assert.equal(nap.startMs, 1791054930000); // 15:15:30 EDT 10-03
  assert.equal(nap.endMs, 1791058920000); //   16:22:00 EDT 10-03
  const night = ingestSleep(NIGHT_1004_RING, [[0, 14400]], BOOTS_1004);
  const sun = assembleNight([nap, night], EDT_MIDNIGHT_1004);
  assert.equal(sun.blocks.length, 1, "Sunday's sleep day holds only the 04:06 block");
  assert.equal(sun.startMs, 1791101169000);
  const sat = assembleNight([nap, night], EDT_MIDNIGHT_1003);
  assert.equal(sat.blocks.length, 1);
  assert.equal(sat.startMs, 1791054930000);
});

test("a clock-less block with no dated reset stays undated, never a 1970 row", async () => {
  await movePhoneTo("America/New_York");
  const undated = ingestSleep(NIGHT_1004_RING, [[0, 14400]], [{ atMs: 1791127861334, bootAtMs: null }]);
  assert.equal(undated.timeResolved, false);
  // A boot dated so early the block would end after it arrived is not this block's.
  const wrongBoot = ingestSleep(NIGHT_1004_RING, [[0, 14400]], [{ atMs: 1791127861334, bootAtMs: 1791127000000 }]);
  assert.equal(wrongBoot.timeResolved, false);
});

test("Sat 21:00-21:50 EDT steps count toward 10-03, not 10-04 (summary and rollup cache)", async () => {
  await movePhoneTo("America/New_York");
  const evening = [
    steps(EDT_2000_1003 + 1 * HOUR, 194), // 21:00
    steps(EDT_2000_1003 + 1 * HOUR + TEN_MIN, 632),
    steps(EDT_2000_1003 + 1 * HOUR + 2 * TEN_MIN, 162),
    steps(EDT_2000_1003 + 1 * HOUR + 5 * TEN_MIN, 236), // 21:50
  ];
  const early = [steps(EDT_MIDNIGHT_1004 + 3 * HOUR + 20 * 60_000, 10)]; // 03:20 EDT 10-04
  const all = [...evening, ...early];
  assert.equal(dailySummary(all, [], EDT_MIDNIGHT_1003).steps, 1224);
  assert.equal(dailySummary(all, [], EDT_MIDNIGHT_1004).steps, 10);

  const store = new HealthStore(memoryBackend());
  store.ingestSamples(all);
  const days = store.dailyRollups("steps", EDT_MIDNIGHT_1003, EDT_MIDNIGHT_1004 + 24 * HOUR);
  assert.equal(days.get(EDT_MIDNIGHT_1003)?.sum, 1224);
  assert.equal(days.get(EDT_MIDNIGHT_1004)?.sum, 10);
});

// -- stored per-day totals are a cache of the current zone ----------------------

test("the daily rollup cache is recomputed when the phone's zone changes; no sample is lost", async () => {
  await movePhoneTo("America/New_York");
  const backend = memoryBackend();
  const store = new HealthStore(backend);
  const evening = [steps(EDT_2000_1003 + HOUR, 194), steps(EDT_2000_1003 + HOUR + TEN_MIN, 632)];
  store.ingestSamples(evening);
  assert.equal(store.dailyRollups("steps", EDT_MIDNIGHT_1003, EDT_MIDNIGHT_1004).get(EDT_MIDNIGHT_1003)?.sum, 826);
  assert.equal(JSON.parse(backend.files.get("rollups.json")).zone, "America/New_York");

  // In Japan the same 21:00 EDT is 10:00 JST on 10-04: a 10-04 step.
  await movePhoneTo("Asia/Tokyo");
  const jstDays = store.dailyRollups("steps", JST_MIDNIGHT_1004 - 24 * HOUR, JST_MIDNIGHT_1004 + 24 * HOUR);
  assert.equal(jstDays.get(JST_MIDNIGHT_1004)?.sum, 826);
  assert.equal(jstDays.get(JST_MIDNIGHT_1004 - 24 * HOUR), undefined);
  assert.equal(JSON.parse(backend.files.get("rollups.json")).zone, "Asia/Tokyo");

  // A fresh process (new store) reading a file cut in another zone rebuilds it.
  await movePhoneTo("America/New_York");
  const reopened = new HealthStore(backend);
  assert.equal(reopened.dailyRollups("steps", EDT_MIDNIGHT_1003, EDT_MIDNIGHT_1004).get(EDT_MIDNIGHT_1003)?.sum, 826);
  assert.equal(reopened.samplesInRange(EDT_MIDNIGHT_1003, EDT_MIDNIGHT_1004 + 24 * HOUR).length, 2);
});

test("a bucket re-delivered in another zone near a month edge is held once", async () => {
  // 2026-09-30 22:00 EDT = 10-01 02:00Z = 10-01 11:00 JST.
  const t = Date.UTC(2026, 9, 1, 2);
  const backend = memoryBackend();
  // A legacy shard: written by the old build in EDT, named by the local month.
  backend.files.set("samples-2026-09.jsonl", JSON.stringify({ m: "steps", t, s: TEN_MIN, n: 5, x: 5, a: 5, u: 5 }) + "\n");
  await movePhoneTo("Asia/Tokyo");
  const store = new HealthStore(backend);
  store.ingestSamples([steps(t, 40)]); // the window filled, re-delivered after the trip
  const held = store.samplesInRange(t - HOUR, t + HOUR);
  assert.equal(held.length, 1);
  assert.equal(held[0].total, 40);
  assert.equal(backend.files.has("samples-2026-10.jsonl"), false, "corrected in the shard that held it");
});
