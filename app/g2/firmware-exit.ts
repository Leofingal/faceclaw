/**
 * Firmware exit events (FOREGROUND_EXIT / ABNORMAL_EXIT / SYSTEM_EXIT) as a
 * tiny bus, and the Microphones session's answer to them (2026-09-25).
 *
 * At 19:01:17 that evening the glasses sent SYSTEM_EXIT_EVENT mid-captions
 * (0.3 s after a ring tick's device-channel handshake), and 1.6 s later the
 * left arm stopped streaming the mic. The session still believed it was
 * listening: the mic is armed only when the session starts, so re-entering
 * Captions restarted the recognizer and never the mic. Now a running session
 * re-arms its capture a few seconds after any firmware exit.
 *
 * No NativeScript here, so tests/firmware-exit-rearm.test.cjs drives it.
 */

/** OsEventTypeList FOREGROUND_EXIT_EVENT, ABNORMAL_EXIT_EVENT, SYSTEM_EXIT_EVENT (g2/events.ts). */
export const FIRMWARE_EXIT_EVENT_TYPES: readonly number[] = [5, 6, 7];

export function isFirmwareExitEvent(eventType: number): boolean {
  return FIRMWARE_EXIT_EVENT_TYPES.includes(eventType);
}

type ExitListener = (eventType: number) => void;
const listeners = new Set<ExitListener>();

/** The dashboard calls this for every firmware sys-event; non-exits are ignored. */
export function notifyFirmwareSysEvent(eventType: number): void {
  if (!isFirmwareExitEvent(eventType)) return;
  for (const listener of [...listeners]) {
    try {
      listener(eventType);
    } catch {
      // One listener's failure must not stop the others.
    }
  }
}

export function onFirmwareExit(listener: ExitListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * How long after the exit to re-arm. The mic stopped 1.6 s after the exit
 * event on 2026-09-25, so re-arming at once could land before the firmware
 * finishes tearing the stream down. [guess: 3 s; not measured]
 */
export const MIC_REARM_DELAY_MS = 3000;

export type RearmPort = {
  isRunning(): boolean;
  rearm(why: string): void;
  schedule(fn: () => void, ms: number): () => void;
};

/**
 * One re-arm per burst of exits: a second exit while one is pending pushes
 * nothing extra, and the session must still be running when the timer fires.
 */
export function createFirmwareExitRearm(port: RearmPort, delayMs = MIC_REARM_DELAY_MS) {
  let cancelPending: (() => void) | null = null;
  return {
    onExit(eventType: number): void {
      if (!isFirmwareExitEvent(eventType) || !port.isRunning() || cancelPending) return;
      cancelPending = port.schedule(() => {
        cancelPending = null;
        if (port.isRunning()) port.rearm(`firmware exit event ${eventType}`);
      }, delayMs);
    },
    cancel(): void {
      cancelPending?.();
      cancelPending = null;
    },
  };
}
