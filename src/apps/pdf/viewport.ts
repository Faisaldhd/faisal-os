/**
 * PDF app — the geometry of the page view (هندسة عرض الصفحات), with no DOM and no pdf.js.
 *
 * The viewer lays out every page from these numbers, converts a tap on the screen into a point
 * in PDF user space (where annotations and added text live) and decides which pages are near
 * enough to the viewport to deserve a canvas. The transform is the same one pdf.js builds in
 * `PageViewport`, so a point converted here lands exactly where pdf.js painted it.
 */

/** A page as pdf.js describes it: the visible box (crop ∩ media) and the page's own rotation. */
export interface PageGeom {
  /** [x0, y0, x1, y1] in PDF user space. */
  view: readonly [number, number, number, number];
  /** The page's /Rotate, one of 0/90/180/270. */
  rotate: number;
}

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; width: number; height: number }

/** 25 % … 400 %. The zoom box accepts anything in between; the buttons walk these steps. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

/** CSS pixels per PDF point at 100 % — pdf.js' own `PixelsPerInch.PDF_TO_CSS_UNITS` (96 / 72). */
export const CSS_UNITS = 96 / 72;

export type ZoomMode = 'fitWidth' | 'fitPage' | 'custom';

export function normalizeAngle(deg: number): number {
  const n = Math.round(Number.isFinite(deg) ? deg : 0) % 360;
  const pos = n < 0 ? n + 360 : n;
  return Math.round(pos / 90) * 90 % 360;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** The next step up (`dir` 1) or down (-1) from `current`, never stuck on the same value. */
export function nextZoom(current: number, dir: 1 | -1): number {
  const eps = 0.001;
  if (dir > 0) return ZOOM_STEPS.find((step) => step > current + eps) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find((step) => step < current - eps) ?? ZOOM_MIN;
}

/** A zoom typed by the owner ("150", "150%", "١٥٠") → a factor, or null when it is not a number. */
export function parseZoomInput(text: string): number | null {
  const digits = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[%٪\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  return clampZoom(Number(digits) / 100);
}

/** Total rotation shown on screen: the page's own /Rotate plus the view rotation. */
export function totalRotation(geom: PageGeom, viewRotation: number): number {
  return normalizeAngle(geom.rotate + viewRotation);
}

/** The on-screen size (CSS px, unrounded) of a page at `zoom`, turned by the view rotation. */
export function pageSize(geom: PageGeom, viewRotation: number, zoom: number): { width: number; height: number } {
  const [x0, y0, x1, y1] = geom.view;
  const w = Math.abs(x1 - x0) * zoom * CSS_UNITS;
  const h = Math.abs(y1 - y0) * zoom * CSS_UNITS;
  return totalRotation(geom, viewRotation) % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
}

/**
 * The zoom that makes a page fill the available width (`fitWidth`) or fit whole inside the
 * available box (`fitPage`). `gutter` is the space kept around the page on each side.
 *
 * `columns` is 2 in the two-page spread: the SAME page width is then shared by both pages of the
 * spread (one outer gutter each plus one between them), and the height is unchanged, so the pairs
 * and the lone cover that follows them all stay at one zoom instead of jumping per row.
 */
export function fitZoom(
  mode: 'fitWidth' | 'fitPage',
  geom: PageGeom,
  viewRotation: number,
  avail: { width: number; height: number },
  gutter = 16,
  columns = 1,
): number {
  const unit = pageSize(geom, viewRotation, 1);
  if (unit.width <= 0 || unit.height <= 0) return 1;
  const cols = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
  const byWidth = Math.max(avail.width - 2 * gutter * cols, 40) / (unit.width * cols);
  if (mode === 'fitWidth') return clampZoom(byWidth);
  const byHeight = Math.max(avail.height - 2 * gutter, 40) / unit.height;
  return clampZoom(Math.min(byWidth, byHeight));
}

/**
 * pdf.js' viewport transform for a page at a CSS scale (`zoom * CSS_UNITS`) and a total
 * rotation: `[a, b, c, d, e, f]` mapping PDF user space to CSS pixels inside the page box
 * (origin top-left, y down). Mirrors `PageViewport`'s constructor, offsets 0, no flip.
 */
export function viewportTransform(geom: PageGeom, rotation: number, scale: number): [number, number, number, number, number, number] {
  const [x0, y0, x1, y1] = geom.view;
  const cx = (x1 + x0) / 2;
  const cy = (y1 + y0) / 2;
  let a: number; let b: number; let c: number; let d: number;
  switch (normalizeAngle(rotation)) {
    case 180: a = -1; b = 0; c = 0; d = 1; break;
    case 90: a = 0; b = 1; c = 1; d = 0; break;
    case 270: a = 0; b = -1; c = -1; d = 0; break;
    default: a = 1; b = 0; c = 0; d = -1;
  }
  let offX: number; let offY: number;
  if (a === 0) {
    offX = Math.abs(cy - y0) * scale;
    offY = Math.abs(cx - x0) * scale;
  } else {
    offX = Math.abs(cx - x0) * scale;
    offY = Math.abs(cy - y0) * scale;
  }
  return [
    a * scale, b * scale, c * scale, d * scale,
    offX - a * scale * cx - c * scale * cy,
    offY - b * scale * cx - d * scale * cy,
  ];
}

export function toView(t: readonly number[], x: number, y: number): Point {
  return { x: x * t[0] + y * t[2] + t[4], y: x * t[1] + y * t[3] + t[5] };
}

export function toPdf(t: readonly number[], x: number, y: number): Point {
  const det = t[0] * t[3] - t[1] * t[2];
  return {
    x: (x * t[3] - y * t[2] + t[2] * t[5] - t[4] * t[3]) / det,
    y: (-x * t[1] + y * t[0] + t[4] * t[1] - t[5] * t[0]) / det,
  };
}

/** Two corners on screen → the normalized box in PDF space (rotation-safe). */
export function boxToPdf(t: readonly number[], a: Point, b: Point): Box {
  const p = toPdf(t, a.x, a.y);
  const q = toPdf(t, b.x, b.y);
  const x = Math.min(p.x, q.x);
  const y = Math.min(p.y, q.y);
  return { x: round2(x), y: round2(y), width: round2(Math.abs(p.x - q.x)), height: round2(Math.abs(p.y - q.y)) };
}

/** A PDF-space box → its on-screen box (CSS px inside the page), whatever the rotation. */
export function boxToView(t: readonly number[], box: Box): Box {
  const p = toView(t, box.x, box.y);
  const q = toView(t, box.x + box.width, box.y + box.height);
  return {
    x: Math.min(p.x, q.x), y: Math.min(p.y, q.y),
    width: Math.abs(p.x - q.x), height: Math.abs(p.y - q.y),
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Index of the page whose box contains `y` (or the nearest one), by binary search. */
export function pageAtOffset(tops: readonly number[], heights: readonly number[], y: number): number {
  if (!tops.length) return -1;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  // In the gap below page `lo`: the next page is closer when y is past the middle of the gap.
  if (lo + 1 < tops.length && y > tops[lo] + heights[lo]) {
    const gapMid = (tops[lo] + heights[lo] + tops[lo + 1]) / 2;
    if (y >= gapMid) return lo + 1;
  }
  return lo;
}

/** First and last page index that intersect [top, bottom]; [-1, -1] when none do. */
export function visibleRange(tops: readonly number[], heights: readonly number[], top: number, bottom: number): [number, number] {
  if (!tops.length || bottom < top) return [-1, -1];
  let first = pageAtOffset(tops, heights, top);
  if (first < 0) return [-1, -1];
  if (tops[first] + heights[first] < top && first + 1 < tops.length) first++;
  let last = first;
  while (last + 1 < tops.length && tops[last + 1] <= bottom) last++;
  return [first, last];
}

/**
 * The pages that may hold a canvas: the visible ones plus `extra` on each side, ordered so the
 * page nearest the centre of the viewport is drawn first.
 */
export function renderOrder(first: number, last: number, count: number, extra = 1, center = Math.round((first + last) / 2)): number[] {
  if (first < 0 || count <= 0) return [];
  const lo = Math.max(0, first - extra);
  const hi = Math.min(count - 1, last + extra);
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
}

/**
 * Device pixels per CSS pixel for one page canvas: the screen's density, lowered only when the
 * canvas would pass `maxPixels` (a browser canvas cap, and the memory guard of the viewer).
 */
export function outputScale(cssWidth: number, cssHeight: number, dpr: number, maxPixels = 16_777_216): number {
  const want = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const area = Math.max(1, cssWidth * cssHeight);
  const limit = Math.sqrt(maxPixels / area);
  return Math.max(0.25, Math.min(want, limit));
}

/** The scroll offset that keeps the same point of the document under the anchor after a zoom. */
export function anchoredScroll(oldScroll: number, anchor: number, ratio: number): number {
  return Math.max(0, (oldScroll + anchor) * ratio - anchor);
}

/**
 * The boxes a text selection covers (one per span, often overlapping) → one box per line:
 * boxes whose vertical middles are within half a line of each other and that touch or overlap
 * horizontally are merged.
 */
export function mergeLineBoxes(boxes: readonly Box[]): Box[] {
  const sorted = [...boxes].filter((b) => b.width > 0 && b.height > 0)
    .sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2) || a.x - b.x);
  const out: Box[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    const sameLine = last && Math.abs((last.y + last.height / 2) - (b.y + b.height / 2)) < Math.min(last.height, b.height) / 2;
    const touches = last && b.x <= last.x + last.width + Math.max(2, b.height * 0.6) && b.x + b.width >= last.x - Math.max(2, b.height * 0.6);
    if (last && sameLine && touches) {
      const x = Math.min(last.x, b.x);
      const y = Math.min(last.y, b.y);
      last.width = Math.max(last.x + last.width, b.x + b.width) - x;
      last.height = Math.max(last.y + last.height, b.y + b.height) - y;
      last.x = x;
      last.y = y;
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

/**
 * Screen boxes on one page → PDF QuadPoints (8 numbers per box: top-left, top-right,
 * bottom-left, bottom-right, as readers expect for text markup), plus the bounding rect.
 */
export function quadsFromBoxes(t: readonly number[], boxes: readonly Box[]): { quads: number[]; rect: Box } | null {
  const lines = mergeLineBoxes(boxes);
  if (!lines.length) return null;
  const quads: number[] = [];
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const b of lines) {
    const p = boxToPdf(t, { x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height });
    const top = p.y + p.height;
    quads.push(p.x, top, p.x + p.width, top, p.x, p.y, p.x + p.width, p.y);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.width); y1 = Math.max(y1, top);
  }
  return { quads, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

/** Keeps a box (CSS px) inside a page of `width` × `height`, shrinking it only if it is larger. */
export function clampBox(box: Box, width: number, height: number, min = 8): Box {
  const w = Math.max(min, Math.min(box.width, width));
  const h = Math.max(min, Math.min(box.height, height));
  return {
    x: Math.min(Math.max(0, box.x), Math.max(0, width - w)),
    y: Math.min(Math.max(0, box.y), Math.max(0, height - h)),
    width: w,
    height: h,
  };
}

/** The bounding box of freehand strokes, padded; null when there is nothing drawn. */
export function strokesBounds(strokes: readonly (readonly Point[])[], pad = 0): Box | null {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const s of strokes) for (const p of s) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad };
}
