/**
 * The home screen's right-hand status lines: their FORMATTING and their FIT
 * RULE, and none of their plumbing.
 *
 * ## Why this is its own file
 *
 * The same split `health/health-glance.ts` makes against
 * `apps/health/health-app.ts`: nothing here imports NativeScript, reads a
 * store, or reaches for a clock (every function that needs the time takes it
 * as an argument). So `tools/menu-preview.cjs` renders real rows under plain
 * node, and `tests/exocortex-status-line.test.cjs` pins the rules that are
 * easy to get quietly wrong — the truncation boundary and the null cases.
 *
 * ## The contract these serve (Chris, session 0155)
 *
 * An app answers for its own row, and the answer has to be **cheap and
 * synchronous**, because it is produced inside the glasses menu's paint path.
 * Anything expensive belongs in the app's `refreshStatus()`, on the shared
 * `util/aligned-tick.ts` :01/:31 tick, whose result these functions then
 * format.
 *
 * ## Degrade to nothing
 *
 * Every formatter returns `null` rather than a placeholder, and the painter
 * draws nothing at all for a `null`. There is deliberately no "--", no "n/a"
 * and no empty column: an app with no data has a row that looks exactly as it
 * did before this feature existed. That is the property
 * `tools/menu-preview.cjs` asserts by rendering the whole menu with every
 * line null and comparing the pixels.
 */

/**
 * What the fit rule needs from a font.
 *
 * Structural rather than `UiFont` so a test can pass a stub with predictable
 * metrics — and so this file needs no import from `graphics/`.
 */
export type MeasureFont = {
  measureText(text: string): number;
};

/**
 * Narrowest status worth drawing, in pixels.
 *
 * Below this a status is dropped whole rather than shown as an ellipsis with
 * a character or two in front of it, which reads as damage rather than as
 * information. Roughly four characters at the 12px default.
 */
export const MIN_STATUS_WIDTH = 28;

/** Clear space between the app's name and its status. */
export const STATUS_GAP = 12;

export type RowStatusLayout = {
  /** The text to draw, already truncated to fit. */
  text: string;
  /** Left edge to draw it at; the status is right-aligned in the row. */
  x: number;
};

export type RowStatusOptions = {
  /** The label AS DRAWN — already truncated by the caller, if it had to be. */
  label: string;
  /** Whatever the app's `statusLine()` returned. */
  status: string | null;
  /** Left edge of the label. */
  textX: number;
  /** Right edge of the row's text area. */
  rowRight: number;
  gap?: number;
  minWidth?: number;
};

/**
 * Place a row's status, or decide there is no room for one.
 *
 * ⚠ THE NAME IS NEVER SHORTENED TO MAKE ROOM. The label arrives already laid
 * out against the full row width, exactly as it was before status lines
 * existed, and the status gets only what is left over. A long app name
 * therefore costs its own status line and nothing else — no row changes
 * height, no name loses characters it used to keep. Chris's instruction:
 * "if a line doesn't fit the width, shorten or drop the status, not the name."
 *
 * Returns `null` when there is no status, or not enough room for a legible
 * one.
 */
export function layoutRowStatus(font: MeasureFont, options: RowStatusOptions): RowStatusLayout | null {
  const status = (options.status ?? "").trim();
  if (!status) return null;

  const gap = options.gap ?? STATUS_GAP;
  const minWidth = options.minWidth ?? MIN_STATUS_WIDTH;
  const labelEnd = options.textX + font.measureText(options.label);
  const available = options.rowRight - labelEnd - gap;
  if (available < minWidth) return null;

  const text = truncateStatus(font, status, available);
  if (!text) return null;
  return { text, x: options.rowRight - font.measureText(text) };
}

/**
 * Trim a status to `maxWidth`, or give up.
 *
 * Mirrors `graphics/textwrap.ts`'s `truncateText` deliberately rather than
 * importing it: that function's `WrapFont` also demands `getGlyph`, which
 * would drag this file's test stubs (and this file) into the graphics layer
 * for no gain. The one behavioural difference is the last line — where
 * `truncateText` will return a bare "..." that does not fit, this returns ""
 * so the caller drops the status entirely.
 */
