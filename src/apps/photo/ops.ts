/**
 * Photo Editor — the ONE place the UI asks for pixel work (adjustments, filters, histogram).
 *
 * Every function takes and returns an ImageData-like `{ width, height, data }`. The work is
 * done by the pure engine in `engine/` (LUT adjustment pipeline, filters and looks, histogram,
 * Web Worker RPC). The UI only knows this file, so the engine can change without touching it.
 *
 * `scale` is the proxy factor used for live previews: spatial effects (blur radius) shrink
 * with it, so a preview on a downscaled copy looks like the full-resolution result.
 */
import type { PixelBuffer } from './types';
import * as engine from './engine';

export type AdjustKey =
  | 'exposure' | 'brightness' | 'contrast' | 'highlights' | 'shadows'
  | 'temperature' | 'tint' | 'hue' | 'saturation' | 'vibrance';

export interface AdjustParams {
  exposure: number; brightness: number; contrast: number; highlights: number; shadows: number;
  temperature: number; tint: number; hue: number; saturation: number; vibrance: number;
  invert: boolean; grayscale: boolean;
}

/** Slider groups in display order; every slider is −100..100 except hue (−180..180). */
export const ADJUST_GROUPS: { id: 'light' | 'color'; keys: AdjustKey[] }[] = [
  { id: 'light', keys: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows'] },
  { id: 'color', keys: ['temperature', 'tint', 'hue', 'saturation', 'vibrance'] },
];

export function adjustRange(key: AdjustKey): [number, number] {
  return key === 'hue' ? [-180, 180] : [-100, 100];
}

export const NEUTRAL_ADJUST: AdjustParams = {
  exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0,
  temperature: 0, tint: 0, hue: 0, saturation: 0, vibrance: 0, invert: false, grayscale: false,
};

export function isNeutralAdjust(p: AdjustParams): boolean {
  return (Object.keys(NEUTRAL_ADJUST) as (keyof AdjustParams)[]).every((k) => !p[k]);
}

function copy(buf: PixelBuffer): PixelBuffer {
  return { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
}

/** The adjustment chain (engine LUT pipeline). Alpha is never changed. */
export function adjust(src: PixelBuffer, p: AdjustParams): PixelBuffer {
  if (isNeutralAdjust(p)) return copy(src);
  return engine.adjust(src, { ...p });
}

/* ──────────────────────────────── filters ──────────────────────────────── */

/**
 * One-click looks and effects, in display order. The owner's three (Grayscale, Sepia, Blur)
 * come first, then the named looks, then the other effects.
 */
export const FILTER_IDS = [
  'grayscale', 'sepia', 'blur', 'warm', 'cool', 'vivid', 'vintage', 'golden', 'desert', 'noir',
  'fade', 'soft', 'punch', 'invert', 'sharpen', 'noise', 'vignette', 'pixelate', 'posterize',
  'emboss', 'edges',
] as const;
export type FilterId = (typeof FILTER_IDS)[number];

/** Effects that have a strength in pixels/percent rather than a look. */
export function isSpatial(id: FilterId): boolean {
  return engine.isSpatial(id);
}

/** One filter at `amount` (0..100); `scale` shrinks pixel radii for proxy previews. */
export function applyFilter(src: PixelBuffer, id: FilterId, amount: number, scale = 1): PixelBuffer {
  return engine.applyFilter(src, id, amount, scale);
}

/**
 * The same two operations off the main thread (Web Worker, with a synchronous fallback), used
 * for full-resolution "Apply" so a 12 MP image does not freeze the window.
 */
export async function adjustAsync(src: PixelBuffer, p: AdjustParams): Promise<PixelBuffer> {
  if (isNeutralAdjust(p)) return copy(src);
  const out = await engine.runInWorker('adjust', src, { ...p });
  return { width: out.width, height: out.height, data: out.data };
}

export async function filterAsync(src: PixelBuffer, id: FilterId, amount: number): Promise<PixelBuffer> {
  const out = await engine.runInWorker('filter', src, { id, amount, scale: 1 });
  return { width: out.width, height: out.height, data: out.data };
}

/* ─────────────────────────────── histogram ─────────────────────────────── */

export interface Histogram { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array; max: number }

/** 256-bin RGB + luminance histogram of the opaque pixels (every `step`-th pixel). */
export function histogram(src: PixelBuffer, step = 1): Histogram {
  return engine.histogram(src, step);
}
