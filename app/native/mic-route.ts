/**
 * Which microphone a phone-mic capture actually landed on, and whether that is
 * worth telling the wearer about. Pure (no NativeScript) so tests/ can run it.
 *
 * 2026-10-06 (TLC open problem "Why was the 10-06 morning dictation poor?"):
 * with "Force phone microphone" on, captures are meant to come from the
 * hearing aids (LE Audio, BLE_HEADSET). When the car connected over classic
 * Bluetooth, the hearing aids' input vanished from the phone's input list and
 * three captures fell to the phone's own BUILTIN_MIC, garbled, with nothing on
 * the glasses to say so. This is the "say so" half: the Java controller
 * reports the routed device type (FaceclawVoiceControllerListener.onInputRoute)
 * and the listening screen marks a fallback.
 */

/** Android's AudioDeviceInfo type label for the phone's own microphone, as the
 * controller's describeAudioDeviceType() writes it. */
export const BUILTIN_MIC = "BUILTIN_MIC";

/**
 * A forced-phone-mic capture that is on the built-in mic. Only then: in
 * preview-only mode (no glasses) the phone mic is the plan, not a fallback,
 * and an unknown route ("" before first audio) is not evidence of anything.
 */
export function isPhoneMicFallback(forcePhoneMic: boolean, routedType: string | null | undefined): boolean {
  return Boolean(forcePhoneMic) && routedType === BUILTIN_MIC;
}
