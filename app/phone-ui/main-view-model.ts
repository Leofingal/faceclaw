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
  mirrorTouchSetting,
  onAnySettingChanged,
  type BrightnessSetting,
  type DisplayModeSetting,
} from "../ui/dashboard-settings";
import { isValidMacAddress, loadDeviceAddresses } from "../g2/device-addresses";
import { isAutoReconnectSuppressed, resumeAutoReconnect } from "../g2/reconnect-policy";
import { formatErrorMessage } from "../util/format-error";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH } from "../graphics/image";
import { sentimentBucket } from "../apps/microphones/sentiment";
import {
  conversationStore,
  formatDateTime,
  formatDuration,
  NO_CONVERSATIONS_MESSAGE,
  SENTIMENT_BUCKET_COLORS,
  type SessionRow,
} from "./conversation-format";
import {
  displayClass,
  foldSnapshot,
  onFoldStateChanged,
  refreshFoldTracking,
  type CompanionDisplayClass,
} from "../native/fold-state";
import { GhostCompanionViewModel } from "./ghost-companion-view-model";

const LENS_ASPECT_RATIO = G2_LENS_WIDTH / G2_LENS_HEIGHT;

type LayoutOrientation = "portrait" | "landscape";

type ControlsTab = "settings" | "watch" | "ring";

/** How many recent conversations the home hub shows before "See all". */
const HOME_RECENT_LIMIT = 3;

/**
 * One home-hub conversation row. A trimmed version of the conversations page's
 * row (no speaker chips) — the home screen is a glance, not the list.
 */
export type HomeConversationRow = {
  title: string;
  meta: string;
  sentimentColor: string;
  onRowTap: () => void;
};

// Survives navigation round-trips (a fresh view model is built per visit) but
// not process restarts.
let lastControlsTab: ControlsTab = "watch";

/**
 * Backs both pages that sit at the top of the app: the home hub (main-page)
 * and the glasses mirror (glasses-mirror-page). They share one model because
 * they share one job — holding the live connection state, the app-level
 * warnings and the glasses-driven text editor — and only ever one of them is
 * on screen at a time. The home hub binds the navigation and recent-
 * conversation members plus the two display settings; the mirror page binds
 * the preview, the tabbed controllers and the same display settings.
 */
export class MainViewModel extends Observable {
  private _status = "Disconnected.";
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
  private _warningsModalVisible = false;
  private _phase: "disconnected" | "connecting" | "connected" | "charging" | "disconnecting" = "disconnected";

  // ── What the phone shows, and why ────────────────────────────────────────
  //
  // The home hub is one of three bodies this page can be, chosen by two live
  // signals rather than by navigation:
  //
  //   the FOLD    cover screen -> the glance; inner screen -> the full app.
  //   the GLASSES whichever app has the foreground window over there decides
  //               what the phone's full app shows. Ghost focused -> Ghost's
  //               companion. Anything else -> the hub.
  //
  // Neither is a phone-side mode the user sets, which is the whole point: the
  // companion follows the wearer instead of being a menu he has to drive.
  private _displayClass: CompanionDisplayClass = displayClass(foldSnapshot());
  private _foregroundAppId: string | null = null;
  private _foregroundAppTitle: string | null = null;
  /**
   * "Show me the hub anyway", from the button on the Ghost companion. Cleared
   * whenever the glasses change app, so it is a peek and not a mode — the next
   * thing that happens over there puts the phone back in step.
   */
  private _hubOverride = false;

  /** Ghost's companion screen. Built once; it owns its own feed subscription. */
  readonly ghostCompanion = new GhostCompanionViewModel();

  // A new view model is built on every navigation to the main page; these
  // module-level subscriptions must die with it (see dispose) or each
  // round-trip to another page leaks a listener that pins the dead model.
  private readonly unsubscribers: Array<() => void> = [];

  constructor() {
    super();
    this.attach();
  }

