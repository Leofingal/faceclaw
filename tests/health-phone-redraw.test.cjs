// The phone Health tab, end to end: does it show the pull its open asked for
// once that pull lands? (2026-09-24)
//
// This drives the REAL HealthViewModel (app/phone-ui/health-view-model.ts),
// transpiled here without type-checking - `npx tsc -p tsconfig.json` is what
// type-checks it - with its NativeScript and native imports replaced by small
// fakes: the store holds what has been ingested, the journal holds what a pull
// has delivered but nobody has synced yet, and "progress" is the
// communicator's mode and finished-pull count. Everything the tab computes
// from the store (the rollup, the stat rows) is the real code.
//
// It is written to run against any checkout, so it can show the old tab
// failing: on 164e444 the on-demand cases fail (the tab keeps "No data" after
// the pull lands) and the Direct / no-communicator / disposed cases pass - which
// is also the proof that those cases did not change.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "app/phone-ui/health-view-model.ts");
const OUT = path.join(ROOT, ".test-build/app/phone-ui/health-view-model.js");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  ts.transpileModule(fs.readFileSync(SRC, "utf8"), {
    fileName: SRC,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText,
);

// ---------------------------------------------------------------------------
// The world the tab sees.

const world = {
  store: [], // ingested samples: what healthStore() returns
  journal: [], // delivered by a pull, not yet synced
  progress: null, // { onDemand, pullsFinished } or null (no communicator)
  requested: [],
};

function resetWorld(progress) {
  world.store = [];
  world.journal = [];
  world.progress = progress;
  world.requested = [];
}

class FakeObservable {
  constructor() {
    this.notified = [];
  }
  notifyPropertyChange(name) {
    this.notified.push(name);
  }
}

const stubs = {
  "@nativescript/core": {
    Observable: FakeObservable,
    Screen: { mainScreen: { widthDIPs: 800, heightDIPs: 1200 } },
  },
  "../graphics/ui-fonts": { getDefaultSmallFont: () => ({}) },
  "../native/gray-image-preview": { grayImageToPreviewSource: () => ({ fake: "image" }) },
  "../native/fold-state": {
    displayClass: () => "expanded",
    foldSnapshot: () => ({ widthDp: 0, heightDp: 0, posture: "flat", isFoldable: false, hasHinge: false }),
    onFoldStateChanged: () => () => {},
    refreshFoldTracking: () => {},
  },
  "../health/health-phone-chart": { renderPhoneChart: () => ({ fake: "chart" }) },
  "../health/health-store-files": {
    healthStore: () => ({
      samplesInRange: (startMs, endMs) => world.store.filter((s) => s.startMs >= startMs && s.startMs < endMs),
      dailyRollups: () => new Map(),
      sleepSessions: () => [],
    }),
  },
  "../health/health-live": {
    syncLiveRecords: () => {
      const moved = world.journal.length;
      world.store.push(...world.journal);
      world.journal = [];
      return { seen: moved, samplesWritten: moved, sleepWritten: 0, skipped: [] };
    },
    requestFreshPull: (trigger) => {
      world.requested.push(trigger ?? "(none)");
    },
    ringPullProgress: () => (world.progress ? { ...world.progress } : null),
  },
  "../health/health-seed": { isFixtureData: () => false, seedFixturesIfNeeded: () => {} },
};

const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (parent && parent.filename === OUT && Object.prototype.hasOwnProperty.call(stubs, request)) {
    return stubs[request];
  }
  return realLoad.call(this, request, parent, isMain);
};

const { HealthViewModel } = require(OUT);

// ---------------------------------------------------------------------------

const NOON = new Date(2026, 8, 24, 12, 0, 0).getTime();

function heartRateSample(avg) {
  return { metric: "heartRate", startMs: NOON - 30 * 60_000, spanMs: 60 * 60_000, min: avg - 2, max: avg + 2, avg, total: 0 };
}

/** The pull finishes: its pages are in the journal and the count moves. */
function pullLands(sample, { ingestedAlready = false } = {}) {
  if (ingestedAlready) world.store.push(sample); // the 60 s background sync got there first
  else world.journal.push(sample);
  if (world.progress) world.progress.pullsFinished += 1;
}

function average(vm) {
  const row = vm.statRows.find((r) => r.label === "Average");
  return row ? row.value : `(${vm.statRows.map((r) => r.label).join(", ")})`;
}

function withClock(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOON });
}

test("on-demand: the tab shows the open's pull when it lands, without a re-open", (t) => {
  withClock(t);
  resetWorld({ onDemand: true, pullsFinished: 3 });
  const vm = new HealthViewModel();
  vm.attach();
  assert.equal(world.requested.length, 1, "the open asked for a pull");
  assert.equal(vm.statRows[0].label, "No data", "nothing stored before the pull");

  t.mock.timers.tick(20_000);
  pullLands(heartRateSample(72));
  t.mock.timers.tick(4_000);

  assert.match(average(vm), /72/, "the landed pull is on screen");
  vm.dispose();
});

test("on-demand: a pull the 60 s background sync ingested first still shows", (t) => {
  withClock(t);
  resetWorld({ onDemand: true, pullsFinished: 0 });
  const vm = new HealthViewModel();
  vm.attach();
  t.mock.timers.tick(18_000);
  pullLands(heartRateSample(65), { ingestedAlready: true });
  t.mock.timers.tick(4_000);
  assert.match(average(vm), /65/);
  vm.dispose();
});

test("Direct: unchanged - the tab draws at open and not again on its own", (t) => {
  withClock(t);
  resetWorld({ onDemand: false, pullsFinished: 10 });
  const vm = new HealthViewModel();
  vm.attach();
  const drawsAtOpen = vm.notified.filter((n) => n === "statRows").length;
  t.mock.timers.tick(15_000);
  pullLands(heartRateSample(80));
  t.mock.timers.tick(120_000);
  assert.equal(vm.notified.filter((n) => n === "statRows").length, drawsAtOpen, "no redraw");
  assert.equal(vm.statRows[0].label, "No data", "as before: the next open shows it");
  vm.dispose();
});

test("no communicator (Only via glasses before a connect, or preview): unchanged", (t) => {
  withClock(t);
  resetWorld(null);
  const vm = new HealthViewModel();
  vm.attach();
  const drawsAtOpen = vm.notified.filter((n) => n === "statRows").length;
  world.journal.push(heartRateSample(90));
  t.mock.timers.tick(120_000);
  assert.equal(vm.notified.filter((n) => n === "statRows").length, drawsAtOpen);
  vm.dispose();
});

test("on-demand: a tab closed before the pull lands draws nothing afterwards", (t) => {
  withClock(t);
  resetWorld({ onDemand: true, pullsFinished: 0 });
  const vm = new HealthViewModel();
  vm.attach();
  t.mock.timers.tick(6_000);
  vm.dispose();
  const drawsAtClose = vm.notified.length;
  pullLands(heartRateSample(70));
  t.mock.timers.tick(60_000);
  assert.equal(vm.notified.length, drawsAtClose);
});
