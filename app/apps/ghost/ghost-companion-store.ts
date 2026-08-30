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
  for (const listener of listeners.slice()) {
    listener(next);
  }
}

/** The window closed: drop the feed rather than leave a frozen one on the phone. */
export function clearGhostCompanion(): void {
  publishGhostCompanion({ open: false, items: [], cursor: -1, status: "", sessionId: "" });
}
