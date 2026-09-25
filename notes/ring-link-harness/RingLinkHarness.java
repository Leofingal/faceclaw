package com.faceclaw.app;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * Ring-link harness (2026-09-24): the REAL FaceclawBleCommunicator, on a plain
 * JVM, against a fake BLE manager and a fake ring, driven through many pull
 * cycles in one run. See run.sh for how it is built.
 *
 * <p>Why it exists. "Only when needed" shipped with pure-gate self-tests that
 * all passed, then ran exactly one pull on the phone and went 26 hours without
 * another: its link state stayed "up" after the drop because the drop's
 * close() swallows the DISCONNECTED callback the state machine was waiting for.
 * No test of a pure predicate can see that; it lives in how the communicator,
 * the BLE manager and Android's GATT rules fit together. This drives all three
 * - the communicator's own code, the manager's bookkeeping, Android's close()
 * rule - through more than one cycle, because the first cycle is the one that
 * always works.
 *
 * <p>What is real: every line of FaceclawBleCommunicator and RingProtocol on
 * the ring path, including the handshake, the five-type pull, the page
 * journal, the ACK queue and the receipt files it writes. What is fake: the
 * glasses (the harness sets {@code sessionReady} and never runs the glasses
 * side), the radio (FaceclawBleManager is replaced), the clock (it can jump and
 * runs 10x), and the ring (answers every request at once). The worker loop is
 * not run; the harness calls the loop's ring section instead - the
 * communicator's own {@code ringLinkPass()} where it has one, else the same
 * five calls in the same order run() makes them.
 *
 * <p>Runs against any checkout, including the base: that is how it shows it
 * catches the bug rather than merely passing on the fix.
 *
 * <pre>
 *   notes/ring-link-harness/run.sh [source-root] [transcript-dir]
 * </pre>
 */
public final class RingLinkHarness {
    static final String R = "AA:AA:AA:AA:AA:01";
    static final String L = "AA:AA:AA:AA:AA:02";
    static final String RING = "BB:BB:BB:BB:BB:03";
    static final long CYCLE_TIMEOUT_REAL_MS = 20_000L;

    private static int checks;
    private static boolean passAnnounced;
    private static int failures;
    private static File transcriptDir;

    public static void main(String[] args) throws Exception {
        SystemClock.speed = 10.0;
        Log.echo = Boolean.getBoolean("harness.echo");
        transcriptDir = args.length > 0 ? new File(args[0]) : null;
        if (transcriptDir != null) {
            transcriptDir.mkdirs();
        }

        // -Dharness.only=<substring of a scenario name> runs just that one.
        String only = System.getProperty("harness.only", "");
        if ("onDemandConsecutiveOpens".contains(only)) onDemandConsecutiveOpens();
        if ("onDemandStaleUpDeadLink".contains(only)) onDemandStaleUpDeadLink();
        if ("onDemandTimedPulls".contains(only)) onDemandTimedPulls();
        if ("onDemandChargingNight".contains(only)) onDemandChargingNight();
        if ("onDemandRingAbsent".contains(only)) onDemandRingAbsent();
        if ("onDemandDisconnectCallbackEitherWay".contains(only)) onDemandDisconnectCallbackEitherWay();
        if ("onDemandPagesAndAcks".contains(only)) onDemandPagesAndAcks();
        if ("directUnchanged".contains(only)) directUnchanged();
        if ("glassesUnchanged".contains(only)) glassesUnchanged();
        if ("glassesChargeLatchEveryMode".contains(only)) glassesChargeLatchEveryMode();

        System.out.println();
        if (failures == 0) {
            System.out.println("PASS: all " + checks + " checks");
        } else {
            System.out.println("FAIL: " + failures + " of " + checks + " checks");
        }
        System.exit(failures == 0 ? 0 : 1);
    }

    // ------------------------------------------------------------------
    // Scenarios
    // ------------------------------------------------------------------

