/**
 * Photo Editor — the layered document model (pure data, no DOM).
 *
 * A document is an ordered list of layers (index 0 = bottom). Every value here is treated as
 * IMMUTABLE: an edit
 * returns a new document that shares every untouched layer and pixel buffer with the old one.
 * That is what lets the undo history hold dozens of documents while only paying for the pixel
 * buffers that actually changed (see `newBufferBytes`).
 *
 * Three kinds of layer:
 *   • raster — a pixel buffer (the opened photo, brush strokes, pasted pixels);
 *   • text   — editable text (font, size, colour, alignment, direction), drawn at render time;
 *   • shape  — an editable rectangle / ellipse / line / arrow with fill and stroke.
 * Each carries a matrix that maps its own space into document pixels (transform.ts).
 */
import type { PixelBuffer, Point, Rect, Size } from './types';
import {
  IDENTITY, apply, flipMatrix, freeRotationMatrix, multiply, quarterTurnMatrix, resizeMatrix,
  tidy, transformRect, translation, type Matrix,
} from './transform';
import { rotatedBounds } from './geometry';
import { fromBuffer, tiledBytes, type Tiled } from './tiles';

export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

/** The canvas `globalCompositeOperation` for a blend mode ("normal" is "source-over"). */
export function compositeOperation(mode: BlendMode): GlobalCompositeOperation {
  return (mode === 'normal' ? 'source-over' : mode) as GlobalCompositeOperation;
}

export function isBlendMode(value: string): value is BlendMode {
  return (BLEND_MODES as readonly string[]).includes(value);
}

export type TextAlign = 'start' | 'center' | 'end';
export type TextDirection = 'auto' | 'rtl' | 'ltr';

export interface TextSpec {
  text: string;
  /** Key into FONT_FAMILIES. */
  font: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  direction: TextDirection;
  /** Optional outline, drawn under the fill so the glyph shapes stay crisp. */
  outline: string | null;
  outlineWidth: number;
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';

export interface ShapeSpec {
  shape: ShapeKind;
  from: Point;
  to: Point;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  /** Corner radius for rectangles, in pixels. */
  radius: number;
}

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blend: BlendMode;
  matrix: Matrix;
  /** A locked layer cannot be painted, moved or deleted. */
  locked: boolean;
}

export interface RasterLayer extends LayerBase { kind: 'raster'; tiled: Tiled }
export interface TextLayer extends LayerBase { kind: 'text'; text: TextSpec }
export interface ShapeLayer extends LayerBase { kind: 'shape'; shape: ShapeSpec }
export type Layer = RasterLayer | TextLayer | ShapeLayer;

export interface PhotoDoc {
  width: number;
  height: number;
  layers: readonly Layer[];
  activeId: string;
}

