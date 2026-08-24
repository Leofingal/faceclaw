import {
  Application,
  Dialogs,
  Frame,
  ImageSource,
  Observable,
  Screen,
  SwipeDirection,
  type GestureEventData,
  type SwipeGestureEventData,
  type TouchGestureEventData,
  type View,
} from "@nativescript/core";
import { dashboardController, type MirrorTouchKind } from "../g2/dashboard-controller";
import { shell } from "../ui/shell/shell";
import {
  brightnessSetting,
  DISPLAY_MODE_VALUES,
  displayModeLabel,
  displayModeSetting,
  onAnySettingChanged,
  type BrightnessSetting,
  type DisplayModeSetting,
} from "../ui/dashboard-settings";
import { getBooleanSetting, setBooleanSetting } from "../native/settings-store";
import { isValidMacAddress, loadDeviceAddresses } from "../g2/device-addresses";
import { isAutoReconnectSuppressed } from "../g2/reconnect-policy";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../graphics/image";

const LENS_ASPECT_RATIO = G2_LENS_WIDTH / G2_LENS_HEIGHT;

type LayoutOrientation = "portrait" | "landscape";

export class MainViewModel extends Observable {
  private _status = "Disconnected.";
  private _log = "";
  private _displayPreview: ImageSource | null = null;
  private _displayPreviewMessage = "";
  private _layoutOrientation: LayoutOrientation = this.readLayoutOrientation();
  private _activeTextSettingId: string | null = null;
  private _activeTextEditorTitle = "";
  private _activeTextSettingTitle = "";
  private _activeTextSettingValue = "";
  private _activeTextSettingInputKind: "text" | "email" | "password" = "text";
  private _secondaryTextSettingId: string | null = null;
  private _secondaryTextSettingTitle = "";
  private _secondaryTextSettingValue = "";
  private _secondaryTextSettingInputKind: "text" | "email" | "password" = "text";
  private _evenAppConflictMessage = "";
  private _evenAppConflictWarningVisible = false;
  private _firmwareWarningMessage = "";
  private _firmwareWarningVisible = false;
  private _screenRecordingActive = false;
  private _batteryOptimizationWarningVisible = false;
  private _showLog = false;
  private _phase: "disconnected" | "connecting" | "connected" | "charging" | "disconnecting" = "disconnected";

  constructor() {
    super();
    dashboardController.subscribe((snapshot) => {
      this.status = snapshot.status;
      this.log = snapshot.log;
      this.displayPreview = snapshot.displayPreview;
      this.displayPreviewMessage = snapshot.displayPreviewMessage;
      this.phase = snapshot.phase;
      this.activeTextSettingId = snapshot.activeTextSettingId;
      this.activeTextEditorTitle = snapshot.activeTextEditorTitle;
      this.activeTextSettingTitle = snapshot.activeTextSettingTitle;
      this.activeTextSettingValue = snapshot.activeTextSettingValue;
      this.activeTextSettingInputKind = snapshot.activeTextSettingInputKind;
      this.secondaryTextSettingId = snapshot.secondaryTextSettingId;
      this.secondaryTextSettingTitle = snapshot.secondaryTextSettingTitle;
      this.secondaryTextSettingValue = snapshot.secondaryTextSettingValue;
      this.secondaryTextSettingInputKind = snapshot.secondaryTextSettingInputKind;
      this.evenAppConflictMessage = snapshot.evenAppConflictMessage;
      this.evenAppConflictWarningVisible = snapshot.evenAppConflictWarningVisible;
      this.firmwareWarningMessage = snapshot.firmwareWarningMessage;
      this.firmwareWarningVisible = snapshot.firmwareWarningVisible;
      this.screenRecordingActive = snapshot.screenRecordingActive;
      this.batteryOptimizationWarningVisible = snapshot.batteryOptimizationWarningVisible;
      this.refreshPadFocusLine();
    });
    // Brightness / display mode can change from the glasses' Settings app too.
    onAnySettingChanged(() => this.refreshDisplayControls());
  }

