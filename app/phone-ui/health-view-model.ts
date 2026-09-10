/**
 * HEALTH - the phone view model.
 *
 * Graphs of min/max/average for each of the five measured types, selectable by
 * hour and by day, over history the store keeps for as long as the phone does.
 *
 * ## The chart is a bitmap, and that is a decision
 *
 * The chart is drawn into a `GrayImage` by `health/health-chart.ts` and handed
 * to `<Image>` through `grayImageToPreviewSource()` - the same already-shipping
 * path that puts the glasses mirror on the phone screen. So the phone and the
 * glasses share one chart implementation, and the phone side needed no new
 * native code. The cost is that the chart has to be RE-RENDERED at the new
 * pixel width whenever the layout changes, rather than reflowing by itself:
 * `refreshLayout()` is what does that, and it is wired to the orientation
 * event and to the fold-state listener.
 *
 * ## Responsive behaviour
 *
 * `native/fold-state.ts` already answers "cover screen or inner screen?" for
 * the whole companion (Jetpack WindowManager underneath, 600dp breakpoint),
 * so this page asks it rather than inventing a second rule. Compact stacks the
 * chart over the readout; expanded puts them side by side and gives the chart
 * more height.
 *
 * The page also prints its own layout inputs on screen (`layoutMeta`). That is
 * deliberate and worth keeping: the Fold-7 responsive question has been open
 * since the emulator dispatch, and a screenshot that shows the width, the
 * posture and the resulting class is evidence, where a screenshot that just
 * looks right is an assertion.
 */

import { Observable, Screen } from "@nativescript/core";
import type { EventData, ImageSource, View } from "@nativescript/core";

import { GrayImage } from "../graphics/image";
import { getDefaultSmallFont } from "../graphics/ui-fonts";
import { grayImageToPreviewSource } from "../native/gray-image-preview";
import {
  displayClass,
  foldSnapshot,
  onFoldStateChanged,
  refreshFoldTracking,
  type CompanionDisplayClass,
} from "../native/fold-state";
import { drawHypnogram, drawMetricChart, hypnogramCaption, INK } from "../health/health-chart";
import {
  RANGE_DAYS,
  RANGE_LABELS,
  type Granularity,
  type RangeKey,
  formatDuration,
  formatValue,
  hypnogram,
  shortWeekday,
  rollupSeries,
  sleepSummary,
} from "../health/health-derive";
import { healthStore } from "../health/health-store-files";
import { isFixtureData, seedFixturesIfNeeded } from "../health/health-seed";
import {
  DAY_MS,
  METRIC_LABELS,
  METRIC_UNITS,
  type RollupPoint,
  type SampleMetric,
  type SeriesMetric,
  startOfLocalDay,
} from "../health/health-types";

const METRIC_ORDER: readonly SeriesMetric[] = ["heartRate", "spo2", "hrv", "steps", "sleep"];
const RANGE_ORDER: readonly RangeKey[] = ["day", "week", "month", "quarter"];

/** Chart height in DIPs, per display class. */
const CHART_HEIGHT_COMPACT = 190;
const CHART_HEIGHT_EXPANDED = 260;
/**
 * Android's compact/medium boundary, and the same number `fold-state.ts` uses.
 * Below this the side-by-side layout's fixed readout column leaves the chart
 * too little room to be worth drawing. See `isCompact`.
 */
const WIDE_LAYOUT_MIN_WIDTH_DP = 600;
/** Render at 2x DIPs so the bitmap stays crisp when the Image scales it. */
const RENDER_SCALE = 2;
const MAX_RENDER_WIDTH = 2200;

/**
 * A selector chip. `onTap` lives on the row rather than on the model because
 * a `Repeater` item template binds to the ITEM, not to the page's binding
 * context - the same shape `active-apps-page.xml`'s rows already use.
 */
type ChipRow = {
  label: string;
  key: string;
  isSelected: boolean;
  chipClass: string;
  onTap: () => void;
};
type StatRow = { label: string; value: string };

