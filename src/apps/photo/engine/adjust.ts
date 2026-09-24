/**
 * Photo engine — adjustments as ONE combined pass.
 *
 * Every tonal operator here works on each channel independently, so the whole tonal stack
 * (exposure → brightness → contrast → highlights → shadows → whites → blacks → levels →
 * gamma → curves → temperature → tint) collapses into three 256-entry lookup tables built
 * once per parameter change. Colour operators that mix channels (saturation, hue) collapse
 * into one 3×3 matrix; vibrance, grayscale and invert are per-pixel steps after it. A full
 * stack on a 12 MP image is therefore a single loop with three table reads.
 *
 * Sliders are all −100..100 with 0 = no change, except `hue` in degrees (−180..180).
 * The first seven keep the maths of `pixels.ts` so existing slider values look the same.
 * Alpha is never changed.
 */
import { clamp, clamp255, mixByMask, type Img, type Mask } from './core';

export type AdjustKey =
  | 'exposure' | 'brightness' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'
  | 'gamma' | 'temperature' | 'tint' | 'saturation' | 'vibrance' | 'hue';

/** Every slider key, in the order the operators run. */
export const ADJUST_KEYS: readonly AdjustKey[] = [
  'exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'gamma',
  'temperature', 'tint', 'saturation', 'hue', 'vibrance',
];

export interface Levels {
  inBlack?: number;
  inWhite?: number;
  /** Midtone gamma, 0.1..10 (1 = linear); > 1 brightens the midtones like Photoshop. */
  gamma?: number;
  outBlack?: number;
  outWhite?: number;
}

/** A curve is a list of [input, output] control points in 0..255. */
export type CurvePoints = readonly (readonly [number, number])[];

export interface ChannelSet<T> {
  master?: T;
  r?: T;
  g?: T;
  b?: T;
}

export type Adjustments = Partial<Record<AdjustKey, number>> & {
  invert?: boolean;
  grayscale?: boolean;
  levels?: ChannelSet<Levels>;
  curves?: ChannelSet<CurvePoints>;
};

/* ─────────────────────────────── scalar maths ─────────────────────────────── */

function s100(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return clamp(n, -100, 100);
}

/** Rec. 601 luma, as `pixels.ts` uses for saturation (matches CSS expectations). */
export function luma601(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** −100 → ×0.25, 0 → ×1, +100 → ×4 (as `pixels.ts`). */
export function exposureFactor(v: number): number {
  const e = s100(v);
  return e >= 0 ? 1 + (e / 100) * 3 : 1 / (1 + (-e / 100) * 3);
}

/** −100 → 0 (flat grey), +100 → ×4 around 128 (as `pixels.ts`). */
export function contrastSlope(v: number): number {
  const c = s100(v);
  return c >= 0 ? 1 + (c / 100) * 3 : 1 + c / 100;
}

/** Gamma slider → exponent: −100 → γ 0.5 (darker mids), +100 → γ 2 (brighter mids). */
export function gammaFromSlider(v: number): number {
  return Math.pow(2, s100(v) / 100);
}

/** Levels on one 0..255 value. */
export function levelsValue(x: number, l: Levels): number {
  const ib = clamp(l.inBlack ?? 0, 0, 254);
  const iw = clamp(l.inWhite ?? 255, ib + 1, 255);
  const g = clamp(l.gamma ?? 1, 0.1, 10);
  const ob = clamp(l.outBlack ?? 0, 0, 255);
  const ow = clamp(l.outWhite ?? 255, 0, 255);
  let t = (x - ib) / (iw - ib);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  if (g !== 1) t = Math.pow(t, 1 / g);
  return ob + t * (ow - ob);
}

function levelsIsNeutral(l: Levels | undefined): boolean {
  return !l || ((l.inBlack ?? 0) === 0 && (l.inWhite ?? 255) === 255 && (l.gamma ?? 1) === 1
    && (l.outBlack ?? 0) === 0 && (l.outWhite ?? 255) === 255);
}

/**
 * A monotone cubic (Fritsch–Carlson) through the control points, sampled at 0..255.
 * Monotone means a curve through rising points never overshoots or dips, so no banding
 * reversal; outside the first/last point the curve is flat. Values are floats in 0..255.
 */
export function curveTable(points: CurvePoints): Float64Array {
  const out = new Float64Array(256);
  const pts = points
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [clamp(p[0], 0, 255), clamp(p[1], 0, 255)] as [number, number])
    .sort((a, b) => a[0] - b[0])
    .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0]);
  if (pts.length === 0) { for (let i = 0; i < 256; i++) out[i] = i; return out; }
  if (pts.length === 1) { out.fill(pts[0][1]); return out; }
  const n = pts.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    slope.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= pts[0][0]) { out[x] = pts[0][1]; continue; }
    if (x >= pts[n - 1][0]) { out[x] = pts[n - 1][1]; continue; }
    while (x > pts[seg + 1][0]) seg++;
    const h = dx[seg];
    const t = (x - pts[seg][0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * pts[seg][1] + (t3 - 2 * t2 + t) * h * m[seg]
      + (-2 * t3 + 3 * t2) * pts[seg + 1][1] + (t3 - t2) * h * m[seg + 1];
    out[x] = clamp255(y);
  }
  return out;
}

