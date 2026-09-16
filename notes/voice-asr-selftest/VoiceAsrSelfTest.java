package com.faceclaw.app;

import java.util.ArrayList;
import java.util.List;

/**
 * Standalone self-test for the on-device transcription policy
 * ({@link FaceclawOnboardAsr}), the capture segmenter
 * ({@link FaceclawTranscriptSegmenter}) and the recognizer fields of
 * {@link FaceclawVoiceCaptureReceipt}. No Android APIs, no model files: the
 * recognizer is a fake that answers by segment kind.
 *
 * <pre>
 *   J=App_Resources/Android/src/main/java/com/faceclaw/app
 *   javac -d /tmp/vat $J/FaceclawOnboardAsr.java $J/FaceclawTranscriptSegmenter.java \
 *                     $J/FaceclawVoiceCaptureReceipt.java $J/FaceclawNonSpeechTags.java \
 *                     notes/voice-asr-selftest/VoiceAsrSelfTest.java
 *   java -cp /tmp/vat com.faceclaw.app.VoiceAsrSelfTest
 * </pre>
 *
 * <p>The two Parakeet traps from the real-recordings scoring
 * (knowledge/staging/faceclaw-asr-real-recordings-score-return.md) are
 * pinned here: an 8 s commit that decodes empty must not borrow a partial of
 * the whole buffer (repeated words), and a segment below the level gate must
 * never reach the recognizer (a TV in the next room).
 */
public final class VoiceAsrSelfTest {
    private static int checks;
    private static int failures;

    private static final FaceclawOnboardAsr.Model MOONSHINE = FaceclawOnboardAsr.Model.MOONSHINE;
    private static final FaceclawOnboardAsr.Model WHISPER = FaceclawOnboardAsr.Model.WHISPER;
    private static final FaceclawOnboardAsr.Model V2 = FaceclawOnboardAsr.Model.PARAKEET_V2;
    private static final FaceclawOnboardAsr.Model M110 = FaceclawOnboardAsr.Model.PARAKEET_110M;

    public static void main(String[] args) {
        testModelIds();
        testPolicy();
        testLevelMath();
        testGates();
        testNoPartialFallbackForParakeet();
        testMoonshineFallbackUnchanged();
        testSilenceStaysEmpty();
        testTvLevelSegmentsNeverDecoded();
        testQuietTailGatedSpeechKept();
        testNormalizedSegmentAndGateLevels();
        testReceiptRecognizerFields();

        System.out.println();
        System.out.println(failures == 0
            ? "PASS: all " + checks + " checks"
            : "FAIL: " + failures + " of " + checks + " checks");
        if (failures != 0) {
            System.exit(1);
        }
    }

    // ---- fixtures ----------------------------------------------------------

    /** A fake recognizer and listener that records every call. */
    private static final class FakeHost implements FaceclawTranscriptSegmenter.Host {
        String partialText = "";
        String commitText = "";
        String finalText = "";
        long nowMs;
        final List<String> recognizedKinds = new ArrayList<>();
        final List<String> gatedKinds = new ArrayList<>();
        final List<FaceclawOnboardAsr.GateResult> recognizedGates = new ArrayList<>();
        final List<Float> recognizedPeaks = new ArrayList<>();
        final List<String> emitted = new ArrayList<>();
        String lastFinal;

        @Override
        public boolean hasRecognizer() {
            return true;
        }

        @Override
        public String recognize(float[] normalized, String kind, FaceclawOnboardAsr.GateResult gate) {
            recognizedKinds.add(kind);
            recognizedGates.add(gate);
            recognizedPeaks.add(FaceclawOnboardAsr.peakAmplitude(normalized, normalized.length));
            if ("partial".equals(kind)) {
                return partialText;
            }
            return "commit".equals(kind) ? commitText : finalText;
        }

        @Override
        public void gated(String kind, int sampleCount, FaceclawOnboardAsr.GateResult gate) {
            gatedKinds.add(kind);
        }

        @Override
        public void transcript(String text, boolean isFinal, int segmentSampleCount, double totalAudioSec) {
            emitted.add(text);
            if (isFinal) {
                lastFinal = text;
            }
        }

        @Override
        public long elapsedMs() {
            return nowMs;
        }
    }

