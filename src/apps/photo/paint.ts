/**
 * Photo Editor — pure painting helpers: flood fill (paint bucket and magic wand), masked
 * fill/clear/mix (everything that must respect a selection), and brush dab spacing.
 *
 * A "mask" is one byte per pixel (0 = untouched, 255 = fully affected), the same layout the
 * selection uses, so the bucket, the wand and the selection share one representation.
 */
import type { PixelBuffer, Point, Rect } from './types';
import { combineMasks, magicWand, maskBounds } from './engine/select';
import { createImg, mixByMask } from './engine/core';

/*
 * Flood fill, mask bounds, mask intersection and masked mixing are the pixel engine's
 * (engine/select.ts, engine/core.ts); the helpers below are thin adapters that keep the
 * editor's call shapes. What remains here is what the engine does not have: region-sized
 * masked fill/clear, the stroke commit and dab spacing used by the canvas brush.
 */
export { maskBounds };

export interface MaskResult {
  mask: Uint8Array;
  bounds: Rect;
}

/**
 * Pixels "like" the one at (x, y): every channel (alpha included) within `tolerance`
 * (0..255). `contiguous` keeps only the connected region, which is what a paint bucket and a
 * magic wand normally do; otherwise every similar pixel counts. Null when nothing matched.
 */
export function floodMask(
  buf: PixelBuffer, x: number, y: number, tolerance: number, contiguous = true,
): MaskResult | null {
  const mask = magicWand(buf, x, y, { tolerance, contiguous });
  const bounds = maskBounds(mask, buf.width, buf.height);
  return bounds ? { mask, bounds } : null;
}

/** Multiplies two masks (selection ∩ bucket region). `b` may be null (no selection). */
export function intersectMasks(a: Uint8Array, b: Uint8Array | null): Uint8Array {
  return b ? combineMasks(a, b, 'intersect') : a;
}

/** "Source-over" of a solid colour through a mask, scaled by `opacity` (0..1). */
export function fillMasked(
  buf: PixelBuffer, mask: Uint8Array | null, rgb: readonly number[], opacity = 1,
): PixelBuffer {
  const out = new Uint8ClampedArray(buf.data);
  const op = Math.max(0, Math.min(1, opacity));
  for (let p = 0, i = 0; i < out.length; p++, i += 4) {
    const a = (mask ? mask[p] / 255 : 1) * op;
    if (a <= 0) continue;
    const da = out[i + 3] / 255;
    const oa = a + da * (1 - a);
    for (let c = 0; c < 3; c++) {
      out[i + c] = oa > 0 ? (rgb[c] * a + out[i + c] * da * (1 - a)) / oa : 0;
    }
    out[i + 3] = oa * 255;
  }
  return { width: buf.width, height: buf.height, data: out };
}

/** Erases through a mask: alpha is reduced by the mask strength. */
export function clearMasked(buf: PixelBuffer, mask: Uint8Array | null): PixelBuffer {
  const out = new Uint8ClampedArray(buf.data);
  for (let p = 0, i = 3; i < out.length; p++, i += 4) {
    const m = mask ? mask[p] : 255;
    if (m) out[i] = (out[i] * (255 - m) + 127) / 255;
  }
  return { width: buf.width, height: buf.height, data: out };
}

/** Blends a processed buffer over the original through a mask (null = everywhere). */
export function mixMasked(orig: PixelBuffer, processed: PixelBuffer, mask: Uint8Array | null): PixelBuffer {
  if (!mask) return processed;
  return mixByMask(orig, processed, mask, 1, createImg(orig.width, orig.height));
}

/** The part of a full-size mask that lies under `rect` (for region-sized operations). */
export function maskRegion(mask: Uint8Array | null, width: number, rect: Rect): Uint8Array | null {
  if (!mask) return null;
  const out = new Uint8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) {
    const from = (rect.y + y) * width + rect.x;
    out.set(mask.subarray(from, from + rect.w), y * rect.w);
  }
  return out;
}

/**
 * Evenly spaced brush dabs from `from` to `to`. `carry` is how far along the previous segment
 * the last dab was left, so spacing stays even across pointer events of any size.
 */
export function dabsAlong(from: Point, to: Point, spacing: number, carry: number): { points: Point[]; carry: number } {
  const step = Math.max(0.5, spacing);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const points: Point[] = [];
  let d = step - carry;
  if (len === 0) return { points, carry };
  while (d <= len) {
    points.push({ x: from.x + (dx * d) / len, y: from.y + (dy * d) / len });
    d += step;
  }
  return { points, carry: len - (d - step) };
}

/** Grows a rectangle to integers that contain it, clipped to (0, 0, width, height). */
export function clipRect(r: Rect, width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.w));
  const y1 = Math.min(height, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Commits a stroke onto a region of a layer. `stroke` holds straight-alpha RGBA the size of
 * `region` (what the stroke canvas painted); `opacity` scales it. A brush/clone/gradient is
 * "source-over"; an eraser removes alpha by the stroke's coverage. `mask` (region-sized, may
 * be null) limits the change — this is how a selection confines every stroke.
 */
export function compositeStroke(
  region: PixelBuffer, stroke: PixelBuffer, opacity: number, erase: boolean, mask: Uint8Array | null = null,
): PixelBuffer {
  const out = new Uint8ClampedArray(region.data);
  const op = Math.max(0, Math.min(1, opacity));
  const s = stroke.data;
  for (let p = 0, i = 0; i < out.length; p++, i += 4) {
    let a = (s[i + 3] / 255) * op;
    if (mask) a *= mask[p] / 255;
    if (a <= 0) continue;
    if (erase) {
      out[i + 3] = out[i + 3] * (1 - a);
      continue;
    }
    const da = out[i + 3] / 255;
    const oa = a + da * (1 - a);
    for (let c = 0; c < 3; c++) out[i + c] = oa > 0 ? (s[i + c] * a + out[i + c] * da * (1 - a)) / oa : 0;
    out[i + 3] = oa * 255;
  }
  return { width: region.width, height: region.height, data: out };
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
