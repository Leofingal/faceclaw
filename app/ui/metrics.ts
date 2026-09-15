/**
 * Font-derived layout metrics for list-style UIs, so row spacing, selection
 * highlights, and text line steps track the user's font size instead of
 * assuming the 12px bitmap default. The font picker guarantees
 * getDefaultSmallFont's lineHeight is 12..21px (and getDefaultMediumFont's
 * 16..29px — see ui-fonts.ts), so layouts driven by these helpers have
 * bounded growth.
 *
 * The formulas reproduce the pre-TTF constants exactly at the 12px default:
 * listRowHeight 20, tightRowHeight 16, lineStep 14, menuTitleHeight 16.
 *
 * ⚠ THIS FILE MUST STAY FREE OF NATIVESCRIPT, and of anything that imports
 * it. `drawSelectionHighlight` and `scrollToKeepSelectionVisible` moved here
 * from `ui/menu.ts` (which reaches `native/frame-timings` through
 * `ui/layers.ts`) so that list UIs can be drawn under plain node by
 * `tools/menu-preview.cjs` and `tools/health-preview.cjs`. `ui/menu.ts`
 * re-exports both, so every existing caller is unaffected.
 */
import type { GrayImage, UiFont } from "../graphics/image";
import { clamp } from "../util/numeric-util";

/** Height of one selectable list/menu row (line box + breathing room). */
export function listRowHeight(font: UiFont): number {
  return font.lineHeight + 8;
}

/** Vertical inset of a listRowHeight row's text within the row. */
export const LIST_ROW_TEXT_INSET = 4;

/**
 * Height of one row in dense lists (file browser, track lists). Grows at
 * half the lineHeight's rate above the 12px anchor: TTF line heights carry
 * internal leading that already reads as row spacing, so full-rate growth
 * made large-font rows feel too tall.
 */
export function tightRowHeight(font: UiFont): number {
  return font.lineHeight + 4 - Math.floor(Math.max(0, font.lineHeight - 12) / 2);
}

/** Step between consecutive lines of body/paragraph text. */
export function lineStep(font: UiFont): number {
  return font.lineHeight + 2;
}

/** Height of a menu/panel title band above a list. */
export function menuTitleHeight(font: UiFont): number {
  return font.lineHeight + 4;
}

/**
 * Minimum height of an icon-grid cell (icon, label line, breathing room).
 * Grid views divide their available height into as many rows of at least
 * this height as fit, so cells grow with the font instead of the label
 * overflowing a fixed-height row.
 */
export function iconGridMinRowHeight(font: UiFont, iconSize: number, labelGap: number): number {
  return iconSize + labelGap + font.lineHeight + 8;
}

const MENU_HIGHLIGHT_SELECTED_BACKGROUND_FILL = 15;
const MENU_HIGHLIGHT_SELECTED_BORDER_STROKE = 45;

/**
 * Draw a selection highlight for a list row. A focused list fills the row and
 * outlines it; a visible-but-unfocused list draws only the outline, so the
 * selection stays legible without implying it will receive input.
 */
export function drawSelectionHighlight(
  image: GrayImage,
  x: number,
  y: number,
  width: number,
  height: number,
  focused: boolean,
  radius = 6,
): void {
  if (focused) {
    image.fillRoundedRect(x, y, width, height, MENU_HIGHLIGHT_SELECTED_BACKGROUND_FILL, radius);
  }
  image.drawRoundedRect(x, y, width, height, MENU_HIGHLIGHT_SELECTED_BORDER_STROKE, radius);
}

/**
 * Move a list's scroll position the minimum distance needed to keep the
 * selected row inside the visible window, clamped to the list bounds.
 * Returns the new scroll row (the index of the first visible item).
 */
export function scrollToKeepSelectionVisible(
  scrollRow: number,
  selectedIndex: number,
  visibleRowCount: number,
  itemCount: number,
): number {
  if (selectedIndex < scrollRow) {
    scrollRow = selectedIndex;
  } else if (selectedIndex >= scrollRow + visibleRowCount) {
    scrollRow = selectedIndex - visibleRowCount + 1;
  }
  return clamp(scrollRow, 0, Math.max(0, itemCount - visibleRowCount));
}
