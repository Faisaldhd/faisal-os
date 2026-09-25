import { describe, expect, it } from 'vitest';
import { EXACT_GAUSS_BELOW, boxesForGauss, createImg, gaussKernel, solidImg } from './core';
import {
  FILTER_IDS, FILTER_PRESETS, PRESET_IDS, applyFilter, applyPreset, blur, convolve3x3, edgeDetect, emboss,
  grayscale, invert, noise, pixelate, posterize, presetById, presetThumbnails, sepia, sharpen, vignette,
} from './filters';
import { bigImg, imgFrom, px, randomImg } from './test-utils';

describe('engine/filters — point filters', () => {
  it('grayscale and sepia use the W3C matrices', () => {
    expect(px(grayscale(imgFrom(1, 1, [[255, 0, 0, 200]])), 0, 0)).toEqual([54, 54, 54, 200]);
    expect(px(grayscale(imgFrom(1, 1, [[255, 0, 0, 200]]), 0), 0, 0)).toEqual([255, 0, 0, 200]);
    expect(px(sepia(imgFrom(1, 1, [[100, 100, 100, 255]])), 0, 0)).toEqual([135, 120, 94, 255]);
  });

  it('invert keeps alpha', () => {
    expect(px(invert(imgFrom(1, 1, [[10, 20, 30, 40]])), 0, 0)).toEqual([245, 235, 225, 40]);
  });

  it('posterize snaps to n evenly spaced levels', () => {
    const src = imgFrom(3, 1, [[100, 200, 0, 255], [127, 128, 255, 255], [60, 190, 30, 255]]);
    expect(Array.from(posterize(src, 2).data)).toEqual([0, 255, 0, 255, 0, 255, 255, 255, 0, 255, 0, 255]);
    // 3 levels: 0, 127.5→128, 255
    expect(px(posterize(src, 3), 0, 0)).toEqual([128, 255, 0, 255]);
  });
});

