/**
 * Ghost stays quiet while the glasses charge.
 *
 * Chris, 2026-09-24: "silent mode should go on any time the glasses are
 * charging! That is a better indicator of bedtime." The phone speaks Ghost's
 * replies aloud, and a reply landing at night woke the house. The only guard
 * until now was a clock window in the seat's hook on the Ghost box, which
 * cannot see the glasses at all; the phone can.
 *
 * WHICH state. Not the dashboard's "charging" phase: that is Java's
 * `chargingMode`, which every glasses link loss and transport rebuild resets to
 * false, so a reconnect in the case reads "connecting", then "connected" until
 * the first battery poll of the new session. Not the raw charge flag either:
 * on 2026-09-25 at 00:38 it read "not charging" with the glasses untouched in
 * their case (most likely a full battery). The communicator's in-case latch
 * (`glassesInCaseLatch()`, 2026-09-25) opens on a charging answer and closes
 * only on a real removal (the glasses put on, or a temple touch with no charge
 * current), or after 14 h; it survives an app restart.
 *
 * What is muted: only AUTOMATIC speech - a reply announced on arrival, an
 * approval/waiting announcement, and the catch-up read after a send. A reply
 * muted here is not queued: nothing replays it when the glasses come off the
 * charger. Tapping into it later still reads it (an explicit ask), and the
 * display is untouched throughout.
 *
 * Pure apart from the one native read, and free of NativeScript imports, so
 * `tests/` can pin it under plain node.
 */
import { localStamp } from "../../g2/resume-receipt";

declare const com: any;

/**
 * The in-case latch from the live communicator: 1 in the case, 0 out of it,
 * -1 never known, null when there is no communicator (or it is an older build
 * without the getter).
 */
export function glassesChargeLatch(): number | null {
  try {
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) return null;
    return Number(communicator.glassesInCaseLatch());
  } catch {
    return null;
  }
}

/**
 * Whether automatic speech is muted for this latch reading. Only an open
 * latch mutes: never known, or no communicator at all, speaks exactly as
 * before (an app restart outside the case must not silence Ghost; one inside
 * it restores the saved latch).
 */
export function autoSpeechMutedFor(latch: number | null): boolean {
  return latch === 1;
}

/** What was about to be spoken. */
export type MutedSpeechKind = "reply" | "approval" | "waiting" | "catch-up";

/**
 * One line of `files/voice/ghost-speech-receipts.jsonl`, written per muted
 * line. The `voice/` folder is already mirrored to the Ghost box
 * (`~/phone-logs/voice/`), so a night's mutes can be counted without adb.
 */
export function mutedSpeechReceiptLine(wallMs: number, kind: MutedSpeechKind, uuid: string | undefined): string {
  return JSON.stringify({
    type: "ghostSpeechMuted",
    at: localStamp(wallMs),
    atMs: wallMs,
    reason: "glasses-in-case",
    kind,
    uuid: uuid ?? null,
  });
}
