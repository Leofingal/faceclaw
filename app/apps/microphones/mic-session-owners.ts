/**
 * Who holds the glasses microphone session open, so two windows can share
 * the one MicSession: the Microphones app and the Captions app (2026-09-25).
 * The session starts with its first owner and stops (mic released) with its
 * last, so closing Captions while Microphones is open keeps the mic running.
 *
 * No NativeScript here, so tests/captions-app.test.cjs can drive it with a
 * fake session.
 */

/** The parts of MicSession the owners need (mic-session.ts implements it). */
export type MicSessionPort = {
  start(): void;
  stop(): void;
  setCaptionsEnabled(enabled: boolean): void;
};

export type MicSessionOwner = "microphones" | "captions";

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
 * The Captions app's whole lifecycle. Opening it turns captions on (the
 * persisted Captions setting, in whatever Languages I'll hear was last set to)
 * and holds the session; leaving it turns captions off and lets go, which
 * releases the mic unless Microphones still holds it.
 */
export function openCaptionsApp(session: MicSessionPort, owners: MicSessionOwners): void {
  // Setting first: start() starts captions only when the setting is on, and a
  // session that is already running (Microphones open) starts them here.
  session.setCaptionsEnabled(true);
  owners.acquire("captions");
}

export function closeCaptionsApp(session: MicSessionPort, owners: MicSessionOwners): void {
  session.setCaptionsEnabled(false);
  owners.release("captions");
}