describe('engine/filters — blur and sharpen', () => {
  it('three boxes approximate the Gaussian variance (sigma ≥ 2); small sigmas use an exact kernel', () => {
    for (const sigma of [EXACT_GAUSS_BELOW, 2.5, 5, 12, 40]) {
      const v = boxesForGauss(sigma).reduce((s, w) => s + (w * w - 1) / 12, 0);
      expect(Math.abs(Math.sqrt(v) - sigma) / sigma).toBeLessThan(0.1);
      for (const w of boxesForGauss(sigma)) expect(w % 2).toBe(1);
    }
    const k = gaussKernel(1);
    expect(k.length).toBe(7);
    expect(k.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
    const variance = k.reduce((s, v, i) => s + v * (i - 3) ** 2, 0);
    expect(Math.sqrt(variance)).toBeCloseTo(1, 1);
  });

  it('a flat image stays exactly flat; radius 0 is a copy', () => {
    const flat = solidImg(9, 7, [12, 200, 90, 255]);
    expect(Array.from(blur(flat, 3).data)).toEqual(Array.from(flat.data));
    const r = randomImg(5, 5, 4);
    expect(Array.from(blur(r, 0).data)).toEqual(Array.from(r.data));
  });

  it('spreads an impulse symmetrically and roughly conserves its energy', () => {
    const img = solidImg(21, 21, [0, 0, 0, 255]);
    img.data.set([255, 255, 255, 255], (10 * 21 + 10) * 4);
    const out = blur(img, 2);
    let sum = 0;
    for (let i = 0; i < out.data.length; i += 4) sum += out.data[i];
    expect(Math.abs(sum - 255)).toBeLessThan(255 * 0.1);
    expect(px(out, 8, 10)).toEqual(px(out, 12, 10));
    expect(px(out, 10, 8)).toEqual(px(out, 10, 12));
    expect(out.data[(10 * 21 + 10) * 4]).toBeGreaterThan(out.data[(10 * 21 + 12) * 4]);
  });

  it('is premultiplied: a transparent neighbour does not darken the colour (no halo)', () => {
    const img = createImg(10, 1);
    for (let x = 0; x < 5; x++) img.data.set([255, 0, 0, 255], x * 4);
    const out = blur(img, 2);
    for (let x = 0; x < 10; x++) {
      const [r, g, b, a] = px(out, x, 0);
      if (a > 0) expect([r, g, b]).toEqual([255, 0, 0]);
    }
    expect(px(out, 4, 0)[3]).toBeLessThan(255);
    expect(px(out, 5, 0)[3]).toBeGreaterThan(0);
  });

  it('sharpen leaves flat areas alone and overshoots at an edge', () => {
    const flat = solidImg(6, 6, [80, 80, 80, 255]);
    expect(Array.from(sharpen(flat, 2).data)).toEqual(Array.from(flat.data));
    const edge = createImg(8, 1);
    for (let x = 0; x < 8; x++) edge.data.set(x < 4 ? [50, 50, 50, 255] : [200, 200, 200, 255], x * 4);
    const out = sharpen(edge, 1.5, 1);
    expect(px(out, 3, 0)[0]).toBeLessThan(50);
    expect(px(out, 4, 0)[0]).toBeGreaterThan(200);
    expect(px(out, 0, 0)[0]).toBe(50);
  });
});

describe('engine/filters — spatial effects', () => {
  it('vignette darkens corners, keeps the centre, 0 is identity', () => {
    const img = solidImg(21, 21, [200, 200, 200, 255]);
    const out = vignette(img, 100);
    expect(px(out, 10, 10)).toEqual([200, 200, 200, 255]);
    expect(px(out, 0, 0)[0]).toBeLessThan(80);
    expect(px(vignette(img, -100), 0, 0)[0]).toBeGreaterThan(200);
    expect(Array.from(vignette(img, 0).data)).toEqual(Array.from(img.data));
  });

  it('noise is deterministic by seed and unbiased on average', () => {
    const img = solidImg(64, 64, [128, 128, 128, 255]);
    const a = noise(img, 50, 3);
    expect(Array.from(noise(img, 50, 3).data)).toEqual(Array.from(a.data));
    expect(Array.from(noise(img, 50, 4).data)).not.toEqual(Array.from(a.data));
    let sum = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      sum += a.data[i];
      expect(a.data[i]).toBe(a.data[i + 1]); // mono
    }
    expect(Math.abs(sum / (64 * 64) - 128)).toBeLessThan(2);
    expect(Array.from(noise(img, 0).data)).toEqual(Array.from(img.data));
  });

  it('pixelate averages each block (alpha-weighted)', () => {
    const img = imgFrom(3, 2, [
      [0, 0, 0, 255], [100, 100, 100, 255], [7, 7, 7, 255],
      [200, 0, 0, 255], [40, 60, 80, 0], [9, 9, 9, 255],
    ]);
    const out = pixelate(img, 2);
    // Block (0..1, 0..1): three opaque pixels average (0+100+200)/3=100, (0+100+0)/3; alpha (3·255)/4.
    expect(px(out, 0, 0)).toEqual([100, 33, 33, 191]);
    expect(px(out, 1, 1)).toEqual([100, 33, 33, 191]);
    // Edge block (x = 2) is 1 pixel wide.
    expect(px(out, 2, 0)).toEqual([8, 8, 8, 255]);
  });

  it('3×3 convolution: identity kernel is a copy; emboss keeps flat colour; edges find edges', () => {
    const r = randomImg(6, 5, 8);
    expect(Array.from(convolve3x3(r, [0, 0, 0, 0, 1, 0, 0, 0, 0]).data)).toEqual(Array.from(r.data));
    const flat = solidImg(5, 5, [90, 60, 30, 255]);
    expect(Array.from(emboss(flat).data)).toEqual(Array.from(flat.data));
    expect(px(edgeDetect(flat), 2, 2)).toEqual([0, 0, 0, 255]);
    const step = createImg(6, 3);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 6; x++) step.data.set(x < 3 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * 6 + x) * 4);
    const e = edgeDetect(step);
    expect(px(e, 2, 1)[0]).toBe(255);
    expect(px(e, 0, 1)[0]).toBe(0);
    // Sobel gx at the step: (255 + 2·255 + 255) = 1020 → clamped to 255.
  });
});

