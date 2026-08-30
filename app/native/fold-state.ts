/**
 * Fold posture and window size, from com.faceclaw.app.FaceclawFoldState
 * (Jetpack WindowManager underneath).
 *
 * The phone UI asks one question of this module — "am I on the cover screen
 * or the inner one?" — and `displayClass()` is the only place that question is
 * answered, so the rule lives in one place rather than in each page.
 */
import { Application } from "@nativescript/core";

declare const com: any;
declare const global: any;

/** Raw hinge posture, as androidx.window reports it. */
export type FoldPosture = "flat" | "half-opened" | "none";

export type FoldSnapshot = {
  posture: FoldPosture;
  /** The window's own size, not the display's. Zero until the first reading. */
  widthDp: number;
  heightDp: number;
  /** A hinge crosses this window right now — i.e. we are on the inner display. */
  hasHinge: boolean;
  /** This device is a foldable at all (hinge sensor, or a hinge seen once). */
  isFoldable: boolean;
};

/**
 * What the companion should lay out for. Deliberately two values, not three:
 * half-open is a posture, not a size, and the window is the same width in it.
 */
export type CompanionDisplayClass = "compact" | "expanded";

/**
 * Android's own compact/medium breakpoint. The Fold 7's cover screen is
 * 1080px wide at ~2.6 density (~411dp) and its inner screen 1968px (~750dp),
 * so this sits with plenty of clearance on both sides of the real hardware
 * rather than being tuned to it.
 */
const EXPANDED_MIN_WIDTH_DP = 600;

const UNKNOWN: FoldSnapshot = {
  posture: "none",
  widthDp: 0,
  heightDp: 0,
  hasHinge: false,
  isFoldable: false,
};

let current: FoldSnapshot = UNKNOWN;
let listeners: Array<(snapshot: FoldSnapshot) => void> = [];
let trackedActivity: any = null;

export function foldSnapshot(): FoldSnapshot {
  return current;
}

/**
 * Cover screen or inner screen.
 *
 * A device with no hinge NEVER gets the compact companion, however narrow it
 * is. Width alone would demote every ordinary phone to the cover-screen
 * layout, which is a different product decision than the one being made here:
 * this is "the Fold is shut", not "the screen is small".
 */
export function displayClass(snapshot: FoldSnapshot = current): CompanionDisplayClass {
  if (!snapshot.isFoldable) return "expanded";
  // No reading yet: the full companion is the safe default — it is what the
  // app showed before this module existed.
  if (snapshot.widthDp <= 0) return "expanded";
  return snapshot.widthDp >= EXPANDED_MIN_WIDTH_DP ? "expanded" : "compact";
}

export function onFoldStateChanged(listener: (snapshot: FoldSnapshot) => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

/**
 * Start (or re-point) tracking at the Activity that is on screen now.
 *
 * Pages call this from `loaded` rather than once at startup: WindowInfoTracker
 * needs an Activity, and NativeScript has none until the first page is up. A
 * suspend/resume cycle can also hand us a different Activity instance, so this
 * re-registers when the Activity has changed and is a no-op when it has not.
 */
export function refreshFoldTracking(): void {
  if (!global.isAndroid) return;
  const activity = Application.android?.foregroundActivity ?? Application.android?.startActivity;
  if (!activity || activity === trackedActivity) return;
  try {
    const proxy = new com.faceclaw.app.FaceclawFoldStateListener({
      onFoldStateChanged: (
        posture: string,
        widthDp: number,
        heightDp: number,
        hasHinge: boolean,
        isFoldable: boolean,
      ) => {
        publish({
          posture: normalizePosture(posture),
          widthDp: Number(widthDp),
          heightDp: Number(heightDp),
          hasHinge: Boolean(hasHinge),
          isFoldable: Boolean(isFoldable),
        });
      },
    });
    com.faceclaw.app.FaceclawFoldState.start(activity, proxy);
    trackedActivity = activity;
  } catch (error) {
    // A build without the androidx.window dependency, or an Activity that has
    // gone away between the check and the call: the app keeps the expanded
    // layout, which is what it had before any of this existed.
    console.warn(`fold tracking unavailable: ${error}`);
  }
}

export function stopFoldTracking(): void {
  if (!global.isAndroid) return;
  try {
    com.faceclaw.app.FaceclawFoldState.stop();
  } catch {
    // Nothing registered; nothing to undo.
  }
  trackedActivity = null;
}

function normalizePosture(value: string): FoldPosture {
  const posture = String(value);
  if (posture === "flat" || posture === "half-opened") return posture;
  return "none";
}

function publish(next: FoldSnapshot): void {
  const previous = current;
  current = next;
  if (
    previous.posture === next.posture &&
    previous.widthDp === next.widthDp &&
    previous.heightDp === next.heightDp &&
    previous.hasHinge === next.hasHinge &&
    previous.isFoldable === next.isFoldable
  ) {
    return;
  }
  for (const listener of listeners.slice()) {
    listener(next);
  }
}
