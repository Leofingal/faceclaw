import { type BdfFont } from "../../graphics/bdffont";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText } from "../../graphics/textwrap";
import { GrayImage } from "../../graphics/image";
import { type Plane } from "../../graphics/plane";
import { renderIcon, type IconName } from "../../graphics/icons";
import { clamp } from "../../util/numeric-util";
import { DashboardInputEvent, isWatchInput, Layer, LayerActions, LayerContext } from "../../ui/layers";
import { drawSelectionHighlight, MenuLayer, scrollToKeepSelectionVisible, type MenuItem } from "../../ui/menu";
import { iconGridMinRowHeight } from "../../ui/metrics";
import { WINDOW_MENU_LAYOUT } from "../../ui/window-menu";
import { onAnySettingChanged } from "../../ui/dashboard-settings";
import { createInProcessWindow, type InProcessWindow } from "../../ui/shell/in-process-window";
import {
  getFolderAssignments,
  getFolders,
  getFolderStateFingerprint,
  setAppFolder,
  unusedNewFolderName,
} from "./launcher-folders";
import { shell } from "../../ui/shell/shell";

export type LauncherAppEntry = {
  appId: string;
  label: string;
  icon: IconName;
  uninstallable?: boolean;
  /** Dynamic artwork for installed apps; icon remains the fallback. */
  renderIcon?: (size: number) => GrayImage | null;
  iconKey?: string;
};

export type LauncherOptions = {
  actions: LayerActions;
  apps: () => LauncherAppEntry[];
  launchApp: (appId: string) => Promise<void> | void;
  uninstallApp: (appId: string) => Promise<void> | void;
  /** Submit a painted viewport-sized frame (as planes) to this window's surface. */
  submitFrame: (planes: Plane[], paintMs: number, frameId: number) => Promise<void>;
  /** Flip the launcher's compositor surface visibility on foreground changes. */
  setSurfaceVisible: (visible: boolean) => void;
};

export const LAUNCHER_WINDOW_ID = "launcher";
export const LAUNCHER_SURFACE_ID = "window:launcher";

const COLS = 5;
const GRID_TOP = 6;
const ICON_SIZE = 44;
const LABEL_GAP = 2;

type LauncherMode = "row" | "item";

/** One cell of the grid: an app, or a folder holding some of the apps. */
type LauncherGridEntry =
  | { kind: "app"; label: string; icon: IconName; appId: string; renderIcon?: (size: number) => GrayImage | null }
  | { kind: "folder"; label: string; name: string };

/**
 * The launcher grid: app and folder icons with labels, arranged in a grid.
 * Navigation has two levels so the max number of swipes to any app is halved:
 * entering from the sidebar starts in "row" mode (scroll picks a row); a tap
 * drops into "item" mode on that row, defaulting to the middle column (scroll
 * picks the item); a tap launches an app or opens a folder (the same grid,
 * restricted to that folder's apps). Double-click backs out one level (item →
 * row, folder → top grid), and from the top level yields to the sidebar.
 * That is the ring's scheme; the watch (see handleWatchInput) skips row mode
 * and moves one cell at a time in four directions.
 *
 * The folder grouping lives in the settings store (see launcher-folders.ts)
 * and is re-read every paint, so assistant folder tools take effect without
 * the layer holding any copy of the state.
 */
class LauncherGridLayer implements Layer {
  // Watch swipes are spatial: up/down move between rows, left/right between
  // columns. From row mode, right goes into the row (left backs out, like
  // double-click); from the first column, left returns to row mode, which
  // keeps "left" pointing toward the sidebar all the way out.
  readonly acceptsDirectional = true;
  private mode: LauncherMode = "row";
  private selectedRow = 0;
  private selectedCol = 1;
  private scrollRow = 0;
  /** Folder whose contents the grid is showing, or null for the top grid. */
  private currentFolder: string | null = null;

  constructor(private readonly options: LauncherOptions) {}

