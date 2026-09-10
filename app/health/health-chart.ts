/**
 * The chart renderer, shared by both surfaces.
 *
 * Both the glasses glance and the phone graphs draw into a `GrayImage`, and
 * the phone converts its one through `grayImageToPreviewSource()` - the same
 * already-shipping path the glasses mirror uses to put a rendered frame on the
 * phone screen. That is a deliberate reuse rather than a shortcut: it means
 * one drawing implementation covers both surfaces, no new native code exists
 * for the phone side, and the two screens cannot drift apart visually.
 *
 * ⚠ DESIGN CHOICE, not a spec (Chris said only "the Even app wasn't bad for
 * this, I liked their summaries, but we can't copy it, we have to make our
 * own"): the phone charts are MONOCHROME, because that is what
 * `PreviewBitmapUtil.fromGray` produces and adding colour would mean new
 * Kotlin. It lands somewhere deliberate rather than accidental - the phone
 * already shows the glasses' grey mirror, so the health screens read as part
 * of the same instrument - but colour is a real option later and would be a
 * contained change: a second bitmap builder plus a palette here.
 *
 * The greys below are a ramp, not arbitrary: background, grid, band, then the
 * data line at full brightness, so the eye lands on the measurement first.
 */

import { GrayImage } from "../graphics/image";
import { type UiFont } from "../graphics/image";
import {
  type RollupPoint,
  type SampleMetric,
  isCumulative,
} from "./health-types";
import { bandIsMeaningful, formatValue, primaryValue } from "./health-derive";
import { STAGE_MAPPING_CONFIRMED, type SleepStageName } from "./sleep-stages";

/** The grey ramp. Everything drawn here uses one of these. */
export const INK = {
  background: 0,
  grid: 42,
  axis: 70,
  band: 78,
  bar: 168,
  line: 246,
  label: 148,
  title: 255,
  dim: 108,
} as const;

export type ChartRect = { x: number; y: number; width: number; height: number };

export type ChartOptions = {
  /** Only used to pick the default mode and to read `avg` vs `sum`. */
  metric: SampleMetric;
  points: readonly RollupPoint[];
  font: UiFont;
  /** Formats a point's x-axis label; return "" to leave a tick unlabelled. */
  xLabel: (point: RollupPoint, index: number) => string;
  /**
   * `band` draws a min/max band with the average through it; `bars` draws a
   * column per bucket from zero. Defaults to bars for the cumulative metrics.
   * Sleep passes `bars` explicitly - a night's total is a total, not a
   * measurement with a spread.
   */
  mode?: "band" | "bars";
};

/**
 * A min/max band with the average tracked through it, or bars for the
 * cumulative metrics.
 *
 * Gaps are drawn as gaps. A ring is taken off to charge, so missing hours are
 * the normal case, not an edge case, and a line that joins across them claims
 * a continuity the data does not have.
 */
export function drawMetricChart(image: GrayImage, rect: ChartRect, options: ChartOptions): void {
  const { metric, points, font } = options;
  const labelWidth = 34;
  const labelHeight = font.lineHeight + 2;
  const plot: ChartRect = {
    x: rect.x + labelWidth,
    y: rect.y,
    width: Math.max(8, rect.width - labelWidth),
    height: Math.max(8, rect.height - labelHeight),
  };

  const withData = points.filter((point) => point.count > 0);
  if (withData.length === 0) {
    const message = "No data for this range";
    image.drawText(
      font,
      rect.x + Math.round((rect.width - font.measureText(message)) / 2),
      rect.y + Math.round(rect.height / 2) - font.lineHeight,
      message,
      INK.dim,
    );
    return;
  }

  const bars = options.mode ? options.mode === "bars" : isCumulative(metric);
  const scale = valueScale(withData, bars);
  const showBand = !bars && bandIsMeaningful(points);

  drawGrid(image, plot, scale, font, rect.x);

  const slotWidth = plot.width / points.length;
  const yFor = (value: number): number =>
    plot.y + plot.height - ((value - scale.low) / scale.span) * plot.height;

  if (bars) {
    const barWidth = Math.max(1, Math.floor(slotWidth * 0.62));
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      if (point.count === 0) continue;
      const top = yFor(point.sum);
      const left = Math.round(plot.x + index * slotWidth + (slotWidth - barWidth) / 2);
      const height = Math.max(1, Math.round(plot.y + plot.height - top));
      image.fillRect(left, Math.round(top), barWidth, height, INK.bar);
    }
  } else {
    if (showBand) {
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index]!;
        if (point.count === 0) continue;
        const left = Math.round(plot.x + index * slotWidth);
        const width = Math.max(1, Math.round(slotWidth));
        const top = Math.round(yFor(point.max));
        const bottom = Math.round(yFor(point.min));
        image.fillRect(left, top, width, Math.max(1, bottom - top), INK.band);
      }
    }
    // The average line, drawn only between adjacent points that both have
    // data, so a gap stays a gap.
    let previous: { x: number; y: number } | null = null;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      if (point.count === 0) {
        previous = null;
        continue;
      }
      const cx = plot.x + index * slotWidth + slotWidth / 2;
      const cy = yFor(primaryValue(point, metric));
      if (previous) image.drawLine(previous.x, previous.y, cx, cy, INK.line);
      else image.fillRect(Math.round(cx), Math.round(cy), 1, 1, INK.line);
      previous = { x: cx, y: cy };
    }
  }

  // X labels along the bottom, thinned so they never collide.
  const step = Math.max(1, Math.ceil(46 / Math.max(1, slotWidth)));
  const labelY = plot.y + plot.height + 2;
  for (let index = 0; index < points.length; index += step) {
    const text = options.xLabel(points[index]!, index);
    if (!text) continue;
    const cx = plot.x + index * slotWidth + slotWidth / 2;
    const x = Math.round(cx - font.measureText(text) / 2);
    if (x < rect.x || x + font.measureText(text) > rect.x + rect.width) continue;
    image.drawText(font, x, labelY, text, INK.label);
  }
}

