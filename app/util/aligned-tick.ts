/**
 * THE wall-clock-aligned :01/:31 tick. One timer, many riders.
 *
 * ## Why this is a module and not a second timer
 *
 * Session 0157 replaced the ring pull's elapsed-time throttle with a
 * wall-clock-aligned scheduler (commit `0daf44f`, `health/health-live.ts`'s
 * `startAlignedRingPull`). When the home screen's status lines needed an
 * occasional refresh on the same cadence, the obvious move — a second
 * `setTimeout` chain doing the same arithmetic — would have drifted against
 * the first one the moment either was re-armed a few milliseconds late, and
 * would have put two copies of the reasoning below in two files.
 *
 * So the scheduler moved here and the ring pull became its first SUBSCRIBER.
 * `startAlignedRingPull()` still exists and still means what it did; it now
 * registers `requestFreshPull` on this tick instead of owning a timer.
 *
 * ## The reasoning, carried over from health-live.ts verbatim in substance
 *
 * Chris, 2026-09-12: *"I think we should be polling the ring on the 30 minute
 * cycle (that was my intent, not a floor honestly)."*
 *
 * Two reasons this is aligned to the wall clock rather than a plain interval:
 *
 * 1. **The ring's own step buckets close on 10-minute boundaries.** Firing on
 *    the boundary collects a just-closed bucket instead of a half-formed one.
 * 2. **An elapsed timer drifts.** A pull at :07 sets the next at :37, then
 *    :07, wandering away from the boundary it is supposed to track. Re-arming
 *    against the clock each time cannot drift.
 *
 * The **one-minute offset is deliberate**: firing exactly at :00 risks
 * catching the ring before it has finalised that bucket.
 *
 * ## What a listener may do
 *
 * This is the EXPENSIVE half of the home screen's two-part status contract
 * (see `apps/app-definition.ts`): a listener may read a file, call the
 * network, or ask the ring for a pull. It must not assume it is alone — one
 * listener throwing must not cost the others their tick, which is why every
 * call is wrapped below.
 */

/** The minutes past the hour this tick fires on. */
export const ALIGNED_TICK_MINUTES: readonly number[] = [1, 31];

/**
 * Milliseconds from `now` until the next aligned slot.
 *
 * Pure, and exported for tests: this is the arithmetic that was verified in
 * 0157 and it is the only part of the scheduler worth pinning.
 */
export function msUntilNextAlignedTick(now: Date): number {
  const minutes = now.getMinutes();
  const withinHour = ALIGNED_TICK_MINUTES.filter((minute) => minute > minutes);
  // Next slot this hour, or the first slot of the next hour.
  const target = withinHour.length ? withinHour[0]! : ALIGNED_TICK_MINUTES[0]! + 60;
  const msIntoMinute = now.getSeconds() * 1000 + now.getMilliseconds();
  return (target - minutes) * 60 * 1000 - msIntoMinute;
}

type AlignedTickListener = () => void;

const listeners = new Set<AlignedTickListener>();
let tickTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Run `listener` on every aligned tick. Returns an unsubscribe function.
 *
 * Registering does not start the timer — `startAlignedTick()` does, once,
 * from `app.ts`. That keeps "who schedules" in one place instead of making
 * every subscriber responsible for booting the clock.
 */
export function onAlignedTick(listener: AlignedTickListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fire every listener now, independently of the timer.
 *
 * Exported because two callers legitimately want the tick's work without
 * waiting for the next slot: boot (so the first 30 minutes of a fresh
 * process are not blank) and tests.
 */
export function runAlignedTick(): void {
  // A copy, so a listener that unsubscribes during the tick cannot disturb
  // the iteration.
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.warn("aligned tick: listener failed", error);
    }
  }
}

/**
 * Start the one timer. Idempotent — every subscriber may call it.
 *
 * Re-arms against the CLOCK after each fire, never against elapsed time; see
 * the header for why that distinction is the whole point.
 */
export function startAlignedTick(): void {
  if (tickTimer) return;
  const arm = (): void => {
    const delay = msUntilNextAlignedTick(new Date());
    tickTimer = setTimeout(() => {
      tickTimer = null;
      runAlignedTick();
      arm();
    }, delay);
  };
  arm();
}

/** Exported for tests — the arithmetic and the registry, with no timer attached. */
export const __alignedTickInternals = {
  msUntilNextAlignedTick,
  ALIGNED_TICK_MINUTES,
  listenerCount: (): number => listeners.size,
  clearListeners: (): void => {
    listeners.clear();
  },
};
