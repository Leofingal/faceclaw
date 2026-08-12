/**
 * EvenHub compatibility host: runs apps built for Even Realities' EvenHub
 * API (webview apps talking to the glasses through the phone) inside
 * Faceclaw. Launched by picking an .ehpk file in the Files app; the app gets
 * a phone WebView (its runtime + phone UI) and a 576x288 glasses window
 * composited by Faceclaw instead of the stock firmware.
 *
 * Design notes: notes/evenhub_compatibility.txt.
 */
import { Frame } from "@nativescript/core";
import { type AppContext, type AppDefinition } from "../app-definition";
import { shell } from "../../ui/shell/shell";
import {
  appFilesDirPath,
  deletePathRecursively,
  readBinaryFile,
  writeBinaryFile,
} from "../../native/file-access";
import { parseEhpk, parseManifest, utf8Decode } from "./ehpk";
import { EvenHubSession } from "./session";
import { createEvenHubWindow } from "./evenhub-window";

const EVENHUB_WINDOW_ID = "evenhub:app";

let activeSession: EvenHubSession | null = null;

export function getActiveEvenHubSession(): EvenHubSession | null {
  return activeSession;
}

/**
 * Unpack an .ehpk and launch it: glasses window plus the phone WebView page.
 * Only one EvenHub app runs at a time for now; opening another closes the
 * previous one.
 */
export async function openEvenHubPackage(ctx: AppContext, ehpkPath: string): Promise<void> {
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

  if (activeSession && !activeSession.isClosed()) {
    activeSession.close();
  }

  // Unpack fresh into app-private storage, keyed by package id.
  const safeId = manifest.packageId.replace(/[^A-Za-z0-9._-]/g, "_");
  const baseDir = `${appFilesDirPath()}/evenhub-apps/${safeId}`;
  deletePathRecursively(baseDir);
  for (const [name, content] of archive.files) {
    if (!writeBinaryFile(`${baseDir}/${name}`, content)) {
      ctx.appendLog(`evenhub: failed to write ${name}`);
      return;
    }
  }

  const session = new EvenHubSession(manifest, `${baseDir}/dist`, ctx.appendLog);
  activeSession = session;
  ctx.appendLog(`evenhub: launching ${manifest.name} ${manifest.version} (${manifest.packageId})`);

  await ctx.launchInProcessApp(EVENHUB_WINDOW_ID, `window:${EVENHUB_WINDOW_ID}`, (options) =>
    createEvenHubWindow(EVENHUB_WINDOW_ID, session, options),
  );

  Frame.topmost()?.navigate({ moduleName: "phone-ui/evenhub-page" });
}

const evenhubApp: AppDefinition = {
  appId: "evenhub",
  title: "EvenHub",
  icon: "package",
  // Launching happens by opening an .ehpk in Files; the grid entry would
  // have nothing to open.
  showInLauncher: false,
  launch: async (ctx) => {
    const existing = shell.getWindows().find((window) => window.appId === "evenhub");
    if (existing) {
      shell.focusWindow(existing.windowId);
      ctx.requestShellRender();
    } else {
      ctx.appendLog("EvenHub apps launch from .ehpk files in the Files app");
    }
  },
};

export default evenhubApp;
