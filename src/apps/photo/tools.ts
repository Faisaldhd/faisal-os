/**
 * Photo Editor — the pure tool layer: brushes, lines, rectangles, ellipses, arrows and
 * text placement.
 *
 * Each tool rasterises into a `PixelBuffer` with no DOM. The brush draws a round stamp with
 * a coverage mask rather than a hard disc, so an edge is anti-aliased instead of jagged, and
 * `coverageOf` is exported because that is the part worth testing: a stamp must cover its
 * centre fully, its rim partially and its outside not at all.
 */
import type { Point, Rect, Size } from './types';
import { clamp, clampDimension } from './geometry';
import { clamp255 } from './pixels';

export interface DrawOp {
  kind: 'brush' | 'line' | 'rect' | 'ellipse' | 'arrow';
  from: Point;
  to: Point;
  /** Points the brush passed through; a line/shape only needs `from` and `to`. */
  path?: Point[];
  /** "#rrggbb". */
  color: string;
  /** Stroke width in image pixels. */
  size: number;
  /** A rectangle/ellipse can be outlined or filled. */
  filled?: boolean;
}

export const MIN_BRUSH = 1;
export const MAX_BRUSH = 200;

export function clampBrush(size: number): number {
  if (!Number.isFinite(size)) return MIN_BRUSH;
  return clamp(size, MIN_BRUSH, MAX_BRUSH);
}

/* ───────────────────────────────── colour ───────────────────────────────── */

/** "#rgb" / "#rrggbb" → [r, g, b]; anything unparsable becomes opaque black. */
export function parseHexColor(hex: string): [number, number, number] {
  const s = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  return [0, 0, 0];
}

/* ─────────────────────────────── the buffer ─────────────────────────────── */

export interface PaintTarget {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function blendAt(target: PaintTarget, x: number, y: number, rgb: [number, number, number], coverage: number): void {
  if (coverage <= 0) return;
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return;
  const i = (y * target.width + x) * 4;
  const a = Math.min(1, coverage);
  target.data[i] = clamp255(target.data[i] + (rgb[0] - target.data[i]) * a);
  target.data[i + 1] = clamp255(target.data[i + 1] + (rgb[1] - target.data[i + 1]) * a);
  target.data[i + 2] = clamp255(target.data[i + 2] + (rgb[2] - target.data[i + 2]) * a);
  // A drawn mark is opaque where it fully covers the pixel: that is what makes a stroke
  // visible over a transparent PNG background, which a purely "paint the colour" pass
  // would leave invisible.
  target.data[i + 3] = clamp255(target.data[i + 3] + (255 - target.data[i + 3]) * a);
}

/**
 * How much of pixel (x, y) a radius-r disc centred at (cx, cy) covers.
 *
 * The 4×4 supersample is exact enough to remove the staircase on a diagonal edge and cheap
 * enough to stay pure arithmetic. Exported for tests: centre = 1, far outside = 0, and the
 * sample is monotone in the distance.
 */
export function coverageOf(cx: number, cy: number, r: number, x: number, y: number): number {
  if (r <= 0) return 0;
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4;
      const py = y + (sy + 0.5) / 4;
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r * r) hits++;
    }
  }
  return hits / 16;
}

/** One round brush stamp (a dot for a single click). */
export function stampDot(target: PaintTarget, center: Point, rgb: [number, number, number], size: number): void {
  const r = clampBrush(size) / 2;
  const x0 = Math.floor(center.x - r - 1);
  const y0 = Math.floor(center.y - r - 1);
  const x1 = Math.ceil(center.x + r + 1);
  const y1 = Math.ceil(center.y + r + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      blendAt(target, x, y, rgb, coverageOf(center.x, center.y, r, x, y));
    }
  }
}

/**
 * A straight stroke between two points: the brush is stamped at every `size/4` of the
 * segment, so a fast drag cannot leave gaps and a slow one cannot visibly darken (stamps
 * share the same colour, and alpha compositing of the same colour is idempotent).
 */
export function strokeSegment(
  target: PaintTarget,
  from: Point,
  to: Point,
  rgb: [number, number, number],
  size: number,
  offset: number,
): void {
  const width = clampBrush(size);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const step = Math.max(0.5, width / 4);
  const count = Math.max(1, Math.ceil(length / step));
  for (let i = 0; i <= count; i++) {
    const t = count === 0 ? 0 : i / count;
    const phase = (offset + i) % 4;
    stampDot(target, { x: from.x + dx * t, y: from.y + dy * t }, rgb, phase === 3 ? width * 0.92 : width);
  }
}

/** Paints a whole `DrawOp`; a brush uses its `path`, every other tool its two endpoints. */
export function paintOp(target: PaintTarget, op: DrawOp): void {
  const rgb = parseHexColor(op.color);
  const size = clampBrush(op.size);
  switch (op.kind) {
    case 'brush': {
      const path = op.path && op.path.length ? op.path : [op.from, op.to];
      if (path.length === 1) {
        stampDot(target, path[0], rgb, size);
        return;
      }
      for (let i = 1; i < path.length; i++) strokeSegment(target, path[i - 1], path[i], rgb, size, i);
      return;
    }
    case 'line':
      strokeSegment(target, op.from, op.to, rgb, size, 0);
      return;
    case 'rect':
      paintRect(target, op.from, op.to, rgb, size, !!op.filled);
      return;
    case 'ellipse':
      paintEllipse(target, op.from, op.to, rgb, size, !!op.filled);
      return;
    case 'arrow':
      paintArrow(target, op.from, op.to, rgb, size);
      return;
  }
}

