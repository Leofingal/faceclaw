#!/usr/bin/env node
// One-off repair of the phone's files/health after the Japan trip (2026-10-04).
//
//   node tools/health-trip-repair/repair.cjs <snapshot health dir> <decoded.jsonl> <out health dir> [report.json]
//
// Run through run.sh, which compiles this tree's TypeScript (`tests/tsconfig.json`
// -> .test-build) and decodes ring-pages.jsonl with this tree's RingProtocol.
//
// WHAT IT DOES
// Every record still in the ring page journal is re-derived from its raw page
// with the ring clock offset in force when the RING STAMPED it, through this
// tree's own conversion (`health-ingest.ts`) and store (`health-store.ts`). The
// stored rows those pages produced under the old build (062fb8a: ring minus the
// JS engine's zone offset, and the JS engine held JST until the 10-04 reboot)
// are computed too. A stored key that the old build put at a wrong instant is
// removed outright (its lines are not copied to the repaired shard), and the true
// samples are then ingested through HealthStore, whose own dedupe leaves every
// already-right row untouched. Lines for keys no journal page touches are copied
// byte for byte, in order.
//
// THE RING CLOCK HISTORY is read from the receipts, not assumed, and asserted
// against the values the seat gave (instruction §Inputs 3):
//   - until the first Java receipt in -0700 (the 11:22 PDT 10-03 connect): -32400
//   - from that connect's write: +25200 (written onto a ring reset at ~11:17 PDT)
//   - from the first -0400 receipt (19:27 EDT 10-03): +14400 (a 3 h BACKWARD step)
//   - the 01:31:39 EDT 10-04 reset: uptime stamps until the 11:31 EDT connect,
//     which wrote +14400 again.
// A group or bucket is placed in the era its ring span says, with the backward
// step resolved by arrival: a page received after the step carries the ring's
// current meaning of that ring second (+14400) unless the span ends before the
// step's landing point (then it can only be +25200 data).
//
// After the reset the ring sent every hourly type and steps twice: an UPTIME
// copy (anchor -1) and a copy re-anchored to the ring-day 8 h late. The uptime
// copy is dated boot + index; an anchored group equal on every field to the
// uptime group 8 h (48 buckets) before it is the duplicate and is dropped.

"use strict";

process.env.TZ = "America/New_York";

const fs = require("fs");
const path = require("path");

const [, , SNAP, DECODED, OUT, REPORT] = process.argv;
if (!SNAP || !DECODED || !OUT) {
  console.error("usage: repair.cjs <snapshot health dir> <decoded.jsonl> <out health dir> [report.json]");
  process.exit(2);
}

// The phone's zone, as the app reads it from Java: the rollup cache records it.
const PHONE_ZONE = "America/New_York";
function offsetMsIn(zone, utcMs) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(utcMs))) parts[p.type] = Number(p.value);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(utcMs / 1000) * 1000;
}
globalThis.java = {
  util: { TimeZone: { getDefault: () => ({ getID: () => PHONE_ZONE, getOffset: (ms) => offsetMsIn(PHONE_ZONE, Number(ms)) }) } },
};

const BUILD = path.resolve(__dirname, "../../.test-build/app");
const ingest = require(`${BUILD}/health/health-ingest.js`);
const { HealthStore } = require(`${BUILD}/health/health-store.js`);
const derive = require(`${BUILD}/health/health-derive.js`);
const types = require(`${BUILD}/health/health-types.js`);
const zone = require(`${BUILD}/util/local-zone.js`);

const HOUR = 3600;
const FLOOR = ingest.RING_TIME_FLOOR_SEC;
const fail = [];
function check(cond, what) {
  if (!cond) fail.push(what);
  return cond;
}
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const edt = (ms) =>
  new Date(ms).toLocaleString("sv-SE", { timeZone: "America/New_York" }) + " EDT";

// ---------------------------------------------------------------------------
// Inputs

const read = (name) => fs.readFileSync(path.join(SNAP, name), "utf8");
const lines = (text) => text.split("\n").filter((l) => l.length > 0);
const pages = lines(fs.readFileSync(DECODED, "utf8")).map((l) => JSON.parse(l));
const receipts = lines(read("ring-sleep-receipts.jsonl"))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);
const resumeLines = lines(read("resume-receipts.jsonl"))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const zoneOf = (r) => {
  const s = r.at || r.req || r.rx || "";
  const m = s.match(/([+-]\d\d:?\d\d)$/);
  return m ? m[1].replace(":", "") : null;
};
const msOf = (r) => r.atMs ?? r.reqMs ?? r.rxMs ?? null;

// ---------------------------------------------------------------------------
// The ring clock history, from Java's receipts (Java follows the phone's zone;
// every connect of the old build wrote `now - zone offset`).

