package com.faceclaw.app;

/**
 * The on-device (sherpa-onnx offline) transcription models that
 * {@link FaceclawVoiceController} can load, and each model's decode policy:
 * its files, whether it runs live partial decodes, and which gate a segment
 * must pass before it reaches the recognizer.
 *
 * <p>Pure Java with no Android imports, so notes/voice-asr-selftest can pin
 * the policy and the gate off-device. The TS side names the same models in
 * app/native/asr-model-defs.ts (download registry and provider mapping);
 * {@link Model#dirName} and {@link Model#files} must match it.
 */
final class FaceclawOnboardAsr {
    private FaceclawOnboardAsr() {
    }

    static final int SAMPLE_RATE = 16000;

    /**
     * Decode threads for every on-device model. On the desktop benchmark
     * (sherpa-onnx 1.13.0, Whisper base.en, Moonshine Base, both Parakeets),
     * transcripts were byte-identical at 1 and 4 threads on every clip while
     * latency roughly halved (knowledge/staging/faceclaw-asr-benchmark-return.md
     * section 5). Not yet measured on the phone.
     */
    static final int RECOGNIZER_THREADS = 4;

    /** Level statistics use fixed 50 ms windows (the G2 packet cadence). */
    static final int LEVEL_WINDOW_SAMPLES = SAMPLE_RATE / 20;

    /**
     * Whisper's silence gate, unchanged since it was added: below this peak
     * amplitude (pre-normalization, full scale 1.0) a segment never reaches
     * the recognizer, because Whisper writes text into near-silence.
     */
    static final float WHISPER_SILENCE_PEAK_THRESHOLD = 0.01f;

    /**
     * Parakeet's gate: a segment whose loudest 50 ms window (RMS,
     * pre-normalization) is below this never reaches the recognizer.
     *
     * <p>Why a loudness gate and not Whisper's peak gate or a voice detector:
     * peak normalization boosts quiet audio up to 30x, and a transducer then
     * transcribes whatever speech is left in it, including a TV in the next
     * room. On Chris's scripted recordings (2026-09-14, both mics) the TV line
     * peaked at -25.6 dBFS on the hearing aids, which clears Whisper's -40 dBFS
     * peak gate, and a transient on the quiet-room G2 line peaked at -16.1
     * dBFS, louder than the quietest G2 speech peak (-18.1). Silero VAD
     * scored the TV line as 5.4 s of speech, more than any spoken line, so a
     * voice-probability gate would pass it too. The loudest-window level separates them: every
     * segment carrying Chris's words measured -27.8 dBFS or louder (G2 pass
     * minimum), the TV -36.0 dBFS or quieter. -33 sits between, 5 dB under
     * the quietest speech. Replaying both passes through this gate on the
     * desktop left both TV lines empty and gated no speech segment.
     *
     * <p>Measured on 62 captures in one quiet office, with the Microphones
     * app's noise cancellation as Chris normally runs it. Unmeasured: the
     * phone's own mic, soft speech, a louder TV. The capture receipt records
     * each segment's levelDbfs, so the threshold can be re-cut from real use.
     */
    static final float PARAKEET_MIN_LEVEL_DBFS = -33f;
    static final float PARAKEET_MIN_LEVEL = (float) Math.pow(10.0, PARAKEET_MIN_LEVEL_DBFS / 20.0);

    enum Gate {
        /** Every segment is decoded (Moonshine, as before). */
        NONE,
        /** Pre-normalization peak below {@link #WHISPER_SILENCE_PEAK_THRESHOLD}. */
        PEAK,
        /** Loudest 50 ms window below {@link #PARAKEET_MIN_LEVEL_DBFS}. */
        LEVEL
    }