  /**
   * The cells to show, computed fresh from the folder state. Self-heals
   * currentFolder: if the open folder no longer exists (the assistant
   * disbanded it), the view falls back to the top grid.
   */
  private entries(): LauncherGridEntry[] {
    const apps = this.options.apps();
    const byAppId = new Map(apps.map((app) => [app.appId, app]));
    if (this.currentFolder !== null) {
      const members = (getFolders().get(this.currentFolder) ?? [])
        .map((appId) => byAppId.get(appId))
        .filter(Boolean) as LauncherAppEntry[];
      if (members.length > 0) {
        return members
          .map((app): LauncherGridEntry => ({
            kind: "app",
            label: app.label,
            icon: app.icon,
            appId: app.appId,
            renderIcon: app.renderIcon,
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
      }
      this.currentFolder = null;
    }
    const assignments = getFolderAssignments();
    const entries: LauncherGridEntry[] = [];
    // A folder cell appears only when it holds at least one known app; stale
    // assignments to removed apps are ignored.
    for (const [name, members] of getFolders()) {
      if (members.some((appId) => byAppId.has(appId))) {
        entries.push({ kind: "folder", label: name, name });
      }
    }
    for (const app of apps) {
      if (!assignments[app.appId]) {
        entries.push({
          kind: "app",
          label: app.label,
          icon: app.icon,
          appId: app.appId,
          renderIcon: app.renderIcon,
        });
      }
    }
    return entries.sort((a, b) => a.label.localeCompare(b.label));
  }

  private rowCount(entryCount: number): number {
    return Math.max(1, Math.ceil(entryCount / COLS));
  }

  private itemsInRow(entryCount: number, row: number): number {
    return Math.max(0, Math.min(COLS, entryCount - row * COLS));
  }

  /** Leave the current folder, putting the selection back on its cell. */
  private exitFolder(): void {
    const folder = this.currentFolder;
    this.currentFolder = null;
    this.mode = "row";
    const index = this.entries().findIndex((entry) => entry.kind === "folder" && entry.name === folder);
    this.selectedRow = index >= 0 ? Math.floor(index / COLS) : 0;
  }

  /**
   * App-specific entries for the window's long-press menu. Only item mode
   * pins the selection to a single cell, and only apps can move to folders,
   * so anywhere else the menu falls back to just the defaults.
   */
  menuItems(): MenuItem[] {
    if (this.mode !== "item") return [];
    const entry = this.entries()[this.selectedRow * COLS + this.selectedCol];
    if (!entry || entry.kind !== "app") return [];
    return [
      {
        label: "Move to folder",
        onSelect: (ctx) => {
          ctx.stack.pop();
          ctx.stack.push(
            new MenuLayer("Move to folder", this.moveToFolderItems(entry.appId), WINDOW_MENU_LAYOUT),
          );
        },
      },
      ...(this.options.apps().find((app) => app.appId === entry.appId)?.uninstallable
        ? [{
            label: "Uninstall",
            onSelect: (ctx: LayerContext) => {
              ctx.stack.pop();
              ctx.stack.push(
                new MenuLayer(
                  "Uninstall app?",
                  [
                    {
                      label: "Confirm uninstall",
                      onSelect: async (confirmCtx) => {
                        confirmCtx.stack.pop();
                        setAppFolder(entry.appId, null);
                        await this.options.uninstallApp(entry.appId);
                        this.mode = "row";
                      },
                    },
                    { label: "Cancel", onSelect: (confirmCtx) => confirmCtx.stack.pop() },
                  ],
                  WINDOW_MENU_LAYOUT,
                ),
              );
            },
          } satisfies MenuItem]
        : []),
    ];
  }

  /**
   * The folder-picker submenu: every existing folder except the app's own,
   * plus a generated-name "New folder" (ring input has no text entry) and,
   * when the app is in a folder, an escape back to the top level.
   */
  private moveToFolderItems(appId: string): MenuItem[] {
    const currentFolder = getFolderAssignments()[appId] ?? null;
    const items: MenuItem[] = [];
    for (const name of getFolders().keys()) {
      if (name === currentFolder) continue;
      items.push({
        label: name,
        onSelect: (ctx) => {
          setAppFolder(appId, name);
          ctx.stack.pop();
        },
      });
    }
    items.push({
      label: "New folder",
      onSelect: (ctx) => {
        setAppFolder(appId, unusedNewFolderName());
        ctx.stack.pop();
      },
    });
    if (currentFolder !== null) {
      items.push({
        label: "Remove from folder",
        onSelect: (ctx) => {
          setAppFolder(appId, null);
          ctx.stack.pop();
        },
      });
    }
    return items;
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const focused = ctx.stack.isFocused();
    const entries = this.entries();
    const rows = this.rowCount(entries.length);
    this.selectedRow = clamp(this.selectedRow, 0, rows - 1);
    this.selectedCol = clamp(
      this.selectedCol,
      0,
      Math.max(0, this.itemsInRow(entries.length, this.selectedRow) - 1),
    );

    // The folder-name header band scales with the font.
    const gridTop = this.currentFolder !== null ? GRID_TOP + font.lineHeight + 4 : GRID_TOP;
    if (this.currentFolder !== null) {
      image.drawText(font, 8, GRID_TOP - 2, truncateText(font, this.currentFolder, width - 16), 160);
    }
    const gridBottom = height - 4;
    // Rows are exactly as tall as their content (icon + label + breathing
    // room), so row height tracks the font instead of stretching to fill the
    // viewport. Leftover space below the last full row shows the top of the
    // next row when there are more apps to scroll to.
    const rowH = iconGridMinRowHeight(font, ICON_SIZE, LABEL_GAP);
    const fullRows = Math.max(1, Math.floor((gridBottom - gridTop) / rowH));
    const colW = width / COLS;

    // Scroll to keep the selected row among the fully-visible rows.
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, this.selectedRow, fullRows, rows);

    const rowY = (row: number) => gridTop + (row - this.scrollRow) * rowH;

    // Selection highlight (row band, or a single cell in item mode).
    const selY = rowY(this.selectedRow);
    if (this.mode === "row") {
      drawSelectionHighlight(image, 4, selY + 2, width - 8, rowH - 4, focused, 6);
    } else {
      drawSelectionHighlight(image, this.selectedCol * colW + 6, selY + 2, colW - 12, rowH - 4, focused, 6);
    }

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const row = Math.floor(index / COLS);
      if (row < this.scrollRow) continue;
      const blockTop = rowY(row) + Math.max(2, (rowH - ICON_SIZE - font.lineHeight - LABEL_GAP) / 2);
      if (blockTop >= gridBottom) break; // fully below the grid
      const centerX = (index % COLS) * colW + colW / 2;
      const icon = entry.kind === "app"
        ? entry.renderIcon?.(ICON_SIZE) ?? renderIcon(entry.icon, ICON_SIZE)
        : renderIcon("folder-filled", ICON_SIZE);
      if (icon) {
        // Clip the icon at the grid bottom so a peeking row shows only its top.
        // A fully visible icon goes through the deferred-image path (texture
        // cacheable); the clipped peeking row falls back to a raster blit,
        // since cached draws are whole-image only.
        // Icons narrower/shorter than ICON_SIZE (a non-square logo scaled to
        // fit) are centered in the square the row reserves for them.
        const iconX = Math.round(centerX - icon.width / 2);
        const iconY = Math.round(blockTop + Math.max(0, (ICON_SIZE - icon.height) / 2));
        const clipHeight = Math.min(icon.height, Math.floor(gridBottom - iconY));
        if (clipHeight >= icon.height) {
          image.drawImage(icon, iconX, iconY);
        } else if (clipHeight > 0) {
          image.bitBlt(icon, iconX, iconY, { height: clipHeight, transparentZero: true });
        }
      }
      const labelY = Math.round(blockTop + ICON_SIZE + LABEL_GAP);
      if (labelY + font.lineHeight <= gridBottom) {
        const label = truncateText(font, entry.label, colW - 8);
        image.drawText(font, Math.round(centerX - font.measureText(label) / 2), labelY, label, 210);
      }
    }

    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (isWatchInput(event)) {
      await this.handleWatchInput(event, ctx);
      return;
    }
    const entries = this.entries();
    const rows = this.rowCount(entries.length);
    switch (event.type) {
      case "scroll-up":
      case "scroll-down": {
        const delta = event.type === "scroll-down" ? 1 : -1;
        if (this.mode === "row") {
          this.selectedRow = clamp(this.selectedRow + delta, 0, rows - 1);
        } else {
          // Item selection traverses the grid linearly: past a row's edge it
          // continues onto the adjacent row (stopping at the grid's ends).
          const itemCount = this.itemsInRow(entries.length, this.selectedRow);
          const next = clamp(this.selectedCol, 0, itemCount - 1) + delta;
          if (next >= 0 && next < itemCount) {
            this.selectedCol = next;
          } else if (next < 0 && this.selectedRow > 0) {
            this.selectedRow--;
            this.selectedCol = this.itemsInRow(entries.length, this.selectedRow) - 1;
          } else if (next >= itemCount && this.selectedRow < rows - 1) {
            this.selectedRow++;
            this.selectedCol = 0;
          }
        }
        return;
      }
      case "click": {
        if (this.mode === "row") {
          this.mode = "item";
          // Default to the middle column (clamped to the row's item count).
          this.selectedCol = Math.min(
            Math.floor(COLS / 2),
            this.itemsInRow(entries.length, this.selectedRow) - 1,
          );
        } else {
          await this.openSelected(entries);
        }
        return;
      }
      case "double-click":
        if (this.mode === "item") {
          this.mode = "row";
        } else if (this.currentFolder !== null) {
          this.exitFolder();
        } else {
          shell.backOutToHome();
        }
        return;
      default:
        return;
    }
  }

  /**
   * The watch's scheme: there is no row mode to enter first. The selection is
   * always one cell; up/down/left/right (and the crown) move it spatially,
   * select opens it, back leaves the folder or the grid, and stepping left
   * past the first column leaves for the sidebar, which is where "left" goes.
   * Row mode is restored on the way out so a ring user finds the grid as
   * they left it.
   */
  private async handleWatchInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    const entries = this.entries();
    const rows = this.rowCount(entries.length);
    if (this.mode === "row") {
      this.mode = "item";
      this.selectedCol = clamp(this.selectedCol, 0, this.itemsInRow(entries.length, this.selectedRow) - 1);
    }
    const leave = () => {
      this.mode = "row";
      shell.backOutToHome();
    };
    switch (event.type) {
      case "swipe-up":
      case "swipe-down":
      case "scroll-up":
      case "scroll-down": {
        const delta = event.type === "swipe-down" || event.type === "scroll-down" ? 1 : -1;
        this.selectedRow = clamp(this.selectedRow + delta, 0, rows - 1);
        // Keep the column; a shorter last row clamps it.
        this.selectedCol = clamp(this.selectedCol, 0, this.itemsInRow(entries.length, this.selectedRow) - 1);
        return;
      }
      case "swipe-right":
        this.selectedCol = clamp(this.selectedCol + 1, 0, this.itemsInRow(entries.length, this.selectedRow) - 1);
        return;
      case "swipe-left":
        if (this.selectedCol > 0) {
          this.selectedCol--;
        } else if (this.currentFolder !== null) {
          this.exitFolder();
          this.mode = "item";
        } else {
          leave();
        }
        return;
      case "click":
        await this.openSelected(entries);
        return;
      case "double-click":
        if (this.currentFolder !== null) {
          this.exitFolder();
          this.mode = "item";
        } else {
          leave();
        }
        return;
      default:
        return;
    }
  }

