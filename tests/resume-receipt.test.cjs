// The resume receipt line (app/g2/resume-receipt.ts).
//
// The point of the file is a comparison: every line's `ms` has to be the same
// quantity as the 449 ms hand-read from logcat on 2026-09-08, or a later
// reader will subtract two different things. So what is pinned here is which
// boundary `ms` measures, that a coalesced join is never mistaken for a
// resume, and that a reading nowhere near 449 is labelled as such in the line
// itself.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resumeReceiptLine,
  emptyResumeStamps,
  resumeSanity,
  localStamp,
  RESUME_KNOWN_GOOD_MS,
  RESUME_SANITY_MIN_MS,
  RESUME_SANITY_MAX_MS,
} = require("../.test-build/app/g2/resume-receipt.js");

const T0 = 1_758_290_000_000; // an arbitrary fixed epoch ms

// A barrier that woke a suspended session: screen-on 20ms, resume 200ms,
// unblank 30ms, await-ready 219ms -> resume-start to ready is 449ms.
function goodResume(overrides = {}) {
  return {
    ...emptyResumeStamps(),
    id: 7,
    frameId: 1234,
    startedAtMs: T0,
    resumeStartedAtMs: T0 + 20,
    resumeDoneAtMs: T0 + 220,
    unblankDoneAtMs: T0 + 250,
    readyDoneAtMs: T0 + 469,
    endedAtMs: T0 + 469,
    resumed: true,
    ready: true,
    wasSuspended: true,
    suspendedForMs: 31_840,
    sessionUpMs: 812_345,
    ...overrides,
  };
}

const RING_UP = '{"state":"up","onDemand":false,"wanted":true,"ageMs":13235,"abortedRetries":0}';

test("every line is one parseable JSON object", () => {
  const parsed = JSON.parse(resumeReceiptLine(goodResume(), 449, RING_UP, "direct"));
  assert.equal(parsed.type, "resume");
  assert.equal(parsed.id, 7);
  assert.equal(parsed.frame, 1234);
  assert.equal(parsed.mode, "direct");
});

test("ms is resume-start to content-frame-ack, NOT the whole barrier", () => {
  const parsed = JSON.parse(resumeReceiptLine(goodResume(), -1, RING_UP, "direct"));
  // 469 - 20: the screen-on round trip is excluded, because the 449 ms
  // measurement excluded it too.
  assert.equal(parsed.ms, RESUME_KNOWN_GOOD_MS);
  assert.equal(parsed.barrierMs, 469);
  assert.equal(parsed.screenOnMs, 20);
  assert.equal(parsed.resumeMs, 200);
  assert.equal(parsed.unblankMs, 30);
  assert.equal(parsed.readyMs, 219);
  assert.equal(parsed.sanity, "ok");
});

test("preludeMs is passed through untouched; -1 when no prelude was replayed", () => {
  assert.equal(JSON.parse(resumeReceiptLine(goodResume(), 441, RING_UP, "direct")).preludeMs, 441);
  assert.equal(JSON.parse(resumeReceiptLine(goodResume(), -1, RING_UP, "direct")).preludeMs, -1);
});

test("a coalesced join is flagged, and its ms is the wait, not a resume", () => {
  const joined = {
    ...emptyResumeStamps(),
    id: 7,
    coalesced: true,
    startedAtMs: T0 + 100,
    endedAtMs: T0 + 469,
  };
  const parsed = JSON.parse(resumeReceiptLine(joined, 449, RING_UP, "direct"));
  assert.equal(parsed.coalesced, true);
  assert.equal(parsed.ms, 369);
  // It shares the id of the barrier it waited on, so the two join on `id`.
  assert.equal(parsed.id, 7);
  // A joiner is not a resume, so it never carries a resume verdict.
  assert.equal(parsed.sanity, "n/a");
  assert.equal(parsed.resumeMs, -1);
});

test("a reading nowhere near 449 says so in the line", () => {
  assert.equal(resumeSanity(RESUME_KNOWN_GOOD_MS, false), "ok");
  assert.equal(resumeSanity(RESUME_SANITY_MIN_MS, false), "ok");
  assert.equal(resumeSanity(RESUME_SANITY_MIN_MS - 1, false), "implausibly-fast");
  assert.equal(resumeSanity(RESUME_SANITY_MAX_MS, false), "ok");
  assert.equal(resumeSanity(RESUME_SANITY_MAX_MS + 1, false), "implausibly-slow");
  assert.equal(resumeSanity(-1, false), "n/a");
});

test("a barrier that stopped at !resumed still writes a line, with -1 spans", () => {
  const stopped = {
    ...emptyResumeStamps(),
    id: 8,
    startedAtMs: T0,
    resumeStartedAtMs: T0 + 18,
    resumeDoneAtMs: T0 + 24,
    endedAtMs: T0 + 24,
    resumed: false,
  };
  const parsed = JSON.parse(resumeReceiptLine(stopped, -1, RING_UP, "glasses"));
  assert.equal(parsed.resumed, false);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.resumeMs, 6);
  assert.equal(parsed.unblankMs, -1);
  assert.equal(parsed.readyMs, -1);
  // The span still resolves off endedAtMs, and 6ms is flagged rather than
  // quietly joining the resume population.
  assert.equal(parsed.ms, 6);
  assert.equal(parsed.sanity, "implausibly-fast");
});

test("the ring fragment is embedded as an object, and anything else becomes null", () => {
  const withRing = JSON.parse(resumeReceiptLine(goodResume(), 449, RING_UP, "direct"));
  assert.equal(withRing.ring.state, "up");
  assert.equal(withRing.ring.ageMs, 13235);
  for (const bad of ["", "not json", "[1,2]", null, undefined]) {
    assert.equal(JSON.parse(resumeReceiptLine(goodResume(), 449, bad, "direct")).ring, null);
  }
});

test("at and atMs are the same instant, and at carries its UTC offset", () => {
  const parsed = JSON.parse(resumeReceiptLine(goodResume(), 449, RING_UP, "direct"));
  assert.equal(parsed.atMs, T0 + 469);
  assert.equal(new Date(parsed.at).getTime(), parsed.atMs);
  assert.match(parsed.at, /[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(localStamp(T0)).getTime(), T0);
});
