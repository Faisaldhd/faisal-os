/**
 * Photo engine — filters and one-click looks.
 *
 * Point filters (grayscale, sepia, invert, posterize) are W3C colour matrices or lookup
 * tables; spatial ones (blur, sharpen, emboss, edges, pixelate) are separable or 3×3 passes.
 * Named looks are nothing more than an adjustment stack (see `adjust.ts`) plus optional
 * vignette/grain, so a look is reproducible, previewable on a thumbnail and testable.
 * All vignette/grain maths is in normalised coordinates: a thumbnail looks like the photo.
 */
import { buildPipeline, applyPipeline, type Adjustments, type CurvePoints } from './adjust';
import {
  clamp, clamp01, clamp255, cloneImg, downscale, gaussianBlurImg, mixByMask, prng, type Img, type Mask,
} from './core';

function blank(src: Img): Img {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.length) };
}

/** Applies a 3×3 colour matrix (row-major) to every pixel; alpha is kept. */
export function colorMatrix(src: Img, m: readonly number[]): Img {
  const out = blank(src);
  const s = src.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i], g = s[i + 1], b = s[i + 2];
    d[i] = m[0] * r + m[1] * g + m[2] * b;
    d[i + 1] = m[3] * r + m[4] * g + m[5] * b;
    d[i + 2] = m[6] * r + m[7] * g + m[8] * b;
    d[i + 3] = s[i + 3];
  }
  return out;
}

/** W3C `grayscale(amount)` matrix (Rec. 709 weights). */
export function grayscaleMatrix(amount = 1): number[] {
  const a = 1 - clamp01(amount);
  return [
    0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a,
    0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a,
    0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a,
  ];
}

/** W3C `sepia(amount)` matrix. */
export function sepiaMatrix(amount = 1): number[] {
  const a = 1 - clamp01(amount);
  return [
    0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a,
    0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a,
    0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a,
  ];
}

export function grayscale(src: Img, amount = 1): Img {
  return colorMatrix(src, grayscaleMatrix(amount));
}

export function sepia(src: Img, amount = 1): Img {
  return colorMatrix(src, sepiaMatrix(amount));
}

export function invert(src: Img): Img {
  const out = blank(src);
  const s = src.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    d[i] = 255 - s[i]; d[i + 1] = 255 - s[i + 1]; d[i + 2] = 255 - s[i + 2]; d[i + 3] = s[i + 3];
  }
  return out;
}

/** Posterize to `levels` steps per channel (2..256): v → round(v·(n−1)/255)·255/(n−1). */
export function posterize(src: Img, levels: number): Img {
  const n = clamp(Math.round(levels), 2, 256);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = (Math.round((v * (n - 1)) / 255) * 255) / (n - 1);
  const out = blank(src);
  const s = src.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    d[i] = lut[s[i]]; d[i + 1] = lut[s[i + 1]]; d[i + 2] = lut[s[i + 2]]; d[i + 3] = s[i + 3];
  }
  return out;
}

/** Gaussian blur; `radius` is the Gaussian sigma in pixels (Photoshop-like). Premultiplied. */
export function blur(src: Img, radius: number): Img {
  return gaussianBlurImg(src, Math.max(0, radius));
}

/**
 * Unsharp mask: `out = src + amount · (src − gaussian(src, radius))` where the difference
 * exceeds `threshold` levels. Alpha is kept.
 */
export function sharpen(src: Img, amount: number, radius = 1, threshold = 0): Img {
  const a = Math.max(0, amount);
  if (a === 0 || !(radius > 0)) return cloneImg(src);
  const bl = gaussianBlurImg(src, radius);
  const out = blank(src);
  const s = src.data;
  const b = bl.data;
  const d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = s[i + c] - b[i + c];
      d[i + c] = diff > threshold || diff < -threshold ? s[i + c] + diff * a : s[i + c];
    }
    d[i + 3] = s[i + 3];
  }
  return out;
}

/**
 * Vignette: −100..100 (positive darkens the corners, negative lightens them). The falloff
 * starts at `midpoint` (0..1 of the half-diagonal) and eases with a smoothstep.
 */