const TRIP_FROM = Date.UTC(2026, 8, 30); // the journal's era; the trip zones before it are checked below
function firstReceiptInZone(zoneId, afterMs) {
  return receipts.find((r) => msOf(r) !== null && msOf(r) >= afterMs && zoneOf(r) === zoneId) ?? null;
}
const lastJst = [...receipts].reverse().find((r) => zoneOf(r) === "+0900");
const pdtWrite = firstReceiptInZone("-0700", msOf(lastJst));
const edtWrite = firstReceiptInZone("-0400", msOf(pdtWrite));
const W1 = { atMs: msOf(pdtWrite), offset: 25200 };
W1.ringSec = Math.floor(W1.atMs / 1000) + W1.offset;
const W2 = { atMs: msOf(edtWrite), offset: 14400 };
W2.ringBeforeSec = Math.floor(W2.atMs / 1000) + W1.offset;
W2.ringSec = Math.floor(W2.atMs / 1000) + W2.offset;
check(W1.atMs === 1791051764752, `PDT write at 11:22:44.752 PDT 10-03 (got ${W1.atMs})`);
check(W2.atMs === 1791070040283, `EDT write at 19:27:20.283 EDT 10-03 (got ${W2.atMs})`);
check(pdtWrite.type === "ringBoot", "the PDT write is a ringBoot connect (the ring had reset in transit)");

// The 10-04 reset, dated from the 11:31 connect's ringBoot and the pages' trailer.
const RESET_TRAILER = 35962;
const resetBoot = receipts.find((r) => r.type === "ringBoot" && r.atMs >= Date.UTC(2026, 9, 4, 15) && r.atMs < Date.UTC(2026, 9, 4, 16));
check(resetBoot && resetBoot.atMs === 1791127861334, "11:31:01.334 EDT ringBoot present");
const BOOT_AT_MS = (Math.floor(resetBoot.atMs / 1000) - RESET_TRAILER) * 1000;
check(BOOT_AT_MS === 1791091899000, `reset dated 01:31:39 EDT 10-04 = 1791091899000 (got ${BOOT_AT_MS})`);

// The JS engine's zone, from JS-written resume receipts: JST from 09-27 17:51 JST
// to the 10-04 reboot. The old build's correction used it.
const jsJst = resumeLines.filter((r) => /\+09:00$/.test(r.at || ""));
const JS_JST_FROM = jsJst[0].atMs;
const JS_JST_LAST = jsJst[jsJst.length - 1].atMs;
const JS_EDT_FROM = resumeLines.find((r) => r.atMs > JS_JST_LAST && /-04:00$/.test(r.at || "")).atMs;
check(JS_JST_LAST === 1791079935938, `last JST-stamped JS receipt 22:12:15 EDT 10-03 (got ${iso(JS_JST_LAST)})`);
const ambiguousJs = pages.filter((p) => p.rxMs > JS_JST_LAST && p.rxMs < JS_EDT_FROM);
check(ambiguousJs.length === 0, `no page arrived while the JS zone is unknown (${ambiguousJs.length})`);
/** Minutes WEST of UTC, as `Date#getTimezoneOffset` answered in the old app process. */
function oldJsOffsetMin(rxMs, atMs) {
  if (rxMs >= JS_JST_FROM && rxMs <= JS_JST_LAST) return -540;
  return new Date(atMs).getTimezoneOffset(); // engine pinned to New York above
}

/**
 * The offset (s, ring ahead of UTC) in force when the ring stamped the span
 * [ringSec, ringSec + spanSec), for a page that arrived at rxMs. null = clock-less.
 */
function trueOffsetSec(ringSec, spanSec, rxMs) {
  if (ringSec < FLOOR) return null;
  if (rxMs < W1.atMs) return -32400;
  if (ringSec + spanSec <= W1.ringSec) return -32400; // stamped before the reset/PDT write
  if (rxMs < W2.atMs) return 25200;
  if (ringSec + spanSec <= W2.ringSec) return 25200; // wholly before the backward step's landing point
  return 14400;
}

// Verify each segment against the page headers: an hourly page's tag is its
// newest record's ring time, so tag - rx must sit just below the offset.
const eraCheck = {};
for (const p of pages) {
  if (!p.rec || p.rec.kind !== "hourly" || p.rec.tagRaw < FLOOR) continue;
  const rxSec = p.rxMs / 1000;
  const off = trueOffsetSec(p.rec.tagRaw, 0, p.rxMs);
  const lag = off - (p.rec.tagRaw - rxSec); // how far the newest record trails "now" on the ring
  const key = String(off);
  eraCheck[key] = eraCheck[key] || { pages: 0, minLagSec: Infinity, maxLagSec: -Infinity, firstRx: iso(p.rxMs), lastRx: null };
  const e = eraCheck[key];
  e.pages += 1;
  e.minLagSec = Math.min(e.minLagSec, Math.round(lag));
  e.maxLagSec = Math.max(e.maxLagSec, Math.round(lag));
  e.lastRx = iso(p.rxMs);
  check(lag >= -120 && lag <= 2 * 3600, `page n=${p.n}: tag lags the ring's now by ${Math.round(lag)} s under ${off}`);
}

