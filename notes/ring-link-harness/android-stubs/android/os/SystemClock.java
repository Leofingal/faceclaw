package android.os;

/**
 * Harness-only stand-in for Android's SystemClock (ring-link harness,
 * 2026-09-24). NOT shipped: it lives under notes/ and is only ever on the
 * classpath of the plain-JVM harness, ahead of android.jar.
 *
 * <p>Monotonic like the real one, with two harness controls: {@link #advance}
 * jumps the clock (so a 60 s floor or a 5-minute floor can be crossed without
 * waiting), and {@link #speed} runs it faster than real time (so a pull's
 * 1.5 s idle windows do not make the run take minutes). Everything in the
 * communicator reads this one clock, so both controls move every deadline
 * together.
 */
public final class SystemClock {
    private static final long START_NANOS = System.nanoTime();
    /** Starts well above zero: the communicator uses 0 as "never". */
    private static volatile long offsetMs = 10_000_000L;
    /** Virtual ms per real ms. Set once, before anything runs. */
    public static volatile double speed = 1.0;

    private SystemClock() {}

    public static long elapsedRealtime() {
        return offsetMs + (long) ((System.nanoTime() - START_NANOS) / 1_000_000.0 * speed);
    }

    public static long elapsedRealtimeNanos() {
        return elapsedRealtime() * 1_000_000L;
    }

    public static long uptimeMillis() {
        return elapsedRealtime();
    }

    public static long currentThreadTimeMillis() {
        return elapsedRealtime();
    }

    /** Like Android's: sleeps, and swallows (but re-asserts) an interrupt. */
    public static void sleep(long ms) {
        long realMs = Math.max(0L, (long) (ms / speed));
        try {
            Thread.sleep(realMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Harness control: jump the clock forward. */
    public static void advance(long ms) {
        offsetMs += ms;
    }
}
