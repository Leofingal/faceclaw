package com.faceclaw.app;

import java.io.File;
import java.nio.file.Files;

/**
 * Standalone self-test for {@link FaceclawVoiceCaptureReceipt}. No Android
 * APIs and no hardware: every capture here is synthetic.
 *
 * <pre>
 *   javac -d /tmp/vct App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawVoiceCaptureReceipt.java \
 *                     notes/voice-capture-selftest/VoiceCaptureSelfTest.java
 *   java -cp /tmp/vct com.faceclaw.app.VoiceCaptureSelfTest
 * </pre>
 *
 * <p>The lines starting "EXAMPLE " are a fake capture's receipt lines, printed
 * so they can be checked with a real JSON parser, e.g.
 * {@code ... | sed -n 's/^EXAMPLE //p' | node -e "require('fs').readFileSync(0,'utf8').trim().split('\n').forEach(l=>JSON.parse(l))"}.
 */
public final class VoiceCaptureSelfTest {
    private static int checks;
    private static int failures;

    public static void main(String[] args) throws Exception {
        testLevels();
        testSilentAndZeroWindows();
        testJsonEscaping();
        testSegmentsAndGate();
        testExampleCaptureLine();
        testG2Line();
        testSideLines();
        testAppendCap();

        System.out.println();
        System.out.println(failures == 0
            ? "PASS: all " + checks + " checks"
            : "FAIL: " + failures + " of " + checks + " checks");
        if (failures != 0) {
            System.exit(1);
        }
    }

    private static FaceclawVoiceCaptureReceipt phoneReceipt(String model) {
        return new FaceclawVoiceCaptureReceipt(1789440000123L, 1789440000123L, 5_000L,
            "onboard-whisper", "ptt", true, "onboard", model, true);
    }

    /** A square wave at +/-amplitude: its peak and RMS are both exactly amplitude. */
    private static void feedSquare(FaceclawVoiceCaptureReceipt r, int samples, int amplitude, int chunk) {
        short[] buf = new short[chunk];
        int fed = 0;
        while (fed < samples) {
            int n = Math.min(chunk, samples - fed);
            for (int i = 0; i < n; i++) {
                buf[i] = (short) (((fed + i) % 2 == 0) ? amplitude : -amplitude);
            }
            r.acceptPcm(buf, n);
            fed += n;
        }
    }

    private static void testLevels() {
        section("levels");
        FaceclawVoiceCaptureReceipt r = phoneReceipt("whisper");
        // 3277 / 32768 = 0.1000 full scale = -20.0 dBFS.
        feedSquare(r, 16000, 3277, 800);
        String line = r.toJsonLine();
        contains("peak -20 dBFS", line, "\"peakDbfs\":-20.0");
        contains("rms -20 dBFS", line, "\"rmsDbfs\":-20.0");
        contains("1 s of audio", line, "\"ms\":1000");
        contains("20 windows", line, "\"windows\":20");
        contains("nothing silent", line, "\"silentFrac\":0.000");

        FaceclawVoiceCaptureReceipt quiet = phoneReceipt("whisper");
        quiet.acceptPcm(new short[1600], 1600);
        String quietLine = quiet.toJsonLine();
        contains("digital silence has no peak dBFS", quietLine, "\"peakDbfs\":null");
        contains("digital silence has no rms dBFS", quietLine, "\"rmsDbfs\":null");
        contains("all windows zero", quietLine, "\"zeroFrac\":1.000");

        FaceclawVoiceCaptureReceipt empty = phoneReceipt("whisper");
        contains("no audio at all", empty.toJsonLine(), "\"windows\":0,\"silentFrac\":null,\"zeroFrac\":null");
    }

    private static void testSilentAndZeroWindows() {
        section("silent and zero windows, independent of chunking");
        FaceclawVoiceCaptureReceipt r = phoneReceipt("whisper");
        // Odd chunk sizes: windowing must not follow the caller's chunks.
        short[] zeros = new short[333];
        int fed = 0;
        while (fed < 8000) {
            int n = Math.min(333, 8000 - fed);
            r.acceptPcm(zeros, n);
            fed += n;
        }
        feedSquare(r, 8000, 50, 257);     // -56.3 dBFS: near-silent, not zero
        feedSquare(r, 16000, 3277, 999);  // -20 dBFS speech-level
        String line = r.toJsonLine();
        contains("40 windows", line, "\"windows\":40");
        contains("half silent (zero + near-silent)", line, "\"silentFrac\":0.500");
        contains("a quarter exactly zero", line, "\"zeroFrac\":0.250");
        contains("overall rms", line, "\"rmsDbfs\":-23.0");
        contains("2 s of audio", line, "\"ms\":2000");

        FaceclawVoiceCaptureReceipt partial = phoneReceipt("whisper");
        feedSquare(partial, 1200, 3277, 1200);  // one full window + a half window
        contains("trailing partial window counts", partial.toJsonLine(), "\"windows\":2");
    }