// ---------------------------------------------------------------------------
// Re-derive every journal record: true placement, and where the old build put it.

/** Clock-less pages of the 10-04 reset: anchor -1, that boot's trailer, that connect. */
function isResetUptimeCopy(p) {
  return p.rec && p.rec.anchorUnixSeconds === -1 && p.trailerSec === RESET_TRAILER &&
    p.rxMs >= resetBoot.atMs && p.rxMs < resetBoot.atMs + 60_000;
}
const uptimeCopy = {}; // metric -> index -> fields
for (const p of pages.filter(isResetUptimeCopy)) {
  const r = p.rec;
  if (r.kind === "hourly") {
    const m = metricOf(p.cmdHi);
    uptimeCopy[m] = uptimeCopy[m] || {};
    for (const g of r.groups) uptimeCopy[m][g.hourIndex] = g;
  } else if (r.kind === "steps") {
    uptimeCopy.steps = uptimeCopy.steps || {};
    for (const b of r.buckets) uptimeCopy.steps[b.index] = b;
  }
}
function metricOf(cmdHi) {
  return { 1: "heartRate", 2: "spo2", 4: "hrv", 5: "steps", 6: "sleep" }[cmdHi];
}
const sameHourly = (a, b) => a && b && a.avg === b.avg && a.max === b.max && a.min === b.min;
const sameBucket = (a, b) => a && b && a.steps === b.steps && a.calorieLike2 === b.calorieLike2 && a.calorieLike3 === b.calorieLike3;

// The re-anchoring shift, found rather than assumed: the shift at which the first
// re-anchored page after the reset reproduces its uptime copy group for group.
const SHIFT = {};
let DUP_ANCHOR = null; // the ring-day the duplicates were re-anchored to
for (const p of pages) {
  if (!p.rec || p.trailerSec !== RESET_TRAILER || p.rec.anchorUnixSeconds === -1) continue;
  if (p.rxMs >= resetBoot.atMs + 60_000) continue;
  const m = metricOf(p.cmdHi);
  const copy = uptimeCopy[m];
  if (!copy) continue;
  const items = p.rec.kind === "hourly" ? p.rec.groups : p.rec.buckets;
  const idx = (x) => (p.rec.kind === "hourly" ? x.hourIndex : x.index);
  const same = p.rec.kind === "hourly" ? sameHourly : sameBucket;
  for (let s = 1; s <= 144; s++) {
    if (items.every((x) => same(x, copy[idx(x) - s]))) { SHIFT[m] = s; DUP_ANCHOR = p.rec.anchorUnixSeconds; break; }
  }
}
check(SHIFT.heartRate === 8 && SHIFT.hrv === 8 && SHIFT.spo2 === 8, `hourly re-anchoring shift is 8 h for every type (${JSON.stringify(SHIFT)})`);
check(SHIFT.steps === 48, `steps re-anchoring shift is 48 buckets = 8 h (${SHIFT.steps})`);
check(DUP_ANCHOR === 1791086400, `duplicates re-anchored to ring-day 1791086400 (${DUP_ANCHOR})`);

const deliveries = []; // one per group/bucket/session delivered
const dupsDropped = [];
for (const p of pages) {
  const r = p.rec;
  if (!r) continue;
  const m = metricOf(p.cmdHi);
  if (r.kind === "hourly" || r.kind === "steps") {
    const span = r.kind === "hourly" ? HOUR : 600;
    const items = r.kind === "hourly" ? r.groups : r.buckets;
    for (const it of items) {
      const index = r.kind === "hourly" ? it.hourIndex : it.index;
      const d = { n: p.n, rxMs: p.rxMs, metric: m, kind: r.kind, anchor: r.anchorUnixSeconds, index, it };
      if (r.anchorUnixSeconds === -1) {
        if (!isResetUptimeCopy(p)) { d.trueStartMs = null; d.why = "anchor -1, not the dated reset"; }
        else { d.era = "uptime"; d.trueStartMs = BOOT_AT_MS + index * span * 1000; }
        d.oldStartMs = null; // the old build dropped every anchor -1 page
      } else {
        const ringSec = r.anchorUnixSeconds + index * span;
        const off = trueOffsetSec(ringSec, span, p.rxMs);
        d.era = off;
        d.ringSec = ringSec;
        // Placed through this tree's own conversion of a ring second.
        d.trueStartMs = ingest.ringSecToRealMs([[0, off]], ringSec);
        d.oldStartMs = ringSec * 1000 - oldJsOffsetMin(p.rxMs, ringSec * 1000) * 60000;
        const s = SHIFT[m];
        if (p.trailerSec === RESET_TRAILER && r.anchorUnixSeconds === DUP_ANCHOR && s && uptimeCopy[m]) {
          const twin = uptimeCopy[m][index - s];
          if ((r.kind === "hourly" ? sameHourly : sameBucket)(it, twin)) {
            d.dup = true;
            dupsDropped.push({ n: p.n, metric: m, index, storedAt: edt(d.oldStartMs), uptimeTwin: index - s, twinAt: edt(BOOT_AT_MS + (index - s) * span * 1000) });
          }
        }
      }
      deliveries.push(d);
    }
  } else if (r.kind === "sleep" && r.recordState === 1) {
    const wire = ingest.sleepWireFromRing(
      { ...r, segments: r.segments },
      r.startTs < FLOOR ? [[0, 0]] : [[0, trueOffsetSec(r.startTs, r.endTs - r.startTs, p.rxMs)]],
      () => [{ atMs: resetBoot.atMs, bootAtMs: BOOT_AT_MS }],
    );
    const session = ingest.convertRecords([wire]).sleep[0];
    const oldStartMs = r.startTs * 1000 - oldJsOffsetMin(p.rxMs, r.startTs * 1000) * 60000;
    deliveries.push({ n: p.n, rxMs: p.rxMs, metric: "sleep", kind: "sleep", session, oldStartMs, trueStartMs: session.startMs, era: r.startTs < FLOOR ? "uptime" : trueOffsetSec(r.startTs, 0, p.rxMs) });
  }
}

