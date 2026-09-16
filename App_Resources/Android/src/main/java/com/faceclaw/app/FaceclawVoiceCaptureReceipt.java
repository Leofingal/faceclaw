package com.faceclaw.app;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The receipt for one voice capture: one JSON line in
 * {@code files/voice/capture-receipts.jsonl} (app-private storage), written
 * when the capture ends, so a dictation that came out badly can be looked up
 * afterwards. logcat rotates within minutes; this file does not.
 *
 * <p>Same idea as {@code ring-sleep-receipts.jsonl}: append-only, a hard size
 * cap, never throws. Pure Java with no Android imports, so
 * notes/voice-capture-selftest can build and pin a line off-device.
 * {@link FaceclawVoiceController} converts the Android objects
 * (AudioDeviceInfo, AudioRecordingConfiguration) into the plain values
 * recorded here.
 *
 * <p>Threads: the capture worker feeds audio and segments; routing changes
 * arrive on the main looper. Every mutator is synchronized.
 *
 * <p>Two more line types share the file, keyed to a capture by its id:
 * {@code outcome} (what the wearer did with the transcript) and
 * {@code cloudFinal} (a cloud provider's final text, which arrives after the
 * capture line has already been written). Readers join on the id, not on line
 * order.
 */
public final class FaceclawVoiceCaptureReceipt {
    public static final String DIR = "voice";
    public static final String FILE = "capture-receipts.jsonl";
    /** Hard stop on the receipt file. A typical capture line is 1-2 KB. */
    public static final long MAX_BYTES = 2L * 1024L * 1024L;

    static final int SAMPLE_RATE = 16000;
    /** Level statistics use fixed 50 ms windows, whatever the upstream chunking. */
    static final int WINDOW_SAMPLES = SAMPLE_RATE / 20;
    /**
     * A window whose RMS is below this counts as near-silent. A starting point
     * picked by judgment, not measured against real captures.
     */
    static final double SILENT_WINDOW_DBFS = -50.0;
    private static final int MAX_ROUTING_CHANGES = 32;
    private static final int MAX_SEGMENTS = 64;
    private static final int MAX_TRANSCRIPT_CHARS = 4000;
    private static final int MAX_TAGS_DROPPED = 16;
    private static final Object APPEND_LOCK = new Object();

    /** A device as the receipt records it: Android's type label, product name, AudioDeviceInfo id. */
    public static final class Device {
        final String type;
        final String name;
        final int id;

        public Device(String type, String name, int id) {
            this.type = type;
            this.name = name;
            this.id = id;
        }
    }

    private static final class RoutingChange {
        final long tMs;
        final Device device;

        RoutingChange(long tMs, Device device) {
            this.tMs = tMs;
            this.device = device;
        }
    }

    private static final class Segment {
        final int index;
        final String kind;
        final long audioMs;
        final float peak;
        /** Loudest 50 ms window RMS, full scale 1.0; NaN when not measured. */
        final float level;
        final long decodeMs;
        final boolean gated;
        final int chars;

        Segment(int index, String kind, long audioMs, float peak, float level, long decodeMs, boolean gated,
                int chars) {
            this.index = index;
            this.kind = kind;
            this.audioMs = audioMs;
            this.peak = peak;
            this.level = level;
            this.decodeMs = decodeMs;
            this.gated = gated;
            this.chars = chars;
        }
    }

    private static final class TagDrop {
        final int index;
        final String kind;
        final String tag;

        TagDrop(int index, String kind, String tag) {
            this.index = index;
            this.kind = kind;
            this.tag = tag;
        }
    }

    public final long id;
    public final long startElapsedMs;
    public final boolean phoneMic;
    private final long startWallMs;
    private final String provider;
    private final String holder;
    private final boolean forcePhoneMic;
    private final String mode;
    private final String model;

    // Phone-mic routing.
    private boolean requestSearched;
    private Device requested;
    private boolean requestAccepted;
    private Device routedAfterStart;
    private Device routedAtFirstAudio;
    private final List<RoutingChange> routingChanges = new ArrayList<>();
    private int routingChangesOmitted;
    private Boolean clientSilenced;

