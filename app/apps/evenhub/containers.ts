/**
 * EvenHub page-container model and lenient JSON parsing.
 *
 * Hosts and apps in the wild emit both camelCase and protobuf names
 * (Container_ID), and numbers sometimes arrive as strings, so all field
 * reads go through loose key matching (the SDK's pickLoose behavior).
 */

export type EvenHubTextContainer = {
  kind: "text";
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  borderWidth: number;
  borderRadius: number;
  paddingLength: number;
  isEventCapture: boolean;
  zOrderIndex: number | undefined;
  content: string;
};

export type EvenHubImageContainer = {
  kind: "image";
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrderIndex: number | undefined;
  /** Decoded 8bpp grayscale, set by updateImageRawData; null until first update. */
  pixels: Uint8Array | null;
  pixelsWidth: number;
  pixelsHeight: number;
};

export type EvenHubListContainer = {
  kind: "list";
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  borderWidth: number;
  borderRadius: number;
  paddingLength: number;
  isEventCapture: boolean;
  zOrderIndex: number | undefined;
  itemNames: string[];
  itemWidth: number;
  selectBorder: boolean;
  /** Selection is host-local: scroll moves it with no app round-trip. */
  selectedIndex: number;
};

export type EvenHubContainer = EvenHubTextContainer | EvenHubImageContainer | EvenHubListContainer;

export type EvenHubPage = {
  /** In declaration order (lists, images, texts); z-sorted at paint time. */
  containers: EvenHubContainer[];
};

function normalizeKey(key: string): string {
  return key.replace(/_/g, "").toLowerCase();
}

function pickLoose(obj: Record<string, unknown>, key: string): unknown {
  if (key in obj) return obj[key];
  const wanted = normalizeKey(key);
  for (const k of Object.keys(obj)) {
    if (normalizeKey(k) === wanted) return obj[k];
  }
  return undefined;
}

export function readNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
  const value = pickLoose(obj, key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function readOptionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = readNumber(obj, key, Number.NaN);
  return Number.isNaN(value) ? undefined : value;
}

export function readString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const value = pickLoose(obj, key);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseTextContainer(json: Record<string, unknown>): EvenHubTextContainer {
  return {
    kind: "text",
    id: readNumber(json, "containerID", 0),
    name: readString(json, "containerName", ""),
    x: readNumber(json, "xPosition", 0),
    y: readNumber(json, "yPosition", 0),
    width: readNumber(json, "width", 0),
    height: readNumber(json, "height", 0),
    borderWidth: readNumber(json, "borderWidth", 0),
    borderRadius: readNumber(json, "borderRadius", 0),
    paddingLength: readNumber(json, "paddingLength", 0),
    isEventCapture: readNumber(json, "isEventCapture", 0) !== 0,
    zOrderIndex: readOptionalNumber(json, "zOrderIndex"),
    content: readString(json, "content", ""),
  };
}

function parseImageContainer(json: Record<string, unknown>): EvenHubImageContainer {
  return {
    kind: "image",
    id: readNumber(json, "containerID", 0),
    name: readString(json, "containerName", ""),
    x: readNumber(json, "xPosition", 0),
    y: readNumber(json, "yPosition", 0),
    width: readNumber(json, "width", 0),
    height: readNumber(json, "height", 0),
    zOrderIndex: readOptionalNumber(json, "zOrderIndex"),
    pixels: null,
    pixelsWidth: 0,
    pixelsHeight: 0,
  };
}

function parseListContainer(json: Record<string, unknown>): EvenHubListContainer {
  const itemContainer = asRecord(pickLoose(json, "itemContainer"));
  const itemNamesRaw = pickLoose(itemContainer, "itemName");
  const itemNames = Array.isArray(itemNamesRaw) ? itemNamesRaw.map(String) : [];
  return {
    kind: "list",
    id: readNumber(json, "containerID", 0),
    name: readString(json, "containerName", ""),
    x: readNumber(json, "xPosition", 0),
    y: readNumber(json, "yPosition", 0),
    width: readNumber(json, "width", 0),
    height: readNumber(json, "height", 0),
    borderWidth: readNumber(json, "borderWidth", 0),
    borderRadius: readNumber(json, "borderRadius", 0),
    paddingLength: readNumber(json, "paddingLength", 0),
    isEventCapture: readNumber(json, "isEventCapture", 0) !== 0,
    zOrderIndex: readOptionalNumber(json, "zOrderIndex"),
    itemNames,
    itemWidth: readNumber(itemContainer, "itemWidth", 0),
    selectBorder: readNumber(itemContainer, "isItemSelectBorderEn", 0) !== 0,
    selectedIndex: 0,
  };
}

/**
 * Parse a CreateStartUpPageContainer / RebuildPageContainer payload into a
 * page. Containers keep declaration order within and across the three arrays
 * (lists, then images, then texts — texts last so info panels and capture
 * containers sit above image tiles when no zOrderIndex is given).
 */
export function parsePage(data: Record<string, unknown>): EvenHubPage {
  const containers: EvenHubContainer[] = [];
  const lists = pickLoose(data, "listObject");
  if (Array.isArray(lists)) {
    for (const item of lists) containers.push(parseListContainer(asRecord(item)));
  }
  const images = pickLoose(data, "imageObject");
  if (Array.isArray(images)) {
    for (const item of images) containers.push(parseImageContainer(asRecord(item)));
  }
  const texts = pickLoose(data, "textObject");
  if (Array.isArray(texts)) {
    for (const item of texts) containers.push(parseTextContainer(asRecord(item)));
  }
  return { containers };
}

/** The container that owns gesture events (exactly one per valid page). */
export function eventCaptureContainer(page: EvenHubPage): EvenHubContainer | undefined {
  return page.containers.find(
    (container) => container.kind !== "image" && container.isEventCapture,
  );
}
