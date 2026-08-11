import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../../graphics/image";
import { verticalPositionSetting } from "../dashboard-settings";

/** Top bar: 24px notification icons plus a little padding. */
export const TOP_BAR_HEIGHT = 28;
/**
 * Sidebar width. Leaves the app viewport exactly 576px wide — the surface
 * width EvenHub apps expect. Icon column layout within the strip (one wide
 * column vs. two narrow ones) is the chrome layer's business.
 */
export const SIDEBAR_WIDTH = 64;

/**
 * On the color-key shell surface, pixel value 0 is transparent; 1 is the
 * darkest opaque shade (identical to 0 after 4bpp quantization). Shell
 * painting must use this for intentional black.
 */
export const SHELL_OPAQUE_BLACK = 1;

/**
 * Windows come in three heights. "min" covers the same 288px band the stock
 * firmware uses, leaving most of the field of view clear; "medium" is one
 * top bar taller, so the content area below the bar is a full 288px (the
 * EvenHub app surface height); "max" uses the whole 480px screen (terminal
 * views). All include a top bar drawn by the shell at the window's top edge.
 */
export type WindowHeightMode = "min" | "medium" | "max";

/** Total height (top bar + content) of a min-height window. */
export const MIN_WINDOW_HEIGHT = 288;
/** Farthest down a min-height window can start. */
export const MIN_WINDOW_MAX_TOP = G2_LENS_HEIGHT - MIN_WINDOW_HEIGHT;

/** Total height (top bar + content) of a window's band in the given mode. */
export function windowBandHeight(mode: WindowHeightMode): number {
  switch (mode) {
    case "max":
      return G2_LENS_HEIGHT;
    case "medium":
      return MIN_WINDOW_HEIGHT + TOP_BAR_HEIGHT;
    default:
      return MIN_WINDOW_HEIGHT;
  }
}

/**
 * Fraction of the slack above a window band, from the Display > Vertical
 * position setting: each band height distributes its own free space by the
 * same fraction, so all heights sit consistently within the screen.
 */
function verticalPositionFraction(): number {
  switch (verticalPositionSetting.get()) {
    case "top":
      return 0;
    case "upper":
      return 0.25;
    case "lower":
      return 0.75;
    case "bottom":
      return 1;
    default:
      return 0.5;
  }
}

/**
 * Top edge (y) of a min-height window. The sidebar and shell overlays always
 * align to this band, even while a taller window is foreground.
 */
export function minWindowTop(): number {
  return windowTop("min");
}

/** Top edge (y) of a window's top bar; max-height windows pin to the screen top. */
export function windowTop(mode: WindowHeightMode): number {
  return Math.round((G2_LENS_HEIGHT - windowBandHeight(mode)) * verticalPositionFraction());
}

/** App-content viewport size for a height mode (independent of vertical position). */
export function appViewportSize(mode: WindowHeightMode): { width: number; height: number } {
  return {
    width: G2_LENS_WIDTH - SIDEBAR_WIDTH,
    height: windowBandHeight(mode) - TOP_BAR_HEIGHT,
  };
}

/** Screen rect of a window's app-content viewport (below its top bar). */
export function appViewportRect(mode: WindowHeightMode): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: SIDEBAR_WIDTH,
    y: windowTop(mode) + TOP_BAR_HEIGHT,
    ...appViewportSize(mode),
  };
}