    // Audio levels, pre-suppression.
    private long samples;
    private int peakAbs;
    private double sumSquares;
    private int windows;
    private int silentWindows;
    private int zeroWindows;
    private double windowSumSquares;
    private int windowCount;
    private boolean windowAllZero = true;

    // Recognition.
    private final List<Segment> segments = new ArrayList<>();
    private int segmentCount;
    private final List<Integer> gatedSegments = new ArrayList<>();
    private int partialDecodes;
    private long partialDecodeMs;
    private final List<TagDrop> tagsDropped = new ArrayList<>();
    private int tagsDroppedOmitted;

    // G2 path.
    private long beamDropped;
    private boolean g2StatsSet;
    private long g2Packets;
    private long g2Missing;
    private long g2Late;
    private long g2QueueDrop;
    private long g2MaxGapMs;
    private long g2DecodeErrors;

    private boolean speechEnd;
    private boolean verified;
    private boolean isWearer;
    private float similarity;

    // On-device recognizer: loaded for this capture, or already resident.
    private String recognizerModel;
    private boolean recognizerLoaded;
    private int recognizerThreads;
    private long recognizerLoadMs;
    private long recognizerIdleMs;
    private long rssKbBefore = -1;
    private long rssKbAfter = -1;
    private long nativeHeapKbBefore = -1;
    private long nativeHeapKbAfter = -1;

    private String transcript;
    private String outcome = "unfinished";
    private String error;
    private long endWallMs;
    private long durationMs = -1;

    /**
     * @param mode     "onboard" or "cloud"
     * @param model    "moonshine" / "whisper" / "parakeet-v2" / "parakeet-110m" for onboard, null for cloud
     * @param phoneMic true when AudioRecord is the source, false for the G2 over BLE
     */
    public FaceclawVoiceCaptureReceipt(long id, long startWallMs, long startElapsedMs, String provider,
                                       String holder, boolean forcePhoneMic, String mode, String model,
                                       boolean phoneMic) {
        this.id = id;
        this.startWallMs = startWallMs;
        this.startElapsedMs = startElapsedMs;
        this.provider = provider;
        this.holder = holder;
        this.forcePhoneMic = forcePhoneMic;
        this.mode = mode;
        this.model = model;
        this.phoneMic = phoneMic;
    }

    /** setPreferredDevice() was called with this device; accepted is its return value. */
    public synchronized void setRequested(Device device, boolean accepted) {
        requestSearched = true;
        requested = device;
        requestAccepted = accepted;
    }

    /** The search ran and found no hearing-aid / BLE headset input to request. */
    public synchronized void setRequestedNoneFound() {
        requestSearched = true;
        requested = null;
    }

    /** getRoutedDevice() right after startRecording(); often still null that early. */
    public synchronized void setRoutedAfterStart(Device device) {
        routedAfterStart = device;
    }

    /** getRoutedDevice() once the first audio chunk has been read. */
    public synchronized void setRoutedAtFirstAudio(Device device) {
        routedAtFirstAudio = device;
    }

    /** One routing callback, tMs after the capture request. */
    public synchronized void addRoutingChange(long tMs, Device device) {
        if (routingChanges.size() >= MAX_ROUTING_CHANGES) {
            routingChangesOmitted++;
            return;
        }
        routingChanges.add(new RoutingChange(tMs, device));
    }

    /** Sticky: true if any sample saw the client silenced. */
    public synchronized void noteClientSilenced(boolean silenced) {
        clientSilenced = (clientSilenced != null && clientSilenced) || silenced;
    }

    public synchronized void acceptPcm(short[] pcm, int count) {
        if (pcm == null) {
            return;
        }
        int n = Math.min(count, pcm.length);
        for (int i = 0; i < n; i++) {
            int v = pcm[i];
            int a = v < 0 ? -v : v;
            if (a > peakAbs) {
                peakAbs = a;
            }
            double sq = (double) v * v;
            sumSquares += sq;
            windowSumSquares += sq;
            if (v != 0) {
                windowAllZero = false;
            }
            windowCount++;
            if (windowCount == WINDOW_SAMPLES) {
                closeWindow();
            }
        }
        if (n > 0) {
            samples += n;
        }
    }

