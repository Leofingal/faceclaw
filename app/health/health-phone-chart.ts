/**
 * The phone graph view's BITMAP, built without touching the phone.
 *
 * Same split, and for the same reason, as `health-glance.ts` is split out of
 * the glasses app: `health-view-model.ts` owns the store reads, the measured
 * box, the fold class and the `ImageSource` conversion - all NativeScript - and
 * hands this file a size, a font and some already-selected data. What comes
 * back is a `GrayImage`.
 *
 * The payoff is that `tools/health-preview.cjs` can render the phone chart at
 * any width under plain node, which is how the narrow/wide layouts get checked
 * without an emulator. It also means the chart the preview shows is built by
 * the same function the phone calls, not a reimplementation of it.
 */

import { GrayImage, type UiFont } from "../graphics/image";
import {
  drawMetricChart,
  drawNightTimeline,
  drawSleepLanes,
  drawSleepStackChart,
  INK,
  metricPlotRect,
  sleepStackPlotRect,
} from "./health-chart";
import type { RollupPoint, SampleMetric, SleepNight } from "./health-types";
import type { SleepStageName } from "./sleep-stages";
import type { NightTimeline } from "./health-night-timeline";

/**
 * What to draw. Three shapes, because the redesign gave sleep two charts of
 * its own that are not "a series of numbers over time":
 *
 *   - `metric`   the five measured types, banded or barred (unchanged)
 *   - `nights`   sleep over a week/month/quarter: the diverging stacked bar
 *   - `lanes`    sleep over ONE day: the four stage lanes, which is the same
 *                view the glasses drill-down shows, so the two surfaces agree
 *                about what "sleep, today" looks like
 *   - `timeline` sleep over ONE day on the phone since 2026-10-04: the same
 *                lanes in clock time, with awake gaps and no-data spans
 *                (`drawNightTimeline`). `lanes` stays for the glasses.
 */
export type PhoneChartContent =
  | {
      kind: "metric";
      metric: SampleMetric;
      points: readonly RollupPoint[];
      mode: "band" | "bars";
      xLabel: (point: RollupPoint, index: number) => string;
      labelThinning?: "step" | "collide";
    }
  | {
      kind: "nights";
      nights: readonly SleepNight[];
      xLabel: (night: SleepNight, index: number) => string;
    }
  | {
      kind: "lanes";
      bands: readonly { stage: SleepStageName | null; seconds: number }[];
      laneText: (stage: SleepStageName) => { label: string; value: string };
    }
  | {
      /** Sleep over ONE day, in clock time (2026-10-04). See `drawNightTimeline`. */
      kind: "timeline";
      timeline: NightTimeline;
    };

export type PhoneChartRequest = {
  /** Pixels, already scaled by RENDER_SCALE. */
  width: number;
  height: number;
  font: UiFont;
  content: PhoneChartContent;
};

/** The inset between the bitmap's edge and the plot. */
const INSET = 8;

export function renderPhoneChart(request: PhoneChartRequest): GrayImage {
  const { width, height, font, content } = request;
  const image = new GrayImage(width, height, INK.background);
  const rect = plotArea(width, height);

  switch (content.kind) {
    case "metric":
      drawMetricChart(image, rect, {
        metric: content.metric,
        points: content.points,
        font,
        mode: content.mode,
        xLabel: content.xLabel,
        labelThinning: content.labelThinning,
      });
      return image;
    case "nights":
      drawSleepStackChart(image, rect, {
        nights: content.nights,
        font,
        xLabel: content.xLabel,
      });
      return image;
    case "lanes":
      drawSleepLanes(image, rect, {
        bands: content.bands,
        font,
        laneText: content.laneText,
      });
      return image;
    case "timeline":
      drawNightTimeline(image, rect, { timeline: content.timeline, font });
      return image;
  }
}

function plotArea(width: number, height: number) {
  return {
    x: INSET,
    y: INSET,
    width: Math.max(8, width - INSET * 2),
    height: Math.max(8, height - INSET * 2),
  };
}

/** One tappable day of a multi-day chart, in bitmap pixels. */
export type ChartSlot = { startMs: number; x: number; width: number };

/**
 * Where each day sits on a multi-day chart, in the bitmap's own pixels, from
 * the same plot geometry the drawing used (`metricPlotRect`,
 * `sleepStackPlotRect`). The phone maps a tap to a day through this
 * (2026-10-04: tap a day in a week/month view to open its day view). Empty for
 * the one-day charts, which have no days to tap.
 */
export function phoneChartSlots(request: PhoneChartRequest): ChartSlot[] {
  const { width, height, font, content } = request;
  const rect = plotArea(width, height);
  if (content.kind === "metric") {
    const plot = metricPlotRect(rect, font);
    const slotWidth = plot.width / Math.max(1, content.points.length);
    return content.points.map((point, index) => ({
      startMs: point.startMs,
      x: plot.x + index * slotWidth,
      width: slotWidth,
    }));
  }
  if (content.kind === "nights") {
    const plot = sleepStackPlotRect(rect, font);
    const slotWidth = plot.width / Math.max(1, content.nights.length);
    return content.nights.map((night, index) => ({
      startMs: night.startMs,
      x: plot.x + index * slotWidth,
      width: slotWidth,
    }));
  }
  return [];
}

/** The slot under bitmap x, or null (the gutter, the margins, a one-day chart). */
export function slotAt(slots: readonly ChartSlot[], x: number): ChartSlot | null {
  return slots.find((slot) => x >= slot.x && x < slot.x + slot.width) ?? null;
}
