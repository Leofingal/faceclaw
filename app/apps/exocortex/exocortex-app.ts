import { GrayImage } from "../../graphics/image";
import { renderIcon, type IconName } from "../../graphics/icons";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { clamp } from "../../util/numeric-util";
import { formatRelativeTime } from "../../util/date-util";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../../util/render-freshness";
import {
  dismissNotification,
  onAndroidNotificationPosted,
  readActiveNotifications,
  readNotificationIconByKey,
  type AndroidNotification,
} from "../../native/notification-icons";
import { isNotificationListenerEnabled } from "../../native/notification-access";
import { SingleNotificationLayer } from "../../ui/notifications";
import { drawSelectionHighlight, scrollToKeepSelectionVisible } from "../../ui/menu";
import { LIST_ROW_TEXT_INSET, lineStep, listRowHeight } from "../../ui/metrics";
import { type Layer, type LayerActions, type LayerContext } from "../../ui/layers";
import { type InputEvent } from "../../ui/gestures";
import { type Plane } from "../../graphics/plane";
import { createInProcessWindow, YieldAtRootLayer } from "../../ui/shell/in-process-window";
import { type ShellWindow } from "../../ui/shell/shell";

export const EXOCORTEX_WINDOW_ID = "exocortex";
export const EXOCORTEX_SURFACE_ID = "window:exocortex";

/** One launchable entry of the home screen's app run. */
export type ExocortexAppEntry = {
  appId: string;
  label: string;
  icon: IconName;
  /** App-supplied artwork; icon remains the fallback. */
  renderIcon?: (size: number) => GrayImage | null;
};

/**
 * What the home window needs from the controller. Spelled out rather than
 * extended from InProcessAppOptions (the shape ordinary apps get handed by
 * launchInProcessApp) because this window is registered at boot instead: it is
 * never closed, so there is no removeSurface or onClosed to take, and it never
 * changes height band, so there is no reconfigureSurface. Same reason
 * LauncherOptions lists its own.
 */
export type ExocortexOptions = {
  /** Shared layer actions; requestRender is rebound to this window's render. */
  actions: LayerActions;
  /** The launchable apps, read fresh every paint (the registry can change). */
  apps: () => ExocortexAppEntry[];
  launchApp: (appId: string) => Promise<void> | void;
  /** Submit a painted viewport-sized frame (as planes) to this window's surface. */
  submitFrame: (planes: Plane[], paintMs: number, frameId: number) => Promise<void>;
  /** Flip the home screen's compositor surface visibility on foreground changes. */
  setSurfaceVisible: (visible: boolean) => void;
};

const PAGE_X = 20;
const TITLE_X = 18;
const TITLE_Y = 10;
const LIST_TOP = 38;
const ROW_X = 12;
const NOTIF_ICON_SIZE = 24;
const ICON_TEXT_GAP = 8;
const MAX_NOTIFICATIONS = 50;

/**
 * Which run of the home screen the cursor is in. Notifications and apps are
 * one continuous scroll (see ExocortexHomeLayer), but they paint differently
 * and anchor their selection differently, so the zone is explicit rather than
 * inferred from an index that live data keeps invalidating.
 */
type HomeZone = "blank" | "notification" | "app";

/**
 * Exocortex's home screen: notification-first, with the app list below it.
 *
 * The design (ported from the interactive pilot) is a single vertical run —
 * blank when there is nothing to show, the most recent notification when
 * there is one, older notifications below it, and the app list continuing on
 * past the last notification. Scroll moves along that run, so the glasses
 * never present a 2D grid to navigate.
 *
 * The run's contents change underneath the cursor (notifications arrive and
 * get dismissed while it is open), so the cursor is not stored as an index
 * into it. Each zone keeps its own stable anchor — the notification's key,
 * the app's position — and the fused index only exists for the moment a
 * scroll is being applied. That is the same trick NotificationsListLayer uses
 * to keep a selection pinned to a notification rather than to a row number.
 */
