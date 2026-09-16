package com.faceclaw.app;

import java.util.Arrays;

/**
 * One capture's on-device transcript: buffers the decoded mic samples, cuts
 * them into model-safe segments, gates and normalizes each segment, and joins
 * the recognized text into the utterance transcript (REPLACE semantics: every
 * emitted text is the complete utterance so far, never a delta).
 *
 * <p>Moved out of {@link FaceclawVoiceController} unchanged except for the
 * per-model policy in {@link FaceclawOnboardAsr.Model}, so the capture
 * pipeline can run off-device in notes/voice-asr-selftest with a fake
 * recognizer. Pure Java; the controller supplies the recognizer, the receipt
 * and the clock through {@link Host}.
 *
 * <p>Not thread-safe: the capture worker thread owns it.
 */
final class FaceclawTranscriptSegmenter {
    /** What the segmenter needs from its owner. */
    interface Host {
        /** False when no recognizer is loaded; decoding is then skipped. */
        boolean hasRecognizer();

        /**
         * Recognize one segment that passed the gate. {@code normalized} is a
         * peak-normalized copy; {@code gate} holds its pre-normalization levels.
         *
         * @param kind "partial" (live preview), "commit" (a full 8 s segment) or "final"
         * @return the trimmed text, or "" for no words
         */
        String recognize(float[] normalized, String kind, FaceclawOnboardAsr.GateResult gate);

        /** A segment the gate kept away from the recognizer. */
        void gated(String kind, int sampleCount, FaceclawOnboardAsr.GateResult gate);

        /** The utterance transcript so far, after a decode or commit. */
        void transcript(String text, boolean isFinal, int segmentSampleCount, double totalAudioSec);

        /** Monotonic milliseconds (SystemClock.elapsedRealtime on the phone). */
        long elapsedMs();
    }

    static final int SAMPLE_RATE = FaceclawOnboardAsr.SAMPLE_RATE;
    // Push-to-talk utterance boundaries come from the button. A model with live
    // partials re-decodes the current audio segment in full on this interval and
    // emits the complete utterance text. The sherpa Moonshine v2 decoder fails
    // once a single input grows past roughly 9.1 seconds, so longer utterances
    // are committed in model-safe segments (kept for every model).
    static final int DECODE_INTERVAL_MS = 700;
    static final int MIN_SAMPLES = SAMPLE_RATE / 3;
    static final int SEGMENT_MAX_SAMPLES = SAMPLE_RATE * 8;
    // When a segment fills, cut at the quietest window within the last
    // CUT_SEARCH_SAMPLES rather than mid-word at the 8s mark; the audio after
    // the cut carries over into the next segment.
    static final int CUT_SEARCH_SAMPLES = SAMPLE_RATE * 2;
    static final int CUT_WINDOW_SAMPLES = SAMPLE_RATE * 30 / 1000;
    // Glasses-mic PCM peaks around 0.1 full scale, and at that level the
    // quantized Moonshine model often returns empty or garbled text. Boost
    // each decode window toward this peak, with a gain cap so near-silent
    // buffers aren't amplified into pure noise.
    static final float NORMALIZE_TARGET_PEAK = 0.9f;
    static final float NORMALIZE_MAX_GAIN = 30f;

    private final Host host;
    private final float[] samples = new float[SEGMENT_MAX_SAMPLES];
    private FaceclawOnboardAsr.Model model = FaceclawOnboardAsr.Model.MOONSHINE;
    private int sampleCount;
    private long committedSampleCount;
    private String committedTranscript = "";
    private String currentSegmentTranscript = "";
    private long lastDecodeAtMs;
    private String lastTranscript = "";

    FaceclawTranscriptSegmenter(Host host) {
        this.host = host;
    }

    /** Start a new utterance, decoded with {@code model}'s policy. */
    void reset(FaceclawOnboardAsr.Model model) {
        this.model = model == null ? FaceclawOnboardAsr.Model.MOONSHINE : model;
        sampleCount = 0;
        committedSampleCount = 0;
        committedTranscript = "";
        currentSegmentTranscript = "";
        lastDecodeAtMs = 0;
        lastTranscript = "";
    }

    FaceclawOnboardAsr.Model model() {
        return model;
    }

    /** The last transcript emitted for this utterance ("" before any). */
    String lastTranscript() {
        return lastTranscript;
    }

    /** Audio seconds accepted so far (committed segments plus the buffer). */
    double totalAudioSec() {
        return (committedSampleCount + sampleCount) / (double) SAMPLE_RATE;
    }

    /** One chunk of mic audio, full scale 1.0. */
    void accept(float[] chunk) {
        appendSamples(chunk);
        // Models without live partials (Whisper, Parakeet) decode only when a
        // segment commits (8 s buffer fill) or the utterance ends (finish()).
        // No live preview text while speaking in those modes: status stays
        // "Listening..." until release.
        if (!model.livePartials) {
            return;
        }
        long now = host.elapsedMs();
        if (sampleCount >= MIN_SAMPLES && now - lastDecodeAtMs >= DECODE_INTERVAL_MS) {
            decode(false);
            lastDecodeAtMs = now;
        }
    }

