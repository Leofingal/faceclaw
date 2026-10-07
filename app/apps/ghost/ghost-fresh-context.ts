/**
 * Fresh Context: retire the live cc-web session and carry on in a new one,
 * from the glasses (Ghost's window menu) or the phone's Ghost view.
 *
 * The box does the work: POST /api/glasses/:sessionId/clear stops the agent,
 * mints a new session in the same working directory, starts an agent in it,
 * and answers with the new id (cc-web branch cc-web-fresh-context, 2026-10-06).
 * The old id is dead the moment that succeeds, so the client must adopt the
 * new one at once or it polls a 404 forever.
 *
 * PURE: no NativeScript, no fetch. The response classifier and the action's
 * sequencing live here so they run under plain node (tests/), and the layer
 * and phone view model hand in their own I/O.
 *
 * ⚠ The version gate (paired client/server change). An older cc-web has no
 * such route and Express answers its own HTML "Cannot POST" 404. The new route
 * answers an unknown session with a JSON 404 ({ error: 'Session not found' }).
 * So: a 404 whose body is a JSON object with an `error` is a stale session; any
 * other 404 means the server predates the route, and the action says so rather
 * than failing silently.
 */

export type ClearFailure =
  /** The server has no clear route: cc-web predates this build. */
  | "needs-update"
  /** The server has the route but not this session (already retired). */
  | "session-gone"
  | "unauthorized"
  | "http"
  | "offline"
  /** No session id is set on this phone. */
  | "no-session"
  /** The phone asked, but Ghost is not open on the glasses to carry it out. */
  | "not-open"
  /** A Fresh Context is already in flight (a double tap). */
  | "busy";

export type ClearResult = {
  /** The new session id; set exactly when `failure` is null. */
  sessionId: string | null;
  failure: ClearFailure | null;
  detail: string;
};

export const FRESH_CONTEXT_LABEL = "Fresh Context";
export const NEEDS_UPDATE_MESSAGE = "Fresh Context needs a server update";

export function clearFailure(failure: ClearFailure, detail = ""): ClearResult {
  return { sessionId: null, failure, detail };
}

/** Classify the box's answer to POST /api/glasses/:id/clear. */
export function classifyClearResponse(status: number, body: string): ClearResult {
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  if (status >= 200 && status < 300) {
    const id = json && typeof json.sessionId === "string" ? json.sessionId.trim() : "";
    return id ? { sessionId: id, failure: null, detail: "" } : clearFailure("http", "no session id in the reply");
  }
  if (status === 401) return clearFailure("unauthorized", "401");
  if (status === 404) {
    const jsonError = json !== null && typeof json === "object" && typeof json.error === "string";
    return jsonError ? clearFailure("session-gone", String(json.error)) : clearFailure("needs-update", "404");
  }
  return clearFailure("http", String(status));
}

/** The one sentence both surfaces show for a result. */
export function freshContextMessage(result: ClearResult): string {
  if (!result.failure && result.sessionId) {
    return `Fresh context — new session ${result.sessionId.slice(0, 8)}`;
  }
  switch (result.failure) {
    case "needs-update":
      return NEEDS_UPDATE_MESSAGE;
    case "session-gone":
      return "Fresh Context: that session is already gone";
    case "unauthorized":
      return "Fresh Context: token rejected";
    case "offline":
      return "Fresh Context: cannot reach the box";
    case "no-session":
      return "Fresh Context: no session set";
    case "not-open":
      return "Fresh Context: open Ghost on the glasses first";
    case "busy":
      return "Fresh Context: already working on it";
    default:
      return `Fresh Context failed — server said ${result.detail || "?"}`;
  }
}

export type FreshContextDeps = {
  currentSessionId(): string;
  /** The HTTP call; must resolve, never reject (offline is a result). */
  clearSession(sessionId: string): Promise<ClearResult>;
  /** Point everything at the new session and drop the old one's view state. */
  adopt(newSessionId: string): void;
};

/**
 * One Fresh Context: call the box with the current id; on success adopt the
 * new id. Nothing is touched on failure: the old session is still the live one
 * (or, for "session-gone", auto-follow will find the new one on its own).
 */
export async function runFreshContext(deps: FreshContextDeps): Promise<ClearResult> {
  const sessionId = deps.currentSessionId().trim();
  if (!sessionId) return clearFailure("no-session");
  let result: ClearResult;
  try {
    result = await deps.clearSession(sessionId);
  } catch (error) {
    result = clearFailure("offline", String((error as Error)?.message ?? error));
  }
  if (!result.failure && result.sessionId) deps.adopt(result.sessionId);
  return result;
}
