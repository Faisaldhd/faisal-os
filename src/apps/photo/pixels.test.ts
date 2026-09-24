import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_ORDER, FILTER_PRESETS, applyAdjustments, applyAdjustmentsToPixel, applyPreset, boxBlur,
  bufferBytes, clamp255, clampSigned100, contrastSlope, createBuffer, ditherRound, exposureFactor,
  isNeutral, luma, presetById, saturationFactor, sharpen,
} from './pixels';
import type { PixelBuffer } from './types';

/** One opaque pixel plus transparent padding, so alpha handling can be checked too. */
function buf(width: number, height: number, rgba: [number, number, number, number]): PixelBuffer {
  const b = createBuffer(width, height);
  for (let i = 0; i < b.data.length; i += 4) {
    b.data[i] = rgba[0];
    b.data[i + 1] = rgba[1];
    b.data[i + 2] = rgba[2];
    b.data[i + 3] = rgba[3];
  }
  return b;
}

const neutral = { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, highlights: 0, shadows: 0 };

describe('pixels — clamping and buffer accounting', () => {
  it('clamps a sample to the byte range and a signed slider to ±100', () => {
    expect(clamp255(-40)).toBe(0);
    expect(clamp255(999)).toBe(255);
    expect(clamp255(128.4)).toBe(128.4);
    expect(clampSigned100(-200)).toBe(-100);
    expect(clampSigned100(200)).toBe(100);
  });

  it('reports exactly width × height × 4 bytes, which is what the history budget charges', () => {
    expect(bufferBytes(createBuffer(10, 4))).toBe(10 * 4 * 4);
    expect(createBuffer(0, 0).width).toBe(1);
    expect(createBuffer(0, 0).height).toBe(1);
  });

  it('rounds with an ordered dither inside the byte range', () => {
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(ditherRound(10.5, x, y)).toBeGreaterThanOrEqual(10);
        expect(ditherRound(10.5, x, y)).toBeLessThanOrEqual(11);
      }
    }
    expect(ditherRound(-5, 0, 0)).toBe(0);
    expect(ditherRound(300, 0, 0)).toBe(255);
  });
});