class ExocortexHomeLayer implements Layer {
  private zone: HomeZone = "blank";
  /** Anchor for the notification zone: which notification is being previewed. */
  private selectedKey = "";
  /** Anchor for the app zone: position in the app run. */
  private appIndex = 0;
  private scrollRow = 0;

  constructor(private readonly options: ExocortexOptions) {}

  /**
   * Put the home screen back to its RESTING state: the newest notification if
   * there is one, the blank screen if there is not, and the app run scrolled
   * back to the top either way.
   *
   * This is the "bare Exocortex" Chris asked for a way to reach. Backing out
   * of an app lands on this window but does NOT land on this view — normalize()
   * deliberately leaves a cursor parked in the app run alone, so that an
   * arriving notification never yanks the reader out of the app list. The
   * consequence nobody had noticed: once you have scrolled down into the app
   * list even once, every subsequent return to home puts you back in the app
   * list, and the notification view the home screen is built around becomes
   * unreachable for the rest of the session. There was no gesture anywhere
   * that reset it.
   *
   * Called from the app's own `launch` (apps/exocortex/index.ts), which is now
   * reachable as a real, listed entry — so "open Exocortex", from the glasses
   * list, the phone's app screen, the assistant or the watch, all mean this.
   */
  resetToRestingView(): void {
    this.zone = "blank";
    this.selectedKey = "";
    this.appIndex = 0;
    this.scrollRow = 0;
  }

  /**
   * Active notifications, newest first. The home screen's premise is "the
   * most recent notification, then older ones", so the ordering is part of
   * the design rather than incidental — the stock Notifications app takes the
   * listener service's order as-is, which is not documented to be sorted.
   */
  private notifications(): AndroidNotification[] {
    return readActiveNotifications(MAX_NOTIFICATIONS).sort(
      (a, b) => (b.postTime || b.when) - (a.postTime || a.when),
    );
  }

  /**
   * Reconcile the zone with what actually exists right now. Only the
   * blank/notification boundary moves on its own: home rests on the newest
   * notification whenever there is one, and falls back to blank when the last
   * one goes away. A cursor parked in the app run is left alone, so an
   * arriving notification never yanks the reader out of the app list.
   */
  private normalize(notifications: AndroidNotification[], appCount: number): void {
    if (this.zone === "app") {
      this.appIndex = clamp(this.appIndex, 0, Math.max(0, appCount - 1));
      return;
    }
    if (notifications.length === 0) {
      this.zone = "blank";
      this.selectedKey = "";
      return;
    }
    if (this.zone === "blank" || !notifications.some((item) => item.key === this.selectedKey)) {
      this.zone = "notification";
      this.selectedKey = notifications[0]!.key;
    }
  }

  /** The cursor's position along the fused notifications-then-apps run; -1 is blank. */
  private fusedIndex(notifications: AndroidNotification[], appCount: number): number {
    if (this.zone === "app") {
      return notifications.length + clamp(this.appIndex, 0, Math.max(0, appCount - 1));
    }
    if (this.zone === "notification") {
      const index = notifications.findIndex((item) => item.key === this.selectedKey);
      return index >= 0 ? index : 0;
    }
    return -1;
  }

  /** Put the cursor at a position along the fused run, re-anchoring its zone. */
  private setFusedIndex(index: number, notifications: AndroidNotification[], appCount: number): void {
    if (index < 0) {
      this.zone = "blank";
      this.selectedKey = "";
      return;
    }
    if (index < notifications.length) {
      this.zone = "notification";
      this.selectedKey = notifications[index]!.key;
      return;
    }
    this.zone = "app";
    this.appIndex = clamp(index - notifications.length, 0, Math.max(0, appCount - 1));
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const notifications = this.notifications();
    const apps = this.options.apps();
    this.normalize(notifications, apps.length);

    if (this.zone === "app") {
      this.paintAppList(image, apps, ctx.stack.isFocused(), width, height);
    } else if (this.zone === "notification") {
      const notification = notifications.find((item) => item.key === this.selectedKey) ?? notifications[0];
      if (notification) {
        this.paintNotification(image, notification, notifications, width, height);
      }
    } else {
      this.paintBlank(image, width);
    }
    return image;
  }

