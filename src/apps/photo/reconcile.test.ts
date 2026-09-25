import { describe, expect, it } from 'vitest';
import * as engine from './engine';
import * as paint from './paint';
import * as selection from './selection';

/**
 * One implementation per pixel operation: the editor's selection.ts and paint.ts are thin
 * adapters over the engine (engine/select.ts, engine/core.ts), not a second copy of it.
 */
describe('selection.ts / paint.ts — adapters over the engine, not duplicates', () => {
  it('re-exports the engine mask builders and bounds instead of re-implementing them', () => {
    expect(selection.rectMask).toBe(engine.rectMask);
    expect(selection.ellipseMask).toBe(engine.ellipseMask);
    expect(selection.polygonMask).toBe(engine.polygonMask);
    expect(paint.maskBounds).toBe(engine.maskBounds);
  });

  it('flood fill, intersection and invert give exactly the engine results', () => {
    const w = 6;
    const h = 4;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set(i % w < 3 ? [10, 10, 10, 255] : [240, 30, 30, 255], i * 4);
    const buf = { width: w, height: h, data };
    const flood = paint.floodMask(buf, 0, 0, 16)!;
    expect(Array.from(flood.mask)).toEqual(Array.from(engine.magicWand(buf, 0, 0, { tolerance: 16 })));
    expect(flood.bounds).toEqual({ x: 0, y: 0, w: 3, h: 4 });
    const other = engine.rectMask(w, h, { x: 2, y: 0, w: 4, h: 4 });
    expect(Array.from(paint.intersectMasks(flood.mask, other))).toEqual(Array.from(engine.combineMasks(flood.mask, other, 'intersect')));
    const sel = selection.combine(null, w, h, flood.mask, null, 'replace')!;
    expect(Array.from(selection.invertSelection(sel, w, h)!.mask)).toEqual(Array.from(engine.invertMask(flood.mask)));
  });

  it('mixMasked leaves both inputs untouched (the engine mixes in place by default)', () => {
    const orig = { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]) };
    const proc = { width: 2, height: 1, data: new Uint8ClampedArray([200, 200, 200, 255, 200, 200, 200, 255]) };
    const out = paint.mixMasked(orig, proc, new Uint8Array([0, 255]));
    expect(Array.from(out.data)).toEqual([0, 0, 0, 255, 200, 200, 200, 255]);
    expect(proc.data[0]).toBe(200);
    expect(orig.data[4]).toBe(0);
  });

  it('traces edges with the engine outline, scaled back up on huge masks', () => {
    const sel = selection.selectAll(3000, 10);
    const t = selection.traceEdges(sel, 1000);
    expect(t.scale).toBe(3);
    expect(t.segments.length / 4).toBe(4);
    expect(Math.max(...t.segments)).toBe(3000);
  });
});
