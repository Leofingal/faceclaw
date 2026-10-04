package com.faceclaw.app;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Where the ring's clock is, persisted (2026-10-04): {@code files/health/ring-clock.json}.
 *
 * <p>The ring's clock holds whatever offset it has at or above UTC (ours:
 * UTC+4 h, the old {@code now - zone offset} in EDT) and never moves back; a
 * ring behind UTC, or one that reset and lost its clock, is written plain UTC
 * (see {@link RingProtocol#planClockWrite}). With the developer setting
 * {@code developer.ringClockRestoreUtc} on, an offset above 0 is slewed to UTC
 * by at most {@link RingProtocol#CLOCK_MAX_BACK_STEP_SEC} per connect. The
 * file format is unchanged from 7025819. This file holds:
 * <ul>
 *   <li>{@code offsetSec}: ring clock minus true UTC as last written AND
 *       answered. The next write starts from here, so a value the ring
 *       may not have taken is never a base.</li>
 *   <li>{@code lastBackStepAtMs}: wall time of the last committed backward
 *       slew step (the write after a reset is not one).</li>
 *   <li>{@code segments}: {@code [ring second, offset]} from each committed
 *       change, oldest first, the first one {@code [0, seed]}. The store sync
 *       reads it to turn a ring timestamp back into true time with the offset
 *       that was in force when the ring stamped it
 *       ({@link RingProtocol#clockOffsetSecAt}). This replaced the JS
 *       {@code ringClockOffsetMs()}, which read the JS zone, and the JS zone
 *       in a long-running app process is the zone it STARTED in: on 10-03 the
 *       app kept stamping JST (+09:00) receipts after landing in the US, and
 *       stored the in-flight nap 9 h late.</li>
 * </ul>
 *
 * <p>No file (first run of this build, or app data wiped): seeded with the old
 * formula, {@code -zone offset} now, which is exactly what the previous build
 * wrote on its last connect as long as the phone has not changed zone since.
 * Measured 2026-10-04 from the page timestamps: the ring sat at UTC+4 h, the
 * EDT value. A file that will not parse is kept as {@code ring-clock.json.bad}
 * and reseeded the same way.
 *
 * <p>Free of Android imports so the ring-link harness runs it on a plain JVM.
 * Every read and write holds one process-wide lock; the file is replaced by
 * write-then-rename.
 */
public final class RingClockState {
    public static final String FILE = "ring-clock.json";
    /** Bounds the file. The 4 h slew is 85 segments; the hold rule adds one per reset or forward jump. */
    static final int MAX_SEGMENTS = 512;

    private static final Object LOCK = new Object();
    private static final Pattern SEGMENT = Pattern.compile("\\[\\s*(-?[0-9]+)\\s*,\\s*(-?[0-9]+)\\s*\\]");

    public final long offsetSec;
    public final long lastBackStepAtMs;
    public final String seed;
    public final long seedOffsetSec;
    public final long seededAtMs;
    public final long[][] segments;
    /** Set on the load that created the file; not persisted. */
    public final boolean seededNow;

    private RingClockState(long offsetSec, long lastBackStepAtMs, String seed, long seedOffsetSec,
            long seededAtMs, long[][] segments, boolean seededNow) {
        this.offsetSec = offsetSec;
        this.lastBackStepAtMs = lastBackStepAtMs;
        this.seed = seed;
        this.seedOffsetSec = seedOffsetSec;
        this.seededAtMs = seededAtMs;
        this.segments = segments;
        this.seededNow = seededNow;
    }

    /** What the pre-2026-10-04 handshake wrote: {@code -TimeZone.getOffset(now)}, +14400 in EDT. */
    public static long legacyOffsetSec(long nowMs) {
        return -TimeZone.getDefault().getOffset(nowMs) / 1000L;
    }

    /** The phone's zone now, minutes east of UTC, as 00:05 carries it. */
    public static int zoneMinutesEast(long nowMs) {
        return TimeZone.getDefault().getOffset(nowMs) / 60_000;
    }

    /** Load, seeding (and saving the seed) when there is no usable file. */
    public static RingClockState load(File healthDir, long nowMs) {
        synchronized (LOCK) {
            File file = new File(healthDir, FILE);
            if (file.exists()) {
                try {
                    RingClockState parsed = parse(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
                    if (parsed != null) {
                        return parsed;
                    }
                } catch (IOException | RuntimeException ignored) {
                    // fall through: keep the bad copy, reseed
                }
                //noinspection ResultOfMethodCallIgnored
                file.renameTo(new File(healthDir, FILE + ".bad"));
            }
            long seedOffset = legacyOffsetSec(nowMs);
            RingClockState seeded = new RingClockState(seedOffset, 0L, "legacy-zone", seedOffset, nowMs,
                new long[][] {{0L, seedOffset}}, true);
            save(healthDir, seeded);
            return seeded;
        }
    }

    /**
     * Record a write the ring answered: the new offset becomes the base, a
     * backward slew step stamps {@code lastBackStepAtMs}, and a changed offset
     * opens a segment at the written ring second. Returns the saved state.
     */
    public static RingClockState commit(File healthDir, RingProtocol.ClockPlan plan, long nowMs) {
        synchronized (LOCK) {
            RingClockState current = load(healthDir, nowMs);
            List<long[]> segs = new ArrayList<>();
            for (long[] s : current.segments) {
                segs.add(s);
            }
            if (segs.isEmpty() || segs.get(segs.size() - 1)[1] != plan.offsetSec) {
                segs.add(new long[] {plan.writtenSec, plan.offsetSec});
            }
            while (segs.size() > MAX_SEGMENTS) {
                // Drop the second-oldest, keeping the seed as the floor.
                segs.remove(1);
            }
            long lastBack = plan.isBackwardStep() ? nowMs : current.lastBackStepAtMs;
            RingClockState next = new RingClockState(plan.offsetSec, lastBack, current.seed, current.seedOffsetSec,
                current.seededAtMs, segs.toArray(new long[0][]), false);
            save(healthDir, next);
            return next;
        }
    }

    /** The state as JSON, for the JS store sync (which parses {@code segments}). Seeds if needed. */
    public static String historyJson(File healthDir) {
        return load(healthDir, System.currentTimeMillis()).toJson();
    }

    public String toJson() {
        StringBuilder out = new StringBuilder(64 + segments.length * 24);
        out.append("{\"v\":1");
        out.append(",\"offsetSec\":").append(offsetSec);
        out.append(",\"lastBackStepAtMs\":").append(lastBackStepAtMs);
        out.append(",\"seed\":\"").append(seed).append('"');
        out.append(",\"seedOffsetSec\":").append(seedOffsetSec);
        out.append(",\"seededAtMs\":").append(seededAtMs);
        out.append(",\"segments\":[");
        for (int i = 0; i < segments.length; i++) {
            if (i > 0) {
                out.append(',');
            }
            out.append('[').append(segments[i][0]).append(',').append(segments[i][1]).append(']');
        }
        out.append("]}");
        return out.toString();
    }

    static RingClockState parse(String json) {
        if (json == null || !json.contains("\"offsetSec\"") || !json.contains("\"segments\"")) {
            return null;
        }
        long offset = RingProtocol.jsonLongField(json, "offsetSec", Long.MIN_VALUE);
        if (offset == Long.MIN_VALUE) {
            return null;
        }
        long lastBack = RingProtocol.jsonLongField(json, "lastBackStepAtMs", 0L);
        long seedOffset = RingProtocol.jsonLongField(json, "seedOffsetSec", offset);
        long seededAt = RingProtocol.jsonLongField(json, "seededAtMs", 0L);
        Matcher seedMatch = Pattern.compile("\"seed\"\\s*:\\s*\"([a-z-]*)\"").matcher(json);
        String seed = seedMatch.find() ? seedMatch.group(1) : "unknown";
        int segStart = json.indexOf("\"segments\"");
        List<long[]> segs = new ArrayList<>();
        Matcher m = SEGMENT.matcher(json.substring(segStart));
        while (m.find()) {
            segs.add(new long[] {Long.parseLong(m.group(1)), Long.parseLong(m.group(2))});
        }
        if (segs.isEmpty()) {
            segs.add(new long[] {0L, offset});
        }
        return new RingClockState(offset, lastBack, seed, seedOffset, seededAt, segs.toArray(new long[0][]), false);
    }

    private static void save(File healthDir, RingClockState state) {
        //noinspection ResultOfMethodCallIgnored
        healthDir.mkdirs();
        File tmp = new File(healthDir, FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(state.toJson().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (IOException e) {
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        tmp.renameTo(new File(healthDir, FILE));
    }
}