export function vignette(src: Img, amount: number, midpoint = 0.35): Img {
  const out = cloneImg(src);
  const k = clamp(amount, -100, 100) / 100;
  if (k === 0) return out;
  const { width: w, height: h } = src;
  const cx = w / 2;
  const cy = h / 2;
  const maxD = Math.hypot(cx, cy) || 1;
  const mid = clamp(midpoint, 0, 0.95);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < w; x++) {
      const t = Math.hypot(x + 0.5 - cx, dy) / maxD;
      const f = t <= mid ? 0 : (t - mid) / (1 - mid);
      if (f === 0) continue;
      const wgt = f * f * (3 - 2 * f) * k * 0.85;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = d[i + c];
        d[i + c] = wgt >= 0 ? v * (1 - wgt) : v + (255 - v) * -wgt;
      }
    }
  }
  return out;
}

/** Film-like noise, 0..100 strength, deterministic by `seed`. Mono noise keeps hues. */
export function noise(src: Img, amount: number, seed = 1, mono = true): Img {
  const out = cloneImg(src);
  const k = (clamp(amount, 0, 100) / 100) * 64;
  if (k === 0) return out;
  const rnd = prng(seed);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    // Sum of two uniforms: a triangular distribution, closer to film grain than flat noise.
    const n = (rnd() + rnd() - 1) * k;
    if (mono) {
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    } else {
      d[i] += n;
      d[i + 1] += (rnd() + rnd() - 1) * k;
      d[i + 2] += (rnd() + rnd() - 1) * k;
    }
  }
  return out;
}

/** Pixelate into `size`×`size` blocks, each the alpha-weighted average of its pixels. */
export function pixelate(src: Img, size: number): Img {
  const bs = Math.max(1, Math.round(size));
  const out = cloneImg(src);
  if (bs === 1) return out;
  const { width: w, height: h } = src;
  const s = src.data;
  const d = out.data;
  for (let by = 0; by < h; by += bs) {
    const ye = Math.min(h, by + bs);
    for (let bx = 0; bx < w; bx += bs) {
      const xe = Math.min(w, bx + bs);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = by; y < ye; y++) {
        for (let x = bx; x < xe; x++) {
          const i = (y * w + x) * 4;
          const al = s[i + 3];
          r += s[i] * al; g += s[i + 1] * al; b += s[i + 2] * al; a += al; n++;
        }
      }
      const R = a ? r / a : 0, G = a ? g / a : 0, B = a ? b / a : 0, A = a / n;
      for (let y = by; y < ye; y++) {
        for (let x = bx; x < xe; x++) {
          const i = (y * w + x) * 4;
          d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = A;
        }
      }
    }
  }
  return out;
}

/**
 * Generic 3×3 convolution on RGB (edges clamped): `out = Σ k·p / divisor + bias`.
 * Alpha is kept.
 */
export function convolve3x3(src: Img, kernel: readonly number[], divisor = 1, bias = 0): Img {
  const { width: w, height: h } = src;
  const out = blank(src);
  const s = src.data;
  const d = out.data;
  const inv = 1 / (divisor || 1);
  // Clamped neighbour offsets, computed once: no per-pixel arrays on a 12 MP image.
  const xs = new Int32Array(w * 3);
  for (let x = 0; x < w; x++) {
    xs[x * 3] = x > 0 ? x - 1 : 0; xs[x * 3 + 1] = x; xs[x * 3 + 2] = x < w - 1 ? x + 1 : w - 1;
  }
  const ys = new Int32Array(3);
  for (let y = 0; y < h; y++) {
    ys[0] = (y > 0 ? y - 1 : 0) * w; ys[1] = y * w; ys[2] = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < 3; ky++) {
        const row = ys[ky];
        for (let kx = 0; kx < 3; kx++) {
          const k = kernel[ky * 3 + kx];
          if (k === 0) continue;
          const i = (row + xs[x * 3 + kx]) * 4;
          r += s[i] * k; g += s[i + 1] * k; b += s[i + 2] * k;
        }
      }
      const o = (y * w + x) * 4;
      d[o] = r * inv + bias; d[o + 1] = g * inv + bias; d[o + 2] = b * inv + bias; d[o + 3] = s[o + 3];
    }
  }
  return out;
}

