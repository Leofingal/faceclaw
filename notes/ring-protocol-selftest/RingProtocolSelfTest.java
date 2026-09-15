package com.faceclaw.app;

import java.util.Arrays;
import java.util.List;

/**
 * Standalone self-test for {@link RingProtocol}. No Android APIs and no
 * hardware: every byte-manipulation path is exercised against either frames
 * copied from the reference capture or synthetic bodies built from the spec's
 * field layout.
 *
 * <pre>
 *   javac -d /tmp/rpt App_Resources/Android/src/main/java/com/faceclaw/app/g2protocol/RingProtocol.java \
 *                     notes/ring-protocol-selftest/RingProtocolSelfTest.java
 *   java -cp /tmp/rpt com.faceclaw.app.RingProtocolSelfTest
 * </pre>
 *
 * <p>The captured frames reproduced below are requests, page-ACKs, the ring's
 * device-channel 00:08 pushes and its battery-shaped 00:01/00:7F/00:03 frames.
 * Those carry a nonce, a command id, a sequence number and at most battery or
 * state bytes — no biometric values. No captured health DATA page appears
 * here, deliberately.
 */
public final class RingProtocolSelfTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) {
        testCrcAndRequestRoundTrip();
        testFiveHealthRequests();
        testPageAckAgainstCapture();
        testParseRejectsGarbage();
        testFragmentReassembly();
        testHourlyDecode();
        testStepsDecode();
        testSleepDecodeAndIdentities();
        testSleepReceiptLines();
        testEvenConnectFramesAgainstCapture();
        testReconnectGuardAndBootReceipts();
        testRingBatteryReceipts();

