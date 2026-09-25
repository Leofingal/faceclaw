// Ghost does not speak while the glasses charge (2026-09-24).
//
// This drives the REAL GhostLayer (app/apps/ghost/ghost-layer.ts) through its
// poll, transpiled here without type-checking - `npx tsc -p tsconfig.json`
// type-checks it - with its NativeScript and native imports replaced by small
// fakes. The box's feed is a list the test grows; speech is a recorded call;
// the communicator is a fake whose only job is `glassesInCaseLatch()` (1 in
// the case, 0 out of it, -1 never known). ghost-charge-mute.ts itself is the
// real module, compiled by tests/tsconfig.json, so the latch read is real too.
//
// It is written to run against any checkout: on a build without the mute the
// "charging" cases fail (Ghost speaks) and the others pass, which is also the
// proof that speech off the charger did not change.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "app/apps/ghost/ghost-layer.ts");
const OUT = path.join(ROOT, ".test-build/app/apps/ghost/ghost-layer.js");

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
// The world the layer sees.

const world = {
  items: [], // the box's feed
  spoken: [], // every speakGhost() call, by text
  receipts: [], // every muted-speech receipt line
  logs: [], // console.log lines from the layer
  latch: 0, // communicator.glassesInCaseLatch(); null = no communicator
  speakSetting: true,
};

function resetWorld(latch) {
  world.items = [];
  world.spoken = [];
  world.receipts = [];
  world.logs = [];
  world.latch = latch;
  world.speakSetting = true;
}

globalThis.com = {
  faceclaw: {
    app: {
      FaceclawBleCommunicator: {
        getActive: () =>
          world.latch === null
            ? null
            : {
                glassesInCaseLatch: () => world.latch,
              },
      },
    },
  },
};

const noop = () => {};
/** Anything the poll path does not use: every property is a no-op function. */
const inert = new Proxy({}, { get: () => noop });

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
  "../../native/voice-control": { voiceControlBridge: { onTranscript: () => noop, onStatus: () => noop } },
  "../../util/numeric-util": { clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)) },
  "./ghost-client": {
    fetchActiveSessionId: async () => null,
    fetchFeed: async () => ({ feed: { items: world.items.slice() } }),
    fetchProse: async () => null,
    ghostAuthHeaders: () => ({}),
    ghostAutoFollowSetting: { get: () => false, set: noop },
    ghostSessionId: () => "session-1",
    ghostSessionSetting: { get: () => "session-1", set: noop },
    ghostSpeakSetting: { get: () => world.speakSetting, set: (v) => (world.speakSetting = v) },
    sendApproval: async () => true,
    sendInput: async () => true,
    ttsUrl: (_session, text) => `tts:${text}`,
  },
  "./ghost-speech": {
    speakGhost: (url, _headers, onEnd) => {
      world.spoken.push(url.replace(/^tts:/, ""));
      onEnd?.();
    },
    stopGhostSpeech: noop,
    appendGhostSpeechReceipt: (line) => world.receipts.push(JSON.parse(line)),
  },
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
  if (line.startsWith("ghost:")) world.logs.push(line);
  else realLog(...args);
};

const { GhostLayer } = require(OUT);

// ---------------------------------------------------------------------------

let nextId = 1;
function reply(text) {
  return { uuid: `a${nextId++}`, role: "assistant", headline: `${text} (headline)`, body: [text] };
}
function mine(text) {
  return { uuid: `u${nextId++}`, role: "user", headline: text, body: [text] };
}
function approval() {
  return { uuid: `p${nextId++}`, role: "assistant", kind: "approval", headline: "Allow edit?", body: [], options: [{ n: 1, label: "Yes" }] };
}

/** A layer that has already seen one reply, so the next arrival is "grew". */
async function settledLayer() {
  const layer = new GhostLayer(inert);
  world.items.push(mine("hello"));
  await layer.poll();
  world.spoken = [];
  world.receipts = [];
  world.logs = [];
  return layer;
}