    private void closeWindow() {
        windows++;
        if (windowAllZero) {
            zeroWindows++;
        }
        if (isSilent(windowSumSquares, windowCount)) {
            silentWindows++;
        }
        windowSumSquares = 0;
        windowCount = 0;
        windowAllZero = true;
    }

    private static boolean isSilent(double sumSq, int count) {
        if (count <= 0) {
            return true;
        }
        double rms = Math.sqrt(sumSq / count);
        return rms <= 0 || 20.0 * Math.log10(rms / 32768.0) < SILENT_WINDOW_DBFS;
    }

    /**
     * One recognizer call. "partial" calls (Moonshine's live preview) only
     * count; "commit" and "final" segments are listed.
     *
     * @param peak pre-normalization peak of the segment, full scale 1.0
     * @return the segment's index, or -1 for a partial
     */
    public synchronized int noteSegment(String kind, long audioMs, float peak, long decodeMs, boolean gated, int chars) {
        return noteSegment(kind, audioMs, peak, Float.NaN, decodeMs, gated, chars);
    }

    /**
     * As above, plus the segment's loudest 50 ms window RMS (full scale 1.0,
     * pre-normalization; the value the Parakeet gate compares), written as
     * "levelDbfs" at the end of the segment entry.
     */
    public synchronized int noteSegment(String kind, long audioMs, float peak, float level, long decodeMs,
                                        boolean gated, int chars) {
        if ("partial".equals(kind)) {
            partialDecodes++;
            partialDecodeMs += decodeMs;
            return -1;
        }
        int index = segmentCount++;
        if (segments.size() < MAX_SEGMENTS) {
            segments.add(new Segment(index, kind, audioMs, peak, level, decodeMs, gated, chars));
        }
        if (gated) {
            gatedSegments.add(index);
        }
        return index;
    }

    /**
     * A recognizer result that was nothing but non-speech tags, dropped
     * before it reached the transcript.
     *
     * @param index the segment index from {@link #noteSegment}, or -1 for a partial
     */
    public synchronized void noteTagDropped(int index, String kind, String tag) {
        if (tagsDropped.size() >= MAX_TAGS_DROPPED) {
            tagsDroppedOmitted++;
            return;
        }
        tagsDropped.add(new TagDrop(index, kind, tag));
    }

    /**
     * This capture built the on-device recognizer: load time and process
     * memory (VmRSS, native heap) either side of it, in kB (-1 = unknown).
     */
    public synchronized void setRecognizerLoad(String model, int threads, long loadMs, long rssKbBefore,
                                               long rssKbAfter, long nativeHeapKbBefore, long nativeHeapKbAfter) {
        this.recognizerModel = model;
        this.recognizerLoaded = true;
        this.recognizerThreads = threads;
        this.recognizerLoadMs = loadMs;
        this.rssKbBefore = rssKbBefore;
        this.rssKbAfter = rssKbAfter;
        this.nativeHeapKbBefore = nativeHeapKbBefore;
        this.nativeHeapKbAfter = nativeHeapKbAfter;
    }

    /** This capture reused the resident recognizer, idle for idleMs since the last capture. */
    public synchronized void setRecognizerResident(String model, int threads, long idleMs) {
        this.recognizerModel = model;
        this.recognizerLoaded = false;
        this.recognizerThreads = threads;
        this.recognizerIdleMs = idleMs;
    }

    public synchronized void noteBeamDrop() {
        beamDropped++;
    }

    public synchronized void setG2Stats(long packets, long missing, long late, long queueDrop, long maxGapMs,
                                        long decodeErrors) {
        g2StatsSet = true;
        g2Packets = packets;
        g2Missing = missing;
        g2Late = late;
        g2QueueDrop = queueDrop;
        g2MaxGapMs = maxGapMs;
        g2DecodeErrors = decodeErrors;
    }

