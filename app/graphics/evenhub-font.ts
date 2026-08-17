/**
 * Even's on-glasses 20px UI font, for the EvenHub compatibility layer.
 *
 * Three pieces:
 *  - Latin + Greek/Cyrillic + emoji glyphs are extracted from the stock G2
 *    firmware into app-private storage while Faceclaw prepares custom firmware.
 *    They are not distributed with Faceclaw.
 *  - The final fallback is the G2's serialized Source Han Sans SC Light font,
 *    which Faceclaw can bundle under the SIL Open Font License.
 *  - Text SIZING / KERNING / WRAPPING: @evenrealities/pretext, whose advance
 *    tables the bitmaps were validated against. Using pretext for measurement
 *    means our line breaks match exactly where EvenHub apps (which measure
 *    with the same library) expect them.
 *
 * Bitmaps are 4bpp, high-nibble-first, row stride floor(boxW/2)+1. The UI
 * fonts are effectively 1-bit (nibbles 0 or 0xF); we keep the nibble value so
 * any anti-aliasing survives. Codepoints with no glyph are skipped silently,
 * matching stock firmware (no tofu boxes).
 */
import { File, knownFolders } from "@nativescript/core";
import { getTextWidth } from "@evenrealities/pretext";
import { EVENHUB_RUNTIME_FONT_FILENAME, isEvenHubFontAsset } from "../g2/firmware-fonts";
import { toUint8Array } from "../util/array-util";
import { GrayImage } from "./image";

declare const com: any;

const CJK_ASSET_PATH = "fonts/source-han-sans/SourceHanSansSC-Light-20.lvgl.bin";

/** [boxW, boxH, ofsX, ofsY, bitmapOffset, bitmapLen] */
type GlyphRecord = [number, number, number, number, number, number];

type FontAsset = {
  lineHeight: number;
  baseline: number;
  glyphs: Record<string, GlyphRecord>;
  bitmapBase64: string;
};

type CjkGlyph = {
  record: GlyphRecord;
  bitmap: Uint8Array;
};

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let bitCount = 0;
  let outIndex = 0;
  for (let i = 0; i < clean.length; i++) {
    bits = (bits << 6) | BASE64_ALPHABET.indexOf(clean[i]!);
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIndex++] = (bits >> bitCount) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

export class EvenHubFont {
  readonly lineHeight: number;
  readonly baseline: number;
  private readonly glyphs: Map<number, GlyphRecord>;
  private readonly bitmap: Uint8Array;
  private readonly cjkPath: string;
  private readonly cjkBaseline: number;
  private readonly cjkGlyphs = new Map<number, CjkGlyph | null>();

  private constructor(asset: FontAsset) {
    this.lineHeight = asset.lineHeight;
    this.baseline = asset.baseline;
    this.bitmap = base64Decode(asset.bitmapBase64);
    this.glyphs = new Map();
    for (const key of Object.keys(asset.glyphs)) {
      this.glyphs.set(Number(key), asset.glyphs[key]!);
    }
    this.cjkPath = knownFolders.currentApp().getFile(CJK_ASSET_PATH).path;
    const metrics = toUint8Array(com.faceclaw.app.LvglFontFile.getMetrics(this.cjkPath));
    if (metrics.length < 2) {
      throw new Error("The bundled Source Han Sans font could not be loaded.");
    }
    this.cjkBaseline = metrics[1]!;
  }

  private static cached: EvenHubFont | null = null;

  static get(): EvenHubFont {
    if (!EvenHubFont.cached) {
      const path = `${knownFolders.documents().path}/${EVENHUB_RUNTIME_FONT_FILENAME}`;
      let asset: FontAsset | null = null;
      if (File.exists(path)) {
        try {
          const parsed: unknown = JSON.parse(File.fromPath(path).readTextSync());
          if (!isEvenHubFontAsset(parsed)) throw new Error("invalid font asset structure");
          asset = parsed;
        } catch (error) {
          console.warn(`Could not load the extracted G2 fonts; using Source Han Sans only: ${error}`);
        }
      } else {
        console.warn(
          "The G2 fonts have not been extracted yet; using Source Han Sans only. " +
            "Reinstall Faceclaw's custom firmware to prepare the exact fallback chain.",
        );
      }
      EvenHubFont.cached = new EvenHubFont(
        asset ?? { lineHeight: 27, baseline: 22, glyphs: {}, bitmapBase64: "" },
      );
    }
    return EvenHubFont.cached;
  }

  hasGlyph(codePoint: number): boolean {
    return this.glyphs.has(codePoint) || this.getCjkGlyph(codePoint) !== null;
  }

  /**
   * Pixel advance of a codepoint, including kerning against the following one
   * (pass 0/undefined for the last glyph). Derived from pretext's public
   * getTextWidth so it carries pretext's kerning and missing-glyph placeholder
   * exactly: width(a+b) - width(b) isolates a's kerned advance.
   */
  advanceOf(codePoint: number, nextCodePoint = 0): number {
    const a = String.fromCodePoint(codePoint);
    if (!nextCodePoint) return getTextWidth(a);
    const b = String.fromCodePoint(nextCodePoint);
    return getTextWidth(a + b) - getTextWidth(b);
  }

  /** Single-line pixel width including kerning (pretext-exact). */
  measureLine(text: string): number {
    return getTextWidth(text);
  }

