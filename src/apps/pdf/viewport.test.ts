import { describe, expect, it } from 'vitest';
import {
  anchoredScroll, boxToPdf, boxToView, clampZoom, CSS_UNITS, fitZoom, nextZoom, normalizeAngle, outputScale,
  pageAtOffset, pageSize, parseZoomInput, renderOrder, toPdf, toView, viewportTransform, visibleRange,
  ZOOM_MAX, ZOOM_MIN, type PageGeom,
} from './viewport';

const A4: PageGeom = { view: [0, 0, 595, 842], rotate: 0 };

describe('zoom steps', () => {
  it('clamps and walks the steps without getting stuck', () => {
    expect(clampZoom(10)).toBe(ZOOM_MAX);
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(nextZoom(1.05, 1)).toBe(1.1);
    expect(nextZoom(4, 1)).toBe(4);
    expect(nextZoom(0.25, -1)).toBe(0.25);
  });

  it('reads a typed zoom in Latin or Arabic-Indic digits', () => {
    expect(parseZoomInput('150%')).toBe(1.5);
    expect(parseZoomInput('١٢٥')).toBe(1.25);
    expect(parseZoomInput('9000')).toBe(ZOOM_MAX);
    expect(parseZoomInput('abc')).toBeNull();
  });

  it('normalizes any angle to a quarter turn', () => {
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(360)).toBe(0);
  });
});

describe('page size and fit', () => {
  it('swaps width and height for a quarter turn', () => {
    const upright = pageSize(A4, 0, 1);
    expect(upright.width).toBeCloseTo(595 * CSS_UNITS);
    const turned = pageSize(A4, 90, 1);
    expect(turned.width).toBeCloseTo(842 * CSS_UNITS);
    expect(pageSize({ ...A4, rotate: 90 }, 90, 1).width).toBeCloseTo(595 * CSS_UNITS);
  });

  it('fits the width or the whole page into the space', () => {
    const w = fitZoom('fitWidth', A4, 0, { width: 800, height: 600 }, 0);
    expect(pageSize(A4, 0, w).width).toBeCloseTo(800);
    const p = fitZoom('fitPage', A4, 0, { width: 800, height: 600 }, 0);
    expect(pageSize(A4, 0, p).height).toBeCloseTo(600);
  });

  it('shares the available width between two pages in a spread, and fits the pair in height', () => {
    // Two pages side by side: each one gets half of the width, plus one gutter between them.
    const w = fitZoom('fitWidth', A4, 0, { width: 800, height: 600 }, 10, 2);
    expect(pageSize(A4, 0, w).width).toBeCloseTo((800 - 4 * 10) / 2);
    // Both pages of the spread fit on screen, so the pair is as wide as the space (minus gutters).
    expect(pageSize(A4, 0, w).width * 2 + 4 * 10).toBeCloseTo(800);
    // The height of a pair is the height of one page: fitPage takes the smaller of the two limits.
    const p = fitZoom('fitPage', A4, 0, { width: 800, height: 600 }, 10, 2);
    expect(p).toBeCloseTo(fitZoom('fitWidth', A4, 0, { width: 800, height: 600 }, 10, 2));
    expect(pageSize(A4, 0, p).height).toBeLessThanOrEqual(600);
  });

  it('keeps the single-page result exactly as it was when asked for one column', () => {
    for (const mode of ['fitWidth', 'fitPage'] as const) {
      expect(fitZoom(mode, A4, 0, { width: 800, height: 600 }, 12)).toBe(
        fitZoom(mode, A4, 0, { width: 800, height: 600 }, 12, 1),
      );
    }
    // A nonsense column count is treated as one page rather than dividing by something strange.
    expect(fitZoom('fitWidth', A4, 0, { width: 800, height: 600 }, 0, 0)).toBeCloseTo(800 / (595 * CSS_UNITS));
  });
});