describe('engine/filters — named looks', () => {
  it('has the owner looks, each changing a colourful image', () => {
    for (const id of ['warm', 'cool', 'vintage', 'mono', 'vivid', 'fade', 'noir', 'golden', 'desert']) {
      expect(presetById(id)).toBeDefined();
    }
    expect(new Set(PRESET_IDS).size).toBe(PRESET_IDS.length);
    const src = randomImg(16, 16, 21);
    for (const p of FILTER_PRESETS) {
      expect(Array.from(applyPreset(src, p).data)).not.toEqual(Array.from(src.data));
      expect(Array.from(applyPreset(src, p, 0).data)).toEqual(Array.from(src.data));
    }
  });

  it('warm is warmer than cool; mono and noir are grey', () => {
    const grey = solidImg(4, 4, [128, 128, 128, 255]);
    const w = px(applyPreset(grey, 'warm'), 1, 1);
    const c = px(applyPreset(grey, 'cool'), 1, 1);
    expect(w[0] - w[2]).toBeGreaterThan(0);
    expect(c[2] - c[0]).toBeGreaterThan(0);
    const src = randomImg(8, 8, 2);
    for (const id of ['mono', 'noir']) {
      const out = applyPreset(src, id);
      for (let i = 0; i < out.data.length; i += 4) {
        expect(out.data[i]).toBe(out.data[i + 1]);
        expect(out.data[i + 1]).toBe(out.data[i + 2]);
      }
    }
  });

  it('renders every look as a thumbnail of a 12 MP photo quickly', () => {
    const big = bigImg(4000, 3000);
    let ms = Infinity;
    let thumbs = new Map();
    for (let run = 0; run < 3 && ms >= 1500; run++) {
      const t0 = performance.now();
      thumbs = presetThumbnails(big, 96);
      ms = Math.min(ms, performance.now() - t0);
    }
    // eslint-disable-next-line no-console
    console.log(`[perf] ${thumbs.size} look thumbnails from 4000×3000: ${ms.toFixed(0)} ms`);
    expect(thumbs.size).toBe(FILTER_PRESETS.length);
    for (const t of thumbs.values()) {
      expect(t.width).toBe(96);
      expect(t.height).toBe(72);
    }
    expect(ms).toBeLessThan(1500);
  });
});

describe('engine/filters — 12 MP', () => {
  it('runs every filter on a 4000×3000 photo in reasonable time', () => {
    const big = bigImg(4000, 3000);
    const times: string[] = [];
    for (const id of FILTER_IDS) {
      const t0 = performance.now();
      const out = applyFilter(big, id, 1, 1);
      const ms = performance.now() - t0;
      times.push(`${id} ${ms.toFixed(0)}`);
      expect(out.width).toBe(4000);
      expect(out.height).toBe(3000);
      // Generous: CI machines vary; this catches a quadratic or per-pixel-allocation regression.
      expect(ms).toBeLessThan(15000);
    }
    // eslint-disable-next-line no-console
    console.log(`[perf] 4000×3000 filters (ms): ${times.join(', ')}`);
  }, 240000);
});

describe('engine/filters — the ops.ts seam applyFilter(buf, id, amount, scale)', () => {
  it('knows every id; amount 0 of a look is identity; unknown ids copy', () => {
    const src = randomImg(12, 12, 6);
    expect(FILTER_IDS).toContain('blur');
    expect(FILTER_IDS).toContain('vintage');
    for (const id of FILTER_IDS) {
      const out = applyFilter(src, id, 60, 1);
      expect(out.width).toBe(12);
      expect(out.data.length).toBe(src.data.length);
    }
    expect(Array.from(applyFilter(src, 'vivid', 0, 1).data)).toEqual(Array.from(src.data));
    expect(Array.from(applyFilter(src, 'blur', 0, 1).data)).toEqual(Array.from(src.data));
    const unknown = applyFilter(src, 'nope', 100, 1);
    expect(Array.from(unknown.data)).toEqual(Array.from(src.data));
    expect(unknown.data).not.toBe(src.data);
  });

  it('invert at 50% lands halfway; scale shrinks the blur radius for proxies', () => {
    const src = imgFrom(1, 1, [[0, 100, 255, 255]]);
    expect(px(applyFilter(src, 'invert', 50, 1), 0, 0)).toEqual([128, 128, 128, 255]);
    const imp = solidImg(31, 1, [0, 0, 0, 255]);
    imp.data.set([255, 255, 255, 255], 15 * 4);
    const wide = applyFilter(imp, 'blur', 50, 1);
    const narrow = applyFilter(imp, 'blur', 50, 0.25);
    expect(px(narrow, 15, 0)[0]).toBeGreaterThan(px(wide, 15, 0)[0]);
  });
});
