package com.faceclaw.app;

import android.content.Context;
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
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig;
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;

public class FaceclawVoiceController {
    private static final String TAG = "FaceclawVoice";
    private static final int SAMPLE_RATE = 16000;
    private static final int FEATURE_DIM = 80;
    private static final int MAX_AUDIO_QUEUE_PACKETS = 80;
    private static final int EXPECTED_PACKET_INTERVAL_MS = 50;
    private static final int LATE_PACKET_INTERVAL_MS = 90;
    private static final int STATS_INTERVAL_MS = 5_000;
    // Grace window between stop() being triggered and the G2 mic actually
    // being halted. Without this, stop() dropped any BLE mic packet still in
    // flight at the moment the capture-ending tap landed -- both by halting
    // FaceclawBleCommunicator's audio request immediately (stopG2Audio()) and,
    // more subtly, because queueAudioPacket()/processG2Audio() gated on
    // `started`, which stop() had already flipped false, so even packets that
    // arrived a few ms late were silently dropped before stopG2Audio() ever
    // ran. Confirmed both behaviorally (2026-09-06: "it does better if I fail
    // to hit send for a second or two") and by this code. This morning's own
    // logged maxGapMs values ran 120-150ms between real packets, so the window
    // needs to comfortably clear that; 450ms is a starting point, tuned
    // against real captures, not a measured optimum -- see
    // knowledge/staging/exocortex-stt-tail-clip-instruction.md. Scoped to the
    // G2/BLE path only: the phone mic (activePhoneMic) reads AudioRecord's own
    // local buffer directly, with no BLE transit hop to race against.
    private static final long AUDIO_STOP_GRACE_MS = 450;
    // Transcript segmenting, normalization and the per-model decode policy
    // live in FaceclawTranscriptSegmenter and FaceclawOnboardAsr (pure Java,
    // tested off-device in notes/voice-asr-selftest).
    private static final int TRANSCRIPT_LOG_PREVIEW_CHARS = 80;
    // Model directories shared with the TS-side download flow (asr-model.ts),
    // which fetches each model's files into ASR_ROOT/<Model.dirName> on
    // demand; none are bundled in the APK.
    private static final String ASR_ROOT = "faceclaw-voice-asr";
    // Model files for the retired on-phone wake-word spotter, copied to
    // filesDir by earlier releases; deleted on sight to reclaim the space.
    // (The wakeword is now detected by the glasses firmware itself.)
    private static final String LEGACY_KWS_ROOT = "faceclaw-voice";
    // Unload a resident recognizer after this long without a capture (see
    // setIdleUnloadMinutes); the TS side overrides it from Settings > Voice.
    // 0 = never, matching the TS default (asr-model-defs.ts).
    private static final long DEFAULT_IDLE_UNLOAD_MS = 0L;

    private enum VoiceInputMode {
        ONBOARD,  // on-phone transcription (see onboardModel)
        CLOUD     // decode locally, emit PCM for a cloud recognizer on the TS side
    }

    private final Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private final Object audioQueueLock = new Object();
    private final ArrayDeque<AudioPacket> audioQueue = new ArrayDeque<>();
    private volatile FaceclawVoiceControllerListener listener;
    private volatile FaceclawBleCommunicator communicator;
    private Thread workerThread;
    private volatile boolean started;
    // Set once the worker has the glasses mic enabled for this session.
    // Read and written under `lock`, so it flips with `started` atomically.
    private boolean audioStarted;
    // Wall-clock time (elapsedRealtime) `stop()` flipped `started` false, or 0
    // when not in the post-stop grace window. Lets queueAudioPacket() and the
    // G2 audio loop keep accepting/processing packets for AUDIO_STOP_GRACE_MS
    // after `started` goes false, instead of dropping in-flight BLE audio the
    // instant the capture-ending tap lands. See withinAudioGrace().
    private volatile long stopRequestedAtMs;
    // Capture from the phone's own microphone instead of the G2 over BLE
    // (preview-only mode, where no glasses are connected). Latched into
    // activePhoneMic at start() (under `lock`) so a mid-session setter call
    // can't switch pipelines underneath the worker.
    private volatile boolean usePhoneMic;
    private boolean activePhoneMic;
    private VoiceInputMode mode = VoiceInputMode.CLOUD;
    /** Which on-device model ONBOARD mode uses. Set via setOnboardModelKind() before start(). */
    private volatile FaceclawOnboardAsr.Model onboardModel = FaceclawOnboardAsr.Model.MOONSHINE;
    // Kept resident across captures; loaded by the worker (runLoop), released on
    // a model switch (worker), on idle unload (main thread, see
    // unloadIdleRecognizer) or on close(). Every release off the worker holds
    // `lock` and requires activeWorkers == 0, so no worker is using it.
    private OfflineRecognizer recognizer;
    // Which model `recognizer` above was actually built with.
    private FaceclawOnboardAsr.Model recognizerModel;
    // Workers started and not yet through their finally block. Counted under
    // `lock`; can briefly exceed 1 when stop()'s join times out and a new
    // start() follows (workerThread alone would not show the old worker).
    private int activeWorkers;
    // Idle unload of the resident recognizer: <= 0 means never. elapsedRealtime
    // of the end of the last on-device capture, for the idle check.
    private volatile long idleUnloadMs = DEFAULT_IDLE_UNLOAD_MS;
    private volatile long lastRecognizerUseEndMs;
    private final Runnable idleUnloadRunnable = this::unloadIdleRecognizer;
    private FaceclawLc3Decoder lc3Decoder;
    // The on-device transcript for the current capture (worker thread only).
    private final FaceclawTranscriptSegmenter transcript = new FaceclawTranscriptSegmenter(new SegmenterHost());
    private volatile boolean saveRecordings;
    private volatile boolean endpointing;
    private final EndpointDetector endpointDetector = new EndpointDetector();
    private java.io.ByteArrayOutputStream recordingPcm;
    // Speaker verification against the enrolled wearer voice-print ("my voice
    // only" command gating). Configured before start(); the utterance PCM is
    // buffered (capped) and verified once at session end.
    private static final int VERIFY_MAX_SAMPLES = SAMPLE_RATE * 10;
    private static final int VERIFY_MIN_SAMPLES = SAMPLE_RATE;
    private volatile String verifySpeakerModelPath;
    private volatile float[] verifyWearerEmbedding;
    private volatile float verifyThreshold = 0.8f;
    private short[] verifyBuffer;
    private int verifyCount;
    // Global mic processing (Microphones app config): spectral noise
    // suppression and firmware-DoA beam gating, applied to every capture
    // session that opts in (assistant push-to-talk, Transcribe, hands-free).
    // The raw tap opts out — raw means raw, and the Microphones session does
    // its own beam-compensated processing on that path.
    private volatile boolean suppressionEnabled;
    private volatile boolean beamFilterEnabled;
    private volatile int beamCenterDeg;
    private volatile int beamHalfWidthDeg = 180;
    private FaceclawNoiseSuppressor suppressor;
    private long queuedPackets;
    private long queueDroppedPackets;
    private long decodedSamples;
    private long latePackets;
    private long wrongArmPackets;
    private long lastPacketArrivalMs;
    private long maxInterPacketMs;
    private long lastStatsAtMs;
    // Capture receipt log (files/voice/capture-receipts.jsonl, see
    // FaceclawVoiceCaptureReceipt): one JSON line per capture, kept because
    // logcat rotates within minutes and "sometimes great, sometimes terrible"
    // dictation can only be diagnosed after the fact. The TS bridge sets the
    // context per capture; a null provider means no receipt (the raw
    // EvenHub/Microphones tap, which is not a dictation and can run for hours).
    private volatile String receiptProvider;
    private volatile String receiptHolder;
    private volatile boolean receiptForcePhoneMic;
    // The live capture's receipt, created in start() so its clock starts at the
    // request, or null. Written and cleared by the worker's finally block.
    private volatile FaceclawVoiceCaptureReceipt receipt;
    // Id (start wall-clock ms) and provider of the most recently started
    // receipted capture, for the outcome/cloudFinal lines the TS side appends.
    private volatile long lastCaptureId;
    private volatile String lastCaptureProvider;
    // Worker thread only: the phone-mic routing listener, removed before release.
    private android.media.AudioRouting.OnRoutingChangedListener phoneMicRoutingListener;

