/**
 * Constructs the Android WebView that runs one EvenHub app and attaches it to
 * the persistent keep-alive host (FaceclawEvenHubWebViewHost), decoupled from
 * any phone Page. The WebView is created at launch and lives until the app's
 * glasses window closes — it renders the app to the glasses whether or not the
 * phone is currently showing it (see the host for the off-screen-render trick).
 *
 * A raw android.webkit.WebView (not the NativeScript component) is used so we
 * fully own the WebViewClient: offline asset serving from a fake per-app origin
 * plus document-start injection of the flutter_inappwebview bridge shim.
 */
import { Application, Utils } from "@nativescript/core";
import { EVENHUB_BRIDGE_INJECT_SCRIPT, type EvenHubSession } from "./session";

declare const android: any;
declare const com: any;

export type EvenHubWebView = {
  evaluateJs: (js: string) => void;
  destroy: () => void;
  showOnPhone: () => void;
  hideOnPhone: () => void;
  /** The native android.webkit.WebView, for the host. */
  native: unknown;
};

/** A distinct (fake, intercepted) https origin per app isolates web storage. */
function originHost(session: EvenHubSession): string {
  const safe = session.manifest.packageId.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  return `${safe}.evenhub.invalid`;
}

/**
 * Build the app's WebView, wire it to the session, attach it to the keep-alive
 * host, and start loading. Must run on the main thread.
 */
export function createEvenHubWebView(session: EvenHubSession): EvenHubWebView {
  const activity = Application.android?.foregroundActivity ?? Application.android?.startActivity;
  const context = activity ?? Utils.android.getApplicationContext();
  const webView = new android.webkit.WebView(context);
  const settings = webView.getSettings();
  settings.setJavaScriptEnabled(true);
  settings.setDomStorageEnabled(true);
  settings.setAllowFileAccess(false);
  settings.setMediaPlaybackRequiresUserGesture(false);

  const listener = new com.faceclaw.app.FaceclawEvenHubListener({
    onEvenAppMessage: (handlerName: string, argsJson: string, callId: number) => {
      session.handleBridgeCall(String(handlerName), String(argsJson), Number(callId));
    },
    onPageFinished: () => {
      session.webViewLoaded();
    },
  });

  const host = originHost(session);
  webView.setWebViewClient(
    new com.faceclaw.app.FaceclawEvenHubWebViewClient(session.distDir, host, EVENHUB_BRIDGE_INJECT_SCRIPT, listener),
  );
  webView.addJavascriptInterface(new com.faceclaw.app.FaceclawEvenHubJsBridge(listener), "__faceclawEvenHub");

  // Surface the app's console in logcat (tag FaceclawEvenHubConsole).
  const ChromeClient = (android.webkit.WebChromeClient as any).extend({
    onConsoleMessage: (message: any): boolean => {
      android.util.Log.i(
        "FaceclawEvenHubConsole",
        `${message.message()} (${message.sourceId()}:${message.lineNumber()})`,
      );
      return true;
    },
  });
  webView.setWebChromeClient(new ChromeClient());

  const nativeHost = com.faceclaw.app.FaceclawEvenHubWebViewHost.getInstance();
  nativeHost.attach(activity, webView);
  webView.loadUrl(`https://${host}/${session.manifest.entrypoint}`);

  return {
    native: webView,
    evaluateJs: (js: string) => {
      try {
        webView.evaluateJavascript(js, null);
      } catch (error) {
        console.warn(`evenhub evaluateJs failed: ${error}`);
      }
    },
    destroy: () => {
      try {
        nativeHost.detach(webView);
      } catch (error) {
        console.warn(`evenhub webview destroy failed: ${error}`);
      }
    },
    showOnPhone: () => nativeHost.showOnPhone(webView),
    hideOnPhone: () => nativeHost.hideOnPhone(),
  };
}
