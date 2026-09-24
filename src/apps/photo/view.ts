/**
 * Photo Editor — the viewport maths: zoom about a point, fit-and-centre, screen ↔ image
 * mapping, pinch gestures, new-canvas presets, export sizing and text direction. Pure numbers,
 * unit tested; the canvas and DOM only consume the results.
 */
import type { Point, Size } from './types';
import { clamp, clampDimension } from './geometry';

export interface View {
  zoom: number;
  /** Where image pixel (0, 0) sits inside the viewport, in CSS pixels. */
  panX: number;
  panY: number;
}

export const VIEW_ZOOM_MIN = 0.02;
export const VIEW_ZOOM_MAX = 32;

export function clampViewZoom(z: number): number {
  return Number.isFinite(z) ? clamp(z, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX) : 1;
}

/** Fits the image inside the viewport (never above 100%) and centres it. */
export function fitView(image: Size, viewport: Size, padding = 32): View {
  const availW = Math.max(1, viewport.width - padding * 2);
  const availH = Math.max(1, viewport.height - padding * 2);
  const zoom = clampViewZoom(Math.min(1, availW / Math.max(1, image.width), availH / Math.max(1, image.height)));
  return centreAt(image, viewport, zoom);
}

export function centreAt(image: Size, viewport: Size, zoom: number): View {
  return {
    zoom,
    panX: Math.round((viewport.width - image.width * zoom) / 2),
    panY: Math.round((viewport.height - image.height * zoom) / 2),
  };
}

export function screenToImage(v: View, p: Point): Point {
  return { x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom };
}

export function imageToScreen(v: View, p: Point): Point {
  return { x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY };
}

/** Zooms to `zoom` keeping the image point under `anchor` (viewport coordinates) still. */
export function zoomAbout(v: View, zoom: number, anchor: Point): View {
  const z = clampViewZoom(zoom);
  const img = screenToImage(v, anchor);
  return { zoom: z, panX: anchor.x - img.x * z, panY: anchor.y - img.y * z };
}

/** The next zoom stop up or down (the usual 1-2-3-5 style ladder). */
const STOPS = [0.02, 0.05, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
export function zoomStop(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return STOPS.find((s) => s > zoom * 1.001) ?? VIEW_ZOOM_MAX;
  for (let i = STOPS.length - 1; i >= 0; i--) if (STOPS[i] < zoom / 1.001) return STOPS[i];
  return VIEW_ZOOM_MIN;
}

/** A wheel delta → a multiplicative zoom factor (smooth for trackpads, stepped for mice). */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-clamp(px, -200, 200) * 0.0025);
}

export interface PinchState { a: Point; b: Point }

/**
 * Two fingers moved from `start` to `now`: zoom by the distance ratio about the midpoint and
 * pan by the midpoint's travel — the usual photo-app gesture.
 */
export function pinchView(base: View, start: PinchState, now: PinchState): View {
  const d0 = Math.hypot(start.b.x - start.a.x, start.b.y - start.a.y) || 1;
  const d1 = Math.hypot(now.b.x - now.a.x, now.b.y - now.a.y) || 1;
  const m0 = { x: (start.a.x + start.b.x) / 2, y: (start.a.y + start.b.y) / 2 };
  const m1 = { x: (now.a.x + now.b.x) / 2, y: (now.a.y + now.b.y) / 2 };
  const zoomed = zoomAbout(base, base.zoom * (d1 / d0), m0);
  return { ...zoomed, panX: zoomed.panX + (m1.x - m0.x), panY: zoomed.panY + (m1.y - m0.y) };
}

/** Above this zoom individual pixels are drawn as crisp squares. */
export const PIXELATED_ABOVE = 4;

/* ─────────────────────────── new canvas & export ─────────────────────────── */

export interface CanvasPreset { id: string; width: number; height: number }

/** New-canvas presets; A4 is at 300 dpi (2480 × 3508). Labels live in strings.ts. */
export const CANVAS_PRESETS: CanvasPreset[] = [
  { id: 'square', width: 1080, height: 1080 },
  { id: 'story', width: 1080, height: 1920 },
  { id: 'hd', width: 1920, height: 1080 },
  { id: 'a4', width: 2480, height: 3508 },
  { id: 'web', width: 1280, height: 720 },
];

/** An export size from a percentage, both sides clamped and at least 1px. */
export function exportSize(image: Size, percent: number): Size {
  const f = clamp(Number.isFinite(percent) ? percent : 100, 1, 400) / 100;
  return { width: clampDimension(image.width * f), height: clampDimension(image.height * f) };
}

