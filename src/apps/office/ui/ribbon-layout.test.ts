import { describe, expect, it } from 'vitest';
import { layoutRibbon, rowWidth, type GroupWidths } from './ribbon-layout';

const g = (full: number, icon: number, menu: number): GroupWidths => ({ full, icon, menu });

describe('layoutRibbon — WPS-style shrinking', () => {
  const groups = [g(200, 120, 60), g(150, 90, 60), g(100, 70, 60)];

  it('keeps every group full when the row fits', () => {
    expect(layoutRibbon(groups, 450)).toEqual({ modes: ['full', 'full', 'full'], overflow: false });
    expect(layoutRibbon(groups, 1000).modes).toEqual(['full', 'full', 'full']);
  });

  it('drops captions first, from the last group back', () => {
    expect(layoutRibbon(groups, 440).modes).toEqual(['full', 'full', 'icon']);
    expect(layoutRibbon(groups, 400).modes).toEqual(['full', 'icon', 'icon']);
    expect(layoutRibbon(groups, 300).modes).toEqual(['icon', 'icon', 'icon']);
  });

  it('then folds groups into dropdowns, again from the end', () => {
    expect(layoutRibbon(groups, 270).modes).toEqual(['icon', 'icon', 'menu']);
    expect(layoutRibbon(groups, 240).modes).toEqual(['icon', 'menu', 'menu']);
    expect(layoutRibbon(groups, 180)).toEqual({ modes: ['menu', 'menu', 'menu'], overflow: false });
  });

  it('scrolls (overflow) only when even all dropdowns do not fit', () => {
    expect(layoutRibbon(groups, 150)).toEqual({ modes: ['menu', 'menu', 'menu'], overflow: true });
  });

  it('counts the gap between groups', () => {
    expect(rowWidth(groups, ['full', 'full', 'full'], 4)).toBe(458);
    expect(layoutRibbon(groups, 450, 4).modes).toEqual(['full', 'full', 'icon']);
    expect(layoutRibbon(groups, 458, 4).modes).toEqual(['full', 'full', 'full']);
  });

  it('never folds a group into something as wide or wider', () => {
    // A one-button group: icon-only is no narrower, and its dropdown would be wider.
    const tiny = [g(300, 200, 60), g(40, 40, 60)];
    expect(layoutRibbon(tiny, 250).modes).toEqual(['icon', 'full']);
    expect(layoutRibbon(tiny, 100)).toEqual({ modes: ['menu', 'full'], overflow: false });
    expect(layoutRibbon(tiny, 90)).toEqual({ modes: ['menu', 'full'], overflow: true });
  });

  it('keeps everything full when there is no measured room (a hidden ribbon, jsdom)', () => {
    expect(layoutRibbon(groups, 0).modes).toEqual(['full', 'full', 'full']);
    expect(layoutRibbon(groups, Number.NaN).modes).toEqual(['full', 'full', 'full']);
    expect(layoutRibbon([], 100)).toEqual({ modes: [], overflow: false });
  });
});
