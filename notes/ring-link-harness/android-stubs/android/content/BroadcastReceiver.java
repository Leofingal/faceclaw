package android.content;

/** Harness-only stand-in: android.jar's constructor throws "Stub!". */
public abstract class BroadcastReceiver {
    public BroadcastReceiver() {
    }

    public abstract void onReceive(Context context, Intent intent);
}