/** Emboss kernel (sums to 1, so flat areas keep their colour); `strength` scales the relief. */
export function emboss(src: Img, strength = 1): Img {
  const s = Math.max(0, strength);
  return convolve3x3(src, [-2 * s, -s, 0, -s, 1, s, 0, s, 2 * s]);
}

/** Sobel edge magnitude of the luma, as a grey image (white edges on black). */
export function edgeDetect(src: Img): Img {
  const { width: w, height: h } = src;
  const s = src.data;
  const lum = new Float32Array(w * h);
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) lum[p] = 0.2126 * s[i] + 0.7152 * s[i + 1] + 0.0722 * s[i + 2];
  const out = blank(src);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const y0 = (y > 0 ? y - 1 : 0) * w, y1 = y * w, y2 = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0, x2 = x < w - 1 ? x + 1 : w - 1;
      const gx = -lum[y0 + x0] + lum[y0 + x2] - 2 * lum[y1 + x0] + 2 * lum[y1 + x2] - lum[y2 + x0] + lum[y2 + x2];
      const gy = -lum[y0 + x0] - 2 * lum[y0 + x] - lum[y0 + x2] + lum[y2 + x0] + 2 * lum[y2 + x] + lum[y2 + x2];
      const m = clamp255(Math.sqrt(gx * gx + gy * gy));
      const o = (y1 + x) * 4;
      d[o] = m; d[o + 1] = m; d[o + 2] = m; d[o + 3] = s[o + 3];
    }
  }
  return out;
}

/* ─────────────────────────────── named looks ─────────────────────────────── */

export interface FilterPreset {
  id: string;
  adjust: Adjustments;
  /** Vignette −100..100 applied after the adjustments. */
  vignette?: number;
  /** Grain 0..100 applied last. */
  grain?: number;
  /** W3C sepia toning after the adjustments. */
  sepia?: boolean;
}

/*
 * Looks add contrast with S-curves rather than the linear `contrast` slider: an S-curve
 * keeps pure black and white where they are, so a dark photo is not crushed to black.
 */
const S_SOFT: CurvePoints = [[0, 0], [64, 58], [192, 200], [255, 255]];
const S_MED: CurvePoints = [[0, 0], [64, 54], [192, 205], [255, 255]];
const S_STRONG: CurvePoints = [[0, 0], [56, 38], [128, 128], [200, 222], [255, 255]];

export const FILTER_PRESETS: readonly FilterPreset[] = [
  { id: 'warm', adjust: { temperature: 22, tint: 4, vibrance: 10, curves: { master: S_SOFT } } },
  { id: 'cool', adjust: { temperature: -22, tint: -3, vibrance: 6, curves: { master: S_SOFT } } },
  {
    id: 'vintage',
    adjust: {
      temperature: 14, saturation: -22,
      curves: { master: [[0, 26], [64, 70], [192, 198], [255, 236]], b: [[0, 36], [255, 218]] },
    },
    vignette: 28,
    grain: 6,
  },
  { id: 'mono', adjust: { grayscale: true, curves: { master: S_MED } } },
  { id: 'vivid', adjust: { vibrance: 38, saturation: 10, curves: { master: S_MED } } },
  { id: 'fade', adjust: { saturation: -20, curves: { master: [[0, 34], [128, 130], [255, 242]] } } },
  {
    id: 'noir',
    adjust: { grayscale: true, curves: { master: S_STRONG } },
    vignette: 45,
  },
  {
    id: 'golden',
    adjust: {
      temperature: 30, tint: 6, vibrance: 16, highlights: -10,
      curves: { r: [[0, 0], [128, 138], [255, 255]], b: [[0, 8], [128, 118], [255, 240]] },
    },
    vignette: 12,
  },
  {
    id: 'desert',
    adjust: {
      temperature: 24, saturation: -14, highlights: -8,
      curves: { master: [[0, 18], [64, 66], [192, 204], [255, 250]], g: [[0, 0], [128, 124], [255, 250]] },
    },
  },
  // Kept from the first editor so saved choices and the quick editor keep working.
  { id: 'sepia', adjust: { curves: { master: S_SOFT } }, sepia: true },
  { id: 'soft', adjust: { contrast: -18, brightness: 8, highlights: -12, saturation: -6 } },
  { id: 'punch', adjust: { vibrance: 20, saturation: 8, highlights: -18, curves: { master: S_STRONG } } },
];