    /** Button released / stop requested: emit one final full-utterance transcript. */
    void finish() {
        decode(true);
    }

    private void appendSamples(float[] chunk) {
        int sourceOffset = 0;
        while (sourceOffset < chunk.length) {
            int available = SEGMENT_MAX_SAMPLES - sampleCount;
            int count = Math.min(available, chunk.length - sourceOffset);
            System.arraycopy(chunk, sourceOffset, samples, sampleCount, count);
            sampleCount += count;
            sourceOffset += count;

            if (sampleCount == SEGMENT_MAX_SAMPLES) {
                commitSegment();
            }
        }
    }

    /**
     * Decode the current model-safe segment and emit the best transcript of the
     * complete utterance (REPLACE semantics; the caller displays it as-is).
     */
    private void decode(boolean isFinal) {
        if (!host.hasRecognizer() || sampleCount <= 0) {
            if (isFinal) {
                host.transcript(lastTranscript, true, 0, totalAudioSec());
            }
            return;
        }
        int segmentSampleCount = sampleCount;
        String segmentText = recognizeSegment(segmentSampleCount, isFinal ? "final" : "partial");
        if (segmentText.length() > 0) {
            currentSegmentTranscript = segmentText;
        } else if (model.livePartials) {
            // Moonshine only: keep showing the last partial of this segment.
            segmentText = currentSegmentTranscript;
        }
        String text = joinTranscript(committedTranscript, segmentText);
        lastTranscript = text;
        host.transcript(text, isFinal, segmentSampleCount, totalAudioSec());
    }

    /**
     * Finalize a full segment before accepting more audio. This keeps every
     * Moonshine invocation below its failing sequence length while retaining
     * all earlier text in the replace-semantics preview.
     */
    private void commitSegment() {
        int cut = findCutPoint();
        String segmentText = recognizeSegment(cut, "commit");
        if (segmentText.length() == 0 && model.livePartials) {
            // Moonshine only. The fallback text came from partial decodes of the
            // full buffer, so it may include words from the carried-over tail.
            // That repeats words once the tail is decoded again, which is why no
            // other model takes this path (FaceclawOnboardAsr.Model.PARAKEET_V2).
            segmentText = currentSegmentTranscript;
        }
        committedTranscript = joinTranscript(committedTranscript, segmentText);
        currentSegmentTranscript = "";
        committedSampleCount += cut;
        int tail = sampleCount - cut;
        System.arraycopy(samples, cut, samples, 0, tail);
        sampleCount = tail;
        lastTranscript = committedTranscript;
        lastDecodeAtMs = host.elapsedMs();
        host.transcript(committedTranscript, false, cut, totalAudioSec());
    }

    /**
     * Pick where to end the committed segment: the center of the quietest
     * window within the search region at the end of the buffer, so the cut
     * lands between words instead of splitting one.
     */
    private int findCutPoint() {
        int count = sampleCount;
        int searchStart = Math.max(0, count - CUT_SEARCH_SAMPLES);
        int win = CUT_WINDOW_SAMPLES;
        if (count - searchStart <= win) {
            return count;
        }
        double sum = 0;
        for (int i = searchStart; i < searchStart + win; i++) {
            sum += (double) samples[i] * samples[i];
        }
        double best = sum;
        int bestStart = searchStart;
        for (int start = searchStart + 1; start + win <= count; start++) {
            float dropped = samples[start - 1];
            float added = samples[start + win - 1];
            sum += (double) added * added - (double) dropped * dropped;
            if (sum < best) {
                best = sum;
                bestStart = start;
            }
        }
        return bestStart + win / 2;
    }

    /** Gate, normalize and recognize the first {@code count} buffered samples. */
    private String recognizeSegment(int count, String kind) {
        if (!host.hasRecognizer() || count <= 0) {
            return "";
        }
        float[] segment = Arrays.copyOf(samples, count);
        // Gate on the PRE-normalization levels: normalizePeak() would otherwise
        // lift quiet audio right up to the target and hide what is being checked.
        FaceclawOnboardAsr.GateResult gate = FaceclawOnboardAsr.gate(model, segment, count);
        if (!gate.pass) {
            host.gated(kind, count, gate);
            return "";
        }
        normalizePeak(segment);
        String text = host.recognize(segment, kind, gate);
        return text == null ? "" : text;
    }

    static void normalizePeak(float[] samples) {
        float peak = FaceclawOnboardAsr.peakAmplitude(samples, samples.length);
        if (peak <= 0f) {
            return;
        }
        float gain = Math.min(NORMALIZE_TARGET_PEAK / peak, NORMALIZE_MAX_GAIN);
        if (gain <= 1f) {
            return;
        }
        for (int i = 0; i < samples.length; i++) {
            samples[i] *= gain;
        }
    }

    static String joinTranscript(String prefix, String suffix) {
        if (prefix == null || prefix.length() == 0) {
            return suffix == null ? "" : suffix;
        }
        if (suffix == null || suffix.length() == 0) {
            return prefix;
        }
        char first = suffix.charAt(0);
        boolean attachesToPrevious = ".,!?;:%)]}".indexOf(first) >= 0;
        return prefix + (attachesToPrevious ? "" : " ") + suffix;
    }
}
