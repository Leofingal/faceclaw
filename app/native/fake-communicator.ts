import { type ImageSource } from "@nativescript/core";

import { GrayImage, G2_LENS_WIDTH, G2_LENS_HEIGHT } from "../graphics/image";
import { grayImageToPreviewSource } from "./gray-image-preview";
import { FLASHABLE_STOCK_VERSION_TEXT } from "../g2/firmware-compat";
import { emulatorPreFirmwareSetting } from "../ui/dashboard-settings";
import type {
  CommunicatorPhase,
  CommunicatorState,
  FrameMetrics,
  HeadsetBatteryState,
  FirmwareInfo,
  SurfaceOptions,
  RawInputEvent,
} from "./faceclaw-communicator";

/**
 * Software-only stand-in for FaceclawCommunicatorBridge, used by
 * dashboard-controller.ts's connect() when no glasses MAC addresses are
 * configured (the "Preview Only" onboarding path). Implements the same
 * public surface as the real bridge -- phase/state, the compositor surface
 * API, and the phone-side composite preview -- entirely in TypeScript, with
 * no BLE, no native FaceclawBleCommunicator, and no simulated Bluetooth
 * protocol of any kind.
 *
 * Everything faceclaw already renders through this surface (shell chrome,
 * per-window app content, the lock screen) keeps working completely
 * unmodified: dashboard-controller.ts hands this class the exact same
 * pixels8bpp buffers, rects, and zOrders it would hand the real bridge, so
 * what shows up in getCompositePreview() is a genuine render of faceclaw's
 * own UI -- not a mock of it. This class only replaces the transport (BLE)
 * and the native compositor (Kotlin/C++); the rendering logic upstream
 * (graphics/plane.ts, graphics/glyph-wire.ts, the shell) never learns the
 * difference.
 *
 * Compositing follows the same contract the real bridge documents on
 * SurfaceOptions (faceclaw-communicator.ts): surfaces composite in ascending
 * zOrder onto a black background; a "color-key" surface treats pixel value 0
 * as transparent (letting whatever is beneath it show through) and an
 * "opaque" surface covers its whole rect outright. GrayImage.bitBlt's own
 * transparentZero option implements exactly this, so surface storage and
 * the final composite both reuse it rather than re-deriving the rule.
 *
 * Known simplifications, worth being honest about:
 * - No green preview-color tinting (previewColorSetting's "green" option is
 *   ignored; grayImageToPreviewSource only renders grayscale).
 * - getNativeCommunicator() returns null, so any feature that reaches past
 *   the bridge for a raw native handle (currently: live voice/mic capture
 *   over BLE) will not work here. That is real hardware audio and was never
 *   in scope for a software-only preview.
 * - Battery/wear/phone-lock state are synthetic constants, not modeled.
 */

type FakeSurface = {
  x: number;
  y: number;
  zOrder: number;
  transparency: "opaque" | "color-key";
  visible: boolean;
  image: GrayImage;
};

/** Small, visible delay so "Connecting..." reads as real rather than instant. */
const CONNECT_DELAY_MS = 350;
const DISCONNECT_DELAY_MS = 50;

export class FakeFaceclawCommunicator {
  private readonly logListeners = new Set<(line: string) => void>();
  private readonly stateListeners = new Set<(state: CommunicatorState) => void>();
  private readonly ringListeners = new Set<(event: RawInputEvent) => void>();
  private readonly batteryListeners = new Set<(state: HeadsetBatteryState) => void>();
  private readonly silentModeListeners = new Set<(silent: boolean) => void>();
  private readonly wearStateListeners = new Set<(wearing: boolean) => void>();
  private readonly phoneLockStateListeners = new Set<(locked: boolean) => void>();
  private readonly evenAppConflictListeners = new Set<(message: string) => void>();
  private readonly frameMetricsListeners = new Set<(metrics: FrameMetrics) => void>();
  private readonly firmwareInfoListeners = new Set<(info: FirmwareInfo) => void>();

  private compositeWidth = G2_LENS_WIDTH;
  private compositeHeight = G2_LENS_HEIGHT;
  private readonly surfaces = new Map<string, FakeSurface>();