        System.out.println();
        System.out.println(failures == 0
            ? "PASS: all " + checks + " checks"
            : "FAIL: " + failures + " of " + checks + " checks");
        if (failures != 0) {
            System.exit(1);
        }
    }

    // ------------------------------------------------------------------

    /**
     * Rebuild captured request pkt 9166 from its decoded fields alone. If the
     * CRC-32C parameters or the header layout are wrong by even one bit this
     * cannot reproduce the captured bytes.
     */
    private static void testCrcAndRequestRoundTrip() {
        section("CRC + request round-trip (captured pkt 9166)");
        byte[] built = RingProtocol.buildRequest(
            RingProtocol.CHAN_HEALTH,
            RingProtocol.CMD_HI_HEART_RATE,
            RingProtocol.CMD_LO_HEALTH,
            0x06,
            0x08ca);
        expectHex("pkt 9166", "00db64265a64026406000001010c00ca08", built);

        RingProtocol.Frame frame = RingProtocol.parse(built);
        expect("parses back", frame != null && frame.crcOk);
        expect("chan", frame.chan == RingProtocol.CHAN_HEALTH);
        expect("kind REQ", frame.kind == RingProtocol.KIND_REQ);
        expect("seq", frame.seq == 0x06);
        expect("cmd 01:01", frame.cmdHi == 0x01 && frame.cmdLo == 0x01);
        expect("payload is the 2-byte nonce", frame.payload.length == 2);

        // A single flipped payload bit must invalidate the CRC.
        byte[] tampered = built.clone();
        tampered[15] ^= 0x01;
        RingProtocol.Frame bad = RingProtocol.parse(tampered);
        expect("tampered frame fails CRC", bad != null && !bad.crcOk);
    }

    /** The five ready-to-send health requests, seq=1, nonce=0. */
    private static void testFiveHealthRequests() {
        section("five health requests (spec section 9)");
        String[][] expected = {
            {"heart rate", "00450fe48f64026401000001010c000000"},
            {"SpO2",       "000d3fd33364026401000002010c000000"},
            {"HRV",        "00dc30615564026401000004010c000000"},
            {"steps",      "00e4208c3e64026401000005010c000000"},
            {"sleep",      "00ac10bb8264026401000006010c000000"},
        };
        int[] commands = {
            RingProtocol.CMD_HI_HEART_RATE,
            RingProtocol.CMD_HI_SPO2,
            RingProtocol.CMD_HI_HRV,
            RingProtocol.CMD_HI_STEPS,
            RingProtocol.CMD_HI_SLEEP,
        };
        for (int i = 0; i < commands.length; i++) {
            byte[] built = RingProtocol.buildHealthRequest(commands[i], 0x01, 0x0000);
            expectHex(expected[i][0], expected[i][1], built);
        }

        // The convenience burst builder must produce the same first frame and
        // then advance the shared sequence counter by one per frame.
        List<byte[]> burst = RingProtocol.buildHealthRequestBurst(0x01, 0x0000);
        expect("burst has five frames", burst.size() == 5);
        expectHex("burst[0] == heart rate", expected[0][1], burst.get(0));
        boolean seqRuns = true;
        for (int i = 0; i < burst.size(); i++) {
            RingProtocol.Frame f = RingProtocol.parse(burst.get(i));
            if (f == null || !f.crcOk || f.seq != 0x01 + i) {
                seqRuns = false;
            }
        }
        expect("burst sequence numbers run 1..5 and all CRCs are valid", seqRuns);
    }

    /**
     * Rebuild real captured page-ACKs. This is what pins down the two things
     * the prose spec got wrong: the payload begins with the usual nonce (so the
     * echoed page seq is at offset 6, not 4), and the frame's own SEQ is the
     * phone's shared counter rather than the echoed page seq.
     */
    private static void testPageAckAgainstCapture() {
        section("page ACK 00:7E rebuilt from captured frames");
        // seq, nonce, ackedCmdHi, ackedCmdLo, pageSeq, expected hex
        Object[][] cases = {
            {0x0d, 0x5f49, 0x01, 0x01, 0x03, "005e55d80b6401640d0001007e1600495f02010100030000000000"},
            {0x13, 0xdc10, 0x04, 0x01, 0x07, "00a2bae3c4640164130001007e160010dc02040100070000000000"},
            {0x17, 0x86e9, 0x02, 0x01, 0x09, "002c006c61640164170001007e1600e98602020100090000000000"},
            {0x23, 0x634c, 0x06, 0x01, 0x13, "00b96c8823640164230001007e16004c6302060100130000000000"},
            {0x25, 0x46f2, 0x05, 0x01, 0x14, "00474ee8b8640164250001007e1600f24602050100140000000000"},
            {0x14, 0x7bc3, 0x05, 0x01, 0x3b, "00f3a5a917640164140001007e1600c37b020501003b0000000000"},
        };
        for (Object[] c : cases) {
            byte[] built = RingProtocol.buildPageAck(
                (Integer) c[0], (Integer) c[1], (Integer) c[2], (Integer) c[3], (Integer) c[4]);
            expectHex("ack for cmd " + hex2((Integer) c[2]) + ":" + hex2((Integer) c[3])
                + " page seq " + hex2((Integer) c[4]), (String) c[5], built);
        }

        RingProtocol.Frame f = RingProtocol.parse(RingProtocol.buildPageAck(0x0d, 0x5f49, 0x01, 0x01, 0x03));
        expect("ack rides the DEVICE channel", f.chan == RingProtocol.CHAN_DEVICE);
        expect("ack kind is ACK", f.kind == RingProtocol.KIND_ACK);
        expect("ack command is 00:7e", f.cmdHi == 0x00 && f.cmdLo == 0x7e);
        expect("ack header seq differs from echoed page seq", f.seq != (f.payload[6] & 0xff));
        expect("echoed page seq is at payload[6]", (f.payload[6] & 0xff) == 0x03);
    }

    /**
     * Known-good assertion for the 2026-09-14 handshake: rebuild a complete
     * Even connect's device-channel writes from their decoded fields and
     * reproduce the captured ATT values byte for byte, CRC included.
     * Source: bazzite-desktop:/tmp/br4_last/btsnoop_hci.log.last, pkts
     * 64287-64690, Even's app, 2026-09-11 05:32:18 EDT (btsnoop label 01:32:18
     * plus this phone's 4 h snoop skew).
     *
     * <p>EVEN_CLOCK is that capture's clock value: the phone's plain Unix time
     * at that instant (1789119138 = 2026-09-11 09:32:18 UTC). The 00:05 frames
     * carry the SAME u32 as the 00:0E - not local midnight. No DATA page here.
     */
    private static void testEvenConnectFramesAgainstCapture() {
        section("Even connect device frames rebuilt from br4l capture (00:08/0E/05/01/05/0A/0A/06:02/04)");
        final long evenClock = 1789119138L;
        expectHex("pkt 64287 00:08 hello", "00971953f964016401000000080d003f0101",
            RingProtocol.buildHello(0x01));
        expectHex("pkt 64303 00:0E clock set", "00414eef16640164020002000e1800c9a6a2caa36a0100000000000000",
            RingProtocol.buildClockSet(0x02, 0xa6c9, evenClock));
        expectHex("pkt 64324 00:05 (first)", "00b0f79eb964016403000200051200282810ffa2caa36a",
            RingProtocol.buildDayAnchorWrite(0x03, 0x2828, evenClock));
        expectHex("pkt 64336 00:01", "00a16eee6064016404000000010c004b3d",
            RingProtocol.buildDeviceRequest(0x01, 0x04, 0x3d4b));
        expectHex("pkt 64393 00:05 (second, same clock)", "000de3911a64016405000200051200162310ffa2caa36a",
            RingProtocol.buildDayAnchorWrite(0x05, 0x2316, evenClock));
        expectHex("pkt 64411 00:0A", "008c9c8ae8640164060000000a1800a882f8f53d235ac4ceaa073885cc",
            RingProtocol.buildDeviceRequest(0x0a, 0x06, 0x82a8));
        expectHex("pkt 64462 00:0A (again)", "00bb857344640164070000000a18009972f8f53d235ac4ceaa073885cc",
            RingProtocol.buildDeviceRequest(0x0a, 0x07, 0x7299));
        expectHex("pkt 64473 06:02 health-channel DATA", "00c0d450e764026408000206020c0097c4",
            RingProtocol.buildHealth0602(0x08, 0xc497));
        expectHex("pkt 64690 00:04 settings", "00db4db2126401640c000000041800c9f40000b7005100000000000000",
            RingProtocol.buildDeviceRequest(0x04, 0x0c, 0xf4c9));

        // The midnight reading of 00:05 is dead: a midnight anchor for that
        // capture's day (2026-09-11 00:00 EDT = 1789099200) does NOT reproduce it.
        String midnightBuilt = RingProtocol.hex(RingProtocol.buildDayAnchorWrite(0x03, 0x2828, 1789099200L));
        expect("a local-midnight 00:05 does not match pkt 64324",
            !"00b0f79eb964016403000200051200282810ffa2caa36a".equals(midnightBuilt));

        int[] even = {RingProtocol.CMD_HI_HEART_RATE, RingProtocol.CMD_HI_HRV, RingProtocol.CMD_HI_SPO2,
            RingProtocol.CMD_HI_SLEEP, RingProtocol.CMD_HI_STEPS};
        expect("HEALTH_COMMANDS is Even's order 01,04,02,06,05",
            Arrays.equals(even, RingProtocol.HEALTH_COMMANDS));
        expect("interleave table has one row per health type",
            RingProtocol.EVEN_DEVICE_REQS_AFTER_TYPE.length == RingProtocol.HEALTH_COMMANDS.length);
        expect("after 01:01 Even sends 00:02, 00:0A, 00:04, 00:01",
            Arrays.equals(new int[] {0x02, 0x0a, 0x04, 0x01}, RingProtocol.EVEN_DEVICE_REQS_AFTER_TYPE[0]));
    }

    private static void testParseRejectsGarbage() {
        section("parser rejects non-frames");
        expect("null", RingProtocol.parse(null) == null);
        expect("too short", RingProtocol.parse(new byte[8]) == null);
        expect("no magic", RingProtocol.parse(new byte[20]) == null);
        // A 3-byte ring gesture frame must not look like a header.
        expect("gesture frame is not a header",
            !RingProtocol.looksLikeHeader(new byte[] {(byte) 0xff, 0x04, 0x01}));
        // A frame whose PLEN disagrees with its actual length is rejected.
        byte[] frame = RingProtocol.buildHealthRequest(RingProtocol.CMD_HI_HRV, 1, 0);
        byte[] truncated = Arrays.copyOf(frame, frame.length - 1);
        expect("length/PLEN mismatch rejected", RingProtocol.parse(truncated) == null);
    }

    /**
     * Fragmentation, reproducing the shape the capture actually shows: an
     * oversized frame split into a 244-byte FLAG=0x01 head and a headerless
     * continuation, with an unrelated complete frame arriving in between.
     */
    private static void testFragmentReassembly() {
        section("fragment reassembly");
        // Build a 252-byte steps-shaped frame: 15 header + 237 payload.
        byte[] payload = new byte[237];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) (i * 7 + 3);
        }
        byte[] whole = RingProtocol.buildFrame(
            RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
            RingProtocol.CMD_HI_STEPS, RingProtocol.CMD_LO_HEALTH, 0x15, payload);
        expect("test frame is 252 bytes", whole.length == 252);

        byte[] head = Arrays.copyOf(whole, 244);
        head[0] = (byte) RingProtocol.FLAG_FRAGMENTED;
        byte[] continuation = new byte[RingProtocol.CONTINUATION_PREFIX_LEN + (whole.length - 244)];
        System.arraycopy(whole, 244, continuation, RingProtocol.CONTINUATION_PREFIX_LEN, whole.length - 244);
        expect("continuation is 5 + remaining bytes", continuation.length == 13);

        byte[] interleaved = RingProtocol.buildFrame(
            RingProtocol.CHAN_DEVICE, RingProtocol.KIND_DATA, 0x00, 0x01, 0x16, new byte[9]);

        RingProtocol.Reassembler reassembler = new RingProtocol.Reassembler();

        RingProtocol.Intake first = reassembler.accept(head);
        expect("head consumed", first.consumed && first.frame == null);
        expect("fragment outstanding", reassembler.hasPending());

        RingProtocol.Intake middle = reassembler.accept(interleaved);
        expect("interleaved frame still parses while a fragment is pending",
            middle.consumed && middle.frame != null && middle.frame.crcOk);
        expect("fragment survives the interleaved frame", reassembler.hasPending());

        RingProtocol.Intake done = reassembler.accept(continuation);
        expect("continuation completes the frame", done.consumed && done.frame != null);
        expect("reassembled frame passes CRC", done.frame.crcOk);
        expect("reassembled bytes are exact",
            Arrays.equals(done.frame.raw, headJoined(head, whole)));
        expect("no fragment left outstanding", !reassembler.hasPending());
        expect("reassembled payload is intact", Arrays.equals(done.frame.payload, payload));

        // Non-protocol traffic must pass straight through untouched.
        RingProtocol.Intake gesture = reassembler.accept(new byte[] {(byte) 0xff, 0x04, 0x01});
        expect("gesture frame is not consumed", !gesture.consumed);
    }

    private static byte[] headJoined(byte[] head, byte[] whole) {
        byte[] expected = whole.clone();
        expected[0] = head[0];
        return expected;
    }

    // ------------------------------------------------------------------
    // Synthetic record bodies, built directly from the spec's field layout.
    // ------------------------------------------------------------------

    private static void testHourlyDecode() {
        section("hourly decode (heart rate W=1, HRV W=2, backlog page)");

        // Anchored heart-rate page, W=1, three groups.
        long anchor = 1788926400L; // 2026-09-09 00:00 local, the capture's anchor
        int[][] groups = {{0, 61, 88, 55}, {1, 58, 71, 52}, {2, 63, 90, 57}};
        byte[] body = hourlyBody(3, anchor, 12345L, 64, 1, groups);
        RingProtocol.Frame frame = dataFrame(RingProtocol.CMD_HI_HEART_RATE, body);
        RingProtocol.HourlyRecord hr = RingProtocol.decodeHourly(frame, 0L);
        expect("HR decodes", hr != null);
        expect("HR width resolved to 1", hr.valueWidth == 1);
        expect("HR group count", hr.groups.length == 3);
        expect("HR anchor", hr.anchorUnixSeconds == anchor);
        expect("HR not backlog", !hr.isBacklog());
        expect("HR current", hr.current == 64);
        boolean values = true;
        for (int i = 0; i < groups.length; i++) {
            RingProtocol.HourlyGroup g = hr.groups[i];
            values &= g.hourIndex == groups[i][0] && g.avg == groups[i][1]
                && g.max == groups[i][2] && g.min == groups[i][3]
                && g.unixSeconds == anchor + groups[i][0] * 3600L;
        }
        expect("HR values and hour timestamps round-trip", values);

        // HRV uses two-byte values; the width must be resolved, not assumed.
        int[][] hrvGroups = {{8, 300, 420, 210}, {9, 275, 380, 190}, {10, 512, 640, 400}};
        byte[] hrvBody = hourlyBody(3, anchor, 22222L, 333, 2, hrvGroups);
        RingProtocol.HourlyRecord hrv =
            RingProtocol.decodeHourly(dataFrame(RingProtocol.CMD_HI_HRV, hrvBody), 0L);
        expect("HRV decodes", hrv != null);
        expect("HRV width resolved to 2", hrv.valueWidth == 2);
        expect("HRV current", hrv.current == 333);
        expect("HRV holds values above 255", hrv.groups[2].max == 640);

        // Backlog page: anchor absent. The hour index must survive; the absolute
        // time must NOT be invented.
        byte[] backlogBody = hourlyBody(3, RingProtocol.UNKNOWN_TIME, 77777L, 60, 1, groups);
        RingProtocol.HourlyRecord backlog =
            RingProtocol.decodeHourly(dataFrame(RingProtocol.CMD_HI_HEART_RATE, backlogBody), 0L);
        expect("backlog decodes", backlog != null);
        expect("backlog flagged", backlog.isBacklog());
        expect("backlog anchor unknown", backlog.anchorUnixSeconds == RingProtocol.UNKNOWN_TIME);
        boolean noInventedTime = true;
        for (RingProtocol.HourlyGroup g : backlog.groups) {
            noInventedTime &= g.unixSeconds == RingProtocol.UNKNOWN_TIME;
        }
        expect("backlog groups carry no invented absolute time", noInventedTime);
        expect("backlog keeps raw hour indices",
            backlog.groups[0].hourIndex == 0 && backlog.groups[2].hourIndex == 2);
        expect("backlog still decodes values", backlog.groups[1].avg == 58);
    }

    private static void testStepsDecode() {
        section("steps decode");
        long anchor = 1788926400L;
        int[][] buckets = {{0, 120, 4, 16}, {3, 0, 0, 12}, {130, 45, 2, 14}};
        byte[] body = stepsBody(anchor, buckets);
        RingProtocol.StepsRecord steps =
            RingProtocol.decodeSteps(dataFrame(RingProtocol.CMD_HI_STEPS, body), 0L);
        expect("steps decode", steps != null);
        expect("bucket count", steps.buckets.length == 3);
        expect("total steps", steps.totalSteps() == 165);
        expect("raw index preserved, including the 130+ jump",
            steps.buckets[2].index == 130);
        expect("v2/v3 kept as unconfirmed calorie-shaped fields",
            steps.buckets[0].calorieLike2 == 4 && steps.buckets[0].calorieLike3 == 16);
        expect("steps anchor", steps.anchorUnixSeconds == anchor);
        // Length must be exact: a truncated body is a decode failure, not a guess.
        byte[] shortBody = Arrays.copyOf(body, body.length - 1);
        expect("truncated steps body rejected",
            RingProtocol.decodeSteps(dataFrame(RingProtocol.CMD_HI_STEPS, shortBody), 0L) == null);
    }

    private static void testSleepDecodeAndIdentities() {
        section("sleep decode + the spec's arithmetic identities");
        // segments: (stage, halfMinutes). Stage sums: 0->10, 1->20, 2->70, 3->25.
        int[][] segments = {{0, 4}, {1, 20}, {2, 40}, {0, 6}, {2, 30}, {3, 25}};
        int totalHalfMinutes = 125;
        int seconds = totalHalfMinutes * 30;   // 3750
        int wake = 10 * 30;                    // 300, stage 0
        int rem = 20 * 30;                     // 600, stage 1
        int light = 70 * 30;                   // 2100, stage 2
        int deep = 25 * 30;                    // 750, stage 3
        int total = seconds - wake;            // 3450
        long start = 100000L;
        long end = start + seconds;

        byte[] body = sleepBody(1, start, end, total, wake, rem, light, deep, segments);
        RingProtocol.SleepRecord sleep =
            RingProtocol.decodeSleep(dataFrame(RingProtocol.CMD_HI_SLEEP, body), 0L);
        expect("sleep decodes", sleep != null);
        expect("real record", sleep.isRealRecord());
        expect("segment count", sleep.segments.length == segments.length);
        expect("segment stages and durations round-trip",
            sleep.segments[2].stage == 2 && sleep.segments[2].halfMinutes == 40);

        expect("identity: sum(half_minutes) x 30 == total_time + wake_time",
            sleep.totalHalfMinutes() * 30 == sleep.totalTime + sleep.wakeTime);
        expect("identity: sum(half_minutes) x 30 == end_ts - start_ts",
            sleep.totalHalfMinutes() * 30 == (int) (sleep.endTs - sleep.startTs));
        expect("identity: per-stage sums match the four stage totals",
            sleep.halfMinutesForStage(0) * 30 == wake
                && sleep.halfMinutesForStage(1) * 30 == rem
                && sleep.halfMinutesForStage(2) * 30 == light
                && sleep.halfMinutesForStage(3) * 30 == deep);
        expect("identitiesHold() agrees", sleep.identitiesHold());

        expect("uncracked 6-byte field stored raw, not interpreted",
            sleep.unknownPrefix.length == 6);
        expect("relative timestamps kept as sent",
            sleep.startTs == start && sleep.endTs == end);

        // The empty end-of-list marker must decode without inventing a session.
        byte[] marker = new byte[] {0x11, 0x22, 0x02};
        RingProtocol.SleepRecord empty =
            RingProtocol.decodeSleep(dataFrame(RingProtocol.CMD_HI_SLEEP, marker), 0L);
        expect("RECSTATE=2 marker decodes", empty != null && !empty.isRealRecord());
        expect("marker has no segments", empty.segments.length == 0);

        // A declared segment count that does not fill the body is a parse failure.
        byte[] broken = body.clone();
        broken[32] = (byte) (segments.length + 1);
        expect("segment-count mismatch rejected",
            RingProtocol.decodeSleep(dataFrame(RingProtocol.CMD_HI_SLEEP, broken), 0L) == null);
    }

    /**
     * The sleep receipt log (ring-sleep-receipts.jsonl). The file append lives in
     * FaceclawBleCommunicator and needs Android; the LINE is built here, purely,
     * so what a morning pull will read is pinned. Each line is also printed with
     * a RECEIPT prefix so a caller can JSON-parse it.
     */
    private static void testSleepReceiptLines() {
        section("sleep receipt log lines");
        int[][] segments = {{0, 4}, {2, 40}};
        long start = 1789295708L;
        long end = start + 44 * 30;
        byte[] body = sleepBody(1, start, end, 40 * 30, 4 * 30, 0, 40 * 30, 0, segments);
        RingProtocol.Frame page = dataFrame(RingProtocol.CMD_HI_SLEEP, body);

        String line = RingProtocol.sleepPageReceiptLine(page, 1789300000123L, 1789300000135L, 12L, true, null);
        System.out.println("RECEIPT " + line);
        expect("page line is a single line", !line.contains("\n"));
        expect("page line is typed", line.startsWith("{\"type\":\"page\""));
        expect("carries receive time", line.contains("\"rxMs\":1789300000123"));
        expect("carries RECSTATE", line.contains("\"recState\":1"));
        expect("carries RAW ring start/end, uncorrected",
            line.contains("\"startTs\":" + start) && line.contains("\"endTs\":" + end));
        expect("carries segment count", line.contains("\"segments\":2"));
        expect("carries the page's own seq", line.contains("\"pageSeq\":32"));
        expect("carries ACK written time, latency and outcome",
            line.contains("\"ackMs\":1789300000135") && line.contains("\"ackLatencyMs\":12")
                && line.contains("\"ackOk\":true"));
        expect("carries the whole payload as hex",
            line.contains("\"payloadHex\":\"" + RingProtocol.hex(page.payload) + "\""));
        expect("no note when the ACK went out", !line.contains("\"note\""));

        String unsent = RingProtocol.sleepPageReceiptLine(page, 1L, -1L, -1L, false, "ACK dropped: link \"dropped\"");
        System.out.println("RECEIPT " + unsent);
        expect("an unsent ACK is null, not zero",
            unsent.contains("\"ack\":null") && unsent.contains("\"ackLatencyMs\":null")
                && unsent.contains("\"ackOk\":false"));
        expect("note is JSON-escaped", unsent.contains("\"note\":\"ACK dropped: link \\\"dropped\\\"\""));

        String marker = RingProtocol.sleepPageReceiptLine(
            dataFrame(RingProtocol.CMD_HI_SLEEP, new byte[] {0x11, 0x22, 0x02}), 5L, 6L, 1L, true, null);
        System.out.println("RECEIPT " + marker);
        expect("RECSTATE=2 end marker gets a receipt with no session times",
            marker.contains("\"recState\":2") && !marker.contains("startTs") && !marker.contains("\"decoded\""));

        String pull = RingProtocol.sleepPullReceiptLine(1000L, 2600L, true, 3, 2, true);
        System.out.println("RECEIPT " + pull);
        expect("pull line carries rsp and page count",
            pull.startsWith("{\"type\":\"pull\"") && pull.contains("\"rsp\":true")
                && pull.contains("\"pages\":3") && pull.contains("\"doneMs\":2600"));
        expect("pull line keeps sleep pages and other-type pages apart",
            pull.contains("\"pages\":3,\"otherPages\":2,"));
        expect("pull line says the link was new (first pull after a handshake)",
            pull.endsWith(",\"link\":\"new\"}"));
        expect("a held-link pull says held",
            RingProtocol.sleepPullReceiptLine(1000L, 2600L, true, 0, 0, false).endsWith(",\"link\":\"held\"}"));
    }

    /**
     * 2026-09-15 reconnect guard and ring-boot receipt. The guard lives in
     * FaceclawBleCommunicator.tryConnectRing and needs Android; its predicate is
     * pinned here. The boot detector runs against the ring's own 00:08 frames
     * from bazzite-desktop's 09-15 capture (FS__data__log__bt__btsnoop_hci.log,
     * handle 0x0017 rx and 0x0015 tx). Each carries a 2-byte nonce and one or
     * three argument bytes, no biometric values.
     */
    private static void testReconnectGuardAndBootReceipts() {
        section("reconnect guard + ring boot receipt (09-15 capture 00:08 frames)");
        expect("connected + notifications ready -> skip, connectRing() not called",
            RingProtocol.ringConnectShouldSkip(true, true));
        expect("connected, notifications NOT ready -> connect (the retry path's case)",
            !RingProtocol.ringConnectShouldSkip(true, false));
        expect("not connected -> connect", !RingProtocol.ringConnectShouldSkip(false, false));
        expect("ready flag without a link -> connect", !RingProtocol.ringConnectShouldSkip(false, true));

        final String bootHex = "004a4af65364016400000200080d00376d00";
        RingProtocol.Frame boot = RingProtocol.parse(unhex(bootHex));
        expect("pkt 41285 (06:22:00) parses CRC-clean: device DATA 00:08 seq 00 payload 376d00",
            boot != null && boot.crcOk && boot.chan == RingProtocol.CHAN_DEVICE
                && boot.kind == RingProtocol.KIND_DATA && "00:08".equals(boot.commandLabel())
                && boot.seq == 0 && "376d00".equals(RingProtocol.hex(boot.payload)));
        expect("pkt 41285 is the boot signature", RingProtocol.isRingBootHello(boot));
        expectHex("buildFrame reproduces pkt 41285 from its fields", bootHex,
            RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_DATA, 0x00, 0x08, 0x00,
                new byte[] {0x37, 0x6d, 0x00}));
        expect("the same push at seq 01 is not",
            !RingProtocol.isRingBootHello(RingProtocol.parse(RingProtocol.buildFrame(
                RingProtocol.CHAN_DEVICE, RingProtocol.KIND_DATA, 0x00, 0x08, 0x01, new byte[] {0x37, 0x6d, 0x00}))));
        expect("pkt 682 (02:41:10, push seq 4b) is not",
            !RingProtocol.isRingBootHello(RingProtocol.parse(unhex("00611281706401644b000200080d00445c00"))));
        expect("pkt 49829 (06:38:07, push seq 2d) is not",
            !RingProtocol.isRingBootHello(RingProtocol.parse(unhex("00d12d51136401642d000200080d00a7fd00"))));
        expect("pkt 683, the ring's RSP to our hello (seq 01), is not",
            !RingProtocol.isRingBootHello(RingProtocol.parse(unhex("00a25aac9264016401000300080d00a76400"))));
        expect("pkt 41282, our own 00:08 REQ, is not",
            !RingProtocol.isRingBootHello(RingProtocol.parse(unhex("00971953f964016401000000080d003f0101"))));
        expect("a seq-00 health DATA page is not",
            !RingProtocol.isRingBootHello(RingProtocol.parse(RingProtocol.buildFrame(
                RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA, RingProtocol.CMD_HI_SLEEP,
                RingProtocol.CMD_LO_HEALTH, 0x00, new byte[] {0x11, 0x22, 0x02}))));
        byte[] corrupt = unhex(bootHex);
        corrupt[16] ^= 0x01;
        expect("pkt 41285 with one payload bit flipped (CRC fails) is not",
            !RingProtocol.isRingBootHello(RingProtocol.parse(corrupt)));

        expect("first skip receipt is always due", RingProtocol.ringConnectSkipReceiptDue(5_000L, -1L));
        expect("a second skip 59 999 ms later is suppressed", !RingProtocol.ringConnectSkipReceiptDue(64_999L, 5_000L));
        expect("a skip 60 000 ms later is due", RingProtocol.ringConnectSkipReceiptDue(65_000L, 5_000L));

        String skip = RingProtocol.ringConnectSkippedReceiptLine(1789453302322L, "initial", 13_235_000L, 0);
        System.out.println("RECEIPT " + skip);
        expect("skip line is typed and a single line",
            skip.startsWith("{\"type\":\"ringConnectSkipped\",\"at\":\"") && !skip.contains("\n"));
        expect("skip line's at uses the pull/page stamp format",
            skip.contains("\"at\":\"" + RingProtocol.localStamp(1789453302322L) + "\""));
        expect("skip line carries atMs, reason, link age and suppressed count",
            skip.endsWith(",\"atMs\":1789453302322,\"reason\":\"initial\",\"linkAgeMs\":13235000,\"suppressed\":0}"));
        expect("unknown link age is null, suppressed count carried",
            RingProtocol.ringConnectSkippedReceiptLine(1L, "retry", -1L, 3)
                .endsWith(",\"reason\":\"retry\",\"linkAgeMs\":null,\"suppressed\":3}"));

        String bootLine = RingProtocol.ringBootReceiptLine(1789453320009L, 1_400L, 0x7c);
        System.out.println("RECEIPT " + bootLine);
        expect("boot line is typed, fresh link says new, carries previous push seq",
            bootLine.startsWith("{\"type\":\"ringBoot\",\"at\":\"" + RingProtocol.localStamp(1789453320009L) + "\"")
                && bootLine.endsWith(",\"atMs\":1789453320009,\"link\":\"new\",\"linkAgeMs\":1400,\"prevPushSeq\":124}"));
        expect("a link up 13 235 s says held; a wrap shows prevPushSeq 255",
            RingProtocol.ringBootReceiptLine(1L, 13_235_000L, 0xff)
                .endsWith(",\"link\":\"held\",\"linkAgeMs\":13235000,\"prevPushSeq\":255}"));
        expect("held starts at exactly 30 000 ms",
            RingProtocol.ringBootReceiptLine(1L, 29_999L, 1).contains("\"link\":\"new\"")
                && RingProtocol.ringBootReceiptLine(1L, 30_000L, 1).contains("\"link\":\"held\""));
        expect("no link-up time and no earlier push -> unknown and nulls",
            RingProtocol.ringBootReceiptLine(1L, -1L, -1)
                .endsWith(",\"link\":\"unknown\",\"linkAgeMs\":null,\"prevPushSeq\":null}"));
    }

    /**
     * 2026-09-15 ringBattery receipt, against the ring's own battery-shaped
     * frames from bazzite-desktop's 09-15 captures (btsnoop_hci.log and .last).
     */
    private static void testRingBatteryReceipts() {
        section("ring battery receipt (09-15 capture 00:01 / 00:7F / 00:03 frames)");
        // Nonce split: parse() puts everything after the 15-byte header into
        // payload, and payload[0:2] is the nonce. A bare 06:01 RSP carries only that.
        final String bareHex = "0059ca906564026414000306010c00ae68";
        RingProtocol.Frame bare = RingProtocol.parse(unhex(bareHex));
        expect("pkt 41753, a bare 06:01 RSP: payload is the 2-byte nonce alone",
            bare != null && bare.crcOk && bare.kind == RingProtocol.KIND_RSP
                && "ae68".equals(RingProtocol.hex(bare.payload)));

        final String rspHex = "00cf0c53f06401640400030001130017993c020100000000";
        RingProtocol.Frame rsp = RingProtocol.parse(unhex(rspHex));
        expect("pkt 41306 (06:22:00) parses CRC-clean: device RSP 00:01 seq 04, payload 17993c020100000000",
            rsp != null && rsp.crcOk && rsp.chan == RingProtocol.CHAN_DEVICE && rsp.kind == RingProtocol.KIND_RSP
                && "00:01".equals(rsp.commandLabel()) && rsp.seq == 0x04
                && "17993c020100000000".equals(RingProtocol.hex(rsp.payload)));
        expect("pkt 41306 is battery-shaped", RingProtocol.isRingBatteryFrame(rsp));
        expect("pkt 41306 level = 60 (0x3c, the byte after nonce 1799)", RingProtocol.ringBatteryLevel(rsp) == 60);
        RingProtocol.Frame before = RingProtocol.parse(unhex("003588823364016404000300011300ba9e41020100000000"));
        expect("pkt 36337 (00:44:52, before the reset) level = 65 (0x41)",
            RingProtocol.isRingBatteryFrame(before) && RingProtocol.ringBatteryLevel(before) == 65);
        RingProtocol.Frame hourly = RingProtocol.parse(unhex("00bc9f0945640164590002007f1300ea5e41020100000000"));
        expect("pkt 4502 hourly 00:7F push (03:02:28) is battery-shaped, level 65",
            RingProtocol.isRingBatteryFrame(hourly) && hourly.kind == RingProtocol.KIND_DATA
                && RingProtocol.ringBatteryLevel(hourly) == 65);
        RingProtocol.Frame state = RingProtocol.parse(unhex("00b79f84cf64016433000200030d00472702"));
        expect("pkt 44986 00:03 push (01:02:18) is battery-shaped, no level",
            RingProtocol.isRingBatteryFrame(state) && RingProtocol.ringBatteryLevel(state) == -1);

        expect("pkt 41285 00:08 boot push is not",
            !RingProtocol.isRingBatteryFrame(RingProtocol.parse(unhex("004a4af65364016400000200080d00376d00"))));
        expect("our own 00:01 REQ is not",
            !RingProtocol.isRingBatteryFrame(RingProtocol.parse(RingProtocol.buildDeviceRequest(0x01, 0x04, 0x3d4b))));
        expect("our 00:7E page ACK is not",
            !RingProtocol.isRingBatteryFrame(RingProtocol.parse(RingProtocol.buildPageAck(0x0d, 0x5f49, 0x01, 0x01, 0x03))));
        expect("a health-channel 06:01 RSP (cmd lo 01) is not", !RingProtocol.isRingBatteryFrame(bare));
        byte[] corrupt = unhex(rspHex);
        corrupt[17] ^= 0x01;
        expect("pkt 41306 with one level bit flipped (CRC fails) is not",
            !RingProtocol.isRingBatteryFrame(RingProtocol.parse(corrupt)));

        String line = RingProtocol.ringBatteryReceiptLine(rsp, 1789453320403L, 1_500L);
        System.out.println("RECEIPT " + line);
        expect("00:01 RSP line, exact",
            line.equals("{\"type\":\"ringBattery\",\"at\":\"" + RingProtocol.localStamp(1789453320403L) + "\""
                + ",\"atMs\":1789453320403,\"cmd\":\"00:01\",\"kind\":\"rsp\",\"level\":60"
                + ",\"payloadHex\":\"17993c020100000000\",\"link\":\"new\",\"linkAgeMs\":1500}"));
        String hourlyLine = RingProtocol.ringBatteryReceiptLine(hourly, 1L, 13_235_000L);
        System.out.println("RECEIPT " + hourlyLine);
        expect("00:7F push line: cmd 00:7f, kind push, level 65, raw payload, held",
            hourlyLine.contains(",\"cmd\":\"00:7f\",\"kind\":\"push\",\"level\":65"
                + ",\"payloadHex\":\"ea5e41020100000000\",\"link\":\"held\","));
        String stateLine = RingProtocol.ringBatteryReceiptLine(state, 1L, -1L);
        System.out.println("RECEIPT " + stateLine);
        expect("00:03 push line: level null, raw payload, unknown link",
            stateLine.endsWith(",\"cmd\":\"00:03\",\"kind\":\"push\",\"level\":null"
                + ",\"payloadHex\":\"472702\",\"link\":\"unknown\",\"linkAgeMs\":null}"));
    }

    // ------------------------------------------------------------------
    // Synthetic body builders (mirror the spec layout, used only by the tests)
    // ------------------------------------------------------------------

    private static byte[] hourlyBody(int count, long anchor, long tag, int current,
                                     int width, int[][] groups) {
        byte[] body = new byte[13 + width + count * (1 + 3 * width) + 4];
        body[0] = 0x11;
        body[1] = 0x22;
        body[2] = (byte) count;
        writeAnchor(body, anchor);
        putLe(body, 9, tag, 4);
        putLe(body, 13, current, width);
        int offset = 13 + width;
        for (int[] g : groups) {
            body[offset++] = (byte) g[0];
            putLe(body, offset, g[1], width);
            offset += width;
            putLe(body, offset, g[2], width);
            offset += width;
            putLe(body, offset, g[3], width);
            offset += width;
        }
        putFooter(body);
        return body;
    }

    private static byte[] stepsBody(long anchor, int[][] buckets) {
        byte[] body = new byte[9 + buckets.length * 7 + 4];
        body[0] = 0x33;
        body[1] = 0x44;
        body[2] = (byte) buckets.length;
        writeAnchor(body, anchor);
        int offset = 9;
        for (int[] b : buckets) {
            body[offset] = (byte) b[0];
            putLe(body, offset + 1, b[1], 2);
            putLe(body, offset + 3, b[2], 2);
            putLe(body, offset + 5, b[3], 2);
            offset += 7;
        }
        putFooter(body);
        return body;
    }

    private static byte[] sleepBody(int recordState, long start, long end, int total, int wake,
                                    int rem, int light, int deep, int[][] segments) {
        byte[] body = new byte[34 + segments.length * 3 + 4];
        body[0] = 0x55;
        body[1] = 0x66;
        body[2] = (byte) recordState;
        for (int i = 3; i < 9; i++) {
            body[i] = (byte) (0xA0 + i);       // the uncracked 6-byte field
        }
        putLe(body, 9, 90210L, 4);             // the uncracked u32 tag
        body[13] = 0x00;
        putLe(body, 14, start, 4);
        putLe(body, 18, end, 4);
        putLe(body, 22, total, 2);
        putLe(body, 24, wake, 2);
        putLe(body, 26, rem, 2);
        putLe(body, 28, light, 2);
        putLe(body, 30, deep, 2);
        body[32] = (byte) segments.length;
        body[33] = 0x00;
        int offset = 34;
        for (int[] s : segments) {
            body[offset] = (byte) s[0];
            putLe(body, offset + 1, s[1], 2);
            offset += 3;
        }
        putFooter(body);
        return body;
    }

    private static void writeAnchor(byte[] body, long anchor) {
        if (anchor == RingProtocol.UNKNOWN_TIME) {
            return;                             // six zero bytes = backlog page
        }
        body[3] = 0x10;
        body[4] = (byte) 0xFF;
        putLe(body, 5, anchor, 4);
    }

    private static void putFooter(byte[] body) {
        int offset = body.length - 4;
        body[offset] = (byte) 0x94;
        body[offset + 1] = 0x33;
        body[offset + 2] = 0x01;
        body[offset + 3] = 0x00;
    }

    private static void putLe(byte[] out, int offset, long value, int width) {
        for (int i = 0; i < width; i++) {
            out[offset + i] = (byte) ((value >>> (8 * i)) & 0xff);
        }
    }

    private static RingProtocol.Frame dataFrame(int cmdHi, byte[] body) {
        byte[] frame = RingProtocol.buildFrame(
            RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA, cmdHi,
            RingProtocol.CMD_LO_HEALTH, 0x20, body);
        return RingProtocol.parse(frame);
    }

    // ------------------------------------------------------------------

    private static void section(String name) {
        System.out.println();
        System.out.println("-- " + name);
    }

    private static void expect(String what, boolean ok) {
        checks++;
        if (!ok) {
            failures++;
        }
        System.out.println("   " + (ok ? "ok  " : "FAIL") + "  " + what);
    }

    private static void expectHex(String what, String expectedHex, byte[] actual) {
        String actualHex = RingProtocol.hex(actual);
        boolean ok = expectedHex.equals(actualHex);
        checks++;
        if (!ok) {
            failures++;
            System.out.println("   FAIL  " + what);
            System.out.println("         expected " + expectedHex);
            System.out.println("         actual   " + actualHex);
            return;
        }
        System.out.println("   ok    " + what + "  " + actualHex);
    }

    private static String hex2(int value) {
        return String.format(java.util.Locale.US, "%02x", value & 0xff);
    }

    private static byte[] unhex(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}
