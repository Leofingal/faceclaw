/**
 * Which body main-page shows for each app in the glasses' foreground (audit F1).
 *
 * Design rule 1: the phone and the glasses mirror each other for every app.
 * Picking an app on either side moves both screens; the phone's half is
 * MainViewModel's body choice, driven by `foregroundAppId` in the dashboard
 * snapshot.
 *
 * This drives the REAL `app/phone-ui/main-view-model.ts`, not a copy of its
 * logic. The model imports NativeScript and half the app, so it is not in
 * tests/tsconfig.json's pure-module list; instead it is transpiled here
 * (no type check: `tsc` and `./build.sh` do that) and loaded with every import
 * stubbed except the few this test controls:
 *
 *   - the dashboard controller, so the test can set the foreground app;
 *   - fold-state, so the test can open and shut the Fold;
 *   - the Health phone view model, so the test can count attach/dispose
 *     (attach asks the ring for a fresh pull, so it must only run while the
 *     Health body is actually up);
 *   - `./phone-views`, the app id -> phone view lookup, loaded from source.
 *
 * Everything else resolves to an inert stub that absorbs any call.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const APP = path.join(__dirname, "..", "app");
const PHONE_UI = path.join(APP, "phone-ui");

// ---------------------------------------------------------------------------
// Stubs

/** A value that absorbs anything: property reads, calls, `new`, arithmetic. */
function inert() {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "then") return undefined; // never look like a promise
      if (prop === Symbol.iterator) return function* () {};
      return inert();
    },
    apply() {
      return inert();
    },
    construct() {
      return inert();
    },
  });
}

/**
 * A settings module: every member is a setting that reads false. Inert would
 * read truthy, and "Show BLE bandwidth usage" being on starts a 1 s interval
 * that keeps node alive forever.
 */
function settingsModule() {
  const setting = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "get") return () => false;
      return inert()[prop];
    },
    apply() {
      return inert();
    },
  });
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "__esModule") return true;
        return setting;
      },
    },
  );
}

/** Object whose listed members are real and every other member is inert. */
function partial(members) {
  return new Proxy(members, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === "__esModule") return true;
      return inert();
    },
  });
}

class Observable {
  constructor() {
    this._listeners = [];
  }
  on(_event, fn) {
    this._listeners.push(fn);
  }
  off(_event, fn) {
    this._listeners = this._listeners.filter((l) => l !== fn);
  }
  notifyPropertyChange(propertyName, value) {
    for (const fn of this._listeners.slice()) fn({ propertyName, value, object: this });
  }
  notify() {}
  get(key) {
    return this[key];
  }
  set(key, value) {
    this[key] = value;
  }
}
Observable.propertyChangeEvent = "propertyChange";

function makeWorld() {
  const world = {
    snapshot: {
      status: "Connected.",
      phase: "connected",
      previewMode: false,
      displayPreview: null,
      displayPreviewMessage: "",
      foregroundAppId: null,
      foregroundAppTitle: null,
      openWindows: [],
    },
    controllerListeners: [],
    foldClass: "expanded",
    foldListeners: [],
    health: { constructed: 0, attached: 0, disposed: 0, refreshed: 0 },
  };

  const dashboardController = partial({
    subscribe(fn) {
      world.controllerListeners.push(fn);
      fn(world.snapshot);
      return () => {
        world.controllerListeners = world.controllerListeners.filter((l) => l !== fn);
      };
    },
  });

  class HealthViewModel extends Observable {
    constructor() {
      super();
      world.health.constructed += 1;
    }
    attach() {
      world.health.attached += 1;
    }
    dispose() {
      world.health.disposed += 1;
    }
    refreshLayout() {
      world.health.refreshed += 1;
    }
  }

  const overrides = {
    "@nativescript/core": partial({
      Observable,
      Screen: { mainScreen: { widthDIPs: 800, heightDIPs: 900, scale: 2 } },
    }),
    [path.join(APP, "g2", "dashboard-controller")]: partial({ dashboardController }),
    [path.join(APP, "native", "fold-state")]: partial({
      displayClass: (snapshot) => snapshot.cls,
      foldSnapshot: () => ({ cls: world.foldClass }),
      refreshFoldTracking: () => {},
      onFoldStateChanged: (fn) => {
        world.foldListeners.push(fn);
        return () => {};
      },
    }),
    [path.join(PHONE_UI, "health-view-model")]: partial({ HealthViewModel }),
    [path.join(APP, "ui", "dashboard-settings")]: settingsModule(),
  };
  // Pure modules loaded from source rather than stubbed. Absent on a tree
  // that predates them, and then nothing imports them either.
  const fromSource = new Set([path.join(PHONE_UI, "phone-views")]);

  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(file, "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: file,
    });
    const mod = new Module(file);
    mod.filename = file;
    cache.set(file, mod);
    mod.require = (spec) => {
      if (overrides[spec]) return overrides[spec];
      if (spec.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), spec);
        if (overrides[resolved]) return overrides[resolved];
        if (fromSource.has(resolved) && fs.existsSync(`${resolved}.ts`)) return load(`${resolved}.ts`);
      }
      return partial({});
    };
    mod._compile(outputText, file);
    return mod.exports;
  }

  world.MainViewModel = load(path.join(PHONE_UI, "main-view-model.ts")).MainViewModel;

  world.setForeground = (appId, title) => {
    world.snapshot = { ...world.snapshot, foregroundAppId: appId, foregroundAppTitle: title };
    for (const fn of world.controllerListeners.slice()) fn(world.snapshot);
  };
  world.setFold = (cls) => {
    world.foldClass = cls;
    for (const fn of world.foldListeners.slice()) fn({ cls });
  };
  return world;
}