    /**
     * The instruction's first known-good value: three or more consecutive
     * Health-open pulls in one run, each a fresh link, the state back to idle
     * between them. Four here, two through each pull path: a gap past the
     * 5-minute automatic floor lets connectRing() run the pull itself; a gap of
     * 61 s leaves that to runRequestedRingHealthPull().
     */
    static void onDemandConsecutiveOpens() throws Exception {
        section("on-demand: four consecutive Health opens");
        Rig rig = new Rig(true);
        rig.glassesConnect();
        expect("a glasses connect does not dial the ring", rig.ble().dials == 0);
        expect("state is idle before any open", "idle".equals(rig.state()));

        long[] gaps = {0L, 61_000L, 6 * 60_000L, 61_000L};
        for (int i = 0; i < gaps.length; i++) {
            SystemClock.advance(gaps[i]);
            openCycle(rig, i + 1, "health-open");
        }
        expect("four opens, four dials, four deliberate drops",
            rig.ble().dials == 4 && rig.ble().deliberateDisconnects == 4);
        expect("no write ever hit a missing GATT client", rig.ble().writesRejectedNotConnected == 0);
        // The drop itself must bring the state down. If only the stale-state
        // safety net were doing it, each cycle would leave a ringLinkStale line.
        expect("the drop alone returns the state to idle: no ringLinkStale line",
            rig.receipts("ringLinkStale").isEmpty());
        expect("no pull aborted", rig.receipts("pullAborted").isEmpty());
        rig.close();
    }

    /**
     * The instruction's third known-good value, in the exact state the phone
     * was in on 09-23/24: flags say up, the manager holds no client. A Health
     * open must end in a pull, and a glasses reconnect in between must not be
     * turned away by the 0160 guard.
     */
    static void onDemandStaleUpDeadLink() throws Exception {
        section("on-demand: stale 'up', dead link");
        Rig rig = new Rig(true);
        rig.glassesConnect();
        openCycle(rig, 1, "health-open");

        // Force the 09-23 state.
        rig.set("ringConnected", true);
        rig.set("ringNotificationsReady", true);
        rig.set("ringLinkUpElapsedMs", SystemClock.elapsedRealtime());
        expect("forced: state reads up with no client behind it",
            "up".equals(rig.state()) && !rig.ble().hasGattClient(RING));

        int skipsBefore = rig.receipts("ringConnectSkipped").size();
        SystemClock.advance(61_000L);
        rig.requestPull("health-open");
        // A glasses reconnect lands while the ask is open - the 20:10:09 case.
        rig.call("tryConnectRing", "initial");
        int pullsBefore = rig.receipts("\"type\":\"pull\"").size();
        boolean done = rig.runUntil(() -> rig.receipts("\"type\":\"pull\"").size() > pullsBefore
            && "idle".equals(rig.state()));
        expect("the open ends in a pull and the link back at idle", done);
        expect("no ringConnectSkipped for a link that was not there",
            rig.receipts("ringConnectSkipped").size() == skipsBefore);
        expect("the pull after the stale state is on a new link",
            lastContains(rig.receipts("\"type\":\"pull\""), "\"link\":\"new\""));
        expect("nothing aborted on the way", rig.receipts("pullAborted").isEmpty()
            && rig.ble().writesRejectedNotConnected == 0);
        if (rig.hasTriggers()) {
            expect("the stale state was caught and receipted once",
                rig.receipts("ringLinkStale").size() == 1);
        }

        // And the organic way in: the client vanishes while the link lingers.
        SystemClock.advance(61_000L);
        rig.requestPull("health-open");
        int pullsBefore2 = rig.receipts("\"type\":\"pull\"").size();
        boolean pulled = rig.runUntil(() -> rig.receipts("\"type\":\"pull\"").size() > pullsBefore2);
        rig.ble().loseClientSilently(RING);
        boolean idle = rig.runUntil(() -> "idle".equals(rig.state()));
        expect("a client lost silently mid-linger still comes back to idle", pulled && idle);
        SystemClock.advance(61_000L);
        openCycle(rig, 3, "health-open");
        rig.close();
    }

