import { describe, expect, it } from 'vitest';
import {
  adjust, adjustImage, adjustPixelReference, applyPipeline, buildPipeline, contrastSlope, curveTable,
  exposureFactor, hueMatrix, isNeutralAdjust, levelsValue, luma601, type Adjustments,
} from './adjust';
import { imgFrom, px, randomImg, bigImg } from './test-utils';

const one = (rgba: number[], adj: Adjustments) => px(adjustImage(imgFrom(1, 1, [rgba]), adj), 0, 0);

describe('engine/adjust — single operators, exact pixels', () => {
  it('neutral settings are an exact copy (alpha included)', () => {
    const src = randomImg(8, 8, 2, false);
    const out = adjustImage(src, {});
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
    expect(out.data).not.toBe(src.data);
    expect(isNeutralAdjust({ brightness: 0, hue: 0, levels: { master: {} }, curves: { r: [] } })).toBe(true);
    expect(isNeutralAdjust({ hue: 10 })).toBe(false);
    expect(buildPipeline({}).identity).toBe(true);
  });

  it('brightness adds levels and never touches alpha', () => {
    expect(one([100, 150, 200, 128], { brightness: 20 })).toEqual([120, 170, 220, 128]);
    expect(one([250, 5, 0, 7], { brightness: -10 })).toEqual([240, 0, 0, 7]);
  });

  it('exposure is a light multiplier ×0.25…×4', () => {
    expect(exposureFactor(100)).toBe(4);
    expect(exposureFactor(-100)).toBe(0.25);
    expect(one([50, 10, 0, 255], { exposure: 100 })).toEqual([200, 40, 0, 255]);
    expect(one([200, 100, 40, 255], { exposure: -100 })).toEqual([50, 25, 10, 255]);
  });

  it('contrast is a slope around 128', () => {
    expect(contrastSlope(100)).toBe(4);
    expect(one([140, 128, 120, 255], { contrast: 100 })).toEqual([176, 128, 96, 255]);
    expect(one([10, 128, 250, 255], { contrast: -100 })).toEqual([128, 128, 128, 255]);
  });

  it('temperature warms (R up, B down) and tint shifts green↔magenta', () => {
    // d = 255 · 0.6 · 0.35 = 53.55
    expect(one([100, 100, 100, 255], { temperature: 100 })).toEqual([154, 100, 46, 255]);
    expect(one([100, 100, 100, 255], { tint: 100 })).toEqual([120, 60, 120, 255]);
    expect(one([100, 100, 100, 255], { tint: -50 })).toEqual([90, 120, 90, 255]);
  });

  it('highlights roll only the bright half, shadows only the dark half', () => {
    expect(one([255, 128, 0, 255], { highlights: -100 })).toEqual([159, 128, 0, 255]);
    expect(one([255, 128, 0, 255], { shadows: 100 })).toEqual([255, 128, 96, 255]);
  });

  it('whites/blacks move the ends, leaving the other end fixed', () => {
    expect(one([255, 0, 128, 255], { whites: -100 })).toEqual([191, 0, 112, 255]);
    expect(one([255, 0, 128, 255], { blacks: 100 })).toEqual([255, 64, 144, 255]);
  });

  it('gamma brightens or darkens the midtones and keeps the ends', () => {
    // γ 2 → 255 · (64/255)^0.5 = 127.75
    expect(one([64, 0, 255, 255], { gamma: 100 })).toEqual([128, 0, 255, 255]);
    // γ 0.5 → 255 · (128/255)^2 = 64.25
    expect(one([128, 0, 255, 255], { gamma: -100 })).toEqual([64, 0, 255, 255]);
  });

  it('levels remap the input range, gamma and output range', () => {
    expect(levelsValue(110, { inBlack: 50, inWhite: 200 })).toBeCloseTo(102, 10);
    expect(levelsValue(20, { inBlack: 50 })).toBe(0);
    expect(levelsValue(255, { outWhite: 200 })).toBe(200);
    expect(levelsValue(0, { outBlack: 30 })).toBe(30);
    expect(one([110, 110, 110, 255], { levels: { master: { inBlack: 50, inWhite: 200 } } })).toEqual([102, 102, 102, 255]);
    // Per-channel levels only touch their own channel.
    expect(one([100, 100, 100, 255], { levels: { g: { outBlack: 255 } } })).toEqual([100, 255, 100, 255]);
  });

  it('saturation −100 is the Rec. 601 grey; grayscale/invert flags', () => {
    const y = Math.round(luma601(200, 100, 50));
    expect(one([200, 100, 50, 9], { saturation: -100 })).toEqual([y, y, y, 9]);
    expect(one([200, 100, 50, 9], { grayscale: true })).toEqual([y, y, y, 9]);
    expect(one([200, 100, 50, 9], { invert: true })).toEqual([55, 155, 205, 9]);
    expect(one([200, 100, 50, 9], { invert: true, saturation: -100 })).toEqual([255 - y, 255 - y, 255 - y, 9]);
  });

  it('hue rotation keeps greys and 0° is identity', () => {
    expect(one([90, 90, 90, 255], { hue: 120 })).toEqual([90, 90, 90, 255]);
    const m = hueMatrix(77);
    for (let r = 0; r < 3; r++) expect(m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2]).toBeCloseTo(1, 10);
    const rot = one([200, 40, 40, 255], { hue: 120 });
    expect(rot[1]).toBeGreaterThan(rot[0]); // red turns towards green
  });

  it('vibrance boosts muted colours more than saturated ones', () => {
    const muted = one([140, 120, 110, 255], { vibrance: 100 });
    const vivid = one([250, 10, 10, 255], { vibrance: 100 });
    expect(muted[0] - muted[2]).toBeGreaterThan(140 - 110);
    // Saturation 0.96 → factor 1.04 only: G/B move from 10 to 7.
    expect(vivid).toEqual([255, 7, 7, 255]);
  });
});

