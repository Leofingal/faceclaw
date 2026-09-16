/**
 * The shell's top bar: clock on the left, notification icons after it, app
 * tray icons, then the battery block right-aligned (Ph, G2, R1).
 *
 * Split out of chrome-layer.ts (2026-09-16, for the ring battery) so it
 * imports nothing from NativeScript. The chrome layer reads the settings, the
 * phone battery and the notification icons and hands them in; everything
 * drawn is decided here, which is what lets tools/top-bar-preview.cjs render
 * the real bar under plain node.
 */
import { BATTERY_ICON_WIDTH, drawBattery } from "../../graphics/battery";
import { G2_LENS_WIDTH, GrayImage, type UiFont } from "../../graphics/image";

/** Top bar: 24px notification icons plus a little padding. */
export const TOP_BAR_HEIGHT = 28;

/**
 * On the color-key shell surface, pixel value 0 is transparent; 1 is the
 * darkest opaque shade (identical to 0 after 4bpp quantization). Shell
 * painting must use this for intentional black.
 */
export const SHELL_OPAQUE_BLACK = 1;

/** The bar's bottom rule and the sidebar separator. */
export const BORDER_VALUE = 40;

export const NOTIFICATION_ICON_SIZE = 24;

const LABEL_INK = 150;
const VALUE_INK = 200;
/** A stale reading keeps its place but draws at this ink, label and value alike. */
const STALE_INK = 80;
/** Stale battery icons are scaled to this fraction of their normal ink. */
const STALE_ICON_SCALE = 0.45;

/**
 * A ring reading older than this is drawn stale. The ring answers a 00:01 on
 * every connect and at each :01/:31 pull, and pushes 00:7F hourly, so a
 * reading this old means the link has been down for most of that time.
 */
export const RING_BATTERY_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Item labels, kept short to save bar width (Chris, 2026-09-16): "Ph" for the
 * phone (was "Phone"), "G2" for the glasses, "R1" for the ring.
 */
export const PHONE_LABEL = "Ph";
export const GLASSES_LABEL = "G2";
export const RING_LABEL = "R1";

/** Latest ring battery, as the communicator reports it (see RingBatteryState). */
export type RingBatteryReading = {
  level: number;
  charging: boolean;
  atMs: number;
};

/** What the shell knows about the glasses and ring batteries. */
export type TopBarBatteryLevels = {
  headset: number | null;
  headsetCharging: boolean | null;
  ring: RingBatteryReading | null;
};

export type TopBarBatteryItem = {
  label: string;
  percent: number;
  charging: boolean;
  /** Drawn dimmed, never with the charging mark. */
  stale: boolean;
};

/**
 * The ring's top-bar item, or null when nothing should be drawn: no reading
 * yet, or a level outside 0..100 (the byte is sent as 0..255 and has only
 * ever been a percentage). Past RING_BATTERY_STALE_MS the item is stale, and a
 * stale item never shows charging: the charger state is the part of an old
 * reading most likely to have changed.
 */
export function ringBatteryItem(reading: RingBatteryReading | null | undefined, nowMs: number): TopBarBatteryItem | null {
  if (!reading) return null;
  const level = Number(reading.level);
  const atMs = Number(reading.atMs);
  if (!Number.isInteger(level) || level < 0 || level > 100 || !Number.isFinite(atMs)) return null;
  const stale = nowMs - atMs > RING_BATTERY_STALE_MS;
  return { label: RING_LABEL, percent: level, charging: !stale && Boolean(reading.charging), stale };
}

/** The battery block's items, left to right: Ph, G2, R1; each only when known. */
export function topBarBatteryItems(
  phone: { battery: number | null; charging: boolean | null },
  levels: TopBarBatteryLevels,
  nowMs: number,
): TopBarBatteryItem[] {
  const items: TopBarBatteryItem[] = [];
  if (phone.battery !== null && Number.isFinite(phone.battery)) {
    items.push({ label: PHONE_LABEL, percent: phone.battery, charging: Boolean(phone.charging), stale: false });
  }
  if (levels.headset !== null && Number.isFinite(levels.headset)) {
    items.push({ label: GLASSES_LABEL, percent: levels.headset, charging: Boolean(levels.headsetCharging), stale: false });
  }
  const ring = ringBatteryItem(levels.ring, nowMs);
  if (ring) items.push(ring);
  return items;
}

/**
 * Whether replacing one ring reading with another changes what the bar draws.
 * The ring pushes a 00:01 about every 30 s while charging; only a change in
 * level, charging or staleness is worth a repaint.
 */
export function ringBatteryDisplayChanged(
  previous: RingBatteryReading | null | undefined,
  next: RingBatteryReading | null | undefined,
  nowMs: number,
): boolean {
  const before = ringBatteryItem(previous, nowMs);
  const after = ringBatteryItem(next, nowMs);
  if (before === null || after === null) return before !== after;
  return before.percent !== after.percent || before.charging !== after.charging || before.stale !== after.stale;
}

