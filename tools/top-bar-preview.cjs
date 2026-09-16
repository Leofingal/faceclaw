#!/usr/bin/env node
/**
 * Render the glasses top bar (clock, notification icons, Phone / G2 / Ring
 * batteries) to PNGs, under plain node, with no emulator.
 *
 * Same approach as `tools/health-preview.cjs`: the bar's drawing lives in
 * `ui/shell/top-bar.ts`, which imports nothing from NativeScript, so this
 * script calls the REAL `paintTopBar` with fixture inputs. The chrome layer on
 * the phone calls the same function; only its inputs (settings, the phone
 * battery, the notification icons) come from the device.
 *
 * The one platform shim is the usual one: `graphics/bdffont.ts` reads the .bdf
 * through `knownFolders.currentApp()`, stubbed here with node:fs.
 *
 * ⚠ FONT CAVEAT, as for the other previews: the device default UI font is
 * Roboto-Light 14px, rasterized in Java, so these use the Terminus bitmap
 * faces (small 12px, medium 16px; `--big` is small 16px, medium 24px).
 *
 * ## Display modes
 *
 * The bar is drawn at `windowTop(foreground height mode)`, from barLeft to
 * the right screen edge (ui/shell/chrome-layer.ts). Two numbers are mirrored
 * here because geometry.ts reads settings and can't load under node:
 *   - Band (576x288, the default), a min-height window, vertical position
 *     "middle" (the default): top = round((480 - 288) * 0.5) = 96.
 *   - Full panel (640x480): every window is max height, top = 0.
 *   - barLeft is 0 in both, because APP_SWITCHER_REMOVED is true. The
 *     switcher-era 576px bar (barLeft 64) is rendered too, as a fit check for
 *     the one-line reversal.
 *
 * ## What it checks
 *
 * 1. The bar's pixels are identical at both modes' positions (it only moves).
 * 2. No reading, and an unusable level (255), draw exactly what the bar drew
 *    before the ring existed: Phone and G2 only.
 * 3. A stale reading that says "charging" draws exactly the same as a stale
 *    one that doesn't: no charging mark on an old reading.
 * 4. Worst-case width (12h clock, three 100% batteries in percentage mode, a
 *    tray icon, the switcher-era 576px bar): the battery block stays clear of
 *    the clock, and the notification icon slots lost to the ring are counted.
 *
 * ## Use
 *
 *     npx tsc -p tests/tsconfig.json      # or: npm test
 *     node tools/top-bar-preview.cjs [--out DIR] [--big]
 */

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "app");
const BUILD = path.join(ROOT, ".test-build", "app");

