package android.util;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.List;

/**
 * Harness-only stand-in for android.util.Log. Every line is kept in memory
 * (the harness asserts on them) and echoed to stdout when {@link #echo} is set.
 */
public final class Log {
    public static final int VERBOSE = 2;
    public static final int DEBUG = 3;
    public static final int INFO = 4;
    public static final int WARN = 5;
    public static final int ERROR = 6;
    public static final int ASSERT = 7;

    private static final List<String> LINES = new ArrayList<>();
    public static volatile boolean echo = false;

    private Log() {}

    private static int put(String level, String tag, String msg, Throwable tr) {
        String line = level + "/" + tag + ": " + msg + (tr == null ? "" : " :: " + tr);
        synchronized (LINES) {
            LINES.add(line);
        }
        if (echo) {
            System.out.println("    log " + line);
        }
        return 0;
    }

    /** Harness: a copy of every line logged so far. */
    public static List<String> lines() {
        synchronized (LINES) {
            return new ArrayList<>(LINES);
        }
    }

    /** Harness: lines logged since index {@code from}. */
    public static List<String> linesSince(int from) {
        synchronized (LINES) {
            return new ArrayList<>(LINES.subList(Math.min(from, LINES.size()), LINES.size()));
        }
    }

    public static int size() {
        synchronized (LINES) {
            return LINES.size();
        }
    }

    public static int v(String tag, String msg) { return put("V", tag, msg, null); }
    public static int v(String tag, String msg, Throwable tr) { return put("V", tag, msg, tr); }
    public static int d(String tag, String msg) { return put("D", tag, msg, null); }
    public static int d(String tag, String msg, Throwable tr) { return put("D", tag, msg, tr); }
    public static int i(String tag, String msg) { return put("I", tag, msg, null); }
    public static int i(String tag, String msg, Throwable tr) { return put("I", tag, msg, tr); }
    public static int w(String tag, String msg) { return put("W", tag, msg, null); }
    public static int w(String tag, String msg, Throwable tr) { return put("W", tag, msg, tr); }
    public static int w(String tag, Throwable tr) { return put("W", tag, "", tr); }
    public static int e(String tag, String msg) { return put("E", tag, msg, null); }
    public static int e(String tag, String msg, Throwable tr) { return put("E", tag, msg, tr); }
    public static int wtf(String tag, String msg) { return put("F", tag, msg, null); }
    public static int wtf(String tag, String msg, Throwable tr) { return put("F", tag, msg, tr); }
    public static int println(int priority, String tag, String msg) { return put("P" + priority, tag, msg, null); }
    public static boolean isLoggable(String tag, int level) { return true; }

    public static String getStackTraceString(Throwable tr) {
        if (tr == null) return "";
        StringWriter sw = new StringWriter();
        tr.printStackTrace(new PrintWriter(sw));
        return sw.toString();
    }
}
