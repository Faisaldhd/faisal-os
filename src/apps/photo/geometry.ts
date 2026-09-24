/**
 * Photo Editor — the pure geometry layer.
 *
 * Crop rectangles, rotation bounds, resize maths and view transforms. All of it is
 * arithmetic on numbers: the canvas performs the actual rasterisation (drawImage), but every
 * coordinate it is handed is computed here, where it can be tested without a browser.
 */
import type { Point, Rect, Rotation, Size } from './types';

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/* ────────────────────────────────── crop ────────────────────────────────── */

/**
 * Turns a drag (which can start at any corner and cross over itself) into a rectangle that
 * lies inside the image: the two corners are sorted, then rounded, then clamped so
 * `x + w <= width` and `y + h <= height`, and degenerate rectangles are dropped (null).
 */
export function normaliseCrop(a: Point, b: Point, bounds: Size): Rect | null {
  const x1 = Math.round(Math.min(a.x, b.x));
  const y1 = Math.round(Math.min(a.y, b.y));
  const x2 = Math.round(Math.max(a.x, b.x));
  const y2 = Math.round(Math.max(a.y, b.y));
  const x = clamp(x1, 0, Math.max(0, bounds.width));
  const y = clamp(y1, 0, Math.max(0, bounds.height));
  const right = clamp(x2, 0, Math.max(0, bounds.width));
  const bottom = clamp(y2, 0, Math.max(0, bounds.height));
  const w = right - x;
  const h = bottom - y;
  if (w < 1 || h < 1) return null;
  return { x, y, w, h };
}

/**
 * Fits the largest `aspect`-shaped rectangle centred on `rect` and inside the image.
 * Used when the user picks 16:9 (etc.) after an arbitrary drag: the crop keeps its centre
 * instead of jumping to a corner. Returns null when no positive rectangle fits.
 */
export function applyAspect(rect: Rect, aspect: number, bounds: Size): Rect | null {
  if (!(aspect > 0) || bounds.width < 1 || bounds.height < 1) return null;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  // Start from the dragged area, then grow to the aspect while staying inside the image.
  let w = rect.w;
  let h = rect.h;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  // Scale down (never up) to fit the image, preserving the aspect exactly.
  const fit = Math.min(bounds.width / w, bounds.height / h, 1);
  w = Math.round(w * fit);
  h = Math.round(h * fit);
  if (w < 1 || h < 1) return null;
  const x = Math.round(clamp(cx - w / 2, 0, bounds.width - w));
  const y = Math.round(clamp(cy - h / 2, 0, bounds.height - h));
  return { x, y, w, h };
}

/** Pixel indices covered by a crop rectangle, guaranteed inside the buffer. */
export function cropRegion(rect: Rect, bounds: Size): Rect {
  const x = Math.round(clamp(rect.x, 0, Math.max(0, bounds.width - 1)));
  const y = Math.round(clamp(rect.y, 0, Math.max(0, bounds.height - 1)));
  const w = Math.round(clamp(rect.w, 1, bounds.width - x));
  const h = Math.round(clamp(rect.h, 1, bounds.height - y));
  return { x, y, w, h };
}

/* ──────────────────────────────── rotation ──────────────────────────────── */

/** Normalises a rotation into `quarter ∈ {0,1,2,3}` and `free ∈ (-180, 180]`. */
export function normaliseRotation(rotation: Rotation): Rotation {
  let quarter = ((Math.round(rotation.quarter) % 4) + 4) % 4;
  let free = rotation.free % 360;
  if (free > 180) free -= 360;
  if (free <= -180) free += 360;
  // A free angle that lands exactly on a right angle is folded into the quarter turn, so
  // "rotate 90°" and "drag to 90°" produce identical output (and identical history).
  for (const candidate of [90, -90, 180, -180]) {
    if (Math.abs(free - candidate) < 1e-9) {
      quarter = ((quarter + (free > 0 ? 1 : 3) * (Math.abs(candidate) === 180 ? 2 : 1)) % 4 + 4) % 4;
      free = 0;
      break;
    }
  }
  return { quarter, free };
}

/** Clockwise turns as degrees, 0/90/180/270. */
export function quarterDegrees(quarter: number): number {
  return (((Math.round(quarter) % 4) + 4) % 4) * 90;
}

