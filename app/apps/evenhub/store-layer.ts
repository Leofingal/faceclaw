import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL } from "../../ui/gestures";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import {
  drawListScrollbar,
  drawSelectionHighlight,
  scrollToKeepSelectionVisible,
  type MenuItem,
} from "../../ui/menu";
import { shell } from "../../ui/shell/shell";
import { evenHubApi, isEvenHubStoreConfigured, type EvenHubStoreApp } from "./even-api";
import { EvenHubStoreDetailLayer } from "./store-detail-layer";

const HEADER_HEIGHT = 34;
const FOOTER_HEIGHT = 22;
const ROW_HEIGHT = 30;
const LIST_X = 18;

export type EvenHubStoreLayerOptions = {
  launchApp: (appId: string) => Promise<void> | void;
  openSettings: () => Promise<void> | void;
  appendLog: (message: string) => void;
};

/** Browse the public EvenHub leaderboard and download one package to run. */
export class EvenHubStoreLayer implements Layer {
  private apps: EvenHubStoreApp[] = [];
  private selectedIndex = 0;
  private scrollRow = 0;
  private total = 0;
  private nextPage = 1;
  private started = false;
  private loading = false;
  private status = "";

  constructor(private readonly options: EvenHubStoreLayerOptions) {}

  paint(ctx: LayerContext): GrayImage {
    if (!this.started) {
      this.started = true;
      void this.reload(ctx);
    }

    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    image.drawText(font, LIST_X, 8, "EvenHub", 220);

    const subtitle = !isEvenHubStoreConfigured()
      ? "Set account details in Settings > EvenHub"
      : this.status || (this.total ? `${this.apps.length} of ${this.total} public apps` : "Public apps");
    image.drawText(font, LIST_X, 22, truncateText(font, subtitle, width - LIST_X * 2), 125);

    if (this.apps.length === 0) {
      const message = this.loading ? "Loading apps..." : this.status || "No apps returned.";
      image.drawText(font, LIST_X, HEADER_HEIGHT + 28, truncateText(font, message, width - LIST_X * 2), 190);
    } else {
      this.selectedIndex = clamp(this.selectedIndex, 0, this.apps.length - 1);
      const visibleRows = Math.max(1, Math.floor((height - HEADER_HEIGHT - FOOTER_HEIGHT) / ROW_HEIGHT));
      this.scrollRow = scrollToKeepSelectionVisible(
        this.scrollRow,
        this.selectedIndex,
        visibleRows,
        this.apps.length,
      );
      const last = Math.min(this.apps.length, this.scrollRow + visibleRows);
      for (let index = this.scrollRow; index < last; index++) {
        const app = this.apps[index]!;
        const y = HEADER_HEIGHT + (index - this.scrollRow) * ROW_HEIGHT;
        const selected = index === this.selectedIndex;
        if (selected) {
          drawSelectionHighlight(image, LIST_X - 6, y, width - LIST_X * 2 + 12, ROW_HEIGHT - 2, ctx.stack.isFocused(), 5);
        }
        image.drawText(font, LIST_X, y + 2, truncateText(font, app.name, width - LIST_X * 2), 215);
        const detail = app.tagline || `${app.creatorName} · ${formatCount(app.installCount)} installs`;
        image.drawText(font, LIST_X, y + 16, truncateText(font, detail, width - LIST_X * 2), 115);
      }
      if (this.apps.length > visibleRows) {
        drawListScrollbar(image, width - 5, HEADER_HEIGHT, visibleRows * ROW_HEIGHT - 3, this.scrollRow, visibleRows, this.apps.length);
      }
    }

    const hint = !isEvenHubStoreConfigured()
      ? `${GESTURE_CLICK} settings   ${GESTURE_DOUBLE_CLICK} back`
      : `${GESTURE_SCROLL} select   ${GESTURE_CLICK} details   ${GESTURE_DOUBLE_CLICK} back`;
    image.drawText(font, LIST_X, height - 16, truncateText(font, hint, width - LIST_X * 2), 105);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    switch (event.type) {
      case "scroll-up":
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        return;
      case "scroll-down":
        this.selectedIndex = Math.min(Math.max(0, this.apps.length - 1), this.selectedIndex + 1);
        if (this.selectedIndex >= this.apps.length - 4 && this.apps.length < this.total) {
          void this.loadNextPage(ctx);
        }
        return;
      case "click":
        if (!isEvenHubStoreConfigured()) {
          await this.options.openSettings();
          return;
        }
        if (!this.loading) {
          const app = this.apps[this.selectedIndex];
          if (app) {
            ctx.stack.push(
              new EvenHubStoreDetailLayer(app, {
                launchApp: this.options.launchApp,
                appendLog: this.options.appendLog,
              }),
            );
          }
        }
        return;
      case "double-click":
        shell.yieldFocusToSidebar();
        return;
      default:
        return;
    }
  }

  buildMenuItems(): MenuItem[] {
    return [
      {
        label: "Refresh",
        onSelect: (ctx) => {
          ctx.stack.pop();
          void this.reload(ctx);
        },
      },
      {
        label: "EvenHub settings",
        onSelect: (ctx) => {
          ctx.stack.pop();
          void this.options.openSettings();
        },
      },
    ];
  }

  private async reload(ctx: LayerContext): Promise<void> {
    if (this.loading) return;
    evenHubApi.clearSession();
    this.apps = [];
    this.total = 0;
    this.nextPage = 1;
    this.selectedIndex = 0;
    this.scrollRow = 0;
    this.status = "";
    if (!isEvenHubStoreConfigured()) {
      ctx.actions.requestRender();
      return;
    }
    await this.loadNextPage(ctx);
  }

  private async loadNextPage(ctx: LayerContext): Promise<void> {
    if (this.loading || (this.total > 0 && this.apps.length >= this.total)) return;
    this.loading = true;
    this.status = this.apps.length ? "Loading more apps..." : "Loading apps...";
    ctx.actions.requestRender();
    try {
      const page = await evenHubApi.listApps(this.nextPage);
      const seen = new Set(this.apps.map((app) => app.packageId));
      this.apps.push(...page.apps.filter((app) => !seen.has(app.packageId)));
      this.total = page.total;
      this.nextPage = page.page + 1;
      this.status = "";
    } catch (error) {
      this.status = cleanError(error);
      this.options.appendLog(`evenhub store: ${this.status}`);
    } finally {
      this.loading = false;
      ctx.actions.requestRender();
    }
  }

}

function cleanError(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
