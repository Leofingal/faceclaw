package android.content;

import java.io.File;

/**
 * Harness-only stand-in for android.content.Context: just the members the
 * communicator touches on the ring-link path, with the exact signatures
 * android.jar declares (the communicator is compiled against android.jar, so a
 * descriptor mismatch here would surface as a NoSuchMethodError, never as a
 * silent difference).
 */
public abstract class Context {
    public static final String POWER_SERVICE = "power";
    public static final String KEYGUARD_SERVICE = "keyguard";
    public static final String BLUETOOTH_SERVICE = "bluetooth";

    public Context getApplicationContext() {
        return this;
    }

    public Object getSystemService(String name) {
        return null;
    }

    public Intent registerReceiver(BroadcastReceiver receiver, IntentFilter filter) {
        return null;
    }

    public void unregisterReceiver(BroadcastReceiver receiver) {
    }

    public abstract File getFilesDir();

    public File getExternalFilesDir(String type) {
        return null;
    }
}
