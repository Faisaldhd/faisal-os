import { describe, expect, it } from 'vitest';
import { solidImg } from './core';
import {
  applyThroughMask, combineMasks, ellipseMask, emptyMask, featherMask, fullMask, invertMask, isMaskEmpty,
  magicWand, maskBounds, maskOutline, polygonMask, rectMask,
} from './select';
import { imgFrom, px } from './test-utils';

const sum = (m: Uint8Array) => m.reduce((s, v) => s + (v ? 1 : 0), 0);
const rows = (m: Uint8Array, w: number) => {
  const out: string[] = [];
  for (let i = 0; i < m.length; i += w) out.push(Array.from(m.subarray(i, i + w), (v) => (v >= 128 ? '#' : '.')).join(''));
  return out;
};

describe('engine/select — shapes', () => {
  it('rectangle: exact pixels, any drag direction, clipped', () => {
    expect(rows(rectMask(5, 3, { x: 1, y: 1, w: 3, h: 2 }), 5)).toEqual(['.....', '.###.', '.###.']);
    expect(rows(rectMask(5, 3, { x: 4, y: 3, w: -3, h: -2 }), 5)).toEqual(['.....', '.###.', '.###.']);
    expect(sum(rectMask(4, 4, { x: -5, y: -5, w: 100, h: 100 }))).toBe(16);
  });

  it('ellipse: solid centre, empty corners, symmetric, soft edge', () => {
    const m = ellipseMask(11, 11, { x: 0, y: 0, w: 11, h: 11 });
    expect(m[5 * 11 + 5]).toBe(255);
    expect(m[0]).toBe(0);
    for (let y = 0; y < 11; y++) for (let x = 0; x < 11; x++) {
      expect(m[y * 11 + x]).toBe(m[y * 11 + (10 - x)]);
      expect(m[y * 11 + x]).toBe(m[(10 - y) * 11 + x]);
    }
    expect(Array.from(m).some((v) => v > 0 && v < 255)).toBe(true);
    const area = m.reduce((s, v) => s + v / 255, 0);
    expect(Math.abs(area - Math.PI * 5.5 * 5.5)).toBeLessThan(1.5);
  });

  it('lasso polygon: even-odd scanline fill at pixel centres', () => {
    const sq = polygonMask(6, 6, [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 4 }, { x: 1, y: 4 }]);
    expect(rows(sq, 6)).toEqual(['......', '.####.', '.####.', '.####.', '......', '......']);
    const tri = polygonMask(5, 4, [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 4 }]);
    expect(rows(tri, 5)).toEqual(['####.', '###..', '##...', '#....']);
    expect(sum(polygonMask(5, 5, [{ x: 0, y: 0 }, { x: 3, y: 3 }]))).toBe(0);
  });
});

describe('engine/select — magic wand', () => {
  const img = imgFrom(5, 1, [[100, 100, 100, 255], [110, 100, 100, 255], [0, 0, 0, 255], [105, 100, 100, 255], [140, 100, 100, 255]]);

  it('contiguous: stops at a different colour; tolerance is per channel', () => {
    expect(Array.from(magicWand(img, 0, 0, { tolerance: 10 }))).toEqual([255, 255, 0, 0, 0]);
    expect(Array.from(magicWand(img, 0, 0, { tolerance: 9 }))).toEqual([255, 0, 0, 0, 0]);
    expect(Array.from(magicWand(img, 0, 0, { tolerance: 0 }))).toEqual([255, 0, 0, 0, 0]);
  });

  it('global: every similar pixel, connected or not', () => {
    expect(Array.from(magicWand(img, 0, 0, { tolerance: 10, contiguous: false }))).toEqual([255, 255, 0, 255, 0]);
    expect(Array.from(magicWand(img, 0, 0, { tolerance: 255, contiguous: false }))).toEqual([255, 255, 255, 255, 255]);
  });

  it('alpha counts as a channel; off-image seed is empty', () => {
    const a = imgFrom(2, 1, [[0, 0, 0, 0], [0, 0, 0, 255]]);
    expect(Array.from(magicWand(a, 0, 0, { tolerance: 50 }))).toEqual([255, 0]);
    expect(isMaskEmpty(magicWand(a, -1, 0))).toBe(true);
    expect(isMaskEmpty(magicWand(a, 2, 0))).toBe(true);
  });

  it('fills a 4-connected region around an obstacle (no diagonal leaks), large area without recursion', () => {
    const b = solidImg(5, 5, [255, 255, 255, 255]);
    // A closed black ring around the centre pixel.
    for (const [x, y] of [[1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3]]) b.data.set([0, 0, 0, 255], (y * 5 + x) * 4);
    const outside = magicWand(b, 0, 0, { tolerance: 10 });
    expect(sum(outside)).toBe(16);
    expect(outside[2 * 5 + 2]).toBe(0);
    const big = solidImg(2000, 2000, [9, 9, 9, 255]);
    expect(sum(magicWand(big, 1000, 1000, { tolerance: 0 }))).toBe(4_000_000);
  });
});

