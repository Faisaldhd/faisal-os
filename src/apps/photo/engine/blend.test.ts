import { describe, expect, it } from 'vitest';
import {
  BLEND_MODES, blendChannel, blendColor, blendPixel, compositeLayer, flattenLayers, lum, sat, type BlendMode,
} from './blend';
import { createImg, prng, solidImg } from './core';
import { imgFrom, px } from './test-utils';

describe('engine/blend — W3C separable formulas', () => {
  const cases: [BlendMode, number, number, number][] = [
    ['normal', 0.3, 0.8, 0.8],
    ['multiply', 0.5, 0.5, 0.25],
    ['screen', 0.5, 0.5, 0.75],
    ['overlay', 0.25, 0.5, 0.25],
    ['overlay', 0.75, 0.5, 0.75],
    ['darken', 0.3, 0.6, 0.3],
    ['lighten', 0.3, 0.6, 0.6],
    ['color-dodge', 0.5, 0.5, 1],
    ['color-dodge', 0.25, 0.5, 0.5],
    ['color-dodge', 0, 1, 0],
    ['color-burn', 0.5, 0.5, 0],
    ['color-burn', 0.75, 0.5, 0.5],
    ['color-burn', 1, 0, 1],
    ['hard-light', 0.5, 0.25, 0.25],
    ['hard-light', 0.5, 0.75, 0.75],
    ['soft-light', 0.25, 0.75, 0.375],
    ['soft-light', 0.5, 0.25, 0.375],
    ['soft-light', 0.64, 1, 0.8],
    ['difference', 0.7, 0.2, 0.5],
    ['exclusion', 0.5, 0.5, 0.5],
    ['exclusion', 1, 0.25, 0.75],
  ];
  for (const [mode, cb, cs, want] of cases) {
    it(`${mode}(Cb ${cb}, Cs ${cs}) = ${want}`, () => {
      expect(blendChannel(mode, cb, cs)).toBeCloseTo(want, 10);
    });
  }
});

describe('engine/blend — non-separable modes', () => {
  it('color keeps the backdrop luminosity with the source hue/saturation', () => {
    const out = blendColor('color', [0.5, 0.5, 0.5], [1, 0, 0]);
    expect(lum(out)).toBeCloseTo(0.5, 10);
    expect(out[0]).toBeCloseTo(1, 10);
    expect(out[1]).toBeCloseTo(0.2 / 0.7, 10);
  });

  it('luminosity keeps the backdrop colour with the source luminosity', () => {
    const out = blendColor('luminosity', [1, 0, 0], [0.2, 0.2, 0.2]);
    expect(lum(out)).toBeCloseTo(0.2, 10);
    expect(out[0]).toBeGreaterThan(out[1]);
  });

  it('hue keeps backdrop saturation + luminosity; saturation keeps backdrop hue + luminosity', () => {
    const cb: [number, number, number] = [0.8, 0.4, 0.2];
    const cs: [number, number, number] = [0.1, 0.3, 0.9];
    const h = blendColor('hue', cb, cs);
    expect(lum(h)).toBeCloseTo(lum(cb), 10);
    expect(h[2]).toBeGreaterThan(h[0]); // takes the blue hue
    const s = blendColor('saturation', cb, [0.5, 0.5, 0.5]);
    expect(sat(s)).toBeCloseTo(0, 10); // grey source → no saturation
    expect(lum(s)).toBeCloseTo(lum(cb), 10);
  });
});

describe('engine/blend — premultiplied compositing', () => {
  it('opaque normal = source; half opacity = halfway', () => {
    expect(blendPixel('normal', [0, 0, 0, 255], [255, 128, 0, 255])).toEqual([255, 128, 0, 255]);
    expect(blendPixel('normal', [0, 0, 0, 255], [255, 255, 255, 255], 0.5)).toEqual([127.5, 127.5, 127.5, 255]);
  });

  it('a translucent layer over nothing keeps its colour (no darkening), any mode', () => {
    for (const mode of BLEND_MODES) {
      const [r, g, b, a] = blendPixel(mode, [0, 0, 0, 0], [200, 100, 50, 128]);
      expect([r, g, b].map(Math.round)).toEqual([200, 100, 50]);
      expect(a).toBeCloseTo(128, 10);
    }
  });

  it('source-over alpha: αo = αs + αb(1 − αs)', () => {
    const out = blendPixel('multiply', [255, 255, 255, 128], [0, 0, 0, 128]);
    expect(out[3]).toBeCloseTo(255 * (0.502 + 0.502 * 0.498), 0);
  });

  it('compositeLayer matches blendPixel for every mode on random pixels', () => {
    const rnd = prng(5);
    for (const mode of BLEND_MODES) {
      const back = createImg(16, 16);
      const src = createImg(16, 16);
      for (let i = 0; i < back.data.length; i++) { back.data[i] = rnd() * 256; src.data[i] = rnd() * 256; }
      const before = new Uint8ClampedArray(back.data);
      compositeLayer(back, src, { mode, opacity: 0.8 });
      for (let i = 0; i < back.data.length; i += 4) {
        const want = new Uint8ClampedArray(blendPixel(mode, Array.from(before.subarray(i, i + 4)), Array.from(src.data.subarray(i, i + 4)), 0.8));
        for (let c = 0; c < 4; c++) expect(Math.abs(back.data[i + c] - want[c])).toBeLessThanOrEqual(1);
      }
    }
  });

  it('multiply/screen on opaque pixels give the textbook bytes', () => {
    const b = imgFrom(1, 1, [[200, 100, 50, 255]]);
    compositeLayer(b, imgFrom(1, 1, [[128, 255, 0, 255]]), { mode: 'multiply' });
    expect(px(b, 0, 0)).toEqual([100, 100, 0, 255]);
    const s = imgFrom(1, 1, [[200, 100, 50, 255]]);
    compositeLayer(s, imgFrom(1, 1, [[128, 255, 0, 255]]), { mode: 'screen' });
    expect(px(s, 0, 0)).toEqual([228, 255, 50, 255]);
  });

  it('offsets and clips the layer, honours a layer mask, returns the changed rect', () => {
    const dst = solidImg(4, 4, [0, 0, 0, 255]);
    const layer = solidImg(3, 3, [255, 255, 255, 255]);
    const mask = new Uint8Array(9).fill(255);
    mask[0] = 0;
    const r = compositeLayer(dst, layer, { x: 2, y: 2, mask });
    expect(r).toEqual({ x: 2, y: 2, w: 2, h: 2 });
    expect(px(dst, 2, 2)).toEqual([0, 0, 0, 255]); // masked out
    expect(px(dst, 3, 3)).toEqual([255, 255, 255, 255]);
    expect(px(dst, 1, 1)).toEqual([0, 0, 0, 255]);
    expect(compositeLayer(dst, layer, { x: 10, y: 0 })).toBeNull();
    expect(compositeLayer(dst, layer, { opacity: 0 })).toBeNull();
  });

  it('flattenLayers stacks bottom-first and skips hidden layers', () => {
    const red = solidImg(2, 2, [255, 0, 0, 255]);
    const blue = solidImg(2, 2, [0, 0, 255, 255]);
    const flat = flattenLayers(2, 2, [{ image: red }, { image: blue, opacity: 0.5 }, { image: red, visible: false }]);
    expect(px(flat, 0, 0)).toEqual([128, 0, 128, 255]);
    const bg = flattenLayers(1, 1, [], [255, 255, 255, 255]);
    expect(px(bg, 0, 0)).toEqual([255, 255, 255, 255]);
  });
});