    /**
     * Revision 2026-09-24 20:15 (Chris): "Only when needed" keeps its :01/:31
     * timed pulls. With the glasses connected and not charging, three ticks in
     * a row each raise the link, pull on a new link and drop it again.
     */
    static void onDemandTimedPulls() throws Exception {
        section("on-demand: timed pulls with the glasses on");
        Rig rig = new Rig(true);
        rig.glassesConnect();
        for (int i = 1; i <= 3; i++) {
            SystemClock.advance(30 * 60_000L);
            pullCycle(rig, "tick " + i, "tick");
        }
        expect("three ticks, three dials, three drops",
            rig.ble().dials == 3 && rig.ble().deliberateDisconnects == 3);
        expect("no tick was refused", rig.receipts("pullSkipped").isEmpty());
        rig.close();
    }

    /**
     * A night with the glasses in their case: every tick refused with a
     * receipt and no dial; a Health open still pulls; a glasses link that
     * drops and comes back in the case does not end the pause or fire the
     * morning pull; taking them off the charger fires exactly one pull; and
     * the next tick pulls as usual.
     */
    static void onDemandChargingNight() throws Exception {
        section("on-demand: a night on the charger");
        Rig rig = new Rig(true);
        rig.glassesConnect();
        SystemClock.advance(30 * 60_000L);
        pullCycle(rig, "evening tick", "tick");

        rig.chargingReading(true);
        int dials = rig.ble().dials;
        int pulls = rig.receipts("\"type\":\"pull\"").size();
        for (int i = 0; i < 4; i++) {
            SystemClock.advance(30 * 60_000L);
            rig.requestPull("tick");
            rig.runFor(300L);
        }
        List<String> refused = rig.receipts("\"reason\":\"glasses-charging\"");
        expect("four ticks on the charger: four refusals receipted, each a tick: " + refused.size(),
            refused.size() == 4 && refused.stream().allMatch(l -> l.contains("\"type\":\"pullSkipped\"")
                && l.contains("\"trigger\":\"tick\"")));
        expect("four ticks on the charger: no dial, no pull",
            rig.ble().dials == dials && rig.receipts("\"type\":\"pull\"").size() == pulls);
        expect("on the charger: idle, nothing wanted",
            "idle".equals(rig.state()) && rig.stateJson().contains("\"wanted\":false"));

        SystemClock.advance(61_000L);
        pullCycle(rig, "Health open on the charger", "health-open");

        // The glasses link drops in the case and comes back; until the first
        // battery poll on the new session the phase reads connected, not charging.
        rig.glassesLinkDrops();
        rig.glassesConnect();
        int dialsFlicker = rig.ble().dials;
        int pullsFlicker = rig.receipts("\"type\":\"pull\"").size();
        SystemClock.advance(30 * 60_000L);
        rig.requestPull("tick");
        rig.runFor(300L);
        expect("a tick in the reconnect gap before the first battery poll is still refused",
            rig.receipts("\"reason\":\"glasses-charging\"").size() == 5 && rig.ble().dials == dialsFlicker);
        rig.chargingReading(true);
        rig.runFor(1_000L);
        expect("the first poll says charging again: no morning pull from the flicker",
            rig.receipts("\"type\":\"pull\"").size() == pullsFlicker && rig.ble().dials == dialsFlicker);

        // Morning: off the charger.
        SystemClock.advance(30 * 60_000L);
        int pullsMorning = rig.receipts("\"type\":\"pull\"").size();
        int dialsMorning = rig.ble().dials;
        rig.chargingReading(false);
        rig.glassesConnect();
        boolean swept = rig.runUntil(() -> rig.receipts("\"type\":\"pull\"").size() > pullsMorning
            && "idle".equals(rig.state()));
        List<String> morning = rig.receipts("\"type\":\"pull\"");
        String sweep = morning.size() > pullsMorning ? morning.get(morning.size() - 1) : "(none)";
        expect("off the charger: one pull, trigger charger-off, new link, back to idle  " + sweep,
            swept && sweep.contains("\"trigger\":\"charger-off\"") && sweep.contains("\"link\":\"new\""));
        rig.runFor(1_500L);
        expect("off the charger: exactly one pull and one dial for it",
            rig.receipts("\"type\":\"pull\"").size() == pullsMorning + 1 && rig.ble().dials == dialsMorning + 1);

        SystemClock.advance(30 * 60_000L);
        pullCycle(rig, "first tick of the day", "tick");
        expect("the night's ticks were the only refusals",
            rig.receipts("\"reason\":\"glasses-charging\"").size() == 5);
        rig.close();
    }

