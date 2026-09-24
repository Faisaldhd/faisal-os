/**
 * Photo engine — painting: brush / eraser / clone stamp strokes, paint bucket, gradients
 * and the eyedropper.
 *
 * Painting mutates the target image IN PLACE (a stroke touches a few thousand pixels of a
 * 12 MP layer; copying the layer per mouse move would lag) and reports the dirty rectangle
 * so the UI can redraw and snapshot only that. Take a history snapshot before starting.
 *
 * The stroke model is Photoshop's: each dab adds `flow` coverage to a per-stroke coverage
 * buffer that can never exceed `opacity`, and the layer is recomposited from its state at
 * the start of the stroke. Overlapping dabs inside one stroke therefore build up to the
 * opacity and stop, instead of going solid. A selection mask scales the coverage, so
 * nothing outside the selection ever changes.
 */
import { magicWand } from './select';
import { clamp, clamp01, type Img, type Mask, type Rect, type RGB, type RGBA } from './core';

export type BrushMode = 'paint' | 'erase' | 'clone';

export interface BrushOptions {
  /** Diameter in pixels. */
  size: number;
  /** 0..1: 1 = hard anti-aliased edge, 0 = soft all the way from the centre. */
  hardness?: number;
  /** 0..1: the most a single stroke can cover. */
  opacity?: number;
  /** 0..1: coverage each dab adds. */
  flow?: number;
  /** Distance between dabs as a fraction of the size (default 0.25). */
  spacing?: number;
  /** Paint colour (paint mode). */
  color?: RGB;
  mode?: BrushMode;
  /** Clone stamp: the source pixel is at (x + dx, y + dy). */
  cloneOffset?: { dx: number; dy: number };
  /** Selection: coverage is multiplied by mask/255. */
  mask?: Mask | null;
}

/**
 * Coverage of a round dab of radius `r` at distance `d` from its centre.
 * Hard (1): a one-pixel anti-aliased rim. Softer: full inside `r·hardness`, then a
 * smoothstep falloff to 0 at `r`.
 */
export function dabAlpha(d: number, r: number, hardness: number): number {
  const h = clamp01(hardness);
  if (h >= 1 || r <= 1) return clamp01(r - d + 0.5);
  const core = r * h;
  if (d <= core) return 1;
  if (d >= r) return 0;
  const t = (d - core) / (r - core);
  return 1 - t * t * (3 - 2 * t);
}

function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** One stroke: `moveTo` once, `lineTo` for every pointer move, read `dirty` to redraw. */
export class BrushStroke {
  readonly target: Img;
  /** Union of every pixel this stroke changed, or null before the first dab. */
  dirty: Rect | null = null;
  private readonly base: Uint8ClampedArray;
  private readonly cov: Uint16Array;
  private readonly radius: number;
  private readonly hardness: number;
  private readonly opacity: number;
  private readonly flow: number;
  private readonly step: number;
  private readonly color: RGB;
  private readonly mode: BrushMode;
  private readonly dx: number;
  private readonly dy: number;
  private readonly mask: Mask | null;
  private last: { x: number; y: number } | null = null;
  /** Distance travelled since the last dab. */
  private carry = 0;

  constructor(target: Img, opts: BrushOptions) {
    this.target = target;
    this.base = new Uint8ClampedArray(target.data);
    this.cov = new Uint16Array(target.width * target.height);
    const size = clamp(Number.isFinite(opts.size) ? opts.size : 1, 1, 5000);
    this.radius = size / 2;
    this.hardness = clamp01(opts.hardness ?? 0.8);
    this.opacity = clamp01(opts.opacity ?? 1);
    this.flow = clamp01(opts.flow ?? 1);
    this.step = Math.max(0.5, clamp(opts.spacing ?? 0.25, 0.01, 10) * size);
    this.color = opts.color ?? [0, 0, 0];
    this.mode = opts.mode ?? 'paint';
    this.dx = Math.round(opts.cloneOffset?.dx ?? 0);
    this.dy = Math.round(opts.cloneOffset?.dy ?? 0);
    this.mask = opts.mask ?? null;
  }

  moveTo(x: number, y: number): Rect | null {
    this.last = { x, y };
    this.carry = 0;
    return this.dab(x, y);
  }

