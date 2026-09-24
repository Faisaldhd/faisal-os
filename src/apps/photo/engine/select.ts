/**
 * Photo engine — selection masks.
 *
 * A mask is a `Uint8Array` of `width * height` coverage values (0 outside, 255 inside,
 * in between on soft/anti-aliased edges), the same shape the UI's `selection.ts` stores.
 * Combine modes match it too: add = max, subtract = a·(255−b)/255, intersect = a·b/255.
 */
import { blurPlane16, clamp, cloneImg, mixByMask, type Img, type Mask, type Rect } from './core';

export type CombineMode = 'replace' | 'add' | 'subtract' | 'intersect';

export interface Pt {
  x: number;
  y: number;
}

export function emptyMask(width: number, height: number): Mask {
  return new Uint8Array(width * height);
}

export function fullMask(width: number, height: number): Mask {
  return new Uint8Array(width * height).fill(255);
}

/** Rectangle (hard edges, snapped to whole pixels, clipped to the image). */
export function rectMask(width: number, height: number, rect: Rect): Mask {
  const m = emptyMask(width, height);
  const x0 = clamp(Math.round(Math.min(rect.x, rect.x + rect.w)), 0, width);
  const x1 = clamp(Math.round(Math.max(rect.x, rect.x + rect.w)), 0, width);
  const y0 = clamp(Math.round(Math.min(rect.y, rect.y + rect.h)), 0, height);
  const y1 = clamp(Math.round(Math.max(rect.y, rect.y + rect.h)), 0, height);
  for (let y = y0; y < y1; y++) m.fill(255, y * width + x0, y * width + x1);
  return m;
}

/**
 * Ellipse inscribed in `rect`, anti-aliased: each pixel's coverage comes from a 4×4
 * supersample of its area, so the edge is smooth and the inside is exactly 255.
 */
export function ellipseMask(width: number, height: number, rect: Rect): Mask {
  const m = emptyMask(width, height);
  const rx = Math.abs(rect.w) / 2;
  const ry = Math.abs(rect.h) / 2;
  if (rx <= 0 || ry <= 0) return m;
  const cx = Math.min(rect.x, rect.x + rect.w) + rx;
  const cy = Math.min(rect.y, rect.y + rect.h) + ry;
  const y0 = clamp(Math.floor(cy - ry), 0, height);
  const y1 = clamp(Math.ceil(cy + ry), 0, height);
  const x0 = clamp(Math.floor(cx - rx), 0, width);
  const x1 = clamp(Math.ceil(cx + rx), 0, width);
  const irx2 = 1 / (rx * rx);
  const iry2 = 1 / (ry * ry);
  const inside = (px: number, py: number) => (px - cx) * (px - cx) * irx2 + (py - cy) * (py - cy) * iry2 <= 1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // Fast path: all four corners inside → fully covered; handled by the corner test.
      const c = +inside(x, y) + +inside(x + 1, y) + +inside(x, y + 1) + +inside(x + 1, y + 1);
      if (c === 4) { m[y * width + x] = 255; continue; }
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++;
      }
      m[y * width + x] = Math.round((hit * 255) / 16);
    }
  }
  return m;
}

/**
 * Lasso / polygon: scanline fill with the even-odd rule, sampled at pixel centres.
 * The path is closed automatically.
 */
export function polygonMask(width: number, height: number, points: readonly Pt[]): Mask {
  const m = emptyMask(width, height);
  const n = points.length;
  if (n < 3) return m;
  let minY = Infinity, maxY = -Infinity;
  for (const p of points) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  const ys = clamp(Math.floor(minY), 0, height);
  const ye = clamp(Math.ceil(maxY), 0, height);
  const xs: number[] = [];
  for (let y = ys; y < ye; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = points[i];
      const b = points[j];
      if ((a.y > sy) !== (b.y > sy)) xs.push(a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Pixel x is inside when its centre x+0.5 lies in [xs[k], xs[k+1]).
      const from = clamp(Math.ceil(xs[k] - 0.5), 0, width);
      const to = clamp(Math.ceil(xs[k + 1] - 0.5), 0, width);
      if (to > from) m.fill(255, y * width + from, y * width + to);
    }
  }
  return m;
}

export interface WandOptions {
  /** 0..255: every channel (alpha included) must be within this of the seed pixel. */
  tolerance?: number;
  /** true: only the connected region (4-neighbour); false: every similar pixel. */
  contiguous?: boolean;
}

