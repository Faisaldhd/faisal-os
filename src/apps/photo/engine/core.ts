/**
 * Photo engine — shared primitives.
 *
 * The engine works on an ImageData-like `{ width, height, data }` (straight, non-premultiplied
 * RGBA, 4 bytes per pixel, row-major) so the same code runs in node tests, on the main thread
 * and inside a Web Worker. Masks are plain `Uint8Array`s of `width * height` coverage values
 * (0 = outside, 255 = fully inside), the same shape the UI's `selection.ts` uses.
 */

export interface Img {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A selection/coverage mask: one byte per pixel, 0..255. Its size is the image's. */
export type Mask = Uint8Array;

export type RGB = readonly [number, number, number];
export type RGBA = readonly [number, number, number, number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function createImg(width: number, height: number): Img {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

export function cloneImg(src: Img): Img {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

/** An image filled with one RGBA colour (tests and "new canvas" use it). */
export function solidImg(width: number, height: number, rgba: RGBA): Img {
  const img = createImg(width, height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = rgba[0]; d[i + 1] = rgba[1]; d[i + 2] = rgba[2]; d[i + 3] = rgba[3];
  }
  return img;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Rec. 709 luma — the weights of the W3C filter matrices (grayscale, saturate, hue-rotate). */
export function luma709(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Writes into `dst` a blend between `orig` and `processed` by `mask` (and a global 0..1
 * `amount`). All four channels move, so an op that changes alpha (eraser, blur) is masked
 * too. `dst` may be `processed` itself (in place, the default).
 */
export function mixByMask(orig: Img, processed: Img, mask: Mask | null, amount = 1, dst: Img = processed): Img {
  const k = clamp01(amount);
  const o = orig.data;
  const p = processed.data;
  const d = dst.data;
  if (!mask) {
    if (k >= 1) { if (d !== p) d.set(p); return dst; }
    for (let i = 0; i < d.length; i++) d[i] = o[i] + (p[i] - o[i]) * k;
    return dst;
  }
  const scale = k / 255;
  for (let px = 0, i = 0; i < d.length; px++, i += 4) {
    const m = mask[px];
    if (m === 0) {
      d[i] = o[i]; d[i + 1] = o[i + 1]; d[i + 2] = o[i + 2]; d[i + 3] = o[i + 3];
    } else if (m === 255 && k >= 1) {
      if (d !== p) { d[i] = p[i]; d[i + 1] = p[i + 1]; d[i + 2] = p[i + 2]; d[i + 3] = p[i + 3]; }
    } else {
      const t = m * scale;
      d[i] = o[i] + (p[i] - o[i]) * t;
      d[i + 1] = o[i + 1] + (p[i + 1] - o[i + 1]) * t;
      d[i + 2] = o[i + 2] + (p[i + 2] - o[i + 2]) * t;
      d[i + 3] = o[i + 3] + (p[i + 3] - o[i + 3]) * t;
    }
  }
  return dst;
}

/* ─────────────────────────── Gaussian (3 × box) blur core ─────────────────────────── */

/**
 * Box widths whose three successive passes approximate a Gaussian of `sigma`
 * (Jarosz / Kutskir): every width is odd and their variances sum to about sigma².
 */
export function boxesForGauss(sigma: number, n = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/**
 * One horizontal box pass over a `w × h` plane, written TRANSPOSED into `dst` (`h × w`).
 * Two calls blur both axes while every read stays sequential (cache friendly). Edges are
 * clamped (the border pixel repeats), so a flat image stays exactly flat.
 */
function boxPassT(src: Uint16Array, dst: Uint16Array, w: number, h: number, r: number): void {
  const inv = 1 / (r + r + 1);
  const last = w - 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + (k < 0 ? 0 : k > last ? last : k)];
    for (let x = 0; x < w; x++) {
      dst[x * h + y] = sum * inv + 0.5;
      const outI = x - r;
      const inI = x + r + 1;
      sum += src[row + (inI > last ? last : inI)] - src[row + (outI < 0 ? 0 : outI)];
    }
  }
}

/** Normalised 1-D Gaussian kernel of `sigma`, radius ⌈3σ⌉. */
export function gaussKernel(sigma: number): Float64Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Direct kernel pass (small sigmas, where odd-width boxes are too coarse), transposed like boxPassT. */
function kernelPassT(src: Uint16Array, dst: Uint16Array, w: number, h: number, k: Float64Array): void {
  const r = (k.length - 1) >> 1;
  const last = w - 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = -r; j <= r; j++) {
        const xx = x + j;
        sum += src[row + (xx < 0 ? 0 : xx > last ? last : xx)] * k[j + r];
      }
      dst[x * h + y] = sum + 0.5;
    }
  }
}

/** Below this sigma the blur uses an exact Gaussian kernel instead of three boxes. */
export const EXACT_GAUSS_BELOW = 2;

/** Gaussian blur of one 16-bit plane in place (`tmp` is scratch of the same size). */
export function blurPlane16(plane: Uint16Array, w: number, h: number, sigma: number, tmp?: Uint16Array): void {
  if (!(sigma > 0)) return;
  const scratch = tmp ?? new Uint16Array(plane.length);
  if (sigma < EXACT_GAUSS_BELOW) {
    const k = gaussKernel(sigma);
    kernelPassT(plane, scratch, w, h, k);
    kernelPassT(scratch, plane, h, w, k);
    return;
  }
  for (const size of boxesForGauss(sigma, 3)) {
    const r = (size - 1) >> 1;
    if (r <= 0) continue;
    boxPassT(plane, scratch, w, h, r);
    boxPassT(scratch, plane, h, w, r);
  }
}

/**
 * Gaussian blur of an RGBA image, `sigma` in pixels (≈ Photoshop's "radius").
 * Colours are blurred premultiplied by alpha, so a transparent neighbour never darkens an
 * edge (no black halo). The work is done at 16-bit precision one plane at a time, which
 * keeps the extra memory to three planes (about 6 bytes per pixel).
 */
export function gaussianBlurImg(src: Img, sigma: number): Img {
  const out = cloneImg(src);
  if (!(sigma > 0)) return out;
  const { width: w, height: h } = src;
  const n = w * h;
  const s = src.data;
  const d = out.data;
  let opaque = true;
  for (let i = 3; i < s.length; i += 4) if (s[i] !== 255) { opaque = false; break; }
  const tmp = new Uint16Array(n);
  const plane = new Uint16Array(n);
  let alpha: Uint16Array | null = null;
  if (!opaque) {
    alpha = new Uint16Array(n);
    for (let p = 0; p < n; p++) alpha[p] = s[p * 4 + 3] * 257;
    blurPlane16(alpha, w, h, sigma, tmp);
    for (let p = 0; p < n; p++) d[p * 4 + 3] = alpha[p] / 257;
  }
  for (let c = 0; c < 3; c++) {
    if (opaque) {
      for (let p = 0; p < n; p++) plane[p] = s[p * 4 + c] * 257;
    } else {
      // Premultiplied colour at 16 bits: c · a · 257 / 255.
      for (let p = 0, i = 0; p < n; p++, i += 4) plane[p] = (s[i + c] * s[i + 3] * 257) / 255 + 0.5;
    }
    blurPlane16(plane, w, h, sigma, tmp);
    if (opaque) {
      for (let p = 0; p < n; p++) d[p * 4 + c] = plane[p] / 257;
    } else {
      const A = alpha as Uint16Array;
      for (let p = 0; p < n; p++) {
        const a = A[p];
        d[p * 4 + c] = a > 0 ? (plane[p] * 255) / a : 0;
      }
    }
  }
  return out;
}

/** Deterministic 32-bit PRNG (mulberry32) so a preview and the applied result match exactly. */
export function prng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Area-average downscale so the longest side is at most `maxSide` (thumbnails, previews). */
export function downscale(src: Img, maxSide: number): Img {
  const long = Math.max(src.width, src.height);
  if (long <= maxSide) return cloneImg(src);
  const f = maxSide / long;
  const w = Math.max(1, Math.round(src.width * f));
  const h = Math.max(1, Math.round(src.height * f));
  const out = createImg(w, h);
  const sx = src.width / w;
  const sy = src.height / h;
  const s = src.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          const al = s[i + 3];
          r += s[i] * al; g += s[i + 1] * al; b += s[i + 2] * al; a += al; n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a; }
      out.data[o + 3] = a / n;
    }
  }
  return out;
}
