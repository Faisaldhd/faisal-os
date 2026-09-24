/**
 * Photo Editor — selections.
 *
 * A selection is a document-sized coverage mask (one byte per pixel) plus, when it came from a
 * single shape, that shape's outline so the marching ants can be drawn exactly. Rectangle,
 * ellipse, lasso (polygon) and magic wand all produce a mask; the four modes (replace, add,
 * subtract, intersect) combine masks byte by byte. Brush, eraser, bucket, gradient, delete,
 * copy and every adjustment read the same mask, which is what makes "painting outside the
 * selection changes no pixels" true by construction.
 */
import type { Point, Rect } from './types';
import { maskBounds } from './paint';

export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect';

export type Outline =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'ellipse'; rect: Rect }
  | { kind: 'poly'; points: Point[] };

export interface Selection {
  width: number;
  height: number;
  mask: Uint8Array;
  bounds: Rect;
  /** Exact outline when the selection is one untouched shape; null → trace the mask. */
  outline: Outline | null;
}

export function rectMask(width: number, height: number, rect: Rect): Uint8Array {
  const mask = new Uint8Array(width * height);
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(width, Math.round(rect.x + rect.w));
  const y1 = Math.min(height, Math.round(rect.y + rect.h));
  for (let y = y0; y < y1; y++) mask.fill(255, y * width + x0, y * width + x1);
  return mask;
}

/** An ellipse inscribed in `rect`, anti-aliased on its rim with a 4×4 supersample. */
export function ellipseMask(width: number, height: number, rect: Rect): Uint8Array {
  const mask = new Uint8Array(width * height);
  const rx = rect.w / 2;
  const ry = rect.h / 2;
  if (rx <= 0 || ry <= 0) return mask;
  const cx = rect.x + rx;
  const cy = rect.y + ry;
  const y0 = Math.max(0, Math.floor(rect.y));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  const x0 = Math.max(0, Math.floor(rect.x));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ux = (x + 0.5 - cx) / rx;
      const uy = (y + 0.5 - cy) / ry;
      const d = ux * ux + uy * uy;
      // Fully inside/outside away from the rim; supersample only near the boundary.
      if (d < 0.85) { mask[y * width + x] = 255; continue; }
      if (d > 1.2) continue;
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const vx = (x + (sx + 0.5) / 4 - cx) / rx;
          const vy = (y + (sy + 0.5) / 4 - cy) / ry;
          if (vx * vx + vy * vy <= 1) hits++;
        }
      }
      mask[y * width + x] = Math.round((hits / 16) * 255);
    }
  }
  return mask;
}

/** A closed polygon (the lasso), even-odd rule, sampled at pixel centres. */
export function polygonMask(width: number, height: number, points: readonly Point[]): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (points.length < 3) return mask;
  const xs: number[] = [];
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i];
      const b = points[j];
      if ((a.y > py) !== (b.y > py)) xs.push(a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    if (xs.length < 2) continue;
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      if (to >= from) mask.fill(255, y * width + from, y * width + to + 1);
    }
  }
  return mask;
}

function fromMask(width: number, height: number, mask: Uint8Array, outline: Outline | null): Selection | null {
  const bounds = maskBounds(mask, width, height);
  return bounds ? { width, height, mask, bounds, outline } : null;
}

/** Combines a new shape mask with the current selection. Returns null for an empty result. */
export function combine(
  current: Selection | null, width: number, height: number, shape: Uint8Array, outline: Outline | null,
  mode: SelectionMode,
): Selection | null {
  if (mode === 'replace' || !current || current.width !== width || current.height !== height) {
    if (mode === 'subtract' || mode === 'intersect') {
      // Subtracting from / intersecting with nothing leaves nothing.
      if (!current) return null;
    }
    return mode === 'replace' || !current ? fromMask(width, height, shape, outline) : null;
  }
  const out = new Uint8Array(width * height);
  const a = current.mask;
  for (let i = 0; i < out.length; i++) {
    if (mode === 'add') out[i] = Math.max(a[i], shape[i]);
    else if (mode === 'subtract') out[i] = (a[i] * (255 - shape[i]) + 127) / 255;
    else out[i] = (a[i] * shape[i] + 127) / 255;
  }
  return fromMask(width, height, out, null);
}

export function selectAll(width: number, height: number): Selection {
  const mask = new Uint8Array(width * height).fill(255);
  return { width, height, mask, bounds: { x: 0, y: 0, w: width, h: height }, outline: { kind: 'rect', rect: { x: 0, y: 0, w: width, h: height } } };
}

/** Everything that was not selected becomes selected (and vice versa). */
export function invertSelection(current: Selection | null, width: number, height: number): Selection | null {
  if (!current) return selectAll(width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = 255 - current.mask[i];
  return fromMask(width, height, out, null);
}

/** Selection from a ready-made mask (the magic wand). */
export function selectionFromMask(width: number, height: number, mask: Uint8Array): Selection | null {
  return fromMask(width, height, mask, null);
}

/** Moves the whole selection with the canvas when it is cropped or shifted. */
export function cropSelection(sel: Selection | null, rect: Rect): Selection | null {
  if (!sel) return null;
  const out = new Uint8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) {
    const sy = y + rect.y;
    if (sy < 0 || sy >= sel.height) continue;
    for (let x = 0; x < rect.w; x++) {
      const sx = x + rect.x;
      if (sx >= 0 && sx < sel.width) out[y * rect.w + x] = sel.mask[sy * sel.width + sx];
    }
  }
  return fromMask(rect.w, rect.h, out, null);
}

/**
 * The mask's boundary as axis-aligned segments, for marching ants when there is no exact
 * outline. Large masks are traced on a grid of at most `maxSide` cells so a noisy wand
 * selection cannot produce millions of segments; `scale` converts cells back to pixels.
 * Horizontal and vertical runs are merged, so a rectangle is exactly four segments.
 */
export function traceEdges(sel: Selection, maxSide = 1024): { scale: number; segments: number[] } {
  const scale = Math.max(1, Math.ceil(Math.max(sel.width, sel.height) / maxSide));
  const w = Math.ceil(sel.width / scale);
  const h = Math.ceil(sel.height / scale);
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sel.width - 1, x * scale + (scale >> 1));
      const sy = Math.min(sel.height - 1, y * scale + (scale >> 1));
      on[y * w + x] = sel.mask[sy * sel.width + sx] >= 128 ? 1 : 0;
    }
  }
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : on[y * w + x]);
  const segments: number[] = [];
  // Horizontal edges: between row y-1 and y.
  for (let y = 0; y <= h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && get(x, y - 1) !== get(x, y);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) { segments.push(start * scale, y * scale, x * scale, y * scale); start = -1; }
    }
  }
  // Vertical edges: between column x-1 and x.
  for (let x = 0; x <= w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && get(x - 1, y) !== get(x, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) { segments.push(x * scale, start * scale, x * scale, y * scale); start = -1; }
    }
  }
  return { scale, segments };
}

/** Which mode a pointer gesture means: Shift adds, Alt subtracts, both intersect. */
export function modeFromModifiers(base: SelectionMode, shift: boolean, alt: boolean): SelectionMode {
  if (shift && alt) return 'intersect';
  if (shift) return 'add';
  if (alt) return 'subtract';
  return base;
}