  /** Dabs along the segment from the previous point at the brush spacing. */
  lineTo(x: number, y: number): Rect | null {
    if (!this.last) return this.moveTo(x, y);
    const { x: x0, y: y0 } = this.last;
    const len = Math.hypot(x - x0, y - y0);
    let changed: Rect | null = null;
    let t = this.step - this.carry;
    while (t <= len) {
      const k = t / len;
      const r = this.dab(x0 + (x - x0) * k, y0 + (y - y0) * k);
      if (r) changed = unionRect(changed, r);
      t += this.step;
    }
    this.carry = len - (t - this.step);
    this.last = { x, y };
    return changed;
  }

  private dab(cx: number, cy: number): Rect | null {
    const { width: w, height: h, data } = this.target;
    const r = this.radius;
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const x1 = Math.min(w, Math.ceil(cx + r + 1));
    const y1 = Math.min(h, Math.ceil(cy + r + 1));
    if (x1 <= x0 || y1 <= y0) return null;
    const base = this.base;
    const cov = this.cov;
    const op = this.opacity;
    const flow = this.flow;
    const mask = this.mask;
    const [cr, cg, cb] = this.color;
    for (let y = y0; y < y1; y++) {
      const py = y + 0.5 - cy;
      for (let x = x0; x < x1; x++) {
        const a = dabAlpha(Math.hypot(x + 0.5 - cx, py), r, this.hardness);
        if (a <= 0) continue;
        const p = y * w + x;
        let s = cov[p] / 65535;
        s += a * flow * (op - s);
        if (s > op) s = op;
        cov[p] = s * 65535 + 0.5;
        const eff = mask ? (s * mask[p]) / 255 : s;
        const i = p * 4;
        const ba = base[i + 3] / 255;
        if (this.mode === 'erase') {
          data[i] = base[i]; data[i + 1] = base[i + 1]; data[i + 2] = base[i + 2];
          data[i + 3] = base[i + 3] * (1 - eff);
          continue;
        }
        let sr = cr, sg = cg, sb = cb, sa = eff;
        if (this.mode === 'clone') {
          const sx = x + this.dx;
          const sy = y + this.dy;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          const j = (sy * w + sx) * 4;
          sr = base[j]; sg = base[j + 1]; sb = base[j + 2]; sa = (eff * base[j + 3]) / 255;
        }
        // Straight-alpha source-over of the paint on the stroke's starting pixels.
        const oa = sa + ba * (1 - sa);
        if (oa <= 0) { data[i + 3] = 0; continue; }
        const kb = (ba * (1 - sa)) / oa;
        const ks = sa / oa;
        data[i] = sr * ks + base[i] * kb;
        data[i + 1] = sg * ks + base[i + 1] * kb;
        data[i + 2] = sb * ks + base[i + 2] * kb;
        data[i + 3] = oa * 255;
      }
    }
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    this.dirty = unionRect(this.dirty, rect);
    return rect;
  }
}

/** Convenience: a whole stroke through `points` in one call. Returns the dirty rectangle. */
export function strokePath(target: Img, points: readonly { x: number; y: number }[], opts: BrushOptions): Rect | null {
  if (!points.length) return null;
  const s = new BrushStroke(target, opts);
  s.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) s.lineTo(points[i].x, points[i].y);
  return s.dirty;
}

/** Source-over of a colour at coverage `a` (0..1) onto pixel `i`. */
function overAt(d: Uint8ClampedArray, i: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  const ba = d[i + 3] / 255;
  const oa = a + ba * (1 - a);
  const kb = (ba * (1 - a)) / oa;
  const ks = a / oa;
  d[i] = r * ks + d[i] * kb;
  d[i + 1] = g * ks + d[i + 1] * kb;
  d[i + 2] = b * ks + d[i + 2] * kb;
  d[i + 3] = oa * 255;
}

export interface BucketOptions {
  tolerance?: number;
  contiguous?: boolean;
  /** 0..1 */
  opacity?: number;
  mask?: Mask | null;
}

/**
 * Paint bucket: fills the region the magic wand would select at (x, y) with `color`
 * (source-over, alpha of the colour × opacity × selection). In place; returns the dirty
 * rectangle or null when nothing was filled.
 */