  /**
   * Nothing to show. Blank is the design's resting state, not an empty-list
   * placeholder, so there is deliberately no "no notifications" copy here.
   * The exception is a feed that was never connected: blank would disguise a
   * missing permission as a quiet phone, so that one case says so.
   */
  private paintBlank(image: GrayImage, width: number): void {
    if (isNotificationListenerEnabled()) return;
    const font = getDefaultSmallFont();
    const lines = wrapText(
      font,
      "Grant notification access on your phone to see notifications here.",
      width - 2 * PAGE_X,
    );
    for (let index = 0; index < lines.length; index++) {
      image.drawText(font, PAGE_X, TITLE_Y + index * lineStep(font), lines[index]!, 190);
    }
  }

  /** The previewed notification: source line, headline, body. */
  private paintNotification(
    image: GrayImage,
    notification: AndroidNotification,
    notifications: AndroidNotification[],
    width: number,
    height: number,
  ): void {
    const font = getDefaultSmallFont();
    const headlineFont = getDefaultMediumFont();
    const icon = iconForNotification(notification.key);

    // Source line: which app this came from on the left, position in the run
    // and age on the right. The position matters on glasses — it is the only
    // cue that there is anything above or below to scroll to.
    const metaY = TITLE_Y;
    let metaX = PAGE_X;
    if (icon) {
      image.bitBlt(icon, PAGE_X, metaY - 4, { transparentZero: true });
      metaX = PAGE_X + NOTIF_ICON_SIZE + ICON_TEXT_GAP;
    }
    const source = notification.appName || notification.packageName || "Notification";
    const index = notifications.findIndex((item) => item.key === notification.key);
    const position = notifications.length > 1 ? `${Math.max(0, index) + 1}/${notifications.length}` : "";
    const age = formatRelativeTime(notification.postTime);
    const right = [position, age].filter(Boolean).join("  ");
    const rightWidth = right ? font.measureText(right) : 0;
    image.drawText(
      font,
      metaX,
      metaY,
      truncateText(font, `notifications — ${source}`, width - metaX - PAGE_X - rightWidth - 12),
      150,
    );
    if (right) {
      image.drawText(font, width - PAGE_X - rightWidth, metaY, right, 140);
    }

    const contentWidth = width - 2 * PAGE_X;
    let cursorY = metaY + Math.max(NOTIF_ICON_SIZE, font.lineHeight) + 10;

    // Headline, then body — the pilot's headline+body split. A notification
    // with no title of its own falls back through the same chain the stock
    // notification card uses, so an untitled one still reads as something.
    const headlineLines = wrapText(headlineFont, notificationHeadline(notification), contentWidth).slice(0, 2);
    for (const line of headlineLines) {
      image.drawText(headlineFont, PAGE_X, cursorY, line, 240);
      cursorY += headlineFont.lineHeight + 2;
    }

    const body = notificationBody(notification);
    if (!body) return;
    cursorY += 6;
    const step = lineStep(font);
    const maxLines = Math.max(0, Math.floor((height - cursorY) / step));
    const bodyLines = wrapText(font, body, contentWidth);
    for (let line = 0; line < Math.min(bodyLines.length, maxLines); line++) {
      image.drawText(font, PAGE_X, cursorY + line * step, bodyLines[line]!, 195);
    }
    if (bodyLines.length > maxLines && maxLines > 0) {
      image.drawText(font, PAGE_X, cursorY + (maxLines - 1) * step, "...", 140);
    }
  }

