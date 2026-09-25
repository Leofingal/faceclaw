package com.k2fsa.sherpa.onnx;

/**
 * Config for sherpa-onnx's offline SenseVoice backend (one CTC model for
 * Mandarin, Cantonese, English, Japanese and Korean, with a language tag on
 * every result).
 *
 * Copied from sherpa-onnx v1.13.0's java-api
 * (sherpa-onnx/java-api/src/main/java/com/k2fsa/sherpa/onnx/OfflineSenseVoiceModelConfig.java),
 * with QnnConfig built by its no-arg constructor (this package's QnnConfig has
 * no builder). Field names and types are load-bearing: the v1.13.0 JNI
 * (sherpa-onnx/jni/offline-recognizer.cc lines 182-212) reads model,
 * language, useInverseTextNormalization and qnnConfig by name via GetFieldID.
 */
public class OfflineSenseVoiceModelConfig {
    private final String model;
    private final String language;
    private final boolean useInverseTextNormalization;
    private final QnnConfig qnnConfig;

    private OfflineSenseVoiceModelConfig(Builder builder) {
        this.model = builder.model;
        this.language = builder.language;
        this.useInverseTextNormalization = builder.useInverseTextNormalization;
        this.qnnConfig = builder.qnnConfig;
    }

    public static Builder builder() {
        return new Builder();
    }

    public String getModel() {
        return model;
    }

    public String getLanguage() {
        return language;
    }

    public boolean getUseInverseTextNormalization() {
        return useInverseTextNormalization;
    }

    public QnnConfig getQnnConfig() {
        return qnnConfig;
    }

    public static class Builder {
        private String model = "";
        private String language = "";
        private boolean useInverseTextNormalization = true;
        private QnnConfig qnnConfig = new QnnConfig();

        public OfflineSenseVoiceModelConfig build() {
            return new OfflineSenseVoiceModelConfig(this);
        }

        public Builder setModel(String model) {
            this.model = model;
            return this;
        }

        /** "" or "auto" detects the language; "zh", "en", "ja", "ko", "yue" force one. */
        public Builder setLanguage(String language) {
            this.language = language;
            return this;
        }

        public Builder setInverseTextNormalization(boolean useInverseTextNormalization) {
            this.useInverseTextNormalization = useInverseTextNormalization;
            return this;
        }
    }
}
