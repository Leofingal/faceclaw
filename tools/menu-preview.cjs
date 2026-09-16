#!/usr/bin/env node
/**
 * Render the Exocortex home screen's app run to a PNG, under plain node, with
 * no emulator.
 *
 * Same trick, and the same reasoning, as `tools/health-preview.cjs`: the app
 * run's drawing lives in `apps/exocortex/app-run.ts`, which imports nothing
 * from NativeScript, so this script calls the REAL paint function with
 * fixture entries and writes what comes back. The preview cannot drift from
 * the glasses, because it is not a second implementation of them.
 *
 * The one platform shim is the same one: `graphics/bdffont.ts` reads the
 * bundled .bdf through `knownFolders.currentApp()`, so that gets a node:fs
 * stub pointed at the same `app/fonts/` files the device loads.
 *
 * ⚠ FONT CAVEAT, unchanged from health-preview: the device's DEFAULT UI font
 * is Roboto-Light 14px, a TTF, and TTF rasterization happens in Java. Off
 * Android the shipping code falls back to the Terminus bitmap faces, which is
 * what these previews use — a real, user-selectable configuration, but not
 * the default. `--big` re-renders one bitmap size up (12 -> 16) to check the
 * layout survives the guaranteed small-font line-height band of 12..21.
 *
 * ## What it checks, beyond looking right
 *
 * 1. **Degrade to nothing.** The all-null menu is rendered twice — once from
 *    entries with no `statusLine` at all, once from entries whose
 *    `statusLine` returns null — and the two pixel buffers must be IDENTICAL.
 *    That is the property Chris's design turns on: an app with no data has a
 *    row that looks exactly as it did before this feature existed.
 * 2. **A provider that throws costs one status and nothing else.**
 * 3. **The known-good step count.** The Health row's number must equal the
 *    figure `health-glance.ts` draws on its overview page, computed from the
 *    same `dailySummary`. Both are printed.
 *
 * ## Use
 *
 *     npx tsc -p tests/tsconfig.json      # or: npm test
 *     node tools/menu-preview.cjs [--out DIR] [--big]
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

const { GrayImage } = require(path.join(BUILD, "graphics/image.js"));
const { getFont } = require(path.join(BUILD, "graphics/bdffont.js"));
const { drawAppRun, appRunVisibleRows } = require(path.join(BUILD, "apps/exocortex/app-run.js"));
const {
  formatGhostStatus,
  formatStepsStatus,
  formatWeatherStatus,
} = require(path.join(BUILD, "apps/exocortex/status-line.js"));
const { buildFixtures } = require(path.join(BUILD, "health/health-fixtures.js"));
const { dailySummary } = require(path.join(BUILD, "health/health-derive.js"));
const { DAY_MS, startOfLocalDay } = require(path.join(BUILD, "health/health-types.js"));
const UPNG = require("upng-js");

// --- arguments -------------------------------------------------------------
const args = process.argv.slice(2);
const big = args.includes("--big");
const outIndex = args.indexOf("--out");
const OUT = path.resolve(
  outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : path.join(ROOT, "preview", "menu"),
);
fs.mkdirSync(OUT, { recursive: true });

const font = getFont(big ? "terminus16" : "terminus12");

// The real glasses band. Chris's menu is left-justified and uses little of
// this width, which is the whole premise of the feature: the right-hand space
// is already free.
const WIDTH = 576;
const HEIGHT = 288;

// --- the known-good step count ---------------------------------------------
// A fixed clock so the preview is reproducible. Mid-afternoon, so "today so
// far" is a partial day like a real glance.
const NOW = new Date(2026, 8, 15, 15, 20, 0).getTime();
const TODAY = startOfLocalDay(NOW);
const fixtures = buildFixtures({ days: 10, nowMs: NOW, seed: 0x5eed });
const todaySamples = fixtures.samples.filter(
  (sample) => sample.startMs >= TODAY && sample.startMs < TODAY + DAY_MS,
);
const summary = dailySummary(todaySamples, fixtures.sleep, TODAY);
// What health-glance.ts draws on its overview page, character for character.
const glanceStepsText = summary.steps > 0 ? summary.steps.toLocaleString() : "--";
const menuStepsText = formatStepsStatus(summary.steps);

// --- the entries -----------------------------------------------------------
const WEATHER = {
  temperatureF: 72,
  description: "Sunny",
  precipitationPercent: 0,
  lastUpdatedMs: NOW - 20 * 60 * 1000,
};

function entries(statuses) {
  const of = (appId) => (statuses ? statuses[appId] : undefined);
  return [
    { appId: "exocortex", label: "Exocortex", icon: "bell", statusLine: of("exocortex") },
    { appId: "ghost", label: "Ghost", icon: "activity", statusLine: of("ghost") },
    { appId: "microphones", label: "Microphones", icon: "mic", statusLine: of("microphones") },
    { appId: "weather", label: "Weather", icon: "cloud-sun", statusLine: of("weather") },
    { appId: "health", label: "Health", icon: "activity", statusLine: of("health") },
    { appId: "news", label: "News", icon: "file-text", statusLine: of("news") },
    { appId: "calendar", label: "Calendar", icon: "calendar", statusLine: of("calendar") },
    { appId: "terminal", label: "Terminal", icon: "terminal", statusLine: of("terminal") },
  ];
}

const LIVE = {
  ghost: () => formatGhostStatus(NOW - 12 * 60 * 1000, NOW),
  weather: () => formatWeatherStatus(WEATHER, NOW),
  health: () => menuStepsText,
  // Everything else returns null today - and that is what the rows below show.
  news: () => null,
  calendar: () => null,
};

// --- render ----------------------------------------------------------------
const written = [];

function render(entryList, { selectedIndex = 0, focused = true } = {}) {
  const image = new GrayImage(WIDTH, HEIGHT, 0);
  drawAppRun(
    image,
    { width: WIDTH, height: HEIGHT, font },
    entryList,
    { selectedIndex, scrollRow: 0, focused },
  );
  return image;
}

function writePng(name, image) {
  const baked = image.withDrawsBaked();
  const rgba = new Uint8Array(baked.width * baked.height * 4);
  for (let i = 0; i < baked.pixels.length; i += 1) {
    const value = baked.pixels[i];
    rgba[i * 4] = value;
    rgba[i * 4 + 1] = value;
    rgba[i * 4 + 2] = value;
    rgba[i * 4 + 3] = 255;
  }
  const file = path.join(OUT, `${name}${big ? "-big" : ""}.png`);
  fs.writeFileSync(file, Buffer.from(UPNG.encode([rgba.buffer], baked.width, baked.height, 0)));

  // A blank canvas would otherwise be a silent pass, and a menu that drew
  // nothing is exactly the failure a preview is supposed to catch.
  let lit = 0;
  for (const value of baked.pixels) if (value > 0) lit += 1;
  const inkPercent = ((lit / baked.pixels.length) * 100).toFixed(1);
  written.push({ name: path.basename(file), size: `${baked.width}x${baked.height}`, ink: `${inkPercent}%` });
  if (lit === 0) console.error(`  !! ${file} is entirely blank`);
  return baked;
}

// 1. The menu as Chris will see it: three apps answering, the rest bare.
writePng("app-run-live", render(entries(LIVE), { selectedIndex: 4 }));

// 2. The same menu unfocused, so the highlight is an outline rather than a fill.
writePng("app-run-live-unfocused", render(entries(LIVE), { selectedIndex: 4, focused: false }));

// 3. The width limit, in its two distinct cases. Ghost carries a status far
//    too long for the row, so it truncates; the two long-named rows below it
//    keep EVERY character of their names and give up as much of their status
//    as the leftover space demands - the longer one losing it entirely.
const LONG = {
  ghost: () => "Chance Showers And Thunderstorms Then Patchy Fog After Midnight",
  weather: () => formatWeatherStatus({ ...WEATHER, description: "Chance Light Rain And Patchy Fog" }, NOW),
  health: () => menuStepsText,
};
const longEntries = entries(LONG);
longEntries[2] = {
  appId: "microphones",
  label: "Microphones, Subtitles and Translation, with the voice signature",
  icon: "mic",
  // Room for a truncated status remains after this name, so one is drawn.
  statusLine: () => "truncated, because this name still leaves room",
};
longEntries.splice(3, 0, {
  appId: "long-name",
  label: "An app whose name runs the entire width of the glasses display and then some more",
  icon: "file-text",
  // No room left at all: the status goes, the name keeps every character.
  statusLine: () => "dropped whole",
});
writePng("app-run-long", render(longEntries, { selectedIndex: 1 }));

// 4. A provider that throws costs one status and nothing else.
writePng(
  "app-run-throwing-provider",
  render(
    entries({
      ...LIVE,
      health: () => {
        throw new Error("provider blew up");
      },
    }),
    { selectedIndex: 4 },
  ),
);

// 5. DEGRADE TO NOTHING - the assertion this whole feature turns on.
const bareBaseline = writePng("app-run-no-status-feature", render(entries(null)));
const allNull = writePng(
  "app-run-all-null",
  render(entries({ ghost: () => null, weather: () => null, health: () => null })),
);

let identical = bareBaseline.pixels.length === allNull.pixels.length;
if (identical) {
  for (let i = 0; i < bareBaseline.pixels.length; i += 1) {
    if (bareBaseline.pixels[i] !== allNull.pixels[i]) {
      identical = false;
      break;
    }
  }
}

// --- report ----------------------------------------------------------------
console.log(`font: lineHeight ${font.lineHeight}, rows visible ${appRunVisibleRows(font, HEIGHT)}`);
console.log(`wrote ${written.length} PNGs to ${OUT}\n`);
for (const entry of written) {
  console.log(`  ${entry.name.padEnd(36)} ${entry.size.padEnd(10)} ink ${entry.ink}`);
}

console.log("\nknown-good assertions");
console.log(`  health-glance overview steps : ${glanceStepsText}`);
console.log(`  menu status line             : ${menuStepsText}`);
console.log(`  dailySummary().steps         : ${summary.steps}`);
console.log(`  degrade-to-nothing identical : ${identical}`);

let failed = false;
if (menuStepsText !== `${glanceStepsText} steps`) {
  console.error("  !! the menu row and the glance page disagree about today's steps");
  failed = true;
}
if (!identical) {
  console.error("  !! an all-null menu does NOT render identically to one with no status feature");
  failed = true;
}
process.exit(failed ? 1 : 0);