    /**
     * The ring is not there (on its charger, out of range): an open dials for
     * its 60 s window, gives up, leaves a pullSkipped line and an idle link -
     * not a radio dialling forever - and the next open, with the ring back,
     * pulls normally.
     */
    static void onDemandRingAbsent() throws Exception {
        section("on-demand: ring absent, then back");
        FaceclawBleManager.ringPresent = false;
        try {
            Rig rig = new Rig(true);
            rig.glassesConnect();
            SystemClock.advance(61_000L);
            rig.requestPull("health-open");
            boolean gaveUp = rig.runUntil(() -> !rig.receipts("pullSkipped").isEmpty());
            rig.runFor(500L);
            int dialsWhileAbsent = rig.ble().dials;
            expect("the ask gives up with a pullSkipped line", gaveUp
                && lastContains(rig.receipts("pullSkipped"), "\"trigger\":\"health-open\",\"reason\":\"no-link\""));
            expect("it dialled, and a bounded number of times: " + dialsWhileAbsent,
                dialsWhileAbsent >= 1 && dialsWhileAbsent <= 4);
            expect("then idle, nothing wanted, no pull", "idle".equals(rig.state())
                && rig.stateJson().contains("\"wanted\":false") && rig.receipts("\"type\":\"pull\"").isEmpty());
            rig.runFor(1_000L);
            expect("and it stops dialling", rig.ble().dials == dialsWhileAbsent);

            FaceclawBleManager.ringPresent = true;
            SystemClock.advance(61_000L);
            openCycle(rig, 2, "health-open");
            rig.close();
        } finally {
            FaceclawBleManager.ringPresent = true;
        }
    }

    /**
     * The fix must not depend on Android's close() rule going one particular
     * way: with the DISCONNECTED delivered after close() anyway, three cycles
     * still come back to idle and no late callback marks a new link down.
     */
    static void onDemandDisconnectCallbackEitherWay() throws Exception {
        section("on-demand: DISCONNECTED delivered after close() anyway");
        FaceclawBleManager.deliverDisconnectAfterClose = true;
        try {
            Rig rig = new Rig(true);
            rig.glassesConnect();
            for (int i = 0; i < 3; i++) {
                SystemClock.advance(61_000L);
                openCycle(rig, i + 1, "health-open");
            }
            rig.close();
        } finally {
            FaceclawBleManager.deliverDisconnectAfterClose = false;
        }
    }

    /**
     * With DATA pages flowing: every page is journaled and ACKed before the
     * drop, none is discarded by it (the page-journal rule).
     */
    static void onDemandPagesAndAcks() throws Exception {
        section("on-demand: pages journaled and ACKed before each drop");
        FaceclawBleManager.pagesPerHealthRequest = 2;
        try {
            Rig rig = new Rig(true);
            rig.glassesConnect();
            for (int i = 0; i < 3; i++) {
                SystemClock.advance(61_000L);
                openCycle(rig, i + 1, "health-open");
            }
            List<String> sleepPages = rig.receipts("\"type\":\"page\"");
            expect("sleep pages got receipts (2 per pull, 3 pulls): " + sleepPages.size(), sleepPages.size() == 6);
            boolean anyDropped = false;
            for (String line : sleepPages) {
                anyDropped |= line.contains("dropped") || line.contains("withheld") || line.contains("not queued");
            }
            expect("no page ACK was dropped, withheld or left unqueued", !anyDropped);
            expect("no 'dropping N unsent ACK(s)' line",
                !rig.logContains("unsent ACK"));
            rig.close();
        } finally {
            FaceclawBleManager.pagesPerHealthRequest = 0;
        }
    }

