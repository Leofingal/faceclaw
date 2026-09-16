// Copyright 2024 Xiaomi Corporation

package com.k2fsa.sherpa.onnx;

/**
 * Config for sherpa-onnx's offline transducer backend (used here for NVIDIA
 * Parakeet TDT, model type "nemo_transducer").
 *
 * Copied from sherpa-onnx's java-api at the pinned v1.13.0 tag. Field names
 * and types are load-bearing: the JNI glue reads them by name via
 * GetFieldID, not through the getters (sherpa-onnx/jni/offline-recognizer.cc
 * at v1.13.0, lines 78-92, reads encoder, decoder and joiner off the
 * OfflineModelConfig's "transducer" field for every recognizer). This
 * replaces the package-private stub that used to live in
 * OfflineModelConfig.java.
 *
 * Upgrade trap: v1.13.8's JNI also reads a "qnnConfig" field here
 * unconditionally. Bumping the native library without re-copying this class
 * from the new tag would break every on-device recognizer at creation.
 */
public class OfflineTransducerModelConfig {
    private final String encoder;
    private final String decoder;
    private final String joiner;

    private OfflineTransducerModelConfig(Builder builder) {
        this.encoder = builder.encoder;
        this.decoder = builder.decoder;
        this.joiner = builder.joiner;
    }

    public static Builder builder() {
        return new Builder();
    }

    public String getEncoder() {
        return encoder;
    }

    public String getDecoder() {
        return decoder;
    }

    public String getJoiner() {
        return joiner;
    }

    public static class Builder {
        private String encoder = "";
        private String decoder = "";
        private String joiner = "";

        public OfflineTransducerModelConfig build() {
            return new OfflineTransducerModelConfig(this);
        }

        public Builder setEncoder(String encoder) {
            this.encoder = encoder;
            return this;
        }

        public Builder setDecoder(String decoder) {
            this.decoder = decoder;
            return this;
        }

        public Builder setJoiner(String joiner) {
            this.joiner = joiner;
            return this;
        }
    }
}
