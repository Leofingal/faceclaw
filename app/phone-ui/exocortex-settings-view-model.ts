/**
 * Exocortex's own Settings screen on the phone — the design pilot's
 * categorized page (session 0142: Display / Glasses / Notifications /
 * Interface / About), ported onto faceclaw's real settings objects.
 *
 * What it replaces: nothing was deleted. Faceclaw's own Settings app on the
 * GLASSES is untouched, and so is the mirror page's Settings tab. What did not
 * exist before is a phone-side settings surface of Exocortex's own, which is
 * where the notification ignore list and the app-list controls have to live —
 * they are both things you configure once, with a thumb, not through a ring.
 *
 * Every row here reads and writes the SAME ConfigSetting objects the glasses
 * menu edits, so the two can never disagree; onAnySettingChanged re-reads the
 * page when something is changed from the other side.
 */
import { Frame, Observable } from "@nativescript/core";

import {
  batteryDisplayModeSetting,
  brightnessSetting,
  displayModeSetting,
  lockScreenEnabledSetting,
  onAnySettingChanged,
  screenTimeoutSetting,
  timeFormatSetting,
  verticalPositionSetting,
} from "../ui/dashboard-settings";
import { setUiFontSize, uiFontSizeLabel, UI_FONT_SIZE_PRESETS } from "../graphics/ui-fonts";
import { mutedNotificationSourceCount } from "../native/notification-sources";
import { ALL_APPS } from "../apps/all-apps";
import { isAppVisibleInExocortex, isCuratedAppId } from "../native/exocortex-app-list";

export class ExocortexSettingsViewModel extends Observable {
  private offSettingChanged: (() => void) | null = null;

  constructor() {
    super();
    this.offSettingChanged = onAnySettingChanged(() => this.refresh());
  }

  dispose(): void {
    this.offSettingChanged?.();
    this.offSettingChanged = null;
  }

  /** Re-read every displayed value. Cheap: they are all setting reads. */
  refresh(): void {
    for (const property of [
      "brightnessLabel",
      "screenTimeoutLabel",
      "verticalPositionLabel",
      "lockScreenEnabled",
      "displayModeLabel",
      "timeFormatLabel",
      "batteryDisplayLabel",
      "textSizeLabel",
      "notificationSourcesSummary",
      "appListSummary",
    ]) {
      this.notifyPropertyChange(property, (this as unknown as Record<string, unknown>)[property]);
    }
  }

  // ---- Glasses ----

  get brightnessLabel(): string {
    return brightnessSetting.displayValue();
  }

  onBrightnessTap(): void {
    brightnessSetting.set(brightnessSetting.next());
    this.refresh();
  }

  get screenTimeoutLabel(): string {
    return screenTimeoutSetting.displayValue();
  }

  onScreenTimeoutTap(): void {
    screenTimeoutSetting.set(screenTimeoutSetting.next());
    this.refresh();
  }

  get verticalPositionLabel(): string {
    return verticalPositionSetting.displayValue();
  }

  onVerticalPositionTap(): void {
    verticalPositionSetting.set(verticalPositionSetting.next());
    this.refresh();
  }

  get lockScreenEnabled(): boolean {
    return lockScreenEnabledSetting.get();
  }

  onLockScreenChange(args: { object: { checked: boolean } }): void {
    const checked = Boolean(args?.object?.checked);
    if (checked === lockScreenEnabledSetting.get()) return;
    lockScreenEnabledSetting.set(checked);
  }

  // ---- Display ----

  get displayModeLabel(): string {
    return displayModeSetting.displayValue();
  }

  onDisplayModeTap(): void {
    displayModeSetting.set(displayModeSetting.next());
    this.refresh();
  }

  get timeFormatLabel(): string {
    return timeFormatSetting.displayValue();
  }

  onTimeFormatTap(): void {
    timeFormatSetting.set(timeFormatSetting.next());
    this.refresh();
  }

  get batteryDisplayLabel(): string {
    return batteryDisplayModeSetting.displayValue();
  }

  onBatteryDisplayTap(): void {
    batteryDisplayModeSetting.set(batteryDisplayModeSetting.next());
    this.refresh();
  }

  /**
   * Text size on the glasses. Cycles the three presets rather than opening a
   * picker: three sizes is the whole useful range inside the line-height
   * bounds UI layouts are guaranteed, and a cycle is one thumb tap.
   */
  get textSizeLabel(): string {
    return uiFontSizeLabel();
  }

  onTextSizeTap(): void {
    const current = uiFontSizeLabel();
    const index = UI_FONT_SIZE_PRESETS.findIndex((preset) => preset.label === current);
    const next = UI_FONT_SIZE_PRESETS[(index + 1) % UI_FONT_SIZE_PRESETS.length]!;
    setUiFontSize(next.size);
    this.refresh();
  }

  // ---- Notifications ----

  get notificationSourcesSummary(): string {
    const muted = mutedNotificationSourceCount();
    if (!muted) return "Nothing muted";
    return muted === 1 ? "1 app muted" : `${muted} apps muted`;
  }

  onNotificationSourcesTap(): void {
    Frame.topmost()?.navigate("phone-ui/notification-sources-page");
  }

  // ---- Apps ----

  get appListSummary(): string {
    const listable = ALL_APPS.filter((app) => app.showInLauncher !== false);
    const shown = listable.filter((app) =>
      isAppVisibleInExocortex(app.appId, isCuratedAppId(app.appId)),
    ).length;
    return `${shown} of ${listable.length} in the list`;
  }

  onAppListTap(): void {
    Frame.topmost()?.navigate("phone-ui/exocortex-apps-page");
  }
}
