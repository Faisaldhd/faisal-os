import { describe, expect, it } from 'vitest';
import { hsvToRgb, normaliseHex, relativeLuminance, rgbToHex, rgbToHsv } from './color';
import {
  clearMasked, clipRect, compositeStroke, dabsAlong, fillMasked, floodMask, intersectMasks, maskBounds, mixMasked, unionRect,
} from './paint';
import {
  combine, ellipseMask, invertSelection, modeFromModifiers, polygonMask, rectMask, selectAll, traceEdges,
} from './selection';
import {
  CANVAS_PRESETS, CROP_RATIOS, centreAt, centredAspect, dragCrop, detectDirection, exportSize, fitView, imageToScreen, lineOffset, pinchView,
  screenToImage, wheelFactor, zoomAbout, zoomStop,
} from './view';
import { SHORTCUTS, describeKeys, matchShortcut, toolKey } from './shortcuts';
import { parseRecent, pushRecent, removeRecent } from './recent';
import { FILTER_IDS, NEUTRAL_ADJUST, adjust, applyFilter, histogram, isNeutralAdjust } from './ops';
import type { PixelBuffer } from './types';

function solid(w: number, h: number, rgba: number[]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
}

describe('color', () => {
  it('normalises hex and round-trips through HSV', () => {
    expect(normaliseHex('#ABC')).toBe('#aabbcc');
    expect(normaliseHex('zzz')).toBeNull();
    for (const hex of ['#c8894b', '#5b8def', '#000000', '#ffffff', '#3dd68c']) {
      const rgb = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5), 16)];
      expect(rgbToHex(hsvToRgb(rgbToHsv(rgb)))).toBe(hex);
    }
    expect(rgbToHsv([255, 0, 0])).toEqual({ h: 0, s: 1, v: 1 });
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1);
  });
});

