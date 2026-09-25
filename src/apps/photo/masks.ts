/**
 * Photo Editor — layer masks and adjustment-layer compositing (pure, no DOM).
 *
 * A mask is a tiled raster in the layer's own space, stored as white pixels whose ALPHA is the
 * coverage (255 = the layer shows, 0 = hidden). Keeping coverage in alpha is what lets the
 * canvas use the mask directly (`destination-in`) and lets the ordinary brush machinery paint
 * it: painting white is "source-over" (reveal), painting black is "erase" (hide) — exactly
 * `compositeStroke` in paint.ts.
 */
import type { PixelBuffer } from './types';
import { fromBuffer, toBuffer, type Tiled } from './tiles';
import { layerById, maskSize, replaceLayer, setLayerMask, type PhotoDoc } from './layers';

/** A mask of one value everywhere (255 = reveal all, 0 = hide all). */
export function solidMask(width: number, height: number, value = 255): Tiled {
  return maskFromCoverage(new Uint8Array(width * height).fill(value), width, height);
}

/** A mask from one coverage byte per pixel (a selection in the layer's space). */
export function maskFromCoverage(coverage: Uint8Array, width: number, height: number): Tiled {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < coverage.length; p++, i += 4) {
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = coverage[p];
  }
  return fromBuffer({ width, height, data });
}

/** One coverage byte per pixel, read back from a mask buffer. */
export function maskCoverage(buf: PixelBuffer): Uint8Array {
  const out = new Uint8Array(buf.width * buf.height);
  for (let p = 0; p < out.length; p++) out[p] = buf.data[p * 4 + 3];
  return out;
}

/** Hidden becomes shown and shown becomes hidden (tile by tile; the grid is kept). */
export function invertMaskTiled(mask: Tiled): Tiled {
  const tiles = mask.tiles.map((t) => {
    const data = new Uint8ClampedArray(t.data.length);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255 - t.data[i + 3];
    }
    return { width: t.width, height: t.height, data };
  });
  return { ...mask, tiles };
}

/** The layer's pixels with the mask baked into their alpha ("Apply mask"). */
export function applyMaskToBuffer(buf: PixelBuffer, mask: PixelBuffer): PixelBuffer {
  const data = new Uint8ClampedArray(buf.data);
  const n = Math.min(buf.width * buf.height, mask.width * mask.height);
  for (let p = 0; p < n; p++) {
    const m = mask.data[p * 4 + 3];
    if (m !== 255) data[p * 4 + 3] = (data[p * 4 + 3] * m) / 255;
  }
  return { width: buf.width, height: buf.height, data };
}

/** Adds a mask to a layer: from a coverage (the selection) or revealing everything. */
export function addLayerMask(doc: PhotoDoc, id: string, coverage: Uint8Array | null = null): PhotoDoc {
  const layer = layerById(doc, id);
  const size = layer && maskSize(layer);
  if (!layer || !size || layer.mask) return doc;
  const mask = coverage && coverage.length === size.width * size.height
    ? maskFromCoverage(coverage, size.width, size.height)
    : solidMask(size.width, size.height);
  return setLayerMask(doc, id, mask);
}

export function invertLayerMask(doc: PhotoDoc, id: string): PhotoDoc {
  const layer = layerById(doc, id);
  return layer?.mask ? setLayerMask(doc, id, invertMaskTiled(layer.mask)) : doc;
}

/**
 * Bakes a raster layer's mask into its pixels and removes the mask. Adjustment layers have no
 * pixels to bake into, so for them this is a no-op (their mask stays editable).
 */
export function applyLayerMask(doc: PhotoDoc, id: string): PhotoDoc {
  const layer = layerById(doc, id);
  if (!layer || layer.kind !== 'raster' || !layer.mask || layer.locked) return doc;
  const baked = applyMaskToBuffer(toBuffer(layer.tiled), toBuffer(layer.mask));
  return replaceLayer(doc, { ...layer, tiled: fromBuffer(baked), mask: null });
}

/** Black paints "hide", white paints "reveal": the brush's colour decides by its luminance. */
export function maskPaintHides(hex: string): boolean {
  const s = hex.replace('#', '');
  const r = parseInt(s.slice(0, 2), 16) || 0;
  const g = parseInt(s.slice(2, 4), 16) || 0;
  const b = parseInt(s.slice(4, 6), 16) || 0;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/**
 * An adjustment layer over what is already composited: `adjusted` is `below` run through the
 * layer's pipeline; the result mixes the two by `coverage` (the mask/box, null = everywhere)
 * times `opacity`. Alpha is always `below`'s — an adjustment never adds or removes pixels.
 * Writes into `below` and returns it (the caller owns that copy).
 */
export function blendAdjusted(
  below: PixelBuffer, adjusted: PixelBuffer, coverage: Uint8Array | null, opacity: number,
): PixelBuffer {
  const k = Math.max(0, Math.min(1, opacity));
  if (k === 0) return below;
  const d = below.data;
  const a = adjusted.data;
  for (let p = 0, i = 0; i < d.length; p++, i += 4) {
    if (d[i + 3] === 0) continue;
    const t = (coverage ? coverage[p] / 255 : 1) * k;
    if (t <= 0) continue;
    if (t >= 1) { d[i] = a[i]; d[i + 1] = a[i + 1]; d[i + 2] = a[i + 2]; continue; }
    d[i] = d[i] + (a[i] - d[i]) * t;
    d[i + 1] = d[i + 1] + (a[i + 1] - d[i + 1]) * t;
    d[i + 2] = d[i + 2] + (a[i + 2] - d[i + 2]) * t;
  }
  return below;
}
