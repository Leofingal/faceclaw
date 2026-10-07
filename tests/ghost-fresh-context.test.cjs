// Ghost Fresh Context (2026-10-06), and the "phone mic" marker on the
// listening screen (same branch, same day).
//
// Fresh Context retires the live cc-web session from the glasses or the phone:
// POST /api/glasses/:id/clear on the box (cc-web branch cc-web-fresh-context)
// answers with a NEW session id, which the client must adopt at once. Known-
// good values asserted here:
//   - the action calls the endpoint with the current id, adopts the returned id
//     and clears the view (lens feed and the phone's transcript);
//   - a 404 from a server WITHOUT the route (Express's HTML "Cannot POST")
//     shows "Fresh Context needs a server update" and changes nothing;
//   - a JSON 404 from a server WITH the route is a stale session, not an update;
//   - the action is in Ghost's window menu (glasses) and on the phone's view.
// The REAL GhostLayer, companion store and phone view model run here,
// transpiled without type-checking (tsc checks them), with NativeScript and
// native imports replaced by fakes, as in ghost-dictation-scroll.test.cjs.
const test = require("node:test");
const { afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(ROOT, ".test-build");

function transpile(srcRel, outRel) {
  const src = path.join(ROOT, srcRel);
  const out = path.join(BUILD, outRel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    ts.transpileModule(fs.readFileSync(src, "utf8"), {
      fileName: src,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
  );
  return out;
}

const LAYER = transpile("app/apps/ghost/ghost-layer.ts", "app/apps/ghost/ghost-layer-fresh.js");
const STORE = transpile("app/apps/ghost/ghost-companion-store.ts", "app/apps/ghost/ghost-companion-store-fresh.js");
const APP = transpile("app/apps/ghost/ghost-app.ts", "app/apps/ghost/ghost-app-fresh.js");
const VM = transpile("app/phone-ui/ghost-companion-view-model.ts", "app/phone-ui/ghost-companion-view-model-fresh.js");

// --------------------------------------------------------------------------
// The world the fakes share.

const world = {
  session: "session-1",
  autoFollow: false,
  clearCalls: [], // session ids POSTed to /clear
  clearReply: null, // (id) => ClearResult
  feeds: {}, // session id -> GhostItem[]
  transcripts: {}, // session id -> GhostTurn[]
  statusListener: null,
  drawn: [], // every text the fake image drew
  menuOptions: null, // createInProcessWindow's options, from ghost-app
};

const fresh = require(path.join(BUILD, "app/apps/ghost/ghost-fresh-context.js"));

const noop = () => {};
const inert = new Proxy({}, { get: () => noop });

globalThis.com = { faceclaw: { app: { FaceclawBleCommunicator: { getActive: () => null } } } };

class FakeImage {
  constructor() {
    this.texts = world.drawn;
  }
  drawText(_font, _x, _y, text) {
    world.drawn.push(String(text));
  }
}
for (const name of ["fillRect", "drawRect", "drawLine", "invert", "drawImage", "blit", "clear"]) {
  FakeImage.prototype[name] = noop;
}
const font = { lineHeight: 10, measureText: (t) => String(t).length * 5 };

const ghostClient = {
  clearSession: async (id) => {
    world.clearCalls.push(id);
    return world.clearReply(id);
  },
  fetchActiveSessionId: async () => (world.autoFollow ? world.session : null),
  fetchFeed: async (id) => ({ feed: { items: (world.feeds[id] || []).slice() }, failure: null, detail: "" }),
  fetchProse: async () => [],
  fetchTranscript: async (id) => (world.transcripts[id] || []).slice(),
  fetchFileManifest: async () => [],
  fetchFileText: async () => "",
  ghostAuthHeaders: () => ({}),
  ghostAutoFollowSetting: { get: () => world.autoFollow, set: (v) => void (world.autoFollow = v) },
  ghostHostSetting: { get: () => "http://box" },
  ghostTokenSetting: { get: () => "" },
  ghostSessionId: () => world.session,
  ghostSessionSetting: { get: () => world.session, set: (v) => void (world.session = v) },
  ghostSpeakSetting: { get: () => false, set: noop },
  sendApproval: async () => true,
  sendInput: async () => true,
  ttsUrl: (_s, t) => `tts:${t}`,
};

const layerStubs = {
  "../../graphics/image": { GrayImage: FakeImage },
  "../../graphics/ui-fonts": { getDefaultMediumFont: () => font, getDefaultSmallFont: () => font },
  "../../graphics/textwrap": { truncateText: (_f, t) => t, wrapText: (_f, t) => [t] },
  "../../ui/gestures": {
    gestureHints: () => "",
    GESTURE_CLICK: "click",
    GESTURE_DOUBLE_CLICK: "double",
    GESTURE_SCROLL: "scroll",
    GESTURE_SCROLL_DOWN: "down",
    GESTURE_SCROLL_UP: "up",
  },
  "../../ui/menu": inert,
  "../../ui/metrics": { LIST_ROW_TEXT_INSET: 0, lineStep: () => 10, listRowHeight: () => 10 },
  "../../ui/layers": {},
  "../../ui/shell/shell": { shell: inert },
  "../../native/voice-control": {
    voiceControlBridge: {
      onTranscript: () => noop,
      onStatus: (listener) => {
        world.statusListener = listener;
        return noop;
      },
      noteCaptureOutcome: noop,
      lastRawInput: () => "",
    },
  },
  "../../util/numeric-util": { clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)) },
  "./ghost-client": ghostClient,
  "./ghost-speech": { speakGhost: noop, stopGhostSpeech: noop, appendGhostSpeechReceipt: noop },
};

const appStubs = {
  "../../ui/dashboard/settings-panel": { openSettingsSubMenu: noop },
  "../../ui/dashboard-settings": { logUploadSetting: {}, textSettingMenuItem: () => ({}), toggleSettingMenuItem: () => ({}) },
  "../../ui/menu": {},
  "../../ui/shell/in-process-window": {
    createInProcessWindow: (options) => {
      world.menuOptions = options;
      return { stack: { receiveTextInput: () => false }, requestRender: noop };
    },
  },
  "./ghost-client": ghostClient,
  "./ghost-companion-store": null, // filled with the real store below
  "./ghost-layer": null, // filled with the real layer below
};

const vmStubs = {
  "@nativescript/core": {
    Observable: class {
      notifyPropertyChange() {}
    },
    FormattedString: class {
      constructor() {
        this.spans = [];
      }
    },
    Span: class {},
    ScrollView: class {},
  },
  "../apps/ghost/ghost-client": ghostClient,
  "../apps/ghost/ghost-companion-store": null, // the real store
  "../util/format-error": { formatErrorMessage: (e) => String(e && e.message ? e.message : e) },
};

const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  const from = parent && parent.filename;
  const table = from === LAYER ? layerStubs : from === APP ? appStubs : from === VM ? vmStubs : null;
  if (table && Object.prototype.hasOwnProperty.call(table, request) && table[request] !== null) {
    return table[request];
  }
  if (from === APP && request === "./ghost-companion-store") return require(STORE);
  if (from === APP && request === "./ghost-layer") return require(LAYER);
  if (from === VM && request === "../apps/ghost/ghost-companion-store") return require(STORE);
  return realLoad.call(this, request, parent, isMain);
};

const realLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  if (!line.startsWith("ghost:")) realLog(...args);
};

const { GhostLayer, PHONE_MIC_MARKER } = require(LAYER);
const store = require(STORE);
const { GhostCompanionViewModel } = require(VM);

const actions = new Proxy({}, { get: () => async () => {} });
const paintCtx = { stack: { getBaseSize: () => ({ width: 576, height: 288 }), isFocused: () => true } };
const tick = () => new Promise((r) => setTimeout(r, 0));

// Every layer, view model and window a test opens is closed after it, pass or
// fail: each holds timers (the phone's transcript poll, the window's feed
// poll) that would otherwise keep node alive after a failed assertion.
const cleanups = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()();
    } catch {
      // keep closing the rest
    }
  }
  store.setGhostFreshContextHandler(null);
});

const OK = (id) => ({ sessionId: `new-${id}`, failure: null, detail: "" });
const OLD_SERVER = () => fresh.classifyClearResponse(404, "<!DOCTYPE html><pre>Cannot POST /api/glasses/x/clear</pre>");

function reset() {
  world.session = "session-1";
  world.autoFollow = false;
  world.clearCalls = [];
  world.clearReply = OK;
  world.feeds = {
    "session-1": [
      { uuid: "a1", role: "assistant", headline: "Old reply one", body: ["one"] },
      { uuid: "a2", role: "assistant", headline: "Old reply two", body: ["two"] },
    ],
  };
  world.transcripts = {
    "session-1": [
      { uuid: "u1", role: "user", text: "hello" },
      { uuid: "a1", role: "assistant", text: "Old reply one" },
    ],
  };
  world.drawn.length = 0;
}

