/**
 * Photo Editor — the ONE place the UI asks for pixel work (adjustments, filters, histogram).
 *
 * Every function takes and returns an ImageData-like `{ width, height, data }`. The
 * implementation below runs on the existing, tested `pixels.ts` plus a few small extras
 * (tint, hue, vibrance, invert, grayscale, noise, vignette). The dedicated engine
 * (`engine/`) plugs in HERE when it lands; the UI does not change.
 *
 * `scale` is the proxy factor used for live previews: spatial effects (blur radius) shrink
 * with it, so a preview on a downscaled copy looks like the full-resolution result.
 */
import type { PixelBuffer } from './types';
import {
  applyAdjustments, applyPreset, boxBlur, clamp255, isNeutral, luma, presetById, sharpen,
} from './pixels';

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

/** Hue rotation matrix (the one CSS `hue-rotate()` uses), degrees. */
function hueMatrix(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}

/**
 * The adjustment chain: the seven tone/colour operators of `pixels.ts` first (same order,
 * same maths), then tint, hue, vibrance, grayscale and invert. Alpha is never changed.
 */
export function adjust(src: PixelBuffer, p: AdjustParams): PixelBuffer {
  if (isNeutralAdjust(p)) return copy(src);
  const base = {
    exposure: p.exposure, brightness: p.brightness, contrast: p.contrast, highlights: p.highlights,
    shadows: p.shadows, temperature: p.temperature, saturation: p.saturation,
  };
  const out = isNeutral(base) ? copy(src) : applyAdjustments(src, base);
  if (!p.tint && !p.hue && !p.vibrance && !p.grayscale && !p.invert) return out;
  const d = out.data;
  const tint = (p.tint / 100) * 40;
  const m = p.hue ? hueMatrix(p.hue) : null;
  const vib = p.vibrance / 100;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let b = d[i + 2];
    if (tint) { g -= tint; r += tint / 2; b += tint / 2; }
    if (m) {
      const nr = m[0] * r + m[1] * g + m[2] * b;
      const ng = m[3] * r + m[4] * g + m[5] * b;
      const nb = m[6] * r + m[7] * g + m[8] * b;
      r = nr; g = ng; b = nb;
    }
    if (vib) {
      // Vibrance: saturate muted colours more than already-saturated ones.
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max > 0 ? (max - min) / max : 0;
      const k = 1 + vib * (1 - sat);
      const y = luma(r, g, b);
      r = y + (r - y) * k; g = y + (g - y) * k; b = y + (b - y) * k;
    }
    if (p.grayscale) { const y = luma(r, g, b); r = y; g = y; b = y; }
    if (p.invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
    d[i] = clamp255(r); d[i + 1] = clamp255(g); d[i + 2] = clamp255(b);
  }
  return out;
}

/* ──────────────────────────────── filters ──────────────────────────────── */

export type FilterId =
  | 'mono' | 'sepia' | 'vivid' | 'soft' | 'punch' | 'warm' | 'cool'
  | 'noir' | 'fade' | 'invert' | 'blur' | 'sharpen' | 'noise' | 'vignette';

/** One-click looks shown as thumbnails (quick editor + Filters panel). */
export const FILTER_IDS: FilterId[] = [
  'mono', 'sepia', 'vivid', 'warm', 'cool', 'soft', 'punch', 'noir', 'fade', 'invert',
  'blur', 'sharpen', 'noise', 'vignette',
];

/** Effects that have a strength in pixels/percent rather than a look. */
export function isSpatial(id: FilterId): boolean {
  return id === 'blur' || id === 'sharpen' || id === 'noise' || id === 'vignette';
}

/** Deterministic noise so a preview and the applied result match exactly. */
function noise(src: PixelBuffer, amount: number, seed = 1): PixelBuffer {
  const out = copy(src);
  let s = seed >>> 0 || 1;
  const k = (amount / 100) * 60;
  for (let i = 0; i < out.data.length; i += 4) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    const n = ((s / 4294967296) - 0.5) * 2 * k;
    out.data[i] = clamp255(out.data[i] + n);
    out.data[i + 1] = clamp255(out.data[i + 1] + n);
    out.data[i + 2] = clamp255(out.data[i + 2] + n);
  }
  return out;
}

/** Darkens the corners (positive) or lightens them (negative), smooth radial falloff. */
export function vignette(src: PixelBuffer, amount: number): PixelBuffer {
  const out = copy(src);
  const cx = src.width / 2;
  const cy = src.height / 2;
  const maxD = Math.hypot(cx, cy) || 1;
  const k = amount / 100;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const t = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / maxD;
      const f = Math.max(0, (t - 0.35) / 0.65);
      const w = f * f * (3 - 2 * f) * k;
      const i = (y * src.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = out.data[i + c];
        out.data[i + c] = clamp255(w >= 0 ? v * (1 - w * 0.85) : v + (255 - v) * -w * 0.85);
      }
    }
  }
  return out;
}

function mix(orig: PixelBuffer, done: PixelBuffer, amount: number): PixelBuffer {
  const k = Math.max(0, Math.min(1, amount / 100));
  if (k >= 1) return done;
  const out = copy(orig);
  for (let i = 0; i < out.data.length; i++) out.data[i] = orig.data[i] + (done.data[i] - orig.data[i]) * k;
  return out;
}

const NEUTRAL7 = { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, highlights: 0, shadows: 0 };

/**
 * One filter at `amount` (0..100). Looks blend with the original by the amount; spatial
 * effects use it as their strength. `scale` shrinks pixel radii for proxy previews.
 */
export function applyFilter(src: PixelBuffer, id: FilterId, amount: number, scale = 1): PixelBuffer {
  const a = Math.max(0, Math.min(100, amount));
  switch (id) {
    case 'blur': return boxBlur(src, Math.max(0, Math.round((a / 100) * 24 * scale)), 3);
    case 'sharpen': return sharpen(src, (a / 100) * 2.5);
    case 'noise': return noise(src, a);
    case 'vignette': return vignette(src, a);
    case 'invert': return mix(src, adjust(src, { ...NEUTRAL_ADJUST, invert: true }), a);
    case 'noir': {
      const g = adjust(src, { ...NEUTRAL_ADJUST, grayscale: true, contrast: 35, shadows: -20 });
      return mix(src, vignette(g, 45), a);
    }
    case 'fade': return mix(src, adjust(src, { ...NEUTRAL_ADJUST, contrast: -30, brightness: 14, saturation: -30, temperature: 8 }), a);
    default: {
      const preset = presetById(id);
      if (!preset) return copy(src);
      return mix(src, applyPreset(src, preset, NEUTRAL7), a);
    }
  }
}

/* ─────────────────────────────── histogram ─────────────────────────────── */

export interface Histogram { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array; max: number }

/** 256-bin RGB + luminance histogram of the opaque pixels (every `step`-th pixel). */
export function histogram(src: PixelBuffer, step = 1): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  const stride = Math.max(1, Math.floor(step)) * 4;
  const d = src.data;
  for (let i = 0; i < d.length; i += stride) {
    if (d[i + 3] < 8) continue;
    r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
    l[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
  }
  let max = 0;
  for (let i = 0; i < 256; i++) max = Math.max(max, r[i], g[i], b[i], l[i]);
  return { r, g, b, l, max };
}
