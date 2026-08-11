import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/bdffont";
import { BATTERY_ICON_WIDTH, drawBattery } from "../../graphics/battery";
import { readActiveNotificationIcons } from "../../native/notification-icons";
import { readPhoneBatteryState } from "../../native/phone-battery";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../util/render-freshness";
import { renderIcon, renderIconWithGlyph, type IconName } from "../../graphics/icons";
import { batteryDisplayModeSetting, timeFormatSetting } from "../dashboard-settings";
import { Layer } from "../layers";
import { scrollToKeepSelectionVisible } from "../menu";
import {
  MIN_WINDOW_HEIGHT,
  minWindowTop,
  SHELL_OPAQUE_BLACK,
  SIDEBAR_WIDTH,
  TOP_BAR_HEIGHT,
  windowTop,
  type WindowHeightMode,
} from "./geometry";

/**
 * Sidebar icon layout comes in two variants. Few enough windows for a single
 * column keeps the roomy 36px slots (32px icons) right-aligned against the
 * separator; past one column's worth it switches to two 32px slots (28px
 * icons) that exactly fill the 64px sidebar. In the two-column variant the
 * right column (against the app area) fills first and windows past that
 * overflow into the left column, so the common case keeps every icon next to
 * the content it belongs to.
 */
type SidebarVariant = { columns: number; columnWidth: number; iconSize: number };
const ONE_COLUMN: SidebarVariant = { columns: 1, columnWidth: 36, iconSize: 32 };
const TWO_COLUMN: SidebarVariant = { columns: 2, columnWidth: 32, iconSize: 28 };

const ICON_SPACING = 8;
/** Icon list top/bottom margins within the sidebar band, below the top bar. */
const LIST_MARGIN = 10;
const LIST_HEIGHT = MIN_WINDOW_HEIGHT - TOP_BAR_HEIGHT - 2 * LIST_MARGIN;

/** Icon rows that fit in one sidebar column. */
function rowsPerColumn(variant: SidebarVariant): number {
  return Math.max(1, ((LIST_HEIGHT + ICON_SPACING) / (variant.iconSize + ICON_SPACING)) | 0);
}

function sidebarVariant(windowCount: number): SidebarVariant {
  return windowCount > rowsPerColumn(ONE_COLUMN) ? TWO_COLUMN : ONE_COLUMN;
}

/** Left x of a sidebar column; columns pack rightward against the separator. */
function columnLeft(variant: SidebarVariant, column: number): number {
  return SIDEBAR_WIDTH - (variant.columns - column) * variant.columnWidth;
}

/**
 * Left edge of the sidebar region that actually holds icons: the one-column
 * variant leaves a dead strip left of its single right-aligned column.
 * Screenshot cropping uses this to trim the unused part.
 */
export function sidebarContentLeft(windowCount: number): number {
  return columnLeft(sidebarVariant(windowCount), 0);
}
const NOTIFICATION_ICON_SIZE = 24;
const BORDER_VALUE = 40;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ShellChromeWindow = {
  windowId: string;
  title: string;
  attention: boolean;
  /** Draw the window's indicator icon. inverted = black-on-white (focused tab). */
  drawIcon: (image: GrayImage, x: number, y: number, size: number, inverted?: boolean) => void;
};

export type ShellChromeState = {
  windows: ShellChromeWindow[];
  selectedIndex: number;
  focus: "sidebar" | "window";
  /** Height mode of the foreground window; decides where its top bar sits. */
  foregroundHeightMode: WindowHeightMode;
  battery: { headset: number | null; headsetCharging: boolean | null };
  /** App-provided tray images, drawn between notification icons and batteries. */
  trayIcons: GrayImage[];
};

/** Placeholder window icon: rounded outline with a single letter. */
export function makeLetterWindowIcon(letter: string): ShellChromeWindow["drawIcon"] {
  return (image, x, y, size, inverted) => {
    const font = getDefaultMediumFont();
    if (!inverted) {
      image.drawRoundedRect(x, y, size, size, 120, 6);
    }
    const textX = x + Math.max(0, ((size - font.measureText(letter)) / 2) | 0);
    const textY = y + Math.max(0, ((size - font.lineHeight) / 2) | 0);
    image.drawText(font, textX, textY, letter, inverted ? SHELL_OPAQUE_BLACK : 210);
  };
}