export class HealthViewModel extends Observable {
  private metric: SeriesMetric = "heartRate";
  private range: RangeKey = "day";
  private displayClassValue: CompanionDisplayClass = "expanded";
  private unsubscribeFold: (() => void) | null = null;
  private chart: ImageSource | null = null;
  /** The chart Image's measured box in DIPs; see `onChartLayoutChanged`. */
  private chartBoxDips: { width: number; height: number } | null = null;
  private stats: StatRow[] = [];
  private fixture = false;
  private sleepCaption = "";

  attach(): void {
    seedFixturesIfNeeded();
    refreshFoldTracking();
    this.displayClassValue = displayClass(foldSnapshot());
    this.unsubscribeFold = onFoldStateChanged((snapshot) => {
      const next = displayClass(snapshot);
      const changed = next !== this.displayClassValue;
      this.displayClassValue = next;
      if (changed) this.notifyLayout();
      this.notifyPropertyChange("layoutMeta", this.layoutMeta);
      this.rebuild();
    });
    this.fixture = isFixtureData();
    this.rebuild();
  }

  dispose(): void {
    this.unsubscribeFold?.();
    this.unsubscribeFold = null;
  }

  // -------------------------------------------------------------------------
  // Selection

  get metricChips(): ChipRow[] {
    return METRIC_ORDER.map((key) =>
      this.chip(key, METRIC_LABELS[key], key === this.metric, () => this.selectMetric(key)),
    );
  }

  get rangeChips(): ChipRow[] {
    // By-hour only means something inside a single day; the other three ranges
    // are by-day. So the range control doubles as the granularity control, and
    // there is no second toggle to get out of step with it.
    return RANGE_ORDER.map((key) =>
      this.chip(key, RANGE_LABELS[key], key === this.range, () => this.selectRange(key)),
    );
  }

  private chip(key: string, label: string, isSelected: boolean, onTap: () => void): ChipRow {
    return {
      key,
      label,
      isSelected,
      chipClass: isSelected ? "health-chip health-chip-on" : "health-chip",
      onTap,
    };
  }

  private selectMetric(key: SeriesMetric): void {
    if (key === this.metric) return;
    this.metric = key;
    this.notifyPropertyChange("metricChips", this.metricChips);
    this.rebuild();
  }

  private selectRange(key: RangeKey): void {
    if (key === this.range) return;
    this.range = key;
    this.notifyPropertyChange("rangeChips", this.rangeChips);
    this.rebuild();
  }

  // -------------------------------------------------------------------------
  // Layout

  /**
   * Compact when the Fold is SHUT, or when the window is simply too narrow for
   * the side column - and the second half of that is not redundant.
   *
   * `fold-state.ts` answers "cover screen or inner screen?", and it refuses on
   * purpose to call a non-folding phone compact however narrow it is: width
   * alone would demote every ordinary phone to the cover-screen COMPANION,
   * which is a different product decision. That rule is right for main-page,
   * which is choosing between three whole bodies.
   *
   * It is not sufficient here, because a chart is not a product surface - it
   * is a box that either fits or does not. On a 411dp window the expanded
   * layout's fixed 300dp readout column leaves about a hundred points for the
   * chart, whatever the hinge situation is. So this page takes the fold class
   * OR the measured width, and the width test is what makes it correct on an
   * ordinary narrow phone and in a small multi-window pane, neither of which
   * has a hinge to report.
   *
   * The breakpoint is Android's own compact/medium boundary, the same 600dp
   * `fold-state.ts` uses, so the two signals cannot disagree about the Fold
   * itself - only add to each other elsewhere.
   */
  get isCompact(): boolean {
    if (this.displayClassValue === "compact") return true;
    return Screen.mainScreen.widthDIPs < WIDE_LAYOUT_MIN_WIDTH_DP;
  }

  get compactVisibility(): "visible" | "collapse" {
    return this.isCompact ? "visible" : "collapse";
  }

  get expandedVisibility(): "visible" | "collapse" {
    return this.isCompact ? "collapse" : "visible";
  }

  get chartHeight(): number {
    return this.isCompact ? CHART_HEIGHT_COMPACT : CHART_HEIGHT_EXPANDED;
  }

