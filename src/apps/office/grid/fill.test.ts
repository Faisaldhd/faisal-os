import { describe, expect, it } from 'vitest';
import { copyIndex, fillCells, fillPlan, isSingleCell, seriesFrom, type FillRect } from './fill';

/**
 * The fill handle's maths, on its own: where a drag fills (in DRAWN coordinates, which the view
 * then maps to model rows) and what a series does with numbers, dates and text. The model-row
 * mapping — the rule that keeps a fill out of a filtered-hidden row — is integration and lives in
 * `fill-view.test.ts`.
 */
describe('where a drag fills', () => {
  const source: FillRect = { r0: 2, c0: 1, r1: 3, c1: 2 };

  it('reads the direction and the count from the dragged-to cell', () => {
    expect(fillPlan(source, { row: 6, col: 2 })).toEqual({ direction: 'down', count: 3 });
    expect(fillPlan(source, { row: 0, col: 1 })).toEqual({ direction: 'up', count: 2 });
    expect(fillPlan(source, { row: 2, col: 5 })).toEqual({ direction: 'right', count: 3 });
    expect(fillPlan(source, { row: 3, col: 0 })).toEqual({ direction: 'left', count: 1 });
  });

  it('does nothing while the pointer is still inside the source', () => {
    expect(fillPlan(source, { row: 3, col: 2 })).toBeNull();
    expect(fillPlan({ r0: 1, c0: 1, r1: 1, c1: 1 }, { row: 1, col: 1 })).toBeNull();
  });

  it('takes the dominant axis when the drag wobbles sideways', () => {
    expect(fillPlan(source, { row: 9, col: 3 })).toEqual({ direction: 'down', count: 6 });
  });

  it('lists the filled cells in top-to-bottom, left-to-right order', () => {
    expect(fillCells(source, { direction: 'down', count: 2 })).toEqual([
      { row: 4, col: 1 }, { row: 4, col: 2 }, { row: 5, col: 1 }, { row: 5, col: 2 },
    ]);
    expect(fillCells(source, { direction: 'up', count: 2 })).toEqual([
      { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 1, col: 1 }, { row: 1, col: 2 },
    ]);
    expect(fillCells(source, { direction: 'right', count: 2 })).toEqual([
      { row: 2, col: 3 }, { row: 2, col: 4 }, { row: 3, col: 3 }, { row: 3, col: 4 },
    ]);
    expect(fillCells(source, { direction: 'left', count: 1 })).toEqual([{ row: 2, col: 0 }, { row: 3, col: 0 }]);
    expect(fillCells(source, { direction: 'down', count: 0 })).toEqual([]);
  });

  it('knows a one-cell source from a range', () => {
    expect(isSingleCell({ r0: 2, c0: 2, r1: 2, c1: 2 })).toBe(true);
    expect(isSingleCell({ r0: 2, c0: 2, r1: 2, c1: 3 })).toBe(false);
  });
});

describe('the series', () => {
  it('continues two numbers by their step', () => {
    expect(seriesFrom(['10', '20'], 'down', 3)).toEqual(['30', '40', '50']);
    expect(seriesFrom(['100', '150'], 'down', 2)).toEqual(['200', '250']);
    expect(seriesFrom(['1', '3', '5'], 'down', 2)).toEqual(['7', '9']);
  });

  it('continues backwards when the drag goes up or left', () => {
    expect(seriesFrom(['10', '20'], 'up', 2)).toEqual(['-10', '0']);
    expect(seriesFrom(['5', '10'], 'left', 3)).toEqual(['-10', '-5', '0']);
  });

  it('copies a single number, the way every spreadsheet does', () => {
    expect(seriesFrom(['7'], 'down', 3)).toEqual(['7', '7', '7']);
    expect(seriesFrom(['2.5'], 'right', 2)).toEqual(['2.5', '2.5']);
  });

  it('steps a single date by one day, and a pair of dates by their own gap', () => {
    expect(seriesFrom(['2026-01-30'], 'down', 2)).toEqual(['2026-01-31', '2026-02-01']);
    expect(seriesFrom(['2026-01-05', '2026-01-12'], 'down', 2)).toEqual(['2026-01-19', '2026-01-26']);
    expect(seriesFrom(['2026-03-01'], 'up', 1)).toEqual(['2026-02-28']);
  });

  it('steps the number inside a text cell', () => {
    expect(seriesFrom(['بند 3'], 'down', 3)).toEqual(['بند 4', 'بند 5', 'بند 6']);
    expect(seriesFrom(['Q1'], 'right', 3)).toEqual(['Q2', 'Q3', 'Q4']);
  });

  it('copies text, cycling the pattern of the source', () => {
    expect(seriesFrom(['شهري', 'سنوي'], 'down', 4)).toEqual(['شهري', 'سنوي', 'شهري', 'سنوي']);
    expect(seriesFrom(['a', 'b', 'c'], 'right', 4)).toEqual(['a', 'b', 'c', 'a']);
    expect(seriesFrom(['x'], 'down', 2)).toEqual(['x', 'x']);
  });

  it('walks the copy index forwards and backwards', () => {
    expect(copyIndex(1, 3)).toBe(0);
    expect(copyIndex(3, 3)).toBe(2);
    expect(copyIndex(4, 3)).toBe(0);
    expect(copyIndex(-1, 3)).toBe(2);
    expect(copyIndex(-3, 3)).toBe(0);
    expect(copyIndex(0, 0)).toBe(0);
  });

  it('answers an empty request and an empty source without inventing cells', () => {
    expect(seriesFrom(['1', '2'], 'down', 0)).toEqual([]);
    expect(seriesFrom([], 'down', 3)).toEqual([]);
    expect(seriesFrom([''], 'down', 2)).toEqual(['', '']);
  });

  it('never lets a mixed source crash: the first line that does not fit is copied', () => {
    expect(seriesFrom(['10', 'س'], 'down', 2)).toEqual(['10', 'س']);
    expect(seriesFrom(['2026-01-01', 'x'], 'down', 2)).toEqual(['2026-01-01', 'x']);
  });
});