// A second duplicate class, found here (not in the instruction): after the
// in-transit reset (~11:17 PDT 10-03) the ring re-anchored some of the previous
// ring-day's step buckets to the new ring-day at the SAME index. Buckets 138-140
// of ring-day 1791000000 (16:00-16:30 EDT 10-03, mid-nap) equal 10-03 08:00-08:30
// EDT (ring-day 1790913600, Japan) on all three fields. Listed always; dropped
// only with HEALTH_REPAIR_DROP_TRANSIT_COPIES=1 (the seat's and Chris's call).
const DROP_TRANSIT = process.env.HEALTH_REPAIR_DROP_TRANSIT_COPIES === "1";
const transitCopies = [];
{
  const japan = new Map();
  for (const d of deliveries) {
    if (d.kind === "sleep" || d.era !== -32400) continue;
    japan.set(`${d.metric}|${d.anchor}|${d.index}`, d);
  }
  for (const d of deliveries) {
    // Steps only: a bucket carries three independent fields (steps and two
    // calorie counts). An hourly SpO2/HRV value is often one reading, so a match
    // there is chance (seen: SpO2 96 = 96), not evidence.
    if (d.kind !== "steps" || (d.era !== 25200 && d.era !== 14400)) continue;
    const twin = japan.get(`${d.metric}|${d.anchor - 86400}|${d.index}`);
    if (!twin) continue;
    if (!(d.kind === "hourly" ? sameHourly : sameBucket)(d.it, twin.it)) continue;
    d.transitCopy = true;
    if (DROP_TRANSIT) d.dup = true;
    transitCopies.push({ n: d.n, metric: d.metric, index: d.index, at: edt(d.trueStartMs), value: d.kind === "hourly" ? d.it.avg : d.it.steps, twinN: twin.n, twinAt: edt(twin.trueStartMs), dropped: DROP_TRANSIT });
  }
}

// ---------------------------------------------------------------------------
// True samples, collapsed to one value per key the way the live path does:
// hourly = the latest delivery of that ring group; steps = max per ring bucket
// (the ledger's merge), within one era.

const trueByGroup = new Map(); // `${metric}|${anchor}|${era}|${index}` -> delivery
for (const d of deliveries) {
  if (d.kind === "sleep" || d.dup || d.trueStartMs === null) continue;
  const id = `${d.metric}|${d.anchor}|${d.era}|${d.index}`;
  const held = trueByGroup.get(id);
  if (d.kind === "hourly") trueByGroup.set(id, d); // pages are in arrival order
  else if (!held) trueByGroup.set(id, { ...d, it: { ...d.it } });
  else {
    held.it.steps = Math.max(held.it.steps, d.it.steps);
    held.it.calorieLike2 = Math.max(held.it.calorieLike2, d.it.calorieLike2);
    held.it.calorieLike3 = Math.max(held.it.calorieLike3, d.it.calorieLike3);
    held.rxMs = d.rxMs;
    held.n = d.n;
  }
}
// Through this tree's conversion: wire records with each group's own startMs.
const wires = [];
for (const d of [...trueByGroup.values()].sort((a, b) => a.rxMs - b.rxMs)) {
  if (d.kind === "hourly") {
    wires.push({ kind: "hourly", metric: d.metric, anchorMs: d.trueStartMs, groups: [{ hourIndex: 0, avg: d.it.avg, max: d.it.max, min: d.it.min, startMs: d.trueStartMs }] });
  } else {
    wires.push({ kind: "steps", anchorMs: d.trueStartMs, buckets: [{ index: 0, steps: d.it.steps, activeCalories: d.it.calorieLike2, totalCalories: d.it.calorieLike3, startMs: d.trueStartMs }] });
  }
}
const converted = ingest.convertRecords(wires);
check(converted.skipped.length === 0, `conversion skipped nothing (${converted.skipped.length})`);
// Two ring groups landing on one true key: the later arrival wins (store rule); listed.
const trueSamples = new Map();
const collisions = [];
for (const s of converted.samples) {
  const k = `${s.metric}|${s.startMs}|${s.spanMs}`;
  const held = trueSamples.get(k);
  if (held && (held.total !== s.total || held.avg !== s.avg)) collisions.push({ key: k, at: edt(s.startMs), was: held.total, now: s.total });
  trueSamples.set(k, s);
}

