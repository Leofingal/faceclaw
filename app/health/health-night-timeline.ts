/**
 * HEALTH - one sleep day as a TIMELINE (Chris, 2026-10-04): "went to bed,
 * slept 1 h, awake 2 h, then slept 6:31", not one number.
 *
 * The sleep day is the 20:00 -> 20:00 window labelled by the day it ends on
 * (`sleepNightDayStartMs`). Within it this module lays out, in clock time:
 *
 *   - each SLEEP block the ring recorded, with its stage runs (REM / light /
 *     deep / wake) positioned where they happened;
 *   - AWAKE time between two blocks, where the ring was demonstrably on and
 *     running across the gap (no reset in it, and at least one sample of any
 *     metric overlapping it);
 *   - NO-DATA everywhere else, labelled when it can be explained: a ring reset
 *     (dated from the `ringBoot` receipts, `datedRingResets`) or no ring
 *     contact at all. **A no-data span is never awake.** Before the first block
 *     and after the last one the ring recorded no sleep, and the app cannot know
 *     whether the wearer slept then (10-04: a ~00:30-01:30 block was lost to the
 *     01:31 reset), so that time is no-data too, never "awake".
 *
 * Two windows (Chris's ruling, 2026-10-04): PRIMARY sleep, 20:00 -> noon, and
 * the FULL sleep day, 20:00 -> 20:00. Sleep that belongs to the day but falls
 * after noon (an afternoon nap) is listed in `outside` so the view can show an
 * edge marker for it in primary mode.
 *
 * Pure: no NativeScript, no clock.
 */

import { assembleNight } from "./health-derive";
import type { HealthSample, SleepSession } from "./health-types";
import { localFields, localToMs } from "../util/local-zone";
import { stageNameForId, type SleepStageName } from "./sleep-stages";
import type { SleepWindow } from "./health-view-state";

// ===========================================================================
// Ring resets

/**
 * When a receipt's boot is undated, the first journal page at most this long
 * after the receipt dates it. The boot push and the first page arrive on the
 * same connect, seconds apart (11:31:01.334 boot, 11:31:03.734 first page on
 * 10-04).
 */
const UNDATED_BOOT_PAGE_WINDOW_MS = 120_000;

/**
 * Receipts whose previous DATA seq was this high read as an 8-bit counter
 * wrap, not a reset (the communicator's own rule, `noteRingPush`).
 */
const WRAP_SEQ_FLOOR = 0xf0;

/**
 * Every ring reset the receipts can date, oldest first, in wall-clock ms.
 *
 * A `ringBoot` receipt written by `7025819` or later carries `bootAtMs` (the
 * link's clock write minus the page trailer) and is used as-is. An older
 * receipt has only `atMs`, the moment the boot was seen; it is dated here the
 * same way Java dates the new ones, from the trailer of the first journal page
 * that arrived on that connect: `atMs - trailerSec`. The trailer is the last
 * four bytes of every health page, u32 LE, the ring's uptime when its clock was
 * set after the boot (`RingProtocol.pageTrailerSeconds`). A receipt whose page
 * the journal has already trimmed stays undated and is left out: a marker at
 * the wrong time would be worse than none.
 */
export function datedRingResets(
  receiptsText: string | null | undefined,
  journalText: string | null | undefined,
): number[] {
  type Boot = { atMs: number; bootAtMs: number | null };
  const boots: Boot[] = [];
  for (const line of (receiptsText ?? "").split("\n")) {
    if (line.indexOf('"ringBoot"') < 0) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        atMs?: unknown;
        bootAtMs?: unknown;
        prevPushSeq?: unknown;
      };
      if (parsed?.type !== "ringBoot" || typeof parsed.atMs !== "number") continue;
      if (typeof parsed.prevPushSeq === "number" && parsed.prevPushSeq >= WRAP_SEQ_FLOOR) continue;
      boots.push({
        atMs: parsed.atMs,
        bootAtMs: typeof parsed.bootAtMs === "number" ? parsed.bootAtMs : null,
      });
    } catch {
      // One bad line must not cost the rest.
    }
  }
  if (boots.length === 0) return [];

  const undated = boots.filter((boot) => boot.bootAtMs === null);
  let pages: { rxMs: number; trailerSec: number }[] = [];
  if (undated.length > 0 && journalText) pages = journalTrailers(journalText);

  const out: number[] = [];
  for (const boot of boots) {
    if (boot.bootAtMs !== null) {
      out.push(boot.bootAtMs);
      continue;
    }
    const page = pages.find(
      (candidate) =>
        candidate.rxMs >= boot.atMs && candidate.rxMs <= boot.atMs + UNDATED_BOOT_PAGE_WINDOW_MS,
    );
    if (page) out.push(boot.atMs - page.trailerSec * 1000);
  }
  return out.sort((a, b) => a - b);
}