  get status(): string {
    return this._status;
  }

  set status(value: string) {
    if (this._status !== value) {
      this._status = value;
      this.notifyPropertyChange("status", value);
    }
  }

  get log(): string {
    return this._log;
  }

  set log(value: string) {
    if (this._log !== value) {
      this._log = value;
      this.notifyPropertyChange("log", value);
    }
  }

  get displayPreview(): ImageSource | null {
    return this._displayPreview;
  }

  set displayPreview(value: ImageSource | null) {
    if (this._displayPreview !== value) {
      this._displayPreview = value;
      this.notifyPropertyChange("displayPreview", value);
      this.notifyPropertyChange("hasDisplayPreview", this.hasDisplayPreview);
      this.notifyPropertyChange("displayPreviewVisibility", this.displayPreviewVisibility);
    }
  }

  get displayPreviewMessage(): string {
    return this._displayPreviewMessage;
  }

  set displayPreviewMessage(value: string) {
    if (this._displayPreviewMessage !== value) {
      this._displayPreviewMessage = value;
      this.notifyPropertyChange("displayPreviewMessage", value);
      this.notifyPropertyChange("displayPreviewMessageVisibility", this.displayPreviewMessageVisibility);
      this.notifyPropertyChange("displayPreviewVisibility", this.displayPreviewVisibility);
    }
  }

  get hasDisplayPreview(): boolean {
    return this._displayPreview !== null;
  }

  /**
   * The preview and its stand-in message are mutually exclusive and occupy the
   * same box, so the form doesn't reflow when one replaces the other.
   */
  get displayPreviewVisibility(): "visible" | "collapse" {
    return this.hasDisplayPreview && !this._displayPreviewMessage ? "visible" : "collapse";
  }

  get displayPreviewMessageVisibility(): "visible" | "collapse" {
    return this._displayPreviewMessage ? "visible" : "collapse";
  }

  get displayPreviewHeight(): number {
    return Screen.mainScreen.widthDIPs / LENS_ASPECT_RATIO;
  }

  get landscapeDisplayPreviewWidth(): number {
    return Math.floor(this.landscapeDisplayPreviewHeight * LENS_ASPECT_RATIO);
  }

  get landscapeDisplayPreviewHeight(): number {
    // Height keeps the vertical footprint the preview had at the old 2:1
    // aspect; the width is derived from it, so a wider lens aspect can't
    // grow the preview past the side panel.
    const screenWidth = Screen.mainScreen.widthDIPs;
    const sidePanelWidth = 260;
    const availableWidth = Math.max(240, Math.floor(screenWidth - sidePanelWidth - 56));
    return Math.floor(availableWidth / 2);
  }

  get portraitLayoutVisibility(): "visible" | "collapse" {
    return this._layoutOrientation === "portrait" ? "visible" : "collapse";
  }

  get landscapeLayoutVisibility(): "visible" | "collapse" {
    return this._layoutOrientation === "landscape" ? "visible" : "collapse";
  }

  refreshLayoutMetrics(): void {
    const nextOrientation = this.readLayoutOrientation();
    if (this._layoutOrientation !== nextOrientation) {
      this._layoutOrientation = nextOrientation;
      this.notifyPropertyChange("portraitLayoutVisibility", this.portraitLayoutVisibility);
      this.notifyPropertyChange("landscapeLayoutVisibility", this.landscapeLayoutVisibility);
    }
    this.notifyPropertyChange("displayPreviewHeight", this.displayPreviewHeight);
    this.notifyPropertyChange("landscapeDisplayPreviewWidth", this.landscapeDisplayPreviewWidth);
    this.notifyPropertyChange("landscapeDisplayPreviewHeight", this.landscapeDisplayPreviewHeight);
  }

  get showLog(): boolean {
    return this._showLog;
  }