    /** Feed {@code seconds} of a +/-amplitude square wave in 50 ms chunks, advancing the fake clock. */
    private static void feed(FaceclawTranscriptSegmenter seg, FakeHost host, double seconds, float amplitude) {
        int total = (int) Math.round(seconds * 16000);
        int fed = 0;
        while (fed < total) {
            int n = Math.min(800, total - fed);
            float[] chunk = new float[n];
            for (int i = 0; i < n; i++) {
                chunk[i] = ((fed + i) % 2 == 0) ? amplitude : -amplitude;
            }
            host.nowMs += 50;
            seg.accept(chunk);
            fed += n;
        }
    }

    private static float dbfsToAmplitude(double dbfs) {
        return (float) Math.pow(10.0, dbfs / 20.0);
    }

    private static int occurrences(String haystack, String needle) {
        int count = 0;
        for (int at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
            count++;
        }
        return count;
    }

    // ---- policy ------------------------------------------------------------

    private static void testModelIds() {
        section("model ids from the TS bridge");
        check("whisper", FaceclawOnboardAsr.Model.fromId("whisper") == WHISPER);
        check("parakeet-v2", FaceclawOnboardAsr.Model.fromId("parakeet-v2") == V2);
        check("parakeet-110m", FaceclawOnboardAsr.Model.fromId("parakeet-110m") == M110);
        check("moonshine", FaceclawOnboardAsr.Model.fromId("moonshine") == MOONSHINE);
        check("null keeps Moonshine", FaceclawOnboardAsr.Model.fromId(null) == MOONSHINE);
        check("unknown keeps Moonshine", FaceclawOnboardAsr.Model.fromId("parakeet") == MOONSHINE);
        check("receipt ids unchanged for the old two", "moonshine".equals(MOONSHINE.id) && "whisper".equals(WHISPER.id));
    }

