package com.faceclaw.app;

/**
 * Standalone self-test for {@link StartupSettingsRetry}. No Android.
 *
 * <pre>
 *   javac -d /tmp/ssr App_Resources/Android/src/main/java/com/faceclaw/app/StartupSettingsRetry.java \
 *                     notes/startup-settings-retry-selftest/StartupSettingsRetrySelfTest.java
 *   java -cp /tmp/ssr com.faceclaw.app.StartupSettingsRetrySelfTest
 * </pre>
 */
public final class StartupSettingsRetrySelfTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        testConstants();
        testNothingBeforeQueued();
        testWaitsForTheQuiet();
        testAnswerStopsIt();
        testBudget();
        testReplay7517();

        System.out.println();
        System.out.println(failures == 0
            ? "PASS: all " + checks + " checks"
            : "FAIL: " + failures + " of " + checks + " checks");
        if (failures != 0) {
            System.exit(1);
        }
    }

    private static void testConstants() {
        check("re-send after 5 s", StartupSettingsRetry.RESEND_AFTER_MS == 5_000L);
        check("at most 3 re-sends", StartupSettingsRetry.MAX_RESENDS == 3);
    }

    private static void testNothingBeforeQueued() {
        StartupSettingsRetry r = new StartupSettingsRetry();
        check("never re-sends a query that was never queued", !r.shouldResend(1_000_000L, false));
    }

    private static void testWaitsForTheQuiet() {
        StartupSettingsRetry r = new StartupSettingsRetry();
        r.noteQueued(1_000L);
        check("not before 5 s", !r.shouldResend(5_999L, false));
        check("at 5 s with nothing outstanding", r.shouldResend(6_000L, false));
        check("not while a copy is still queued or in flight", !r.shouldResend(60_000L, true));
        check("next re-send numbered 1", r.noteResent(6_000L) == 1);
        check("the re-send restarts the 5 s wait", !r.shouldResend(10_999L, false));
        check("and then fires again", r.shouldResend(11_000L, false));
    }

    private static void testAnswerStopsIt() {
        StartupSettingsRetry r = new StartupSettingsRetry();
        r.noteQueued(0L);
        r.noteAnswered();
        check("answered: no re-send, ever", !r.shouldResend(1_000_000L, false));
        check("answered is reported", r.isAnswered());
    }

    private static void testBudget() {
        StartupSettingsRetry r = new StartupSettingsRetry();
        r.noteQueued(0L);
        long now = 0L;
        int sent = 0;
        for (int i = 0; i < 10; i++) {
            now += StartupSettingsRetry.RESEND_AFTER_MS;
            if (r.shouldResend(now, false)) {
                r.noteResent(now);
                sent++;
            }
        }
        check("exactly MAX_RESENDS re-sends over 50 s unanswered (got " + sent + ")", sent == StartupSettingsRetry.MAX_RESENDS);
        check("resends() agrees", r.resends() == StartupSettingsRetry.MAX_RESENDS);
    }

    /** pid 7517, 2026-09-16, times as ms after 14:53:00. */
    private static void testReplay7517() {
        StartupSettingsRetry r = new StartupSettingsRetry();
        r.noteQueued(43_801L);                       // queue settings query for firmware info
        check("7517: still queued behind the ring handshake at 50 s", !r.shouldResend(50_000L, true));
        check("7517: still queued at 54.0 s", !r.shouldResend(54_000L, true));
        // 54.027 s: SYSTEM_EXIT_EVENT, clearAllMessagesLocked("firmware exit event"): nothing outstanding.
        check("7517: re-sent on the next writer pass after the clear", r.shouldResend(54_030L, false));
        r.noteResent(54_030L);
        check("7517: the re-send is outstanding until its ACK", !r.shouldResend(59_100L, true));
        r.noteAnswered();
        check("7517: answered, so the 14:58:44 poll is no longer the first reading", !r.shouldResend(300_000L, false));
    }

    private static void check(String name, boolean ok) {
        checks++;
        if (!ok) {
            failures++;
        }
        System.out.println((ok ? "  ok   " : "  FAIL ") + name);
    }
}
