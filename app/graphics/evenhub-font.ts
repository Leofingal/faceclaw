/**
 * Even's on-glasses 20px UI font, for the EvenHub compatibility layer.
 *
 * Two halves, from two sources:
 *  - Glyph BITMAPS + boxes: preprocessed from the firmware's extracted LVGL
 *    fonts (latin + greek/cyrillic + emoji, merged in the EvenHub fallback
 *    order) into fonts/evenhub/evenhub-20.json by scripts/build-evenhub-font.mjs.
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
import { knownFolders } from "@nativescript/core";
import { getTextWidth } from "@evenrealities/pretext";
import { GrayImage } from "./image";

const ASSET_PATH = "fonts/evenhub/evenhub-20.json";

/** [boxW, boxH, ofsX, ofsY, bitmapOffset, bitmapLen] */
type GlyphRecord = [number, number, number, number, number, number];

type FontAsset = {
  lineHeight: number;
  baseline: number;
  glyphs: Record<string, GlyphRecord>;
  bitmapBase64: string;
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

  private constructor(asset: FontAsset) {
    this.lineHeight = asset.lineHeight;
    this.baseline = asset.baseline;
    this.bitmap = base64Decode(asset.bitmapBase64);
    this.glyphs = new Map();
    for (const key of Object.keys(asset.glyphs)) {
      this.glyphs.set(Number(key), asset.glyphs[key]!);
    }
  }

  private static cached: EvenHubFont | null = null;

  static get(): EvenHubFont {
    if (!EvenHubFont.cached) {
      const text = knownFolders.currentApp().getFile(ASSET_PATH).readTextSync();
      EvenHubFont.cached = new EvenHubFont(JSON.parse(text) as FontAsset);
    }
    return EvenHubFont.cached;
  }

  hasGlyph(codePoint: number): boolean {
    return this.glyphs.has(codePoint);
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
      if (glyph) this.drawGlyph(image, glyph, penX, baselineY, value);
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

  private drawGlyph(image: GrayImage, glyph: GlyphRecord, penX: number, baselineY: number, value: number): void {
    const [boxW, boxH, ofsX, ofsY, off, len] = glyph;
    if (boxW <= 0 || boxH <= 0 || len <= 0) return;
    const stride = Math.floor(boxW / 2) + 1;
    const left = penX + ofsX;
    const top = baselineY - boxH - ofsY;
    for (let row = 0; row < boxH; row++) {
      const rowStart = off + row * stride;
      for (let col = 0; col < boxW; col++) {
        const byte = this.bitmap[rowStart + (col >> 1)] ?? 0;
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
