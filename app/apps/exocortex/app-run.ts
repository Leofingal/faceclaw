/**
 * The home screen's APP RUN — its geometry and its drawing, and none of its
 * plumbing.
 *
 * ## Why this is split out of exocortex-app.ts
 *
 * Exactly the split `health/health-glance.ts` makes against
 * `apps/health/health-app.ts`, and for the same payoff. The layer owns what
 * only a running app can do: the notification feed, the cursor, the window.
 * Drawing a list of rows needs nothing but a `GrayImage` and a font — so with
 * it over here, `tools/menu-preview.cjs` renders the real menu to a PNG under
 * plain node, with no emulator and no device, and the previews cannot drift
 * from what the glasses show because they ARE the glasses' paint code.
 *
 * The rule this file keeps: fonts and entries arrive as arguments, nothing is
 * imported from `native/` or `@nativescript/core`, and nothing reads a clock.
 *
 * ## It owns the home screen's layout constants
 *
 * Including the two the notification view also uses (`PAGE_X`, `TITLE_Y`).
 * One home for the numbers beats two files agreeing by hand.
 */

import { GrayImage, type UiFont } from "../../graphics/image";
import { renderIcon, type IconName } from "../../graphics/icons";
import { truncateText } from "../../graphics/textwrap";
import { drawSelectionHighlight, LIST_ROW_TEXT_INSET, listRowHeight } from "../../ui/metrics";
import { layoutRowStatus } from "./status-line";

export const PAGE_X = 20;
export const TITLE_X = 18;
export const TITLE_Y = 10;
export const LIST_TOP = 38;
export const ROW_X = 12;
export const ICON_TEXT_GAP = 8;

/** One launchable entry of the app run, as the painter needs it. */
export type AppRunEntry = {
  appId: string;
  label: string;
  icon: IconName;
  /** App-supplied artwork; `icon` remains the fallback. */
  renderIcon?: (size: number) => GrayImage | null;
  /**
   * This app's live status, for the right-hand end of its row.
   *
   * CALLED IN THE PAINT PATH, so it must be cheap and synchronous — see
   * `apps/app-definition.ts` for the full contract. Absent, or returning
   * null, means the row draws exactly as it did before status lines existed.
   */
  statusLine?: () => string | null;
  /** When `statusLine` next changes its text; see `apps/app-definition.ts`. */
  statusLineChangesInMs?: () => number | null;
};

export type AppRunGeometry = {
  width: number;
  height: number;
  font: UiFont;
};

/** How many rows fit below the title band. */
export function appRunVisibleRows(font: UiFont, height: number): number {
  return Math.max(1, Math.floor((height - LIST_TOP) / listRowHeight(font)));
}

/** Left edge of a row's text, which is also where its label starts. */
export function appRunTextX(font: UiFont): number {
  return ROW_X + 8 + appRunIconSize(font) + ICON_TEXT_GAP;
}

/** Right edge of a row's text area — the label's bound, and the status's. */
export function appRunRowRight(width: number): number {
  return width - ROW_X - 8;
}

function appRunIconSize(font: UiFont): number {
  return Math.max(12, listRowHeight(font) - 6);
}

/**
 * Ask an entry for its status without letting it break the home screen.
 *
 * A provider that throws costs its own row's status and nothing else. This
 * matters more than it looks: these run on every paint of the home screen,
 * which is the one window that cannot be closed and has nothing behind it.
 */
function statusOf(entry: AppRunEntry): string | null {
  if (!entry.statusLine) return null;
  try {
    return entry.statusLine();
  } catch (error) {
    console.warn(`status line failed for ${entry.appId}`, error);
    return null;
  }
}

/**
 * The app run: a plain vertical list, one row per app.
 *
 * Unchanged from the pre-status-line version except for the two lines at the
 * end of the loop that place a status — which is what lets the all-null case
 * be pixel-identical to the old rendering rather than merely similar.
 */
export function drawAppRun(
  image: GrayImage,
  geometry: AppRunGeometry,
  entries: readonly AppRunEntry[],
  state: { selectedIndex: number; scrollRow: number; focused: boolean },
): void {
  const { font, width, height } = geometry;
  image.drawText(font, TITLE_X, TITLE_Y, "Apps", 220);
  if (!entries.length) {
    image.drawText(font, PAGE_X, LIST_TOP, "No apps registered.", 190);
    return;
  }

  const rowH = listRowHeight(font);
  const iconSize = appRunIconSize(font);
  const visibleRows = appRunVisibleRows(font, height);
  const textX = appRunTextX(font);
  const rowRight = appRunRowRight(width);

  for (let index = state.scrollRow; index < Math.min(entries.length, state.scrollRow + visibleRows); index++) {
    const entry = entries[index]!;
    const y = LIST_TOP + (index - state.scrollRow) * rowH;
    const selected = index === state.selectedIndex;
    if (selected) {
      drawSelectionHighlight(image, ROW_X, y, width - 2 * ROW_X, rowH - 2, state.focused);
    }
    const icon = entry.renderIcon?.(iconSize) ?? renderIcon(entry.icon, iconSize);
    if (icon) {
      image.bitBlt(icon, ROW_X + 8, y + Math.round((rowH - 2 - icon.height) / 2), { transparentZero: true });
    }
    // The label is laid out against the FULL row width, exactly as before —
    // the status gets the leftovers, never the other way round.
    const label = truncateText(font, entry.label, width - textX - ROW_X - 8);
    image.drawText(font, textX, y + LIST_ROW_TEXT_INSET, label, selected ? 235 : 190);

    const status = layoutRowStatus(font, { label, status: statusOf(entry), textX, rowRight });
    if (status) {
      // Dimmer than the name it sits beside: the row is still "the app", with
      // the number as a secondary annotation on it.
      image.drawText(font, status.x, y + LIST_ROW_TEXT_INSET, status.text, selected ? 175 : 145);
    }
  }
}

/**
 * Which row a touch on the phone's mirror landed on, or null.
 *
 * Uses the same geometry `drawAppRun` laid the rows out with, so it lands on
 * what the mirror showed.
 */
export function appRunIndexAt(
  geometry: Pick<AppRunGeometry, "width" | "font">,
  entryCount: number,
  scrollRow: number,
  x: number,
  y: number,
): number | null {
  if (entryCount <= 0) return null;
  if (y < LIST_TOP || x < ROW_X || x >= geometry.width - ROW_X) return null;
  const index = scrollRow + Math.floor((y - LIST_TOP) / listRowHeight(geometry.font));
  if (index < 0 || index >= entryCount) return null;
  return index;
}
