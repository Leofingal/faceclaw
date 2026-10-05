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
import type { EventData, ImageSource, TouchGestureEventData, View } from "@nativescript/core";

import { getDefaultSmallFont } from "../graphics/ui-fonts";
import { grayImageToPreviewSource } from "../native/gray-image-preview";
import {
  displayClass,
  foldSnapshot,
  onFoldStateChanged,
  refreshFoldTracking,
  type CompanionDisplayClass,
} from "../native/fold-state";
import { hypnogramCaption } from "../health/health-chart";
import {
  phoneChartSlots,
  renderPhoneChart,
  slotAt,
  type PhoneChartContent,
  type PhoneChartRequest,
} from "../health/health-phone-chart";
import {
  RANGE_DAYS,
  RANGE_LABELS,
  type Granularity,
  type RangeKey,
  formatDuration,
  formatValue,
  shortDate,
  shortWeekday,
  rollupSeries,
  assembleNights,
  sleepNights,
  sleepSummary,
} from "../health/health-derive";
import {
  backToDrillSource,
  canStepForward,
  drillIntoDay,
  healthViewState,
  selectedDayMs,
  stepDay,
  withMetric,
  withRange,
  withSleepWindow,
  type HealthViewState,
  type SleepWindow,
} from "../health/health-view-state";
import {
  buildNightTimeline,
  clockText,
  hourText,
  sleepWindowBounds,
  type NightTimeline,
} from "../health/health-night-timeline";
import { healthStore } from "../health/health-store-files";
import { ringCoverage } from "../health/health-coverage";
import { requestFreshPull, ringPullProgress, syncLiveRecords } from "../health/health-live";
import { watchOpenPull } from "../health/health-open-refresh";
import { isFixtureData, seedFixturesIfNeeded } from "../health/health-seed";
import { localFields } from "../util/local-zone";
import {
  DAY_MS,
  HOUR_MS,
  METRIC_LABELS,
  METRIC_UNITS,
  type RollupPoint,
  type SampleMetric,
  type SeriesMetric,
  addLocalDays,
  startOfLocalDay,
} from "../health/health-types";

const METRIC_ORDER: readonly SeriesMetric[] = ["heartRate", "spo2", "hrv", "steps", "sleep"];
const RANGE_ORDER: readonly RangeKey[] = ["day", "week", "month", "quarter"];

/**
 * Chart height in DIPs, per display class.
 *
 * ⚠ EXPANDED RAISED 260 -> 380, Chris 2026-09-10: "make the chart itself
 * larger/more prominent". The width half of that change is in the layout
 * (now health-body.xml), where the readout moved from beside the chart to below it - the chart
 * now gets the whole window width instead of window-minus-300dp, which on an
 * unfolded Fold 7 is most of the change. The extra height is so a chart twice
 * as wide does not end up a letterbox strip.
 */
const CHART_HEIGHT_COMPACT = 190;
const CHART_HEIGHT_EXPANDED = 380;
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

/** A tap that moves less than this (DIPs) between down and up is a tap, not a scroll. */
const TAP_SLOP_DIPS = 12;

const SLEEP_WINDOW_LABELS: Readonly<Record<SleepWindow, string>> = {
  primary: "Night (8 PM - noon)",
  full: "Full day (8 PM - 8 PM)",
};

export class HealthViewModel extends Observable {
  /**
   * Metric, range, day and sleep window live in the SHARED store, not here
   * (2026-10-04, audit F8): the glasses Health app reads and writes the same
   * copy, so the two screens mirror each other, and a fresh model on every
   * main-page visit no longer resets the selection. See health-view-state.ts.
   */
  private get state(): HealthViewState {
    return healthViewState.get();
  }
  private get metric(): SeriesMetric {
    return this.state.metric;
  }
  private get range(): RangeKey {
    return this.state.range;
  }
  private unsubscribeState: (() => void) | null = null;
  /** What the last chart was drawn from, for mapping a tap back to a day. */
  private lastRender: PhoneChartRequest | null = null;
  private touchDown: { x: number; y: number } | null = null;
  private timeline: NightTimeline | null = null;
  private displayClassValue: CompanionDisplayClass = "expanded";
  private unsubscribeFold: (() => void) | null = null;
  private chart: ImageSource | null = null;
  /** The chart Image's measured box in DIPs; see `onChartLayoutChanged`. */
  private chartBoxDips: { width: number; height: number } | null = null;
  private stats: StatRow[] = [];
  private fixture = false;
  private sleepCaption = "";
  /** Stops the redraw-on-landing watch; see `health-open-refresh.ts`. */
  private stopOpenPullWatch: (() => void) | null = null;

