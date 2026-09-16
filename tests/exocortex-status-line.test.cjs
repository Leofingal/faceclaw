// The home screen's status lines (app/apps/exocortex/status-line.ts): the fit
// rule and the formatters. Two properties are worth pinning above all the
// others, because both are silent when they break:
//
//   1. a null status must produce NO layout at all, so the row draws exactly
//      as it did before this feature existed;
//   2. the app's NAME is never shortened to make room for a status.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MIN_STATUS_WIDTH,
  STATUS_GAP,
  WEATHER_STATUS_MAX_AGE_MS,
  formatGhostStatus,
  formatStepsStatus,
  formatWeatherStatus,
  groupDigits,
  layoutRowStatus,
  parseGhostTimestamp,
} = require("../.test-build/app/apps/exocortex/status-line.js");

// A font with arithmetic anyone can do in their head: every character is
// exactly 10px wide, so a width in pixels is a character count times ten.
// Deliberately coarser than any real face - the 12px Terminus this ships
// against is nearer 6px a character - because a coarse font reaches the
// give-up branches with short, readable test strings.
const font = { measureText: (text) => text.length * 10 };

const ROW = { textX: 40, rowRight: 540 };
// What a zero-width label would leave for a status: 540 - 40 - 12.
const FREE = ROW.rowRight - ROW.textX - STATUS_GAP;

// ---------------------------------------------------------------------------
// The fit rule

test("a null or empty status produces no layout at all", () => {
  assert.equal(layoutRowStatus(font, { ...ROW, label: "Health", status: null }), null);
  assert.equal(layoutRowStatus(font, { ...ROW, label: "Health", status: "" }), null);
  assert.equal(layoutRowStatus(font, { ...ROW, label: "Health", status: "   " }), null);
});

test("a status is right-aligned against the row's right edge", () => {
  const laid = layoutRowStatus(font, { ...ROW, label: "Health", status: "8,432 steps" });
  assert.equal(laid.text, "8,432 steps");
  // 11 characters * 10px = 110px wide, ending flush with rowRight.
  assert.equal(laid.x, 540 - 110);
});

test("a status too long for the leftover space is truncated, not the name", () => {
  const label = "Health";
  const available = FREE - font.measureText(label);
  const laid = layoutRowStatus(font, { ...ROW, label, status: "x".repeat(80) });
  assert.ok(laid.text.endsWith("..."));
  assert.ok(font.measureText(laid.text) <= available);
  // The name is untouched by any of this: the caller passes it in already
  // laid out, and nothing here hands a different one back.
  assert.deepEqual(Object.keys(laid).sort(), ["text", "x"]);
});

test("a name that fills the row costs its status, and keeps every character", () => {
  const label = "A".repeat(49); // 490px, past the row's right edge once gapped
  assert.ok(FREE - font.measureText(label) < 0);
  assert.equal(layoutRowStatus(font, { ...ROW, label, status: "8,432 steps" }), null);
});

test("a slot under the minimum legible width is refused outright", () => {
  const label = "A".repeat(47);
  assert.equal(FREE - font.measureText(label), 18);
  assert.ok(18 < MIN_STATUS_WIDTH);
  assert.equal(layoutRowStatus(font, { ...ROW, label, status: "12m ago" }), null);
});

test("a slot too narrow for even an ellipsis is dropped WHOLE, never stubbed", () => {
  // Past the minimum-width gate, but "..." alone costs 30px in this font. The
  // gate is a floor, not a promise: what decides it is whether a truncated
  // form actually fits, and a lone "..." on a row is damage, not information.
  const label = "A".repeat(46);
  assert.equal(FREE - font.measureText(label), MIN_STATUS_WIDTH);
  assert.equal(layoutRowStatus(font, { ...ROW, label, status: "12m ago" }), null);
});

test("a status that fits once truncated is truncated rather than dropped", () => {
  const label = "A".repeat(42);
  const available = FREE - font.measureText(label);
  assert.equal(available, 68);
  const laid = layoutRowStatus(font, { ...ROW, label, status: "12m ago" });
  assert.equal(laid.text, "12m...");
  assert.ok(font.measureText(laid.text) <= available);
});

// ---------------------------------------------------------------------------
// Health

