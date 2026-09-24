/**
 * Photo Editor — pure painting helpers: flood fill (paint bucket and magic wand), masked
 * fill/clear/mix (everything that must respect a selection), and brush dab spacing.
 *
 * A "mask" is one byte per pixel (0 = untouched, 255 = fully affected), the same layout the
 * selection uses, so the bucket, the wand and the selection share one representation.
 */
import type { PixelBuffer, Point, Rect } from './types';

export interface MaskResult {
  mask: Uint8Array;
  bounds: Rect;
}

/** The bounding box of every non-zero mask byte, or null when the mask is empty. */
export function maskBounds(mask: Uint8Array, width: number, height: number): Rect | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0) {
      if (first < x0) x0 = first;
      if (last > x1) x1 = last;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Pixels "like" the one at (x, y): every channel (alpha included) within `tolerance`
 * (0..255). `contiguous` keeps only the connected region (4-neighbour scanline fill), which
 * is what a paint bucket and a magic wand normally do; otherwise every similar pixel counts.
 */
export function floodMask(
  buf: PixelBuffer, x: number, y: number, tolerance: number, contiguous = true,
): MaskResult | null {
  const { width, height, data } = buf;
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const tol = Math.max(0, Math.min(255, tolerance));
  const at = (sy * width + sx) * 4;
  const r0 = data[at];
  const g0 = data[at + 1];
  const b0 = data[at + 2];
  const a0 = data[at + 3];
  const similar = (p: number) => {
    const i = p * 4;
    return Math.abs(data[i] - r0) <= tol && Math.abs(data[i + 1] - g0) <= tol
      && Math.abs(data[i + 2] - b0) <= tol && Math.abs(data[i + 3] - a0) <= tol;
  };
  const mask = new Uint8Array(width * height);
  if (!contiguous) {
    for (let p = 0; p < width * height; p++) if (similar(p)) mask[p] = 255;
  } else {
    const stack: number[] = [sx, sy];
    while (stack.length) {
      const py = stack.pop()!;
      const px = stack.pop()!;
      let lx = px;
      const row = py * width;
      if (mask[row + lx] || !similar(row + lx)) continue;
      while (lx > 0 && !mask[row + lx - 1] && similar(row + lx - 1)) lx--;
      let rx = px;
      while (rx < width - 1 && !mask[row + rx + 1] && similar(row + rx + 1)) rx++;
      for (let i = lx; i <= rx; i++) mask[row + i] = 255;
      for (const ny of [py - 1, py + 1]) {
        if (ny < 0 || ny >= height) continue;
        const nrow = ny * width;
        let inRun = false;
        for (let i = lx; i <= rx; i++) {
          const ok = !mask[nrow + i] && similar(nrow + i);
          if (ok && !inRun) { stack.push(i, ny); inRun = true; } else if (!ok) inRun = false;
        }
      }
    }
  }
  const bounds = maskBounds(mask, width, height);
  return bounds ? { mask, bounds } : null;
}

/** Multiplies two masks (selection ∩ bucket region). `b` may be null (no selection). */
export function intersectMasks(a: Uint8Array, b: Uint8Array | null): Uint8Array {
  if (!b) return a;
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] * b[i] + 127) / 255;
  return out;
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
  const out = new Uint8ClampedArray(orig.data.length);
  for (let p = 0, i = 0; i < out.length; p++, i += 4) {
    const m = mask[p];
    if (m === 255) {
      out[i] = processed.data[i]; out[i + 1] = processed.data[i + 1];
      out[i + 2] = processed.data[i + 2]; out[i + 3] = processed.data[i + 3];
    } else if (m === 0) {
      out[i] = orig.data[i]; out[i + 1] = orig.data[i + 1]; out[i + 2] = orig.data[i + 2]; out[i + 3] = orig.data[i + 3];
    } else {
      const k = m / 255;
      for (let c = 0; c < 4; c++) out[i + c] = orig.data[i + c] + (processed.data[i + c] - orig.data[i + c]) * k;
    }
  }
  return { width: orig.width, height: orig.height, data: out };
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
