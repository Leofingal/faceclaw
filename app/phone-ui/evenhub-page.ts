/**
 * Phone-side host page for a running EvenHub app: a fullscreen native
 * WebView showing the app's web UI. The WebView is also the app's runtime —
 * navigating back closes the app (webview, glasses window, session).
 *
 * The WebView is a raw android.webkit.WebView (via Placeholder) rather than
 * the NativeScript WebView component, so we fully own the WebViewClient
 * (offline asset serving + bridge-shim injection) without fighting the
 * component's own client.
 */
import { Application, CreateViewEventData, Frame, NavigatedData, Page, Utils } from "@nativescript/core";
import { getActiveEvenHubSession } from "../apps/evenhub";
import { EVENHUB_BRIDGE_INJECT_SCRIPT, EvenHubSession } from "../apps/evenhub/session";

declare const android: any;
declare const com: any;

let currentPage: Page | null = null;
let currentWebView: any = null;
let currentSession: EvenHubSession | null = null;

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  const session = getActiveEvenHubSession();
  page.bindingContext = { title: session?.manifest.name ?? "EvenHub" };
  currentPage = page;
}

export function creatingWebView(args: CreateViewEventData): void {
  const session = getActiveEvenHubSession();
  if (!session || session.isClosed()) {
    setTimeout(() => Frame.topmost()?.goBack(), 0);
    return;
  }
  currentSession = session;

  const context = Application.android?.foregroundActivity ?? Utils.android.getApplicationContext();
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
      session.pageFinished();
    },
  });

  const host = evenHubOriginHost(session);
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

  const page = currentPage;
  session.attachPage({
    evaluateJs: (js: string) => {
      try {
        webView.evaluateJavascript(js, null);
      } catch (error) {
        console.warn(`evenhub evaluateJs failed: ${error}`);
      }
    },
    closePage: () => {
      const frame = Frame.topmost();
      if (frame && page && frame.currentPage === page) {
        frame.goBack();
      }
    },
  });

  currentWebView = webView;
  webView.loadUrl(`https://${host}/${session.manifest.entrypoint}`);
  args.view = webView;
}

export function navigatedFrom(args: NavigatedData): void {
  if (!args.isBackNavigation) return;
  const session = currentSession;
  const webView = currentWebView;
  currentSession = null;
  currentWebView = null;
  currentPage = null;
  session?.pageGone();
  if (webView) {
    try {
      webView.destroy();
    } catch (error) {
      console.warn(`evenhub webview destroy failed: ${error}`);
    }
  }
}

/** A distinct (fake, intercepted) https origin per app isolates web storage. */
function evenHubOriginHost(session: EvenHubSession): string {
  const safe = session.manifest.packageId.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  return `${safe}.evenhub.invalid`;
}