async function layerOnFeed() {
  const layer = new GhostLayer(actions);
  cleanups.push(() => layer.onRemoved());
  layer.requestRender = () => store.publishGhostCompanion(layer.companionState());
  await layer.poll();
  return layer;
}

function painted(layer) {
  world.drawn.length = 0;
  layer.paint(paintCtx);
  return world.drawn.slice();
}

// --------------------------------------------------------------------------
// The response classifier: the version gate lives here.

test("classifier: a 200 with a session id is the new id", () => {
  const r = fresh.classifyClearResponse(200, JSON.stringify({ ok: true, oldSessionId: "a", sessionId: "b-123" }));
  assert.deepEqual(r, { sessionId: "b-123", failure: null, detail: "" });
});

test("classifier: Express's HTML 404 (no route: old cc-web) means 'needs a server update'", () => {
  const r = OLD_SERVER();
  assert.equal(r.failure, "needs-update");
  assert.equal(fresh.freshContextMessage(r), "Fresh Context needs a server update");
  // An empty 404 body is the same: no JSON error, so no route.
  assert.equal(fresh.classifyClearResponse(404, "").failure, "needs-update");
});

test("classifier: the new server's JSON 404 is a stale session, not an update", () => {
  const r = fresh.classifyClearResponse(404, JSON.stringify({ error: "Session not found" }));
  assert.equal(r.failure, "session-gone");
  assert.notEqual(fresh.freshContextMessage(r), fresh.NEEDS_UPDATE_MESSAGE);
});

test("classifier: 401, 500 and a 200 without an id are failures with their own words", () => {
  assert.equal(fresh.classifyClearResponse(401, "{}").failure, "unauthorized");
  const five = fresh.classifyClearResponse(500, JSON.stringify({ error: "x" }));
  assert.equal(five.failure, "http");
  assert.match(fresh.freshContextMessage(five), /500/);
  assert.equal(fresh.classifyClearResponse(200, "{}").failure, "http");
});

test("runFreshContext: no session set never calls the box", async () => {
  let called = false;
  const r = await fresh.runFreshContext({
    currentSessionId: () => "  ",
    clearSession: async () => ((called = true), OK("x")),
    adopt: () => assert.fail("must not adopt"),
  });
  assert.equal(r.failure, "no-session");
  assert.equal(called, false);
});

// --------------------------------------------------------------------------
// The lens: GhostLayer.freshContext()

