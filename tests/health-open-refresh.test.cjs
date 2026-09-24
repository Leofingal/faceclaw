// The phone Health tab's redraw-on-landing watch (app/health/health-open-refresh.ts).
//
// "Only when needed" pulls only when Health opens, and the pull lands ~20 s
// after the tab has drawn. The watch reads the communicator's finished-pull
// count and redraws when it moves. Pinned here: it redraws when the pull lands
// and not before, it stays silent (no timer at all) outside "Only when
// needed", it stops at the end of its window and on stop(), and a failed
// progress read or redraw does not wedge it.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  watchOpenPull,
  OPEN_PULL_POLL_MS,
  OPEN_PULL_WATCH_MS,
} = require("../.test-build/app/health/health-open-refresh.js");

/** A minimal manual clock: timers fire only when tick() passes them. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending() {
      return timers.size;
    },
  };
}

function rig(progress) {
  const clock = fakeClock();
  const state = { progress, redraws: 0, reads: 0 };
  const stop = watchOpenPull({
    progress: () => {
      state.reads++;
      return typeof state.progress === "function" ? state.progress() : state.progress;
    },
    redraw: () => {
      state.redraws++;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, state, stop };
}

test("constants: a 2 s poll over a 150 s window", () => {
  assert.equal(OPEN_PULL_POLL_MS, 2_000);
  assert.equal(OPEN_PULL_WATCH_MS, 150_000);
});

test("on-demand: redraws once when the open's pull lands, not before", () => {
  const { clock, state } = rig({ onDemand: true, pullsFinished: 4 });
  clock.tick(20_000);
  assert.equal(state.redraws, 0, "nothing has landed yet");
  state.progress = { onDemand: true, pullsFinished: 5 }; // the pull finished at ~20 s
  clock.tick(OPEN_PULL_POLL_MS);
  assert.equal(state.redraws, 1);
  clock.tick(30_000);
  assert.equal(state.redraws, 1, "no further redraw while nothing else lands");
});

test("on-demand: an aborted pull and its retry each redraw", () => {
  const { clock, state } = rig({ onDemand: true, pullsFinished: 0 });
  clock.tick(24_000);
  state.progress = { onDemand: true, pullsFinished: 1 }; // aborted, maybe partial
  clock.tick(60_000);
  state.progress = { onDemand: true, pullsFinished: 2 }; // the retry
  clock.tick(OPEN_PULL_POLL_MS);
  assert.equal(state.redraws, 2);
});

test("on-demand: stops at the end of its window, leaving no timer", () => {
  const { clock, state } = rig({ onDemand: true, pullsFinished: 0 });
  clock.tick(OPEN_PULL_WATCH_MS);
  const readsAtEnd = state.reads;
  assert.equal(clock.pending(), 0);
  clock.tick(60_000);
  assert.equal(state.reads, readsAtEnd, "no reads after the window");
  assert.equal(state.redraws, 0);
});

test("on-demand: stop() ends it at once; a landing afterwards draws nothing", () => {
  const { clock, state, stop } = rig({ onDemand: true, pullsFinished: 0 });
  clock.tick(4_000);
  stop();
  stop(); // twice is harmless
  assert.equal(clock.pending(), 0);
  state.progress = { onDemand: true, pullsFinished: 1 };
  clock.tick(10_000);
  assert.equal(state.redraws, 0);
});

test("Direct: no watch at all - no timer, no redraw, whatever lands", () => {
  const { clock, state } = rig({ onDemand: false, pullsFinished: 0 });
  assert.equal(clock.pending(), 0);
  state.progress = { onDemand: false, pullsFinished: 3 };
  clock.tick(60_000);
  assert.equal(state.redraws, 0);
  assert.equal(state.reads, 1, "one read at start, to learn the mode");
});

test("no communicator (preview, or glasses never connected): no watch", () => {
  const { clock, state } = rig(null);
  assert.equal(clock.pending(), 0);
  clock.tick(60_000);
  assert.equal(state.redraws, 0);
});

test("a progress read that throws at the start means no watch", () => {
  const { clock } = rig(() => {
    throw new Error("no such method on an older APK");
  });
  assert.equal(clock.pending(), 0);
});

test("the communicator going away mid-watch ends it", () => {
  const { clock, state } = rig({ onDemand: true, pullsFinished: 0 });
  clock.tick(4_000);
  state.progress = null;
  clock.tick(OPEN_PULL_POLL_MS);
  assert.equal(clock.pending(), 0);
  assert.equal(state.redraws, 0);
});

test("a new communicator (count back at 0) redraws rather than waiting for it to pass the old count", () => {
  const { clock, state } = rig({ onDemand: true, pullsFinished: 7 });
  clock.tick(4_000);
  state.progress = { onDemand: true, pullsFinished: 0 };
  clock.tick(OPEN_PULL_POLL_MS);
  assert.equal(state.redraws, 1);
});

test("a redraw that throws does not end the watch", () => {
  const clock = fakeClock();
  let n = 0;
  let calls = 0;
  watchOpenPull({
    progress: () => ({ onDemand: true, pullsFinished: n }),
    redraw: () => {
      calls++;
      throw new Error("render failed");
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  n = 1;
  clock.tick(OPEN_PULL_POLL_MS);
  n = 2;
  clock.tick(OPEN_PULL_POLL_MS);
  assert.equal(calls, 2);
  assert.equal(clock.pending(), 1);
});