/** The rectangle a two-point drag describes, in any direction. */
export function dragRect(from: Point, to: Point): Rect {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return { x, y, w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
}

export function paintRect(
  target: PaintTarget,
  from: Point,
  to: Point,
  rgb: [number, number, number],
  size: number,
  filled: boolean,
): void {
  const r = dragRect(from, to);
  if (r.w < 0.5 && r.h < 0.5) { stampDot(target, from, rgb, size); return; }
  if (filled) {
    const x0 = Math.round(r.x);
    const y0 = Math.round(r.y);
    const x1 = Math.round(r.x + r.w);
    const y1 = Math.round(r.y + r.h);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) blendAt(target, x, y, rgb, 1);
    return;
  }
  const corners: Point[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) strokeSegment(target, corners[i], corners[(i + 1) % 4], rgb, size, i);
}

/**
 * Ellipse inscribed in the drag rectangle. `((x−cx)/rx)² + ((y−cy)/ry)² = 1` decides
 * inside/outside; the outline draws the band between the outer ellipse and the inner one
 * shrunk by the stroke width, so a thick outline stays inside its rectangle.
 */
export function paintEllipse(
  target: PaintTarget,
  from: Point,
  to: Point,
  rgb: [number, number, number],
  size: number,
  filled: boolean,
): void {
  const r = dragRect(from, to);
  const rx = Math.max(0.5, r.w / 2);
  const ry = Math.max(0.5, r.h / 2);
  const cx = r.x + rx;
  const cy = r.y + ry;
  const stroke = clampBrush(size);
  const innerX = Math.max(0.0001, rx - stroke);
  const innerY = Math.max(0.0001, ry - stroke);
  const x0 = Math.floor(cx - rx - 1);
  const y0 = Math.floor(cy - ry - 1);
  const x1 = Math.ceil(cx + rx + 1);
  const y1 = Math.ceil(cy + ry + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // Sample at the pixel centre, with a 2×2 supersample on the boundary.
      let inside = 0;
      let outerHits = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
        const ux = (x + ox - cx) / rx;
        const uy = (y + oy - cy) / ry;
        if (ux * ux + uy * uy <= 1) outerHits++;
        const ix = (x + ox - cx) / innerX;
        const iy = (y + oy - cy) / innerY;
        if (ix * ix + iy * iy <= 1) inside++;
      }
      if (filled) {
        if (outerHits) blendAt(target, x, y, rgb, outerHits / 4);
      } else if (outerHits && inside < 4) {
        blendAt(target, x, y, rgb, (outerHits - inside) / 4);
      }
    }
  }
}

/** A line with a two-barb head at `to`. The barbs are the same brush, so the width matches. */
export function paintArrow(
  target: PaintTarget,
  from: Point,
  to: Point,
  rgb: [number, number, number],
  size: number,
): void {
  const width = clampBrush(size);
  strokeSegment(target, from, to, rgb, width, 0);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.max(width * 2.5, Math.min(width * 6, 8 + width * 2));
  const spread = Math.PI / 7;
  const left = { x: to.x - Math.cos(angle - spread) * head, y: to.y - Math.sin(angle - spread) * head };
  const right = { x: to.x - Math.cos(angle + spread) * head, y: to.y - Math.sin(angle + spread) * head };
  strokeSegment(target, to, left, rgb, width, 1);
  strokeSegment(target, to, right, rgb, width, 2);
}

/* ──────────────────────────────── text tool ──────────────────────────────── */

export const MIN_FONT = 8;
export const MAX_FONT = 400;

export function clampFont(size: number): number {
  if (!Number.isFinite(size)) return 16;
  return clamp(Math.round(size), MIN_FONT, MAX_FONT);
}

export interface TextRequest {
  text: string;
  /** Top-left of the text box, in image pixels (before clamping). */
  at: Point;
  fontSize: number;
  color: string;
}

/** A font-independent estimate: 0.6 em per average glyph, one line per `\n`. */
export function textBoxSize(text: string, fontSize: number): Size {
  const lines = text.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const font = clampFont(fontSize);
  return {
    width: Math.max(1, Math.ceil(longest * font * 0.6)) + font,
    height: Math.max(1, Math.ceil(lines.length * font * 1.25)),
  };
}

/** Keeps the text box inside the image, so text cannot be placed where it is invisible. */
export function clampTextPosition(request: TextRequest, bounds: Size): Point {
  const box = textBoxSize(request.text, request.fontSize);
  return {
    x: Math.round(clamp(request.at.x, 0, Math.max(0, bounds.width - Math.min(box.width, bounds.width)))),
    y: Math.round(clamp(request.at.y, 0, Math.max(0, bounds.height - Math.min(box.height, bounds.height)))),
  };
}

/** Font size, clamped, scaled by nothing else — the UI's number input feeds this. */
export function normaliseFont(size: number): number {
  return clampFont(size);
}

/** Largest dimension the editor will allocate for any operation, kept here for the UI copy. */
export const TOOL_MAX_DIMENSION = clampDimension(16384);

/**
 * Blends an anti-aliased text mask (produced by the canvas in the UI, tested here) into the
 * buffer. `mask` is one coverage byte per pixel, `maskWidth` per row.
 */
export function blendTextMask(
  target: PaintTarget,
  mask: Uint8ClampedArray,
  maskWidth: number,
  maskHeight: number,
  at: Point,
  rgb: [number, number, number],
): void {
  const ox = Math.round(at.x);
  const oy = Math.round(at.y);
  for (let y = 0; y < maskHeight; y++) {
    for (let x = 0; x < maskWidth; x++) {
      const coverage = mask[y * maskWidth + x] / 255;
      if (coverage > 0) blendAt(target, ox + x, oy + y, rgb, coverage);
    }
  }
}