  /**
   * The layout inputs, printed on screen. See the header - this exists so a
   * screenshot is evidence about the fold question rather than a claim.
   */
  get layoutMeta(): string {
    const snapshot = foldSnapshot();
    const screen = `${Math.round(Screen.mainScreen.widthDIPs)}x${Math.round(
      Screen.mainScreen.heightDIPs,
    )}dp`;
    const window =
      snapshot.widthDp > 0 ? `${snapshot.widthDp}x${snapshot.heightDp}dp` : "no reading";
    // Both inputs, then the decision, so a screenshot says WHY it laid out the
    // way it did - not just that it did.
    return (
      `layout ${this.isCompact ? "COMPACT" : "EXPANDED"} · fold-class ${this.displayClassValue}` +
      ` · screen ${screen} · window ${window} · posture ${snapshot.posture}` +
      `${snapshot.isFoldable ? " · foldable" : " · not foldable"}${snapshot.hasHinge ? " · hinge" : ""}`
    );
  }

  /** Called from the page on orientation change and on load. */
  refreshLayout(): void {
    this.displayClassValue = displayClass(foldSnapshot());
    // The box is about to change shape; drop the stale measurement so the
    // next render uses the estimate rather than the old screen's width, and
    // the Image's own layoutChanged then corrects it.
    this.chartBoxDips = null;
    this.notifyLayout();
    this.rebuild();
  }

  private notifyLayout(): void {
    this.notifyPropertyChange("isCompact", this.isCompact);
    this.notifyPropertyChange("compactVisibility", this.compactVisibility);
    this.notifyPropertyChange("expandedVisibility", this.expandedVisibility);
    this.notifyPropertyChange("chartHeight", this.chartHeight);
    this.notifyPropertyChange("layoutMeta", this.layoutMeta);
  }

  // -------------------------------------------------------------------------
  // Output

  get chartImage(): ImageSource | null {
    return this.chart;
  }

  get statRows(): StatRow[] {
    return this.stats;
  }

  get headline(): string {
    return METRIC_LABELS[this.metric];
  }

  get subhead(): string {
    const unit = METRIC_UNITS[this.metric];
    const grain = this.granularity() === "hour" ? "by hour" : "by day";
    return unit ? `${grain} · ${unit}` : grain;
  }

  get sampleBadgeVisibility(): "visible" | "collapse" {
    return this.fixture ? "visible" : "collapse";
  }

  get sleepCaptionText(): string {
    return this.sleepCaption;
  }

  get sleepCaptionVisibility(): "visible" | "collapse" {
    return this.sleepCaption ? "visible" : "collapse";
  }

  private granularity(): Granularity {
    return this.range === "day" ? "hour" : "day";
  }

  // -------------------------------------------------------------------------
  // Building the chart

  private rebuild(): void {
    try {
      this.fixture = isFixtureData();
      const { points, mode, stats, caption } = this.buildSeries();
      this.stats = stats;
      this.sleepCaption = caption;
      this.chart = this.renderChart(points, mode);
    } catch (error) {
      console.warn("health chart build failed", error);
      this.chart = null;
      this.stats = [{ label: "Error", value: "could not build chart" }];
    }
    this.notifyPropertyChange("chartImage", this.chartImage);
    this.notifyPropertyChange("statRows", this.statRows);
    this.notifyPropertyChange("headline", this.headline);
    this.notifyPropertyChange("subhead", this.subhead);
    this.notifyPropertyChange("sampleBadgeVisibility", this.sampleBadgeVisibility);
    this.notifyPropertyChange("sleepCaptionText", this.sleepCaptionText);
    this.notifyPropertyChange("sleepCaptionVisibility", this.sleepCaptionVisibility);
  }

  private windowMs(): { startMs: number; endMs: number } {
    const days = RANGE_DAYS[this.range];
    const today = startOfLocalDay(Date.now());
    return { startMs: today - (days - 1) * DAY_MS, endMs: today + DAY_MS };
  }

