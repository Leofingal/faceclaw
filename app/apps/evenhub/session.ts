/**
 * One running EvenHub app: the host side of the SDK's
 * flutter_inappwebview.callHandler('evenAppMessage', ...) contract, the page
 * container state, and the glue between the phone WebView and the glasses
 * window. Wire shapes were captured empirically from even_hub_sdk 0.0.12
 * (see notes/evenhub_compatibility.txt).
 *
 * Wire contract summary:
 *  - Web -> host: callHandler('evenAppMessage', '<json>') where the JSON is
 *    {type: "call_even_app_method", method, data?}. The handler's return
 *    value resolves the app-side promise (no response postMessage).
 *  - Host -> web: call window._listenEvenAppMessage({type:
 *    "listen_even_app_data", method, data}); for method "evenHubEvent", data
 *    is {type: "sysEvent"|"textEvent"|"listEvent", jsonData: {...}}.
 *  - Return values: createStartUpPageContainer -> int 0..3;
 *    updateImageRawData -> int 0..3 or enum string; rebuild/textUpgrade/
 *    shutDown/setLocalStorage -> boolean; getLocalStorage -> string;
 *    getUserInfo/getGlassesInfo -> plain JSON objects (not strings).
 */
import { ApplicationSettings } from "@nativescript/core";
import { GrayImage } from "../../graphics/image";
import { EvenHubFont } from "../../graphics/evenhub-font";
import { type DashboardInputEvent } from "../../ui/layers";
import {
  asRecord,
  eventCaptureContainer,
  parsePage,
  readNumber,
  readOptionalNumber,
  readString,
  type EvenHubImageContainer,
  type EvenHubListContainer,
  type EvenHubPage,
} from "./containers";
import { compositePage } from "./compositor";
import { type EvenHubManifest } from "./ehpk";
import { permissionsIncludeMicrophone, permissionsInclude } from "./permissions";
import { evenHubMicRouter, type EvenHubMicClient } from "./mic-router";
import { getCurrentLocation } from "../../native/location";
import { LocationTracker, type TrackedLocation } from "../../native/location-tracker";
import { ensureFineLocationPermission } from "../../g2/android-permissions";

const UPNG = require("upng-js");

/** OsEventTypeList values (PB ordinals). */
const CLICK_EVENT = 0;
const SCROLL_TOP_EVENT = 1;
const SCROLL_BOTTOM_EVENT = 2;
const DOUBLE_CLICK_EVENT = 3;
const FOREGROUND_ENTER_EVENT = 4;
const FOREGROUND_EXIT_EVENT = 5;
const SYSTEM_EXIT_EVENT = 7;

/**
 * Injected into every served HTML document at document start (before any app
 * JS): (1) the promise-returning flutter_inappwebview.callHandler the EvenHub
 * SDK expects, backed by the FaceclawEvenHubJsBridge Java object; and (2) a
 * host-driven setTimeout/setInterval/requestAnimationFrame replacement that
 * survives the screen-off throttle (fired by the native ticker in
 * FaceclawEvenHubWebViewHost). Kept in ES5 so it runs on any webview.
 */