    public synchronized void noteSpeechEnd() {
        speechEnd = true;
    }

    public synchronized void setVerification(boolean isWearer, float similarity) {
        this.verified = true;
        this.isWearer = isWearer;
        this.similarity = similarity;
    }

    /**
     * @param transcript final text, or null when Java does not own it (cloud, or a failure)
     * @param outcome    transcribed / empty / cloud / no-model / mic-failed / g2-audio-failed / error
     */
    public synchronized void finish(String transcript, String outcome, String error, long endWallMs,
                                    long endElapsedMs) {
        this.transcript = transcript;
        this.outcome = outcome;
        this.error = error;
        this.endWallMs = endWallMs;
        this.durationMs = Math.max(0, endElapsedMs - startElapsedMs);
    }

    public synchronized String toJsonLine() {
        StringBuilder out = new StringBuilder(1024);
        out.append("{\"type\":\"capture\"");
        out.append(",\"id\":").append(id);
        out.append(",\"start\":").append(json(localStamp(startWallMs)));
        out.append(",\"startMs\":").append(startWallMs);
        out.append(",\"endMs\":").append(endWallMs > 0 ? String.valueOf(endWallMs) : "null");
        out.append(",\"durationMs\":").append(durationMs >= 0 ? String.valueOf(durationMs) : "null");
        out.append(",\"provider\":").append(json(provider));
        out.append(",\"holder\":").append(json(holder));
        out.append(",\"mode\":").append(json(mode));
        out.append(",\"model\":").append(json(model));
        out.append(",\"source\":").append(json(phoneMic ? "phone-mic" : "g2"));
        out.append(",\"forcePhoneMic\":").append(forcePhoneMic);

        if (phoneMic) {
            out.append(",\"requested\":");
            if (!requestSearched) {
                out.append("null");
            } else if (requested == null) {
                out.append("{\"found\":false}");
            } else {
                out.append("{\"found\":true,\"device\":");
                appendDevice(out, requested);
                out.append(",\"accepted\":").append(requestAccepted).append('}');
            }
            out.append(",\"routedAfterStart\":");
            appendDevice(out, routedAfterStart);
            out.append(",\"routedAtFirstAudio\":");
            appendDevice(out, routedAtFirstAudio);
            out.append(",\"routingChanges\":[");
            for (int i = 0; i < routingChanges.size(); i++) {
                RoutingChange change = routingChanges.get(i);
                if (i > 0) {
                    out.append(',');
                }
                out.append("{\"tMs\":").append(change.tMs).append(",\"device\":");
                appendDevice(out, change.device);
                out.append('}');
            }
            out.append(']');
            if (routingChangesOmitted > 0) {
                out.append(",\"routingChangesOmitted\":").append(routingChangesOmitted);
            }
            out.append(",\"clientSilenced\":").append(clientSilenced == null ? "null" : clientSilenced.toString());
        } else {
            out.append(",\"g2\":");
            if (!g2StatsSet) {
                out.append("null");
            } else {
                out.append("{\"packets\":").append(g2Packets)
                        .append(",\"missing\":").append(g2Missing)
                        .append(",\"late\":").append(g2Late)
                        .append(",\"queueDrop\":").append(g2QueueDrop)
                        .append(",\"maxGapMs\":").append(g2MaxGapMs)
                        .append(",\"decodeErrors\":").append(g2DecodeErrors)
                        .append(",\"beamDropped\":").append(beamDropped)
                        .append('}');
            }
        }

        // A trailing partial window still counts, without disturbing the accumulator.
        int totalWindows = windows;
        int totalSilent = silentWindows;
        int totalZero = zeroWindows;
        if (windowCount > 0) {
            totalWindows++;
            if (windowAllZero) {
                totalZero++;
            }
            if (isSilent(windowSumSquares, windowCount)) {
                totalSilent++;
            }
        }
        out.append(",\"audio\":{\"ms\":").append(samples * 1000L / SAMPLE_RATE)
                .append(",\"peakDbfs\":").append(dbfs(peakAbs / 32768.0))
                .append(",\"rmsDbfs\":").append(samples > 0 ? dbfs(Math.sqrt(sumSquares / samples) / 32768.0) : "null")
                .append(",\"windows\":").append(totalWindows)
                .append(",\"silentFrac\":").append(frac(totalSilent, totalWindows))
                .append(",\"zeroFrac\":").append(frac(totalZero, totalWindows))
                .append(",\"silentBelowDbfs\":").append((int) SILENT_WINDOW_DBFS)
                .append('}');

        out.append(",\"segments\":[");
        for (int i = 0; i < segments.size(); i++) {
            Segment s = segments.get(i);
            if (i > 0) {
                out.append(',');
            }
            out.append("{\"i\":").append(s.index)
                    .append(",\"kind\":").append(json(s.kind))
                    .append(",\"audioMs\":").append(s.audioMs)
                    .append(",\"peakDbfs\":").append(dbfs(s.peak))
                    .append(",\"decodeMs\":").append(s.decodeMs)
                    .append(",\"gated\":").append(s.gated)
                    .append(",\"chars\":").append(s.chars);
            if (!Float.isNaN(s.level)) {
                out.append(",\"levelDbfs\":").append(dbfs(s.level));
            }
            out.append('}');
        }
        out.append(']');
        out.append(",\"segmentCount\":").append(segmentCount);
        out.append(",\"gateDrops\":").append(gatedSegments.size());
        out.append(",\"gatedSegments\":[");
        for (int i = 0; i < gatedSegments.size(); i++) {
            if (i > 0) {
                out.append(',');
            }
            out.append(gatedSegments.get(i));
        }
        out.append(']');
        out.append(",\"partialDecodes\":").append(partialDecodes);
        out.append(",\"partialDecodeMs\":").append(partialDecodeMs);
        out.append(",\"tagsDropped\":[");
        for (int i = 0; i < tagsDropped.size(); i++) {
            TagDrop drop = tagsDropped.get(i);
            if (i > 0) {
                out.append(',');
            }
            out.append("{\"i\":").append(drop.index >= 0 ? String.valueOf(drop.index) : "null")
                    .append(",\"kind\":").append(json(drop.kind))
                    .append(",\"tag\":").append(json(drop.tag))
                    .append('}');
        }
        out.append(']');
        if (tagsDroppedOmitted > 0) {
            out.append(",\"tagsDroppedOmitted\":").append(tagsDroppedOmitted);
        }
        if (recognizerModel != null) {
            out.append(",\"recognizer\":{\"model\":").append(json(recognizerModel))
                    .append(",\"threads\":").append(recognizerThreads)
                    .append(",\"loaded\":").append(recognizerLoaded);
            if (recognizerLoaded) {
                out.append(",\"loadMs\":").append(recognizerLoadMs)
                        .append(",\"rssMb\":[").append(mbOrNull(rssKbBefore)).append(',').append(mbOrNull(rssKbAfter))
                        .append("],\"nativeHeapMb\":[").append(mbOrNull(nativeHeapKbBefore)).append(',')
                        .append(mbOrNull(nativeHeapKbAfter)).append(']');
            } else {
                out.append(",\"idleMs\":").append(recognizerIdleMs);
            }
            out.append('}');
        }
        out.append(",\"speechEnd\":").append(speechEnd);
        out.append(",\"verify\":");
        if (verified) {
            out.append("{\"isWearer\":").append(isWearer)
                    .append(",\"similarity\":").append(String.format(Locale.US, "%.3f", similarity))
                    .append('}');
        } else {
            out.append("null");
        }
        appendTranscript(out, transcript);
        out.append(",\"outcome\":").append(json(outcome));
        out.append(",\"error\":").append(json(error));
        out.append('}');
        return out.toString();
    }