/** Window icon rendered from an SVG (Lucide), rendered once per size and cached. */
export function makeSvgWindowIcon(name: IconName, glyph?: string): ShellChromeWindow["drawIcon"] {
  return (image, x, y, size, inverted) => {
    const icon = glyph ? renderIconWithGlyph(name, glyph, size) : renderIcon(name, size);
    if (!icon) return;
    const dx = x + Math.max(0, ((size - icon.width) / 2) | 0);
    const dy = y + Math.max(0, ((size - icon.height) / 2) | 0);
    if (!inverted) {
      image.bitBlt(icon, dx, dy, { transparentZero: true });
      return;
    }
    // Invert onto a white background: coverage becomes darkness. Full coverage
    // maps to SHELL_OPAQUE_BLACK (1) rather than 0, since 0 is the surface's
    // transparent color key.
    for (let row = 0; row < icon.height; row++) {
      for (let col = 0; col < icon.width; col++) {
        const coverage = icon.pixels[row * icon.width + col] ?? 0;
        if (coverage > 0) {
          image.setPixel(dx + col, dy + row, Math.max(SHELL_OPAQUE_BLACK, 255 - coverage));
        }
      }
    }
  };
}

/** SVG icon when a name is given, else the letter placeholder. */
export function windowIcon(icon: IconName | undefined, letter: string, glyph?: string): ShellChromeWindow["drawIcon"] {
  return icon ? makeSvgWindowIcon(icon, glyph) : makeLetterWindowIcon(letter);
}

/**
 * Base layer of the shell surface: the window sidebar on the left and the
 * status top bar. Everything not explicitly painted stays 0 (transparent on
 * the color-key shell surface), so the app viewport shows through.
 */
export class ShellChromeLayer implements Layer {
  // First sidebar row shown; adjusted each paint to keep the selection visible.
  private scrollRow = 0;

