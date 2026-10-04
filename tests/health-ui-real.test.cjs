// The Health UI batch on the phone's REAL data (2026-10-04): the repaired
// health folder taken off the phone at 14:06 EDT and run through the trip
// repair (seat's swap snapshot, `~/health-repair-1004/swap-1406/out/health/`
// on bazzite-desktop). Read-only; the store's rollup rebuild for this zone
// goes to memory.
//
// The data is Chris's own health record, so it is NOT in this repository.
// Point HEALTH_REAL_DIR at a copy of the folder to run these; without it every
// test here is skipped (and says so).
//
//   HEALTH_REAL_DIR=~/health-repair-1004/swap-1406/out/health npm test
//
// Zone: America/New_York, as the phone was on 10-04.
process.env.TZ = "America/New_York";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { loadSurfaces, DirBackend, tapDay } = require("./health-ui-harness.cjs");

const DIR = process.env.HEALTH_REAL_DIR;
const skip = !DIR || !fs.existsSync(DIR) ? "HEALTH_REAL_DIR not set (real health data is not in the repo)" : false;

// Instants, each checked with `TZ=America/New_York date -d @...`.
const DAY_1003 = 1791000000000; //    2026-10-03 00:00 EDT
const DAY_1004 = 1791086400000; //    2026-10-04 00:00 EDT
const EVE_1003 = 1791072000000; //    2026-10-03 20:00 EDT (the 10-04 sleep day starts)
const BLOCK_START = 1791101169000; // 2026-10-04 04:06:09 EDT
const BLOCK_END = 1791125409000; //   2026-10-04 10:50:09 EDT
const RESET = 1791091899000; //       2026-10-04 01:31:39 EDT
const NAP_START = 1791054930000; //   2026-10-03 15:15:30 EDT
const NAP_END = 1791058920000; //     2026-10-03 16:22:00 EDT
const NOW = 1791137160000; //         2026-10-04 14:06 EDT, when the snapshot was taken
const MIN = 60_000;

let S = null;
function setup(t) {
  if (!S) S = loadSurfaces();
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  S.state.healthViewState.reset();
  S.world.store = new S.HealthStore(new DirBackend(DIR));
  const vm = new S.HealthViewModel();
  vm.attach();
  const layer = new S.HealthLayer(() => {});
  layer.start();
  t.after(() => {
    vm.dispose();
    layer.stop();
  });
  return { vm, layer, set: (patch, source = "phone") => S.state.healthViewState.update(patch, source) };
}

test("10-04 sleep day, primary window: one block 04:06:09-10:50:09; no data from 20:00 with the 01:31:39 reset; nothing awake before 04:06", { skip }, (t) => {
  const { vm, set } = setup(t);
  set({ metric: "sleep", range: "day", dayMs: null, sleepWindow: "primary" });
  const timeline = vm.timeline;
  assert.equal(vm.lastRender.content.kind, "timeline");
  assert.equal(timeline.dayMs, DAY_1004);
  assert.equal(timeline.startMs, EVE_1003);

  const sleep = timeline.spans.filter((s) => s.kind === "sleep");
  assert.deepEqual(sleep.map((s) => [s.startMs, s.endMs]), [[BLOCK_START, BLOCK_END]], "exactly one block");

  const first = timeline.spans[0];
  assert.equal(first.kind, "nodata");
  assert.equal(first.startMs, EVE_1003);
  assert.equal(first.endMs, BLOCK_START);
  assert.equal(first.reason, "reset");
  assert.equal(first.resetsMs.length, 1);
  assert.ok(
    first.resetsMs[0] >= RESET && first.resetsMs[0] < RESET + 1000,
    `reset at ${new Date(first.resetsMs[0]).toString()}`,
  );

  const awakeBefore = timeline.spans.filter((s) => s.kind === "awake" && s.startMs < BLOCK_START);
  assert.deepEqual(awakeBefore, [], "zero awake time before 04:06");
  const wakeRunsBefore = sleep.flatMap((s) => s.runs).filter((r) => r.stage === "wake" && r.startMs < BLOCK_START);
  assert.deepEqual(wakeRunsBefore, []);

  // Totals for the window, from the block's named fields.
  assert.equal(timeline.asleepSec, 23430);
  assert.equal(timeline.awakeSec, 810);
  const rows = Object.fromEntries(vm.statRows.map((r) => [r.label, r.value]));
  assert.equal(rows.Asleep, "6h 31m");
  assert.equal(rows.Awake, "14m");
  assert.equal(rows["Ring reset"], "1:31 AM");
  assert.equal(vm.napMarkerVisibility, "collapse", "no nap on 10-04 by 14:06");
});

