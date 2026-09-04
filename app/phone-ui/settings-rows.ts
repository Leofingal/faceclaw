/**
 * The settings catalogue (ui/settings-catalog), rendered as phone rows.
 *
 * Chris, 2026-09-03, on consolidating Settings under the phone's gear:
 * "they should be all editable on the phone side without any glasses
 * interaction". EDITABLE is the load-bearing word — the earlier round mirrored
 * some labels onto the phone while the real write path still ran through the
 * glasses' own menu, and that is precisely the miss this file exists to avoid.
 * So every row here writes the setting itself, with a control that fits its
 * type: an enum cycles on tap, a boolean is a Switch, a string is a TextField
 * you type into on this screen.
 *
 * ROWS ARE OBSERVABLES, one per row, and the list identity is stable. That is
 * not decoration: a TextField inside a Repeater loses focus the instant its
 * containing view is rebuilt, so a page that rebuilt its row list whenever a
 * setting changed would be unable to type into its own API-key fields — every
 * keystroke writes a setting, which fires the change listener, which would
 * rebuild the list under the caret. Notifying one row instead touches nothing
 * else on the page.
 */
import { Observable } from "@nativescript/core";

import {
  ConfigSettingBoolean,
  ConfigSettingEnum,
  ConfigSettingString,
} from "../ui/dashboard-settings";
import {
  SETTINGS_CATEGORIES,
  type CatalogEntry,
  type CatalogSpecialId,
} from "../ui/settings-catalog";
import {
  ASR_MODELS,
  asrModelState,
  cancelAsrModelDownload,
  deleteAsrModel,
  onAsrModelStateChanged,
  startAsrModelDownload,
  type AsrModelId,
} from "../native/asr-model";
import {
  cancelLocalModelDownload,
  deleteLocalModel,
  LOCAL_MODEL,
  localModelState,
  onLocalModelStateChanged,
  startLocalModelDownload,
} from "../native/llama";
import { getInstalledFont, listInstalledFonts } from "../graphics/installed-fonts";
import {
  fontSelectionLabel,
  getTerminalFontSelection,
  getUiFontSelection,
  setTerminalFontSelection,
  setUiFontSelection,
  uiFontSizeAllowed,
  type UiFontSelection,
} from "../graphics/ui-fonts";

export type SettingsRowKind = "header" | "enum" | "toggle" | "text" | "action";

type RowSpec = {
  kind: SettingsRowKind;
  title: string;
  description?: string;
  /** enum / action: the value shown at the right-hand end of the row. */
  value?: () => string;
  /** enum / action: what tapping the row does. */
  activate?: () => void;
  getBool?: () => boolean;
  setBool?: (on: boolean) => void;
  getText?: () => string;
  setText?: (value: string) => void;
  secure?: boolean;
  hint?: string;
  /**
   * For rows whose value changes on its own — a download's percentage. Called
   * on attach, and the returned function on detach, so a page that has been
   * navigated away from is not still holding a listener.
   */
  watch?: (onChange: () => void) => () => void;
};

type Visibility = "visible" | "collapse";

function show(condition: boolean): Visibility {
  return condition ? "visible" : "collapse";
}

export class PhoneSettingsRow extends Observable {
  constructor(private readonly spec: RowSpec) {
    super();
  }

  get title(): string {
    return this.spec.title;
  }

  get description(): string {
    return this.spec.description ?? "";
  }

  get headerVisibility(): Visibility {
    return show(this.spec.kind === "header");
  }

  get rowVisibility(): Visibility {
    return show(this.spec.kind !== "header");
  }

  get descriptionVisibility(): Visibility {
    return show(this.spec.kind !== "header" && !!this.spec.description);
  }

  get valueVisibility(): Visibility {
    return show(this.spec.kind === "enum" || this.spec.kind === "action");
  }

  get toggleVisibility(): Visibility {
    return show(this.spec.kind === "toggle");
  }

  get textVisibility(): Visibility {
    return show(this.spec.kind === "text");
  }

