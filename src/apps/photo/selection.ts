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
import {
  combineMasks, ellipseMask, invertMask, maskBounds, maskOutline, polygonMask, rectMask,
} from './engine/select';

/*
 * The mask builders are the pixel engine's (engine/select.ts); this file only adds what the
 * editor needs on top of a bare mask: the document-sized `Selection` with its bounds and exact
 * outline, and the down-sampled edge trace for marching ants on huge masks.
 */
export { rectMask, ellipseMask, polygonMask };

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
  return fromMask(width, height, combineMasks(current.mask, shape, mode), null);
}

export function selectAll(width: number, height: number): Selection {
  const mask = new Uint8Array(width * height).fill(255);
  return { width, height, mask, bounds: { x: 0, y: 0, w: width, h: height }, outline: { kind: 'rect', rect: { x: 0, y: 0, w: width, h: height } } };
}

/** Everything that was not selected becomes selected (and vice versa). */
export function invertSelection(current: Selection | null, width: number, height: number): Selection | null {
  if (!current) return selectAll(width, height);
  return fromMask(width, height, invertMask(current.mask), null);
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
      on[y * w + x] = sel.mask[sy * sel.width + sx] >= 128 ? 255 : 0;
    }
  }
  const segments = maskOutline(on, w, h);
  if (scale > 1) for (let i = 0; i < segments.length; i++) segments[i] *= scale;
  return { scale, segments };
}

/** Which mode a pointer gesture means: Shift adds, Alt subtracts, both intersect. */
export function modeFromModifiers(base: SelectionMode, shift: boolean, alt: boolean): SelectionMode {
  if (shift && alt) return 'intersect';
  if (shift) return 'add';
  if (alt) return 'subtract';
  return base;
}