// --- the one platform shim -------------------------------------------------
const nsCoreStub = {
  knownFolders: {
    currentApp: () => ({
      getFile: (relative) => ({
        readTextSync: () => fs.readFileSync(path.join(APP, relative), "utf8"),
      }),
    }),
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@nativescript/core") return nsCoreStub;
  return realLoad.apply(this, arguments);
};

if (!fs.existsSync(BUILD)) {
  console.error(`No ${path.relative(ROOT, BUILD)} - run: npx tsc -p tests/tsconfig.json`);
  process.exit(1);
}

const { GrayImage, G2_LENS_WIDTH, G2_LENS_HEIGHT } = require(path.join(BUILD, "graphics/image.js"));
const { getFont } = require(path.join(BUILD, "graphics/bdffont.js"));
const {
  NOTIFICATION_ICON_SIZE,
  TOP_BAR_HEIGHT,
  drawTopBarBatteries,
  paintTopBar,
  topBarBatteryItems,
} = require(path.join(BUILD, "ui/shell/top-bar.js"));
const UPNG = require("upng-js");

// --- arguments -------------------------------------------------------------
const args = process.argv.slice(2);
const big = args.includes("--big");
const outIndex = args.indexOf("--out");
const OUT = path.resolve(
  outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : path.join(ROOT, "preview", "top-bar"),
);
fs.mkdirSync(OUT, { recursive: true });

const smallFont = getFont(big ? "terminus16" : "terminus12");
const mediumFont = getFont(big ? "terminus24" : "terminus16");
const captionFont = getFont("terminus12");

const BAND_TOP = Math.round((G2_LENS_HEIGHT - 288) * 0.5);
const PANEL_TOP = 0;
const SWITCHER_ERA_LEFT = 64;

// --- fixtures ----------------------------------------------------------------
const NOW = new Date(2026, 8, 16, 14, 30, 0).getTime();
const MINUTE = 60 * 1000;
const CLOCK_24H = "Wed 16 Sep 14:30";
const CLOCK_WORST = "Wed 30 Sep 12:59 PM";

// The Java parse's output for the seat's known-good 00:01 payloads.
const RING = {
  none: null,
  off51: { level: 51, charging: false, atMs: NOW - 5 * MINUTE }, // 025233020100000000
  on49: { level: 49, charging: true, atMs: NOW - 30 * 1000 }, // d98531010000000000
  stale59: { level: 59, charging: false, atMs: NOW - 3 * 60 * MINUTE }, // feab3b020000000000, 3 h old
  stale59Charging: { level: 59, charging: true, atMs: NOW - 3 * 60 * MINUTE },
  unusable: { level: 255, charging: false, atMs: NOW - MINUTE },
  full: { level: 100, charging: true, atMs: NOW - MINUTE },
};
const PHONE = { battery: 83, charging: false };
const HEADSET = { headset: 64, headsetCharging: false };

/** A stand-in notification icon: an outlined 24px tile with a filled corner. */
function fakeIcon(size, seed) {
  const icon = new GrayImage(size, size, 0);
  icon.drawRoundedRect(1, 1, size - 2, size - 2, 170, 5);
  icon.fillRect(6, 6 + (seed % 3) * 3, size - 12, 4, 200);
  return icon;
}
const NOTIFICATIONS = Array.from({ length: 12 }, (_, i) => fakeIcon(NOTIFICATION_ICON_SIZE, i));
const TRAY = fakeIcon(18, 1);

// --- painting ----------------------------------------------------------------
function paintBar({ barTop, barLeft = 0, clock = CLOCK_24H, percentageMode, ring, phone = PHONE, headset = HEADSET, tray = [], notifications = 3 }) {
  const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
  let slots = 0;
  paintTopBar(image, {
    barLeft,
    barTop,
    clockText: clock,
    clockFont: mediumFont,
    batteryFont: smallFont,
    percentageMode,
    batteries: topBarBatteryItems(phone, { ...headset, ring }, NOW),
    trayIcons: tray,
    notificationIcons: (maxIcons) => {
      slots = maxIcons;
      return NOTIFICATIONS.slice(0, Math.min(maxIcons, notifications));
    },
  });
  return { image: image.withDrawsBaked(), slots };
}

function crop(image, top) {
  const out = new GrayImage(G2_LENS_WIDTH, TOP_BAR_HEIGHT, 0);
  out.bitBlt(image, 0, 0, { sy: top, height: TOP_BAR_HEIGHT });
  return out;
}

function samePixels(a, b) {
  if (a.pixels.length !== b.pixels.length) return false;
  for (let i = 0; i < a.pixels.length; i++) if (a.pixels[i] !== b.pixels[i]) return false;
  return true;
}

// --- output ----------------------------------------------------------------
const written = [];

function writePng(name, image, scale = 1) {
  const width = image.width * scale;
  const height = image.height * scale;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = image.pixels[((y / scale) | 0) * image.width + ((x / scale) | 0)];
      const i = (y * width + x) * 4;
      rgba[i] = value;
      rgba[i + 1] = value;
      rgba[i + 2] = value;
      rgba[i + 3] = 255;
    }
  }
  const file = path.join(OUT, `${name}${big ? "-big" : ""}.png`);
  fs.writeFileSync(file, Buffer.from(UPNG.encode([rgba.buffer], width, height, 0)));
  let lit = 0;
  for (const value of image.pixels) if (value > 0) lit += 1;
  written.push({ name: path.basename(file), size: `${width}x${height}` });
  if (lit === 0) console.error(`  !! ${file} is entirely blank`);
}

/** Bar crops stacked with a caption under each, at 2x. */
function sheet(rows) {
  const captionHeight = captionFont.lineHeight + 6;
  const rowHeight = TOP_BAR_HEIGHT + captionHeight + 6;
  const image = new GrayImage(G2_LENS_WIDTH, rows.length * rowHeight + 6, 0);
  rows.forEach((row, index) => {
    const y = 6 + index * rowHeight;
    image.bitBlt(row.bar, 0, y);
    image.drawText(captionFont, 10, y + TOP_BAR_HEIGHT + 3, row.caption, 110);
  });
  return image.withDrawsBaked();
}

// 1. The scenarios, painted at the band position.
const scenarios = [
  ["icon", false, "none", "no ring reading (today's bar)"],
  ["icon", false, "off51", "Ring 51, not charging (025233020100000000)"],
  ["icon", false, "on49", "Ring 49, charging (d98531010000000000)"],
  ["icon", false, "stale59", "Ring 59, 3 h old: stale (feab3b020000000000)"],
  ["pct", true, "none", "no ring reading (today's bar)"],
  ["pct", true, "off51", "Ring 51, not charging"],
  ["pct", true, "on49", "Ring 49, charging"],
  ["pct", true, "stale59", "Ring 59, 3 h old: stale"],
];
const rows = [];
let positionIdentical = true;
for (const [modeLabel, percentageMode, ringKey, caption] of scenarios) {
  const band = paintBar({ barTop: BAND_TOP, percentageMode, ring: RING[ringKey] });
  const panel = paintBar({ barTop: PANEL_TOP, percentageMode, ring: RING[ringKey] });
  const bandBar = crop(band.image, BAND_TOP);
  const panelBar = crop(panel.image, PANEL_TOP);
  if (!samePixels(bandBar, panelBar)) {
    positionIdentical = false;
    console.error(`  !! ${modeLabel}/${ringKey}: band and panel bars differ`);
  }
  rows.push({ bar: bandBar, caption: `${modeLabel === "icon" ? "icon" : "percentage"} | ${caption}` });
}

