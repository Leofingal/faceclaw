/**
 * Ghost's half of the conversation with Chris's own box (cc-web on
 * `ghost:32352`). Everything network lives here so the layer stays a view.
 *
 * WHY THIS POLLS A SERVER RATHER THAN READING ANDROID NOTIFICATIONS.
 * Ghost's feed is not a notification tray. Each entry carries a headline, a
 * separately-authored body, a `kind` ('brief' / 'approval' / 'news') and, on a
 * live permission prompt, the structured `options` array the approval screen
 * navigates. None of that survives a trip through Android's notification
 * model, and the approval screen — the single most-used interaction in the
 * app — is built directly on `options`. Exocortex already owns the
 * Android-notification surface; Ghost is the session, not the tray. So this
 * keeps the existing behaviour: one GET every few seconds against the box.
 */
import {
  ConfigSettingBoolean,
  ghostHostSetting,
  ghostSessionSetting,
  ghostTokenSetting,
} from "../../ui/dashboard-settings";
import { fetchWithUserAgent } from "../../util/http";

export { ghostHostSetting, ghostTokenSetting, ghostSessionSetting };

/**
 * One entry of the feed, exactly as the box's own digester emits it
 * (apps/claude-code-web/src/utils/glasses.js). The glasses never parse a
 * transcript, ANSI or markdown: the least reliable device on the network gets
 * the most digested payload.
 */
export type GhostItem = {
  uuid: string;
  ts?: string | number;
  role?: "user" | "assistant";
  headline: string;
  body: string[];
  /** 'brief' | 'approval' | 'news' | 'waiting'; absent on an ordinary turn. */
  kind?: string;
  /** Present on an 'approval' item: the structured choices a live prompt offers. */
  options?: { n: number; label: string }[];
};

export type GhostFeed = {
  items: GhostItem[];
  /** A spoken "turn voice on/off" the box carries out on one poll and forgets. */
  speak?: boolean;
};

// ---------------------------------------------------------------------------
// Settings
//
// ghostHostSetting / ghostTokenSetting / ghostSessionSetting now live in
// ui/dashboard-settings.ts (imported above, re-exported below for existing
// callers of this module) so native/ghost-stt.ts -- the box-side
// Transcription Provider option -- can read them without a native/ -> apps/
// import. ghostSpeakSetting and ghostAutoFollowSetting stay here: they're
// Ghost-app UI behavior the STT client has no reason to touch.

export const ghostSpeakSetting = new ConfigSettingBoolean({
  id: "ghost-speak",
  label: "Speak replies",
  storageKey: "ghost.speak",
  // A voice that starts talking unasked is worse than silence.
  defaultValue: false,
  description: "Read new arrivals aloud through the phone's audio route (the hearing aids).",
});

export const ghostAutoFollowSetting = new ConfigSettingBoolean({
  id: "ghost-auto-follow",
  label: "Follow active session",
  storageKey: "ghost.autoFollow",
  defaultValue: true,
  description: "Track whichever session the box has marked active, instead of a fixed id.",
});

export function ghostHost(): string {
  return ghostHostSetting.get();
}

export function ghostSessionId(): string {
  return ghostSessionSetting.get().trim();
}

/**
 * The box runs cc-web WITH --auth, so every /api/* call needs the token or it
 * comes back 401. An EMPTY token deliberately sends no header at all, so the
 * same build still works against a --disable-auth server — the degradation is
 * "no credential offered" rather than "a wrong one presented".
 */
export function ghostAuthHeaders(): Record<string, string> {
  const token = ghostTokenSetting.get();
  return token ? { authorization: `Bearer ${token}` } : {};
}

// ---------------------------------------------------------------------------
// Calls

/**
 * How a poll failed, when it did. Three cases rather than one because they
 * need different actions from Chris: a bad credential is not a network
 * problem, and saying "server said 401" would send him hunting the wrong one.
 */
export type FeedFailure = "unauthorized" | "http" | "offline";

/**
 * What a poll produced. `feed` is null exactly when `failure` is set — kept as
 * two plain fields rather than a discriminated union because this project
 * compiles without `strict`, and union narrowing on a boolean discriminant is
 * not reliable there (measured: it does not narrow).
 */
export type FeedResult = {
  feed: GhostFeed | null;
  failure: FeedFailure | null;
  detail: string;
};