test("lens: calls the endpoint with the current id, adopts the new id, clears the feed", async () => {
  reset();
  const layer = await layerOnFeed();
  assert.equal(layer.items.length, 2);
  const r = await layer.freshContext();
  assert.deepEqual(world.clearCalls, ["session-1"]);
  assert.equal(r.sessionId, "new-session-1");
  assert.equal(world.session, "new-session-1", "the session setting now holds the new id");
  assert.equal(layer.items.length, 0, "the old session's feed is gone");
  assert.equal(layer.cursor, -1);
  // The result holds the glass.
  assert.ok(painted(layer).some((t) => t.startsWith("Fresh context — new session new-sess")), world.drawn.join(" | "));
  // And the next poll asks the NEW session.
  world.feeds["new-session-1"] = [{ uuid: "n1", role: "assistant", headline: "Fresh start", body: ["hi"] }];
  await layer.poll();
  assert.deepEqual(layer.items.map((i) => i.uuid), ["n1"]);
  layer.onRemoved();
});

test("lens: an old server (404, no route) shows the update message and changes nothing", async () => {
  reset();
  world.clearReply = OLD_SERVER;
  const layer = await layerOnFeed();
  const r = await layer.freshContext();
  assert.equal(r.failure, "needs-update");
  assert.equal(world.session, "session-1", "session unchanged");
  assert.equal(layer.items.length, 2, "feed unchanged");
  assert.ok(painted(layer).includes("Fresh Context needs a server update"), world.drawn.join(" | "));
  layer.onRemoved();
});

test("lens: a double tap calls the box once", async () => {
  reset();
  const layer = await layerOnFeed();
  const [a, b] = await Promise.all([layer.freshContext(), layer.freshContext()]);
  assert.equal(world.clearCalls.length, 1);
  assert.equal(a.sessionId, b.sessionId);
  layer.onRemoved();
});

test("lens: a poll that was out when the session changed is dropped", async () => {
  reset();
  const layer = await layerOnFeed();
  // A poll for session-1 is in flight; Fresh Context lands before it answers.
  let release;
  const gate = new Promise((r) => (release = r));
  const realFetch = ghostClient.fetchFeed;
  ghostClient.fetchFeed = async (id) => {
    await gate;
    return realFetch(id);
  };
  const polling = layer.poll();
  await tick();
  ghostClient.fetchFeed = realFetch;
  await layer.freshContext();
  release();
  await polling;
  assert.equal(layer.items.length, 0, "old feed must not be written over the new session");
  layer.onRemoved();
});

// --------------------------------------------------------------------------
// The menus: glasses window menu, phone Ghost view

test("glasses: Ghost's window menu has Fresh Context, and selecting it runs the action", async () => {
  reset();
  const { createGhostAppWindow } = require(APP);
  createGhostAppWindow({ actions, submitFrame: noop, setSurfaceVisible: noop, removeSurface: noop, onClosed: noop });
  const opened = world.menuOptions;
  cleanups.push(() => opened.onClosed());
  const items = world.menuOptions.menuItems();
  const entry = items.find((i) => i.label === "Fresh Context");
  assert.ok(entry, `menu: ${items.map((i) => i.label).join(", ")}`);
  let popped = 0;
  entry.onSelect({ stack: { pop: () => popped++ } });
  await tick();
  await tick();
  assert.equal(popped, 1, "the menu closes first");
  assert.deepEqual(world.clearCalls, ["session-1"]);
  world.menuOptions.onClosed(); // stops the window's poll timer
});

test("phone: the Ghost view has a Fresh Context button bound to the action", () => {
  const xml = fs.readFileSync(path.join(ROOT, "app/phone-ui/ghost-companion.xml"), "utf8");
  assert.match(xml, /<Button[^>]*tap="\{\{ onFreshContextTap \}\}"/);
  assert.equal(typeof GhostCompanionViewModel.prototype.onFreshContextTap, "function");
});

// --------------------------------------------------------------------------
// The phone view model, through the real store to the real layer.

async function phoneWithLens() {
  const layer = await layerOnFeed();
  store.setGhostFreshContextHandler(() => layer.freshContext());
  const vm = new GhostCompanionViewModel();
  cleanups.push(() => vm.dispose());
  vm.attach();
  await tick();
  await tick();
  return { layer, vm };
}

