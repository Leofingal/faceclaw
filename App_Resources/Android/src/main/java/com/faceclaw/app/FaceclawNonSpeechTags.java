package com.faceclaw.app;

import java.util.regex.Pattern;

/**
 * Whisper writes non-speech as bracketed or parenthesized tags:
 * {@code [BLANK_AUDIO]}, {@code [ Silence ]}, {@code (wind blowing)}. They are
 * not words, and must never be injected into a session as if the wearer had
 * said them.
 *
 * <p>Deliberately whole-segment: a segment is dropped only when its entire
 * text is one or more tags (plus stray whitespace or punctuation). A bracket
 * or parenthesis inside real speech survives. The Ghost box's
 * {@code apps/claude-code-web/src/utils/stt.js} is broader: it strips every
 * {@code [...]} anywhere in the text, and does not look at {@code (...)}.
 *
 * <p>Pure Java, so notes/voice-capture-selftest covers it off-device.
 */
public final class FaceclawNonSpeechTags {
    /** One tag: [...] or (...) with no nesting inside. */
    private static final Pattern TAG = Pattern.compile("\\[[^\\[\\]]*\\]|\\([^()]*\\)");
    /** What may remain once the tags are gone, for the segment to still count as non-speech. */
    private static final Pattern LEFTOVER = Pattern.compile("[\\s.,!?;:\\-]*");

    private FaceclawNonSpeechTags() {
    }

    /** True when {@code text} is nothing but non-speech tags. Empty or null text is not a tag. */
    public static boolean isNonSpeechOnly(String text) {
        if (text == null) {
            return false;
        }
        String trimmed = text.trim();
        if (trimmed.isEmpty() || !TAG.matcher(trimmed).find()) {
            return false;
        }
        return LEFTOVER.matcher(TAG.matcher(trimmed).replaceAll("")).matches();
    }
}