/** Human file size for the export preview. */
export function formatSize(bytes: number, locale: 'ar' | 'en'): string {
  const unit = locale === 'ar' ? { b: 'بايت', kb: 'ك.ب', mb: 'م.ب' } : { b: 'B', kb: 'KB', mb: 'MB' };
  if (bytes < 1024) return `${bytes} ${unit.b}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} ${unit.kb}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${unit.mb}`;
}

/* ─────────────────────────────── text ─────────────────────────────── */

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/** The first strong character decides (the Unicode "auto" rule, simplified). */
export function detectDirection(text: string): 'rtl' | 'ltr' {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (LTR_CHAR.test(ch)) return 'ltr';
  }
  return 'ltr';
}

/**
 * The left x of a text line of `width` for an anchor at x = 0, given the alignment and the
 * direction ("start" is the right edge in RTL).
 */
export function lineOffset(width: number, align: 'start' | 'center' | 'end', dir: 'rtl' | 'ltr'): number {
  if (align === 'center') return -width / 2;
  const right = (align === 'start') === (dir === 'rtl');
  return right ? -width : 0;
}

/** Line height used by the text renderer, measure and hit-test alike. */
export const LINE_HEIGHT = 1.25;

/* ─────────────────────────────── crop box ─────────────────────────────── */

export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';
type Box = { x: number; y: number; w: number; h: number };

/**
 * Drags one handle of the crop box by (dx, dy) image pixels. The opposite edge stays put,
 * the box never leaves the image and never gets smaller than `min`. With an `aspect`, the
 * other side follows (edges keep the box centred on the other axis, corners keep the
 * opposite corner anchored), and the result is shrunk until it fits.
 */
export function dragCrop(start: Box, handle: CropHandle, dx: number, dy: number, aspect: number | null, bounds: Size, min = 8): Box {
  if (handle === 'move') {
    return {
      x: Math.round(clamp(start.x + dx, 0, bounds.width - start.w)),
      y: Math.round(clamp(start.y + dy, 0, bounds.height - start.h)),
      w: start.w,
      h: start.h,
    };
  }
  let l = start.x;
  let t = start.y;
  let r = start.x + start.w;
  let b = start.y + start.h;
  if (handle.includes('w')) l = clamp(l + dx, 0, r - min);
  if (handle.includes('e')) r = clamp(r + dx, l + min, bounds.width);
  if (handle.includes('n')) t = clamp(t + dy, 0, b - min);
  if (handle.includes('s')) b = clamp(b + dy, t + min, bounds.height);
  if (aspect && aspect > 0) {
    let w = r - l;
    let h = b - t;
    if (handle === 'n' || handle === 's') w = h * aspect;
    else if (handle === 'e' || handle === 'w') h = w / aspect;
    else if (w / h > aspect) h = w / aspect;
    else w = h * aspect;
    // Anchor: the opposite edge/corner, or the centre on the free axis.
    const ax = handle.includes('w') ? r : handle.includes('e') ? l : (l + r) / 2;
    const ay = handle.includes('n') ? b : handle.includes('s') ? t : (t + b) / 2;
    const maxW = handle.includes('w') ? ax : handle.includes('e') ? bounds.width - ax : 2 * Math.min(ax, bounds.width - ax);
    const maxH = handle.includes('n') ? ay : handle.includes('s') ? bounds.height - ay : 2 * Math.min(ay, bounds.height - ay);
    const fit = Math.min(1, maxW / w, maxH / h);
    w *= fit;
    h *= fit;
    l = handle.includes('w') ? ax - w : handle.includes('e') ? ax : ax - w / 2;
    t = handle.includes('n') ? ay - h : handle.includes('s') ? ay : ay - h / 2;
    r = l + w;
    b = t + h;
  }
  const x = Math.round(l);
  const y = Math.round(t);
  return { x, y, w: Math.max(1, Math.round(r) - x), h: Math.max(1, Math.round(b) - y) };
}

/** The largest box of `aspect` centred in the image (what picking a ratio starts from). */
export function centredAspect(bounds: Size, aspect: number | null): Box {
  if (!aspect) return { x: 0, y: 0, w: bounds.width, h: bounds.height };
  let w = bounds.width;
  let h = w / aspect;
  if (h > bounds.height) { h = bounds.height; w = h * aspect; }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  return { x: Math.round((bounds.width - w) / 2), y: Math.round((bounds.height - h) / 2), w, h };
}

/** Crop ratio presets: the owner's four first (free, 1:1, 16:9, 4:3), then the rest. */
export const CROP_RATIOS: { id: string; value: number | null }[] = [
  { id: 'free', value: null },
  { id: '1:1', value: 1 },
  { id: '16:9', value: 16 / 9 },
  { id: '4:3', value: 4 / 3 },
  { id: '3:2', value: 3 / 2 },
  { id: '9:16', value: 9 / 16 },
];