  constructor(private readonly getState: () => ShellChromeState) {}

  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const state = this.getState();
    this.drawSidebar(image, state);
    this.drawTopBar(image, state);
    return image;
  }

  handleInput(): void {
    // Shell input is handled by the shell state machine before it reaches the
    // layer stack; the chrome itself never consumes events.
  }

  private drawSidebar(image: GrayImage, state: ShellChromeState): void {
    // The sidebar always occupies the min-height window band at the preferred
    // vertical position: it never moves when the foreground window's height
    // changes, and it lines up exactly with a min-height window's chrome.
    const bandTop = minWindowTop();
    const bandBottom = bandTop + MIN_WINDOW_HEIGHT;
    image.fillRect(0, bandTop, SIDEBAR_WIDTH, MIN_WINDOW_HEIGHT, SHELL_OPAQUE_BLACK);

    // Scroll the icon list to keep the selection visible; chevrons mark
    // windows off-screen above/below. Icons fill the right column top to
    // bottom, then overflow into the left one, so a visible slot's column is
    // decided by its position within the scrolled window.
    const count = state.windows.length;
    const variant = sidebarVariant(count);
    const iconSize = variant.iconSize;
    const iconMarginX = ((variant.columnWidth - iconSize) / 2) | 0;
    // Column index of the rightmost column (the one that fills first).
    const firstColumn = variant.columns - 1;
    const listTop = bandTop + TOP_BAR_HEIGHT + LIST_MARGIN;
    const itemStride = iconSize + ICON_SPACING;
    const rows = rowsPerColumn(variant);
    const visibleCount = rows * variant.columns;
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, state.selectedIndex, visibleCount, count);
    const lastVisible = Math.min(count, this.scrollRow + visibleCount);
    const slotOf = (index: number) => {
      const position = index - this.scrollRow;
      const columnsFromRight = (position / rows) | 0;
      return {
        column: firstColumn - columnsFromRight,
        y: listTop + (position % rows) * itemStride,
      };
    };

    // The selection is a "diversion" of the sidebar/main separator line: the
    // line bulges right around the selected icon (rounded on the left, open
    // to the main area on the right), so the separator is drawn with a gap
    // there. When the sidebar has focus, the diversion is filled white and
    // the icon drawn inverted. Only the right column touches the separator;
    // a selected overflow icon gets a self-contained box instead.
    const sep = SIDEBAR_WIDTH - 1;
    const selVisible = state.selectedIndex >= this.scrollRow && state.selectedIndex < lastVisible;
    const selSlot = selVisible ? slotOf(state.selectedIndex) : null;
    const selTabTop = selSlot && selSlot.column === firstColumn ? selSlot.y - 2 : null;
    if (selTabTop !== null) {
      image.drawLine(sep, bandTop, sep, selTabTop, BORDER_VALUE);
      image.drawLine(sep, selTabTop + iconSize + 4, sep, bandBottom - 1, BORDER_VALUE);
    } else {
      image.drawLine(sep, bandTop, sep, bandBottom - 1, BORDER_VALUE);
    }

    for (let index = this.scrollRow; index < lastVisible; index++) {
      const window = state.windows[index]!;
      const { column, y } = slotOf(index);
      const left = columnLeft(variant, column);
      const x = left + iconMarginX;
      const selected = index === state.selectedIndex;
      const focused = selected && state.focus === "sidebar";
      if (selected && column === firstColumn) {
        drawSelectionTab(image, left, y - 2, y + iconSize + 2, focused);
      } else if (selected) {
        // Spans the full column: only 2px of margin flanks the icon in its
        // slot, so anything wider would clip at the screen edge.
        drawSelectionBox(image, left, y - 2, variant.columnWidth, iconSize + 4, focused);
      }
      window.drawIcon(image, x, y, iconSize, focused);
      if (window.attention) {
        // Black dot on the white focused tab, white dot otherwise.
        image.fillRoundedRect(x + iconSize - 7, y - 1, 8, 8, focused ? SHELL_OPAQUE_BLACK : 255, 4);
      }
    }

    // Chevrons center over the icon area, which in the one-column variant is
    // narrower than the sidebar strip.
    const chevronX = ((columnLeft(variant, 0) + SIDEBAR_WIDTH) / 2) | 0;
    if (this.scrollRow > 0) {
      drawChevron(image, chevronX, bandTop + TOP_BAR_HEIGHT + 6, -1);
    }
    if (lastVisible < count) {
      drawChevron(image, chevronX, bandBottom - 6, 1);
    }
  }

  private drawTopBar(image: GrayImage, state: ShellChromeState): void {
    const font = getDefaultMediumFont();
    // The bar sits at the top edge of the foreground window's band, wherever
    // its height mode puts that (screen top for max height). It moves when
    // the foreground switches to a window of a different height.
    const barTop = windowTop(state.foregroundHeightMode);
    image.fillRect(SIDEBAR_WIDTH, barTop, G2_LENS_WIDTH - SIDEBAR_WIDTH, TOP_BAR_HEIGHT, SHELL_OPAQUE_BLACK);
    image.drawLine(SIDEBAR_WIDTH, barTop + TOP_BAR_HEIGHT - 1, G2_LENS_WIDTH - 1, barTop + TOP_BAR_HEIGHT - 1, BORDER_VALUE);

    const now = new Date();
    const clock = `${WEEKDAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]} ` +
      formatClockTime(now);
    const clockX = SIDEBAR_WIDTH + 10;
    const textY = barTop + Math.max(0, ((TOP_BAR_HEIGHT - font.lineHeight) / 2) | 0);
    image.drawText(font, clockX, textY, clock, 210);

    const batteryLeft = this.drawTopBarBatteries(image, state, barTop);
    const trayLeft = drawTrayIcons(image, state.trayIcons, batteryLeft, barTop);

    const iconsX = clockX + font.measureText(clock) + 16;
    const maxIcons = Math.max(0, ((trayLeft - 8 - iconsX) / (NOTIFICATION_ICON_SIZE + 4)) | 0);
    if (maxIcons > 0) {
      const { icons, stale } = readActiveNotificationIcons(maxIcons, renderPassAllowsStaleData());
      if (stale) {
        noteStaleDataUsed();
      }
      const iconY = barTop + (((TOP_BAR_HEIGHT - NOTIFICATION_ICON_SIZE) / 2) | 0);
      for (let index = 0; index < icons.length; index++) {
        image.bitBlt(icons[index]!, iconsX + index * (NOTIFICATION_ICON_SIZE + 4), iconY, {
          transparentZero: true,
        });
      }
    }
  }

  /**
   * Labelled battery indicators for the phone and the G2, right-aligned in
   * the top bar, following the dashboard card's icon/percentage setting.
   * Returns the left edge of the battery block.
   */
  private drawTopBarBatteries(image: GrayImage, state: ShellChromeState, barTop: number): number {
    const font = getDefaultSmallFont();
    const percentageMode = batteryDisplayModeSetting.get() === "percentage";
    type BatteryItem = { label: string; percent: number; charging: boolean };
    const items: BatteryItem[] = [];
    const phone = readPhoneBatteryState();
    if (phone.battery !== null && Number.isFinite(phone.battery)) {
      items.push({ label: "Phone", percent: phone.battery, charging: Boolean(phone.charging) });
    }
    if (state.battery.headset !== null && Number.isFinite(state.battery.headset)) {
      items.push({ label: "G2", percent: state.battery.headset, charging: Boolean(state.battery.headsetCharging) });
    }
    if (!items.length) return G2_LENS_WIDTH;

    const labelGap = 5;
    const itemGap = 12;
    const textY = barTop + Math.max(0, ((TOP_BAR_HEIGHT - font.lineHeight) / 2) | 0);
    let x = G2_LENS_WIDTH - 8;
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      const percentText = `${Math.max(0, Math.min(100, Math.round(item.percent)))}%`;
      const valueWidth = percentageMode ? font.measureText(percentText) : BATTERY_ICON_WIDTH;
      const labelWidth = font.measureText(item.label);
      x -= labelWidth + labelGap + valueWidth;
      image.drawText(font, x, textY, item.label, 150);
      const valueX = x + labelWidth + labelGap;
      if (percentageMode) {
        if (item.charging) {
          // Inverted text marks charging, matching the dashboard card.
          image.fillRect(valueX - 2, textY - 1, valueWidth + 4, font.lineHeight + 2, 255);
          image.drawText(font, valueX, textY, percentText, 1);
        } else {
          image.drawText(font, valueX, textY, percentText, 200);
        }
      } else {
        const icon = drawBattery(item.percent, item.charging);
        image.bitBlt(icon, valueX, barTop + Math.max(0, ((TOP_BAR_HEIGHT - icon.height) / 2) | 0), {
          transparentZero: true,
        });
      }
      x -= itemGap;
    }
    return x + itemGap;
  }
}