  /**
   * Subscribe to the controller and settings. Idempotent; the page calls it
   * again from `loaded` because an app suspend fires unloaded/loaded (which
   * dispose the model) without a navigation building a fresh one. Subscribing
   * delivers the current snapshot, so a re-attached model catches up.
   */
  attach(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers.push(dashboardController.subscribe((snapshot) => {
      this.status = snapshot.status;
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
      this.setForegroundApp(snapshot.foregroundAppId, snapshot.foregroundAppTitle);
      this.refreshPadFocusLine();
    }));
    // Brightness / display mode can change from the glasses' Settings app too.
    this.unsubscribers.push(onAnySettingChanged(() => this.refreshDisplayControls()));
    // Folding, unfolding, and any other window resize.
    this.unsubscribers.push(onFoldStateChanged((snapshot) => this.setDisplayClass(displayClass(snapshot))));
    this.ghostCompanion.attach();
    // The companion's own feed drives the cover screen's one line of content,
    // so the glance updates while the Fold is shut without anything polling.
    // Observable.on returns void, so the unsubscriber is written by hand.
    const glanceHandler = () => {
      if (this._displayClass !== "compact") return;
      this.notifyPropertyChange("glassesGlanceText", this.glassesGlanceText);
    };
    this.ghostCompanion.on(Observable.propertyChangeEvent, glanceHandler);
    this.unsubscribers.push(() => this.ghostCompanion.off(Observable.propertyChangeEvent, glanceHandler));
  }

  /** Detach from the controller and settings; the page calls this when it lets go of the model. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.ghostCompanion.dispose();
  }

  get status(): string {
    return this._status;
  }

  set status(value: string) {
    if (this._status !== value) {
      this._status = value;
      this.notifyPropertyChange("status", value);
      this.notifyPropertyChange("connectionStatusLabel", this.connectionStatusLabel);
    }
  }

  /**
   * Short connection indicator for the action bar. The full status string
   * (which can be a sentence, e.g. a failure reason) stays available by
   * tapping the indicator.
   */
  get connectionStatusLabel(): string {
    switch (this._phase) {
      case "connected":
        return "Connected";
      case "charging":
        return "Charging";
      case "disconnecting":
        return "Disconnecting";
      case "connecting":
        // The transport reports retry loops as "Reconnecting..." with the
        // phase still "connecting"; keep that distinction visible.
        return this._status.startsWith("Reconnecting") ? "Reconnecting" : "Connecting";
      default:
        return this._status.startsWith("Failed") ? "Failed" : "Disconnected";
    }
  }

  onConnectionStatusTap(): void {
    void Dialogs.alert({ title: "Connection status", message: this._status, okButtonText: "OK" });
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
    // Must match the landscape grid's fixed side-panel column in main-page.xml.
    const sidePanelWidth = 360;
    const availableWidth = Math.max(240, Math.floor(screenWidth - sidePanelWidth - 56));
    return Math.floor(availableWidth / 2);
  }

  /** Near-full-width on phones, capped on tablets (the 32 clears the 16 margins). */
  get warningsModalWidth(): number {
    return Math.min(Screen.mainScreen.widthDIPs - 32, 480);
  }

  /**
   * The simulated watch face (and the Back/Menu row under it) is capped at a
   * 1.5:1 face aspect; on narrow phones the available width governs instead.
   */
  get watchFaceWidth(): number {
    // Must match .touchpad height in app.css.
    const faceHeight = 230;
    const available =
      this._layoutOrientation === "landscape"
        ? // The landscape side panel column (see main-page.xml) minus its
          // m-l-16 margin and the controls' own 8+8 margins.
          360 - 32
        : Screen.mainScreen.widthDIPs - 56; // p-20 padding + controls margins
    return Math.min(available, Math.round(faceHeight * 1.5));
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
    this.notifyPropertyChange("warningsModalWidth", this.warningsModalWidth);
    this.notifyPropertyChange("watchFaceWidth", this.watchFaceWidth);
  }

