// The Captions app's lifecycle (app/apps/microphones/mic-session-owners.ts):
// opening the Captions entry starts the caption session, leaving it stops it and
// releases the mic, and a Microphones window open alongside keeps the mic.
// The fake session mirrors MicSession's contract: start() starts captions only
// when the Captions setting is on; setCaptionsEnabled persists the setting and,
// while running, starts or stops captions immediately.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMicSessionOwners,
  openCaptionsApp,
  closeCaptionsApp,
} = require("../.test-build/app/apps/microphones/mic-session-owners.js");

function fakeSession(captionsSetting = false) {
  const s = {
    setting: captionsSetting,
    running: false,
    captionsActive: false,
    starts: 0,
    stops: 0,
    start() {
      if (s.running) return;
      s.running = true;
      s.starts++;
      if (s.setting) s.captionsActive = true;
    },
    stop() {
      if (!s.running) return;
      s.running = false;
      s.stops++;
      s.captionsActive = false;
    },
    setCaptionsEnabled(enabled) {
      s.setting = enabled;
      if (!s.running) return;
      s.captionsActive = enabled;
    },
  };
  return s;
}

test("opening Captions starts the caption session; leaving stops it and releases the mic", () => {
  const session = fakeSession(false);
  const owners = createMicSessionOwners(session);
  openCaptionsApp(session, owners);
  assert.equal(session.running, true);
  assert.equal(session.captionsActive, true);
  assert.equal(session.setting, true);
  assert.deepEqual(owners.held(), ["captions"]);
  closeCaptionsApp(session, owners);
  assert.equal(session.running, false, "mic released");
  assert.equal(session.captionsActive, false);
  assert.equal(session.setting, false, "captions off after leaving");
  assert.deepEqual(owners.held(), []);
});

test("Captions opened over a running Microphones session turns captions on; leaving keeps the mic for Microphones", () => {
  const session = fakeSession(false);
  const owners = createMicSessionOwners(session);
  owners.acquire("microphones");
  assert.equal(session.running, true);
  assert.equal(session.captionsActive, false);
  openCaptionsApp(session, owners);
  assert.equal(session.captionsActive, true);
  assert.equal(session.starts, 1, "no second start");
  closeCaptionsApp(session, owners);
  assert.equal(session.running, true, "Microphones still holds the mic");
  assert.equal(session.captionsActive, false);
  owners.release("microphones");
  assert.equal(session.running, false);
  assert.equal(session.stops, 1);
});

test("closing Microphones while Captions is open keeps captions running", () => {
  const session = fakeSession(false);
  const owners = createMicSessionOwners(session);
  openCaptionsApp(session, owners);
  owners.acquire("microphones");
  owners.release("microphones");
  assert.equal(session.running, true);
  assert.equal(session.captionsActive, true);
  closeCaptionsApp(session, owners);
  assert.equal(session.running, false);
});

test("a release by an owner that never acquired does not stop the session", () => {
  const session = fakeSession(false);
  const owners = createMicSessionOwners(session);
  openCaptionsApp(session, owners);
  owners.release("microphones");
  assert.equal(session.running, true);
  closeCaptionsApp(session, owners);
  closeCaptionsApp(session, owners);
  assert.equal(session.stops, 1);
});
