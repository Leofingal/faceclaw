import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL } from "../../ui/gestures";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight } from "../../ui/menu";
import { TextViewerLayer } from "../files/text-viewer";
import { evenHubApi, type EvenHubStoreApp } from "./even-api";
import {
  getInstalledEvenHubApp,
  installEvenHubPackageBytes,
  installedEvenHubAppId,
  readEvenHubPackageManifestBytes,
  setInstalledEvenHubIcon,
  type EvenHubInstallIcon,
} from "./installed-apps";
import { EvenHubPermissionDialogLayer } from "./permission-dialog";

const X = 18;
const ACTION_HEIGHT = 24;

export type EvenHubStoreDetailOptions = {
  launchApp: (appId: string) => Promise<void> | void;
  appendLog: (message: string) => void;
};

/** Storefront metadata and the Install/Launch action for one public app. */
export class EvenHubStoreDetailLayer implements Layer {
  /** About, What's New, Install/Launch. */
  private selectedIndex = 2;
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
    const actions = ["About", "What's New", this.working ? "Installing..." : installed ? "Launch" : "Install"];
    const actionTop = height - 22 - actions.length * ACTION_HEIGHT;
    if (installed && !this.status) {
      image.drawText(font, X, y + 2, `Installed version ${installed.version}`, 155);
    }
    if (this.status) {
      image.drawText(font, X, Math.min(actionTop - 14, y + 2), truncateText(font, this.status, textWidth), 180);
    }

    for (let index = 0; index < actions.length; index++) {
      const actionY = actionTop + index * ACTION_HEIGHT;
      const selected = index === this.selectedIndex;
      if (selected) {
        drawSelectionHighlight(image, X - 5, actionY, textWidth + 10, ACTION_HEIGHT - 1, ctx.stack.isFocused(), 8);
      }
      image.drawText(font, X + 6, actionY + 5, actions[index]!, this.working && index === 2 ? 145 : selected ? 245 : 190);
    }
    image.drawText(
      font,
      X,
      height - 16,
      `${GESTURE_SCROLL} select   ${GESTURE_CLICK} open   ${GESTURE_DOUBLE_CLICK} back`,
      105,
    );
    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      if (!this.working) ctx.stack.pop();
      return;
    }
    if (this.working) return;
    if (event.type === "scroll-up") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (event.type === "scroll-down") {
      this.selectedIndex = Math.min(2, this.selectedIndex + 1);
      return;
    }
    if (event.type !== "click") return;

    await this.ensureDetail(ctx);

    if (this.selectedIndex === 0) {
      ctx.stack.push(new TextViewerLayer(this.app.description || "No description supplied.", "About"));
      return;
    }
    if (this.selectedIndex === 1) {
      ctx.stack.push(new TextViewerLayer(this.app.changelog || "No release notes supplied.", "What's New"));
      return;
    }

    const installed = getInstalledEvenHubApp(this.app.packageId);
    if (installed) {
      await this.options.launchApp(installedEvenHubAppId(installed.packageId));
      return;
    }

    await this.prepareInstall(ctx);
  }

  private async prepareInstall(ctx: LayerContext): Promise<void> {
    this.working = true;
    this.status = `Downloading ${this.app.name}...`;
    ctx.actions.requestRender();
    try {
      const [download, icon] = await Promise.all([
        evenHubApi.downloadApp(this.app.packageId),
        this.app.iconPath
          ? evenHubApi.downloadPublicAsset(this.app.iconPath).catch((error) => {
              this.options.appendLog(`evenhub store: icon unavailable for ${this.app.packageId}: ${cleanError(error)}`);
              return undefined;
            })
          : Promise.resolve(undefined),
      ]);
      const manifest = readEvenHubPackageManifestBytes(download.bytes);
      if (!manifest) throw new Error("The downloaded EHPK manifest could not be read.");
      const privacyPolicyUrl = download.privacyPolicyUrl || manifest.privacyPolicyUrl;
      this.working = false;
      this.status = "";
      ctx.actions.requestRender();
      if (manifest.permissions.length > 0 || privacyPolicyUrl) {
        ctx.stack.push(
          new EvenHubPermissionDialogLayer(
            manifest.name,
            manifest.permissions,
            privacyPolicyUrl,
            () => {
              void this.installAndLaunch(ctx, download.bytes, icon);
            },
            () => {
              this.status = "Installation canceled.";
              ctx.actions.requestRender();
            },
          ),
        );
        return;
      }
      await this.installAndLaunch(ctx, download.bytes, icon);
    } catch (error) {
      this.working = false;
      this.status = cleanError(error);
      this.options.appendLog(`evenhub store: ${this.status}`);
      ctx.actions.requestRender();
    }
  }

  private async installAndLaunch(
    ctx: LayerContext,
    bytes: Uint8Array,
    icon: EvenHubInstallIcon | undefined,
  ): Promise<void> {
    this.working = true;
    this.status = "Installing...";
    ctx.actions.requestRender();
    try {
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
