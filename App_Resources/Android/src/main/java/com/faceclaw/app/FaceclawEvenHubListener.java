package com.faceclaw.app;

/**
 * Callbacks from a hosted EvenHub app's WebView to the TypeScript host.
 * All methods are delivered on the Android main thread (NativeScript's JS
 * thread), regardless of which WebView-internal thread produced them.
 */
public interface FaceclawEvenHubListener {
    /**
     * The app invoked window.flutter_inappwebview.callHandler(handlerName, ...args).
     * argsJson is the JSON-encoded argument array; callId identifies the
     * promise to resolve via window.__fcResolve(callId, ok, value).
     */
    void onEvenAppMessage(String handlerName, String argsJson, int callId);

    /** The WebView finished loading the app's page. */
    void onPageFinished(String url);
}