export const EVENHUB_BRIDGE_INJECT_SCRIPT = `
(function () {
  if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) return;
  var pending = {};
  var nextId = 1;
  window.__fcResolve = function (id, ok, value) {
    var entry = pending[id];
    if (!entry) return;
    delete pending[id];
    (ok ? entry[0] : entry[1])(value);
  };
  window.flutter_inappwebview = {
    callHandler: function (name) {
      var args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending[id] = [resolve, reject];
        window.__faceclawEvenHub.postMessage(String(name), JSON.stringify(args), id);
      });
    }
  };
})();
(function () {
  // Host-driven timers. Chromium heavily throttles a page's own
  // setTimeout/setInterval when the phone screen is off, which slows
  // timer-driven apps to a crawl. Replace them with a queue fired by
  // window.__fcTimerTick(), which the native host calls at ~60Hz regardless of
  // screen state (host-initiated evaluateJavascript escapes the throttle).
  if (window.__fcTimerTick) return;
  var timers = new Map();
  var nextId = 1;
  window.setTimeout = function (cb, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nextId++;
    timers.set(id, { cb: cb, args: args, due: Date.now() + (+delay || 0), interval: 0 });
    return id;
  };
  window.setInterval = function (cb, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nextId++;
    var d = +delay || 0;
    timers.set(id, { cb: cb, args: args, due: Date.now() + d, interval: d });
    return id;
  };
  window.clearTimeout = function (id) { timers.delete(id); };
  window.clearInterval = function (id) { timers.delete(id); };
  window.__fcTimerTick = function () {
    var now = Date.now();
    var dueIds = [];
    timers.forEach(function (entry, id) { if (entry.due <= now) dueIds.push(id); });
    dueIds.sort(function (a, b) { return timers.get(a).due - timers.get(b).due; });
    for (var i = 0; i < dueIds.length; i++) {
      var entry = timers.get(dueIds[i]);
      if (!entry) continue; // cleared by an earlier callback this tick
      if (entry.interval > 0) {
        // Advance one period (keeps cadence); if we've fallen behind, skip the
        // missed periods rather than fast-forwarding a burst of catch-up fires.
        entry.due += entry.interval;
        if (entry.due <= now) entry.due = now + entry.interval;
      } else {
        timers.delete(dueIds[i]);
      }
      try { entry.cb.apply(null, entry.args); } catch (e) { if (window.console) console.error(e); }
    }
  };
})();
(function () {
  // Host-driven requestAnimationFrame, same idea as the timers above: a hidden
  // page's rAF is paused/throttled with the screen off, stalling canvas apps
  // that render on a rAF loop. Drive it from window.__fcRafTick(), called by the
  // native ticker each frame. (The glasses render via BLE, not the phone's
  // display, so vsync alignment doesn't matter — a steady frame rate does.)
  if (window.__fcRafTick) return;
  var rafs = new Map();
  var nextRafId = 1;
  window.requestAnimationFrame = function (cb) {
    var id = nextRafId++;
    rafs.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = function (id) { rafs.delete(id); };
  window.__fcRafTick = function () {
    if (rafs.size === 0) return;
    var ts = window.performance && performance.now ? performance.now() : Date.now();
    // Snapshot and clear: callbacks that re-request during this frame run on
    // the NEXT frame, matching rAF semantics (so a loop doesn't spin forever).
    var current = rafs;
    rafs = new Map();
    current.forEach(function (cb) {
      try { cb(ts); } catch (e) { if (window.console) console.error(e); }
    });
  };
})();
`;

/** Stock blocks a repeated createStartUpPageContainer ~2s before failing it. */
const DUPLICATE_CREATE_DELAY_MS = 2000;

export type EvenHubWebViewHandle = {
  /** Run JS inside the app's WebView (must be called on the main thread). */
  evaluateJs: (js: string) => void;
  /** Detach and destroy the WebView (the app is closing). */
  destroy: () => void;
};

export type EvenHubWindowHooks = {
  requestRender: () => void;
  closeWindow: () => void;
  /** Hand focus to the app switcher (used to decline an app's quit request). */
  focusSwitcher: () => void;
};

export class EvenHubSession implements EvenHubMicClient {
  readonly manifest: EvenHubManifest;
  readonly distDir: string;

  private page: EvenHubPage | null = null;
  private pageCreated = false;
  private webViewHandle: EvenHubWebViewHandle | null = null;
  private windowHooks: EvenHubWindowHooks | null = null;
  private closed = false;
  private launchContextPushed = false;
  private systemExitSent = false;
  /** Shell focus state; true from launch (apps open focused). */
  private foreground = true;
  /** Phone screen state; the mic goes silent while the screen is off. */
  private screenOn = true;
  /** The app has enabled its microphone via audioControl(true). */
  private micRequested = false;
  /** Non-null while the app has an active location subscription. */
  private locationTracker: LocationTracker | null = null;
  private log: (message: string) => void;

  constructor(manifest: EvenHubManifest, distDir: string, log: (message: string) => void) {
    this.manifest = manifest;
    this.distDir = distDir;
    this.log = log;
  }

  // ----- webview wiring -----

