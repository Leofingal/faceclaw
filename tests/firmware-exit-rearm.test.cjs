// A running Microphones session re-arms the glasses mic after a firmware exit
// event (app/g2/firmware-exit.ts). 2026-09-25 19:01:17: SYSTEM_EXIT_EVENT
// mid-captions, the left arm stopped streaming 1.6 s later, and nothing asked
// for the mic again until the app was restarted.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FIRMWARE_EXIT_EVENT_TYPES,
  MIC_REARM_DELAY_MS,
  createFirmwareExitRearm,
  isFirmwareExitEvent,
  notifyFirmwareSysEvent,
  onFirmwareExit,
} = require("../.test-build/app/g2/firmware-exit.js");

function fakePort(running = true) {
  const port = {
    running,
    rearms: [],
    timers: [],
    isRunning: () => port.running,
    rearm: (why) => port.rearms.push(why),
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      port.timers.push(timer);
      return () => (timer.cancelled = true);
    },
    fire() {
      const due = port.timers.filter((t) => !t.cancelled && !t.fired);
      due.forEach((t) => {
        t.fired = true;
        t.fn();
      });
    },
  };
  return port;
}

test("the three firmware exits count; a click or scroll does not", () => {
  assert.deepEqual([...FIRMWARE_EXIT_EVENT_TYPES], [5, 6, 7]);
  assert.equal(isFirmwareExitEvent(7), true);
  assert.equal(isFirmwareExitEvent(0), false);
  assert.equal(isFirmwareExitEvent(10), false);
});

test("SYSTEM_EXIT while the session runs: one re-arm, after the delay", () => {
  const port = fakePort(true);
  const rearm = createFirmwareExitRearm(port);
  rearm.onExit(7);
  assert.equal(port.rearms.length, 0, "not at once");
  assert.equal(port.timers[0].ms, MIC_REARM_DELAY_MS);
  port.fire();
  assert.deepEqual(port.rearms, ["firmware exit event 7"]);
});

test("a burst of exits re-arms once; a later exit re-arms again", () => {
  const port = fakePort(true);
  const rearm = createFirmwareExitRearm(port);
  rearm.onExit(7);
  rearm.onExit(5);
  rearm.onExit(6);
  port.fire();
  assert.equal(port.rearms.length, 1);
  rearm.onExit(7);
  port.fire();
  assert.equal(port.rearms.length, 2);
});

test("no session, or the session stopped before the timer: no re-arm", () => {
  const idle = fakePort(false);
  createFirmwareExitRearm(idle).onExit(7);
  assert.equal(idle.timers.length, 0);
  const port = fakePort(true);
  const rearm = createFirmwareExitRearm(port);
  rearm.onExit(7);
  port.running = false;
  port.fire();
  assert.equal(port.rearms.length, 0);
  const cancelled = fakePort(true);
  const r2 = createFirmwareExitRearm(cancelled);
  r2.onExit(7);
  r2.cancel();
  cancelled.fire();
  assert.equal(cancelled.rearms.length, 0);
});

test("the bus delivers exits only, and unsubscribing stops delivery", () => {
  const seen = [];
  const off = onFirmwareExit((t) => seen.push(t));
  notifyFirmwareSysEvent(0);
  notifyFirmwareSysEvent(7);
  off();
  notifyFirmwareSysEvent(7);
  assert.deepEqual(seen, [7]);
});
