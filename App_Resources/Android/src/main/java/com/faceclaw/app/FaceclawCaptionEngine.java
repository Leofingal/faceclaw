package com.faceclaw.app;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizerResult;
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig;
import com.k2fsa.sherpa.onnx.OfflineStream;

import java.io.File;
import java.util.ArrayDeque;
import java.util.Arrays;

/**
 * Continuous captioning over the decoded mic PCM: segments speech into
 * utterances with an adaptive energy gate, transcribes each utterance with
 * the on-device caption model (Moonshine for English, or SenseVoice for
 * Japanese/Korean/Chinese/English with a detected-language tag per
 * utterance), and attaches a speaker voice-print per utterance. PCM is pushed in from the TS side (which owns mic arbitration
 * and any beam-direction gating), so this engine has no BLE dependencies.
 *
 * Utterance boundaries are measured on the sample clock, not the wall clock:
 * BLE delivers mic packets in bursts, so elapsed real time overestimates the
 * audio heard. The TS side converts startMs/endMs to wall-clock times using
 * the engine start timestamp.
 */
public class FaceclawCaptionEngine {
    private static final String TAG = "FaceclawCaptions";
    private static final int SAMPLE_RATE = 16000;
    private static final int FEATURE_DIM = 80;
    private static final int MAX_QUEUE_PACKETS = 200;

    // Segmentation: RMS thresholds relative to a rolling noise floor, in the
    // same spirit as FaceclawVoiceController.EndpointDetector but recurring.
    private static final double ONSET_FACTOR = 3.0;
    private static final double RELEASE_FACTOR = 1.8;
    private static final double MIN_RMS = 220.0;
    private static final double NOISE_EMA_ALPHA = 0.05;
    private static final int PRE_ROLL_MS = 400;
    private static final int DEFAULT_SILENCE_MS = 800;
    private static final int MIN_UTTERANCE_MS = 350;
    private static final int MAX_UTTERANCE_MS = 15000;
    // Moonshine v2 fails past ~9.1 s of input; decode long utterances in
    // segments cut at the quietest window (mirrors FaceclawVoiceController).
    private static final int DECODE_SEGMENT_MAX_SAMPLES = SAMPLE_RATE * 8;
    // SenseVoice is a non-autoregressive CTC model with no such limit (FLEURS
    // clips up to 30 s decoded whole on the desktop benchmark), so a whole
    // utterance (<= MAX_UTTERANCE_MS) is decoded at once: one language tag per
    // caption line and no cut mid-sentence before translation.
    private static final int SENSEVOICE_SEGMENT_MAX_SAMPLES = SAMPLE_RATE * (MAX_UTTERANCE_MS / 1000);
    private static final int CUT_SEARCH_SAMPLES = SAMPLE_RATE * 2;
    private static final int CUT_WINDOW_SAMPLES = SAMPLE_RATE * 30 / 1000;
    private static final float NORMALIZE_TARGET_PEAK = 0.9f;
    private static final float NORMALIZE_MAX_GAIN = 30f;
    // Voice-prints degrade on very long inputs; embed at most the first 10 s.
    private static final int EMBED_MAX_SAMPLES = SAMPLE_RATE * 10;

    /** Caption model kinds (setAsrModel). */
    public static final String MODEL_MOONSHINE = "moonshine";
    public static final String MODEL_SENSEVOICE = "sensevoice";
    /**
     * SenseVoice decode threads. Captions decode once per utterance, between
     * utterances, so 2 threads cut per-caption latency without keeping four
     * cores busy for a whole conversation. Moonshine keeps its original 1.
     */
    private static final int SENSEVOICE_THREADS = 2;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private final Object queueLock = new Object();
    private final ArrayDeque<byte[]> queue = new ArrayDeque<>();

    private volatile FaceclawCaptionEngineListener listener;
    private volatile String asrModelDir;
    private volatile String asrModelKind = MODEL_MOONSHINE;
    private volatile String speakerModelPath;
    private volatile int silenceMs = DEFAULT_SILENCE_MS;
    private Thread workerThread;
    private volatile boolean started;

    private OfflineRecognizer recognizer;
    private String recognizerKind = MODEL_MOONSHINE;
    private FaceclawSpeakerId speakerId;
    // Detected language of the last recognizeUtterance() (SenseVoice only; ""
    // for Moonshine). Worker thread only.
    private String lastUtteranceLang = "";

