import { describe, expect, it } from 'vitest';
import { createImg, solidImg } from './core';
import { BrushStroke, dabAlpha, drawGradient, gradientColorAt, paintBucket, sampleColor, strokePath } from './paint';
import { imgFrom, px } from './test-utils';

describe('engine/paint — brush dab profile', () => {
  it('hard: full inside, one anti-aliased pixel at the rim, zero outside', () => {
    expect(dabAlpha(0, 5, 1)).toBe(1);
    expect(dabAlpha(4.5, 5, 1)).toBe(1);
    expect(dabAlpha(5, 5, 1)).toBe(0.5);
    expect(dabAlpha(5.6, 5, 1)).toBe(0);
  });

  it('soft: full inside the core, smooth monotone falloff to zero at the radius', () => {
    expect(dabAlpha(1, 10, 0.5)).toBe(1);
    expect(dabAlpha(5, 10, 0.5)).toBe(1);
    expect(dabAlpha(7.5, 10, 0.5)).toBeCloseTo(0.5, 10);
    expect(dabAlpha(10, 10, 0.5)).toBe(0);
    let prev = 1;
    for (let d = 0; d <= 10; d += 0.25) {
      const a = dabAlpha(d, 10, 0);
      expect(a).toBeLessThanOrEqual(prev);
      prev = a;
    }
  });
});

