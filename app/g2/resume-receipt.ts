/**
 * One line of `files/health/resume-receipts.jsonl`: what an EvenHub wake
 * barrier did, how long it took, and what the direct ring link was doing at
 * that instant.
 *
 * Why it exists (2026-09-19). Resume latency had exactly three hand-read
 * samples, all off 2026-09-08 logcat timestamps: 449 ms on the wake-latency
 * fix, 620 ms and 611 ms on the build before it. Three samples describe a
 * median; the complaint they have to answer ("under 500 ms most of the time,
 * but still sluggish sometimes") is about the tail. So every resume records
 * itself instead, with enough context to attribute a slow one - in particular
 * the ring link state, because the standing hypothesis is that a direct link
 * to the ring contends for the radio.
 *
 * Pure, and free of NativeScript imports, so `tests/` can pin the format under
 * plain node - the same split `health-store.ts` has from
 * `health-store-files.ts`. Diagnostic only: nothing in the app reads it back.
 */

/**
 * The stamps one wake barrier collects. Every time is `Date.now()`; 0 means
 * that step was never reached.
 */
export interface ResumeStamps {
  /** Per-process counter. A coalesced joiner carries the id of the barrier it waited on. */
  id: number;
  /** FrameTimings frame id, so a slow line can be looked up in the timing export. 0 = none. */
  frameId: number;
  /** True when this call joined a barrier already in flight instead of starting one. */
  coalesced: boolean;
  /** When this call entered the barrier. */
  startedAtMs: number;
  /** When the barrier settled for this caller. */
  endedAtMs: number;
  /** Just before `resumeEvenHubSession()`, i.e. after the screen-on round trip. */
  resumeStartedAtMs: number;
  /** When `resumeEvenHubSession()` returned. */
  resumeDoneAtMs: number;
  /** When `setScreenBlanked(false)` returned. */
  unblankDoneAtMs: number;
  /** When `awaitEvenHubSessionReady()` returned. */
  readyDoneAtMs: number;
  /** What `resumeEvenHubSession()` returned. */
  resumed: boolean;
  /** What the barrier resolved to. */
  ready: boolean;
  /** Whether the EvenHub session was suspended when this barrier started. */
  wasSuspended: boolean;
  /** How long it had been suspended, or -1 when it was not. */
  suspendedForMs: number;
  /** How long the glasses connection had been up, or -1 when not connected. */
  sessionUpMs: number;
}

export function emptyResumeStamps(): ResumeStamps {
  return {
    id: 0,
    frameId: 0,
    coalesced: false,
    startedAtMs: 0,
    endedAtMs: 0,
    resumeStartedAtMs: 0,
    resumeDoneAtMs: 0,
    unblankDoneAtMs: 0,
    readyDoneAtMs: 0,
    resumed: false,
    ready: false,
    wasSuspended: false,
    suspendedForMs: -1,
    sessionUpMs: -1,
  };
}

/**
 * The sanity floor and ceiling on a real resume's `ms`. A reading outside them
 * almost certainly means the stamp is on the wrong boundary, not that the
 * resume was that fast or that slow: the one measurement we trust is 449 ms,
 * hand-read from logcat on 2026-09-08 between `resumeEvenHubSession()`'s
 * prelude line and the content frame being acked. The verdict rides along on
 * every line so a bad boundary is visible in the file itself rather than only
 * to whoever remembers to check.
 */
export const RESUME_SANITY_MIN_MS = 50;
export const RESUME_SANITY_MAX_MS = 5_000;
/** The 2026-09-08 hand-read resume, and what a healthy line should look like. */
export const RESUME_KNOWN_GOOD_MS = 449;

/** "ok" | "implausibly-fast" | "implausibly-slow" | "n/a" (coalesced, or no span). */
export function resumeSanity(ms: number, coalesced: boolean): string {
  if (coalesced || !Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < RESUME_SANITY_MIN_MS) return "implausibly-fast";
  if (ms > RESUME_SANITY_MAX_MS) return "implausibly-slow";
  return "ok";
}