  /** The app run: a plain vertical list, one row per app. */
  private paintAppList(
    image: GrayImage,
    apps: ExocortexAppEntry[],
    focused: boolean,
    width: number,
    height: number,
  ): void {
    const font = getDefaultSmallFont();
    image.drawText(font, TITLE_X, TITLE_Y, "Apps", 220);
    if (!apps.length) {
      image.drawText(font, PAGE_X, LIST_TOP, "No apps registered.", 190);
      return;
    }
    const rowH = listRowHeight(font);
    const iconSize = Math.max(12, rowH - 6);
    const visibleRows = Math.max(1, Math.floor((height - LIST_TOP) / rowH));
    this.scrollRow = scrollToKeepSelectionVisible(this.scrollRow, this.appIndex, visibleRows, apps.length);
    const textX = ROW_X + 8 + iconSize + ICON_TEXT_GAP;
    for (let index = this.scrollRow; index < Math.min(apps.length, this.scrollRow + visibleRows); index++) {
      const app = apps[index]!;
      const y = LIST_TOP + (index - this.scrollRow) * rowH;
      const selected = index === this.appIndex;
      if (selected) {
        drawSelectionHighlight(image, ROW_X, y, width - 2 * ROW_X, rowH - 2, focused);
      }
      const icon = app.renderIcon?.(iconSize) ?? renderIcon(app.icon, iconSize);
      if (icon) {
        image.bitBlt(icon, ROW_X + 8, y + Math.round((rowH - 2 - icon.height) / 2), { transparentZero: true });
      }
      const label = truncateText(font, app.label, width - textX - ROW_X - 8);
      image.drawText(font, textX, y + LIST_ROW_TEXT_INSET, label, selected ? 235 : 190);
    }
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    const notifications = this.notifications();
    const apps = this.options.apps();
    this.normalize(notifications, apps.length);

    switch (event.type) {
      case "scroll-up":
      case "scroll-down": {
        // One continuous run. Blank is only reachable when there are no
        // notifications at all — with any in the tray, home's top is the
        // newest one rather than an empty screen.
        const min = notifications.length > 0 ? 0 : -1;
        const max = Math.max(min, notifications.length + apps.length - 1);
        const delta = event.type === "scroll-down" ? 1 : -1;
        const next = clamp(this.fusedIndex(notifications, apps.length) + delta, min, max);
        this.setFusedIndex(next, notifications, apps.length);
        return;
      }
      case "click": {
        if (this.zone === "app") {
          const app = apps[this.appIndex];
          if (app) await this.options.launchApp(app.appId);
        } else if (this.zone === "notification") {
          this.expandSelectedNotification(notifications, ctx);
        }
        return;
      }
      case "long-press": {
        // Exocortex's own standard (the interactive pilot, session 0142),
        // not faceclaw's stock long-press: clear every current notification
        // in one gesture. There is no native batch-dismiss to call — Android's
        // NotificationListenerService supports cancelAllNotifications() but
        // faceclaw's JS bridge (native/notification-icons.ts) only exposes
        // per-key dismissNotification() — so this loops that per-key call
        // over every notification currently in the tray. From the user's
        // side it is one gesture, not one-by-one, which is the actual point:
        // Even's own app makes you dismiss them individually. Only fires in
        // the notification zone, matching the pilot; a long-press in the app
        // zone is deliberately still a no-op (no equivalent destructive
        // action there to guard against).
        if (this.zone === "notification") {
          for (const item of notifications) dismissNotification(item.key);
          this.zone = "blank";
          this.selectedKey = "";
        }
        return;
      }
      case "double-click":
        // At the app's root the YieldAtRootLayer wrapper takes this and hands
        // focus to the sidebar; this branch is reached only if the layer is
        // ever hosted deeper, where popping is the right answer.
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  /**
   * Open the previewed notification in faceclaw's own detail view, which
   * brings its quick actions and Dismiss with it. Origin "notifications-list"
   * is what makes its back/dismiss paths pop this stack rather than try to
   * close a modal that does not exist here.
   */
  private expandSelectedNotification(notifications: AndroidNotification[], ctx: LayerContext): void {
    const notification = notifications.find((item) => item.key === this.selectedKey);
    if (!notification) return;
    ctx.stack.push(new SingleNotificationLayer(notification.key, { origin: "notifications-list" }));
  }

  /**
   * A touch on the phone's mirror. Only the app run has per-row geometry to
   * hit; a touch anywhere on the notification preview expands it, which is
   * what tapping it on the mirror should mean. Uses the same geometry paint
   * laid the rows out with, so it lands on what the mirror showed.
   */
  async hitTest(x: number, y: number, ctx: LayerContext): Promise<boolean> {
    const notifications = this.notifications();
    const apps = this.options.apps();
    this.normalize(notifications, apps.length);

    if (this.zone === "notification") {
      this.expandSelectedNotification(notifications, ctx);
      return true;
    }
    if (this.zone !== "app" || !apps.length) return false;
    const font = getDefaultSmallFont();
    const rowH = listRowHeight(font);
    const { width } = ctx.stack.getBaseSize();
    if (y < LIST_TOP || x < ROW_X || x >= width - ROW_X) return false;
    const index = this.scrollRow + Math.floor((y - LIST_TOP) / rowH);
    if (index < 0 || index >= apps.length) return false;
    this.appIndex = index;
    await this.options.launchApp(apps[index]!.appId);
    return true;
  }
}

/**
 * The one home layer, held so `launch` can put it back to its resting view.
 *
 * A module singleton is honest here rather than lazy: the home window is
 * registered exactly once, from boot, and is uncloseable — there is no second
 * instance for this to be ambiguous between, which is the same reason the
 * window itself can be looked up by a fixed id. Null only before boot has run.
 */
let homeLayer: ExocortexHomeLayer | null = null;

/**
 * Reset the home screen to its resting notification view. A no-op before boot
 * registers the window, so callers do not have to know about boot ordering.
 */
export function resetExocortexHomeView(): void {
  homeLayer?.resetToRestingView();
}

/** Icon for a paint pass: allow-stale, reporting staleness to the render loop. */
function iconForNotification(key: string): GrayImage | null {
  const { icon, stale } = readNotificationIconByKey(key, renderPassAllowsStaleData());
  if (stale) {
    noteStaleDataUsed();
  }
  return icon;
}

// The fallback chains below mirror ui/notifications.ts's private
// notificationTitle/detailNotificationBody, so a notification reads the same
// on the home screen as it does on its own card. They are duplicated rather
// than exported from there to keep this first pass additive — worth
// consolidating into one shared helper when the next pass touches that file.

function notificationHeadline(notification: AndroidNotification): string {
  return (
    notification.title ||
    notification.text ||
    notification.summaryText ||
    notification.appName ||
    notification.packageName ||
    "(untitled)"
  );
}

function notificationBody(notification: AndroidNotification): string {
  const headline = notificationHeadline(notification);
  const body =
    notification.bigText || notification.text || notification.lines.join(" / ") || notification.summaryText || "";
  return body === headline ? "" : body;
}

/**
 * The Exocortex home window: the pinned boot launcher. Registered once from
 * index.ts's `boot` callback, never through launchInProcessApp.
 *
 * Uncloseable on purpose. `closeable: false` does two things: it drops "Close
 * window" from the long-press menu, and it makes shell.closeWindow ignore this
 * window id, so the shell's own escape paths can't take it either. Nothing
 * re-opens it — the home screen is what every other window falls back to when
 * it closes, so losing it would leave the glasses with nothing to show.
 */
export function createExocortexWindow(options: ExocortexOptions): ShellWindow {
  const layer = new ExocortexHomeLayer(options);
  homeLayer = layer;
  const created = createInProcessWindow({
    appId: "exocortex",
    windowId: EXOCORTEX_WINDOW_ID,
    title: "Exocortex",
    iconLetter: "E",
    icon: "activity",
    closeable: false,
    // "The wearer is on the home screen", not "the wearer is in an app called
    // Exocortex" — what the assistant's context line reports. The shell used
    // to spot this by comparing appId to "launcher"; a flag on the window
    // survives the home screen changing hands.
    isHomeScreen: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
  });
  // Newly posted notifications repaint the home screen — the same subscription
  // the Notifications app uses. The window lives for the app's lifetime now,
  // so the subscription never needs tearing down (the stock launcher's
  // settings subscription is unhooked for the same reason).
  onAndroidNotificationPosted(() => created.requestRender());
  return created.window;
}
