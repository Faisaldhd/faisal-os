import { describe, expect, it } from 'vitest';
import {
  addLayerMask, applyLayerMask, applyMaskToBuffer, blendAdjusted, invertLayerMask, maskCoverage, maskFromCoverage,
  maskPaintHides, solidMask,
} from './masks';
import {
  adjustLayer, docFromBuffer, layerBounds, maskSize, newBufferBytes, pickVectorLayer, rotateDocQuarter, setLayerMask,
  textLayer, addLayer, updateAdjust, type PhotoDoc,
} from './layers';
import { toBuffer } from './tiles';
import { NEUTRAL_ADJUST } from './ops';
import { parseProject, serializeProject, type RasterCodec } from './project';
import type { PixelBuffer } from './types';

function solid(w: number, h: number, rgba: number[]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
}

const codec: RasterCodec = {
  async encode(buf) { return JSON.stringify([buf.width, buf.height, Array.from(buf.data)]); },
  async decode(payload) {
    const [w, h, d] = JSON.parse(payload) as [number, number, number[]];
    return { width: w, height: h, data: new Uint8ClampedArray(d) };
  },
};

const measure = () => ({ x: 0, y: 0, w: 10, h: 10 });

describe('layer masks', () => {
  it('builds masks from a value or a coverage, and reads the coverage back', () => {
    expect(Array.from(maskCoverage(toBuffer(solidMask(2, 1))))).toEqual([255, 255]);
    expect(Array.from(maskCoverage(toBuffer(maskFromCoverage(new Uint8Array([0, 128]), 2, 1))))).toEqual([0, 128]);
  });

  it('adds (from the selection), inverts, applies and deletes a raster mask', () => {
    let doc = docFromBuffer(solid(2, 1, [10, 20, 30, 255]), 'bg');
    const id = doc.activeId;
    doc = addLayerMask(doc, id, new Uint8Array([255, 0]));
    expect(Array.from(maskCoverage(toBuffer(doc.layers[0].mask!)))).toEqual([255, 0]);
    expect(addLayerMask(doc, id)).toBe(doc); // one mask per layer
    doc = invertLayerMask(doc, id);
    expect(Array.from(maskCoverage(toBuffer(doc.layers[0].mask!)))).toEqual([0, 255]);
    const applied = applyLayerMask(doc, id);
    expect(applied.layers[0].mask).toBeNull();
    const px = toBuffer((applied.layers[0] as { tiled: Parameters<typeof toBuffer>[0] }).tiled).data;
    expect([px[3], px[7]]).toEqual([0, 255]);
    expect(setLayerMask(doc, id, null).layers[0].mask).toBeNull();
  });

  it('refuses masks on text layers and masks of the wrong size', () => {
    let doc = docFromBuffer(solid(2, 2, [0, 0, 0, 255]), 'bg');
    const t = textLayer({ text: 'x', font: 'system', size: 10, color: '#fff', bold: false, italic: false, align: 'start', direction: 'auto', outline: null, outlineWidth: 0 }, { x: 0, y: 0 }, 't');
    doc = addLayer(doc, t);
    expect(maskSize(t)).toBeNull();
    expect(addLayerMask(doc, t.id)).toBe(doc);
    expect(setLayerMask(doc, doc.layers[0].id, solidMask(3, 3))).toBe(doc);
  });

  it('bakes partial coverage into alpha and follows the layer through a rotation', () => {
    const out = applyMaskToBuffer(solid(1, 1, [1, 2, 3, 200]), toBuffer(maskFromCoverage(new Uint8Array([128]), 1, 1)));
    expect(Math.abs(out.data[3] - 100)).toBeLessThanOrEqual(1);
    let doc = addLayerMask(docFromBuffer(solid(4, 2, [0, 0, 0, 255]), 'bg'), '', null);
    doc = addLayerMask(doc, doc.activeId);
    const turned = rotateDocQuarter(doc, 1);
    expect(turned.layers[0].mask).toBe(doc.layers[0].mask); // same pixels, new matrix
    expect(newBufferBytes(null, doc)).toBeGreaterThan(newBufferBytes(null, docFromBuffer(solid(4, 2, [0, 0, 0, 255]), 'bg')));
  });

  it('paints black to hide and white to reveal', () => {
    expect(maskPaintHides('#000000')).toBe(true);
    expect(maskPaintHides('#ffffff')).toBe(false);
    expect(maskPaintHides('#1a1d26')).toBe(true);
  });
});

