/**
 * PDF engine — pure geometry (الهندسة الصافية: منحنيات التوقيع والأشكال).
 *
 * No pdf-lib here: points in, numbers / content-stream path text out, so every shape the
 * writer draws can be pinned by a test.
 */
import { num, type Box } from './common';

export interface Point { x: number; y: number }
/** A pad point with optional pen pressure (0..1). */
export interface PressurePoint extends Point { p?: number }

/** One cubic Bézier segment from the previous end point. */
export interface Cubic { c1: Point; c2: Point; to: Point }
export interface SmoothPath { start: Point; segments: Cubic[] }

/** Drops points closer than `minDist` to the last kept one (jitter), always keeping the last. */
export function simplify<T extends Point>(points: readonly T[], minDist = 0.75): T[] {
  const out: T[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minDist) out.push(p);
  }
  const tail = points[points.length - 1];
  if (tail && out.length && out[out.length - 1] !== tail && Number.isFinite(tail.x) && Number.isFinite(tail.y)) {
    if (Math.hypot(tail.x - out[out.length - 1].x, tail.y - out[out.length - 1].y) > 0) out.push(tail);
  }
  return out;
}

/**
 * Uniform Catmull-Rom through every point, converted to cubic Béziers: the curve passes
 * through each sampled point and its tangent at P[i] is (P[i+1] − P[i−1]) / 2, so there are
 * no corners where the pointer samples were. End points are duplicated.
 * `tension` 1 = classic Catmull-Rom, 0 = straight segments.
 */
export function catmullRom(points: readonly Point[], tension = 1): SmoothPath | null {
  if (!points.length) return null;
  const start = { x: points[0].x, y: points[0].y };
  const segments: Cubic[] = [];
  const k = tension / 6;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    segments.push({
      c1: { x: p1.x + (p2.x - p0.x) * k, y: p1.y + (p2.y - p0.y) * k },
      c2: { x: p2.x - (p3.x - p1.x) * k, y: p2.y - (p3.y - p1.y) * k },
      to: { x: p2.x, y: p2.y },
    });
  }
  return { start, segments };
}

/** Evaluates a cubic at t (for tests and hit-testing). */
export function cubicAt(from: Point, c: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return {
    x: a * from.x + b * c.c1.x + d * c.c2.x + e * c.to.x,
    y: a * from.y + b * c.c1.y + d * c.c2.y + e * c.to.y,
  };
}

/** Content-stream path text (`m` + `c`, or a dot as a tiny line) for a smooth path. */
export function pathOperators(path: SmoothPath): string {
  const parts = [`${num(path.start.x)} ${num(path.start.y)} m`];
  if (!path.segments.length) {
    // A tap: a zero-length line with a round cap draws a dot.
    parts.push(`${num(path.start.x + 0.01)} ${num(path.start.y)} l`);
  }
  for (const s of path.segments) {
    parts.push(`${num(s.c1.x)} ${num(s.c1.y)} ${num(s.c2.x)} ${num(s.c2.y)} ${num(s.to.x)} ${num(s.to.y)} c`);
  }
  return parts.join('\n');
}

/** Bounding box of points (empty input → null). */
export function boundsOf(points: readonly Point[]): Box | null {
  if (!points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function inflate(b: Box, by: number): Box {
  return { x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by };
}

/** Ellipse inscribed in a box, as four Béziers (κ = 0.5523). */
export function ellipseOperators(b: Box): string {
  const k = 0.5522847498;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2, rx = b.width / 2, ry = b.height / 2;
  const ox = rx * k, oy = ry * k;
  return [
    `${num(cx + rx)} ${num(cy)} m`,
    `${num(cx + rx)} ${num(cy + oy)} ${num(cx + ox)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`,
    `${num(cx - ox)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + oy)} ${num(cx - rx)} ${num(cy)} c`,
    `${num(cx - rx)} ${num(cy - oy)} ${num(cx - ox)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`,
    `${num(cx + ox)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - oy)} ${num(cx + rx)} ${num(cy)} c`,
    'h',
  ].join('\n');
}

/** Rounded rectangle path. */
export function roundedRectOperators(b: Box, r: number): string {
  const rr = Math.max(0, Math.min(r, b.width / 2, b.height / 2));
  if (rr === 0) return `${num(b.x)} ${num(b.y)} ${num(b.width)} ${num(b.height)} re`;
  const k = 0.5522847498 * rr;
  const x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height;
  return [
    `${num(x0 + rr)} ${num(y0)} m`,
    `${num(x1 - rr)} ${num(y0)} l`,
    `${num(x1 - rr + k)} ${num(y0)} ${num(x1)} ${num(y0 + rr - k)} ${num(x1)} ${num(y0 + rr)} c`,
    `${num(x1)} ${num(y1 - rr)} l`,
    `${num(x1)} ${num(y1 - rr + k)} ${num(x1 - rr + k)} ${num(y1)} ${num(x1 - rr)} ${num(y1)} c`,
    `${num(x0 + rr)} ${num(y1)} l`,
    `${num(x0 + rr - k)} ${num(y1)} ${num(x0)} ${num(y1 - rr + k)} ${num(x0)} ${num(y1 - rr)} c`,
    `${num(x0)} ${num(y0 + rr)} l`,
    `${num(x0)} ${num(y0 + rr - k)} ${num(x0 + rr - k)} ${num(y0)} ${num(x0 + rr)} ${num(y0)} c`,
    'h',
  ].join('\n');
}

/** The two wing points of an open arrow head at `tip`, pointing away from `from`. */
export function arrowHead(from: Point, tip: Point, length: number, spread = Math.PI / 6): [Point, Point] {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  return [
    { x: tip.x - length * Math.cos(ang - spread), y: tip.y - length * Math.sin(ang - spread) },
    { x: tip.x - length * Math.cos(ang + spread), y: tip.y - length * Math.sin(ang + spread) },
  ];
}

/** A text-markup quad: the four corners in the de-facto (Acrobat) order TL, TR, BL, BR. */
export interface Quad { tl: Point; tr: Point; bl: Point; br: Point }

/** Flat QuadPoints (8 numbers per quad, TL TR BL BR) → quads; a trailing partial quad is dropped. */
export function quadsOf(flat: readonly number[]): Quad[] {
  const out: Quad[] = [];
  for (let i = 0; i + 8 <= flat.length; i += 8) {
    const q = flat.slice(i, i + 8);
    if (!q.every(Number.isFinite)) continue;
    out.push({ tl: { x: q[0], y: q[1] }, tr: { x: q[2], y: q[3] }, bl: { x: q[4], y: q[5] }, br: { x: q[6], y: q[7] } });
  }
  return out;
}

/** A page-space rectangle (e.g. one selected text line) → flat QuadPoints. */
export function quadForRect(b: Box): number[] {
  const x1 = b.x + b.width, y1 = b.y + b.height;
  return [b.x, y1, x1, y1, b.x, b.y, x1, b.y];
}

export function quadPoints(q: Quad): Point[] {
  return [q.tl, q.tr, q.bl, q.br];
}

/** The quad's height (TL→BL distance) — the line height the markup scales with. */
export function quadHeight(q: Quad): number {
  return Math.hypot(q.tl.x - q.bl.x, q.tl.y - q.bl.y);
}

/** Point at fraction `t` from a to b. */
export function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
