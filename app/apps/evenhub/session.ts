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
 * JS): the promise-returning flutter_inappwebview.callHandler the EvenHub
 * SDK expects, backed by the FaceclawEvenHubJsBridge Java object. Kept in
 * ES5 so it runs on any webview.
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
`;

/** How long after SYSTEM_EXIT the webview stays alive so the app can save. */
const EXIT_GRACE_MS = 1500;
/** Stock blocks a repeated createStartUpPageContainer ~2s before failing it. */
const DUPLICATE_CREATE_DELAY_MS = 2000;

export type EvenHubPageHandle = {
  /** Run JS inside the app's WebView (must be called on the main thread). */
  evaluateJs: (js: string) => void;
  /** Tear the phone page down (navigate back if it is current). */
  closePage: () => void;
};

export type EvenHubWindowHooks = {
  requestRender: () => void;
  closeWindow: () => void;
  /** Push the on-glasses exit confirm; answers come back via exitDialogAnswer. */
  openExitDialog: () => void;
};

export class EvenHubSession {
  readonly manifest: EvenHubManifest;
  readonly distDir: string;

  private page: EvenHubPage | null = null;
  private pageCreated = false;
  private pageHandle: EvenHubPageHandle | null = null;
  private windowHooks: EvenHubWindowHooks | null = null;
  private closed = false;
  private launchContextPushed = false;
  private systemExitSent = false;
  private graceCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private log: (message: string) => void;

  constructor(manifest: EvenHubManifest, distDir: string, log: (message: string) => void) {
    this.manifest = manifest;
    this.distDir = distDir;
    this.log = log;
  }

  // ----- phone page wiring -----

  attachPage(handle: EvenHubPageHandle): void {
    this.pageHandle = handle;
  }

  /** The WebView finished loading the app: push the one-shot launch context. */
  pageFinished(): void {
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

  /** The phone page went away (back navigation); the webview is gone too. */
  pageGone(): void {
    this.pageHandle = null;
    this.close();
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
    const delta = eventType === SCROLL_TOP_EVENT ? 1 : -1;
    const next = list.selectedIndex + delta;
    if (next < 0 || next >= list.itemNames.length) {
      // At a boundary the selection stays put and the app hears about it.
      this.emitListEvent(list, eventType);
      return;
    }
    list.selectedIndex = next;
    this.windowHooks?.requestRender();
  }

  setForeground(foreground: boolean): void {
    if (!this.pageCreated) return;
    this.emitSysEvent(foreground ? FOREGROUND_ENTER_EVENT : FOREGROUND_EXIT_EVENT, 0);
  }

  /** The on-glasses exit confirm was answered. */
  exitDialogAnswer(exit: boolean): void {
    if (exit) {
      this.emitSysEvent(SYSTEM_EXIT_EVENT, 0);
      this.systemExitSent = true;
      // Give the app a beat to persist state; it usually calls
      // shutDownPageContainer(0) well before this fires.
      this.graceCloseTimer = setTimeout(() => this.close(), EXIT_GRACE_MS);
    } else {
      this.emitSysEvent(FOREGROUND_EXIT_EVENT, 0);
    }
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
      // Unsupported surface (mic, IMU, location, pickers): fail politely.
      case "audioControl":
      case "imuControl":
      case "startAppLocationUpdates":
      case "stopAppLocationUpdates":
        return false;
      case "getAppLocation":
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
      // Stock pops an on-glasses confirm and tells the app its page is gone.
      this.emitSysEvent(FOREGROUND_ENTER_EVENT, 0);
      this.windowHooks?.openExitDialog();
      this.windowHooks?.requestRender();
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
    this.pageHandle?.evaluateJs(
      `window.__fcResolve && window.__fcResolve(${callId}, ${ok ? "true" : "false"}, ${JSON.stringify(value ?? null)})`,
    );
  }

  private pushMessage(method: string, data: unknown): void {
    const message = { type: "listen_even_app_data", method, data };
    this.pageHandle?.evaluateJs(
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

  /** Close everything: glasses window, phone page, session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.graceCloseTimer) {
      clearTimeout(this.graceCloseTimer);
      this.graceCloseTimer = null;
    }
    if (!this.systemExitSent) {
      // Best effort: lets the app's teardown handlers run before the webview dies.
      this.emitSysEvent(SYSTEM_EXIT_EVENT, 0);
      this.systemExitSent = true;
    }
    const hooks = this.windowHooks;
    this.windowHooks = null;
    hooks?.closeWindow();
    const page = this.pageHandle;
    this.pageHandle = null;
    if (page) {
      // Give in-flight resolves/pushes a beat to reach the webview first.
      setTimeout(() => page.closePage(), 100);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
