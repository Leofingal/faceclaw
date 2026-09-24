package android.os;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Harness-only stand-in: one daemon thread plays the main looper. The harness
 * sets no communicator listener, so in practice nothing is ever posted here.
 */
public class Handler {
    private static final ExecutorService MAIN = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "harness-main");
        t.setDaemon(true);
        return t;
    });

    public Handler() {
    }

    public Handler(Looper looper) {
    }

    public final boolean post(Runnable r) {
        MAIN.execute(r);
        return true;
    }

    public final boolean postDelayed(Runnable r, long delayMillis) {
        MAIN.execute(() -> {
            SystemClock.sleep(delayMillis);
            r.run();
        });
        return true;
    }

    public final void removeCallbacks(Runnable r) {
    }

    public final void removeCallbacksAndMessages(Object token) {
    }
}