  set showLog(value: boolean) {
    if (this._showLog !== value) {
      this._showLog = value;
      this.notifyPropertyChange("showLog", value);
      this.notifyPropertyChange("showLogVisibility", this.showLogVisibility);
      this.notifyPropertyChange("showLogMenuLabel", this.showLogMenuLabel);
    }
  }

  get showLogVisibility(): "visible" | "collapse" {
    return this._showLog ? "visible" : "collapse";
  }

  get showLogMenuLabel(): string {
    return this._showLog ? "Hide Log" : "Show Log";
  }

  get activeTextSettingId(): string | null {
    return this._activeTextSettingId;
  }

  set activeTextSettingId(value: string | null) {
    if (this._activeTextSettingId !== value) {
      this._activeTextSettingId = value;
      this.notifyPropertyChange("activeTextSettingId", value);
      this.notifyPropertyChange("textSettingEditorVisibility", this.textSettingEditorVisibility);
      this.notifyPropertyChange("isTextSettingEditorActive", this.isTextSettingEditorActive);
    }
  }

  get activeTextSettingTitle(): string {
    return this._activeTextSettingTitle;
  }

  get activeTextEditorTitle(): string {
    return this._activeTextEditorTitle;
  }

  set activeTextEditorTitle(value: string) {
    if (this._activeTextEditorTitle !== value) {
      this._activeTextEditorTitle = value;
      this.notifyPropertyChange("activeTextEditorTitle", value);
    }
  }

  set activeTextSettingTitle(value: string) {
    if (this._activeTextSettingTitle !== value) {
      this._activeTextSettingTitle = value;
      this.notifyPropertyChange("activeTextSettingTitle", value);
    }
  }

  get activeTextSettingValue(): string {
    return this._activeTextSettingValue;
  }

  set activeTextSettingValue(value: string) {
    if (this._activeTextSettingValue !== value) {
      this._activeTextSettingValue = value;
      this.notifyPropertyChange("activeTextSettingValue", value);
    }
  }

  get activeTextSettingInputKind(): "text" | "email" | "password" {
    return this._activeTextSettingInputKind;
  }

  set activeTextSettingInputKind(value: "text" | "email" | "password") {
    if (this._activeTextSettingInputKind !== value) {
      this._activeTextSettingInputKind = value;
      this.notifyPropertyChange("activeTextSettingKeyboardType", this.activeTextSettingKeyboardType);
      this.notifyPropertyChange("activeTextSettingSecure", this.activeTextSettingSecure);
    }
  }

  get activeTextSettingKeyboardType(): "email" | "text" {
    return this._activeTextSettingInputKind === "email" ? "email" : "text";
  }

  get activeTextSettingSecure(): boolean {
    return this._activeTextSettingInputKind === "password";
  }

  get secondaryTextSettingId(): string | null {
    return this._secondaryTextSettingId;
  }

  set secondaryTextSettingId(value: string | null) {
    if (this._secondaryTextSettingId !== value) {
      this._secondaryTextSettingId = value;
      this.notifyPropertyChange("secondaryTextSettingId", value);
      this.notifyPropertyChange("secondaryTextSettingVisibility", this.secondaryTextSettingVisibility);
      this.notifyPropertyChange("hasSecondaryTextSetting", this.hasSecondaryTextSetting);
      this.notifyPropertyChange("primaryTextSettingReturnKeyType", this.primaryTextSettingReturnKeyType);
    }
  }

  get secondaryTextSettingTitle(): string {
    return this._secondaryTextSettingTitle;
  }

  set secondaryTextSettingTitle(value: string) {
    if (this._secondaryTextSettingTitle !== value) {
      this._secondaryTextSettingTitle = value;
      this.notifyPropertyChange("secondaryTextSettingTitle", value);
    }
  }

  get secondaryTextSettingValue(): string {
    return this._secondaryTextSettingValue;
  }

  set secondaryTextSettingValue(value: string) {
    if (this._secondaryTextSettingValue !== value) {
      this._secondaryTextSettingValue = value;
      this.notifyPropertyChange("secondaryTextSettingValue", value);
    }
  }

