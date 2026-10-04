/**
 * HEALTH - the glasses status page.
 *
 * This file is now PLUMBING ONLY: the store reads, the refresh timer, the
 * scroll cursor, the window lifecycle. Every pixel is drawn by
 * `health/health-glance.ts`, which has no NativeScript imports and therefore
 * renders under plain node - see `tools/health-preview.cjs`, which produces a
 * PNG of each page below without an emulator. The first pass drew and plumbed
 * in one file and could only be looked at by booting an AVD; that is the
 * difference this split buys, and it is the reason to keep the two apart.
 *
 * ## The surface, after Chris's 2026-09-10 review
 *
 * The overview is a SUMMARY - text only, no charts - and scrolling walks a
 * cursor through a detail page per parameter, ending at sleep's own view.
 * `GLANCE_PAGES` in `health-glance.ts` is the page list, and the doc comment
 * there carries the reasoning for the carousel (including which parts of it are
 * interpretation rather than spec).
 */

import { getDefaultLargeFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import {
  assembleNight,
  dailySummary,
  hypnogram,
  RANGE_DAYS,
  rollupSeries,
  sleepNights,
  type DailySummary,
  type GapAwake,
  type RangeKey,
} from "../../health/health-derive";
import { ringCoverage } from "../../health/health-coverage";
import type { HealthStore } from "../../health/health-store";
import {
  drawGlancePage,
  GLANCE_PAGES,
  type GlanceData,
  type GlancePage,
} from "../../health/health-glance";
import { healthStore } from "../../health/health-store-files";
import { requestFreshPull, syncLiveRecords } from "../../health/health-live";
import { noteHealthSteps } from "../../health/health-status";
import { isFixtureData, seedFixturesIfNeeded } from "../../health/health-seed";
import {
  cycleGlassesRange,
  healthViewState,
  selectedDayMs,
  withMetric,
  type HealthViewChange,
} from "../../health/health-view-state";
import {
  addLocalDays,
  DAY_MS,
  HOUR_MS,
  SAMPLE_METRICS,
  startOfLocalDay,
  type RollupPoint,
  type SampleMetric,
  type SeriesMetric,
  type SleepNight,
} from "../../health/health-types";

export const HEALTH_WINDOW_ID = "health";
export const HEALTH_SURFACE_ID = "window:health";

/** Cheap enough to re-read on a timer; the store is a few hundred rows a day. */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * The page that shows a phone metric. The phone's metrics are the glasses'
 * detail pages less calories (no phone chart) plus sleep.
 */
function pageIndexForMetric(metric: SeriesMetric): number {
  return GLANCE_PAGES.findIndex((page) =>
    metric === "sleep" ? page.kind === "sleep" : page.kind === "metric" && page.metric === metric,
  );
}

/** The phone metric a page shows, or null (the overview, calories). */
function metricForPage(page: GlancePage | undefined): SeriesMetric | null {
  if (!page) return null;
  if (page.kind === "sleep") return "sleep";
  if (page.kind === "metric" && page.metric !== "calories") return page.metric;
  return null;
}

/**
 * Exported for tests only (2026-10-04): the shared-state test drives this
 * layer and the phone's HealthViewModel against one store.
 */
/** Ring-data seconds in a gap, for the sleep days `firstDayMs`..`lastDayMs`. */
function gapAwake(store: HealthStore, firstDayMs: number, lastDayMs: number): GapAwake {
  const coverage = ringCoverage(
    store.samplesInRange(addLocalDays(firstDayMs, -1) - HOUR_MS, addLocalDays(lastDayMs, 1)),
  );
  return (startMs, endMs) => coverage.secondsIn(startMs, endMs);
}

export class HealthLayer implements Layer {
  private summary: DailySummary | null = null;
  private todaySummary: DailySummary | null = null;
  /** The selected day by hour, per metric - what the drill-down pages plot. */
  private hourly: Partial<Record<SampleMetric, RollupPoint[]>> = {};
  private stageBands: GlanceData["stageBands"] = [];
  /** Per-day points / per-night totals over the range, when it is not "day". */
  private daily: Partial<Record<SampleMetric, RollupPoint[]>> = {};
  private nights: SleepNight[] = [];
  private range: RangeKey = "day";
  private dayMs = 0;
  private fixture = false;
  /** Index into GLANCE_PAGES. 0 is the overview. */
  private pageIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private removed = false;
  private unsubscribeState: (() => void) | null = null;

  constructor(private readonly requestRender: () => void) {}

  /** The page the cursor is on. */
  get currentPage(): GlancePage {
    return GLANCE_PAGES[this.pageIndex] ?? GLANCE_PAGES[0]!;
  }

  /** What `paint` will plot: the shared range, and the day resolved. */
  get plotted(): { range: RangeKey; dayMs: number } {
    return { range: this.range, dayMs: this.dayMs };
  }

  start(): void {
    // The phone moves the glasses (design rule 1, both ways, 2026-10-04):
    // a change made on the phone brings the cursor to that metric's page and
    // redraws; a change made here only redraws.
    this.unsubscribeState = healthViewState.subscribe((change) => this.onStateChange(change));
    // Live data first: if the ring has been pulled this session, this stores it
    // and wipes any fixtures out of the way. Only if that leaves us with
    // nothing does seeding fill the screen, and seeding refuses outright once
    // real data has ever landed.
    syncLiveRecords();
    // Ask for something current rather than showing whatever the last
    // automatic 30-minute pull happened to catch. Returns immediately; the
    // pull takes ~15s and lands via the refresh tick below.
    requestFreshPull("health-open");
    seedFixturesIfNeeded();
    this.reload();
    this.timer = setInterval(() => this.reload(), REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
  }

  private onStateChange(change: HealthViewChange): void {
    if (this.removed) return;
    if (change.source === "phone") {
      const index = pageIndexForMetric(change.state.metric);
      if (index >= 0) this.pageIndex = index;
    }
    this.reload();
  }

  onRemoved(): void {
    this.stop();
  }

  private reload(): void {
    if (this.removed) return;
    // Cheap on every tick: a no-op when the communicator has nothing new, and
    // the store dedupes when it does, so a 30-minute pull shows up here within
    // one refresh instead of waiting for the app to be reopened.
    syncLiveRecords();
    try {
      const store = healthStore();
      const today = startOfLocalDay(Date.now());
      const state = healthViewState.get();
      // The overview is always TODAY's glance; the detail pages plot the
      // shared day and range (the phone may have stepped to another day).
      const day = selectedDayMs(state, today);
      this.range = state.range;
      this.dayMs = day;
      const sessions = store.sleepSessions();
      const todaySamples = store.samplesInRange(today, addLocalDays(today, 1));
      // A gap between sleep blocks is awake only where the ring has data
      // (health-derive rule 4): coverage from the samples around the night.
      const todaySummary = dailySummary(todaySamples, sessions, today, gapAwake(store, today, today));
      // Chris asked for the menu's step count to update "every 30 minutes, or
      // when you go into the health app view". This is that second case — and
      // it hands over the exact figure this page is about to draw, so the row
      // and the glance can never disagree about today's steps.
      noteHealthSteps(today, todaySummary.steps);
      this.todaySummary = todaySummary;
      const samples = day === today ? todaySamples : store.samplesInRange(day, addLocalDays(day, 1));
      this.summary = day === today ? todaySummary : dailySummary(samples, sessions, day, gapAwake(store, day, day));
      // One pass per metric over a day's samples - a few hundred rows, and the
      // drill-down has to be instant when the cursor lands on it.
      const hourly: Partial<Record<SampleMetric, RollupPoint[]>> = {};
      for (const metric of SAMPLE_METRICS) {
        hourly[metric] = rollupSeries(samples, {
          metric,
          granularity: "hour",
          startMs: day,
          endMs: addLocalDays(day, 1),
        });
      }
      this.hourly = hourly;
      // The whole night - every block, gaps as wake - not one stored session.
      const night = assembleNight(sessions, day, gapAwake(store, day, day));
      this.stageBands = night ? hypnogram(night) : [];
      // Week / month: one point per day ending today, from the rollup cache,
      // the same window the phone's multi-day views use.
      this.daily = {};
      this.nights = [];
      if (state.range !== "day") {
        const startMs = addLocalDays(today, -(RANGE_DAYS[state.range] - 1));
        const endMs = addLocalDays(today, 1);
        for (const metric of SAMPLE_METRICS) {
          const rollups = store.dailyRollups(metric, startMs, endMs);
          const points: RollupPoint[] = [];
          for (let cursor = startMs; cursor < endMs; cursor = addLocalDays(cursor, 1)) {
            const entry = rollups.get(cursor);
            points.push({
              startMs: cursor,
              spanMs: DAY_MS,
              min: entry?.min ?? 0,
              max: entry?.max ?? 0,
              avg: entry?.avg ?? 0,
              sum: entry?.sum ?? 0,
              count: entry?.count ?? 0,
            });
          }
          this.daily[metric] = points;
        }
        this.nights = sleepNights(sessions, startMs, endMs, gapAwake(store, startMs, today));
      }
      this.fixture = isFixtureData();
    } catch (error) {
      console.warn("health glance reload failed", error);
    }
    this.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    drawGlancePage(
      image,
      { width, height },
      { small: getDefaultSmallFont(), large: getDefaultLargeFont() },
      GLANCE_PAGES[this.pageIndex] ?? GLANCE_PAGES[0]!,
      {
        // The overview is today's glance even when the detail pages show another day.
        summary: this.currentPage.kind === "overview" ? this.todaySummary : this.summary,
        hourly: this.hourly,
        stageBands: this.stageBands,
        nowMs: Date.now(),
        fixture: this.fixture,
        range: this.range,
        dayMs: this.dayMs,
        daily: this.daily,
        nights: this.nights,
      },
    );
    return image;
  }

  /**
   * Scrolling moves between the overview and the per-parameter detail pages.
   *
   * The cursor WRAPS. With seven pages and no back gesture available
   * (`YieldAtRootLayer` takes double-click for back-out-to-home), wrapping is
   * what guarantees the overview is always reachable by holding one direction -
   * a user who has scrolled to the end never has to work out which way is back.
   * On the overview a click advances too; on a plot it cycles the range.
   */
  handleInput(event: InputEvent, _ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-down":
        this.movePage(1);
        return;
      case "click":
        // ⚠ CHANGED 2026-10-04 (Chris 2026-10-01): on a plot, a click cycles
        // its range day -> week -> month through the shared state, so the
        // phone follows. The overview has no plot, so there a click still
        // advances, as it always did.
        if (this.currentPage.kind === "overview") this.movePage(1);
        else healthViewState.set(cycleGlassesRange(healthViewState.get()), "glasses");
        return;
      case "scroll-up":
        this.movePage(-1);
        return;
      default:
        return;
    }
  }

  private movePage(delta: number): void {
    const count = GLANCE_PAGES.length;
    this.pageIndex = (this.pageIndex + delta + count) % count;
    // Scrolling onto a phone metric's page moves the phone to it too. The
    // overview and calories have no phone chart, and leave the phone alone.
    const metric = metricForPage(this.currentPage);
    if (metric) healthViewState.set(withMetric(healthViewState.get(), metric), "glasses");
    this.requestRender();
  }
}

export function createHealthAppWindow(options: InProcessAppOptions): InProcessWindow {
  let requestRender = () => {};
  const layer = new HealthLayer(() => requestRender());
  const app = createInProcessWindow({
    appId: "health",
    windowId: HEALTH_WINDOW_ID,
    title: "Health",
    iconLetter: "H",
    icon: "activity",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.stop();
      options.onClosed();
    },
  });
  requestRender = app.requestRender;
  layer.start();
  return app;
}
