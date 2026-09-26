import { describe, expect, it } from 'vitest';
import { chartPlacement, chartSource, chartTitleFrom, dataRegion, draggedChart, resizedChart } from './chartplace';

const rows = [
  ['Region', 'Sales', 'Cost', '', 'x'],
  ['North', '10', '4'],
  ['South', '20', '6'],
  ['', '', ''],
  ['far', '', ''],
];

describe('the data a chart is made from', () => {
  it('is the table around a single selected cell', () => {
    expect(dataRegion(rows, 1, 1)).toEqual({ r0: 0, c0: 0, r1: 2, c1: 2 });
    expect(chartSource(rows, { r0: 2, c0: 2, r1: 2, c1: 2 })).toEqual({ r0: 0, c0: 0, r1: 2, c1: 2 });
  });
  it('is the selection when more than one cell is selected', () => {
    expect(chartSource(rows, { r0: 0, c0: 0, r1: 2, c1: 1 })).toEqual({ r0: 0, c0: 0, r1: 2, c1: 1 });
  });
  it('stops at an empty row and an empty column', () => {
    expect(dataRegion(rows, 4, 0)).toEqual({ r0: 4, c0: 0, r1: 4, c1: 0 });
  });
});

describe('where a new chart goes', () => {
  const colStart = (c: number): number => c * 100;
  const rowTop = (r: number): number => r * 24;
  it('beside the data, level with its top — never over it', () => {
    const at = chartPlacement({ r0: 0, c0: 0, r1: 2, c1: 2 }, colStart, rowTop);
    expect(at).toEqual({ x: 316, y: 0 });
    expect(at.x).toBeGreaterThan(colStart(3));
  });
  it('follows a block lower down the sheet', () => {
    expect(chartPlacement({ r0: 5, c0: 1, r1: 9, c1: 1 }, colStart, rowTop, 8)).toEqual({ x: 208, y: 120 });
  });
});

describe('what a new chart is called', () => {
  it('the header of the first value column', () => {
    expect(chartTitleFrom(rows, { r0: 0, c0: 0, r1: 2, c1: 2 }, 'Chart')).toBe('Sales');
  });
  it('the fallback when there is no header row', () => {
    expect(chartTitleFrom(rows, { r0: 1, c0: 0, r1: 2, c1: 1 }, 'Chart')).toBe('Chart');
  });
  it('a single numeric column under a header takes that header', () => {
    expect(chartTitleFrom([['المبيعات'], ['1'], ['2']], { r0: 0, c0: 0, r1: 2, c1: 0 }, 'مخطط')).toBe('المبيعات');
  });
});

describe('moving and resizing a chart', () => {
  it('drags the way the pointer goes, mirrored in a right-to-left sheet', () => {
    expect(draggedChart({ x: 100, y: 50 }, 30, 10, false)).toEqual({ x: 130, y: 60 });
    expect(draggedChart({ x: 100, y: 50 }, 30, 10, true)).toEqual({ x: 70, y: 60 });
    expect(draggedChart({ x: 10, y: 5 }, -50, -50, false)).toEqual({ x: 0, y: 0 });
  });
  it('resizes from its corner and keeps a readable minimum', () => {
    expect(resizedChart({ w: 400, h: 280 }, 40, 20, false)).toEqual({ w: 440, h: 300 });
    expect(resizedChart({ w: 400, h: 280 }, 40, 20, true)).toEqual({ w: 360, h: 300 });
    expect(resizedChart({ w: 200, h: 150 }, -500, -500, false)).toEqual({ w: 160, h: 120 });
  });
});