  /**
   * A touch on the phone's mirror: the cell under it becomes the selection
   * and opens (the same as a watch select on it). Uses the geometry paint
   * lays the grid out with, so it lands on what the mirror showed.
   */
  async hitTest(x: number, y: number, ctx: LayerContext): Promise<boolean> {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const entries = this.entries();
    const gridTop = this.currentFolder !== null ? GRID_TOP + font.lineHeight + 4 : GRID_TOP;
    const gridBottom = height - 4;
    if (y < gridTop || y >= gridBottom || x < 0 || x >= width) return false;
    const rowH = iconGridMinRowHeight(font, ICON_SIZE, LABEL_GAP);
    const colW = width / COLS;
    const row = this.scrollRow + Math.floor((y - gridTop) / rowH);
    const col = Math.floor(x / colW);
    if (row < 0 || row >= this.rowCount(entries.length)) return false;
    if (col < 0 || col >= this.itemsInRow(entries.length, row)) return false;
    this.mode = "item";
    this.selectedRow = row;
    this.selectedCol = col;
    await this.openSelected(entries);
    return true;
  }

  /** Open the selected cell: enter a folder, or launch the app. */
  private async openSelected(entries: readonly LauncherGridEntry[]): Promise<void> {
    const entry = entries[this.selectedRow * COLS + this.selectedCol];
    if (!entry) return;
    if (entry.kind === "folder") {
      this.currentFolder = entry.name;
      this.mode = "row";
      this.selectedRow = 0;
      this.scrollRow = 0;
    } else {
      // Return to the top grid before launching, so the launcher never
      // shows (even briefly) stale folder contents when re-entered.
      if (this.currentFolder !== null) this.exitFolder();
      this.mode = "row";
      await this.options.launchApp(entry.appId);
    }
  }
}