  // =========================================================================
  // Which body the page is showing
  //
  // Three, chosen by the fold and by the glasses (see the field comments):
  // the cover glance, Ghost's companion, and the home hub. Exactly one is
  // visible; they share the page's grid cell rather than being separate pages,
  // because neither signal is a navigation the user performed — a page swap
  // would put a back-stack entry behind a screen he never asked to leave.

  /**
   * Re-point fold tracking at the Activity on screen and re-read the posture.
   * Called from the page's `loaded`: WindowInfoTracker needs an Activity, and
   * a suspend/resume can hand us a different instance of one.
   */
  refreshFoldMetrics(): void {
    refreshFoldTracking();
    this.setDisplayClass(displayClass(foldSnapshot()));
  }

  private setDisplayClass(next: CompanionDisplayClass): void {
    if (this._displayClass === next) return;
    this._displayClass = next;
    this.notifyBodyChange();
  }

  private setForegroundApp(appId: string | null, title: string | null): void {
    if (this._foregroundAppId === appId && this._foregroundAppTitle === title) return;
    // Changing app over there ends any "show me the hub anyway" peek: the
    // override exists to look away from Ghost, not to pin the phone.
    if (this._foregroundAppId !== appId) this._hubOverride = false;
    this._foregroundAppId = appId;
    this._foregroundAppTitle = title;
    this.notifyPropertyChange("glassesForegroundLabel", this.glassesForegroundLabel);
    this.notifyBodyChange();
  }

  private notifyBodyChange(): void {
    this.notifyPropertyChange("coverGlanceVisibility", this.coverGlanceVisibility);
    this.notifyPropertyChange("ghostCompanionVisibility", this.ghostCompanionVisibility);
    this.notifyPropertyChange("hubBodyVisibility", this.hubBodyVisibility);
    this.notifyPropertyChange("ghostReturnRowVisibility", this.ghostReturnRowVisibility);
    this.notifyPropertyChange("glassesGlanceText", this.glassesGlanceText);
  }

  private get isGhostForeground(): boolean {
    return this._foregroundAppId === "ghost";
  }

  get coverGlanceVisibility(): "visible" | "collapse" {
    return this._displayClass === "compact" ? "visible" : "collapse";
  }

  get ghostCompanionVisibility(): "visible" | "collapse" {
    return this._displayClass === "expanded" && this.isGhostForeground && !this._hubOverride
      ? "visible"
      : "collapse";
  }

  get hubBodyVisibility(): "visible" | "collapse" {
    return this.coverGlanceVisibility === "collapse" && this.ghostCompanionVisibility === "collapse"
      ? "visible"
      : "collapse";
  }

  /** The way back to Ghost's companion after peeking at the hub. */
  get ghostReturnRowVisibility(): "visible" | "collapse" {
    return this._hubOverride && this.isGhostForeground ? "visible" : "collapse";
  }

  onShowHubTap(): void {
    this._hubOverride = true;
    this.notifyBodyChange();
  }

  onShowGhostTap(): void {
    this._hubOverride = false;
    this.notifyBodyChange();
  }

  /** What is on the lens right now, for the cover screen's one content card. */
  get glassesForegroundLabel(): string {
    return this._foregroundAppTitle ?? "Home";
  }