// 2. Worst-case width rows.
const worst = (ring, barLeft = 0) =>
  paintBar({
    barTop: PANEL_TOP,
    barLeft,
    clock: CLOCK_WORST,
    percentageMode: true,
    ring,
    phone: { battery: 100, charging: true },
    headset: { headset: 100, headsetCharging: true },
    tray: [TRAY],
    notifications: 12,
  });
const worstNoRing = worst(null);
const worstRing = worst(RING.full);
const worstRing576 = worst(RING.full, SWITCHER_ERA_LEFT);
rows.push({ bar: crop(worstRing.image, PANEL_TOP), caption: `worst case 640: 12h clock, 3x 100% charging, tray, 12 notifications -> ${worstRing.slots} icon slots` });
rows.push({ bar: crop(worstRing576.image, PANEL_TOP), caption: `worst case, switcher-era 576px bar -> ${worstRing576.slots} icon slots` });

const sheetImage = sheet(rows);
writePng("top-bar-sheet-2x", sheetImage, 2);

// 3. Whole-screen frames, one per display mode, with a faint outline of the
//    window band so the bar's position reads.
function frame(barTop, bandHeight, name) {
  const { image } = paintBar({ barTop, percentageMode: false, ring: RING.on49 });
  image.drawRect(0, barTop, G2_LENS_WIDTH, bandHeight, 40);
  image.drawText(captionFont, 10, barTop + TOP_BAR_HEIGHT + 8, `${name}: bar top ${barTop}, band ${bandHeight}px; Ring 49 charging`, 110);
  writePng(`frame-${name}`, image.withDrawsBaked());
}
frame(BAND_TOP, 288, "band-576x288");
frame(PANEL_TOP, G2_LENS_HEIGHT, "panel-640x480");

// --- checks ----------------------------------------------------------------
let failed = false;
function check(label, ok) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failed = true;
}

console.log(`fonts: small lineHeight ${smallFont.lineHeight}, medium lineHeight ${mediumFont.lineHeight}`);
console.log(`wrote ${written.length} PNGs to ${OUT}`);
for (const entry of written) console.log(`  ${entry.name.padEnd(34)} ${entry.size}`);
console.log("\nchecks");

check("every scenario's bar is pixel-identical at band (top 96) and panel (top 0)", positionIdentical);

for (const percentageMode of [false, true]) {
  const beforeRing = paintBar({ barTop: PANEL_TOP, percentageMode, ring: null }).image;
  const unusable = paintBar({ barTop: PANEL_TOP, percentageMode, ring: RING.unusable }).image;
  check(`${percentageMode ? "percentage" : "icon"}: an unusable level (255) draws exactly the no-reading bar`, samePixels(beforeRing, unusable));
  const staleCharging = paintBar({ barTop: PANEL_TOP, percentageMode, ring: RING.stale59Charging }).image;
  const staleOff = paintBar({ barTop: PANEL_TOP, percentageMode, ring: RING.stale59 }).image;
  check(`${percentageMode ? "percentage" : "icon"}: stale + charging draws exactly stale + not charging`, samePixels(staleCharging, staleOff));
}

for (const [label, barLeft] of [["640px bar", 0], ["switcher-era 576px bar", SWITCHER_ERA_LEFT]]) {
  const scratch = new GrayImage(G2_LENS_WIDTH, TOP_BAR_HEIGHT, 0);
  const items = topBarBatteryItems({ battery: 100, charging: true }, { headset: 100, headsetCharging: true, ring: RING.full }, NOW);
  const batteryLeft = drawTopBarBatteries(scratch, smallFont, items, 0, true);
  const clockRight = barLeft + 10 + mediumFont.measureText(CLOCK_WORST);
  const trayLeft = batteryLeft - (TRAY.width + 10);
  console.log(`  ..   ${label}: clock ends x=${clockRight}, tray starts x=${trayLeft}, batteries start x=${batteryLeft}`);
  check(`${label}: worst-case battery block + tray clear the clock with room for the 16px icon gap`, trayLeft - 8 >= clockRight + 16);
}
check(
  `worst case 640px: the ring costs ${worstNoRing.slots - worstRing.slots} notification icon slot(s) (${worstNoRing.slots} -> ${worstRing.slots}), and at least one remains`,
  worstRing.slots >= 1 && worstRing576.slots >= 1,
);

process.exit(failed ? 1 : 0);
