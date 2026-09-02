import { GrayImage } from "../../graphics/image";
import { flattenPlanes } from "../../graphics/plane";
import { InputEvent } from "../gestures";
import { Layer, LayerActions, LayerContext, LayerStack, PaintBelow } from "../layers";
import { appViewportRect, appViewportSize, SHELL_OPAQUE_BLACK } from "./geometry";

// The modal covers most of the min-height app viewport, leaving a little of
// the foreground app visible around the edges. Both its size and position are
// computed per paint: the display-mode setting changes the viewport size at
// runtime, and the vertical position setting moves the band.
const MODAL_MARGIN = 14;
const MODAL_PADDING = 4;
/** Enough for a border, a line of text and its padding — never smaller. */
const MIN_INTERIOR_HEIGHT = 24;

/**
 * A hosted layer that knows how tall it wants to be. Returning a height
 * smaller than the full viewport is what stops a two-word notification being
 * drawn inside a full-screen box — Chris's complaint from real use: "a large
 * square border around them, regardless of content length".
 */
export type MeasuredLayer = Layer & {
  /** Interior height this layer needs at the given width, capped by maxHeight. */
  measureInteriorHeight(width: number, maxHeight: number): number;
};

function hasMeasure(layer: Layer): layer is MeasuredLayer {
  return typeof (layer as MeasuredLayer).measureInteriorHeight === "function";
}

/** Widest the modal's content can be, whatever height it settles on. */
function modalInteriorWidth(): number {
  return appViewportSize("min").width - 2 * MODAL_MARGIN - 2 * MODAL_PADDING;
}

/** Tallest the modal's content can be: the full min-height band. */
function maxInteriorHeight(): number {
  return appViewportSize("min").height - 2 * MODAL_MARGIN - 2 * MODAL_PADDING;
}

/**
 * Screen rect of the modal box for a given interior height. The box is
 * centred vertically in the band it would otherwise fill, so a short one
 * reads as a card floating over the app rather than as a full screen that
 * happens to be mostly empty.
 */
export function modalRect(interiorHeight?: number): { x: number; y: number; width: number; height: number } {
  const viewport = appViewportRect("min");
  const full = viewport.height - 2 * MODAL_MARGIN;
  const height =
    interiorHeight === undefined ? full : Math.min(full, interiorHeight + 2 * MODAL_PADDING);
  return {
    x: viewport.x + MODAL_MARGIN,
    y: viewport.y + MODAL_MARGIN + Math.max(0, Math.round((full - height) / 2)),
    width: viewport.width - 2 * MODAL_MARGIN,
    height,
  };
}

/**
 * A shell overlay hosting an inner layer stack in a bordered box over the
 * app viewport (used for new-notification popups). The inner stack paints at
 * the modal's interior size; its pixels blit onto an opaque black backdrop,
 * so inner value-0 pixels read as black, not transparent.
 *
 * The box shrinks to its content when the hosted layer can measure itself
 * (see MeasuredLayer); layers that cannot keep the old full-band box, so this
 * change cannot alter anything that has not opted in.
 */
export class ShellModalLayer implements Layer {
  private readonly stack: LayerStack;

  constructor(private readonly baseLayer: Layer, actions: LayerActions) {
    this.stack = new LayerStack(baseLayer, actions, {
      width: modalInteriorWidth(),
      height: maxInteriorHeight(),
    });
  }

  /**
   * Interior the inner stack should paint at this frame. Measurement only
   * applies while the hosted layer is still the stack's base: once something
   * has been pushed on top of it (the full detail view, say), the thing on
   * top decides nothing about height and gets the whole band.
   */
  private interior(): { width: number; height: number } {
    const width = modalInteriorWidth();
    const maxHeight = maxInteriorHeight();
    if (!this.stack.isAtBase() || !hasMeasure(this.baseLayer)) {
      return { width, height: maxHeight };
    }
    const measured = this.baseLayer.measureInteriorHeight(width, maxHeight);
    if (!Number.isFinite(measured)) return { width, height: maxHeight };
    return { width, height: Math.max(MIN_INTERIOR_HEIGHT, Math.min(maxHeight, Math.round(measured))) };
  }

  paint(_ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    // Track a display-mode switch while the modal is up, so the inner stack
    // paints at the same size the box below is drawn with.
    const interior = this.interior();
    this.stack.setBaseSize(interior);
    // Flattening bakes the inner stack's planes (glyphs included) so the blit
    // below transplants the finished modal content into this layer's plane.
    const inner = flattenPlanes(this.stack.paint(), interior);
    const rect = modalRect(interior.height);
    image.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, SHELL_OPAQUE_BLACK, 8);
    image.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 110, 8);
    image.bitBlt(inner, rect.x + MODAL_PADDING, rect.y + MODAL_PADDING, { transparentZero: true });
    return image;
  }

  async handleInput(event: InputEvent, _ctx: LayerContext): Promise<void> {
    await this.stack.handleInput(event);
  }
}