/** `{rxMs, trailer}` for every journal page, in file order. Bad lines skipped. */
function journalTrailers(text: string): { rxMs: number; trailerSec: number }[] {
  const out: { rxMs: number; trailerSec: number }[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { rxMs?: unknown; rawHex?: unknown };
      if (typeof parsed.rxMs !== "number" || typeof parsed.rawHex !== "string") continue;
      const trailerSec = pageTrailerSec(parsed.rawHex);
      if (trailerSec >= 0) out.push({ rxMs: parsed.rxMs, trailerSec });
    } catch {
      // skip
    }
  }
  return out;
}

/** The last four bytes of a page's hex, u32 LE; -1 when too short (Java's rule: 8 bytes). */
export function pageTrailerSec(rawHex: string): number {
  if (rawHex.length < 16 || rawHex.length % 2 !== 0) return -1;
  const tail = rawHex.slice(-8);
  let value = 0;
  for (let index = 3; index >= 0; index -= 1) {
    const byte = parseInt(tail.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) return -1;
    value = value * 256 + byte;
  }
  return value;
}

// ===========================================================================
// The window

/** 20:00 the evening before `dayMs` -> noon (primary) or 20:00 (full) on `dayMs`. */
export function sleepWindowBounds(
  dayMs: number,
  window: SleepWindow,
): { startMs: number; endMs: number } {
  const f = localFields(dayMs);
  return {
    startMs: localToMs(f.year, f.month, f.date - 1, 20),
    endMs: localToMs(f.year, f.month, f.date, window === "primary" ? 12 : 20),
  };
}

// ===========================================================================
// The timeline

export type TimelineStageRun = {
  /** Null for a stage id outside the mapping: the time happened, unnamed. */
  stage: SleepStageName | null;
  startMs: number;
  endMs: number;
};

export type NoDataReason = "reset" | "no-contact" | null;

export type TimelineSpan =
  | {
      kind: "sleep";
      startMs: number;
      endMs: number;
      /** The block's own start and end, before any clipping to the window. */
      blockStartMs: number;
      blockEndMs: number;
      runs: readonly TimelineStageRun[];
    }
  | { kind: "awake"; startMs: number; endMs: number }
  | {
      kind: "nodata";
      startMs: number;
      endMs: number;
      /** "reset" when a reset falls inside; "no-contact" when no sample overlaps it at all. */
      reason: NoDataReason;
      resetsMs: readonly number[];
    };

/** Sleep of this sleep day that the window does not show (primary mode). */
export type OutsideSleep = {
  startMs: number;
  endMs: number;
  /** "nap": a whole block after the window. "spill": a block running past it. */
  kind: "nap" | "spill";
};

export type NightTimeline = {
  dayMs: number;
  window: SleepWindow;
  startMs: number;
  endMs: number;
  spans: readonly TimelineSpan[];
  /** Resets inside the window, wherever they fall. */
  resetsMs: readonly number[];
  /** Light + REM + deep inside the window, seconds. */
  asleepSec: number;
  /** Wake inside blocks plus awake gaps between them, seconds. */
  awakeSec: number;
  /** Per stage, seconds; `wake` includes the awake gaps. */
  stageSec: Readonly<Record<SleepStageName, number>>;
  outside: readonly OutsideSleep[];
  /** False when no block of this sleep day reaches into the window. */
  hasSleep: boolean;
  /** True when the night's blocks could not be anchored to wall-clock time. */
  unresolved: boolean;
};

/** A no-data stretch this long with no sample at all is labelled "no ring contact". */
const NO_CONTACT_MIN_MS = 30 * 60_000;