    /**
     * The resident recognizer was released between captures (idle timeout or a
     * model switch): memory either side of the release, in MB ([before, after]).
     */
    public static String recognizerUnloadLine(long wallMs, String model, String reason, long rssKbBefore,
                                              long rssKbAfter, long nativeHeapKbBefore, long nativeHeapKbAfter) {
        return "{\"type\":\"recognizerUnload\""
                + ",\"at\":" + json(localStamp(wallMs))
                + ",\"atMs\":" + wallMs
                + ",\"model\":" + json(model)
                + ",\"reason\":" + json(reason)
                + ",\"rssMb\":[" + mbOrNull(rssKbBefore) + "," + mbOrNull(rssKbAfter) + "]"
                + ",\"nativeHeapMb\":[" + mbOrNull(nativeHeapKbBefore) + "," + mbOrNull(nativeHeapKbAfter) + "]"
                + "}";
    }

    /** kB to whole MB, or JSON null when unknown (negative). */
    static String mbOrNull(long kb) {
        return kb < 0 ? "null" : String.valueOf(Math.round(kb / 1024.0));
    }

    /** What the wearer did with capture {@code captureId}'s transcript. */
    public static String outcomeLine(long captureId, long wallMs, String outcome, String via) {
        return "{\"type\":\"outcome\",\"capture\":" + captureId
                + ",\"at\":" + json(localStamp(wallMs))
                + ",\"atMs\":" + wallMs
                + ",\"outcome\":" + json(outcome)
                + ",\"via\":" + json(via) + "}";
    }