    /**
     * Direct, which must be behaviourally untouched. Asserted here, and the
     * transcript is written out so run.sh can diff it against the base's.
     */
    static void directUnchanged() throws Exception {
        section("direct: held link, unchanged");
        Rig rig = new Rig(false);
        List<String> t = new ArrayList<>();
        rig.glassesConnect();
        boolean up = rig.runUntil(() -> "up".equals(rig.state())
            && rig.receipts("\"type\":\"pull\"").size() == 1);
        expect("a glasses connect dials and pulls at once", up && rig.ble().dials == 1);
        rig.checkpoint(t, "connect");

        SystemClock.advance(10_000L);
        rig.runFor(1_000L);
        expect("past any linger: the link is still up, never dropped",
            "up".equals(rig.state()) && rig.ble().deliberateDisconnects == 0);
        rig.checkpoint(t, "linger");

        SystemClock.advance(30 * 60_000L);
        rig.requestPull("tick");
        boolean held = rig.runUntil(() -> rig.receipts("\"type\":\"pull\"").size() == 2);
        expect("a tick pulls over the held link",
            held && lastContains(rig.receipts("\"type\":\"pull\""), "\"link\":\"held\"")
                && rig.ble().dials == 1);
        rig.checkpoint(t, "tick");

        SystemClock.advance(61_000L);
        rig.requestPull("health-open");
        boolean opened = rig.runUntil(() -> rig.receipts("\"type\":\"pull\"").size() == 3);
        expect("an open pulls over the held link", opened && rig.ble().dials == 1);
        rig.checkpoint(t, "open");

        rig.call("tryConnectRing", "initial");
        expect("the 0160 guard still skips a live link on a glasses reconnect",
            rig.receipts("ringConnectSkipped").size() == 1 && rig.ble().dials == 1);
        rig.checkpoint(t, "reconnect-guard");

        rig.ble().ringDropsLink(RING);
        boolean back = rig.runUntil(() -> "up".equals(rig.state()) && rig.ble().dials == 2);
        expect("a ring-side drop is re-dialled and held again", back);
        rig.checkpoint(t, "ring-drop");
        expect("Direct wrote no stale-link receipt", rig.receipts("ringLinkStale").isEmpty());
        if (rig.pullsFinished() >= 0) {
            expect("Direct: three pulls finished, and the communicator says it is not on demand",
                rig.pullsFinished() == 3 && !rig.isOnDemand());
        }
        if (rig.hasTriggers()) {
            List<String> pulls = rig.receipts("\"type\":\"pull\"");
            expect("Direct's three pulls say connect, tick, health-open",
                pulls.size() == 3 && pulls.get(0).contains("\"trigger\":\"connect\"")
                    && pulls.get(1).contains("\"trigger\":\"tick\"")
                    && pulls.get(2).contains("\"trigger\":\"health-open\""));
        }

        // A charging stretch (revision 2026-09-24): Direct ignores it for pulls.
        rig.chargingReading(true);
        SystemClock.advance(30 * 60_000L);
        rig.requestPull("tick");
        boolean chargingTick = rig.runUntil(() -> rig.receipts("\"type\":\"pull\"").size() == 4);
        expect("Direct: a tick while the glasses charge still pulls, over the held link",
            chargingTick && rig.ble().dials == 2 && rig.receipts("pullSkipped").isEmpty());
        rig.checkpoint(t, "charging-tick");
        rig.chargingReading(false);
        rig.glassesConnect();
        rig.runFor(1_000L);
        expect("Direct: off the charger, no extra pull and no re-dial of the held ring link",
            rig.receipts("\"type\":\"pull\"").size() == 4 && rig.ble().dials == 2);
        rig.checkpoint(t, "charger-off");
        writeTranscript("direct", t);
        rig.close();
    }

