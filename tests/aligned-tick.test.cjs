// The shared wall-clock :01/:31 tick (app/util/aligned-tick.ts).
//
// The arithmetic is the part that matters: it was written in 0157 to replace
// an ELAPSED timer that drifted (a pull at :07 setting the next at :37, then
// :07), so the property to pin is that the answer depends only on where the
// clock is, never on when the last tick happened.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  onAlignedTick,
  runAlignedTick,
  __alignedTickInternals,
} = require("../.test-build/app/util/aligned-tick.js");

const { msUntilNextAlignedTick, ALIGNED_TICK_MINUTES } = __alignedTickInternals;

const at = (hour, minute, second = 0, ms = 0) => new Date(2026, 8, 15, hour, minute, second, ms);
const MIN = 60_000;

test("the slots are :01 and :31", () => {
  assert.deepEqual(Array.from(ALIGNED_TICK_MINUTES), [1, 31]);
});

test("before the first slot of the hour, it waits for :01", () => {
  assert.equal(msUntilNextAlignedTick(at(9, 0, 0)), 1 * MIN);
  assert.equal(msUntilNextAlignedTick(at(9, 0, 30)), 30_000);
});

test("between the slots, it waits for :31", () => {
  assert.equal(msUntilNextAlignedTick(at(9, 1, 0)), 30 * MIN);
  assert.equal(msUntilNextAlignedTick(at(9, 7, 0)), 24 * MIN);
  assert.equal(msUntilNextAlignedTick(at(9, 30, 0)), 1 * MIN);
});

test("after the last slot, it waits for :01 of the next hour", () => {
  assert.equal(msUntilNextAlignedTick(at(9, 31, 0)), 30 * MIN);
  assert.equal(msUntilNextAlignedTick(at(9, 59, 0)), 2 * MIN);
});

test("seconds and milliseconds inside the current minute are subtracted", () => {
  assert.equal(msUntilNextAlignedTick(at(9, 7, 15, 250)), 24 * MIN - 15_250);
});

test("the delay never depends on when the last tick fired", () => {
  // The drift bug in one assertion: two processes that ticked at different
  // times but are now at the same wall clock must agree exactly.
  assert.equal(msUntilNextAlignedTick(at(9, 7, 0)), msUntilNextAlignedTick(at(10, 7, 0)));
  assert.equal(msUntilNextAlignedTick(at(9, 7, 0)), msUntilNextAlignedTick(at(23, 7, 0)));
});

test("it always lands on a slot, from every minute of the hour", () => {
  for (let minute = 0; minute < 60; minute++) {
    for (const second of [0, 17, 59]) {
      const now = at(9, minute, second);
      const landing = new Date(now.getTime() + msUntilNextAlignedTick(now));
      assert.ok(
        ALIGNED_TICK_MINUTES.includes(landing.getMinutes()),
        `from ${minute}:${second} landed on :${landing.getMinutes()}`,
      );
      assert.equal(landing.getSeconds(), 0);
      assert.equal(landing.getMilliseconds(), 0);
    }
  }
});

test("every listener runs, and one that throws does not cost the others theirs", () => {
  __alignedTickInternals.clearListeners();
  const ran = [];
  onAlignedTick(() => ran.push("first"));
  onAlignedTick(() => {
    throw new Error("provider blew up");
  });
  onAlignedTick(() => ran.push("third"));
  runAlignedTick();
  assert.deepEqual(ran, ["first", "third"]);
  __alignedTickInternals.clearListeners();
});

test("unsubscribing stops a listener", () => {
  __alignedTickInternals.clearListeners();
  let count = 0;
  const off = onAlignedTick(() => {
    count += 1;
  });
  runAlignedTick();
  off();
  runAlignedTick();
  assert.equal(count, 1);
  assert.equal(__alignedTickInternals.listenerCount(), 0);
});