function teardown({ layer, vm }) {
  vm.dispose();
  store.setGhostFreshContextHandler(null);
  layer.onRemoved();
}

test("phone: the action calls the endpoint, adopts the new id and clears the view", async () => {
  reset();
  const pair = await phoneWithLens();
  const { vm } = pair;
  assert.equal(vm._transcript.length, 2, "the old transcript is on screen first");
  assert.ok(vm.freshContextEnabled);
  await vm.onFreshContextTap();
  assert.deepEqual(world.clearCalls, ["session-1"]);
  assert.equal(world.session, "new-session-1");
  assert.equal(vm._state.sessionId, "new-session-1", "the phone follows the lens to the new id");
  assert.equal(vm._transcript.length, 0, "the old transcript is cleared");
  assert.deepEqual(vm.turns, []);
  assert.match(vm.freshContextStatus, /^Fresh context — new session/);
  assert.equal(vm.freshContextStatusVisibility, "visible");
  teardown(pair);
});

test("phone: an old server shows 'Fresh Context needs a server update' and keeps the view", async () => {
  reset();
  world.clearReply = OLD_SERVER;
  const pair = await phoneWithLens();
  const { vm } = pair;
  await vm.onFreshContextTap();
  assert.equal(vm.freshContextStatus, "Fresh Context needs a server update");
  assert.equal(world.session, "session-1");
  assert.equal(vm._transcript.length, 2, "nothing was cleared");
  teardown(pair);
});

test("phone: with Ghost closed on the glasses the button says so and calls nothing", async () => {
  reset();
  store.setGhostFreshContextHandler(null);
  const vm = new GhostCompanionViewModel();
  await vm.onFreshContextTap();
  assert.equal(vm.freshContextStatus, "Fresh Context: open Ghost on the glasses first");
  assert.deepEqual(world.clearCalls, []);
});

// --------------------------------------------------------------------------
// The "phone mic" marker on the listening screen.

async function listening() {
  const layer = await layerOnFeed();
  await layer.handleInput({ type: "scroll-down" }, {}); // arrive on the reply slot: listening
  assert.equal(layer.micState, "listening");
  return layer;
}

test("marker: a forced-phone-mic capture on the built-in mic shows 'phone mic' by the indicator", async () => {
  reset();
  const layer = await listening();
  world.statusListener({ status: "Listening...", phoneMicFallback: true });
  const texts = painted(layer);
  const headline = texts.find((t) => t.startsWith("Listening..."));
  assert.ok(headline, texts.join(" | "));
  assert.ok(headline.endsWith(`  ${PHONE_MIC_MARKER}`), headline);
  layer.onRemoved();
});

test("marker: absent on the hearing aids, present once the route falls back", async () => {
  reset();
  const layer = await listening();
  world.statusListener({ status: "Listening...", phoneMicFallback: false });
  assert.ok(!painted(layer).some((t) => t.includes(PHONE_MIC_MARKER)));
  world.statusListener({ status: "Listening...", phoneMicFallback: true });
  assert.ok(painted(layer).some((t) => t.includes(PHONE_MIC_MARKER)));
  layer.onRemoved();
});

test("marker rule: only a FORCED phone mic routed to BUILTIN_MIC counts", () => {
  const { isPhoneMicFallback } = require(path.join(BUILD, "app/native/mic-route.js"));
  assert.equal(isPhoneMicFallback(true, "BUILTIN_MIC"), true);
  assert.equal(isPhoneMicFallback(true, "BLE_HEADSET"), false);
  assert.equal(isPhoneMicFallback(true, ""), false, "unknown route is not evidence");
  assert.equal(isPhoneMicFallback(false, "BUILTIN_MIC"), false, "preview-only mode: the phone mic is the plan");
  assert.equal(isPhoneMicFallback(true, null), false);
});
