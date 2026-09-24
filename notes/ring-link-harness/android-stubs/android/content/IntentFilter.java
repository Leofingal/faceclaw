package android.content;

import java.util.ArrayList;
import java.util.List;

/** Harness-only stand-in: android.jar's constructor throws "Stub!". */
public class IntentFilter {
    private final List<String> actions = new ArrayList<>();

    public IntentFilter() {
    }

    public final void addAction(String action) {
        actions.add(action);
    }
}