  get secondaryTextSettingInputKind(): "text" | "email" | "password" {
    return this._secondaryTextSettingInputKind;
  }

  set secondaryTextSettingInputKind(value: "text" | "email" | "password") {
    if (this._secondaryTextSettingInputKind !== value) {
      this._secondaryTextSettingInputKind = value;
      this.notifyPropertyChange("secondaryTextSettingKeyboardType", this.secondaryTextSettingKeyboardType);
      this.notifyPropertyChange("secondaryTextSettingSecure", this.secondaryTextSettingSecure);
    }
  }

  get secondaryTextSettingKeyboardType(): "email" | "text" {
    return this._secondaryTextSettingInputKind === "email" ? "email" : "text";
  }

  get secondaryTextSettingSecure(): boolean {
    return this._secondaryTextSettingInputKind === "password";
  }

  get hasSecondaryTextSetting(): boolean {
    return this._secondaryTextSettingId !== null;
  }

  get secondaryTextSettingVisibility(): "visible" | "collapse" {
    return this.hasSecondaryTextSetting ? "visible" : "collapse";
  }

  get primaryTextSettingReturnKeyType(): "next" | "done" {
    return this.hasSecondaryTextSetting ? "next" : "done";
  }

  get isTextSettingEditorActive(): boolean {
    return this._activeTextSettingId !== null;
  }

  get textSettingEditorVisibility(): "visible" | "collapse" {
    return this.isTextSettingEditorActive ? "visible" : "collapse";
  }

  get evenAppConflictMessage(): string {
    return this._evenAppConflictMessage;
  }

  set evenAppConflictMessage(value: string) {
    if (this._evenAppConflictMessage !== value) {
      this._evenAppConflictMessage = value;
      this.notifyPropertyChange("evenAppConflictMessage", value);
    }
  }

  get evenAppConflictWarningVisible(): boolean {
    return this._evenAppConflictWarningVisible;
  }

  set evenAppConflictWarningVisible(value: boolean) {
    if (this._evenAppConflictWarningVisible !== value) {
      this._evenAppConflictWarningVisible = value;
      this.notifyPropertyChange("evenAppConflictWarningVisible", value);
      this.notifyPropertyChange("evenAppConflictWarningVisibility", this.evenAppConflictWarningVisibility);
    }
  }

  get evenAppConflictWarningVisibility(): "visible" | "collapse" {
    return this._evenAppConflictWarningVisible ? "visible" : "collapse";
  }

  get firmwareWarningMessage(): string {
    return this._firmwareWarningMessage;
  }

  set firmwareWarningMessage(value: string) {
    if (this._firmwareWarningMessage !== value) {
      this._firmwareWarningMessage = value;
      this.notifyPropertyChange("firmwareWarningMessage", value);
    }
  }

  get firmwareWarningVisible(): boolean {
    return this._firmwareWarningVisible;
  }

  set firmwareWarningVisible(value: boolean) {
    if (this._firmwareWarningVisible !== value) {
      this._firmwareWarningVisible = value;
      this.notifyPropertyChange("firmwareWarningVisible", value);
      this.notifyPropertyChange("firmwareWarningVisibility", this.firmwareWarningVisibility);
    }
  }

  get firmwareWarningVisibility(): "visible" | "collapse" {
    return this._firmwareWarningVisible ? "visible" : "collapse";
  }

  get screenRecordingActive(): boolean {
    return this._screenRecordingActive;
  }

  set screenRecordingActive(value: boolean) {
    if (this._screenRecordingActive !== value) {
      this._screenRecordingActive = value;
      this.notifyPropertyChange("screenRecordingActive", value);
      this.notifyPropertyChange("stopRecordingButtonVisibility", this.stopRecordingButtonVisibility);
    }
  }

  get stopRecordingButtonVisibility(): "visible" | "collapse" {
    return this._screenRecordingActive ? "visible" : "collapse";
  }

  onTakeScreenshotTap(): void {
    try {
      dashboardController.saveScreenshot();
    } catch (error) {
      console.error("screenshot failed", error);
    }
  }

