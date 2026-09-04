/**
 * The news deck's shape, and pure parsing of it — deliberately free of any
 * NativeScript/native import so it can be unit tested under plain node (see
 * tests/README.md). Everything that touches the network or app settings
 * (the box's host/token, the actual fetch) lives in news-client.ts instead.
 *
 * The shape is lifted from the retired EvenHub build
 * (TheLimitCase apps/ghost/src/news-fixture.ts): each card carries a
 * headline, Ghost's take, why it's in the brief at all, and a SEPARATE
 * `speak` string written for the ear (numerals/acronyms spelled the way a
 * voice should say them) rather than the eye. That split is why the walk
 * sounds like a person reading while the glass still shows a tight line.
 */

export interface NewsCard {
  id: string;
  /** depth 0 — must stand alone; the glass shows this at rest. */
  headline: string;
  /** depth 1 — Ghost's take. */
  ghost: string;
  /** depth 1 — why this one is in the brief at all. */
  why: string;
  /** depth 0 spoken text; written for the ear, not the eye. */
  speak: string;
}

export interface NewsDeck {
  cards: NewsCard[];
  /** The date string the server tagged the deck with, e.g. "2026-09-04". */
  date: string;
  /**
   * Stable per-deck id, e.g. "news:2026-09-04:excise-futures-...". Used to
   * scope the walk's "already spoken" read-state so a genuinely new deck
   * re-reads while re-fetching the same deck doesn't restart the walk.
   */
  uuid: string;
}

/**
 * One card in, one normalised card out, or null if it cannot be shown.
 *
 * The server (apps/claude-code-web/src/utils/news-feed.js, normalizeCard)
 * already does this shaping before a deck is ever pushed, so in the ordinary
 * case every field here is already a clean string. This is a defensive
 * backstop, not the primary validation — the same "drop rather than show a
 * blank the walk pauses on for no reason" rule the server uses, applied
 * again at the boundary where the client trusts a JSON response it did not
 * itself produce.
 */
export function normalizeNewsCard(raw: unknown, index: number): NewsCard | null {
  if (!raw || typeof raw !== "object") return null;
  const card = raw as Record<string, unknown>;
  const headline = typeof card.headline === "string" ? card.headline.trim() : "";
  const speak = typeof card.speak === "string" ? card.speak.trim() : "";
  if (!headline && !speak) return null;
  const rawId = typeof card.id === "string" ? card.id.trim() : "";
  return {
    id: rawId || `card-${index + 1}`,
    headline: headline || speak,
    ghost: typeof card.ghost === "string" ? card.ghost.trim() : "",
    why: typeof card.why === "string" ? card.why.trim() : "",
    speak: speak || headline,
  };
}

/**
 * The whole GET /api/news/today response in, a typed deck out, or null if
 * there is nothing usable. Mirrors the response shape server.js builds for
 * `this.latestNewsDeck`: `{ cards, date, uuid }`, decoupled from the
 * conversation pin lifecycle (session 0130) — see news-client.ts's own
 * comment for why News fetches from this route rather than polling Ghost's
 * pinned feed.
 */
export function parseNewsDeck(data: unknown): NewsDeck | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (!Array.isArray(raw.cards)) return null;
  const cards: NewsCard[] = [];
  for (const entry of raw.cards) {
    const card = normalizeNewsCard(entry, cards.length);
    if (card) cards.push(card);
  }
  if (!cards.length) return null;
  return {
    cards,
    date: typeof raw.date === "string" ? raw.date : "",
    uuid: typeof raw.uuid === "string" && raw.uuid ? raw.uuid : `news-${Date.now()}`,
  };
}

/**
 * Key for the walk's "mark as read, never re-narrate it" set (same rule as
 * Ghost's own spokenBodies, session 0135: every spoken line is a live, billed
 * TTS request). Scoped by deck uuid AND depth so: (a) a genuinely new deck
 * re-reads every card, (b) re-fetching the SAME deck (a manual Refresh) does
 * not re-narrate cards already walked, and (c) depth 0's auto-narration and
 * depth 1's take/why narration are tracked independently — descending into a
 * card you already heard the headline of should still read the take once.
 */
export function newsReadKey(deckUuid: string, cardId: string, depth: 0 | 1): string {
  return `${deckUuid}:${cardId}:${depth}`;
}
