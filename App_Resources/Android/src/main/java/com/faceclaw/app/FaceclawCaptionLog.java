package com.faceclaw.app;

import android.content.Context;
import android.os.Environment;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Append-only translation log: one JSONL file per local day, one line per
 * caption (built on the TS side, caption-lang.ts). Nothing in the app ever
 * deletes these files; the Microphones retention sweep only touches the
 * conversation database and recordings.
 *
 * <p>Location: Download/Faceclaw/translation-log/ in shared storage, so the
 * phone's file manager can open it and it survives an app data wipe. If that
 * directory can't be written (no all-files access and the file belongs to an
 * earlier install), the line goes to the app's own external files dir
 * (Android/data/com.faceclaw.app/files/translation-log/) instead, and
 * {@link #currentDir()} says which one is in use.
 *
 * <p>Each line is written on a single background thread with open-append,
 * write, fsync, close, so a crash or kill loses at most the line in flight.
 */
public final class FaceclawCaptionLog {
    private static final String TAG = "FaceclawCaptionLog";
    private static final String SUBDIR = "translation-log";

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "FaceclawCaptionLog");
        thread.setDaemon(true);
        return thread;
    });

    private static volatile String currentDir = "";
    private static volatile String lastError = "";
    private static volatile long linesWritten;

    private FaceclawCaptionLog() {
    }

    /** Shared-storage log directory (may not be writable; see class doc). */
    public static String publicDir() {
        File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        return new File(new File(downloads, "Faceclaw"), SUBDIR).getAbsolutePath();
    }

    /** The directory the last line went to, or the shared one before any write. */
    public static String currentDir() {
        String dir = currentDir;
        return dir.isEmpty() ? publicDir() : dir;
    }

    public static String lastError() {
        return lastError;
    }

    public static long linesWritten() {
        return linesWritten;
    }

    /** Queue one line (no trailing newline) for fileName in the log directory. */
    public static void append(Context context, String fileName, String line) {
        if (context == null || fileName == null || line == null) {
            return;
        }
        Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> write(app, fileName, line));
    }

    private static void write(Context context, String fileName, String line) {
        byte[] bytes = (line.replace('\n', ' ') + "\n").getBytes(StandardCharsets.UTF_8);
        File publicDir = new File(publicDir());
        if (tryWrite(publicDir, fileName, bytes)) {
            return;
        }
        File ownDir = context.getExternalFilesDir(SUBDIR);
        if (ownDir == null) {
            ownDir = new File(context.getFilesDir(), SUBDIR);
        }
        if (!tryWrite(ownDir, fileName, bytes)) {
            Log.e(TAG, "translation log write failed in both directories: " + lastError);
        }
    }

    private static boolean tryWrite(File dir, String fileName, byte[] bytes) {
        try {
            if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
                lastError = "mkdirs failed: " + dir;
                return false;
            }
            File file = new File(dir, fileName);
            try (FileOutputStream out = new FileOutputStream(file, true)) {
                out.write(bytes);
                out.flush();
                out.getFD().sync();
            }
            String path = dir.getAbsolutePath();
            if (!path.equals(currentDir)) {
                Log.i(TAG, "translation log directory: " + path);
                currentDir = path;
            }
            linesWritten++;
            return true;
        } catch (Throwable t) {
            lastError = t.getClass().getSimpleName() + ": " + t.getMessage();
            return false;
        }
    }
}
