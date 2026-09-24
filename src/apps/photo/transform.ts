/**
 * Photo Editor — 2D affine matrices for layers.
 *
 * Every layer carries one matrix that maps its own content space (a raster's pixels, a text
 * anchor, a shape's points) into document pixels. Moving a layer, cropping the canvas,
 * rotating/flipping the image or resizing it are all "multiply one more matrix in front", so
 * text and shape layers stay editable through every image transform.
 *
 * The layout matches `CanvasRenderingContext2D.setTransform(a, b, c, d, e, f)`:
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 */
import type { Point, Rect } from './types';

export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m1 · m2`: apply m2 first, then m1. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function translation(dx: number, dy: number): Matrix {
  return [1, 0, 0, 1, dx, dy];
}

export function scaling(sx: number, sy: number = sx): Matrix {
  return [sx, 0, 0, sy, 0, 0];
}

/** Clockwise rotation in degrees (canvas y points down), about the origin. */
export function rotation(degrees: number): Matrix {
  const r = (degrees * Math.PI) / 180;
  // Snap the trig of exact right angles so a quarter turn stays an exact permutation.
  const snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-12 ? Math.sign(v) : v);
  const cos = snap(Math.cos(r));
  const sin = snap(Math.sin(r));
  return [cos, sin, -sin, cos, 0, 0];
}

export function apply(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function determinant(m: Matrix): number {
  return m[0] * m[3] - m[1] * m[2];
}

/** The inverse, or null for a degenerate (zero-area) matrix. */
export function invert(m: Matrix): Matrix | null {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const [a, b, c, d, e, f] = m;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** True when the matrix only moves (no scale, rotation or flip). */
export function isTranslationOnly(m: Matrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
}

/** The uniform scale a matrix applies to lengths (geometric mean of its axes). */
export function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(determinant(m)));
}

/** Axis-aligned bounds of `rect` after the matrix. */
export function transformRect(m: Matrix, rect: Rect): Rect {
  const pts = [
    apply(m, { x: rect.x, y: rect.y }),
    apply(m, { x: rect.x + rect.w, y: rect.y }),
    apply(m, { x: rect.x, y: rect.y + rect.h }),
    apply(m, { x: rect.x + rect.w, y: rect.y + rect.h }),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * The matrix of a whole-image operation, plus the new canvas size. Used for rotate 90°,
 * flips, free rotation (which grows the canvas to its rotated bounds) and resize.
 */
export function quarterTurnMatrix(width: number, height: number, direction: 1 | -1): Matrix {
  // Clockwise: (x, y) → (H − y, x); counter-clockwise: (x, y) → (y, W − x).
  return direction > 0 ? [0, 1, -1, 0, height, 0] : [0, -1, 1, 0, 0, width];
}

export function flipMatrix(width: number, height: number, axis: 'h' | 'v'): Matrix {
  return axis === 'h' ? [-1, 0, 0, 1, width, 0] : [1, 0, 0, -1, 0, height];
}

/** Rotates about the old centre and re-centres on a canvas of `out` size. */
export function freeRotationMatrix(
  width: number, height: number, degrees: number, out: { width: number; height: number },
): Matrix {
  return multiply(
    translation(out.width / 2, out.height / 2),
    multiply(rotation(degrees), translation(-width / 2, -height / 2)),
  );
}

export function resizeMatrix(from: { width: number; height: number }, to: { width: number; height: number }): Matrix {
  return scaling(to.width / Math.max(1, from.width), to.height / Math.max(1, from.height));
}

/** Rounds away the float noise a chain of exact operations leaves behind (1e-15 and friends). */
export function tidy(m: Matrix): Matrix {
  const r = (v: number) => {
    const n = Math.round(v);
    return Math.abs(v - n) < 1e-9 ? n + 0 : v; // `+ 0` turns -0 into 0
  };
  return [r(m[0]), r(m[1]), r(m[2]), r(m[3]), r(m[4]), r(m[5])];
}
