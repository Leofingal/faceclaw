package com.faceclaw.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * RingProtocol: frame build/parse plus per-record decoding for the Even R1
 * ring's health-data channel. Does _not_ include code for actually sending
 * anything; for that, see FaceclawBleCommunicator (same split as BleProtocol).
 *
 * <p>Deliberately free of Android imports so the whole thing can be exercised
 * with plain javac/java — see notes/ring-protocol-selftest/.
 *
 * <p><b>This is a different protocol from BleProtocol's.</b> The glasses speak
 * an {@code aa21} envelope with a CRC-16/CCITT; the ring speaks a 15-byte
 * {@code 64 .. 64} header with a CRC-32C. Nothing is shared between them, and
 * in particular {@link #crc32} must never be pointed at a glasses frame.
 *
 * <p>Wire format (offsets from the start of the ATT value):
 * <pre>
 *  off size field
 *   0   1   FLAG      0x00 normally; 0x01 = fragmented, a continuation follows
 *   1   4   CRC32     little-endian, over bytes [5:] of the *reassembled* frame
 *   5   1   0x64      constant magic
 *   6   1   CHAN      0x01 device/system, 0x02 health data
 *   7   1   0x64      constant magic
 *   8   1   SEQ       phone-side: one counter shared by both channels
 *   9   1   0x00      constant
 *  10   1   KIND      0x00 REQ, 0x01 ACK, 0x02 DATA, 0x03 RSP
 *  11   1   CMD_HI
 *  12   1   CMD_LO
 *  13   2   PLEN      little-endian; equals (total frame length - 5)
 *  15  ..   PAYLOAD   PLEN - 10 bytes; PAYLOAD[0:2] is a free per-message nonce
 * </pre>
 *
 * <p>Protocol spec and its evidence:
 * knowledge/staging/faceclaw-ring-protocol-decode-return.md in the TLC
 * knowledge base. Everything below is implemented from that document; the
 * places where it is explicitly *not* solved are marked UNSOLVED and are
 * surfaced raw rather than guessed at.
 */
public final class RingProtocol {
    private RingProtocol() {
    }

    /** CRC-32C polynomial, MSB-first / non-reflected form. Not CRC-32 (0x04C11DB7). */
    private static final int CRC32C_POLY = 0x1EDC6F41;

    public static final int MAGIC = 0x64;
    public static final int HEADER_LEN = 15;
    /** A continuation frame is FLAG(1) + CRC32(4) and then raw remainder bytes. */
    public static final int CONTINUATION_PREFIX_LEN = 5;

    public static final int FLAG_PLAIN = 0x00;
    public static final int FLAG_FRAGMENTED = 0x01;

    public static final int CHAN_DEVICE = 0x01;
    public static final int CHAN_HEALTH = 0x02;

    public static final int KIND_REQ = 0x00;
    public static final int KIND_ACK = 0x01;
    public static final int KIND_DATA = 0x02;
    public static final int KIND_RSP = 0x03;

    /** Every health record type uses CMD_LO = 0x01; the type lives in CMD_HI. */
    public static final int CMD_LO_HEALTH = 0x01;
    public static final int CMD_HI_HEART_RATE = 0x01;
    public static final int CMD_HI_SPO2 = 0x02;
    public static final int CMD_HI_HRV = 0x04;
    public static final int CMD_HI_STEPS = 0x05;
    public static final int CMD_HI_SLEEP = 0x06;

    /** Device/system channel commands all have CMD_HI = 0x00. */
    public static final int CMD_HI_DEVICE = 0x00;
    public static final int CMD_LO_PAGE_ACK = 0x7E;

    /**
     * The five health pulls, in the order Even's own app issues them:
     * heart rate, HRV, SpO2, sleep, steps. That order is identical in all four
     * sync bursts of the reference capture. (It is NOT the order the spec
     * document happens to list them in — that is just its presentation order.)
     * Whether the order matters to the ring is untested; matching the app is
     * the cheapest way not to find out the hard way.
     */
    public static final int[] HEALTH_COMMANDS = {
        CMD_HI_HEART_RATE,
        CMD_HI_HRV,
        CMD_HI_SPO2,
        CMD_HI_SLEEP,
        CMD_HI_STEPS,
    };

    /** Constant terminator on every record body of every type. Meaning unknown. */
    private static final byte[] RECORD_FOOTER = {(byte) 0x94, 0x33, 0x01, 0x00};

    /** ANCHOR field marker: 0x10 0xFF then a u32 LE Unix timestamp. */
    private static final int ANCHOR_MARK_HI = 0x10;
    private static final int ANCHOR_MARK_LO = 0xFF;

    /** Returned by anchor/timestamp accessors when the value is not known. */
    public static final long UNKNOWN_TIME = -1L;

    private static final byte[] EMPTY = new byte[0];

    // ------------------------------------------------------------------
    // CRC
    // ------------------------------------------------------------------

    /**
     * CRC-32C over {@code data[from, to)}: polynomial 0x1EDC6F41, MSB-first,
     * init 0, no reflection, no final xor. Verified against 188/188 frames in
     * the reference capture.
     */
    public static int crc32(byte[] data, int from, int to) {
        int crc = 0;
        for (int i = from; i < to; i++) {
            crc ^= (data[i] & 0xff) << 24;
            for (int bit = 0; bit < 8; bit++) {
                if ((crc & 0x80000000) != 0) {
                    crc = (crc << 1) ^ CRC32C_POLY;
                } else {
                    crc = crc << 1;
                }
            }
        }
        return crc;
    }

    public static int crc32(byte[] data) {
        return crc32(data, 0, data == null ? 0 : data.length);
    }

    // ------------------------------------------------------------------
    // Frame building
    // ------------------------------------------------------------------

    /**
     * Build one complete, CRC-correct frame. Fragmentation is a receive-side
     * concern only: nothing we send approaches the 244-byte ATT ceiling.
     */
    public static byte[] buildFrame(int chan, int kind, int cmdHi, int cmdLo, int seq, byte[] payload) {
        byte[] body = payload == null ? EMPTY : payload;
        int total = HEADER_LEN + body.length;
        byte[] frame = new byte[total];
        frame[0] = (byte) FLAG_PLAIN;
        frame[5] = (byte) MAGIC;
        frame[6] = (byte) (chan & 0xff);
        frame[7] = (byte) MAGIC;
        frame[8] = (byte) (seq & 0xff);
        frame[9] = 0x00;
        frame[10] = (byte) (kind & 0xff);
        frame[11] = (byte) (cmdHi & 0xff);
        frame[12] = (byte) (cmdLo & 0xff);
        int plen = total - 5;
        frame[13] = (byte) (plen & 0xff);
        frame[14] = (byte) ((plen >>> 8) & 0xff);
        System.arraycopy(body, 0, frame, HEADER_LEN, body.length);
        writeIntLe(frame, 1, crc32(frame, 5, total));
        return frame;
    }

    /**
     * A request frame. Health requests carry no arguments at all: the payload
     * is the 2-byte nonce and nothing else.
     *
     * <p>The nonce is a free per-message id — it is covered by the frame CRC but
     * is not content-derived, so any value works. It is encoded little-endian.
     */
    public static byte[] buildRequest(int chan, int cmdHi, int cmdLo, int seq, int nonce) {
        return buildFrame(chan, KIND_REQ, cmdHi, cmdLo, seq, nonceBytes(nonce));
    }

    /** One of the five health pulls; see {@link #HEALTH_COMMANDS}. */
    public static byte[] buildHealthRequest(int cmdHi, int seq, int nonce) {
        return buildRequest(CHAN_HEALTH, cmdHi, CMD_LO_HEALTH, seq, nonce);
    }

    /**
     * The per-page acknowledgement: command 00:7E on the DEVICE channel,
     * echoing the sequence number of the DATA page being acknowledged.
     *
     * <p>Payload is 12 bytes: the usual 2-byte nonce, then
     * {@code 02 <cmd_hi> <cmd_lo> 00 <page_seq>}, then five zero bytes. (Note
     * the echoed page seq is at payload offset 6, after the nonce — a spec doc
     * that describes the payload as starting at {@code 02} is off by the nonce.)
     *
     * <p>The frame's own SEQ is the phone's shared counter, NOT the echoed page
     * seq: across 20 ACKs in the reference capture the two are always different,
     * and the header SEQ continues the same +1 sequence used by every other
     * phone-to-ring write on both channels.
     *
     * <p>Whether the ring actually *requires* this is untested — Even's app
     * sends one for every page without exception (20/20), but no page has ever
     * been deliberately left unacknowledged to see what happens.
     */
    public static byte[] buildPageAck(int seq, int nonce, int ackedCmdHi, int ackedCmdLo, int pageSeq) {
        byte[] payload = new byte[12];
        payload[0] = (byte) (nonce & 0xff);
        payload[1] = (byte) ((nonce >>> 8) & 0xff);
        payload[2] = 0x02;
        payload[3] = (byte) (ackedCmdHi & 0xff);
        payload[4] = (byte) (ackedCmdLo & 0xff);
        payload[5] = 0x00;
        payload[6] = (byte) (pageSeq & 0xff);
        // payload[7..11] stay zero.
        return buildFrame(CHAN_DEVICE, KIND_ACK, CMD_HI_DEVICE, CMD_LO_PAGE_ACK, seq, payload);
    }

    private static byte[] nonceBytes(int nonce) {
        return new byte[] {(byte) (nonce & 0xff), (byte) ((nonce >>> 8) & 0xff)};
    }

    // ------------------------------------------------------------------
    // Device-channel frames, built exactly as Even's app builds them
    // ------------------------------------------------------------------
    //
    // Every builder below is pinned byte for byte (CRC included) by
    // RingProtocolSelfTest against a complete Even connect in
    // bazzite-desktop:/tmp/br4_last/btsnoop_hci.log.last, pkts 64287-64690
    // (2026-09-11 05:32 EDT). The fresh capture (/tmp/btsnoop_fresh.log,
    // pkts 41056-41643, 2026-09-11 00:09 EDT) runs the identical order.

    /** 00:0A's constant argument, byte-identical in every Even capture. */
    private static final byte[] IDENTITY_0A_ARG = {
        (byte) 0xf8, (byte) 0xf5, 0x3d, 0x23, 0x5a, (byte) 0xc4, (byte) 0xce, (byte) 0xaa, 0x07, 0x38, (byte) 0x85, (byte) 0xcc,
    };

    /**
     * 00:04's constant argument. Even sends 00:04 as a REQ with exactly these
     * 12 bytes after the nonce in all four captured frames (pkts 9327, 9390,
     * 41456, 64690), across three connects from 2026-09-09 to 2026-09-11.
     * Meaning unknown; copied, not derived.
     */
    private static final byte[] SETTINGS_04_ARG = {
        0x00, 0x00, (byte) 0xb7, 0x00, 0x51, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    };

    /**
     * The device-channel REQs Even sends after each health type's request,
     * indexed by position in {@link #HEALTH_COMMANDS} (01:01, 04:01, 02:01,
     * 06:01, 05:01 - Even's order too). br4l pkts 64640-64748 and fresh pkts
     * 41417-41535 agree: after 01:01 come 00:02, 00:0A, 00:04, 00:01; after
     * 04:01 comes 00:0B; nothing after the other three.
     */
    public static final int[][] EVEN_DEVICE_REQS_AFTER_TYPE = {
        {0x02, 0x0a, 0x04, 0x01},
        {0x0b},
        {},
        {},
        {},
    };

    /** 00:08: REQ whose payload is exactly 3f 01 01 - the one frame with NO nonce. */
    public static byte[] buildHello(int seq) {
        return buildFrame(CHAN_DEVICE, KIND_REQ, CMD_HI_DEVICE, 0x08, seq, new byte[] {0x3f, 0x01, 0x01});
    }

    /** 00:0E clock set: DATA, nonce, u32 LE clock seconds, then 01 and seven zero bytes. */
    public static byte[] buildClockSet(int seq, int nonce, long clockSeconds) {
        byte[] payload = new byte[14];
        payload[0] = (byte) (nonce & 0xff);
        payload[1] = (byte) ((nonce >>> 8) & 0xff);
        writeIntLe(payload, 2, (int) clockSeconds);
        payload[6] = 0x01;
        return buildFrame(CHAN_DEVICE, KIND_DATA, CMD_HI_DEVICE, 0x0e, seq, payload);
    }

    /**
     * 00:05: DATA, nonce, {@code 10 ff}, then a u32 LE timestamp. <b>Even puts
     * the same u32 here as in the same connect's 00:0E clock set</b> - in all
     * five captured Even connects (pkts 8835/9153/9266, 26693/26703/26765,
     * 41069/41088/41178, 46555/46569/46594, 64303/64324/64393). It is NOT local
     * midnight: midnight (e.g. {@code c0d9a06a}) appears only in the ring's own
     * DATA page anchors, ring to phone.
     */
    public static byte[] buildDayAnchorWrite(int seq, int nonce, long clockSeconds) {
        byte[] payload = new byte[8];
        payload[0] = (byte) (nonce & 0xff);
        payload[1] = (byte) ((nonce >>> 8) & 0xff);
        payload[2] = (byte) ANCHOR_MARK_HI;
        payload[3] = (byte) ANCHOR_MARK_LO;
        writeIntLe(payload, 4, (int) clockSeconds);
        return buildFrame(CHAN_DEVICE, KIND_DATA, CMD_HI_DEVICE, 0x05, seq, payload);
    }

    /**
     * A device-channel REQ as Even builds it: 00:0A carries its constant blob,
     * 00:04 its constant settings argument, everything else (00:01, 00:02,
     * 00:0B) is nonce-only.
     */
    public static byte[] buildDeviceRequest(int cmdLo, int seq, int nonce) {
        byte[] arg;
        if (cmdLo == 0x0a) {
            arg = IDENTITY_0A_ARG;
        } else if (cmdLo == 0x04) {
            arg = SETTINGS_04_ARG;
        } else {
            return buildRequest(CHAN_DEVICE, CMD_HI_DEVICE, cmdLo, seq, nonce);
        }
        byte[] payload = new byte[2 + arg.length];
        payload[0] = (byte) (nonce & 0xff);
        payload[1] = (byte) ((nonce >>> 8) & 0xff);
        System.arraycopy(arg, 0, payload, 2, arg.length);
        return buildFrame(CHAN_DEVICE, KIND_REQ, CMD_HI_DEVICE, cmdLo, seq, payload);
    }

    /**
     * 06:02 on the HEALTH channel: DATA, nonce only. Even sends it as the last
     * handshake frame, then pauses ~1.5 s (1501/1514/1515 ms) before its first
     * health request, in 3 of 4 captured full connects (pkts 8845, 41267, 64473).
     * No RSP follows it in any capture.
     */
    public static byte[] buildHealth0602(int seq, int nonce) {
        return buildFrame(CHAN_HEALTH, KIND_DATA, CMD_HI_SLEEP, 0x02, seq, nonceBytes(nonce));
    }

    // ------------------------------------------------------------------
    // Frame parsing and fragment reassembly
    // ------------------------------------------------------------------

    /** True when a value could be the start of a frame (magic bytes in place). */
    public static boolean looksLikeHeader(byte[] value) {
        return value != null
            && value.length >= HEADER_LEN
            && (value[5] & 0xff) == MAGIC
            && (value[7] & 0xff) == MAGIC;
    }

    /** Total frame length declared by PLEN, or -1 when this is not a header. */
    public static int declaredLength(byte[] value) {
        if (!looksLikeHeader(value)) {
            return -1;
        }
        int plen = (value[13] & 0xff) | ((value[14] & 0xff) << 8);
        int total = plen + 5;
        return total < HEADER_LEN ? -1 : total;
    }

    /** Parse a complete (already reassembled) frame. Returns null if malformed. */
    public static Frame parse(byte[] frame) {
        if (frame == null || frame.length < HEADER_LEN) {
            return null;
        }
        if ((frame[5] & 0xff) != MAGIC || (frame[7] & 0xff) != MAGIC) {
            return null;
        }
        int plen = (frame[13] & 0xff) | ((frame[14] & 0xff) << 8);
        if (plen + 5 != frame.length) {
            return null;
        }
        int storedCrc = readIntLe(frame, 1);
        int actualCrc = crc32(frame, 5, frame.length);
        byte[] payload = Arrays.copyOfRange(frame, HEADER_LEN, frame.length);
        return new Frame(
            frame[0] & 0xff,
            frame[6] & 0xff,
            frame[8] & 0xff,
            frame[10] & 0xff,
            frame[11] & 0xff,
            frame[12] & 0xff,
            payload,
            frame,
            storedCrc == actualCrc
        );
    }

    /**
     * Feeds raw ATT notification values in and produces complete frames,
     * rejoining fragmented ones.
     *
     * <p>Fragmentation (spec §2.3): when a frame exceeds the 244-byte ATT
     * ceiling the ring sets FLAG=0x01, sends the first 244 bytes, and later
     * sends a continuation frame in a different, headerless shape — FLAG(1),
     * CRC32(4), then the remaining bytes verbatim.
     *
     * <p>Two things the spec document does not say, both measured from the
     * reference capture and both load-bearing here:
     * <ul>
     *   <li><b>The continuation is not adjacent.</b> In one of the six captured
     *       fragmentations three unrelated complete frames arrive between the
     *       first fragment and its continuation, so a "next value is the rest"
     *       rule mis-joins. Complete frames are therefore still parsed normally
     *       while a fragment is outstanding.</li>
     *   <li><b>The continuation's own CRC field is not reliably the reassembled
     *       CRC.</b> It matched in five of six cases and differed in the sixth
     *       (whose join is nonetheless byte-exact and CRC-valid), so the
     *       continuation must not be matched by comparing CRC fields.</li>
     * </ul>
     *
     * <p>What is reliable, in all six cases, is length: a continuation carries
     * exactly {@code CONTINUATION_PREFIX_LEN + bytesStillNeeded} bytes and does
     * not itself look like a header. The reassembled frame's CRC is the real
     * validator and is always checked.
     */
    public static final class Reassembler {
        /**
         * Give up on an outstanding fragment after this many intervening
         * complete frames. The observed worst case is 3; this is slack, not a
         * measured bound.
         */
        private static final int MAX_INTERLEAVED_FRAMES = 16;

        private byte[] pending;
        private int pendingTotal;
        private int interleaved;

        public boolean hasPending() {
            return pending != null;
        }

        public void reset() {
            pending = null;
            pendingTotal = 0;
            interleaved = 0;
        }

        /**
         * Offer one ATT notification value. The result says whether the value
         * belonged to this protocol at all (so the caller can fall through to
         * the gesture decoder) and carries a frame once one is complete.
         */
        public Intake accept(byte[] value) {
            if (value == null || value.length == 0) {
                return Intake.ignored();
            }

            if (pending != null) {
                int needed = pendingTotal - pending.length;
                if (value.length == CONTINUATION_PREFIX_LEN + needed && !looksLikeHeader(value)) {
                    byte[] joined = new byte[pendingTotal];
                    System.arraycopy(pending, 0, joined, 0, pending.length);
                    System.arraycopy(value, CONTINUATION_PREFIX_LEN, joined, pending.length, needed);
                    reset();
                    return complete(joined);
                }
                if (!looksLikeHeader(value)) {
                    int dropped = pendingTotal;
                    reset();
                    return Intake.consumed(String.format(
                        Locale.US,
                        "dropped %d-byte fragment: continuation was %d bytes, expected %d",
                        dropped, value.length, CONTINUATION_PREFIX_LEN + needed));
                }
                if (++interleaved > MAX_INTERLEAVED_FRAMES) {
                    int dropped = pendingTotal;
                    reset();
                    // Fall through and parse this value as a fresh frame.
                    Intake result = acceptFresh(value);
                    return result.withNote(String.format(
                        Locale.US, "dropped %d-byte fragment: continuation never arrived", dropped));
                }
            }

            return acceptFresh(value);
        }

        private Intake acceptFresh(byte[] value) {
            int total = declaredLength(value);
            if (total < 0) {
                return Intake.ignored();
            }
            if (value.length >= total) {
                return complete(Arrays.copyOf(value, total));
            }
            // Only one fragment is ever outstanding in the reference capture,
            // but never silently clobber one if that assumption breaks.
            String clobbered = pending == null ? null : String.format(
                Locale.US, "dropped %d-byte fragment: a new fragment started", pendingTotal);
            pending = Arrays.copyOf(value, value.length);
            pendingTotal = total;
            interleaved = 0;
            return Intake.consumed(String.format(
                Locale.US, "fragment start, %d of %d bytes", value.length, total)).withNote(clobbered);
        }

        private Intake complete(byte[] raw) {
            Frame frame = parse(raw);
            if (frame == null) {
                return Intake.consumed("malformed frame, " + raw.length + " bytes");
            }
            return Intake.frame(frame);
        }
    }

    /** The outcome of offering one ATT value to a {@link Reassembler}. */
    public static final class Intake {
        /** True when the value belonged to this protocol and must not be re-handled. */
        public final boolean consumed;
        /** Non-null once a complete frame is available. Check {@link Frame#crcOk}. */
        public final Frame frame;
        /** Human-readable detail for logging, or null. */
        public final String note;

        private Intake(boolean consumed, Frame frame, String note) {
            this.consumed = consumed;
            this.frame = frame;
            this.note = note;
        }

        static Intake ignored() {
            return new Intake(false, null, null);
        }

        static Intake consumed(String note) {
            return new Intake(true, null, note);
        }

        static Intake frame(Frame frame) {
            return new Intake(true, frame, null);
        }

        Intake withNote(String extra) {
            if (extra == null) {
                return this;
            }
            return new Intake(consumed, frame, note == null ? extra : note + "; " + extra);
        }
    }

    /** One complete frame. */
    public static final class Frame {
        public final int flag;
        public final int chan;
        public final int seq;
        public final int kind;
        public final int cmdHi;
        public final int cmdLo;
        /** PLEN - 10 bytes. payload[0:2] is the sender's nonce. */
        public final byte[] payload;
        public final byte[] raw;
        public final boolean crcOk;

        Frame(int flag, int chan, int seq, int kind, int cmdHi, int cmdLo,
              byte[] payload, byte[] raw, boolean crcOk) {
            this.flag = flag;
            this.chan = chan;
            this.seq = seq;
            this.kind = kind;
            this.cmdHi = cmdHi;
            this.cmdLo = cmdLo;
            this.payload = payload;
            this.raw = raw;
            this.crcOk = crcOk;
        }

        public boolean isHealth() {
            return chan == CHAN_HEALTH;
        }

        public String commandLabel() {
            return String.format(Locale.US, "%02x:%02x", cmdHi, cmdLo);
        }

        public String describe() {
            return String.format(
                Locale.US,
                "chan=%02x kind=%02x cmd=%s seq=%02x len=%d",
                chan, kind, commandLabel(), seq, raw.length);
        }
    }

    // ------------------------------------------------------------------
    // Record decoding
    // ------------------------------------------------------------------

    /**
     * Decode a health DATA page. Returns null when the frame is not a health
     * DATA page or its body does not match the layout for its type.
     */
    public static HealthRecord decode(Frame frame, long receivedAtMs) {
        if (frame == null || !frame.crcOk || !frame.isHealth() || frame.kind != KIND_DATA) {
            return null;
        }
        if (frame.cmdLo != CMD_LO_HEALTH) {
            return null;
        }
        switch (frame.cmdHi) {
            case CMD_HI_HEART_RATE:
            case CMD_HI_SPO2:
            case CMD_HI_HRV:
                return decodeHourly(frame, receivedAtMs);
            case CMD_HI_STEPS:
                return decodeSteps(frame, receivedAtMs);
            case CMD_HI_SLEEP:
                return decodeSleep(frame, receivedAtMs);
            default:
                return null;
        }
    }

    /**
     * Heart rate / SpO2 / HRV: an hourly {@code [index][avg][max][min]} series.
     *
     * <p>The value width W is not guessed — it is resolved from the body length
     * by {@code len == W + COUNT * (1 + 3W)}, which has a unique solution for
     * every frame in the reference capture (W=1 for HR and SpO2, W=2 for HRV).
     */
    public static HourlyRecord decodeHourly(Frame frame, long receivedAtMs) {
        byte[] pay = frame.payload;
        if (pay.length < 13 + RECORD_FOOTER.length) {
            return null;
        }
        int count = pay[2] & 0xff;
        long anchor = anchorUnixSeconds(pay);
        long tag = readUInt32Le(pay, 9);

        int bodyLen = pay.length - 13 - RECORD_FOOTER.length;
        int width;
        if (bodyLen == 1 + count * 4) {
            width = 1;
        } else if (bodyLen == 2 + count * 7) {
            width = 2;
        } else {
            return null;
        }

        int current = readUIntLe(pay, 13, width);
        int offset = 13 + width;
        HourlyGroup[] groups = new HourlyGroup[count];
        for (int i = 0; i < count; i++) {
            int hourIndex = pay[offset] & 0xff;
            offset++;
            int avg = readUIntLe(pay, offset, width);
            offset += width;
            int max = readUIntLe(pay, offset, width);
            offset += width;
            int min = readUIntLe(pay, offset, width);
            offset += width;
            long unix = anchor == UNKNOWN_TIME ? UNKNOWN_TIME : anchor + hourIndex * 3600L;
            groups[i] = new HourlyGroup(hourIndex, avg, max, min, unix);
        }
        return new HourlyRecord(frame.cmdHi, receivedAtMs, anchor, tag, current, width, groups);
    }

    /**
     * Steps / activity buckets: {@code [index][v1][v2][v3]} after the record
     * prefix. v1 (steps) is proven against a full-day total; v2 and v3 are
     * calorie-shaped but unconfirmed, and the bucket index does NOT map to a
     * known wall-clock time (see {@link StepsBucket}).
     */
    public static StepsRecord decodeSteps(Frame frame, long receivedAtMs) {
        byte[] pay = frame.payload;
        if (pay.length < 9 + RECORD_FOOTER.length) {
            return null;
        }
        int count = pay[2] & 0xff;
        if (pay.length != 9 + count * 7 + RECORD_FOOTER.length) {
            return null;
        }
        long anchor = anchorUnixSeconds(pay);
        int offset = 9;
        StepsBucket[] buckets = new StepsBucket[count];
        for (int i = 0; i < count; i++) {
            int index = pay[offset] & 0xff;
            int steps = readUInt16Le(pay, offset + 1);
            int v2 = readUInt16Le(pay, offset + 3);
            int v3 = readUInt16Le(pay, offset + 5);
            offset += 7;
            buckets[i] = new StepsBucket(index, steps, v2, v3);
        }
        return new StepsRecord(receivedAtMs, anchor, buckets);
    }

    /**
     * A sleep session. The ring transmits pre-classified stages, per-stage
     * totals and the session boundaries; nothing is computed phone-side.
     *
     * <p>{@code startTs}/{@code endTs} are ring-relative seconds, NOT Unix
     * timestamps — see {@link SleepRecord}.
     */
    public static SleepRecord decodeSleep(Frame frame, long receivedAtMs) {
        byte[] pay = frame.payload;
        if (pay.length < 3) {
            return null;
        }
        int recordState = pay[2] & 0xff;
        byte[] unknownA = safeRange(pay, 3, 9);
        long unknownTag = pay.length >= 13 ? readUInt32Le(pay, 9) : UNKNOWN_TIME;
        if (recordState != 1 || pay.length < 34 + RECORD_FOOTER.length) {
            // RECSTATE 2 is the empty / end-of-list marker.
            return new SleepRecord(
                receivedAtMs, recordState, unknownA, unknownTag,
                0, 0, 0, 0, 0, 0, 0, new SleepSegment[0]);
        }

        long startTs = readUInt32Le(pay, 14);
        long endTs = readUInt32Le(pay, 18);
        int totalTime = readUInt16Le(pay, 22);
        int wakeTime = readUInt16Le(pay, 24);
        int remTime = readUInt16Le(pay, 26);
        int lightTime = readUInt16Le(pay, 28);
        int deepTime = readUInt16Le(pay, 30);
        int segmentCount = pay[32] & 0xff;
        if (pay.length != 34 + segmentCount * 3 + RECORD_FOOTER.length) {
            return null;
        }
        SleepSegment[] segments = new SleepSegment[segmentCount];
        int offset = 34;
        for (int i = 0; i < segmentCount; i++) {
            int stage = pay[offset] & 0xff;
            int halfMinutes = readUInt16Le(pay, offset + 1);
            offset += 3;
            segments[i] = new SleepSegment(stage, halfMinutes);
        }
        return new SleepRecord(
            receivedAtMs, recordState, unknownA, unknownTag,
            startTs, endTs, totalTime, wakeTime, remTime, lightTime, deepTime, segments);
    }

    /**
     * The record's day anchor as Unix epoch seconds, or {@link #UNKNOWN_TIME}
     * when the anchor field is the six-zero-byte "backlog page" form.
     *
     * <p><b>UNSOLVED:</b> a backlog page's true base is not understood as a
     * general rule. One capture's backlog base landed at 2026-09-08 23:48:49
     * local, which is the moment that sync ran plus a per-type offset — it is
     * not a fixed offset from midnight and must not be hardcoded. Callers get
     * {@link #UNKNOWN_TIME} and the raw hour index instead of an invented
     * absolute time.
     */
    public static long anchorUnixSeconds(byte[] payload) {
        if (payload == null || payload.length < 9) {
            return UNKNOWN_TIME;
        }
        if ((payload[3] & 0xff) == ANCHOR_MARK_HI && (payload[4] & 0xff) == ANCHOR_MARK_LO) {
            return readUInt32Le(payload, 5);
        }
        return UNKNOWN_TIME;
    }

    // ------------------------------------------------------------------
    // Decoded record types
    // ------------------------------------------------------------------

    /** Common supertype so one store can hold every decoded page. */
    public abstract static class HealthRecord {
        public final int cmdHi;
        public final long receivedAtMs;

        HealthRecord(int cmdHi, long receivedAtMs) {
            this.cmdHi = cmdHi;
            this.receivedAtMs = receivedAtMs;
        }

        /** The metric name, for logs. */
        public String metric() {
            switch (cmdHi) {
                case CMD_HI_HEART_RATE: return "heart_rate";
                case CMD_HI_SPO2: return "spo2";
                case CMD_HI_HRV: return "hrv";
                case CMD_HI_STEPS: return "steps";
                case CMD_HI_SLEEP: return "sleep";
                default: return String.format(Locale.US, "cmd%02x", cmdHi);
            }
        }

        /** A one-line summary safe to put in a log. */
        public abstract String summary();
    }

    /** Heart rate, SpO2 or HRV: one page of hourly buckets. */
    public static final class HourlyRecord extends HealthRecord {
        /** Day anchor in Unix seconds, or {@link #UNKNOWN_TIME} on a backlog page. */
        public final long anchorUnixSeconds;
        /** Per-metric "last measured at". See the 4-hour skew note in the spec. */
        public final long tagRaw;
        /** The metric's latest value. */
        public final int current;
        /** 1 byte for HR/SpO2, 2 for HRV; resolved from the body length. */
        public final int valueWidth;
        public final HourlyGroup[] groups;

        HourlyRecord(int cmdHi, long receivedAtMs, long anchorUnixSeconds, long tagRaw,
                     int current, int valueWidth, HourlyGroup[] groups) {
            super(cmdHi, receivedAtMs);
            this.anchorUnixSeconds = anchorUnixSeconds;
            this.tagRaw = tagRaw;
            this.current = current;
            this.valueWidth = valueWidth;
            this.groups = groups;
        }

        /** True when this page has no anchor, i.e. it is a backlog page. */
        public boolean isBacklog() {
            return anchorUnixSeconds == UNKNOWN_TIME;
        }

        @Override public String summary() {
            return String.format(
                Locale.US,
                "%s groups=%d width=%d current=%d anchor=%s tag=%d",
                metric(), groups.length, valueWidth, current,
                isBacklog() ? "backlog(unanchored)" : Long.toString(anchorUnixSeconds),
                tagRaw);
        }
    }

    /** One hourly bucket. */
    public static final class HourlyGroup {
        /** Raw index as sent. On an anchored page this is hours since the anchor. */
        public final int hourIndex;
        public final int avg;
        public final int max;
        public final int min;
        /**
         * Absolute Unix seconds for this bucket, or {@link #UNKNOWN_TIME} on a
         * backlog page — where the base is UNSOLVED and deliberately not guessed.
         */
        public final long unixSeconds;

        HourlyGroup(int hourIndex, int avg, int max, int min, long unixSeconds) {
            this.hourIndex = hourIndex;
            this.avg = avg;
            this.max = max;
            this.min = min;
            this.unixSeconds = unixSeconds;
        }
    }

    /** One page of activity buckets. */
    public static final class StepsRecord extends HealthRecord {
        public final long anchorUnixSeconds;
        public final StepsBucket[] buckets;

        StepsRecord(long receivedAtMs, long anchorUnixSeconds, StepsBucket[] buckets) {
            super(CMD_HI_STEPS, receivedAtMs);
            this.anchorUnixSeconds = anchorUnixSeconds;
            this.buckets = buckets;
        }

        public int totalSteps() {
            int total = 0;
            for (StepsBucket bucket : buckets) {
                total += bucket.steps;
            }
            return total;
        }

        @Override public String summary() {
            return String.format(
                Locale.US,
                "steps buckets=%d total=%d anchor=%s",
                buckets.length, totalSteps(),
                anchorUnixSeconds == UNKNOWN_TIME ? "none" : Long.toString(anchorUnixSeconds));
        }
    }

    /**
     * One activity bucket.
     *
     * <p><b>UNSOLVED:</b> {@link #index} does not map to a known wall-clock
     * time. It runs 0-7, 10, 11, 13-34 and then jumps to 130+, and no bucket
     * width at any base reproduces the app's own per-bucket distribution — even
     * though the steps total across all buckets is exactly right. The raw index
     * is stored as sent; no time-of-day mapping is invented.
     */
    public static final class StepsBucket {
        public final int index;
        /** Confirmed: summed over a page this equals the app's daily step total. */
        public final int steps;
        /** UNCONFIRMED: calorie-shaped (v3 - v2 tracks per-bucket resting kcal). */
        public final int calorieLike2;
        /** UNCONFIRMED: calorie-shaped. */
        public final int calorieLike3;

        StepsBucket(int index, int steps, int calorieLike2, int calorieLike3) {
            this.index = index;
            this.steps = steps;
            this.calorieLike2 = calorieLike2;
            this.calorieLike3 = calorieLike3;
        }
    }

    /**
     * One sleep session.
     *
     * <p><b>{@link #startTs} and {@link #endTs} are ring-relative seconds, not
     * Unix time.</b> Even's own app gets this wrong and stamps live-pushed
     * sessions with timestamps in 1979. Do not feed them to a date formatter.
     *
     * <p><b>UNSOLVED:</b> {@link #unknownPrefix} (6 bytes) and
     * {@link #unknownTag} (u32) are not decoded; one of them probably carries
     * the session date, which would remove the anchoring problem. They are
     * stored raw rather than interpreted.
     */
    public static final class SleepRecord extends HealthRecord {
        /** 1 = a real record, 2 = the empty / end-of-list marker. */
        public final int recordState;
        /** UNSOLVED per-record 6-byte field (payload[3:9]). Stored raw. */
        public final byte[] unknownPrefix;
        /** UNSOLVED u32 tag (payload[9:13]). Stored raw. */
        public final long unknownTag;
        /** Ring-relative seconds, NOT Unix. */
        public final long startTs;
        /** Ring-relative seconds, NOT Unix. */
        public final long endTs;
        public final int totalTime;
        public final int wakeTime;
        public final int remTime;
        public final int lightTime;
        public final int deepTime;
        /**
         * The stage series. Stage ids are the same 0-3 encoding the app's own
         * export uses, but which id means wake/rem/light/deep is NOT stated by
         * the spec and is deliberately not guessed here — see
         * {@link #halfMinutesForStage}.
         */
        public final SleepSegment[] segments;

        SleepRecord(long receivedAtMs, int recordState, byte[] unknownPrefix, long unknownTag,
                    long startTs, long endTs, int totalTime, int wakeTime, int remTime,
                    int lightTime, int deepTime, SleepSegment[] segments) {
            super(CMD_HI_SLEEP, receivedAtMs);
            this.recordState = recordState;
            this.unknownPrefix = unknownPrefix;
            this.unknownTag = unknownTag;
            this.startTs = startTs;
            this.endTs = endTs;
            this.totalTime = totalTime;
            this.wakeTime = wakeTime;
            this.remTime = remTime;
            this.lightTime = lightTime;
            this.deepTime = deepTime;
            this.segments = segments;
        }

        public boolean isRealRecord() {
            return recordState == 1;
        }

        public int totalHalfMinutes() {
            int total = 0;
            for (SleepSegment segment : segments) {
                total += segment.halfMinutes;
            }
            return total;
        }

        public int halfMinutesForStage(int stage) {
            int total = 0;
            for (SleepSegment segment : segments) {
                if (segment.stage == stage) {
                    total += segment.halfMinutes;
                }
            }
            return total;
        }

        /**
         * The two whole-record arithmetic identities from the spec, which held
         * exactly for all ten real records in the reference capture. A false
         * result means the body was mis-parsed.
         */
        public boolean identitiesHold() {
            if (!isRealRecord()) {
                return true;
            }
            int seconds = totalHalfMinutes() * 30;
            return seconds == totalTime + wakeTime && seconds == (int) (endTs - startTs);
        }

        @Override public String summary() {
            if (!isRealRecord()) {
                return String.format(Locale.US, "sleep marker state=%d", recordState);
            }
            return String.format(
                Locale.US,
                "sleep segments=%d total=%ds wake=%d rem=%d light=%d deep=%d relStart=%d relEnd=%d identities=%s",
                segments.length, totalTime, wakeTime, remTime, lightTime, deepTime,
                startTs, endTs, identitiesHold());
        }
    }

    /** One stage run: a stage id and a duration in half-minutes (30 s units). */
    public static final class SleepSegment {
        public final int stage;
        public final int halfMinutes;

        SleepSegment(int stage, int halfMinutes) {
            this.stage = stage;
            this.halfMinutes = halfMinutes;
        }
    }

    // ------------------------------------------------------------------
    // Little-endian helpers
    // ------------------------------------------------------------------

    private static void writeIntLe(byte[] out, int offset, int value) {
        out[offset] = (byte) (value & 0xff);
        out[offset + 1] = (byte) ((value >>> 8) & 0xff);
        out[offset + 2] = (byte) ((value >>> 16) & 0xff);
        out[offset + 3] = (byte) ((value >>> 24) & 0xff);
    }

    private static int readIntLe(byte[] data, int offset) {
        return (data[offset] & 0xff)
            | ((data[offset + 1] & 0xff) << 8)
            | ((data[offset + 2] & 0xff) << 16)
            | ((data[offset + 3] & 0xff) << 24);
    }

    private static long readUInt32Le(byte[] data, int offset) {
        return readIntLe(data, offset) & 0xffffffffL;
    }

    private static int readUInt16Le(byte[] data, int offset) {
        return (data[offset] & 0xff) | ((data[offset + 1] & 0xff) << 8);
    }

    private static int readUIntLe(byte[] data, int offset, int width) {
        int value = 0;
        for (int i = 0; i < width; i++) {
            value |= (data[offset + i] & 0xff) << (8 * i);
        }
        return value;
    }

    private static byte[] safeRange(byte[] data, int from, int to) {
        if (data == null || from >= data.length) {
            return EMPTY;
        }
        return Arrays.copyOfRange(data, from, Math.min(to, data.length));
    }

    /** Hex, for logs. Mirrors FaceclawBleCommunicator.hex(). */
    /**
     * One JSON line for {@code ring-sleep-receipts.jsonl}, describing one sleep
     * DATA page as it came off the wire. Pure, so the self-test can pin it.
     *
     * <p>Deliberately RAW: {@code startTs}/{@code endTs} are the ring's own
     * clock, uncorrected, and the whole payload rides along as hex. The log
     * exists to answer protocol questions (how many blocks, in what order, how
     * fast we ACKed) that the decoded store cannot, including about fields the
     * decode has not cracked yet.
     *
     * @param ackWrittenWallMs wall time the ACK write completed, or -1 if it never went out
     * @param ackLatencyMs     page arrival to ACK written, or -1 if it never went out
     * @param note             why the ACK did not go out, or null
     */
    public static String sleepPageReceiptLine(Frame page, long receivedWallMs, long ackWrittenWallMs,
                                              long ackLatencyMs, boolean ackOk, String note) {
        byte[] pay = page.payload;
        int recState = pay != null && pay.length >= 3 ? pay[2] & 0xff : -1;
        SleepRecord record = null;
        try {
            record = page.cmdHi == CMD_HI_SLEEP ? decodeSleep(page, receivedWallMs) : null;
        } catch (RuntimeException ignored) {
            // A body the decoder chokes on still gets its receipt, marked undecoded.
        }
        StringBuilder out = new StringBuilder(320);
        out.append("{\"type\":\"page\"");
        out.append(",\"rx\":\"").append(localStamp(receivedWallMs)).append('"');
        out.append(",\"rxMs\":").append(receivedWallMs);
        out.append(",\"cmd\":\"").append(page.commandLabel()).append('"');
        out.append(",\"pageSeq\":").append(page.seq & 0xff);
        out.append(",\"recState\":").append(recState);
        if (record != null && record.isRealRecord()) {
            out.append(",\"startTs\":").append(record.startTs);
            out.append(",\"endTs\":").append(record.endTs);
            out.append(",\"segments\":").append(record.segments.length);
            out.append(",\"totalSec\":").append(record.totalTime);
            out.append(",\"wakeSec\":").append(record.wakeTime);
            out.append(",\"identities\":").append(record.identitiesHold());
        } else if (record == null) {
            out.append(",\"decoded\":false");
        }
        if (ackWrittenWallMs >= 0) {
            out.append(",\"ack\":\"").append(localStamp(ackWrittenWallMs)).append('"');
            out.append(",\"ackMs\":").append(ackWrittenWallMs);
            out.append(",\"ackLatencyMs\":").append(ackLatencyMs);
        } else {
            out.append(",\"ack\":null,\"ackMs\":null,\"ackLatencyMs\":null");
        }
        out.append(",\"ackOk\":").append(ackOk);
        if (note != null) {
            out.append(",\"note\":\"").append(note.replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
        }
        out.append(",\"payloadHex\":\"").append(hex(pay)).append('"');
        out.append('}');
        return out.toString();
    }

    /**
     * One JSON line for {@code ring-sleep-receipts.jsonl} per sleep REQUEST,
     * whether or not any page came back. {@code pages} counts the SLEEP DATA
     * pages that arrived between this REQ and the ACK flush after its idle
     * wait, queued or not - one per {@code "type":"page"} line in that window.
     * {@code otherPages} counts DATA pages of any OTHER type in the same window:
     * nonzero means an earlier type's pages were still landing after the sleep
     * REQ went out (seen 2026-09-13 15:24, two of them), which is the
     * one-type-in-flight race {@code requestRingHealth} warns about.
     */
    public static String sleepPullReceiptLine(long requestedWallMs, long finishedWallMs, boolean rspSeen,
                                              int pages, int otherPages, boolean newLink) {
        return "{\"type\":\"pull\",\"req\":\"" + localStamp(requestedWallMs) + "\""
            + ",\"reqMs\":" + requestedWallMs
            + ",\"doneMs\":" + finishedWallMs
            + ",\"rsp\":" + rspSeen
            + ",\"pages\":" + pages
            + ",\"otherPages\":" + otherPages
            // link: "new" = first pull after a handshake (Even's connect-time
            // device REQs); "held" = pull over an already-held link (0daf44f's
            // pings). Added 2026-09-14 so a night's sleep pages can be
            // attributed without logcat.
            + ",\"link\":\"" + (newLink ? "new" : "held") + "\"}";
    }

    // ------------------------------------------------------------------
    // Reconnect guard and ring-boot receipts (2026-09-15)
    // ------------------------------------------------------------------

    /** Least gap between two ringConnectSkipped lines; skips inside it are counted instead. */
    public static final long RING_CONNECT_SKIP_RECEIPT_GAP_MS = 60_000L;

    /**
     * A ringBoot or ringBattery line whose ring link had been up at least this
     * long says {@code "link":"held"}. A fresh connect's 00:08 push lands ~1.4 s
     * after the link comes up (09-15 capture, pkts 559 -> 682), and the
     * handshake plus the first pull are done ~14-18 s in (09-14 22:11:59 ->
     * 22:12:12; 09-15 02:41:09 -> 02:41:27). The 06:21:44 re-handshake ran on a
     * link 13 235 s old. Receipt labelling only, and NOT the pull line's
     * "link", which means "first pull after a handshake".
     */
    public static final long RING_HELD_LINK_MIN_AGE_MS = 30_000L;

    /** "held", "new" or "unknown" (age < 0) for a ring link age in ms. */
    static String linkLabel(long linkAgeMs) {
        return linkAgeMs < 0 ? "unknown" : linkAgeMs >= RING_HELD_LINK_MIN_AGE_MS ? "held" : "new";
    }

    /**
     * The tryConnectRing guard. True = the ring is already connected with its
     * notifications subscribed, so connecting again would re-handshake a live
     * link. Pure so the self-test can pin it.
     */
    public static boolean ringConnectShouldSkip(boolean ringConnected, boolean ringNotificationsReady) {
        return ringConnected && ringNotificationsReady;
    }

    /** Rate limit for ringConnectSkipped lines, monotonic clock. {@code lastWrittenMs} < 0 = none yet. */
    public static boolean ringConnectSkipReceiptDue(long nowMs, long lastWrittenMs) {
        return lastWrittenMs < 0 || nowMs - lastWrittenMs >= RING_CONNECT_SKIP_RECEIPT_GAP_MS;
    }

    /**
     * The ring's boot signature: an intact device-channel 00:08 DATA push with
     * seq 00. The ring's DATA seq is one global push counter that carries
     * through reconnects and supervision timeouts and restarts at 00 only after
     * a reset (09-15 capture: 06:22:00, 06:32:01, 06:40:16, three byte-identical
     * frames). Our own 00:08 is a REQ and the ring's answer is a RSP echoing our
     * seq, so neither matches. The counter is 8 bits, so a wrap onto a 00:08
     * push would match too; the receipt carries the previous push seq for that.
     */
    public static boolean isRingBootHello(Frame frame) {
        return frame != null
            && frame.crcOk
            && frame.chan == CHAN_DEVICE
            && frame.kind == KIND_DATA
            && frame.cmdHi == CMD_HI_DEVICE
            && frame.cmdLo == 0x08
            && frame.seq == 0;
    }

    /**
     * One JSON line: tryConnectRing found the ring live and did not touch it.
     * {@code linkAgeMs} < 0 = unknown; {@code suppressed} = skips inside the
     * rate-limit window since the previous such line.
     */
    public static String ringConnectSkippedReceiptLine(long wallMs, String reason, long linkAgeMs, int suppressed) {
        String safeReason = reason == null ? "" : reason.replace("\\", "\\\\").replace("\"", "\\\"");
        return "{\"type\":\"ringConnectSkipped\",\"at\":\"" + localStamp(wallMs) + "\""
            + ",\"atMs\":" + wallMs
            + ",\"reason\":\"" + safeReason + "\""
            + ",\"linkAgeMs\":" + (linkAgeMs >= 0 ? Long.toString(linkAgeMs) : "null")
            + ",\"suppressed\":" + suppressed + "}";
    }

    /**
     * One JSON line: the ring's boot signature arrived. {@code link} is "held"
     * when the link had been up {@link #RING_HELD_LINK_MIN_AGE_MS} or more,
     * "new" below that, "unknown" with no link-up time. {@code prevPushSeq} is
     * the ring's previous DATA seq this process (null = none): near 255 reads
     * as a counter wrap, anything else as a reset.
     */
    public static String ringBootReceiptLine(long wallMs, long linkAgeMs, int prevPushSeq) {
        return "{\"type\":\"ringBoot\",\"at\":\"" + localStamp(wallMs) + "\""
            + ",\"atMs\":" + wallMs
            + ",\"link\":\"" + linkLabel(linkAgeMs) + "\""
            + ",\"linkAgeMs\":" + (linkAgeMs >= 0 ? Long.toString(linkAgeMs) : "null")
            + ",\"prevPushSeq\":" + (prevPushSeq >= 0 ? Integer.toString(prevPushSeq) : "null") + "}";
    }

    /**
     * Battery-shaped device frames, receipt-log only (2026-09-15): the 00:01 RSP
     * (asked for in every handshake and pull), the hourly 00:7F push of the
     * same shape (09-15 capture pkt 4502), and the 00:03 push, one byte after
     * the nonce, meaning unknown. RSP or DATA for all three.
     */
    public static boolean isRingBatteryFrame(Frame frame) {
        return frame != null
            && frame.crcOk
            && frame.chan == CHAN_DEVICE
            && frame.cmdHi == CMD_HI_DEVICE
            && (frame.kind == KIND_RSP || frame.kind == KIND_DATA)
            && (frame.cmdLo == 0x01 || frame.cmdLo == 0x7F || frame.cmdLo == 0x03);
    }

    /**
     * 00:01 / 00:7F level: the first payload byte after the 2-byte nonce, as
     * 0-255 (0x3c = 60 in pkt 41306). -1 for 00:03 or a payload too short to
     * hold it. The byte after it is the charge state ({@link #ringBatteryChargeState});
     * nothing later is read or named here, and the whole payload still goes
     * into the receipt.
     */
    public static int ringBatteryLevel(Frame frame) {
        if (frame == null || frame.cmdLo == 0x03 || frame.payload == null || frame.payload.length < 3) {
            return -1;
        }
        return frame.payload[2] & 0xff;
    }

    /** Charge-state byte on the ring's charger. */
    public static final int RING_BATTERY_STATE_CHARGING = 0x01;
    /** Charge-state byte off the charger. */
    public static final int RING_BATTERY_STATE_NOT_CHARGING = 0x02;

    /**
     * 00:01 / 00:7F charge state: payload[3], the byte after the level, as
     * 0-255. 0x01 on the charger, 0x02 off it: 01 in every 30 s push during the
     * 2026-09-16 09:29-09:39 charge and 02 from 09:40:03 on, when it came off.
     * -1 for 00:03 or a payload too short to hold it.
     */
    public static int ringBatteryChargeState(Frame frame) {
        if (frame == null || frame.cmdLo == 0x03 || frame.payload == null || frame.payload.length < 4) {
            return -1;
        }
        return frame.payload[3] & 0xff;
    }

    /** True only for the on-charger byte; 0x02, any other value and -1 are not charging. */
    public static boolean ringBatteryCharging(Frame frame) {
        return ringBatteryChargeState(frame) == RING_BATTERY_STATE_CHARGING;
    }

    /**
     * One JSON line per battery-shaped frame. {@code cmd} is the same lower-case
     * label page lines use ("00:01", "00:7f", "00:03"); {@code kind} is "rsp" or
     * "push"; {@code payloadHex} is the whole payload, nonce included;
     * {@code link} as for ringBoot.
     */
    public static String ringBatteryReceiptLine(Frame frame, long wallMs, long linkAgeMs) {
        int level = ringBatteryLevel(frame);
        return "{\"type\":\"ringBattery\",\"at\":\"" + localStamp(wallMs) + "\""
            + ",\"atMs\":" + wallMs
            + ",\"cmd\":\"" + frame.commandLabel() + "\""
            + ",\"kind\":\"" + (frame.kind == KIND_RSP ? "rsp" : "push") + "\""
            + ",\"level\":" + (level >= 0 ? Integer.toString(level) : "null")
            + ",\"payloadHex\":\"" + hex(frame.payload) + "\""
            + ",\"link\":\"" + linkLabel(linkAgeMs) + "\""
            + ",\"linkAgeMs\":" + (linkAgeMs >= 0 ? Long.toString(linkAgeMs) : "null") + "}";
    }

    /** "2026-09-14T09:31:02.123-0400", in the device's zone. */
    static String localStamp(long wallMs) {
        return String.format(Locale.US, "%tFT%<tT.%<tL%<tz", wallMs);
    }

    public static String hex(byte[] data) {
        if (data == null || data.length == 0) {
            return "";
        }
        char[] digits = "0123456789abcdef".toCharArray();
        char[] out = new char[data.length * 2];
        for (int i = 0; i < data.length; i++) {
            int value = data[i] & 0xff;
            out[i * 2] = digits[value >>> 4];
            out[i * 2 + 1] = digits[value & 0x0f];
        }
        return new String(out);
    }

    /** The five health requests, ready to write, sharing one ascending seq run. */
    public static List<byte[]> buildHealthRequestBurst(int firstSeq, int firstNonce) {
        List<byte[]> frames = new ArrayList<>(HEALTH_COMMANDS.length);
        int seq = firstSeq;
        int nonce = firstNonce;
        for (int cmdHi : HEALTH_COMMANDS) {
            frames.add(buildHealthRequest(cmdHi, seq, nonce));
            seq = (seq + 1) & 0xff;
            nonce = (nonce + 1) & 0xffff;
        }
        return frames;
    }
}