    private static void testJsonEscaping() {
        section("json escaping");
        check("null literal", "null".equals(FaceclawVoiceCaptureReceipt.json(null)));
        String raw = "he said \"hi\" \\ back\nnext\ttab" + (char) 1 + " café";
        String expected = "\"he said \\\"hi\\\" \\\\ back\\nnext\\ttab\\u0001 café\"";
        String got = FaceclawVoiceCaptureReceipt.json(raw);
        check("escapes quote, backslash, newline, tab, control; keeps non-ASCII (got " + got + ")",
            expected.equals(got));

        FaceclawVoiceCaptureReceipt r = phoneReceipt("whisper");
        r.finish(raw, "transcribed", null, 1789440006543L, 11_420L);
        String line = r.toJsonLine();
        contains("transcript escaped in line", line, "\"transcript\":" + expected);
        check("no raw newline in the line", line.indexOf('\n') < 0);

        StringBuilder huge = new StringBuilder();
        for (int i = 0; i < 5000; i++) {
            huge.append('a');
        }
        FaceclawVoiceCaptureReceipt big = phoneReceipt("whisper");
        big.finish(huge.toString(), "transcribed", null, 1789440006543L, 11_420L);
        String bigLine = big.toJsonLine();
        contains("transcript chars counts the full length", bigLine, "\"transcriptChars\":5000");
        contains("truncation flagged", bigLine, "\"transcriptTruncated\":true");
    }

    private static void testSegmentsAndGate() {
        section("segments, silence gate, partials");
        FaceclawVoiceCaptureReceipt r = phoneReceipt("whisper");
        int first = r.noteSegment("commit", 8000, 0.2f, 1800, false, 57);
        int partial = r.noteSegment("partial", 3000, 0.2f, 300, false, 20);
        int second = r.noteSegment("partial", 2000, 0.2f, 250, false, 22);
        int gated = r.noteSegment("final", 1000, 0.004f, 0, true, 0);
        check("commit is segment 0", first == 0);
        check("partials are not segments", partial == -1 && second == -1);
        check("final gated is segment 1", gated == 1);
        String line = r.toJsonLine();
        contains("commit entry", line,
            "{\"i\":0,\"kind\":\"commit\",\"audioMs\":8000,\"peakDbfs\":-14.0,\"decodeMs\":1800,\"gated\":false,\"chars\":57}");
        contains("gated final entry", line,
            "{\"i\":1,\"kind\":\"final\",\"audioMs\":1000,\"peakDbfs\":-48.0,\"decodeMs\":0,\"gated\":true,\"chars\":0}");
        contains("gate drop count and index", line, "\"gateDrops\":1,\"gatedSegments\":[1]");
        contains("partial counters", line, "\"partialDecodes\":2,\"partialDecodeMs\":550");
        contains("segment count", line, "\"segmentCount\":2");
    }

    private static void testExampleCaptureLine() {
        section("example capture line");
        FaceclawVoiceCaptureReceipt r = phoneReceipt("whisper");
        FaceclawVoiceCaptureReceipt.Device aid = new FaceclawVoiceCaptureReceipt.Device("BLE_HEADSET", "Hearing aid L", 42);
        FaceclawVoiceCaptureReceipt.Device builtin = new FaceclawVoiceCaptureReceipt.Device("BUILTIN_MIC", "SM-F966U", 7);
        r.setRequested(aid, true);
        r.setRoutedAfterStart(null);
        r.addRoutingChange(38, aid);
        r.setRoutedAtFirstAudio(aid);
        r.noteClientSilenced(false);
        feedSquare(r, 16000 * 3, 3277, 800);   // 3 s of speech-level audio
        r.acceptPcm(new short[16000], 16000);  // 1 s of dead air
        r.addRoutingChange(3120, builtin);     // the route falls back mid-capture
        feedSquare(r, 16000 * 2, 60, 800);     // 2 s at the built-in mic's floor
        r.noteSegment("final", 6000, 0.1f, 2140, false, 38);
        r.finish("so the thing I wanted to say was that", "transcribed", null, 1789440006543L, 11_420L);
        String line = r.toJsonLine();
        System.out.println("EXAMPLE " + line);

        contains("type and id", line, "{\"type\":\"capture\",\"id\":1789440000123,");
        contains("duration from the elapsed clock", line, "\"durationMs\":6420");
        contains("provider/holder/mode/model/source", line,
            "\"provider\":\"onboard-whisper\",\"holder\":\"ptt\",\"mode\":\"onboard\",\"model\":\"whisper\",\"source\":\"phone-mic\",\"forcePhoneMic\":true");
        contains("requested device", line,
            "\"requested\":{\"found\":true,\"device\":{\"type\":\"BLE_HEADSET\",\"name\":\"Hearing aid L\",\"id\":42},\"accepted\":true}");
        contains("routed after start unknown", line, "\"routedAfterStart\":null");
        contains("routing changes in order", line,
            "\"routingChanges\":[{\"tMs\":38,\"device\":{\"type\":\"BLE_HEADSET\",\"name\":\"Hearing aid L\",\"id\":42}},{\"tMs\":3120,\"device\":{\"type\":\"BUILTIN_MIC\",\"name\":\"SM-F966U\",\"id\":7}}]");
        contains("client not silenced", line, "\"clientSilenced\":false");
        contains("half the windows near-silent", line, "\"silentFrac\":0.500");
        contains("requested block present", line, "\"requested\"");
        check("no g2 block on the phone mic (absent)", line.indexOf("\"g2\"") < 0);
        contains("outcome", line, "\"outcome\":\"transcribed\",\"error\":null}");

        FaceclawVoiceCaptureReceipt none = phoneReceipt("whisper");
        none.setRequestedNoneFound();
        contains("none found", none.toJsonLine(), "\"requested\":{\"found\":false}");
        FaceclawVoiceCaptureReceipt silenced = phoneReceipt("whisper");
        silenced.noteClientSilenced(true);
        silenced.noteClientSilenced(false);
        contains("silenced is sticky", silenced.toJsonLine(), "\"clientSilenced\":true");
    }

