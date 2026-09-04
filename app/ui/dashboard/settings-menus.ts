import { knownFolders } from "@nativescript/core";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import type { GrayImage } from "../../graphics/image";
import { getDashboardLogo } from "../../graphics/logo";
import { wrapText } from "../../graphics/textwrap";
import { FACECLAW_VERSION } from "../../version";
import {
  cancelLocalModelDownload,
  deleteLocalModel,
  LOCAL_MODEL,
  localModelState,
  onLocalModelStateChanged,
  startLocalModelDownload,
} from "../../native/llama";
import {
  ASR_MODELS,
  asrModelState,
  cancelAsrModelDownload,
  deleteAsrModel,
  onAsrModelStateChanged,
  startAsrModelDownload,
  type AsrModelId,
} from "../../native/asr-model";
import { TextViewerLayer } from "../../apps/files/text-viewer";
import type { LayerContext } from "../layers";
import { drawRightValueMenuItem, openModalMenu, type MenuItem } from "../menu";
import {
  ConfigSettingBoolean,
  ConfigSettingEnum,
  ConfigSettingString,
  enumSettingMenuItem,
  textSettingMenuItem,
  toggleSettingMenuItem,
} from "../dashboard-settings";
import {
  settingsCategory,
  type CatalogEntry,
  type CatalogSpecialId,
} from "../settings-catalog";
import { wearBridge } from "../../native/wear-bridge";
import { SettingsPanelLayer, type SettingsSection } from "./settings-panel";
import { terminalFontPickerMenuItem, uiFontPickerMenuItem } from "../font-picker";

/** The Settings app's master-detail panel (sections on the left, contents on the right). */
export function createSettingsPanelLayer(): SettingsPanelLayer {
  return new SettingsPanelLayer(settingsSections());
}

/**
 * THE CATEGORY LIST IS NOT WRITTEN HERE ANY MORE (2026-09-03).
 *
 * Which setting belongs to which category now lives in ui/settings-catalog,
 * because the phone's own Settings page renders the identical tree — that
 * consolidation is the whole point of the change (Chris: "I want those
 * settings to be settings so they should be under the gear"), and two
 * hand-written copies of one list would have drifted the first time a setting
 * was added. This function is now purely the GLASSES rendering of it: the
 * catalogue says what, the mapping below says how it draws on a lens.
 *
 * The two sections with no settings in them at all — About (bundled docs) and
 * Quit (disconnect) — stay written out here, since they are glasses-only
 * screens rather than values the phone could edit.
 */
function settingsSections(): SettingsSection[] {
  return [
    { label: "Display", items: categoryItems("Display") },
    { label: "Voice", items: categoryItems("Voice") },
    { label: "Assistant", items: categoryItems("Assistant") },
    { label: "API Keys", items: categoryItems("API keys") },
    // Connections (g2mirror:// strings) are managed inside the Terminal app's
    // Manage Connections section, not here.
    { label: "Terminal", items: categoryItems("Terminal") },
    // The phone app's mirror of the glasses screen and its controls
    // (app/phone-ui/): all read live by the main page.
    { label: "Phone display", items: categoryItems("Phone display") },
    {
      label: "Watch",
      // Wear OS remote (wear/); the status line above the items says whether
      // a watch running the companion app is currently reachable.
      items: categoryItems("Watch"),
      renderDetail: renderWatchStatus,
    },
    { label: "Developer", items: categoryItems("Developer") },
    {
      label: "About",
      // The version/license blurb (renderDetail) draws above the bundled
      // project docs, in both the preview and the focused states.
      items: [
        bundledDocMenuItem("README.md", "README"),
        bundledDocMenuItem("LICENSE", "License"),
        bundledDocMenuItem("PRIVACY", "Privacy policy"),
        bundledDocMenuItem("ACKNOWLEDGEMENTS.md", "Acknowledgements"),
      ],
      renderDetail: renderAbout,
    },
    {
      label: "Quit",
      items: [
        {
          label: "Disconnect from glasses",
          description: "Close the Bluetooth connection to the glasses and return them to standby.",
          onSelect: async (ctx) => {
            ctx.stack.clearToBase();
            await ctx.actions.disconnect();
          },
        },
      ],
    },
  ];
}

/** One catalogue category, rendered as glasses menu rows in catalogue order. */
function categoryItems(label: string): MenuItem[] {
  return settingsCategory(label).entries.map(catalogMenuItem);
}

