/**
 * The sheet's view-level glue: the sort/AutoFilter/format/chart state reducer, which rows the
 * filter leaves visible, the range → chart-spec adapter, and the number-format picker mapping.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_FORMATS, formatValue, makeFormat } from '../calc/index';
import {
  MAX_SORT_LEVELS, addChart, addCondRule, addSortLevel, chartNumber, chartTypeChoices, clearCondRules,
  clearFilter, clearFilters, clearSort, colorScaleRule, conditionalStyles, dataBarRule, displayText,
  dragPosition, emptySheetView, filteredColumns, formatChoices, formatForCell, isFiltered, looksLikeHeader,
  rangeToChartSpec, removeChart, removeSortLevel, setFilter, setSortOrder, topRule, visibleRowMap,
} from './sheetview';

const SHEET: string[][] = [
  ['Item', 'Qty', 'Price'],
  ['Widget', '3', '10'],
  ['Gadget', '1', '250'],
  ['Cable', '5', '2'],
  ['Widget', '2', '10'],
];

describe('multi-level sort state', () => {
  it('adds a level at the front (the newest key is the most significant)', () => {
    let view = emptySheetView();
    view = addSortLevel(view, 1, 'asc');
    view = addSortLevel(view, 2, 'desc');
    expect(view.sort).toEqual([{ col: 2, order: 'desc' }, { col: 1, order: 'asc' }]);
  });

  it('never keeps two keys for the same column', () => {
    let view = addSortLevel(emptySheetView(), 1, 'asc');
    view = addSortLevel(view, 1, 'desc');
    expect(view.sort).toEqual([{ col: 1, order: 'desc' }]);
  });

  it('caps the levels it offers', () => {
    let view = emptySheetView();
    for (const col of [0, 1, 2, 3, 4]) view = addSortLevel(view, col, 'asc');
    expect(view.sort).toHaveLength(MAX_SORT_LEVELS);
    expect(view.sort.map((k) => k.col)).toEqual([4, 3, 2]);
  });

  it('flips a level’s direction, removes one, and clears them all', () => {
    let view = addSortLevel(addSortLevel(emptySheetView(), 1), 2);
    view = setSortOrder(view, 1, 'desc');
    expect(view.sort.find((k) => k.col === 1)?.order).toBe('desc');
    expect(setSortOrder(view, 9, 'desc')).toBe(view);      // an unknown column changes nothing
    view = removeSortLevel(view, 2);
    expect(view.sort.map((k) => k.col)).toEqual([1]);
    expect(clearSort(view).sort).toEqual([]);
  });
});

describe('the header row', () => {
  it('is recognised: text on top, numbers below', () => {
    expect(looksLikeHeader(SHEET)).toBe(true);
    expect(looksLikeHeader([['1', '2'], ['3', '4']])).toBe(false);
    expect(looksLikeHeader([['Item', 'Qty']])).toBe(false);       // one row is not enough
    expect(looksLikeHeader([[], []])).toBe(false);
  });
});

describe('AutoFilter state', () => {
  it('sets, reports, clears one column, clears them all', () => {
    let view = setFilter(emptySheetView(), 1, { kind: 'values', keys: ['3'] });
    expect(isFiltered(view)).toBe(true);
    expect(filteredColumns(view)).toEqual([1]);
    view = setFilter(view, 2, { kind: 'compare', op: '>', value: 5 });
    expect(filteredColumns(view)).toEqual([1, 2]);
    view = clearFilter(view, 1);
    expect(filteredColumns(view)).toEqual([2]);
    expect(clearFilters(view).filters).toEqual({});
    expect(isFiltered(emptySheetView())).toBe(false);
  });

  it('leaves the header rows alone and counts what it hides', () => {
    const view = setFilter(emptySheetView(), 0, { kind: 'values', keys: ['Widget'] });
    const map = visibleRowMap(SHEET, view, 1);
    expect(map.filtered).toBe(true);
    expect(map.rows).toEqual([0, 1, 4]);
    expect(map.hidden).toBe(2);
  });

  it('maps every row when nothing is filtered', () => {
    const map = visibleRowMap(SHEET, emptySheetView(), 1);
    expect(map.rows).toEqual([0, 1, 2, 3, 4]);
    expect(map.filtered).toBe(false);
    expect(map.hidden).toBe(0);
  });

  it('applies every column’s condition at once', () => {
    let view = setFilter(emptySheetView(), 0, { kind: 'values', keys: ['Widget'] });
    view = setFilter(view, 1, { kind: 'compare', op: '>', value: 2 });
    expect(visibleRowMap(SHEET, view, 1).rows).toEqual([0, 1]);   // header + the 3-widget row
  });
});

describe('the number-format picker', () => {
  const choices = formatChoices();

  it('offers patterns the engine really understands', () => {
    expect(choices.length).toBeGreaterThan(6);
    for (const choice of choices) {
      expect(choice.labelKey.startsWith('office.')).toBe(true);
      // Every pattern must format a number without throwing.
      expect(() => formatValue(1234.5, choice.value, { locale: 'en' })).not.toThrow();
    }
    const patterns = choices.map((c) => c.value);
    expect(new Set(patterns).size).toBe(patterns.length);         // no duplicates
    expect(patterns).toContain(BUILTIN_FORMATS[0]);
    expect(patterns).toContain(BUILTIN_FORMATS[4]);
    expect(patterns).toContain(makeFormat({ kind: 'currency', decimals: 2 }));
  });

  it('gives every choice its own label key', () => {
    const keys = choices.map((c) => c.labelKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('formats a cell through its chosen pattern, and leaves General alone', () => {
    const formats = { '1:2': BUILTIN_FORMATS[4] };
    expect(formatForCell(formats, 1, 2)).toBe('#,##0.00');
    expect(formatForCell(formats, 2, 2)).toBe('');
    expect(displayText('1234.5', '#,##0.00')).toBe('1,234.50');
    expect(displayText('50%', '0.0%')).toBe('50.0%');
    expect(displayText('Widget', '#,##0.00')).toBe('Widget');      // not a number: shown as it is
    expect(displayText('1234.5', 'General')).toBe('1234.5');
    expect(displayText('', '#,##0')).toBe('');
  });
});

describe('conditional formatting', () => {
  it('returns one style slot per cell, and none without rules', () => {
    const none = conditionalStyles(SHEET, []);
    expect(none).toHaveLength(SHEET.length);
    expect(none[0]).toHaveLength(SHEET[0].length);
    expect(none.flat().every((s) => s === null)).toBe(true);
  });

  it('paints a colour scale and draws a data bar through the engine', () => {
    const scale = conditionalStyles(SHEET, [colorScaleRule()]);
    expect(scale[1][1]).not.toBeNull();
    expect(String(scale[1][1]?.fill)).toMatch(/^#/);
    const bars = conditionalStyles(SHEET, [dataBarRule()]);
    const bar = bars[1][1]?.bar;
    expect(bar).toBeTruthy();
    expect(bar!.end).toBeGreaterThan(bar!.start);
    expect(bar!.color).toBe('#5B8DEF');
  });

  it('marks the top values with a rule, and clears the rules', () => {
    const top = conditionalStyles(SHEET, [topRule(1)]);
    const painted = top.flat().filter((s) => s?.fill).length;
    expect(painted).toBeGreaterThan(0);
    expect(clearCondRules(addCondRule(emptySheetView(), colorScaleRule())).condRules).toEqual([]);
  });
});

describe('a range becomes a chart spec', () => {
  it('takes the first column as categories and the rest as series, named from the header', () => {
    const spec = rangeToChartSpec(SHEET, { r0: 0, c0: 0, r1: 4, c1: 2 }, { type: 'bar', title: 'Qty' });
    expect(spec.type).toBe('bar');
    expect(spec.categories).toEqual(['Widget', 'Gadget', 'Cable', 'Widget']);
    expect(spec.series).toHaveLength(2);
    expect(spec.series[0].name).toBe('Qty');
    expect((spec.series[0] as unknown as { values: Array<number | null> }).values).toEqual([3, 1, 5, 2]);
    expect(spec.title).toBe('Qty');
    expect(spec.xTitle).toBe('Item');
  });

  it('uses the row numbers as categories for a single column', () => {
    const spec = rangeToChartSpec(SHEET, { r0: 1, c0: 1, r1: 4, c1: 1 }, { type: 'line' });
    expect(spec.categories).toEqual(['2', '3', '4', '5']);
    expect(spec.series).toHaveLength(1);
    expect((spec.series[0] as unknown as { values: Array<number | null> }).values).toEqual([3, 1, 5, 2]);
  });

  it('treats a range with no header as data, and keeps blanks as gaps', () => {
    const spec = rangeToChartSpec([['1', '2'], ['3', ''], ['5', '6']], { r0: 0, c0: 0, r1: 2, c1: 1 }, { type: 'line' });
    expect(spec.categories).toEqual(['1', '3', '5']);
    expect((spec.series[0] as unknown as { values: Array<number | null> }).values).toEqual([2, null, 6]);
  });

  it('builds points for a scatter and survives an empty range', () => {
    const scatter = rangeToChartSpec(SHEET, { r0: 1, c0: 1, r1: 4, c1: 2 }, { type: 'scatter' });
    expect(scatter.categories).toBeUndefined();
    const points = (scatter.series[0] as unknown as { points: Array<{ x: number; y: number }> }).points;
    expect(points[0]).toEqual({ x: 3, y: 10 });
    const empty = rangeToChartSpec([], { r0: 5, c0: 5, r1: 2, c1: 2 }, { type: 'pie' });
    expect(empty.series).toEqual([]);
  });

  it('swaps an inverted range the way a selection drag can produce it', () => {
    const spec = rangeToChartSpec(SHEET, { r0: 4, c0: 2, r1: 0, c1: 0 }, { type: 'bar' });
    expect(spec.series.length).toBeGreaterThan(0);
  });

  it('reads numbers through the engine’s own parser', () => {
    expect(chartNumber('1,234.5')).toBe(1234.5);
    expect(chartNumber('50%')).toBe(0.5);
    expect(chartNumber('Widget')).toBeNull();
    expect(chartNumber('')).toBeNull();
  });

  it('names the chart types the dialog offers', () => {
    expect(chartTypeChoices().map((c) => c.value)).toEqual(['bar', 'line', 'pie', 'doughnut', 'scatter']);
    for (const choice of chartTypeChoices()) expect(choice.labelKey.startsWith('office.')).toBe(true);
  });
});

describe('charts as objects over the sheet', () => {
  const chart = { type: 'bar' as const, range: { r0: 0, c0: 0, r1: 3, c1: 2 }, title: 'T', x: 10, y: 20, w: 320, h: 200 };

  it('adds with a stable id and removes by it', () => {
    const view = addChart(emptySheetView(), chart);
    expect(view.charts).toHaveLength(1);
    expect(view.charts[0].id).toMatch(/^chart1-/);
    expect(removeChart(view, view.charts[0].id).charts).toEqual([]);
    expect(removeChart(view, 'nope')).toBe(view);
  });

  it('keeps a dragged chart inside the sheet', () => {
    const bounds = { w: 400, h: 300 };
    const size = { w: 320, h: 200 };
    expect(dragPosition({ x: 10, y: 20 }, 50, 40, bounds, size)).toEqual({ x: 60, y: 60 });
    expect(dragPosition({ x: 10, y: 20 }, 1000, 1000, bounds, size)).toEqual({ x: 80, y: 100 });
    expect(dragPosition({ x: 10, y: 20 }, -1000, -1000, bounds, size)).toEqual({ x: 0, y: 0 });
    // A chart bigger than the sheet cannot go negative.
    expect(dragPosition({ x: 0, y: 0 }, 10, 10, { w: 100, h: 100 }, { w: 300, h: 300 })).toEqual({ x: 0, y: 0 });
  });
});
