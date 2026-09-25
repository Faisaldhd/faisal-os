/**
 * Photo Editor — the canvas side of the document: turning layers into pixels on screen and in
 * exports. Pure maths lives elsewhere (layers.ts, view.ts, transform.ts); this file is the
 * thin, browser-only glue around `CanvasRenderingContext2D`.
 *
 *  • One canvas per raster layer, kept in step with its tiles: when a layer's tiled raster
 *    changes (a stroke, an undo), only the tiles that differ are re-uploaded.
 *  • Text is drawn with the browser's own shaping (`fillText` with `direction`), so Arabic is
 *    joined and ordered correctly both on screen and in the exported file.
 *  • Blend modes are the canvas's own `globalCompositeOperation` values.
 */
import type { PixelBuffer, Rect } from './types';
import {
  compositeOperation, type AdjustLayer, type Layer, type PhotoDoc, type RasterLayer, type ShapeSpec, type TextSpec,
} from './layers';
import { adjust as runAdjust, isNeutralAdjust } from './ops';
import { blendAdjusted } from './masks';
import { changedTiles, tileRect, type Tiled } from './tiles';
import { detectDirection, lineOffset, LINE_HEIGHT } from './view';
import type { RasterCodec } from './project';

/** Font stacks (system fonts only: nothing is downloaded). Labels live in strings.ts. */
export const FONT_FAMILIES: Record<string, string> = {
  system: 'system-ui, "Segoe UI", Tahoma, "Noto Sans Arabic", "Geeza Pro", sans-serif',
  naskh: '"Noto Naskh Arabic", "Traditional Arabic", "Amiri", "Geeza Pro", "Times New Roman", serif',
  kufi: '"Noto Kufi Arabic", "Segoe UI", Tahoma, "Geeza Pro", sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Naskh Arabic", serif',
  mono: 'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace',
  display: 'Impact, "Arial Black", "Segoe UI Black", "Noto Kufi Arabic", sans-serif',
};
export const FONT_IDS = Object.keys(FONT_FAMILIES);

export function canvas2d(width: number, height: number, willRead = false): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d', willRead ? { willReadFrequently: true } : undefined)!;
  return { canvas, ctx };
}

export function putBuffer(ctx: CanvasRenderingContext2D, buf: PixelBuffer, x = 0, y = 0): void {
  ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), x, y);
}

export function bufferCanvas(buf: PixelBuffer): HTMLCanvasElement {
  const { canvas, ctx } = canvas2d(buf.width, buf.height);
  putBuffer(ctx, buf);
  return canvas;
}

export function readCanvas(canvas: HTMLCanvasElement, rect?: Rect): PixelBuffer {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const r = rect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
  const img = ctx.getImageData(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h));
  return { width: img.width, height: img.height, data: img.data };
}

/* ─────────────────────────── raster layer canvases ─────────────────────────── */

/** Keeps one canvas per raster layer id, patched tile-by-tile as the layer changes. */
export class LayerCanvases {
  private map = new Map<string, { tiled: Tiled; canvas: HTMLCanvasElement }>();

  get(layer: RasterLayer): HTMLCanvasElement {
    return this.tiled(layer.id, layer.tiled);
  }

  /** The canvas of a layer's mask (white pixels, alpha = coverage). */
  mask(layer: Layer): HTMLCanvasElement | null {
    return layer.mask ? this.tiled(`${layer.id}#mask`, layer.mask) : null;
  }

