/**
 * Phone-side reimplementation of the on-glasses EvenHub page compositor:
 * containers render into the 576x288 canvas the stock firmware gives apps.
 *
 * Known deviations from stock, acceptable for now:
 *  - Text uses Terminus 24 rather than the firmware's proportional LVGL font,
 *    so grid-aligned/padded layouts won't line up exactly (see
 *    notes/evenhub_compatibility.txt section 6 for the extraction plan).
 *  - List rendering is a plain vertical list; itemWidth-based horizontal
 *    layouts are not implemented yet.
 */
import { GrayImage } from "../../graphics/image";
import { getFont } from "../../graphics/bdffont";
import {
  type EvenHubContainer,
  type EvenHubImageContainer,
  type EvenHubListContainer,
  type EvenHubPage,
  type EvenHubTextContainer,
} from "./containers";

export const EVENHUB_SCREEN_WIDTH = 576;
export const EVENHUB_SCREEN_HEIGHT = 288;

const TEXT_WHITE = 255;
const LIST_ROW_PADDING = 4;

function containerFont() {
  return getFont("terminus24");
}

/** Chars the font lacks are skipped silently on stock (no tofu); drawText
 * already skips unknown glyphs, matching that. */
function paintTextContainer(image: GrayImage, container: EvenHubTextContainer): void {
  paintBorder(image, container);
  const inset = container.borderWidth + container.paddingLength;
  const font = containerFont();
  image.drawTextWrapped({
    font,
    x: container.x + inset,
    y: container.y + inset,
    width: Math.max(1, container.width - 2 * inset),
    text: container.content,
    value: TEXT_WHITE,
  });
}

function paintBorder(
  image: GrayImage,
  container: { x: number; y: number; width: number; height: number; borderWidth: number; borderRadius: number },
): void {
  for (let i = 0; i < container.borderWidth; i++) {
    if (container.borderRadius > 0) {
      image.drawRoundedRect(
        container.x + i,
        container.y + i,
        container.width - 2 * i,
        container.height - 2 * i,
        TEXT_WHITE,
        Math.max(0, container.borderRadius - i),
      );
    } else {
      image.drawRect(container.x + i, container.y + i, container.width - 2 * i, container.height - 2 * i, TEXT_WHITE);
    }
  }
}

function paintImageContainer(image: GrayImage, container: EvenHubImageContainer): void {
  if (!container.pixels || container.pixelsWidth <= 0 || container.pixelsHeight <= 0) return;
  const source = new GrayImage(container.pixelsWidth, container.pixelsHeight, 0);
  source.pixels.set(container.pixels);
  // Stock quirk: raw data smaller than the container tiles/repeats to fill it.
  for (let ty = 0; ty < container.height; ty += container.pixelsHeight) {
    for (let tx = 0; tx < container.width; tx += container.pixelsWidth) {
      image.bitBlt(source, container.x + tx, container.y + ty, {
        width: Math.min(container.pixelsWidth, container.width - tx),
        height: Math.min(container.pixelsHeight, container.height - ty),
      });
    }
  }
}

function paintListContainer(image: GrayImage, container: EvenHubListContainer, focused: boolean): void {
  paintBorder(image, container);
  const font = containerFont();
  const inset = container.borderWidth + container.paddingLength;
  const rowHeight = font.lineHeight + LIST_ROW_PADDING;
  const left = container.x + inset;
  const top = container.y + inset;
  const width = Math.max(1, container.width - 2 * inset);
  const visibleRows = Math.max(1, Math.floor((container.height - 2 * inset) / rowHeight));
  // Keep the selection in view.
  let firstRow = 0;
  if (container.selectedIndex >= visibleRows) firstRow = container.selectedIndex - visibleRows + 1;
  for (let row = 0; row < visibleRows; row++) {
    const index = firstRow + row;
    if (index >= container.itemNames.length) break;
    const y = top + row * rowHeight;
    const selected = index === container.selectedIndex;
    if (selected && focused) {
      image.fillRect(left, y, width, rowHeight - 1, 40);
    }
    if (selected && container.selectBorder) {
      image.drawRect(left, y, width, rowHeight - 1, TEXT_WHITE);
    }
    image.drawText(font, left + 2, y + Math.floor(LIST_ROW_PADDING / 2), container.itemNames[index]!, TEXT_WHITE);
  }
}

/** Containers with a zOrderIndex sort by it; the rest keep declaration order. */
function paintOrder(containers: EvenHubContainer[]): EvenHubContainer[] {
  const anyZ = containers.some((c) => c.zOrderIndex !== undefined);
  if (!anyZ) return containers;
  return [...containers].sort((a, b) => (a.zOrderIndex ?? 0) - (b.zOrderIndex ?? 0));
}

/** Render a page into a fresh app-viewport image (positioned by the shell). */
export function compositePage(page: EvenHubPage | null, size: { width: number; height: number }, focused: boolean): GrayImage {
  const image = new GrayImage(size.width, size.height, 0);
  if (!page) return image;
  for (const container of paintOrder(page.containers)) {
    switch (container.kind) {
      case "image":
        paintImageContainer(image, container);
        break;
      case "text":
        paintTextContainer(image, container);
        break;
      case "list":
        paintListContainer(image, container, focused);
        break;
    }
  }
  return image;
}