/**
 * Magic wand: pixels "like" the one at (x, y). Returns an empty mask when (x, y) is off
 * the image. Contiguous mode is a scanline flood fill with an explicit stack (no recursion,
 * so a 12 MP flat image cannot overflow the call stack).
 */
export function magicWand(src: Img, x: number, y: number, opts: WandOptions = {}): Mask {
  const { width: w, height: h, data: d } = src;
  const m = emptyMask(w, h);
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (!(sx >= 0 && sy >= 0 && sx < w && sy < h)) return m;
  const tol = clamp(opts.tolerance ?? 32, 0, 255);
  const at = (sy * w + sx) * 4;
  const r0 = d[at], g0 = d[at + 1], b0 = d[at + 2], a0 = d[at + 3];
  const similar = (p: number): boolean => {
    const i = p * 4;
    return Math.abs(d[i] - r0) <= tol && Math.abs(d[i + 1] - g0) <= tol
      && Math.abs(d[i + 2] - b0) <= tol && Math.abs(d[i + 3] - a0) <= tol;
  };
  if (opts.contiguous === false) {
    for (let p = 0; p < w * h; p++) if (similar(p)) m[p] = 255;
    return m;
  }
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const py = stack.pop() as number;
    const px = stack.pop() as number;
    const row = py * w;
    if (m[row + px] || !similar(row + px)) continue;
    let l = px;
    while (l > 0 && !m[row + l - 1] && similar(row + l - 1)) l--;
    let r = px;
    while (r < w - 1 && !m[row + r + 1] && similar(row + r + 1)) r++;
    m.fill(255, row + l, row + r + 1);
    for (const ny of [py - 1, py + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let xx = l; xx <= r; xx++) {
        const ok = !m[nrow + xx] && similar(nrow + xx);
        if (ok && !inRun) { stack.push(xx, ny); inRun = true; } else if (!ok) inRun = false;
      }
    }
  }
  return m;
}

/** Gaussian feather of a mask edge; `radius` is the sigma in pixels. */
export function featherMask(mask: Mask, width: number, height: number, radius: number): Mask {
  if (!(radius > 0)) return new Uint8Array(mask);
  const plane = new Uint16Array(mask.length);
  for (let i = 0; i < mask.length; i++) plane[i] = mask[i] * 257;
  blurPlane16(plane, width, height, radius);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = (plane[i] + 128) / 257;
  return out;
}

export function invertMask(mask: Mask): Mask {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = 255 - mask[i];
  return out;
}

/** Combines `shape` into `current` (null current = nothing selected). */
export function combineMasks(current: Mask | null, shape: Mask, mode: CombineMode): Mask {
  if (mode === 'replace') return new Uint8Array(shape);
  if (!current) return mode === 'add' ? new Uint8Array(shape) : new Uint8Array(shape.length);
  const out = new Uint8Array(shape.length);
  for (let i = 0; i < out.length; i++) {
    const a = current[i];
    const b = shape[i];
    if (mode === 'add') out[i] = a > b ? a : b;
    else if (mode === 'subtract') out[i] = (a * (255 - b) + 127) / 255;
    else out[i] = (a * b + 127) / 255;
  }
  return out;
}

/** Tight bounding rectangle of the non-zero part, or null for an empty mask. */
export function maskBounds(mask: Mask, width: number, height: number): Rect | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function isMaskEmpty(mask: Mask): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i]) return false;
  return true;
}

/**
 * Marching-ants outline: the pixel edges between selected (≥ 128) and unselected pixels,
 * as flat [x1, y1, x2, y2, …] segments in image pixels, horizontal runs merged.
 */
export function maskOutline(mask: Mask, width: number, height: number): number[] {
  const seg: number[] = [];
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] >= 128;
  for (let y = 0; y <= height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const edge = x < width && on(x, y) !== on(x, y - 1);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) { seg.push(start, y, x, y); start = -1; }
    }
  }
  for (let x = 0; x <= width; x++) {
    let start = -1;
    for (let y = 0; y <= height; y++) {
      const edge = y < height && on(x, y) !== on(x - 1, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) { seg.push(x, start, x, y); start = -1; }
    }
  }
  return seg;
}

/**
 * Runs any image op and keeps its result only inside the mask (soft edges blend).
 * A null mask means "everything". The op gets a copy, so it may work in place.
 */
export function applyThroughMask(src: Img, mask: Mask | null, op: (img: Img) => Img): Img {
  const processed = op(cloneImg(src));
  if (!mask) return processed;
  return mixByMask(src, processed, mask);
}