  /**
   * Wrap text to a pixel width, returning the actual line strings. Ports
   * pretext's measureTextWrap (LVGL lv_text_get_next_line semantics) so the
   * breaks land exactly where the measurement library reports them.
   */
  wrap(text: string, maxWidth: number): string[] {
    if (!text) return [""];
    const cps = Array.from(text).map((c) => c.codePointAt(0)!);
    const lines: string[] = [];
    let line: number[] = [];
    let lineWidth = 0;
    let lastBreak = -1; // index within `line` after which we may wrap

    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i]!;
      if (cp === 10) {
        lines.push(String.fromCodePoint(...line));
        line = [];
        lineWidth = 0;
        lastBreak = -1;
        continue;
      }
      // LVGL drops leading spaces at the start of a wrapped line.
      if (line.length === 0 && cp === 32) continue;
      const adv = this.advanceOf(cp, cps[i + 1] ?? 0);
      if (lineWidth + adv > maxWidth) {
        if (cp === 32) {
          // The overflowing char is a space: break here, discard it.
          lines.push(String.fromCodePoint(...line));
          line = [];
          lineWidth = 0;
          lastBreak = -1;
        } else if (lastBreak !== -1) {
          // Wrap at the last break opportunity; carry the remainder forward.
          const carry = line.slice(lastBreak + 1);
          line = line.slice(0, lastBreak + 1);
          const trimmed = line[line.length - 1] === 32 ? line.slice(0, -1) : line;
          lines.push(String.fromCodePoint(...trimmed));
          line = carry;
          lineWidth = carry.reduce((sum, c, j) => sum + this.advanceOf(c, carry[j + 1] ?? 0), 0);
          lastBreak = -1;
          line.push(cp);
          lineWidth += adv;
        } else {
          // No break opportunity: hard break before the overflowing char.
          lines.push(String.fromCodePoint(...line));
          line = [cp];
          lineWidth = adv;
          lastBreak = -1;
        }
      } else {
        line.push(cp);
        lineWidth += adv;
        if (isBreakable(cp)) lastBreak = line.length - 1;
      }
    }
    lines.push(String.fromCodePoint(...line));
    return lines;
  }

  /** Draw one line of text with its top-left at (x, y). Missing glyphs are skipped. */
  drawText(image: GrayImage, x: number, y: number, text: string, value = 255): void {
    const cps = Array.from(text).map((c) => c.codePointAt(0)!);
    const baselineY = y + this.baseline;
    let penX = x;
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i]!;
      const glyph = this.glyphs.get(cp);
      if (glyph) {
        this.drawGlyph(image, glyph, this.bitmap, penX, baselineY, value);
      } else {
        const cjk = this.getCjkGlyph(cp);
        if (cjk) this.drawGlyph(image, cjk.record, cjk.bitmap, penX, y + this.cjkBaseline, value);
      }
      penX += this.advanceOf(cp, cps[i + 1] ?? 0);
    }
  }

  /** Draw wrapped text within a box; returns the number of lines drawn. */
  drawTextWrapped(image: GrayImage, x: number, y: number, maxWidth: number, text: string, value = 255): number {
    const lines = this.wrap(text, maxWidth);
    for (let i = 0; i < lines.length; i++) {
      this.drawText(image, x, y + i * this.lineHeight, lines[i]!, value);
    }
    return lines.length;
  }

  private getCjkGlyph(codePoint: number): CjkGlyph | null {
    const cached = this.cjkGlyphs.get(codePoint);
    if (cached !== undefined) return cached;
    const bytes = toUint8Array(com.faceclaw.app.LvglFontFile.getGlyph(this.cjkPath, codePoint));
    if (bytes.length < 8) {
      this.cjkGlyphs.set(codePoint, null);
      return null;
    }
    const u16 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
    const i16 = (offset: number) => {
      const value = u16(offset);
      return value & 0x8000 ? value - 0x10000 : value;
    };
    const bitmap = bytes.subarray(8);
    const glyph: CjkGlyph = {
      record: [u16(0), u16(2), i16(4), i16(6), 0, bitmap.length],
      bitmap,
    };
    this.cjkGlyphs.set(codePoint, glyph);
    return glyph;
  }

  private drawGlyph(
    image: GrayImage,
    glyph: GlyphRecord,
    bitmap: Uint8Array,
    penX: number,
    baselineY: number,
    value: number,
  ): void {
    const [boxW, boxH, ofsX, ofsY, off, len] = glyph;
    if (boxW <= 0 || boxH <= 0 || len <= 0) return;
    const stride = Math.floor(boxW / 2) + 1;
    const left = penX + ofsX;
    const top = baselineY - boxH - ofsY;
    for (let row = 0; row < boxH; row++) {
      const rowStart = off + row * stride;
      for (let col = 0; col < boxW; col++) {
        const byte = bitmap[rowStart + (col >> 1)] ?? 0;
        const nibble = col % 2 === 0 ? byte >> 4 : byte & 0x0f;
        if (nibble === 0) continue;
        image.setPixel(left + col, top + row, Math.round((nibble / 15) * value));
      }
    }
  }
}

function isBreakable(cp: number): boolean {
  if (cp === 32 || cp === 45) return true; // space, hyphen
  // CJK ranges (pretext parity) — breakable between any two ideographs.
  return (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xac00 && cp <= 0xd7af);
}
