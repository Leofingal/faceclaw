import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL } from "../../ui/gestures";
import { type DashboardInputEvent, type Layer, type LayerActions, type LayerContext } from "../../ui/layers";
import {
  drawListScrollbar,
  drawSelectionHighlight,
  scrollToKeepSelectionVisible,
  type MenuItem,
} from "../../ui/menu";
import { shell } from "../../ui/shell/shell";
import {
  evenHubApi,
  EvenHubAuthenticationError,
  isEvenHubStoreConfigured,
  type EvenHubStoreApp,
} from "./even-api";
import {
  clearEvenHubPassword,
  evenHubEmailSetting,
  evenHubPasswordSetting,
} from "./credentials";
import { EvenHubStoreDetailLayer } from "./store-detail-layer";

const HEADER_HEIGHT = 34;
const FOOTER_HEIGHT = 22;
const ROW_HEIGHT = 30;
const LIST_X = 18;

export type EvenHubStoreLayerOptions = {
  launchApp: (appId: string) => Promise<void> | void;
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
  private showingLogin = !isEvenHubStoreConfigured();
  private status = this.showingLogin ? "Sign in to browse public apps." : "";
  private credentialEditorOpen = false;

  constructor(private readonly options: EvenHubStoreLayerOptions) {}

  paint(ctx: LayerContext): GrayImage {
    if (!this.started) {
      this.started = true;
      if (this.showingLogin) {
        this.openCredentialEditor(ctx);
      } else {
        void this.reload(ctx);
      }
    }

    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    image.drawText(font, LIST_X, 8, "EvenHub", 220);

    const subtitle = this.status || (this.total ? `${this.apps.length} of ${this.total} public apps` : "Public apps");
    image.drawText(font, LIST_X, 22, truncateText(font, subtitle, width - LIST_X * 2), 125);

    if (this.showingLogin) {
      const message = this.loading
        ? "Signing in..."
        : "Enter your Even account email and password in the phone app.";
      for (const [index, line] of wrapText(font, message, width - LIST_X * 2).entries()) {
        image.drawText(font, LIST_X, HEADER_HEIGHT + 22 + index * 15, line, 190);
      }
      image.drawText(
        font,
        LIST_X,
        height - 16,
        truncateText(font, `${GESTURE_CLICK} edit credentials   ${GESTURE_DOUBLE_CLICK} back`, width - LIST_X * 2),
        105,
      );
      return image;
    }

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

    const hint = `${GESTURE_SCROLL} select   ${GESTURE_CLICK} details   ${GESTURE_DOUBLE_CLICK} back`;
    image.drawText(font, LIST_X, height - 16, truncateText(font, hint, width - LIST_X * 2), 105);
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (this.showingLogin) {
      if (event.type === "click" && !this.loading) {
        this.openCredentialEditor(ctx);
      } else if (event.type === "double-click") {
        shell.yieldFocusToSidebar();
      }
      return;
    }
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
    if (this.showingLogin) return [];
    return [
      {
        label: "Refresh",
        onSelect: (ctx) => {
          ctx.stack.pop();
          void this.reload(ctx);
        },
      },
      {
        label: "Log Out",
        onSelect: (ctx) => {
          ctx.stack.pop();
          clearEvenHubPassword();
          evenHubApi.clearSession();
          this.enterLogin(ctx, "Signed out.");
        },
      },
    ];
  }

  closeCredentialEditor(actions: Pick<LayerActions, "endTextSettingEdit">): void {
    if (!this.credentialEditorOpen) return;
    this.credentialEditorOpen = false;
    void actions.endTextSettingEdit();
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
      this.enterLogin(ctx);
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
      const message = cleanError(error);
      if (error instanceof EvenHubAuthenticationError) {
        this.options.appendLog(`evenhub store login failed: ${message}`);
        this.enterLogin(ctx, `Login failed: ${message}`);
        return;
      }
      this.status = message;
      this.options.appendLog(`evenhub store: ${this.status}`);
    } finally {
      this.loading = false;
      ctx.actions.requestRender();
    }
  }

  private enterLogin(ctx: LayerContext, status = "Sign in to browse public apps."): void {
    this.showingLogin = true;
    this.loading = false;
    this.apps = [];
    this.total = 0;
    this.status = status;
    this.openCredentialEditor(ctx);
    ctx.actions.requestRender();
  }

  private openCredentialEditor(ctx: LayerContext): void {
    if (this.credentialEditorOpen) return;
    this.credentialEditorOpen = true;
    void ctx.actions.startTextSettingsEdit(
      [evenHubEmailSetting, evenHubPasswordSetting],
      "Sign in to EvenHub",
      () => {
        this.credentialEditorOpen = false;
        void this.submitCredentials(ctx);
      },
    );
  }

  private async submitCredentials(ctx: LayerContext): Promise<void> {
    if (!isEvenHubStoreConfigured()) {
      this.enterLogin(ctx, "Email and password are required.");
      return;
    }
    this.showingLogin = false;
    await this.reload(ctx);
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
