/**
 * Photo engine — layer compositing with the W3C Compositing and Blending Level 1 modes.
 *
 * For backdrop Cb/αb and source Cs/αs (straight colour in 0..1, αs already × layer opacity):
 *   Cs' = (1 − αb)·Cs + αb·B(Cb, Cs)          (the blend only applies where there is a backdrop)
 *   co  = αs·Cs' + αb·Cb·(1 − αs)             (source-over, premultiplied)
 *   αo  = αs + αb·(1 − αs),  out = co / αo    (back to straight alpha for ImageData)
 * This is the premultiplied-correct form: a half-transparent layer over nothing keeps its
 * own colour, and a transparent backdrop never darkens the result.
 * Separable modes read B from a 256×256 table built once per mode (exact at 8 bits).
 */
import { clamp01, type Img, type Mask, type Rect } from './core';

export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

const NON_SEPARABLE = new Set<BlendMode>(['hue', 'saturation', 'color', 'luminosity']);

export function isBlendMode(v: unknown): v is BlendMode {
  return typeof v === 'string' && (BLEND_MODES as readonly string[]).includes(v);
}

/** B(Cb, Cs) for a separable mode, values in 0..1. */
export function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'multiply': return cb * cs;
    case 'screen': return cb + cs - cb * cs;
    case 'overlay': return blendChannel('hard-light', cs, cb);
    case 'darken': return Math.min(cb, cs);
    case 'lighten': return Math.max(cb, cs);
    case 'color-dodge':
      if (cb === 0) return 0;
      if (cs >= 1) return 1;
      return Math.min(1, cb / (1 - cs));
    case 'color-burn':
      if (cb >= 1) return 1;
      if (cs <= 0) return 0;
      return 1 - Math.min(1, (1 - cb) / cs);
    case 'hard-light':
      return cs <= 0.5 ? cb * 2 * cs : blendChannel('screen', cb, 2 * cs - 1);
    case 'soft-light': {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      const dd = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (dd - cb);
    }
    case 'difference': return Math.abs(cb - cs);
    case 'exclusion': return cb + cs - 2 * cb * cs;
    default: return cs;
  }
}

/* ─────────────────────────── non-separable helpers (W3C) ─────────────────────────── */

type V3 = [number, number, number];

export function lum(c: V3): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}

function clipColor(c: V3): V3 {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let [r, g, b] = c;
  if (n < 0) {
    const k = l - n;
    r = l + ((r - l) * l) / k; g = l + ((g - l) * l) / k; b = l + ((b - l) * l) / k;
  }
  if (x > 1) {
    const k = x - l;
    r = l + ((r - l) * (1 - l)) / k; g = l + ((g - l) * (1 - l)) / k; b = l + ((b - l) * (1 - l)) / k;
  }
  return [r, g, b];
}

export function setLum(c: V3, l: number): V3 {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

export function sat(c: V3): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

export function setSat(c: V3, s: number): V3 {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [iMin, iMid, iMax] = idx;
  const out: V3 = [0, 0, 0];
  if (c[iMax] > c[iMin]) {
    out[iMid] = ((c[iMid] - c[iMin]) * s) / (c[iMax] - c[iMin]);
    out[iMax] = s;
  }
  out[iMin] = 0;
  return out;
}

/** B(Cb, Cs) for any mode on whole colours (0..1). */
export function blendColor(mode: BlendMode, cb: V3, cs: V3): V3 {
  switch (mode) {
    case 'hue': return setLum(setSat(cs, sat(cb)), lum(cb));
    case 'saturation': return setLum(setSat(cb, sat(cs)), lum(cb));
    case 'color': return setLum(cs, lum(cb));
    case 'luminosity': return setLum(cb, lum(cs));
    default: return [blendChannel(mode, cb[0], cs[0]), blendChannel(mode, cb[1], cs[1]), blendChannel(mode, cb[2], cs[2])];
  }
}

/**
 * One pixel, 8-bit straight RGBA in and float straight RGBA (0..255) out.
 * `opacity` (0..1) scales the source alpha.
 */
export function blendPixel(mode: BlendMode, backdrop: readonly number[], source: readonly number[], opacity = 1): [number, number, number, number] {
  const as = (source[3] / 255) * clamp01(opacity);
  const ab = backdrop[3] / 255;
  const ao = as + ab * (1 - as);
  if (ao <= 0) return [0, 0, 0, 0];
  const cb: V3 = [backdrop[0] / 255, backdrop[1] / 255, backdrop[2] / 255];
  const cs: V3 = [source[0] / 255, source[1] / 255, source[2] / 255];
  const B = blendColor(mode, cb, cs);
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const csP = (1 - ab) * cs[c] + ab * B[c];
    out.push(((as * csP + ab * cb[c] * (1 - as)) / ao) * 255);
  }
  return [out[0], out[1], out[2], ao * 255];
}

