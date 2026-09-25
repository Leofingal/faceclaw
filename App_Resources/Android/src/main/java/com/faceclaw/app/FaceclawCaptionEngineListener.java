package com.faceclaw.app;

public interface FaceclawCaptionEngineListener {
    /**
     * One finished utterance. text may be empty when no ASR model is loaded
     * or recognition produced nothing; lang is the caption model's detected
     * language ("ja", "ko", "zh", "en", "yue") or "" when the model gives none
     * (Moonshine); embedding is the L2-normalized voice-print or null when
     * the speaker model is unavailable or the utterance was too short.
     * startMs/endMs are on the engine's sample clock (milliseconds of audio
     * since start()); decodeMs is the recognizer's wall time for the line.
     */
    void onUtterance(String text, String lang, float[] embedding, long startMs, long endMs, double peakRms, long decodeMs);

    /** A speech onset was detected; the utterance is now being collected. */
    void onSpeechStart(long startMs);

    void onStatus(String status);

    /**
     * The caption recognizer finished loading: a JSON object with model,
     * loadMs, rssMb [before, after] and nativeHeapMb [before, after].
     */
    void onModelLoaded(String infoJson);
}