  attachWebView(handle: EvenHubWebViewHandle): void {
    this.webViewHandle = handle;
  }

  /** The WebView finished loading the app: push the one-shot launch context. */
  webViewLoaded(): void {
    if (this.launchContextPushed) return;
    this.launchContextPushed = true;
    // Launched to drive the glasses (from the on-glasses file browser), so
    // apps that branch on this should take their glasses path.
    this.pushMessage("evenAppLaunchSource", { launchSource: "glassesMenu" });
    this.pushMessage("deviceStatusChanged", {
      sn: "FACECLAW-G2",
      connectType: "connected",
      isWearing: true,
      batteryLevel: 100,
      isCharging: false,
      isInCase: false,
    });
  }

  // ----- glasses window wiring -----

  attachWindow(hooks: EvenHubWindowHooks): void {
    this.windowHooks = hooks;
  }

  windowClosed(): void {
    this.windowHooks = null;
    this.close();
  }

  paint(size: { width: number; height: number }, focused: boolean): GrayImage {
    if (!this.pageCreated || !this.page) {
      const image = new GrayImage(size.width, size.height, 0);
      const font = EvenHubFont.get();
      font.drawText(image, 16, 16, `Loading ${this.manifest.name}...`, 255);
      font.drawText(image, 16, 16 + 2 * font.lineHeight, "(waiting for the app to build its page)", 120);
      return image;
    }
    return compositePage(this.page, size, focused);
  }

  /**
   * Route a gesture to the app, emulating stock hardware: clicks and
   * double-clicks arrive as sysEvent (never textEvent) with zero-valued
   * fields elided the way protobuf JSON elides them; list selection moves
   * locally with events only for clicks and boundary scrolls.
   */
  handleGesture(event: DashboardInputEvent): void {
    if (!this.page) return;
    const capture = this.page ? eventCaptureContainer(this.page) : undefined;
    switch (event.type) {
      case "click":
        if (capture?.kind === "list") {
          this.emitListEvent(capture, CLICK_EVENT);
        } else {
          this.emitSysEvent(CLICK_EVENT, gestureSource(event.source));
        }
        break;
      case "double-click":
        this.emitSysEvent(DOUBLE_CLICK_EVENT, gestureSource(event.source));
        break;
      case "scroll-up":
      case "scroll-down": {
        const eventType = event.type === "scroll-up" ? SCROLL_TOP_EVENT : SCROLL_BOTTOM_EVENT;
        if (capture?.kind === "list") {
          this.scrollList(capture, eventType);
        } else {
          this.emitSysEvent(eventType, 0);
        }
        break;
      }
      default:
        break;
    }
  }

  private scrollList(list: EvenHubListContainer, eventType: number): void {
    // Swipe up selects the previous item, swipe down the next (stock direction).
    const delta = eventType === SCROLL_TOP_EVENT ? -1 : 1;
    const next = list.selectedIndex + delta;
    if (next < 0 || next >= list.itemNames.length) {
      // At a boundary the selection stays put and the app hears about it.
      this.emitListEvent(list, eventType);
      return;
    }
    list.selectedIndex = next;
    this.windowHooks?.requestRender();
  }

