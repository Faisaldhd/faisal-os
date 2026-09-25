import { describe, expect, it } from 'vitest';
import { FT_IDENTITY, corners, dragHandle, ftMatrix, ftReadout, hitHandle, isIdentity } from './freetransform';
import { apply } from './transform';

const box = { x: 10, y: 20, w: 100, h: 50 };
const close = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 6);
  expect(p.y).toBeCloseTo(y, 6);
};

describe('free transform', () => {
  it('is the identity until something is dragged', () => {
    close(apply(ftMatrix(box, FT_IDENTITY), { x: 37, y: 41 }), 37, 41);
    expect(isIdentity(FT_IDENTITY)).toBe(true);
  });

  it('moves with the move handle', () => {
    const ft = dragHandle(box, FT_IDENTITY, 'move', { x: 50, y: 40 }, { x: 60, y: 35 }, false);
    close(corners(box, ft)[0], 20, 15);
  });

  it('scales from the opposite edge/corner; Shift keeps the ratio', () => {
    const e = dragHandle(box, FT_IDENTITY, 'e', { x: 110, y: 45 }, { x: 160, y: 45 }, false);
    const c = corners(box, e);
    close(c[0], 10, 20); // west edge anchored
    close(c[1], 160, 20);
    const se = dragHandle(box, FT_IDENTITY, 'se', { x: 110, y: 70 }, { x: 210, y: 80 }, true);
    expect(se.sx).toBeCloseTo(2);
    expect(se.sy).toBeCloseTo(2);
    close(corners(box, se)[0], 10, 20); // nw anchored
    expect(ftReadout(box, se)).toEqual({ w: 200, h: 100, angle: 0 });
  });

  it('flips when a handle is dragged past its anchor', () => {
    const f = dragHandle(box, FT_IDENTITY, 'e', { x: 110, y: 45 }, { x: -90, y: 45 }, false);
    expect(f.sx).toBeCloseTo(-1);
    const m = ftMatrix(box, f);
    close(apply(m, { x: 10, y: 20 }), 10, 20);
    close(apply(m, { x: 110, y: 20 }), -90, 20);
  });

  it('rotates about the centre, snapping to 15° with Shift', () => {
    const r = dragHandle(box, FT_IDENTITY, 'rotate', { x: 60, y: 0 }, { x: 110, y: 45 }, false);
    expect(r.angle).toBeCloseTo(90);
    close(apply(ftMatrix(box, r), { x: 60, y: 45 }), 60, 45);
    const snapped = dragHandle(box, FT_IDENTITY, 'rotate', { x: 60, y: 0 }, { x: 100, y: 10 }, true);
    expect(snapped.angle % 15).toBe(0);
  });

  it('scales in the rotated frame after a rotation', () => {
    const r = { ...FT_IDENTITY, angle: 90 };
    // After 90° the "e" handle points down; dragging it further down widens the box.
    const e = dragHandle(box, r, 'e', { x: 60, y: 95 }, { x: 60, y: 145 }, false);
    expect(e.sx).toBeCloseTo(1.5);
    expect(e.sy).toBeCloseTo(1);
  });

  it('hits handles first, then the inside of the box', () => {
    expect(hitHandle(box, FT_IDENTITY, { x: 111, y: 71 }, 6, 24)).toBe('se');
    expect(hitHandle(box, FT_IDENTITY, { x: 60, y: -4 }, 6, 24)).toBe('rotate');
    expect(hitHandle(box, FT_IDENTITY, { x: 60, y: 45 }, 6, 24)).toBe('move');
    expect(hitHandle(box, FT_IDENTITY, { x: 500, y: 500 }, 6, 24)).toBeNull();
  });
});