type Scale = { low: number; high: number; span: number };

function valueScale(points: readonly RollupPoint[], bars: boolean): Scale {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const top = bars ? point.sum : point.max;
    const bottom = bars ? 0 : point.min;
    if (bottom < low) low = bottom;
    if (top > high) high = top;
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { low: 0, high: 1, span: 1 };
  if (bars) low = 0;
  if (high - low < 1) {
    // A flat series still needs somewhere to sit; centre it rather than
    // letting it collapse onto the axis.
    low -= 1;
    high += 1;
  }
  // Bars are measured from zero, so only the top gets breathing room - padding
  // the bottom too would put a negative tick under a count that cannot go
  // negative, and float the bars off their own baseline.
  const pad = (high - low) * 0.08;
  const scale = { low: bars ? low : low - pad, high: high + pad, span: 0 };
  scale.span = scale.high - scale.low || 1;
  return scale;
}

function drawGrid(
  image: GrayImage,
  plot: ChartRect,
  scale: Scale,
  font: UiFont,
  labelX: number,
): void {
  const lines = 3;
  for (let index = 0; index < lines; index += 1) {
    const fraction = index / (lines - 1);
    const value = scale.high - fraction * scale.span;
    const y = Math.round(plot.y + fraction * plot.height);
    image.drawLine(plot.x, y, plot.x + plot.width, y, INK.grid);
    const text = `${Math.round(value)}`;
    const textY = Math.min(
      plot.y + plot.height - font.lineHeight,
      Math.max(plot.y, y - Math.round(font.lineHeight / 2)),
    );
    image.drawText(font, labelX, textY, text, INK.label);
  }
  image.drawLine(plot.x, plot.y, plot.x, plot.y + plot.height, INK.axis);
}

// ===========================================================================
// Sleep

const STAGE_INK: Readonly<Record<SleepStageName, number>> = {
  wake: 62,
  rem: 196,
  light: 120,
  deep: 250,
};

/**
 * The night as a run of stage blocks.
 *
 * This is the ONE thing on either surface that depends on the raw stage-id
 * mapping, so while `STAGE_MAPPING_CONFIRMED` is false the caller is expected
 * to caption it as unconfirmed - `hypnogramCaption()` supplies the wording.
 */
export function drawHypnogram(
  image: GrayImage,
  rect: ChartRect,
  bands: readonly { stage: SleepStageName | null; seconds: number }[],
): void {
  let total = 0;
  for (const band of bands) total += band.seconds;
  if (total <= 0) return;
  let x = rect.x;
  for (const band of bands) {
    const width = (band.seconds / total) * rect.width;
    const drawn = Math.max(1, Math.round(width));
    // An unmapped stage id is drawn as a hatch-dim block rather than being
    // dropped: the time happened, we just cannot name it.
    const ink = band.stage ? STAGE_INK[band.stage] : INK.grid;
    image.fillRect(Math.round(x), rect.y, drawn, rect.height, ink);
    x += width;
  }
  image.drawRect(rect.x, rect.y, rect.width, rect.height, INK.axis);
}

export function hypnogramCaption(): string {
  return STAGE_MAPPING_CONFIRMED
    ? "Sleep stages through the night"
    : "Stage pattern - labels not yet confirmed on live data";
}

/** The same caption for the glasses, where the line is 300-odd pixels wide. */
export function hypnogramCaptionShort(): string {
  return STAGE_MAPPING_CONFIRMED ? "Stages through the night" : "Stages - labels unconfirmed";
}

// ===========================================================================
// Small shared pieces

/**
 * A "min / avg / max" readout, the shape both surfaces use for a metric.
 *
 * `whole` rounds all three. The glance passes it: an average heart rate
 * printed as 72.7 reads as precision the measurement does not have, and on a
 * screen you glance at rather than study, the tenth is noise. The phone's stat
 * panel keeps the decimal, where comparing two averages is the point.
 */
export function tripleText(
  summary: { min: number; max: number; avg: number; hasData: boolean },
  metric: SampleMetric,
  options?: { whole?: boolean },
): string {
  if (!summary.hasData) return "--";
  const show = (value: number): string =>
    options?.whole ? `${Math.round(value)}` : formatValue(value, metric);
  return `${show(summary.min)} / ${show(summary.avg)} / ${show(summary.max)}`;
}

/** A right-aligned draw, for readouts that should line up on their last digit. */
export function drawTextRight(
  image: GrayImage,
  font: UiFont,
  right: number,
  y: number,
  text: string,
  value: number,
): void {
  image.drawText(font, Math.round(right - font.measureText(text)), y, text, value);
}
