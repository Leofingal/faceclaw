// The ring battery in the glasses top bar (app/ui/shell/top-bar.ts): what a
// ring reading turns into on the bar. The bytes-to-reading half is Java
// (RingProtocol.ringBatteryLevel / ringBatteryCharging, pinned in
// RingProtocolSelfTest against the same three payloads used here):
//
//   025233020100000000 -> level 51, not charging
//   d98531010000000000 -> level 49, charging
//   feab3b020000000000 -> level 59, not charging
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RING_BATTERY_STALE_MS,
  TOP_BAR_HEIGHT,
  drawTopBarBatteries,
  ringBatteryDisplayChanged,
  ringBatteryItem,
  topBarBatteryItems,
} = require("../.test-build/app/ui/shell/top-bar.js");
const { GrayImage, G2_LENS_WIDTH } = require("../.test-build/app/graphics/image.js");
const { BATTERY_ICON_WIDTH } = require("../.test-build/app/graphics/battery.js");

const NOW = new Date(2026, 8, 16, 14, 30, 0).getTime();
const MINUTE = 60 * 1000;

// The Java parse's output for the three known-good payloads, as the
// communicator hands it over (RingBatteryState).
const OFF_51 = { level: 51, charging: false, atMs: NOW - 5 * MINUTE };
const ON_49 = { level: 49, charging: true, atMs: NOW - 30 * 1000 };
const OFF_59 = { level: 59, charging: false, atMs: NOW - 20 * MINUTE };

// Every character 6px wide and a 12px line, like 12px Terminus. Text is a
// solid block of its ink, so what was drawn can be read back from pixels.
const font = {
  lineHeight: 12,
  descent: 2,
  measureText: (text) => text.length * 6,
  drawText: (image, x, y, text, value) => image.fillRect(x, y, text.length * 6, 12, value),
};

// ---------------------------------------------------------------------------
// Reading -> item

test("known-good 51, not charging: Ring 51, no charging mark, fresh", () => {
  assert.deepEqual(ringBatteryItem(OFF_51, NOW), { label: "Ring", percent: 51, charging: false, stale: false });
});

test("known-good 49, charging: Ring 49 with the charging mark", () => {
  assert.deepEqual(ringBatteryItem(ON_49, NOW), { label: "Ring", percent: 49, charging: true, stale: false });
});

test("known-good 59, not charging: Ring 59", () => {
  assert.deepEqual(ringBatteryItem(OFF_59, NOW), { label: "Ring", percent: 59, charging: false, stale: false });
});

test("no reading draws nothing", () => {
  assert.equal(ringBatteryItem(null, NOW), null);
  assert.equal(ringBatteryItem(undefined, NOW), null);
});

test("a level that is not a whole percentage draws nothing", () => {
  for (const level of [-1, 101, 255, 50.5, Number.NaN]) {
    assert.equal(ringBatteryItem({ ...OFF_51, level }, NOW), null, `level ${level}`);
  }
  assert.equal(ringBatteryItem({ ...OFF_51, atMs: Number.NaN }, NOW), null);
  assert.deepEqual(ringBatteryItem({ ...OFF_51, level: 0 }, NOW).percent, 0);
  assert.deepEqual(ringBatteryItem({ ...OFF_51, level: 100 }, NOW).percent, 100);
});

test("stale starts just past two hours, and a stale reading never shows charging", () => {
  assert.equal(RING_BATTERY_STALE_MS, 2 * 60 * MINUTE);
  const atEdge = ringBatteryItem({ ...ON_49, atMs: NOW - RING_BATTERY_STALE_MS }, NOW);
  assert.equal(atEdge.stale, false);
  assert.equal(atEdge.charging, true);
  const past = ringBatteryItem({ ...ON_49, atMs: NOW - RING_BATTERY_STALE_MS - 1 }, NOW);
  assert.deepEqual(past, { label: "Ring", percent: 49, charging: false, stale: true });
});

test("a reading stamped slightly in the future (clock skew) is fresh", () => {
  assert.equal(ringBatteryItem({ ...OFF_51, atMs: NOW + 5000 }, NOW).stale, false);
});

// ---------------------------------------------------------------------------
// The battery block's items

test("items run Phone, G2, Ring, each only when known", () => {
  const phone = { battery: 83, charging: false };
  const levels = { headset: 64, headsetCharging: false, ring: OFF_51 };
  assert.deepEqual(
    topBarBatteryItems(phone, levels, NOW).map((item) => item.label),
    ["Phone", "G2", "Ring"],
  );
  assert.deepEqual(
    topBarBatteryItems(phone, { ...levels, ring: null }, NOW).map((item) => item.label),
    ["Phone", "G2"],
  );
  assert.deepEqual(
    topBarBatteryItems({ battery: null, charging: null }, { headset: null, headsetCharging: null, ring: ON_49 }, NOW),
    [{ label: "Ring", percent: 49, charging: true, stale: false }],
  );
});

test("Phone and G2 items are unchanged by the ring: never stale, same fields", () => {
  const items = topBarBatteryItems({ battery: 83, charging: true }, { headset: 64, headsetCharging: false, ring: null }, NOW);
  assert.deepEqual(items, [
    { label: "Phone", percent: 83, charging: true, stale: false },
    { label: "G2", percent: 64, charging: false, stale: false },
  ]);
});