/** 0 = R, 1 = G, 2 = B. */
export type Channel = 0 | 1 | 2;
const CH_KEYS = ['r', 'g', 'b'] as const;

/** Linear interpolation into a 256-entry table (inputs may be fractional). */
function sampleTable(t: Float64Array, x: number): number {
  if (x <= 0) return t[0];
  if (x >= 255) return t[255];
  const i = Math.floor(x);
  const f = x - i;
  return f === 0 ? t[i] : t[i] + (t[i + 1] - t[i]) * f;
}

interface ToneSetup {
  ef: number; bright: number; slope: number; hi: number; sh: number; wh: number; bl: number;
  gammaExp: number; temp: number; tint: number;
  levels: (Levels | null)[]; masterLevels: Levels | null;
  curves: (Float64Array | null)[]; masterCurve: Float64Array | null;
}

function toneSetup(adj: Adjustments): ToneSetup {
  const lv = adj.levels ?? {};
  const cv = adj.curves ?? {};
  return {
    ef: exposureFactor(adj.exposure ?? 0),
    bright: s100(adj.brightness),
    slope: contrastSlope(adj.contrast ?? 0),
    hi: s100(adj.highlights),
    sh: s100(adj.shadows),
    wh: s100(adj.whites),
    bl: s100(adj.blacks),
    gammaExp: 1 / gammaFromSlider(adj.gamma ?? 0),
    temp: (s100(adj.temperature) / 100) * 255 * 0.6 * 0.35,
    tint: (s100(adj.tint) / 100) * 40,
    masterLevels: levelsIsNeutral(lv.master) ? null : (lv.master as Levels),
    levels: CH_KEYS.map((k) => (levelsIsNeutral(lv[k]) ? null : (lv[k] as Levels))),
    masterCurve: cv.master && cv.master.length ? curveTable(cv.master) : null,
    curves: CH_KEYS.map((k) => (cv[k] && (cv[k] as CurvePoints).length ? curveTable(cv[k] as CurvePoints) : null)),
  };
}

function toneWith(s: ToneSetup, ch: Channel, x0: number): number {
  let x = x0;
  if (s.ef !== 1) x *= s.ef;
  x += s.bright;
  if (s.slope !== 1) x = (x - 128) * s.slope + 128;
  // Highlight/shadow rolls: a linear ramp weight that is 0 at the far end and 1 at its own
  // end (the per-channel form of pixels.ts' luma ramp; identical on neutral greys).
  if (s.hi !== 0 || s.sh !== 0) {
    const t = x / 255;
    const wHi = t <= 0.5 ? 0 : t >= 1 ? 1 : (t - 0.5) * 2;
    const wSh = t >= 0.5 ? 0 : t <= 0 ? 1 : (0.5 - t) * 2;
    x += (s.hi / 100) * 96 * wHi + (s.sh / 100) * 96 * wSh;
  }
  if (s.wh !== 0 || s.bl !== 0) {
    const t = x < 0 ? 0 : x > 255 ? 1 : x / 255;
    x += (s.wh / 100) * 64 * t * t + (s.bl / 100) * 64 * (1 - t) * (1 - t);
  }
  // Levels, gamma and curves are defined on the displayable range.
  x = clamp255(x);
  if (s.masterLevels) x = levelsValue(x, s.masterLevels);
  const l = s.levels[ch];
  if (l) x = levelsValue(x, l);
  if (s.gammaExp !== 1) x = 255 * Math.pow(x / 255, s.gammaExp);
  if (s.masterCurve) x = sampleTable(s.masterCurve, x);
  const c = s.curves[ch];
  if (c) x = sampleTable(c, x);
  // White balance: warm adds red and removes blue; tint +: magenta (less green).
  if (ch === 0) x += s.temp + s.tint / 2;
  else if (ch === 1) x -= s.tint;
  else x += -s.temp + s.tint / 2;
  return clamp255(x);
}

