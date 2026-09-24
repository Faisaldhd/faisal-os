import { describe, expect, it } from 'vitest';
import {
  BLEND_MODES, activeLayer, addLayer, compositeOperation, cropDoc, docFromBuffer, duplicateLayer, flipDoc,
  layerBounds, moveLayer, moveLayerTo, newBufferBytes, nextLayerName, pickVectorLayer, rasterLayer, removeLayer,
  rotateDocQuarter, setRaster, shapeLayer, solidBuffer, textLayer, translateLayer, updateLayer,
  type RasterLayer, type TextSpec,
} from './layers';
import { blankTiled, writeRegion } from './tiles';

const text: TextSpec = {
  text: 'مرحبا', font: 'system', size: 20, color: '#ffffff', bold: false, italic: false,
  align: 'start', direction: 'auto', outline: null, outlineWidth: 0,
};
const measure = () => ({ x: -50, y: 0, w: 50, h: 25 });

function doc3() {
  let d = docFromBuffer(solidBuffer(100, 80, [255, 255, 255, 255]), 'Background');
  d = addLayer(d, textLayer(text, { x: 90, y: 10 }, 'Text'));
  d = addLayer(d, shapeLayer({
    shape: 'rect', from: { x: 10, y: 10 }, to: { x: 30, y: 40 }, fill: '#ff0000', stroke: null, strokeWidth: 0, radius: 0,
  }, 'Shape'));
  return d;
}

describe('layers — stack edits', () => {
  it('adds above the active layer and activates it', () => {
    const d = doc3();
    expect(d.layers.map((l) => l.name)).toEqual(['Background', 'Text', 'Shape']);
    expect(activeLayer(d).name).toBe('Shape');
    const d2 = addLayer({ ...d, activeId: d.layers[0].id }, rasterLayer(blankTiled(100, 80), 'New'));
    expect(d2.layers.map((l) => l.name)).toEqual(['Background', 'New', 'Text', 'Shape']);
  });

  it('duplicates sharing pixels, removes (never the last or a locked one), reorders', () => {
    const d = doc3();
    const dup = duplicateLayer(d, d.layers[0].id, 'copy');
    expect(dup.layers[1].name).toBe('Background copy');
    expect((dup.layers[1] as RasterLayer).tiled).toBe((dup.layers[0] as RasterLayer).tiled);
    expect(removeLayer(d, d.layers[1].id).layers).toHaveLength(2);
    const locked = updateLayer(d, d.layers[1].id, { locked: true });
    expect(removeLayer(locked, d.layers[1].id).layers).toHaveLength(3);
    const single = docFromBuffer(solidBuffer(2, 2, [0, 0, 0, 0]), 'bg');
    expect(removeLayer(single, single.layers[0].id)).toBe(single);
    expect(moveLayer(d, d.layers[2].id, -1).layers.map((l) => l.name)).toEqual(['Background', 'Shape', 'Text']);
    expect(moveLayer(d, d.layers[2].id, 1)).toBe(d);
    expect(moveLayerTo(d, d.layers[2].id, 0).layers.map((l) => l.name)).toEqual(['Shape', 'Background', 'Text']);
  });

  it('clamps opacity and maps blend modes to canvas operations', () => {
    const d = doc3();
    const d2 = updateLayer(d, d.layers[1].id, { opacity: 3, blend: 'multiply' });
    expect(d2.layers[1].opacity).toBe(1);
    expect(d2.layers[1].blend).toBe('multiply');
    expect(compositeOperation('normal')).toBe('source-over');
    expect(compositeOperation('multiply')).toBe('multiply');
    for (const m of ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten']) expect(BLEND_MODES).toContain(m);
  });

  it('names new layers without collisions', () => {
    expect(nextLayerName(doc3(), 'Layer')).toBe('Layer 4');
  });
});

describe('layers — whole-image operations keep vector layers editable', () => {
  it('crops by shifting every layer, without touching pixels', () => {
    const d = doc3();
    const c = cropDoc(d, { x: 10, y: 5, w: 50, h: 40 });
    expect([c.width, c.height]).toEqual([50, 40]);
    expect(c.layers[0].matrix).toEqual([1, 0, 0, 1, -10, -5]);
    expect((c.layers[0] as RasterLayer).tiled).toBe((d.layers[0] as RasterLayer).tiled);
    expect(c.layers[1].kind).toBe('text');
  });

  it('rotates and flips the canvas and every layer matrix', () => {
    const d = doc3();
    const r = rotateDocQuarter(d, 1);
    expect([r.width, r.height]).toEqual([80, 100]);
    expect(layerBounds(r.layers[2], measure)).toEqual({ x: 40, y: 10, w: 30, h: 20 });
    expect(flipDoc(d, 'h').layers[0].matrix).toEqual([-1, 0, 0, 1, 100, 0]);
  });

  it('moves a layer (not a locked one) and hit-tests vector layers top-down', () => {
    const d = doc3();
    const moved = translateLayer(d, d.layers[2].id, 5, 5);
    expect(layerBounds(moved.layers[2], measure)).toEqual({ x: 15, y: 15, w: 20, h: 30 });
    const locked = updateLayer(d, d.layers[2].id, { locked: true });
    expect(translateLayer(locked, d.layers[2].id, 5, 5)).toBe(locked);
    expect(pickVectorLayer(d, { x: 20, y: 20 }, measure)?.name).toBe('Shape');
    expect(pickVectorLayer(d, { x: 60, y: 10 }, measure)?.name).toBe('Text');
    expect(pickVectorLayer(d, { x: 95, y: 70 }, measure)).toBeNull();
  });
});

describe('layers — history cost', () => {
  it('charges only the tiles a step added', () => {
    const d = doc3();
    const bg = d.layers[0] as RasterLayer;
    const one = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    const painted = setRaster(d, bg.id, writeRegion(bg.tiled, 0, 0, one));
    const cost = newBufferBytes(d, painted);
    expect(cost).toBe(100 * 80 * 4 + 256 * 3);
    const renamed = updateLayer(d, d.layers[1].id, { name: 'x' });
    expect(newBufferBytes(d, renamed)).toBe(256 * 3);
  });
});