    /**
     * Ghost's speech mute (2026-09-24, late) reads the glasses' latched charge
     * reading, so the latch must follow battery answers in EVERY ring mode, not
     * only "Only when needed" - and must survive the phase flicker of a
     * reconnect in the case. Read from the field, so an older build shows
     * where it fell short (the latch stayed -1 outside on-demand); the getter
     * the TS side calls is checked against it where the build has one.
     */
    static void glassesChargeLatchEveryMode() throws Exception {
        String[][] modes = {{"on-demand", "true", RING}, {"direct", "false", RING}, {"glasses only", "false", ""}};
        for (String[] mode : modes) {
            String n = mode[0];
            section("glasses charge latch: " + n);
            Rig rig = new Rig(Boolean.parseBoolean(mode[1]), mode[2]);
            rig.glassesConnect();
            rig.runFor(200L);
            expect(n + ": not heard yet reads -1", rig.chargeLatch() == -1);
            rig.chargingReading(true);
            expect(n + ": a charging answer latches 1", rig.chargeLatch() == 1);
            rig.glassesLinkDrops();
            expect(n + ": the glasses link drops in the case: the phase flag reads not charging",
                !((Boolean) rig.get("chargingMode")));
            expect(n + ": ...and the latch still reads 1", rig.chargeLatch() == 1);
            rig.glassesConnect();
            rig.runFor(200L);
            expect(n + ": reconnected, before any battery answer: the latch still reads 1", rig.chargeLatch() == 1);
            rig.chargingReading(true);
            expect(n + ": the next answer says charging: 1", rig.chargeLatch() == 1);
            rig.chargingReading(false);
            expect(n + ": off the charger: 0", rig.chargeLatch() == 0);
            rig.close();
        }
    }

    /** "Only via glasses": no address, nothing happens, whatever asks. */
    static void glassesUnchanged() throws Exception {
        section("glasses: no ring address, unchanged");
        Rig rig = new Rig(false, "");
        List<String> t = new ArrayList<>();
        rig.glassesConnect();
        SystemClock.advance(30 * 60_000L);
        rig.requestPull("tick");
        rig.runFor(500L);
        SystemClock.advance(61_000L);
        rig.requestPull("health-open");
        rig.runFor(500L);
        expect("no dial, no receipt, state off",
            rig.ble().dials == 0 && rig.receipts("").isEmpty() && "off".equals(rig.state()));
        rig.checkpoint(t, "asks");
        writeTranscript("glasses", t);
        rig.close();
    }

    /**
     * One open: request, run the loop until a NEW pull receipt exists and the
     * state is idle again, then check the receipt and the link.
     */
    static void openCycle(Rig rig, int n, String trigger) throws Exception {
        pullCycle(rig, "open " + n, trigger);
    }

    static void pullCycle(Rig rig, String n, String trigger) throws Exception {
        int pullsBefore = rig.receipts("\"type\":\"pull\"").size();
        int dialsBefore = rig.ble().dials;
        int skipsBefore = rig.receipts("ringConnectSkipped").size();
        int finishedBefore = rig.pullsFinished();
        expect(n + ": starts idle", "idle".equals(rig.state()));
        rig.requestPull(trigger);
        boolean done = rig.runUntil(() -> rig.receipts("\"type\":\"pull\"").size() > pullsBefore
            && "idle".equals(rig.state()));
        List<String> pulls = rig.receipts("\"type\":\"pull\"");
        String last = pulls.size() > pullsBefore ? pulls.get(pulls.size() - 1) : "(none)";
        expect(n + ": a new pull receipt, and the state back to idle", done);
        expect(n + ": exactly one new pull receipt", pulls.size() == pullsBefore + 1);
        expect(n + ": the pull is on a new link  " + last, last.contains("\"link\":\"new\""));
        if (rig.hasTriggers()) {
            expect(n + ": the receipt says trigger " + trigger,
                last.contains("\"trigger\":\"" + trigger + "\""));
        }
        expect(n + ": one dial for it", rig.ble().dials == dialsBefore + 1);
        expect(n + ": the manager holds no ring client afterwards", !rig.ble().hasGattClient(RING));
        expect(n + ": nothing wanted afterwards", rig.stateJson().contains("\"wanted\":false"));
        expect(n + ": no ringConnectSkipped", rig.receipts("ringConnectSkipped").size() == skipsBefore);
        if (finishedBefore >= 0) {
            // The count the phone Health tab watches to redraw when the pull lands.
            expect(n + ": the finished-pull count moved by exactly one",
                rig.pullsFinished() == finishedBefore + 1);
            expect(n + ": the communicator says it is on demand", rig.isOnDemand());
        }
    }

    // ------------------------------------------------------------------
    // The rig: one communicator, one fake manager, one files dir
    // ------------------------------------------------------------------

    static final class HarnessContext extends Context {
        final File files;

        HarnessContext(File files) {
            this.files = files;
        }

        @Override public File getFilesDir() {
            return files;
        }
    }