/** The tonal stack on one channel value (float in, float 0..255 out). */
export function toneValue(adj: Adjustments, ch: Channel, x: number): number {
  return toneWith(toneSetup(adj), ch, x);
}

/* ─────────────────────────────── colour matrix ─────────────────────────────── */

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o;
}

/** Saturation around Rec. 601 luma: factor 0 = grey, 1 = unchanged, 2 = doubled. */
export function saturationMatrix(factor: number): Mat3 {
  const s = factor;
  const lr = 0.299 * (1 - s);
  const lg = 0.587 * (1 - s);
  const lb = 0.114 * (1 - s);
  return [lr + s, lg, lb, lr, lg + s, lb, lr, lg, lb + s];
}

/** The W3C `hue-rotate()` matrix (what CSS filters use), degrees. */
export function hueMatrix(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}

/* ────────────────────────────────── pipeline ────────────────────────────────── */

export interface Pipeline {
  /** Float tone tables per channel (0..255). */
  tone: [Float64Array, Float64Array, Float64Array];
  /** The same tables rounded to bytes — used when no colour stage follows. */
  tone8: [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray];
  /** Saturation × hue matrix, or null when identity. */
  matrix: Mat3 | null;
  vibrance: number;
  grayscale: boolean;
  invert: boolean;
  /** True when the pipeline changes nothing. */
  identity: boolean;
}

export function isNeutralAdjust(adj: Adjustments): boolean {
  if (adj.invert || adj.grayscale) return false;
  for (const k of ADJUST_KEYS) if ((k === 'hue' ? hueDeg(adj.hue) : s100(adj[k])) !== 0) return false;
  const lv = adj.levels ?? {};
  if (![lv.master, lv.r, lv.g, lv.b].every(levelsIsNeutral)) return false;
  const cv = adj.curves ?? {};
  return ![cv.master, cv.r, cv.g, cv.b].some((c) => c && c.length);
}

function hueDeg(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return clamp(n, -180, 180);
}

/** Builds the combined tables + matrix for an adjustment set (cheap: 768 evaluations). */
export function buildPipeline(adj: Adjustments): Pipeline {
  const setup = toneSetup(adj);
  const tone: [Float64Array, Float64Array, Float64Array] = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  const tone8: [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] = [
    new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256),
  ];
  const invert = !!adj.invert;
  const grayscale = !!adj.grayscale;
  const sat = s100(adj.saturation);
  const hue = hueDeg(adj.hue);
  let matrix: Mat3 | null = null;
  if (sat !== 0) matrix = saturationMatrix(1 + sat / 100);
  if (hue !== 0) matrix = mulMat3(hueMatrix(hue), matrix ?? IDENTITY3);
  const vibrance = s100(adj.vibrance) / 100;
  const colourStage = !!matrix || vibrance !== 0 || grayscale;
  let identity = !colourStage && !invert;
  for (let ch = 0 as Channel; ch < 3; ch = (ch + 1) as Channel) {
    for (let x = 0; x < 256; x++) {
      const v = toneWith(setup, ch, x);
      tone[ch][x] = v;
      // Without a colour stage the invert folds into the table too.
      tone8[ch][x] = !colourStage && invert ? 255 - v : v;
      if (identity && tone8[ch][x] !== x) identity = false;
    }
  }
  return { tone, tone8, matrix, vibrance, grayscale, invert, identity };
}

/**
 * Runs a pipeline over `src` into `dst` (a new image by default; `dst` may be `src`).
 * One pass; alpha is copied through.
 */
