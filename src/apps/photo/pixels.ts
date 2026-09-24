/**
 * Photo Editor — the pure pixel layer.
 *
 * Everything here is plain arithmetic on an RGBA buffer: no canvas, no DOM, no image
 * decoding. That is deliberate — the maths behind the adjustments and filters is the part
 * that can be wrong in ways the eye misses (a channel swap, a clamp that clips at 255
 * instead of 255.999, a highlight curve that does nothing), so it is the part that is unit
 * tested. The canvas only ever calls into this file.
 */
import type { PixelBuffer } from './types';

/** An 8-bit sample is an integer in [0, 255]; this is the only clamp the pixel layer uses. */
export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** A signed adjustment is a number in [-100, 100]; anything else is pulled into range. */
export function clampSigned100(v: number): number {
  return v < -100 ? -100 : v > 100 ? 100 : v;
}

/** True when every sample of a row/column range is inside the buffer. */
export function isInside(buf: Pick<PixelBuffer, 'width' | 'height'>, x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < buf.width && y < buf.height;
}

export function createBuffer(width: number, height: number): PixelBuffer {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

export function cloneBuffer(buf: PixelBuffer): PixelBuffer {
  return { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
}

/** Exactly how many bytes a buffer holds. Used by the history stack's memory budget. */
export function bufferBytes(buf: PixelBuffer): number {
  return buf.data.length;
}

/**
 * Rec. 601 luma — the same weights the CSS `saturate()`/`grayscale()` filters use, so a
 * saturation change here matches what the user already expects from CSS filters.
 */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 4×4 ordered Bayer matrix, normalised to (0, 1). Breaks up the banding a nearest-round does. */
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

/** `Math.round` is biased (and on .5 rounds up): the ordered dither keeps the average honest. */
export function ditherRound(v: number, x: number, y: number): number {
  return clamp255(Math.floor(v + BAYER_4[y & 3][x & 3]));
}

/* ─────────────────────────────── adjustments ─────────────────────────────── */

/**
 * The order is fixed and documented because it is observable: exposure is a light
 * multiplier applied first (like a camera), then brightness/contrast move the midtones,
 * then the highlight/shadow curves roll the ends, and only then does temperature colour the
 * result. Saturation runs last, after the tone map, so a saturation boost does not
 * re-multiply the white balance.
 */
export const ADJUSTMENT_ORDER = [
  'exposure',
  'brightness',
  'contrast',
  'highlights',
  'shadows',
  'temperature',
  'saturation',
] as const;

/**
 * Light multiplier for `exposure` in [-100, 100]: -100 → ×0.25, 0 → ×1, +100 → ×4.
 * Multiplicative (not additive) so +1 EV really is a doubling of light at every level.
 */
export function exposureFactor(exposure: number): number {
  const v = clampSigned100(exposure);
  return v >= 0 ? 1 + (v / 100) * 3 : 1 / (1 + (-v / 100) * 3);
}

/** Luminance scale for `saturation`: -100 → 0 (greyscale), 0 → 1, +100 → 2. */
export function saturationFactor(saturation: number): number {
  const v = clampSigned100(saturation);
  return v >= 0 ? 1 + v / 100 : 1 + v / 100;
}

/** Contrast slope around the 128 midpoint: -100 → 0 (flat grey), +100 → 4. */
export function contrastSlope(contrast: number): number {
  const v = clampSigned100(contrast);
  return v >= 0 ? 1 + (v / 100) * 3 : 1 + v / 100;
}

/** White balance shift per degree of `temperature` in [-100, 100], applied to R and B. */
export const TEMPERATURE_STRENGTH = 0.6;

/**
 * One pixel through the whole chain. Returns [r, g, b] as floats (the caller clamps),
 * alpha is never touched by an adjustment.
 */
export function applyAdjustmentsToPixel(
  r0: number,
  g0: number,
  b0: number,
  adj: Record<string, number>,
): [number, number, number] {
  let r = r0;
  let g = g0;
  let b = b0;

  // 1. exposure — a camera-like light multiplier.
  const ef = exposureFactor(adj.exposure ?? 0);
  if (ef !== 1) { r *= ef; g *= ef; b *= ef; }

  // 2. brightness — a constant offset in 8-bit levels (−100 → −100, +100 → +100).
  const bright = clampSigned100(adj.brightness ?? 0);
  if (bright !== 0) { r += bright; g += bright; b += bright; }

  // 3. contrast — a slope around the 128 midpoint.
  const slope = contrastSlope(adj.contrast ?? 0);
  if (slope !== 1) {
    r = (r - 128) * slope + 128;
    g = (g - 128) * slope + 128;
    b = (b - 128) * slope + 128;
  }

  // 4/5. highlight and shadow rolls — luminance-driven, so hues survive the roll-off.
  // The weight is a linear ramp that is 0 at the opposite end and 1 at its own end, and the
  // offset is a uniform level shift: it can never invert a colour, and a weight of 0 means
  // exactly no change (which is what the unit tests pin).
  const hi = clampSigned100(adj.highlights ?? 0);
  const sh = clampSigned100(adj.shadows ?? 0);
  if (hi !== 0 || sh !== 0) {
    const yn = luma(r, g, b) / 255;
    const weightHi = Math.min(1, Math.max(0, (yn - 0.5) * 2));
    const weightSh = Math.min(1, Math.max(0, (0.5 - yn) * 2));
    const delta = (hi / 100) * 96 * weightHi + (sh / 100) * 96 * weightSh;
    if (delta !== 0) { r += delta; g += delta; b += delta; }
  }

  // 6. temperature — warm adds red and removes blue, cool the other way round.
  const temp = clampSigned100(adj.temperature ?? 0);
  if (temp !== 0) {
    const d = (temp / 100) * 255 * TEMPERATURE_STRENGTH * 0.35;
    r += d;
    b -= d;
  }

  // 7. saturation — move towards (or past) the pixel's own luminance.
  const sf = saturationFactor(adj.saturation ?? 0);
  if (sf !== 1) {
    const y = luma(r, g, b);
    r = y + (r - y) * sf;
    g = y + (g - y) * sf;
    b = y + (b - y) * sf;
  }

  return [r, g, b];
}

/** Whole-buffer adjustment. Alpha is preserved sample-for-sample. */
export function applyAdjustments(src: PixelBuffer, adj: Record<string, number>): PixelBuffer {
  const out: PixelBuffer = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.length) };
  const skip = ADJUSTMENT_ORDER.every((k) => !adj[k]);
  if (skip) {
    out.data.set(src.data);
    return out;
  }
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      const [r, g, b] = applyAdjustmentsToPixel(src.data[i], src.data[i + 1], src.data[i + 2], adj);
      out.data[i] = ditherRound(r, x, y);
      out.data[i + 1] = ditherRound(g, x, y);
      out.data[i + 2] = ditherRound(b, x, y);
      out.data[i + 3] = src.data[i + 3];
    }
  }
  return out;
}