test("10-03 sleep day: the plane nap 15:15:30-16:22:00 is outside primary and makes the edge marker; full mode draws it", { skip }, (t) => {
  const { vm, set } = setup(t);
  set({ metric: "sleep", range: "day", dayMs: DAY_1003, sleepWindow: "primary" });
  const primary = vm.timeline;
  assert.deepEqual(primary.outside, [{ startMs: NAP_START, endMs: NAP_END, kind: "nap" }]);
  assert.ok(!primary.spans.some((s) => s.kind === "sleep" && s.startMs === NAP_START));
  assert.equal(vm.napMarkerVisibility, "visible");
  assert.equal(vm.napMarkerText, "+ nap 3:15 PM, 1h 7m ›");

  vm.onNapMarkerTap(); // the marker is also the toggle
  assert.equal(S.state.healthViewState.get().sleepWindow, "full");
  const full = vm.timeline;
  const nap = full.spans.find((s) => s.kind === "sleep" && s.startMs === NAP_START);
  assert.ok(nap, "the nap is drawn in full mode");
  assert.equal(nap.endMs, NAP_END);
  assert.deepEqual(full.outside, []);
  assert.equal(vm.napMarkerVisibility, "collapse");
});

test("10-04 steps day view: the 03:21-03:51 walk (83 steps) and nothing 04:15-11:00", { skip }, (t) => {
  const { vm, set } = setup(t);
  set({ metric: "steps", range: "day", dayMs: null });
  const points = vm.lastRender.content.points;
  assert.equal(points.length, 144);
  assert.equal(points[0].startMs, DAY_1004);
  const at = (h, m) => points.find((p) => p.startMs === DAY_1004 + (h * 60 + m) * MIN);
  // 03:40 holds a stored bucket of 0 steps (the uptime copy sends every bucket).
  assert.deepEqual([at(3, 20).sum, at(3, 30).sum, at(3, 40).sum, at(3, 50).sum], [10, 56, 0, 17]);
  const walk = points.filter((p) => p.startMs >= DAY_1004 + 3 * 60 * MIN && p.startMs < DAY_1004 + 4 * 60 * MIN);
  assert.equal(walk.reduce((sum, p) => sum + p.sum, 0), 83);
  const quiet = points.filter(
    (p) => p.startMs + p.spanMs > DAY_1004 + (4 * 60 + 15) * MIN && p.startMs < DAY_1004 + 11 * 60 * MIN,
  );
  assert.equal(quiet.length, 41, "04:10 through 10:50");
  assert.deepEqual(quiet.filter((p) => p.sum > 0), [], "no steps 04:15-11:00");
  assert.deepEqual(quiet.filter((p) => p.count > 0), [], "and no stored bucket at all (absent, not zero)");
});

test("tapping 10-03 in the steps week view opens the 10-03 steps day view", { skip }, (t) => {
  const { vm, set } = setup(t);
  set({ metric: "steps", range: "week", dayMs: null });
  assert.equal(vm.lastRender.content.points.length, 7);
  tapDay(vm, S.phoneChart, DAY_1003);
  const s = S.state.healthViewState.get();
  assert.deepEqual([s.metric, s.range, s.dayMs, s.drillFrom], ["steps", "day", DAY_1003, "week"]);
  assert.equal(vm.dayLabel, "Sat 3 Oct");
  const points = vm.lastRender.content.points;
  assert.equal(points.length, 144);
  assert.equal(points[0].startMs, DAY_1003);
  // The evening the repair return lists for 10-03: 19:40 = 404 ... 21:50 = 236.
  const at = (h, m) => points.find((p) => p.startMs === DAY_1003 + (h * 60 + m) * MIN).sum;
  assert.deepEqual([at(19, 40), at(21, 0), at(21, 10), at(21, 20), at(21, 50)], [404, 194, 632, 162, 236]);
});

test("the shared state, both ways, on real data: glasses -> phone and phone -> glasses", { skip }, (t) => {
  const { vm, layer, set } = setup(t);
  set({ metric: "heartRate", range: "day", dayMs: null });
  // Glasses: scroll to sleep's page (overview, HR, SpO2, HRV, steps, calories, sleep).
  for (let i = 0; i < 6; i += 1) layer.handleInput({ type: "scroll-down" });
  assert.deepEqual(layer.currentPage, { kind: "sleep" });
  assert.equal(vm.headline, "Sleep");
  assert.equal(vm.lastRender.content.kind, "timeline", "the phone shows tonight's timeline");
  layer.handleInput({ type: "click" }); // day -> week
  assert.equal(vm.lastRender.content.kind, "nights");
  assert.equal(vm.lastRender.content.nights.length, 7);
  // 10-03's bar: the wake inside its two blocks only. The 10:28 -> 15:15 gap
  // holds the 14:17 in-transit reset, so it is not counted as awake.
  const sat = vm.lastRender.content.nights.find((n) => n.startMs === DAY_1003);
  assert.equal(sat.wakeSec, 810 + 810);

  // Phone: step to a day; the glasses' plot follows.
  vm.rangeChips.find((c) => c.key === "day").onTap();
  vm.onPrevDayTap();
  assert.equal(layer.plotted.range, "day");
  assert.equal(layer.plotted.dayMs, DAY_1003);
  vm.metricChips.find((c) => c.key === "steps").onTap();
  assert.deepEqual(layer.currentPage, { kind: "metric", metric: "steps" });
  layer.paint({ stack: { getBaseSize: () => ({ width: 576, height: 288 }) } });
});
