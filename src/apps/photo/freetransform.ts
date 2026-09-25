/**
 * Photo Editor — free transform (pure maths, no DOM).
 *
 * A free transform is a move + rotation + (possibly negative, i.e. flipping) scale applied to
 * a box in DOCUMENT pixels, about the box's centre:
 *     M = T(centre + offset) · R(angle) · S(sx, sy) · T(−centre)
 * The editor multiplies M in front of a layer's matrix (so a raster is resampled once, at
 * render time, and text/shape layers stay editable), or draws a selection mask through it.
 * Handles are dragged in the box's own rotated frame, anchored on the opposite side, which is
 * what makes a corner drag feel like every other editor.
 */
import type { Point, Rect } from './types';
import { multiply, rotation, scaling, translation, type Matrix } from './transform';

export interface FreeTransform {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  /** Degrees, clockwise. */
  angle: number;
}

export const FT_IDENTITY: FreeTransform = { dx: 0, dy: 0, sx: 1, sy: 1, angle: 0 };

export type FtHandle = 'move' | 'rotate' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const SIGNS: Record<Exclude<FtHandle, 'move' | 'rotate'>, [number, number]> = {
  n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1],
};

function centre(box: Rect): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

export function ftMatrix(box: Rect, ft: FreeTransform): Matrix {
  const c = centre(box);
  return multiply(
    translation(c.x + ft.dx, c.y + ft.dy),
    multiply(rotation(ft.angle), multiply(scaling(ft.sx, ft.sy), translation(-c.x, -c.y))),
  );
}

function rot(p: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

/** Handle positions in document pixels; `rotateGap` is the rotate handle's distance above the top edge. */
export function handlePoints(box: Rect, ft: FreeTransform, rotateGap: number): { id: FtHandle; x: number; y: number }[] {
  const c = centre(box);
  const cc = { x: c.x + ft.dx, y: c.y + ft.dy };
  const at = (lx: number, ly: number) => {
    const v = rot({ x: lx, y: ly }, ft.angle);
    return { x: cc.x + v.x, y: cc.y + v.y };
  };
  const hw = (box.w / 2) * ft.sx;
  const hh = (box.h / 2) * ft.sy;
  const out: { id: FtHandle; x: number; y: number }[] = [];
  for (const [id, [hx, hy]] of Object.entries(SIGNS) as [FtHandle, [number, number]][]) out.push({ id, ...at(hx * hw, hy * hh) });
  const up = Math.sign(ft.sy) || 1;
  out.push({ id: 'rotate', ...at(0, -up * (Math.abs(hh) + rotateGap)) });
  return out;
}

/** The four corners (nw, ne, se, sw) in document pixels, for drawing the box. */
export function corners(box: Rect, ft: FreeTransform): Point[] {
  const m = ftMatrix(box, ft);
  const ap = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  return [ap(box.x, box.y), ap(box.x + box.w, box.y), ap(box.x + box.w, box.y + box.h), ap(box.x, box.y + box.h)];
}

/** True when `p` is inside the transformed box. */
export function insideBox(box: Rect, ft: FreeTransform, p: Point): boolean {
  const c = centre(box);
  const q = rot({ x: p.x - c.x - ft.dx, y: p.y - c.y - ft.dy }, -ft.angle);
  return Math.abs(q.x) <= Math.abs((box.w / 2) * ft.sx) && Math.abs(q.y) <= Math.abs((box.h / 2) * ft.sy);
}

/** The handle within `reach` document pixels of `p`, else 'move' inside the box, else null. */
export function hitHandle(box: Rect, ft: FreeTransform, p: Point, reach: number, rotateGap: number): FtHandle | null {
  let best: FtHandle | null = null;
  let bestD = reach;
  for (const h of handlePoints(box, ft, rotateGap)) {
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (d <= bestD) { best = h.id; bestD = d; }
  }
  if (best) return best;
  return insideBox(box, ft, p) ? 'move' : null;
}

/**
 * The transform after dragging `handle` from `from` to `to` (document pixels), starting at
 * `start`. `keep` (Shift) keeps the aspect ratio on corners and snaps rotation to 15°.
 */
export function dragHandle(
  box: Rect, start: FreeTransform, handle: FtHandle, from: Point, to: Point, keep: boolean,
): FreeTransform {
  const c = centre(box);
  const cc = { x: c.x + start.dx, y: c.y + start.dy };
  if (handle === 'move') return { ...start, dx: start.dx + to.x - from.x, dy: start.dy + to.y - from.y };
  if (handle === 'rotate') {
    const a0 = Math.atan2(from.y - cc.y, from.x - cc.x);
    const a1 = Math.atan2(to.y - cc.y, to.x - cc.x);
    let angle = start.angle + ((a1 - a0) * 180) / Math.PI;
    if (keep) angle = Math.round(angle / 15) * 15;
    angle = ((((angle + 180) % 360) + 360) % 360) - 180;
    return { ...start, angle };
  }
  const [hx, hy] = SIGNS[handle];
  const q = rot({ x: to.x - cc.x, y: to.y - cc.y }, -start.angle);
  const w = Math.max(1e-6, box.w);
  const h = Math.max(1e-6, box.h);
  // Anchor = the opposite edge/corner, in the start frame (relative to the start centre).
  const ax = -hx * (w / 2) * start.sx;
  const ay = -hy * (h / 2) * start.sy;
  let sx = hx ? (q.x - ax) / (hx * w) : start.sx;
  let sy = hy ? (q.y - ay) / (hy * h) : start.sy;
  const minS = 1 / Math.max(w, h);
  if (Math.abs(sx) < minS) sx = Math.sign(sx || 1) * minS;
  if (Math.abs(sy) < minS) sy = Math.sign(sy || 1) * minS;
  if (keep && hx && hy) {
    const r = Math.max(Math.abs(sx / start.sx), Math.abs(sy / start.sy));
    sx = Math.sign(sx) * Math.abs(start.sx) * r;
    sy = Math.sign(sy) * Math.abs(start.sy) * r;
  }
  const lx = hx ? ax + (hx * w * sx) / 2 : 0;
  const ly = hy ? ay + (hy * h * sy) / 2 : 0;
  const off = rot({ x: lx, y: ly }, start.angle);
  return { dx: start.dx + off.x, dy: start.dy + off.y, sx, sy, angle: start.angle };
}

/** The transformed box's size and angle, for the options-bar readout. */
export function ftReadout(box: Rect, ft: FreeTransform): { w: number; h: number; angle: number } {
  return { w: Math.round(Math.abs(box.w * ft.sx)), h: Math.round(Math.abs(box.h * ft.sy)), angle: Math.round(ft.angle * 10) / 10 };
}

export function isIdentity(ft: FreeTransform): boolean {
  return ft.dx === 0 && ft.dy === 0 && ft.sx === 1 && ft.sy === 1 && ft.angle === 0;
}
