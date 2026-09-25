/** The fill handle's series rules, and the circular-reference check. */
import { describe, expect, it } from 'vitest';
import type { SheetsModel } from '../model';
import { fillSeries, fillTarget } from './fill';
import { isCircularAt } from './helpers';

describe('the fill handle', () => {
  it('extends a numeric series by its step', () => {
    expect(fillSeries([{ value: '1' }, { value: '2' }], 3, 'row').map((c) => c.value)).toEqual(['3', '4', '5']);
    expect(fillSeries([{ value: '10' }, { value: '7.5' }], 2, 'row').map((c) => c.value)).toEqual(['5', '2.5']);
  });

  it('copies one number, counts up text ending in a number, repeats a block', () => {
    expect(fillSeries([{ value: '7' }], 2, 'row').map((c) => c.value)).toEqual(['7', '7']);
    expect(fillSeries([{ value: 'Item 9' }], 2, 'row').map((c) => c.value)).toEqual(['Item 10', 'Item 11']);
    expect(fillSeries([{ value: 'Q01' }], 1, 'row').map((c) => c.value)).toEqual(['Q02']);
    expect(fillSeries([{ value: 'a' }, { value: 'b' }], 3, 'col').map((c) => c.value)).toEqual(['a', 'b', 'a']);
  });

  it('moves relative references of formulas and keeps absolute ones', () => {
    const out = fillSeries([{ value: '2', formula: '=A1*$B$1' }], 2, 'row');
    expect(out.map((c) => c.formula)).toEqual(['=A2*$B$1', '=A3*$B$1']);
    expect(fillSeries([{ value: '2', formula: '=A1+1' }], 1, 'col')[0].formula).toBe('=B1+1');
  });

  it('reads the drag direction from the corner', () => {
    const g = { r0: 0, c0: 0, r1: 1, c1: 1 };
    expect(fillTarget(g, 5, 1)).toEqual({ axis: 'row', count: 4 });
    expect(fillTarget(g, 1, 3)).toEqual({ axis: 'col', count: 2 });
    expect(fillTarget(g, 0, 0)).toBeNull();
  });
});

describe('circular references', () => {
  it('is reported for a formula that depends on itself', () => {
    const model: SheetsModel = { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'S', truncated: false, rows: [['1', '', '']] }], formulas: { '0:0:1': '=C1+1', '0:0:2': '=B1*2' } };
    expect(isCircularAt(model, 0, 1)).toBe(true);
    const fine: SheetsModel = { ...model, formulas: { '0:0:1': '=A1+1' } };
    expect(isCircularAt(fine, 0, 1)).toBe(false);
  });
});
