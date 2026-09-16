package com.faceclaw.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Write-ahead journal for ring health DATA pages, so the ring never discards a
 * page before the phone holds it durably.
 *
 * <p>Chris, 2026-09-16: nothing we send may make the ring discard data until it
 * is durably in the store. The page ACK ({@code 00:7E}) is the ring's read
 * pointer: a closed hour, step slot or sleep block that has been ACKed is never
 * sent again. Before this journal the ACK went out ~1.5 s after the page while
 * the only copy sat in RAM, and the store write came up to ~60 s later, so an
 * app kill in between lost closed data for good
 * (knowledge/staging/faceclaw-ring-reboot-cause-return.md §§5-6 in the TLC
 * knowledge base).
 *
 * <p>The order is now:
 * <ol>
 *   <li>{@link #journalThenAck}: the raw frame of every page in a flush is
 *       appended here and fsynced, and only then are their ACKs written. If the
 *       append fails, no ACK is written; the ring keeps the page and re-sends
 *       it on the next request.</li>
 *   <li>The JS store sync reads {@link #readBatch()} (everything above the
 *       committed watermark, decoded with {@link RingProtocol#decode}), writes
 *       the store, and only after both store appends return calls
 *       {@link #commit(long)}.</li>
 *   <li>Lines at or below the watermark are trimmed ({@link #compact}) only
 *       once that watermark is {@link #TRIM_DELAY_MS} old, and only when the
 *       file has grown past {@link #COMPACT_AT_BYTES}.</li>
 * </ol>
 *
 * <p>Each line is {@code {"n":N,"rxMs":R,"cmd":"06:01","pageSeq":32,"rawHex":"..."}}:
 * {@code n} is a journal-local identity that only increases, {@code rxMs} the
 * page's arrival wall time (what {@link RingProtocol#decode} was handed live),
 * and {@code rawHex} the whole reassembled frame, header and CRC included, so a
 * round trip reproduces the bytes the ring sent.
 *
 * <p>Deliberately free of Android imports, like {@link RingProtocol}, so
 * notes/ring-protocol-selftest/ can exercise it with plain javac/java.
 */
public class RingPageJournal {
    public static final String JOURNAL_FILE = "ring-pages.jsonl";
    public static final String COMMITTED_FILE = "ring-pages.committed";
    /** Compaction runs only past this size. A pull is a few kB of lines. */
    static final long COMPACT_AT_BYTES = 128L * 1024L;
    /**
     * A committed line is trimmed only once its commit is this old. The store's
     * appends are not fsynced (they survive an app kill, not a phone crash), so
     * this is margin for the kernel to write them out before the journal copy
     * goes. Measured in process-monotonic time; a restart simply trims nothing
     * until a new commit ages.
     */
    static final long TRIM_DELAY_MS = 10L * 60L * 1000L;
    /** Bounds one sync's work if the store has fallen far behind. */
    static final int MAX_LINES_PER_BATCH = 2000;

    private static final Map<String, RingPageJournal> SHARED = new HashMap<>();

    /**
     * The one journal for a directory. The communicator (worker thread, appends)
     * and the JS store sync (main thread, reads and commits) must share one
     * instance: its lock is what keeps a compaction's rename from racing an
     * append. Keyed by canonical path so two spellings of files/health still
     * meet.
     */
    public static RingPageJournal forDirectory(File dir) {
        String key;
        try {
            key = dir.getCanonicalPath();
        } catch (IOException e) {
            key = dir.getAbsolutePath();
        }
        synchronized (SHARED) {
            RingPageJournal journal = SHARED.get(key);
            if (journal == null) {
                journal = new RingPageJournal(dir);
                SHARED.put(key, journal);
            }
            return journal;
        }
    }

    private final File dir;
    private final File journalFile;
    private final File committedFile;
    private boolean loaded;
    /** Identity for the next appended line. Guarded by this. */
    private long nextN = 1L;
    /** Highest n the store has durably written. Guarded by this. */
    private long committed;
    /** Commits not yet {@link #TRIM_DELAY_MS} old, oldest first: {n, monotonic ms}. */
    private final ArrayDeque<long[]> recentCommits = new ArrayDeque<>();
    /** Highest n whose commit is old enough to trim below. -1 = none yet this process. */
    private long trimFloor = -1L;

    /** Package-private: production code goes through {@link #forDirectory}; tests build their own. */
    RingPageJournal(File dir) {
        this.dir = dir;
        this.journalFile = new File(dir, JOURNAL_FILE);
        this.committedFile = new File(dir, COMMITTED_FILE);
    }

    // ------------------------------------------------------------------
    // Append, then ACK
    // ------------------------------------------------------------------

    /** Writes one page's ACK; called only after its page is durably journaled. */
    public interface AckStep {
        void ack(int index);
    }

    /** The outcome of one {@link #append}. */
    public static final class Appended {
        public final int pages;
        public final long firstN;
        public final long lastN;
        public final long durationMs;
        /** Null when the lines are written and fsynced. */
        public final IOException error;

        Appended(int pages, long firstN, long lastN, long durationMs, IOException error) {
            this.pages = pages;
            this.firstN = firstN;
            this.lastN = lastN;
            this.durationMs = durationMs;
            this.error = error;
        }

        public boolean ok() {
            return error == null;
        }
    }

    /**
     * The rule in one place: journal every page of the batch durably, and only
     * then run {@code step} for each, in order. On any journal failure (a null
     * journal included) no step runs.
     */
    public static Appended journalThenAck(RingPageJournal journal, List<RingProtocol.Frame> pages,
                                          long[] rxWallMs, AckStep step) {
        Appended appended = journal == null
            ? new Appended(pages.size(), -1L, -1L, 0L, new IOException("no page journal"))
            : journal.append(pages, rxWallMs);
        if (appended.ok()) {
            for (int i = 0; i < pages.size(); i++) {
                step.ack(i);
            }
        }
        return appended;
    }

    /**
     * Append one line per page and fsync, in a single write. Never throws; the
     * result carries the error.
     *
     * <p>The identities are spent even when the append fails: bytes may have
     * reached the file before the failing fsync, and reusing their n would give
     * two lines one identity. A gap in n costs nothing.
     */
    public synchronized Appended append(List<RingProtocol.Frame> pages, long[] rxWallMs) {
        long startNs = System.nanoTime();
        long firstN = -1L;
        long lastN = -1L;
        try {
            ensureLoaded();
            firstN = nextN;
            lastN = nextN + pages.size() - 1;
            nextN += pages.size();
            if (!dir.isDirectory() && !dir.mkdirs()) {
                throw new IOException("cannot create " + dir);
            }
            StringBuilder text = new StringBuilder();
            if (!endsWithNewline(journalFile)) {
                // A crash mid-append left a torn last line. Start clean so this
                // batch's first line is not glued onto it.
                text.append('\n');
            }
            for (int i = 0; i < pages.size(); i++) {
                text.append(line(firstN + i, pages.get(i), rxWallMs[i])).append('\n');
            }
            try (FileOutputStream out = new FileOutputStream(journalFile, true)) {
                out.write(text.toString().getBytes(StandardCharsets.UTF_8));
                out.flush();
                syncToDisk(out);
            }
            return new Appended(pages.size(), firstN, lastN, elapsedMs(startNs), null);
        } catch (IOException e) {
            return new Appended(pages.size(), firstN, lastN, elapsedMs(startNs), e);
        } catch (RuntimeException e) {
            return new Appended(pages.size(), firstN, lastN, elapsedMs(startNs),
                new IOException(e.getClass().getSimpleName() + ": " + e.getMessage(), e));
        }
    }

    /** Overridable so the self-test can make the fsync fail. */
    protected void syncToDisk(FileOutputStream out) throws IOException {
        out.getFD().sync();
    }

    /** Overridable so the self-test can age commits. */
    protected long monotonicMs() {
        return System.nanoTime() / 1_000_000L;
    }

    /** One journal line. Public so the self-test pins the exact shape. */
    public static String line(long n, RingProtocol.Frame page, long rxWallMs) {
        return "{\"n\":" + n
            + ",\"rxMs\":" + rxWallMs
            + ",\"cmd\":\"" + page.commandLabel() + "\""
            + ",\"pageSeq\":" + (page.seq & 0xff)
            + ",\"rawHex\":\"" + RingProtocol.hex(page.raw) + "\"}";
    }

    // ------------------------------------------------------------------
    // Read, commit, compact
    // ------------------------------------------------------------------

    /** One parsed journal line. */
    public static final class Entry {
        public final long n;
        public final long rxWallMs;
        public final byte[] raw;

        Entry(long n, long rxWallMs, byte[] raw) {
            this.n = n;
            this.rxWallMs = rxWallMs;
            this.raw = raw;
        }
    }

    /**
     * Everything above the committed watermark, decoded. Shaped like
     * FaceclawBleCommunicator.RingHealthBatch so the JS sync barely changes.
     */
    public static final class Batch {
        private final List<RingProtocol.HealthRecord> records;
        private final long watermark;
        private final long committed;
        private final int lines;
        private final int undecoded;
        private final int corrupt;

        Batch(List<RingProtocol.HealthRecord> records, long watermark, long committed,
              int lines, int undecoded, int corrupt) {
            this.records = records;
            this.watermark = watermark;
            this.committed = committed;
            this.lines = lines;
            this.undecoded = undecoded;
            this.corrupt = corrupt;
        }

        public List<RingProtocol.HealthRecord> getRecords() {
            return records;
        }

        /** Pass to {@link #commit(long)} once the store has written these records. */
        public long getWatermark() {
            return watermark;
        }

        /** The watermark this batch was read above. */
        public long getCommitted() {
            return committed;
        }

        /** Journal lines above the watermark read into this batch. 0 = nothing new. */
        public int getLines() {
            return lines;
        }

        /** Intact frames RingProtocol.decode could not decode. Committed like the rest. */
        public int getUndecoded() {
            return undecoded;
        }

        /** Lines whose frame failed to parse or failed its CRC. */
        public int getCorrupt() {
            return corrupt;
        }
    }

    /**
     * Read and decode every line above the committed watermark, up to
     * {@link #MAX_LINES_PER_BATCH}. The file is copied under the lock and parsed
     * outside it, so a read never holds up an ACK flush for the parse.
     */
    public Batch readBatch() throws IOException {
        byte[] bytes;
        long committedNow;
        synchronized (this) {
            ensureLoaded();
            committedNow = committed;
            bytes = readAll(journalFile);
        }
        List<RingProtocol.HealthRecord> records = new ArrayList<>();
        long watermark = committedNow;
        int lines = 0;
        int undecoded = 0;
        int corrupt = 0;
        for (String text : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
            if (text.isEmpty()) {
                continue;
            }
            Entry entry = parseLine(text);
            if (entry == null) {
                corrupt++;
                continue;
            }
            if (entry.n <= committedNow) {
                continue;
            }
            if (lines >= MAX_LINES_PER_BATCH) {
                break;
            }
            lines++;
            watermark = Math.max(watermark, entry.n);
            RingProtocol.Frame frame = RingProtocol.parse(entry.raw);
            if (frame == null || !frame.crcOk) {
                corrupt++;
                continue;
            }
            RingProtocol.HealthRecord record = null;
            try {
                record = RingProtocol.decode(frame, entry.rxWallMs);
            } catch (RuntimeException e) {
                record = null;
            }
            if (record == null) {
                undecoded++;
            } else {
                records.add(record);
            }
        }
        return new Batch(records, watermark, committedNow, lines, undecoded, corrupt);
    }

    /**
     * The store has written every record up to and including {@code n}. Call
     * ONLY after the store appends returned without throwing.
     *
     * <p>The watermark file is replaced by rename and deliberately not fsynced:
     * it is then no more durable than the store appends it vouches for, so a
     * phone crash that loses those appends tends to lose this too, and the
     * lines are re-ingested (the store dedupes). An unreadable watermark reads
     * as 0, which re-ingests rather than skips.
     */
    public synchronized void commit(long n) throws IOException {
        ensureLoaded();
        if (n <= committed) {
            return;
        }
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("cannot create " + dir);
        }
        File tmp = new File(dir, COMMITTED_FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp, false)) {
            out.write((n + "\n").getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(committedFile)) {
            throw new IOException("rename " + tmp + " -> " + committedFile + " failed");
        }
        committed = n;

        long now = monotonicMs();
        recentCommits.addLast(new long[] {n, now});
        while (!recentCommits.isEmpty() && now - recentCommits.peekFirst()[1] >= TRIM_DELAY_MS) {
            trimFloor = Math.max(trimFloor, recentCommits.pollFirst()[0]);
        }
        while (recentCommits.size() > 1000) {
            // Commits every few seconds for hours: keep the deque bounded. Dropping
            // the oldest only delays trimming, never hastens it.
            recentCommits.pollFirst();
        }
        if (trimFloor > 0 && journalFile.length() > COMPACT_AT_BYTES) {
            compact(trimFloor);
        }
    }

    /** Highest committed n (loads the watermark file on first use). */
    public synchronized long committed() throws IOException {
        ensureLoaded();
        return committed;
    }

    /**
     * Rewrite the journal without lines at or below {@code floor} (and without
     * unparseable lines, which a crash can leave and nothing ever ACKed). The new
     * file is fsynced before the rename; a crash before the rename leaves the
     * old, longer journal, which is the safe side. Caller holds this.
     */
    private void compact(long floor) throws IOException {
        byte[] bytes = readAll(journalFile);
        StringBuilder keep = new StringBuilder();
        for (String text : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
            if (text.isEmpty()) {
                continue;
            }
            Entry entry = parseLine(text);
            if (entry == null || entry.n <= floor) {
                continue;
            }
            keep.append(text).append('\n');
        }
        File tmp = new File(dir, JOURNAL_FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp, false)) {
            out.write(keep.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
            syncToDisk(out);
        }
        if (!tmp.renameTo(journalFile)) {
            throw new IOException("rename " + tmp + " -> " + journalFile + " failed");
        }
    }

    // ------------------------------------------------------------------

    private void ensureLoaded() throws IOException {
        if (loaded) {
            return;
        }
        long watermark = 0L;
        if (committedFile.isFile()) {
            try {
                watermark = Long.parseLong(new String(readAll(committedFile), StandardCharsets.UTF_8).trim());
            } catch (NumberFormatException e) {
                watermark = 0L;
            }
        }
        long maxN = 0L;
        for (String text : new String(readAll(journalFile), StandardCharsets.UTF_8).split("\n")) {
            Entry entry = text.isEmpty() ? null : parseLine(text);
            if (entry != null && entry.n > maxN) {
                maxN = entry.n;
            }
        }
        committed = Math.max(0L, watermark);
        nextN = Math.max(maxN, committed) + 1L;
        loaded = true;
    }

    /** Parse one line this class wrote, or null. Strict: only our own shape. */
    public static Entry parseLine(String text) {
        if (!text.startsWith("{") || !text.endsWith("}")) {
            return null;
        }
        long n = longField(text, "\"n\":");
        long rx = longField(text, "\"rxMs\":");
        String hex = stringField(text, "\"rawHex\":\"");
        if (n <= 0L || rx == Long.MIN_VALUE || hex == null || hex.length() % 2 != 0) {
            return null;
        }
        byte[] raw = new byte[hex.length() / 2];
        for (int i = 0; i < raw.length; i++) {
            int hi = Character.digit(hex.charAt(i * 2), 16);
            int lo = Character.digit(hex.charAt(i * 2 + 1), 16);
            if (hi < 0 || lo < 0) {
                return null;
            }
            raw[i] = (byte) ((hi << 4) | lo);
        }
        return new Entry(n, rx, raw);
    }

    private static long longField(String text, String key) {
        int at = text.indexOf(key);
        if (at < 0) {
            return Long.MIN_VALUE;
        }
        int start = at + key.length();
        int end = start;
        if (end < text.length() && text.charAt(end) == '-') {
            end++;
        }
        while (end < text.length() && Character.isDigit(text.charAt(end))) {
            end++;
        }
        try {
            return Long.parseLong(text.substring(start, end));
        } catch (NumberFormatException e) {
            return Long.MIN_VALUE;
        }
    }

    private static String stringField(String text, String key) {
        int at = text.indexOf(key);
        if (at < 0) {
            return null;
        }
        int start = at + key.length();
        int end = text.indexOf('"', start);
        return end < 0 ? null : text.substring(start, end);
    }

    private static boolean endsWithNewline(File file) throws IOException {
        long length = file.length();
        if (!file.isFile() || length == 0) {
            return true;
        }
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            in.seek(length - 1);
            return in.read() == '\n';
        }
    }

    private static byte[] readAll(File file) throws IOException {
        if (!file.isFile()) {
            return new byte[0];
        }
        try (FileInputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.min(file.length(), 1 << 24));
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }

    private static long elapsedMs(long startNs) {
        return (System.nanoTime() - startNs) / 1_000_000L;
    }
}