function truncateStatus(font: MeasureFont, text: string, maxWidth: number): string {
  if (font.measureText(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.measureText(`${out}...`) > maxWidth) {
    out = out.slice(0, -1);
  }
  const trimmed = `${out}...`;
  return font.measureText(trimmed) <= maxWidth ? trimmed : "";
}

// ===========================================================================
// The formatters
//
// One per app with a line. Each takes plain data and returns the string the
// row should show, or null. No clocks, no stores: the caller supplies both.

/**
 * Health: today's step count, e.g. `8,432 steps`.
 *
 * `null` means "no figure to show" and is NOT the same as zero — a store that
 * has never been read returns null and the row stays bare, while a genuine
 * zero on a day that has only just started reads as "0 steps", which is
 * information.
 */
export function formatStepsStatus(steps: number | null): string | null {
  if (steps === null || !Number.isFinite(steps) || steps < 0) return null;
  return `${groupDigits(Math.round(steps))} steps`;
}

/**
 * Thousands separators, computed rather than delegated to `toLocaleString`.
 *
 * The glance page uses `toLocaleString`, which is right there — it is
 * formatting for a human on one device. Here the same string is asserted in
 * tests and rendered by a preview tool on a different machine, so a
 * locale-dependent separator would make those two disagree with the phone for
 * reasons that have nothing to do with this feature.
 */
export function groupDigits(value: number): string {
  const negative = value < 0;
  const digits = Math.abs(Math.round(value)).toString();
  let out = "";
  for (let index = 0; index < digits.length; index++) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ",";
    out += digits[index];
  }
  return negative ? `-${out}` : out;
}

export type WeatherStatusInput = {
  temperatureF: number | null;
  description: string;
  /** Today's chance of precipitation, from the current forecast period. */
  precipitationPercent: number | null;
  /** When the bridge last succeeded; null when it never has. */
  lastUpdatedMs: number | null;
};

/**
 * How stale a cached forecast may be and still be shown.
 *
 * ⚠ A JUDGMENT CALL, not a spec. The weather bridge only refreshes while its
 * app is open or on the aligned tick, so without a bound the row could show
 * yesterday's afternoon as though it were now — and a wrong weather line is
 * worse than no weather line, because nothing on the row says how old it is.
 * Six hours keeps a morning reading useful through lunch and drops it before
 * it can describe a different day.
 */
export const WEATHER_STATUS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Weather: today's line, e.g. `72F 0% Sunny` — Chris's own example.
 *
 * Cache only. This never triggers a fetch; `refreshStatus()` does that on the
 * aligned tick.
 */
export function formatWeatherStatus(input: WeatherStatusInput | null, nowMs: number): string | null {
  if (!input) return null;
  if (input.lastUpdatedMs === null || !Number.isFinite(input.lastUpdatedMs)) return null;
  if (nowMs - input.lastUpdatedMs > WEATHER_STATUS_MAX_AGE_MS) return null;

  const parts: string[] = [];
  if (input.temperatureF !== null && Number.isFinite(input.temperatureF)) {
    parts.push(`${Math.round(input.temperatureF)}F`);
  }
  if (input.precipitationPercent !== null && Number.isFinite(input.precipitationPercent)) {
    parts.push(`${Math.round(input.precipitationPercent)}%`);
  }
  // The NWS phrase, verbatim. Shortening it here would mean inventing a
  // synonym table ("Mostly Sunny" -> "Sunny"?) that nobody asked for and that
  // would quietly disagree with the weather app's own wording; the fit rule
  // above already handles a long one by trimming it.
  const description = input.description.trim();
  if (description) parts.push(description);

  return parts.length ? parts.join(" ") : null;
}

/**
 * Ghost: how long ago its last message arrived, e.g. `12m ago`.
 *
 * Needs no fetch at all — Chris's point when he named it. The ladder matches
 * `util/date-util.ts`'s `formatRelativeTime` so the home screen and the
 * notification meta line age things the same way; it is restated here with
 * "ago" and with the clock passed in, because that function reads
 * `Date.now()` itself and this file does not.
 */
export function formatGhostStatus(lastMessageMs: number | null, nowMs: number): string | null {
  if (lastMessageMs === null || !Number.isFinite(lastMessageMs) || lastMessageMs <= 0) return null;
  const minutes = Math.floor(Math.max(0, nowMs - lastMessageMs) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * A `GhostItem.ts` as milliseconds, or null.
 *
 * The box emits it as `string | number | undefined` (see
 * `apps/ghost/ghost-client.ts`), so all three shapes are handled here rather
 * than at the call site. A bare number below 1e12 is read as SECONDS — that
 * boundary is the year 2001 in milliseconds and the year 33658 in seconds, so
 * no real timestamp is ambiguous.
 */
export function parseGhostTimestamp(ts: string | number | undefined | null): number | null {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === "number") {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts);
  }
  const text = ts.trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
