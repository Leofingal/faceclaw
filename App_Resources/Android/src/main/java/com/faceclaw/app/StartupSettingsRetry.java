package com.faceclaw.app;

/**
 * The startup settings query (firmware info and the glasses battery), queued
 * once when the first session becomes ready, and re-sent while it goes
 * unanswered.
 *
 * <p>Why it exists: on 2026-09-16 the query was lost on two of three installs.
 * On pid 7517 a {@code SYSTEM_EXIT_EVENT} arrived about 10 s after session
 * ready, and the firmware-exit handler's {@code clearAllMessagesLocked} dropped
 * the query while it was still queued. That path writes no log line, and the
 * query has no timeout while it only sits in the queue. With no answer, the top
 * bar had no G2 battery and the firmware capability flags stayed unset until
 * the five-minute battery poll.
 *
 * <p>Pure Java with no Android imports, so
 * {@code notes/startup-settings-retry-selftest} can drive it. The communicator
 * calls everything under its lock except {@link #noteAnswered()}, which comes
 * from the ACK path; that flag is volatile.
 */
final class StartupSettingsRetry {
    /** How long a query may go unanswered, with no copy queued or in flight, before it is sent again. */
    static final long RESEND_AFTER_MS = 5_000L;
    /** Re-sends per process; the five-minute battery poll remains the backstop after that. */
    static final int MAX_RESENDS = 3;

    private boolean queued;
    private volatile boolean answered;
    private long lastQueuedOrSentAtMs;
    private int resends;

    /** The first session's query was queued. */
    void noteQueued(long nowMs) {
        queued = true;
        lastQueuedOrSentAtMs = nowMs;
    }

    /** Any settings/battery query was answered: firmware info and battery are known. */
    void noteAnswered() {
        answered = true;
    }

    boolean isAnswered() {
        return answered;
    }

    int resends() {
        return resends;
    }

    /**
     * Whether to send the query again now.
     *
     * @param outstanding a settings/battery query is still queued or in flight,
     *                    so its own ACK or timeout is still to come
     */
    boolean shouldResend(long nowMs, boolean outstanding) {
        return queued
                && !answered
                && !outstanding
                && resends < MAX_RESENDS
                && nowMs - lastQueuedOrSentAtMs >= RESEND_AFTER_MS;
    }

    /** Record a re-send and return its number, 1 to {@link #MAX_RESENDS}. */
    int noteResent(long nowMs) {
        resends++;
        lastQueuedOrSentAtMs = nowMs;
        return resends;
    }
}
