import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { drawRightValueMenuItem, type MenuItem } from "../../ui/menu";
import {
  downloadTranslationPacks,
  onTranslationPacksChanged,
  refreshTranslationPacks,
  translationPacksSummary,
} from "./translate";

/**
 * Glasses menu row for ML Kit's Japanese, Korean and Chinese translation
 * packs: download on Wi-Fi before travel, then captions translate offline.
 * Selecting starts (or retries) the downloads; the row re-renders as each one
 * lands. Used by the Microphones menu and Settings > Translation.
 */
export function translationPacksItem(): MenuItem {
  let unsubscribe: (() => void) | null = null;
  refreshTranslationPacks();
  return {
    label: "Translation packs",
    description:
      "Japanese, Korean and Chinese to English (ML Kit), for translating captions with no network. Download on Wi-Fi before you travel.",
    onSelect: (ctx) => {
      unsubscribe?.();
      unsubscribe = onTranslationPacksChanged(() => ctx.actions.requestRender());
      downloadTranslationPacks();
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, "Translation packs", translationPacksSummary());
    },
  };
}