  private emitAsync<T>(listeners: Set<(value: T) => void>, value: T): void {
    const snapshot = Array.from(listeners);
    setTimeout(() => {
      for (const listener of snapshot) listener(value);
    }, 0);
  }

  onLog(listener: (line: string) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onStateChange(listener: (state: CommunicatorState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onRingEvent(listener: (event: RawInputEvent) => void): () => void {
    this.ringListeners.add(listener);
    return () => this.ringListeners.delete(listener);
  }

  onBatteryState(listener: (state: HeadsetBatteryState) => void): () => void {
    this.batteryListeners.add(listener);
    // Synthetic, cosmetic-only reading so the shell chrome's battery
    // indicator has something plausible to show instead of "unknown".
    this.emitAsync(this.batteryListeners, { battery: 88, chargingStatus: 0 });
    return () => this.batteryListeners.delete(listener);
  }

  onSilentMode(listener: (silent: boolean) => void): () => void {
    this.silentModeListeners.add(listener);
    return () => this.silentModeListeners.delete(listener);
  }

  onWearState(listener: (wearing: boolean) => void): () => void {
    this.wearStateListeners.add(listener);
    return () => this.wearStateListeners.delete(listener);
  }

  onPhoneLockState(listener: (locked: boolean) => void): () => void {
    this.phoneLockStateListeners.add(listener);
    return () => this.phoneLockStateListeners.delete(listener);
  }

  onEvenAppConflict(listener: (message: string) => void): () => void {
    this.evenAppConflictListeners.add(listener);
    return () => this.evenAppConflictListeners.delete(listener);
  }

  onFrameMetrics(listener: (metrics: FrameMetrics) => void): () => void {
    this.frameMetricsListeners.add(listener);
    return () => this.frameMetricsListeners.delete(listener);
  }

  onFirmwareInfo(listener: (info: FirmwareInfo) => void): () => void {
    this.firmwareInfoListeners.add(listener);
    return () => this.firmwareInfoListeners.delete(listener);
  }

  /** No real native transport exists; see the class doc's known-simplifications note. */
  getNativeCommunicator(): any {
    return null;
  }

  waitForFrameFinished(_frameId: number, _timeoutMs: number): Promise<string | null> {
    // Nothing to wait on: submitSurfaceFrame below applies synchronously.
    return Promise.resolve("sent");
  }

  waitForNextFrameMetrics(timeoutMs: number): Promise<FrameMetrics | null> {
    return new Promise((resolve) => {
      setTimeout(() => resolve({ paintMs: 0, transmitMs: 0, tileCount: 1 }), Math.min(16, Math.max(0, timeoutMs)));
    });
  }

  async start(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, CONNECT_DELAY_MS));
    this.emitAsync(this.logListeners, "emulator preview: connected (no real glasses involved)");
    this.emitAsync(this.stateListeners, { phase: "connected", status: "Connected (emulator preview)." });
    // A first version of this emitted onFirmwareInfo with a fabricated
    // "emulator" version string; firmwareIncompatibilityMessage() correctly
    // rejected it (confirmed empirically -- logcat showed a real auto-
    // disconnect) since it isn't a parseable version at or above
    // MIN_FIRMWARE_VERSION. FLASHABLE_STOCK_VERSION_TEXT is a real exported
    // constant from firmware-compat.ts, guaranteed to satisfy that gate
    // (>= MIN_FIRMWARE_VERSION by construction), so reusing it here rather
    // than hardcoding a version keeps this from silently drifting out of
    // sync if the minimum ever changes. The capability string carries the
    // three tokens firmware-compat.ts's REQUIRED_FIRMWARE_EXTENSIONS checks
    // for (img640, fbguard, wearnotify) plus wakelease (optional feature,
    // dashboard-controller.ts checks for it separately) plus a menugesture
    // marker this emulator invents for its own use -- faceclaw's real
    // firmware-capability-driven menu-gesture fallback doesn't exist yet,
    // so nothing else reads this token, but it lets Ghost's gesture-
    // adaptive UI be designed and previewed against both cases now.
    const preFirmware = emulatorPreFirmwareSetting.get();
    this.emitAsync(this.firmwareInfoListeners, {
      leftVersion: FLASHABLE_STOCK_VERSION_TEXT,
      rightVersion: FLASHABLE_STOCK_VERSION_TEXT,
      capabilities: `img640 fbguard wearnotify wakelease ${preFirmware ? "menugesture:doubleclick" : "menugesture:longpress"}`,
    });
  }

  async setG2ScreenOn(_screenOn: boolean): Promise<void> {}

  async setFirmwareDebugFlags(_enabled: boolean): Promise<void> {}

  async setBrightness(_autoAdjust: boolean, _level: number): Promise<void> {}

  async enableWearDetectionAndRequestState(): Promise<void> {}

  async configureCompositorScreen(width: number, height: number): Promise<void> {
    this.compositeWidth = Math.max(1, Math.round(width));
    this.compositeHeight = Math.max(1, Math.round(height));
  }

  /** Phone-UI preview, composited here in JS from every configured surface. */
  getCompositePreview(_green = false): ImageSource | null {
    if (!global.isAndroid) return null;
    const composite = new GrayImage(this.compositeWidth, this.compositeHeight, 0);
    const ordered = Array.from(this.surfaces.values())
      .filter((surface) => surface.visible)
      .sort((a, b) => a.zOrder - b.zOrder);
    for (const surface of ordered) {
      composite.bitBlt(surface.image, surface.x, surface.y, {
        transparentZero: surface.transparency === "color-key",
      });
    }
    return grayImageToPreviewSource(composite);
  }

  saveScreenshot(_crop?: { x: number; y: number; width: number; height: number }): string {
    return "";
  }

  startScreenRecording(): void {}

  recordScreenFrame(): void {}

  stopScreenRecording(): string {
    return "";
  }

  async configureSurface(id: string, options: SurfaceOptions): Promise<void> {
    const width = Math.max(1, Math.round(options.width));
    const height = Math.max(1, Math.round(options.height));
    const existing = this.surfaces.get(id);
    this.surfaces.set(id, {
      x: Math.round(options.x),
      y: Math.round(options.y),
      zOrder: Math.round(options.zOrder),
      transparency: options.transparency,
      visible: existing?.visible ?? true,
      image: new GrayImage(width, height, 0),
    });
  }

  async removeSurface(id: string): Promise<void> {
    this.surfaces.delete(id);
  }

  async setSurfaceVisible(id: string, visible: boolean): Promise<void> {
    const surface = this.surfaces.get(id);
    if (surface) surface.visible = visible;
  }

  async setScreenBlanked(_blanked: boolean): Promise<void> {
    // Nothing to blank: hidden surfaces already stop compositing via
    // setSurfaceVisible, which every caller of setScreenBlanked pairs this with.
  }

  async submitSurfaceFrame(
    surfaceId: string,
    pixels8bpp: Uint8Array,
    rect: { x: number; y: number; width: number; height: number },
    _fingerprint: string,
    _paintMs = -1,
    _frameId = 0,
    _glyphs: ArrayBuffer | null = null,
  ): Promise<void> {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) return;
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const patch = new GrayImage(width, height, 0);
    patch.pixels.set(pixels8bpp.subarray(0, width * height));
    surface.image.bitBlt(patch, Math.round(rect.x), Math.round(rect.y));
    this.emitAsync(this.frameMetricsListeners, { paintMs: 0, transmitMs: 0, tileCount: 1 });
  }

  async disconnect(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, DISCONNECT_DELAY_MS));
    this.emitAsync(this.stateListeners, { phase: "disconnected", status: "Disconnected." });
  }

  async sendShutdown(_exitMode = 0): Promise<boolean> {
    return true;
  }

  async sendCfwCleanup(): Promise<boolean> {
    return true;
  }

  async suspendEvenHubSession(): Promise<boolean> {
    return true;
  }

  async resumeEvenHubSession(): Promise<boolean> {
    return true;
  }

  async setFaceclawWakeLeaseEnabled(_enabled: boolean): Promise<boolean> {
    return true;
  }

  async awaitEvenHubSessionReady(_timeoutMs: number): Promise<boolean> {
    return true;
  }

  async playBuzzerSequence(_payload: Uint8Array): Promise<void> {}

  async close(): Promise<void> {
    this.surfaces.clear();
  }
}

