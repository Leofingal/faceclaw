import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK } from "../../ui/gestures";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight } from "../../ui/menu";
import { evenHubApi, type EvenHubStoreApp } from "./even-api";
import {
  getInstalledEvenHubApp,
  installEvenHubPackageBytes,
  installedEvenHubAppId,
  setInstalledEvenHubIcon,
} from "./installed-apps";

const X = 18;
const BUTTON_HEIGHT = 24;

export type EvenHubStoreDetailOptions = {
  launchApp: (appId: string) => Promise<void> | void;
  appendLog: (message: string) => void;
};

/** Storefront metadata and the Install/Launch action for one public app. */
export class EvenHubStoreDetailLayer implements Layer {
  private working = false;
  private detailPromise: Promise<void> | null = null;
  private status = "";

  constructor(
    private app: EvenHubStoreApp,
    private readonly options: EvenHubStoreDetailOptions,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    if (!this.detailPromise) void this.ensureDetail(ctx);
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const textWidth = width - X * 2;
    let y = 8;

    image.drawText(font, X, y, truncateText(font, this.app.name, textWidth), 235);
    y += 16;
    const creator = this.app.creatorName ? `by ${this.app.creatorName}` : this.app.packageId;
    image.drawText(font, X, y, truncateText(font, creator, textWidth), 130);
    y += 20;

    const summary = this.app.tagline || this.app.description || "No description supplied.";
    for (const line of wrapText(font, summary, textWidth).slice(0, 3)) {
      image.drawText(font, X, y, line, 205);
      y += 14;
    }
    y += 4;

    const metadata = [
      `${formatCount(this.app.installCount)} installs  ·  ${formatCount(this.app.likeCount)} likes`,
      this.app.version ? `Version ${this.app.version}${this.app.fileSize ? `  ·  ${formatBytes(this.app.fileSize)}` : ""}` : "",
      this.app.categories.length ? `Categories: ${this.app.categories.join(", ")}` : "",
      this.app.firstPublishedAt ? `Published: ${formatDate(this.app.firstPublishedAt)}` : "",
    ].filter(Boolean);
    for (const line of metadata) {
      image.drawText(font, X, y, truncateText(font, line, textWidth), 125);
      y += 14;
    }

    const installed = getInstalledEvenHubApp(this.app.packageId);
    if (installed) {
      image.drawText(font, X, y + 2, `Installed version ${installed.version}`, 155);
    }
    if (this.status) {
      image.drawText(font, X, Math.min(height - 58, y + 18), truncateText(font, this.status, textWidth), 180);
    }

    const buttonY = height - 48;
    drawSelectionHighlight(image, X - 5, buttonY, textWidth + 10, BUTTON_HEIGHT, ctx.stack.isFocused(), 8);
    const label = this.working ? "Installing..." : installed ? "Launch" : "Install";
    image.drawText(font, X + 6, buttonY + 5, label, this.working ? 145 : 245);
    image.drawText(
      font,
      X,
      height - 16,
      `${GESTURE_CLICK} ${installed ? "launch" : "install"}   ${GESTURE_DOUBLE_CLICK} back`,
      105,
    );
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      if (!this.working) ctx.stack.pop();
      return;
    }
    if (event.type !== "click" || this.working) return;

    await this.ensureDetail(ctx);

    const installed = getInstalledEvenHubApp(this.app.packageId);
    if (installed) {
      await this.options.launchApp(installedEvenHubAppId(installed.packageId));
      return;
    }

    this.working = true;
    this.status = `Downloading ${this.app.name}...`;
    ctx.actions.requestRender();
    try {
      const [bytes, icon] = await Promise.all([
        evenHubApi.downloadApp(this.app.packageId),
        this.app.iconPath
          ? evenHubApi.downloadPublicAsset(this.app.iconPath).catch((error) => {
              this.options.appendLog(`evenhub store: icon unavailable for ${this.app.packageId}: ${cleanError(error)}`);
              return undefined;
            })
          : Promise.resolve(undefined),
      ]);
      this.status = "Installing...";
      ctx.actions.requestRender();
      const result = installEvenHubPackageBytes(bytes, {
        expectedPackageId: this.app.packageId,
        icon,
      });
      this.options.appendLog(
        `evenhub store: installed ${result.packageId} ${result.version} (${bytes.length} bytes)`,
      );
      this.status = "Installed";
      ctx.actions.requestRender();
      await this.options.launchApp(installedEvenHubAppId(result.packageId));
    } catch (error) {
      this.status = cleanError(error);
      this.options.appendLog(`evenhub store: ${this.status}`);
    } finally {
      this.working = false;
      ctx.actions.requestRender();
    }
  }

  private ensureDetail(ctx: LayerContext): Promise<void> {
    if (this.detailPromise) return this.detailPromise;
    this.detailPromise = evenHubApi
      .getStoreAppDetail(this.app.packageId)
      .then((detail) => {
        if (detail) this.app = { ...this.app, ...detail };
        const installed = getInstalledEvenHubApp(this.app.packageId);
        if (installed && !installed.iconFile && this.app.iconPath) {
          return evenHubApi.downloadPublicAsset(this.app.iconPath).then((icon) => {
            setInstalledEvenHubIcon(this.app.packageId, icon);
          });
        }
        return undefined;
      })
      .catch((error) => {
        this.options.appendLog(`evenhub store: app details unavailable: ${cleanError(error)}`);
      })
      .finally(() => ctx.actions.requestRender());
    return this.detailPromise;
  }
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : value;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function cleanError(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
}