const tables = new Map<BlendMode, Float32Array>();

/** 256×256 table of B(cb, cs) (index cb·256 + cs), values 0..1. */
function tableFor(mode: BlendMode): Float32Array {
  let t = tables.get(mode);
  if (!t) {
    t = new Float32Array(65536);
    for (let b = 0; b < 256; b++) for (let s = 0; s < 256; s++) t[b * 256 + s] = blendChannel(mode, b / 255, s / 255);
    tables.set(mode, t);
  }
  return t;
}

export interface CompositeOptions {
  mode?: BlendMode;
  /** 0..1 */
  opacity?: number;
  /** Where the layer's top-left sits on the backdrop (may be negative or fractional → rounded). */
  x?: number;
  y?: number;
  /** Layer mask, sized like `src` (0 hides, 255 shows). */
  mask?: Mask | null;
}

/**
 * Composites `src` onto `dst` IN PLACE with a blend mode and opacity. Returns the changed
 * rectangle on `dst`, or null when the layer is off-canvas or invisible.
 */
export function compositeLayer(dst: Img, src: Img, opts: CompositeOptions = {}): Rect | null {
  const mode: BlendMode = isBlendMode(opts.mode) ? opts.mode : 'normal';
  const op = clamp01(opts.opacity ?? 1);
  if (op <= 0) return null;
  const ox = Math.round(opts.x ?? 0);
  const oy = Math.round(opts.y ?? 0);
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(dst.width, ox + src.width);
  const y1 = Math.min(dst.height, oy + src.height);
  if (x1 <= x0 || y1 <= y0) return null;
  const d = dst.data;
  const s = src.data;
  const mask = opts.mask ?? null;
  const sep = !NON_SEPARABLE.has(mode);
  const table = sep && mode !== 'normal' ? tableFor(mode) : null;
  const opK = op / 255;
  for (let y = y0; y < y1; y++) {
    const sy = y - oy;
    for (let x = x0; x < x1; x++) {
      const sp = sy * src.width + (x - ox);
      const si = sp * 4;
      let as = s[si + 3] * opK;
      if (mask) as = (as * mask[sp]) / 255;
      if (as <= 0) continue;
      const di = (y * dst.width + x) * 4;
      const ab = d[di + 3] / 255;
      const ao = as + ab * (1 - as);
      const kS = as / ao;
      const kB = (ab * (1 - as)) / ao;
      if (mode === 'normal' || ab === 0) {
        // B only matters where there is a backdrop; with none this is plain source-over.
        d[di] = s[si] * kS + d[di] * kB;
        d[di + 1] = s[si + 1] * kS + d[di + 1] * kB;
        d[di + 2] = s[si + 2] * kS + d[di + 2] * kB;
      } else if (table) {
        for (let c = 0; c < 3; c++) {
          const cb = d[di + c];
          const cs = s[si + c];
          const csP = (1 - ab) * cs + ab * table[cb * 256 + cs] * 255;
          d[di + c] = csP * kS + cb * kB;
        }
      } else {
        const cb: V3 = [d[di] / 255, d[di + 1] / 255, d[di + 2] / 255];
        const cs: V3 = [s[si] / 255, s[si + 1] / 255, s[si + 2] / 255];
        const B = blendColor(mode, cb, cs);
        for (let c = 0; c < 3; c++) {
          const csP = (1 - ab) * cs[c] + ab * B[c];
          d[di + c] = (csP * kS + cb[c] * kB) * 255;
        }
      }
      d[di + 3] = ao * 255;
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface LayerInput {
  image: Img;
  mode?: BlendMode;
  opacity?: number;
  visible?: boolean;
  x?: number;
  y?: number;
  mask?: Mask | null;
}

/** Flattens layers (bottom first) onto a transparent (or `background`) canvas. */
export function flattenLayers(width: number, height: number, layers: readonly LayerInput[], background?: readonly [number, number, number, number]): Img {
  const out: Img = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  if (background) {
    for (let i = 0; i < out.data.length; i += 4) out.data.set(background, i);
  }
  for (const l of layers) {
    if (l.visible === false) continue;
    compositeLayer(out, l.image, { mode: l.mode, opacity: l.opacity, x: l.x, y: l.y, mask: l.mask });
  }
  return out;
}