export function buildNightTimeline(input: {
  sessions: readonly SleepSession[];
  /** Samples of any metric around the window, for the "ring was on" test. */
  samples: readonly HealthSample[];
  resetsMs: readonly number[];
  dayMs: number;
  window: SleepWindow;
}): NightTimeline {
  const { dayMs, window } = input;
  const bounds = sleepWindowBounds(dayMs, window);
  const night = assembleNight(input.sessions, dayMs);
  const unresolved = night !== null && !night.timeResolved;
  const blocks = night && night.timeResolved ? [...night.blocks].sort((a, b) => a.startMs - b.startMs) : [];

  const stageSec: Record<SleepStageName, number> = { wake: 0, rem: 0, light: 0, deep: 0 };
  const spans: TimelineSpan[] = [];
  const outside: OutsideSleep[] = [];
  const resetsMs = input.resetsMs.filter((ms) => ms >= bounds.startMs && ms < bounds.endMs);

  const resetsIn = (startMs: number, endMs: number): number[] =>
    input.resetsMs.filter((ms) => ms >= startMs && ms < endMs);
  const sampleOverlaps = (startMs: number, endMs: number): boolean =>
    input.samples.some((sample) => sample.startMs < endMs && sample.startMs + sample.spanMs > startMs);

  const pushNoData = (startMs: number, endMs: number): void => {
    if (endMs <= startMs) return;
    const resets = resetsIn(startMs, endMs);
    let reason: NoDataReason = null;
    if (resets.length > 0) reason = "reset";
    else if (endMs - startMs >= NO_CONTACT_MIN_MS && !sampleOverlaps(startMs, endMs)) reason = "no-contact";
    spans.push({ kind: "nodata", startMs, endMs, reason, resetsMs: resets });
  };

  let unnamedSec = 0;
  let cursor = bounds.startMs;
  let previousEnd = Number.NEGATIVE_INFINITY;
  let seenBlock = false;
  for (const block of blocks) {
    // A partial overlap with the previous block is trimmed, never drawn twice.
    const blockStart = Math.max(block.startMs, previousEnd);
    const blockEnd = block.endMs;
    if (blockEnd <= blockStart) continue;
    previousEnd = blockEnd;

    if (blockEnd > bounds.endMs) {
      outside.push({
        startMs: Math.max(blockStart, bounds.endMs),
        endMs: blockEnd,
        kind: blockStart >= bounds.endMs ? "nap" : "spill",
      });
    }
    const start = Math.max(blockStart, bounds.startMs);
    const end = Math.min(blockEnd, bounds.endMs);
    if (end <= start) continue;

    // The time before this block: between two blocks it can be awake.
    if (start > cursor) {
      const between = seenBlock;
      if (between && resetsIn(cursor, start).length === 0 && sampleOverlaps(cursor, start)) {
        spans.push({ kind: "awake", startMs: cursor, endMs: start });
        stageSec.wake += (start - cursor) / 1000;
      } else {
        pushNoData(cursor, start);
      }
    }

    const runs = stageRuns(block, blockStart).filter((run) => run.endMs > start && run.startMs < end)
      .map((run) => ({ ...run, startMs: Math.max(run.startMs, start), endMs: Math.min(run.endMs, end) }));
    spans.push({ kind: "sleep", startMs: start, endMs: end, blockStartMs: block.startMs, blockEndMs: block.endMs, runs });

    const whole = start === block.startMs && end === block.endMs;
    if (whole) {
      // The record's NAMED totals, not a sum of segments: they do not depend
      // on the unconfirmed stage-id mapping (see `stageSeconds`).
      stageSec.wake += Math.max(0, block.wakeSec);
      stageSec.rem += Math.max(0, block.remSec);
      stageSec.light += Math.max(0, block.lightSec);
      stageSec.deep += Math.max(0, block.deepSec);
    } else {
      for (const run of runs) {
        const seconds = (run.endMs - run.startMs) / 1000;
        // An unnamed stage inside a block is still time in the block, and not
        // wake (wake has its own id): counted as asleep, under no stage.
        if (run.stage) stageSec[run.stage] += seconds;
        else unnamedSec += seconds;
      }
    }
    cursor = end;
    seenBlock = true;
  }
  pushNoData(cursor, bounds.endMs);

  // Sleep of this day that lies wholly or partly before 20:00 the evening
  // before is not possible: a block belongs to the day its END falls in, and
  // the day starts at 20:00. So `outside` only ever looks past the window end.

  return {
    dayMs,
    window,
    startMs: bounds.startMs,
    endMs: bounds.endMs,
    spans,
    resetsMs,
    asleepSec: stageSec.rem + stageSec.light + stageSec.deep + unnamedSec,
    awakeSec: stageSec.wake,
    stageSec,
    outside,
    hasSleep: spans.some((span) => span.kind === "sleep"),
    unresolved,
  };
}

/**
 * A block's stage runs in clock time, from its own start. Segments are
 * half-minutes, in order; a block whose segments fall short of its span gets
 * an unnamed run for the rest, so the drawn block is the block's real length.
 */
function stageRuns(block: SleepSession, fromMs: number): TimelineStageRun[] {
  const runs: TimelineStageRun[] = [];
  let cursor = block.startMs;
  for (const segment of block.segments) {
    const end = Math.min(block.endMs, cursor + segment.halfMinutes * 30_000);
    if (end > cursor) runs.push({ stage: stageNameForId(segment.stageId), startMs: cursor, endMs: end });
    cursor = end;
    if (cursor >= block.endMs) break;
  }
  if (cursor < block.endMs) runs.push({ stage: null, startMs: cursor, endMs: block.endMs });
  return runs.filter((run) => run.endMs > fromMs).map((run) => ({ ...run, startMs: Math.max(run.startMs, fromMs) }));
}

// ===========================================================================
// Words

/** "3:15 PM", in the phone's current zone. */
export function clockText(ms: number): string {
  const f = localFields(ms);
  const hour12 = f.hours % 12 === 0 ? 12 : f.hours % 12;
  const minutes = `${f.minutes}`.padStart(2, "0");
  return `${hour12}:${minutes} ${f.hours < 12 ? "AM" : "PM"}`;
}

/** "8 PM", "12 AM" - an axis tick. */
export function hourText(ms: number): string {
  const f = localFields(ms);
  const hour12 = f.hours % 12 === 0 ? 12 : f.hours % 12;
  return `${hour12} ${f.hours < 12 ? "AM" : "PM"}`;
}
