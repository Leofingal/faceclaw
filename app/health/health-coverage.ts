/**
 * HEALTH - when the ring recorded ANYTHING (Chris's ruling, 2026-10-04 16:40:
 * "awake time is awake").
 *
 * Outside a sleep block, time the ring has data for (heart rate, HRV, SpO2,
 * steps, calories) is AWAKE; only time the ring recorded nothing at all is
 * NO-DATA. This module answers "which stretches of [a, b) does the ring have
 * data for?" from the stored samples, for the night timeline and the
 * week/month sleep bars.
 *
 * A sample covers its own bucket, `[startMs, startMs + spanMs)`. One
 * refinement, because an hourly bucket overstates the edge of a data run: the
 * ring delivers the CURRENT hour as a partial bucket, so the 22:00 heart-rate
 * bucket of 10-03 (pulled at 22:04, then the ring reset at 01:31 and lost the
 * rest) claims 22:00-23:00. When an hourly bucket sits at the END of a run (no
 * sample starts within 10 minutes after it, none spans past it) and finer
 * 10-minute buckets fall inside it, its coverage stops where the last of those
 * ends. Only the end: a bucket at the START of a run is a finished hour, and
 * the ring does not always send its 10-minute buckets (10-04: none 04:11-11:40,
 * while the 11:00 heart-rate hour is there), so trimming a run's start to its
 * first 10-minute bucket would call recorded time no-data. Everywhere else an
 * hourly bucket keeps its whole hour, which is what bridges the 10-minute
 * buckets the ring does not send.
 *
 * Pure, no NativeScript, sorted once, binary-searched: the quarter view runs it
 * over ~90 days of samples.
 */

import type { HealthSample } from "./health-types";

/** Buckets this short or shorter are "fine" (the ring's 10-minute steps/calories). */
const FINE_MAX_MS = 10 * 60_000;

export type RingCoverage = {
  /** The covered stretches inside [a, b), sorted, merged, clipped. */
  intervalsIn(startMs: number, endMs: number): [number, number][];
  /** Covered seconds inside [a, b). */
  secondsIn(startMs: number, endMs: number): number;
};

export function ringCoverage(samples: readonly HealthSample[]): RingCoverage {
  const sorted = samples
    .filter((sample) => sample.spanMs > 0 && Number.isFinite(sample.startMs))
    .slice()
    .sort((a, b) => a.startMs - b.startMs);
  const starts = sorted.map((sample) => sample.startMs);
  // prefixMaxEnd[i] = the latest end among sorted[0..i].
  const prefixMaxEnd: number[] = [];
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const sample of sorted) {
    maxEnd = Math.max(maxEnd, sample.startMs + sample.spanMs);
    prefixMaxEnd.push(maxEnd);
  }
  const lowerBound = (value: number): number => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const raw: [number, number][] = [];
  for (const sample of sorted) {
    let start = sample.startMs;
    let end = sample.startMs + sample.spanMs;
    if (sample.spanMs > FINE_MAX_MS) {
      const lo = lowerBound(start);
      const hi = lowerBound(end);
      let fineEnd = Number.NEGATIVE_INFINITY;
      for (let index = lo; index < hi; index += 1) {
        const inside = sorted[index]!;
        if (inside.spanMs > FINE_MAX_MS) continue;
        fineEnd = Math.max(fineEnd, inside.startMs + inside.spanMs);
      }
      if (Number.isFinite(fineEnd)) {
        const before = lo > 0 ? prefixMaxEnd[lo - 1]! : Number.NEGATIVE_INFINITY;
        const followed = lowerBound(end + FINE_MAX_MS + 1) > hi || before >= end;
        if (!followed) end = Math.min(end, Math.max(fineEnd, start));
      }
    }
    if (end > start) raw.push([start, end]);
  }

  raw.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of raw) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const intervalsIn = (a: number, b: number): [number, number][] => {
    const out: [number, number][] = [];
    for (const [start, end] of merged) {
      if (end <= a) continue;
      if (start >= b) break;
      out.push([Math.max(a, start), Math.min(b, end)]);
    }
    return out;
  };
  return {
    intervalsIn,
    secondsIn: (a, b) => intervalsIn(a, b).reduce((sum, [start, end]) => sum + (end - start) / 1000, 0),
  };
}