  onRecordScreenTap(): void {
    try {
      dashboardController.startScreenRecording();
    } catch (error) {
      console.error("screen recording start failed", error);
    }
  }

  onStopRecordingTap(): void {
    try {
      dashboardController.stopScreenRecording();
    } catch (error) {
      console.error("screen recording stop failed", error);
    }
  }

  get batteryOptimizationWarningVisible(): boolean {
    return this._batteryOptimizationWarningVisible;
  }

  set batteryOptimizationWarningVisible(value: boolean) {
    if (this._batteryOptimizationWarningVisible !== value) {
      this._batteryOptimizationWarningVisible = value;
      this.notifyPropertyChange("batteryOptimizationWarningVisible", value);
      this.notifyPropertyChange("batteryOptimizationWarningVisibility", this.batteryOptimizationWarningVisibility);
    }
  }

  get batteryOptimizationWarningVisibility(): "visible" | "collapse" {
    return this._batteryOptimizationWarningVisible ? "visible" : "collapse";
  }

  onAllowBackgroundUsageTap(): void {
    dashboardController.requestBatteryOptimizationExemption();
  }

  get phase(): "disconnected" | "connecting" | "connected" | "charging" | "disconnecting" {
    return this._phase;
  }

  set phase(value: "disconnected" | "connecting" | "connected" | "charging" | "disconnecting") {
    if (this._phase !== value) {
      this._phase = value;
      this.notifyPropertyChange("phase", value);
      this.notifyPropertyChange("buttonLabel", this.buttonLabel);
      this.notifyPropertyChange("canRun", this.canRun);
    }
  }

  get buttonLabel(): string {
    switch (this.phase) {
      case "connecting":
        return "Connecting...";
      case "connected":
      case "charging":
        return "Disconnect";
      case "disconnecting":
        return "Disconnecting...";
      default:
        return "Connect";
    }
  }

  get canRun(): boolean {
    return this.phase !== "connecting" && this.phase !== "disconnecting";
  }

  async onTap(): Promise<void> {
    if (!this.canRun) return;

    try {
      if (this.phase === "connected" || this.phase === "charging") {
        await dashboardController.disconnect();
      } else {
        await dashboardController.connect();
      }
    } catch (error) {
      const message = this.formatError(error);
      if (!this.status.startsWith("Failed:")) {
        this.status = `Failed: ${message}`;
        this.appendLog(`error: ${message}`);
      }
    }
  }

  /**
   * Try to connect automatically on reaching the main page. No-op if already
   * connecting/connected, if the app is in the manual-disconnected state
   * (the user picked Disconnect, the flash flow owns the glasses, or the
   * firmware was found incompatible), or if no glasses are configured
   * (e.g. preview-only users, who have nothing to connect to).
   */
  async autoConnect(): Promise<void> {
    if (this.phase !== "disconnected") return;
    if (isAutoReconnectSuppressed()) return;
    const addresses = loadDeviceAddresses();
    if (!isValidMacAddress(addresses.right) || !isValidMacAddress(addresses.left)) return;
    try {
      await dashboardController.connect();
    } catch {
      // The controller surfaces failures via status/log; nothing to add here.
    }
  }

  onConfigureTap(): void {
    if (!this.canRun) return;
    Frame.topmost()?.navigate("phone-ui/config-page");
  }

  /**
   * Live scan that names each nearby pair by model, colour, and serial and
   * checks both arms belong together. A connected arm stops advertising, so
   * drop the current link first; autoConnect picks it back up afterwards.
   */
  async onPairGlassesTap(): Promise<void> {
    if (!this.canRun) return;
    if (this.phase === "connected" || this.phase === "charging" || this.phase === "connecting") {
      try {
        await dashboardController.disconnect();
      } catch {
        // proceed anyway; the pairing page reports what it hears
      }
    }
    Frame.topmost()?.navigate({ moduleName: "phone-ui/pairing-page", context: { onboarding: false } });
  }