// Sleep: the latest delivery per true start.
const trueSleep = new Map();
for (const d of deliveries) if (d.kind === "sleep") trueSleep.set(d.session.startMs, d);

// ---------------------------------------------------------------------------
// Which stored keys are wrong

const wrongSampleKeys = new Map(); // key -> Set of reasons
const metricsOf = (d) => (d.kind === "steps" ? ["steps", "calories"] : [d.metric]);
const addReason = (k, why) => { if (!wrongSampleKeys.has(k)) wrongSampleKeys.set(k, new Set()); wrongSampleKeys.get(k).add(why); };
for (const d of deliveries) {
  if (d.kind === "sleep" || d.oldStartMs === null) continue;
  const span = d.kind === "hourly" ? HOUR * 1000 : 600000;
  if (d.dup) {
    for (const m of metricsOf(d)) addReason(`${m}|${d.oldStartMs}|${span}`, d.transitCopy ? "transit copy" : "re-anchored duplicate");
  } else if (d.trueStartMs !== d.oldStartMs) {
    for (const m of metricsOf(d)) addReason(`${m}|${d.oldStartMs}|${span}`, d.era === 25200 ? "ring +7 h era, stored +16 h" : d.era === 14400 ? "ring +4 h era, stored +13 h" : `era ${d.era}`);
  }
}
const wrongSleepStarts = new Map();
for (const d of deliveries) {
  if (d.kind === "sleep" && d.oldStartMs !== d.trueStartMs) wrongSleepStarts.set(d.oldStartMs, `stored ${iso(d.oldStartMs)}, true ${iso(d.trueStartMs)}`);
}

// ---------------------------------------------------------------------------
// Build the repaired copy

const original = {};
for (const name of fs.readdirSync(SNAP)) original[name] = fs.readFileSync(path.join(SNAP, name));
const files = new Map(); // name -> text, for the store's backend
const shardNames = Object.keys(original).filter((n) => /^samples-\d{4}-\d{2}\.jsonl$/.test(n)).sort();
const removedLines = {};
const keyOfLine = (line) => { const o = JSON.parse(line); return `${o.m}|${o.t}|${o.s}`; };
const originalEffective = new Map();
for (const name of shardNames) {
  const kept = [];
  removedLines[name] = 0;
  for (const line of lines(original[name].toString("utf8"))) {
    const k = keyOfLine(line);
    originalEffective.set(k, JSON.parse(line));
    if (wrongSampleKeys.has(k)) removedLines[name] += 1;
    else kept.push(line);
  }
  files.set(name, kept.map((l) => l + "\n").join(""));
}
const sleepKept = [];
let sleepRemoved = 0;
for (const line of lines(original["sleep.jsonl"].toString("utf8"))) {
  const o = JSON.parse(line);
  if (wrongSleepStarts.has(o.startMs)) sleepRemoved += 1;
  else sleepKept.push(line);
}
files.set("sleep.jsonl", sleepKept.map((l) => l + "\n").join(""));

const backend = {
  files,
  exists: (n) => files.has(n),
  read: (n) => (files.has(n) ? files.get(n) : null),
  append: (n, t) => files.set(n, (files.get(n) ?? "") + t),
  write: (n, t) => files.set(n, t),
  list: () => [...files.keys()],
};
const store = new HealthStore(backend);
const samplesWritten = store.ingestSamples([...trueSamples.values()]);
// Sleep: only sessions whose start no kept row holds, so right rows keep their bytes.
const keptStarts = new Set(sleepKept.map((l) => JSON.parse(l).startMs));
const sleepToWrite = [...trueSleep.values()].filter((d) => !keptStarts.has(d.session.startMs)).map((d) => d.session);
const sleepWritten = store.ingestSleep(sleepToWrite);
store.rebuildRollups();

fs.mkdirSync(OUT, { recursive: true });
const changed = [];
for (const name of Object.keys(original).sort()) {
  const out = files.has(name) || name === "rollups.json" ? Buffer.from(files.get(name), "utf8") : original[name];
  fs.writeFileSync(path.join(OUT, name), out);
  if (!out.equals(original[name])) changed.push(name);
}
for (const name of files.keys()) if (!(name in original)) { fs.writeFileSync(path.join(OUT, name), files.get(name)); changed.push(`${name} (new)`); }

