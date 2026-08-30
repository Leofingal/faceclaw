package com.faceclaw.app;

/**
 * Receives window posture changes (fold state plus the window's own size) on
 * the main thread. One callback carries both because they always change
 * together: unfolding a Galaxy Fold swaps the display AND resizes the window,
 * and a listener that saw one without the other would lay out against a state
 * the device was never in.
 */
public interface FaceclawFoldStateListener {
    void onFoldStateChanged(String posture, int widthDp, int heightDp, boolean hasHinge, boolean isFoldable);
}
