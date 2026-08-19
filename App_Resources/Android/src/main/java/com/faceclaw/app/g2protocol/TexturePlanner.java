package com.faceclaw.app;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Plans a screen update that ships text and icons as on-glasses cached draws
 * instead of pixels (CFW modes 12/13/14; see g2flash/patches/zlib_glue.c and
 * texture_cache.c).
 *
 * Approach: dirty rects come from comparing the fully composited old and new
 * frames, exactly as the plain incremental path does. For each deferred draw
 * (glyph or image) whose pixels intersect a sent rect, check that every pixel
 * the on-glasses draw would write lands correct — i.e. the new composite's
 * 4bpp value at each in-panel nonzero-source pixel equals what the draw
 * produces (this one check subsumes plane occlusion, surface
 * occlusion/clipping, and draw-on-draw overlap). A draw that passes and is
 * (or can be made) resident in the texture cache is replayed on-glasses: its
 * written pixels are punched to 0 in the delta rect content — which is what
 * makes text and icons nearly free to compress — and re-emitted as a mode-14
 * string or mode-13 image sub-message in the same atomic mode-8 batch, so
 * the shadow after apply equals the full composite exactly. Everything else
 * stays baked.
 *
 * Fallback shape: when nothing qualifies, plan() returns null and the caller
 * uses the plain single-bbox/multi-rect/full-frame paths unchanged.
 */
public final class TexturePlanner {
    private TexturePlanner() {}

    /** Cap on mode-14 string sub-messages (mode-8 count is a u8). */
    private static final int MAX_GLYPH_RUNS = 180;
    /** Cap on mode-13 image sub-messages per update. */
    private static final int MAX_IMAGE_DRAWS = 60;
    /** Mode-12 payload size that fits one BLE image message comfortably. */
    private static final int UPLOAD_PAYLOAD_MAX = 3600;
    /** Max x-adjust control bytes between two glyphs before starting a new run. */
    private static final int MAX_ADJUST_BYTES = 4;
    /** Options: identity LUT (top 15) + transparent, for mode-13 image draws. */
    private static final int IMAGE_DRAW_OPTIONS = 0x1f;

    public static final class Result {
        /** Complete image payload: a mode-8 batch of rect deltas + cached draws. */
        public final byte[] payload;
        /** Mode-12 upload payloads to enqueue BEFORE the image message. */
        public final List<byte[]> uploads;
        /** Next mode-3 frame id (deltas consumed some). */
        public final int nextFid;
        public final int rectCount;
        public final int drawnGlyphs;
        public final int runCount;
        public final int drawnImages;
        public final int bakedCandidates;
        public final int uploadBytes;
        public final boolean fullFrame;

        Result(byte[] payload, List<byte[]> uploads, int nextFid, int rectCount,
               int drawnGlyphs, int runCount, int drawnImages, int bakedCandidates,
               int uploadBytes, boolean fullFrame) {
            this.payload = payload;
            this.uploads = uploads;
            this.nextFid = nextFid;
            this.rectCount = rectCount;
            this.drawnGlyphs = drawnGlyphs;
            this.runCount = runCount;
            this.drawnImages = drawnImages;
            this.bakedCandidates = bakedCandidates;
            this.uploadBytes = uploadBytes;
            this.fullFrame = fullFrame;
        }
    }

    /** One draw selected for on-glasses replay. */
    private static final class Selected {
        final SurfaceCompositor.ScreenDraw draw;
        final GlyphAtlas.Glyph glyphAtlas;   // glyph draws
        final ImageAtlas.Entry imageAtlas;   // image draws
        final int gx;      // screen x of the cached image (pen + bearing / blit left)
        final int top;     // glyph draws: 4bpp top color

        Selected(SurfaceCompositor.ScreenDraw draw, GlyphAtlas.Glyph glyphAtlas,
                 ImageAtlas.Entry imageAtlas, int gx, int top) {
            this.draw = draw;
            this.glyphAtlas = glyphAtlas;
            this.imageAtlas = imageAtlas;
            this.gx = gx;
            this.top = top;
        }
    }

