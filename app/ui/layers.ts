import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { type Plane } from "../graphics/plane";
import { spanCurrent } from "../native/frame-timings";
import { type ConfigSettingString } from "./dashboard-settings";

/**
 * Where an input came from. The ring and the glasses' arms are the stock
 * sources; "watch" is the Wear OS remote, which components may treat with a
 * richer scheme (see isWatchInput) — the ring's semantics are never changed
 * by it.
 */
export type InputSource = "ring" | "left-arm" | "right-arm" | "watch";

export type DashboardInputEvent =
  | { type: "click"; source: InputSource }
  | { type: "double-click"; source: InputSource }
  /** Ring scroll (or a watch crown turn, then tagged source "watch"). */
  | { type: "scroll-up"; source?: InputSource }
  | { type: "scroll-down"; source?: InputSource }
  | { type: "long-press"; source: InputSource }
  | { type: "long-press-release"; source: InputSource }
  /**
   * Spatial (four-way) input, which only a watch can produce: the ring's
   * scroll is a one-dimensional cursor, these are directions. Components with
   * a spatial meaning for them opt in with Layer.acceptsDirectional /
   * ShellWindow.acceptsDirectional and must then handle all four; for the
   * rest, directionalFallback turns up/down into scroll, right into "select"
   * (click) and left into "back" (double-click), so a swipe always does
   * something sensible.
   */
  | { type: "swipe-up"; source: "watch" }
  | { type: "swipe-down"; source: "watch" }
  | { type: "swipe-left"; source: "watch" }
  | { type: "swipe-right"; source: "watch" }
  /**
   * The stock display lifecycle woke while no EvenHub page was running. This
   * is wake-only, unlike a normal double-click (which turns an on screen off).
   */
  | { type: "display-wake" }
  /**
   * The on-glasses "Hey Even" wakeword fired. Delivered on sid 0x07 by the
   * stock firmware regardless of CFW; the CFW additionally suppresses the stock
   * Even AI app so this is ours to handle. Its configured action may be applied
   * while the screen is off, unlike ordinary input events.
   */
  | { type: "wakeword" }
  | { type: "unknown"; kind: string; eventSource: number; eventType: number };

/** True for input from the Wear OS remote (any type that carries a source). */
export function isWatchInput(event: DashboardInputEvent): boolean {
  return "source" in event && event.source === "watch";
}

export type DirectionalInputEvent = Extract<
  DashboardInputEvent,
  { type: "swipe-up" | "swipe-down" | "swipe-left" | "swipe-right" }
>;

export function isDirectionalInput(event: DashboardInputEvent): event is DirectionalInputEvent {
  return (
    event.type === "swipe-up" ||
    event.type === "swipe-down" ||
    event.type === "swipe-left" ||
    event.type === "swipe-right"
  );
}

/**
 * The ring-vocabulary equivalent of a directional swipe: up/down scroll,
 * right selects, left backs out.
 */
export function directionalFallback(event: DashboardInputEvent): DashboardInputEvent {
  switch (event.type) {
    case "swipe-up":
      return { type: "scroll-up" };
    case "swipe-down":
      return { type: "scroll-down" };
    case "swipe-right":
      return { type: "click", source: "ring" };
    case "swipe-left":
      return { type: "double-click", source: "ring" };
    default:
      return event;
  }
}

export type LayerActions = {
  /** Ask for a dashboard repaint+transmit, e.g. when async data arrives. */
  requestRender: () => void;
  disconnect: () => Promise<void> | void;
  startTextSettingEdit: (setting: ConfigSettingString) => Promise<void> | void;
  /** Open one phone form for multiple related settings (for example email + password). */
  startTextSettingsEdit: (
    settings: readonly ConfigSettingString[],
    title: string,
    onFinish?: () => void,
  ) => Promise<void> | void;
  endTextSettingEdit: () => Promise<void> | void;
  /**
   * Start push-to-talk voice capture with the provider chosen in settings.
   * With `endpointing`, the capture also ends itself when the speaker stops
   * (hands-free); otherwise it runs until stopVoiceCapture.
   */
  startVoiceCapture: (endpointing?: boolean) => Promise<void> | void;
  /** Stop push-to-talk; for a cloud provider this also commits for a final result. */
  stopVoiceCapture: () => Promise<void> | void;
  /** Start continuous capture (Transcribe); shares the mic with push-to-talk. */
  startContinuousVoiceCapture: () => Promise<void> | void;
  stopContinuousVoiceCapture: () => Promise<void> | void;
  /** Play a CFW tone-sequencer payload (see sound-effects.ts). */
  playBuzzerSequence: (payload: Uint8Array) => Promise<void> | void;
};

/** Do-nothing actions, for stacks whose layers never use them (or as a base to spread over). */
export const noopLayerActions: LayerActions = {
  requestRender: () => {},
  disconnect: () => {},
  startTextSettingEdit: () => {},
  startTextSettingsEdit: () => {},
  endTextSettingEdit: () => {},
  startVoiceCapture: () => {},
  stopVoiceCapture: () => {},
  startContinuousVoiceCapture: () => {},
  stopContinuousVoiceCapture: () => {},
  playBuzzerSequence: () => {},
};

/**
 * Hands a layer its paint canvas: a fresh transparent (0-filled) image the
 * size of the stack. Calling it also declares that the layers below should
 * stay visible beneath this layer — each layer becomes its own plane, so a
 * layer that never calls paintBelow fully replaces what is under it (its
 * plane is submitted alone), while one that does gets composited above the
 * planes below. Repeat calls return the same canvas.
 *
 * Note the plane model's occlusion rule: raster painted onto the canvas
 * covers lower planes entirely (including their text), but glyphs drawn into
 * the *same* image always render above that image's own raster.
 */
