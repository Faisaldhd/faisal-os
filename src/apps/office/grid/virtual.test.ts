/**
 * The virtual grid's maths: the window a scroll position shows, the element
 * budget between two windows, the width model, auto-fit and border hit-testing.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOFIT_SAMPLE_ROWS, CELL_FONT_SIZE, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, MAX_COL_WIDTH,
  MIN_COL_WIDTH, MIN_WINDOW_ROWS, OVERSCAN_ROWS, autoFitColumns, autoFitWidth, borderGrab,
  clampColWidth, columnWidth, draggedWidth, estimateTextWidth, isDoubleAct, hitSlop, recyclePlan,
  rowAt, rowOffsets, rowWindow, setColumnWidth, shiftColumnWidths,
} from './virtual';

/** Every row the same height — what most sheets are. */
const flat = (count: number, height = 20): Float64Array => rowOffsets(count, () => height);

describe('row offsets', () => {
  it('stacks uniform rows and totals them', () => {
    const offsets = flat(5, 20);
    expect([...offsets]).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('follows a file that gives some rows their own height', () => {
    const offsets = rowOffsets(4, (r) => (r === 1 ? 40 : 20));
    expect([...offsets]).toEqual([0, 20, 60, 80, 100]);
  });

  it('falls back to the default for a height that is not a size', () => {
    const offsets = rowOffsets(2, () => Number.NaN);
    expect([...offsets]).toEqual([0, DEFAULT_ROW_HEIGHT, DEFAULT_ROW_HEIGHT * 2]);
  });

  it('handles an empty sheet and fractions without going backwards', () => {
    expect([...rowOffsets(0, () => 20)]).toEqual([0]);
    expect([...rowOffsets(-3, () => 20)]).toEqual([0]);
    expect([...rowOffsets(2, () => 10.5)]).toEqual([0, 10.5, 21]);
  });
});

describe('the row under a scroll offset', () => {
  const offsets = flat(10, 20);

  it('finds the row whose top is at or above the offset', () => {
    expect(rowAt(offsets, 0)).toBe(0);
    expect(rowAt(offsets, 19)).toBe(0);
    expect(rowAt(offsets, 20)).toBe(1);
    expect(rowAt(offsets, 199)).toBe(9);
  });

  it('clamps past the end and treats a bad offset as the top', () => {
    expect(rowAt(offsets, 10_000)).toBe(9);
    expect(rowAt(offsets, -50)).toBe(0);
    expect(rowAt(offsets, Number.NaN)).toBe(0);
    expect(rowAt(rowOffsets(0, () => 20), 5)).toBe(0);
  });

  it('walks a sheet with rows of different heights', () => {
    const mixed = rowOffsets(4, (r) => [20, 60, 20, 100][r] as number);
    expect([...mixed]).toEqual([0, 20, 80, 100, 200]);
    expect(rowAt(mixed, 79)).toBe(1);
    expect(rowAt(mixed, 80)).toBe(2);
    expect(rowAt(mixed, 150)).toBe(3);
  });
});

describe('the visible window', () => {
  const offsets = flat(1000, 20); // 20 000px of sheet

  it('draws the viewport plus the overscan, with spacers for the rest', () => {
    const w = rowWindow(offsets, 2000, 400, 4);
    expect(w.first).toBe(96);          // row 100 is the first visible one
    expect(w.last).toBe(124);          // 20 visible rows + 4 tail
    expect(w.padTop).toBe(96 * 20);
    expect(w.padBottom).toBe((1000 - 124) * 20);
    expect(w.total).toBe(20_000);
    // The drawn rows plus both spacers are the whole sheet: no gap, no overlap.
    expect(w.padTop + (w.last - w.first) * 20 + w.padBottom).toBe(w.total);
  });

  it('never asks for rows outside the sheet', () => {
    expect(rowWindow(offsets, 0, 400).first).toBe(0);
    const end = rowWindow(offsets, 19_700, 400, 4);
    expect(end.first).toBe(976); // the scroll is clamped to the last full viewport first
    expect(end.last).toBe(1000);
    expect(end.padBottom).toBe(0);
    expect(end.padTop + (end.last - end.first) * 20).toBe(end.total);
  });

  it('clamps a scroll past the end (iOS rubber-banding)', () => {
    const w = rowWindow(offsets, 99_999, 400);
    expect(w.last).toBe(1000);
    expect(w.padBottom).toBe(0);
  });

  it('still draws something when the viewport measures zero', () => {
    const w = rowWindow(offsets, 0, 0);
    expect(w.last - w.first).toBe(MIN_WINDOW_ROWS + OVERSCAN_ROWS);
    expect(rowWindow(offsets, 0, Number.NaN).last).toBe(MIN_WINDOW_ROWS + OVERSCAN_ROWS);
  });

  it('handles a sheet shorter than a row and an empty one', () => {
    const one = rowWindow(flat(1, 20), 0, 400);
    expect(one).toEqual({ first: 0, last: 1, padTop: 0, padBottom: 0, total: 20 });
    expect(rowWindow(flat(0), 0, 400)).toEqual({ first: 0, last: 0, padTop: 0, padBottom: 0, total: 0 });
  });

  it('covers 10 000 rows in one window without ever leaving a gap', () => {
    const big = flat(10_000, 24);
    for (const top of [0, 1, 12_345, 100_000, 239_999]) {
      const w = rowWindow(big, top, 600, OVERSCAN_ROWS);
      expect(w.padTop + (w.last - w.first) * 24 + w.padBottom).toBe(240_000);
      expect(w.last - w.first).toBeLessThan(70); // a window, not the sheet
    }
  });
});

describe('element recycling', () => {
  it('keeps the rows two windows share', () => {
    expect(recyclePlan(0, 30, 10, 40)).toEqual({ reuse: 20, create: 10, drop: 10, forward: true });
  });

  it('reuses everything when the window did not move', () => {
    expect(recyclePlan(10, 40, 10, 40)).toEqual({ reuse: 30, create: 0, drop: 0, forward: true });
  });

  it('counts a jump backwards as a fresh refill of the same size', () => {
    expect(recyclePlan(500, 530, 10, 40)).toEqual({ reuse: 0, create: 30, drop: 30, forward: false });
  });

  it('handles an empty previous window and an empty next one', () => {
    expect(recyclePlan(0, 0, 0, 30)).toEqual({ reuse: 0, create: 30, drop: 0, forward: true });
    expect(recyclePlan(0, 30, 0, 0)).toEqual({ reuse: 0, create: 0, drop: 30, forward: true });
  });
});

describe('the column width model', () => {
  it('clamps to a legal width', () => {
    expect(clampColWidth(100)).toBe(100);
    expect(clampColWidth(4)).toBe(MIN_COL_WIDTH);
    expect(clampColWidth(5000)).toBe(MAX_COL_WIDTH);
    expect(clampColWidth(Number.NaN)).toBe(DEFAULT_COL_WIDTH);
  });

  it('reads the owner width, else the fallback', () => {
    expect(columnWidth({ 2: 140 }, 2, 88)).toBe(140);
    expect(columnWidth({ 2: 140 }, 3, 88)).toBe(88);
    expect(columnWidth(undefined, 0, 120)).toBe(120);
    expect(columnWidth({ 2: Number.NaN }, 2, 88)).toBe(88);
  });

  it('sets a width and forgets one that is back to the fallback', () => {
    const once = setColumnWidth(undefined, 3, 160, 88);
    expect(once).toEqual({ 3: 160 });
    expect(setColumnWidth(once, 4, 200, 88)).toEqual({ 3: 160, 4: 200 });
    expect(setColumnWidth(once, 3, 88, 88)).toBeUndefined();
    expect(setColumnWidth(undefined, 3, 10, 88)).toEqual({ 3: MIN_COL_WIDTH });
  });

  it('does not change the record it was given', () => {
    const before = { 1: 100 };
    const after = setColumnWidth(before, 2, 150);
    expect(before).toEqual({ 1: 100 });
    expect(after).toEqual({ 1: 100, 2: 150 });
  });

  it('moves widths with their columns when a column is inserted or removed', () => {
    const widths = { 0: 100, 2: 150, 5: 90 };
    expect(shiftColumnWidths(widths, 1, 1)).toEqual({ 0: 100, 3: 150, 6: 90 });
    expect(shiftColumnWidths(widths, 2, -1)).toEqual({ 0: 100, 4: 90 }); // column 2 took its 150 with it
    expect(shiftColumnWidths(widths, 9, 1)).toEqual({ 0: 100, 2: 150, 5: 90 });
    expect(shiftColumnWidths(undefined, 0, 1)).toBeUndefined();
    // Removing the column that carried the only width leaves an empty model.
    expect(shiftColumnWidths({ 2: 150 }, 2, -1)).toBeUndefined();
  });
});

describe('auto-fit', () => {
  const measure = (text: string, size = CELL_FONT_SIZE): number => estimateTextWidth(text, size);

  it('guesses a width from the characters, wider for wide scripts', () => {
    expect(estimateTextWidth('iiii')).toBeLessThan(estimateTextWidth('mmmm'));
    expect(estimateTextWidth('1234')).toBeCloseTo(4 * 0.55 * CELL_FONT_SIZE, 5);
    expect(estimateTextWidth('日本語')).toBeCloseTo(3 * CELL_FONT_SIZE, 5);
    expect(estimateTextWidth('مرحبا')).toBeLessThan(estimateTextWidth('日本語'));
    expect(estimateTextWidth('')).toBe(0);
  });

  it('fits the widest sample, plus padding', () => {
    const width = autoFitWidth(['ab', 'a much longer label'], measure);
    expect(width).toBeGreaterThan(estimateTextWidth('a much longer label'));
    expect(width).toBeLessThanOrEqual(MAX_COL_WIDTH);
    expect(autoFitWidth([], measure)).toBe(MIN_COL_WIDTH);
    expect(autoFitWidth([''], measure)).toBe(MIN_COL_WIDTH);
  });

  it('reads only the sample at the top of the sheet', () => {
    const rows = Array.from({ length: AUTOFIT_SAMPLE_ROWS + 50 }, () => ['short']);
    rows[rows.length - 1] = ['a much much much longer cell right at the bottom'];
    const narrow = autoFitColumns(rows, [0], measure);
    expect(narrow.get(0)).toBe(autoFitWidth(['short'], measure));
    const whole = autoFitColumns(rows, [0], measure, rows.length);
    expect(whole.get(0)).toBeGreaterThan(narrow.get(0) as number);
  });

  it('fits each column on its own content and ignores empty ones', () => {
    const rows = [['a', 'a very wide cell'], ['bb', '']];
    const widths = autoFitColumns(rows, [0, 1, 2], measure);
    expect(widths.get(0)).toBe(autoFitWidth(['a', 'bb'], measure));
    expect(widths.get(1)).toBe(autoFitWidth(['a very wide cell'], measure));
    expect(widths.get(2)).toBe(MIN_COL_WIDTH);
    expect(autoFitColumns([], [], measure).size).toBe(0);
  });
});

describe('grabbing a column border', () => {
  // Three columns of 100px, as the browser reports them.
  const rects = [{ left: 0, right: 100 }, { left: 100, right: 200 }, { left: 200, right: 300 }];

  it('grabs the column whose trailing border is under the pointer', () => {
    expect(borderGrab(rects, 100, 5)).toBe(0);
    expect(borderGrab(rects, 103, 5)).toBe(0);
    expect(borderGrab(rects, 199, 5)).toBe(1);
    expect(borderGrab(rects, 300, 5)).toBe(2);
  });

  it('finds nothing in the middle of a cell or on the table’s own left edge', () => {
    expect(borderGrab(rects, 50, 5)).toBeNull();
    expect(borderGrab(rects, 150, 5)).toBeNull();
    expect(borderGrab(rects, 2, 5)).toBeNull();
    expect(borderGrab(rects, 100, 0)).toBeNull();
  });

  it('needs a 44px band on touch and only 10px with a mouse', () => {
    expect(hitSlop(true)).toBe(22);
    expect(hitSlop(false)).toBe(5);
    expect(borderGrab(rects, 100, hitSlop(true))).toBe(0);
    expect(borderGrab(rects, 120, hitSlop(true))).toBe(0); // 20px away: inside the band
    expect(borderGrab(rects, 180, hitSlop(true))).toBe(1); // 20px before B's trailing edge
    expect(borderGrab(rects, 120, hitSlop(false))).toBeNull();
  });

  it('reads the trailing edge from the other side on a right-to-left sheet', () => {
    // The same sheet mirrored: the rectangles move, the column order does not.
    const mirrored = [{ left: 200, right: 300 }, { left: 100, right: 200 }, { left: 0, right: 100 }];
    expect(borderGrab(mirrored, 200, 5, true)).toBe(0); // A's trailing edge is its left one
    expect(borderGrab(mirrored, 100, 5, true)).toBe(1);
    expect(borderGrab(mirrored, 300, 5, true)).toBeNull(); // A's leading edge resizes nothing
    expect(borderGrab(mirrored, 200, 5, false)).toBe(1);  // …and with the wrong side it is B's
  });

  it('turns a drag into a width and clamps it', () => {
    expect(draggedWidth(100, 500, 560)).toBe(160);
    expect(draggedWidth(100, 500, 460)).toBe(60);
    expect(draggedWidth(100, 500, -5000)).toBe(MIN_COL_WIDTH);
    expect(draggedWidth(100, 500, 5000)).toBe(MAX_COL_WIDTH);
  });

  it('reads a double act from two hits close in time and place', () => {
    expect(isDoubleAct(1000, 300, 1200, 304)).toBe(true);
    expect(isDoubleAct(1000, 300, 2000, 300)).toBe(false);
    expect(isDoubleAct(1000, 300, 1100, 400)).toBe(false);
  });
});
