/**
 * Ghost stays quiet while the glasses charge.
 *
 * Chris, 2026-09-24: "silent mode should go on any time the glasses are
 * charging! That is a better indicator of bedtime." The phone speaks Ghost's
 * replies aloud, and a reply landing at night woke the house. The only guard
 * until now was a clock window in the seat's hook on the Ghost box, which
 * cannot see the glasses at all; the phone can.
 *
 * WHICH charge state. Not the dashboard's "charging" phase: that is Java's
 * `chargingMode`, which every glasses link loss and transport rebuild resets to
 * false, so a reconnect in the case reads "connecting", then "connected" until
 * the first battery poll of the new session. Keyed to the phase, a reply that
 * landed in that window would be spoken. The communicator's latch
 * (`glassesChargeLatch()`) changes only when a battery answer says so.
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
 * The glasses' latched charge reading from the live communicator: 1 on the
 * charger, 0 off it, -1 not heard yet, null when there is no communicator (or
 * it is an older build without the getter).
 */
export function glassesChargeLatch(): number | null {
  try {
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) return null;
    return Number(communicator.glassesChargeLatch());
  } catch {
    return null;
  }
}

/**
 * Whether automatic speech is muted for this latch reading. Only a battery
 * answer that said "charging" mutes: not heard yet, or no communicator at all,
 * speaks exactly as before (an app restart must not silence Ghost until the
 * glasses answer).
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
    reason: "glasses-charging",
    kind,
    uuid: uuid ?? null,
  });
}