describe('pixels — each adjustment operator', () => {
  it('exposure is a multiplicative light factor, 1 at 0 and symmetric at the ends', () => {
    expect(exposureFactor(0)).toBe(1);
    expect(exposureFactor(100)).toBe(4);
    expect(exposureFactor(-100)).toBeCloseTo(0.25, 6);
    expect(exposureFactor(50)).toBeCloseTo(2.5, 6);
    expect(exposureFactor(500)).toBe(4); // clamped before use
  });

  it('brightness is a constant offset in 8-bit levels', () => {
    const [r, g, b] = applyAdjustmentsToPixel(100, 100, 100, { ...neutral, brightness: 30 });
    expect([r, g, b]).toEqual([130, 130, 130]);
  });

  it('contrast is a slope around the 128 midpoint: 0 slope is flat grey, +100 is ×4', () => {
    expect(contrastSlope(0)).toBe(1);
    expect(contrastSlope(100)).toBe(4);
    expect(contrastSlope(-100)).toBe(0);
    const dark = applyAdjustmentsToPixel(0, 0, 0, { ...neutral, contrast: 100 });
    const light = applyAdjustmentsToPixel(255, 255, 255, { ...neutral, contrast: 100 });
    expect(dark[0]).toBe(-384);
    expect(light[0]).toBe(636);
    const flat = applyAdjustmentsToPixel(10, 200, 90, { ...neutral, contrast: -100 });
    expect([flat[0], flat[1], flat[2]]).toEqual([128, 128, 128]);
  });

  it('saturation moves away from luminance: -100 is grey, 0 is identity, +100 doubles', () => {
    expect(saturationFactor(0)).toBe(1);
    expect(saturationFactor(-100)).toBe(0);
    expect(saturationFactor(100)).toBe(2);
    const [r, g, b] = applyAdjustmentsToPixel(200, 100, 50, { ...neutral, saturation: -100 });
    const y = luma(200, 100, 50);
    expect(r).toBeCloseTo(y, 6);
    expect(g).toBeCloseTo(y, 6);
    expect(b).toBeCloseTo(y, 6);
  });

  it('temperature warms by adding red and removing blue, and cools the other way', () => {
    const warm = applyAdjustmentsToPixel(128, 128, 128, { ...neutral, temperature: 100 });
    expect(warm[0]).toBeGreaterThan(128);
    expect(warm[2]).toBeLessThan(128);
    expect(warm[1]).toBe(128);
    const cool = applyAdjustmentsToPixel(128, 128, 128, { ...neutral, temperature: -100 });
    expect(cool[0]).toBeLessThan(128);
    expect(cool[2]).toBeGreaterThan(128);
  });

  it('highlights and shadows act only on their own end of the tone range', () => {
    // A dark pixel is untouched by a highlight change, and vice versa: the ramp weight is 0.
    const darkHi = applyAdjustmentsToPixel(40, 40, 40, { ...neutral, highlights: 60 });
    expect(darkHi).toEqual([40, 40, 40]);
    const brightSh = applyAdjustmentsToPixel(230, 230, 230, { ...neutral, shadows: 60 });
    expect(brightSh).toEqual([230, 230, 230]);
    // At full weight they move in opposite directions.
    const brightHi = applyAdjustmentsToPixel(255, 255, 255, { ...neutral, highlights: -60 });
    expect(brightHi[0]).toBeLessThan(255);
    const darkSh = applyAdjustmentsToPixel(0, 0, 0, { ...neutral, shadows: 60 });
    expect(darkSh[0]).toBeGreaterThan(0);
  });

  it('orders the operators deterministically, and a neutral set is the identity', () => {
    expect(ADJUSTMENT_ORDER).toEqual(['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'temperature', 'saturation']);
    expect(isNeutral(neutral)).toBe(true);
    const src = buf(2, 2, [12, 200, 77, 255]);
    const out = applyAdjustments(src, neutral);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('never changes the alpha channel', () => {
    const src = buf(3, 3, [10, 20, 30, 77]);
    const out = applyAdjustments(src, { ...neutral, exposure: 50, contrast: 20, saturation: -40 });
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(77);
  });

  it('clamps the result of an extreme adjustment instead of wrapping', () => {
    const src = buf(2, 2, [250, 250, 250, 255]);
    const out = applyAdjustments(src, { ...neutral, brightness: 100, exposure: 100 });
    expect(out.data[0]).toBe(255);
    const dark = applyAdjustments(buf(2, 2, [5, 5, 5, 255]), { ...neutral, brightness: -100 });
    expect(dark.data[0]).toBe(0);
  });
});

describe('pixels — blur and sharpen', () => {
  it('a box blur averages a hard edge into a ramp and keeps the buffer size', () => {
    const src = createBuffer(5, 1);
    for (let x = 0; x < 5; x++) {
      const value = x < 3 ? 0 : 255;
      const i = x * 4;
      src.data[i] = value; src.data[i + 1] = value; src.data[i + 2] = value; src.data[i + 3] = 255;
    }
    const out = boxBlur(src, 1, 1);
    expect(out.width).toBe(5);
    expect(out.height).toBe(1);
    // The middle pixel of a 3-wide window across the edge sits strictly between the two sides.
    expect(out.data[2 * 4]).toBeGreaterThan(0);
    expect(out.data[2 * 4]).toBeLessThan(255);
    // A radius of 0 is a copy, not a no-op object.
    expect(Array.from(boxBlur(src, 0).data)).toEqual(Array.from(src.data));
  });

  it('sharpen is the inverse direction of blur: it increases an edge contrast', () => {
    const src = createBuffer(5, 1);
    for (let x = 0; x < 5; x++) {
      const value = x < 2 ? 40 : 200;
      const i = x * 4;
      src.data[i] = value; src.data[i + 1] = value; src.data[i + 2] = value; src.data[i + 3] = 255;
    }
    const out = sharpen(src, 1);
    // Compare the magnitude of the step across the edge: sharpening widens it (clamping is
    // allowed to cut the overshoot, which is why the signed difference is not the metric).
    const before = Math.abs(Number(src.data[1 * 4]) - Number(src.data[2 * 4]));
    const after = Math.abs(Number(out.data[1 * 4]) - Number(out.data[2 * 4]));
    expect(after).toBeGreaterThan(before);
    expect(out.data[1 * 4]).toBeLessThan(40);      // the dark side got darker
    expect(out.data[2 * 4]).toBeGreaterThanOrEqual(200); // the bright side never drops
    expect(Array.from(sharpen(src, 0).data)).toEqual(Array.from(src.data));
  });
});

describe('pixels — named presets', () => {
  it('exposes eight presets, each findable by id and with the documented keys', () => {
    expect(FILTER_PRESETS.map((p) => p.id)).toEqual(['none', 'mono', 'sepia', 'vivid', 'soft', 'punch', 'warm', 'cool']);
    expect(presetById('warm')?.adjustments.temperature).toBe(28);
    expect(presetById('nope')).toBeUndefined();
  });

  it('mono really removes colour and sepia makes the channels unequal but non-grey', () => {
    const src = buf(2, 2, [200, 100, 50, 255]);
    const mono = applyPreset(src, presetById('mono')!, neutral);
    expect(mono.data[0]).toBe(mono.data[1]);
    expect(mono.data[1]).toBe(mono.data[2]);
    const sepia = applyPreset(src, presetById('sepia')!, neutral);
    expect(sepia.data[0]).toBeGreaterThan(sepia.data[2]);
  });

  it('a preset overrides only the base values it names', () => {
    const src = buf(1, 1, [128, 128, 128, 255]);
    const out = applyPreset(src, presetById('warm')!, { ...neutral, brightness: 0 });
    const warmOnly = applyAdjustments(src, { ...neutral, temperature: 28, brightness: 4 });
    expect(Array.from(out.data)).toEqual(Array.from(warmOnly.data));
  });

  it('the none preset is the identity', () => {
    const src = buf(2, 2, [9, 80, 250, 255]);
    expect(Array.from(applyPreset(src, presetById('none')!, neutral).data)).toEqual(Array.from(src.data));
  });
});