  async onInstallFirmwareTap(): Promise<void> {
    await this.openFlashPage("install");
  }

  async onUninstallFirmwareTap(): Promise<void> {
    await this.openFlashPage("uninstall");
  }

  private async openFlashPage(mode: "install" | "uninstall"): Promise<void> {
    // The flasher needs the glasses to itself, so drop the main connection first.
    if (this.phase === "connected" || this.phase === "charging") {
      try {
        await dashboardController.disconnect();
      } catch {
        // proceed anyway; the flash page surfaces any connection trouble
      }
    }
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/onboarding-flash-page",
      context: { mode, fromOnboarding: false },
    });
  }

  onToggleLogTap(): void {
    this.showLog = !this.showLog;
  }

  onTextSettingTextChange(args: { value?: string; object?: { text?: string } }): void {
    dashboardController.setActiveTextSettingValue(
      args.object?.text ?? args.value ?? "",
      this.activeTextSettingId ?? undefined,
    );
  }

  onPrimaryTextSettingReturnPress(args: { object?: { text?: string; page?: { getViewById?: (id: string) => { focus?: () => void } | null } } }): void {
    // Commit the field's actual text at done-time, in case the final
    // keystroke's textChange hadn't landed yet.
    const text = args?.object?.text;
    if (typeof text === "string") {
      dashboardController.setActiveTextSettingValue(text, this.activeTextSettingId ?? undefined);
    }
    if (this.hasSecondaryTextSetting) {
      args.object?.page?.getViewById?.("secondarySettingsTextField")?.focus?.();
      return;
    }
    dashboardController.finishActiveTextSettingEdit();
  }

  onSecondaryTextSettingTextChange(args: { value?: string; object?: { text?: string } }): void {
    dashboardController.setActiveTextSettingValue(
      args.object?.text ?? args.value ?? "",
      this.secondaryTextSettingId ?? undefined,
    );
  }

  onSecondaryTextSettingReturnPress(args: { object?: { text?: string } }): void {
    const text = args?.object?.text;
    if (typeof text === "string") {
      dashboardController.setActiveTextSettingValue(text, this.secondaryTextSettingId ?? undefined);
    }
    dashboardController.finishActiveTextSettingEdit();
  }

  onOpenEvenAppSettingsTap(): void {
    dashboardController.openEvenAppSettings();
  }

  async onSyntheticUpTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("scroll-up");
  }

  async onSyntheticDownTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("scroll-down");
  }

  async onSyntheticLeftTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("double-click");
  }

  async onSyntheticRightTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("click");
  }

  async onSyntheticLongPressTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("long-press");
  }

  async onSyntheticMicTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("wakeword");
  }

  // ---- the phone's own controller: touchpad, d-pad, mirror touch ----
  //
  // Everything here is the watch scheme (origin "watch"): spatial swipes,
  // tap = select, double-tap / two fingers = back, hold = menu. The ring row
  // above stays on the ring's own scheme.

  private padPointers = 0;
  private padTwoFingerDown = false;

  /** What the next gesture lands on, as the watch pad shows it. */
  get padFocusLine(): string {
    if (this.phase !== "connected" && this.phase !== "charging") return "Glasses disconnected";
    if (!shell.isScreenOn()) return "Display off";
    const foreground = shell.getForegroundApp();
    return foreground ? foreground.title : "Launcher";
  }

  private refreshPadFocusLine(): void {
    this.notifyPropertyChange("padFocusLine", this.padFocusLine);
  }

  async onPadTap(): Promise<void> {
    if (this.padTwoFingerDown) return;
    await dashboardController.injectSyntheticRingInput("click", "watch");
    this.refreshPadFocusLine();
  }

  async onPadDoubleTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("double-click", "watch");
    this.refreshPadFocusLine();
  }

  async onPadLongPress(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("long-press", "watch");
    this.refreshPadFocusLine();
  }

  async onPadSwipe(args: SwipeGestureEventData): Promise<void> {
    await dashboardController.injectSyntheticRingInput(swipeKind(args.direction), "watch");
    this.refreshPadFocusLine();
  }

  /** Two fingers down and up without moving: back (the watch's two-finger tap). */
  async onPadTouch(args: TouchGestureEventData): Promise<void> {
    const count = args.getPointerCount();
    if (args.action === "down" || args.action === "move") {
      this.padPointers = Math.max(this.padPointers, count);
      if (count >= 2) this.padTwoFingerDown = true;
      return;
    }
    if (args.action === "up" || args.action === "cancel") {
      const twoFinger = this.padTwoFingerDown;
      this.padPointers = 0;
      if (twoFinger) {
        // Let the single-tap recognizer's delayed tap see the flag first.
        setTimeout(() => {
          this.padTwoFingerDown = false;
        }, 400);
        if (args.action === "up") {
          await dashboardController.injectSyntheticRingInput("double-click", "watch");
          this.refreshPadFocusLine();
        }
      }
    }
  }

  async onDpadUp(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("swipe-up", "watch");
    this.refreshPadFocusLine();
  }

  async onDpadDown(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("swipe-down", "watch");
    this.refreshPadFocusLine();
  }

  async onDpadLeft(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("swipe-left", "watch");
    this.refreshPadFocusLine();
  }

  async onDpadRight(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("swipe-right", "watch");
    this.refreshPadFocusLine();
  }

  async onDpadSelect(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("click", "watch");
    this.refreshPadFocusLine();
  }

  async onBackTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("double-click", "watch");
    this.refreshPadFocusLine();
  }

  async onMenuTap(): Promise<void> {
    await dashboardController.injectSyntheticRingInput("long-press", "watch");
    this.refreshPadFocusLine();
  }

  // ---- touching the mirror itself ----

  get mirrorTouchEnabled(): boolean {
    return getBooleanSetting(MIRROR_TOUCH_KEY, true);
  }

  onMirrorTouchChange(args: { value?: boolean; object?: { checked?: boolean } }): void {
    const on = typeof args.value === "boolean" ? args.value : Boolean(args.object?.checked);
    setBooleanSetting(MIRROR_TOUCH_KEY, on);
    this.notifyPropertyChange("mirrorTouchEnabled", on);
  }

  private mirrorFraction(args: GestureEventData & { getX?: () => number; getY?: () => number }): { nx: number; ny: number } | null {
    const view = args.object as View | undefined;
    const size = view?.getActualSize?.();
    if (!view || !size || !size.width || !size.height || !args.getX || !args.getY) return null;
    // On Android the gesture's getX/getY are screen-absolute (in DIPs), not
    // view-local; the view's own screen position makes them local.
    const origin = view.getLocationOnScreen?.() ?? { x: 0, y: 0 };
    const localX = args.getX() - origin.x;
    const localY = args.getY() - origin.y;
    return { nx: localX / size.width, ny: localY / size.height };
  }

  private async mirrorGesture(kind: MirrorTouchKind, args: GestureEventData): Promise<void> {
    if (!this.mirrorTouchEnabled) return;
    const at = this.mirrorFraction(args) ?? { nx: 0.5, ny: 0.5 };
    await dashboardController.handleMirrorTouch(kind, at.nx, at.ny);
    this.refreshPadFocusLine();
  }

  onMirrorTap(args: GestureEventData): Promise<void> {
    return this.mirrorGesture("tap", args);
  }

  onMirrorDoubleTap(args: GestureEventData): Promise<void> {
    return this.mirrorGesture("double-tap", args);
  }

  onMirrorLongPress(args: GestureEventData): Promise<void> {
    return this.mirrorGesture("long-press", args);
  }

  onMirrorSwipe(args: SwipeGestureEventData): Promise<void> {
    return this.mirrorGesture(swipeKind(args.direction), args);
  }

  // ---- display mode and brightness, beside the mirror ----

  get displayModeLabel(): string {
    return displayModeLabel(displayModeSetting.get()) + " ▾";
  }

  async onDisplayModeTap(): Promise<void> {
    const current = displayModeSetting.get();
    const options = DISPLAY_MODE_VALUES.map((value) => displayModeLabel(value) + (value === current ? "  ✓" : ""));
    const picked = await Dialogs.action({ title: "Display mode", cancelButtonText: "Cancel", actions: options });
    const index = options.indexOf(picked);
    if (index < 0) return;
    const value = DISPLAY_MODE_VALUES[index] as DisplayModeSetting;
    if (value !== current) displayModeSetting.set(value);
    this.notifyPropertyChange("displayModeLabel", this.displayModeLabel);
  }

  get brightnessAuto(): boolean {
    return brightnessSetting.get() === "auto";
  }

  get brightnessSliderEnabled(): boolean {
    return !this.brightnessAuto;
  }

  /** The slider's position; while Auto, the last manual level (or 50). */
  get brightnessPercent(): number {
    const value = brightnessSetting.get();
    if (value === "auto") return this.lastManualBrightness;
    const numeric = parseInt(value, 10);
    return Number.isFinite(numeric) ? numeric : 50;
  }

  private lastManualBrightness = 50;

  onBrightnessChange(args: { value?: number; object?: { value?: number } }): void {
    if (this.brightnessAuto) return;
    const raw = typeof args.value === "number" ? args.value : Number(args.object?.value ?? NaN);
    if (!Number.isFinite(raw)) return;
    // The setting only has every tenth level; snap to the nearest.
    const level = Math.min(100, Math.max(0, Math.round(raw / 10) * 10));
    this.lastManualBrightness = level;
    const value = String(level) as BrightnessSetting;
    if (brightnessSetting.get() !== value) brightnessSetting.set(value);
  }

  onBrightnessAutoChange(args: { value?: boolean; object?: { checked?: boolean } }): void {
    const on = typeof args.value === "boolean" ? args.value : Boolean(args.object?.checked);
    if (on) {
      if (brightnessSetting.get() !== "auto") {
        this.lastManualBrightness = this.brightnessPercent;
        brightnessSetting.set("auto");
      }
    } else if (brightnessSetting.get() === "auto") {
      brightnessSetting.set(String(this.lastManualBrightness) as BrightnessSetting);
    }
    this.refreshDisplayControls();
  }

  private refreshDisplayControls(): void {
    this.notifyPropertyChange("brightnessAuto", this.brightnessAuto);
    this.notifyPropertyChange("brightnessSliderEnabled", this.brightnessSliderEnabled);
    this.notifyPropertyChange("brightnessPercent", this.brightnessPercent);
    this.notifyPropertyChange("displayModeLabel", this.displayModeLabel);
  }

  private appendLog(line: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    this.log = this.log ? `${this.log}\n[${stamp}] ${line}` : `[${stamp}] ${line}`;
  }

  private readLayoutOrientation(): LayoutOrientation {
    const applicationOrientation = Application.orientation();
    if (applicationOrientation === "landscape" || applicationOrientation === "portrait") {
      return applicationOrientation;
    }
    return Screen.mainScreen.widthDIPs > Screen.mainScreen.heightDIPs ? "landscape" : "portrait";
  }

  private formatError(error: unknown): string {
    const raw = (error as Error)?.message ?? String(error);
    const sanitized = raw.replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
    if (sanitized.length <= 240) return sanitized;
    return `${sanitized.slice(0, 237)}...`;
  }
}

const MIRROR_TOUCH_KEY = "phone.mirrorTouch";

/** NativeScript swipe direction -> the watch-scheme directional gesture. */
function swipeKind(direction: SwipeDirection): "swipe-up" | "swipe-down" | "swipe-left" | "swipe-right" {
  switch (direction) {
    case SwipeDirection.up:
      return "swipe-up";
    case SwipeDirection.down:
      return "swipe-down";
    case SwipeDirection.left:
      return "swipe-left";
    default:
      return "swipe-right";
  }
}