// ---------------------------------------------------------------------------
// Repaint decision

test("a new push with the same level and charger state does not repaint", () => {
  assert.equal(ringBatteryDisplayChanged(ON_49, { ...ON_49, atMs: NOW }, NOW), false);
});

test("a level, charger or staleness change repaints; so does the first reading", () => {
  assert.equal(ringBatteryDisplayChanged(ON_49, { ...ON_49, level: 50, atMs: NOW }, NOW), true);
  assert.equal(ringBatteryDisplayChanged(ON_49, { ...ON_49, charging: false, atMs: NOW }, NOW), true);
  assert.equal(ringBatteryDisplayChanged({ ...OFF_59, atMs: NOW - 3 * 60 * MINUTE }, { ...OFF_59, atMs: NOW }, NOW), true);
  assert.equal(ringBatteryDisplayChanged(null, OFF_51, NOW), true);
  assert.equal(ringBatteryDisplayChanged(null, { ...OFF_51, level: 255 }, NOW), false);
});

// ---------------------------------------------------------------------------
// Drawing

const BAR_TOP = 0;

function draw(items, percentageMode) {
  const image = new GrayImage(G2_LENS_WIDTH, TOP_BAR_HEIGHT, 0);
  const left = drawTopBarBatteries(image, font, items, BAR_TOP, percentageMode);
  return { left, pixels: image.withDrawsBaked().pixels };
}

function maxInColumns(pixels, x0, x1) {
  let max = 0;
  for (let y = 0; y < TOP_BAR_HEIGHT; y++) {
    for (let x = x0; x < x1; x++) max = Math.max(max, pixels[y * G2_LENS_WIDTH + x]);
  }
  return max;
}

test("no items: nothing drawn, block edge is the screen edge", () => {
  const { left, pixels } = draw([], true);
  assert.equal(left, G2_LENS_WIDTH);
  assert.equal(pixels.some((value) => value !== 0), false);
});

test("the ring takes label + gap + value + item gap to the left of G2, and G2/Phone keep their pixels", () => {
  const phone = { battery: 83, charging: false };
  const without = topBarBatteryItems(phone, { headset: 64, headsetCharging: false, ring: null }, NOW);
  const withRing = topBarBatteryItems(phone, { headset: 64, headsetCharging: false, ring: OFF_51 }, NOW);
  for (const percentageMode of [false, true]) {
    const a = draw(without, percentageMode);
    const b = draw(withRing, percentageMode);
    const ringValueWidth = percentageMode ? "51%".length * 6 : BATTERY_ICON_WIDTH;
    const ringWidth = "Ring".length * 6 + 5 + ringValueWidth + 12;
    assert.equal(a.left - b.left, ringWidth, `percentageMode ${percentageMode}`);
    // Phone and G2 shifted left by exactly ringWidth, pixel for pixel.
    for (let y = 0; y < TOP_BAR_HEIGHT; y++) {
      for (let x = a.left; x < G2_LENS_WIDTH - 8; x++) {
        assert.equal(
          b.pixels[y * G2_LENS_WIDTH + x - ringWidth],
          a.pixels[y * G2_LENS_WIDTH + x],
          `percentageMode ${percentageMode} at ${x},${y}`,
        );
      }
    }
  }
});

test("percentage mode: charging inverts the ring's value, not charging does not", () => {
  const valueX0 = G2_LENS_WIDTH - 8 - "49%".length * 6;
  const charging = draw([ringBatteryItem(ON_49, NOW)], true);
  assert.equal(maxInColumns(charging.pixels, valueX0 - 2, valueX0), 255, "inverted box around the value");
  const plain = draw([ringBatteryItem(OFF_51, NOW)], true);
  assert.equal(maxInColumns(plain.pixels, valueX0 - 2, valueX0), 0);
  assert.equal(maxInColumns(plain.pixels, valueX0, G2_LENS_WIDTH - 8), 200);
});

test("a stale reading is dimmed and loses its charging mark, in both modes", () => {
  const stale = ringBatteryItem({ ...ON_49, atMs: NOW - 3 * 60 * MINUTE }, NOW);
  const fresh = ringBatteryItem(ON_49, NOW);
  const staleOff = ringBatteryItem({ ...OFF_59, level: 49, atMs: NOW - 3 * 60 * MINUTE }, NOW);
  for (const percentageMode of [false, true]) {
    const s = draw([stale], percentageMode);
    const f = draw([{ ...fresh, charging: false }], percentageMode);
    assert.ok(maxInColumns(s.pixels, 0, G2_LENS_WIDTH) < maxInColumns(f.pixels, 0, G2_LENS_WIDTH), `dimmer, pm ${percentageMode}`);
    assert.ok(maxInColumns(s.pixels, 0, G2_LENS_WIDTH) > 0, `still drawn, pm ${percentageMode}`);
    // Stale + charging draws exactly what stale + not charging draws.
    assert.deepEqual(s.pixels, draw([staleOff], percentageMode).pixels, `pm ${percentageMode}`);
  }
});