const muteLines = () => world.logs.filter((l) => l.includes("glasses charging"));

test("off the charger: an arriving reply is spoken exactly as before", async () => {
  resetWorld(0);
  const layer = await settledLayer();
  world.items.push(reply("It is done."));
  await layer.poll();
  assert.deepEqual(world.spoken, ["It is done."]);
  assert.equal(world.receipts.length, 0);
  assert.equal(muteLines().length, 0);
});

test("on the charger: an arriving reply is not spoken, one log line and one receipt", async () => {
  resetWorld(1);
  const layer = await settledLayer();
  const item = reply("It is done.");
  world.items.push(item);
  await layer.poll();
  assert.deepEqual(world.spoken, []);
  assert.equal(muteLines().length, 1, world.logs.join("\n"));
  assert.match(muteLines()[0], new RegExp(`reply ${item.uuid}`));
  assert.equal(world.receipts.length, 1);
  assert.equal(world.receipts[0].type, "ghostSpeechMuted");
  assert.equal(world.receipts[0].reason, "glasses-in-case");
  assert.equal(world.receipts[0].kind, "reply");
  assert.equal(world.receipts[0].uuid, item.uuid);
  // The display is untouched: the cursor still follows onto the new reply.
  assert.equal(layer.cursor, world.items.indexOf(item));
});

test("on the charger: three replies, three lines; later polls with nothing new add none", async () => {
  resetWorld(1);
  const layer = await settledLayer();
  for (const text of ["one", "two", "three"]) {
    world.items.push(reply(text));
    await layer.poll();
    await layer.poll(); // nothing new: no second line for the same reply
  }
  assert.deepEqual(world.spoken, []);
  assert.equal(muteLines().length, 3);
  assert.equal(world.receipts.length, 3);
});

test("off the charger again: no backlog - only the next new reply speaks", async () => {
  resetWorld(1);
  const layer = await settledLayer();
  world.items.push(reply("night one"));
  await layer.poll();
  world.items.push(reply("night two"));
  await layer.poll();
  world.latch = 0; // the latch closed (the glasses were put on)
  await layer.poll(); // nothing new arrived
  assert.deepEqual(world.spoken, [], "muted replies must not be replayed");
  world.items.push(reply("morning"));
  await layer.poll();
  assert.deepEqual(world.spoken, ["morning"]);
});

test("the latch holds through a reconnect in the case (the phase would flicker)", async () => {
  // The dashboard phase goes charging -> connecting -> connected -> charging
  // on a reconnect in the case; the in-case latch does not move on a
  // reconnect, so it reads 1 all the way through. Replies across that window stay silent.
  resetWorld(1);
  const layer = await settledLayer();
  for (const phase of ["connecting", "connected", "charging"]) {
    world.items.push(reply(`during ${phase}`));
    await layer.poll();
  }
  assert.deepEqual(world.spoken, []);
  assert.equal(muteLines().length, 3);
});

test("not heard yet (-1) and no communicator: speaks as before", async () => {
  for (const latch of [-1, null]) {
    resetWorld(latch);
    const layer = await settledLayer();
    world.items.push(reply(`latch ${latch}`));
    await layer.poll();
    assert.deepEqual(world.spoken, [`latch ${latch}`]);
    assert.equal(world.receipts.length, 0);
  }
});

test("voice off: nothing is spoken and nothing is logged as muted", async () => {
  resetWorld(1);
  const layer = await settledLayer();
  world.speakSetting = false;
  world.items.push(reply("quiet anyway"));
  await layer.poll();
  assert.deepEqual(world.spoken, []);
  assert.equal(muteLines().length, 0);
  assert.equal(world.receipts.length, 0);
});

