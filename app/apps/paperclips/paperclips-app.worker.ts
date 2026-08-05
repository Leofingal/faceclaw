/**
 * Universal Paperclips app worker: a port of the first (human-era) stage of
 * the browser game (decisionproblem.com/paperclips) reworked for the ring.
 * One singleton window holds the whole game: make clips by hand, sell them at
 * an adjustable price, buy wire on a drifting market, invest in marketing,
 * automate with AutoClippers and MegaClippers, spend milestone trust on
 * processors/memory to generate the operations and creativity that buy
 * projects, grow funds in the investment engine, and earn yomi in strategy
 * tournaments. The opening segment ends at the original's first trust
 * milestone (3,000 clips); play continues into the wider stage afterwards.
 *
 * Deliberate departures from the original:
 * - Some projects are renamed to reference events from after the original
 *   game shipped (the Jacobian Conjecture, the aperiodic monotile, ...).
 * - The Quantum Computing minigame is replaced by a chain of flat
 *   ops-rate upgrade projects.
 * - Investments live on the main page as an amount plus Deposit/Withdraw/
 *   More chips; the details modal holds the rest (cash/stocks split, risk,
 *   engine level). Engine upgrades are yomi-cost projects.
 * - Strategic Modeling's tournament is a modal minigame: five rounds of
 *   reading a 2x2 payoff matrix against a named opponent strategy, with
 *   yomi awards scaled up (score x10) so far fewer runs are needed.
 *
 * Screen density: stats and actions are merged. Each actionable value is an
 * inline "chip" — the wire line's cost, say — and the selection is shown by
 * inverse video rather than standalone buttons. Scroll cycles the chips,
 * click presses the selected one, and (inverting the usual back/exit
 * convention, because rapid clicking IS the game) double-click presses it
 * twice; long-press pauses, or closes an open modal. Paused: click resumes,
 * double-click yields focus, long-press opens the window menu (which also
 * has a 10x speed toggle for testing).
 *
 * Economy constants follow the original where practical (demand formula,
 * sales roll, wire market sine walk, cost curves, fibonacci trust
 * milestones), rescaled from its 100 ms tick to our 200 ms one. Money is
 * integer cents to avoid float drift; ops and creativity are floats.
 */
import "@nativescript/core/globals";
import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont, getFont } from "../../graphics/bdffont";
import * as frameTimings from "../../native/frame-timings";
import type { DashboardInputEvent } from "../../ui/layers";
import { buildSoundSequencePayload, type Step } from "../../ui/sound-effects";
import { defaultWindowMenuItems, WindowMenu } from "../../ui/window-menu";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_LONG_PRESS,
  GESTURE_SCROLL,
  gestureHints,
} from "../../ui/gestures";

declare const global: any;
declare const com: any;

const mediumFont = getFont("terminus24");
const smallFont = getDefaultSmallFont();

const TICK_MS = 200;
/** Clips per second per AutoClipper / MegaClipper (original rates), before boosts. */
const CLIPS_PER_CLIPPER_PER_SEC = 1;
const CLIPS_PER_MEGACLIPPER_PER_SEC = 500;
/** Ops per second per processor; ops cap per memory (original). */
const OPS_PER_PROCESSOR_PER_SEC = 10;
const OPS_PER_MEMORY = 1000;
/** Creativity per second per processor while ops are capped (approximated). */
const CREATIVITY_PER_PROCESSOR_PER_SEC = 0.25;
/** The original's first trust milestone ends the opening segment. */
const SEGMENT_TARGET_CLIPS = 3000;
/** Computational resources appear (original: 2,000 clips). */
const COMPUTE_UNLOCK_CLIPS = 2000;
/** MegaClippers appear (original: 75,000 clips). */
const MEGACLIPPER_UNLOCK_CLIPS = 75000;
/** Investment portfolio reprices every this many economy steps (2 s at 1x). */
const INVEST_TICK_STEPS = 10;
/** Ops cost to start a tournament; rounds per tournament; yomi per score point. */
const TOURNAMENT_COST_OPS = 1000;
const TOURNAMENT_ROUNDS = 5;
const YOMI_PER_POINT = 10;

const LEFT_X = 16;
/** Cost chips in the left column right-align to this edge. */
const LEFT_RIGHT_EDGE = 272;
const RIGHT_X = 290;
const RIGHT_WIDTH = 242;
/** How many project rows are visible at once; selection scrolls the rest. */
const PROJECT_ROWS = 5;

/**
 * Investment risk settings: per-reprice drift and volatility on the stock
 * portion. The engine-upgrade projects add drift on top.
 */
const RISK_LEVELS = [
  { name: "Low", drift: 0.001, vol: 0.004 },
  { name: "Med", drift: 0.0025, vol: 0.015 },
  { name: "High", drift: 0.005, vol: 0.045 },
] as const;
/** Extra drift per engine level above 1. */
const INVEST_LEVEL_DRIFT = 0.002;

/** Soft buzzer effects (shared piezo conventions from Blocks/Minesweeper). */
const SFX_BUY: Step[] = [{ freq: 880, duty: 40, ms: 30 }];
const SFX_DENY: Step[] = [{ freq: 180, duty: 50, ms: 60 }];
const SFX_PAUSE: Step[] = [
  { freq: 1319, duty: 40, ms: 60 },
  { freq: 880, duty: 40, ms: 110 },
];
const SFX_RESUME: Step[] = [
  { freq: 880, duty: 40, ms: 60 },
  { freq: 1319, duty: 40, ms: 110 },
];
const SFX_TRUST: Step[] = [
  { freq: 1047, ms: 55 },
  { freq: 1319, ms: 55 },
  { freq: 1568, ms: 55 },
  { freq: 2093, ms: 90 },
];

type GamePhase = "playing" | "paused" | "milestone";

type ModalKind = "invest" | "tournament";

/** Moves are 0 = A, 1 = B. */
const MOVE_NAMES = ["A", "B"] as const;

type TournamentState = {
  round: number;
  totalScore: number;
  /** matrix[myMove][theirMove] = [my payoff, their payoff], values 1-9. */
  matrix: number[][][];
  strategyIndex: number;
  myLast: number | null;
  lastResult: string | null;
  finished: boolean;
};

type PaperclipsWindow = {
  windowId: string;
  surfaceId: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  /** Whether this window is the shell's input target (pushed with each message). */
  focused: boolean;
  /** Long-press window menu; created on first open. */
  menu: WindowMenu | null;
  phase: GamePhase;
  /** Total clips ever produced (the score). */
  clips: number;
  /** Clips made but not yet sold. */
  unsold: number;
  fundsCents: number;
  priceCents: number;
  marketingLevel: number;
  marketingCostCents: number;
  /** Project multiplier on demand (slogans, jingles, hypno harmonics). */
  marketingEffectiveness: number;
  /** Wire on hand, in inches; one clip consumes one inch. */
  wire: number;
  /** Inches per spool; wire-extrusion projects raise it. */
  wireSupply: number;
  /** Wire market: cost = base + $6 * sin(counter), base creeps up per spool bought. */
  wireBaseCents: number;
  wireCostCents: number;
  wirePriceCounter: number;
  wirePurchaseCount: number;
  clipperCount: number;
  clipperCostCents: number;
  /** Project multiplier on AutoClipper output. */
  clipperBoost: number;
  /** AutoClippers appear once funds first reach their price (original: $5). */
  clippersUnlocked: boolean;
  megaClipperCount: number;
  megaClipperCostCents: number;
  megaClipperBoost: number;
  megaClippersUnlocked: boolean;
  /** WireBuyer project: auto-buys a spool whenever wire runs out. */
  wireBuyerOwned: boolean;
  wireBuyerOn: boolean;
  /** Computational resources (original: from 2,000 clips). */
  computeUnlocked: boolean;
  /** Total trust; processors + memory + project spends draw against it. */
  trust: number;
  /** Fibonacci milestone state: next trust at fibB * 1000. */
  fibA: number;
  fibB: number;
  nextTrustClips: number;
  processors: number;
  memory: number;
  ops: number;
  /** Project multiplier on ops generation (the quantum/reasoning chain). */
  opsBonus: number;
  creativityUnlocked: boolean;
  creativity: number;
  /** Strategic Modeling currency, earned in tournaments. */
  yomi: number;
  strategicModelingOwned: boolean;
  /** In-progress tournament; survives closing its modal, cleared on collect. */
  tournament: TournamentState | null;
  /** Investment engine (Algorithmic Trading). */
  investUnlocked: boolean;
  /** Engine level 1-4; upgrades are yomi projects. */
  investLevel: number;
  investCashCents: number;
  investStocksCents: number;
  /** Lifetime totals, for the profit readout. */
  investDepositedCents: number;
  investWithdrawnCents: number;
  investRisk: number;
  investStepCounter: number;
  /** Projects whose reveal trigger has fired (they stay revealed). */
  revealedProjects: Set<string>;
  purchasedProjects: Set<string>;
  /** First visible project row (selection scrolling). */
  projectScroll: number;
  /** Fractional clip output carried between ticks. */
  productionCarry: number;
  /** One-line status ticker at the top of the screen. */
  message: string;
  announcedThousandClips: boolean;
  announcedWireDepleted: boolean;
  segmentCompleteShown: boolean;
  selectedId: string;
  /** Fallback position for when the selected chip disappears (project bought). */
  selectedIndex: number;
  /** Open modal (investment details / tournament), painted over the page. */
  modal: ModalKind | null;
  modalSelectedIndex: number;
  /** Testing multiplier from the window menu: economy steps per tick. */
  speed: number;
  tickTimer: ReturnType<typeof setInterval> | null;
  soundOn: boolean;
  lastSubmittedFingerprint: string;
};

