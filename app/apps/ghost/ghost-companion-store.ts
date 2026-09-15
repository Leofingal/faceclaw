/**
 * What Ghost is currently showing on the glasses, published for the phone.
 *
 * The phone's companion screen is a SECOND VIEW OF THE SAME SESSION, not a
 * second client of it. GhostLayer already polls the box every three seconds
 * while its window is open; adding a phone-side poll would double the traffic
 * and let the two surfaces disagree about which item is current. So the layer
 * publishes here on every render and the phone subscribes — one poll, one
 * truth, and the phone shows exactly the feed the lens is showing.
 *
 * Ghost's window is in-process (index.ts launches it with launchInProcessApp),
 * so this module singleton is genuinely shared with the phone UI. A worker-
 * hosted app could not use this as-is; see the return doc.
 */
import { type GhostItem } from "./ghost-client";
import { parseGhostTimestamp } from "../exocortex/status-line";

export type GhostCompanionState = {
  /** True while Ghost's window exists on the glasses. */
  open: boolean;
  items: GhostItem[];
  /** Which item the lens has under its cursor; -1 when the feed is empty. */
  cursor: number;
  /**
   * Non-empty exactly when the feed is unhealthy, carrying the same sentence
   * the lens shows ("cannot reach the box", "token rejected", ...). The phone
   * repeats it rather than inventing its own wording for the same failure.
   */
  status: string;
  sessionId: string;
};

const EMPTY: GhostCompanionState = {
  open: false,
  items: [],
  cursor: -1,
  status: "",
  sessionId: "",
};

let current: GhostCompanionState = EMPTY;
let listeners: Array<(state: GhostCompanionState) => void> = [];

/**
 * When Ghost's newest message arrived — the home screen's menu row.
 *
 * ⚠ DELIBERATELY NOT PART OF `GhostCompanionState`, because that state is
 * cleared when the window closes and this must not be. The menu row exists
 * precisely for the moments Ghost is NOT open; a "last message" that vanished
 * the moment you left the app would be a row that is blank whenever anyone
 * could read it.
 *
 * In memory only. It does not survive a process restart, and the row is bare
 * until the next poll — a settings write on every three-second poll would be
 * the wrong trade for a line that is back within seconds of opening Ghost.
 */
let lastMessageMs: number | null = null;
/** The newest item's id as last seen, so an arrival can be told from a repaint. */
let lastItemUuid = "";

export function ghostLastMessageMs(): number | null {
  return lastMessageMs;
}

/**
 * Note the arrival time of the newest item, if it is new.
 *
 * Prefers the box's own `ts`. Falls back to the wall clock when the feed
 * carries none — `GhostItem.ts` is optional in the wire type, and a row that
 * said nothing whenever the box omitted a field would be a puzzle to debug
 * from the glasses. The fallback is only taken when the newest item's uuid
 * has actually CHANGED, so a repaint of the same feed never makes an old
 * message look like it just landed.
 */
function noteNewestItem(items: readonly GhostItem[]): void {
  const newest = items.length ? items[items.length - 1] : null;
  if (!newest) return;
  const stamped = parseGhostTimestamp(newest.ts);
  if (stamped !== null) {
    if (lastMessageMs === null || stamped > lastMessageMs) lastMessageMs = stamped;
  } else if (newest.uuid !== lastItemUuid) {
    lastMessageMs = Date.now();
  }
  lastItemUuid = newest.uuid;
}

export function ghostCompanionState(): GhostCompanionState {
  return current;
}

export function onGhostCompanionChanged(
  listener: (state: GhostCompanionState) => void,
): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

/**
 * Publish a partial update. Called from the layer's render path, which fires
 * on every interim dictation transcript, so an unchanged state must not wake
 * the phone: `items` is compared by identity (the layer swaps the array
 * wholesale on each poll, never mutates it in place).
 */
export function publishGhostCompanion(patch: Partial<GhostCompanionState>): void {
  const next: GhostCompanionState = { ...current, ...patch };
  if (
    next.open === current.open &&
    next.items === current.items &&
    next.cursor === current.cursor &&
    next.status === current.status &&
    next.sessionId === current.sessionId
  ) {
    return;
  }
  current = next;
  // After the identity guard: an unchanged feed cannot have a new newest
  // item, so this runs only when something actually moved.
  noteNewestItem(next.items);
  for (const listener of listeners.slice()) {
    listener(next);
  }
}

/**
 * The window closed: drop the feed rather than leave a frozen one on the
 * phone. `lastMessageMs` deliberately survives this — see its declaration.
 */
export function clearGhostCompanion(): void {
  publishGhostCompanion({ open: false, items: [], cursor: -1, status: "", sessionId: "" });
}