export type TopBarPaint = {
  /** Left edge of the bar (past the sidebar strip while it overlays). */
  barLeft: number;
  /** Top edge of the bar: the foreground window band's top. */
  barTop: number;
  clockText: string;
  clockFont: UiFont;
  batteryFont: UiFont;
  /** Battery display setting: exact percentage rather than the gauge icon. */
  percentageMode: boolean;
  batteries: readonly TopBarBatteryItem[];
  trayIcons: readonly GrayImage[];
  /** Up to maxIcons notification icons; called only when at least one fits. */
  notificationIcons: (maxIcons: number) => readonly GrayImage[];
};

export function paintTopBar(image: GrayImage, paint: TopBarPaint): void {
  const font = paint.clockFont;
  const { barLeft, barTop } = paint;
  image.fillRect(barLeft, barTop, G2_LENS_WIDTH - barLeft, TOP_BAR_HEIGHT, SHELL_OPAQUE_BLACK);
  image.drawLine(barLeft, barTop + TOP_BAR_HEIGHT - 1, G2_LENS_WIDTH - 1, barTop + TOP_BAR_HEIGHT - 1, BORDER_VALUE);

  const clockX = barLeft + 10;
  const textY = barTop + Math.max(0, ((TOP_BAR_HEIGHT - font.lineHeight) / 2) | 0);
  image.drawText(font, clockX, textY, paint.clockText, 210);

  const batteryLeft = drawTopBarBatteries(image, paint.batteryFont, paint.batteries, barTop, paint.percentageMode);
  const trayLeft = drawTrayIcons(image, paint.trayIcons, batteryLeft, barTop);

  const iconsX = clockX + font.measureText(paint.clockText) + 16;
  const maxIcons = Math.max(0, ((trayLeft - 8 - iconsX) / (NOTIFICATION_ICON_SIZE + 4)) | 0);
  if (maxIcons > 0) {
    const icons = paint.notificationIcons(maxIcons);
    const iconY = barTop + (((TOP_BAR_HEIGHT - NOTIFICATION_ICON_SIZE) / 2) | 0);
    for (let index = 0; index < icons.length; index++) {
      image.drawImage(icons[index]!, iconsX + index * (NOTIFICATION_ICON_SIZE + 4), iconY);
    }
  }
}

/**
 * Labelled battery indicators, right-aligned in the top bar, following the
 * dashboard card's icon/percentage setting. Returns the left edge of the
 * battery block (G2_LENS_WIDTH when there are no items).
 */
export function drawTopBarBatteries(
  image: GrayImage,
  font: UiFont,
  items: readonly TopBarBatteryItem[],
  barTop: number,
  percentageMode: boolean,
): number {
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
    image.drawText(font, x, textY, item.label, item.stale ? STALE_INK : LABEL_INK);
    const valueX = x + labelWidth + labelGap;
    const charging = item.charging && !item.stale;
    if (percentageMode) {
      if (charging) {
        // Inverted text marks charging, matching the dashboard card.
        image.fillRect(valueX - 2, textY - 1, valueWidth + 4, font.lineHeight + 2, 255);
        image.drawText(font, valueX, textY, percentText, 1);
      } else {
        image.drawText(font, valueX, textY, percentText, item.stale ? STALE_INK : VALUE_INK);
      }
    } else {
      const gauge = drawBattery(item.percent, charging);
      const icon = item.stale ? scaledInk(gauge, STALE_ICON_SCALE) : gauge;
      image.bitBlt(icon, valueX, barTop + Math.max(0, ((TOP_BAR_HEIGHT - icon.height) / 2) | 0), {
        transparentZero: true,
      });
    }
    x -= itemGap;
  }
  return x + itemGap;
}

/**
 * Draw app tray icons right-to-left, ending just left of the battery block;
 * returns the left edge of the tray region.
 */
function drawTrayIcons(image: GrayImage, trayIcons: readonly GrayImage[], rightEdge: number, barTop: number): number {
  let x = rightEdge;
  for (let index = trayIcons.length - 1; index >= 0; index--) {
    const icon = trayIcons[index]!;
    x -= icon.width + 10;
    image.drawImage(icon, x, barTop + Math.max(0, ((TOP_BAR_HEIGHT - icon.height) / 2) | 0));
  }
  return x;
}

/** A copy with every lit pixel's ink scaled, never dropping a lit pixel to transparent 0. */
function scaledInk(source: GrayImage, scale: number): GrayImage {
  const out = new GrayImage(source.width, source.height, 0);
  for (let i = 0; i < source.pixels.length; i++) {
    const value = source.pixels[i]!;
    if (value > 0) out.pixels[i] = Math.max(1, Math.round(value * scale));
  }
  return out;
}