export function paintBucket(target: Img, x: number, y: number, color: RGBA | RGB, opts: BucketOptions = {}): Rect | null {
  const region = magicWand(target, x, y, { tolerance: opts.tolerance ?? 32, contiguous: opts.contiguous ?? true });
  const { width: w } = target;
  const d = target.data;
  const alpha = ((color.length > 3 ? (color as RGBA)[3] : 255) / 255) * clamp01(opts.opacity ?? 1);
  const mask = opts.mask ?? null;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let p = 0; p < region.length; p++) {
    if (!region[p]) continue;
    const a = mask ? (alpha * mask[p]) / 255 : alpha;
    if (a <= 0) continue;
    overAt(d, p * 4, color[0], color[1], color[2], a);
    const px = p % w;
    const py = (p - px) / w;
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export interface GradientStop {
  /** 0..1 */
  offset: number;
  color: RGBA;
}

export interface GradientOptions {
  type: 'linear' | 'radial';
  from: { x: number; y: number };
  to: { x: number; y: number };
  stops: readonly GradientStop[];
  /** 0..1 */
  opacity?: number;
  mask?: Mask | null;
}

/**
 * Colour of a gradient at t (0..1), interpolated in premultiplied space like CSS, so a
 * fade to transparent does not pass through grey. Returns straight RGBA.
 */
export function gradientColorAt(stops: readonly GradientStop[], t: number): [number, number, number, number] {
  const s = [...stops].sort((a, b) => a.offset - b.offset);
  if (!s.length) return [0, 0, 0, 0];
  const tt = clamp01(t);
  if (tt <= s[0].offset) return [...s[0].color] as [number, number, number, number];
  const last = s[s.length - 1];
  if (tt >= last.offset) return [...last.color] as [number, number, number, number];
  let k = 0;
  while (tt > s[k + 1].offset) k++;
  const a = s[k];
  const b = s[k + 1];
  const f = b.offset > a.offset ? (tt - a.offset) / (b.offset - a.offset) : 1;
  const aa = a.color[3] / 255;
  const ba = b.color[3] / 255;
  const oa = aa + (ba - aa) * f;
  if (oa <= 0) return [0, 0, 0, 0];
  const ch = (c: number) => (a.color[c] * aa + (b.color[c] * ba - a.color[c] * aa) * f) / oa;
  return [ch(0), ch(1), ch(2), oa * 255];
}

/** Draws a linear or radial gradient over the target (source-over). In place. */
export function drawGradient(target: Img, opts: GradientOptions): Rect | null {
  const { width: w, height: h, data: d } = target;
  const LUT_N = 1024;
  const lut = new Float32Array(LUT_N * 4);
  for (let i = 0; i < LUT_N; i++) {
    const c = gradientColorAt(opts.stops, i / (LUT_N - 1));
    lut.set(c, i * 4);
  }
  const op = clamp01(opts.opacity ?? 1);
  const mask = opts.mask ?? null;
  const fx = opts.from.x, fy = opts.from.y;
  const vx = opts.to.x - fx, vy = opts.to.y - fy;
  const len2 = vx * vx + vy * vy;
  if (len2 <= 0) return null;
  const len = Math.sqrt(len2);
  const radial = opts.type === 'radial';
  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - fy;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (mask && !mask[p]) continue;
      const px = x + 0.5 - fx;
      const t = radial ? Math.sqrt(px * px + py * py) / len : (px * vx + py * vy) / len2;
      const li = Math.round(clamp01(t) * (LUT_N - 1)) * 4;
      const a = (lut[li + 3] / 255) * op * (mask ? mask[p] / 255 : 1);
      overAt(d, p * 4, lut[li], lut[li + 1], lut[li + 2], a);
    }
  }
  return { x: 0, y: 0, w, h };
}

/**
 * Eyedropper: the average colour of a `size`×`size` square (1, 3 or 5) centred on (x, y),
 * clipped to the image. RGB is alpha-weighted (transparent pixels do not pull it to black).
 * Returns null off the image.
 */
export function sampleColor(src: Img, x: number, y: number, size: 1 | 3 | 5 = 1): [number, number, number, number] | null {
  const { width: w, height: h, data: d } = src;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (!(cx >= 0 && cy >= 0 && cx < w && cy < h)) return null;
  const half = (Math.max(1, size) - 1) >> 1;
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let yy = Math.max(0, cy - half); yy <= Math.min(h - 1, cy + half); yy++) {
    for (let xx = Math.max(0, cx - half); xx <= Math.min(w - 1, cx + half); xx++) {
      const i = (yy * w + xx) * 4;
      const al = d[i + 3];
      r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al; n++;
    }
  }
  if (a === 0) return [0, 0, 0, 0];
  return [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n)];
}
