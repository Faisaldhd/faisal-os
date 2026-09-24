import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT_COLOR, MIN_COVERAGE, clampRect, colorContrast, contrastRatio, pickContrastTextColor,
  sampleRegion,
} from './contrast-text';
import type { PixelBuffer, Rect } from './types';

/**
 * Hand-computed expectations. The formulas were written out independently of the module and
 * evaluated once with a script, exactly as WCAG 2.x defines them:
 *
 *   lin(c) = (c / 255) <= 0.03928 ? (c / 255) / 12.92 : (((c / 255) + 0.055) / 1.055) ** 2.4
 *   L      = 0.2126·lin(r) + 0.7152·lin(g) + 0.0722·lin(b)
 *   ratio  = (Lmax + 0.05) / (Lmin + 0.05)
 */
const L_BLACK = 0;
const L_WHITE = 1;
const L_GREY_808080 = 0.21586050011389923;
const L_GREY_555555 = 0.09084171118340768;
const L_RED_FF0000 = 0.2126;
/** (1 + 0.05) / (0 + 0.05) */
const WHITE_ON_BLACK = 21;
/** (0.21586050011389923 + 0.05) / 0.05 */
const BLACK_ON_GREY_808080 = 5.317210002277984;
/** 1.05 / (0.21586050011389923 + 0.05) */
const WHITE_ON_GREY_808080 = 3.9494396480491156;
/** 1.05 / (0.09084171118340768 + 0.05) */
const WHITE_ON_GREY_555555 = 7.455177810447525;
/** A half-black half-white region averages to L = 0.5, so (0.5 + 0.05) / 0.05 */
const BLACK_ON_HALF = 11;

const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

/** A `PixelBuffer` — the app's own image type, so it also proves the structural compatibility. */
function buffer(width: number, height: number, fill: [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3];
  }
  return { width, height, data };
}

function paint(buf: PixelBuffer, x: number, y: number, rgba: readonly [number, number, number, number]): void {
  const i = (y * buf.width + x) * 4;
  buf.data[i] = rgba[0]; buf.data[i + 1] = rgba[1]; buf.data[i + 2] = rgba[2]; buf.data[i + 3] = rgba[3];
}

const all = (buf: PixelBuffer): Rect => ({ x: 0, y: 0, w: buf.width, h: buf.height });

describe('contrast-text — the WCAG maths, against hand-computed numbers', () => {
  it('matches the spec ratio on the two extremes (21:1)', () => {
    expect(colorContrast('#ffffff', '#000000')).toBeCloseTo(WHITE_ON_BLACK, 10);
    expect(colorContrast('#000000', '#ffffff')).toBeCloseTo(WHITE_ON_BLACK, 10);
    expect(contrastRatio(L_BLACK, L_WHITE)).toBeCloseTo(WHITE_ON_BLACK, 10);
  });

  it('reproduces the hand-computed luminance and ratio of #808080 and #555555', () => {
    const grey80 = buffer(2, 2, [128, 128, 128, 255]);
    const grey55 = buffer(2, 2, [85, 85, 85, 255]);
    expect(sampleRegion(grey80, all(grey80)).luminance).toBeCloseTo(L_GREY_808080, 10);
    expect(sampleRegion(grey55, all(grey55)).luminance).toBeCloseTo(L_GREY_555555, 10);
    expect(colorContrast('#000000', '#808080')).toBeCloseTo(BLACK_ON_GREY_808080, 10);
    expect(colorContrast('#ffffff', '#808080')).toBeCloseTo(WHITE_ON_GREY_808080, 10);
    expect(colorContrast('#ffffff', '#555555')).toBeCloseTo(WHITE_ON_GREY_555555, 10);
    // lin(255) = 1 and lin(0) = 0, so L(#ff0000) = 0.2126 and its ratio against black is
    // (0.2126 + 0.05) / 0.05 = 5.252.
    expect(L_RED_FF0000).toBeCloseTo(0.2126, 12);
    expect(colorContrast('#ff0000', '#000000')).toBeCloseTo(5.252, 10);
  });

  it('is symmetric and never falls below 1:1', () => {
    expect(contrastRatio(L_GREY_555555, L_WHITE)).toBeCloseTo(contrastRatio(L_WHITE, L_GREY_555555), 12);
    expect(contrastRatio(L_GREY_808080, L_GREY_808080)).toBeCloseTo(1, 12);
  });
});