/**
 * How each catalogue entry draws on the lens. The `instanceof` dispatch is
 * what the three existing helpers were already doing by hand at every call
 * site; doing it once here is what lets the catalogue stay presentation-free.
 */
function catalogMenuItem(entry: CatalogEntry): MenuItem {
  if (entry.kind === "special") return specialMenuItem(entry.id);
  const { setting, onChange } = entry;
  const opts = onChange ? { onChange: () => onChange() } : undefined;
  if (setting instanceof ConfigSettingBoolean) return toggleSettingMenuItem(setting, opts);
  if (setting instanceof ConfigSettingEnum) return enumSettingMenuItem(setting, opts);
  if (setting instanceof ConfigSettingString) return textSettingMenuItem(setting, opts);
  throw new Error(`settings catalogue: unrenderable setting ${String(setting?.id)}`);
}

function specialMenuItem(id: CatalogSpecialId): MenuItem {
  switch (id) {
    case "ui-font":
      return uiFontPickerMenuItem();
    case "terminal-font":
      return terminalFontPickerMenuItem();
    case "asr-moonshine":
      return asrModelMenuItem("moonshine");
    case "asr-whisper":
      return asrModelMenuItem("whisper-base-en");
    case "local-model":
      return localModelMenuItem();
  }
}

const LOCAL_MODEL_GB = `${(LOCAL_MODEL.sizeBytes / 1e9).toFixed(1)}GB`;

// While a download is running, re-render on progress updates so the row's
// percentage stays live; the watch tears itself down when the download ends.
let localModelRenderUnsub: (() => void) | null = null;

function watchLocalModelDownload(ctx: LayerContext): void {
  localModelRenderUnsub?.();
  localModelRenderUnsub = onLocalModelStateChanged((state) => {
    ctx.actions.requestRender();
    if (state.status !== "downloading") {
      localModelRenderUnsub?.();
      localModelRenderUnsub = null;
    }
  });
}

function localModelStatusText(): string {
  const state = localModelState();
  if (state.status === "ready") return "downloaded";
  if (state.status === "downloading") {
    const pct = state.totalBytes > 0 ? Math.floor((state.bytesDownloaded / state.totalBytes) * 100) : 0;
    return `${pct}% of ${LOCAL_MODEL_GB}`;
  }
  return "not downloaded";
}

/** Download/cancel/delete management for the on-phone assistant model. */
function localModelMenuItem(): MenuItem {
  return {
    label: "On-phone model",
    description:
      `${LOCAL_MODEL.label} (${LOCAL_MODEL_GB} download over Wi-Fi recommended). ` +
      "Answers assistant queries on the phone itself, with no API key or cloud service. " +
      "Slower and simpler than the cloud models, but free and private. " +
      "Used automatically when no API key is set. An interrupted download resumes where it left off.",
    onSelect: (ctx) => {
      const state = localModelState();
      const action: MenuItem =
        state.status === "downloading"
          ? {
              label: "Cancel download",
              onSelect: (innerCtx) => {
                cancelLocalModelDownload();
                innerCtx.stack.pop();
              },
            }
          : state.status === "ready"
            ? {
                label: "Delete model",
                onSelect: (innerCtx) => {
                  deleteLocalModel();
                  innerCtx.stack.pop();
                },
              }
            : {
                label: `Download (${LOCAL_MODEL_GB})`,
                onSelect: (innerCtx) => {
                  startLocalModelDownload();
                  watchLocalModelDownload(innerCtx);
                  innerCtx.stack.pop();
                },
              };
      openModalMenu(ctx, "On-phone model", [action], 0);
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, "On-phone model", localModelStatusText());
    },
  };
}

function asrModelMb(id: AsrModelId): string {
  return `${Math.round(ASR_MODELS[id].totalBytes / 1e6)}MB`;
}

const asrModelRenderUnsub: Partial<Record<AsrModelId, () => void>> = {};

function watchAsrModelDownload(id: AsrModelId, ctx: LayerContext): void {
  asrModelRenderUnsub[id]?.();
  asrModelRenderUnsub[id] = onAsrModelStateChanged(id, (state) => {
    ctx.actions.requestRender();
    if (state.status !== "downloading") {
      asrModelRenderUnsub[id]?.();
      asrModelRenderUnsub[id] = undefined;
    }
  });
}

