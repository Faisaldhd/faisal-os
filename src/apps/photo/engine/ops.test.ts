import { describe, expect, it } from 'vitest';
import * as engine from './index';
import { OP_NAMES, handleRequest, runOp, type OpName } from './ops';
import { runInWorker, toImageData, workerAvailable } from './rpc';
import { imgFrom, px, randomImg } from './test-utils';

const PARAMS: Record<OpName, unknown> = {
  adjust: { brightness: 10 },
  filter: { id: 'vivid', amount: 80 },
  preset: { id: 'noir' },
  blur: { radius: 2 },
  sharpen: { amount: 1 },
  grayscale: {},
  sepia: {},
  invert: {},
  vignette: { amount: 40 },
  noise: { amount: 20 },
  pixelate: { size: 3 },
  posterize: { levels: 4 },
  emboss: {},
  edges: {},
};

describe('engine/ops — registry', () => {
  it('every op returns an image of the same size and leaves the input alone', () => {
    const src = randomImg(9, 7, 3);
    const copy = Array.from(src.data);
    for (const op of OP_NAMES) {
      const out = runOp(op, src, PARAMS[op] as never);
      expect(out.width).toBe(9);
      expect(out.height).toBe(7);
      expect(out.data.length).toBe(src.data.length);
    }
    expect(Array.from(src.data)).toEqual(copy);
  });

  it('any op honours a mask param', () => {
    const src = imgFrom(2, 1, [[10, 20, 30, 255], [10, 20, 30, 255]]);
    const out = runOp('invert', src, { mask: new Uint8Array([0, 255]) } as never);
    expect(px(out, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(px(out, 1, 0)).toEqual([245, 235, 225, 255]);
  });

  it('handleRequest answers ok with the pixels, or an error for an unknown op (never throws)', () => {
    const src = imgFrom(1, 1, [[1, 2, 3, 4]]);
    const ok = handleRequest({ id: 7, op: 'invert', width: 1, height: 1, data: src.data, params: {} });
    expect(ok).toMatchObject({ id: 7, ok: true, width: 1, height: 1 });
    if (ok.ok) expect(Array.from(ok.data)).toEqual([254, 253, 252, 4]);
    const bad = handleRequest({ id: 8, op: 'rm -rf' as OpName, width: 1, height: 1, data: src.data, params: {} });
    expect(bad).toMatchObject({ id: 8, ok: false });
  });
});

describe('engine/rpc — runInWorker', () => {
  it('falls back to the main thread when Worker is unavailable, with identical output', async () => {
    expect(workerAvailable()).toBe(typeof Worker !== 'undefined');
    const src = randomImg(8, 8, 1);
    const viaRpc = await runInWorker('adjust', src, { contrast: 30, hue: 40 });
    const direct = runOp('adjust', src, { contrast: 30, hue: 40 });
    expect(viaRpc.width).toBe(8);
    expect(Array.from(viaRpc.data)).toEqual(Array.from(direct.data));
    const forced = await runInWorker('blur', src, { radius: 1 }, { sync: true });
    expect(Array.from(forced.data)).toEqual(Array.from(runOp('blur', src, { radius: 1 }).data));
  });

  it('rejects an already-aborted call and an unknown op', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(runInWorker('invert', randomImg(2, 2), {}, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(runInWorker('nope' as OpName, randomImg(2, 2), {} as never)).rejects.toThrow();
  });

  it('toImageData keeps size and pixels', () => {
    const img = imgFrom(1, 1, [[9, 8, 7, 6]]);
    const id = toImageData(img);
    expect([id.width, id.height]).toEqual([1, 1]);
    expect(Array.from(id.data)).toEqual([9, 8, 7, 6]);
  });
});

describe('engine/index — the ops.ts seam', () => {
  it('exports adjust, applyFilter and histogram with the seam shapes', () => {
    const buf = imgFrom(2, 1, [[100, 150, 200, 255], [0, 0, 0, 255]]);
    const a = engine.adjust(buf, { brightness: 20, grayscale: false });
    expect(px(a, 0, 0)).toEqual([120, 170, 220, 255]);
    const f = engine.applyFilter(buf, 'invert', 100, 1);
    expect(px(f, 1, 0)).toEqual([255, 255, 255, 255]);
    const h = engine.histogram(buf);
    for (const k of ['r', 'g', 'b', 'l'] as const) {
      expect(h[k]).toBeInstanceOf(Uint32Array);
      expect(h[k].length).toBe(256);
    }
    expect(h.r[100]).toBe(1);
  });
});