  get valueLabel(): string {
    return this.spec.value?.() ?? "";
  }

  get toggleValue(): boolean {
    return this.spec.getBool?.() ?? false;
  }

  get textValue(): string {
    return this.spec.getText?.() ?? "";
  }

  get textSecure(): boolean {
    return !!this.spec.secure;
  }

  get textHint(): string {
    return this.spec.hint ?? "";
  }

  /**
   * Bound as arrow properties, not methods: a `tap="{{ onRowTap }}"` binding
   * hands NativeScript the function value, which is called without its
   * receiver — a plain method would arrive with `this` undefined.
   */
  readonly onRowTap = (): void => {
    if (!this.spec.activate) return;
    this.spec.activate();
    this.refresh();
  };

  readonly onToggleChange = (args: { value?: boolean; object?: { checked?: boolean } }): void => {
    if (!this.spec.setBool || !this.spec.getBool) return;
    const on = typeof args?.value === "boolean" ? args.value : Boolean(args?.object?.checked);
    // The Switch fires on programmatic assignment too, so writing only on a
    // real change stops a refresh from looping back through here.
    if (on === this.spec.getBool()) return;
    this.spec.setBool(on);
  };

  readonly onTextChange = (args: { value?: string; object?: { text?: string } }): void => {
    if (!this.spec.setText) return;
    const next = typeof args?.value === "string" ? args.value : String(args?.object?.text ?? "");
    if (next === this.spec.getText?.()) return;
    this.spec.setText(next);
  };

  /**
   * Re-read what this row displays. Deliberately NOT `textValue`: pushing a
   * value back into a TextField mid-edit moves the caret, and the only writer
   * of a text setting while this page is up is the field itself.
   */
  refresh(): void {
    this.notifyPropertyChange("valueLabel", this.valueLabel);
    this.notifyPropertyChange("toggleValue", this.toggleValue);
  }

  private unwatch: (() => void) | null = null;

  /** Idempotent: the page reuses its view model across back-navigations. */
  attach(): void {
    if (this.unwatch || !this.spec.watch) return;
    this.unwatch = this.spec.watch(() => this.refresh());
  }

  detach(): void {
    this.unwatch?.();
    this.unwatch = null;
  }
}

/**
 * Every catalogue category, flattened into header + control rows. One flat list
 * because a NativeScript Repeater has one item template; the header rows carry
 * their own visibility, which is the same collapse-the-unused-half pattern the
 * Ghost companion's transcript rows already use.
 */
export function buildSettingsRows(): PhoneSettingsRow[] {
  const rows: PhoneSettingsRow[] = [];
  for (const category of SETTINGS_CATEGORIES) {
    rows.push(new PhoneSettingsRow({ kind: "header", title: category.label, description: category.blurb }));
    for (const entry of category.entries) rows.push(...entryRows(entry));
  }
  return rows;
}

function entryRows(entry: CatalogEntry): PhoneSettingsRow[] {
  if (entry.kind === "special") return specialRows(entry.id);
  const { setting, onChange } = entry;
  const after = (): void => onChange?.();

  if (setting instanceof ConfigSettingBoolean) {
    return [
      new PhoneSettingsRow({
        kind: "toggle",
        title: setting.label,
        description: setting.description,
        getBool: () => setting.get(),
        setBool: (on) => {
          setting.set(on);
          after();
        },
      }),
    ];
  }
  if (setting instanceof ConfigSettingEnum) {
    return [
      new PhoneSettingsRow({
        kind: "enum",
        title: setting.label,
        description: setting.description,
        value: () => setting.displayValue(),
        // Cycles rather than opening a picker — the same control the phone's
        // existing Glasses/Display rows already use, and next() already skips
        // options the setting reports as unavailable.
        activate: () => {
          setting.set(setting.next());
          after();
        },
      }),
    ];
  }
  if (setting instanceof ConfigSettingString) {
    return [
      new PhoneSettingsRow({
        kind: "text",
        title: setting.label,
        description: setting.description,
        getText: () => setting.get(),
        setText: (value) => {
          setting.set(value);
          after();
        },
        // The glasses menu masks secrets behind the setting's own formatValue;
        // on the phone the field itself is the mask, and it has to be typable.
        secure: setting.inputKind === "password",
        hint: setting.editorTitle,
      }),
    ];
  }
  return [];
}

