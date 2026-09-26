/**
 * Impress — smart guides: which line a dragged shape snaps to, and the guides that are drawn.
 */
import { describe, expect, it } from 'vitest';
import { applyResizeSnap, handleAnchors, snapBox, type Box } from './guides';

const slide = { w: 1000, h: 600 };
const box = (x: number, y: number, w = 100, h = 50): Box => ({ x, y, w, h });

describe('snapping a moved shape', () => {
  it('snaps its centre onto the slide centre and draws both centre guides', () => {
    const s = snapBox(box(447, 272), [], slide, 6);
    expect([s.dx, s.dy]).toEqual([3, 3]);
    expect(s.guides).toContainEqual({ axis: 'x', pos: 500, from: 0, to: 600 });
    expect(s.guides).toContainEqual({ axis: 'y', pos: 300, from: 0, to: 1000 });
  });

  it('snaps an edge onto the slide edge', () => {
    const s = snapBox(box(4, 200), [], slide, 6);
    expect(s.dx).toBe(-4);
    expect(s.guides.find((g) => g.axis === 'x')?.pos).toBe(0);
  });

  it('lines up with another shape: left to left, and a guide spanning both', () => {
    const other = box(300, 400);
    const s = snapBox(box(303, 100), [other], slide, 6);
    expect(s.dx).toBe(-3);
    const g = s.guides.find((x) => x.axis === 'x' && x.pos === 300)!;
    expect([g.from, g.to]).toEqual([100, 450]);
  });

  it('chooses the closest line when several are in reach', () => {
    const s = snapBox(box(0, 0), [box(96, 300), box(102, 400)], slide, 6);
    // Its right edge (100) is 2 away from 102 and 4 from 96; its left edge sits on the slide edge (0).
    expect(s.dx).toBe(0);
    const t = snapBox(box(1, 0), [box(96, 300), box(103, 400)], slide, 6);
    expect(t.dx).toBe(-1);
  });

  it('does nothing beyond the threshold', () => {
    const s = snapBox(box(200, 150), [box(700, 450)], slide, 6);
    expect(s).toEqual({ dx: 0, dy: 0, guides: [] });
  });
});

describe('snapping a resize', () => {
  it('snaps only the dragged edge and keeps the opposite one', () => {
    expect(handleAnchors('e')).toEqual({ x: ['end'], y: [] });
    expect(handleAnchors('nw')).toEqual({ x: ['start'], y: ['start'] });
    const b = box(100, 100, 396, 50);
    const s = snapBox(b, [], slide, 6, handleAnchors('e'));
    expect(s.dx).toBe(4); // right edge 496 → the slide centre 500
    expect(applyResizeSnap(b, 'e', s.dx, s.dy)).toEqual({ x: 100, y: 100, w: 400, h: 50 });
    expect(applyResizeSnap(box(4, 4), 'nw', -4, -4)).toEqual({ x: 0, y: 0, w: 104, h: 54 });
  });
});
