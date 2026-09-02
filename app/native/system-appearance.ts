import { Application } from '@nativescript/core'

/**
 * Force a live re-apply of the .ns-dark/.ns-light root CSS class, bypassing
 * Application's own cached-value guard.
 *
 * Root cause background (round 4, 2026-09-02): Chris confirmed live, both
 * directions, that a system theme switch WHILE the app is running leaves
 * Terminal and Doc view white-on-white and Rich View dark-locked, while a
 * cold launch in either theme is correct. That rules out the CSS itself
 * (app.css's `.ns-dark .ghost-*` rules are complete and correct -- cold
 * launch proves they apply cleanly) and points at the live-update signal.
 *
 * NativeScript's own automatic mechanism (Application.autoSystemAppearanceChanged,
 * on by default) is supposed to handle exactly this: Android delivers a
 * uiMode configuration-change callback, NativeScript swaps the root view's
 * .ns-dark/.ns-light class, bumps the style-scope's selector version, and
 * recursively re-evaluates every descendant view's CSS state. Read end to
 * end in @nativescript/core 9.0.18's source, this pipeline is real and
 * complete -- which means one of two things is actually happening on real
 * hardware, and there was no way to tell which without a device to
 * instrument: (a) Android silently never delivers the config-change
 * callback for some theme-toggle paths (a real, documented class of
 * OEM/Android flakiness this app doesn't control), so NativeScript's cache
 * goes stale and nothing downstream ever fires; or (b) the callback does
 * fire and the cache updates, but the recolor doesn't fully land on views
 * that were already painted before the switch.
 *
 * This function is written to fix both without needing to know which is
 * real. Application.setSystemAppearance() is the framework's own reapply
 * path (root CSS class swap + recursive restyle) but is guarded by
 * `if (this._systemAppearance === value) return` -- which would silently
 * no-op in failure mode (b), where the cache already (correctly) matches
 * the OS value but the views never got restyled. Clearing the cached value
 * first forces the guard open every time this runs, so both failure modes
 * get the same real reapply. It's cheap and idempotent (a CSS class swap
 * and a re-cascade, not a network or layout-heavy op), so calling it
 * defensively on every trigger -- including when nothing was actually wrong
 * -- costs nothing worth avoiding.
 *
 * Called from two triggers (app.ts), not per-pane: Application's own
 * systemAppearanceChangedEvent (covers failure mode (b), and is a no-op
 * cost-wise if the framework already got it right) and the resumeEvent
 * (covers failure mode (a) -- catches up the moment the wearer is back
 * looking at the screen, rather than staying wrong until some later,
 * unrelated theme change). One mechanism fixes Terminal, Doc, and Rich View
 * at once, matching what round 4's instruction asked for instead of three
 * separate per-pane CSS patches.
 *
 * REENTRANCY GUARD IS LOAD-BEARING, NOT DEFENSIVE STYLE. Traced through
 * @nativescript/core's own source before shipping this, not assumed:
 * `Application.setSystemAppearance()` ends by calling
 * `this.notify({ eventName: this.systemAppearanceChangedEvent, ... })` --
 * the SAME event this function is subscribed to in app.ts. Without the
 * guard below, the systemAppearanceChangedEvent trigger would call this
 * function, which calls setSystemAppearance(), which re-fires
 * systemAppearanceChangedEvent, which calls this function again --
 * synchronous, unbounded recursion on every real theme switch. The guard
 * blocks exactly the re-entrant nested call (itself now a genuine no-op:
 * the outer call already forced the real reapply), not the two real
 * top-level triggers, which still each run once per resume/switch.
 */
let resyncing = false

export function resyncSystemAppearance(): void {
  if (resyncing) return
  if (!global.isAndroid || !Application.android) return
  // Cast past TypeScript's `protected` on both members -- real at the class
  // level (guarding external callers from depending on framework internals
  // that could change), but this is the framework's own supported mechanism
  // for exactly this operation, just not exposed as a public re-apply API.
  const android = Application.android as unknown as { getSystemAppearance(): 'dark' | 'light' | null }
  const actual = android.getSystemAppearance()
  if (!actual) return
  const app = Application as unknown as {
    _systemAppearance?: 'dark' | 'light' | null
    setSystemAppearance(value: 'dark' | 'light'): void
  }
  resyncing = true
  try {
    app._systemAppearance = undefined
    app.setSystemAppearance(actual)
  } finally {
    resyncing = false
  }
}