  /**
   * Shell focus changes drive foreground/background. The initial ENTER is
   * deferred until the page exists (a just-launched app is focused before it
   * has built its page); createStartUpPage emits it then.
   */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    // Foreground gates mic eligibility (an app only hears audio while visible).
    if (this.micRequested) evenHubMicRouter.notifyEligibilityChanged();
    if (!this.pageCreated) return;
    this.emitSysEvent(foreground ? FOREGROUND_ENTER_EVENT : FOREGROUND_EXIT_EVENT, 0);
  }

  /** Screen turned on/off (forwarded from the shell); mutes the mic when off. */
  setScreenOn(on: boolean): void {
    if (this.screenOn === on) return;
    this.screenOn = on;
    if (this.micRequested) evenHubMicRouter.notifyEligibilityChanged();
  }

  // ----- microphone (EvenHubMicClient) -----

  get windowId(): string {
    return this.manifest.packageId;
  }

  isForeground(): boolean {
    return this.foreground;
  }

  isScreenOn(): boolean {
    return this.screenOn;
  }

  /** A decoded mic frame from the router: hand it to the app as an audioEvent. */
  deliverAudioPcm(pcm: Uint8Array): void {
    const audioPcm = Array.from(pcm);
    this.pushMessage("evenHubEvent", { type: "audioEvent", jsonData: { audioPcm } });
  }

  /**
   * audioControl(enable, source?): open or close the microphone for this app.
   * Gated on a declared microphone permission (confirmed at install/first run).
   * Enabling only registers intent — the router decides when audio actually
   * flows (foreground + screen on + no assistant modal).
   */
  private audioControl(data: Record<string, unknown>): boolean {
    if (!permissionsIncludeMicrophone(this.manifest.permissions)) {
      this.log("evenhub: audioControl denied (app declares no microphone permission)");
      return false;
    }
    const enable = readAudioEnable(data);
    // The 0.0.12 payload shape isn't captured; log it once per toggle so the
    // real field names can be confirmed from hardware.
    this.log(`evenhub: audioControl enable=${enable} data=${JSON.stringify(data)}`);
    if (enable) {
      if (!this.micRequested) {
        this.micRequested = true;
        evenHubMicRouter.requestMic(this);
      }
    } else if (this.micRequested) {
      this.micRequested = false;
      evenHubMicRouter.releaseMic(this);
    }
    return true;
  }

  // ----- location -----

  private declaresLocation(): boolean {
    if (permissionsInclude(this.manifest.permissions, "location")) return true;
    this.log("evenhub: location denied (app declares no location permission)");
    return false;
  }

  /** getAppLocation(): one-shot fix, or null on denial/error (SDK contract). */
  private async getAppLocation(): Promise<AppLocation | null> {
    if (!this.declaresLocation()) return null;
    if (!(await ensureFineLocationPermission())) return null;
    try {
      const location = await getCurrentLocation();
      return {
        latitude: location.latitude,
        longitude: location.longitude,
        ...(location.accuracyMeters != null ? { accuracy: location.accuracyMeters } : {}),
        timestamp: location.timestampMs,
      };
    } catch (error) {
      this.log(`evenhub: getAppLocation failed: ${error}`);
      return null;
    }
  }

  /**
   * startAppLocationUpdates(options?): begin a location subscription. Fixes are
   * pushed to the app as `appLocationChanged`. Continues in the background (the
   * subscription ends only on stopAppLocationUpdates or app close), matching the
   * Navigate app's foreground-service-backed tracking.
   */
  private async startLocationUpdates(data: Record<string, unknown>): Promise<boolean> {
    if (!this.declaresLocation()) return false;
    if (!(await ensureFineLocationPermission())) return false;
    if (this.closed) return false;
    if (this.locationTracker) return true;
    const intervalMs = readOptionalNumber(data, "intervalMs") ?? 1000;
    const tracker = new LocationTracker({
      onLocation: (location) => {
        if (this.closed) return;
        this.pushMessage("appLocationChanged", toAppLocation(location));
      },
      onError: (message) => this.log(`evenhub: location update error: ${message}`),
    });
    this.locationTracker = tracker;
    tracker.start(Math.max(200, Math.round(intervalMs)));
    return true;
  }

  private stopLocationUpdates(): boolean {
    this.locationTracker?.stop();
    this.locationTracker = null;
    return true;
  }

  // ----- bridge calls (web -> host) -----

  /**
   * Handle one callHandler('evenAppMessage', ...) invocation. argsJson is the
   * JSON array of handler arguments; args[0] is the SDK's message JSON string
   * (kept lenient: a bare object works too).
   */
  handleBridgeCall(handlerName: string, argsJson: string, callId: number): void {
    void (async () => {
      let result: unknown = null;
      try {
        if (handlerName !== "evenAppMessage") throw new Error(`unknown handler ${handlerName}`);
        const args = JSON.parse(argsJson) as unknown[];
        const first = args[0];
        const message = asRecord(typeof first === "string" ? JSON.parse(first) : first);
        const method = readString(message, "method", "");
        const data = asRecord(message.data);
        result = await this.dispatch(method, data);
      } catch (error) {
        this.log(`evenhub bridge call failed: ${error}`);
        this.resolveCall(callId, false, String(error));
        return;
      }
      this.resolveCall(callId, true, result);
    })();
  }

  private async dispatch(method: string, data: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "createStartUpPageContainer":
        return this.createStartUpPage(data);
      case "rebuildPageContainer":
        return this.rebuildPage(data);
      case "textContainerUpgrade":
        return this.textUpgrade(data);
      case "updateImageRawData":
        return this.updateImage(data);
      case "shutDownPageContainer":
        return this.shutDown(readNumber(data, "exitMode", 0));
      case "setLocalStorage":
        ApplicationSettings.setString(this.storageKey(readString(data, "key", "")), readString(data, "value", ""));
        return true;
      case "getLocalStorage":
        return ApplicationSettings.getString(this.storageKey(readString(data, "key", "")), "");
      case "getUserInfo":
        return { uid: 0, name: "Faceclaw", avatar: "", country: "" };
      case "getGlassesInfo":
        return {
          model: "g2",
          sn: "FACECLAW-G2",
          status: {
            sn: "FACECLAW-G2",
            connectType: "connected",
            isWearing: true,
            batteryLevel: 100,
            isCharging: false,
            isInCase: false,
          },
        };
      case "audioControl":
        return this.audioControl(data);
      case "getAppLocation":
        return this.getAppLocation();
      case "startAppLocationUpdates":
        return this.startLocationUpdates(data);
      case "stopAppLocationUpdates":
        return this.stopLocationUpdates();
      // Unsupported surface (IMU, pickers): fail politely.
      case "imuControl":
        return false;
      case "pickImageFromAlbum":
      case "captureImageFromCamera":
        return null;
      default:
        this.log(`evenhub: unhandled method ${method}`);
        return null;
    }
  }

  /** EhStartUpPageCreateResult: 0 success, 1 invalid, 2 oversize, 3 outOfMemory. */
  private async createStartUpPage(data: Record<string, unknown>): Promise<number> {
    if (this.pageCreated) {
      // One-shot per session on stock: a second call blocks ~2s, then fails.
      await delay(DUPLICATE_CREATE_DELAY_MS);
      return 1;
    }
    const page = parsePage(data);
    this.warnOnInvalidPage(page);
    this.page = page;
    this.pageCreated = true;
    // The launch focus arrived before the page existed; deliver the ENTER now.
    if (this.foreground) this.emitSysEvent(FOREGROUND_ENTER_EVENT, 0);
    this.windowHooks?.requestRender();
    return 0;
  }

  private rebuildPage(data: Record<string, unknown>): boolean {
    // Also serves as create for apps that fall back to rebuild-on-error.
    const page = parsePage(data);
    this.warnOnInvalidPage(page);
    this.page = page;
    this.pageCreated = true;
    this.windowHooks?.requestRender();
    return true;
  }

  private warnOnInvalidPage(page: EvenHubPage): void {
    // Stock rejects these outright; we accept-and-log until rejection is
    // proven necessary for compatibility.
    const captures = page.containers.filter((c) => c.kind !== "image" && c.isEventCapture).length;
    if (captures !== 1) this.log(`evenhub: page has ${captures} event-capture containers (stock requires exactly 1)`);
    const texts = page.containers.filter((c) => c.kind === "text").length;
    const images = page.containers.filter((c) => c.kind === "image").length;
    if (texts > 8 || images > 4) this.log(`evenhub: page exceeds stock limits (${texts} text, ${images} image)`);
  }

  private textUpgrade(data: Record<string, unknown>): boolean {
    const id = readNumber(data, "containerID", -1);
    const name = readString(data, "containerName", "");
    const container = this.page?.containers.find((c) => c.kind === "text" && c.id === id && c.name === name);
    if (!container || container.kind !== "text") return false;
    const content = readString(data, "content", "");
    const offset = readOptionalNumber(data, "contentOffset");
    const length = readOptionalNumber(data, "contentLength");
    if (offset !== undefined && length !== undefined) {
      container.content = container.content.slice(0, offset) + content + container.content.slice(offset + length);
    } else {
      container.content = content;
    }
    this.windowHooks?.requestRender();
    return true;
  }

  /** BleEhSendImageResult: 0 success, 1 imageException, 2 sizeInvalid, 3 sendFailed. */
  private updateImage(data: Record<string, unknown>): number {
    const id = readNumber(data, "containerID", -1);
    const container = this.page?.containers.find((c) => c.kind === "image" && c.id === id);
    if (!container || container.kind !== "image") return 3;
    const bytes = imagePayloadBytes(data.imageData ?? data.rawData ?? asRecord(data).mapRawData);
    if (!bytes || bytes.length === 0) return 1;
    const decoded = decodeImageBytes(bytes, container);
    if (!decoded) return 1;
    container.pixels = decoded.pixels;
    container.pixelsWidth = decoded.width;
    container.pixelsHeight = decoded.height;
    this.windowHooks?.requestRender();
    return 0;
  }

  private shutDown(exitMode: number): boolean {
    if (exitMode === 1) {
      // The app asked to quit (stock would pop an on-glasses confirm). We
      // decline and hand focus to the app switcher instead, leaving the app
      // running — so an app's double-tap-to-quit becomes double-tap-to-defocus.
      // No FOREGROUND_EXIT: focusing the sidebar doesn't background the app
      // (native Faceclaw apps behave the same), and refocusing the same window
      // wouldn't re-fire ENTER, which would leave a pause-on-exit app stuck.
      this.windowHooks?.focusSwitcher();
      return true;
    }
    // Immediate exit. Resolve first (the return travels via evaluateJs, and
    // close() only tears the webview down after its own delay).
    setTimeout(() => this.close(), 200);
    return true;
  }

  private storageKey(key: string): string {
    return `evenhub:${this.manifest.packageId}:ls:${key}`;
  }

  // ----- pushes (host -> web) -----

  private resolveCall(callId: number, ok: boolean, value: unknown): void {
    this.webViewHandle?.evaluateJs(
      `window.__fcResolve && window.__fcResolve(${callId}, ${ok ? "true" : "false"}, ${JSON.stringify(value ?? null)})`,
    );
  }

  private pushMessage(method: string, data: unknown): void {
    const message = { type: "listen_even_app_data", method, data };
    this.webViewHandle?.evaluateJs(
      `window._listenEvenAppMessage && window._listenEvenAppMessage(${JSON.stringify(message)})`,
    );
  }

  private pushEvenHubEvent(payloadType: "sysEvent" | "textEvent" | "listEvent", jsonData: Record<string, unknown>): void {
    this.pushMessage("evenHubEvent", { type: payloadType, jsonData: elideZeroFields(jsonData) });
  }

  private emitSysEvent(eventType: number, eventSource: number): void {
    this.pushEvenHubEvent("sysEvent", { eventType, eventSource });
  }

  private emitListEvent(list: EvenHubListContainer, eventType: number): void {
    this.pushEvenHubEvent("listEvent", {
      containerID: list.id,
      containerName: list.name,
      currentSelectItemIndex: list.selectedIndex,
      currentSelectItemName: list.itemNames[list.selectedIndex] ?? "",
      eventType,
    });
  }

  // ----- teardown -----

  /** Close everything: glasses window, WebView, session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.micRequested) {
      this.micRequested = false;
      evenHubMicRouter.releaseMic(this);
    }
    this.locationTracker?.stop();
    this.locationTracker = null;
    if (!this.systemExitSent) {
      // Best effort: lets the app's teardown handlers run before the webview dies.
      this.emitSysEvent(SYSTEM_EXIT_EVENT, 0);
      this.systemExitSent = true;
    }
    const hooks = this.windowHooks;
    this.windowHooks = null;
    hooks?.closeWindow();
    const webView = this.webViewHandle;
    this.webViewHandle = null;
    if (webView) {
      // Give in-flight resolves/pushes a beat to reach the webview first.
      setTimeout(() => webView.destroy(), 100);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The SDK's AppLocation shape (even_hub_sdk 0.0.12+), all fields camelCase. */
type AppLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  speed?: number;
  heading?: number;
  timestamp?: number;
};

/** Map a continuous GPS fix to the SDK's AppLocation (omitting absent fields). */
function toAppLocation(location: TrackedLocation): AppLocation {
  const out: AppLocation = { latitude: location.latitude, longitude: location.longitude };
  if (location.accuracyMeters != null) out.accuracy = location.accuracyMeters;
  if (location.speedMps != null) out.speed = location.speedMps;
  if (location.bearingDeg != null) out.heading = location.bearingDeg;
  out.timestamp = location.timestampMs;
  return out;
}

/**
 * Read the enable flag from an audioControl payload. The exact wire field name
 * for SDK 0.0.12 isn't captured, so accept the plausible spellings; default to
 * enabling (the common intent) when the payload is opaque, and log it so the
 * real shape can be pinned from hardware.
 */
function readAudioEnable(data: Record<string, unknown>): boolean {
  for (const key of ["enable", "open", "isOpen", "on", "status", "value", "start"]) {
    const value = data[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value === "true" || value === "1" || value === "on" || value === "open";
  }
  return true;
}

/** ring/left-arm/right-arm -> PB EventSourceType. */
function gestureSource(source: "ring" | "left-arm" | "right-arm"): number {
  switch (source) {
    case "right-arm":
      return 1;
    case "ring":
      return 2;
    case "left-arm":
      return 3;
  }
}

/**
 * Protobuf JSON elides zero-valued fields, and apps depend on it (they test
 * eventType === 0 || eventType === undefined). Emit the same shape.
 */
function elideZeroFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === 0 || value === "") continue;
    out[key] = value;
  }
  return out;
}

