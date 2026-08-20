import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { Layer, type DashboardInputEvent, type LayerContext, type PaintBelow } from "../../ui/layers";
import { drawSelectionHighlight } from "../../ui/menu";
import { permissionDetail, permissionLabel, type EvenHubPermission } from "./permissions";
import { openPrivacyPolicyOnPhone } from "./privacy-policy";

const DIALOG_X = 8;
const DIALOG_Y = 8;
const DIALOG_WIDTH = 272;
const PADDING = 10;
const HEADER_STEP = 16;
const PERM_LABEL_STEP = 15;
const PERM_DETAIL_STEP = 13;
const PERM_GAP = 4;
const ACTION_ROW_HEIGHT = 20;

/**
 * Confirmation dialog listing the permissions an EvenHub app declares, shown
 * before installing it or running an uninstalled package. Allow proceeds;
 * Cancel (or double-click) backs out. A privacy-policy-only app still reaches
 * this dialog so the user can review the policy before allowing first run.
 */
export class EvenHubPermissionDialogLayer implements Layer {
  /** Starts on Allow; the optional privacy-policy action is inserted after it. */
  private selectedIndex = 0;
  private resolved = false;

  constructor(
    private readonly appName: string,
    private readonly permissions: EvenHubPermission[],
    private readonly privacyPolicyUrl: string,
    private readonly onConfirm: () => void,
    private readonly onCancel: () => void,
  ) {}

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const font = getDefaultSmallFont();
    const { height: viewportHeight } = ctx.stack.getBaseSize();
    const image = paintBelow();
    const textWidth = DIALOG_WIDTH - 2 * PADDING - 4;
    const left = DIALOG_X + PADDING + 2;

    const permsHeight = this.permissions.reduce(
      (sum, permission) => sum + PERM_LABEL_STEP + (permissionDetail(permission) ? PERM_DETAIL_STEP : 0) + PERM_GAP,
      0,
    );
    const emptyPermissionsHeight = this.permissions.length === 0 ? PERM_LABEL_STEP + PERM_GAP : 0;
    const bodyTop = PADDING + HEADER_STEP + 6 + permsHeight + emptyPermissionsHeight + 6;
    const height = Math.min(bodyTop + this.actions().length * ACTION_ROW_HEIGHT + PADDING, viewportHeight - 2 * DIALOG_Y);

    // Fill 1 (transparent color key is 0), outline for the dialog edge.
    image.fillRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_WIDTH, height, 1);
    image.drawRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_WIDTH, height, 72);

    let y = DIALOG_Y + PADDING;
    const heading = this.permissions.length ? `${this.appName} needs:` : `${this.appName} is ready to run`;
    image.drawText(font, left, y, truncateText(font, heading, textWidth), 235);
    y += HEADER_STEP + 6;

    if (this.permissions.length === 0) {
      image.drawText(font, left, y, "No special permissions requested.", 140);
      y += emptyPermissionsHeight;
    }
    for (const permission of this.permissions) {
      image.drawText(font, left, y, truncateText(font, permissionLabel(permission.name), textWidth), 220);
      y += PERM_LABEL_STEP;
      const detail = permissionDetail(permission);
      if (detail) {
        image.drawText(font, left + 8, y, truncateText(font, detail, textWidth - 8), 140);
        y += PERM_DETAIL_STEP;
      }
      y += PERM_GAP;
    }
    y += 2;

    const focused = ctx.stack.isFocused();
    const actions = this.actions();
    for (let index = 0; index < actions.length; index++) {
      const rowY = y + index * ACTION_ROW_HEIGHT;
      const selected = index === this.selectedIndex;
      if (selected) {
        drawSelectionHighlight(image, DIALOG_X + 12, rowY, DIALOG_WIDTH - 24, ACTION_ROW_HEIGHT - 1, focused, 8);
      }
      image.drawText(font, DIALOG_X + 22, rowY + 3, actions[index]!, selected ? 255 : 200);
    }
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    const actions = this.actions();
    switch (event.type) {
      case "scroll-up":
        this.selectedIndex = (this.selectedIndex + actions.length - 1) % actions.length;
        return;
      case "scroll-down":
        this.selectedIndex = (this.selectedIndex + 1) % actions.length;
        return;
      case "click":
        if (actions[this.selectedIndex] === "Privacy policy") {
          openPrivacyPolicyOnPhone(this.privacyPolicyUrl, this.appName);
        } else {
          this.resolve(ctx, actions[this.selectedIndex] === "Allow");
        }
        return;
      case "double-click":
        this.resolve(ctx, false);
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    // Dismissed some other way (window closed, back button): treat as cancel.
    if (!this.resolved) {
      this.resolved = true;
      this.onCancel();
    }
  }

  private resolve(ctx: LayerContext, confirmed: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    ctx.stack.pop();
    if (confirmed) this.onConfirm();
    else this.onCancel();
  }

  private actions(): string[] {
    return this.privacyPolicyUrl ? ["Allow", "Privacy policy", "Cancel"] : ["Allow", "Cancel"];
  }
}