    public FaceclawVoiceController(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public void setListener(FaceclawVoiceControllerListener listener) {
        this.listener = listener;
    }

    public void setCommunicator(FaceclawBleCommunicator communicator) {
        this.communicator = communicator;
    }

    /** Source the next capture from the phone microphone (no glasses paired). */
    public void setUsePhoneMic(boolean usePhoneMic) {
        this.usePhoneMic = usePhoneMic;
    }

    /**
     * Receipt context for the next capture: the provider setting it was
     * started with ("onboard-whisper", "soniox", ...), whether Settings >
     * Developer > Force phone microphone is on, and who holds the mic ("ptt" /
     * "continuous"). Must be set before {@link #start}; a null provider (or
     * {@link #clearReceiptContext}) means that capture leaves no receipt.
     */
    public void setReceiptContext(String provider, boolean forcePhoneMic, String holder) {
        this.receiptProvider = provider;
        this.receiptForcePhoneMic = forcePhoneMic;
        this.receiptHolder = holder;
    }

    public void clearReceiptContext() {
        this.receiptProvider = null;
    }

    /**
     * What the wearer did with the most recent receipted capture's transcript
     * ("sent", "cancelled", ...), as its own line keyed by capture id. The
     * capture line is written when the worker ends, which can be after this
     * call, so readers join on the id rather than on line order. Never throws.
     */
    public void appendCaptureOutcome(String outcome, String via) {
        long id = lastCaptureId;
        if (id == 0 || outcome == null) {
            return;
        }
        appendReceiptLine(FaceclawVoiceCaptureReceipt.outcomeLine(id, System.currentTimeMillis(), outcome, via));
    }

    /** A cloud provider's final text, which arrives after the capture line is written. Never throws. */
    public void appendCloudFinal(String text) {
        long id = lastCaptureId;
        if (id == 0) {
            return;
        }
        appendReceiptLine(FaceclawVoiceCaptureReceipt.cloudFinalLine(
                id, System.currentTimeMillis(), lastCaptureProvider, text));
    }

    /** When true, the decoded mic PCM for each session is saved as a WAV. */
    public void setSaveRecordings(boolean saveRecordings) {
        this.saveRecordings = saveRecordings;
    }

    /**
     * Which on-device model {@link #start}("onboard") should load: "whisper",
     * "parakeet-v2" or "parakeet-110m" (see FaceclawOnboardAsr.Model); any
     * other value (including null/absent) keeps the existing Moonshine model,
     * so callers that never call this see unchanged behavior. Must be set
     * before {@link #start}; has no effect in CLOUD mode.
     */
    public void setOnboardModelKind(String kind) {
        this.onboardModel = FaceclawOnboardAsr.Model.fromId(kind);
    }

    /**
     * Release the resident on-device recognizer after this many minutes
     * without a capture; the next on-device capture loads it again. Zero or
     * less keeps it loaded until the app closes. Takes effect from the end of
     * the next capture.
     */
    public void setIdleUnloadMinutes(int minutes) {
        this.idleUnloadMs = minutes <= 0 ? 0 : minutes * 60_000L;
    }

    /**
     * When true, watch the decoded PCM and fire {@code onSpeechEnd} once the
     * speaker stops. Used by hands-free ("Hey Even") capture, which has no
     * button release to end the utterance. Must be set before {@link #start}.
     */
    public void setEndpointing(boolean endpointing) {
        this.endpointing = endpointing;
    }

    /**
     * Verify this session's speaker against the enrolled wearer voice-print
     * and report the result via onSpeakerVerified just before the final
     * transcript. Must be set before {@link #start}; pass a null model path
     * to disable.
     */
    public void setSpeakerVerification(String speakerModelPath, float[] wearerEmbedding, float threshold) {
        this.verifySpeakerModelPath = speakerModelPath;
        this.verifyWearerEmbedding = wearerEmbedding;
        this.verifyThreshold = threshold > 0 ? threshold : 0.8f;
    }

    public void clearSpeakerVerification() {
        this.verifySpeakerModelPath = null;
        this.verifyWearerEmbedding = null;
    }

    /** Spectral noise suppression on the decoded stream. Safe to flip mid-run. */
    public void setNoiseSuppression(boolean enabled) {
        this.suppressionEnabled = enabled;
    }

    /**
     * Direction gating from the Sonic Radar beam: packets whose firmware
     * direction-of-arrival falls outside centerDeg ± halfWidthDeg (device
     * frame, 0 = straight ahead, positive right) are dropped before any
     * consumer sees them. Safe to update mid-run.
     */
    public void setBeamFilter(boolean enabled, int centerDeg, int halfWidthDeg) {
        this.beamFilterEnabled = enabled;
        this.beamCenterDeg = centerDeg;
        this.beamHalfWidthDeg = Math.max(5, Math.min(180, halfWidthDeg));
    }

    private boolean withinBeam(int angleDegrees) {
        int delta = angleDegrees - beamCenterDeg;
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        return Math.abs(delta) <= beamHalfWidthDeg;
    }

    private void applySuppression(short[] pcm, int count) {
        try {
            if (suppressor == null) {
                suppressor = new FaceclawNoiseSuppressor(SAMPLE_RATE);
            }
            byte[] le = new byte[count * 2];
            for (int i = 0; i < count; i++) {
                le[i * 2] = (byte) (pcm[i] & 0xff);
                le[i * 2 + 1] = (byte) ((pcm[i] >> 8) & 0xff);
            }
            byte[] cleaned = suppressor.process(le);
            int cleanedCount = Math.min(count, cleaned.length / 2);
            for (int i = 0; i < cleanedCount; i++) {
                pcm[i] = (short) ((cleaned[i * 2] & 0xff) | (cleaned[i * 2 + 1] << 8));
            }
        } catch (Throwable t) {
            Log.w(TAG, "noise suppression failed; passing audio through", t);
            suppressionEnabled = false;
        }
    }

    public void start(String requestedMode) {
        synchronized (lock) {
            if (started) {
                emitStatus("Voice control is already listening.");
                return;
            }
            if (!usePhoneMic && (communicator == null || !communicator.isSessionReady())) {
                emitStatus("Voice control needs an active G2 connection.");
                return;
            }
            mode = parseMode(requestedMode);
            activePhoneMic = usePhoneMic;
            started = true;
            audioStarted = false;
            activeWorkers++;
            // A capture is starting: whatever the idle timer planned no longer holds.
            mainHandler.removeCallbacks(idleUnloadRunnable);
            String provider = receiptProvider;
            if (provider != null) {
                long nowWall = System.currentTimeMillis();
                long id = Math.max(nowWall, lastCaptureId + 1);
                lastCaptureId = id;
                lastCaptureProvider = provider;
                receipt = new FaceclawVoiceCaptureReceipt(
                        id,
                        nowWall,
                        SystemClock.elapsedRealtime(),
                        provider,
                        receiptHolder,
                        receiptForcePhoneMic,
                        mode == VoiceInputMode.CLOUD ? "cloud" : "onboard",
                        mode == VoiceInputMode.CLOUD ? null : onboardModel.id,
                        activePhoneMic);
            } else {
                receipt = null;
            }
            workerThread = new Thread(this::runLoop, "FaceclawVoiceController");
            workerThread.start();
        }
    }

    /**
     * Whether mic audio is actually flowing. {@link #start} only records
     * intent: the enable lives in the glasses' EvenHub session, so a transport
     * drop or a session suspend can leave this controller started with a
     * worker that will never see another packet. Anything deciding whether to
     * (re)start capture must ask this rather than assume its own bookkeeping.
     */
    public boolean isCapturing() {
        boolean audioUp;
        boolean phoneMic;
        synchronized (lock) {
            if (!started) {
                return false;
            }
            audioUp = audioStarted;
            phoneMic = activePhoneMic;
        }
        if (!audioUp) {
            // The worker is still bringing the mic up; report it as running so
            // a concurrent request shares it instead of restarting it.
            return true;
        }
        if (phoneMic) {
            // AudioRecord has no session to lose the enable to; it runs until stop().
            return true;
        }
        FaceclawBleCommunicator currentCommunicator = communicator;
        return currentCommunicator != null && currentCommunicator.isAudioCaptureActive();
    }

    public void stop() {
        Thread threadToJoin;
        boolean wasPhoneMic;
        synchronized (lock) {
            if (!started) {
                return;
            }
            started = false;
            threadToJoin = workerThread;
            wasPhoneMic = activePhoneMic;
        }
        // Grace window: give any G2 mic packet already crossing the BLE link
        // a chance to still arrive and get queued/decoded before the audio
        // request is actually halted and the worker thread is interrupted.
        // Only meaningful for the G2/BLE path (see AUDIO_STOP_GRACE_MS) and
        // only when some other thread is waiting on this stop() -- if the
        // worker thread is calling stop() on itself, sleeping here would just
        // stall the very loop this is meant to let finish draining.
        if (!wasPhoneMic && Thread.currentThread() != threadToJoin) {
            stopRequestedAtMs = SystemClock.elapsedRealtime();
            try {
                Thread.sleep(AUDIO_STOP_GRACE_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        stopG2Audio();
        synchronized (audioQueueLock) {
            audioQueueLock.notifyAll();
        }
        if (threadToJoin != null) {
            threadToJoin.interrupt();
            if (Thread.currentThread() != threadToJoin) {
                try {
                    threadToJoin.join(1500);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
        stopRequestedAtMs = 0;
    }

    /**
     * Real app teardown. Releases the resident recognizer unless a worker is
     * somehow still running after stop()'s join (then the process is going
     * away anyway, and releasing under it could crash in native code).
     */
    public void close() {
        stop();
        mainHandler.removeCallbacks(idleUnloadRunnable);
        synchronized (lock) {
            if (activeWorkers == 0) {
                releaseSherpa();
            }
        }
    }

    private VoiceInputMode parseMode(String requestedMode) {
        if ("cloud".equals(requestedMode)) {
            return VoiceInputMode.CLOUD;
        }
        return VoiceInputMode.ONBOARD;
    }

    private void runLoop() {
        // This worker's own receipt (see finishReceipt()). A non-null failure is
        // a Java-visible outcome that wins over "transcribed"/"empty".
        FaceclawVoiceCaptureReceipt workerReceipt = receipt;
        VoiceInputMode currentMode = mode;
        String failure = null;
        String failureMessage = null;
        try {
            deleteLegacyKwsFiles();
            FaceclawOnboardAsr.Model currentModel = onboardModel;
            if (currentMode == VoiceInputMode.ONBOARD) {
                // The recognizer is kept resident across captures (see recognizerModel
                // above) -- constructing an OfflineRecognizer loads the ONNX model from
                // disk, which used to happen fresh on every single push-to-talk press
                // (measured as the dominant cost in the startup-latency investigation).
                // Only rebuild it here if it's missing (first capture since app start,
                // or unloaded after idling) or the wearer switched on-device models.
                if (recognizer != null && recognizerModel != currentModel) {
                    String switchLine = logRecognizerRelease("switch to " + currentModel.id);
                    if (switchLine != null) {
                        appendReceiptLine(switchLine);
                    }
                }
                if (recognizer == null) {
                    File modelDir = findAsrModelDir(currentModel);
                    if (modelDir == null) {
                        emitStatus("Voice model not downloaded (see Settings > Voice).");
                        failure = "no-model";
                        return;
                    }
                    emitStatus("Loading transcription model...");
                    loadRecognizer(modelDir, currentModel, workerReceipt);
                } else if (workerReceipt != null) {
                    workerReceipt.setRecognizerResident(currentModel.id, FaceclawOnboardAsr.RECOGNIZER_THREADS,
                            SystemClock.elapsedRealtime() - lastRecognizerUseEndMs);
                }
                transcript.reset(currentModel);
            }
            endpointDetector.reset();
            if (suppressor != null) {
                suppressor.reset();
            }
            recordingPcm = saveRecordings ? new java.io.ByteArrayOutputStream(SAMPLE_RATE * 2 * 4) : null;
            boolean verifying = verifySpeakerModelPath != null && verifyWearerEmbedding != null;
            verifyBuffer = verifying ? new short[VERIFY_MAX_SAMPLES] : null;
            verifyCount = 0;
            if (activePhoneMic) {
                android.media.AudioRecord record = openPhoneMic(workerReceipt);
                if (record == null) {
                    emitStatus("Could not start the phone microphone.");
                    failure = "mic-failed";
                    return;
                }
                synchronized (lock) {
                    audioStarted = true;
                }
                emitStatus(currentMode == VoiceInputMode.CLOUD
                        ? "Listening (cloud)..."
                        : "Listening...");
                try {
                    processPhoneAudio(record);
                } finally {
                    sampleClientSilenced(record, workerReceipt);
                    if (phoneMicRoutingListener != null) {
                        try {
                            record.removeOnRoutingChangedListener(phoneMicRoutingListener);
                        } catch (Throwable ignored) {
                            // Released below either way.
                        }
                        phoneMicRoutingListener = null;
                    }
                    try {
                        record.stop();
                    } catch (Throwable ignored) {
                        // Already stopped or never recording; release below either way.
                    }
                    record.release();
                }
            } else {
                lc3Decoder = new FaceclawLc3Decoder();
                if (!startG2Audio()) {
                    emitStatus("Could not start G2 microphone input.");
                    failure = "g2-audio-failed";
                    return;
                }
                synchronized (lock) {
                    audioStarted = true;
                }
                emitStatus(currentMode == VoiceInputMode.CLOUD
                        ? "Listening (cloud)..."
                        : "Listening...");
                processG2Audio();
            }
            // Verification result must precede the final transcript so the
            // TS bridge can suppress a non-wearer command before it is acted
            // on (the callbacks are posted in order to the main handler).
            runSpeakerVerification();
            // Button released / stop requested: emit one final full-utterance
            // transcript so the UI can freeze it.
            if (currentMode == VoiceInputMode.ONBOARD) {
                transcript.finish();
            }
        } catch (Throwable error) {
            Log.e(TAG, "Voice control failed", error);
            emitStatus("Voice control failed: " + error.getMessage());
            failure = "error";
            failureMessage = error.getClass().getSimpleName() + ": " + error.getMessage();
        } finally {
            stopG2Audio();
            writeRecordingIfAny();
            // Before releaseLc3(): the G2 packet counters are read off the decoder.
            finishReceipt(workerReceipt, currentMode, failure, failureMessage);
            // recognizer is NOT released here any more -- it stays resident across
            // captures (see the ONBOARD branch above). releaseSherpa() now runs only
            // from close(), on real app teardown.
            releaseLc3();
            synchronized (lock) {
                started = false;
                audioStarted = false;
                workerThread = null;
                activeWorkers--;
                if (currentMode == VoiceInputMode.ONBOARD && recognizer != null) {
                    lastRecognizerUseEndMs = SystemClock.elapsedRealtime();
                    scheduleIdleUnload(idleUnloadMs);
                }
            }
        }
    }

    /** Build the recognizer, logging how long it took and what it cost in memory. */
    private void loadRecognizer(File modelDir, FaceclawOnboardAsr.Model model, FaceclawVoiceCaptureReceipt r) {
        long rssBeforeKb = readVmRssKb();
        long heapBeforeKb = android.os.Debug.getNativeHeapAllocatedSize() / 1024;
        long startMs = SystemClock.elapsedRealtime();
        recognizer = new OfflineRecognizer(buildRecognizerConfig(modelDir, model));
        recognizerModel = model;
        long loadMs = SystemClock.elapsedRealtime() - startMs;
        long rssAfterKb = readVmRssKb();
        long heapAfterKb = android.os.Debug.getNativeHeapAllocatedSize() / 1024;
        Log.i(TAG, "ASR recognizer loaded model=" + model.id
                + " threads=" + FaceclawOnboardAsr.RECOGNIZER_THREADS
                + " loadMs=" + loadMs
                + " rssMb=" + mb(rssBeforeKb) + "->" + mb(rssAfterKb)
                + " nativeHeapMb=" + mb(heapBeforeKb) + "->" + mb(heapAfterKb));
        if (r != null) {
            r.setRecognizerLoad(model.id, FaceclawOnboardAsr.RECOGNIZER_THREADS, loadMs,
                    rssBeforeKb, rssAfterKb, heapBeforeKb, heapAfterKb);
        }
    }

    /**
     * Release the recognizer and log what came back. Caller guarantees no
     * worker is using it: the worker itself, or `lock` held with
     * activeWorkers == 0.
     *
     * @return the receipt side line describing the release, or null if nothing was loaded
     */
    private String logRecognizerRelease(String reason) {
        OfflineRecognizer current = recognizer;
        if (current == null) {
            return null;
        }
        FaceclawOnboardAsr.Model model = recognizerModel;
        long rssBeforeKb = readVmRssKb();
        long heapBeforeKb = android.os.Debug.getNativeHeapAllocatedSize() / 1024;
        current.release();
        recognizer = null;
        recognizerModel = null;
        long rssAfterKb = readVmRssKb();
        long heapAfterKb = android.os.Debug.getNativeHeapAllocatedSize() / 1024;
        Log.i(TAG, "ASR recognizer released model=" + (model == null ? "?" : model.id)
                + " reason=" + reason
                + " rssMb=" + mb(rssBeforeKb) + "->" + mb(rssAfterKb)
                + " nativeHeapMb=" + mb(heapBeforeKb) + "->" + mb(heapAfterKb));
        return FaceclawVoiceCaptureReceipt.recognizerUnloadLine(System.currentTimeMillis(),
                model == null ? null : model.id, reason, rssBeforeKb, rssAfterKb, heapBeforeKb, heapAfterKb);
    }

    /** Main-thread timer; call with `lock` held or from the main thread. */
    private void scheduleIdleUnload(long delayMs) {
        mainHandler.removeCallbacks(idleUnloadRunnable);
        if (delayMs > 0) {
            mainHandler.postDelayed(idleUnloadRunnable, delayMs);
        }
    }

    /**
     * Idle-unload timer (main thread). Releases the resident recognizer when no
     * worker is running and none has finished within idleUnloadMs; otherwise
     * does nothing (a running worker reschedules from its finally block) or
     * waits out the remainder.
     */
    private void unloadIdleRecognizer() {
        String line;
        synchronized (lock) {
            long idleMs = idleUnloadMs;
            if (recognizer == null || idleMs <= 0 || started || activeWorkers > 0) {
                return;
            }
            long idleForMs = SystemClock.elapsedRealtime() - lastRecognizerUseEndMs;
            if (idleForMs < idleMs) {
                scheduleIdleUnload(idleMs - idleForMs);
                return;
            }
            line = logRecognizerRelease("idle " + (idleForMs / 1000) + "s");
        }
        if (line != null) {
            appendReceiptLine(line);
        }
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

    private void appendRecording(short[] pcm, int count) {
        java.io.ByteArrayOutputStream out = recordingPcm;
        if (out == null) {
            return;
        }
        for (int i = 0; i < count; i++) {
            short s = pcm[i];
            out.write(s & 0xff);
            out.write((s >> 8) & 0xff);
        }
    }

    /** Save the session's decoded mic PCM as a 16 kHz mono 16-bit WAV. */
    private void writeRecordingIfAny() {
        java.io.ByteArrayOutputStream out = recordingPcm;
        recordingPcm = null;
        if (out == null || out.size() == 0) {
            return;
        }
        try {
            byte[] pcmBytes = out.toByteArray();
            java.io.File dir = new java.io.File(appContext.getExternalFilesDir(null), "voice-recordings");
            if (!dir.exists() && !dir.mkdirs()) {
                Log.w(TAG, "could not create voice-recordings dir");
                return;
            }
            String stamp = new java.text.SimpleDateFormat("yyyyMMdd-HHmmss-SSS", java.util.Locale.US)
                    .format(new java.util.Date());
            java.io.File file = new java.io.File(dir, "voice-" + stamp + ".wav");
            try (java.io.FileOutputStream fos = new java.io.FileOutputStream(file)) {
                fos.write(buildWavHeader(pcmBytes.length, SAMPLE_RATE, 1, 16));
                fos.write(pcmBytes);
            }
            Log.i(TAG, "saved voice recording " + file.getAbsolutePath()
                    + " samples=" + (pcmBytes.length / 2)
                    + " sec=" + String.format(java.util.Locale.US, "%.2f", pcmBytes.length / 2.0 / SAMPLE_RATE));
        } catch (Throwable t) {
            Log.w(TAG, "failed to save voice recording", t);
        }
    }

    private static byte[] buildWavHeader(int pcmBytes, int sampleRate, int channels, int bitsPerSample) {
        int byteRate = sampleRate * channels * bitsPerSample / 8;
        int blockAlign = channels * bitsPerSample / 8;
        int dataSize = pcmBytes;
        int riffSize = 36 + dataSize;
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        b.putInt(riffSize);
        b.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        b.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        b.putInt(16);            // PCM fmt chunk size
        b.putShort((short) 1);   // PCM
        b.putShort((short) channels);
        b.putInt(sampleRate);
        b.putInt(byteRate);
        b.putShort((short) blockAlign);
        b.putShort((short) bitsPerSample);
        b.put("data".getBytes(StandardCharsets.US_ASCII));
        b.putInt(dataSize);
        return b.array();
    }

    private OfflineRecognizerConfig buildRecognizerConfig(File modelDir, FaceclawOnboardAsr.Model model) {
        OfflineModelConfig.Builder modelConfig = OfflineModelConfig.builder()
                .setNumThreads(FaceclawOnboardAsr.RECOGNIZER_THREADS);
        if (model.isTransducer()) {
            // The same config the desktop benchmark scored (sherpa_onnx
            // OfflineRecognizer.from_transducer(..., model_type="nemo_transducer"),
            // greedy search). Feature dim and NeMo normalization come from the
            // model's own metadata (offline-recognizer-transducer-nemo-impl.h
            // PostInit at v1.13.0), overriding FEATURE_DIM below.
            modelConfig
                    .setTransducer(OfflineTransducerModelConfig.builder()
                            .setEncoder(new File(modelDir, "encoder.int8.onnx").getAbsolutePath())
                            .setDecoder(new File(modelDir, "decoder.int8.onnx").getAbsolutePath())
                            .setJoiner(new File(modelDir, "joiner.int8.onnx").getAbsolutePath())
                            .build())
                    .setTokens(new File(modelDir, "tokens.txt").getAbsolutePath())
                    .setModelType("nemo_transducer");
        } else if (model == FaceclawOnboardAsr.Model.WHISPER) {
            modelConfig
                    .setWhisper(OfflineWhisperModelConfig.builder()
                            .setEncoder(new File(modelDir, "base.en-encoder.int8.onnx").getAbsolutePath())
                            .setDecoder(new File(modelDir, "base.en-decoder.int8.onnx").getAbsolutePath())
                            .setLanguage("en")
                            .setTask("transcribe")
                            .build())
                    .setTokens(new File(modelDir, "base.en-tokens.txt").getAbsolutePath());
        } else {
            modelConfig
                    .setMoonshine(OfflineMoonshineModelConfig.builder()
                            .setEncoder(new File(modelDir, "encoder_model.ort").getAbsolutePath())
                            .setMergedDecoder(new File(modelDir, "decoder_model_merged.ort").getAbsolutePath())
                            .build())
                    .setTokens(new File(modelDir, "tokens.txt").getAbsolutePath());
        }
        return OfflineRecognizerConfig.builder()
                .setFeatureConfig(FeatureConfig.builder()
                        .setSampleRate(SAMPLE_RATE)
                        .setFeatureDim(FEATURE_DIM)
                        .build())
                .setModelConfig(modelConfig.build())
                .build();
    }

    /**
     * The on-device model directory for the given kind, populated by the
     * download flow in asr-model.ts (releases before 0.5.0 copied the
     * Moonshine files out of the APK directly, so upgraded installs are
     * already complete for that model). Null when any expected file is
     * missing, i.e. the model still needs to be downloaded.
     */
    private File findAsrModelDir(FaceclawOnboardAsr.Model model) {
        File modelDir = new File(appContext.getFilesDir(), ASR_ROOT + File.separator + model.dirName);
        for (String fileName : model.files) {
            File file = new File(modelDir, fileName);
            if (!file.exists() || file.length() == 0) {
                return null;
            }
        }
        return modelDir;
    }

    private void deleteLegacyKwsFiles() {
        try {
            deleteRecursively(new File(appContext.getFilesDir(), LEGACY_KWS_ROOT));
        } catch (Throwable t) {
            Log.w(TAG, "failed to delete legacy wake-word files", t);
        }
    }

    private static void deleteRecursively(File file) {
        if (!file.exists()) {
            return;
        }
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursively(child);
            }
        }
        file.delete();
    }

    private boolean startG2Audio() {
        FaceclawBleCommunicator currentCommunicator = communicator;
        if (currentCommunicator == null) {
            return false;
        }
        resetAudioStats();
        synchronized (audioQueueLock) {
            audioQueue.clear();
        }
        return currentCommunicator.startG2AudioCapture(this::queueAudioPacket);
    }

    /**
     * True while the G2 audio pipeline should keep accepting/processing mic
     * packets: either a capture is actively running, or stop() was called
     * within the last AUDIO_STOP_GRACE_MS. Gates queueAudioPacket() and the
     * processG2Audio()/takeAudioPacket() loop so in-flight BLE audio isn't
     * dropped the instant `started` flips false -- see stop()'s own comment.
     */
    private boolean withinAudioGrace() {
        if (started) {
            return true;
        }
        long requestedAt = stopRequestedAtMs;
        return requestedAt != 0
                && SystemClock.elapsedRealtime() - requestedAt < AUDIO_STOP_GRACE_MS;
    }

    private void processG2Audio() {
        short[] pcm = new short[FaceclawLc3Decoder.SAMPLES_PER_PACKET];
        while (withinAudioGrace() && !Thread.currentThread().isInterrupted()) {
            FaceclawLc3Decoder currentDecoder = lc3Decoder;
            if (currentDecoder == null) {
                return;
            }

            AudioPacket packet = takeAudioPacket();
            if (packet == null) {
                continue;
            }

            int count = currentDecoder.decodePacket(packet.data, pcm);
            if (count <= 0) {
                maybeEmitAudioStats(false);
                continue;
            }
            decodedSamples += count;
            // Global mic processing from the Microphones app config: the
            // beam filter drops packets whose firmware direction-of-arrival
            // falls outside the listening wedge (isolating the aimed talker
            // for every consumer, recognition included), and the spectral
            // noise suppressor cleans what remains before it reaches the
            // recognizer, cloud PCM, endpointing, or speaker verification.
            int angleDegrees = currentDecoder.getLastAngleDegrees();
            int ssr = currentDecoder.getLastSsr();
            if (beamFilterEnabled && ssr > 0 && !withinBeam(angleDegrees)) {
                FaceclawVoiceCaptureReceipt r = receipt;
                if (r != null) {
                    r.noteBeamDrop();
                }
                emitFrameMeta(angleDegrees, ssr);
                maybeEmitAudioStats(false);
                continue;
            }
            processPcmChunk(pcm, count, angleDegrees, ssr, true);
            maybeEmitAudioStats(false);
        }
    }

    /**
     * Per-chunk processing shared by the G2 and phone-mic paths, downstream of
     * decode and the beam filter. hasFrameMeta is false for the phone mic,
     * which has no firmware DSP metadata to report.
     */
    private void processPcmChunk(short[] pcm, int count, int angleDegrees, int ssr, boolean hasFrameMeta) {
        // Receipt levels are taken BEFORE noise suppression: they describe what
        // the mic delivered, which is the routing/link question.
        FaceclawVoiceCaptureReceipt r = receipt;
        if (r != null) {
            r.acceptPcm(pcm, count);
        }
        if (suppressionEnabled) {
            applySuppression(pcm, count);
        }
        if (recordingPcm != null) {
            appendRecording(pcm, count);
        }
        if (verifyBuffer != null && verifyCount < VERIFY_MAX_SAMPLES) {
            int copied = Math.min(count, VERIFY_MAX_SAMPLES - verifyCount);
            System.arraycopy(pcm, 0, verifyBuffer, verifyCount, copied);
            verifyCount += copied;
        }
        if (endpointing && endpointDetector.accept(pcm, count)) {
            if (r != null) {
                r.noteSpeechEnd();
            }
            emitSpeechEnd();
        }
        // PCM and frame metadata flow in every mode so levels, recording,
        // and the Microphones radar keep working alongside onboard ASR.
        emitPcm(pcm, count);
        if (hasFrameMeta) {
            emitFrameMeta(angleDegrees, ssr);
        }
        if (mode != VoiceInputMode.CLOUD) {
            float[] samples = new float[count];
            for (int i = 0; i < count; i++) {
                samples[i] = pcm[i] / 32768.0f;
            }
            transcript.accept(samples);
        }
    }

    // 50 ms chunks match the G2 packet cadence the rest of the pipeline
    // (endpointing, transcript pacing) is tuned for.
    private static final int PHONE_MIC_CHUNK_SAMPLES = SAMPLE_RATE / 20;

    /**
     * Open the phone's own microphone at the pipeline's native format
     * (16 kHz mono PCM16), or null when it cannot start — the permission is
     * missing (SecurityException) or the device refuses the configuration.
     *
     * A plain AudioRecord does NOT automatically prefer a connected Bluetooth
     * LE Audio / hearing-aid input over the phone's built-in mic, even when
     * that device is marked the system's preferred microphone for calls --
     * confirmed against Android's own BLE Audio recording guidance (developer
     * documentation for AudioRecord + BLE Audio, 2026-09-07: "the application
     * must ... explicitly set it as preferred" via setPreferredDevice(), or
     * the default input device -- typically the built-in mic -- is used
     * regardless of what's connected). Without the block below, forcing phone
     * mic while the hearing aids are connected would silently capture from
     * the phone's own mic instead: a working toggle that solves nothing. See
     * knowledge/staging/exocortex-phone-mic-toggle-instruction.md.
     */
    private android.media.AudioRecord openPhoneMic(FaceclawVoiceCaptureReceipt r) {
        android.media.AudioRecord record = null;
        try {
            int minBytes = android.media.AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    android.media.AudioFormat.CHANNEL_IN_MONO,
                    android.media.AudioFormat.ENCODING_PCM_16BIT);
            int bufferBytes = Math.max(minBytes, PHONE_MIC_CHUNK_SAMPLES * 2 * 4);
            record = new android.media.AudioRecord(
                    android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    android.media.AudioFormat.CHANNEL_IN_MONO,
                    android.media.AudioFormat.ENCODING_PCM_16BIT,
                    bufferBytes);
            if (record.getState() != android.media.AudioRecord.STATE_INITIALIZED) {
                record.release();
                return null;
            }
            android.media.AudioDeviceInfo preferredInput = findPreferredBleAudioInput();
            if (preferredInput != null) {
                boolean accepted = record.setPreferredDevice(preferredInput);
                Log.i(TAG, "phone mic: requesting preferred input device type="
                        + describeAudioDeviceType(preferredInput.getType())
                        + " name=" + preferredInput.getProductName()
                        + " accepted=" + accepted);
                if (r != null) {
                    r.setRequested(deviceOf(preferredInput), accepted);
                }
            } else {
                Log.i(TAG, "phone mic: no BLE/hearing-aid input device found among "
                        + "GET_DEVICES_INPUTS; falling back to Android's default input "
                        + "routing (likely the built-in mic)");
                if (r != null) {
                    r.setRequestedNoneFound();
                }
            }
            if (r != null) {
                // Every routing change for the life of this AudioRecord, stamped
                // relative to the capture request. AudioRouting's listener is
                // API 24 (minSdk, so no guard); it replaces API 23's deprecated
                // AudioRecord.OnRoutingChangedListener. Delivered on the main
                // looper; the receipt's mutators are synchronized.
                final long startElapsed = r.startElapsedMs;
                android.media.AudioRouting.OnRoutingChangedListener routingListener = router -> {
                    try {
                        r.addRoutingChange(SystemClock.elapsedRealtime() - startElapsed,
                                deviceOf(router.getRoutedDevice()));
                    } catch (Throwable ignored) {
                        // A receipt must never break capture.
                    }
                };
                record.addOnRoutingChangedListener(routingListener, mainHandler);
                phoneMicRoutingListener = routingListener;
            }
            record.startRecording();
            if (record.getRecordingState() != android.media.AudioRecord.RECORDSTATE_RECORDING) {
                phoneMicRoutingListener = null;
                record.release();
                return null;
            }
            if (r != null) {
                // Often still null this early; routedAtFirstAudio is taken once audio flows.
                r.setRoutedAfterStart(deviceOf(record.getRoutedDevice()));
            }
            return record;
        } catch (Throwable t) {
            Log.w(TAG, "phone mic open failed", t);
            phoneMicRoutingListener = null;
            if (record != null) {
                record.release();
            }
            return null;
        }
    }

    /**
     * Look for a connected Bluetooth LE Audio or hearing-aid input device to
     * hand to AudioRecord.setPreferredDevice() -- see the caller's comment
     * for why this is required at all. TYPE_HEARING_AID (API 28) is the
     * classic-Bluetooth ASHA hearing-aid profile; TYPE_BLE_HEADSET (API 31)
     * is how Android exposes general LE Audio input devices, which is also
     * the type LE Audio hearing aids (the HAP profile) are expected to
     * surface as on current Android versions -- NOT independently confirmed
     * against Chris's actual hearing aids, since that requires a real device
     * with them connected (see the return doc). Referencing these constants
     * is safe on the app's minSdk 24: they're compile-time int fields, not
     * calls, so an old OS that never returns a device of that type just never
     * matches -- no version guard needed.
     */
    private android.media.AudioDeviceInfo findPreferredBleAudioInput() {
        android.media.AudioManager audioManager =
                (android.media.AudioManager) appContext.getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) {
            return null;
        }
        android.media.AudioDeviceInfo[] inputs;
        try {
            inputs = audioManager.getDevices(android.media.AudioManager.GET_DEVICES_INPUTS);
        } catch (Throwable t) {
            Log.w(TAG, "phone mic: could not enumerate input devices", t);
            return null;
        }
        android.media.AudioDeviceInfo hearingAid = null;
        android.media.AudioDeviceInfo bleHeadset = null;
        for (android.media.AudioDeviceInfo device : inputs) {
            int type = device.getType();
            if (type == android.media.AudioDeviceInfo.TYPE_HEARING_AID) {
                hearingAid = device;
            } else if (type == android.media.AudioDeviceInfo.TYPE_BLE_HEADSET) {
                bleHeadset = device;
            }
        }
        // Prefer the dedicated hearing-aid type over the general BLE Audio
        // type when both are somehow present.
        return hearingAid != null ? hearingAid : bleHeadset;
    }

    /** The receipt's plain-value view of an Android audio device; null stays null. */
    private static FaceclawVoiceCaptureReceipt.Device deviceOf(android.media.AudioDeviceInfo device) {
        if (device == null) {
            return null;
        }
        CharSequence name = device.getProductName();
        return new FaceclawVoiceCaptureReceipt.Device(
                describeAudioDeviceType(device.getType()),
                name == null ? null : name.toString(),
                device.getId());
    }

    /**
     * Whether Android is feeding this client silence instead of mic audio
     * (another app holds the mic, or capture lost its foreground rights).
     * AudioRecord.getActiveRecordingConfiguration() and
     * AudioRecordingConfiguration.isClientSilenced() are both API 29; below
     * that the receipt says null.
     */
    private static void sampleClientSilenced(android.media.AudioRecord record, FaceclawVoiceCaptureReceipt r) {
        if (r == null || android.os.Build.VERSION.SDK_INT < 29) {
            return;
        }
        try {
            android.media.AudioRecordingConfiguration config = record.getActiveRecordingConfiguration();
            if (config != null) {
                r.noteClientSilenced(config.isClientSilenced());
            }
        } catch (Throwable ignored) {
            // Diagnostic only.
        }
    }

    /**
     * Close out this worker's receipt and append it. Never throws. The outcome
     * is only what Java can see: a failure to start, "transcribed" / "empty"
     * on-device, or "cloud" when a cloud provider owns the transcript (its text
     * follows as a cloudFinal line). Whether the wearer then sent or cancelled
     * it arrives separately, via appendCaptureOutcome().
     */
    private void finishReceipt(FaceclawVoiceCaptureReceipt r, VoiceInputMode currentMode,
                               String failure, String failureMessage) {
        if (r == null) {
            return;
        }
        try {
            if (!r.phoneMic) {
                FaceclawLc3Decoder decoder = lc3Decoder;
                r.setG2Stats(queuedPackets,
                        decoder == null ? 0 : decoder.getMissingPackets(),
                        latePackets,
                        queueDroppedPackets,
                        maxInterPacketMs,
                        decoder == null ? 0 : decoder.getDecodeErrors());
            }
            String transcriptText = null;
            String outcome;
            if (failure != null) {
                outcome = failure;
            } else if (currentMode == VoiceInputMode.CLOUD) {
                outcome = "cloud";
            } else {
                transcriptText = this.transcript.lastTranscript();
                outcome = transcriptText.trim().length() == 0 ? "empty" : "transcribed";
            }
            r.finish(transcriptText, outcome, failureMessage, System.currentTimeMillis(), SystemClock.elapsedRealtime());
            appendReceiptLine(r.toJsonLine());
        } catch (Throwable t) {
            Log.w(TAG, "capture receipt failed", t);
        } finally {
            if (receipt == r) {
                receipt = null;
            }
        }
    }

    private void appendReceiptLine(String line) {
        try {
            File dir = new File(appContext.getFilesDir(), FaceclawVoiceCaptureReceipt.DIR);
            boolean written = FaceclawVoiceCaptureReceipt.appendLine(dir, line, FaceclawVoiceCaptureReceipt.MAX_BYTES);
            Log.i(TAG, (written ? "capture receipt: " : "capture receipt NOT written (dir, cap or I/O): ") + line);
        } catch (Throwable t) {
            Log.w(TAG, "capture receipt write failed", t);
        }
    }

    /** Human-readable label for logcat; falls back to the raw int for any type not named here. */
    private static String describeAudioDeviceType(int type) {
        if (type == android.media.AudioDeviceInfo.TYPE_BUILTIN_MIC) return "BUILTIN_MIC";
        if (type == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO) return "BLUETOOTH_SCO";
        if (type == android.media.AudioDeviceInfo.TYPE_BLE_HEADSET) return "BLE_HEADSET";
        if (type == android.media.AudioDeviceInfo.TYPE_HEARING_AID) return "HEARING_AID";
        if (type == android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET) return "WIRED_HEADSET";
        if (type == android.media.AudioDeviceInfo.TYPE_USB_HEADSET) return "USB_HEADSET";
        return "TYPE_" + type;
    }

    /**
     * Phone-mic capture loop: no LC3 decode, no arm bookkeeping, no frame
     * metadata — AudioRecord already delivers the pipeline's PCM format. The
     * blocking read returns every chunk (50 ms), which bounds how long a
     * stop() waits for the loop to notice `started` dropped.
     */
    private void processPhoneAudio(android.media.AudioRecord record) {
        short[] pcm = new short[PHONE_MIC_CHUNK_SAMPLES];
        boolean loggedRoutedDevice = false;
        while (started && !Thread.currentThread().isInterrupted()) {
            int read = record.read(pcm, 0, pcm.length);
            if (read < 0) {
                Log.w(TAG, "phone mic read failed: " + read);
                return;
            }
            if (read == 0) {
                continue;
            }
            if (!loggedRoutedDevice) {
                // AudioRecord.getRoutedDevice() reports the device actually in
                // use, populated once real audio has started flowing (may be
                // null on the very first call right after startRecording()).
                // This is the ground-truth check for the hearing-aid routing
                // question: setPreferredDevice() above is only a request, and
                // per Android's own docs "the user can manually override this
                // preference in device settings" -- so this line, not the
                // request log in openPhoneMic(), is what a real device test
                // must grep for. Logged once per capture, not every chunk.
                loggedRoutedDevice = true;
                android.media.AudioDeviceInfo routed = record.getRoutedDevice();
                Log.i(TAG, "phone mic capture active; routedDevice=" + (routed == null
                        ? "unknown (not yet reported)"
                        : describeAudioDeviceType(routed.getType()) + " " + routed.getProductName()));
                FaceclawVoiceCaptureReceipt r = receipt;
                if (r != null) {
                    r.setRoutedAtFirstAudio(deviceOf(routed));
                    sampleClientSilenced(record, r);
                }
            }
            decodedSamples += read;
            processPcmChunk(pcm, read, 0, 0, false);
        }
    }

    /**
     * The segmenter's view of this controller: the recognizer, the receipt,
     * logcat and the listener. Called on the capture worker thread only.
     */
    private final class SegmenterHost implements FaceclawTranscriptSegmenter.Host {
        @Override
        public boolean hasRecognizer() {
            return recognizer != null;
        }

        @Override
        public String recognize(float[] normalized, String kind, FaceclawOnboardAsr.GateResult gate) {
            OfflineRecognizer currentRecognizer = recognizer;
            if (currentRecognizer == null) {
                return "";
            }
            FaceclawVoiceCaptureReceipt r = receipt;
            long segmentAudioMs = normalized.length * 1000L / SAMPLE_RATE;
            long decodeStartMs = SystemClock.elapsedRealtime();
            OfflineStream offlineStream = currentRecognizer.createStream();
            try {
                offlineStream.acceptWaveform(normalized, SAMPLE_RATE);
                currentRecognizer.decode(offlineStream);
                OfflineRecognizerResult result = currentRecognizer.getResult(offlineStream);
                String raw = result == null ? "" : result.getText();
                String text = raw == null ? "" : raw.trim();
                // Whisper writes non-speech as bracketed tags ([BLANK_AUDIO],
                // [ Silence ], (wind blowing)). A segment that is nothing but tags
                // is not words: drop it before it reaches the transcript. Tags
                // inside real speech stay; see FaceclawNonSpeechTags.
                String droppedTag = null;
                if (FaceclawNonSpeechTags.isNonSpeechOnly(text)) {
                    droppedTag = text;
                    text = "";
                    Log.i(TAG, "dropped non-speech segment kind=" + kind + " text=\"" + droppedTag + "\"");
                }
                if (r != null) {
                    int index = r.noteSegment(kind, segmentAudioMs, gate.peak, gate.level,
                            SystemClock.elapsedRealtime() - decodeStartMs, false, text.length());
                    if (droppedTag != null) {
                        r.noteTagDropped(index, kind, droppedTag);
                    }
                }
                return text;
            } finally {
                offlineStream.release();
            }
        }

        @Override
        public void gated(String kind, int sampleCount, FaceclawOnboardAsr.GateResult gate) {
            FaceclawVoiceCaptureReceipt r = receipt;
            if (r != null) {
                r.noteSegment(kind, sampleCount * 1000L / SAMPLE_RATE, gate.peak, gate.level, 0, true, 0);
            }
        }

        @Override
        public void transcript(String text, boolean isFinal, int segmentSampleCount, double totalAudioSec) {
            String preview = text.length() <= TRANSCRIPT_LOG_PREVIEW_CHARS
                    ? text : text.substring(0, TRANSCRIPT_LOG_PREVIEW_CHARS) + "...";
            Log.i(TAG, transcript.model().logLabel + " decode final=" + isFinal
                    + " audioSec=" + String.format(java.util.Locale.US, "%.2f", totalAudioSec)
                    + " segmentAudioSec=" + String.format(java.util.Locale.US, "%.2f", segmentSampleCount / (double) SAMPLE_RATE)
                    + " textLen=" + text.length() + " text=\"" + preview + "\"");
            emitTranscript(text, isFinal);
        }

        @Override
        public long elapsedMs() {
            return SystemClock.elapsedRealtime();
        }
    }

    private void emitPcm(short[] pcm, int count) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null || count <= 0) {
            return;
        }
        byte[] le = new byte[count * 2];
        for (int i = 0; i < count; i++) {
            short s = pcm[i];
            le[i * 2] = (byte) (s & 0xff);
            le[i * 2 + 1] = (byte) ((s >> 8) & 0xff);
        }
        mainHandler.post(() -> currentListener.onPcm(le));
    }

    /**
     * Embed the session's buffered utterance and compare it to the enrolled
     * wearer voice-print. Fails open: a session too short to verify, or a
     * model that will not load, counts as the wearer rather than silencing
     * every command.
     */
    private void runSpeakerVerification() {
        short[] buffer = verifyBuffer;
        float[] wearer = verifyWearerEmbedding;
        String modelPath = verifySpeakerModelPath;
        verifyBuffer = null;
        if (buffer == null || wearer == null || modelPath == null) {
            return;
        }
        if (verifyCount < VERIFY_MIN_SAMPLES) {
            emitSpeakerVerified(true, 0f);
            return;
        }
        FaceclawSpeakerId speakerId = cachedSpeakerId(modelPath);
        try {
            byte[] le = new byte[verifyCount * 2];
            for (int i = 0; i < verifyCount; i++) {
                short s = buffer[i];
                le[i * 2] = (byte) (s & 0xff);
                le[i * 2 + 1] = (byte) ((s >> 8) & 0xff);
            }
            float[] embedding = speakerId.embed(le, SAMPLE_RATE);
            if (embedding == null || embedding.length != wearer.length) {
                emitSpeakerVerified(true, 0f);
                return;
            }
            double dot = 0;
            for (int i = 0; i < embedding.length; i++) {
                dot += (double) embedding[i] * wearer[i];
            }
            boolean isWearer = dot >= verifyThreshold;
            Log.i(TAG, "speaker verification similarity=" + String.format(java.util.Locale.US, "%.3f", dot)
                    + " threshold=" + verifyThreshold + " isWearer=" + isWearer);
            emitSpeakerVerified(isWearer, (float) dot);
        } catch (Throwable t) {
            Log.w(TAG, "speaker verification failed", t);
            emitSpeakerVerified(true, 0f);
        }
    }

    // The 28 MB embedding model takes seconds to load; keep one instance
    // across capture sessions so verification adds only the embed time.
    private static FaceclawSpeakerId sharedSpeakerId;
    private static String sharedSpeakerIdPath;

    private static synchronized FaceclawSpeakerId cachedSpeakerId(String modelPath) {
        if (sharedSpeakerId == null || !modelPath.equals(sharedSpeakerIdPath)) {
            if (sharedSpeakerId != null) {
                sharedSpeakerId.close();
            }
            sharedSpeakerId = new FaceclawSpeakerId(modelPath);
            sharedSpeakerIdPath = modelPath;
        }
        return sharedSpeakerId;
    }

    private void emitSpeakerVerified(boolean isWearer, float similarity) {
        FaceclawVoiceCaptureReceipt r = receipt;
        if (r != null) {
            r.setVerification(isWearer, similarity);
        }
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onSpeakerVerified(isWearer, similarity));
    }

    private void emitFrameMeta(int angleDegrees, int ssr) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onFrameMeta(angleDegrees, ssr));
    }

    private void emitSpeechEnd() {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(currentListener::onSpeechEnd);
    }

    /**
     * Decides when a hands-free utterance is over, so "Hey Even" capture can
     * stop without a button release.
     *
     * Runs on the decoded 16 kHz PCM, so it works the same in every input mode
     * (the cloud path never sees the samples on this side, and the onboard
     * recognizer's own endpointing only covers ONBOARD).
     *
     * Timing is measured on the sample clock rather than the wall clock: BLE
     * delivers mic packets in bursts, so elapsed real time badly overestimates
     * how much audio has actually been heard.
     *
     * The threshold is relative to a noise floor measured over the first
     * {@link #CALIBRATE_MS} of the session, which is roughly the interval where
     * the user is reacting to the dialog appearing and not yet speaking.
     */
    private static final class EndpointDetector {
        /** Audio used to estimate the room's noise floor. */
        private static final int CALIBRATE_MS = 300;
        /** Speech must exceed this multiple of the noise floor to count as onset. */
        private static final double ONSET_FACTOR = 3.0;
        /** Below this multiple of the noise floor counts as silence again. */
        private static final double RELEASE_FACTOR = 1.8;
        /** Absolute floor, so a silent room can't make the threshold ~0. */
        private static final double MIN_RMS = 220.0;
        /** Trailing silence that ends an utterance. */
        private static final int SILENCE_MS = 900;
        /** If the user never speaks, give up rather than record forever. */
        private static final int LEAD_IN_MS = 6000;
        /** Hard cap on a single utterance. */
        private static final int MAX_UTTERANCE_MS = 30000;

        private long totalSamples;
        private double noiseAccum;
        private int noisePackets;
        private double threshold;
        private boolean speechStarted;
        private long silenceSamples;
        private boolean fired;

        void reset() {
            totalSamples = 0;
            noiseAccum = 0;
            noisePackets = 0;
            threshold = 0;
            speechStarted = false;
            silenceSamples = 0;
            fired = false;
        }

        /** Returns true exactly once, on the packet that ends the utterance. */
        boolean accept(short[] pcm, int count) {
            if (fired || count <= 0) {
                return false;
            }
            totalSamples += count;
            long elapsedMs = totalSamples * 1000L / SAMPLE_RATE;

            double sumSquares = 0;
            for (int i = 0; i < count; i++) {
                double s = pcm[i];
                sumSquares += s * s;
            }
            double rms = Math.sqrt(sumSquares / count);

            if (elapsedMs <= CALIBRATE_MS) {
                noiseAccum += rms;
                noisePackets++;
                return false;
            }
            if (threshold == 0) {
                double noiseFloor = noisePackets > 0 ? noiseAccum / noisePackets : 0;
                threshold = Math.max(noiseFloor, MIN_RMS);
            }

            if (!speechStarted) {
                if (rms >= threshold * ONSET_FACTOR) {
                    speechStarted = true;
                    silenceSamples = 0;
                } else if (elapsedMs >= LEAD_IN_MS) {
                    // Never heard anything; close the dialog rather than hang.
                    fired = true;
                    return true;
                }
                return false;
            }

            if (rms < threshold * RELEASE_FACTOR) {
                silenceSamples += count;
                if (silenceSamples * 1000L / SAMPLE_RATE >= SILENCE_MS) {
                    fired = true;
                    return true;
                }
            } else {
                silenceSamples = 0;
            }

            if (elapsedMs >= MAX_UTTERANCE_MS) {
                fired = true;
                return true;
            }
            return false;
        }
    }

    private void stopG2Audio() {
        FaceclawBleCommunicator currentCommunicator = communicator;
        if (currentCommunicator != null) {
            currentCommunicator.stopG2AudioCapture();
        }
        maybeEmitAudioStats(true);
    }

    private void releaseSherpa() {
        if (recognizer != null) {
            recognizer.release();
            recognizer = null;
        }
    }

    private void releaseLc3() {
        if (lc3Decoder != null) {
            lc3Decoder.close();
            lc3Decoder = null;
        }
    }

    private void queueAudioPacket(byte[] data, String arm, long arrivalMs) {
        if (data == null || !withinAudioGrace()) {
            return;
        }
        if (!"L".equals(arm)) {
            wrongArmPackets++;
        }
        synchronized (audioQueueLock) {
            if (audioQueue.size() >= MAX_AUDIO_QUEUE_PACKETS) {
                audioQueue.removeFirst();
                queueDroppedPackets++;
            }
            audioQueue.addLast(new AudioPacket(data, arm, arrivalMs));
            queuedPackets++;
            if (lastPacketArrivalMs > 0) {
                long delta = arrivalMs - lastPacketArrivalMs;
                if (delta > maxInterPacketMs) {
                    maxInterPacketMs = delta;
                }
                if (delta > LATE_PACKET_INTERVAL_MS) {
                    latePackets++;
                }
            }
            lastPacketArrivalMs = arrivalMs;
            audioQueueLock.notifyAll();
        }
    }

    private AudioPacket takeAudioPacket() {
        synchronized (audioQueueLock) {
            while (withinAudioGrace() && audioQueue.isEmpty()) {
                try {
                    audioQueueLock.wait(250);
                    maybeEmitAudioStats(false);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return null;
                }
            }
            return audioQueue.pollFirst();
        }
    }

    private void resetAudioStats() {
        queuedPackets = 0;
        queueDroppedPackets = 0;
        decodedSamples = 0;
        latePackets = 0;
        wrongArmPackets = 0;
        lastPacketArrivalMs = 0;
        maxInterPacketMs = 0;
        lastStatsAtMs = SystemClock.elapsedRealtime();
    }

    private void maybeEmitAudioStats(boolean force) {
        long now = SystemClock.elapsedRealtime();
        if (!force && now - lastStatsAtMs < STATS_INTERVAL_MS) {
            return;
        }
        lastStatsAtMs = now;
        FaceclawLc3Decoder currentDecoder = lc3Decoder;
        long real = currentDecoder == null ? 0 : currentDecoder.getRealPackets();
        long duplicate = currentDecoder == null ? 0 : currentDecoder.getDuplicatePackets();
        long missing = currentDecoder == null ? 0 : currentDecoder.getMissingPackets();
        long decodeErrors = currentDecoder == null ? 0 : currentDecoder.getDecodeErrors();
        String status = "G2 mic packets=" + queuedPackets
                + " decoded=" + real
                + " missing=" + missing
                + " duplicate=" + duplicate
                + " late=" + latePackets
                + " maxGapMs=" + maxInterPacketMs
                + "\n"
                + " queueDrop=" + queueDroppedPackets
                + " decodeErrors=" + decodeErrors
                + " wrongArm=" + wrongArmPackets
                + " audioSec=" + String.format(java.util.Locale.US, "%.1f", decodedSamples / (double) SAMPLE_RATE);
        // Audio-pipeline stats are diagnostic; keep them in logcat only, out of
        // the on-glasses voice UI.
        Log.i(TAG, status.replace('\n', ' ') + " expectedIntervalMs=" + EXPECTED_PACKET_INTERVAL_MS);
    }

    private void emitStatus(String status) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        mainHandler.post(() -> currentListener.onStatus(status));
    }

    private void emitTranscript(String text, boolean isFinal) {
        FaceclawVoiceControllerListener currentListener = listener;
        if (currentListener == null) {
            return;
        }
        Log.i(TAG, "Emit transcript final=" + isFinal + " textLen=" + (text == null ? 0 : text.trim().length()));
        mainHandler.post(() -> currentListener.onTranscript(text, isFinal));
    }

    private static final class AudioPacket {
        final byte[] data;
        final String arm;
        final long arrivalMs;

        AudioPacket(byte[] data, String arm, long arrivalMs) {
            this.data = data;
            this.arm = arm == null ? "?" : arm;
            this.arrivalMs = arrivalMs;
        }
    }
}
