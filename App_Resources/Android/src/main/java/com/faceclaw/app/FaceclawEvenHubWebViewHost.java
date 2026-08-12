package com.faceclaw.app;

import android.app.Activity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

/**
 * Keeps EvenHub app WebViews alive and rendering while the phone shows the
 * Faceclaw dashboard instead of the app.
 *
 * The problem: an EvenHub app only paints (canvas / requestAnimationFrame) and
 * runs un-throttled timers while its WebView is attached to the window and
 * VISIBLE. Faceclaw is glasses-first — the phone normally shows its own UI, not
 * the app — so the app's WebView must render off-screen.
 *
 * The trick: a single full-screen overlay FrameLayout is inserted as the FIRST
 * child of the activity's content view, i.e. BEHIND the NativeScript UI. Every
 * app WebView lives in it, full-size and VISIBLE, but occluded by the opaque
 * dashboard on top. Chromium doesn't stop rendering a view merely because a
 * sibling covers it (only VISIBILITY flags / detachment / zero-size do that),
 * so the apps keep driving their glasses windows while unseen. Touches go to
 * the NativeScript UI on top.
 *
 * To show one app's UI on the phone, the overlay is raised to the front (and
 * the chosen WebView to the top of the overlay); hiding sends it back behind.
 * All view work happens on the main thread (callers are on the NS/JS thread).
 *
 * Backgrounding note: when the whole activity is not resumed (phone asleep /
 * Faceclaw not foregrounded) the platform stops producing frames for these
 * WebViews regardless — true screen-off rendering is a separate, harder problem.
 */
public class FaceclawEvenHubWebViewHost {
    private static FaceclawEvenHubWebViewHost instance;

    private FrameLayout overlay;
    private boolean shown = false;

    public static synchronized FaceclawEvenHubWebViewHost getInstance() {
        if (instance == null) instance = new FaceclawEvenHubWebViewHost();
        return instance;
    }

    private FrameLayout ensureOverlay(Activity activity) {
        if (overlay != null) return overlay;
        ViewGroup content = activity.findViewById(android.R.id.content);
        overlay = new FrameLayout(activity);
        // index 0 = behind the NativeScript content view.
        content.addView(overlay, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return overlay;
    }

    /** Add a WebView to the host, full-size and rendering, hidden behind the UI. */
    public void attach(Activity activity, WebView web) {
        FrameLayout o = ensureOverlay(activity);
        web.setVisibility(View.VISIBLE);
        if (web.getParent() == null) {
            o.addView(web, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        // resumeTimers() is process-global; make sure nothing left timers paused.
        web.resumeTimers();
    }

    /** Bring an app's WebView to the front so it is visible on the phone. */
    public void showOnPhone(WebView web) {
        if (overlay == null) return;
        web.bringToFront();
        overlay.bringToFront();
        shown = true;
    }

    /** Send the overlay back behind the NativeScript UI. */
    public void hideOnPhone() {
        shown = false;
        if (overlay == null) return;
        ViewGroup content = (ViewGroup) overlay.getParent();
        if (content != null) {
            content.removeView(overlay);
            content.addView(overlay, 0);
        }
    }

    public boolean isShown() {
        return shown;
    }

    /** Remove and destroy a WebView (its app is closing). */
    public void detach(WebView web) {
        if (overlay != null) overlay.removeView(web);
        web.destroy();
    }
}
