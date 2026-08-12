/**
 * Registry of running EvenHub apps. Each launched package gets its own glasses
 * window, session, and persistent WebView — they run concurrently and keep
 * driving their windows in the background (the shell delivers FOREGROUND_ENTER/
 * EXIT as focus changes; the WebView host keeps them rendering while unseen).
 *
 * Glasses-first: launching does NOT take over the phone screen. The phone
 * stays on the Faceclaw dashboard; an app's phone UI is shown on demand
 * (window menu -> "Show phone UI"), overlaying the dashboard, and the Back
 * button returns to it. Apps are kept alive until explicitly closed (no memory
 * eviction yet).
 */
import { Application } from "@nativescript/core";
import { type AppContext } from "../app-definition";
import {
  appFilesDirPath,
  deletePathRecursively,
  readBinaryFile,
  writeBinaryFile,
} from "../../native/file-access";
import { parseEhpk, parseManifest, utf8Decode } from "./ehpk";
import { EvenHubSession } from "./session";
import { createEvenHubWindow } from "./evenhub-window";
import { createEvenHubWebView, type EvenHubWebView } from "./webview";

type RunningApp = {
  windowId: string;
  session: EvenHubSession;
  webView: EvenHubWebView;
};

const running = new Map<string, RunningApp>();
let nextSerial = 1;
let phoneShownWindowId: string | null = null;
let backHandlerRegistered = false;

/** Intercept Android Back while an app's phone UI is overlaying the dashboard. */
function ensureBackHandler(): void {
  if (backHandlerRegistered) return;
  backHandlerRegistered = true;
  Application.android?.on("activityBackPressed", (args: { cancel: boolean }) => {
    if (phoneShownWindowId) {
      args.cancel = true;
      hidePhone();
    }
  });
}

/**
 * Unpack an .ehpk and launch it as a new concurrent app: a glasses window plus
 * a persistent WebView. Does not disturb other running apps or the phone screen.
 */
export async function launchPackage(ctx: AppContext, ehpkPath: string): Promise<void> {
  const data = readBinaryFile(ehpkPath);
  if (!data) {
    ctx.appendLog(`evenhub: could not read ${ehpkPath}`);
    return;
  }
  const archive = parseEhpk(data);
  const appJson = archive.files.get("app.json");
  if (!appJson) {
    ctx.appendLog("evenhub: package has no app.json");
    return;
  }
  const manifest = parseManifest(utf8Decode(appJson));

  // Unpack fresh into app-private storage, keyed by package id.
  const safeId = manifest.packageId.replace(/[^A-Za-z0-9._-]/g, "_");
  const baseDir = `${appFilesDirPath()}/evenhub-apps/${safeId}`;
  deletePathRecursively(baseDir);
  for (const [name, content] of Array.from(archive.files)) {
    if (!writeBinaryFile(`${baseDir}/${name}`, content)) {
      ctx.appendLog(`evenhub: failed to write ${name}`);
      return;
    }
  }

  const windowId = `evenhub:app:${nextSerial++}`;
  const session = new EvenHubSession(manifest, `${baseDir}/dist`, ctx.appendLog);
  const webView = createEvenHubWebView(session);
  session.attachWebView({
    evaluateJs: webView.evaluateJs,
    destroy: () => {
      if (phoneShownWindowId === windowId) {
        webView.hideOnPhone();
        phoneShownWindowId = null;
      }
      webView.destroy();
      running.delete(windowId);
    },
  });
  running.set(windowId, { windowId, session, webView });
  ensureBackHandler();
  ctx.appendLog(`evenhub: launching ${manifest.name} ${manifest.version} (${manifest.packageId})`);

  await ctx.launchInProcessApp(windowId, `window:${windowId}`, (options) =>
    createEvenHubWindow(windowId, session, options, () => showOnPhone(windowId)),
  );
}

/** Overlay one app's phone UI over the dashboard (from its window menu). */
export function showOnPhone(windowId: string): void {
  const app = running.get(windowId);
  if (!app) return;
  app.webView.showOnPhone();
  phoneShownWindowId = windowId;
}

/** Return the phone to the dashboard (Back, or the shown app closing). */
export function hidePhone(): void {
  if (!phoneShownWindowId) return;
  running.get(phoneShownWindowId)?.webView.hideOnPhone();
  phoneShownWindowId = null;
}

export function runningAppCount(): number {
  return running.size;
}
