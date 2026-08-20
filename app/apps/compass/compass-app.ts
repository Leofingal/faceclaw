import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import {
  COMPASS_CALIBRATION_COMPLETE,
  COMPASS_CALIBRATION_STARTED,
  COMPASS_CHANGED,
  addCompassListener,
  setCompassEnabled,
  type CompassEvent,
} from "../../native/compass";
import { wrapText } from "../../graphics/textwrap";
import { type DashboardInputEvent, type Layer, type LayerContext } from "../../ui/layers";
import { lineStep } from "../../ui/metrics";
import { screenCenterInViewportX } from "../../ui/shell/geometry";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { calibrateHeading, isCompassCalibrated, normalizeHeading } from "./calibration";
import { CompassCalibrationLayer } from "./calibration-layer";

export const COMPASS_WINDOW_ID = "compass";
export const COMPASS_SURFACE_ID = "window:compass";
const RECONCILE_INTERVAL_MS = 400;
/** Vertical breathing room between the rose, the readout and the status line. */
const STACK_GAP = 8;
/** Inset of the cardinal-label ring from the rose's outer circle. */
const LABEL_INSET = 14;

class CompassLayer implements Layer {
  private rawHeading: number | null = null;
  /** A firmware calibration message, shown until the next heading arrives. */
  private firmwareStatus: string | null = null;
  private enabled = false;
  private removed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly requestRender: () => void) {}

  start(): void {
    this.unsubscribe = addCompassListener((event) => this.onCompassEvent(event));
    this.timer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    this.reconcile();
  }

  stop(): void {
    if (this.removed) return;
    this.removed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.enabled) setCompassEnabled(false);
    this.enabled = false;
  }

  onRemoved(): void {
    this.stop();
  }

  openCalibration(ctx: LayerContext): void {
    if (ctx.stack.topMatches((layer) => layer instanceof CompassCalibrationLayer)) return;
    ctx.stack.push(new CompassCalibrationLayer(() => this.rawHeading));
  }

  private reconcile(): void {
    if (this.removed) return;
    const visible = shell.isWindowVisible(COMPASS_WINDOW_ID);
    if (visible === this.enabled) return;
    this.enabled = visible;
    setCompassEnabled(visible);
    this.firmwareStatus = null;
    this.requestRender();
  }

  private onCompassEvent(event: CompassEvent): void {
    if (this.removed) return;
    if (event.command === COMPASS_CHANGED && event.headingDegrees >= 0) {
      this.rawHeading = normalizeHeading(event.headingDegrees);
      this.firmwareStatus = null;
    } else if (event.command === COMPASS_CALIBRATION_STARTED) {
      this.firmwareStatus = "Calibrating — move the glasses";
    } else if (event.command === COMPASS_CALIBRATION_COMPLETE) {
      this.firmwareStatus = "Calibration complete";
    }
    this.requestRender();
  }

  private statusText(): string {
    if (this.firmwareStatus !== null) return this.firmwareStatus;
    if (!this.enabled) return "Compass paused";
    if (this.rawHeading === null) return "Waiting for compass data…";
    return isCompassCalibrated() ? "Magnetic heading" : "Uncalibrated - Tap to calibrate";
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const large = getDefaultLargeFont();
    const heading = this.rawHeading === null ? null : calibrateHeading(this.rawHeading);
    const radius = Math.min(63, Math.round(height * 0.227));
    const headingText = heading === null ? "--°" : `${Math.round(heading)}° ${cardinalDirection(heading)}`;
    const statusLines = wrapText(small, this.statusText(), width - STACK_GAP * 2);
    const smallStep = lineStep(small);

    // One column centred on the display's true centre, so the rose's centre
    // dot sits where the wearer is looking rather than 32px right of it.
    const cx = screenCenterInViewportX();
    const stackHeight = radius * 2 + STACK_GAP + large.lineHeight + STACK_GAP + statusLines.length * smallStep;
    const cy = Math.max(0, Math.round((height - stackHeight) / 2)) + radius;

    drawCompassRose(image, cx, cy, radius, heading);

    let y = cy + radius + STACK_GAP;
    image.drawText(large, Math.round(cx - large.measureText(headingText) / 2), y, headingText, heading === null ? 150 : 255);
    y += large.lineHeight + STACK_GAP;
    for (const line of statusLines) {
      image.drawText(small, Math.round(cx - small.measureText(line) / 2), y, line, 125);
      y += smallStep;
    }
    return image;
  }

  // A tap opens calibration from either state: it is the affordance the
  // "Uncalibrated" prompt advertises, and re-calibrating is a normal thing to
  // want once the glasses have been taken off and put back on.
  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "click") this.openCalibration(ctx);
  }
}

