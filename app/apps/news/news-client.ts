/**
 * News's half of the conversation with Chris's own box — fetching today's
 * deck. Everything network lives here so the layer stays a view, same split
 * as ghost-client.ts.
 *
 * WHY /api/news/today, AND NOT THE FEED GHOST POLLS.
 *
 * A news push (POST /api/glasses/:sessionId/news, server.js) does two things:
 * it sets `this.latestNewsDeck` (the whole deck, as data), and it PINS the
 * deck onto the conversation feed Ghost polls — which, per that route's own
 * pin, REPLACES the feed entirely while pinned rather than appending to it
 * ("one thing on the glass at a time"). That second effect is what actually
 * causes the announced bug this app exists to fix: opening Ghost shows
 * nothing but news, because the server temporarily has nothing else to send.
 *
 * /api/news/today reads `latestNewsDeck` directly — no session id, no pin, no
 * dismiss-on-speak lifecycle, added session 0130 specifically so the old
 * app's News menu wouldn't show a stale fixture after any live conversation
 * dismissed the pin. That is exactly the right shape for this app: News
 * fetches its own deck, in its own format, entirely decoupled from whatever
 * Ghost's feed is doing. No server route change needed — this one already
 * exists and already returns exactly {cards, date, uuid}.
 */
import { fetchWithUserAgent } from "../../util/http";
import { ghostAuthHeaders, ghostHost } from "../ghost/ghost-client";
import { parseNewsDeck, type NewsDeck } from "./news-deck";

export type NewsFetchFailure = "unauthorized" | "http" | "offline" | "empty";

export type NewsFetchResult = {
  deck: NewsDeck | null;
  failure: NewsFetchFailure | null;
  detail: string;
};

export async function fetchNewsToday(): Promise<NewsFetchResult> {
  try {
    const response = await fetchWithUserAgent(`${ghostHost()}/api/news/today`, {
      headers: { accept: "application/json", ...ghostAuthHeaders() },
    });
    if (response.status === 401) return { deck: null, failure: "unauthorized", detail: "401" };
    // Not an error: the nightly push simply hasn't happened yet (or the box
    // restarted since, since latestNewsDeck is in-memory-only — see server.js).
    if (response.status === 404) return { deck: null, failure: "empty", detail: "no deck pushed yet" };
    if (!response.ok) return { deck: null, failure: "http", detail: String(response.status) };
    const data = await response.json();
    const deck = parseNewsDeck(data);
    if (!deck) return { deck: null, failure: "empty", detail: "deck had no usable cards" };
    return { deck, failure: null, detail: "" };
  } catch (error) {
    return { deck: null, failure: "offline", detail: String((error as Error)?.message ?? error) };
  }
}