    /** A cloud provider's final transcript for capture {@code captureId}. */
    public static String cloudFinalLine(long captureId, long wallMs, String provider, String text) {
        StringBuilder out = new StringBuilder(256);
        out.append("{\"type\":\"cloudFinal\",\"capture\":").append(captureId)
                .append(",\"at\":").append(json(localStamp(wallMs)))
                .append(",\"atMs\":").append(wallMs)
                .append(",\"provider\":").append(json(provider));
        appendTranscript(out, text);
        out.append('}');
        return out.toString();
    }

    /**
     * Append one line to {@code dir/FILE}. Returns whether it was written;
     * never throws. Like the sleep receipts, the cap is checked before the
     * write, so the file can pass it by at most one line.
     */
    public static boolean appendLine(File dir, String line, long maxBytes) {
        if (dir == null || line == null) {
            return false;
        }
        synchronized (APPEND_LOCK) {
            try {
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    return false;
                }
                File file = new File(dir, FILE);
                if (file.length() > maxBytes) {
                    return false;
                }
                try (FileOutputStream out = new FileOutputStream(file, true)) {
                    out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                }
                return true;
            } catch (Throwable t) {
                return false;
            }
        }
    }

    private static void appendTranscript(StringBuilder out, String text) {
        if (text == null) {
            out.append(",\"transcript\":null");
            return;
        }
        boolean truncated = text.length() > MAX_TRANSCRIPT_CHARS;
        out.append(",\"transcript\":").append(json(truncated ? text.substring(0, MAX_TRANSCRIPT_CHARS) : text));
        out.append(",\"transcriptChars\":").append(text.length());
        if (truncated) {
            out.append(",\"transcriptTruncated\":true");
        }
    }

    private static void appendDevice(StringBuilder out, Device device) {
        if (device == null) {
            out.append("null");
            return;
        }
        out.append("{\"type\":").append(json(device.type))
                .append(",\"name\":").append(json(device.name))
                .append(",\"id\":").append(device.id)
                .append('}');
    }

    /** Full-scale-1.0 amplitude to dBFS with one decimal; silence is JSON null. */
    static String dbfs(double amplitude) {
        if (!(amplitude > 0)) {
            return "null";
        }
        return String.format(Locale.US, "%.1f", 20.0 * Math.log10(amplitude));
    }

    private static String frac(int part, int whole) {
        return whole <= 0 ? "null" : String.format(Locale.US, "%.3f", part / (double) whole);
    }

    /** "2026-09-14T22:40:00.123-0400", in the device's zone (same format as the sleep receipts). */
    static String localStamp(long wallMs) {
        return String.format(Locale.US, "%tFT%<tT.%<tL%<tz", wallMs);
    }

    /** A JSON string literal, or null. */
    static String json(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder out = new StringBuilder(s.length() + 2);
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        out.append(String.format(Locale.US, "\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
        return out.toString();
    }
}
