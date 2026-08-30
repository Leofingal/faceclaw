package com.faceclaw.app;

import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.util.Consumer;
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter;
import androidx.window.layout.DisplayFeature;
import androidx.window.layout.FoldingFeature;
import androidx.window.layout.WindowInfoTracker;
import androidx.window.layout.WindowLayoutInfo;
import androidx.window.layout.WindowMetricsCalculator;

import java.util.concurrent.Executor;

/**
 * Fold posture and window size for the current Activity, from Jetpack
 * WindowManager (androidx.window).
 *
 * Two separate facts, reported together, because the phone UI needs both and
 * neither answers the other's question:
 *
 *   THE HINGE (FoldingFeature) is present only while the window is on the
 *   inner display. Folded shut, a Galaxy Fold runs the app on the cover
 *   display, which is an ordinary display with no hinge crossing it — so "no
 *   folding feature" is the cover screen's signature, not a failure to detect
 *   one. That asymmetry is why posture alone cannot drive a layout.
 *
 *   THE WINDOW SIZE, in dp, from WindowMetricsCalculator. This is the window,
 *   not the display: it is what layout actually has to fit into (multi-window
 *   and free-form included), and it is the only one of the two that means
 *   anything on a device with no hinge at all.
 *
 * isFoldable is reported so the caller can tell "cover screen" from "an
 * ordinary narrow phone", which width alone cannot. It is true when the
 * platform reports a hinge-angle sensor (Samsung foldables do, API 30+) or
 * when this process has ever been handed a FoldingFeature — the sensor check
 * covers the case where the app launched straight onto the cover screen and
 * has therefore never seen a hinge.
 */
public final class FaceclawFoldState {
    private static final String TAG = "FaceclawFoldState";

    /** Inner display, fully open (or a device whose hinge reports flat). */
    public static final String POSTURE_FLAT = "flat";
    /** Inner display, part-way open — tabletop / book posture. */
    public static final String POSTURE_HALF_OPENED = "half-opened";
    /** No hinge in this window: the cover screen, or a device without one. */
    public static final String POSTURE_NONE = "none";

    private static WindowInfoTrackerCallbackAdapter adapter;
    private static Consumer<WindowLayoutInfo> consumer;
    /** Sticky: a device that has ever shown a hinge is a foldable, on every screen. */
    private static boolean everSawHinge;

    private FaceclawFoldState() {
    }

    /**
     * Begin tracking the given Activity's window. Replaces any previous
     * registration, so a recreated Activity can call this again without the
     * caller having to unregister first.
     *
     * Delivers one reading immediately (the tracker's own first callback can
     * be a frame or two out), then one per layout change.
     */
    public static synchronized void start(Activity activity, FaceclawFoldStateListener listener) {
        if (activity == null || listener == null) {
            return;
        }
        stop();

        final Activity boundActivity = activity;
        final FaceclawFoldStateListener boundListener = listener;

        // Size is available synchronously and never fails; report it before
        // touching the tracker so a caller gets a usable reading even if the
        // library below is missing or throws.
        emit(boundActivity, boundListener, POSTURE_NONE, false);

        try {
            adapter = new WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(activity));
        } catch (Throwable t) {
            Log.w(TAG, "window layout tracking unavailable; size-only readings", t);
            adapter = null;
            return;
        }

        consumer = new Consumer<WindowLayoutInfo>() {
            @Override
            public void accept(WindowLayoutInfo info) {
                String posture = POSTURE_NONE;
                boolean hasHinge = false;
                for (DisplayFeature feature : info.getDisplayFeatures()) {
                    if (!(feature instanceof FoldingFeature)) {
                        continue;
                    }
                    FoldingFeature folding = (FoldingFeature) feature;
                    hasHinge = true;
                    everSawHinge = true;
                    posture = FoldingFeature.State.HALF_OPENED.equals(folding.getState())
                            ? POSTURE_HALF_OPENED
                            : POSTURE_FLAT;
                    break;
                }
                emit(boundActivity, boundListener, posture, hasHinge);
            }
        };

        try {
            adapter.addWindowLayoutInfoListener(activity, mainExecutor(), consumer);
        } catch (Throwable t) {
            Log.w(TAG, "could not register window layout listener", t);
            adapter = null;
            consumer = null;
        }
    }

    public static synchronized void stop() {
        if (adapter != null && consumer != null) {
            try {
                adapter.removeWindowLayoutInfoListener(consumer);
            } catch (Throwable t) {
                Log.w(TAG, "could not remove window layout listener", t);
            }
        }
        adapter = null;
        consumer = null;
    }

    /** Whether this device is a foldable at all (see the class comment). */
    public static boolean isFoldable(Context context) {
        if (everSawHinge) {
            return true;
        }
        if (context == null) {
            return false;
        }
        try {
            return context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_SENSOR_HINGE_ANGLE);
        } catch (Throwable t) {
            return false;
        }
    }

    private static void emit(
            Activity activity,
            FaceclawFoldStateListener listener,
            String posture,
            boolean hasHinge
    ) {
        int widthDp = 0;
        int heightDp = 0;
        try {
            Rect bounds = WindowMetricsCalculator.getOrCreate()
                    .computeCurrentWindowMetrics(activity)
                    .getBounds();
            float density = activity.getResources().getDisplayMetrics().density;
            if (density <= 0f) {
                density = 1f;
            }
            widthDp = Math.round(bounds.width() / density);
            heightDp = Math.round(bounds.height() / density);
        } catch (Throwable t) {
            Log.w(TAG, "could not measure the window", t);
        }
        try {
            listener.onFoldStateChanged(posture, widthDp, heightDp, hasHinge, isFoldable(activity));
        } catch (Throwable t) {
            Log.w(TAG, "fold state listener threw", t);
        }
    }

    private static Executor mainExecutor() {
        final Handler handler = new Handler(Looper.getMainLooper());
        return new Executor() {
            @Override
            public void execute(Runnable command) {
                handler.post(command);
            }
        };
    }
}
