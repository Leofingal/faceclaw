/**
 * Today's step count, cached for the home screen's menu row.
 *
 * ## Why a cache exists at all
 *
 * `statusLine()` is called inside the glasses menu's paint path, so it may
 * not read the store: `samplesInRange` opens a month shard off disk and
 * `dailySummary` walks it. That is nothing on a timer and unacceptable on a
 * paint. So the read happens on the shared :01/:31 tick
 * (`refreshHealthStatus`, wired from `apps/health/index.ts`) and the paint
 * path reads this one number out of memory.
 *
 * ## The two ways it gets filled, both of them Chris's
 *
 * 2026-09-15: *"I think the live status we wanted to be on the 30 minute
 * refresh cycle of the health stats pulls too. So steps get updated every 30
 * minutes, or when you go into the health app view."*
 *
 *  1. the aligned tick, through `refreshHealthStatus()`;
 *  2. the health app's own reload, through `noteHealthSteps()` — which hands
 *     over the figure the app is about to DRAW, so the menu row and the
 *     glance page cannot disagree about today's steps. That is the coupling
 *     the known-good assertion in `tools/menu-preview.cjs` checks.
 *
 * ⚠ Nothing here talks to the ring. The menu line must never trigger a pull;
 * the on-demand pull stays where it was, in the health app's own `start()`.
 */

import { dailySummary } from "./health-derive";
import { healthStore } from "./health-store-files";
import { DAY_MS, startOfLocalDay } from "./health-types";

let steps: number | null = null;
let stepsDayStartMs: number | null = null;

/**
 * Today's steps, or null when there is no figure for TODAY.
 *
 * The day is part of the cache, so a phone left running past midnight shows
 * nothing rather than yesterday's total — the one failure mode of a cached
 * daily number, and invisible on a row that carries no date.
 */
export function healthStepsToday(nowMs: number = Date.now()): number | null {
  if (steps === null || stepsDayStartMs === null) return null;
  return startOfLocalDay(nowMs) === stepsDayStartMs ? steps : null;
}

/** Record a step total for a day, from whoever just computed one. */
export function noteHealthSteps(dayStartMs: number, value: number): void {
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(value) || value < 0) return;
  steps = Math.round(value);
  stepsDayStartMs = dayStartMs;
}

/**
 * Read the store and cache today's steps. The expensive half; tick only.
 *
 * Sleep sessions are deliberately NOT loaded: `dailySummary` only needs them
 * for its sleep field, steps are summed from the samples alone, and skipping
 * them saves reading `sleep.jsonl` on every tick for a number that would be
 * thrown away.
 */
export function refreshHealthStatus(nowMs: number = Date.now()): void {
  try {
    const today = startOfLocalDay(nowMs);
    const samples = healthStore().samplesInRange(today, today + DAY_MS);
    noteHealthSteps(today, dailySummary(samples, [], today).steps);
  } catch (error) {
    console.warn("health status refresh failed", error);
  }
}
