// The Health UI batch (2026-10-04): one shared view state for the phone and
// the glasses, the day drill-down, day stepping, the night timeline and the
// sleep window toggle. Synthetic data only, so it runs everywhere; the same
// behaviour on the phone's real repaired data is health-ui-real.test.cjs.
//
// All times are New York's: the engine is pinned there and nothing here
// supplies a Java zone, so `util/local-zone.ts` falls back to it.
process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadSurfaces, MemoryBackend, tapDay } = require("./health-ui-harness.cjs");

const S = loadSurfaces();
const { state: vs, timeline: tl } = S;

const HOUR = 3_600_000;
const MIN = 60_000;
/** 2026-10-10 00:00 EDT, a Saturday; checked with `TZ=America/New_York date -d @1791604800`. */
const D = 1791604800000;
const at = (hours, minutes = 0) => D + hours * HOUR + minutes * MIN; // hours may be negative

function block(startMs, endMs, segments) {
  const sec = (stage) =>
    segments.filter(([id]) => id === stage).reduce((sum, [, half]) => sum + half * 30, 0);
  return {
    dayStartMs: D,
    startMs,
    endMs,
    totalSec: sec(1) + sec(2) + sec(3),
    wakeSec: sec(0),
    remSec: sec(1),
    lightSec: sec(2),
    deepSec: sec(3),
    segments: segments.map(([stageId, halfMinutes]) => ({ stageId, halfMinutes })),
    timeResolved: true,
  };
}

// Block A 23:00-01:00: 10 min awake, 50 light, 30 deep, 30 REM.
const A = block(at(-1), at(1), [[0, 20], [2, 100], [3, 60], [1, 60]]);
// Block B 02:30-06:30: four hours of light.
const B = block(at(2, 30), at(6, 30), [[2, 480]]);
// A nap 14:00-15:00, inside the sleep day, outside the primary window.
const NAP = block(at(14), at(15), [[2, 120]]);
const hr = (startMs, avg) => ({ metric: "heartRate", startMs, spanMs: HOUR, min: avg, max: avg, avg, total: 0 });
const steps = (startMs, n) => ({ metric: "steps", startMs, spanMs: 10 * MIN, min: n, max: n, avg: n, total: n });

// The ring's record across the gap between A and B: the 01:00 hour of heart
// rate and 10-minute step buckets 02:00-02:30.
const GAP_DATA = [hr(at(1), 60), steps(at(2), 0), steps(at(2, 10), 0), steps(at(2, 20), 3)];

function night(window, resetsMs = [], samples = GAP_DATA) {
  return tl.buildNightTimeline({ sessions: [A, B, NAP], samples, resetsMs, dayMs: D, window });
}

// ---------------------------------------------------------------------------
// The night timeline. Rule (Chris, 2026-10-04 16:40, "awake time is awake"):
// outside a block, time with ring data is awake; only time with no ring
// record at all is no-data. Resets are markers.

test("timeline: blocks in clock time; awake where the ring has data; no-data where it has none", () => {
  const t = night("primary");
  assert.equal(t.startMs, at(-4)); // 20:00 the evening before
  assert.equal(t.endMs, at(12)); // noon
  assert.deepEqual(
    t.spans.map((s) => [s.kind, s.startMs, s.endMs]),
    [
      ["nodata", at(-4), at(-1)],
      ["sleep", at(-1), at(1)],
      ["awake", at(1), at(2, 30)],
      ["sleep", at(2, 30), at(6, 30)],
      ["nodata", at(6, 30), at(12)],
    ],
  );
  assert.equal(t.spans[0].reason, "no-contact", "3 h with no ring record at all");
  const runs = t.spans[1].runs;
  assert.deepEqual(runs.map((r) => [r.stage, r.startMs]), [
    ["wake", at(-1)],
    ["light", at(-1, 10)],
    ["deep", at(0)],
    ["rem", at(0, 30)],
  ]);
});

