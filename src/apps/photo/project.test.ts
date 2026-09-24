import { describe, expect, it } from 'vitest';
import { ProjectError, isProjectPath, parseProject, serializeProject, type RasterCodec } from './project';
import { addLayer, docFromBuffer, shapeLayer, solidBuffer, textLayer, updateLayer } from './layers';
import { toBuffer } from './tiles';

/** A lossless stand-in for PNG: raw RGBA as base64. */
const codec: RasterCodec = {
  async encode(buf) {
    let s = '';
    for (const v of buf.data) s += String.fromCharCode(v);
    return btoa(s);
  },
  async decode(payload, width, height) {
    const bin = atob(payload);
    const data = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return { width, height, data };
  },
};

describe('project — .fphoto round trip', () => {
  it('reopens every layer with name, opacity, blend, lock, matrix and editable text', async () => {
    let d = docFromBuffer(solidBuffer(4, 3, [10, 20, 30, 255]), 'Background');
    d = addLayer(d, textLayer({
      text: 'فيصل OS', font: 'naskh', size: 32, color: '#c8894b', bold: true, italic: false,
      align: 'center', direction: 'rtl', outline: '#000000', outlineWidth: 2,
    }, { x: 2, y: 1 }, 'عنوان'));
    d = addLayer(d, shapeLayer({
      shape: 'arrow', from: { x: 0, y: 0 }, to: { x: 3, y: 2 }, fill: null, stroke: '#5b8def', strokeWidth: 3, radius: 0,
    }, 'Arrow'));
    d = updateLayer(d, d.layers[1].id, { opacity: 0.5, blend: 'screen', locked: true, visible: false });
    const back = await parseProject(await serializeProject(d, codec), codec);
    expect([back.width, back.height]).toEqual([4, 3]);
    const summary = (x: typeof d) => x.layers.map((l) => [l.kind, l.name, l.opacity, l.blend, l.locked, l.visible, l.matrix]);
    expect(summary(back)).toEqual(summary(d));
    const t = back.layers[1];
    expect(t.kind === 'text' && t.text).toEqual((d.layers[1] as { text: unknown }).text);
    const bg = back.layers[0];
    expect(bg.kind === 'raster' && Array.from(toBuffer(bg.tiled).data))
      .toEqual(Array.from(solidBuffer(4, 3, [10, 20, 30, 255]).data));
    const s = back.layers[2];
    expect(s.kind === 'shape' && s.shape).toEqual((d.layers[2] as { shape: unknown }).shape);
    expect(back.activeId).toBe(back.layers[2].id);
  });

  it('refuses what is not a project, and sanitises hostile fields', async () => {
    await expect(parseProject('nope', codec)).rejects.toBeInstanceOf(ProjectError);
    await expect(parseProject('{"format":"other","layers":[]}', codec)).rejects.toThrow('wrong-format');
    await expect(parseProject(JSON.stringify({ format: 'faisal-photo', version: 99, width: 2, height: 2, layers: [{}] }), codec))
      .rejects.toThrow('newer-version');
    const hostile = JSON.stringify({
      format: 'faisal-photo', version: 1, width: 5, height: 5, active: 99,
      layers: [{ kind: 'text', name: 'x', opacity: 9, blend: '<script>', matrix: ['a'], text: { text: 'hi', color: 'red;x', size: -5 } }],
    });
    const d = await parseProject(hostile, codec);
    const l = d.layers[0];
    expect(l.opacity).toBe(1);
    expect(l.blend).toBe('normal');
    expect(l.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(l.kind === 'text' && [l.text.color, l.text.size]).toEqual(['#ffffff', 4]);
    await expect(parseProject(JSON.stringify({ format: 'faisal-photo', version: 1, width: 2, height: 2, layers: [{ kind: 'raster', width: 2, height: 2 }] }), codec))
      .rejects.toThrow('bad-layer');
  });

  it('recognises the extension', () => {
    expect(isProjectPath('/home/user/a.FPHOTO')).toBe(true);
    expect(isProjectPath('/home/user/a.png')).toBe(false);
  });
});
