import { describe, expect, it } from 'vitest';
import { clampFades, describeFades, fadeCurve, gainAt, gainDecibels, MAX_FADE_FRACTION, trackGainAt } from './fades';

describe('clampFades', () => {
  it('keeps both fades inside half of the result', () => {
    expect(clampFades({ fadeIn: 9, fadeOut: 9 }, 10)).toEqual({ fadeIn: 5, fadeOut: 5 });
  });

  it('never returns a negative fade', () => {
    expect(clampFades({ fadeIn: -3, fadeOut: -1 }, 10)).toEqual({ fadeIn: 0, fadeOut: 0 });
  });

  it('returns no fade when the result has no length', () => {
    expect(clampFades({ fadeIn: 2, fadeOut: 2 }, 0)).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(clampFades({ fadeIn: 2, fadeOut: 2 }, Number.NaN)).toEqual({ fadeIn: 0, fadeOut: 0 });
  });

  it('repairs non-finite input', () => {
    expect(clampFades({ fadeIn: Number.NaN, fadeOut: 1 }, 10)).toEqual({ fadeIn: 0, fadeOut: 1 });
  });
});

describe('gainAt', () => {
  it('ramps up across the fade-in', () => {
    const fades = { fadeIn: 2, fadeOut: 0 };
    expect(gainAt(0, 10, fades)).toBe(0);
    expect(gainAt(1, 10, fades)).toBeCloseTo(0.5, 10);
    expect(gainAt(2, 10, fades)).toBe(1);
    expect(gainAt(8, 10, fades)).toBe(1);
  });

  it('ramps down across the fade-out', () => {
    const fades = { fadeIn: 0, fadeOut: 2 };
    expect(gainAt(7, 10, fades)).toBe(1);
    expect(gainAt(9, 10, fades)).toBeCloseTo(0.5, 10);
    expect(gainAt(10, 10, fades)).toBe(0);
  });

  it('applies both ramps and never overshoots', () => {
    const fades = { fadeIn: 3, fadeOut: 3 };
    for (let at = 0; at <= 10; at += 0.1) {
      const value = gainAt(at, 10, fades);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(gainAt(0, 10, fades)).toBe(0);
    expect(gainAt(5, 10, fades)).toBe(1);
    expect(gainAt(10, 10, fades)).toBe(0);
  });

  it('meets at full gain in the middle when both fades are at the cap', () => {
    const length = 8;
    const fades = clampFades({ fadeIn: 99, fadeOut: 99 }, length);
    expect(fades.fadeIn).toBe(length * MAX_FADE_FRACTION);
    expect(fades.fadeOut).toBe(length * MAX_FADE_FRACTION);
    // Each ramp covers exactly half, so they meet at 1: the two fades never
    // overlap and the middle of the result is never attenuated.
    expect(gainAt(length / 2, length, fades)).toBe(1);
    expect(gainAt(0, length, fades)).toBe(0);
    expect(gainAt(length, length, fades)).toBe(0);
  });

  it('clamps a position outside the result', () => {
    expect(gainAt(-5, 10, { fadeIn: 0, fadeOut: 2 })).toBe(1);
    expect(gainAt(50, 10, { fadeIn: 0, fadeOut: 2 })).toBe(0);
  });

  it('is a steady 1 when there is no length or no fade', () => {
    expect(gainAt(1, 0, { fadeIn: 2, fadeOut: 2 })).toBe(1);
    expect(gainAt(5, 10, { fadeIn: 0, fadeOut: 0 })).toBe(1);
  });

  it('treats a non-finite position as the start', () => {
    expect(gainAt(Number.NaN, 10, { fadeIn: 2, fadeOut: 0 })).toBe(0);
  });
});

describe('trackGainAt', () => {
  it('multiplies the fade by the user gain', () => {
    expect(trackGainAt(5, 10, { fadeIn: 0, fadeOut: 0 }, 1.5)).toBeCloseTo(1.5, 10);
    expect(trackGainAt(1, 10, { fadeIn: 2, fadeOut: 0 }, 2)).toBeCloseTo(1, 10);
  });

  it('treats a broken multiplier as 1', () => {
    expect(trackGainAt(5, 10, { fadeIn: 0, fadeOut: 0 }, Number.NaN)).toBe(1);
  });
});

describe('fadeCurve', () => {
  it('produces a monotonically rising-then-falling curve with the right ends', () => {
    const curve = fadeCurve(10, { fadeIn: 2, fadeOut: 2 }, 10);
    expect(curve).toHaveLength(11);
    expect(curve[0]).toEqual({ at: 0, gain: 0 });
    expect(curve[curve.length - 1].gain).toBe(0);
    expect(Math.max(...curve.map((point) => point.gain))).toBe(1);
  });

  it('handles a zero-length result without dividing by zero', () => {
    const curve = fadeCurve(0, { fadeIn: 1, fadeOut: 1 }, 4);
    expect(curve.every((point) => Number.isFinite(point.gain))).toBe(true);
  });
});

describe('describing the fades', () => {
  it('reports the steady middle after the two ramps', () => {
    expect(describeFades(10, { fadeIn: 2, fadeOut: 3 })).toEqual({ fadeIn: 2, fadeOut: 3, steady: 5 });
  });

  it('reports no steady part when the ramps fill the result', () => {
    expect(describeFades(10, { fadeIn: 6, fadeOut: 6 }).steady).toBe(0);
  });

  it('converts a multiplier to decibels', () => {
    expect(gainDecibels(1)).toBeCloseTo(0, 10);
    expect(gainDecibels(0.5)).toBeCloseTo(-6.0206, 3);
    expect(gainDecibels(0)).toBe(-Infinity);
  });
});