test("quality totals: first recorded sleep to last wake of the sleep day, the same in either window", () => {
  for (const window of ["primary", "full"]) {
    const t = night(window);
    assert.equal(t.qualityStartMs, at(-1), "block A's start");
    assert.equal(t.qualityEndMs, at(15), "the nap's end: the sleep day's last wake, drawn or not");
    assert.equal(t.asleepSec, 6600 + 14400 + 3600, "A, B and the nap");
    assert.equal(t.awakeSec, 600 + 90 * 60, "wake inside A plus the A-B gap the ring recorded");
    assert.equal(t.noDataSec, 7.5 * 3600, "B -> nap, 06:30-14:00, no ring record: neither asleep nor awake");
    assert.equal(t.stageSec.wake, t.awakeSec);
  }
  // Ring data before the first block and after the last never counts.
  const evening = night("primary", [], [hr(at(-3), 70), hr(at(-2), 72), ...GAP_DATA, hr(at(16), 80)]); // 16:00 is after the nap, the last wake
  assert.equal(evening.awakeSec, 600 + 90 * 60);
});

test("timeline: a stretch with no ring record at all is no-data, never awake; a reset at its end explains it", () => {
  // Only the 02:00-02:30 step buckets: 01:00-02:00 has no record.
  const t = night("primary", [at(2)], GAP_DATA.slice(1));
  assert.deepEqual(
    t.spans.slice(2, 4).map((s) => [s.kind, s.startMs, s.endMs]),
    [
      ["nodata", at(1), at(2)],
      ["awake", at(2), at(2, 30)],
    ],
  );
  assert.equal(t.spans[2].reason, "reset", "recording restarted at the reset");
  assert.deepEqual(t.resetsMs, [at(2)]);

  const none = night("primary", [], []);
  assert.ok(!none.spans.some((s) => s.kind === "awake"));
  assert.equal(none.awakeSec, 600, "only the wake inside block A");
});

test("timeline: a reset inside a stretch with ring data is a marker; the time stays awake", () => {
  const t = night("primary", [at(1, 45)]);
  assert.equal(t.spans[2].kind, "awake");
  assert.deepEqual(t.resetsMs, [at(1, 45)]);
});

test("timeline: an evening before bed with heart rate recorded reads awake", () => {
  const t = night("primary", [], [hr(at(-3), 70), hr(at(-2), 72), ...GAP_DATA]);
  assert.deepEqual(
    t.spans.slice(0, 2).map((s) => [s.kind, s.startMs, s.endMs]),
    [
      ["nodata", at(-4), at(-3)],
      ["awake", at(-3), at(-1)],
    ],
  );
});

test("coverage: a run's LAST hourly bucket stops at its last 10-minute bucket (10-03 22:00); the first keeps its hour", () => {
  const { ringCoverage } = require("../.test-build/app/health/health-coverage.js");
  // 21:00 and 22:00 hours of HR, steps 21:50 and 22:00, then nothing until 01:30.
  const c = ringCoverage([hr(at(-3), 80), hr(at(-2), 80), steps(at(-2, -10), 236), steps(at(-2), 0), hr(at(1, 30), 68)]);
  assert.deepEqual(c.intervalsIn(at(-4), at(3)), [
    [at(-3), at(-2, 10)], // 21:00 (a finished hour) -> 22:10 (the last 10-minute bucket), not -> 23:00
    [at(1, 30), at(2, 30)], // an hour with no finer bucket keeps its span
  ]);
  // In the middle of a run the hour keeps its whole span (bridges missing 10-minute buckets).
  const mid = ringCoverage([hr(at(-3), 80), steps(at(-3), 5), hr(at(-2), 80)]);
  assert.deepEqual(mid.intervalsIn(at(-4), at(0)), [[at(-3), at(-1)]]);
  assert.equal(mid.secondsIn(at(-4), at(0)), 2 * 3600);
});

test("night assembly: only the part of a gap the ring has data for is wake (week bars, glasses lanes)", () => {
  const { assembleNight, sleepNights } = S.derive;
  const plain = assembleNight([A, B], D);
  assert.equal(plain.wakeSec, 600 + 90 * 60, "no coverage given: the 2026-09-13 rule, the whole gap");
  const half = (a, b) => (Math.min(b, at(1, 45)) - a) / 1000; // data for 01:00-01:45 only
  const covered = assembleNight([A, B], D, half);
  assert.equal(covered.wakeSec, 600 + 45 * 60);
  assert.equal(covered.gapSec, 45 * 60);
  const none = assembleNight([A, B], D, () => 0);
  assert.equal(none.wakeSec, 600);
  assert.ok(!none.segments.some((seg) => seg.gap));
  const [bar] = sleepNights([A, B], D, D + 86_400_000, () => 0);
  assert.equal(bar.wakeSec, 600);
});