    /**
     * Plan a cached-draw update. previous is the delta base (the frame the
     * shadow currently holds), or null/mismatched for a full-frame keyframe.
     * allowImages requires the teximg13 capability. Returns null when the
     * plain paths should run instead (no replayable draws, or identical
     * frames).
     */
    public static Result plan(
            byte[] previous, byte[] next, int width, int height,
            SurfaceCompositor.ScreenDraw[] draws,
            TextureCacheState cache, int fidStart,
            boolean allowMultiRect, int maxRects, boolean allowImages) {
        if (next == null || draws == null || draws.length == 0 || width <= 0 || height <= 0) {
            return null;
        }
        int stride = (width + 1) >> 1;
        if (next.length != stride * height) {
            return null;
        }

        // Rect geometry, matching what the plain paths would send.
        boolean fullFrame = previous == null || previous.length != next.length;
        List<int[]> rects;
        if (!fullFrame) {
            int[] box = BleImageOptimizer.computeChangedBox(previous, next, width, height);
            if (box == null) {
                return null; // identical frames; caller's dedup normally catches this
            }
            if (box[2] >= width && box[3] >= height) {
                fullFrame = true;
                rects = Collections.singletonList(new int[]{0, 0, width, height});
            } else {
                List<int[]> split = allowMultiRect
                        ? BleImageOptimizer.computeChangedRects(previous, next, width, height, maxRects)
                        : null;
                rects = split != null ? split : Collections.singletonList(box);
            }
        } else {
            rects = Collections.singletonList(new int[]{0, 0, width, height});
        }

        // Candidates: draws whose written pixels intersect a sent rect, are
        // representable on the wire, and land correct against the composite.
        List<Selected> selected = new ArrayList<>();
        int bakedCandidates = 0;
        int selectedImages = 0;
        for (SurfaceCompositor.ScreenDraw draw : draws) {
            if (draw.kind == SurfaceCompositor.ScreenDraw.KIND_GLYPH) {
                GlyphAtlas.Glyph atlas = GlyphAtlas.get(draw.fontId, draw.encoding);
                if (atlas == null) continue; // unregistered: stays baked, not a "candidate"
                int gx = draw.x + atlas.bbxX;
                int inkTop = draw.y + atlas.inkTop;
                if (!intersectsAny(rects, gx, inkTop, atlas.width, atlas.inkHeight)) {
                    continue;
                }
                if (draw.encoding < 32 || draw.encoding > 127
                        || gx < 0 || draw.y < 0 || gx > 0xffff || draw.y > 0xffff) {
                    bakedCandidates++;
                    continue;
                }
                int top = BmpUtil.nibbleForGray(draw.value);
                if (!glyphMatchesComposite(next, stride, width, height, atlas, gx, draw.y, top)) {
                    bakedCandidates++;
                    continue;
                }
                if (selected.size() >= MAX_GLYPH_RUNS * 10) { // soft cap before run grouping
                    bakedCandidates++;
                    continue;
                }
                selected.add(new Selected(draw, atlas, null, gx, top));
            } else {
                if (!allowImages) continue; // firmware lacks teximg13: stays baked
                ImageAtlas.Entry atlas = ImageAtlas.get(draw.imageId);
                if (atlas == null) continue;
                if (!intersectsAny(rects, draw.x, draw.y, atlas.width, atlas.height)) {
                    continue;
                }
                if (draw.x < 0 || draw.y < 0 || draw.x > 0xffff || draw.y > 0xffff
                        || selectedImages >= MAX_IMAGE_DRAWS) {
                    bakedCandidates++;
                    continue;
                }
                if (!imageMatchesComposite(next, stride, width, height, atlas, draw.x, draw.y)) {
                    bakedCandidates++;
                    continue;
                }
                selected.add(new Selected(draw, null, atlas, draw.x, 0));
                selectedImages++;
            }
        }
        if (selected.isEmpty()) {
            return null;
        }

        // Residency: ensure every selected draw is in the cache, retrying once
        // after a reset when the bump allocator fills. A draw that still fails
        // falls back to baked. IMPORTANT: from here on, every bail-out to the
        // plain path must cache.reset() — ensure* marked entries resident
        // and queued uploads that only a returned Result would enqueue.
        List<Selected> drawable = ensureResident(cache, selected);
        bakedCandidates += selected.size() - drawable.size();
        if (drawable.isEmpty()) {
            cache.reset();
            return null;
        }

        // Group glyphs into mode-14 runs; leftover-budget glyphs bake.
        List<Selected> glyphDrawable = new ArrayList<>();
        List<Selected> imageDrawable = new ArrayList<>();
        for (Selected sel : drawable) {
            if (sel.glyphAtlas != null) glyphDrawable.add(sel);
            else imageDrawable.add(sel);
        }
        List<byte[]> runs = new ArrayList<>();
        List<Selected> drawnGlyphs = buildRuns(cache, glyphDrawable, runs);
        bakedCandidates += glyphDrawable.size() - drawnGlyphs.size();
        List<Selected> drawn = new ArrayList<>(drawnGlyphs);
        drawn.addAll(imageDrawable);
        if (drawn.isEmpty() || rects.size() + runs.size() + imageDrawable.size() > 255) {
            cache.reset();
            return null;
        }

        // Punch the drawn pixels out of a copy of the composite, then encode
        // the rect deltas from the punched content.
        byte[] punched = next.clone();
        for (Selected sel : drawn) {
            punch(punched, stride, width, height, sel);
        }

        List<byte[]> subs = new ArrayList<>();
        int fid = fidStart;
        if (fullFrame) {
            subs.add(BleImageOptimizer.maybeCompress(punched, width, height));
        } else {
            for (int[] r : rects) {
                subs.add(BleImageOptimizer.encodeMode3Rect(punched, stride, r[0], r[1], r[2], r[3], fid));
                fid = (fid >= 0xfffe) ? 1 : fid + 1;
            }
        }
        for (Selected sel : imageDrawable) {
            subs.add(encodeImageDraw(cache, sel));
        }
        subs.addAll(runs);
        byte[] payload = assembleMode8(subs);

        int uploadBytes = cache.pendingUploadBytes();
        List<byte[]> uploads = cache.drainUploadPayloads(UPLOAD_PAYLOAD_MAX);
        return new Result(payload, uploads, fid, rects.size(), drawnGlyphs.size(), runs.size(),
                imageDrawable.size(), bakedCandidates, uploadBytes, fullFrame);
    }

