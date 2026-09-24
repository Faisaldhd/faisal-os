import { describe, expect, it } from 'vitest';
import { histogram, lumaIndex, percentile } from './histogram';
import { bigImg, imgFrom } from './test-utils';

describe('engine/histogram', () => {
  it('counts exact bins for R, G, B and fixed-point luma', () => {
    const img = imgFrom(4, 1, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [10, 10, 10, 255]]);
    const h = histogram(img);
    expect(h.count).toBe(4);
    expect(h.r[255]).toBe(1);
    expect(h.r[0]).toBe(2);
    expect(h.r[10]).toBe(1);
    expect(h.g[255]).toBe(1);
    expect(h.b[255]).toBe(1);
    expect(lumaIndex(255, 0, 0)).toBe(77);
    expect(lumaIndex(0, 255, 0)).toBe(149);
    expect(lumaIndex(0, 0, 255)).toBe(29);
    expect(lumaIndex(255, 255, 255)).toBe(255);
    expect(h.l[77]).toBe(1);
    expect(h.l[149]).toBe(1);
    expect(h.l[29]).toBe(1);
    expect(h.l[10]).toBe(1);
    expect(h.max).toBe(2);
    for (const bins of [h.r, h.g, h.b, h.l]) expect(bins.reduce((s, v) => s + v, 0)).toBe(4);
  });

  it('skips nearly transparent pixels, supports a step and a mask', () => {
    const img = imgFrom(4, 1, [[1, 1, 1, 255], [2, 2, 2, 7], [3, 3, 3, 8], [4, 4, 4, 255]]);
    const h = histogram(img);
    expect(h.count).toBe(3);
    expect(h.r[2]).toBe(0);
    expect(histogram(img, 2).count).toBe(2); // pixels 0 and 2
    const m = histogram(img, 1, new Uint8Array([0, 255, 255, 127]));
    expect(m.count).toBe(1);
    expect(m.r[3]).toBe(1);
  });

  it('works on a subarray view that is not 4-byte aligned (slow path)', () => {
    const buf = new Uint8ClampedArray(9);
    const view = buf.subarray(1, 9);
    view.set([5, 6, 7, 255, 5, 6, 7, 255]);
    const h = histogram({ width: 2, height: 1, data: view });
    expect(h.r[5]).toBe(2);
    expect(h.g[6]).toBe(2);
  });

  it('percentile finds the clip points for auto-levels', () => {
    const bins = new Uint32Array(256);
    bins[10] = 5; bins[100] = 90; bins[250] = 5;
    expect(percentile(bins, 0.01)).toBe(10);
    expect(percentile(bins, 0.5)).toBe(100);
    expect(percentile(bins, 1)).toBe(250);
    expect(percentile(new Uint32Array(256), 0.5)).toBe(0);
  });

  it('is fast on 12 MP', () => {
    const big = bigImg(4000, 3000);
    histogram(big, 64);
    let ms = Infinity;
    let h = histogram(big, 1000);
    for (let run = 0; run < 3 && ms >= 300; run++) {
      const t0 = performance.now();
      h = histogram(big);
      ms = Math.min(ms, performance.now() - t0);
    }
    // eslint-disable-next-line no-console
    console.log(`[perf] histogram 4000×3000: ${ms.toFixed(0)} ms`);
    expect(h.count).toBe(12_000_000);
    expect(ms).toBeLessThan(300);
  });
});