/** True when the adjustment set would change nothing at all (all seven at zero). */
export function isNeutral(adj: Record<string, number>): boolean {
  return ADJUSTMENT_ORDER.every((k) => !adj[k]);
}

/* ────────────────────────────────── blur ────────────────────────────────── */

/**
 * Separable box blur repeated `passes` times — three passes converge on a Gaussian and
 * cost O(w·h·passes) with no kernel larger than the window. Alpha is blurred alongside the
 * colours: blurring a transparent edge only in RGB would leave the untouched alpha as a
 * hard seam.
 */
export function boxBlur(src: PixelBuffer, radius: number, passes = 3): PixelBuffer {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return cloneBuffer(src);
  let current = cloneBuffer(src);
  for (let pass = 0; pass < Math.max(1, passes); pass++) {
    current = blurPass(current, r, true);
    current = blurPass(current, r, false);
  }
  return current;
}

function blurPass(src: PixelBuffer, radius: number, horizontal: boolean): PixelBuffer {
  const out: PixelBuffer = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.length) };
  const len = horizontal ? src.width : src.height;
  const lines = horizontal ? src.height : src.width;
  const window = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    for (let ch = 0; ch < 4; ch++) {
      let sum = 0;
      // Prime the running sum with the clamped left/top edge.
      for (let k = -radius; k <= radius; k++) sum += sample(src, line, k, ch, horizontal);
      for (let i = 0; i < len; i++) {
        const value = sum / window;
        const at = horizontal ? (line * src.width + i) * 4 + ch : (i * src.width + line) * 4 + ch;
        out.data[at] = ditherRound(value, i, line);
        sum -= sample(src, line, i - radius, ch, horizontal);
        sum += sample(src, line, i + radius + 1, ch, horizontal);
      }
    }
  }
  return out;
}