export function createCompassAppWindow(options: InProcessAppOptions): InProcessWindow {
  let app: InProcessWindow;
  let requestRender = () => {};
  const layer = new CompassLayer(() => requestRender());
  app = createInProcessWindow({
    appId: "compass",
    windowId: COMPASS_WINDOW_ID,
    title: "Compass",
    iconLetter: "C",
    icon: "compass",
    closeable: true,
    actions: options.actions,
    menuItems: () => [
      {
        label: "Calibrate",
        onSelect: (ctx) => {
          ctx.stack.pop();
          layer.openCalibration(ctx);
        },
      },
    ],
    baseLayer: new YieldAtRootLayer(layer),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.stop();
      options.onClosed();
    },
  });
  requestRender = app.requestRender;
  layer.start();
  return app;
}

function cardinalDirection(heading: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(normalizeHeading(heading) / 45) % names.length]!;
}

/** Draw a compass rose whose bright needle points toward magnetic north. */
function drawCompassRose(image: GrayImage, cx: number, cy: number, radius: number, heading: number | null): void {
  drawCircle(image, cx, cy, radius, 105);
  const small = getDefaultSmallFont();
  const medium = getDefaultMediumFont();
  const cardinals: Array<[string, number]> = [["N", -90], ["E", 0], ["S", 90], ["W", 180]];
  for (const [label, degrees] of cardinals) {
    const angle = (degrees - (heading ?? 0)) * Math.PI / 180;
    const x = cx + Math.cos(angle) * (radius - LABEL_INSET) - medium.measureText(label) / 2;
    const y = cy + Math.sin(angle) * (radius - LABEL_INSET) - medium.lineHeight / 2;
    image.drawText(medium, Math.round(x), Math.round(y), label, label === "N" ? 230 : 105);
  }
  const intercardinals: Array<[string, number]> = [["NE", -45], ["SE", 45], ["SW", 135], ["NW", -135]];
  for (const [label, degrees] of intercardinals) {
    const angle = (degrees - (heading ?? 0)) * Math.PI / 180;
    const x = cx + Math.cos(angle) * (radius - LABEL_INSET) - small.measureText(label) / 2;
    const y = cy + Math.sin(angle) * (radius - LABEL_INSET) - small.lineHeight / 2;
    image.drawText(small, Math.round(x), Math.round(y), label, 85);
  }
  image.fillRect(cx - 2, cy - 2, 5, 5, 180);
  if (heading === null) return;
  const northAngle = (-90 - heading) * Math.PI / 180;
  // Stop the needle just inside the label ring. The labels keep their font
  // size as the rose shrinks, so a fixed inset would run the needle into them.
  const needle = Math.max(8, radius - LABEL_INSET - medium.lineHeight / 2 - 4);
  const nx = cx + Math.cos(northAngle) * needle;
  const ny = cy + Math.sin(northAngle) * needle;
  const sx = cx - Math.cos(northAngle) * (needle - 8);
  const sy = cy - Math.sin(northAngle) * (needle - 8);
  drawThickLine(image, cx, cy, nx, ny, 255);
  image.drawLine(cx, cy, sx, sy, 75);
}

function drawCircle(image: GrayImage, cx: number, cy: number, radius: number, value: number): void {
  let x = radius;
  let y = 0;
  let error = 1 - x;
  while (x >= y) {
    const points = [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]];
    for (const [dx, dy] of points) image.setPixel(cx + dx!, cy + dy!, value);
    y++;
    if (error < 0) error += 2 * y + 1;
    else { x--; error += 2 * (y - x) + 1; }
  }
}

function drawThickLine(image: GrayImage, x0: number, y0: number, x1: number, y1: number, value: number): void {
  image.drawLine(x0, y0, x1, y1, value);
  image.drawLine(x0 - 1, y0, x1 - 1, y1, value);
  image.drawLine(x0 + 1, y0, x1 + 1, y1, value);
}
