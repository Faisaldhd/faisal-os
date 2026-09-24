import { describe, expect, it } from 'vitest';
import {
  anchorX,
  applyColorAdjust,
  canvasAlign,
  colorFilter,
  computePeaks,
  fitRect,
  hitRect,
  isNeutral,
  layerRect,
  peaksSlice,
  textDirection,
  wrapLines,
} from './render-math';

describe('fitting', () => {
  it('letterboxes with contain and crops with cover', () => {
    expect(fitRect({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, 'contain'))
      .toEqual({ x: 0, y: 656.25, width: 1080, height: 607.5 });
    const cover = fitRect({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, 'cover');
    expect(cover.height).toBe(1920);
    expect(cover.x).toBeLessThan(0);
  });

  it('places an overlay by scale and centre, and slides it by offsetX', () => {
    const r = layerRect({ width: 100, height: 100 }, { width: 200, height: 100 }, { fit: 'contain', scale: 0.5, cx: 0.75, cy: 0.5 });
    expect(r).toEqual({ x: 125, y: 25, width: 50, height: 50 });
    const slid = layerRect({ width: 200, height: 100 }, { width: 200, height: 100 }, { fit: 'contain', scale: 1, cx: 0.5, cy: 0.5, offsetX: 1 });
    expect(slid.x).toBe(200);
    expect(hitRect(r, 150, 50)).toBe(true);
    expect(hitRect(r, 10, 50)).toBe(false);
  });

  it('survives a zero-size source', () => {
    expect(fitRect({ width: 0, height: 0 }, { width: 10, height: 5 }, 'contain')).toEqual({ x: 0, y: 0, width: 10, height: 5 });
  });
});

describe('colour', () => {
  it('builds a canvas filter and says none when neutral', () => {
    expect(colorFilter({ brightness: 1, contrast: 1, saturation: 1 })).toBe('none');
    expect(colorFilter({ brightness: 1.2, contrast: 0.8, saturation: 0 }))
      .toBe('brightness(1.200) contrast(0.800) saturate(0.000)');
    expect(isNeutral({ brightness: 1, contrast: 1.0001, saturation: 1 })).toBe(true);
  });

  it('applies the same adjustment to raw pixels', () => {
    const px = new Uint8ClampedArray([100, 150, 200, 255]);
    applyColorAdjust(px, { brightness: 1, contrast: 1, saturation: 0 });
    expect(px[0]).toBe(px[1]);
    expect(px[1]).toBe(px[2]);
    expect(px[3]).toBe(255);
    const bright = new Uint8ClampedArray([100, 100, 100, 128]);
    applyColorAdjust(bright, { brightness: 2, contrast: 1, saturation: 1 });
    expect([...bright]).toEqual([200, 200, 200, 128]);
    const flat = new Uint8ClampedArray([0, 255, 30, 255]);
    applyColorAdjust(flat, { brightness: 1, contrast: 0, saturation: 1 });
    expect([flat[0], flat[1], flat[2]]).toEqual([128, 128, 128]);
  });
});

describe('text', () => {
  it('detects direction from the first strong character', () => {
    expect(textDirection('مرحبا Hello')).toBe('rtl');
    expect(textDirection('123 Hello مرحبا')).toBe('ltr');
    expect(textDirection('2026')).toBe('ltr');
  });

  it('wraps by words, keeps newlines, never cuts a word', () => {
    const measure = (s: string) => s.length;
    expect(wrapLines('one two three four', 9, measure)).toEqual(['one two', 'three', 'four']);
    expect(wrapLines('a\n\nb', 10, measure)).toEqual(['a', '', 'b']);
    expect(wrapLines('extraordinarily', 4, measure)).toEqual(['extraordinarily']);
    expect(wrapLines('عنوان الفيديو الجديد', 13, measure)).toEqual(['عنوان الفيديو', 'الجديد']);
  });

  it('mirrors start/end alignment for right-to-left text', () => {
    expect(canvasAlign('start', 'rtl')).toBe('right');
    expect(canvasAlign('start', 'ltr')).toBe('left');
    expect(canvasAlign('end', 'rtl')).toBe('left');
    expect(canvasAlign('center', 'rtl')).toBe('center');
    expect(anchorX('left', 100, 40)).toBe(80);
    expect(anchorX('right', 100, 40)).toBe(120);
  });
});

describe('waveform peaks', () => {
  it('takes the absolute peak of each bucket', () => {
    const peaks = computePeaks([0, -0.5, 0.2, 0.9, -1.5, 0], 3);
    expect([...peaks].map((v) => Math.round(v * 10) / 10)).toEqual([0.5, 0.9, 1]);
    expect(computePeaks([], 4)).toHaveLength(4);
  });

  it('slices the peaks of a source range', () => {
    const peaks = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    expect([...peaksSlice(peaks, 4, 1, 3)].map((v) => Math.round(v * 10) / 10)).toEqual([0.2, 0.3]);
    expect(peaksSlice(peaks, 0, 0, 1)).toHaveLength(0);
  });
});