/**
 * `2026-09-19T10:31:02.115-04:00`. Local, with the offset spelled out: these
 * lines are read next to logcat, which is local, and a bare UTC stamp in a log
 * read alongside local timestamps has already cost one hours-long misreading.
 * `atMs` on every line stays the canonical value.
 */
export function localStamp(wallMs: number): string {
  const d = new Date(wallMs);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(offsetMin / 60 < 0 ? Math.ceil(offsetMin / 60) : Math.floor(offsetMin / 60))}:${pad(offsetMin % 60)}`
  );
}

/**
 * One receipt line.
 *
 * `ms` is the number to compare against 449: resume-start (just before
 * `resumeEvenHubSession()`) to the barrier seeing the content frame acked.
 * `preludeMs` is the same quantity measured inside Java, between exactly the
 * two events the 449 was read from, so it excludes the JS call-queue hop that
 * `ms` includes; when both are present, `preludeMs` is the comparable one.
 *
 * A coalesced line's `ms` is how long the joiner waited, which is a different
 * quantity on purpose - `coalesced` separates the two populations.
 *
 * @param preludeSpanMs from `evenHubResumePreludeSpanMs()`; -1 when this
 *     barrier replayed no prelude (the session was never suspended).
 * @param ringJson a JSON object from `ringLinkReceiptJson()`, or anything else
 *     (including "") to record `null`.
 */
export function resumeReceiptLine(
  stamps: ResumeStamps,
  preludeSpanMs: number,
  ringJson: string,
  mode: string,
): string {
  const endedAtMs = stamps.endedAtMs;
  const resumeEndMs = stamps.readyDoneAtMs > 0 ? stamps.readyDoneAtMs : endedAtMs;
  const ms = stamps.coalesced
    ? span(stamps.startedAtMs, endedAtMs)
    : span(stamps.resumeStartedAtMs, resumeEndMs);
  const ring = typeof ringJson === "string" && ringJson.startsWith("{") ? ringJson : "null";
  return (
    `{"type":"resume","id":${int(stamps.id)}` +
    `,"at":${JSON.stringify(localStamp(endedAtMs))}` +
    `,"atMs":${int(endedAtMs)}` +
    `,"coalesced":${stamps.coalesced === true}` +
    `,"frame":${int(stamps.frameId)}` +
    `,"ms":${int(ms)}` +
    `,"preludeMs":${int(preludeSpanMs)}` +
    `,"barrierMs":${int(span(stamps.startedAtMs, endedAtMs))}` +
    `,"screenOnMs":${int(span(stamps.startedAtMs, stamps.resumeStartedAtMs))}` +
    `,"resumeMs":${int(span(stamps.resumeStartedAtMs, stamps.resumeDoneAtMs))}` +
    `,"unblankMs":${int(span(stamps.resumeDoneAtMs, stamps.unblankDoneAtMs))}` +
    `,"readyMs":${int(span(stamps.unblankDoneAtMs, stamps.readyDoneAtMs))}` +
    `,"resumed":${stamps.resumed === true}` +
    `,"ready":${stamps.ready === true}` +
    `,"wasSuspended":${stamps.wasSuspended === true}` +
    `,"suspendedForMs":${int(stamps.suspendedForMs)}` +
    `,"sessionUpMs":${int(stamps.sessionUpMs)}` +
    `,"sanity":${JSON.stringify(resumeSanity(ms, stamps.coalesced))}` +
    `,"mode":${JSON.stringify(String(mode ?? ""))}` +
    `,"ring":${ring}}`
  );
}

function span(fromMs: number, toMs: number): number {
  if (!(fromMs > 0) || !(toMs > 0) || toMs < fromMs) return -1;
  return toMs - fromMs;
}

function int(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : -1;
}

function pad(value: number, width = 2): string {
  return String(Math.abs(Math.trunc(value))).padStart(width, "0");
}