describe('paint — flood fill and masked operations', () => {
  it('fills the connected region only, or every similar pixel when not contiguous', () => {
    const b = solid(5, 5, [255, 255, 255, 255]);
    // a vertical black wall at x = 2
    for (let y = 0; y < 5; y++) b.data.set([0, 0, 0, 255], (y * 5 + 2) * 4);
    const left = floodMask(b, 0, 0, 10)!;
    expect(left.bounds).toEqual({ x: 0, y: 0, w: 2, h: 5 });
    expect(left.mask.reduce((s, v) => s + (v ? 1 : 0), 0)).toBe(10);
    const all = floodMask(b, 0, 0, 10, false)!;
    expect(all.mask.reduce((s, v) => s + (v ? 1 : 0), 0)).toBe(20);
    expect(floodMask(b, -1, 0, 10)).toBeNull();
  });

  it('fills, clears and mixes only through the mask', () => {
    const b = solid(2, 1, [0, 0, 0, 255]);
    const mask = new Uint8Array([255, 0]);
    const filled = fillMasked(b, mask, [255, 0, 0]);
    expect(Array.from(filled.data)).toEqual([255, 0, 0, 255, 0, 0, 0, 255]);
    const cleared = clearMasked(b, mask);
    expect([cleared.data[3], cleared.data[7]]).toEqual([0, 255]);
    const mixed = mixMasked(b, solid(2, 1, [100, 100, 100, 255]), mask);
    expect(Array.from(mixed.data)).toEqual([100, 100, 100, 255, 0, 0, 0, 255]);
    expect(Array.from(intersectMasks(new Uint8Array([255, 255]), mask))).toEqual([255, 0]);
    expect(maskBounds(new Uint8Array(4), 2, 2)).toBeNull();
  });

  it('commits strokes by source-over or erase, confined by the mask', () => {
    const region = solid(2, 1, [0, 0, 255, 255]);
    const stroke = solid(2, 1, [255, 0, 0, 255]);
    const painted = compositeStroke(region, stroke, 1, false, new Uint8Array([255, 0]));
    expect(Array.from(painted.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    const half = compositeStroke(region, stroke, 0.5, false);
    expect(half.data[0]).toBeGreaterThan(120);
    expect(half.data[0]).toBeLessThan(135);
    const erased = compositeStroke(region, stroke, 1, true, new Uint8Array([0, 255]));
    expect([erased.data[3], erased.data[7]]).toEqual([255, 0]);
    const none = compositeStroke(region, solid(2, 1, [255, 0, 0, 0]), 1, false);
    expect(Array.from(none.data)).toEqual(Array.from(region.data));
  });

  it('spaces dabs evenly across segments', () => {
    const a = dabsAlong({ x: 0, y: 0 }, { x: 10, y: 0 }, 4, 0);
    expect(a.points.map((p) => p.x)).toEqual([4, 8]);
    const b = dabsAlong({ x: 10, y: 0 }, { x: 20, y: 0 }, 4, a.carry);
    expect(b.points.map((p) => p.x)).toEqual([12, 16, 20]);
    expect(clipRect({ x: -2.5, y: 1.2, w: 5, h: 100 }, 10, 10)).toEqual({ x: 0, y: 1, w: 3, h: 9 });
    expect(unionRect(null, { x: 1, y: 1, w: 1, h: 1 })).toEqual({ x: 1, y: 1, w: 1, h: 1 });
  });
});

describe('selection', () => {
  it('builds rectangle, ellipse and lasso masks', () => {
    const r = rectMask(4, 4, { x: 1, y: 1, w: 2, h: 2 });
    expect(r.reduce((s, v) => s + (v ? 1 : 0), 0)).toBe(4);
    const e = ellipseMask(20, 20, { x: 0, y: 0, w: 20, h: 20 });
    expect(e[10 * 20 + 10]).toBe(255);
    expect(e[0]).toBe(0);
    const tri = polygonMask(10, 10, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]);
    expect(tri[1 * 10 + 1]).toBe(255);
    expect(tri[9 * 10 + 9]).toBe(0);
  });

  it('combines with add / subtract / intersect and inverts', () => {
    const a = combine(null, 4, 1, new Uint8Array([255, 255, 0, 0]), null, 'replace')!;
    const added = combine(a, 4, 1, new Uint8Array([0, 0, 0, 255]), null, 'add')!;
    expect(Array.from(added.mask)).toEqual([255, 255, 0, 255]);
    const sub = combine(added, 4, 1, new Uint8Array([255, 0, 0, 0]), null, 'subtract')!;
    expect(Array.from(sub.mask)).toEqual([0, 255, 0, 255]);
    const inter = combine(sub, 4, 1, new Uint8Array([0, 255, 255, 0]), null, 'intersect')!;
    expect(Array.from(inter.mask)).toEqual([0, 255, 0, 0]);
    expect(combine(inter, 4, 1, new Uint8Array([0, 255, 0, 0]), null, 'subtract')).toBeNull();
    expect(Array.from(invertSelection(inter, 4, 1)!.mask)).toEqual([255, 0, 255, 255]);
    expect(selectAll(3, 2).bounds).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(modeFromModifiers('replace', true, false)).toBe('add');
    expect(modeFromModifiers('replace', false, true)).toBe('subtract');
    expect(modeFromModifiers('replace', true, true)).toBe('intersect');
  });

  it('traces a rectangle as exactly four merged edges', () => {
    const sel = combine(null, 8, 8, rectMask(8, 8, { x: 2, y: 2, w: 4, h: 3 }), null, 'replace')!;
    expect(traceEdges(sel).segments.length / 4).toBe(4);
  });
});

describe('view — zoom, pan and presets', () => {
  it('fits and centres without upscaling, and maps screen ↔ image', () => {
    const v = fitView({ width: 2000, height: 1000 }, { width: 1064, height: 564 });
    expect(v.zoom).toBeCloseTo(0.5);
    expect(v.panX).toBe(32);
    const p = screenToImage(v, imageToScreen(v, { x: 123, y: 45 }));
    expect(p.x).toBeCloseTo(123);
    expect(fitView({ width: 10, height: 10 }, { width: 800, height: 600 }).zoom).toBe(1);
    expect(centreAt({ width: 100, height: 100 }, { width: 300, height: 300 }, 1)).toEqual({ zoom: 1, panX: 100, panY: 100 });
  });

  it('zooms about the anchor, steps through stops and pinches', () => {
    const v = { zoom: 1, panX: 0, panY: 0 };
    const z = zoomAbout(v, 2, { x: 100, y: 50 });
    expect(screenToImage(z, { x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
    expect(zoomStop(1, 1)).toBe(1.5);
    expect(zoomStop(1, -1)).toBe(0.667);
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    const pinched = pinchView(v, { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    expect(pinched.zoom).toBeCloseTo(2);
  });

  it('has the start-screen presets and clamps export sizes', () => {
    expect(CANVAS_PRESETS.find((p) => p.id === 'a4')).toMatchObject({ width: 2480, height: 3508 });
    expect(CANVAS_PRESETS.find((p) => p.id === 'square')).toMatchObject({ width: 1080, height: 1080 });
    expect(exportSize({ width: 4000, height: 3000 }, 50)).toEqual({ width: 2000, height: 1500 });
    expect(exportSize({ width: 10, height: 10 }, 0)).toEqual({ width: 1, height: 1 });
  });

  it('drags crop handles inside the image, keeping the ratio when one is set', () => {
    const b = { width: 400, height: 300 };
    const start = { x: 100, y: 100, w: 100, h: 100 };
    expect(dragCrop(start, 'se', 50, 20, null, b)).toEqual({ x: 100, y: 100, w: 150, h: 120 });
    expect(dragCrop(start, 'nw', -500, -500, null, b)).toEqual({ x: 0, y: 0, w: 200, h: 200 });
    expect(dragCrop(start, 'move', 1000, 0, null, b)).toEqual({ x: 300, y: 100, w: 100, h: 100 });
    const wide = dragCrop(start, 'se', 60, 0, 16 / 9, b);
    expect(wide.w / wide.h).toBeCloseTo(16 / 9, 1);
    expect(wide.x).toBe(100);
    const huge = dragCrop(start, 'se', 1000, 1000, 1, b);
    expect(huge.w).toBe(huge.h);
    expect(huge.x + huge.w).toBeLessThanOrEqual(400);
    expect(huge.y + huge.h).toBeLessThanOrEqual(300);
    expect(dragCrop(start, 'e', -1000, 0, null, b).w).toBe(8);
  });

  it('centres the largest box of each owner ratio', () => {
    const b = { width: 400, height: 300 };
    expect(CROP_RATIOS.slice(0, 4).map((r) => r.id)).toEqual(['free', '1:1', '16:9', '4:3']);
    expect(centredAspect(b, 1)).toEqual({ x: 50, y: 0, w: 300, h: 300 });
    expect(centredAspect(b, 16 / 9)).toEqual({ x: 0, y: 38, w: 400, h: 225 });
    expect(centredAspect(b, 4 / 3)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    expect(centredAspect(b, null)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it('detects Arabic text as RTL and aligns lines for either direction', () => {
    expect(detectDirection('مرحبا Faisal')).toBe('rtl');
    expect(detectDirection('Hi مرحبا')).toBe('ltr');
    expect(detectDirection('123')).toBe('ltr');
    expect(lineOffset(100, 'start', 'rtl')).toBe(-100);
    expect(lineOffset(100, 'start', 'ltr')).toBe(0);
    expect(lineOffset(100, 'center', 'ltr')).toBe(-50);
    expect(lineOffset(100, 'end', 'rtl')).toBe(0);
  });
});

describe('shortcuts — one table drives keys and the F1 sheet', () => {
  const ev = (key: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

  it('gives every required tool its one-key shortcut', () => {
    const want: Record<string, string> = { V: 'move', B: 'brush', E: 'eraser', G: 'bucket', I: 'eyedropper', S: 'clone', T: 'text', U: 'shape', C: 'crop', Z: 'zoom', H: 'hand' };
    for (const [k, tool] of Object.entries(want)) {
      expect(matchShortcut(ev(k.toLowerCase()))).toEqual({ kind: 'tool', tool });
      expect(toolKey(tool as never)).toBe(k);
    }
  });

  it('maps the shared editor commands', () => {
    expect(matchShortcut(ev('z', { ctrlKey: true }))).toEqual({ kind: 'command', command: 'undo' });
    expect(matchShortcut(ev('Z', { ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'command', command: 'redo' });
    expect(matchShortcut(ev('y', { metaKey: true }))).toEqual({ kind: 'command', command: 'redo' });
    expect(matchShortcut(ev('0', { ctrlKey: true }))).toEqual({ kind: 'command', command: 'zoomFit' });
    expect(matchShortcut(ev('1', { ctrlKey: true }))).toEqual({ kind: 'command', command: 'zoom100' });
    expect(matchShortcut(ev('I', { ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'command', command: 'invertSelection' });
    expect(matchShortcut(ev('+', { ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'command', command: 'zoomIn' });
    expect(matchShortcut(ev('b', { altKey: true }))).toBeNull();
  });

  it('has no two entries claiming the same key combination', () => {
    const seen = new Set<string>();
    for (const s of SHORTCUTS) {
      const id = `${s.mod ? 'm' : ''}${s.shift ? 's' : ''}:${s.key}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
    }
    expect(describeKeys(SHORTCUTS.find((s) => s.label === 'saveProjectAs')!)).toBe('Ctrl+Shift+S');
  });
});

describe('recent list', () => {
  it('keeps the newest first, without duplicates, capped', () => {
    let list = pushRecent([], '/home/user/a.png', 1);
    list = pushRecent(list, '/home/user/b.png', 2);
    list = pushRecent(list, '/home/user/a.png', 3);
    expect(list.map((r) => r.name)).toEqual(['a.png', 'b.png']);
    expect(removeRecent(list, '/home/user/a.png')).toHaveLength(1);
    let many: ReturnType<typeof pushRecent> = [];
    for (let i = 0; i < 15; i++) many = pushRecent(many, `/home/user/${i}.png`, i);
    expect(many).toHaveLength(10);
  });

  it('drops malformed or out-of-home entries from storage', () => {
    expect(parseRecent('garbage')).toEqual([]);
    expect(parseRecent(JSON.stringify([{ path: '/etc/passwd', at: 1 }, { path: '/home/user/x.png', at: 2 }, 5])))
      .toEqual([{ path: '/home/user/x.png', name: 'x.png', at: 2 }]);
  });
});

describe('ops — the pixel seam', () => {
  it('is the identity when neutral and changes pixels otherwise, never alpha', () => {
    const src = solid(4, 4, [100, 150, 200, 128]);
    expect(isNeutralAdjust(NEUTRAL_ADJUST)).toBe(true);
    expect(Array.from(adjust(src, NEUTRAL_ADJUST).data)).toEqual(Array.from(src.data));
    const inv = adjust(src, { ...NEUTRAL_ADJUST, invert: true });
    expect(Array.from(inv.data.slice(0, 4))).toEqual([155, 105, 55, 128]);
    const gray = adjust(src, { ...NEUTRAL_ADJUST, grayscale: true });
    expect(gray.data[0]).toBe(gray.data[1]);
    const hue = adjust(src, { ...NEUTRAL_ADJUST, hue: 120 });
    expect(hue.data[3]).toBe(128);
    expect(hue.data[0]).not.toBe(100);
  });

  it('applies every filter without changing the size, and 0% is the original look', () => {
    const src = solid(6, 6, [120, 80, 40, 255]);
    for (const id of FILTER_IDS) {
      const out = applyFilter(src, id, 100);
      expect([out.width, out.height], id).toEqual([6, 6]);
    }
    expect(Array.from(applyFilter(src, 'sepia', 0).data)).toEqual(Array.from(src.data));
  });

  it('builds a histogram of opaque pixels', () => {
    const h = histogram(solid(3, 3, [10, 20, 30, 255]));
    expect(h.r[10]).toBe(9);
    expect(h.max).toBe(9);
    expect(histogram(solid(3, 3, [10, 20, 30, 0])).max).toBe(0);
  });
});