// ---------------------------------------------------------------------------
// Acceptance, read back through this tree's store and derive code (zone EDT)

const repaired = new HealthStore({
  exists: (n) => fs.existsSync(path.join(OUT, n)),
  read: (n) => (fs.existsSync(path.join(OUT, n)) ? fs.readFileSync(path.join(OUT, n), "utf8") : null),
  append: () => { throw new Error("read-only"); },
  write: () => {},
  list: () => fs.readdirSync(OUT),
});
check(zone.currentZoneId() === PHONE_ZONE, "zone is the phone's America/New_York");
const D1003 = types.startOfLocalDay(Date.UTC(2026, 9, 3, 16));
const D1004 = types.startOfLocalDay(Date.UTC(2026, 9, 4, 16));
const D1005 = types.addLocalDays(D1004, 1);
check(D1004 === 1791086400000 && D1003 === 1791000000000, "EDT midnights 10-03/10-04");
const sessions = repaired.sleepSessions();
const night1004 = derive.assembleNight(sessions, D1004);
const night1003 = derive.assembleNight(sessions, D1003);
const acceptance = {};
acceptance.sleep1004 = night1004 && night1004.blocks.map((b) => ({ start: edt(b.startMs), end: edt(b.endMs), totalSec: b.totalSec, wakeSec: b.wakeSec }));
check(night1004 && night1004.blocks.length === 1, "10-04 sleep day holds exactly one block");
check(night1004 && night1004.startMs === 1791101169000 && night1004.endMs === 1791125409000, "10-04 block is 04:06:09-10:50:09 EDT");
check(night1004 && night1004.totalSec === 23430 && night1004.wakeSec === 810, "10-04 block: 23430 s asleep, 810 s awake");
acceptance.sleep1003 = night1003 && night1003.blocks.map((b) => ({ start: edt(b.startMs), end: edt(b.endMs), totalSec: b.totalSec }));
check(night1003 && night1003.blocks.some((b) => b.startMs === 1791054930000 && b.endMs === 1791058920000), "the plane nap 15:15:30-16:22:00 EDT is in the 10-03 sleep day");
check(!sessions.some((s) => s.startMs < Date.UTC(2000, 0, 1)), "no 1970 sleep row");
check(!sessions.some((s) => s.startMs === 1791112530000), "the nap's wrong row (07:15:30 EDT 10-04) is gone");

const day = (start) => repaired.samplesInRange(start, types.addLocalDays(start, 1));
const s1004 = day(D1004);
const s1003 = day(D1003);
const nonzero = (list) => list.filter((s) => s.metric === "steps" && s.total > 0).map((s) => `${edt(s.startMs).slice(11, 16)}=${s.total}`);
acceptance.steps1004 = { total: derive.dailySummary(s1004, sessions, D1004).steps, buckets: nonzero(s1004) };
acceptance.steps1003 = { total: derive.dailySummary(s1003, sessions, D1003).steps, eveningFrom1900: nonzero(s1003.filter((s) => s.startMs >= D1003 + 19 * 3600000)) };
const stepAt = (list, ms) => list.find((s) => s.metric === "steps" && s.startMs === ms)?.total;
const walk = [0, 1, 3].map((k) => stepAt(s1004, BOOT_AT_MS + (11 + k) * 600000));
check(walk.join() === "10,56,17", `10-04 walk = 10/56/17 at 03:21:39, 03:31:39, 03:51:39 EDT (got ${walk})`);
const stepsBetween = (list, from, to) => list.filter((s) => s.metric === "steps" && s.startMs >= from && s.startMs < to).reduce((a, s) => a + s.total, 0);
check(stepsBetween(s1004, D1004, D1004 + 3 * 3600000) === 0, "10-04 00:00-03:00 EDT: no steps");
check(stepsBetween(s1004, D1004 + 4.25 * 3600000, D1004 + 11 * 3600000) === 0, "10-04 04:15-11:00 EDT: no steps (the +8 h duplicates are gone)");
check(stepsBetween(s1004, D1004, D1004 + 11 * 3600000) === 83, "10-04 before 11:00 EDT = 83 steps (the uptime copy's walk)");
const evening = [21 * 60, 21 * 60 + 10, 21 * 60 + 20, 21 * 60 + 50].map((min) => stepAt(s1003, D1003 + min * 60000));
check(evening.join() === "194,632,162,236", `10-03 21:00/21:10/21:20/21:50 EDT = 194/632/162/236 (got ${evening})`);
check(stepAt(s1003, D1003 + (19 * 60 + 40) * 60000) === 404, "10-03 19:40 EDT airport walk = 404");
check(acceptance.steps1004.total < 300, `10-04 steps nearly none (${acceptance.steps1004.total})`);
// HR after the reset: the uptime copy, dated boot + h.
const hr0 = repaired.samplesInRange(BOOT_AT_MS, BOOT_AT_MS + 1).find((s) => s.metric === "heartRate");
check(hr0 && hr0.avg === 68, "HR 01:31:39 EDT 10-04 (uptime h0) = 68");
for (const m of ["heartRate", "spo2", "hrv"]) {
  const anchoredDupHours = s1004.filter((s) => s.metric === m && s.startMs >= D1004 + 4 * 3600000 && s.startMs < D1004 + 11 * 3600000 && (s.startMs - D1004) % 3600000 === 0);
  check(anchoredDupHours.length === 0, `${m}: no hour-aligned rows 04:00-10:00 EDT 10-04 (the +8 h duplicates) (${anchoredDupHours.length})`);
}