function sample(src: PixelBuffer, line: number, index: number, ch: number, horizontal: boolean): number {
  const len = horizontal ? src.width : src.height;
  const clamped = index < 0 ? 0 : index >= len ? len - 1 : index;
  const at = horizontal ? (line * src.width + clamped) * 4 + ch : (clamped * src.width + line) * 4 + ch;
  return src.data[at];
}

/* ──────────────────────────────── sharpen ──────────────────────────────── */

/**
 * Unsharp mask: `out = src + amount · (src − blur(src))`. The blur is the same box blur
 * above, so sharpening is exactly the inverse operation of the blur tool and cannot invent
 * detail the blur would not have removed.
 */
export function sharpen(src: PixelBuffer, amount: number): PixelBuffer {
  const a = Math.max(0, amount);
  if (a === 0) return cloneBuffer(src);
  const blurred = boxBlur(src, 1, 1);
  const out: PixelBuffer = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.length) };
  for (let i = 0; i < src.data.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      out.data[i + ch] = clamp255(src.data[i + ch] + (src.data[i + ch] - blurred.data[i + ch]) * a);
    }
    out.data[i + 3] = src.data[i + 3];
  }
  return out;
}

/* ──────────────────────────── named filter presets ──────────────────────────── */

export interface FilterPreset {
  id: string;
  /** Adjustment values the preset applies; `null` means "no change to that slider". */
  adjustments: Partial<Record<string, number>>;
  /** Extra pixel work a preset may need beyond the adjustment chain. */
  grayscale?: boolean;
  sepia?: boolean;
}

/**
 * The named presets. Each one is only an adjustment set plus an optional colour matrix, so
 * a preset is reproducible, previewable through the ordinary pipeline and unit-testable —
 * no hidden shaders.
 */
export const FILTER_PRESETS: FilterPreset[] = [
  { id: 'none', adjustments: {} },
  { id: 'mono', adjustments: { contrast: 12, brightness: 4 }, grayscale: true },
  { id: 'sepia', adjustments: { temperature: 22, saturation: -18, contrast: 8 }, sepia: true },
  { id: 'vivid', adjustments: { saturation: 34, contrast: 16, brightness: 3 } },
  { id: 'soft', adjustments: { contrast: -18, brightness: 8, highlights: -12, saturation: -6 } },
  { id: 'punch', adjustments: { contrast: 30, shadows: -14, highlights: -18, saturation: 12 } },
  { id: 'warm', adjustments: { temperature: 28, brightness: 4 } },
  { id: 'cool', adjustments: { temperature: -28, brightness: 2 } },
];

export function presetById(id: string): FilterPreset | undefined {
  return FILTER_PRESETS.find((p) => p.id === id);
}

/** Applies a preset to a buffer: adjustments first, then the optional grey/sepia matrix. */
export function applyPreset(src: PixelBuffer, preset: FilterPreset, base: Record<string, number>): PixelBuffer {
  const merged: Record<string, number> = { ...base };
  for (const [k, v] of Object.entries(preset.adjustments)) if (typeof v === 'number') merged[k] = v;
  const adjusted = applyAdjustments(src, merged);
  if (!preset.grayscale && !preset.sepia) return adjusted;
  const out = cloneBuffer(adjusted);
  for (let i = 0; i < out.data.length; i += 4) {
    const r = out.data[i];
    const g = out.data[i + 1];
    const b = out.data[i + 2];
    const y = luma(r, g, b);
    if (preset.grayscale) {
      out.data[i] = y; out.data[i + 1] = y; out.data[i + 2] = y;
    } else {
      out.data[i] = clamp255(0.393 * r + 0.769 * g + 0.189 * b);
      out.data[i + 1] = clamp255(0.349 * r + 0.686 * g + 0.168 * b);
      out.data[i + 2] = clamp255(0.272 * r + 0.534 * g + 0.131 * b);
    }
  }
  return out;
}
