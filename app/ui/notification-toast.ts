/**
 * The new-notification popup, rebuilt around Chris's field feedback from real
 * use (2026-08-31).
 *
 * Two complaints, one redesign:
 *
 *  1. "Notifications are taking up the whole screen with a large square border
 *     around them, regardless of content length." The box is now measured from
 *     its content — see ShellModalLayer / MeasuredLayer. A two-word
 *     notification gets a two-word card.
 *
 *  2. "Summary only, not full text, with Dismiss as the default action."
 *     His reasoning, which decides the whole gesture map: if he wants the real
 *     detail he will look at the phone anyway, so the glasses must not make
 *     DISMISSAL the effortful path. Effort now rises with deliberateness:
 *
 *       Click         dismiss             the thing you do to almost all of them
 *       Scroll down   show the full text  the occasional "what did that say?"
 *       Double-click  leave it alone      keeps it in the tray for the phone
 *       Long-press    the full detail     quick actions, reply buttons, etc.
 *
 * This is a refinement of the List -> Detail design from the pilot (session
 * 0142), not a replacement for it: the Notifications app's list still opens a
 * detail view on click. What changed is that the POPUP — the thing that
 * interrupts you — defaults to getting out of the way.
 */
import { clamp } from "../util/numeric-util";
import { formatRelativeTime } from "../util/date-util";
import { GrayImage } from "../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../graphics/ui-fonts";
import { truncateText, wrapText } from "../graphics/textwrap";
import { lineStep } from "./metrics";
import {
  dismissNotification,
  readActiveNotifications,
  readNotificationIconByKey,
  type AndroidNotification,
} from "../native/notification-icons";
import { noteStaleDataUsed, renderPassAllowsStaleData } from "../util/render-freshness";
import { SingleNotificationLayer } from "./notifications";
import { type Layer, type LayerContext, type PaintBelow } from "./layers";
import { type InputEvent } from "./gestures";

const PAD_X = 10;
const PAD_TOP = 6;
const PAD_BOTTOM = 6;
const ICON_SIZE = 24;
const ICON_TEXT_GAP = 8;
const META_GAP = 6;
const BODY_GAP = 6;
/** Headline lines shown while collapsed; expanding lifts the cap. */
const COLLAPSED_HEADLINE_LINES = 2;
const MAX_NOTIFICATIONS = 50;

type ToastOptions = {
  /** Close the popup, leaving the notification where it is. */
  closeModal: (ctx: LayerContext) => void;
};

type ToastLayout = {
  metaLeft: string;
  metaRight: string;
  headlineLines: string[];
  bodyLines: string[];
  /** Height the card wants, before the modal's own max is applied. */
  height: number;
};

export class NotificationToastLayer implements Layer {
  private expanded = false;
  private bodyScroll = 0;
  /** Body lines that did not fit last paint; the scroll clamp reads it. */
  private bodyOverflow = 0;

  constructor(
    private readonly notificationKey: string,
    private readonly options: ToastOptions,
  ) {}

  private notification(): AndroidNotification | undefined {
    return readActiveNotifications(MAX_NOTIFICATIONS).find((item) => item.key === this.notificationKey);
  }

  /**
   * Lay the card out. Called by both measure and paint so the box drawn
   * around the content is exactly the box the content was laid out for —
   * measuring and painting from one function is the only way those two stay
   * in step as the fonts change underneath (the UI font is a live setting).
   */
  private layout(notification: AndroidNotification, width: number, maxHeight: number): ToastLayout {
    const font = getDefaultSmallFont();
    const headlineFont = getDefaultMediumFont();
    const contentWidth = width - 2 * PAD_X;
    const textWidth = contentWidth - ICON_SIZE - ICON_TEXT_GAP;

    const metaLeft = notification.appName || notification.packageName || "Notification";
    const metaRight = formatRelativeTime(notification.postTime);
    const metaHeight = Math.max(ICON_SIZE, font.lineHeight);

    const headline = notificationHeadline(notification);
    const allHeadlineLines = wrapText(headlineFont, headline, contentWidth);
    const headlineLines = this.expanded
      ? allHeadlineLines
      : allHeadlineLines.slice(0, COLLAPSED_HEADLINE_LINES);

    let height = PAD_TOP + metaHeight + META_GAP;
    for (const _line of headlineLines) height += headlineFont.lineHeight + 2;

    let bodyLines: string[] = [];
    if (this.expanded) {
      const body = notificationBody(notification);
      if (body) {
        bodyLines = wrapText(font, body, contentWidth);
        const step = lineStep(font);
        // Grow to fit the body, but never past what the modal can give us;
        // the remainder scrolls.
        const roomForBody = Math.max(0, maxHeight - height - BODY_GAP - PAD_BOTTOM);
        const wantedBodyHeight = bodyLines.length * step;
        height += BODY_GAP + Math.min(roomForBody, wantedBodyHeight);
      }
    }
    height += PAD_BOTTOM;

    return {
      metaLeft: truncateText(font, metaLeft, Math.max(0, textWidth - font.measureText(metaRight) - 10)),
      metaRight,
      headlineLines,
      bodyLines,
      height,
    };
  }