describe('engine/adjust — curves', () => {
  it('a diagonal curve is identity, a reversed one inverts', () => {
    const id = curveTable([[0, 0], [255, 255]]);
    const inv = curveTable([[0, 255], [255, 0]]);
    for (let x = 0; x < 256; x++) {
      expect(id[x]).toBeCloseTo(x, 9);
      expect(inv[x]).toBeCloseTo(255 - x, 9);
    }
    expect(Array.from(curveTable([[0, 0], [128, 128], [255, 255]]).map(Math.round))).toEqual(
      Array.from({ length: 256 }, (_, i) => i),
    );
  });

  it('is monotone, passes through every control point and is flat outside them', () => {
    const pts: [number, number][] = [[30, 20], [60, 100], [100, 110], [180, 230], [220, 240]];
    const t = curveTable(pts);
    for (const [x, y] of pts) expect(t[x]).toBeCloseTo(y, 9);
    for (let x = 1; x < 256; x++) expect(t[x]).toBeGreaterThanOrEqual(t[x - 1] - 1e-9);
    expect(t[0]).toBe(20);
    expect(t[255]).toBe(240);
  });

  it('applies master then per-channel', () => {
    const out = one([64, 64, 64, 255], { curves: { master: [[0, 0], [255, 255]], b: [[0, 255], [255, 0]] } });
    expect(out).toEqual([64, 64, 191, 255]);
  });
});