    enum Model {
        MOONSHINE("moonshine", "Moonshine",
                "sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
                new String[] {"encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"},
                true, Gate.NONE),
        /**
         * sherpa-onnx's offline Whisper backend, base.en int8. No live
         * partials: each Whisper call pays a large fixed encoder cost, so it
         * decodes only when a segment commits and at the end of the utterance.
         */
        WHISPER("whisper", "Whisper",
                "sherpa-onnx-whisper-base-en-int8",
                new String[] {"base.en-encoder.int8.onnx", "base.en-decoder.int8.onnx", "base.en-tokens.txt"},
                false, Gate.PEAK),
        /**
         * NVIDIA Parakeet TDT 0.6B v2, int8, as a nemo_transducer. No live
         * partials, and so no partial fallback: on this pipeline's Moonshine
         * path, an 8 s commit that decoded empty fell back to a partial of the
         * whole buffer and repeated words ("Schedule a walk for tomorrow.
         * Schedule a walk for tomorrow...") and wrote "Uh"/"Okay." into
         * silence, taking pass A from 1.9% to 4.2% WER
         * (knowledge/staging/faceclaw-asr-real-recordings-score-return.md).
         * Every decode also runs inline on the capture thread, so skipping
         * partials keeps a 0.6B re-decode of a growing buffer from delaying
         * mic reads every 700 ms.
         */
        PARAKEET_V2("parakeet-v2", "Parakeet-v2",
                "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
                new String[] {"encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"},
                false, Gate.LEVEL),
        /** NVIDIA Parakeet TDT_CTC 110M (transducer head), int8. Same policy as v2. */
        PARAKEET_110M("parakeet-110m", "Parakeet-110M",
                "sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8",
                new String[] {"encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"},
                false, Gate.LEVEL);

        /** The value the TS bridge passes to setOnboardModelKind(), and the receipt's "model". */
        final String id;
        /** Label in logcat decode lines ("Whisper decode final=..."). */
        final String logLabel;
        /** Directory under filesDir/faceclaw-voice-asr/, shared with asr-model-defs.ts. */
        final String dirName;
        final String[] files;
        /**
         * Re-decode the growing buffer every 700 ms for live preview text. Only
         * a model that does this may fall back to its last partial when a
         * segment decodes empty.
         */
        final boolean livePartials;
        final Gate gate;

        Model(String id, String logLabel, String dirName, String[] files, boolean livePartials, Gate gate) {
            this.id = id;
            this.logLabel = logLabel;
            this.dirName = dirName;
            this.files = files;
            this.livePartials = livePartials;
            this.gate = gate;
        }

        boolean isTransducer() {
            return this == PARAKEET_V2 || this == PARAKEET_110M;
        }

        /** The model for a setOnboardModelKind() value; anything unknown (or null) is Moonshine, as before. */
        static Model fromId(String id) {
            for (Model model : values()) {
                if (model.id.equals(id)) {
                    return model;
                }
            }
            return MOONSHINE;
        }
    }

    /** One segment's pre-normalization measurements, and whether it may reach the recognizer. */
    static final class GateResult {
        /** Peak absolute sample, full scale 1.0. */
        final float peak;
        /** RMS of the loudest 50 ms window, full scale 1.0. */
        final float level;
        final boolean pass;

        GateResult(float peak, float level, boolean pass) {
            this.peak = peak;
            this.level = level;
            this.pass = pass;
        }
    }

    /** Measure the first {@code count} samples and apply {@code model}'s gate. */
    static GateResult gate(Model model, float[] samples, int count) {
        float peak = peakAmplitude(samples, count);
        float level = loudestWindowRms(samples, count);
        boolean pass;
        switch (model.gate) {
            case PEAK:
                pass = !(peak < WHISPER_SILENCE_PEAK_THRESHOLD);
                break;
            case LEVEL:
                pass = !(level < PARAKEET_MIN_LEVEL);
                break;
            default:
                pass = true;
        }
        return new GateResult(peak, level, pass);
    }

    static float peakAmplitude(float[] samples, int count) {
        int n = Math.min(count, samples.length);
        float peak = 0f;
        for (int i = 0; i < n; i++) {
            float a = Math.abs(samples[i]);
            if (a > peak) {
                peak = a;
            }
        }
        return peak;
    }

    /**
     * RMS of the loudest of the consecutive 50 ms windows, starting at sample
     * 0; a trailing part-window is ignored unless the segment is shorter than
     * one window, in which case the whole segment is the window.
     */
    static float loudestWindowRms(float[] samples, int count) {
        int n = Math.min(count, samples.length);
        if (n <= 0) {
            return 0f;
        }
        int window = LEVEL_WINDOW_SAMPLES;
        if (n < window) {
            double sum = 0;
            for (int i = 0; i < n; i++) {
                sum += (double) samples[i] * samples[i];
            }
            return (float) Math.sqrt(sum / n);
        }
        double best = 0;
        for (int start = 0; start + window <= n; start += window) {
            double sum = 0;
            for (int i = start; i < start + window; i++) {
                sum += (double) samples[i] * samples[i];
            }
            if (sum > best) {
                best = sum;
            }
        }
        return (float) Math.sqrt(best / window);
    }
}
