/**
 * Who holds the glasses microphone session open, so two windows can share
 * the one MicSession: the Microphones app and the Translate app (2026-09-25).
 * The session starts with its first owner and stops (mic released) with its
 * last, so closing Translate while Microphones is open keeps the mic running.
 *
 * No NativeScript here, so tests/translate-app.test.cjs can drive it with a
 * fake session.
 */

/** The parts of MicSession the owners need (mic-session.ts implements it). */
export type MicSessionPort = {
  start(): void;
  stop(): void;
  setCaptionsEnabled(enabled: boolean): void;
  setCaptionLanguageOverride(language: string | null): void;
};

export type MicSessionOwner = "microphones" | "translate";

export type MicSessionOwners = {
  acquire(owner: MicSessionOwner): void;
  release(owner: MicSessionOwner): void;
  held(): readonly MicSessionOwner[];
};

export function createMicSessionOwners(session: MicSessionPort): MicSessionOwners {
  const owners = new Set<MicSessionOwner>();
  return {
    acquire(owner) {
      owners.add(owner);
      session.start();
    },
    release(owner) {
      if (!owners.delete(owner)) return;
      if (owners.size === 0) session.stop();
    },
    held: () => [...owners],
  };
}

/**
 * The Translate app's whole lifecycle (named Captions until 2026-09-25 19:2x;
 * Chris keeps "Captions" for a later English-with-voice-ID app). Opening it
 * runs captions in Japanese/Korean/Chinese (+ English) whatever Languages I'll
 * hear says, turns captions on and holds the session. Leaving it turns
 * captions off, hands the language back to the setting, and lets go, which
 * releases the mic unless Microphones still holds it.
 */
export const TRANSLATE_CAPTION_LANGUAGE = "asian";

export function openTranslateApp(session: MicSessionPort, owners: MicSessionOwners): void {
  // Language first, so the engine starts on SenseVoice rather than
  // starting on Moonshine and restarting.
  session.setCaptionLanguageOverride(TRANSLATE_CAPTION_LANGUAGE);
  // Setting next: start() starts captions only when the setting is on, and a
  // session that is already running (Microphones open) starts them here.
  session.setCaptionsEnabled(true);
  owners.acquire("translate");
}

export function closeTranslateApp(session: MicSessionPort, owners: MicSessionOwners): void {
  session.setCaptionsEnabled(false);
  session.setCaptionLanguageOverride(null);
  owners.release("translate");
}