    // Segmentation state (worker thread only).
    private long totalSamples;
    private double noiseFloor;
    private boolean inUtterance;
    private long utteranceStartSample;
    private long silenceRunSamples;
    private double utterancePeakRms;
    private short[] utterance = new short[SAMPLE_RATE * (MAX_UTTERANCE_MS / 1000)];
    private int utteranceLength;
    private final short[] preRoll = new short[SAMPLE_RATE * PRE_ROLL_MS / 1000];
    private int preRollLength;

    public void setListener(FaceclawCaptionEngineListener listener) {
        this.listener = listener;
    }

    /** Directory holding the Moonshine model files, or null to disable ASR. */
    public void setAsrModelDir(String dir) {
        setAsrModel(MODEL_MOONSHINE, dir);
    }

    /**
     * The caption model: {@link #MODEL_MOONSHINE} or {@link #MODEL_SENSEVOICE},
     * and the directory holding its files (null disables ASR). Takes effect at
     * the next start().
     */
    public void setAsrModel(String kind, String dir) {
        this.asrModelKind = MODEL_SENSEVOICE.equals(kind) ? MODEL_SENSEVOICE : MODEL_MOONSHINE;
        this.asrModelDir = dir;
    }

    /** Speaker-embedding ONNX model path, or null to disable voice-prints. */
    public void setSpeakerModelPath(String path) {
        this.speakerModelPath = path;
    }

    public void setSilenceMs(int ms) {
        this.silenceMs = Math.max(200, Math.min(3000, ms));
    }

    public void start() {
        synchronized (lock) {
            if (started) {
                return;
            }
            started = true;
            workerThread = new Thread(this::runLoop, "FaceclawCaptionEngine");
            workerThread.start();
        }
    }

