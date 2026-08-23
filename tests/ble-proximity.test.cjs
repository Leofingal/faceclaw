// Ported from SybilSight's BLEProximityTests.
//
// These pin the parts the pairing screen depends on: that a stronger signal
// always sorts first, that the absolute numbers stay inside a plausible band,
// and that a missing signal degrades to "unknown" rather than to a fabricated
// distance.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  estimateProximity,
  GLASSES_CALIBRATION,
  RING_CALIBRATION,
  MINIMUM_METERS,
  MAXIMUM_METERS,
  zoneFromMeters,
  zoneLabel,
  formatDistance,
  proximitySummary,
  sortedByProximity,
} = require("../.test-build/app/g2/ble-proximity.js");

const near = (a, b, eps) => Math.abs(a - b) <= eps;

test("distance falls as signal weakens", () => {
  const close = estimateProximity(-40, null, GLASSES_CALIBRATION);
  const mid = estimateProximity(-70, null, GLASSES_CALIBRATION);
  const farAway = estimateProximity(-95, null, GLASSES_CALIBRATION);
  assert.ok(close.meters < mid.meters);
  assert.ok(mid.meters < farAway.meters);
});

test("the reference power reads as one metre", () => {
  const estimate = estimateProximity(GLASSES_CALIBRATION.txPowerAtOneMeter, null, GLASSES_CALIBRATION);
  assert.ok(near(estimate.meters, 1.0, 0.001));
  assert.equal(estimate.zone, "near");
});

test("estimates stay inside a plausible band", () => {
  assert.ok(near(estimateProximity(20, null, GLASSES_CALIBRATION).meters, MINIMUM_METERS, 0.0001));
  assert.ok(near(estimateProximity(-127, null, GLASSES_CALIBRATION).meters, MAXIMUM_METERS, 0.0001));
});

test("an advertised TX power overrides the calibration", () => {
  const assumed = estimateProximity(-60, null, GLASSES_CALIBRATION);
  const measured = estimateProximity(-60, -50, GLASSES_CALIBRATION);
  // A device that says it transmits at -50 dBm at 1 m, heard at -60, is further
  // away than one assumed to transmit at -62 — and it is trusted more.
  assert.ok(measured.meters > assumed.meters);
  assert.ok(measured.confidence > assumed.confidence);
});

test("no signal yields no estimate (127 is the unavailable sentinel)", () => {
  assert.equal(estimateProximity(null, null, GLASSES_CALIBRATION), null);
  assert.equal(estimateProximity(undefined, null, GLASSES_CALIBRATION), null);
  assert.equal(estimateProximity(127, null, GLASSES_CALIBRATION), null);
});

test("zones and their boundaries", () => {
  assert.equal(zoneFromMeters(0.2), "immediate");
  assert.equal(zoneFromMeters(0.5), "near");
  assert.equal(zoneFromMeters(2.9), "near");
  assert.equal(zoneFromMeters(3), "far");
  assert.equal(zoneFromMeters(9.9), "far");
  assert.equal(zoneFromMeters(10), "distant");
  assert.equal(zoneLabel("immediate"), "In your hand");
});

test("weak signals are marked as approximate", () => {
  const strong = estimateProximity(-45, -60, GLASSES_CALIBRATION);
  const weak = estimateProximity(-95, null, GLASSES_CALIBRATION);
  assert.ok(!formatDistance(strong).startsWith("~"));
  assert.ok(formatDistance(weak).startsWith("~"));
  assert.ok(weak.confidence < strong.confidence);
});

test("distance formatting is rounded hard", () => {
  const centimetres = estimateProximity(-30, -60, GLASSES_CALIBRATION);
  assert.ok(formatDistance(centimetres).includes("cm"), formatDistance(centimetres));
  assert.equal(formatDistance({ meters: 2.34, confidence: 1, zone: "near" }), "2.3 m");
  assert.equal(formatDistance({ meters: 42.6, confidence: 1, zone: "distant" }), "43 m");
  assert.equal(proximitySummary({ meters: 0.3, confidence: 1, zone: "immediate" }), "In your hand · 30 cm");
});

const device = (id, rssi) => ({ id, rssi });
const estimate = (d) => estimateProximity(d.rssi, null, GLASSES_CALIBRATION);
const byId = (d) => d.id;

test("glasses sort closest first", () => {
  const sorted = sortedByProximity([device("1", -80), device("2", -40), device("3", -60)], estimate, byId);
  assert.deepEqual(sorted.map(byId), ["2", "3", "1"]);
});

test("devices without a signal sort last and are not dropped", () => {
  const sorted = sortedByProximity([device("silent", null), device("heard", -70)], estimate, byId);
  assert.deepEqual(sorted.map(byId), ["heard", "silent"]);
});

test("equal signals keep a stable order", () => {
  const forward = sortedByProximity([device("b", -60), device("a", -60)], estimate, byId);
  const reversed = sortedByProximity([device("a", -60), device("b", -60)], estimate, byId);
  assert.deepEqual(forward.map(byId), ["a", "b"]);
  assert.deepEqual(reversed.map(byId), forward.map(byId));
});

test("ring and glasses are calibrated separately", () => {
  // The ring's antenna reads weaker than the glasses at the same distance, so
  // the same RSSI must not be reported as the same distance for both.
  const ring = estimateProximity(-70, null, RING_CALIBRATION);
  const glasses = estimateProximity(-70, null, GLASSES_CALIBRATION);
  assert.ok(ring.meters < glasses.meters);
});