  measureInteriorHeight(width: number, maxHeight: number): number {
    const notification = this.notification();
    if (!notification) return maxHeight;
    return Math.min(maxHeight, this.layout(notification, width, maxHeight).height);
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const notification = this.notification();
    if (!notification) {
      // Dismissed from the phone, or from the detail view we pushed. Nothing
      // to show, so stop showing it.
      this.options.closeModal(ctx);
      return paintBelow();
    }

    const image = new GrayImage(width, height, 0);
    const font = getDefaultSmallFont();
    const headlineFont = getDefaultMediumFont();
    const laid = this.layout(notification, width, height);

    const icon = iconForNotification(notification.key);
    const metaHeight = Math.max(ICON_SIZE, font.lineHeight);
    let textX = PAD_X;
    if (icon) {
      image.bitBlt(icon, PAD_X, PAD_TOP + Math.max(0, ((metaHeight - ICON_SIZE) / 2) | 0), {
        transparentZero: true,
      });
      textX = PAD_X + ICON_SIZE + ICON_TEXT_GAP;
    }
    const metaTextY = PAD_TOP + Math.max(0, ((metaHeight - font.lineHeight) / 2) | 0);
    image.drawText(font, textX, metaTextY, laid.metaLeft, 150);
    if (laid.metaRight) {
      image.drawText(font, width - PAD_X - font.measureText(laid.metaRight), metaTextY, laid.metaRight, 140);
    }

    let cursorY = PAD_TOP + metaHeight + META_GAP;
    for (const line of laid.headlineLines) {
      image.drawText(headlineFont, PAD_X, cursorY, line, 240);
      cursorY += headlineFont.lineHeight + 2;
    }

    this.bodyOverflow = 0;
    if (this.expanded && laid.bodyLines.length) {
      cursorY += BODY_GAP;
      const step = lineStep(font);
      const visible = Math.max(0, Math.floor((height - cursorY - PAD_BOTTOM) / step));
      this.bodyOverflow = Math.max(0, laid.bodyLines.length - visible);
      this.bodyScroll = clamp(this.bodyScroll, 0, this.bodyOverflow);
      for (let index = 0; index < Math.min(visible, laid.bodyLines.length - this.bodyScroll); index++) {
        image.drawText(font, PAD_X, cursorY + index * step, laid.bodyLines[this.bodyScroll + index]!, 195);
      }
    }
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    const notification = this.notification();
    if (!notification) {
      this.options.closeModal(ctx);
      return;
    }

    switch (event.type) {
      case "click":
        // The default action. Chris's own framing: dismissal is what happens
        // to almost every notification, so it is the cheapest gesture.
        dismissNotification(this.notificationKey);
        this.options.closeModal(ctx);
        return;

      case "scroll-down":
        // The deliberate path to the full text: first scroll expands, further
        // scrolls page through the body.
        if (!this.expanded) {
          this.expanded = true;
          this.bodyScroll = 0;
          return;
        }
        this.bodyScroll = clamp(this.bodyScroll + 1, 0, this.bodyOverflow);
        return;

      case "scroll-up":
        // Back up through the body, then collapse again at the top rather
        // than dead-ending on a screen the wearer cannot leave by scrolling.
        if (this.expanded && this.bodyScroll > 0) {
          this.bodyScroll = Math.max(0, this.bodyScroll - 1);
          return;
        }
        this.expanded = false;
        this.bodyScroll = 0;
        return;

      case "double-click":
        // Leave it alone: the popup goes away, the notification stays in the
        // tray for the home screen and the phone.
        this.options.closeModal(ctx);
        return;

      case "long-press":
        // The full detail view, with the quick actions the notification came
        // with. Pushed onto the modal's own stack, so its Back returns here
        // rather than trying to close a modal it does not own. This is the
        // one thing Click used to do, kept behind the most deliberate
        // gesture instead of being dropped.
        ctx.stack.push(new SingleNotificationLayer(this.notificationKey, { origin: "notifications-list" }));
        return;

      default:
        return;
    }
  }
}

/** Icon for a paint pass: allow-stale, reporting staleness to the render loop. */
function iconForNotification(key: string): GrayImage | null {
  const { icon, stale } = readNotificationIconByKey(key, renderPassAllowsStaleData());
  if (stale) {
    noteStaleDataUsed();
  }
  return icon;
}

// Same fallback chains the home screen and the notification card use, so one
// notification reads the same wherever it appears.
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