export async function fetchFeed(sessionId: string, limit = 20): Promise<FeedResult> {
  try {
    const response = await fetchWithUserAgent(`${ghostHost()}/api/glasses/${sessionId}?limit=${limit}`, {
      headers: { accept: "application/json", ...ghostAuthHeaders() },
    });
    if (response.status === 401) return { feed: null, failure: "unauthorized", detail: "401" };
    if (!response.ok) return { feed: null, failure: "http", detail: String(response.status) };
    const data = (await response.json()) as any;
    return {
      feed: {
        items: Array.isArray(data?.items) ? (data.items as GhostItem[]) : [],
        speak: typeof data?.speak === "boolean" ? data.speak : undefined,
      },
      failure: null,
      detail: "",
    };
  } catch (error) {
    return { feed: null, failure: "offline", detail: String((error as Error)?.message ?? error) };
  }
}

/**
 * Which session the box has marked current (markSessionActive). Without this,
 * the session id is a value typed once and baked into every poll URL forever —
 * the glasses would keep faithfully polling a session Chris left behind,
 * silently, because every layer below this one succeeds.
 */
export async function fetchActiveSessionId(): Promise<string | null> {
  try {
    const response = await fetchWithUserAgent(`${ghostHost()}/api/active-session`, {
      headers: { accept: "application/json", ...ghostAuthHeaders() },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as any;
    return typeof data?.sessionId === "string" && data.sessionId ? data.sessionId : null;
  } catch {
    return null;
  }
}

/** Inject text into the live session — the ordinary "Chris said something" path. */
export async function sendInput(sessionId: string, text: string): Promise<boolean> {
  if (!text.trim() || !sessionId) return false;
  try {
    const response = await fetchWithUserAgent(`${ghostHost()}/api/glasses/${sessionId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ghostAuthHeaders() },
      body: JSON.stringify({ text }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Answer a live permission prompt by option number. */
export async function sendApproval(sessionId: string, n: number): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const response = await fetchWithUserAgent(`${ghostHost()}/api/glasses/${sessionId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ghostAuthHeaders() },
      body: JSON.stringify({ n }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Tier 3: everything Ghost wrote above the authored <glasses> block, fetched
 * only when Chris asks for it. Sanitized server-side for the same reason the
 * HUD block always has been.
 */
export async function fetchProse(sessionId: string, uuid: string): Promise<string[]> {
  const response = await fetchWithUserAgent(`${ghostHost()}/api/glasses/${sessionId}/prose/${uuid}`, {
    headers: { accept: "application/json", ...ghostAuthHeaders() },
  });
  if (!response.ok) throw new Error(`server said ${response.status}`);
  const data = (await response.json()) as any;
  return Array.isArray(data?.prose) ? (data.prose as string[]) : [];
}

/**
 * "Add information": merge a second utterance into a transcript already on the
 * confirm screen. The box runs the model pass; an EMPTY addition is not an
 * error, it is "refine with no addition" and falls back to a plain cleanup.
 */
export async function refineDictation(
  sessionId: string,
  raw: string,
  addition: string,
): Promise<{ text: string; ok: boolean }> {
  const response = await fetchWithUserAgent(`${ghostHost()}/api/glasses/${sessionId}/refine`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ghostAuthHeaders() },
    body: JSON.stringify({ raw, addition }),
  });
  const data = (await response.json()) as any;
  if (!response.ok) throw new Error(String(data?.error ?? response.status));
  const text = typeof data?.refined === "string" && data.refined ? data.refined : joinAddition(raw, addition);
  return { text, ok: !!data?.ok };
}

/** The safe, no-model merge: never reorders, never invents a joining word. */
export function joinAddition(base: string, addition: string): string {
  const a = base.trim();
  const b = addition.trim();
  if (!b) return a;
  if (!a) return b;
  return `${a} ${b}`;
}

/**
 * Where the spoken form of a line of text comes from. The box synthesizes it
 * (ElevenLabs, behind cc-web's /tts route) and we play the bytes — the API key
 * stays on the box, and one route already carries the no-repeat accounting
 * Chris cares about.
 */
export function ttsUrl(sessionId: string, text: string): string {
  return `${ghostHost()}/api/glasses/${sessionId}/tts?text=${encodeURIComponent(text)}`;
}