describe('engine/select — mask maths', () => {
  it('combine: add = max, subtract = a·(255−b)/255, intersect = a·b/255 (same as selection.ts)', () => {
    const a = new Uint8Array([0, 255, 255, 128, 200]);
    const b = new Uint8Array([255, 0, 255, 128, 100]);
    expect(Array.from(combineMasks(a, b, 'add'))).toEqual([255, 255, 255, 128, 200]);
    expect(Array.from(combineMasks(a, b, 'subtract'))).toEqual([0, 255, 0, 64, 122]);
    expect(Array.from(combineMasks(a, b, 'intersect'))).toEqual([0, 0, 255, 64, 78]);
    expect(Array.from(combineMasks(a, b, 'replace'))).toEqual(Array.from(b));
    expect(Array.from(combineMasks(null, b, 'add'))).toEqual(Array.from(b));
    expect(isMaskEmpty(combineMasks(null, b, 'intersect'))).toBe(true);
  });

  it('invert, bounds, empty/full', () => {
    expect(Array.from(invertMask(new Uint8Array([0, 255, 100])))).toEqual([255, 0, 155]);
    expect(maskBounds(rectMask(10, 8, { x: 2, y: 3, w: 4, h: 2 }), 10, 8)).toEqual({ x: 2, y: 3, w: 4, h: 2 });
    expect(maskBounds(emptyMask(3, 3), 3, 3)).toBeNull();
    expect(sum(fullMask(3, 2))).toBe(6);
  });

  it('feather softens the edge but keeps the deep inside and far outside', () => {
    const m = rectMask(40, 40, { x: 10, y: 10, w: 20, h: 20 });
    const f = featherMask(m, 40, 40, 3);
    expect(f[20 * 40 + 20]).toBe(255);
    expect(f[0]).toBe(0);
    expect(f[20 * 40 + 10]).toBeGreaterThan(90);
    expect(f[20 * 40 + 10]).toBeLessThan(200);
    expect(f[20 * 40 + 8]).toBeGreaterThan(0);
    expect(Array.from(featherMask(m, 40, 40, 0))).toEqual(Array.from(m));
  });

  it('outline of one pixel is its four edges', () => {
    const m = new Uint8Array(9);
    m[4] = 255;
    const seg = maskOutline(m, 3, 3);
    expect(seg.length).toBe(16);
    expect(seg).toEqual([1, 1, 2, 1, 1, 2, 2, 2, 1, 1, 1, 2, 2, 1, 2, 2]);
  });

  it('applyThroughMask changes only masked pixels (soft ones partly)', () => {
    const src = imgFrom(3, 1, [[0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]]);
    const out = applyThroughMask(src, new Uint8Array([255, 0, 51]), (img) => {
      img.data.fill(255);
      return img;
    });
    expect(px(out, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(px(out, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(px(out, 2, 0)).toEqual([51, 51, 51, 255]);
    expect(px(src, 0, 0)).toEqual([0, 0, 0, 255]);
  });
});