/**
 * Draw app tray icons right-to-left, ending just left of the battery block;
 * returns the left edge of the tray region.
 */
function drawTrayIcons(image: GrayImage, trayIcons: GrayImage[], rightEdge: number, barTop: number): number {
  let x = rightEdge;
  for (let index = trayIcons.length - 1; index >= 0; index--) {
    const icon = trayIcons[index]!;
    x -= icon.width + 10;
    image.bitBlt(icon, x, barTop + Math.max(0, ((TOP_BAR_HEIGHT - icon.height) / 2) | 0), {
      transparentZero: true,
    });
  }
  return x;
}

const TAB_RADIUS = 6;
// How far the diversion pokes past the separator into the main area.
const TAB_EXTEND = 1;
const TAB_STROKE = 150;

/**
 * Draw the selection "diversion" of the separator line around a sidebar icon
 * in the rightmost column: rounded on the left, square and open on the right,
 * extending a few px past the separator into the main area. Focused = filled
 * white; otherwise an outline. `left` is the column's left edge, which the
 * rounded corners curve in from.
 */
function drawSelectionTab(image: GrayImage, left: number, top: number, bottom: number, focused: boolean): void {
  const right = SIDEBAR_WIDTH - 1 + TAB_EXTEND;
  if (focused) {
    for (let yy = top; yy < bottom; yy++) {
      const x = left + tabLeftInset(yy, top, bottom, TAB_RADIUS);
      image.fillRect(x, yy, right - x + 1, 1, 255);
    }
    return;
  }
  // Outline: curved left edge (per-row) plus straight top and bottom edges.
  for (let yy = top; yy < bottom; yy++) {
    image.setPixel(left + tabLeftInset(yy, top, bottom, TAB_RADIUS), yy, TAB_STROKE);
  }
  image.drawLine(left + tabLeftInset(top, top, bottom-1, TAB_RADIUS), top, right, top, TAB_STROKE);
  image.drawLine(left + tabLeftInset(bottom-1, top, bottom-1, TAB_RADIUS), bottom-1, right, bottom-1, TAB_STROKE);
}

/**
 * Selection marker for an overflow-column icon, which has no separator to
 * divert: a self-contained rounded box, filled white when the sidebar has
 * focus and outlined otherwise (matching the tab's two states).
 */
function drawSelectionBox(image: GrayImage, x: number, y: number, width: number, height: number, focused: boolean): void {
  if (focused) {
    image.fillRoundedRect(x, y, width, height, 255, TAB_RADIUS);
  } else {
    image.drawRoundedRect(x, y, width, height, TAB_STROKE, TAB_RADIUS);
  }
}

/** Left boundary x of the tab at row yy: 0 in the middle, curving to the rounded left corners. */
function tabLeftInset(yy: number, top: number, bottom: number, radius: number): number {
  const cy = yy + 0.5;
  let dy = 0;
  if (cy < top + radius) {
    dy = top + radius - cy;
  } else if (cy > bottom - radius) {
    dy = cy - (bottom - radius);
  } else {
    return 0;
  }
  return Math.max(0, Math.round(radius - Math.sqrt(Math.max(0, radius * radius - dy * dy))));
}

/** Format the top-bar clock time, honoring the 12/24-hour setting. */
function formatClockTime(now: Date): string {
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const hour24 = now.getHours();
  if (timeFormatSetting.get() === "12h") {
    const hour12 = ((hour24 + 11) % 12) + 1;
    return `${hour12}:${minutes} ${hour24 < 12 ? "AM" : "PM"}`;
  }
  return `${hour24}:${minutes}`;
}

/** Small triangle marker for sidebar overflow; direction -1 = up, 1 = down. */
function drawChevron(image: GrayImage, centerX: number, y: number, direction: -1 | 1): void {
  const half = 5;
  const tipY = direction < 0 ? y - 3 : y + 3;
  image.drawLine(centerX - half, y, centerX, tipY, 140);
  image.drawLine(centerX, tipY, centerX + half, y, 140);
}
