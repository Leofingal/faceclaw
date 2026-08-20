package com.faceclaw.app;

import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Reader for the serialized LVGL font image in the G2's CJK flash partition.
 * Faceclaw bundles that font because it is Source Han Sans SC Light under the
 * SIL OFL. Proprietary fonts embedded in the main firmware never pass through
 * this class and are instead extracted on the user's phone during CFW install.
 */
public final class LvglFontFile {
    private static final String TAG = "LvglFontFile";
    private static final int MAPPED_BASE = 0x80100000;
    private static final int FONT_CACHE_SIZE = 2;

    private static final Map<String, FontData> fontCache =
            new LinkedHashMap<String, FontData>(FONT_CACHE_SIZE, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, FontData> eldest) {
                    return size() > FONT_CACHE_SIZE;
                }
            };

    private LvglFontFile() {}

    /**
     * Returns [lineHeight, baseline] or an empty array when the font is invalid.
     * The baseline is measured down from the top of the line.
     */
    public static byte[] getMetrics(String path) {
        FontData font = load(path);
        if (font == null) return new byte[0];
        return new byte[] { (byte) font.lineHeight, (byte) font.baseline };
    }

    /**
     * Returns one packed glyph:
     *   u16 boxW, u16 boxH, i16 ofsX, i16 ofsY, then aligned 4bpp bitmap bytes.
     * Returns an empty array when the code point is not mapped.
     */
    public static byte[] getGlyph(String path, int codePoint) {
        FontData font = load(path);
        if (font == null) return new byte[0];
        Integer glyphId = font.codePointToGlyph.get(codePoint);
        if (glyphId == null || glyphId <= 0) return new byte[0];
        try {
            int descriptor = font.glyphDescriptors + glyphId * 16;
            int bitmapIndex = font.u32(descriptor);
            int boxWidth = font.u16(descriptor + 8);
            int boxHeight = font.u16(descriptor + 10);
            int offsetX = font.i16(descriptor + 12);
            int offsetY = font.i16(descriptor + 14);
            int stride = boxWidth / 2 + 1;
            int bitmapLength = boxWidth > 0 && boxHeight > 0 ? stride * boxHeight : 0;
            font.check(font.glyphBitmaps + bitmapIndex, bitmapLength);

            byte[] result = new byte[8 + bitmapLength];
            putU16(result, 0, boxWidth);
            putU16(result, 2, boxHeight);
            putU16(result, 4, offsetX);
            putU16(result, 6, offsetY);
            System.arraycopy(font.bytes, font.glyphBitmaps + bitmapIndex, result, 8, bitmapLength);
            return result;
        } catch (RuntimeException e) {
            Log.w(TAG, "invalid glyph U+" + Integer.toHexString(codePoint) + " in " + path, e);
            return new byte[0];
        }
    }

    private static synchronized FontData load(String path) {
        if (path == null || path.isEmpty()) return null;
        FontData cached = fontCache.get(path);
        if (cached != null) return cached;
        try {
            FontData font = FontData.read(path);
            fontCache.put(path, font);
            return font;
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "could not load LVGL font " + path, e);
            return null;
        }
    }

    private static void putU16(byte[] destination, int offset, int value) {
        destination[offset] = (byte) (value & 0xff);
        destination[offset + 1] = (byte) ((value >>> 8) & 0xff);
    }

    private static final class FontData {
        final byte[] bytes;
        final ByteBuffer view;
        final int lineHeight;
        final int baseline;
        final int glyphBitmaps;
        final int glyphDescriptors;
        final Map<Integer, Integer> codePointToGlyph;

        private FontData(byte[] bytes) {
            this.bytes = bytes;
            this.view = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
            if (bytes.length < 0x40 || bytes[0] != 'Z' || bytes[1] != 'Z' || bytes[2] != 'Z' || bytes[3] != 'Z') {
                throw new IllegalArgumentException("missing ZZZZ font header");
            }

            lineHeight = u16(0x38);
            int baseLine = u16(0x3a);
            baseline = lineHeight - baseLine;

            int descriptor = pointerOffset(u32(0x34));
            glyphBitmaps = pointerOffset(u32(descriptor));
            glyphDescriptors = pointerOffset(u32(descriptor + 4));
            int cmaps = pointerOffset(u32(descriptor + 8));
            int packed = u16(descriptor + 18);
            int cmapCount = packed & 0x1ff;
            int bitsPerPixel = (packed >>> 9) & 0xf;
            int bitmapFormat = (packed >>> 14) & 0x3;
            if (lineHeight <= 0 || baseline < 0 || cmapCount <= 0 ||
                    bitsPerPixel != 4 || bitmapFormat != 3) {
                throw new IllegalArgumentException("unsupported LVGL font metadata");
            }

            codePointToGlyph = new HashMap<>();
            for (int index = 0; index < cmapCount; index++) {
                readCmap(cmaps + index * 20);
            }
        }

        static FontData read(String path) throws IOException {
            File file = new File(path);
            if (!file.isFile() || !file.canRead() || file.length() > Integer.MAX_VALUE) {
                throw new IOException("font is not a readable file");
            }
            byte[] bytes = new byte[(int) file.length()];
            try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
                input.readFully(bytes);
            }
            return new FontData(bytes);
        }

        void readCmap(int address) {
            int rangeStart = u32(address);
            int rangeLength = u16(address + 4);
            int glyphIdStart = u16(address + 6);
            int unicodeListPointer = u32(address + 8);
            int glyphIdOffsetsPointer = u32(address + 12);
            int listLength = u16(address + 16);
            int type = u8(address + 18);

            if (type == 2) {
                for (int relative = 0; relative < rangeLength; relative++) {
                    codePointToGlyph.put(rangeStart + relative, glyphIdStart + relative);
                }
                return;
            }

            if (type == 0) {
                int offsets = pointerOffset(glyphIdOffsetsPointer);
                for (int relative = 0; relative < rangeLength; relative++) {
                    int offset = u8(offsets + relative);
                    if (relative != 0 && offset == 0) continue;
                    codePointToGlyph.put(rangeStart + relative, glyphIdStart + offset);
                }
                return;
            }

            if (type == 3 || type == 1) {
                int unicodeList = pointerOffset(unicodeListPointer);
                int offsets = glyphIdOffsetsPointer == 0 ? -1 : pointerOffset(glyphIdOffsetsPointer);
                for (int index = 0; index < listLength; index++) {
                    int relative = u16(unicodeList + index * 2);
                    int offset = index;
                    if (offsets >= 0) {
                        offset = type == 1 ? u16(offsets + index * 2) : u8(offsets + index);
                        if (index != 0 && offset == 0) continue;
                    }
                    codePointToGlyph.put(rangeStart + relative, glyphIdStart + offset);
                }
                return;
            }

            throw new IllegalArgumentException("unknown cmap type " + type);
        }

        int u8(int offset) {
            check(offset, 1);
            return bytes[offset] & 0xff;
        }

        int u16(int offset) {
            check(offset, 2);
            return view.getShort(offset) & 0xffff;
        }

        int i16(int offset) {
            check(offset, 2);
            return view.getShort(offset);
        }

        int u32(int offset) {
            check(offset, 4);
            return view.getInt(offset);
        }

        int pointerOffset(int pointer) {
            long unsignedPointer = pointer & 0xffffffffL;
            long offset = unsignedPointer - (MAPPED_BASE & 0xffffffffL);
            if (offset < 0 || offset > Integer.MAX_VALUE) {
                throw new IllegalArgumentException("font pointer is outside the mapped partition");
            }
            check((int) offset, 1);
            return (int) offset;
        }

        void check(int offset, int length) {
            if (offset < 0 || length < 0 || (long) offset + length > bytes.length) {
                throw new IllegalArgumentException("font range is out of bounds");
            }
        }
    }
}