// One clean pre-trip night, byte for byte: the 09-26 night (ends 08:00Z = 04:00 EDT).
const cleanNight = lines(original["sleep.jsonl"].toString("utf8")).find((l) => JSON.parse(l).startMs === 1790408100000 - 14400000);
check(cleanNight && fs.readFileSync(path.join(OUT, "sleep.jsonl"), "utf8").split("\n").includes(cleanNight), "09-26 night's sleep row is byte-identical");
const cleanHr = lines(original["samples-2026-09.jsonl"].toString("utf8")).filter((l) => { const o = JSON.parse(l); return o.t >= Date.UTC(2026, 8, 26, 3) && o.t < Date.UTC(2026, 8, 26, 8); });
const repairedSep = new Set(fs.readFileSync(path.join(OUT, "samples-2026-09.jsonl"), "utf8").split("\n"));
check(cleanHr.length > 0 && cleanHr.every((l) => repairedSep.has(l)), `09-26 03:00-08:00Z sample rows byte-identical (${cleanHr.length} lines)`);

// ---------------------------------------------------------------------------
// Accounting

const effective = (name, dir) => {
  const m = new Map();
  for (const l of lines(fs.readFileSync(path.join(dir, name), "utf8"))) { const o = JSON.parse(l); m.set(`${o.m}|${o.t}|${o.s}`, o); }
  return m;
};
const counts = {};
for (const name of shardNames.concat([...files.keys()].filter((n) => /^samples-/.test(n) && !shardNames.includes(n)))) {
  const before = name in original ? effective(name, SNAP) : new Map();
  const after = effective(name, OUT);
  let redatedIn = 0, valueChanged = 0, unchangedKeys = 0;
  for (const [k, o] of after) {
    const b = before.get(k);
    if (!b) redatedIn += 1;
    else if (b.n === o.n && b.x === o.x && b.a === o.a && b.u === o.u) unchangedKeys += 1;
    else valueChanged += 1;
  }
  let gone = 0;
  for (const k of before.keys()) if (!after.has(k)) gone += 1;
  counts[name] = {
    linesBefore: name in original ? lines(original[name].toString("utf8")).length : 0,
    linesAfter: lines(fs.readFileSync(path.join(OUT, name), "utf8")).length,
    linesRemoved: removedLines[name] ?? 0,
    keysBefore: before.size, keysAfter: after.size, keysGone: gone, keysAdded: redatedIn, keysValueChanged: valueChanged, keysUnchanged: unchangedKeys,
  };
}
counts["sleep.jsonl"] = {
  linesBefore: lines(original["sleep.jsonl"].toString("utf8")).length,
  linesAfter: lines(fs.readFileSync(path.join(OUT, "sleep.jsonl"), "utf8")).length,
  linesRemoved: sleepRemoved, sessionsWritten: sleepWritten,
};