    private static boolean intersectsAny(List<int[]> rects, int x, int y, int w, int h) {
        if (w <= 0 || h <= 0) return false;
        for (int[] r : rects) {
            if (x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1]) {
                return true;
            }
        }
        return false;
    }

    /**
     * Whether every in-panel ink pixel of the glyph equals `top` in the packed
     * new frame — i.e. the draw's writes all land correct. Ink outside the
     * panel is clipped by the firmware and irrelevant.
     */
    private static boolean glyphMatchesComposite(byte[] packed, int stride, int width, int height,
            GlyphAtlas.Glyph atlas, int gx, int lineY, int top) {
        for (int row = atlas.inkTop; row < atlas.inkTop + atlas.inkHeight; row++) {
            int y = lineY + row;
            if (y < 0 || y >= height) continue;
            for (int col = 0; col < atlas.width; col++) {
                if (!atlas.inkAt(col, row)) continue;
                int x = gx + col;
                if (x < 0 || x >= width) continue;
                if (nibbleAt(packed, stride, x, y) != top) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Whether every in-panel nonzero pixel of the cached image equals the
     * packed new frame — the mode-13 transparent draw writes exactly those.
     */
    private static boolean imageMatchesComposite(byte[] packed, int stride, int width, int height,
            ImageAtlas.Entry atlas, int left, int top) {
        for (int row = 0; row < atlas.height; row++) {
            int y = top + row;
            if (y < 0 || y >= height) continue;
            for (int col = 0; col < atlas.width; col++) {
                int source = atlas.nibbleAt(col, row);
                if (source == 0) continue;
                int x = left + col;
                if (x < 0 || x >= width) continue;
                if (nibbleAt(packed, stride, x, y) != source) {
                    return false;
                }
            }
        }
        return true;
    }

    private static int nibbleAt(byte[] packed, int stride, int x, int y) {
        int b = packed[y * stride + (x >> 1)] & 0xff;
        return (x & 1) != 0 ? (b & 0x0f) : (b >> 4);
    }

    private static void punch(byte[] packed, int stride, int width, int height, Selected sel) {
        if (sel.glyphAtlas != null) {
            GlyphAtlas.Glyph atlas = sel.glyphAtlas;
            for (int row = atlas.inkTop; row < atlas.inkTop + atlas.inkHeight; row++) {
                int y = sel.draw.y + row;
                if (y < 0 || y >= height) continue;
                for (int col = 0; col < atlas.width; col++) {
                    if (!atlas.inkAt(col, row)) continue;
                    punchPixel(packed, stride, width, sel.gx + col, y);
                }
            }
        } else {
            ImageAtlas.Entry atlas = sel.imageAtlas;
            for (int row = 0; row < atlas.height; row++) {
                int y = sel.draw.y + row;
                if (y < 0 || y >= height) continue;
                for (int col = 0; col < atlas.width; col++) {
                    if (atlas.nibbleAt(col, row) == 0) continue;
                    punchPixel(packed, stride, width, sel.gx + col, y);
                }
            }
        }
    }

    private static void punchPixel(byte[] packed, int stride, int width, int x, int y) {
        if (x < 0 || x >= width) return;
        int index = y * stride + (x >> 1);
        if ((x & 1) != 0) {
            packed[index] = (byte) (packed[index] & 0xf0);
        } else {
            packed[index] = (byte) (packed[index] & 0x0f);
        }
    }

    /**
     * Ensure residency for all of `selected`, resetting the cache once if the
     * allocator fills mid-plan (a reset invalidates offsets handed out earlier
     * in the same pass, so the whole pass reruns). Returns the draws that are
     * resident afterwards.
     */
    private static List<Selected> ensureResident(TextureCacheState cache, List<Selected> selected) {
        for (int attempt = 0; attempt < 2; attempt++) {
            List<Selected> resident = new ArrayList<>(selected.size());
            boolean full = false;
            for (Selected sel : selected) {
                int offset = sel.glyphAtlas != null
                        ? cache.ensureGlyph(sel.draw.fontId, sel.draw.encoding, sel.glyphAtlas)
                        : cache.ensureImage(sel.draw.imageId, sel.imageAtlas);
                if (offset >= 0) {
                    resident.add(sel);
                } else {
                    full = true;
                }
            }
            if (!full || attempt == 1) {
                return resident;
            }
            cache.reset();
        }
        return Collections.emptyList(); // unreachable
    }

    /** Mode-13 cached-image draw: [13][offset u16][x u16][y u16][options u8]. */
    private static byte[] encodeImageDraw(TextureCacheState cache, Selected sel) {
        int offset = cache.ensureImage(sel.draw.imageId, sel.imageAtlas); // resident: returns the offset
        byte[] sub = new byte[8];
        sub[0] = 13;
        sub[1] = (byte) (offset & 0xff);
        sub[2] = (byte) ((offset >> 8) & 0xff);
        sub[3] = (byte) (sel.draw.x & 0xff);
        sub[4] = (byte) ((sel.draw.x >> 8) & 0xff);
        sub[5] = (byte) (sel.draw.y & 0xff);
        sub[6] = (byte) ((sel.draw.y >> 8) & 0xff);
        sub[7] = (byte) IMAGE_DRAW_OPTIONS;
        return sub;
    }

    /**
     * Group selected glyphs into mode-14 string sub-messages:
     *   [14][fontTable u16][x u16][y u16][options u8][strlen u8][string]
     * One run per (font, line y, top color) span; within a run, control bytes
     * 1..31 adjust x by -10..+20 to hit each glyph's exact position, and each
     * glyph advances x by its cached width. Order across runs is free: every
     * drawn glyph's ink equals the composite, so overlaps write equal values.
     * Returns the glyphs actually emitted (run budget can drop stragglers).
     */
    private static List<Selected> buildRuns(TextureCacheState cache, List<Selected> drawable, List<byte[]> outRuns) {
        List<Selected> sorted = new ArrayList<>(drawable);
        sorted.sort(Comparator
                .comparingInt((Selected s) -> s.draw.fontId)
                .thenComparingInt(s -> s.draw.y)
                .thenComparingInt(s -> s.top)
                .thenComparingInt(s -> s.gx));

        List<Selected> drawn = new ArrayList<>(sorted.size());
        int i = 0;
        while (i < sorted.size() && outRuns.size() < MAX_GLYPH_RUNS) {
            Selected first = sorted.get(i);
            int fontTable = cache.fontTableOffset(first.draw.fontId);
            if (fontTable < 0) { // shouldn't happen: residency ensured above
                i++;
                continue;
            }
            java.io.ByteArrayOutputStream string = new java.io.ByteArrayOutputStream();
            List<Selected> runGlyphs = new ArrayList<>();
            int cursor = first.gx; // the run's wire x starts exactly at the first glyph
            int j = i;
            while (j < sorted.size()) {
                Selected sel = sorted.get(j);
                if (sel.draw.fontId != first.draw.fontId
                        || sel.draw.y != first.draw.y
                        || sel.top != first.top) {
                    break;
                }
                int delta = sel.gx - cursor;
                int adjustBytes = adjustByteCount(delta);
                if (adjustBytes > MAX_ADJUST_BYTES && j > i) {
                    break; // far gap: cheaper to start a fresh run
                }
                if (string.size() + adjustBytes + 1 > 255) {
                    break; // strlen is a u8
                }
                emitAdjust(string, delta);
                string.write(sel.draw.encoding);
                runGlyphs.add(sel);
                cursor = sel.gx + sel.glyphAtlas.width;
                j++;
            }
            if (!runGlyphs.isEmpty()) {
                byte[] stringBytes = string.toByteArray();
                byte[] run = new byte[9 + stringBytes.length];
                run[0] = 14;
                run[1] = (byte) (fontTable & 0xff);
                run[2] = (byte) ((fontTable >> 8) & 0xff);
                run[3] = (byte) (first.gx & 0xff);
                run[4] = (byte) ((first.gx >> 8) & 0xff);
                run[5] = (byte) (first.draw.y & 0xff);
                run[6] = (byte) ((first.draw.y >> 8) & 0xff);
                run[7] = (byte) (first.top | 0x10); // top color + transparent
                run[8] = (byte) stringBytes.length;
                System.arraycopy(stringBytes, 0, run, 9, stringBytes.length);
                outRuns.add(run);
                drawn.addAll(runGlyphs);
                i = j;
            } else {
                i++;
            }
        }
        return drawn;
    }

    /** How many 1..31 control bytes are needed to move the cursor by delta. */
    private static int adjustByteCount(int delta) {
        if (delta == 0) return 0;
        return delta > 0 ? (delta + 19) / 20 : (-delta + 9) / 10;
    }

    private static void emitAdjust(java.io.ByteArrayOutputStream out, int delta) {
        while (delta != 0) {
            int step = delta > 0 ? Math.min(delta, 20) : Math.max(delta, -10);
            out.write(step + 11); // byte 1..31 adjusts x by (byte - 11)
            delta -= step;
        }
    }

    /** [8][count]([len u16][sub])* — one atomic present for deltas + draws. */
    private static byte[] assembleMode8(List<byte[]> subs) {
        int total = 2;
        for (byte[] sub : subs) {
            total += 2 + sub.length;
        }
        byte[] out = new byte[total];
        out[0] = 8;
        out[1] = (byte) subs.size();
        int pos = 2;
        for (byte[] sub : subs) {
            out[pos] = (byte) (sub.length & 0xff);
            out[pos + 1] = (byte) ((sub.length >> 8) & 0xff);
            pos += 2;
            System.arraycopy(sub, 0, out, pos, sub.length);
            pos += sub.length;
        }
        return out;
    }
}