    private static void testG2Line() {
        section("g2 line");
        FaceclawVoiceCaptureReceipt r = new FaceclawVoiceCaptureReceipt(1789440100000L, 1789440100000L, 9_000L,
            "soniox", "continuous", false, "cloud", null, false);
        r.noteBeamDrop();
        r.noteBeamDrop();
        r.setG2Stats(120, 3, 5, 0, 180, 1);
        r.noteSpeechEnd();
        r.setVerification(false, 0.4123f);
        r.finish(null, "cloud", null, 1789440106000L, 15_000L);
        String line = r.toJsonLine();
        System.out.println("EXAMPLE " + line);
        contains("cloud mode, no model", line, "\"mode\":\"cloud\",\"model\":null,\"source\":\"g2\"");
        contains("g2 stats", line,
            "\"g2\":{\"packets\":120,\"missing\":3,\"late\":5,\"queueDrop\":0,\"maxGapMs\":180,\"decodeErrors\":1,\"beamDropped\":2}");
        check("no routing fields on g2", line.indexOf("\"requested\"") < 0 && line.indexOf("routingChanges") < 0);
        contains("speech end", line, "\"speechEnd\":true");
        contains("verification", line, "\"verify\":{\"isWearer\":false,\"similarity\":0.412}");
        contains("cloud transcript is null in the capture line", line, "\"transcript\":null,\"outcome\":\"cloud\"");

        FaceclawVoiceCaptureReceipt failed = new FaceclawVoiceCaptureReceipt(1L, 1789440100000L, 0L,
            "onboard", "ptt", false, "onboard", "moonshine", false);
        failed.finish(null, "error", "IllegalStateException: boom \"x\"", 1789440100500L, 500L);
        contains("error message escaped", failed.toJsonLine(),
            "\"outcome\":\"error\",\"error\":\"IllegalStateException: boom \\\"x\\\"\"}");
    }

    private static void testSideLines() {
        section("outcome and cloudFinal lines");
        String outcome = FaceclawVoiceCaptureReceipt.outcomeLine(1789440000123L, 1789440010000L, "sent", "ghost");
        System.out.println("EXAMPLE " + outcome);
        check("outcome line shape (got " + outcome + ")",
            outcome.startsWith("{\"type\":\"outcome\",\"capture\":1789440000123,\"at\":\"")
                && outcome.endsWith(",\"atMs\":1789440010000,\"outcome\":\"sent\",\"via\":\"ghost\"}"));
        String cloud = FaceclawVoiceCaptureReceipt.cloudFinalLine(1789440100000L, 1789440107000L, "soniox", "a \"quoted\" word");
        System.out.println("EXAMPLE " + cloud);
        contains("cloud final", cloud,
            "\"provider\":\"soniox\",\"transcript\":\"a \\\"quoted\\\" word\",\"transcriptChars\":15}");
    }

    private static void testAppendCap() throws Exception {
        section("append and cap");
        File dir = Files.createTempDirectory("vct").toFile();
        File nested = new File(dir, "voice");
        StringBuilder hundred = new StringBuilder();
        for (int i = 0; i < 100; i++) {
            hundred.append('x');
        }
        String line = hundred.toString();
        check("1st write creates the dir", FaceclawVoiceCaptureReceipt.appendLine(nested, line, 250));
        check("2nd write", FaceclawVoiceCaptureReceipt.appendLine(nested, line, 250));
        check("3rd write (202 <= 250)", FaceclawVoiceCaptureReceipt.appendLine(nested, line, 250));
        check("4th write refused (303 > 250)", !FaceclawVoiceCaptureReceipt.appendLine(nested, line, 250));
        File file = new File(nested, FaceclawVoiceCaptureReceipt.FILE);
        check("file holds three lines", file.length() == 303);

        File notADir = new File(dir, "plain-file");
        Files.write(notADir.toPath(), new byte[] {1});
        boolean wrote = true;
        try {
            wrote = FaceclawVoiceCaptureReceipt.appendLine(new File(notADir, "voice"), line, 250);
        } catch (Throwable t) {
            check("appendLine must not throw", false);
        }
        check("unwritable dir returns false", !wrote);
        check("null dir returns false", !FaceclawVoiceCaptureReceipt.appendLine(null, line, 250));

        file.delete();
        nested.delete();
        notADir.delete();
        dir.delete();
    }

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
