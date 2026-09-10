/**
 * HEALTH - the glasses status page.
 *
 * A daily-summary glance, in the shape a glance wants: two columns, everything
 * on one screen, nothing to scroll and nothing to navigate. Left is today so
 * far; right is last night. That split is the whole layout idea - the two
 * halves answer different questions ("how am I doing?" and "how did I sleep?")
 * and reading either one should not require having read the other.
 *
 * ⚠ LAYOUT IS A GUESS - Chris specified the CONTENT exactly (steps, SpO2
 * min/max/avg, heart rate min/max/avg, calories, last night's total and its
 * REM/deep/light percentages) and, for the look, only "the Even app wasn't bad
 * for this, I liked their summaries, but we can't copy it, we have to make our
 * own". So: the numbers are his; the two-column split, the min/avg/max triple
 * as one line each, and the hypnogram strip are mine.
 *
 * The one addition beyond the stated content is sleep efficiency - see
 * `SleepSummary.efficiencyPercent` in `health-derive.ts` for why that one and
 * not a "sleep quality score".
 *
 * Rendering runs through the same in-process-window path as Compass, which the
 * emulator dispatch already proved renders correctly with no hardware.
 */

import { getDefaultLargeFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { lineStep } from "../../ui/metrics";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import {
  dailySummary,
  formatDuration,
  hypnogram,
  rollupSeries,
  shortDate,
  type DailySummary,
} from "../../health/health-derive";
import {
  drawHypnogram,
  drawMetricChart,
  drawTextRight,
  hypnogramCaptionShort,
  INK,
  tripleText,
} from "../../health/health-chart";
import type { RollupPoint } from "../../health/health-types";
import { healthStore } from "../../health/health-store-files";
import { isFixtureData, seedFixturesIfNeeded } from "../../health/health-seed";
import { DAY_MS, startOfLocalDay } from "../../health/health-types";

export const HEALTH_WINDOW_ID = "health";
export const HEALTH_SURFACE_ID = "window:health";

/** Cheap enough to re-read on a timer; the store is a few hundred rows a day. */
const REFRESH_INTERVAL_MS = 60_000;

const MARGIN = 10;
const GUTTER = 14;
/** Below this the two columns stack instead. */
const TWO_COLUMN_MIN_WIDTH = 380;

class HealthLayer implements Layer {
  private summary: DailySummary | null = null;
  /** Today's heart rate, hour by hour - the trace under the left column. */
  private hourlyHeartRate: RollupPoint[] = [];
  private stageBands: { stage: ReturnType<typeof hypnogram>[number]["stage"]; seconds: number }[] = [];
  private fixture = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private removed = false;

  constructor(private readonly requestRender: () => void) {}

  start(): void {
    // Without hardware there is nothing to show; seeding makes the glance
    // demonstrable and stamps the marker that keeps it labelled as sample data.
    seedFixturesIfNeeded();
    this.reload();
    this.timer = setInterval(() => this.reload(), REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  onRemoved(): void {
    this.stop();
  }

  private reload(): void {
    if (this.removed) return;
    try {
      const store = healthStore();
      const today = startOfLocalDay(Date.now());
      const samples = store.samplesInRange(today, today + DAY_MS);
      const sessions = store.sleepSessions();
      this.summary = dailySummary(samples, sessions, today);
      this.hourlyHeartRate = rollupSeries(samples, {
        metric: "heartRate",
        granularity: "hour",
        startMs: today,
        endMs: today + DAY_MS,
      });
      const night = sessions.find((session) => session.dayStartMs === today);
      this.stageBands = night ? hypnogram(night) : [];
      this.fixture = isFixtureData();
    } catch (error) {
      console.warn("health glance reload failed", error);
    }
    this.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const large = getDefaultLargeFont();
    const step = lineStep(small);
    const summary = this.summary;

    // Header: what this is, and when.
    const dateText = shortDate(Date.now());
    image.drawText(small, MARGIN, MARGIN, "HEALTH", INK.title);
    drawTextRight(image, small, width - MARGIN, MARGIN, dateText, INK.label);
    const headerBottom = MARGIN + small.lineHeight + 3;
    image.drawLine(MARGIN, headerBottom, width - MARGIN, headerBottom, INK.axis);

    if (!summary) {
      image.drawText(small, MARGIN, headerBottom + step, "Waiting for ring data...", INK.dim);
      return image;
    }

    const twoColumn = width >= TWO_COLUMN_MIN_WIDTH;
    const columnWidth = twoColumn ? Math.floor((width - MARGIN * 2 - GUTTER) / 2) : width - MARGIN * 2;
    const leftX = MARGIN;
    const rightX = twoColumn ? MARGIN + columnWidth + GUTTER : MARGIN;
    let y = headerBottom + 6;

    const todayBottom = this.paintToday(image, summary, {
      x: leftX,
      y,
      width: columnWidth,
      height: height - y - MARGIN,
      small,
      large,
      step,
    });
    const nightTop = twoColumn ? y : todayBottom + 6;
    const nightBottom = this.paintLastNight(image, summary, {
      x: rightX,
      y: nightTop,
      width: columnWidth,
      height: height - nightTop - MARGIN,
      small,
      large,
      step,
    });

    if (twoColumn) {
      const divider = MARGIN + columnWidth + Math.floor(GUTTER / 2);
      image.drawLine(divider, headerBottom + 6, divider, height - MARGIN, INK.grid);
    }

    if (this.fixture) {
      const badge = "Sample data";
      const badgeY = height - small.lineHeight - 2;
      drawTextRight(image, small, width - MARGIN, badgeY, badge, INK.grid);
    }
    void todayBottom;
    void nightBottom;
    return image;
  }

  private paintToday(
    image: GrayImage,
    summary: DailySummary,
    layout: {
      x: number;
      y: number;
      width: number;
      height: number;
      small: ReturnType<typeof getDefaultSmallFont>;
      large: ReturnType<typeof getDefaultLargeFont>;
      step: number;
    },
  ): number {
    const { x, width, small, large, step } = layout;
    let y = layout.y;
    image.drawText(small, x, y, "TODAY", INK.label);
    y += step;

    // Steps get the large font: it is the number a glance is most often for.
    const stepsText = summary.steps > 0 ? summary.steps.toLocaleString() : "--";
    image.drawText(large, x, y, stepsText, INK.title);
    const stepsWidth = large.measureText(stepsText);
    image.drawText(small, x + stepsWidth + 6, y + large.lineHeight - small.lineHeight - 1, "steps", INK.label);
    y += large.lineHeight + 4;

    const caloriesText = summary.calories > 0 ? `${summary.calories.toLocaleString()} kcal` : "-- kcal";
    image.drawText(small, x, y, caloriesText, INK.bar);
    y += step + 4;

    // Whole numbers here: see `tripleText`'s `whole` option.
    y = this.paintTriple(image, x, y, width, "HR", tripleText(summary.heartRate, "heartRate", { whole: true }), "bpm", small, step);
    y = this.paintTriple(image, x, y, width, "SpO2", tripleText(summary.spo2, "spo2", { whole: true }), "%", small, step);

    image.drawText(small, x, y, "min / avg / max", INK.grid);
    y += step + 6;

    // The day's heart rate, hour by hour, in whatever room the readout left.
    // The glance is mostly numbers; one trace is what turns "74 bpm average"
    // into "and it happened in the afternoon", which is the question a glance
    // actually raises. Same renderer as the phone charts.
    const remaining = layout.y + layout.height - y;
    const traceHeight = Math.min(170, remaining - step - 4);
    if (traceHeight >= 44 && this.hourlyHeartRate.some((point) => point.count > 0)) {
      image.drawText(small, x, y, "Heart rate today", INK.label);
      y += step;
      drawMetricChart(
        image,
        { x, y, width, height: Math.min(traceHeight, layout.y + layout.height - y) },
        {
          metric: "heartRate",
          points: this.hourlyHeartRate,
          font: small,
          // Just format the hour - `drawMetricChart` already thins labels to
          // whatever the column width fits. Thinning here as well multiplies
          // the two and leaves a single label at midnight.
          xLabel: (point) => `${new Date(point.startMs).getHours()}`,
        },
      );
      y += traceHeight;
    }
    return y;
  }

  private paintTriple(
    image: GrayImage,
    x: number,
    y: number,
    width: number,
    label: string,
    value: string,
    unit: string,
    small: ReturnType<typeof getDefaultSmallFont>,
    step: number,
  ): number {
    image.drawText(small, x, y, label, INK.label);
    const unitWidth = unit ? small.measureText(unit) + 4 : 0;
    drawTextRight(image, small, x + width - unitWidth, y, value, INK.line);
    if (unit) drawTextRight(image, small, x + width, y, unit, INK.label);
    return y + step;
  }

  private paintLastNight(
    image: GrayImage,
    summary: DailySummary,
    layout: {
      x: number;
      y: number;
      width: number;
      height: number;
      small: ReturnType<typeof getDefaultSmallFont>;
      large: ReturnType<typeof getDefaultLargeFont>;
      step: number;
    },
  ): number {
    const { x, width, small, large, step } = layout;
    let y = layout.y;
    image.drawText(small, x, y, "LAST NIGHT", INK.label);
    y += step;

    const sleep = summary.sleep;
    if (!sleep) {
      image.drawText(small, x, y, "No sleep record", INK.dim);
      return y + step;
    }

    const totalText = formatDuration(sleep.totalSec);
    image.drawText(large, x, y, totalText, INK.title);
    y += large.lineHeight + 4;

    image.drawText(small, x, y, "Efficiency", INK.label);
    drawTextRight(image, small, x + width, y, `${Math.round(sleep.efficiencyPercent)}%`, INK.line);
    y += step + 3;

    // The three stage shares Chris named, as percentages of time asleep. These
    // come from the record's own named totals, so they are unaffected by the
    // unconfirmed stage-id mapping the strip below depends on.
    const rows: [string, number][] = [
      ["REM", sleep.remPercent],
      ["Deep", sleep.deepPercent],
      ["Light", sleep.lightPercent],
    ];
    for (const [label, percent] of rows) {
      image.drawText(small, x, y, label, INK.label);
      drawTextRight(image, small, x + width, y, `${Math.round(percent)}%`, INK.line);
      y += step;
    }

    if (this.stageBands.length > 0) {
      y += 8;
      const room = layout.height - (y - layout.y) - small.lineHeight - 6;
      const stripHeight = Math.max(8, Math.min(46, room));
      if (stripHeight >= 8) {
        image.drawText(small, x, y, "Through the night", INK.label);
        y += step;
        drawHypnogram(image, { x, y, width, height: stripHeight }, this.stageBands);
        y += stripHeight + 3;
        image.drawText(small, x, y, hypnogramCaptionShort(), INK.grid);
        y += step;
      }
    }
    return y;
  }

  // A glance has nothing to drill into yet - the graphs live on the phone, per
  // the spec. Swallowing input rather than leaving it unhandled keeps a stray
  // click from doing something surprising.
  handleInput(_event: InputEvent, _ctx: LayerContext): void {}
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