describe('contrast-text — reading the colour under the box', () => {
  it('uses only the pixels the rect covers, not the whole image', () => {
    const img = buffer(4, 1, BLACK);
    paint(img, 2, 0, WHITE);
    paint(img, 3, 0, WHITE);
    const left = pickContrastTextColor(img, { x: 0, y: 0, w: 2, h: 1 });
    const right = pickContrastTextColor(img, { x: 2, y: 0, w: 2, h: 1 });
    expect(left.luminance).toBeCloseTo(L_BLACK, 12);
    expect(left.color).toBe('#ffffff');
    expect(right.luminance).toBeCloseTo(L_WHITE, 12);
    expect(right.color).toBe('#000000');
    expect(left.ratio).toBeCloseTo(WHITE_ON_BLACK, 10);
    expect(right.ratio).toBeCloseTo(WHITE_ON_BLACK, 10);
  });

  it('reports the box it really sampled and how much of it was opaque', () => {
    const img = buffer(8, 8, BLACK);
    const picked = pickContrastTextColor(img, { x: 2, y: 3, w: 4, h: 2 });
    expect(picked.pixels).toBe(8);
    expect(picked.coverage).toBe(1);
    expect(picked.fallback).toBe(false);
    expect(sampleRegion(img, { x: 2, y: 3, w: 4, h: 2 }).pixels).toBe(8);
  });

  it('lets a partially transparent pixel vote in proportion to its alpha', () => {
    const img = buffer(2, 1, BLACK);
    paint(img, 1, 0, [255, 255, 255, 128]);
    // The opaque black pixel weighs 1 and the half-transparent white one weighs 128/255, so
    // L = (0×1 + 1×(128/255)) / (1 + 128/255) = 0.3342036553524804: lighter than black, nowhere
    // near the 1 a fully white box would give.
    const sample = sampleRegion(img, all(img));
    expect(sample.luminance).toBeCloseTo(0.3342036553524804, 10);
    expect(sample.luminance).toBeLessThan(L_WHITE);
    // coverage = (255/255 + 128/255) / 2
    expect(sample.coverage).toBeCloseTo(0.7509803921568627, 12);
    // 0.3342 is well past the 0.179 crossover, so even this mixed region gets dark text.
    expect(pickContrastTextColor(img, all(img)).color).toBe('#000000');
  });

  it('keeps the luminance of a uniformly translucent region unchanged', () => {
    const img = buffer(1, 1, [255, 255, 255, 128]);
    const sample = sampleRegion(img, all(img));
    expect(sample.luminance).toBeCloseTo(L_WHITE, 12);
    expect(sample.coverage).toBeCloseTo(0.5019607843137255, 12);
    expect(pickContrastTextColor(img, all(img)).color).toBe('#000000');
  });
});