  private buildSeries(): {
    points: RollupPoint[];
    mode: "band" | "bars";
    stats: StatRow[];
    caption: string;
  } {
    const { startMs, endMs } = this.windowMs();
    if (this.metric === "sleep") return this.buildSleepSeries(startMs, endMs);

    const metric = this.metric as SampleMetric;
    const store = healthStore();
    const granularity = this.granularity();
    let points: RollupPoint[];

    if (granularity === "day") {
      // Long ranges come from the derived daily-rollup cache, so a quarter-long
      // chart never opens a sample shard. See health-store.ts.
      const rollups = store.dailyRollups(metric, startMs, endMs);
      points = [];
      let cursor = startOfLocalDay(startMs);
      while (cursor < endMs) {
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
        const next = new Date(cursor);
        next.setDate(next.getDate() + 1);
        cursor = next.getTime();
      }
    } else {
      points = rollupSeries(store.samplesInRange(startMs, endMs), {
        metric,
        granularity,
        startMs,
        endMs,
      });
    }

    return {
      points,
      mode: metric === "steps" || metric === "calories" ? "bars" : "band",
      stats: this.summariseSeries(points, metric),
      caption: "",
    };
  }

  private buildSleepSeries(
    startMs: number,
    endMs: number,
  ): { points: RollupPoint[]; mode: "band" | "bars"; stats: StatRow[]; caption: string } {
    const sessions = healthStore()
      .sleepSessions()
      .filter((session) => session.dayStartMs >= startMs && session.dayStartMs < endMs);
    const byDay = new Map<number, number>();
    for (const session of sessions) {
      byDay.set(session.dayStartMs, (byDay.get(session.dayStartMs) ?? 0) + session.totalSec);
    }
    const points: RollupPoint[] = [];
    let cursor = startOfLocalDay(startMs);
    while (cursor < endMs) {
      const seconds = byDay.get(cursor);
      const hours = seconds !== undefined ? seconds / 3600 : 0;
      points.push({
        startMs: cursor,
        spanMs: DAY_MS,
        min: hours,
        max: hours,
        avg: hours,
        sum: hours,
        count: seconds === undefined ? 0 : 1,
      });
      const next = new Date(cursor);
      next.setDate(next.getDate() + 1);
      cursor = next.getTime();
    }

    const nights = points.filter((point) => point.count > 0).map((point) => point.sum);
    const latest = sessions.sort((a, b) => b.dayStartMs - a.dayStartMs)[0];
    const stats: StatRow[] = [];
    if (nights.length > 0) {
      const total = nights.reduce((sum, value) => sum + value, 0);
      stats.push({ label: "Shortest", value: formatDuration(Math.min(...nights) * 3600) });
      stats.push({ label: "Average", value: formatDuration((total / nights.length) * 3600) });
      stats.push({ label: "Longest", value: formatDuration(Math.max(...nights) * 3600) });
      stats.push({ label: "Nights", value: `${nights.length}` });
    }
    if (latest) {
      const summary = sleepSummary(latest);
      stats.push({ label: "Latest efficiency", value: `${Math.round(summary.efficiencyPercent)}%` });
      stats.push({
        label: "Latest REM / deep / light",
        value: `${Math.round(summary.remPercent)}% / ${Math.round(
          summary.deepPercent,
        )}% / ${Math.round(summary.lightPercent)}%`,
      });
      if (!summary.timeResolved) {
        stats.push({ label: "Session time", value: "not anchored to wall clock" });
      }
    }
    return { points, mode: "bars", stats, caption: latest ? hypnogramCaption() : "" };
  }