/**
 * The model as main-page holds it. hub-page.ts tells main-page apart from
 * Settings and the mirror page (all three bind a MainViewModel); on a tree
 * without that flag the assignment is an inert extra property.
 */
function mainPage(world) {
  const vm = new world.MainViewModel();
  vm.hostsBodies = true;
  return vm;
}

/** The names of the main-page bodies that are visible. Exactly one should be. */
function visibleBodies(vm) {
  const bodies = {
    cover: vm.coverGlanceVisibility,
    ghost: vm.ghostCompanionVisibility,
    health: vm.healthBodyVisibility,
    list: vm.homeBodyVisibility,
  };
  return Object.keys(bodies).filter((name) => bodies[name] === "visible");
}

// ---------------------------------------------------------------------------

test("Ghost in the foreground shows Ghost's companion (unchanged)", () => {
  const world = makeWorld();
  const vm = mainPage(world);
  world.setForeground("ghost", "Ghost");
  assert.deepEqual(visibleBodies(vm), ["ghost"]);
  assert.equal(vm.companionBodyVisibility, "visible");
});

test("Health in the foreground shows the Health graphs on the phone", () => {
  const world = makeWorld();
  const vm = mainPage(world);
  world.setForeground("health", "Health");
  assert.deepEqual(visibleBodies(vm), ["health"]);
  assert.equal(vm.companionBodyVisibility, "visible");
});

test("an app with no phone view leaves the phone on the app list", () => {
  const world = makeWorld();
  const vm = mainPage(world);
  for (const [id, title] of [["translate", "Translate"], ["timer", "Timer"], [null, null]]) {
    world.setForeground(id, title);
    assert.deepEqual(visibleBodies(vm), ["list"], `foreground ${id}`);
    assert.equal(vm.companionBodyVisibility, "collapse", `foreground ${id}`);
  }
});

test("an id that is an Object.prototype member is not an app view", () => {
  const world = makeWorld();
  const vm = mainPage(world);
  world.setForeground("constructor", "constructor");
  assert.deepEqual(visibleBodies(vm), ["list"]);
});

test("Fold shut shows the cover glance whatever the foreground app", () => {
  const world = makeWorld();
  const vm = mainPage(world);
  world.setFold("compact");
  for (const id of ["ghost", "health", "translate"]) {
    world.setForeground(id, id);
    assert.deepEqual(visibleBodies(vm), ["cover"], `foreground ${id}`);
  }
});

test("Exocortex peek from Health shows the list with a way back, cleared by the next app change", () => {
  const world = makeWorld();
  const vm = mainPage(world);
  world.setForeground("health", "Health");
  vm.onShowHomeTap();
  assert.deepEqual(visibleBodies(vm), ["list"]);
  assert.equal(vm.returnRowVisibility, "visible");
  assert.equal(vm.returnRowTitle, "Health");
  vm.onReturnRowTap();
  assert.deepEqual(visibleBodies(vm), ["health"]);
  vm.onShowHomeTap();
  world.setForeground("ghost", "Ghost");
  assert.deepEqual(visibleBodies(vm), ["ghost"]);
});

test("Ghost's way-back row keeps its text", () => {
  const world = makeWorld();
  const vm = mainPage(world);
  world.setForeground("ghost", "Ghost");
  vm.onShowHomeTap();
  assert.equal(vm.returnRowVisibility, "visible");
  assert.equal(vm.returnRowTitle, "Ghost");
  assert.equal(vm.returnRowMeta, "Back to the companion for the session on the glasses");
});

test("the Health view model runs only while its body is on screen", () => {
  const world = makeWorld();
  const vm = mainPage(world);
  assert.equal(world.health.attached, 0, "not attached at construction");
  world.setForeground("health", "Health");
  assert.equal(world.health.attached, 1, "attached when Health comes up");
  world.setForeground("health", "Health"); // repeat snapshot, same app
  assert.equal(world.health.attached, 1, "not attached twice");
  world.setFold("compact");
  assert.equal(world.health.disposed, 1, "disposed when the Fold shuts");
  world.setFold("expanded");
  assert.equal(world.health.attached, 2, "re-attached when it opens again");
  world.setForeground("ghost", "Ghost");
  assert.equal(world.health.disposed, 2, "disposed when Ghost takes over");
  world.setForeground("health", "Health");
  assert.equal(world.health.attached, 3);
  vm.dispose();
  assert.equal(world.health.disposed, 3, "disposed with the page's model");
  // Suspend/resume: the page calls attach() again on the same model.
  vm.attach();
  assert.equal(world.health.attached, 4, "re-attached on resume while Health is up");
});

test("Settings and the mirror page never start the Health model", () => {
  const world = makeWorld();
  const vm = new world.MainViewModel(); // hostsBodies left false, as on those pages
  world.setForeground("health", "Health");
  assert.equal(world.health.attached, 0);
  vm.dispose();
  vm.attach();
  assert.equal(world.health.attached, 0);
});
