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
 */
import type { UiFont } from "../graphics/image";

/** Height of one selectable list/menu row (line box + breathing room). */
export function listRowHeight(font: UiFont): number {
  return font.lineHeight + 8;
}

/** Vertical inset of a listRowHeight row's text within the row. */
export const LIST_ROW_TEXT_INSET = 4;

/** Height of one row in dense lists (file browser, track lists). */
export function tightRowHeight(font: UiFont): number {
  return font.lineHeight + 4;
}

/** Step between consecutive lines of body/paragraph text. */
export function lineStep(font: UiFont): number {
  return font.lineHeight + 2;
}

/** Height of a menu/panel title band above a list. */
export function menuTitleHeight(font: UiFont): number {
  return font.lineHeight + 4;
}
