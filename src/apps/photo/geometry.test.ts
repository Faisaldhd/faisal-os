import { describe, expect, it } from 'vitest';
import {
  applyAspect, clamp, clampDimension, clampZoom, cropRegion, degreesToRadians, fitScale, imageToView,
  lockedOtherSide, normaliseCrop, normaliseRotation, quarterDegrees, quarterTurnSize, resizeByPercent,
  rotatedBounds, sameSize, scalePoint, totalDegrees, viewToImage, zoomStep, MAX_DIMENSION, MIN_DIMENSION,
} from './geometry';

const bounds = { width: 200, height: 100 };

describe('geometry — crop normalisation', () => {
  it('normalises a rectangle dragged from any corner and in any direction', () => {
    expect(normaliseCrop({ x: 150, y: 80 }, { x: 50, y: 20 }, bounds)).toEqual({ x: 50, y: 20, w: 100, h: 60 });
    expect(normaliseCrop({ x: 50, y: 20 }, { x: 150, y: 80 }, bounds)).toEqual({ x: 50, y: 20, w: 100, h: 60 });
    expect(normaliseCrop({ x: 20, y: 60 }, { x: 90, y: 10 }, bounds)).toEqual({ x: 20, y: 10, w: 70, h: 50 });
  });

  it('clamps a drag that leaves the image and rounds to whole pixels', () => {
    expect(normaliseCrop({ x: -40, y: -30 }, { x: 400, y: 400 }, bounds)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(normaliseCrop({ x: 10.4, y: 10.6 }, { x: 60.5, y: 40.2 }, bounds)).toEqual({ x: 10, y: 11, w: 51, h: 29 });
  });

  it('returns null for a degenerate (sub-pixel) selection', () => {
    expect(normaliseCrop({ x: 10, y: 10 }, { x: 10.4, y: 10.4 }, bounds)).toBeNull();
    expect(normaliseCrop({ x: 10, y: 10 }, { x: 10, y: 40 }, bounds)).toBeNull();
  });
});

describe('geometry — aspect presets', () => {
  it('grows the dragged box to the ratio around its centre, and never leaves the image', () => {
    // A 200×50 drag in a 200×100 image: forcing 1:1 grows the height to 200, which does not
    // fit, so the whole box is scaled down to 100×100. A square that fills the height can only
    // sit centred, so its vertical centre is the image's — the clamp, not the drag, decides.
    const square = applyAspect({ x: 0, y: 0, w: 200, h: 50 }, 1, bounds);
    expect(square).not.toBeNull();
    expect(square!.w).toBe(square!.h);
    expect(square!.w).toBeGreaterThanOrEqual(99);
    expect(square!.w).toBeLessThanOrEqual(100);
    expect(square!.x + square!.w / 2).toBeCloseTo(100, 0);
    expect(square!.y + square!.h / 2).toBeCloseTo(50, 0);
    expect(square!.y + square!.h).toBeLessThanOrEqual(bounds.height);
    expect(square!.x + square!.w).toBeLessThanOrEqual(bounds.width);
  });

  it('keeps a wide drag that already fits inside the image', () => {
    const wide = applyAspect({ x: 0, y: 0, w: 100, h: 100 }, 16 / 9, bounds);
    expect(wide!.w / wide!.h).toBeCloseTo(16 / 9, 1);
    expect(wide!.w).toBeLessThanOrEqual(bounds.width);
    expect(wide!.x + wide!.w).toBeLessThanOrEqual(bounds.width);
    expect(wide!.x).toBeGreaterThanOrEqual(0);
  });
  it('a 1:1 preset is square and a bad ratio is refused', () => {
    const square = applyAspect({ x: 10, y: 10, w: 120, h: 40 }, 1, bounds);
    expect(square!.w).toBe(square!.h);
    expect(applyAspect({ x: 0, y: 0, w: 10, h: 10 }, 0, bounds)).toBeNull();
    expect(applyAspect({ x: 0, y: 0, w: 10, h: 10 }, -3, bounds)).toBeNull();
  });

  it('cropRegion always yields at least one pixel inside the buffer', () => {
    expect(cropRegion({ x: 0, y: 0, w: 0, h: 0 }, bounds)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const clipped = cropRegion({ x: 199, y: 99, w: 50, h: 50 }, bounds);
    expect(clipped.w).toBe(1);
    expect(clipped.h).toBe(1);
  });
});

describe('geometry — rotation bounds', () => {
  it('normalises quarter turns and free angles into the documented ranges', () => {
    expect(normaliseRotation({ quarter: 5, free: 0 })).toEqual({ quarter: 1, free: 0 });
    expect(normaliseRotation({ quarter: -1, free: 0 })).toEqual({ quarter: 3, free: 0 });
    expect(normaliseRotation({ quarter: 0, free: 190 })).toEqual({ quarter: 0, free: -170 });
    expect(normaliseRotation({ quarter: 0, free: 181 })).toMatchObject({ free: -179 });
    expect(quarterDegrees(2)).toBe(180);
    expect(totalDegrees({ quarter: 1, free: 45 })).toBe(135);
  });

  it('folds an exact right angle into a quarter turn, so both paths give the same angle', () => {
    expect(normaliseRotation({ quarter: 0, free: 90 })).toEqual({ quarter: 1, free: 0 });
    expect(normaliseRotation({ quarter: 1, free: -90 })).toEqual({ quarter: 0, free: 0 });
    expect(normaliseRotation({ quarter: 0, free: 180 })).toEqual({ quarter: 2, free: 0 });
  });

  it('rotatedBounds is the tight box around the rotated rectangle', () => {
    expect(rotatedBounds({ width: 100, height: 50 }, 0)).toEqual({ width: 100, height: 50 });
    expect(rotatedBounds({ width: 100, height: 50 }, 90)).toEqual({ width: 50, height: 100 });
    const square = rotatedBounds({ width: 100, height: 100 }, 45);
    expect(square.width).toBe(142);
    expect(square.height).toBe(142);
    expect(degreesToRadians(180)).toBeCloseTo(Math.PI, 12);
  });

  it('a quarter turn swaps the sides, and 0/2 do not', () => {
    expect(quarterTurnSize({ width: 30, height: 10 }, 1)).toEqual({ width: 10, height: 30 });
    expect(quarterTurnSize({ width: 30, height: 10 }, 3)).toEqual({ width: 10, height: 30 });
    expect(quarterTurnSize({ width: 30, height: 10 }, 2)).toEqual({ width: 30, height: 10 });
    expect(quarterTurnSize({ width: 30, height: 10 }, 4)).toEqual({ width: 30, height: 10 });
  });
});

describe('geometry — resize maths', () => {
  it('clamps a dimension into the allocatable range', () => {
    expect(clampDimension(0)).toBe(MIN_DIMENSION);
    expect(clampDimension(-10)).toBe(MIN_DIMENSION);
    expect(clampDimension(99999)).toBe(MAX_DIMENSION);
    expect(clampDimension(12.6)).toBe(13);
    expect(clampDimension(Number.NaN)).toBe(MIN_DIMENSION);
  });

  it('locks the aspect ratio from whichever side the user typed', () => {
    const size = { width: 400, height: 200 };
    expect(lockedOtherSide('width', 200, size)).toBe(100);
    expect(lockedOtherSide('height', 400, size)).toBe(800);
    // Degenerate source: the typed value stands rather than producing NaN.
    expect(lockedOtherSide('width', 50, { width: 0, height: 0 })).toBe(50);
  });

  it('a percentage resize scales both sides and clamps them', () => {
    expect(resizeByPercent({ width: 400, height: 200 }, 50)).toEqual({ width: 200, height: 100 });
    expect(resizeByPercent({ width: 400, height: 200 }, 900)).toEqual({ width: 3600, height: 1800 });
    expect(resizeByPercent({ width: 20000, height: 20000 }, 200)).toEqual({ width: 16384, height: 16384 });
    expect(resizeByPercent({ width: 4, height: 4 }, 1).width).toBeGreaterThanOrEqual(1);
  });

  it('sameSize compares rounded values', () => {
    expect(sameSize({ width: 10.2, height: 20.4 }, { width: 10, height: 20 })).toBe(true);
    expect(sameSize({ width: 10, height: 21 }, { width: 10, height: 20 })).toBe(false);
  });

  it('fitScale fits the image into the viewport and never upscales', () => {
    expect(fitScale({ width: 1000, height: 500 }, { width: 400, height: 300 }, 0)).toBeCloseTo(0.4, 6);
    expect(fitScale({ width: 10, height: 10 }, { width: 400, height: 300 }, 0)).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, { width: 400, height: 300 })).toBe(1);
  });
});