export function applyPipeline(src: Img, pipe: Pipeline, dst?: Img): Img {
  const out = dst ?? { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.length) };
  const s = src.data;
  const d = out.data;
  const n = s.length;
  if (pipe.identity) { if (d !== s) d.set(s); return out; }
  const colour = !!pipe.matrix || pipe.vibrance !== 0 || pipe.grayscale;
  if (!colour) {
    const [lr, lg, lb] = pipe.tone8;
    for (let i = 0; i < n; i += 4) {
      d[i] = lr[s[i]];
      d[i + 1] = lg[s[i + 1]];
      d[i + 2] = lb[s[i + 2]];
      d[i + 3] = s[i + 3];
    }
    return out;
  }
  const [lr, lg, lb] = pipe.tone;
  const m = pipe.matrix;
  const hasM = !!m;
  const m0 = m ? m[0] : 1, m1 = m ? m[1] : 0, m2 = m ? m[2] : 0;
  const m3 = m ? m[3] : 0, m4 = m ? m[4] : 1, m5 = m ? m[5] : 0;
  const m6 = m ? m[6] : 0, m7 = m ? m[7] : 0, m8 = m ? m[8] : 1;
  const vib = pipe.vibrance;
  const gray = pipe.grayscale;
  const inv = pipe.invert;
  for (let i = 0; i < n; i += 4) {
    let r = lr[s[i]];
    let g = lg[s[i + 1]];
    let b = lb[s[i + 2]];
    if (hasM) {
      const nr = m0 * r + m1 * g + m2 * b;
      const ng = m3 * r + m4 * g + m5 * b;
      const nb = m6 * r + m7 * g + m8 * b;
      r = nr; g = ng; b = nb;
    }
    if (vib !== 0) {
      // Vibrance: saturate muted colours more than already-saturated ones.
      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      const sat = max > 0 ? (max - min) / max : 0;
      const k = 1 + vib * (1 - (sat > 1 ? 1 : sat));
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      r = y + (r - y) * k; g = y + (g - y) * k; b = y + (b - y) * k;
    }
    if (gray) { const y = 0.299 * r + 0.587 * g + 0.114 * b; r = y; g = y; b = y; }
    if (inv) {
      r = 255 - (r < 0 ? 0 : r > 255 ? 255 : r);
      g = 255 - (g < 0 ? 0 : g > 255 ? 255 : g);
      b = 255 - (b < 0 ? 0 : b > 255 ? 255 : b);
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = s[i + 3];
  }
  return out;
}

/**
 * Reference for one pixel: the same operators applied step by step in floating point,
 * with no tables. Tests pin `applyPipeline` to it. Returns floats (the caller rounds).
 */
export function adjustPixelReference(r0: number, g0: number, b0: number, adj: Adjustments): [number, number, number] {
  const setup = toneSetup(adj);
  let r = toneWith(setup, 0, r0);
  let g = toneWith(setup, 1, g0);
  let b = toneWith(setup, 2, b0);
  const sat = s100(adj.saturation);
  if (sat !== 0) {
    const f = 1 + sat / 100;
    const y = luma601(r, g, b);
    r = y + (r - y) * f; g = y + (g - y) * f; b = y + (b - y) * f;
  }
  const hue = hueDeg(adj.hue);
  if (hue !== 0) {
    const m = hueMatrix(hue);
    [r, g, b] = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
  }
  const vib = s100(adj.vibrance) / 100;
  if (vib !== 0) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const k = 1 + vib * (1 - Math.min(1, max > 0 ? (max - min) / max : 0));
    const y = luma601(r, g, b);
    r = y + (r - y) * k; g = y + (g - y) * k; b = y + (b - y) * k;
  }
  if (adj.grayscale) { const y = luma601(r, g, b); r = y; g = y; b = y; }
  if (adj.invert) { r = 255 - clamp255(r); g = 255 - clamp255(g); b = 255 - clamp255(b); }
  return [r, g, b];
}

export interface AdjustOptions {
  /** Only pixels inside the mask change (partially where it is soft). */
  mask?: Mask | null;
  /** Global strength 0..1 (1 = full effect). */
  amount?: number;
  /** Write into this image instead of allocating (may be `src`). */
  out?: Img;
}

/** The rich entry point: any adjustment stack, optionally through a selection mask. */
export function adjustImage(src: Img, adj: Adjustments, opts: AdjustOptions = {}): Img {
  const mask = opts.mask ?? null;
  const amount = opts.amount ?? 1;
  if (!mask && amount >= 1) return applyPipeline(src, buildPipeline(adj), opts.out);
  const processed = applyPipeline(src, buildPipeline(adj));
  return mixByMask(src, processed, mask, amount, opts.out ?? processed);
}

/**
 * Seam-compatible entry (`ops.ts`): a flat record of slider values and on/off flags
 * (`invert`, `grayscale`). Unknown keys are ignored. Returns a new image.
 */
export function adjust(buf: Img, params: Record<string, number | boolean>): Img {
  const adj: Adjustments = {};
  for (const k of ADJUST_KEYS) {
    const v = params[k];
    if (typeof v === 'number') adj[k] = v;
  }
  adj.invert = params.invert === true;
  adj.grayscale = params.grayscale === true;
  return applyPipeline(buf, buildPipeline(adj));
}