export type PaintBelow = () => GrayImage;

function notifyRemoved(layer: Layer | undefined): void {
  try {
    layer?.onRemoved?.();
  } catch (error) {
    console.warn("layer onRemoved failed", error);
  }
}

export interface LayerContext {
  readonly stack: LayerStack;
  readonly actions: LayerActions;
}

export interface Layer {
  readonly paintOverBase?: boolean;
  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage;
  handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> | void;
  /**
   * True when handleInput gives swipe-left / swipe-right a meaning of its own.
   * Otherwise the stack hands the layer directionalFallback(event) instead.
   */
  readonly acceptsDirectional?: boolean;
  /**
   * A touch at (x, y) in this layer's own canvas coordinates, from the phone's
   * mirror view. Return true if the layer acted on it (selected / opened what
   * is there); false sends a plain select (click) instead.
   */
  hitTest?(x: number, y: number, ctx: LayerContext): Promise<boolean> | boolean;
  /** Called when the layer leaves the stack by any path (pop or clearToBase). */
  onRemoved?(): void;
  /**
   * Accept a finished text string aimed at this window (voice input, and
   * anything else the shell routes through sendTextToForegroundWindow).
   * Layers that have somewhere to put text implement it; the rest don't, and
   * the shell then has no app destination to offer.
   */
  receiveTextInput?(text: string, ctx: LayerContext): void;
}

export class LayerStack {
  private readonly layers: Layer[];
  private readonly ctx: LayerContext;
  private baseWidth: number;
  private baseHeight: number;
  private readonly focusedFn: () => boolean;

  constructor(
    baseLayer: Layer,
    actions: LayerActions,
    baseSize?: { width: number; height: number },
    // Whether this stack is the current input target; drives the strength of
    // selection highlights (a visible-but-unfocused window dims its selection).
    // Defaults to always-focused for shell overlays and standalone stacks.
    isFocused: () => boolean = () => true,
  ) {
    this.layers = [baseLayer];
    this.ctx = {
      stack: this,
      actions,
    };
    this.baseWidth = baseSize?.width ?? G2_LENS_WIDTH;
    this.baseHeight = baseSize?.height ?? G2_LENS_HEIGHT;
    this.focusedFn = isFocused;
  }

  isFocused(): boolean {
    return this.focusedFn();
  }

  push(layer: Layer): void {
    this.layers.push(layer);
  }

  pop(): void {
    if (this.layers.length > 1) {
      notifyRemoved(this.layers.pop());
    }
  }

  /** Whether the top layer matches (without popping it). */
  topMatches(predicate: (layer: Layer) => boolean): boolean {
    return this.layers.length > 1 && predicate(this.layers[this.layers.length - 1]!);
  }

  /** Pop the top layer only if it matches; returns whether a layer was popped. */
  popIfTop(predicate: (layer: Layer) => boolean): boolean {
    if (this.layers.length > 1 && predicate(this.layers[this.layers.length - 1]!)) {
      notifyRemoved(this.layers.pop());
      return true;
    }
    return false;
  }

  clearToBase(): void {
    for (const layer of this.layers.splice(1)) {
      notifyRemoved(layer);
    }
  }

  isAtBase(): boolean {
    return this.layers.length === 1;
  }

  getBaseSize(): { width: number; height: number } {
    return { width: this.baseWidth, height: this.baseHeight };
  }

  /** Resize the base viewport (e.g. an EvenHub window switching to the tall canvas). */
  setBaseSize(size: { width: number; height: number }): void {
    this.baseWidth = size.width;
    this.baseHeight = size.height;
  }

  setActions(actions: Partial<LayerActions>): void {
    Object.assign(this.ctx.actions, actions);
  }

  /**
   * Paint the stack as planes, bottom to top: the top layer's plane last,
   * preceded by the planes of the layers it asked to remain visible (see
   * PaintBelow). All planes share the stack's base size at offset (0, 0).
   */
  paint(): Plane[] {
    return this.paintLayer(this.layers.length - 1);
  }

  async handleInput(event: DashboardInputEvent): Promise<void> {
    const top = this.layers[this.layers.length - 1]!;
    const delivered = isDirectionalInput(event) && !top.acceptsDirectional ? directionalFallback(event) : event;
    await top.handleInput(delivered, this.ctx);
  }

  /** Pass a mirror touch to the base layer when nothing is stacked on it. */
  async hitTest(x: number, y: number): Promise<boolean> {
    if (this.layers.length !== 1) return false;
    const base = this.layers[0]!;
    if (!base.hitTest) return false;
    return await base.hitTest(x, y, this.ctx);
  }

  /** Hand text to the top layer; false if it doesn't take text input. */
  receiveTextInput(text: string): boolean {
    const layer = this.layers[this.layers.length - 1]!;
    if (!layer.receiveTextInput) return false;
    layer.receiveTextInput(text, this.ctx);
    return true;
  }


  private paintLayer(index: number): Plane[] {
    const layer = this.layers[index]!;
    let canvas: GrayImage | null = null;
    let belowRequested = false;
    const image = spanCurrent(`paint[${index}]:${layer.constructor.name}`, () =>
      layer.paint(this.ctx, () => {
        belowRequested = true;
        if (!canvas) {
          canvas = new GrayImage(this.baseWidth, this.baseHeight, 0);
        }
        return canvas;
      }),
    );
    const ownPlane: Plane = { image, x: 0, y: 0 };
    if (index <= 0 || !belowRequested) {
      return [ownPlane];
    }
    const below = layer.paintOverBase ? this.paintLayer(0) : this.paintLayer(index - 1);
    return [...below, ownPlane];
  }
}