let idCounter = 0;
/** Layer ids only need to be unique inside one window; a counter plus a salt is enough. */
export function newLayerId(): string {
  idCounter += 1;
  return `L${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function rasterLayer(tiled: Tiled, name: string, matrix: Matrix = IDENTITY): RasterLayer {
  return { id: newLayerId(), kind: 'raster', name, visible: true, opacity: 1, blend: 'normal', matrix, locked: false, tiled };
}

export function textLayer(text: TextSpec, at: Point, name: string): TextLayer {
  return {
    id: newLayerId(), kind: 'text', name, visible: true, opacity: 1, blend: 'normal',
    matrix: translation(at.x, at.y), locked: false, text,
  };
}

export function shapeLayer(shape: ShapeSpec, name: string): ShapeLayer {
  return { id: newLayerId(), kind: 'shape', name, visible: true, opacity: 1, blend: 'normal', matrix: IDENTITY, locked: false, shape };
}

/** A one-layer document around an opened image. */
export function docFromBuffer(buffer: PixelBuffer, backgroundName: string): PhotoDoc {
  const bg = rasterLayer(fromBuffer(buffer), backgroundName);
  return { width: buffer.width, height: buffer.height, layers: [bg], activeId: bg.id };
}

/** A solid (or transparent, when `rgba[3]` is 0) buffer: the "new canvas" background. */
export function solidBuffer(width: number, height: number, rgba: readonly [number, number, number, number]): PixelBuffer {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const data = new Uint8ClampedArray(w * h * 4);
  if (rgba[3] !== 0 || rgba[0] || rgba[1] || rgba[2]) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = rgba[3];
    }
  }
  return { width: w, height: h, data };
}

/* ─────────────────────────────── lookups ─────────────────────────────── */

export function layerIndex(doc: PhotoDoc, id: string): number {
  return doc.layers.findIndex((l) => l.id === id);
}

export function layerById(doc: PhotoDoc, id: string): Layer | undefined {
  return doc.layers.find((l) => l.id === id);
}

export function activeLayer(doc: PhotoDoc): Layer {
  return layerById(doc, doc.activeId) ?? doc.layers[doc.layers.length - 1];
}

/** "Layer 3" style names that do not collide with the ones already in the document. */
export function nextLayerName(doc: PhotoDoc, base: string): string {
  const taken = new Set(doc.layers.map((l) => l.name));
  for (let n = doc.layers.length + 1; n < doc.layers.length + 1000; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
  return `${base} ${Date.now()}`;
}

/* ─────────────────────────────── edits ─────────────────────────────── */

/** Inserts `layer` directly above the active layer and makes it active. */
export function addLayer(doc: PhotoDoc, layer: Layer): PhotoDoc {
  const at = layerIndex(doc, doc.activeId);
  const layers = [...doc.layers];
  layers.splice(at < 0 ? layers.length : at + 1, 0, layer);
  return { ...doc, layers, activeId: layer.id };
}

export function duplicateLayer(doc: PhotoDoc, id: string, suffix: string): PhotoDoc {
  const src = layerById(doc, id);
  if (!src) return doc;
  // The buffer is shared on purpose: buffers are never mutated, so a duplicate costs nothing
  // until one of the two is painted on (which then produces a fresh buffer for that layer only).
  const copy: Layer = { ...src, id: newLayerId(), name: `${src.name} ${suffix}` } as Layer;
  return addLayer({ ...doc, activeId: id }, copy);
}

/** Removes a layer; the last remaining layer and locked layers are never removed. */
export function removeLayer(doc: PhotoDoc, id: string): PhotoDoc {
  if (doc.layers.length <= 1) return doc;
  const at = layerIndex(doc, id);
  if (at < 0 || doc.layers[at].locked) return doc;
  const layers = doc.layers.filter((l) => l.id !== id);
  const activeId = doc.activeId === id ? layers[Math.max(0, at - 1)].id : doc.activeId;
  return { ...doc, layers, activeId };
}

/** Moves a layer one step up (+1, towards the top) or down (−1). */
export function moveLayer(doc: PhotoDoc, id: string, direction: 1 | -1): PhotoDoc {
  const at = layerIndex(doc, id);
  return at < 0 ? doc : moveLayerTo(doc, id, at + direction);
}

/** Moves a layer to stack index `to` (0 = bottom), e.g. after a drag in the Layers panel. */
export function moveLayerTo(doc: PhotoDoc, id: string, to: number): PhotoDoc {
  const at = layerIndex(doc, id);
  if (at < 0 || to < 0 || to >= doc.layers.length || to === at) return doc;
  const layers = [...doc.layers];
  const [layer] = layers.splice(at, 1);
  layers.splice(to, 0, layer);
  return { ...doc, layers };
}

export type LayerPatch = Partial<Pick<LayerBase, 'name' | 'visible' | 'opacity' | 'blend' | 'matrix' | 'locked'>>;

export function updateLayer(doc: PhotoDoc, id: string, patch: LayerPatch): PhotoDoc {
  let changed = false;
  const layers = doc.layers.map((l) => {
    if (l.id !== id) return l;
    changed = true;
    const next = { ...l, ...patch } as Layer;
    if (patch.opacity !== undefined) next.opacity = Math.min(1, Math.max(0, patch.opacity));
    return next;
  });
  return changed ? { ...doc, layers } : doc;
}

/** Replaces a layer object wholesale (a new buffer, new text, new shape). */
export function replaceLayer(doc: PhotoDoc, layer: Layer): PhotoDoc {
  const at = layerIndex(doc, layer.id);
  if (at < 0) return doc;
  const layers = [...doc.layers];
  layers[at] = layer;
  return { ...doc, layers };
}

export function setActive(doc: PhotoDoc, id: string): PhotoDoc {
  return layerById(doc, id) && doc.activeId !== id ? { ...doc, activeId: id } : doc;
}

/** Moves a layer by (dx, dy) document pixels. */
export function translateLayer(doc: PhotoDoc, id: string, dx: number, dy: number): PhotoDoc {
  const layer = layerById(doc, id);
  if (!layer || layer.locked || (!dx && !dy)) return doc;
  return updateLayer(doc, id, { matrix: tidy(multiply(translation(dx, dy), layer.matrix)) });
}

/* ───────────────────────── whole-image operations ───────────────────────── */

/**
 * Applies `m` in front of every layer and changes the canvas size. Vector layers stay vector
 * (their matrix just grows); raster layers keep every original pixel too, so rotating twice
 * never resamples twice — the renderer draws each raster through its matrix once.
 */
export function transformDoc(doc: PhotoDoc, m: Matrix, size: Size): PhotoDoc {
  return {
    ...doc,
    width: Math.max(1, Math.round(size.width)),
    height: Math.max(1, Math.round(size.height)),
    layers: doc.layers.map((l) => ({ ...l, matrix: tidy(multiply(m, l.matrix)) }) as Layer),
  };
}

export function rotateDocQuarter(doc: PhotoDoc, direction: 1 | -1): PhotoDoc {
  return transformDoc(doc, quarterTurnMatrix(doc.width, doc.height, direction), { width: doc.height, height: doc.width });
}

export function flipDoc(doc: PhotoDoc, axis: 'h' | 'v'): PhotoDoc {
  return transformDoc(doc, flipMatrix(doc.width, doc.height, axis), { width: doc.width, height: doc.height });
}

export function rotateDocFree(doc: PhotoDoc, degrees: number): PhotoDoc {
  const out = rotatedBounds({ width: doc.width, height: doc.height }, degrees);
  return transformDoc(doc, freeRotationMatrix(doc.width, doc.height, degrees, out), out);
}

export function resizeDoc(doc: PhotoDoc, size: Size): PhotoDoc {
  return transformDoc(doc, resizeMatrix(doc, size), size);
}

/** Crops the canvas to `rect` (document pixels): every layer shifts, nothing is resampled. */
export function cropDoc(doc: PhotoDoc, rect: Rect): PhotoDoc {
  return transformDoc(doc, translation(-rect.x, -rect.y), { width: rect.w, height: rect.h });
}

/* ─────────────────────────────── bounds ─────────────────────────────── */

/** Measures a text layer's box in its own space; supplied by the canvas (or a test stub). */
export type TextMeasure = (spec: TextSpec) => Rect;

/** A shape's box in its own space, grown by half the stroke so a thick outline is included. */
export function shapeLocalRect(spec: ShapeSpec): Rect {
  const pad = spec.stroke ? spec.strokeWidth / 2 : 0;
  const x = Math.min(spec.from.x, spec.to.x) - pad;
  const y = Math.min(spec.from.y, spec.to.y) - pad;
  return { x, y, w: Math.abs(spec.to.x - spec.from.x) + pad * 2, h: Math.abs(spec.to.y - spec.from.y) + pad * 2 };
}

/** The axis-aligned box a layer covers in document pixels. */
export function layerBounds(layer: Layer, measure: TextMeasure): Rect {
  const local: Rect = layer.kind === 'raster'
    ? { x: 0, y: 0, w: layer.tiled.width, h: layer.tiled.height }
    : layer.kind === 'text'
      ? measure(layer.text)
      : shapeLocalRect(layer.shape);
  return transformRect(layer.matrix, local);
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h;
}

/**
 * The top-most visible non-raster layer under a point, for the move and text tools. Raster
 * layers usually cover the whole canvas, so picking them by box would always pick the photo;
 * the caller falls back to the active layer instead.
 */
export function pickVectorLayer(doc: PhotoDoc, p: Point, measure: TextMeasure): Layer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!l.visible || l.kind === 'raster') continue;
    if (rectContains(layerBounds(l, measure), p)) return l;
  }
  return null;
}

/** A point in document pixels → the layer's own space (null for a degenerate matrix). */
export function toLayerSpace(layer: Layer, p: Point, inverse: (m: Matrix) => Matrix | null): Point | null {
  const inv = inverse(layer.matrix);
  return inv ? apply(inv, p) : null;
}

/* ─────────────────────────────── memory ─────────────────────────────── */

function buffersOf(doc: PhotoDoc | null | undefined): Set<PixelBuffer> {
  const set = new Set<PixelBuffer>();
  if (doc) for (const l of doc.layers) if (l.kind === 'raster') for (const t of l.tiled.tiles) set.add(t);
  return set;
}

/**
 * The bytes a history step really costs: the raster TILES `next` holds that `prev` did not.
 * A text edit, a layer move or a layer reorder therefore costs (almost) nothing, and a brush
 * stroke costs only the tiles it touched — the history budget stays honest.
 */
export function newBufferBytes(prev: PhotoDoc | null | undefined, next: PhotoDoc): number {
  const before = buffersOf(prev);
  let bytes = 0;
  for (const b of buffersOf(next)) if (!before.has(b)) bytes += b.data.length;
  // A small constant for the document structure itself, so a step is never "free".
  return bytes + 256 * next.layers.length;
}

/** Total unique raster bytes a document references. */
export function docBytes(doc: PhotoDoc): number {
  let bytes = 0;
  for (const b of buffersOf(doc)) bytes += b.data.length;
  return bytes;
}

/** Replaces a raster layer's pixels (a stroke, fill, adjustment…). */
export function setRaster(doc: PhotoDoc, id: string, tiled: Tiled): PhotoDoc {
  const layer = layerById(doc, id);
  if (!layer || layer.kind !== 'raster') return doc;
  return replaceLayer(doc, { ...layer, tiled });
}

export { tiledBytes };