test("sleep window: primary lists the afternoon nap outside; full draws it", () => {
  const primary = night("primary");
  assert.deepEqual(primary.outside, [{ startMs: at(14), endMs: at(15), kind: "nap" }]);
  assert.ok(!primary.spans.some((s) => s.kind === "sleep" && s.startMs === at(14)));

  const full = night("full");
  assert.equal(full.endMs, at(20));
  assert.deepEqual(full.outside, []);
  const nap = full.spans.find((s) => s.kind === "sleep" && s.startMs === at(14));
  assert.ok(nap, "the nap is drawn in full mode");
  // 06:30 -> 14:00: between two blocks, but the ring recorded nothing.
  const between = full.spans.find((s) => s.startMs === at(6, 30));
  assert.equal(between.kind, "nodata");
});

test("timeline renders into a bitmap without throwing, and leaves no-data hatched (not filled)", () => {
  const { GrayImage } = require(path.join(__dirname, "..", ".test-build", "app", "graphics", "image.js"));
  const { renderPhoneChart } = S.phoneChart;
  const { fakeFont } = require("./health-ui-harness.cjs");
  const image = renderPhoneChart({ width: 1200, height: 500, font: fakeFont, content: { kind: "timeline", timeline: night("primary", [at(1, 45)]) } });
  assert.ok(image instanceof GrayImage);
});

// ---------------------------------------------------------------------------
// Ring resets

test("resets: a dated receipt is used as-is; an undated one is dated from its connect's first page trailer", () => {
  const receipts = [
    JSON.stringify({ type: "ringBoot", atMs: 1000_000, bootAtMs: 400_000, prevPushSeq: 40 }),
    JSON.stringify({ type: "ringBoot", atMs: 1791127861334, link: "new", prevPushSeq: null }),
    JSON.stringify({ type: "ringBoot", atMs: 1791127000000, prevPushSeq: 250 }), // an 8-bit wrap, not a reset
    JSON.stringify({ type: "ringBoot", atMs: 1700000000000 }), // its pages are trimmed: undatable
    JSON.stringify({ type: "pull", atMs: 5 }),
  ].join("\n");
  const journal = [
    JSON.stringify({ n: 1, rxMs: 1791127000500, rawHex: "00aa0000ffff0000" }),
    JSON.stringify({ n: 2, rxMs: 1791127863734, rawHex: "003ac787ae6402640000020101240000000000007a8c0000" }),
  ].join("\n");
  assert.equal(tl.pageTrailerSec("0000000000007a8c0000"), 35962);
  assert.equal(tl.pageTrailerSec("7a8c00"), -1);
  assert.deepEqual(tl.datedRingResets(receipts, journal), [400_000, 1791127861334 - 35962_000]);
});

// ---------------------------------------------------------------------------
// The shared view state's transitions

test("view state: drill into a day remembers the way back; a range chip forgets it", () => {
  let s = vs.withRange({ ...vs.INITIAL_HEALTH_VIEW_STATE, metric: "steps" }, "week");
  s = vs.drillIntoDay(s, D - 86_400_000, D);
  assert.deepEqual([s.range, s.dayMs, s.drillFrom], ["day", D - 86_400_000, "week"]);
  assert.equal(vs.backToDrillSource(s).range, "week");
  assert.equal(vs.backToDrillSource(s).drillFrom, null);
  assert.equal(vs.withRange(s, "month").drillFrom, null);
  // Drilling into today stores null, so the view follows the clock.
  assert.equal(vs.drillIntoDay(vs.withRange(s, "week"), D, D).dayMs, null);
});