// Key-level reconciliation: before - removed + added = after, by reason.
const afterKeys = new Set();
for (const name of fs.readdirSync(OUT)) {
  if (!/^samples-/.test(name)) continue;
  for (const l of lines(fs.readFileSync(path.join(OUT, name), "utf8"))) afterKeys.add(keyOfLine(l));
}
const wrongByReason = {};
for (const [k, whys] of wrongSampleKeys) {
  if (!originalEffective.has(k)) continue;
  const label = `${[...whys].sort().join(" + ")}${afterKeys.has(k) ? " -> key refilled by a true record" : ""}`;
  wrongByReason[label] = (wrongByReason[label] || 0) + 1;
}
const sourceOfTrueKey = new Map();
for (const d of trueByGroup.values()) {
  const span = d.kind === "hourly" ? HOUR * 1000 : 600000;
  for (const m of metricsOf(d)) sourceOfTrueKey.set(`${m}|${d.trueStartMs}|${span}`, d.era === "uptime" ? "uptime copy, dated boot + index" : d.oldStartMs === d.trueStartMs ? "already right" : `re-dated from era ${d.era}`);
}
const addedByReason = {};
for (const k of afterKeys) {
  if (originalEffective.has(k)) continue;
  const label = sourceOfTrueKey.get(k) ?? "unknown";
  addedByReason[label] = (addedByReason[label] || 0) + 1;
}
// Record level: each ring group/bucket once (collapsed), by what happened to it.
const recordLevel = {};
const bump = (metric, what) => { recordLevel[metric] = recordLevel[metric] || {}; recordLevel[metric][what] = (recordLevel[metric][what] || 0) + 1; };
const seenGroup = new Set();
for (const d of deliveries) {
  if (d.kind === "sleep") { bump("sleep", d.oldStartMs === d.trueStartMs ? "already right" : "re-dated"); continue; }
  const id = `${d.metric}|${d.anchor}|${d.era}|${d.index}|${d.dup ? "dup" : ""}`;
  if (seenGroup.has(id)) continue;
  seenGroup.add(id);
  const what = d.trueStartMs === null ? "undatable (anchor -1, not the reset)" : d.dup ? (d.transitCopy ? "transit copy dropped" : "re-anchored duplicate dropped") : d.era === "uptime" ? "uptime copy added" : d.oldStartMs === d.trueStartMs ? "already right" : "re-dated";
  for (const m of metricsOf(d)) bump(m, what);
}
const wrongTimes = [...wrongSampleKeys.keys()].filter((k) => originalEffective.has(k)).map((k) => Number(k.split("|")[1])).sort((a, b) => a - b);
const redatedDeliveries = deliveries.filter((d) => d.kind !== "sleep" && !d.dup && d.trueStartMs !== null && d.oldStartMs !== d.trueStartMs);
const firstDamaged = redatedDeliveries.length ? Math.min(...redatedDeliveries.map((d) => d.rxMs)) : null;

// Model check: every key the old build should have written exists in the store.
// Only pages at or below the journal's committed watermark have been stored; a
// page above it is ingested here and again (identically) by the app later.
const COMMITTED = Number(read("ring-pages.committed").trim());
const uncommittedPages = pages.filter((p) => p.n > COMMITTED).length;
let oldModelMissing = 0;
const oldModelMissingList = [];
for (const d of deliveries) {
  if (d.kind === "sleep" || d.oldStartMs === null || d.n > COMMITTED) continue;
  const span = d.kind === "hourly" ? 3600000 : 600000;
  for (const m of metricsOf(d)) {
    const k = `${m}|${d.oldStartMs}|${span}`;
    if (!originalEffective.has(k)) { oldModelMissing += 1; if (oldModelMissingList.length < 10) oldModelMissingList.push(`n=${d.n} ${k}`); }
  }
}
check(oldModelMissing === 0, `the old build's placement explains every journal record's stored key (${oldModelMissing} missing)`);

const report = {
  snapshot: SNAP,
  journal: { committed: COMMITTED, uncommittedPages, pages: pages.length, firstN: pages[0]?.n, lastN: pages[pages.length - 1]?.n, firstRx: iso(pages[0].rxMs), lastRx: iso(pages[pages.length - 1].rxMs) },
  history: {
    jst: "-32400 until the PDT write",
    pdtWrite: { at: iso(W1.atMs), ringSec: W1.ringSec, offset: 25200 },
    edtWrite: { at: iso(W2.atMs), ringFrom: W2.ringBeforeSec, ringTo: W2.ringSec, offset: 14400 },
    reset1004: { bootAtMs: BOOT_AT_MS, at: edt(BOOT_AT_MS), trailerSec: RESET_TRAILER, ringBootAt: iso(resetBoot.atMs) },
    jsZoneJst: { from: iso(JS_JST_FROM), last: iso(JS_JST_LAST), edtFrom: iso(JS_EDT_FROM) },
    eraCheckFromPageTags: eraCheck,
    reanchorShift: SHIFT,
  },
  scope: {
    firstDamagedPageRx: firstDamaged && iso(firstDamaged),
    wrongStoredKeysPresent: wrongTimes.length,
    wrongStoredSpan: wrongTimes.length ? [iso(wrongTimes[0]), iso(wrongTimes[wrongTimes.length - 1])] : null,
    removedKeysByReason: wrongByReason,
    addedKeysBySource: addedByReason,
    recordLevel,
    wrongSleepRows: [...wrongSleepStarts.values()],
  },
  duplicatesDropped: dupsDropped,
  transitCopies,
  trueKeyCollisions: collisions,
  ingest: { samplesWritten, sleepWritten, trueSampleKeys: trueSamples.size },
  counts,
  changedFiles: changed,
  acceptance,
  oldModelMissing: oldModelMissingList,
  failures: fail,
};
if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(fail.length === 0 ? "ALL ASSERTIONS HOLD" : `${fail.length} ASSERTION(S) FAILED:\n  ${fail.join("\n  ")}`);
process.exit(fail.length === 0 ? 0 : 1);