    static final class Rig {
        final FaceclawBleCommunicator comm;
        final File files;
        final String ringAddress;
        private final Method pass;
        private final Method requestFor;

        Rig(boolean onDemand) throws Exception {
            this(onDemand, RING);
        }

        Rig(boolean onDemand, String ringAddress) throws Exception {
            this.ringAddress = ringAddress;
            files = Files.createTempDirectory("ring-link-harness").toFile();
            comm = new FaceclawBleCommunicator(new HarnessContext(files), R, L, ringAddress, onDemand);
            // The communicator's own ring section where it has one (164e444 on).
            // Named here exactly: a wrong name silently fell back to the copy
            // below until 2026-09-24's revision caught it - so the choice is
            // printed once per run, and reported in the result.
            pass = findMethod("runRingLinkPass");
            if (!passAnnounced) {
                passAnnounced = true;
                System.out.println("ring pass: " + (pass != null
                    ? "the communicator's own runRingLinkPass()"
                    : "a copy of 0878764's run() sequence (this build has no runRingLinkPass)"));
            }
            requestFor = findMethod("requestRingHealthNowFor", String.class);
            set("running", true);
        }

        FaceclawBleManager ble() {
            return FaceclawBleManager.last;
        }

        boolean hasTriggers() {
            return requestFor != null;
        }

