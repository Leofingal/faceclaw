package com.faceclaw.app;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.app.ApplicationStartInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Process;
import android.os.SystemClock;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * One {@code processStart} line per app process, in the glasses-link journal
 * ({@code files/health/glasses-link.jsonl}), 2026-10-04.
 *
 * <p>Answers "why did the app (re)start" without adb: Android 15+ keeps an
 * ApplicationStartInfo per start (launcher, boot, a service such as the sticky
 * foreground service or the Wear listener, a broadcast, an alarm, ...), and
 * every Android 11+ keeps the previous process's exit (the 09-30 restart was a
 * SIGKILL at 1.1 GB, found only through {@code dumpsys activity exit-info}).
 * Called once from app.ts at JS start; a second call in the same process does
 * nothing. Never throws.
 */
public final class FaceclawProcessStart {
    private static boolean recorded;

    private FaceclawProcessStart() {
    }

    public static synchronized void record(Context context) {
        if (recorded || context == null) {
            return;
        }
        recorded = true;
        try {
            long wallMs = System.currentTimeMillis();
            int pid = Process.myPid();
            long sinceStartMs = SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime();
            StringBuilder out = new StringBuilder(256);
            out.append("{\"type\":\"processStart\",\"at\":\"").append(RingProtocol.localStamp(wallMs)).append('"');
            out.append(",\"atMs\":").append(wallMs);
            out.append(",\"pid\":").append(pid);
            out.append(",\"sinceStartMs\":").append(sinceStartMs);
            out.append(",\"sdk\":").append(Build.VERSION.SDK_INT);
            ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null && Build.VERSION.SDK_INT >= 35) {
                appendStartInfo(out, am, pid);
            }
            if (am != null && Build.VERSION.SDK_INT >= 30) {
                appendLastExit(out, am, context.getPackageName(), pid);
            }
            out.append('}');
            File dir = new File(context.getFilesDir(), "health");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            try (FileOutputStream stream = new FileOutputStream(
                    new File(dir, FaceclawBleCommunicator.GLASSES_LINK_FILE), true)) {
                stream.write((out + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable ignored) {
            // diagnostics only
        }
    }

    private static void appendStartInfo(StringBuilder out, ActivityManager am, int pid) {
        try {
            List<ApplicationStartInfo> starts = am.getHistoricalProcessStartReasons(4);
            for (ApplicationStartInfo info : starts) {
                if (info.getPid() != pid) {
                    continue;
                }
                out.append(",\"reason\":\"").append(startReasonName(info.getReason())).append('"');
                out.append(",\"startType\":\"").append(startTypeName(info.getStartType())).append('"');
                out.append(",\"forceStopped\":").append(info.wasForceStopped());
                Intent intent = info.getIntent();
                if (intent != null) {
                    ComponentName component = intent.getComponent();
                    if (component != null) {
                        out.append(",\"component\":\"").append(RingProtocol.jsonSafe(component.getShortClassName())).append('"');
                    }
                    if (intent.getAction() != null) {
                        out.append(",\"action\":\"").append(RingProtocol.jsonSafe(intent.getAction())).append('"');
                    }
                }
                return;
            }
            out.append(",\"reason\":\"no-record\"");
        } catch (Throwable t) {
            out.append(",\"reason\":\"error\"");
        }
    }

    private static void appendLastExit(StringBuilder out, ActivityManager am, String pkg, int pid) {
        try {
            List<ApplicationExitInfo> exits = am.getHistoricalProcessExitReasons(pkg, 0, 2);
            for (ApplicationExitInfo info : exits) {
                if (info.getPid() == pid) {
                    continue;
                }
                out.append(",\"lastExit\":{\"reason\":").append(info.getReason());
                out.append(",\"atMs\":").append(info.getTimestamp());
                out.append(",\"pid\":").append(info.getPid());
                out.append(",\"rssKb\":").append(info.getRss());
                String description = info.getDescription();
                if (description != null) {
                    String d = description.length() > 120 ? description.substring(0, 120) : description;
                    out.append(",\"description\":\"").append(RingProtocol.jsonSafe(d)).append('"');
                }
                out.append('}');
                return;
            }
        } catch (Throwable ignored) {
            // diagnostics only
        }
    }

    private static String startReasonName(int reason) {
        switch (reason) {
            case ApplicationStartInfo.START_REASON_ALARM: return "alarm";
            case ApplicationStartInfo.START_REASON_BACKUP: return "backup";
            case ApplicationStartInfo.START_REASON_BOOT_COMPLETE: return "boot";
            case ApplicationStartInfo.START_REASON_BROADCAST: return "broadcast";
            case ApplicationStartInfo.START_REASON_CONTENT_PROVIDER: return "content-provider";
            case ApplicationStartInfo.START_REASON_JOB: return "job";
            case ApplicationStartInfo.START_REASON_LAUNCHER: return "launcher";
            case ApplicationStartInfo.START_REASON_LAUNCHER_RECENTS: return "recents";
            case ApplicationStartInfo.START_REASON_OTHER: return "other";
            case ApplicationStartInfo.START_REASON_PUSH: return "push";
            case ApplicationStartInfo.START_REASON_SERVICE: return "service";
            case ApplicationStartInfo.START_REASON_START_ACTIVITY: return "start-activity";
            default: return "code-" + reason;
        }
    }

    private static String startTypeName(int type) {
        switch (type) {
            case ApplicationStartInfo.START_TYPE_COLD: return "cold";
            case ApplicationStartInfo.START_TYPE_WARM: return "warm";
            case ApplicationStartInfo.START_TYPE_HOT: return "hot";
            default: return "unset";
        }
    }
}
