/**
 * THE SETTINGS TREE, ONCE — the single definition of which category owns which
 * setting, shared by the glasses' Settings panel (ui/dashboard/settings-menus)
 * and the phone's own Settings page (phone-ui/exocortex-settings-*).
 *
 * WHY IT EXISTS (2026-09-03). Chris, having browsed the live UI to check:
 * "all those things in the settings function, there's the settings app that is
 * in the menu of apps, in the exocortex menu. I want those settings to be
 * settings so they should be under the gear, instead of being a separate app
 * that opens on the glasses" — and, immediately after: "they should be all
 * editable on the phone side without any glasses interaction... it should be
 * like the same content, just inside a separate category or multiple
 * categories — maybe the categories are tied to those menu parameters."
 *
 * "The same content" is the operative phrase, and it is what makes a shared
 * definition the only honest way to build this. A hand-written copy of the
 * category list on the phone would be correct exactly once: the next setting
 * added to the glasses menu would silently not exist on the surface that is
 * now the only one the wearer can reach.
 *
 * Entries are either a real ConfigSetting — read and written identically from
 * either surface, so nothing can disagree — or a `special`, which is an action
 * rather than a value (a model download, a font picker) and which each surface
 * renders in its own way. Splitting them like this is what lets one list
 * describe two very different UIs without either one pretending to be the
 * other.
 */
import { shell } from "./shell/shell";
import {
  anthropicApiKeySetting,
  assistantAllowProactiveSetting,
  assistantBackendSetting,
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
  assistantModelSetting,
  assistantSkipConfirmationSetting,
  batteryDisplayModeSetting,
  brightnessSetting,
  ConfigSetting,
  displayModeSetting,
  elevenLabsApiKeySetting,
  firmwareDebugFlagsSetting,
  lockScreenEnabledSetting,
  mapboxApiKeySetting,
  mirrorTouchSetting,
  openAiApiKeySetting,
  previewColorSetting,
  ringConnectionModeSetting,
  saveVoiceRecordingsSetting,
  screenTimeoutSetting,
  showBleBandwidthSetting,
  sonioxApiKeySetting,
  suspendEvenHubWhenScreenOffSetting,
  terminalAutoReconnectSetting,
  terminalLaunchPresetsSetting,
  terminalWakeOnBellSetting,
  timeFormatSetting,
  useMicControlSetting,
  verticalPositionSetting,
  voiceProviderSetting,
  wakeWordActionSetting,
  watchCanUnlockSetting,
  watchCrownClockwiseNextSetting,
  watchMirrorAssistantSetting,
  watchRemoteEnabledSetting,
} from "./dashboard-settings";

/**
 * Any setting a category can hold.
 *
 * The value type is deliberately `any` rather than a union of the three
 * concrete classes: `ConfigSetting`'s own value formatter is a function
 * PROPERTY, and under strictFunctionTypes a `ConfigSettingEnum<"icon" |
 * "percentage">` is therefore not assignable to a widened
 * `ConfigSettingEnum<string>`. Nothing is actually lost — both surfaces narrow
 * with `instanceof` before touching a value, which is what decides the control
 * they draw anyway.
 */
export type CatalogSetting = ConfigSetting<any>;

/** An action rather than a value. Each surface renders these its own way. */
export type CatalogSpecialId =
  | "ui-font"
  | "terminal-font"
  | "asr-moonshine"
  | "asr-whisper"
  | "local-model";

export type CatalogEntry =
  | { kind: "setting"; setting: CatalogSetting; onChange?: () => void }
  | { kind: "special"; id: CatalogSpecialId };

export type SettingsCategory = {
  label: string;
  /** One line for the phone, which has room for it; the glasses do not. */
  blurb: string;
  entries: CatalogEntry[];
};

function value(setting: CatalogSetting, onChange?: () => void): CatalogEntry {
  return { kind: "setting", setting, onChange };
}

function special(id: CatalogSpecialId): CatalogEntry {
  return { kind: "special", id };
}

/**
 * Category order and within-category order both match what the glasses panel
 * has always shown, deliberately — Chris asked for "the same content, just
 * inside a separate category or multiple categories", not a reorganisation.
 *
 * NOT HERE, and not an oversight: the glasses panel's "About" (bundled README
 * / LICENSE / PRIVACY) and "Quit" (disconnect) sections. Neither is a setting,
 * and the phone already carries both — About as its own row on the Settings
 * hub, disconnect as the hub's own connection button. Listing them again would
 * be the duplicate-surface problem this consolidation exists to end.
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    label: "Display",
    blurb: "How the glasses draw: brightness, how much of the panel is used, and the type.",
    entries: [
      value(brightnessSetting),
      value(screenTimeoutSetting, noteUserActivity),
      value(lockScreenEnabledSetting),
      value(verticalPositionSetting),
      value(displayModeSetting),
      value(batteryDisplayModeSetting),
      value(timeFormatSetting),
      special("ui-font"),
    ],
  },
  {
    label: "Voice",
    blurb: "What the wakeword does, and which transcriber hears you.",
    entries: [
      value(wakeWordActionSetting),
      value(voiceProviderSetting),
      special("asr-moonshine"),
      special("asr-whisper"),
    ],
  },
  {
    label: "Assistant",
    blurb: "The on-phone model, or your own agent over the bridge.",
    entries: [
      value(assistantBackendSetting),
      value(assistantModelSetting),
      special("local-model"),
      value(assistantSkipConfirmationSetting),
      value(assistantBridgeHostSetting),
      value(assistantBridgePortSetting),
      value(assistantBridgeTokenSetting),
      value(assistantAllowProactiveSetting),
    ],
  },
  {
    label: "API keys",
    blurb: "Credentials for the cloud services the apps above can call.",
    entries: [
      value(elevenLabsApiKeySetting),
      value(openAiApiKeySetting),
      value(sonioxApiKeySetting),
      value(anthropicApiKeySetting),
      value(mapboxApiKeySetting),
    ],
  },
  {
    label: "Terminal",
    blurb: "Terminal windows on the glasses. Connections are managed inside the app itself.",
    entries: [
      special("terminal-font"),
      value(terminalLaunchPresetsSetting),
      value(terminalAutoReconnectSetting),
      value(terminalWakeOnBellSetting),
    ],
  },
  {
    label: "Phone display",
    blurb: "This app's own mirror of the lens.",
    entries: [value(previewColorSetting), value(mirrorTouchSetting)],
  },
  {
    label: "Watch",
    blurb: "The Wear OS remote.",
    entries: [
      value(watchRemoteEnabledSetting),
      value(watchCrownClockwiseNextSetting),
      value(watchCanUnlockSetting),
      value(watchMirrorAssistantSetting),
    ],
  },
  {
    label: "Developer",
    blurb: "Diagnostics and switches that are not part of ordinary use.",
    entries: [
      value(ringConnectionModeSetting),
      value(saveVoiceRecordingsSetting),
      value(firmwareDebugFlagsSetting),
      value(suspendEvenHubWhenScreenOffSetting),
      value(useMicControlSetting),
      value(showBleBandwidthSetting),
    ],
  },
];

export function settingsCategory(label: string): SettingsCategory {
  const found = SETTINGS_CATEGORIES.find((category) => category.label === label);
  if (!found) throw new Error(`unknown settings category: ${label}`);
  return found;
}

/**
 * Changing the screen timeout has to count as activity, or lowering it to a
 * short value can blank the screen the moment the menu closes. Carried here
 * rather than left in settings-menus so the phone surface gets the same
 * behaviour for free — it is a property of the setting, not of the menu.
 */
function noteUserActivity(): void {
  shell.noteUserActivity();
}