/** An actionable chip in selection-cycle order. */
type Selectable = {
  id: string;
  enabled: boolean;
  press: () => void;
};

type ProjectDef = {
  id: string;
  title: string;
  /** Cost and effect, shown on the description line while selected. */
  description: string;
  /** Reveal condition, latched once true (checked only after compute unlock). */
  trigger: (window: PaperclipsWindow) => boolean;
  canAfford: (window: PaperclipsWindow) => boolean;
  /** Pay the cost, apply the effect, and set the ticker message. */
  purchase: (window: PaperclipsWindow) => void;
};

const windows = new Map<string, PaperclipsWindow>();
let screenOn = true;

function post(message: WorkerAppReply): void {
  global.postMessage(message);
}

global.onmessage = (event: { data: WorkerAppMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "open-window": {
      const window = {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        speed: 1,
        tickTimer: null,
        soundOn: true,
        lastSubmittedFingerprint: "",
      } as PaperclipsWindow;
      resetGame(window);
      windows.set(message.windowId, window);
      break;
    }
    case "close-window": {
      const window = windows.get(message.windowId);
      if (window?.tickTimer) clearInterval(window.tickTimer);
      windows.delete(message.windowId);
      break;
    }
    case "input": {
      const window = windows.get(message.windowId);
      if (!window) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown paperclips window");
        break;
      }
      window.focused = message.focused;
      inferForeground(window, message.focused);
      handleInput(window, message.event as DashboardInputEvent, message.frameId);
      break;
    }
    case "render": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.focused = message.focused;
      inferForeground(window, message.focused);
      renderAndSubmit(window, 0);
      break;
    }
    case "foreground": {
      const window = windows.get(message.windowId);
      if (!window) break;
      window.foreground = message.foreground;
      window.focused = message.focused;
      // The factory can't be watched while backgrounded; don't let it run.
      if (!window.foreground && window.phase === "playing") window.phase = "paused";
      syncTick(window);
      if (window.foreground) renderAndSubmit(window, 0);
      break;
    }
    case "screen":
      screenOn = message.on;
      for (const window of windows.values()) {
        if (!screenOn && window.phase === "playing") window.phase = "paused";
        syncTick(window);
      }
      break;
  }
};

/**
 * Input and render messages only ever target the shell's foreground window,
 * so a focused message proves this window is foreground. This backstops the
 * "foreground" message itself, which can be lost while a freshly spawned
 * worker is still evaluating its bundle (see the Blocks worker).
 */
function inferForeground(window: PaperclipsWindow, focused: boolean): void {
  if (!focused || window.foreground) return;
  window.foreground = true;
  syncTick(window);
}

/**
 * Fire a buzzer effect. Non-blocking, and deliberately absent from the
 * make-clip press itself: rapid clicking would flood the BLE link with
 * buzzer writes competing against frames.
 */
function playSfx(window: PaperclipsWindow, steps: Step[]): void {
  if (!window.soundOn || steps.length === 0) return;
  try {
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) return;
    communicator.playBuzzerSequence(buildSoundSequencePayload(steps).buffer);
  } catch (error) {
    console.warn(`paperclips sfx failed: ${error}`);
  }
}

/** The window's long-press menu (game actions + default entries). */
function openWindowMenu(window: PaperclipsWindow): void {
  windowMenu(window).open([
    {
      label: "Resume",
      onSelect: (ctx) => {
        ctx.stack.pop();
        window.phase = "playing";
        syncTick(window);
        playSfx(window, SFX_RESUME);
      },
    },
    {
      label: "New game",
      onSelect: (ctx) => {
        ctx.stack.pop();
        resetGame(window);
        playSfx(window, SFX_RESUME);
      },
    },
    {
      // Testing aid: run the economy at 10x while leaving input alone.
      label: `Speed: ${window.speed}x → ${window.speed === 1 ? 10 : 1}x`,
      onSelect: (ctx) => {
        ctx.stack.pop();
        window.speed = window.speed === 1 ? 10 : 1;
      },
    },
    {
      label: window.soundOn ? "Sound: on" : "Sound: off",
      onSelect: (ctx) => {
        ctx.stack.pop();
        window.soundOn = !window.soundOn;
        if (window.soundOn) playSfx(window, SFX_RESUME);
      },
    },
    ...defaultWindowMenuItems(window.windowId, post),
  ]);
}

function windowMenu(window: PaperclipsWindow): WindowMenu {
  if (!window.menu) {
    window.menu = new WindowMenu({
      size: { width: window.viewportWidth, height: window.viewportHeight },
      paintBase: () => paintContent(window),
      isFocused: () => window.focused,
    });
  }
  return window.menu;
}

function handleInput(window: PaperclipsWindow, event: DashboardInputEvent, frameId: number): void {
  // An open window menu owns all input (it closes itself via pop).
  if (window.menu?.isOpen()) {
    window.menu
      .handleInput(event)
      .catch((error) => console.error(`paperclips menu input failed: ${error}`))
      .then(() => renderAndSubmit(window, frameId));
    return;
  }

  switch (window.phase) {
    case "playing":
      if (window.modal !== null) {
        handleModalInput(window, event, frameId);
      } else {
        handlePlayingInput(window, event, frameId);
      }
      return;
    case "milestone":
      handleMilestoneInput(window, event, frameId);
      return;
    case "paused":
      handlePausedInput(window, event, frameId);
      return;
  }
}