test("view state: day stepping never passes today; stepping onto today stores null", () => {
  const today = D;
  let s = { ...vs.INITIAL_HEALTH_VIEW_STATE };
  assert.equal(vs.stepDay(s, 1, today), s, "cannot step past today");
  assert.equal(vs.canStepForward(s, today), false);
  s = vs.stepDay(s, -1, today);
  assert.equal(s.dayMs, D - 86_400_000);
  assert.equal(vs.canStepForward(s, today), true);
  s = vs.stepDay(s, 1, today);
  assert.equal(s.dayMs, null);
  assert.equal(vs.stepDay(vs.withRange(s, "week"), -1, today).range, "week", "no stepping outside a day view");
});

test("view state: the glasses click cycles day -> week -> month -> day; 3 months goes to day", () => {
  let s = { ...vs.INITIAL_HEALTH_VIEW_STATE };
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    s = vs.cycleGlassesRange(s);
    seen.push(s.range);
  }
  assert.deepEqual(seen, ["week", "month", "day", "week"]);
  assert.equal(vs.cycleGlassesRange(vs.withRange(s, "quarter")).range, "day");
});

test("steps at 10-minute grain: 144 buckets a day, an off-grid bucket lands in its 10 minutes", () => {
  const points = S.derive.rollupSeries([steps(at(3, 21) + 39_000, 10), steps(at(3, 31) + 39_000, 56)], {
    metric: "steps",
    granularity: "tenMinutes",
    startMs: D,
    endMs: D + 24 * HOUR,
  });
  assert.equal(points.length, 144);
  assert.equal(points.find((p) => p.startMs === at(3, 20)).sum, 10);
  assert.equal(points.find((p) => p.startMs === at(3, 30)).sum, 56);
});

// ---------------------------------------------------------------------------
// The two surfaces against one store

function syntheticStore() {
  const store = new S.HealthStore(new MemoryBackend());
  store.ingestSleep([A, B, NAP]);
  const samples = [];
  for (let day = -7; day <= 0; day += 1) {
    for (let h = 8; h < 20; h += 1) {
      samples.push(hr(D + day * 86_400_000 + h * HOUR, 60 + h));
      samples.push(steps(D + day * 86_400_000 + h * HOUR, 100 + day + 7));
    }
  }
  store.ingestSamples(samples);
  return store;
}

function fresh(t) {
  t.mock.timers.enable({ apis: ["Date"], now: at(13) });
  vs.healthViewState.reset();
  S.world.store = syntheticStore();
  const vm = new S.HealthViewModel();
  vm.attach();
  const layer = new S.HealthLayer(() => {});
  layer.start();
  // Always, even when an assertion fails: the layer holds a 60 s interval.
  t.after(() => {
    vm.dispose();
    layer.stop();
  });
  return { vm, layer };
}

const chip = (rows, key) => rows.find((row) => row.key === key);

test("mirror: the glasses move the phone - scroll picks the metric, click the range", (t) => {
  const { vm, layer } = fresh(t);
  for (let i = 0; i < 4; i += 1) layer.handleInput({ type: "scroll-down" });
  assert.deepEqual(layer.currentPage, { kind: "metric", metric: "steps" });
  assert.equal(vs.healthViewState.get().metric, "steps");
  assert.equal(vm.headline, "Steps");
  assert.equal(chip(vm.metricChips, "steps").isSelected, true);

  layer.handleInput({ type: "click" });
  assert.equal(vs.healthViewState.get().range, "week");
  assert.equal(chip(vm.rangeChips, "week").isSelected, true);
  assert.equal(vm.subhead, "by day");
  assert.equal(vm.lastRender.content.points.length, 7, "the phone redrew a week");
  layer.handleInput({ type: "click" });
  assert.equal(vm.lastRender.content.points.length, 30, "and a month");
  // A week page on the glasses paints.
  layer.paint({ stack: { getBaseSize: () => ({ width: 576, height: 288 }) } });
  vm.dispose();
  layer.stop();
});

test("mirror: the phone moves the glasses - metric, range and day", (t) => {
  const { vm, layer } = fresh(t);
  chip(vm.metricChips, "sleep").onTap();
  assert.deepEqual(layer.currentPage, { kind: "sleep" });
  chip(vm.metricChips, "hrv").onTap();
  assert.deepEqual(layer.currentPage, { kind: "metric", metric: "hrv" });
  chip(vm.rangeChips, "month").onTap();
  assert.equal(layer.plotted.range, "month");
  chip(vm.rangeChips, "day").onTap();
  vm.onPrevDayTap();
  assert.equal(layer.plotted.dayMs, D - 86_400_000, "the glasses show the day the phone stepped to");
  layer.paint({ stack: { getBaseSize: () => ({ width: 576, height: 288 }) } });
  vm.dispose();
  layer.stop();
});