describe('adjustment layers', () => {
  it('are non-destructive layers with their own box, never picked as vector layers', () => {
    let doc: PhotoDoc = docFromBuffer(solid(4, 3, [100, 100, 100, 255]), 'bg');
    const bgTiles = (doc.layers[0] as { tiled: unknown }).tiled;
    const a = adjustLayer({ ...NEUTRAL_ADJUST, brightness: 40 }, doc.width, doc.height, 'Adj');
    doc = addLayer(doc, a);
    expect((doc.layers[0] as { tiled: unknown }).tiled).toBe(bgTiles);
    expect(layerBounds(a, measure)).toEqual({ x: 0, y: 0, w: 4, h: 3 });
    expect(pickVectorLayer(doc, { x: 1, y: 1 }, measure)).toBeNull();
    doc = updateAdjust(doc, a.id, { contrast: 20 });
    const adj = doc.layers[1];
    expect(adj.kind === 'adjust' && adj.adjust.brightness === 40 && adj.adjust.contrast === 20).toBe(true);
    expect(maskSize(adj)).toEqual({ width: 4, height: 3 });
  });

  it('mixes the adjusted pixels by coverage × opacity and never changes alpha', () => {
    const below = solid(3, 1, [0, 0, 0, 200]);
    below.data[11] = 0; // third pixel transparent
    const adjusted = solid(3, 1, [200, 100, 50, 200]);
    blendAdjusted(below, adjusted, new Uint8Array([255, 128, 255]), 1);
    expect(Array.from(below.data.slice(0, 4))).toEqual([200, 100, 50, 200]);
    expect(below.data[4]).toBeGreaterThan(95);
    expect(below.data[4]).toBeLessThan(105);
    expect(below.data[7]).toBe(200);
    expect(below.data[8]).toBe(0); // transparent pixel untouched
    const half = solid(1, 1, [0, 0, 0, 255]);
    blendAdjusted(half, solid(1, 1, [100, 100, 100, 255]), null, 0.5);
    expect(half.data[0]).toBe(50);
  });
});

describe('project — masks and adjustment layers survive save/reopen', () => {
  it('round-trips both, writes version 2 only when needed', async () => {
    let doc = docFromBuffer(solid(2, 2, [5, 6, 7, 255]), 'bg');
    const plain = JSON.parse(await serializeProject(doc, codec));
    expect(plain.version).toBe(1);
    doc = addLayerMask(doc, doc.activeId, new Uint8Array([255, 0, 0, 255]));
    doc = addLayer(doc, adjustLayer({ ...NEUTRAL_ADJUST, saturation: -50, invert: true }, 2, 2, 'Adj'));
    doc = addLayerMask(doc, doc.activeId);
    const json = await serializeProject(doc, codec);
    expect(JSON.parse(json).version).toBe(2);
    const back = await parseProject(json, codec);
    expect(Array.from(maskCoverage(toBuffer(back.layers[0].mask!)))).toEqual([255, 0, 0, 255]);
    const adj = back.layers[1];
    expect(adj.kind).toBe('adjust');
    if (adj.kind === 'adjust') {
      expect(adj.adjust.saturation).toBe(-50);
      expect(adj.adjust.invert).toBe(true);
      expect([adj.width, adj.height]).toEqual([2, 2]);
    }
    expect(adj.mask?.width).toBe(2);
  });

  it('clamps hostile adjustment values and rejects a mask of the wrong size', async () => {
    const base = { format: 'faisal-photo', version: 2, width: 2, height: 2, active: 0 };
    const back = await parseProject(JSON.stringify({ ...base, layers: [{ kind: 'adjust', adjust: { brightness: 9999, hue: 'x' }, width: 2, height: 2 }] }), codec);
    const l = back.layers[0];
    expect(l.kind === 'adjust' && l.adjust.brightness === 100 && l.adjust.hue === 0).toBe(true);
    const bad = { ...base, layers: [{ kind: 'adjust', adjust: {}, width: 2, height: 2, mask: { width: 3, height: 3, png: await codec.encode(solid(3, 3, [0, 0, 0, 0])) } }] };
    await expect(parseProject(JSON.stringify(bad), codec)).rejects.toThrow('bad-layer');
  });
});
