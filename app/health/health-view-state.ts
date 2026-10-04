/**
 * HEALTH - the one view state both surfaces show (audit F8, design rule 1).
 *
 * Which metric, which range, which day and which sleep window: one copy, held
 * here at module level, read by the phone's Health view
 * (`phone-ui/health-view-model.ts`) and the glasses Health app
 * (`apps/health/health-app.ts`). A change on either side is a change HERE, and
 * every subscriber redraws, so the two screens move together - Chris's ruling
 * (2026-09-30): "if I switch days on the app, it should also show what's on
 * the app" - and it runs both ways.
 *
 * It is module-level rather than on a model instance for a reason F1's return
 * measured: main-page builds a fresh MainViewModel (and with it a fresh
 * HealthViewModel) on every visit, so state on an instance reset to "heart
 * rate, today" every time the phone came back to Health. The JS process keeps
 * this module for as long as the app runs, so the selection now survives a
 * visit. It is deliberately NOT persisted to disk: an app restart starting on
 * today is what a person expects of a health app.
 *
 * Pure: no NativeScript imports, no clock. Every transition that needs "today"
 * takes it as an argument, so the tests can pin it.
 */

import type { RangeKey } from "./health-derive";
import type { SeriesMetric } from "./health-types";
import { addLocalDays } from "../util/local-zone";

/**
 * Chris's ruling (2026-10-04): the sleep day view spans either the PRIMARY
 * sleep window, 20:00 -> noon, or the FULL sleep day, 20:00 -> 20:00.
 */
export type SleepWindow = "primary" | "full";

export type HealthViewState = {
  metric: SeriesMetric;
  range: RangeKey;
  /**
   * Local midnight of the day the day view shows, or null for "today", which
   * follows the clock across midnight. For sleep it is the day the night ENDS
   * on (the 20:00 -> 20:00 sleep day, labelled by its end).
   */
  dayMs: number | null;
  sleepWindow: SleepWindow;
  /**
   * The multi-day range a day view was opened from by tapping a day, so the
   * back control knows where to return. Null when the day view was reached
   * any other way.
   */
  drillFrom: RangeKey | null;
};

/** Who made a change. The glasses use it to follow the phone's metric. */
export type HealthViewSource = "phone" | "glasses";

export type HealthViewChange = {
  state: HealthViewState;
  previous: HealthViewState;
  source: HealthViewSource;
};

export const INITIAL_HEALTH_VIEW_STATE: HealthViewState = Object.freeze({
  metric: "heartRate",
  range: "day",
  dayMs: null,
  sleepWindow: "primary",
  drillFrom: null,
}) as HealthViewState;

export class HealthViewStateStore {
  private state: HealthViewState = { ...INITIAL_HEALTH_VIEW_STATE };
  private listeners: ((change: HealthViewChange) => void)[] = [];

  get(): HealthViewState {
    return this.state;
  }

  /** Replace the state; a no-op (no notification) when nothing changed. */
  set(next: HealthViewState, source: HealthViewSource): void {
    if (sameState(next, this.state)) return;
    const previous = this.state;
    this.state = { ...next };
    for (const listener of this.listeners.slice()) {
      try {
        listener({ state: this.state, previous, source });
      } catch (error) {
        console.warn("health view state listener failed", error);
      }
    }
  }

  update(patch: Partial<HealthViewState>, source: HealthViewSource): void {
    this.set({ ...this.state, ...patch }, source);
  }

  subscribe(listener: (change: HealthViewChange) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((held) => held !== listener);
    };
  }

  /** Tests only: back to the initial state, listeners kept. */
  reset(): void {
    this.state = { ...INITIAL_HEALTH_VIEW_STATE };
  }
}

/** The app's one Health view state. */
export const healthViewState = new HealthViewStateStore();

function sameState(a: HealthViewState, b: HealthViewState): boolean {
  return (
    a.metric === b.metric &&
    a.range === b.range &&
    a.dayMs === b.dayMs &&
    a.sleepWindow === b.sleepWindow &&
    a.drillFrom === b.drillFrom
  );
}

// ---------------------------------------------------------------------------
// Transitions. Each returns the next state; the caller sets it with its source.

/** The day a day view shows, resolved: `dayMs`, or today when it is null or in the future. */
export function selectedDayMs(state: HealthViewState, todayMs: number): number {
  if (state.dayMs === null || state.dayMs >= todayMs) return todayMs;
  return state.dayMs;
}

/** A metric chip. Keeps the range and day, so "steps, Sat 3 Oct" -> "HR, Sat 3 Oct". */
export function withMetric(state: HealthViewState, metric: SeriesMetric): HealthViewState {
  return { ...state, metric };
}

/**
 * A range chip. Picking any range by hand ends a drill-down: the back control
 * would otherwise offer to return to a range the reader has already left.
 */
export function withRange(state: HealthViewState, range: RangeKey): HealthViewState {
  return { ...state, range, drillFrom: null };
}

/**
 * Tap a day in a multi-day view: that day's day view, same metric, with the
 * way back remembered. A tap in the day view itself is not a drill.
 */
export function drillIntoDay(state: HealthViewState, dayMs: number, todayMs: number): HealthViewState {
  if (state.range === "day") return state;
  return {
    ...state,
    range: "day",
    dayMs: dayMs >= todayMs ? null : dayMs,
    drillFrom: state.range,
  };
}

/** The back control: return to the multi-day view the day was opened from. */
export function backToDrillSource(state: HealthViewState): HealthViewState {
  if (state.drillFrom === null) return state;
  return { ...state, range: state.drillFrom, drillFrom: null };
}

/**
 * Previous / next day from a day view (Chris 2026-10-01). Never past today:
 * stepping forward onto today stores null, so the view then follows the clock.
 * Returns the state unchanged when the step is not possible.
 */
export function stepDay(state: HealthViewState, delta: number, todayMs: number): HealthViewState {
  if (state.range !== "day") return state;
  const current = selectedDayMs(state, todayMs);
  const next = addLocalDays(current, delta);
  if (next > todayMs) return state;
  return { ...state, dayMs: next >= todayMs ? null : next };
}

export function canStepForward(state: HealthViewState, todayMs: number): boolean {
  return state.range === "day" && selectedDayMs(state, todayMs) < todayMs;
}

/** The sleep window toggle (and the nap marker, which flips it to full). */
export function withSleepWindow(state: HealthViewState, sleepWindow: SleepWindow): HealthViewState {
  return { ...state, sleepWindow };
}

/**
 * The glasses' click on a plot (Chris 2026-10-01): day -> week -> month -> day.
 * "3 months" is phone-only in the cycle; a click from it goes back to day.
 * Like a range chip, it ends a drill-down.
 */
export const GLASSES_RANGE_CYCLE: readonly RangeKey[] = ["day", "week", "month"];

export function cycleGlassesRange(state: HealthViewState): HealthViewState {
  const index = GLASSES_RANGE_CYCLE.indexOf(state.range);
  const next = index < 0 ? "day" : GLASSES_RANGE_CYCLE[(index + 1) % GLASSES_RANGE_CYCLE.length]!;
  return withRange(state, next);
}
