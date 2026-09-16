// A store append that fails must throw and must not mark anything as held
// (app/health/health-store.ts). Before 2026-09-16 the shard took the sample
// before the append and the file backend swallowed the error, so a failed
// write counted as written and the dedupe refused the retry until restart.
// The ring page journal commits its watermark only after these calls return,
// so "throws, then retries cleanly" is what keeps a failed write recoverable.
const test = require("node:test");
const assert = require("node:assert/strict");

const { HealthStore } = require("../.test-build/app/health/health-store.js");

const HOUR = 3600000;

/** In-memory backend whose appends fail while `failing` is set. */
function flakyBackend() {
  const files = new Map();
  return {
    files,
    failing: false,
    exists: (name) => files.has(name),
    read: (name) => files.get(name) ?? null,
    append(name, text) {
      if (this.failing) throw new Error(`simulated append failure (${name})`);
      files.set(name, (files.get(name) ?? "") + text);
    },
    write(name, text) {
      files.set(name, text);
    },
    list: () => [...files.keys()],
  };
}

function sample(startMs, avg) {
  return { metric: "heartRate", startMs, spanMs: HOUR, min: avg - 5, max: avg + 5, avg, total: avg };
}

function session(startMs) {
  return {
    dayStartMs: new Date(2026, 8, 16).getTime(),
    startMs,
    endMs: startMs + 7 * HOUR,
    totalSec: 6 * 3600,
    wakeSec: 3600,
    remSec: 3600,
    lightSec: 3 * 3600,
    deepSec: 2 * 3600,
    segments: [],
    timeResolved: true,
  };
}

test("a failed sample append throws, and the retry writes the same sample", () => {
  const backend = flakyBackend();
  const store = new HealthStore(backend);
  const hour = new Date(2026, 8, 16, 1).getTime();

  backend.failing = true;
  assert.throws(() => store.ingestSamples([sample(hour, 61)]), /simulated append failure/);
  assert.equal(store.samplesInRange(hour, hour + HOUR).length, 0, "nothing held after a failed append");

  backend.failing = false;
  assert.equal(store.ingestSamples([sample(hour, 61)]), 1, "the retry is not deduped away");
  const shard = [...backend.files.keys()].find((name) => name.startsWith("samples-"));
  assert.equal(backend.files.get(shard).trim().split("\n").length, 1);
  assert.equal(new HealthStore(backend).samplesInRange(hour, hour + HOUR)[0].avg, 61);
});

test("a changed value in the same batch still appends both lines, last one held", () => {
  const backend = flakyBackend();
  const store = new HealthStore(backend);
  const hour = new Date(2026, 8, 16, 2).getTime();
  assert.equal(store.ingestSamples([sample(hour, 60), sample(hour, 60), sample(hour, 64)]), 2);
  assert.equal(store.samplesInRange(hour, hour + HOUR)[0].avg, 64);
  assert.equal(store.ingestSamples([sample(hour, 64)]), 0, "an unchanged re-send is still a no-op");
});

test("a failure in the second month's shard keeps the first month's samples held", () => {
  const backend = flakyBackend();
  const store = new HealthStore(backend);
  const aug = new Date(2026, 7, 31, 23).getTime();
  const sep = new Date(2026, 8, 1, 0).getTime();
  const append = backend.append.bind(backend);
  backend.append = (name, text) => {
    if (name.includes("2026-09")) throw new Error("simulated append failure (september)");
    append(name, text);
  };
  assert.throws(() => store.ingestSamples([sample(aug, 58), sample(sep, 59)]), /september/);
  assert.equal(store.samplesInRange(aug, aug + HOUR).length, 1, "august reached its file and is held");
  assert.equal(store.samplesInRange(sep, sep + HOUR).length, 0, "september did not");
  backend.append = append;
  assert.equal(store.ingestSamples([sample(aug, 58), sample(sep, 59)]), 1, "only september is written on retry");
});

test("a failed sleep append throws, and the retry writes the same session", () => {
  const backend = flakyBackend();
  const store = new HealthStore(backend);
  const night = new Date(2026, 8, 16, 0, 45).getTime();

  backend.failing = true;
  assert.throws(() => store.ingestSleep([session(night)]), /simulated append failure/);
  assert.equal(store.sleepSessions().length, 0, "nothing held after a failed append");

  backend.failing = false;
  assert.equal(store.ingestSleep([session(night)]), 1, "the retry is not deduped away");
  assert.equal(new HealthStore(backend).sleepSessions().length, 1);
  assert.equal(store.ingestSleep([session(night)]), 0, "an identical re-send is still a no-op");
});
