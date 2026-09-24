import { describe, expect, it } from 'vitest';
import {
  IDENTITY, apply, flipMatrix, freeRotationMatrix, invert, isTranslationOnly, multiply, quarterTurnMatrix,
  resizeMatrix, rotation, scaleOf, tidy, transformRect, translation, type Matrix,
} from './transform';

describe('transform — affine matrices', () => {
  it('composes right-to-left (m1·m2 applies m2 first)', () => {
    const m = multiply(translation(10, 0), rotation(90));
    expect(apply(m, { x: 1, y: 0 })).toEqual({ x: 10, y: 1 });
  });

  it('inverts, and a degenerate matrix has no inverse', () => {
    const m = multiply(translation(5, -3), multiply(rotation(30), [2, 0, 0, 3, 0, 0]));
    const inv = invert(m)!;
    const p = apply(inv, apply(m, { x: 7, y: 11 }));
    expect(p.x).toBeCloseTo(7, 9);
    expect(p.y).toBeCloseTo(11, 9);
    expect(invert([0, 0, 0, 0, 1, 1])).toBeNull();
  });

  it('maps the corners of a quarter turn exactly onto the swapped canvas', () => {
    const cw = quarterTurnMatrix(200, 100, 1);
    expect(apply(cw, { x: 0, y: 0 })).toEqual({ x: 100, y: 0 });
    expect(apply(cw, { x: 200, y: 100 })).toEqual({ x: 0, y: 200 });
    const ccw = quarterTurnMatrix(200, 100, -1);
    expect(apply(ccw, { x: 0, y: 0 })).toEqual({ x: 0, y: 200 });
    let m: Matrix = IDENTITY;
    let w = 200;
    let h = 100;
    for (let i = 0; i < 4; i++) { m = multiply(quarterTurnMatrix(w, h, 1), m); [w, h] = [h, w]; }
    expect(tidy(m)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('flips about the canvas edges, and flipping twice is the identity', () => {
    const f = flipMatrix(50, 20, 'h');
    expect(apply(f, { x: 0, y: 5 })).toEqual({ x: 50, y: 5 });
    expect(tidy(multiply(f, f))).toEqual([1, 0, 0, 1, 0, 0]);
    expect(apply(flipMatrix(50, 20, 'v'), { x: 3, y: 0 })).toEqual({ x: 3, y: 20 });
  });

  it('free rotation keeps the image centre at the new canvas centre', () => {
    const m = freeRotationMatrix(100, 60, 30, { width: 120, height: 110 });
    const c = apply(m, { x: 50, y: 30 });
    expect(c.x).toBeCloseTo(60, 9);
    expect(c.y).toBeCloseTo(55, 9);
  });

  it('reports translation-only matrices, scale and transformed bounds', () => {
    expect(isTranslationOnly(translation(3, 4))).toBe(true);
    expect(isTranslationOnly(rotation(10))).toBe(false);
    expect(scaleOf(resizeMatrix({ width: 100, height: 100 }, { width: 50, height: 50 }))).toBeCloseTo(0.5);
    const r = transformRect(rotation(90), { x: 0, y: 0, w: 10, h: 4 });
    expect([r.x, r.y, r.w, r.h].map((v) => Math.round(v))).toEqual([-4, 0, 4, 10]);
  });
});