/** Accept the payload forms seen on the wire: number[], JSON-ified typed
 * array ({"0": 1, ...}), or base64 string. */
function imagePayloadBytes(raw: unknown): Uint8Array | null {
  if (Array.isArray(raw)) {
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = Number(raw[i]) & 0xff;
    return out;
  }
  if (typeof raw === "string") return base64Decode(raw);
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record);
    const out = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const value = record[String(i)];
      if (typeof value !== "number") return null;
      out[i] = value & 0xff;
    }
    return out;
  }
  return null;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Decode(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=]+$/g, "").replace(/\s+/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let bitCount = 0;
  let outIndex = 0;
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) return null;
    bits = (bits << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIndex++] = (bits >> bitCount) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

/**
 * Decode an image payload: PNG (what the SDK-era apps send — the host does
 * the gray conversion), or raw grayscale sized to the container (8bpp, or
 * 4bpp packed two pixels per byte, high nibble first).
 */
function decodeImageBytes(
  bytes: Uint8Array,
  container: EvenHubImageContainer,
): { pixels: Uint8Array; width: number; height: number } | null {
  if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const decoded = UPNG.decode(buffer);
      const frames = UPNG.toRGBA8(decoded) as ArrayBuffer[];
      if (!frames.length) return null;
      const rgba = new Uint8Array(frames[0]!);
      const pixels = new Uint8Array(decoded.width * decoded.height);
      for (let i = 0; i < pixels.length; i++) {
        const offset = i * 4;
        const alpha = (rgba[offset + 3] ?? 0) / 255;
        pixels[i] = Math.round(
          (0.2126 * (rgba[offset] ?? 0) + 0.7152 * (rgba[offset + 1] ?? 0) + 0.0722 * (rgba[offset + 2] ?? 0)) * alpha,
        );
      }
      return { pixels, width: decoded.width, height: decoded.height };
    } catch (error) {
      console.warn(`evenhub: PNG decode failed: ${error}`);
      return null;
    }
  }
  const area = container.width * container.height;
  if (bytes.length === area) {
    return { pixels: Uint8Array.from(bytes), width: container.width, height: container.height };
  }
  if (bytes.length === Math.ceil(area / 2)) {
    const pixels = new Uint8Array(area);
    for (let i = 0; i < area; i++) {
      const byte = bytes[i >> 1]!;
      const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
      pixels[i] = nibble * 17;
    }
    return { pixels, width: container.width, height: container.height };
  }
  return null;
}