function specialRows(id: CatalogSpecialId): PhoneSettingsRow[] {
  switch (id) {
    case "ui-font":
      return fontRows({
        title: "UI font",
        description: "Typeface for UI text on the glasses. Install more faces from the Files app.",
        monospaceOnly: false,
        sizeAllowed: uiFontSizeAllowed,
        bitmapFaces: ["terminus", "terminusv"],
        get: getUiFontSelection,
        set: setUiFontSelection,
      });
    case "terminal-font":
      return fontRows({
        title: "Terminal font",
        description: "Typeface for terminal windows, fixed-width faces only.",
        monospaceOnly: true,
        bitmapFaces: ["terminus"],
        get: getTerminalFontSelection,
        set: setTerminalFontSelection,
      });
    case "asr-moonshine":
      return [asrModelRow("moonshine")];
    case "asr-whisper":
      return [asrModelRow("whisper-base-en")];
    case "local-model":
      return [localModelRow()];
  }
}

// ── downloadable models ────────────────────────────────────────────────────
// The glasses render these as a row that opens a one-item modal menu. On a
// phone the row IS the button: tap to download, tap again to cancel, and once
// it is present tapping deletes it — with the current state spelled out in the
// value column, so the tap is never ambiguous about what it will do.

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1e6)}MB`;
}

function downloadStatus(state: { status: string; bytesDownloaded: number; totalBytes: number }, total: string): string {
  if (state.status === "ready") return "downloaded · tap to delete";
  if (state.status === "downloading") {
    const pct = state.totalBytes > 0 ? Math.floor((state.bytesDownloaded / state.totalBytes) * 100) : 0;
    return `${pct}% · tap to cancel`;
  }
  return `tap to download (${total})`;
}

function asrModelRow(id: AsrModelId): PhoneSettingsRow {
  const def = ASR_MODELS[id];
  const total = megabytes(def.totalBytes);
  const row = new PhoneSettingsRow({
    kind: "action",
    title: `On-device model: ${def.label}`,
    description:
      "Transcribes voice input on the phone itself, with no API key and no cloud service. " +
      "Required for its matching Transcription provider option. An interrupted download resumes.",
    value: () => downloadStatus(asrModelState(id), total),
    activate: () => {
      const state = asrModelState(id);
      if (state.status === "downloading") cancelAsrModelDownload(id);
      else if (state.status === "ready") deleteAsrModel(id);
      else startAsrModelDownload(id);
    },
    // A download runs for minutes; without this the percentage would only move
    // when something else happened to redraw the row.
    watch: (onChange) => onAsrModelStateChanged(id, onChange),
  });
  return row;
}

function localModelRow(): PhoneSettingsRow {
  const total = `${(LOCAL_MODEL.sizeBytes / 1e9).toFixed(1)}GB`;
  const row = new PhoneSettingsRow({
    kind: "action",
    title: `On-phone model: ${LOCAL_MODEL.label}`,
    description:
      "Runs the assistant entirely on the phone, with no API key and no cloud service. " +
      "Only used when the Assistant backend above is set to the on-phone model.",
    value: () => downloadStatus(localModelState(), total),
    activate: () => {
      const state = localModelState();
      if (state.status === "downloading") cancelLocalModelDownload();
      else if (state.status === "ready") deleteLocalModel();
      else startLocalModelDownload();
    },
    watch: (onChange) => onLocalModelStateChanged(onChange),
  });
  return row;
}

// ── fonts ──────────────────────────────────────────────────────────────────
// The glasses have a modal picker with a live preview line; a phone cannot
// preview a bitmap lens font meaningfully, so this is two cycling rows — face
// and size — over the same stored selection. Deliberately simpler than the
// glasses picker rather than a port of it: what it has to be is REACHABLE
// without the glasses, which is the requirement the consolidation carries.

/** Sizes the glasses picker offers; the UI font also has to satisfy its own
 * line-height bound, which is what `sizeAllowed` checks. */
const FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28];
const DEFAULT_TTF_SIZE = 16;

type FontRowOptions = {
  title: string;
  description: string;
  monospaceOnly: boolean;
  sizeAllowed?: (path: string, size: number) => boolean;
  bitmapFaces: ("terminus" | "terminusv")[];
  get: () => UiFontSelection;
  set: (selection: UiFontSelection) => void;
};

function fontRows(options: FontRowOptions): PhoneSettingsRow[] {
  const choices = (): UiFontSelection[] => {
    const list: UiFontSelection[] = options.bitmapFaces.map((face) => ({ kind: "bitmap", face }));
    for (const font of listInstalledFonts()) {
      if (options.monospaceOnly && !font.monospace) continue;
      list.push({ kind: "ttf", file: font.fileName, size: DEFAULT_TTF_SIZE });
    }
    return list;
  };
  const currentIndex = (list: UiFontSelection[], current: UiFontSelection): number =>
    list.findIndex((choice) =>
      choice.kind === "bitmap"
        ? current.kind === "bitmap" && choice.face === current.face
        : current.kind === "ttf" && choice.file === current.file,
    );

  const face = new PhoneSettingsRow({
    kind: "enum",
    title: options.title,
    description: options.description,
    value: () => fontSelectionLabel(options.get()),
    activate: () => {
      const list = choices();
      if (!list.length) return;
      const current = options.get();
      const next = list[(currentIndex(list, current) + 1) % list.length]!;
      // Keep the size across a face change where both are scalable, so
      // cycling faces does not silently resize the whole interface.
      if (next.kind === "ttf" && current.kind === "ttf") {
        options.set(clampFontSize(next.file, current.size, options.sizeAllowed));
        return;
      }
      options.set(next.kind === "ttf" ? clampFontSize(next.file, DEFAULT_TTF_SIZE, options.sizeAllowed) : next);
    },
  });

  const size = new PhoneSettingsRow({
    kind: "enum",
    title: `${options.title} size`,
    description: "Bitmap faces have one fixed size; this applies to installed TTF faces.",
    value: () => {
      const current = options.get();
      return current.kind === "ttf" ? String(current.size) : "fixed";
    },
    activate: () => {
      const current = options.get();
      if (current.kind !== "ttf") return;
      const allowed = FONT_SIZES.filter((candidate) => sizeOk(current.file, candidate, options.sizeAllowed));
      if (!allowed.length) return;
      const index = allowed.indexOf(current.size);
      const next = allowed[(index + 1) % allowed.length]!;
      options.set({ kind: "ttf", file: current.file, size: next });
    },
  });

  return [face, size];
}

/**
 * `uiFontSizeAllowed` wants the font's ABSOLUTE PATH, not the stored file
 * name — a selection stores the name, so it has to be resolved back through
 * the installed-fonts index before the bound can be checked at all.
 */
function sizeOk(file: string, size: number, allowed?: (path: string, size: number) => boolean): boolean {
  if (!allowed) return true;
  try {
    const path = getInstalledFont(file)?.path;
    return path ? allowed(path, size) : false;
  } catch {
    // A face that will not load is not a reason to leave the row inert; the
    // stored selection falls back to the bitmap face at resolution time.
    return false;
  }
}

function clampFontSize(
  file: string,
  wanted: number,
  allowed?: (path: string, size: number) => boolean,
): UiFontSelection {
  if (sizeOk(file, wanted, allowed)) return { kind: "ttf", file, size: wanted };
  const nearest = FONT_SIZES.filter((candidate) => sizeOk(file, candidate, allowed))[0];
  return { kind: "ttf", file, size: nearest ?? wanted };
}
