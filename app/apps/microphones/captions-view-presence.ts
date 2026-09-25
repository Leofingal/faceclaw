/**
 * Whether a captions view is on screen: Microphones > Captions view, or the
 * Captions app (both are a CaptionsLayer). Ghost reads it to hold automatic
 * speech (ghost-charge-mute.ts), because on 2026-09-25 every Ghost reply
 * spoken to Chris's LE Audio hearing aids flipped the glasses-mic link between
 * clean and ~58% packet loss, and the loss stayed until the next stream.
 *
 * A count, not a flag, so two views (both windows open) close cleanly. No
 * NativeScript, so the Ghost mute test can drive it.
 */
let openViews = 0;

export function captionsViewOpened(): void {
  openViews += 1;
}

export function captionsViewClosed(): void {
  openViews = Math.max(0, openViews - 1);
}

export function captionsViewOpen(): boolean {
  return openViews > 0;
}