describe('contrast-text — the cases the client listed', () => {
  it('black region ⇒ light text, at the maximum 21:1', () => {
    const img = buffer(3, 3, BLACK);
    const picked = pickContrastTextColor(img, all(img));
    expect(picked.color).toBe('#ffffff');
    expect(picked.ratio).toBeCloseTo(WHITE_ON_BLACK, 10);
    expect(picked.luminance).toBeCloseTo(L_BLACK, 12);
    expect(picked.fallback).toBe(false);
  });

  it('white region ⇒ dark text, at the maximum 21:1', () => {
    const img = buffer(3, 3, WHITE);
    const picked = pickContrastTextColor(img, all(img));
    expect(picked.color).toBe('#000000');
    expect(picked.ratio).toBeCloseTo(WHITE_ON_BLACK, 10);
    expect(picked.luminance).toBeCloseTo(L_WHITE, 12);
  });

  it('mid grey ⇒ dark, because 5.317 beats the 3.949 the light candidate would get', () => {
    const img = buffer(3, 3, [128, 128, 128, 255]);
    const picked = pickContrastTextColor(img, all(img));
    expect(BLACK_ON_GREY_808080).toBeGreaterThan(WHITE_ON_GREY_808080);
    expect(picked.color).toBe('#000000');
    expect(picked.ratio).toBeCloseTo(BLACK_ON_GREY_808080, 10);
  });

  it('a dark-ish grey still wants light text (the crossover sits at L ≈ 0.179)', () => {
    const img = buffer(3, 3, [85, 85, 85, 255]);
    const picked = pickContrastTextColor(img, all(img));
    expect(L_GREY_555555).toBeLessThan(0.17912878474779204);
    expect(picked.color).toBe('#ffffff');
    expect(picked.ratio).toBeCloseTo(WHITE_ON_GREY_555555, 10);
  });

  it('a busy half-black half-white region ⇒ mean luminance 0.5, dark text at 11:1', () => {
    const img = buffer(2, 2, BLACK);
    paint(img, 1, 0, WHITE);
    paint(img, 0, 1, WHITE);
    const picked = pickContrastTextColor(img, all(img));
    expect(picked.luminance).toBeCloseTo(0.5, 12);
    expect(picked.color).toBe('#000000');
    expect(picked.ratio).toBeCloseTo(BLACK_ON_HALF, 10);
    expect(picked.ratio).toBeGreaterThan(WHITE_ON_GREY_808080);
  });

  it('a fully transparent region ⇒ the current default colour, ratio 0', () => {
    const img = buffer(4, 4, CLEAR);
    const picked = pickContrastTextColor(img, all(img));
    expect(picked.color).toBe(DEFAULT_TEXT_COLOR);
    expect(picked.fallback).toBe(true);
    expect(picked.ratio).toBe(0);
    expect(picked.coverage).toBe(0);
    expect(picked.pixels).toBe(16);
  });

  it('an out-of-bounds rect is clamped, and the clamp is what decides the colour', () => {
    const img = buffer(4, 4, WHITE);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) paint(img, x, y, BLACK);
    // {-2,-2,4,4} → the 2×2 block of black pixels at the origin.
    expect(clampRect({ x: -2, y: -2, w: 4, h: 4 }, 4, 4)).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    const picked = pickContrastTextColor(img, { x: -2, y: -2, w: 4, h: 4 });
    expect(picked.luminance).toBeCloseTo(L_BLACK, 12);
    expect(picked.color).toBe('#ffffff');
    expect(picked.pixels).toBe(4);
    // A rect that misses the image completely has nothing to measure.
    const outside = pickContrastTextColor(img, { x: 10, y: 0, w: 2, h: 2 });
    expect(outside.color).toBe(DEFAULT_TEXT_COLOR);
    expect(outside.fallback).toBe(true);
    expect(outside.pixels).toBe(0);
    expect(outside.ratio).toBe(0);
  });

  it('a sub-pixel rect keeps the single pixel it touches', () => {
    const img = buffer(1, 1, WHITE);
    expect(clampRect({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 1, 1)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const picked = pickContrastTextColor(img, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
    expect(picked.pixels).toBe(1);
    expect(picked.color).toBe('#000000');
    expect(picked.ratio).toBeCloseTo(WHITE_ON_BLACK, 10);
    // A rect with no area at all (a zero-height box) stays empty rather than sampling a line.
    const empty = pickContrastTextColor(img, { x: 0, y: 0, w: 0, h: 0 });
    expect(empty.pixels).toBe(0);
    expect(empty.fallback).toBe(true);
  });
});

describe('contrast-text — clamping and malformed input', () => {
  it('rounds and clips a rect to whole pixels', () => {
    expect(clampRect({ x: 1.2, y: 1.2, w: 0.3, h: 0.3 }, 4, 4)).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    expect(clampRect({ x: 2.5, y: 2.5, w: 1, h: 1 }, 4, 4)).toEqual({ x: 2, y: 2, w: 2, h: 2 });
    expect(clampRect({ x: 0, y: 0, w: 99, h: 99 }, 4, 4)).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    expect(clampRect({ x: -5, y: -5, w: 3, h: 3 }, 4, 4)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(clampRect({ x: 0, y: 0, w: -3, h: 5 }, 4, 4)).toEqual({ x: 0, y: 0, w: 0, h: 4 });
    expect(clampRect({ x: 1, y: 1, w: 1, h: 1 }, 0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('treats a NaN or absurd rect as empty instead of choosing a colour from NaN', () => {
    const img = buffer(2, 2, BLACK);
    for (const rect of [{ x: NaN, y: 0, w: 0, h: 0 }, { x: NaN, y: NaN, w: NaN, h: NaN }]) {
      const picked = pickContrastTextColor(img, rect);
      expect(picked.color).toBe(DEFAULT_TEXT_COLOR);
      expect(picked.fallback).toBe(true);
      expect(picked.ratio).toBe(0);
    }
    expect(clampRect({ x: 0, y: 0, w: 2, h: 2 }, NaN, NaN)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('reads a truncated buffer as empty rather than sampling undefined bytes', () => {
    const whole = buffer(4, 4, BLACK);
    const truncated: PixelBuffer = { width: 4, height: 4, data: whole.data.slice(0, 8) };
    const sample = sampleRegion(truncated, { x: 0, y: 0, w: 4, h: 4 });
    expect(sample).toEqual({ luminance: 0, coverage: 0, pixels: 0 });
    expect(pickContrastTextColor(truncated, { x: 0, y: 0, w: 4, h: 4 }).fallback).toBe(true);
  });

  it('accepts a plain ImageData-shaped object, since the editor passes canvas pixels', () => {
    const data = new Uint8ClampedArray(4);
    data[3] = 255; // one opaque black pixel, ImageData style
    const picked = pickContrastTextColor({ width: 1, height: 1, data }, { x: 0, y: 0, w: 1, h: 1 });
    expect(picked.color).toBe('#ffffff');
    expect(picked.ratio).toBeCloseTo(WHITE_ON_BLACK, 10);
  });
});

describe('contrast-text — options', () => {
  it('keeps a caller-supplied fallback for an empty region and normalises it', () => {
    const clear = buffer(2, 2, CLEAR);
    expect(pickContrastTextColor(clear, all(clear), { fallback: '#ABC' }).color).toBe('#aabbcc');
    expect(pickContrastTextColor(clear, all(clear), { fallback: 'nonsense' }).color).toBe(DEFAULT_TEXT_COLOR);
    // An empty region has no luminance to report a ratio against.
    expect(pickContrastTextColor(clear, all(clear), { fallback: '#abc' }).ratio).toBe(0);
  });

  it('picks the best of the caller candidates whatever their order', () => {
    const black = buffer(2, 2, BLACK);
    const redOnly = pickContrastTextColor(black, all(black), { candidates: ['#ff0000'] });
    expect(redOnly.color).toBe('#ff0000');
    expect(redOnly.ratio).toBeCloseTo(5.252, 10);
    // White reaches 21:1 on black, so it wins even when red is listed first.
    expect(pickContrastTextColor(black, all(black), { candidates: ['#ff0000', '#ffffff'] }).color).toBe('#ffffff');
    // Two spellings of the same colour are one candidate, not a tie.
    const deduped = pickContrastTextColor(black, all(black), { candidates: ['#fff', '#ffffff'] });
    expect(deduped.color).toBe('#ffffff');
    expect(deduped.ratio).toBeCloseTo(WHITE_ON_BLACK, 10);
  });

  it('falls back to the default colour when every candidate is unusable', () => {
    const black = buffer(2, 2, BLACK);
    const picked = pickContrastTextColor(black, all(black), { candidates: ['nope'], fallback: '#123456' });
    expect(picked.color).toBe('#123456');
    // The region itself was measurable, so this is not a fallback decision.
    expect(picked.fallback).toBe(false);
    expect(picked.pixels).toBe(4);
  });

  it('refuses a region whose opaque fraction is at or below the threshold', () => {
    const almostClear = buffer(10, 10, CLEAR);
    paint(almostClear, 0, 0, BLACK); // coverage 1/100 = 0.01
    const refused = pickContrastTextColor(almostClear, all(almostClear));
    expect(refused.coverage).toBeCloseTo(0.01, 12);
    expect(refused.color).toBe(DEFAULT_TEXT_COLOR);
    expect(refused.fallback).toBe(true);
    // The dark default on a black pixel is a real (if poor) ratio, and it is reported as such.
    expect(refused.ratio).toBeCloseTo(colorContrast(DEFAULT_TEXT_COLOR, '#000000'), 10);
    // A caller that wants a thin sample to count can lower the bar.
    const measured = pickContrastTextColor(almostClear, all(almostClear), { minCoverage: 0 });
    expect(measured.fallback).toBe(false);
    expect(measured.color).toBe('#ffffff');
    expect(measured.ratio).toBeCloseTo(WHITE_ON_BLACK, 10);
    expect(MIN_COVERAGE).toBe(0.05);
  });
});