test("on the charger: an approval announcement is muted too, and not re-announced", async () => {
  resetWorld(1);
  const layer = await settledLayer();
  world.items.push(approval());
  await layer.poll();
  world.latch = 0;
  await layer.poll();
  assert.deepEqual(world.spoken, []);
  assert.equal(world.receipts.length, 1);
  assert.equal(world.receipts[0].kind, "approval");
});

test("off the charger: an approval is announced as before", async () => {
  resetWorld(0);
  const layer = await settledLayer();
  world.items.push(approval());
  await layer.poll();
  assert.deepEqual(world.spoken, ["Approval Request"]);
});

test("on the charger: the catch-up read after a send is muted", async () => {
  resetWorld(1);
  const layer = await settledLayer();
  // Park on the reply slot, as dictation does, and let a reply land.
  layer.cursor = world.items.length;
  const item = reply("while you talked");
  world.items.push(item);
  await layer.poll();
  assert.equal(layer.pendingCatchUpUuid, item.uuid);
  layer.catchUpAfterSend();
  assert.deepEqual(world.spoken, []);
  assert.equal(world.receipts.length, 1);
  assert.equal(world.receipts[0].kind, "catch-up");
  assert.equal(layer.follow, true, "follow comes back at once when the read is muted");
});

test("off the charger: the catch-up read after a send speaks as before", async () => {
  resetWorld(0);
  const layer = await settledLayer();
  layer.cursor = world.items.length;
  const item = reply("while you talked");
  world.items.push(item);
  await layer.poll();
  layer.catchUpAfterSend();
  assert.deepEqual(world.spoken, ["while you talked"]);
});

test("on the charger: tapping into a muted reply still reads it (an explicit ask)", async () => {
  resetWorld(1);
  const layer = await settledLayer();
  world.items.push(reply("read me when I ask"));
  await layer.poll();
  assert.deepEqual(world.spoken, []);
  await layer.tap();
  assert.deepEqual(world.spoken, ["read me when I ask"]);
  assert.equal(world.receipts.length, 1, "the explicit read writes no mute receipt");
});

// 2026-09-25: Ghost's speech plays to Chris's LE Audio hearing aids, and each
// stream start flipped the glasses-mic link into ~58% packet loss, garbling
// the captions. While a captions view is open, automatic speech is held.
const presence = require("../.test-build/app/apps/microphones/captions-view-presence.js");

test("captions on screen: an arriving reply is not spoken, one receipt with reason captions-open", async () => {
  resetWorld(0);
  const layer = await settledLayer();
  presence.captionsViewOpened();
  try {
    const item = reply("It is done.");
    world.items.push(item);
    await layer.poll();
    assert.deepEqual(world.spoken, []);
    assert.equal(world.receipts.length, 1);
    assert.equal(world.receipts[0].type, "ghostSpeechMuted");
    assert.equal(world.receipts[0].reason, "captions-open");
    assert.equal(world.receipts[0].uuid, item.uuid);
    assert.equal(world.logs.filter((l) => l.includes("captions on screen")).length, 1);
  } finally {
    presence.captionsViewClosed();
  }
});

test("captions closed again: the next reply speaks as before", async () => {
  resetWorld(0);
  const layer = await settledLayer();
  presence.captionsViewOpened();
  presence.captionsViewOpened();
  presence.captionsViewClosed();
  presence.captionsViewClosed();
  presence.captionsViewClosed(); // an extra close never goes negative
  world.items.push(reply("Back to normal."));
  await layer.poll();
  assert.deepEqual(world.spoken, ["Back to normal."]);
  assert.equal(world.receipts.length, 0);
});

test("in the case AND captions open: the receipt says glasses-in-case", async () => {
  resetWorld(1);
  const layer = await settledLayer();
  presence.captionsViewOpened();
  try {
    world.items.push(reply("quiet"));
    await layer.poll();
    assert.deepEqual(world.spoken, []);
    assert.equal(world.receipts[0].reason, "glasses-in-case");
  } finally {
    presence.captionsViewClosed();
  }
});