  attach(): void {
    // Live data first, so the purge happens before anything renders and
    // seeding is skipped entirely once real records exist. See health-live.ts.
    syncLiveRecords();
    // In "Only when needed" the pull an open asks for is a fresh dial and
    // lands ~20 s after this method has drawn. Watch for it and draw again when it does
    // (2026-09-24). Started BEFORE the ask, so a fast pull cannot slip past
    // the starting count; a no-op in Direct and "Only via glasses".
    this.stopOpenPullWatch?.();
    this.stopOpenPullWatch = watchOpenPull({
      progress: ringPullProgress,
      redraw: () => {
        syncLiveRecords();
        this.rebuild();
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    requestFreshPull("health-open");
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
    // Either screen may move the shared view; whoever moved it, redraw here.
    this.unsubscribeState?.();
    this.unsubscribeState = healthViewState.subscribe(() => {
      this.notifySelection();
      this.rebuild();
    });
    this.notifySelection();
    this.rebuild();
  }

  dispose(): void {
    this.stopOpenPullWatch?.();
    this.stopOpenPullWatch = null;
    this.unsubscribeFold?.();
    this.unsubscribeFold = null;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
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

  /**
   * Every selection goes through the shared store, and the store's
   * subscription (set in `attach`) is what redraws. A model that is not
   * attached still updates the store, so the glasses follow.
   */
  private selectMetric(key: SeriesMetric): void {
    healthViewState.set(withMetric(this.state, key), "phone");
  }

  private selectRange(key: RangeKey): void {
    healthViewState.set(withRange(this.state, key), "phone");
  }

  get sleepWindowChips(): ChipRow[] {
    return (["primary", "full"] as const).map((key) =>
      this.chip(key, SLEEP_WINDOW_LABELS[key], key === this.state.sleepWindow, () =>
        healthViewState.set(withSleepWindow(this.state, key), "phone"),
      ),
    );
  }

  get sleepWindowVisibility(): "visible" | "collapse" {
    return this.metric === "sleep" && this.range === "day" ? "visible" : "collapse";
  }

  // -------------------------------------------------------------------------
  // The day view: stepping, and the way back to the multi-day view

  get dayNavVisibility(): "visible" | "collapse" {
    return this.range === "day" ? "visible" : "collapse";
  }

  /** "Today, Sun 4 Oct" or "Sat 3 Oct". For sleep, the day the night ends on. */
  get dayLabel(): string {
    const today = startOfLocalDay(Date.now());
    const day = selectedDayMs(this.state, today);
    return day === today ? `Today, ${shortDate(day)}` : shortDate(day);
  }

  get prevDayClass(): string {
    return "health-step";
  }

  get nextDayClass(): string {
    return canStepForward(this.state, startOfLocalDay(Date.now())) ? "health-step" : "health-step health-step-off";
  }

  onPrevDayTap(): void {
    healthViewState.set(stepDay(this.state, -1, startOfLocalDay(Date.now())), "phone");
  }

  onNextDayTap(): void {
    healthViewState.set(stepDay(this.state, 1, startOfLocalDay(Date.now())), "phone");
  }

  get backVisibility(): "visible" | "collapse" {
    return this.state.drillFrom !== null && this.range === "day" ? "visible" : "collapse";
  }

  get backText(): string {
    const from = this.state.drillFrom;
    return from ? `‹ Back to ${RANGE_LABELS[from].toLowerCase()}` : "";
  }

  onBackTap(): void {
    healthViewState.set(backToDrillSource(this.state), "phone");
  }

  /** Multi-day views say they can be tapped; nothing else on the chart does. */
  get chartHintVisibility(): "visible" | "collapse" {
    return this.range === "day" ? "collapse" : "visible";
  }

  // -------------------------------------------------------------------------
  // The nap marker (sleep day view, primary window only)

  get napMarkerText(): string {
    const timeline = this.timeline;
    if (!timeline || timeline.window !== "primary" || timeline.outside.length === 0) return "";
    if (timeline.outside.length > 1) return `+ ${timeline.outside.length} more sleeps after noon ›`;
    const outside = timeline.outside[0]!;
    if (outside.kind === "spill") return `+ sleep until ${clockText(outside.endMs)} ›`;
    return `+ nap ${clockText(outside.startMs)}, ${formatDuration((outside.endMs - outside.startMs) / 1000)} ›`;
  }

  get napMarkerVisibility(): "visible" | "collapse" {
    return this.napMarkerText && this.metric === "sleep" && this.range === "day" ? "visible" : "collapse";
  }

  /** The marker is also the toggle: tapping it shows the full sleep day. */
  onNapMarkerTap(): void {
    healthViewState.set(withSleepWindow(this.state, "full"), "phone");
  }

  // -------------------------------------------------------------------------
  // Tapping a day on a multi-day chart

  /**
   * The chart is one bitmap, so a tap is mapped to a day by position: the
   * Image reports the touch in DIPs, `phoneChartSlots` says where each day was
   * drawn in bitmap pixels, and `aspectFit`'s scale and centring connect the
   * two. A touch that moved is a scroll and is ignored.
   */
  onChartTouch(args: TouchGestureEventData): void {
    const x = args.getX();
    const y = args.getY();
    if (args.action === "down") {
      this.touchDown = { x, y };
      return;
    }
    if (args.action !== "up") {
      if (args.action === "cancel") this.touchDown = null;
      return;
    }
    const down = this.touchDown;
    this.touchDown = null;
    if (!down || Math.abs(x - down.x) > TAP_SLOP_DIPS || Math.abs(y - down.y) > TAP_SLOP_DIPS) return;
    const size = (args.object as View)?.getActualSize?.();
    if (!size) return;
    this.tapChartAt(x, size.width, size.height);
  }

  /**
   * A tap at `xDip` across an Image box of `boxWidthDips` x `boxHeightDips`.
   * Returns the day it opened, or null when the tap was not on a day (or the
   * view is already a day view).
   */
  tapChartAt(xDip: number, boxWidthDips: number, boxHeightDips: number): number | null {
    const request = this.lastRender;
    if (!request || this.range === "day" || boxWidthDips <= 0 || boxHeightDips <= 0) return null;
    // aspectFit: the bitmap is scaled by the tighter of the two ratios and
    // centred, so undo both.
    const scale = Math.max(request.width / boxWidthDips, request.height / boxHeightDips);
    const offsetX = (boxWidthDips - request.width / scale) / 2;
    const bitmapX = (xDip - offsetX) * scale;
    const slot = slotAt(phoneChartSlots(request), bitmapX);
    if (!slot) return null;
    const day = startOfLocalDay(slot.startMs);
    healthViewState.set(drillIntoDay(this.state, day, startOfLocalDay(Date.now())), "phone");
    return day;
  }

  private notifySelection(): void {
    this.notifyPropertyChange("metricChips", this.metricChips);
    this.notifyPropertyChange("rangeChips", this.rangeChips);
    this.notifyPropertyChange("sleepWindowChips", this.sleepWindowChips);
    this.notifyPropertyChange("sleepWindowVisibility", this.sleepWindowVisibility);
    this.notifyPropertyChange("dayNavVisibility", this.dayNavVisibility);
    this.notifyPropertyChange("dayLabel", this.dayLabel);
    this.notifyPropertyChange("prevDayClass", this.prevDayClass);
    this.notifyPropertyChange("nextDayClass", this.nextDayClass);
    this.notifyPropertyChange("backVisibility", this.backVisibility);
    this.notifyPropertyChange("backText", this.backText);
    this.notifyPropertyChange("chartHintVisibility", this.chartHintVisibility);
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
    if (this.metric === "sleep" && this.range === "day") {
      const today = startOfLocalDay(Date.now());
      const day = selectedDayMs(this.state, today);
      const bounds = sleepWindowBounds(day, this.state.sleepWindow);
      return `${hourText(bounds.startMs)} ${shortWeekday(bounds.startMs)} to ${
        this.state.sleepWindow === "primary" ? "noon" : hourText(bounds.endMs)
      } ${shortWeekday(day)}`;
    }
    const unit = METRIC_UNITS[this.metric];
    const granularity = this.granularity();
    const grain = granularity === "tenMinutes" ? "by 10 minutes" : granularity === "hour" ? "by hour" : "by day";
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

  /**
   * Day views chart at day scale (2026-10-04): steps in the ring's own
   * 10-minute buckets, so a walk shows as the walk; HR, HRV and SpO2 by hour,
   * which is what the ring reports for them.
   */
  private granularity(): Granularity {
    if (this.range !== "day") return "day";
    return this.metric === "steps" ? "tenMinutes" : "hour";
  }

  // -------------------------------------------------------------------------
  // Building the chart

  private rebuild(): void {
    try {
      this.fixture = isFixtureData();
      const { content, stats, caption } = this.buildContent();
      this.stats = stats;
      this.sleepCaption = caption;
      this.chart = this.renderChart(content);
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
    this.notifyPropertyChange("dayLabel", this.dayLabel);
    this.notifyPropertyChange("napMarkerText", this.napMarkerText);
    this.notifyPropertyChange("napMarkerVisibility", this.napMarkerVisibility);
  }

  /**
   * The plotted window. A day view shows the SELECTED day (shared state);
   * the multi-day views end on today, wherever the day view was stepped to,
   * so "back to week" returns to the week that was tapped.
   */
  private windowMs(): { startMs: number; endMs: number } {
    const today = startOfLocalDay(Date.now());
    if (this.range === "day") {
      const day = selectedDayMs(this.state, today);
      return { startMs: day, endMs: addLocalDays(day, 1) };
    }
    const days = RANGE_DAYS[this.range];
    return { startMs: addLocalDays(today, -(days - 1)), endMs: addLocalDays(today, 1) };
  }

  private buildContent(): { content: PhoneChartContent; stats: StatRow[]; caption: string } {
    const { startMs, endMs } = this.windowMs();
    this.timeline = null;
    if (this.metric === "sleep" && this.range === "day") return this.buildNightContent(startMs);
    if (this.metric === "sleep") return this.buildSleepContent(startMs, endMs);

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
        cursor = addLocalDays(cursor, 1);
      }
    } else {
      points = rollupSeries(store.samplesInRange(startMs, endMs), {
        metric,
        granularity,
        startMs,
        endMs,
      });
    }

    const tenMinutes = granularity === "tenMinutes";
    return {
      content: {
        kind: "metric",
        metric,
        points,
        mode: metric === "steps" || metric === "calories" ? "bars" : "band",
        xLabel: (point) => this.formatAxisLabel(point),
        // 144 slots: label the hours, and let collisions thin them.
        labelThinning: tenMinutes ? "collide" : "step",
      },
      stats: tenMinutes ? this.summariseTenMinutes(points) : this.summariseSeries(points, metric),
      caption: "",
    };
  }

  /** The steps day view's readout: the total, and the busiest 10 minutes. */
  private summariseTenMinutes(points: readonly RollupPoint[]): StatRow[] {
    const withData = points.filter((point) => point.count > 0);
    if (withData.length === 0) return [{ label: "No data", value: "for this day" }];
    const total = withData.reduce((sum, point) => sum + point.sum, 0);
    const busiest = withData.reduce((best, point) => (point.sum > best.sum ? point : best));
    return [
      { label: "Total", value: formatValue(total, "steps") },
      { label: "Busiest 10 minutes", value: `${formatValue(busiest.sum, "steps")} at ${clockText(busiest.startMs)}` },
    ];
  }

  /**
   * Sleep's day view: the night as a timeline (2026-10-04). See
   * `health-night-timeline.ts` for what counts as asleep, awake and no-data.
   */
  private buildNightContent(dayMs: number): { content: PhoneChartContent; stats: StatRow[]; caption: string } {
    const store = healthStore();
    const full = sleepWindowBounds(dayMs, "full");
    const timeline = buildNightTimeline({
      sessions: store.sleepSessions(),
      // Two hours either side: an hourly bucket that started earlier still
      // overlaps the window, and the coverage rule looks at a run's edges.
      samples: store.samplesInRange(full.startMs - 2 * HOUR_MS, full.endMs + HOUR_MS),
      resetsMs: store.ringResets(),
      dayMs,
      window: this.state.sleepWindow,
    });
    this.timeline = timeline;
    // Totals over the QUALITY window - first recorded sleep to last wake of
    // the sleep day (Chris 2026-10-04 23:55) - not over the drawn window.
    const stats: StatRow[] = [];
    if (timeline.qualityStartMs !== null && timeline.qualityEndMs !== null) {
      stats.push({ label: "Asleep", value: formatDuration(timeline.asleepSec) });
      stats.push({ label: "Awake", value: formatDuration(timeline.awakeSec) });
      if (timeline.noDataSec >= 60) stats.push({ label: "No data", value: formatDuration(timeline.noDataSec) });
      stats.push({
        label: "Measured",
        value: `${clockText(timeline.qualityStartMs)} - ${clockText(timeline.qualityEndMs)}`,
      });
    } else {
      stats.push({ label: "No sleep recorded", value: "this sleep day" });
    }
    for (const resetMs of timeline.resetsMs) stats.push({ label: "Ring reset", value: clockText(resetMs) });
    return {
      content: { kind: "timeline", timeline },
      stats,
      caption: timeline.hasSleep ? hypnogramCaption() : "",
    };
  }

  /**
   * Sleep, which now has TWO charts rather than one.
   *
   * ⚠ REDESIGNED 2026-09-10. Over a week/month/quarter this was nightly totals
   * as plain bars plus a separate hypnogram strip of the latest night. It is
   * now one diverging stacked bar per night - deep/REM/light stacked upward,
   * awake extending below zero - which is Chris's design and is described in
   * `drawSleepStackChart`. The strip is gone from this view: it showed one
   * night's shape underneath thirty nights' totals, which invited reading it as
   * a summary of all of them.
   *
   * ⚠ CHANGED 2026-10-04: the single Day is no longer the lanes here. It is
   * the night TIMELINE (`buildNightContent`): the same four lanes, but in
   * clock time, with awake gaps and no-data spans. The glasses keep the lanes.
   */
  private buildSleepContent(
    startMs: number,
    endMs: number,
  ): { content: PhoneChartContent; stats: StatRow[]; caption: string } {
    // Every stored block, not a pre-filtered set: which night a block belongs to
    // is decided by assembly (20:00 -> 20:00, by where the block ENDS), not by
    // the dayStartMs it happened to be stored with.
    const store = healthStore();
    const sessions = store.sleepSessions();
    // A gap between blocks is awake only where the ring has data
    // (health-derive rule 4). Nights start 20:00 the evening before.
    const coverage = ringCoverage(store.samplesInRange(addLocalDays(startMs, -1) - HOUR_MS, endMs));
    const awakeIn = (a: number, b: number): number => coverage.secondsIn(a, b);
    const nights = sleepNights(sessions, startMs, endMs, awakeIn);
    const withData = nights.filter((night) => night.hasData);
    // The latest ASSEMBLED night in the window: every block of it, gaps as
    // wake where the ring has data.
    const latest = assembleNights(sessions, awakeIn).find(
      (night) => night.dayStartMs >= startMs && night.dayStartMs < endMs,
    );

    const stats: StatRow[] = [];
    if (withData.length > 0) {
      const totals = withData.map(
        (night) => night.deepSec + night.remSec + night.lightSec,
      );
      const total = totals.reduce((sum, value) => sum + value, 0);
      stats.push({ label: "Shortest", value: formatDuration(Math.min(...totals)) });
      stats.push({ label: "Average", value: formatDuration(total / totals.length) });
      stats.push({ label: "Longest", value: formatDuration(Math.max(...totals)) });
      stats.push({ label: "Nights", value: `${withData.length}` });
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

    // The day view is `buildNightContent` (2026-10-04); this is week and up.
    return {
      content: {
        kind: "nights",
        nights,
        xLabel: (night) => this.formatAxisLabel({ startMs: night.startMs } as RollupPoint),
      },
      stats,
      caption: "",
    };
  }

  /**
   * ⚠ "Buckets" DROPPED, Chris 2026-09-10: "buckets are not meaningful" to a
   * user. It was the number of sample buckets that had data - an implementation
   * detail of how the store shards time, put on screen by mistake rather than
   * by decision. Nothing replaced it: the other three rows are the answer, and
   * a fourth row existed only because four looked tidier than three.
   *
   * The bucket count is still what the other rows are computed over, so this is
   * a display change only.
   */
  private summariseSeries(points: readonly RollupPoint[], metric: SampleMetric): StatRow[] {
    const withData = points.filter((point) => point.count > 0);
    if (withData.length === 0) return [{ label: "No data", value: "for this range" }];
    if (metric === "steps" || metric === "calories") {
      const totals = withData.map((point) => point.sum);
      const total = totals.reduce((sum, value) => sum + value, 0);
      return [
        { label: "Total", value: formatValue(total, metric) },
        { label: "Best", value: formatValue(Math.max(...totals), metric) },
        { label: "Average", value: formatValue(total / totals.length, metric) },
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

  /**
   * Size the bitmap, then hand the drawing to `health-phone-chart.ts`.
   *
   * Everything below this line used to be drawing code. It moved to a module
   * with no NativeScript imports so that `tools/health-preview.cjs` can render
   * the exact same chart at any width under plain node - which is how the
   * narrow and wide layouts get looked at without an emulator. What stays here
   * is the part that genuinely needs the platform: the measured box, the
   * display class, and the `ImageSource` conversion.
   *
   * The first-paint width estimate no longer subtracts a side column, because
   * after the wide-layout change there isn't one - the readout sits below the
   * chart in both layouts, so the chart spans the window either way.
   */
  private renderChart(content: PhoneChartContent): ImageSource | null {
    // Measured box when the Image has reported one; otherwise a first-paint
    // estimate good enough to draw once, which the measurement then replaces.
    const box = this.chartBoxDips;
    const availableDips = box ? box.width : Math.max(220, Screen.mainScreen.widthDIPs - 32);
    const boxHeightDips = box ? box.height : this.chartHeight;
    const request: PhoneChartRequest = {
      width: Math.min(MAX_RENDER_WIDTH, Math.round(availableDips * RENDER_SCALE)),
      height: Math.round(boxHeightDips * RENDER_SCALE),
      font: getDefaultSmallFont(),
      content,
    };
    this.lastRender = request;
    return grayImageToPreviewSource(renderPhoneChart(request));
  }

  /**
   * Just format the tick. `drawMetricChart` already drops labels to whatever
   * the chart width fits, so thinning here as well multiplies the two and can
   * leave a single label on the axis.
   */
  private formatAxisLabel(point: RollupPoint): string {
    const date = localFields(point.startMs);
    const granularity = this.granularity();
    // The 10-minute day: label the top of every hour; collisions thin them.
    if (granularity === "tenMinutes") return date.minutes === 0 ? `${date.hours}` : "";
    if (granularity === "hour") return `${date.hours}`;
    if (this.range === "week") return shortWeekday(point.startMs);
    return `${date.date}`;
  }
}