/**
 * The stock app grid: an uncloseable in-process window. Selecting an app asks
 * the controller to launch it and foregrounds the new window.
 *
 * No longer pinned at boot — Exocortex is the boot launcher now, and this
 * window is opened on demand through launchInProcessApp (which is why the
 * whole InProcessWindow is returned rather than just its ShellWindow: that is
 * the shape the controller's create callback expects, and it keeps the handle
 * needed to drop the window from its in-process registry).
 */
export function createLauncherWindow(options: LauncherOptions): InProcessWindow {
  const gridLayer = new LauncherGridLayer(options);
  const created = createInProcessWindow({
    appId: "launcher",
    windowId: LAUNCHER_WINDOW_ID,
    title: "Apps",
    iconLetter: "A",
    icon: "layout-grid",
    closeable: false,
    menuItems: () => gridLayer.menuItems(),
    actions: options.actions,
    // Not wrapped in YieldAtRootLayer: the grid handles double-click itself to
    // back out of item selection before yielding to the sidebar.
    baseLayer: gridLayer,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
  });
  // The assistant's folder tools change the grouping from outside the window;
  // the settings broadcast is the change signal, and the fingerprint check
  // keeps every unrelated setting change from repainting the launcher. The
  // window is uncloseable, so once opened it lives for the rest of the run and
  // the subscription still never needs tearing down.
  let lastState = `${getFolderStateFingerprint()}\n${launcherAppsFingerprint(options.apps())}`;
  onAnySettingChanged(() => {
    const state = `${getFolderStateFingerprint()}\n${launcherAppsFingerprint(options.apps())}`;
    if (state === lastState) return;
    lastState = state;
    created.requestRender();
  });
  return created;
}

function launcherAppsFingerprint(apps: LauncherAppEntry[]): string {
  return apps
    .map((app) => `${app.appId}:${app.label}:${app.icon}:${app.iconKey ?? ""}:${app.uninstallable ? 1 : 0}`)
    .join("|");
}