describe('viewport transform (same as pdf.js PageViewport)', () => {
  it('maps the top-left corner of an upright page to 0,0 and y grows downwards', () => {
    const t = viewportTransform(A4, 0, 2);
    expect(toView(t, 0, 842)).toEqual({ x: 0, y: 0 });
    const p = toView(t, 100, 742);
    expect(p.x).toBeCloseTo(200);
    expect(p.y).toBeCloseTo(200);
  });

  it('round-trips view → pdf → view at every rotation, including an offset crop box', () => {
    const cropped: PageGeom = { view: [36, 18, 500, 700], rotate: 0 };
    for (const rotation of [0, 90, 180, 270]) {
      const t = viewportTransform(cropped, rotation, 1.5);
      const pdf = toPdf(t, 123, 45);
      const back = toView(t, pdf.x, pdf.y);
      expect(back.x).toBeCloseTo(123);
      expect(back.y).toBeCloseTo(45);
      // The whole view box lands inside the page box on screen.
      const corners = [toView(t, 36, 18), toView(t, 500, 700)];
      for (const c of corners) {
        expect(c.x).toBeGreaterThanOrEqual(-0.001);
        expect(c.y).toBeGreaterThanOrEqual(-0.001);
      }
    }
  });

  it('a 90° page puts the PDF origin at the top-left', () => {
    const t = viewportTransform(A4, 90, 1);
    const o = toView(t, 0, 0);
    expect(o.x).toBeCloseTo(0);
    expect(o.y).toBeCloseTo(0);
  });

  it('converts a dragged box both ways', () => {
    const t = viewportTransform(A4, 0, 1);
    const box = boxToPdf(t, { x: 10, y: 20 }, { x: 110, y: 70 });
    expect(box).toEqual({ x: 10, y: 772, width: 100, height: 50 });
    const view = boxToView(t, box);
    expect(view.x).toBeCloseTo(10);
    expect(view.y).toBeCloseTo(20);
    expect(view.width).toBeCloseTo(100);
  });
});

describe('which pages are on screen', () => {
  const tops = [0, 1010, 2020, 3030];
  const heights = [1000, 1000, 1000, 1000];

  it('finds the page at an offset, including the gap between pages', () => {
    expect(pageAtOffset(tops, heights, 500)).toBe(0);
    expect(pageAtOffset(tops, heights, 1003)).toBe(0);
    expect(pageAtOffset(tops, heights, 1007)).toBe(1);
    expect(pageAtOffset(tops, heights, 99999)).toBe(3);
    expect(pageAtOffset([], [], 0)).toBe(-1);
  });

  it('lists the visible range and draws the centre first, with one page of margin', () => {
    expect(visibleRange(tops, heights, 900, 2100)).toEqual([0, 2]);
    expect(renderOrder(1, 1, 4, 1)).toEqual([1, 0, 2]);
    expect(renderOrder(0, 0, 4, 2)).toEqual([0, 1, 2]);
    expect(renderOrder(-1, -1, 4)).toEqual([]);
  });
});

describe('canvas density and zoom anchoring', () => {
  it('keeps the screen density unless the canvas would be too big', () => {
    expect(outputScale(800, 1000, 2)).toBe(2);
    expect(outputScale(4000, 4000, 2)).toBeLessThan(2);
    expect(outputScale(100, 100, 0)).toBe(1);
  });

  it('keeps the point under the anchor still', () => {
    expect(anchoredScroll(1000, 200, 2)).toBe(2200);
    expect(anchoredScroll(0, 0, 0.5)).toBe(0);
  });
});

describe('selection boxes → text markup quads', async () => {
  const { mergeLineBoxes, quadsFromBoxes, clampBox, strokesBounds } = await import('./viewport');

  it('merges the spans of one line and keeps separate lines apart', () => {
    const lines = mergeLineBoxes([
      { x: 10, y: 100, width: 40, height: 12 },
      { x: 50, y: 101, width: 30, height: 12 },
      { x: 10, y: 120, width: 60, height: 12 },
      { x: 0, y: 0, width: 0, height: 5 },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ x: 10, y: 100, width: 70, height: 13 });
  });

  it('builds TL,TR,BL,BR quads in PDF space and their bounding rect', () => {
    const t = viewportTransform(A4, 0, 1);
    const out = quadsFromBoxes(t, [{ x: 10, y: 20, width: 100, height: 10 }]);
    expect(out?.quads).toEqual([10, 822, 110, 822, 10, 812, 110, 812]);
    expect(out?.rect).toEqual({ x: 10, y: 812, width: 100, height: 10 });
    expect(quadsFromBoxes(t, [])).toBeNull();
  });

  it('clamps a placed box inside the page and bounds strokes', () => {
    expect(clampBox({ x: -5, y: 90, width: 20, height: 20 }, 100, 100)).toEqual({ x: 0, y: 80, width: 20, height: 20 });
    expect(clampBox({ x: 0, y: 0, width: 500, height: 2 }, 100, 100)).toEqual({ x: 0, y: 0, width: 100, height: 8 });
    expect(strokesBounds([[{ x: 1, y: 2 }, { x: 5, y: 9 }]], 1)).toEqual({ x: 0, y: 1, width: 6, height: 9 });
    expect(strokesBounds([])).toBeNull();
  });
});
