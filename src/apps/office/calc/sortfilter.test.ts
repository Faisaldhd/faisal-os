/** Multi-level sort and the AutoFilter model. */
import { describe, expect, it } from 'vitest';
import { distinctValues, filterRows, matchesCondition, visibleRows } from './filter';
import { compareCells, sortPermutation, sortRows } from './sort';

describe('sort', () => {
  it('orders numbers < text < booleans < errors, blanks last in both directions', () => {
    const col = [['b'], ['10'], [''], ['TRUE'], ['2'], ['#N/A'], ['A'], [null]];
    expect(sortRows(col, [{ col: 0 }]).map((r) => r[0])).toEqual(['2', '10', 'A', 'b', 'TRUE', '#N/A', '', null]);
    expect(sortRows(col, [{ col: 0, order: 'desc' }]).map((r) => r[0])).toEqual(['#N/A', 'TRUE', 'b', 'A', '10', '2', '', null]);
  });

  it('is stable and multi-level', () => {
    const rows = [
      ['Name', 'Dept', 'Salary'],
      ['Sara', 'IT', '9000'],
      ['Ali', 'HR', '7000'],
      ['Omar', 'IT', '9000'],
      ['Huda', 'HR', '8000'],
    ];
    const perm = sortPermutation(rows, [{ col: 1 }, { col: 2, order: 'desc' }], { header: 1 });
    expect(perm).toEqual([0, 4, 2, 1, 3]); // header stays; Sara before Omar (stable)
  });

  it('sorts Arabic text and ignores case unless asked', () => {
    const rows = [['ياسر'], ['أحمد'], ['باسم'], ['b'], ['B'], ['a']];
    expect(sortRows(rows, [{ col: 0 }]).map((r) => r[0])).toEqual(['أحمد', 'باسم', 'ياسر', 'a', 'b', 'B']);
    expect(compareCells('a', 'A')).toBe(0);
    expect(compareCells('a', 'A', { caseSensitive: true })).not.toBe(0);
  });

  it('accepts engine scalars', () => {
    expect(sortRows([[3], [1], [true], ['x']], [{ col: 0 }]).map((r) => r[0])).toEqual([1, 3, 'x', true]);
  });
});

describe('AutoFilter', () => {
  const rows = [
    ['Item', 'Qty', 'City'],
    ['Pen', '5', 'الرياض'],
    ['pen', '12', 'Jeddah'],
    ['Book', '', 'الرياض'],
    ['Bag', '30', 'Dammam'],
    ['Cup', '7', 'jeddah'],
  ];

  it('lists distinct values with counts, blanks last', () => {
    expect(distinctValues(rows, 0, { header: 1 })).toEqual([
      { key: 'Bag', label: 'Bag', count: 1 },
      { key: 'Book', label: 'Book', count: 1 },
      { key: 'Cup', label: 'Cup', count: 1 },
      { key: 'Pen', label: 'Pen', count: 2 },
    ]);
    const qty = distinctValues(rows, 1, { header: 1, format: (v) => `#${String(v)}` });
    expect(qty.map((d) => d.key)).toEqual(['5', '7', '12', '30', '']);
    expect(qty[0].label).toBe('#5');
    expect(qty[4].label).toBe('');
  });

  it('filters by a checklist, case-insensitively, and keeps the header', () => {
    expect(visibleRows(rows, { 2: { kind: 'values', keys: ['Jeddah'] } }, { header: 1 })).toEqual([0, 2, 5]);
    expect(visibleRows(rows, { 1: { kind: 'values', keys: [''] } }, { header: 1 })).toEqual([0, 3]);
  });

  it('filters by comparisons, ranges, text, blanks and combined conditions', () => {
    expect(visibleRows(rows, { 1: { kind: 'compare', op: '>', value: 6 } }, { header: 1 })).toEqual([0, 2, 4, 5]);
    expect(visibleRows(rows, { 1: { kind: 'compare', op: '>=', value: '12' } }, { header: 1 })).toEqual([0, 2, 4]);
    expect(visibleRows(rows, { 1: { kind: 'between', min: 5, max: 12 } }, { header: 1 })).toEqual([0, 1, 2, 5]);
    expect(visibleRows(rows, { 0: { kind: 'text', op: 'begins', value: 'b' } }, { header: 1 })).toEqual([0, 3, 4]);
    expect(visibleRows(rows, { 2: { kind: 'text', op: 'contains', value: 'رياض' } }, { header: 1 })).toEqual([0, 1, 3]);
    expect(visibleRows(rows, { 2: { kind: 'text', op: 'notContains', value: 'dd' } }, { header: 1 })).toEqual([0, 1, 3, 4]);
    expect(visibleRows(rows, { 1: { kind: 'blank', not: true } }, { header: 1 })).toEqual([0, 1, 2, 4, 5]);
    expect(visibleRows(rows, { 1: { kind: 'or', a: { kind: 'compare', op: '<', value: 6 }, b: { kind: 'compare', op: '>', value: 20 } } }, { header: 1 })).toEqual([0, 1, 4]);
    expect(visibleRows(rows, {
      0: { kind: 'values', keys: ['pen'] },
      1: { kind: 'compare', op: '>', value: 10 },
    }, { header: 1 })).toEqual([0, 2]);
    expect(visibleRows(rows, { 0: { kind: 'compare', op: '=', value: 'PEN' } }, { header: 1 })).toEqual([0, 1, 2]);
  });

  it('filters top N, top percent and above/below average', () => {
    expect(visibleRows(rows, { 1: { kind: 'top', count: 2 } }, { header: 1 })).toEqual([0, 2, 4]);
    expect(visibleRows(rows, { 1: { kind: 'top', count: 1, bottom: true } }, { header: 1 })).toEqual([0, 1]);
    expect(visibleRows(rows, { 1: { kind: 'top', count: 50, percent: true } }, { header: 1 })).toEqual([0, 2, 4]);
    expect(visibleRows(rows, { 1: { kind: 'average' } }, { header: 1 })).toEqual([0, 4]); // average 13.5
    expect(visibleRows(rows, { 1: { kind: 'average', below: true } }, { header: 1 })).toEqual([0, 1, 2, 5]);
    expect(filterRows(rows, {})).toEqual([true, true, true, true, true, true]);
    expect(matchesCondition('5', { kind: 'top', count: 1 })).toBe(false); // no stats given
  });
});
