// Shared by health-ui.test.cjs and health-ui-real.test.cjs (not a test file
// itself: node --test runs only *.test.cjs).
//
// Loads the REAL phone Health view model (app/phone-ui/health-view-model.ts)
// and the REAL glasses Health layer (app/apps/health/health-app.ts), both
// transpiled here without type-checking (`npx tsc -p tsconfig.json` type-checks
// them), with only their NativeScript-bound imports replaced: the store
// accessor returns a HealthStore the test builds, fonts are a fixed-width fake,
// and the bitmap-to-ImageSource step hands the GrayImage straight back. Every
// module that computes something - the shared view state, the derive code,
// the night timeline, the chart geometry - is the compiled source, and both
// surfaces resolve the SAME compiled health-view-state module, which is the
// thing under test when one side changes the state and the other must follow.
//
// The transpiled files get a per-process name so that two test files running
// at once (node --test runs files in parallel) never write the same path.

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(ROOT, ".test-build", "app");

function transpile(srcRelative, outRelative) {
  const src = path.join(ROOT, "app", srcRelative);
  const out = path.join(BUILD, outRelative);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    ts.transpileModule(fs.readFileSync(src, "utf8"), {
      fileName: src,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
  );
  process.on("exit", () => {
    try {
      fs.unlinkSync(out);
    } catch {
      // already gone
    }
  });
  return out;
}

/** A fixed-width font: 7 px a character, 14 px a line. Draws nothing. */
const fakeFont = {
  lineHeight: 14,
  descent: 3,
  measureText: (text) => `${text}`.length * 7,
  drawText() {},
  getGlyph() {
    return undefined;
  },
  hasGlyph: () => true,
};

class FakeObservable {
  constructor() {
    this.notified = [];
  }
  notifyPropertyChange(name) {
    this.notified.push(name);
  }
}

/** HealthStorageBackend over a directory, read-only (a test must never write real data). */
class DirBackend {
  constructor(dir) {
    this.dir = dir;
    this.written = new Map();
  }
  exists(name) {
    return this.written.has(name) || fs.existsSync(path.join(this.dir, name));
  }
  read(name) {
    if (this.written.has(name)) return this.written.get(name);
    return fs.existsSync(path.join(this.dir, name)) ? fs.readFileSync(path.join(this.dir, name), "utf8") : null;
  }
  // The store may rebuild its rollup cache for the test's zone; that goes to
  // memory, never to the directory.
  append(name, text) {
    this.written.set(name, (this.read(name) ?? "") + text);
  }
  write(name, text) {
    this.written.set(name, text);
  }
  list() {
    return [...new Set([...fs.readdirSync(this.dir), ...this.written.keys()])];
  }
}

class MemoryBackend {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
  }
  exists(name) {
    return this.files.has(name);
  }
  read(name) {
    return this.files.get(name) ?? null;
  }
  append(name, text) {
    this.files.set(name, (this.files.get(name) ?? "") + text);
  }
  write(name, text) {
    this.files.set(name, text);
  }
  list() {
    return [...this.files.keys()];
  }
}

/**
 * Load both surfaces against `world.store` (set it before attaching).
 * Returns { world, HealthViewModel, HealthLayer, state, chart, ...modules }.
 */
function loadSurfaces() {
  const tag = `${process.pid}`;
  const vmOut = transpile("phone-ui/health-view-model.ts", `phone-ui/health-view-model.health-ui-${tag}.js`);
  const layerOut = transpile("apps/health/health-app.ts", `apps/health/health-app.health-ui-${tag}.js`);

  const world = { store: null, pulls: 0, steps: [] };
  const storeFiles = { healthStore: () => world.store };
  const live = {
    syncLiveRecords: () => ({ seen: 0, samplesWritten: 0, sleepWritten: 0, skipped: [] }),
    requestFreshPull: () => {
      world.pulls += 1;
    },
    ringPullProgress: () => null,
  };
  const seed = { isFixtureData: () => false, seedFixturesIfNeeded: () => false };
  const fonts = { getDefaultSmallFont: () => fakeFont, getDefaultLargeFont: () => fakeFont };

  const vmStubs = {
    "@nativescript/core": { Observable: FakeObservable, Screen: { mainScreen: { widthDIPs: 800, heightDIPs: 1200 } } },
    "../graphics/ui-fonts": fonts,
    "../native/gray-image-preview": { grayImageToPreviewSource: (image) => image },
    "../native/fold-state": {
      displayClass: () => "expanded",
      foldSnapshot: () => ({ widthDp: 0, heightDp: 0, posture: "flat", isFoldable: false, hasHinge: false }),
      onFoldStateChanged: () => () => {},
      refreshFoldTracking: () => {},
    },
    "../health/health-store-files": storeFiles,
    "../health/health-live": live,
    "../health/health-seed": seed,
  };
  const layerStubs = {
    "../../graphics/ui-fonts": fonts,
    "../../ui/shell/in-process-window": {
      createInProcessWindow: () => ({ requestRender() {} }),
      YieldAtRootLayer: class {
        constructor(inner) {
          this.inner = inner;
        }
      },
    },
    "../../health/health-store-files": storeFiles,
    "../../health/health-live": live,
    "../../health/health-status": {
      noteHealthSteps: (day, steps) => world.steps.push([day, steps]),
    },
    "../../health/health-seed": seed,
  };

  const realLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (parent && parent.filename === vmOut && Object.prototype.hasOwnProperty.call(vmStubs, request)) {
      return vmStubs[request];
    }
    if (parent && parent.filename === layerOut && Object.prototype.hasOwnProperty.call(layerStubs, request)) {
      return layerStubs[request];
    }
    return realLoad.call(this, request, parent, isMain);
  };

  const { HealthViewModel } = require(vmOut);
  const { HealthLayer } = require(layerOut);
  return {
    world,
    HealthViewModel,
    HealthLayer,
    state: require(path.join(BUILD, "health/health-view-state.js")),
    timeline: require(path.join(BUILD, "health/health-night-timeline.js")),
    phoneChart: require(path.join(BUILD, "health/health-phone-chart.js")),
    derive: require(path.join(BUILD, "health/health-derive.js")),
    types: require(path.join(BUILD, "health/health-types.js")),
    HealthStore: require(path.join(BUILD, "health/health-store.js")).HealthStore,
  };
}

/** Tap the chart where `dayMs` was drawn, through the model's own touch handler. */
function tapDay(vm, phoneChart, dayMs) {
  const request = vm.lastRender;
  if (!request) throw new Error("no chart rendered yet");
  const slot = phoneChart.phoneChartSlots(request).find((candidate) => candidate.startMs === dayMs);
  if (!slot) throw new Error(`no slot for ${new Date(dayMs).toISOString()}`);
  // The Image box the bitmap was rendered for: RENDER_SCALE 2.
  const box = { width: request.width / 2, height: request.height / 2 };
  const x = (slot.x + slot.width / 2) / 2;
  const object = { getActualSize: () => box };
  vm.onChartTouch({ action: "down", getX: () => x, getY: () => 40, object });
  vm.onChartTouch({ action: "up", getX: () => x + 1, getY: () => 41, object });
}

module.exports = { loadSurfaces, DirBackend, MemoryBackend, tapDay, fakeFont };