test("mirror: a click on the glasses overview still advances; calories leaves the phone alone", (t) => {
  const { vm, layer } = fresh(t);
  layer.handleInput({ type: "click" });
  assert.deepEqual(layer.currentPage, { kind: "metric", metric: "heartRate" });
  assert.equal(vs.healthViewState.get().range, "day", "no range change from the overview");
  chip(vm.metricChips, "steps").onTap();
  layer.handleInput({ type: "scroll-down" }); // steps -> calories
  assert.deepEqual(layer.currentPage, { kind: "metric", metric: "calories" });
  assert.equal(vs.healthViewState.get().metric, "steps");
  vm.dispose();
  layer.stop();
});

test("the selection survives a new phone model (the per-visit reset F1 found)", (t) => {
  const { vm } = fresh(t);
  chip(vm.metricChips, "spo2").onTap();
  chip(vm.rangeChips, "week").onTap();
  vm.dispose();
  const next = new S.HealthViewModel();
  next.attach();
  t.after(() => next.dispose());
  assert.equal(next.headline, "Blood oxygen");
  assert.equal(chip(next.rangeChips, "week").isSelected, true);
});

test("drill-down: tapping a day in a week view opens that day's view, and back returns", (t) => {
  const { vm, layer } = fresh(t);
  chip(vm.metricChips, "steps").onTap();
  chip(vm.rangeChips, "week").onTap();
  assert.equal(vm.dayNavVisibility, "collapse");
  tapDay(vm, S.phoneChart, D - 2 * 86_400_000);
  const s = vs.healthViewState.get();
  assert.deepEqual([s.range, s.dayMs, s.drillFrom], ["day", D - 2 * 86_400_000, "week"]);
  assert.equal(vm.dayNavVisibility, "visible");
  assert.equal(vm.backVisibility, "visible");
  assert.equal(vm.backText, "‹ Back to week");
  assert.equal(vm.lastRender.content.points.length, 144, "steps day view is 10-minute buckets");
  assert.equal(vm.lastRender.content.points[0].startMs, D - 2 * 86_400_000);
  assert.equal(layer.plotted.dayMs, D - 2 * 86_400_000, "the glasses followed the drill");
  vm.onBackTap();
  assert.equal(vs.healthViewState.get().range, "week");
  assert.equal(vm.backVisibility, "collapse");
  vm.dispose();
  layer.stop();
});

test("drill-down works on the sleep nights chart too, onto the night timeline", (t) => {
  const { vm, layer } = fresh(t);
  chip(vm.metricChips, "sleep").onTap();
  chip(vm.rangeChips, "week").onTap();
  tapDay(vm, S.phoneChart, D);
  assert.equal(vs.healthViewState.get().range, "day");
  assert.equal(vm.lastRender.content.kind, "timeline");
  assert.equal(vm.sleepWindowVisibility, "visible");
  assert.match(vm.napMarkerText, /^\+ nap 2:00 PM, 1h 0m/);
  vm.onNapMarkerTap();
  assert.equal(vs.healthViewState.get().sleepWindow, "full");
  assert.equal(vm.napMarkerVisibility, "collapse");
  assert.equal(vm.lastRender.content.timeline.window, "full");
  vm.dispose();
  layer.stop();
});

test("Settings -> Health is gone: no route, no row, no handler (audit F5)", () => {
  const ui = path.join(__dirname, "..", "app", "phone-ui");
  assert.equal(fs.existsSync(path.join(ui, "health-page.ts")), false);
  assert.equal(fs.existsSync(path.join(ui, "health-page.xml")), false);
  assert.doesNotMatch(fs.readFileSync(path.join(ui, "settings-hub-page.xml"), "utf8"), /onHealthTap/);
  assert.doesNotMatch(fs.readFileSync(path.join(ui, "main-view-model.ts"), "utf8"), /onHealthTap|health-page/);
});