describe('engine/paint — strokes', () => {
  it('paints the colour where the dab is solid, leaves far pixels alone, reports the dirty rect', () => {
    const img = solidImg(20, 20, [255, 255, 255, 255]);
    const dirty = strokePath(img, [{ x: 10, y: 10 }], { size: 6, hardness: 1, color: [255, 0, 0] });
    expect(px(img, 10, 10)).toEqual([255, 0, 0, 255]);
    expect(px(img, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(dirty).toEqual({ x: 6, y: 6, w: 8, h: 8 });
  });

  it('opacity caps a stroke even where dabs overlap many times (flow builds up to it)', () => {
    const img = solidImg(40, 10, [255, 255, 255, 255]);
    const pts = [{ x: 5, y: 5 }, { x: 35, y: 5 }, { x: 5, y: 5 }, { x: 35, y: 5 }];
    strokePath(img, pts, { size: 6, hardness: 1, opacity: 0.5, flow: 0.3, spacing: 0.1, color: [0, 0, 0] });
    expect(px(img, 20, 5)).toEqual([128, 128, 128, 255]);
    // A single light dab stays below the cap.
    const one = solidImg(10, 10, [255, 255, 255, 255]);
    strokePath(one, [{ x: 5, y: 5 }], { size: 6, hardness: 1, opacity: 1, flow: 0.2, color: [0, 0, 0] });
    expect(px(one, 5, 5)).toEqual([204, 204, 204, 255]);
  });

  it('places dabs at the spacing across several pointer moves', () => {
    const img = solidImg(60, 5, [255, 255, 255, 255]);
    const s = new BrushStroke(img, { size: 2, hardness: 1, spacing: 5, color: [0, 0, 0] });
    s.moveTo(2, 2.5);
    s.lineTo(9, 2.5);
    s.lineTo(22, 2.5); // dabs at 2, 12, 22 (step = 10 px)
    const hit = (x: number) => px(img, x, 2)[0] < 255;
    expect([hit(2), hit(12), hit(22)]).toEqual([true, true, true]);
    expect([hit(7), hit(17)]).toEqual([false, false]);
  });

  it('eraser lowers alpha and keeps colour; a mask blocks everything outside it', () => {
    const img = solidImg(10, 10, [10, 20, 30, 255]);
    strokePath(img, [{ x: 5, y: 5 }], { size: 4, hardness: 1, mode: 'erase', opacity: 0.5 });
    expect(px(img, 5, 5)).toEqual([10, 20, 30, 128]);
    const masked = solidImg(10, 10, [255, 255, 255, 255]);
    const mask = new Uint8Array(100);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 10; y++) mask[y * 10 + x] = 255;
    strokePath(masked, [{ x: 1, y: 5 }, { x: 9, y: 5 }], { size: 4, hardness: 1, color: [0, 0, 0], mask });
    expect(px(masked, 3, 5)).toEqual([0, 0, 0, 255]);
    for (let y = 0; y < 10; y++) for (let x = 5; x < 10; x++) expect(px(masked, x, y)).toEqual([255, 255, 255, 255]);
  });

  it('paint over a transparent pixel sets its colour and coverage', () => {
    const img = createImg(6, 6);
    strokePath(img, [{ x: 3, y: 3 }], { size: 4, hardness: 1, opacity: 0.5, color: [0, 0, 255] });
    expect(px(img, 3, 3)).toEqual([0, 0, 255, 128]);
  });

  it('clone stamp copies from the source offset of the stroke start', () => {
    const img = createImg(20, 4);
    for (let x = 0; x < 20; x++) for (let y = 0; y < 4; y++) img.data.set(x < 10 ? [255, 0, 0, 255] : [0, 255, 0, 255], (y * 20 + x) * 4);
    strokePath(img, [{ x: 15.5, y: 2.5 }], { size: 4, hardness: 1, mode: 'clone', cloneOffset: { dx: -10, dy: 0 } });
    expect(px(img, 15, 2)).toEqual([255, 0, 0, 255]);
    expect(px(img, 18, 2)).toEqual([0, 255, 0, 255]);
  });
});

describe('engine/paint — bucket, gradient, eyedropper', () => {
  it('bucket fills the contiguous similar region with the colour and opacity', () => {
    const img = imgFrom(4, 1, [[0, 0, 0, 255], [5, 5, 5, 255], [200, 200, 200, 255], [0, 0, 0, 255]]);
    const r = paintBucket(img, 0, 0, [255, 0, 0, 255], { tolerance: 10 });
    expect(r).toEqual({ x: 0, y: 0, w: 2, h: 1 });
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 3, 0)).toEqual([0, 0, 0, 255]);
    const half = imgFrom(1, 1, [[0, 0, 0, 255]]);
    paintBucket(half, 0, 0, [255, 255, 255], { opacity: 0.5 });
    expect(px(half, 0, 0)).toEqual([128, 128, 128, 255]);
    expect(paintBucket(half, 5, 5, [1, 2, 3])).toBeNull();
  });

  it('bucket respects the selection', () => {
    const img = solidImg(3, 1, [0, 0, 0, 255]);
    paintBucket(img, 0, 0, [255, 255, 255, 255], { mask: new Uint8Array([255, 0, 255]) });
    expect(Array.from(img.data)).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it('gradient colours interpolate premultiplied (a fade to transparent keeps its hue)', () => {
    const stops = [{ offset: 0, color: [255, 0, 0, 255] as const }, { offset: 1, color: [0, 0, 255, 0] as const }];
    const mid = gradientColorAt(stops, 0.5);
    expect(mid.map((v) => Math.round(v))).toEqual([255, 0, 0, 128]);
    const bw = [{ offset: 0, color: [0, 0, 0, 255] as const }, { offset: 1, color: [255, 255, 255, 255] as const }];
    expect(gradientColorAt(bw, 0.25).map(Math.round)).toEqual([64, 64, 64, 255]);
    expect(gradientColorAt(bw, -1)).toEqual([0, 0, 0, 255]);
  });

  it('linear and radial gradients run from→to', () => {
    const stops = [{ offset: 0, color: [0, 0, 0, 255] as const }, { offset: 1, color: [255, 255, 255, 255] as const }];
    const lin = createImg(11, 1);
    drawGradient(lin, { type: 'linear', from: { x: 0.5, y: 0.5 }, to: { x: 10.5, y: 0.5 }, stops });
    expect(px(lin, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(lin, 10, 0)).toEqual([255, 255, 255, 255]);
    expect(Math.abs(px(lin, 5, 0)[0] - 128)).toBeLessThanOrEqual(1);
    const rad = createImg(11, 11);
    drawGradient(rad, { type: 'radial', from: { x: 5.5, y: 5.5 }, to: { x: 10.5, y: 5.5 }, stops });
    expect(px(rad, 5, 5)).toEqual([0, 0, 0, 255]);
    expect(px(rad, 5, 0)).toEqual(px(rad, 0, 5));
    expect(px(rad, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it('eyedropper averages 1×1 / 3×3 / 5×5, clipped and alpha-weighted', () => {
    const img = solidImg(5, 5, [0, 0, 0, 255]);
    img.data.set([90, 90, 90, 255], (2 * 5 + 2) * 4);
    img.data.set([255, 255, 255, 0], (2 * 5 + 3) * 4);
    expect(sampleColor(img, 2, 2, 1)).toEqual([90, 90, 90, 255]);
    expect(sampleColor(img, 2, 2, 3)).toEqual([11, 11, 11, 227]);
    expect(sampleColor(img, 2, 2, 5)).toEqual([4, 4, 4, 245]);
    expect(sampleColor(img, 0, 0, 3)).toEqual([0, 0, 0, 255]);
    expect(sampleColor(img, 9, 0)).toBeNull();
  });
});