        /** The finished-pull count the phone tab reads, or -1 on a build without it. */
        int pullsFinished() {
            Method m = findMethod("ringHealthPullsFinished");
            try {
                return m == null ? -1 : (Integer) m.invoke(comm);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }

        boolean isOnDemand() {
            Method m = findMethod("isRingLinkOnDemand");
            try {
                return m != null && (Boolean) m.invoke(comm);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }

        /**
         * The latched charge reading: the getter where the build has one (and
         * it must agree with the field), else the field itself.
         */
        int chargeLatch() {
            try {
                int field = (Integer) get("glassesChargingLatched");
                Method m = findMethod("glassesChargeLatch");
                if (m != null) {
                    int viaGetter = (Integer) m.invoke(comm);
                    if (viaGetter != field) {
                        throw new IllegalStateException("getter " + viaGetter + " != field " + field);
                    }
                }
                return field;
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }

        /** What connectLoopOnce() does for the ring once the glasses are up. */
        void glassesConnect() throws Exception {
            set("sessionReady", true);
            call("tryConnectRing", "initial");
            ble().drain();
        }

        /**
         * A battery-poll answer from the glasses: exactly what the settings
         * ACK handler does with it (updateChargingModeLocked under the lock).
         */
        void chargingReading(boolean charging) throws Exception {
            Method m = FaceclawBleCommunicator.class.getDeclaredMethod(
                "updateChargingModeLocked", boolean.class, int.class);
            m.setAccessible(true);
            synchronized (lockOf()) {
                m.invoke(comm, charging, 80);
            }
            ble().drain();
        }

        /** The glasses' own BLE link drops (right arm), as Android reports it. */
        void glassesLinkDrops() {
            comm.onConnectionStateChange(R, false);
        }

        void requestPull(String trigger) throws Exception {
            if (requestFor != null) {
                requestFor.invoke(comm, trigger);
            } else {
                comm.requestRingHealthNow();
            }
        }

        /** The worker loop's ring section, once. */
        void pass() throws Exception {
            if (pass != null) {
                pass.invoke(comm);
            } else {
                // 0878764's run(), verbatim in order.
                if ((Boolean) call("shouldAttemptRingConnect")) {
                    call("tryConnectRing", "retry");
                } else {
                    call("flushRingOutbound");
                    call("runRequestedRingHealthPull");
                    call("resumeAbortedRingHealthPull");
                    call("maybeDropOnDemandRingLink");
                }
            }
            ble().drain();
        }

        boolean runUntil(BooleanSupplier done) throws Exception {
            long deadline = System.currentTimeMillis() + CYCLE_TIMEOUT_REAL_MS;
            while (System.currentTimeMillis() < deadline) {
                pass();
                if (done.getAsBoolean()) {
                    return true;
                }
                Thread.sleep(5L);
            }
            return false;
        }

        void runFor(long realMs) throws Exception {
            long deadline = System.currentTimeMillis() + realMs;
            while (System.currentTimeMillis() < deadline) {
                pass();
                Thread.sleep(5L);
            }
        }

        String stateJson() {
            return comm.ringLinkReceiptJson();
        }

        String state() {
            String json = stateJson();
            int i = json.indexOf("\"state\":\"");
            if (i < 0) return "?";
            int start = i + 9;
            return json.substring(start, json.indexOf('"', start));
        }

        List<String> receipts(String containing) {
            File f = new File(new File(files, "health"), "ring-sleep-receipts.jsonl");
            if (!f.exists()) return Collections.emptyList();
            try {
                List<String> out = new ArrayList<>();
                for (String line : Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) {
                    if (line.contains(containing)) out.add(line);
                }
                return out;
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        }

        boolean logContains(String needle) {
            for (String line : Log.lines()) {
                if (line.contains(needle)) return true;
            }
            return false;
        }

        /** A normalised, order-free record of what has happened so far. */
        void checkpoint(List<String> t, String name) {
            List<String> lines = new ArrayList<>();
            for (String r : receipts("")) {
                lines.add("receipt " + normalise(r));
            }
            lines.add("state " + normalise(stateJson()));
            lines.add("counters dials=" + ble().dials + " drops=" + ble().deliberateDisconnects
                + " answered=" + ble().healthRequestsAnswered + " rejected=" + ble().writesRejectedNotConnected);
            Collections.sort(lines);
            t.add("== " + name);
            t.addAll(lines);
        }

        Object call(String name, Object... args) throws Exception {
            Class<?>[] types = new Class<?>[args.length];
            for (int i = 0; i < args.length; i++) {
                types[i] = args[i].getClass();
            }
            Method m = FaceclawBleCommunicator.class.getDeclaredMethod(name, types);
            m.setAccessible(true);
            return m.invoke(comm, args);
        }

        Object get(String field) throws Exception {
            Field f = FaceclawBleCommunicator.class.getDeclaredField(field);
            f.setAccessible(true);
            synchronized (lockOf()) {
                return f.get(comm);
            }
        }

        void set(String field, Object value) throws Exception {
            Field f = FaceclawBleCommunicator.class.getDeclaredField(field);
            f.setAccessible(true);
            synchronized (lockOf()) {
                f.set(comm, value);
            }
        }

        private Object lockOf() throws Exception {
            Field f = FaceclawBleCommunicator.class.getDeclaredField("lock");
            f.setAccessible(true);
            return f.get(comm);
        }

        void close() {
            try {
                set("running", false);
            } catch (Exception ignored) {
                // best effort
            }
        }

        private static Method findMethod(String name, Class<?>... types) {
            try {
                Method m = FaceclawBleCommunicator.class.getDeclaredMethod(name, types);
                m.setAccessible(true);
                return m;
            } catch (NoSuchMethodException e) {
                return null;
            }
        }
    }

    // ------------------------------------------------------------------

    /** Strip what legitimately differs between two runs: clocks, and the new trigger field. */
    static String normalise(String line) {
        return line
            .replaceAll(",\"trigger\":\"[^\"]*\"", "")
            .replaceAll("\"(req|at|rx|ack)\":\"[^\"]*\"", "\"$1\":\"T\"")
            .replaceAll("\"(reqMs|doneMs|atMs|linkAgeMs|ageMs|rxMs|ackMs|ackLatencyMs|n)\":-?[0-9]+", "\"$1\":#");
    }

    static boolean lastContains(List<String> lines, String needle) {
        return !lines.isEmpty() && lines.get(lines.size() - 1).contains(needle);
    }

    static void writeTranscript(String name, List<String> t) throws IOException {
        if (transcriptDir == null) return;
        Files.write(new File(transcriptDir, name + ".txt").toPath(), t, StandardCharsets.UTF_8);
    }

    static void expect(String what, boolean ok) {
        checks++;
        if (!ok) failures++;
        System.out.println((ok ? "   ok    " : "   FAIL  ") + what);
    }

    static void section(String name) {
        System.out.println();
        System.out.println("-- " + name);
    }
}
