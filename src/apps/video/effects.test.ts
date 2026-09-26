import { describe, expect, it } from 'vitest';
import {
  blurAt, blurPixels, blackoutAt, darkAt, darkFrame, effectFilter, hasEffects, MAX_FADE,
  NO_EFFECTS, normalizeEffects,
} from './effects';

const fx = (patch: Partial<typeof NO_EFFECTS> = {}) => ({ ...NO_EFFECTS, ...patch });

/**
 * The curves are the whole feature: the compositor asks "how black is this frame right now" and
 * paints exactly that, in the preview and in the export alike, so a wrong curve is a wrong film.
 */
describe('fade to black, as a function of the clip clock', () => {
  it('is fully black at the start of a fade in, and clear once it is over', () => {
    const e = fx({ fadeIn: 1 });
    expect(blackoutAt(e, 0, 4)).toBe(1);
    expect(blackoutAt(e, 0.25, 4)).toBeCloseTo(0.75, 6);
    expect(blackoutAt(e, 0.5, 4)).toBeCloseTo(0.5, 6);
    expect(blackoutAt(e, 1, 4)).toBe(0);
    expect(blackoutAt(e, 2.5, 4)).toBe(0);
  });

  it('is clear until the last seconds, then closes for a fade out', () => {
    const e = fx({ fadeOut: 1 });
    expect(blackoutAt(e, 0, 4)).toBe(0);
    expect(blackoutAt(e, 2.9, 4)).toBe(0);
    expect(blackoutAt(e, 3, 4)).toBe(0);
    expect(blackoutAt(e, 3.5, 4)).toBeCloseTo(0.5, 6);
    expect(blackoutAt(e, 4, 4)).toBe(1);
  });

  it('never exceeds full black when the clip is shorter than its own fades', () => {
    const e = fx({ fadeIn: 3, fadeOut: 3 });
    for (const t of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
      const v = blackoutAt(e, t, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(blackoutAt(e, 0, 3)).toBe(1);
    expect(blackoutAt(e, 3, 3)).toBe(1);
  });

  it('does nothing without a fade, and survives nonsense clocks', () => {
    expect(blackoutAt(NO_EFFECTS, 1, 4)).toBe(0);
    expect(blackoutAt(fx({ fadeIn: 1 }), Number.NaN, 4)).toBe(1);
    expect(blackoutAt(fx({ fadeOut: 1 }), 2, Number.NaN)).toBe(0); // unknown length: no fade out
    expect(blackoutAt(fx({ fadeIn: 1 }), -5, 4)).toBe(1);
  });
});

describe('blur and dark frame strength', () => {
  it('reports the clamped strength, and a pixel radius that follows the frame size', () => {
    expect(blurAt(fx({ blur: 0.5 }), 1, 4)).toBe(0.5);
    expect(blurAt(fx({ blur: 5 }), 1, 4)).toBe(1);
    expect(blurAt(NO_EFFECTS, 1, 4)).toBe(0);
    expect(blurPixels(0, { width: 1920, height: 1080 })).toBe(0);
    expect(blurPixels(1, { width: 1920, height: 1080 })).toBeCloseTo(1080 * 0.012, 6);
    expect(blurPixels(1, { width: 640, height: 360 })).toBeCloseTo(360 * 0.012, 6);
    expect(darkAt(fx({ dark: 0.4 }), 0, 4)).toBe(0.4);
    expect(darkAt(fx({ dark: -1 }), 0, 4)).toBe(0);
  });

  it('builds a filter string that keeps the colour grade and adds the blur', () => {
    expect(effectFilter('none', 0)).toBe('none');
    expect(effectFilter('saturate(1.2)', 0)).toBe('saturate(1.2)');
    expect(effectFilter('none', 0.5)).toBe('blur(0.50px)');
    expect(effectFilter('saturate(1.2)', 13)).toBe('saturate(1.2) blur(13.00px)');
  });

  it('scales the dark frame with the picture and never fully hides it', () => {
    expect(darkFrame(0, { width: 1920, height: 1080 })).toEqual({ border: 0, alpha: 0 });
    const full = darkFrame(1, { width: 1920, height: 1080 });
    expect(full.border).toBeCloseTo(1080 * 0.06, 6);
    expect(full.alpha).toBeLessThanOrEqual(0.92);
    expect(darkFrame(0.5, { width: 640, height: 360 }).border).toBeCloseTo(360 * 0.06 * 0.5, 6);
  });
});

describe('reading effects from a project file', () => {
  it('clamps every number and drops anything that is not one', () => {
    expect(normalizeEffects(undefined)).toEqual(NO_EFFECTS);
    expect(normalizeEffects('nonsense')).toEqual(NO_EFFECTS);
    expect(normalizeEffects({ fadeIn: 99, fadeOut: -3, blur: 'x', dark: 0.5 }))
      .toEqual({ fadeIn: MAX_FADE, fadeOut: 0, blur: 0, dark: 0.5 });
    expect(normalizeEffects({ fadeIn: Number.NaN, blur: 2 })).toEqual({ fadeIn: 0, fadeOut: 0, blur: 1, dark: 0 });
  });

  it('knows when there is nothing to draw', () => {
    expect(hasEffects(NO_EFFECTS)).toBe(false);
    expect(hasEffects(undefined)).toBe(false);
    expect(hasEffects(null)).toBe(false);
    expect(hasEffects(fx({ blur: 0.01 }))).toBe(true);
    expect(hasEffects(fx({ fadeOut: 0.5 }))).toBe(true);
  });
});