  private summariseSeries(points: readonly RollupPoint[], metric: SampleMetric): StatRow[] {
    const withData = points.filter((point) => point.count > 0);
    if (withData.length === 0) return [{ label: "No data", value: "for this range" }];
    if (metric === "steps" || metric === "calories") {
      const totals = withData.map((point) => point.sum);
      const total = totals.reduce((sum, value) => sum + value, 0);
      return [
        { label: "Total", value: formatValue(total, metric) },
        { label: "Best bucket", value: formatValue(Math.max(...totals), metric) },
        { label: "Average", value: formatValue(total / totals.length, metric) },
        { label: "Buckets", value: `${withData.length}` },
      ];
    }
    const min = Math.min(...withData.map((point) => point.min));
    const max = Math.max(...withData.map((point) => point.max));
    const avg =
      withData.reduce((sum, point) => sum + point.avg, 0) / Math.max(1, withData.length);
    return [
      { label: "Minimum", value: formatValue(min, metric) },
      { label: "Average", value: formatValue(avg, metric) },
      { label: "Maximum", value: formatValue(max, metric) },
      { label: "Buckets", value: `${withData.length}` },
    ];
  }

  /**
   * The chart's real on-screen box, reported by the `<Image>` itself.
   *
   * Rendering at a GUESSED width is what letterboxes the bitmap: `aspectFit`
   * keeps the bitmap's own proportions, so any mismatch between the rendered
   * aspect and the box's shows up as black bars down the sides. Guessing was
   * also fragile for a second reason - the expanded layout's chart column is a
   * star-sized cell whose width depends on padding and margins this model does
   * not know. Measuring removes both problems and makes the chart correct in
   * a split-screen pane as well, which no arithmetic here would have covered.
   *
   * No render loop: the Image has an explicit height and a width driven by the
   * layout, so a new bitmap cannot change the box that produced it.
   */
  onChartLayoutChanged(args: EventData): void {
    const view = args.object as View;
    const size = view?.getActualSize?.();
    if (!size || size.width < 40 || size.height < 40) return;
    const previous = this.chartBoxDips;
    if (
      previous &&
      Math.abs(previous.width - size.width) < 2 &&
      Math.abs(previous.height - size.height) < 2
    ) {
      return;
    }
    this.chartBoxDips = { width: size.width, height: size.height };
    this.rebuild();
  }

  private renderChart(points: readonly RollupPoint[], mode: "band" | "bars"): ImageSource | null {
    // Measured box when the Image has reported one; otherwise a first-paint
    // estimate good enough to draw once, which the measurement then replaces.
    const box = this.chartBoxDips;
    const availableDips = box
      ? box.width
      : Math.max(220, Screen.mainScreen.widthDIPs - (this.isCompact ? 32 : 380));
    const boxHeightDips = box ? box.height : this.chartHeight;
    const width = Math.min(MAX_RENDER_WIDTH, Math.round(availableDips * RENDER_SCALE));
    const height = Math.round(boxHeightDips * RENDER_SCALE);
    const image = new GrayImage(width, height, INK.background);
    const font = getDefaultSmallFont();
    const inset = 8;

    // Sleep gets the most recent night's hypnogram under its bars: the bar
    // chart says how long, the strip says what the night was made of.
    const showHypnogram = this.metric === "sleep" && !!this.sleepCaption;
    const stripHeight = showHypnogram ? 22 : 0;
    const chartHeight = height - inset * 2 - stripHeight;

    drawMetricChart(
      image,
      { x: inset, y: inset, width: width - inset * 2, height: chartHeight },
      {
        metric: this.metric === "sleep" ? "steps" : (this.metric as SampleMetric),
        points,
        font,
        mode,
        xLabel: (point) => this.formatAxisLabel(point),
      },
    );

    if (showHypnogram) {
      const latest = healthStore().sleepSessions()[0];
      if (latest) {
        drawHypnogram(
          image,
          { x: inset, y: height - inset - stripHeight + 4, width: width - inset * 2, height: stripHeight - 6 },
          hypnogram(latest),
        );
      }
    }
    return grayImageToPreviewSource(image);
  }

  /**
   * Just format the tick. `drawMetricChart` already drops labels to whatever
   * the chart width fits, so thinning here as well multiplies the two and can
   * leave a single label on the axis.
   */
  private formatAxisLabel(point: RollupPoint): string {
    const date = new Date(point.startMs);
    if (this.granularity() === "hour") return `${date.getHours()}`;
    if (this.range === "week") return shortWeekday(point.startMs);
    return `${date.getDate()}`;
  }
}
