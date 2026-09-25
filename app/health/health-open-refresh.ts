/**
 * Redraw the phone Health tab when the pull its open asked for lands.
 *
 * ## Why (2026-09-24)
 *
 * In "Only when needed" a Health open raises the ring link for a fresh pull
 * (and while the glasses charge overnight it is the only thing that does). The
 * phone tab's `attach()` syncs the store, asks for that pull and draws - all
 * before the pull has even dialled. The pull lands ~20 s later (a dial, the
 * handshake, five record types), and the tab never looked again, so an open
 * showed the data from BEFORE the pull and the new data waited for the next
 * open.
 *
 * ## How
 *
 * The communicator counts every pull that finishes (completed or aborted:
 * `FaceclawBleCommunicator.ringHealthPullsFinished()`). By the time that count
 * moves, every page of the pull is journaled - the pull flushes and journals
 * after each record type before it returns - so one sync and one rebuild then
 * show all of it. This watches that count for a bounded window after the
 * open: a cheap in-memory read every {@link OPEN_PULL_POLL_MS}, a redraw each
 * time it moves, and nothing at all once the window is over.
 *
 * The window covers the worst case of one open: the ask keeps the radio
 * dialling for up to 60 s (`RING_ON_DEMAND_LINK_WAIT_MS`), the pull then
 * takes ~15-20 s, and if it aborts, its first retry starts 60 s after it did.
 * A redraw on every move, not only the first, is what lets that retry show
 * up too.
 *
 * ## Only in "Only when needed"
 *
 * The watch starts only when the live communicator was built in that mode. In
 * Direct and "Only via glasses" the tab draws exactly as it always has - the
 * seat's instruction was to leave those two modes unchanged. Direct's open
 * pull lands ~15 s after the open too, and the same watch would redraw it; it
 * is one condition in `watchOpenPull` if that is wanted later.
 *
 * Pure and NativeScript-free, so `tests/` can drive it with fake timers.
 */

/** What the phone tab reads from the live communicator; null when there is none. */
export type RingPullProgress = {
  /** The communicator was built in "Only when needed" mode. */
  onDemand: boolean;
  /** Pulls finished on this communicator, completed or aborted. */
  pullsFinished: number;
};

/** How often the count is read while the watch runs. */
export const OPEN_PULL_POLL_MS = 2_000;

/**
 * How long one open is watched: up to 60 s of dialling, a ~20 s pull, and the
 * first retry of an aborted pull (60 s after that pull started), with margin.
 */
export const OPEN_PULL_WATCH_MS = 150_000;

export type OpenPullWatchDeps = {
  progress: () => RingPullProgress | null;
  /** Sync the store and rebuild the view. */
  redraw: () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

/**
 * Start watching for the open's pull to land. Call it BEFORE asking for the
 * pull, so a pull that finishes fast cannot slip past the starting count.
 * Returns a stop function; calling it more than once is harmless.
 *
 * Starts nothing - no timer at all - unless the communicator exists and is in
 * "Only when needed" mode.
 */
export function watchOpenPull(deps: OpenPullWatchDeps): () => void {
  const start = readProgress(deps);
  if (!start || !start.onDemand) {
    return () => {};
  }
  let seen = start.pullsFinished;
  let elapsedMs = 0;
  let handle: unknown = null;
  let stopped = false;

  const stop = (): void => {
    stopped = true;
    if (handle !== null) {
      deps.clearTimer(handle);
      handle = null;
    }
  };

  const tick = (): void => {
    handle = null;
    if (stopped) return;
    elapsedMs += OPEN_PULL_POLL_MS;
    const now = readProgress(deps);
    if (!now) {
      // The communicator went away (glasses disconnected for good, app
      // teardown). Nothing more can land for this open.
      stop();
      return;
    }
    // `!==`, not `>`: a glasses reconnect builds a new communicator whose
    // count starts again at 0, and a redraw then costs nothing.
    if (now.pullsFinished !== seen) {
      seen = now.pullsFinished;
      try {
        deps.redraw();
      } catch {
        // A failed redraw must not end the watch; the view logs its own errors.
      }
    }
    if (elapsedMs >= OPEN_PULL_WATCH_MS) {
      stop();
      return;
    }
    handle = deps.setTimer(tick, OPEN_PULL_POLL_MS);
  };

  handle = deps.setTimer(tick, OPEN_PULL_POLL_MS);
  return stop;
}

function readProgress(deps: OpenPullWatchDeps): RingPullProgress | null {
  try {
    return deps.progress();
  } catch {
    return null;
  }
}
