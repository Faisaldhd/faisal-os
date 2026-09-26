import { describe, expect, it } from 'vitest';
import { cellAlignment, columnsToDraw, isNumeric, sheetDirection } from './layout';

describe('which way a sheet runs', () => {
  it('follows the file when it says', () => {
    expect(sheetDirection([['Name']], true, false)).toBe(true);
    expect(sheetDirection([['الاسم']], false, true)).toBe(false);
  });
  it('an Arabic UI opens a sheet right-to-left, column A on the right', () => {
    expect(sheetDirection([['Name', 'Qty']], undefined, true)).toBe(true);
    expect(sheetDirection([], undefined, true)).toBe(true);
  });
  it('an English UI follows the text of the sheet', () => {
    expect(sheetDirection([['البند', 'التكلفة'], ['خوادم', '5000']], undefined, false)).toBe(true);
    expect(sheetDirection([['Name', 'Qty'], ['محمد', '3']], undefined, false)).toBe(false);
    expect(sheetDirection([['1', '2']], undefined, false)).toBe(false);
  });
});

describe('where a cell’s text sits', () => {
  it('numbers — a formula result too — on the right, left to right', () => {
    expect(cellAlignment('30')).toEqual({ dir: 'ltr', justify: 'flex-end', textAlign: 'right' });
    expect(cellAlignment('-1.5E+3')).toMatchObject({ justify: 'flex-end' });
    expect(isNumeric(' 12 ')).toBe(true);
    expect(isNumeric('')).toBe(false);
  });
  it('text at the start of its own direction', () => {
    expect(cellAlignment('الرياض')).toEqual({ dir: 'rtl', justify: 'flex-start', textAlign: 'start' });
    expect(cellAlignment('Riyadh')).toEqual({ dir: 'ltr', justify: 'flex-start', textAlign: 'start' });
  });
  it('TRUE/FALSE and errors in the middle', () => {
    expect(cellAlignment('TRUE').justify).toBe('center');
    expect(cellAlignment('#DIV/0!').justify).toBe('center');
  });
  it('the file’s own alignment wins, mapped through the text direction', () => {
    expect(cellAlignment('Riyadh', 'right').justify).toBe('flex-end');
    expect(cellAlignment('الرياض', 'right').justify).toBe('flex-start');   // rtl: start is the right
    expect(cellAlignment('الرياض', 'left').justify).toBe('flex-end');
    expect(cellAlignment('30', 'left')).toMatchObject({ justify: 'flex-start', textAlign: 'left' });
    expect(cellAlignment('30', 'center').justify).toBe('center');
  });
});

describe('how many columns to draw', () => {
  const w = (): number => 88;
  it('reaches the far edge of a wide window', () => {
    const cols = columnsToDraw(3, 3, 12, 200, 1900, w);
    expect(48 + cols * 88).toBeGreaterThanOrEqual(1900);
    expect(48 + (cols - 1) * 88).toBeLessThan(1900);
  });
  it('never fewer than the minimum, never more than the sheet has', () => {
    expect(columnsToDraw(1, 0, 12, 200, 300, w)).toBe(12);
    expect(columnsToDraw(1, 0, 12, 14, 5000, w)).toBe(14);
  });
  it('keeps the data and its spare columns on a narrow window', () => {
    expect(columnsToDraw(30, 3, 12, 200, 390, w)).toBe(33);
  });
});