test("formatStepsStatus groups digits and labels the unit", () => {
  assert.equal(formatStepsStatus(8432), "8,432 steps");
  assert.equal(formatStepsStatus(942), "942 steps");
  assert.equal(formatStepsStatus(1234567), "1,234,567 steps");
});

test("formatStepsStatus tells no data from a genuine zero", () => {
  assert.equal(formatStepsStatus(null), null);
  assert.equal(formatStepsStatus(0), "0 steps");
  assert.equal(formatStepsStatus(-1), null);
  assert.equal(formatStepsStatus(Number.NaN), null);
});

test("groupDigits matches toLocaleString for the en-US case it replaces", () => {
  for (const value of [0, 7, 42, 999, 1000, 10_000, 123_456, 9_876_543]) {
    assert.equal(groupDigits(value), value.toLocaleString("en-US"));
  }
});

// ---------------------------------------------------------------------------
// Weather

const FRESH = {
  temperatureF: 72,
  description: "Sunny",
  precipitationPercent: 0,
  lastUpdatedMs: 1_000_000,
};

test("formatWeatherStatus builds Chris's line", () => {
  assert.equal(formatWeatherStatus(FRESH, 1_000_000), "72F 0% Sunny");
});

test("formatWeatherStatus omits the fields it does not have", () => {
  assert.equal(
    formatWeatherStatus({ ...FRESH, precipitationPercent: null }, 1_000_000),
    "72F Sunny",
  );
  assert.equal(
    formatWeatherStatus({ ...FRESH, temperatureF: null, precipitationPercent: null }, 1_000_000),
    "Sunny",
  );
  assert.equal(
    formatWeatherStatus({ ...FRESH, temperatureF: null, precipitationPercent: null, description: "" }, 1_000_000),
    null,
  );
});

test("formatWeatherStatus refuses a cache that was never filled, or has gone stale", () => {
  assert.equal(formatWeatherStatus(null, 1_000_000), null);
  assert.equal(formatWeatherStatus({ ...FRESH, lastUpdatedMs: null }, 1_000_000), null);
  assert.equal(formatWeatherStatus(FRESH, 1_000_000 + WEATHER_STATUS_MAX_AGE_MS), "72F 0% Sunny");
  assert.equal(formatWeatherStatus(FRESH, 1_000_000 + WEATHER_STATUS_MAX_AGE_MS + 1), null);
});

test("formatWeatherStatus rounds rather than printing a decimal", () => {
  assert.equal(
    formatWeatherStatus({ ...FRESH, temperatureF: 71.6, precipitationPercent: 19.4 }, 1_000_000),
    "72F 19% Sunny",
  );
});

// ---------------------------------------------------------------------------
// Ghost

test("formatGhostStatus walks the same ladder as formatRelativeTime", () => {
  const now = 10_000_000_000;
  assert.equal(formatGhostStatus(now, now), "now");
  assert.equal(formatGhostStatus(now - 59_000, now), "now");
  assert.equal(formatGhostStatus(now - 60_000, now), "1m ago");
  assert.equal(formatGhostStatus(now - 12 * 60_000, now), "12m ago");
  assert.equal(formatGhostStatus(now - 60 * 60_000, now), "1h ago");
  assert.equal(formatGhostStatus(now - 25 * 3600_000, now), "1d ago");
});

test("formatGhostStatus returns null when nothing has ever arrived", () => {
  assert.equal(formatGhostStatus(null, 10_000_000_000), null);
  assert.equal(formatGhostStatus(0, 10_000_000_000), null);
});

test("parseGhostTimestamp takes all three shapes the box emits", () => {
  assert.equal(parseGhostTimestamp(undefined), null);
  assert.equal(parseGhostTimestamp(null), null);
  assert.equal(parseGhostTimestamp(""), null);
  assert.equal(parseGhostTimestamp(1_757_000_000_000), 1_757_000_000_000);
  // Below 1e12 is read as seconds - the year 2001 in ms, 33658 in seconds.
  assert.equal(parseGhostTimestamp(1_757_000_000), 1_757_000_000_000);
  assert.equal(parseGhostTimestamp("1757000000000"), 1_757_000_000_000);
  assert.equal(parseGhostTimestamp("2026-09-15T12:00:00.000Z"), Date.parse("2026-09-15T12:00:00.000Z"));
  assert.equal(parseGhostTimestamp("not a date"), null);
});