    private static void testPolicy() {
        section("per-model policy");
        check("4 decode threads", FaceclawOnboardAsr.RECOGNIZER_THREADS == 4);
        check("only Moonshine runs live partials",
            MOONSHINE.livePartials && !WHISPER.livePartials && !V2.livePartials && !M110.livePartials);
        check("gates: Moonshine none, Whisper peak, Parakeet level",
            MOONSHINE.gate == FaceclawOnboardAsr.Gate.NONE
                && WHISPER.gate == FaceclawOnboardAsr.Gate.PEAK
                && V2.gate == FaceclawOnboardAsr.Gate.LEVEL
                && M110.gate == FaceclawOnboardAsr.Gate.LEVEL);
        check("transducers are the two Parakeets",
            V2.isTransducer() && M110.isTransducer() && !WHISPER.isTransducer() && !MOONSHINE.isTransducer());
        String[] transducerFiles = {"encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"};
        check("v2 files", java.util.Arrays.equals(V2.files, transducerFiles));
        check("110M files", java.util.Arrays.equals(M110.files, transducerFiles));
        check("v2 dir", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8".equals(V2.dirName));
        check("110M dir", "sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8".equals(M110.dirName));
        check("Whisper dir unchanged", "sherpa-onnx-whisper-base-en-int8".equals(WHISPER.dirName));
        check("Moonshine dir unchanged", "sherpa-onnx-moonshine-base-en-quantized-2026-02-27".equals(MOONSHINE.dirName));
        check("level threshold is -33 dBFS (got " + FaceclawOnboardAsr.PARAKEET_MIN_LEVEL + ")",
            Math.abs(FaceclawOnboardAsr.PARAKEET_MIN_LEVEL - 0.022387f) < 1e-5f);
    }

    private static void testLevelMath() {
        section("peak and loudest-window level");
        float[] square = new float[16000];
        for (int i = 0; i < square.length; i++) {
            square[i] = (i % 2 == 0) ? 0.1f : -0.1f;
        }
        check("square wave peak", Math.abs(FaceclawOnboardAsr.peakAmplitude(square, square.length) - 0.1f) < 1e-6f);
        check("square wave level", Math.abs(FaceclawOnboardAsr.loudestWindowRms(square, square.length) - 0.1f) < 1e-6f);

        float[] burst = new float[16000];
        for (int i = 8000; i < 8800; i++) {
            burst[i] = (i % 2 == 0) ? 0.2f : -0.2f;
        }
        check("level is the loudest window, not the average",
            Math.abs(FaceclawOnboardAsr.loudestWindowRms(burst, burst.length) - 0.2f) < 1e-6f);

        float[] click = new float[16000];
        click[4000] = 0.5f;
        float clickLevel = FaceclawOnboardAsr.loudestWindowRms(click, click.length);
        check("a one-sample click has a high peak but a low level (" + clickLevel + ")",
            FaceclawOnboardAsr.peakAmplitude(click, click.length) == 0.5f && clickLevel < 0.02f);

        float[] tail = new float[850];
        for (int i = 800; i < 850; i++) {
            tail[i] = 0.5f;
        }
        check("a trailing part-window is ignored", FaceclawOnboardAsr.loudestWindowRms(tail, tail.length) == 0f);

        float[] shortSeg = {0.3f, -0.3f, 0.3f, -0.3f};
        check("a segment shorter than a window is one window",
            Math.abs(FaceclawOnboardAsr.loudestWindowRms(shortSeg, shortSeg.length) - 0.3f) < 1e-6f);
        check("count limits the measurement", FaceclawOnboardAsr.loudestWindowRms(burst, 8000) == 0f);
        check("empty is zero", FaceclawOnboardAsr.loudestWindowRms(new float[0], 0) == 0f);
    }

    private static float[] squareAt(double dbfs, int samples) {
        float a = dbfsToAmplitude(dbfs);
        float[] out = new float[samples];
        for (int i = 0; i < samples; i++) {
            out[i] = (i % 2 == 0) ? a : -a;
        }
        return out;
    }

    private static void testGates() {
        section("gates");
        float[] speech = squareAt(-27.8, 16000);   // quietest G2 speech segment measured
        float[] tv = squareAt(-36.0, 16000);       // loudest TV segment measured
        float[] above = squareAt(-32.9, 16000);
        float[] below = squareAt(-33.1, 16000);
        check("Parakeet passes the quietest measured speech", FaceclawOnboardAsr.gate(V2, speech, speech.length).pass);
        check("Parakeet drops the TV level", !FaceclawOnboardAsr.gate(V2, tv, tv.length).pass);
        check("110M drops the TV level", !FaceclawOnboardAsr.gate(M110, tv, tv.length).pass);
        check("-32.9 dBFS passes", FaceclawOnboardAsr.gate(V2, above, above.length).pass);
        check("-33.1 dBFS is dropped", !FaceclawOnboardAsr.gate(V2, below, below.length).pass);
        check("Whisper's peak gate passes the TV level (why Parakeet does not reuse it)",
            FaceclawOnboardAsr.gate(WHISPER, tv, tv.length).pass);

        float[] click = new float[16000];
        click[100] = 0.5f;
        check("Whisper passes a lone click", FaceclawOnboardAsr.gate(WHISPER, click, click.length).pass);
        check("Parakeet drops a lone click", !FaceclawOnboardAsr.gate(V2, click, click.length).pass);

        float[] quiet = squareAt(-40.9, 16000);   // peak 0.009
        float[] justLoud = squareAt(-39.2, 16000); // peak 0.011
        check("Whisper gate unchanged: peak 0.009 dropped", !FaceclawOnboardAsr.gate(WHISPER, quiet, quiet.length).pass);
        check("Whisper gate unchanged: peak 0.011 passes", FaceclawOnboardAsr.gate(WHISPER, justLoud, justLoud.length).pass);
        check("Moonshine is never gated", FaceclawOnboardAsr.gate(MOONSHINE, new float[800], 800).pass);

        FaceclawOnboardAsr.GateResult r = FaceclawOnboardAsr.gate(V2, tv, tv.length);
        check("gate result carries the pre-normalization levels",
            Math.abs(r.peak - dbfsToAmplitude(-36.0)) < 1e-6f && Math.abs(r.level - dbfsToAmplitude(-36.0)) < 1e-6f);
    }

    // ---- trap 1: no whole-buffer partial fallback ---------------------------

    private static void testNoPartialFallbackForParakeet() {
        section("trap 1: an empty commit does not borrow a partial (Parakeet, Whisper)");
        for (FaceclawOnboardAsr.Model model : new FaceclawOnboardAsr.Model[] {V2, M110, WHISPER}) {
            FakeHost host = new FakeHost();
            // What the scoring lobe saw: partials of the full 8 s buffer read the
            // words that also fall after the cut; the cut segment decoded empty.
            host.partialText = "Schedule a walk for tomorrow.";
            host.commitText = "";
            host.finalText = "Schedule a walk for tomorrow, sometime after the rain stops.";
            FaceclawTranscriptSegmenter seg = new FaceclawTranscriptSegmenter(host);
            seg.reset(model);
            feed(seg, host, 11.0, 0.1f);
            seg.finish();
            check(model.id + ": no partial decodes", !host.recognizedKinds.contains("partial"));
            check(model.id + ": one commit and one final decoded (got " + host.recognizedKinds + ")",
                host.recognizedKinds.size() == 2
                    && "commit".equals(host.recognizedKinds.get(0))
                    && "final".equals(host.recognizedKinds.get(1)));
            check(model.id + ": final transcript has the words once (got \"" + host.lastFinal + "\")",
                "Schedule a walk for tomorrow, sometime after the rain stops.".equals(host.lastFinal));
            check(model.id + ": lastTranscript matches the final", host.lastFinal.equals(seg.lastTranscript()));
        }
    }

    private static void testMoonshineFallbackUnchanged() {
        section("Moonshine keeps its partials and its fallback");
        FakeHost host = new FakeHost();
        host.partialText = "Schedule a walk for tomorrow.";
        host.commitText = "";
        host.finalText = "Schedule a walk for tomorrow, sometime after the rain stops.";
        FaceclawTranscriptSegmenter seg = new FaceclawTranscriptSegmenter(host);
        seg.reset(MOONSHINE);
        feed(seg, host, 11.0, 0.1f);
        seg.finish();
        int partials = 0;
        for (String kind : host.recognizedKinds) {
            if ("partial".equals(kind)) {
                partials++;
            }
        }
        // 11 s at one partial per 700 ms of clock after the first 1/3 s.
        check("partials ran on the 700 ms clock (got " + partials + ")", partials >= 14 && partials <= 16);
        check("the commit fell back to the partial, as before (the duplication Parakeet avoids)",
            occurrences(host.lastFinal, "Schedule a walk for tomorrow") == 2);
    }

    private static void testSilenceStaysEmpty() {
        section("trap 1, silence: no stray partial text committed");
        FakeHost host = new FakeHost();
        host.partialText = "Uh";   // what a partial of a quiet buffer said on the Moonshine path
        host.commitText = "";
        host.finalText = "";
        FaceclawTranscriptSegmenter seg = new FaceclawTranscriptSegmenter(host);
        seg.reset(V2);
        feed(seg, host, 5.0, 0.1f);   // loud enough to pass the gate: the model itself returns nothing
        seg.finish();
        check("Parakeet final is empty (got \"" + host.lastFinal + "\")", "".equals(host.lastFinal));

        FakeHost moon = new FakeHost();
        moon.partialText = "Uh";
        FaceclawTranscriptSegmenter moonSeg = new FaceclawTranscriptSegmenter(moon);
        moonSeg.reset(MOONSHINE);
        feed(moonSeg, moon, 5.0, 0.1f);
        moonSeg.finish();
        check("Moonshine still shows its partial (unchanged)", "Uh".equals(moon.lastFinal));
    }

    // ---- trap 2: the level gate --------------------------------------------

    private static void testTvLevelSegmentsNeverDecoded() {
        section("trap 2: a TV-level capture never reaches the recognizer");
        for (FaceclawOnboardAsr.Model model : new FaceclawOnboardAsr.Model[] {V2, M110}) {
            FakeHost host = new FakeHost();
            host.commitText = "touchdown Caleb Williams";
            host.finalText = "And the Bears are able to answer back.";
            FaceclawTranscriptSegmenter seg = new FaceclawTranscriptSegmenter(host);
            seg.reset(model);
            feed(seg, host, 9.35, dbfsToAmplitude(-36.0));
            seg.finish();
            check(model.id + ": recognizer never called (got " + host.recognizedKinds + ")", host.recognizedKinds.isEmpty());
            check(model.id + ": commit and final both gated (got " + host.gatedKinds + ")",
                host.gatedKinds.size() == 2 && "commit".equals(host.gatedKinds.get(0)) && "final".equals(host.gatedKinds.get(1)));
            check(model.id + ": empty transcript", "".equals(host.lastFinal));
        }
        FakeHost whisper = new FakeHost();
        whisper.finalText = "(Casting) (static";
        FaceclawTranscriptSegmenter wseg = new FaceclawTranscriptSegmenter(whisper);
        wseg.reset(WHISPER);
        feed(wseg, whisper, 5.0, dbfsToAmplitude(-36.0));
        wseg.finish();
        check("Whisper at the same level still decodes (its gate is unchanged)",
            whisper.recognizedKinds.size() == 1 && whisper.gatedKinds.isEmpty());
    }

    private static void testQuietTailGatedSpeechKept() {
        section("trap 2: speech passes, a quiet tail after it is gated");
        FakeHost host = new FakeHost();
        host.commitText = "Add oat milk, coffee filters, and dish soap to the list.";
        host.finalText = "Yeah.";
        FaceclawTranscriptSegmenter seg = new FaceclawTranscriptSegmenter(host);
        seg.reset(V2);
        feed(seg, host, 7.0, dbfsToAmplitude(-27.8));
        feed(seg, host, 3.0, dbfsToAmplitude(-45.0));
        seg.finish();
        check("speech commit decoded, quiet final gated (decoded " + host.recognizedKinds + ", gated " + host.gatedKinds + ")",
            host.recognizedKinds.size() == 1 && "commit".equals(host.recognizedKinds.get(0))
                && host.gatedKinds.size() == 1 && "final".equals(host.gatedKinds.get(0)));
        check("transcript is the speech only (got \"" + host.lastFinal + "\")",
            "Add oat milk, coffee filters, and dish soap to the list.".equals(host.lastFinal));
        check("a commit is emitted as a non-final preview", host.emitted.size() == 2);
    }

    private static void testNormalizedSegmentAndGateLevels() {
        section("the recognizer gets a normalized copy; the gate sees the raw level");
        FakeHost host = new FakeHost();
        host.finalText = "hello";
        FaceclawTranscriptSegmenter seg = new FaceclawTranscriptSegmenter(host);
        seg.reset(V2);
        feed(seg, host, 2.0, 0.1f);
        seg.finish();
        check("one final decode", host.recognizedKinds.size() == 1);
        check("normalized to 0.9 peak (got " + host.recognizedPeaks.get(0) + ")",
            Math.abs(host.recognizedPeaks.get(0) - 0.9f) < 1e-4f);
        check("gate saw the raw 0.1 level", Math.abs(host.recognizedGates.get(0).level - 0.1f) < 1e-6f);
        check("total audio seconds", Math.abs(seg.totalAudioSec() - 2.0) < 1e-9);

        FakeHost quietHost = new FakeHost();
        quietHost.finalText = "hello";
        FaceclawTranscriptSegmenter quietSeg = new FaceclawTranscriptSegmenter(quietHost);
        quietSeg.reset(V2);
        feed(quietSeg, quietHost, 2.0, dbfsToAmplitude(-30.0));
        quietSeg.finish();
        check("gain is capped at 30x (0.0316 -> 0.9, got " + quietHost.recognizedPeaks.get(0) + ")",
            Math.abs(quietHost.recognizedPeaks.get(0) - 0.9f) < 1e-3f);

        FakeHost resetHost = new FakeHost();
        resetHost.finalText = "one";
        FaceclawTranscriptSegmenter resetSeg = new FaceclawTranscriptSegmenter(resetHost);
        resetSeg.reset(V2);
        feed(resetSeg, resetHost, 1.0, 0.1f);
        resetSeg.finish();
        resetSeg.reset(V2);
        check("reset clears the last transcript", "".equals(resetSeg.lastTranscript()) && resetSeg.totalAudioSec() == 0.0);
        resetSeg.finish();
        check("a final with no audio re-emits the (empty) last transcript", "".equals(resetHost.lastFinal));
    }

    // ---- receipt -----------------------------------------------------------

    private static void testReceiptRecognizerFields() {
        section("receipt: segment level, recognizer load, unload line");
        FaceclawVoiceCaptureReceipt r = new FaceclawVoiceCaptureReceipt(1789600000000L, 1789600000000L, 1_000L,
            "onboard-parakeet-v2", "ptt", false, "onboard", "parakeet-v2", false);
        int first = r.noteSegment("commit", 7180, 0.15f, dbfsToAmplitude(-27.8), 412, false, 57);
        int gated = r.noteSegment("final", 820, 0.0006f, dbfsToAmplitude(-73.1), 0, true, 0);
        check("segment indexes", first == 0 && gated == 1);
        r.setRecognizerLoad("parakeet-v2", 4, 1712, 402_000, 1_421_000, 90_000, 1_080_000);
        r.finish("Ghost, pull the faceclaw issues we talked about last night.", "transcribed", null,
            1789600009000L, 10_000L);
        String line = r.toJsonLine();
        System.out.println("EXAMPLE " + line);
        contains("commit entry with levelDbfs at the end", line,
            "{\"i\":0,\"kind\":\"commit\",\"audioMs\":7180,\"peakDbfs\":-16.5,\"decodeMs\":412,\"gated\":false,\"chars\":57,\"levelDbfs\":-27.8}");
        contains("gated entry with levelDbfs", line,
            "{\"i\":1,\"kind\":\"final\",\"audioMs\":820,\"peakDbfs\":-64.4,\"decodeMs\":0,\"gated\":true,\"chars\":0,\"levelDbfs\":-73.1}");
        contains("gate drops", line, "\"gateDrops\":1,\"gatedSegments\":[1]");
        contains("recognizer load block", line,
            "\"recognizer\":{\"model\":\"parakeet-v2\",\"threads\":4,\"loaded\":true,\"loadMs\":1712,\"rssMb\":[393,1388],\"nativeHeapMb\":[88,1055]},\"speechEnd\":false");
        contains("model field", line, "\"mode\":\"onboard\",\"model\":\"parakeet-v2\",\"source\":\"g2\"");

        FaceclawVoiceCaptureReceipt resident = new FaceclawVoiceCaptureReceipt(2L, 1789600100000L, 2_000L,
            "onboard-parakeet-110m", "ptt", true, "onboard", "parakeet-110m", true);
        resident.setRecognizerResident("parakeet-110m", 4, 61_000);
        resident.finish("", "empty", null, 1789600105000L, 7_000L);
        String residentLine = resident.toJsonLine();
        System.out.println("EXAMPLE " + residentLine);
        contains("resident block", residentLine,
            "\"recognizer\":{\"model\":\"parakeet-110m\",\"threads\":4,\"loaded\":false,\"idleMs\":61000}");

        FaceclawVoiceCaptureReceipt cloud = new FaceclawVoiceCaptureReceipt(3L, 1789600200000L, 3_000L,
            "soniox", "ptt", false, "cloud", null, false);
        check("no recognizer block on a cloud capture", cloud.toJsonLine().indexOf("\"recognizer\"") < 0);

        FaceclawVoiceCaptureReceipt old = new FaceclawVoiceCaptureReceipt(4L, 1789600300000L, 4_000L,
            "onboard-whisper", "ptt", false, "onboard", "whisper", false);
        old.noteSegment("final", 1000, 0.004f, 0, true, 0);
        contains("the old noteSegment has no levelDbfs", old.toJsonLine(),
            "{\"i\":0,\"kind\":\"final\",\"audioMs\":1000,\"peakDbfs\":-48.0,\"decodeMs\":0,\"gated\":true,\"chars\":0}");

        String unload = FaceclawVoiceCaptureReceipt.recognizerUnloadLine(1789600400000L, "parakeet-v2", "idle 300s",
            1_421_000, 402_000, 1_080_000, -1);
        System.out.println("EXAMPLE " + unload);
        check("unload line shape (got " + unload + ")",
            unload.startsWith("{\"type\":\"recognizerUnload\",\"at\":\"")
                && unload.endsWith(",\"atMs\":1789600400000,\"model\":\"parakeet-v2\",\"reason\":\"idle 300s\",\"rssMb\":[1388,393],\"nativeHeapMb\":[1055,null]}"));
    }

    // ---- helpers -----------------------------------------------------------

    private static void section(String name) {
        System.out.println("-- " + name);
    }

    private static void contains(String name, String haystack, String needle) {
        boolean ok = haystack.contains(needle);
        check(ok ? name : name + "\n     wanted: " + needle + "\n     in:     " + haystack, ok);
    }

    private static void check(String name, boolean ok) {
        checks++;
        if (!ok) {
            failures++;
        }
        System.out.println((ok ? "  ok   " : "  FAIL ") + name);
    }
}
