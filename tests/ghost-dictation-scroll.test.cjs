// Ghost dictation: a scroll-up that ends listening (2026-10-04).
//
// The glasses' touchpad reports some of Chris's end-of-dictation taps as
// scrolls (knowledge/staging/ghost-send-tap-lost-return.md in the TLC repo):
// a scroll-up while listening threw the dictation away, and a scroll-up during
// a refine's "Adding..." threw away the ORIGINAL text too (09-30 22:12). This
// drives the REAL GhostLayer, transpiled without type-checking (tsc checks it),
// with its NativeScript and native imports replaced by fakes, through the two
// scripted sequences:
//   1. speech, then scroll-up            -> the text is sent (as a tap would)
//   2. "Adding...", then scroll-up       -> the original text is sent, the addition dropped
// Both fail on 062fb8a, where each ends with nothing sent. The third case (a
// quick scroll through an empty mic slot still abandons) passes on both.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "app/apps/ghost/ghost-layer.ts");
const OUT = path.join(ROOT, ".test-build/app/apps/ghost/ghost-layer-dictation.js");

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

const world = {
  items: [],
  sent: [], // every sendInput text
  outcomes: [], // every noteCaptureOutcome(outcome, via)
  transcript: null, // the layer's transcript listener
  captures: 0, // startVoiceCapture calls
};

const noop = () => {};
const inert = new Proxy({}, { get: () => noop });

globalThis.com = { faceclaw: { app: { FaceclawBleCommunicator: { getActive: () => null } } } };

const stubs = {
  "../../graphics/image": { GrayImage: class {} },
  "../../graphics/ui-fonts": { getDefaultMediumFont: () => ({}), getDefaultSmallFont: () => ({}) },
  "../../graphics/textwrap": { truncateText: (t) => t, wrapText: (t) => [t] },
  "../../ui/gestures": {
    gestureHints: () => "",
    GESTURE_CLICK: "click",
    GESTURE_DOUBLE_CLICK: "double",
    GESTURE_SCROLL: "scroll",
    GESTURE_SCROLL_DOWN: "down",
    GESTURE_SCROLL_UP: "up",
  },
  "../../ui/menu": inert,
  "../../ui/metrics": { LIST_ROW_TEXT_INSET: 0, lineStep: () => 1, listRowHeight: () => 1 },
  "../../ui/layers": {},
  "../../ui/shell/shell": { shell: inert },
  "../../native/voice-control": {
    voiceControlBridge: {
      onTranscript: (listener) => {
        world.transcript = listener;
        return noop;
      },
      onStatus: () => noop,
      noteCaptureOutcome: (outcome, via) => world.outcomes.push([outcome, via]),
      lastRawInput: () => "sys-event SCROLL_TOP_EVENT TOUCH_EVENT_FROM_GLASSES_R",
    },
  },
  "../../util/numeric-util": { clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)) },
  "./ghost-client": {
    fetchActiveSessionId: async () => null,
    fetchFeed: async () => ({ feed: { items: world.items.slice() } }),
    fetchProse: async () => null,
    ghostAuthHeaders: () => ({}),
    ghostAutoFollowSetting: { get: () => false, set: noop },
    ghostSessionId: () => "session-1",
    ghostSessionSetting: { get: () => "session-1", set: noop },
    ghostSpeakSetting: { get: () => false, set: noop },
    sendApproval: async () => true,
    sendInput: async (_session, text) => {
      world.sent.push(text);
      return true;
    },
    ttsUrl: (_session, text) => `tts:${text}`,
  },
  "./ghost-speech": { speakGhost: noop, stopGhostSpeech: noop, appendGhostSpeechReceipt: noop },
};

const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (parent && parent.filename === OUT && Object.prototype.hasOwnProperty.call(stubs, request)) {
    return stubs[request];
  }
  return realLoad.call(this, request, parent, isMain);
};

const realLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  if (!line.startsWith("ghost:")) realLog(...args);
};

const { GhostLayer } = require(OUT);

const actions = new Proxy(
  {},
  {
    get: (_t, name) => {
      if (name === "startVoiceCapture") return async () => void world.captures++;
      return async () => {};
    },
  },
);

function reset() {
  world.items = [{ uuid: "a1", role: "assistant", headline: "Earlier reply", body: ["Earlier reply"] }];
  world.sent = [];
  world.outcomes = [];
  world.captures = 0;
}

async function layerOnFeed() {
  const layer = new GhostLayer(actions);
  await layer.poll();
  return layer;
}

const input = (layer, type) => layer.handleInput({ type }, {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The auto-send countdown is 4 x 1 s; this outlasts it. */
const AUTO_SEND_WAIT_MS = 4600;

test("speech, then scroll-up: the dictation is sent as a tap would send it", async () => {
  reset();
  const layer = await layerOnFeed();
  await input(layer, "scroll-down"); // arrive on the mic slot: listening
  assert.equal(layer.micState, "listening");
  // The recogniser committed a segment after Chris stopped talking.
  world.transcript({ text: "turn the lights off", isFinal: false });
  await input(layer, "scroll-up"); // the end-of-dictation tap, reported as a scroll
  // The final transcript arrives after the mic stops.
  world.transcript({ text: "turn the lights off", isFinal: true });
  await sleep(AUTO_SEND_WAIT_MS);
  assert.deepEqual(world.sent, ["turn the lights off"], `outcomes: ${JSON.stringify(world.outcomes)}`);
  assert.ok(world.outcomes.some(([o]) => o === "scroll-commit"));
  assert.ok(
    world.outcomes.some(([o, via]) => o === "input scroll-up" && via.startsWith("ghost listening->sending raw sys-event")),
    JSON.stringify(world.outcomes),
  );
});

test("'Adding...', then scroll-up: the original text is kept and sent, the addition dropped", async () => {
  reset();
  const layer = await layerOnFeed();
  await input(layer, "scroll-down");
  world.transcript({ text: "book the table for seven", isFinal: true });
  assert.equal(layer.micState, "confirming");
  await input(layer, "scroll-down"); // refine: "Adding..."
  assert.equal(layer.micState, "listening");
  assert.equal(layer.addingToRaw, true);
  await input(layer, "scroll-up"); // 0.34 s later on 09-30: the same touch read as up
  // A late final for the dropped addition must not resurrect it.
  world.transcript({ text: "no wait eight", isFinal: true });
  await sleep(AUTO_SEND_WAIT_MS);
  assert.deepEqual(world.sent, ["book the table for seven"], `outcomes: ${JSON.stringify(world.outcomes)}`);
  assert.ok(world.outcomes.some(([o]) => o === "addition-cancelled"));
});

test("a quick scroll through an empty mic slot still abandons", async () => {
  reset();
  const layer = await layerOnFeed();
  await input(layer, "scroll-down");
  assert.equal(layer.micState, "listening");
  await input(layer, "scroll-up"); // nothing heard, well under 3 s
  assert.equal(layer.micState, "idle");
  assert.ok(world.outcomes.some(([o]) => o === "abandoned"));
  await sleep(200);
  assert.deepEqual(world.sent, []);
});