describe('geometry — zoom and view transforms', () => {
  it('clamps zoom into 0.1..8 and steps by 1.25', () => {
    expect(clampZoom(0.001)).toBe(0.1);
    expect(clampZoom(100)).toBe(8);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(zoomStep(1, 1)).toBe(1.25);
    expect(zoomStep(1, -1)).toBe(0.8);
    expect(zoomStep(8, 1)).toBe(8);
  });

  it('maps a pointer position to image pixels and back', () => {
    expect(viewToImage({ x: 200, y: 100 }, 2)).toEqual({ x: 100, y: 50 });
    expect(imageToView({ x: 100, y: 50 }, 2)).toEqual({ x: 200, y: 100 });
    // A zero or negative zoom must not divide by zero.
    expect(viewToImage({ x: 10, y: 10 }, 0)).toEqual({ x: 10, y: 10 });
  });

  it('scales a point between two pixel spaces, which is how a crop is mapped after a resize', () => {
    expect(scalePoint({ x: 50, y: 25 }, { width: 100, height: 50 }, { width: 200, height: 100 })).toEqual({ x: 100, y: 50 });
    expect(scalePoint({ x: 5, y: 5 }, { width: 0, height: 0 }, { width: 200, height: 100 })).toEqual({ x: 0, y: 0 });
  });

  it('clamps a plain number', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