  private tiled(key: string, tiled: Tiled): HTMLCanvasElement {
    const entry = this.map.get(key);
    if (entry && entry.tiled === tiled) return entry.canvas;
    const diff = entry && entry.tiled.width === tiled.width && entry.tiled.height === tiled.height ? changedTiles(entry.tiled, tiled) : null;
    if (entry && diff) {
      const ctx = entry.canvas.getContext('2d')!;
      for (const i of diff) {
        const r = tileRect(tiled, i);
        ctx.clearRect(r.x, r.y, r.w, r.h);
        putBuffer(ctx, tiled.tiles[i], r.x, r.y);
      }
      entry.tiled = tiled;
      return entry.canvas;
    }
    const { canvas, ctx } = canvas2d(tiled.width, tiled.height);
    tiled.tiles.forEach((tile, i) => {
      const r = tileRect(tiled, i);
      putBuffer(ctx, tile, r.x, r.y);
    });
    this.map.set(key, { tiled, canvas });
    return canvas;
  }

  /** Drops canvases of layers that no longer exist anywhere (called after history trims). */
  prune(keep: Set<string>): void {
    for (const id of this.map.keys()) if (!keep.has(id.replace(/#mask$/, ''))) this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
  }
}

/* ─────────────────────────────── text ─────────────────────────────── */

let measureCtx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = canvas2d(1, 1).ctx;
  return measureCtx;
}

export function textFont(spec: TextSpec): string {
  const family = FONT_FAMILIES[spec.font] ?? FONT_FAMILIES.system;
  return `${spec.italic ? 'italic ' : ''}${spec.bold ? '700' : '400'} ${Math.max(1, spec.size)}px ${family}`;
}

export function textDirection(spec: TextSpec): 'rtl' | 'ltr' {
  return spec.direction === 'auto' ? detectDirection(spec.text) : spec.direction;
}

function lines(spec: TextSpec): string[] {
  return (spec.text || ' ').split('\n');
}

/** The text box in layer space; the anchor (0, 0) is the top of the first line. */
export function measureText(spec: TextSpec): Rect {
  const ctx = measurer();
  ctx.font = textFont(spec);
  const dir = textDirection(spec);
  ctx.direction = dir;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const line of lines(spec)) {
    const w = Math.max(spec.size * 0.3, ctx.measureText(line).width);
    const off = lineOffset(w, spec.align, dir);
    x0 = Math.min(x0, off);
    x1 = Math.max(x1, off + w);
  }
  const pad = spec.outline ? spec.outlineWidth : 0;
  return { x: x0 - pad, y: -pad, w: x1 - x0 + pad * 2, h: lines(spec).length * spec.size * LINE_HEIGHT + pad * 2 };
}

export function drawText(ctx: CanvasRenderingContext2D, spec: TextSpec): void {
  ctx.font = textFont(spec);
  const dir = textDirection(spec);
  ctx.direction = dir;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const lh = spec.size * LINE_HEIGHT;
  lines(spec).forEach((line, i) => {
    const w = ctx.measureText(line).width;
    const x = lineOffset(w, spec.align, dir);
    const y = i * lh + lh / 2;
    if (spec.outline && spec.outlineWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = spec.outlineWidth * 2;
      ctx.strokeStyle = spec.outline;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = spec.color;
    ctx.fillText(line, x, y);
  });
}

/* ─────────────────────────────── shapes ─────────────────────────────── */

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function drawShape(ctx: CanvasRenderingContext2D, s: ShapeSpec): void {
  const x = Math.min(s.from.x, s.to.x);
  const y = Math.min(s.from.y, s.to.y);
  const w = Math.abs(s.to.x - s.from.x);
  const h = Math.abs(s.to.y - s.from.y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(0.5, s.strokeWidth);
  ctx.beginPath();
  if (s.shape === 'rect') roundRectPath(ctx, x, y, w, h, s.radius);
  else if (s.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
  else {
    ctx.moveTo(s.from.x, s.from.y);
    ctx.lineTo(s.to.x, s.to.y);
  }
  if (s.fill && (s.shape === 'rect' || s.shape === 'ellipse')) {
    ctx.fillStyle = s.fill;
    ctx.fill();
  }
  const stroke = s.stroke ?? (s.shape === 'line' || s.shape === 'arrow' ? s.fill : null);
  if (stroke && s.strokeWidth > 0) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
  if (s.shape === 'arrow' && stroke) {
    const ang = Math.atan2(s.to.y - s.from.y, s.to.x - s.from.x);
    const head = Math.max(10, s.strokeWidth * 3.5);
    ctx.beginPath();
    ctx.moveTo(s.to.x + Math.cos(ang) * s.strokeWidth * 0.5, s.to.y + Math.sin(ang) * s.strokeWidth * 0.5);
    ctx.lineTo(s.to.x - Math.cos(ang - 0.45) * head, s.to.y - Math.sin(ang - 0.45) * head);
    ctx.lineTo(s.to.x - Math.cos(ang + 0.45) * head, s.to.y - Math.sin(ang + 0.45) * head);
    ctx.closePath();
    ctx.fillStyle = stroke;
    ctx.fill();
  }
}

/* ─────────────────────────────── composite ─────────────────────────────── */

export interface Override {
  /** Drawn instead of the layer's own content, stretched over the layer's local box. */
  canvas: CanvasImageSource;
  width: number;
  height: number;
}

export interface DrawOptions {
  /** Live content previews by layer id; a live MASK preview uses the key `mask:<id>`. */
  overrides?: Map<string, Override>;
  /** Draw only these layer ids (merge down); default all visible. */
  only?: Set<string>;
  /** Ignore visibility (merge down of a hidden layer is still a merge). */
  includeHidden?: boolean;
  /** Canvas smoothing (off above 400% for a crisp pixel grid). */
  smooth?: boolean;
}

/** Draws one layer's content in its local space onto `ctx` (whose transform is set). */
export function drawLayerContent(ctx: CanvasRenderingContext2D, layer: Layer, cache: LayerCanvases, override?: Override): void {
  if (override) {
    ctx.drawImage(override.canvas, 0, 0, override.width, override.height);
    return;
  }
  if (layer.kind === 'raster') ctx.drawImage(cache.get(layer), 0, 0);
  else if (layer.kind === 'text') drawText(ctx, layer.text);
  else if (layer.kind === 'shape') drawShape(ctx, layer.shape);
  // An adjustment layer has no content of its own: drawDoc applies it to what is below.
}

/* Scratch canvases the size of the target, reused between frames (0: layer, 1: coverage). */
const scratchPool: HTMLCanvasElement[] = [];
function scratch(slot: number, w: number, h: number): CanvasRenderingContext2D {
  let c = scratchPool[slot];
  if (!c) { c = document.createElement('canvas'); scratchPool[slot] = c; }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d', { willReadFrequently: slot === 1 })!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function maskSource(layer: Layer, cache: LayerCanvases, opts: DrawOptions): { canvas: CanvasImageSource; w: number; h: number } | null {
  const o = opts.overrides?.get(`mask:${layer.id}`);
  if (o) return { canvas: o.canvas, w: o.width, h: o.height };
  const c = cache.mask(layer);
  return c ? { canvas: c, w: c.width, h: c.height } : null;
}

/** A masked layer: drawn alone on a scratch canvas, cut by its mask, then composited. */
function drawMasked(ctx: CanvasRenderingContext2D, base: DOMMatrix, layer: Layer, cache: LayerCanvases, opts: DrawOptions): void {
  const m = layer.matrix;
  const t = scratch(0, ctx.canvas.width, ctx.canvas.height);
  t.imageSmoothingEnabled = ctx.imageSmoothingEnabled;
  t.setTransform(base);
  t.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  drawLayerContent(t, layer, cache, opts.overrides?.get(layer.id));
  const mask = maskSource(layer, cache, opts);
  if (mask) {
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(mask.canvas, 0, 0, mask.w, mask.h);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = compositeOperation(layer.blend);
  ctx.drawImage(t.canvas, 0, 0);
  ctx.restore();
}

/**
 * An adjustment layer: reads back what is composited so far, runs the engine pipeline and
 * mixes it in by coverage (its mask, or its box) × opacity. Alpha never changes, so the
 * result is written straight back.
 */
function drawAdjust(ctx: CanvasRenderingContext2D, base: DOMMatrix, layer: AdjustLayer, cache: LayerCanvases, opts: DrawOptions): void {
  if (isNeutralAdjust(layer.adjust)) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const m = layer.matrix;
  const cov = scratch(1, W, H);
  cov.setTransform(base);
  cov.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  const mask = maskSource(layer, cache, opts);
  if (mask) cov.drawImage(mask.canvas, 0, 0, mask.w, mask.h);
  else { cov.fillStyle = '#fff'; cov.fillRect(0, 0, layer.width, layer.height); }
  const cd = cov.getImageData(0, 0, W, H).data;
  const coverage = new Uint8Array(W * H);
  for (let p = 0; p < coverage.length; p++) coverage[p] = cd[p * 4 + 3];
  const img = ctx.getImageData(0, 0, W, H);
  const below = { width: W, height: H, data: img.data };
  blendAdjusted(below, runAdjust(below, layer.adjust), coverage, layer.opacity);
  ctx.putImageData(img, 0, 0);
}

/**
 * Composites the document onto `ctx`. The caller sets the base transform (view zoom/pan or an
 * export scale); every layer multiplies its own matrix on top.
 */
export function drawDoc(ctx: CanvasRenderingContext2D, doc: PhotoDoc, cache: LayerCanvases, opts: DrawOptions = {}): void {
  const base = ctx.getTransform();
  ctx.imageSmoothingEnabled = opts.smooth !== false;
  ctx.imageSmoothingQuality = 'high';
  for (const layer of doc.layers) {
    if (opts.only && !opts.only.has(layer.id)) continue;
    if (!layer.visible && !opts.includeHidden) continue;
    if (layer.opacity <= 0) continue;
    if (layer.kind === 'adjust') { drawAdjust(ctx, base, layer, cache, opts); continue; }
    if (layer.mask || opts.overrides?.has(`mask:${layer.id}`)) { drawMasked(ctx, base, layer, cache, opts); continue; }
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = compositeOperation(layer.blend);
    const m = layer.matrix;
    ctx.setTransform(base);
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    drawLayerContent(ctx, layer, cache, opts.overrides?.get(layer.id));
    ctx.restore();
  }
  ctx.setTransform(base);
}

/** The flattened document at `scale` (1 = full resolution) as a new canvas. */
export function renderDoc(doc: PhotoDoc, cache: LayerCanvases, scale = 1, opts: DrawOptions = {}): HTMLCanvasElement {
  const { canvas, ctx } = canvas2d(doc.width * scale, doc.height * scale, true);
  ctx.setTransform(canvas.width / doc.width, 0, 0, canvas.height / doc.height, 0, 0);
  drawDoc(ctx, doc, cache, opts);
  return canvas;
}

/** Scale that keeps `w × h` at or under `maxPixels`. */
export function proxyScale(w: number, h: number, maxPixels: number): number {
  return Math.min(1, Math.sqrt(maxPixels / Math.max(1, w * h)));
}

/* ─────────────────────────────── PNG codec ─────────────────────────────── */

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function canvasToBytes(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Uint8Array> {
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, quality));
  if (!blob) throw new Error('encode-failed');
  if (blob.type && blob.type !== mime) throw new Error('encode-unsupported');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Layers in a `.fphoto` project are lossless PNG. */
export const PNG_CODEC: RasterCodec = {
  async encode(buf) {
    return toBase64(await canvasToBytes(bufferCanvas(buf), 'image/png'));
  },
  async decode(payload, width, height) {
    const blob = new Blob([fromBase64(payload).slice()], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const { canvas, ctx } = canvas2d(width, height, true);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return readCanvas(canvas);
  },
};