/** The look ids in display order (the nine owner looks first). */
export const PRESET_IDS: readonly string[] = FILTER_PRESETS.map((p) => p.id);

export function presetById(id: string): FilterPreset | undefined {
  return FILTER_PRESETS.find((p) => p.id === id);
}

/** Renders a look at `amount` 0..100 (blended with the original), optionally through a mask. */
export function applyPreset(src: Img, preset: FilterPreset | string, amount = 100, mask: Mask | null = null): Img {
  const p = typeof preset === 'string' ? presetById(preset) : preset;
  if (!p) return cloneImg(src);
  let out = applyPipeline(src, buildPipeline(p.adjust));
  if (p.sepia) out = sepia(out);
  if (p.vignette) out = vignette(out, p.vignette);
  if (p.grain) out = noise(out, p.grain, 7);
  return mixByMask(src, out, mask, clamp(amount, 0, 100) / 100);
}

/** One small thumbnail per look (the source is downscaled once; each look is then cheap). */
export function presetThumbnails(src: Img, maxSide = 96): Map<string, Img> {
  const small = downscale(src, maxSide);
  const out = new Map<string, Img>();
  for (const p of FILTER_PRESETS) out.set(p.id, applyPreset(small, p));
  return out;
}

/* ───────────────────────────── the ops.ts seam ───────────────────────────── */

/** Every id `applyFilter` knows: the looks plus the effects. */
export const EFFECT_IDS = [
  'grayscale', 'invert', 'blur', 'sharpen', 'noise', 'vignette', 'pixelate', 'posterize', 'emboss', 'edges',
] as const;

export const FILTER_IDS: readonly string[] = [...PRESET_IDS, ...EFFECT_IDS];

/** Effects whose `amount` is a strength (pixels/percent) rather than a blend with the original. */
export function isSpatial(id: string): boolean {
  return id === 'blur' || id === 'sharpen' || id === 'noise' || id === 'vignette' || id === 'pixelate'
    || id === 'posterize';
}

/**
 * One filter at `amount` (0..100). Looks and point effects blend with the original by the
 * amount; spatial effects use it as their strength. `scale` is the preview proxy factor:
 * pixel radii shrink with it so a downscaled preview matches the full-size result.
 * Unknown ids return an unchanged copy.
 */
export function applyFilter(buf: Img, id: string, amount: number, scale = 1): Img {
  const a = clamp(Number.isFinite(amount) ? amount : 0, 0, 100);
  const sc = scale > 0 && Number.isFinite(scale) ? scale : 1;
  const k = a / 100;
  switch (id) {
    case 'blur': return blur(buf, k * 24 * sc);
    case 'sharpen': return sharpen(buf, k * 2.5, Math.max(0.5, sc));
    case 'noise': return noise(buf, a);
    case 'vignette': return vignette(buf, a);
    case 'pixelate': return pixelate(buf, Math.max(1, Math.round(k * 48 * sc)));
    case 'posterize': return posterize(buf, Math.round(32 - k * 30));
    case 'grayscale': return grayscale(buf, k);
    case 'invert': return mixByMask(buf, invert(buf), null, k);
    case 'emboss': return mixByMask(buf, emboss(buf), null, k);
    case 'edges': return mixByMask(buf, edgeDetect(buf), null, k);
    default: return applyPreset(buf, id, a);
  }
}