describe('engine/adjust — one combined pass equals the step-by-step maths', () => {
  const stack: Adjustments = {
    exposure: 12, brightness: -6, contrast: 18, highlights: -25, shadows: 30, whites: 10, blacks: -12,
    gamma: 15, temperature: 20, tint: -8, saturation: 14, vibrance: 22, hue: 12,
    levels: { master: { inBlack: 6, inWhite: 248, gamma: 1.1 } },
    curves: { master: [[0, 0], [64, 58], [192, 200], [255, 255]], r: [[0, 4], [255, 250]] },
  };

  it('matches the per-pixel reference on a random image (full stack with colour stage)', () => {
    const src = randomImg(64, 64, 11);
    const out = applyPipeline(src, buildPipeline(stack));
    let exact = 0;
    for (let i = 0; i < src.data.length; i += 4) {
      const ref = adjustPixelReference(src.data[i], src.data[i + 1], src.data[i + 2], stack);
      const r8 = new Uint8ClampedArray(ref);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(out.data[i + c] - r8[c])).toBeLessThanOrEqual(1);
        if (out.data[i + c] === r8[c]) exact++;
      }
      expect(out.data[i + 3]).toBe(255);
    }
    expect(exact / ((src.data.length / 4) * 3)).toBeGreaterThan(0.99);
  });

  it('matches the reference exactly on the tonal-only (byte LUT) path', () => {
    const tonal: Adjustments = { ...stack, saturation: 0, vibrance: 0, hue: 0 };
    const src = randomImg(32, 32, 5);
    const out = applyPipeline(src, buildPipeline(tonal));
    for (let i = 0; i < src.data.length; i += 4) {
      const ref = new Uint8ClampedArray(adjustPixelReference(src.data[i], src.data[i + 1], src.data[i + 2], tonal));
      expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual(Array.from(ref));
    }
  });

  it('is within one level of applying the operators as separate passes', () => {
    const src = randomImg(32, 32, 9);
    const combined = adjustImage(src, { brightness: 10, contrast: 20, temperature: 15 });
    const seq = adjustImage(adjustImage(adjustImage(src, { brightness: 10 }), { contrast: 20 }), { temperature: 15 });
    for (let i = 0; i < src.data.length; i++) expect(Math.abs(combined.data[i] - seq.data[i])).toBeLessThanOrEqual(1);
  });

  it('can run in place and through a mask with an amount', () => {
    const src = imgFrom(2, 1, [[100, 100, 100, 255], [100, 100, 100, 255]]);
    const masked = adjustImage(src, { brightness: 50 }, { mask: new Uint8Array([255, 0]) });
    expect(px(masked, 0, 0)).toEqual([150, 150, 150, 255]);
    expect(px(masked, 1, 0)).toEqual([100, 100, 100, 255]);
    const half = adjustImage(src, { brightness: 50 }, { amount: 0.5 });
    expect(px(half, 0, 0)).toEqual([125, 125, 125, 255]);
    const same = adjustImage(src, { brightness: 10 }, { out: src });
    expect(same).toBe(src);
    expect(px(src, 1, 0)).toEqual([110, 110, 110, 255]);
  });

  it('seam adjust(buf, flatRecord) reads sliders and flags and ignores unknown keys', () => {
    const src = imgFrom(1, 1, [[100, 150, 200, 77]]);
    expect(px(adjust(src, { brightness: 20, foo: 99, invert: false }), 0, 0)).toEqual([120, 170, 220, 77]);
    expect(px(adjust(src, { invert: true }), 0, 0)).toEqual([155, 105, 55, 77]);
    expect(px(src, 0, 0)).toEqual([100, 150, 200, 77]);
  });
});

describe('engine/adjust — performance', () => {
  it('a full adjustment stack on 4000×3000 runs in under ~400 ms', () => {
    const stack: Adjustments = {
      exposure: 10, brightness: 5, contrast: 15, highlights: -20, shadows: 25, whites: 5, blacks: -5, gamma: 10,
      temperature: 12, tint: 4, saturation: 10, vibrance: 20, hue: 8,
      levels: { master: { inBlack: 4, inWhite: 250 } }, curves: { master: [[0, 0], [128, 140], [255, 255]] },
    };
    const warm = randomImg(256, 256, 1);
    adjustImage(warm, stack);
    const big = bigImg(4000, 3000);
    // Best of up to five runs: the suite runs files in parallel, so a single run can be
    // slowed by a neighbour; the fastest run is the engine's own cost.
    let best = Infinity;
    for (let run = 0; run < 5 && best >= 400; run++) {
      const t0 = performance.now();
      adjustImage(big, stack, { out: big });
      best = Math.min(best, performance.now() - t0);
    }
    // eslint-disable-next-line no-console
    console.log(`[perf] full adjustment stack 4000×3000: ${best.toFixed(0)} ms`);
    expect(best).toBeLessThan(400);
  });
});