    public void stop() {
        Thread threadToJoin;
        synchronized (lock) {
            if (!started) {
                return;
            }
            started = false;
            threadToJoin = workerThread;
            workerThread = null;
        }
        synchronized (queueLock) {
            queueLock.notifyAll();
        }
        if (threadToJoin != null) {
            threadToJoin.interrupt();
            if (Thread.currentThread() != threadToJoin) {
                try {
                    threadToJoin.join(2000);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    /** Push decoded 16 kHz mono S16LE PCM (any chunking). */
    public void acceptPcm(byte[] pcm16le) {
        if (!started || pcm16le == null || pcm16le.length < 2) {
            return;
        }
        synchronized (queueLock) {
            if (queue.size() >= MAX_QUEUE_PACKETS) {
                queue.removeFirst();
            }
            queue.addLast(pcm16le);
            queueLock.notifyAll();
        }
    }

    private void runLoop() {
        try {
            loadModels();
            resetSegmentation();
            while (started && !Thread.currentThread().isInterrupted()) {
                byte[] chunk = takeChunk();
                if (chunk == null) {
                    continue;
                }
                processChunk(chunk);
            }
            // Flush a trailing utterance so its text isn't lost on stop.
            if (inUtterance && utteranceLength > 0) {
                finalizeUtterance();
            }
        } catch (Throwable t) {
            Log.e(TAG, "caption engine failed", t);
            emitStatus("Captions failed: " + t.getMessage());
        } finally {
            releaseModels();
        }
    }

    private void loadModels() {
        String modelDir = asrModelDir;
        String kind = asrModelKind;
        recognizer = null;
        recognizerKind = kind;
        if (modelDir != null && new File(modelDir, "tokens.txt").exists()) {
            boolean senseVoice = MODEL_SENSEVOICE.equals(kind);
            emitStatus(senseVoice ? "Loading caption model (Japanese/Korean/Chinese)..." : "Loading caption model...");
            long rssBeforeKb = readVmRssKb();
            long heapBeforeKb = android.os.Debug.getNativeHeapAllocatedSize() / 1024;
            long startMs = SystemClock.elapsedRealtime();
            OfflineModelConfig.Builder modelConfig = OfflineModelConfig.builder()
                    .setTokens(new File(modelDir, "tokens.txt").getAbsolutePath());
            if (senseVoice) {
                modelConfig
                        .setSenseVoice(OfflineSenseVoiceModelConfig.builder()
                                .setModel(new File(modelDir, "model.int8.onnx").getAbsolutePath())
                                // "auto": the model tags each utterance zh/en/ja/ko/yue.
                                .setLanguage("auto")
                                // Digits and punctuation in the output (better input to
                                // the translator; FLEURS zh CER 4.6% with vs 8.2% without).
                                .setInverseTextNormalization(true)
                                .build())
                        .setNumThreads(SENSEVOICE_THREADS);
            } else {
                modelConfig
                        .setMoonshine(OfflineMoonshineModelConfig.builder()
                                .setEncoder(new File(modelDir, "encoder_model.ort").getAbsolutePath())
                                .setMergedDecoder(new File(modelDir, "decoder_model_merged.ort").getAbsolutePath())
                                .build())
                        .setNumThreads(1);
            }
            recognizer = new OfflineRecognizer(OfflineRecognizerConfig.builder()
                    .setFeatureConfig(FeatureConfig.builder()
                            .setSampleRate(SAMPLE_RATE)
                            .setFeatureDim(FEATURE_DIM)
                            .build())
                    .setModelConfig(modelConfig.build())
                    .build());
            long loadMs = SystemClock.elapsedRealtime() - startMs;
            long rssAfterKb = readVmRssKb();
            long heapAfterKb = android.os.Debug.getNativeHeapAllocatedSize() / 1024;
            Log.i(TAG, "Captions recognizer loaded model=" + kind
                    + " threads=" + (senseVoice ? SENSEVOICE_THREADS : 1)
                    + " loadMs=" + loadMs
                    + " rssMb=" + mb(rssBeforeKb) + "->" + mb(rssAfterKb)
                    + " nativeHeapMb=" + mb(heapBeforeKb) + "->" + mb(heapAfterKb));
            emitModelLoaded(kind, loadMs, rssBeforeKb, rssAfterKb, heapBeforeKb, heapAfterKb);
        }
        String embedModel = speakerModelPath;
        if (embedModel != null && new File(embedModel).exists()) {
            speakerId = new FaceclawSpeakerId(embedModel);
            speakerId.ensureLoaded();
        } else {
            speakerId = null;
        }
        emitStatus(recognizer != null ? "Captions listening..." : "Captions listening (no ASR model)...");
    }

    private void releaseModels() {
        if (recognizer != null) {
            long rssBeforeKb = readVmRssKb();
            recognizer.release();
            recognizer = null;
            Log.i(TAG, "Captions recognizer released model=" + recognizerKind
                    + " rssMb=" + mb(rssBeforeKb) + "->" + mb(readVmRssKb()));
        }
        if (speakerId != null) {
            speakerId.close();
            speakerId = null;
        }
    }

    private byte[] takeChunk() {
        synchronized (queueLock) {
            while (started && queue.isEmpty()) {
                try {
                    queueLock.wait(250);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return null;
                }
            }
            return queue.pollFirst();
        }
    }

    private void resetSegmentation() {
        totalSamples = 0;
        noiseFloor = 0;
        inUtterance = false;
        utteranceLength = 0;
        preRollLength = 0;
        silenceRunSamples = 0;
        utterancePeakRms = 0;
    }

    private void processChunk(byte[] chunk) {
        int count = chunk.length / 2;
        short[] pcm = new short[count];
        double sumSquares = 0;
        for (int i = 0; i < count; i++) {
            short s = (short) ((chunk[i * 2] & 0xff) | (chunk[i * 2 + 1] << 8));
            pcm[i] = s;
            sumSquares += (double) s * s;
        }
        double rms = Math.sqrt(sumSquares / Math.max(1, count));
        totalSamples += count;

        if (!inUtterance) {
            // Track the noise floor only while idle so speech doesn't raise it.
            noiseFloor = noiseFloor == 0 ? rms : noiseFloor * (1 - NOISE_EMA_ALPHA) + rms * NOISE_EMA_ALPHA;
            double threshold = Math.max(noiseFloor, MIN_RMS);
            if (rms >= threshold * ONSET_FACTOR) {
                inUtterance = true;
                utteranceLength = 0;
                silenceRunSamples = 0;
                utterancePeakRms = rms;
                appendUtterance(preRoll, preRollLength);
                utteranceStartSample = Math.max(0, totalSamples - count - preRollLength);
                appendUtterance(pcm, count);
                emitSpeechStart(utteranceStartSample * 1000 / SAMPLE_RATE);
            } else {
                appendPreRoll(pcm, count);
            }
            return;
        }

        appendUtterance(pcm, count);
        utterancePeakRms = Math.max(utterancePeakRms, rms);
        double threshold = Math.max(noiseFloor, MIN_RMS);
        if (rms < threshold * RELEASE_FACTOR) {
            silenceRunSamples += count;
        } else {
            silenceRunSamples = 0;
        }
        long utteranceMs = (long) utteranceLength * 1000 / SAMPLE_RATE;
        boolean silenceEnded = silenceRunSamples * 1000L / SAMPLE_RATE >= silenceMs;
        if (silenceEnded || utteranceMs >= MAX_UTTERANCE_MS) {
            finalizeUtterance();
            inUtterance = false;
            preRollLength = 0;
        }
    }

    private void appendPreRoll(short[] pcm, int count) {
        // Keep the last PRE_ROLL_MS of idle audio so onset consonants survive.
        if (count >= preRoll.length) {
            System.arraycopy(pcm, count - preRoll.length, preRoll, 0, preRoll.length);
            preRollLength = preRoll.length;
            return;
        }
        int keep = Math.min(preRollLength, preRoll.length - count);
        System.arraycopy(preRoll, preRollLength - keep, preRoll, 0, keep);
        System.arraycopy(pcm, 0, preRoll, keep, count);
        preRollLength = keep + count;
    }

    private void appendUtterance(short[] pcm, int count) {
        int room = utterance.length - utteranceLength;
        int copied = Math.min(room, count);
        if (copied > 0) {
            System.arraycopy(pcm, 0, utterance, utteranceLength, copied);
            utteranceLength += copied;
        }
    }

    private void finalizeUtterance() {
        int length = utteranceLength;
        long startMs = utteranceStartSample * 1000 / SAMPLE_RATE;
        long endMs = (utteranceStartSample + length) * 1000 / SAMPLE_RATE;
        if (endMs - startMs < MIN_UTTERANCE_MS) {
            return;
        }
        long decodeStartMs = SystemClock.elapsedRealtime();
        String text = recognizeUtterance(length);
        long decodeMs = SystemClock.elapsedRealtime() - decodeStartMs;
        String lang = lastUtteranceLang;
        if (recognizer != null) {
            Log.i(TAG, "Captions decode model=" + recognizerKind + " audioMs=" + (endMs - startMs)
                    + " decodeMs=" + decodeMs + " lang=" + lang + " chars=" + text.length());
        }
        float[] embedding = embedUtterance(length);
        emitUtterance(text, lang, embedding, startMs, endMs, utterancePeakRms, decodeMs);
    }

    private String recognizeUtterance(int length) {
        lastUtteranceLang = "";
        if (recognizer == null || length <= 0) {
            return "";
        }
        int maxSegment = MODEL_SENSEVOICE.equals(recognizerKind)
                ? SENSEVOICE_SEGMENT_MAX_SAMPLES
                : DECODE_SEGMENT_MAX_SAMPLES;
        StringBuilder joined = new StringBuilder();
        int offset = 0;
        int langSegmentLength = 0;
        while (offset < length) {
            int remaining = length - offset;
            int segment = Math.min(remaining, maxSegment);
            if (remaining > maxSegment) {
                segment = findQuietCut(offset, segment);
            }
            String part = recognizeRange(offset, segment);
            // The longest segment's language tag stands for the utterance.
            if (lastRangeLang.length() > 0 && segment > langSegmentLength) {
                lastUtteranceLang = lastRangeLang;
                langSegmentLength = segment;
            }
            if (part.length() > 0) {
                if (joined.length() > 0 && ".,!?;:%)]}".indexOf(part.charAt(0)) < 0) {
                    joined.append(' ');
                }
                joined.append(part);
            }
            offset += segment;
        }
        return joined.toString().trim();
    }

    /**
     * End a decode segment at the center of the quietest window near its end
     * so the cut lands between words (same approach as the PTT controller).
     */
    private int findQuietCut(int offset, int segment) {
        int searchStart = Math.max(0, segment - CUT_SEARCH_SAMPLES);
        int win = CUT_WINDOW_SAMPLES;
        if (segment - searchStart <= win) {
            return segment;
        }
        double sum = 0;
        for (int i = searchStart; i < searchStart + win; i++) {
            double s = utterance[offset + i];
            sum += s * s;
        }
        double best = sum;
        int bestStart = searchStart;
        for (int start = searchStart + 1; start + win <= segment; start++) {
            double dropped = utterance[offset + start - 1];
            double added = utterance[offset + start + win - 1];
            sum += added * added - dropped * dropped;
            if (sum < best) {
                best = sum;
                bestStart = start;
            }
        }
        return bestStart + win / 2;
    }

    // Language tag of the last recognizeRange() ("" when the model gives none).
    private String lastRangeLang = "";

    /** "<|ja|>" -> "ja"; "" for anything that isn't a short lowercase code. */
    static String normalizeLangTag(String tag) {
        if (tag == null) {
            return "";
        }
        String t = tag.trim();
        if (t.startsWith("<|") && t.endsWith("|>") && t.length() > 4) {
            t = t.substring(2, t.length() - 2);
        }
        t = t.toLowerCase(java.util.Locale.ROOT);
        if (t.length() < 2 || t.length() > 5) {
            return "";
        }
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c < 'a' || c > 'z') {
                return "";
            }
        }
        return t;
    }

    private String recognizeRange(int offset, int count) {
        lastRangeLang = "";
        float[] samples = new float[count];
        float peak = 0f;
        for (int i = 0; i < count; i++) {
            float v = utterance[offset + i] / 32768.0f;
            samples[i] = v;
            float a = Math.abs(v);
            if (a > peak) {
                peak = a;
            }
        }
        if (peak > 0f) {
            float gain = Math.min(NORMALIZE_TARGET_PEAK / peak, NORMALIZE_MAX_GAIN);
            if (gain > 1f) {
                for (int i = 0; i < count; i++) {
                    samples[i] *= gain;
                }
            }
        }
        OfflineStream stream = recognizer.createStream();
        try {
            stream.acceptWaveform(samples, SAMPLE_RATE);
            recognizer.decode(stream);
            OfflineRecognizerResult result = recognizer.getResult(stream);
            String raw = result == null ? "" : result.getText();
            lastRangeLang = result == null ? "" : normalizeLangTag(result.getLang());
            return raw == null ? "" : raw.trim();
        } finally {
            stream.release();
        }
    }

    private float[] embedUtterance(int length) {
        FaceclawSpeakerId currentSpeakerId = speakerId;
        if (currentSpeakerId == null || length <= 0) {
            return null;
        }
        int count = Math.min(length, EMBED_MAX_SAMPLES);
        byte[] le = new byte[count * 2];
        for (int i = 0; i < count; i++) {
            short s = utterance[i];
            le[i * 2] = (byte) (s & 0xff);
            le[i * 2 + 1] = (byte) ((s >> 8) & 0xff);
        }
        return currentSpeakerId.embed(le, SAMPLE_RATE);
    }

    private void emitUtterance(String text, String lang, float[] embedding, long startMs, long endMs,
            double peakRms, long decodeMs) {
        FaceclawCaptionEngineListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        float[] embeddingCopy = embedding == null ? null : Arrays.copyOf(embedding, embedding.length);
        mainHandler.post(() -> currentListener.onUtterance(text, lang, embeddingCopy, startMs, endMs, peakRms, decodeMs));
    }

    private void emitModelLoaded(String model, long loadMs, long rssBeforeKb, long rssAfterKb,
            long heapBeforeKb, long heapAfterKb) {
        FaceclawCaptionEngineListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        String json = "{\"model\":\"" + model + "\",\"loadMs\":" + loadMs
                + ",\"rssMb\":[" + mbJson(rssBeforeKb) + "," + mbJson(rssAfterKb) + "]"
                + ",\"nativeHeapMb\":[" + mbJson(heapBeforeKb) + "," + mbJson(heapAfterKb) + "]}";
        mainHandler.post(() -> currentListener.onModelLoaded(json));
    }

    /** VmRSS of this process from /proc/self/status, in kB, or -1. */
    private static long readVmRssKb() {
        try (java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.FileReader("/proc/self/status"))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("VmRSS:")) {
                    String[] parts = line.substring(6).trim().split("\\s+");
                    return Long.parseLong(parts[0]);
                }
            }
        } catch (Throwable ignored) {
            // Diagnostic only.
        }
        return -1;
    }

    private static String mb(long kb) {
        return kb < 0 ? "?" : String.valueOf(Math.round(kb / 1024.0));
    }

    private static String mbJson(long kb) {
        return kb < 0 ? "null" : String.valueOf(Math.round(kb / 1024.0));
    }

    private void emitSpeechStart(long startMs) {
        FaceclawCaptionEngineListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onSpeechStart(startMs));
    }

    private void emitStatus(String status) {
        FaceclawCaptionEngineListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onStatus(status));
    }
}
