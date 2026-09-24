import { describe, expect, it } from 'vitest';
import {
  arrowHead, boundsOf, catmullRom, cubicAt, ellipseOperators, inflate, pathOperators, quadForRect, quadHeight, quadsOf,
  roundedRectOperators, simplify,
} from './geometry';

describe('stroke smoothing (Catmull-Rom → Bézier)', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 10 }];

  it('passes through every sample point', () => {
    const path = catmullRom(pts);
    expect(path).not.toBeNull();
    if (!path) return;
    expect(path.start).toEqual(pts[0]);
    expect(path.segments.map((s) => s.to)).toEqual(pts.slice(1));
    let from = path.start;
    path.segments.forEach((s, i) => {
      expect(cubicAt(from, s, 0)).toEqual(from);
      expect(cubicAt(from, s, 1)).toEqual(pts[i + 1]);
      from = s.to;
    });
  });

  it('uses the Catmull-Rom tangent (P[i+1] − P[i−1]) / 6 for the control points', () => {
    const path = catmullRom(pts) as NonNullable<ReturnType<typeof catmullRom>>;
    // Segment 1 runs P1→P2; c1 = P1 + (P2 − P0)/6, c2 = P2 − (P3 − P1)/6.
    const s = path.segments[1];
    expect(s.c1.x).toBeCloseTo(10 + (20 - 0) / 6);
    expect(s.c1.y).toBeCloseTo(10 + (0 - 0) / 6);
    expect(s.c2.x).toBeCloseTo(20 - (30 - 10) / 6);
    expect(s.c2.y).toBeCloseTo(0 - (10 - 10) / 6);
  });

  it('is continuous in direction at each joint (no corners)', () => {
    const path = catmullRom(pts) as NonNullable<ReturnType<typeof catmullRom>>;
    for (let i = 0; i < path.segments.length - 1; i++) {
      const joint = path.segments[i].to;
      const inV = { x: joint.x - path.segments[i].c2.x, y: joint.y - path.segments[i].c2.y };
      const outV = { x: path.segments[i + 1].c1.x - joint.x, y: path.segments[i + 1].c1.y - joint.y };
      expect(inV.x * outV.y - inV.y * outV.x).toBeCloseTo(0);
      expect(inV.x * outV.x + inV.y * outV.y).toBeGreaterThan(0);
    }
  });

  it('tension 0 gives straight segments', () => {
    const path = catmullRom(pts, 0) as NonNullable<ReturnType<typeof catmullRom>>;
    expect(path.segments[0].c1).toEqual(pts[0]);
    expect(path.segments[0].c2).toEqual(pts[1]);
  });

  it('drops jitter but keeps the last point', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 5, y: 0 }, { x: 5.2, y: 0 }], 1)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5.2, y: 0 }]);
    expect(simplify([{ x: NaN, y: 0 }, { x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }]);
  });

  it('writes content-stream operators, and a dot for a single tap', () => {
    const text = pathOperators(catmullRom(pts.slice(0, 2)) as NonNullable<ReturnType<typeof catmullRom>>);
    expect(text.split('\n')[0]).toBe('0 0 m');
    expect(text).toMatch(/ 10 10 c$/);
    expect(pathOperators({ start: { x: 5, y: 5 }, segments: [] })).toBe('5 5 m\n5.01 5 l');
    expect(catmullRom([])).toBeNull();
  });
});

describe('shapes and boxes', () => {
  it('bounds, inflates', () => {
    expect(boundsOf([{ x: 1, y: 5 }, { x: -2, y: 3 }])).toEqual({ x: -2, y: 3, width: 3, height: 2 });
    expect(boundsOf([])).toBeNull();
    expect(inflate({ x: 0, y: 0, width: 10, height: 10 }, 2)).toEqual({ x: -2, y: -2, width: 14, height: 14 });
  });

  it('draws an ellipse with four curves and a rounded rect with four corners', () => {
    const e = ellipseOperators({ x: 0, y: 0, width: 20, height: 10 });
    expect(e.split('\n')[0]).toBe('20 5 m');
    expect(e.match(/ c/g)?.length).toBe(4);
    expect(roundedRectOperators({ x: 0, y: 0, width: 20, height: 10 }, 2).match(/ c/g)?.length).toBe(4);
    expect(roundedRectOperators({ x: 0, y: 0, width: 20, height: 10 }, 0)).toBe('0 0 20 10 re');
  });

  it('puts arrow wings behind the tip, symmetric about the shaft', () => {
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 10, y: 0 }, 5);
    expect(a.x).toBeCloseTo(10 - 5 * Math.cos(Math.PI / 6));
    expect(b.x).toBeCloseTo(a.x);
    expect(a.y).toBeCloseTo(-b.y);
  });

  it('reads and makes QuadPoints (TL TR BL BR)', () => {
    const flat = quadForRect({ x: 10, y: 20, width: 30, height: 12 });
    expect(flat).toEqual([10, 32, 40, 32, 10, 20, 40, 20]);
    const [q] = quadsOf([...flat, 1, 2, 3]);
    expect(q.tl).toEqual({ x: 10, y: 32 });
    expect(q.br).toEqual({ x: 40, y: 20 });
    expect(quadHeight(q)).toBe(12);
    expect(quadsOf([1, 2, 3])).toEqual([]);
  });
});