/** The total clockwise angle in degrees. */
export function totalDegrees(rotation: Rotation): number {
  const r = normaliseRotation(rotation);
  return quarterDegrees(r.quarter) + r.free;
}

export function degreesToRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * The smallest box that contains the whole image once the free angle is applied.
 *
 * `Math.cos(π/2)` is 6.1e-17 rather than 0, so an exact quarter turn would compute 50.0000001
 * and `Math.ceil` would then add a whole pixel. Values within a millionth of an integer are
 * snapped before rounding, which is what makes "rotate 90°" return the same box as "swap the
 * sides" instead of one pixel more.
 */
export function rotatedBounds(size: Size, freeAngleDeg: number): Size {
  const rad = degreesToRadians(freeAngleDeg);
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const snap = (v: number) => {
    const rounded = Math.round(v);
    return Math.abs(v - rounded) < 1e-6 ? rounded : v;
  };
  return {
    width: Math.max(1, Math.ceil(snap(size.width * cos + size.height * sin))),
    height: Math.max(1, Math.ceil(snap(size.width * sin + size.height * cos))),
  };
}

/** Maps a point in `from` pixel space to `to` pixel space (used for crop/move drags). */
export function scalePoint(p: Point, from: Size, to: Size): Point {
  if (!from.width || !from.height) return { x: 0, y: 0 };
  return { x: (p.x * to.width) / from.width, y: (p.y * to.height) / from.height };
}

/* ───────────────────────────────── resize ───────────────────────────────── */

export const MIN_DIMENSION = 1;
export const MAX_DIMENSION = 16384;

/** One side of a resize, clamped into a range the canvas can actually allocate. */
export function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return MIN_DIMENSION;
  return Math.round(clamp(value, MIN_DIMENSION, MAX_DIMENSION));
}

/** The other side under a locked aspect ratio, from the side the user typed. */
export function lockedOtherSide(changed: 'width' | 'height', value: number, size: Size): number {
  if (size.width < 1 || size.height < 1) return clampDimension(value);
  const ratio = size.width / size.height;
  return clampDimension(changed === 'width' ? value / ratio : value * ratio);
}

/** A percentage resize about the current size, both sides clamped. */
export function resizeByPercent(size: Size, percent: number): Size {
  const f = Math.max(0.01, percent / 100);
  return { width: clampDimension(size.width * f), height: clampDimension(size.height * f) };
}

/** The scale factor a fit-to-view produces; never upscales past 1. */
export function fitScale(image: Size, viewport: Size, padding = 24): number {
  if (image.width < 1 || image.height < 1) return 1;
  const availW = Math.max(1, viewport.width - padding);
  const availH = Math.max(1, viewport.height - padding);
  return Math.min(1, availW / image.width, availH / image.height);
}

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return clamp(zoom, ZOOM_MIN, ZOOM_MAX);
}

/** Zooms one step (a factor of 1.25) from the current level, then clamps. */
export function zoomStep(zoom: number, direction: 1 | -1): number {
  return clampZoom(zoom * (direction > 0 ? 1.25 : 1 / 1.25));
}

/** A pointer position relative to the viewport → image pixel coordinates at `zoom`. */
export function viewToImage(p: Point, zoom: number): Point {
  const z = zoom > 0 ? zoom : 1;
  return { x: p.x / z, y: p.y / z };
}

/** Image pixel coordinates → a position inside the zoomed viewport. */
export function imageToView(p: Point, zoom: number): Point {
  const z = zoom > 0 ? zoom : 1;
  return { x: p.x * z, y: p.y * z };
}

/* ──────────────────────────────── rotation-free ops ──────────────────────────────── */

/** Fill colour for the corners a free-angle rotation leaves empty: fully transparent. */
export const ROTATION_FILL: [number, number, number, number] = [0, 0, 0, 0];

/** The image-space rectangle a quarter turn moves, expressed as the new size. */
export function quarterTurnSize(size: Size, quarter: number): Size {
  const q = ((Math.round(quarter) % 4) + 4) % 4;
  return q === 1 || q === 3 ? { width: size.height, height: size.width } : { ...size };
}

/** True when the buffer and a requested size agree (so a resize can be skipped). */
export function sameSize(a: Size, b: Size): boolean {
  return Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);
}