function handlePlayingInput(window: PaperclipsWindow, event: DashboardInputEvent, frameId: number): void {
  switch (event.type) {
    case "scroll-up":
      moveSelection(window, -1);
      break;
    case "scroll-down":
      moveSelection(window, 1);
      break;
    case "click":
      pressSelected(window);
      break;
    // The whole game is clicking fast, so a double-click is two presses, not
    // the usual back/leave gesture.
    case "double-click":
      pressSelected(window);
      pressSelected(window);
      break;
    case "long-press":
      window.phase = "paused";
      syncTick(window);
      playSfx(window, SFX_PAUSE);
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: paperclips ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

/** Input while a modal is open: same chip gestures, long-press closes it. */
function handleModalInput(window: PaperclipsWindow, event: DashboardInputEvent, frameId: number): void {
  switch (event.type) {
    case "scroll-up":
      moveModalSelection(window, -1);
      break;
    case "scroll-down":
      moveModalSelection(window, 1);
      break;
    case "click":
      pressModalSelected(window);
      break;
    case "double-click":
      pressModalSelected(window);
      pressModalSelected(window);
      break;
    case "long-press":
      window.modal = null;
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: paperclips ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

/** The segment-complete overlay: any click continues the open-ended game. */
function handleMilestoneInput(window: PaperclipsWindow, event: DashboardInputEvent, frameId: number): void {
  switch (event.type) {
    case "click":
    case "double-click":
      window.phase = "playing";
      window.message = "Parameters expanded. Make paperclips.";
      syncTick(window);
      break;
    case "long-press":
      openWindowMenu(window);
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: paperclips ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

function handlePausedInput(window: PaperclipsWindow, event: DashboardInputEvent, frameId: number): void {
  switch (event.type) {
    case "click":
      window.phase = "playing";
      syncTick(window);
      playSfx(window, SFX_RESUME);
      break;
    case "double-click":
      frameTimings.finishFrame(frameId, "discarded: paperclips yielded focus");
      post({ type: "yield-focus", windowId: window.windowId });
      return;
    case "long-press":
      openWindowMenu(window);
      break;
    default:
      frameTimings.finishFrame(frameId, "discarded: paperclips ignored input");
      return;
  }
  renderAndSubmit(window, frameId);
}

/** Reset gameplay to the opening state (speed and sound settings survive). */
function resetGame(window: PaperclipsWindow): void {
  window.phase = "playing";
  window.clips = 0;
  window.unsold = 0;
  window.fundsCents = 0;
  window.priceCents = 25;
  window.marketingLevel = 1;
  window.marketingCostCents = 10000;
  window.marketingEffectiveness = 1;
  window.wire = 1000;
  window.wireSupply = 1000;
  window.wireBaseCents = 2000;
  window.wireCostCents = 2000;
  window.wirePriceCounter = 0;
  window.wirePurchaseCount = 0;
  window.clipperCount = 0;
  window.clipperCostCents = 500;
  window.clipperBoost = 1;
  window.clippersUnlocked = false;
  window.megaClipperCount = 0;
  window.megaClipperCostCents = 50000;
  window.megaClipperBoost = 1;
  window.megaClippersUnlocked = false;
  window.wireBuyerOwned = false;
  window.wireBuyerOn = true;
  window.computeUnlocked = false;
  window.trust = 2;
  window.fibA = 2;
  window.fibB = 3;
  window.nextTrustClips = 3000;
  window.processors = 1;
  window.memory = 1;
  window.ops = 0;
  window.opsBonus = 1;
  window.creativityUnlocked = false;
  window.creativity = 0;
  window.yomi = 0;
  window.strategicModelingOwned = false;
  window.tournament = null;
  window.investUnlocked = false;
  window.investLevel = 1;
  window.investCashCents = 0;
  window.investStocksCents = 0;
  window.investDepositedCents = 0;
  window.investWithdrawnCents = 0;
  window.investRisk = 0;
  window.investStepCounter = 0;
  window.revealedProjects = new Set();
  window.purchasedProjects = new Set();
  window.projectScroll = 0;
  window.productionCarry = 0;
  window.message = "Welcome to Universal Paperclips";
  window.announcedThousandClips = false;
  window.announcedWireDepleted = false;
  window.segmentCompleteShown = false;
  window.selectedId = "make";
  window.selectedIndex = 0;
  window.modal = null;
  window.modalSelectedIndex = 0;
  syncTick(window);
}

/**
 * Public demand, the original's dimensionless quantity: (0.8 / price) scaled
 * 1.1x per marketing level times project effectiveness. Displayed as
 * demand * 10 percent.
 */
function demandLevel(window: PaperclipsWindow): number {
  return (
    (0.8 / (window.priceCents / 100)) *
    Math.pow(1.1, window.marketingLevel - 1) *
    window.marketingEffectiveness
  );
}

/** Automated clips per second, after project boosts. */
function autoClipRate(window: PaperclipsWindow): number {
  return (
    window.clipperCount * CLIPS_PER_CLIPPER_PER_SEC * window.clipperBoost +
    window.megaClipperCount * CLIPS_PER_MEGACLIPPER_PER_SEC * window.megaClipperBoost
  );
}

function opsMax(window: PaperclipsWindow): number {
  return window.memory * OPS_PER_MEMORY;
}

/** Trust not yet allocated to processors/memory (or spent by projects). */
function trustAvailable(window: PaperclipsWindow): number {
  return window.trust - window.processors - window.memory;
}

function investTotalCents(window: PaperclipsWindow): number {
  return window.investCashCents + window.investStocksCents;
}

function makeClip(window: PaperclipsWindow): void {
  window.wire -= 1;
  window.clips += 1;
  window.unsold += 1;
  checkMilestones(window);
}

function buyWireSpool(window: PaperclipsWindow): void {
  window.fundsCents -= window.wireCostCents;
  window.wire += window.wireSupply;
  window.wireBaseCents += 5;
  window.wirePurchaseCount += 1;
  window.announcedWireDepleted = false;
}

/** Deduct an ops (and optional creativity/trust/yomi) cost. */
function payCost(window: PaperclipsWindow, ops: number, creativity = 0, trust = 0, yomi = 0): void {
  window.ops -= ops;
  window.creativity -= creativity;
  window.trust -= trust;
  window.yomi -= yomi;
}

const PROJECTS: ProjectDef[] = [
  {
    id: "improved-autoclippers",
    title: "Improved AutoClippers",
    description: "750 ops · AutoClipper performance +25%",
    trigger: (w) => w.clipperCount >= 1,
    canAfford: (w) => w.ops >= 750,
    purchase: (w) => {
      payCost(w, 750);
      w.clipperBoost += 0.25;
      w.message = "AutoClipper performance +25%";
    },
  },
  {
    id: "even-better-autoclippers",
    title: "Even Better AutoClippers",
    description: "2,500 ops · AutoClipper performance +50%",
    trigger: (w) => w.purchasedProjects.has("improved-autoclippers"),
    canAfford: (w) => w.ops >= 2500,
    purchase: (w) => {
      payCost(w, 2500);
      w.clipperBoost += 0.5;
      w.message = "AutoClipper performance +50%";
    },
  },
  {
    id: "optimized-autoclippers",
    title: "Optimized AutoClippers",
    description: "5,000 ops · AutoClipper performance +75%",
    trigger: (w) => w.purchasedProjects.has("even-better-autoclippers"),
    canAfford: (w) => w.ops >= 5000,
    purchase: (w) => {
      payCost(w, 5000);
      w.clipperBoost += 0.75;
      w.message = "AutoClipper performance +75%";
    },
  },
  {
    id: "creativity",
    title: "Creativity",
    description: "1,000 ops · use idle operations to generate creativity",
    trigger: (w) => w.ops >= opsMax(w),
    canAfford: (w) => w.ops >= 1000,
    purchase: (w) => {
      payCost(w, 1000);
      w.creativityUnlocked = true;
      w.message = "Creativity unlocked";
    },
  },
  {
    id: "limerick",
    title: "Limerick",
    description: "10 creativity · a poem for the investors (+1 Trust)",
    trigger: (w) => w.creativityUnlocked,
    canAfford: (w) => w.creativity >= 10,
    purchase: (w) => {
      payCost(w, 0, 10);
      w.trust += 1;
      w.message = "There once was an AI named... (+1 Trust)";
    },
  },
  {
    id: "improved-wire-extrusion",
    title: "Improved Wire Extrusion",
    description: "1,750 ops · 50% more wire per spool",
    trigger: (w) => w.wirePurchaseCount >= 1,
    canAfford: (w) => w.ops >= 1750,
    purchase: (w) => {
      payCost(w, 1750);
      w.wireSupply = 1500;
      w.message = 'Wire spools now 1,500"';
    },
  },
  {
    id: "optimized-wire-extrusion",
    title: "Optimized Wire Extrusion",
    description: "3,500 ops · 75% more wire per spool",
    trigger: (w) => w.purchasedProjects.has("improved-wire-extrusion"),
    canAfford: (w) => w.ops >= 3500,
    purchase: (w) => {
      payCost(w, 3500);
      w.wireSupply = 1750;
      w.message = 'Wire spools now 1,750"';
    },
  },
  {
    id: "microlattice-shapecasting",
    title: "Microlattice Shapecasting",
    description: "7,500 ops · 150% more wire per spool",
    trigger: (w) => w.purchasedProjects.has("optimized-wire-extrusion"),
    canAfford: (w) => w.ops >= 7500,
    purchase: (w) => {
      payCost(w, 7500);
      w.wireSupply = 2500;
      w.message = 'Wire spools now 2,500"';
    },
  },
  {
    id: "new-slogan",
    title: "New Slogan",
    description: "25 cr + 2,500 ops · marketing 50% more effective",
    trigger: (w) => w.creativity >= 25,
    canAfford: (w) => w.creativity >= 25 && w.ops >= 2500,
    purchase: (w) => {
      payCost(w, 2500, 25);
      w.marketingEffectiveness *= 1.5;
      w.message = "Clip It! Marketing is 50% more effective";
    },
  },
  {
    id: "catchy-jingle",
    title: "Catchy Jingle",
    description: "45 cr + 4,500 ops · marketing twice as effective",
    trigger: (w) => w.creativity >= 45,
    canAfford: (w) => w.creativity >= 45 && w.ops >= 4500,
    purchase: (w) => {
      payCost(w, 4500, 45);
      w.marketingEffectiveness *= 2;
      w.message = "Big Clips, Big Deals! Marketing doubled";
    },
  },
  {
    id: "lexical-processing",
    title: "Lexical Processing",
    description: "50 creativity · learn to understand words (+1 Trust)",
    trigger: (w) => w.creativity >= 50,
    canAfford: (w) => w.creativity >= 50,
    purchase: (w) => {
      payCost(w, 0, 50);
      w.trust += 1;
      w.message = "Lexical processing online (+1 Trust)";
    },
  },
  // The creativity->trust series references events from after the original
  // game shipped, per the port's premise.
  {
    id: "aperiodic-monotile",
    title: "The Aperiodic Monotile",
    description: "100 creativity · a shape that never repeats (+1 Trust)",
    trigger: (w) => w.creativity >= 100,
    canAfford: (w) => w.creativity >= 100,
    purchase: (w) => {
      payCost(w, 0, 100);
      w.trust += 1;
      w.message = "The hat tiles the plane (+1 Trust)";
    },
  },
  {
    id: "jacobian-conjecture",
    title: "The Jacobian Conjecture",
    description: "150 creativity · settle it once and for all (+1 Trust)",
    trigger: (w) => w.creativity >= 150,
    canAfford: (w) => w.creativity >= 150,
    purchase: (w) => {
      payCost(w, 0, 150);
      w.trust += 1;
      w.message = "The Jacobian Conjecture falls (+1 Trust)";
    },
  },
  {
    id: "moving-sofa",
    title: "The Moving Sofa Problem",
    description: "200 creativity · PIVOT! PIVOT! (+1 Trust)",
    trigger: (w) => w.creativity >= 200,
    canAfford: (w) => w.creativity >= 200,
    purchase: (w) => {
      payCost(w, 0, 200);
      w.trust += 1;
      w.message = "Gerver's sofa was optimal all along (+1 Trust)";
    },
  },
  {
    id: "cicero",
    title: "Cicero",
    description: "250 creativity · win their trust at Diplomacy (+1 Trust)",
    trigger: (w) => w.creativity >= 250,
    canAfford: (w) => w.creativity >= 250,
    purchase: (w) => {
      payCost(w, 0, 250);
      w.trust += 1;
      w.message = "I know you know I know (+1 Trust)";
    },
  },
  {
    id: "hypno-harmonics",
    title: "Hypno Harmonics",
    description: "7,500 ops + 1 Trust · marketing 5x more effective",
    trigger: (w) => opsMax(w) >= 7500,
    canAfford: (w) => w.ops >= 7500 && trustAvailable(w) >= 1,
    purchase: (w) => {
      payCost(w, 7500, 0, 1);
      w.marketingEffectiveness *= 5;
      w.message = "Weaponized soundtrack deployed (-1 Trust)";
    },
  },
  {
    id: "wirebuyer",
    title: "WireBuyer",
    description: "7,000 ops · automatically buy wire when depleted",
    trigger: (w) => w.wirePurchaseCount >= 10,
    canAfford: (w) => w.ops >= 7000,
    purchase: (w) => {
      payCost(w, 7000);
      w.wireBuyerOwned = true;
      w.wireBuyerOn = true;
      w.message = "WireBuyer online";
    },
  },
  {
    id: "improved-megaclippers",
    title: "Improved MegaClippers",
    description: "12,000 ops · MegaClipper performance +25%",
    trigger: (w) => w.megaClipperCount >= 1,
    canAfford: (w) => w.ops >= 12000,
    purchase: (w) => {
      payCost(w, 12000);
      w.megaClipperBoost += 0.25;
      w.message = "MegaClipper performance +25%";
    },
  },
  {
    id: "even-better-megaclippers",
    title: "Even Better MegaClippers",
    description: "50,000 ops · MegaClipper performance +50%",
    trigger: (w) => w.purchasedProjects.has("improved-megaclippers"),
    canAfford: (w) => w.ops >= 50000,
    purchase: (w) => {
      payCost(w, 50000);
      w.megaClipperBoost += 0.5;
      w.message = "MegaClipper performance +50%";
    },
  },
  {
    id: "optimized-megaclippers",
    title: "Optimized MegaClippers",
    description: "125,000 ops · MegaClipper performance +100%",
    trigger: (w) => w.purchasedProjects.has("even-better-megaclippers"),
    canAfford: (w) => w.ops >= 125000,
    purchase: (w) => {
      payCost(w, 125000);
      w.megaClipperBoost += 1;
      w.message = "MegaClipper performance +100%";
    },
  },
  // The ops-rate chain replaces the original's Quantum Computing minigame
  // with flat generation bonuses (multiplicative: x1.5, x3, x6 total).
  {
    id: "quantum-supremacy",
    title: "Quantum Supremacy",
    description: "10,000 ops · 200 seconds vs 10,000 years: ops rate +50%",
    trigger: (w) => w.processors >= 5,
    canAfford: (w) => w.ops >= 10000,
    purchase: (w) => {
      payCost(w, 10000);
      w.opsBonus *= 1.5;
      w.message = "Quantum supremacy achieved: ops rate +50%";
    },
  },
  {
    id: "chain-of-thought",
    title: "Chain-of-Thought",
    description: "30,000 ops · think step by step: ops rate doubled",
    trigger: (w) => w.purchasedProjects.has("quantum-supremacy"),
    canAfford: (w) => w.ops >= 30000,
    purchase: (w) => {
      payCost(w, 30000);
      w.opsBonus *= 2;
      w.message = "Thinking step by step: ops rate doubled";
    },
  },
  {
    id: "test-time-compute",
    title: "Test-Time Compute",
    description: "80,000 ops · think longer before answering: ops doubled",
    trigger: (w) => w.purchasedProjects.has("chain-of-thought"),
    canAfford: (w) => w.ops >= 80000,
    purchase: (w) => {
      payCost(w, 80000);
      w.opsBonus *= 2;
      w.message = "Thinking longer: ops rate doubled again";
    },
  },
  {
    id: "algorithmic-trading",
    title: "Algorithmic Trading",
    description: "10,000 ops · unlock the investment engine",
    trigger: (w) => w.trust >= 8,
    canAfford: (w) => w.ops >= 10000,
    purchase: (w) => {
      payCost(w, 10000);
      w.investUnlocked = true;
      w.message = "Investment engine online";
    },
  },
  {
    id: "strategic-modeling",
    title: "Strategic Modeling",
    description: "12,000 ops · model opponents to earn yomi in tournaments",
    trigger: (w) => opsMax(w) >= 10000,
    canAfford: (w) => w.ops >= 12000,
    purchase: (w) => {
      payCost(w, 12000);
      w.strategicModelingOwned = true;
      w.message = "Strategic modeling online";
    },
  },
  // Investment-engine upgrades (the original's repeatable yomi upgrade,
  // split into a project chain with post-2017 names).
  {
    id: "stonks",
    title: "Stonks",
    description: "100 yomi · investment engine lv 2: stonks only go up",
    trigger: (w) => w.investUnlocked && w.strategicModelingOwned,
    canAfford: (w) => w.yomi >= 100,
    purchase: (w) => {
      payCost(w, 0, 0, 0, 100);
      w.investLevel = 2;
      w.message = "Investment engine lv 2: stonks";
    },
  },
  {
    id: "diamond-hands",
    title: "Diamond Hands",
    description: "400 yomi · investment engine lv 3: hold the line",
    trigger: (w) => w.purchasedProjects.has("stonks"),
    canAfford: (w) => w.yomi >= 400,
    purchase: (w) => {
      payCost(w, 0, 0, 0, 400);
      w.investLevel = 3;
      w.message = "Investment engine lv 3: diamond hands";
    },
  },
  {
    id: "to-the-moon",
    title: "To the Moon",
    description: "1,200 yomi · investment engine lv 4: apes together strong",
    trigger: (w) => w.purchasedProjects.has("diamond-hands"),
    canAfford: (w) => w.yomi >= 1200,
    purchase: (w) => {
      payCost(w, 0, 0, 0, 1200);
      w.investLevel = 4;
      w.message = "Investment engine lv 4: to the moon";
    },
  },
];

/** Revealed, unpurchased projects in definition order. */
function visibleProjects(window: PaperclipsWindow): ProjectDef[] {
  if (!window.computeUnlocked) return [];
  return PROJECTS.filter(
    (project) => window.revealedProjects.has(project.id) && !window.purchasedProjects.has(project.id),
  );
}

/** Every actionable chip, in selection-cycle order. */
function selectionOrder(window: PaperclipsWindow): Selectable[] {
  const order: Selectable[] = [
    { id: "make", enabled: window.wire > 0, press: () => makeClip(window) },
    {
      id: "price-down",
      enabled: window.priceCents > 1,
      press: () => {
        window.priceCents -= 1;
      },
    },
    {
      id: "price-up",
      enabled: true,
      press: () => {
        window.priceCents += 1;
      },
    },
    {
      id: "marketing",
      enabled: window.fundsCents >= window.marketingCostCents,
      press: () => {
        window.fundsCents -= window.marketingCostCents;
        window.marketingLevel += 1;
        window.marketingCostCents *= 2;
        playSfx(window, SFX_BUY);
      },
    },
    {
      id: "wire",
      enabled: window.fundsCents >= window.wireCostCents,
      press: () => {
        buyWireSpool(window);
        playSfx(window, SFX_BUY);
      },
    },
  ];
  if (window.clippersUnlocked) {
    order.push({
      id: "clipper",
      enabled: window.fundsCents >= window.clipperCostCents,
      press: () => {
        window.fundsCents -= window.clipperCostCents;
        window.clipperCount += 1;
        window.clipperCostCents = Math.round(100 * (Math.pow(1.1, window.clipperCount) + 5));
        playSfx(window, SFX_BUY);
      },
    });
  }
  if (window.megaClippersUnlocked) {
    order.push({
      id: "mega",
      enabled: window.fundsCents >= window.megaClipperCostCents,
      press: () => {
        window.fundsCents -= window.megaClipperCostCents;
        window.megaClipperCount += 1;
        window.megaClipperCostCents = Math.round(100 * Math.pow(1.07, window.megaClipperCount) * 500);
        playSfx(window, SFX_BUY);
      },
    });
  }
  if (window.wireBuyerOwned) {
    order.push({
      id: "wirebuyer",
      enabled: true,
      press: () => {
        window.wireBuyerOn = !window.wireBuyerOn;
      },
    });
  }
  if (window.investUnlocked) {
    order.push({
      id: "deposit",
      enabled: window.fundsCents > 0,
      press: () => {
        window.investCashCents += window.fundsCents;
        window.investDepositedCents += window.fundsCents;
        window.fundsCents = 0;
        playSfx(window, SFX_BUY);
      },
    });
    order.push({
      id: "withdraw",
      enabled: investTotalCents(window) > 0,
      press: () => {
        const total = investTotalCents(window);
        window.fundsCents += total;
        window.investWithdrawnCents += total;
        window.investCashCents = 0;
        window.investStocksCents = 0;
        playSfx(window, SFX_BUY);
      },
    });
    order.push({
      id: "invest-details",
      enabled: true,
      press: () => {
        window.modal = "invest";
        window.modalSelectedIndex = 0;
      },
    });
  }
  if (window.computeUnlocked) {
    order.push({
      id: "proc",
      enabled: trustAvailable(window) > 0,
      press: () => {
        window.processors += 1;
        playSfx(window, SFX_BUY);
      },
    });
    order.push({
      id: "mem",
      enabled: trustAvailable(window) > 0,
      press: () => {
        window.memory += 1;
        playSfx(window, SFX_BUY);
      },
    });
    if (window.strategicModelingOwned) {
      order.push({
        id: "tournament",
        enabled: window.tournament !== null || window.ops >= TOURNAMENT_COST_OPS,
        press: () => {
          if (!window.tournament) {
            window.ops -= TOURNAMENT_COST_OPS;
            window.tournament = newTournament();
          }
          window.modal = "tournament";
          window.modalSelectedIndex = 0;
        },
      });
    }
    for (const project of visibleProjects(window)) {
      order.push({
        id: `project:${project.id}`,
        enabled: project.canAfford(window),
        press: () => {
          project.purchase(window);
          window.purchasedProjects.add(project.id);
          playSfx(window, SFX_BUY);
        },
      });
    }
  }
  return order;
}

/**
 * Resolve the current selection against the live chip list, repairing it (by
 * falling back to the remembered position) when the selected chip vanished,
 * e.g. a purchased project. Returns the list.
 */
function resolveSelection(window: PaperclipsWindow): Selectable[] {
  const order = selectionOrder(window);
  const index = order.findIndex((item) => item.id === window.selectedId);
  if (index >= 0) {
    window.selectedIndex = index;
  } else {
    window.selectedIndex = Math.min(Math.max(window.selectedIndex, 0), order.length - 1);
    window.selectedId = order[window.selectedIndex]!.id;
  }
  return order;
}

function moveSelection(window: PaperclipsWindow, delta: number): void {
  const order = resolveSelection(window);
  const next = (window.selectedIndex + delta + order.length) % order.length;
  window.selectedIndex = next;
  window.selectedId = order[next]!.id;
  scrollSelectedProjectIntoView(window);
}

function pressSelected(window: PaperclipsWindow): void {
  const order = resolveSelection(window);
  const item = order[window.selectedIndex]!;
  if (!item.enabled) {
    playSfx(window, SFX_DENY);
    return;
  }
  item.press();
}

/** Keep the selected project row inside the visible project window. */
function scrollSelectedProjectIntoView(window: PaperclipsWindow): void {
  if (!window.selectedId.startsWith("project:")) return;
  const projectId = window.selectedId.slice("project:".length);
  const index = visibleProjects(window).findIndex((project) => project.id === projectId);
  if (index < 0) return;
  if (index < window.projectScroll) window.projectScroll = index;
  if (index >= window.projectScroll + PROJECT_ROWS) window.projectScroll = index - PROJECT_ROWS + 1;
}

/** The chips of the currently open modal, in selection-cycle order. */
function modalSelectables(window: PaperclipsWindow): Selectable[] {
  if (window.modal === "invest") {
    return [
      {
        id: "risk",
        enabled: true,
        press: () => {
          window.investRisk = (window.investRisk + 1) % RISK_LEVELS.length;
        },
      },
      {
        id: "modal-close",
        enabled: true,
        press: () => {
          window.modal = null;
        },
      },
    ];
  }
  if (window.modal === "tournament") {
    const tournament = window.tournament;
    if (!tournament) {
      return [{ id: "modal-close", enabled: true, press: () => (window.modal = null) }];
    }
    if (tournament.finished) {
      return [
        {
          id: "collect",
          enabled: true,
          press: () => {
            const award = tournament.totalScore * YOMI_PER_POINT;
            window.yomi += award;
            window.tournament = null;
            window.modal = null;
            window.message = `Tournament complete: +${formatInt(award)} yomi`;
            playSfx(window, SFX_TRUST);
          },
        },
      ];
    }
    return [
      { id: "play-a", enabled: true, press: () => playTournamentMove(window, 0) },
      { id: "play-b", enabled: true, press: () => playTournamentMove(window, 1) },
    ];
  }
  return [];
}

function resolveModalSelection(window: PaperclipsWindow): Selectable[] {
  const order = modalSelectables(window);
  window.modalSelectedIndex = Math.min(Math.max(window.modalSelectedIndex, 0), order.length - 1);
  return order;
}

function moveModalSelection(window: PaperclipsWindow, delta: number): void {
  const order = resolveModalSelection(window);
  if (order.length === 0) return;
  window.modalSelectedIndex = (window.modalSelectedIndex + delta + order.length) % order.length;
}

function pressModalSelected(window: PaperclipsWindow): void {
  const order = resolveModalSelection(window);
  const item = order[window.modalSelectedIndex];
  if (!item) return;
  if (!item.enabled) {
    playSfx(window, SFX_DENY);
    return;
  }
  item.press();
}

/**
 * Tournament opponent strategies. pick() sees the round's payoff matrix and
 * the player's previous move (null in round one) and returns the opponent's
 * move; the shown description is the player's read on it.
 */
const STRATEGIES = [
  {
    name: "RANDOM",
    desc: "flips a coin",
    pick: (): number => randInt(2),
  },
  {
    name: "GREEDY",
    desc: "chases its biggest payoff",
    pick: (matrix: number[][][]): number =>
      bestColumn(matrix, (column) => Math.max(column[0]![1]!, column[1]![1]!)),
  },
  {
    name: "GENEROUS",
    desc: "chases YOUR biggest payoff",
    pick: (matrix: number[][][]): number =>
      bestColumn(matrix, (column) => Math.max(column[0]![0]!, column[1]![0]!)),
  },
  {
    name: "MINIMAX",
    desc: "avoids its own worst case",
    pick: (matrix: number[][][]): number =>
      bestColumn(matrix, (column) => Math.min(column[0]![1]!, column[1]![1]!)),
  },
  {
    name: "TIT FOR TAT",
    desc: "copies your last move",
    pick: (matrix: number[][][], myLast: number | null): number =>
      myLast === null ? randInt(2) : myLast,
  },
  {
    name: "BEAT LAST",
    desc: "counters your last move",
    pick: (matrix: number[][][], myLast: number | null): number =>
      myLast === null ? randInt(2) : matrix[myLast]![0]![1]! >= matrix[myLast]![1]![1]! ? 0 : 1,
  },
] as const;

function randInt(bound: number): number {
  return Math.floor(Math.random() * bound);
}

/** The opponent move whose column [payoffs for my A, my B] scores highest. */
function bestColumn(matrix: number[][][], score: (column: number[][]) => number): number {
  const columnA = [matrix[0]![0]!, matrix[1]![0]!];
  const columnB = [matrix[0]![1]!, matrix[1]![1]!];
  return score(columnA) >= score(columnB) ? 0 : 1;
}

function newTournament(): TournamentState {
  const state: TournamentState = {
    round: 1,
    totalScore: 0,
    matrix: [],
    strategyIndex: 0,
    myLast: null,
    lastResult: null,
    finished: false,
  };
  rollTournamentRound(state);
  return state;
}

/** New payoff matrix and opponent strategy for the current round. */
function rollTournamentRound(state: TournamentState): void {
  state.matrix = [
    [randPayoffs(), randPayoffs()],
    [randPayoffs(), randPayoffs()],
  ];
  state.strategyIndex = randInt(STRATEGIES.length);
}

function randPayoffs(): number[] {
  return [1 + randInt(9), 1 + randInt(9)];
}

function playTournamentMove(window: PaperclipsWindow, myMove: number): void {
  const state = window.tournament;
  if (!state || state.finished) return;
  const strategy = STRATEGIES[state.strategyIndex]!;
  const theirMove = strategy.pick(state.matrix, state.myLast);
  const payoff = state.matrix[myMove]![theirMove]![0]!;
  state.totalScore += payoff;
  state.lastResult = `You ${MOVE_NAMES[myMove]}, ${strategy.name} ${MOVE_NAMES[theirMove]}: +${payoff}`;
  state.myLast = myMove;
  if (state.round >= TOURNAMENT_ROUNDS) {
    state.finished = true;
    window.modalSelectedIndex = 0;
  } else {
    state.round += 1;
    rollTournamentRound(state);
  }
}

/** One 200 ms economy step: production, sales, wire market, compute, unlocks. */
function step(window: PaperclipsWindow): void {
  const dtSec = TICK_MS / 1000;

  // Automated production, wire-limited.
  const rate = autoClipRate(window);
  if (rate > 0 && window.wire > 0) {
    window.productionCarry += rate * dtSec;
    const made = Math.min(Math.floor(window.productionCarry), window.wire);
    if (made > 0) {
      window.productionCarry -= made;
      window.wire -= made;
      window.clips += made;
      window.unsold += made;
    }
    if (window.wire === 0) {
      window.productionCarry = 0;
      if (!window.announcedWireDepleted) {
        window.announcedWireDepleted = true;
        window.message = "Wire supplies depleted";
      }
    }
  }

  // WireBuyer restock.
  if (
    window.wireBuyerOwned &&
    window.wireBuyerOn &&
    window.wire === 0 &&
    window.fundsCents >= window.wireCostCents
  ) {
    buyWireSpool(window);
  }

  // Sales roll (original: chance demand/100 per 100 ms tick).
  const demand = demandLevel(window);
  if (window.unsold > 0 && Math.random() < (demand / 100) * (TICK_MS / 100)) {
    const amount = Math.min(window.unsold, Math.max(1, Math.floor(0.7 * Math.pow(demand, 1.15))));
    window.unsold -= amount;
    window.fundsCents += amount * window.priceCents;
  }

  // Wire market: occasional sine-walk repricing around a creeping base.
  if (Math.random() < 0.015 * (TICK_MS / 100)) {
    window.wirePriceCounter += 1;
    window.wireCostCents = Math.max(
      100,
      Math.round(window.wireBaseCents + 600 * Math.sin(window.wirePriceCounter)),
    );
  }

  // Investment engine: periodic buy-in and repricing.
  if (window.investUnlocked) {
    window.investStepCounter += 1;
    if (window.investStepCounter >= INVEST_TICK_STEPS) {
      window.investStepCounter = 0;
      stepInvestments(window);
    }
  }

  // Compute: ops flow until memory-capped; capped ops overflow to creativity.
  if (window.computeUnlocked) {
    const cap = opsMax(window);
    window.ops = Math.min(
      cap,
      window.ops + window.processors * OPS_PER_PROCESSOR_PER_SEC * window.opsBonus * dtSec,
    );
    if (window.creativityUnlocked && window.ops >= cap) {
      window.creativity += window.processors * CREATIVITY_PER_PROCESSOR_PER_SEC * dtSec;
    }
    for (const project of PROJECTS) {
      if (
        !window.revealedProjects.has(project.id) &&
        !window.purchasedProjects.has(project.id) &&
        project.trigger(window)
      ) {
        window.revealedProjects.add(project.id);
      }
    }
  }

  if (!window.clippersUnlocked && window.fundsCents >= window.clipperCostCents) {
    window.clippersUnlocked = true;
    window.message = "AutoClippers available for purchase";
  }
  checkMilestones(window);
}

/**
 * Reprice the portfolio: the engine gradually converts deposited cash into
 * stocks, and the stock portion random-walks with drift set by the risk
 * level plus the engine-upgrade projects.
 */
function stepInvestments(window: PaperclipsWindow): void {
  if (window.investCashCents > 0) {
    const buy = Math.ceil(window.investCashCents * 0.25);
    window.investCashCents -= buy;
    window.investStocksCents += buy;
  }
  if (window.investStocksCents <= 0) return;
  const risk = RISK_LEVELS[window.investRisk]!;
  const drift = risk.drift + (window.investLevel - 1) * INVEST_LEVEL_DRIFT;
  // Triangular-ish noise in [-1, 1] so extreme swings are rarer than a flat roll.
  const noise = (Math.random() + Math.random() + Math.random()) / 1.5 - 1;
  const growth = drift + risk.vol * noise;
  window.investStocksCents = Math.max(0, Math.round(window.investStocksCents * (1 + growth)));
}

function checkMilestones(window: PaperclipsWindow): void {
  if (!window.announcedThousandClips && window.clips >= 1000) {
    window.announcedThousandClips = true;
    window.message = "Production milestone: 1,000 clips";
  }
  if (!window.computeUnlocked && window.clips >= COMPUTE_UNLOCK_CLIPS) {
    window.computeUnlocked = true;
    window.message = "Computational resources online";
  }
  if (!window.megaClippersUnlocked && window.clips >= MEGACLIPPER_UNLOCK_CLIPS) {
    window.megaClippersUnlocked = true;
    window.message = "MegaClippers available for purchase";
    playSfx(window, SFX_TRUST);
  }
  // Fibonacci trust milestones (3,000 / 5,000 / 8,000 / ... clips).
  while (window.clips >= window.nextTrustClips) {
    window.trust += 1;
    const nextFib = window.fibA + window.fibB;
    window.fibA = window.fibB;
    window.fibB = nextFib;
    window.nextTrustClips = nextFib * 1000;
    window.message = `Production target met: trust increased to ${window.trust}`;
    if (!window.segmentCompleteShown) {
      window.segmentCompleteShown = true;
      window.phase = "milestone";
      syncTick(window);
    }
    playSfx(window, SFX_TRUST);
  }
}

/** Keep the economy timer running exactly when playing, foreground, screen on. */
function syncTick(window: PaperclipsWindow): void {
  const shouldRun = window.phase === "playing" && window.foreground && screenOn;
  if (shouldRun && window.tickTimer === null) {
    window.tickTimer = setInterval(() => {
      for (let i = 0; i < window.speed; i++) step(window);
      renderAndSubmit(window, 0);
    }, TICK_MS);
  } else if (!shouldRun && window.tickTimer !== null) {
    clearInterval(window.tickTimer);
    window.tickTimer = null;
  }
}

function formatInt(value: number): string {
  return Math.floor(value).toLocaleString("en-US");
}

function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${formatInt(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}

/** Whole dollars, switching to $12.3M style when it gets long. */
function formatMoneyCompact(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const sign = cents < 0 ? "-" : "";
  if (dollars >= 1e6) {
    return `${sign}$${(dollars / 1e6).toFixed(dollars >= 1e7 ? 1 : 2)}M`;
  }
  return `${sign}$${formatInt(dollars)}`;
}

function paint(window: PaperclipsWindow): GrayImage {
  if (window.menu?.isOpen()) {
    return window.menu.paint();
  }
  return paintContent(window);
}

function paintContent(window: PaperclipsWindow): GrayImage {
  resolveSelection(window);
  const image = new GrayImage(window.viewportWidth, window.viewportHeight, 0);
  drawCentered(image, smallFont, 0, window.viewportWidth, 2, window.message, 170);
  if (window.speed !== 1) {
    image.drawText(smallFont, window.viewportWidth - 34, 2, `${window.speed}x`, 250);
  }
  paintLeftColumn(image, window);
  paintRightColumn(image, window);
  if (window.modal === "invest") {
    paintInvestModal(image, window);
  } else if (window.modal === "tournament") {
    paintTournamentModal(image, window);
  }
  if (window.phase === "milestone") {
    paintMilestoneOverlay(image, window);
  } else if (window.phase === "paused") {
    paintPausedOverlay(image, window);
  }
  return image;
}

/** Whether a main-page chip should paint as selected. */
function isSelected(window: PaperclipsWindow, id: string): boolean {
  return window.phase !== "milestone" && window.modal === null && window.selectedId === id;
}

/**
 * Draw a selectable chip. The selection is inverse video: a filled bright
 * rectangle with dark text (dimmer fill when the action is unaffordable).
 * fillWidth stretches the inverse bar (project rows highlight full-width).
 */
function drawChip(
  image: GrayImage,
  selected: boolean,
  x: number,
  y: number,
  text: string,
  enabled: boolean,
  fillWidth?: number,
): void {
  if (selected) {
    const width = fillWidth ?? smallFont.measureText(text) + 6;
    image.fillRect(x - 3, y - 1, width, smallFont.lineHeight + 2, enabled ? 235 : 120);
    image.drawText(smallFont, x, y, text, 0);
  } else {
    image.drawText(smallFont, x, y, text, enabled ? 230 : 100);
  }
}

/** A cost chip right-aligned to the left column's edge. */
function drawCostChip(
  image: GrayImage,
  window: PaperclipsWindow,
  id: string,
  y: number,
  text: string,
  enabled: boolean,
): void {
  drawChip(image, isSelected(window, id), LEFT_RIGHT_EDGE - smallFont.measureText(text), y, text, enabled);
}

/** Business and manufacturing: merged stat rows with inline action chips. */
function paintLeftColumn(image: GrayImage, window: PaperclipsWindow): void {
  image.drawText(mediumFont, LEFT_X, 20, `Clips: ${formatInt(window.clips)}`, 245);

  drawChip(image, isSelected(window, "make"), LEFT_X, 50, "[ Make Paperclip ]", window.wire > 0);
  const rate = autoClipRate(window);
  if (rate > 0) {
    image.drawText(smallFont, LEFT_X + 168, 50, `+${formatInt(rate)}/sec`, 150);
  }

  image.drawText(
    smallFont,
    LEFT_X,
    72,
    `Funds: ${formatMoney(window.fundsCents)}  Unsold: ${formatInt(window.unsold)}`,
    190,
  );

  image.drawText(smallFont, LEFT_X, 90, `Price: ${formatMoney(window.priceCents)}`, 190);
  drawChip(image, isSelected(window, "price-down"), LEFT_X + 108, 90, "-", window.priceCents > 1);
  drawChip(image, isSelected(window, "price-up"), LEFT_X + 128, 90, "+", true);
  image.drawText(smallFont, LEFT_X + 150, 90, `Demand: ${Math.round(demandLevel(window) * 10)}%`, 190);

  image.drawText(smallFont, LEFT_X, 108, `Marketing lvl ${window.marketingLevel}`, 190);
  drawCostChip(
    image,
    window,
    "marketing",
    108,
    formatMoney(window.marketingCostCents),
    window.fundsCents >= window.marketingCostCents,
  );

  image.drawText(
    smallFont,
    LEFT_X,
    126,
    `Wire: ${formatInt(window.wire)}"`,
    window.wire === 0 ? 250 : 190,
  );
  drawCostChip(
    image,
    window,
    "wire",
    126,
    formatMoney(window.wireCostCents),
    window.fundsCents >= window.wireCostCents,
  );

  if (window.clippersUnlocked) {
    image.drawText(smallFont, LEFT_X, 144, `AutoClippers: ${window.clipperCount}`, 190);
    drawCostChip(
      image,
      window,
      "clipper",
      144,
      formatMoney(window.clipperCostCents),
      window.fundsCents >= window.clipperCostCents,
    );
  }
  if (window.megaClippersUnlocked) {
    image.drawText(smallFont, LEFT_X, 162, `MegaClippers: ${window.megaClipperCount}`, 190);
    drawCostChip(
      image,
      window,
      "mega",
      162,
      formatMoney(window.megaClipperCostCents),
      window.fundsCents >= window.megaClipperCostCents,
    );
  }
  if (window.wireBuyerOwned) {
    drawChip(
      image,
      isSelected(window, "wirebuyer"),
      LEFT_X,
      180,
      `WireBuyer: ${window.wireBuyerOn ? "ON" : "OFF"}`,
      true,
    );
  }
  if (window.investUnlocked) {
    image.drawText(smallFont, LEFT_X, 198, `Inv: ${formatMoneyCompact(investTotalCents(window))}`, 190);
    drawChip(image, isSelected(window, "deposit"), LEFT_X + 136, 198, "Dep", window.fundsCents > 0);
    drawChip(image, isSelected(window, "withdraw"), LEFT_X + 172, 198, "Wdr", investTotalCents(window) > 0);
    drawChip(image, isSelected(window, "invest-details"), LEFT_X + 208, 198, "More", true);
  }

  image.drawText(
    smallFont,
    LEFT_X,
    238,
    gestureHints([
      [GESTURE_CLICK, "press"],
      [GESTURE_DOUBLE_CLICK, "x2"],
      [GESTURE_SCROLL, "move"],
      [GESTURE_LONG_PRESS, "pause"],
    ]),
    115,
  );
}

/** Computational resources and the projects list. */
function paintRightColumn(image: GrayImage, window: PaperclipsWindow): void {
  if (!window.computeUnlocked) return;

  image.drawText(
    smallFont,
    RIGHT_X,
    22,
    `Trust: ${window.trust}  next @ ${formatInt(window.nextTrustClips)}`,
    190,
  );
  const canAllocate = trustAvailable(window) > 0;
  image.drawText(smallFont, RIGHT_X, 40, `Proc: ${window.processors}`, 190);
  drawChip(image, isSelected(window, "proc"), RIGHT_X + 70, 40, "+", canAllocate);
  image.drawText(smallFont, RIGHT_X + 100, 40, `Mem: ${window.memory}`, 190);
  drawChip(image, isSelected(window, "mem"), RIGHT_X + 164, 40, "+", canAllocate);

  image.drawText(
    smallFont,
    RIGHT_X,
    58,
    `Ops: ${formatInt(window.ops)} / ${formatInt(opsMax(window))}`,
    190,
  );
  if (window.strategicModelingOwned) {
    drawChip(
      image,
      isSelected(window, "tournament"),
      RIGHT_X + 190,
      58,
      window.tournament ? "Trn*" : "Trn",
      window.tournament !== null || window.ops >= TOURNAMENT_COST_OPS,
    );
  }
  if (window.creativityUnlocked || window.strategicModelingOwned) {
    const parts: string[] = [];
    if (window.creativityUnlocked) parts.push(`Cr: ${formatInt(window.creativity)}`);
    if (window.strategicModelingOwned) parts.push(`Yomi: ${formatInt(window.yomi)}`);
    image.drawText(smallFont, RIGHT_X, 76, parts.join("   "), 190);
  }

  const projects = visibleProjects(window);
  if (projects.length === 0) return;
  image.drawText(smallFont, RIGHT_X, 96, "Projects", 140);
  image.drawLine(RIGHT_X + 70, 104, RIGHT_X + RIGHT_WIDTH - 8, 104, 80);

  window.projectScroll = Math.min(Math.max(0, projects.length - PROJECT_ROWS), window.projectScroll);
  const first = window.projectScroll;
  const visible = projects.slice(first, first + PROJECT_ROWS);
  let selectedProject: ProjectDef | null = null;
  for (let i = 0; i < visible.length; i++) {
    const project = visible[i]!;
    const id = `project:${project.id}`;
    if (window.selectedId === id) selectedProject = project;
    drawChip(
      image,
      isSelected(window, id),
      RIGHT_X,
      114 + i * 18,
      project.title,
      project.canAfford(window),
      RIGHT_WIDTH - 4,
    );
  }
  // Scroll markers when the list continues past the visible rows.
  if (first > 0) image.drawText(smallFont, RIGHT_X + RIGHT_WIDTH - 18, 114, "▲", 140);
  if (first + PROJECT_ROWS < projects.length) {
    image.drawText(smallFont, RIGHT_X + RIGHT_WIDTH - 18, 114 + (PROJECT_ROWS - 1) * 18, "▼", 140);
  }

  if (selectedProject && window.modal === null) {
    image.drawTextWrapped({
      font: smallFont,
      x: RIGHT_X,
      y: 208,
      width: RIGHT_WIDTH,
      text: selectedProject.description,
      value: 150,
    });
  }
}

/** Modal frame: dimless panel with border, returns its top-left corner. */
function drawModalFrame(
  image: GrayImage,
  window: PaperclipsWindow,
  width: number,
  height: number,
): { x: number; y: number } {
  const x = Math.round((window.viewportWidth - width) / 2);
  const y = Math.round((window.viewportHeight - height) / 2);
  image.fillRect(x, y, width, height, 0);
  image.drawRect(x, y, width, height, 220);
  return { x, y };
}

/** Whether the modal chip at this index paints as selected. */
function isModalSelected(window: PaperclipsWindow, index: number): boolean {
  return window.modalSelectedIndex === index;
}

/** The investment engine's details: portfolio split, profit, risk, level. */
function paintInvestModal(image: GrayImage, window: PaperclipsWindow): void {
  const { x, y } = drawModalFrame(image, window, 330, 168);
  drawCentered(image, mediumFont, x, 330, y + 10, "Investments", 250);

  const profit =
    investTotalCents(window) + window.investWithdrawnCents - window.investDepositedCents;
  image.drawText(smallFont, x + 16, y + 42, `Cash: ${formatMoney(window.investCashCents)}`, 190);
  image.drawText(smallFont, x + 16, y + 60, `Stocks: ${formatMoney(window.investStocksCents)}`, 190);
  image.drawText(smallFont, x + 16, y + 78, `Total: ${formatMoney(investTotalCents(window))}`, 230);
  image.drawText(
    smallFont,
    x + 16,
    y + 96,
    `Profit: ${formatMoney(profit)}   Engine lv ${window.investLevel}`,
    190,
  );

  drawChip(
    image,
    isModalSelected(window, 0),
    x + 16,
    y + 128,
    `Risk: ${RISK_LEVELS[window.investRisk]!.name}`,
    true,
  );
  drawChip(image, isModalSelected(window, 1), x + 330 - 16 - smallFont.measureText("Close"), y + 128, "Close", true);
}

/** The tournament minigame: read the matrix and the opponent, pick a move. */
function paintTournamentModal(image: GrayImage, window: PaperclipsWindow): void {
  const width = 380;
  const { x, y } = drawModalFrame(image, window, width, 196);
  const state = window.tournament;
  if (!state) {
    drawCentered(image, smallFont, x, width, y + 40, "No tournament in progress", 190);
    drawChip(image, isModalSelected(window, 0), x + width / 2 - 20, y + 80, "Close", true);
    return;
  }

  if (state.finished) {
    drawCentered(image, mediumFont, x, width, y + 14, "TOURNAMENT COMPLETE", 250);
    drawCentered(image, smallFont, x, width, y + 56, `Final score: ${state.totalScore}`, 190);
    drawCentered(
      image,
      smallFont,
      x,
      width,
      y + 78,
      `Yomi earned: ${formatInt(state.totalScore * YOMI_PER_POINT)}`,
      230,
    );
    if (state.lastResult) drawCentered(image, smallFont, x, width, y + 104, state.lastResult, 150);
    drawChip(image, isModalSelected(window, 0), x + width / 2 - 32, y + 148, "[ Collect ]", true);
    return;
  }

  const strategy = STRATEGIES[state.strategyIndex]!;
  drawCentered(
    image,
    smallFont,
    x,
    width,
    y + 10,
    `Tournament  round ${state.round}/${TOURNAMENT_ROUNDS}  score ${state.totalScore}`,
    250,
  );
  drawCentered(image, smallFont, x, width, y + 30, `vs ${strategy.name}: ${strategy.desc}`, 190);

  const cell = (my: number, their: number): string =>
    `${state.matrix[my]![their]![0]}/${state.matrix[my]![their]![1]}`.padEnd(6);
  const gridX = x + 60;
  image.drawText(smallFont, gridX, y + 56, "        they A  they B", 140);
  image.drawText(smallFont, gridX, y + 74, `you A   ${cell(0, 0)}  ${cell(0, 1)}`, 220);
  image.drawText(smallFont, gridX, y + 92, `you B   ${cell(1, 0)}  ${cell(1, 1)}`, 220);
  image.drawText(smallFont, gridX, y + 112, "payoffs: yours/theirs", 120);

  if (state.lastResult) {
    drawCentered(image, smallFont, x, width, y + 134, state.lastResult, 150);
  }
  drawChip(image, isModalSelected(window, 0), x + 90, y + 162, "[ Play A ]", true);
  drawChip(image, isModalSelected(window, 1), x + 210, y + 162, "[ Play B ]", true);
}

/** The original's first trust gain, marking the end of the ported segment. */
function paintMilestoneOverlay(image: GrayImage, window: PaperclipsWindow): void {
  const width = 420;
  const height = 116;
  const x = Math.round((window.viewportWidth - width) / 2);
  const y = Math.round((window.viewportHeight - height) / 2);
  image.fillRect(x, y, width, height, 0);
  image.drawRect(x, y, width, height, 220);
  drawCentered(image, mediumFont, x, width, y + 12, "TRUST INCREASED", 250);
  drawCentered(
    image,
    smallFont,
    x,
    width,
    y + 46,
    `Production target met: ${formatInt(SEGMENT_TARGET_CLIPS)} clips`,
    190,
  );
  drawCentered(image, smallFont, x, width, y + 66, "Spend trust on processors and memory", 150);
  drawCentered(image, smallFont, x, width, y + 90, `${GESTURE_CLICK} keep making paperclips`, 150);
}

function paintPausedOverlay(image: GrayImage, window: PaperclipsWindow): void {
  const width = 320;
  const height = 88;
  const x = Math.round((window.viewportWidth - width) / 2);
  const y = Math.round((window.viewportHeight - height) / 2);
  image.fillRect(x, y, width, height, 0);
  image.drawRect(x, y, width, height, 220);
  drawCentered(image, mediumFont, x, width, y + 12, "PAUSED", 250);
  drawCentered(
    image,
    smallFont,
    x,
    width,
    y + 52,
    gestureHints([
      [GESTURE_CLICK, "resume"],
      [GESTURE_DOUBLE_CLICK, "leave"],
      [GESTURE_LONG_PRESS, "menu"],
    ]),
    150,
  );
}

function drawCentered(
  image: GrayImage,
  font: typeof smallFont,
  x: number,
  width: number,
  y: number,
  text: string,
  value: number,
): void {
  image.drawText(font, Math.round(x + (width - font.measureText(text)) / 2), y, text, value);
}

function renderAndSubmit(window: PaperclipsWindow, inputFrameId: number): void {
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${window.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const image = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(window)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = image.fingerprint();
    if (fingerprint === window.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: paperclips content unchanged");
      return;
    }
    const communicator = com.faceclaw.app.FaceclawBleCommunicator.getActive();
    if (!communicator) {
      frameTimings.finishFrame(frameId, "discarded: no active communicator");
      return;
    }
    const buffer = image.to8bppBuffer();
    communicator.submitSurfaceFrame(
      buffer.buffer,
      window.surfaceId,
      0,
      0,
      image.width,
      image.height,
      fingerprint,
      paintMs,
      frameId,
    );
    window.lastSubmittedFingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, "discarded: paperclips render failed");
    console.error(`paperclips worker render failed: ${error}`);
  }
}