function asrModelStatusText(id: AsrModelId): string {
  const state = asrModelState(id);
  if (state.status === "ready") return "downloaded";
  if (state.status === "downloading") {
    const pct = state.totalBytes > 0 ? Math.floor((state.bytesDownloaded / state.totalBytes) * 100) : 0;
    return `${pct}% of ${asrModelMb(id)}`;
  }
  return "not downloaded";
}

/** Download/cancel/delete management for one on-device transcription model. */
function asrModelMenuItem(id: AsrModelId): MenuItem {
  const def = ASR_MODELS[id];
  const rowLabel = `On-device model: ${def.label}`;
  return {
    label: rowLabel,
    description:
      `${def.label} (${asrModelMb(id)} download). ` +
      "Transcribes voice input on the phone itself, with no API key or cloud service. " +
      "Required for its matching Transcription Provider option; the other providers work without it. " +
      "An interrupted download resumes where it left off.",
    onSelect: (ctx) => {
      const state = asrModelState(id);
      const action: MenuItem =
        state.status === "downloading"
          ? {
              label: "Cancel download",
              onSelect: (innerCtx) => {
                cancelAsrModelDownload(id);
                innerCtx.stack.pop();
              },
            }
          : state.status === "ready"
            ? {
                label: "Delete model",
                onSelect: (innerCtx) => {
                  deleteAsrModel(id);
                  innerCtx.stack.pop();
                },
              }
            : {
                label: `Download (${asrModelMb(id)})`,
                onSelect: (innerCtx) => {
                  startAsrModelDownload(id);
                  watchAsrModelDownload(id, innerCtx);
                  innerCtx.stack.pop();
                },
              };
      openModalMenu(ctx, rowLabel, [action], 0);
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, rowLabel, asrModelStatusText(id));
    },
  };
}

/** A row that opens one of the project docs (copied into the bundle under
 * about/ by webpack.config.js) in the paged text viewer. */
function bundledDocMenuItem(fileName: string, label: string): MenuItem {
  return {
    label,
    onSelect: (ctx) => {
      ctx.stack.push(new TextViewerLayer(readBundledDoc(fileName), label));
    },
  };
}

function readBundledDoc(fileName: string): string {
  try {
    const text = knownFolders.currentApp().getFile(`about/${fileName}`).readTextSync();
    return text || `(${fileName} is missing from this build)`;
  } catch {
    return `(${fileName} is missing from this build)`;
  }
}

function renderWatchStatus(args: { image: GrayImage; x: number; y: number; width: number }): number {
  const { image, x, y, width } = args;
  const font = getDefaultSmallFont();
  let status: string;
  if (!wearBridge.isAvailable()) {
    status = "Google Play services is unavailable on this phone, so no watch can connect.";
  } else {
    const connection = wearBridge.getWatchConnection();
    status = connection.reachable
      ? `Connected to ${connection.watchName || "a watch"}.`
      : "No watch connected. Install the Faceclaw watch app (wear/ in the source tree) on a Wear OS watch paired with this phone.";
  }
  const lines = wrapText(font, status, width);
  for (let i = 0; i < lines.length; i++) {
    image.drawText(font, x, y + i * font.lineHeight, lines[i]!, 170);
  }
  return lines.length * font.lineHeight + 10;
}

function renderAbout(args: { image: GrayImage; x: number; y: number; width: number }): number {
  const { image, x, y, width } = args;
  const font = getDefaultSmallFont();
  const logo = getDashboardLogo();
  if (logo) {
    image.bitBlt(logo, x, y + 4, { transparentZero: true });
  }
  const textX = logo ? x + logo.width + 12 : x;
  image.drawText(font, textX, y + 8, "Faceclaw", 220);
  image.drawText(font, textX, y + 24, `v${FACECLAW_VERSION}`, 170);
  const blurb = "By James Babcock and other contributors. Distributed under the GNU General Public License, version 3.";
  const blurbY = y + Math.max(64, logo ? logo.height + 12 : 0);
  const blurbLines = wrapText(font, blurb, width);
  for (let i = 0; i < blurbLines.length; i++) {
    image.drawText(font, x, blurbY + i * font.lineHeight, blurbLines[i]!, 170);
  }
  return blurbY - y + blurbLines.length * font.lineHeight + 10;
}