  get glassesGlanceText(): string {
    if (this._phase !== "connected" && this._phase !== "charging") {
      return "Not connected to the glasses.";
    }
    if (this.isGhostForeground) return this.ghostCompanion.glanceHeadline();
    return this._foregroundAppTitle
      ? `${this._foregroundAppTitle} is open on the glasses.`
      : "Resting on the home screen.";
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
      // Keyboard-input mode: the tabbed controls make way for the editor.
      this.notifyPropertyChange("controlsVisibility", this.controlsVisibility);
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
      this.refreshWarningIndicator();
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
      this.refreshWarningIndicator();
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
      this.refreshWarningIndicator();
    }
  }

  get batteryOptimizationWarningVisibility(): "visible" | "collapse" {
    return this._batteryOptimizationWarningVisible ? "visible" : "collapse";
  }

  onAllowBackgroundUsageTap(): void {
    this.setWarningsModalVisible(false);
    dashboardController.requestBatteryOptimizationExemption();
  }

  // ---- the action bar's warning triangle and the modal behind it ----

  get anyWarningVisible(): boolean {
    return (
      this._evenAppConflictWarningVisible ||
      this._firmwareWarningVisible ||
      this._batteryOptimizationWarningVisible
    );
  }

  get warningIconVisibility(): "visible" | "collapse" {
    return this.anyWarningVisible ? "visible" : "collapse";
  }

  get warningsModalVisibility(): "visible" | "collapse" {
    return this._warningsModalVisible ? "visible" : "collapse";
  }

  onWarningIconTap(): void {
    this.setWarningsModalVisible(true);
  }

  onWarningsModalCloseTap(): void {
    this.setWarningsModalVisible(false);
  }

  private setWarningsModalVisible(value: boolean): void {
    if (this._warningsModalVisible !== value) {
      this._warningsModalVisible = value;
      this.notifyPropertyChange("warningsModalVisibility", this.warningsModalVisibility);
    }
  }

  private refreshWarningIndicator(): void {
    this.notifyPropertyChange("warningIconVisibility", this.warningIconVisibility);
    // Don't leave the modal open showing nothing once the last warning clears.
    if (!this.anyWarningVisible) {
      this.setWarningsModalVisible(false);
    }
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
      this.notifyPropertyChange("connectItemEnabled", this.connectItemEnabled);
      this.notifyPropertyChange("connectionStatusLabel", this.connectionStatusLabel);
      // The cover screen leads with connectivity: a disconnected pair makes
      // "what is on the lens" a lie, so the glance says so instead.
      this.notifyPropertyChange("glassesGlanceText", this.glassesGlanceText);
    }
  }

  get buttonLabel(): string {
    switch (this.phase) {
      case "connecting":
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

  /**
   * Unlike the other canRun-gated menu items, Connect/Disconnect stays live
   * while connecting: Disconnect is the only way out of a reconnection-attempt
   * loop short of force-stopping the app.
   */
  get connectItemEnabled(): boolean {
    return this.phase !== "disconnecting";
  }

  async onTap(): Promise<void> {
    if (!this.connectItemEnabled) return;

    try {
      if (this.phase === "disconnected") {
        await dashboardController.connect();
      } else {
        await dashboardController.disconnect();
      }
    } catch (error) {
      const message = this.formatError(error);
      if (!this.status.startsWith("Failed:")) {
        this.status = `Failed: ${message}`;
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

  onPermissionsTap(): void {
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/permissions-page",
      context: { onboarding: false },
    });
  }

  /** Review saved caption sessions; works without a glasses connection. */
  onConversationsTap(): void {
    Frame.topmost()?.navigate("phone-ui/conversations-page");
  }

  onAskTap(): void {
    Frame.topmost()?.navigate("phone-ui/ask-page");
  }

  onSpeakersTap(): void {
    Frame.topmost()?.navigate("phone-ui/speakers-page");
  }

  /**
   * The lens mirror and the simulated ring/watch pads. Kept for debugging and
   * for driving the glasses when the ring is out of reach; not where the phone
   * lands any more.
   */
  onGlassesMirrorTap(): void {
    Frame.topmost()?.navigate("phone-ui/glasses-mirror-page");
  }

  /** The bundled project docs, in the phone-side text viewer. */
  async onAboutTap(): Promise<void> {
    const docs = [
      { action: "License (GPLv3)", fileName: "LICENSE" },
      { action: "Privacy Policy", fileName: "PRIVACY" },
    ];
    const picked = await Dialogs.action({
      title: "About",
      cancelButtonText: "Cancel",
      actions: docs.map((doc) => doc.action),
    });
    const doc = docs.find((candidate) => candidate.action === picked);
    if (!doc) return;
    Frame.topmost()?.navigate({
      moduleName: "phone-ui/document-page",
      context: { fileName: doc.fileName, title: doc.action },
    });
  }

  // ---- the home hub's recent-conversations glance ----

  private _recentConversations: HomeConversationRow[] = [];
  private _recentConversationsMessage = "";

  get recentConversations(): HomeConversationRow[] {
    return this._recentConversations;
  }

  get recentConversationsMessage(): string {
    return this._recentConversationsMessage;
  }

  get recentConversationsMessageVisibility(): "visible" | "collapse" {
    return this._recentConversationsMessage ? "visible" : "collapse";
  }

  /**
   * Re-read the newest few sessions. The page calls this from `loaded`, which
   * also fires on the way back from a conversation, so a deletion or a rename
   * made elsewhere shows up here. The store sorts newest-first and honours
   * `limit`, so this stays a three-row query however long the history gets.
   */
  refreshRecentConversations(): void {
    if (!global.isAndroid) {
      this.setRecentConversations([], "Conversation review is only available on Android.");
      return;
    }
    let rows: SessionRow[] = [];
    try {
      rows = JSON.parse(
        String(conversationStore().querySessions(JSON.stringify({ limit: HOME_RECENT_LIMIT }))),
      ) as SessionRow[];
    } catch (error) {
      console.error(`recent conversations query failed: ${String(error)}`);
      this.setRecentConversations([], "Could not read saved conversations.");
      return;
    }
    this.setRecentConversations(
      rows.map((row) => this.toRecentRow(row)),
      rows.length > 0 ? "" : NO_CONVERSATIONS_MESSAGE,
    );
  }

  private setRecentConversations(rows: HomeConversationRow[], message: string): void {
    this._recentConversations = rows;
    this._recentConversationsMessage = message;
    this.notifyPropertyChange("recentConversations", rows);
    this.notifyPropertyChange("recentConversationsMessage", message);
    this.notifyPropertyChange("recentConversationsMessageVisibility", this.recentConversationsMessageVisibility);
  }

  private toRecentRow(row: SessionRow): HomeConversationRow {
    const durationMs = row.endedAt > row.startedAt ? row.endedAt - row.startedAt : 0;
    const meta = [formatDateTime(row.startedAt), formatDuration(durationMs), `${row.segmentCount} lines`]
      .filter((part) => part.length > 0)
      .join(" · ");
    return {
      title: row.title || formatDateTime(row.startedAt),
      meta,
      sentimentColor: SENTIMENT_BUCKET_COLORS[sentimentBucket(row.avgSentiment ?? 0)],
      onRowTap: () => {
        Frame.topmost()?.navigate({
          moduleName: "phone-ui/conversation-page",
          context: { sessionId: row.id },
        });
      },
    };
  }

  /**
   * Live scan that names each nearby pair by model, colour, and serial and
   * checks both arms belong together. A connected arm stops advertising, so
   * drop the current link first. disconnect() enters the manual-disconnected
   * state; pairing is a detour, not a Disconnect, so lift the suppression
   * right away — nothing dials the glasses until the main page's autoConnect
   * runs again on the way back.
   */
  async onPairGlassesTap(): Promise<void> {
    if (!this.canRun) return;
    if (this.phase === "connected" || this.phase === "charging" || this.phase === "connecting") {
      try {
        await dashboardController.disconnect();
      } catch {
        // proceed anyway; the pairing page reports what it hears
      }
      resumeAutoReconnect();
    }
    Frame.topmost()?.navigate({ moduleName: "phone-ui/pairing-page", context: { onboarding: false } });
  }

  async onInstallFirmwareTap(): Promise<void> {
    this.setWarningsModalVisible(false);
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
    this.setWarningsModalVisible(false);
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

  private padTwoFingerDown = false;

  /** What the next gesture lands on, as the watch pad shows it. */
  get padFocusLine(): string {
    return dashboardController.glassesDisplayLabel();
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
      if (count >= 2) this.padTwoFingerDown = true;
      return;
    }
    if (args.action === "up" || args.action === "cancel") {
      const twoFinger = this.padTwoFingerDown;
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

  // Toggled from Settings > Phone display > Touch mirror; read per gesture,
  // so no change notification is needed.
  get mirrorTouchEnabled(): boolean {
    return mirrorTouchSetting.get();
  }

  private mirrorFraction(args: GestureEventData & { getX?: () => number; getY?: () => number }): { nx: number; ny: number } | null {
    const view = args.object as View | undefined;
    const size = view?.getActualSize?.();
    if (!view || !size || !size.width || !size.height || !args.getX || !args.getY) return null;
    // NativeScript's gesture getX/getY are view-local DIPs (the view's own
    // MotionEvent coordinates), so they divide straight into the view's size.
    return { nx: args.getX() / size.width, ny: args.getY() / size.height };
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

  // ---- the tabbed controls area below the mirror ----
  //
  // Three tabs: Settings (screen size + brightness), Watch (the simulated
  // watch face), Ring (simulated R1 inputs). The whole area collapses while a
  // text setting is being edited so the editor gets the space instead.

  private _controlsTab: ControlsTab = lastControlsTab;

  get controlsVisibility(): "visible" | "collapse" {
    return this.isTextSettingEditorActive ? "collapse" : "visible";
  }

  get settingsTabVisibility(): "visible" | "collapse" {
    return this._controlsTab === "settings" ? "visible" : "collapse";
  }

  get watchTabVisibility(): "visible" | "collapse" {
    return this._controlsTab === "watch" ? "visible" : "collapse";
  }

  get ringTabVisibility(): "visible" | "collapse" {
    return this._controlsTab === "ring" ? "visible" : "collapse";
  }

  get settingsTabClass(): string {
    return this._controlsTab === "settings" ? "tab-button tab-button-selected" : "tab-button";
  }

  get watchTabClass(): string {
    return this._controlsTab === "watch" ? "tab-button tab-button-selected" : "tab-button";
  }

  get ringTabClass(): string {
    return this._controlsTab === "ring" ? "tab-button tab-button-selected" : "tab-button";
  }

  onSettingsTabTap(): void {
    this.setControlsTab("settings");
  }

  onWatchTabTap(): void {
    this.setControlsTab("watch");
  }

  onRingTabTap(): void {
    this.setControlsTab("ring");
  }

  private setControlsTab(tab: ControlsTab): void {
    if (this._controlsTab === tab) return;
    this._controlsTab = tab;
    // Remembered across navigations (module-level) so the page comes back on
    // the tab it left on; deliberately not persisted to disk.
    lastControlsTab = tab;
    this.notifyPropertyChange("settingsTabVisibility", this.settingsTabVisibility);
    this.notifyPropertyChange("watchTabVisibility", this.watchTabVisibility);
    this.notifyPropertyChange("ringTabVisibility", this.ringTabVisibility);
    this.notifyPropertyChange("settingsTabClass", this.settingsTabClass);
    this.notifyPropertyChange("watchTabClass", this.watchTabClass);
    this.notifyPropertyChange("ringTabClass", this.ringTabClass);
  }

  // ---- display mode and brightness, on the Settings tab ----

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

  private readLayoutOrientation(): LayoutOrientation {
    const applicationOrientation = Application.orientation();
    if (applicationOrientation === "landscape" || applicationOrientation === "portrait") {
      return applicationOrientation;
    }
    return Screen.mainScreen.widthDIPs > Screen.mainScreen.heightDIPs ? "landscape" : "portrait";
  }

  private formatError(error: unknown): string {
    return formatErrorMessage(error, 240);
  }
}

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
