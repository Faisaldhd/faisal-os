import { describe, expect, it } from 'vitest';
import { pivotsEdit, type SheetsModel } from '../model';
import {
  PIVOT_AGGREGATES, aggregate, colName, pivotFieldName, pivotNumber, pivotSpecUsable, pivotTable, pivotTarget,
  pivotValueLabel, sourceSignature, type PivotPlacement, type PivotSpec,
} from './pivot';

/*
 * The pivot engine's contract, tested on its own: the aggregation rules (what counts, what is
 * skipped, what is empty rather than zero), the ordering (deterministic, never object-key order) and
 * the layout the sheet receives. The panel only turns this answer into cells.
 */

/** A sales sheet: region, product, amount — with a blank, a word and an empty row on purpose. */
const source = [
  ['Region', 'Product', 'Amount'],
  ['Cairo', 'Pen', '10'],
  ['Cairo', 'Pen', '5'],
  ['Cairo', 'Bag', '20'],
  ['Giza', 'Pen', '7'],
  ['Giza', 'Bag', ''],
  ['Giza', 'Bag', 'n/a'],
  ['Alex', 'Pen', '3'],
  ['Alex', 'Bag', '12'],
];

const spec = (over: Partial<PivotSpec> = {}): PivotSpec => ({ rows: [0], cols: [], values: [{ col: 2, fn: 'sum' }], header: true, ...over });

/** The body rows (everything after the header lines) of a table, as text. */
const bodyOf = (table: { cells: ReadonlyArray<ReadonlyArray<string | number>>; titleRows: number; cols: number }): string[][] => {
  const headerLines = 1 + (table.cols > 2 && table.cells[1] && table.cells[1].length > 2 ? 1 : 0);
  void headerLines;
  return table.cells.map((line) => line.map(String));
};

describe('pivot engine — aggregations', () => {
  it('sums numbers and skips text and blanks; count counts every non-empty cell', () => {
    expect(aggregate('sum', ['10', '5', '', 'n/a'])).toBe(15);
    expect(aggregate('sum', ['', 'x'])).toBe(0); // Excel's SUM over no numbers is 0, not an error
    expect(aggregate('count', ['10', '', 'n/a', '  '])).toBe(2); // a word counts, a blank does not
    expect(aggregate('average', ['10', '20', 'x'])).toBe(15);
    expect(aggregate('min', ['10', '5', 'x'])).toBe(5);
    expect(aggregate('max', ['10', '5', 'x'])).toBe(10);
    // Nothing numeric: empty, never an invented 0.
    for (const fn of ['average', 'min', 'max'] as const) expect(aggregate(fn, ['x', '']), fn).toBe('');
  });

  it('reads a cell as a number only when it really is one', () => {
    expect(pivotNumber(' 42 ')).toBe(42);
    expect(pivotNumber('-3.5')).toBe(-3.5);
    expect(pivotNumber('1e3')).toBe(1000);
    expect(pivotNumber('١٢')).toBeNull(); // Arabic-Indic digits are text to the sheet's own reading
    expect(pivotNumber('1,000')).toBeNull(); // a separator is not a number in a cell
    expect(pivotNumber('n/a')).toBeNull();
    expect(pivotNumber(undefined)).toBeNull();
  });

  it('groups by row field, sums each group, and totals every group', () => {
    const table = pivotTable(source, spec());
    const lines = bodyOf(table).slice(1);
    expect(lines[0]).toEqual(['Region', 'Sum of Amount']);
    expect(lines.slice(1)).toEqual([
      ['Alex', '15'],
      ['Cairo', '35'],
      ['Giza', '7'],
      ['Total', '57'],
    ]);
    expect(table.titleRows).toBe(1);
    expect(table.cells[0][0]).toContain('rows A');
  });

  it('orders deterministically: numbers before text, each ascending, whatever the source order was', () => {
    const shuffled = [
      ['Amount'],
      ['10'],
      ['beta'],
      ['2'],
      ['Alpha'],
      ['', ],
    ];
    const table = pivotTable(shuffled, { rows: [0], cols: [], values: [{ col: 0, fn: 'count' }], header: true });
    const labels = bodyOf(table).slice(2).map((line) => line[0]);
    // Numbers ascending first, then text by code unit (so '' leads the text, Alpha before beta) —
    // never object-key order, which would differ between engines and insertion orders.
    expect(labels).toEqual(['2', '10', '', 'Alpha', 'beta', 'Total']);
  });

  it('spreads a column field across the table and repeats it per value', () => {
    const table = pivotTable(source, spec({ cols: [1], values: [{ col: 2, fn: 'sum' }] }));
    const lines = bodyOf(table);
    // Three header-ish lines: title, the column field's values, then the value names.
    expect(lines[0][0]).toContain('columns B');
    expect(lines[1]).toEqual(['Region', 'Bag', 'Pen']);
    expect(lines[2]).toEqual(['Region', 'Sum of Amount', 'Sum of Amount']);
    expect(lines[3]).toEqual(['Alex', '12', '3']);
    expect(lines[4]).toEqual(['Cairo', '20', '15']);
    expect(lines[5]).toEqual(['Giza', '0', '7']); // the blank and 'n/a' are skipped by Sum
    expect(lines[6]).toEqual(['Total', '32', '25']);
  });

  it('counts when no value field is given, and averages/min/maxes on request', () => {
    const counts = pivotTable(source, { rows: [0], cols: [], values: [], header: true });
    expect(bodyOf(counts).slice(2)).toEqual([['Alex', 2], ['Cairo', 3], ['Giza', 3], ['Total', 8]].map((line) => line.map(String)));

    const avg = pivotTable(source, spec({ values: [{ col: 2, fn: 'average' }] }));
    expect(bodyOf(avg)[2]).toEqual(['Alex', '7.5']);
    const min = pivotTable(source, spec({ values: [{ col: 2, fn: 'min' }] }));
    expect(bodyOf(min)[4]).toEqual(['Giza', '7']);
  });

  it('names fields from the header, falls back to column letters, and labels values like a sheet', () => {
    expect(pivotFieldName(source, spec(), 0)).toBe('Region');
    expect(pivotFieldName([['', '  ']], spec({ header: false }), 1)).toBe('Column B');
    expect(colName(0)).toBe('A');
    expect(colName(25)).toBe('Z');
    expect(colName(26)).toBe('AA');
    expect(pivotValueLabel('sum', 'Amount')).toBe('Sum of Amount');
    expect(pivotValueLabel('count', 'Region')).toBe('Count of Region');
    expect(PIVOT_AGGREGATES).toContain('average');
  });

  it('keeps the source fingerprint stable for unchanged data and moving when it changes', () => {
    const before = sourceSignature(source, spec());
    expect(sourceSignature(source, spec())).toBe(before);
    const changed = source.map((row, index) => (index === 3 ? ['Cairo', 'Pen', '6'] : row));
    expect(sourceSignature(changed, spec())).not.toBe(before);
    // A change in a column the pivot does not use is not a change to the pivot.
    const other = source.map((row) => [...row, 'ignored']); // an UNUSED column is appended, so nothing the pivot reads changes
    expect(sourceSignature(other, spec())).toBe(before);
  });

  it('puts the table two rows below the source, in its first column, and refuses an empty spec', () => {
    expect(pivotTarget({ r0: 4, c0: 2, r1: 12 })).toEqual({ row: 14, col: 2 });
    // Never on top of existing data: with the sheet used down to row 20, a one-cell selection at A1
    // puts the table at A23, not A3 — the case the browser proof caught on a real sheet.
    expect(pivotTarget({ r0: 0, c0: 0, r1: 0 }, 20)).toEqual({ row: 22, col: 0 });
    expect(pivotTarget({ r0: 0, c0: 2, r1: 4 }, 2)).toEqual({ row: 6, col: 2 });
    expect(pivotSpecUsable(spec())).toBe(true);
    expect(pivotSpecUsable({ rows: [], cols: [], values: [], header: true })).toBe(false);
    // Nothing usable: a one-cell table rather than a crash.
    const empty = pivotTable(source, { rows: [], cols: [], values: [], header: true });
    expect(empty.rows).toBe(2);
    expect(empty.cells[0][0]).toContain('Count');
  });
});

describe('pivot engine — the recorded placement', () => {
  it('is one undoable edit on the sheet, and one Ctrl+Z takes the record back', () => {
    const model: SheetsModel = {
      kind: 'xlsx', active: 0, delimiter: ',',
      grids: [{ name: 'Sheet1', rows: [['Region', 'Amount'], ['Cairo', '10']], truncated: false }],
    };
    const placement: PivotPlacement = {
      anchor: { row: 4, col: 0 }, source: { r0: 0, c0: 0, r1: 1, c1: 1 },
      spec: spec(), signature: sourceSignature(source, spec()), size: { rows: 3, cols: 2 },
    };
    const applied = pivotsEdit(0, [], [placement]).apply(model) as SheetsModel;
    expect(applied.pivots?.[0]?.[0]?.anchor).toEqual({ row: 4, col: 0 });
    const reverted = pivotsEdit(0, [], [placement]).revert(applied) as SheetsModel;
    expect(reverted.pivots).toBeUndefined();
    // Another sheet keeps its own list, and an empty list removes that sheet's entry.
    const other = pivotsEdit(1, [], [placement]).apply(model) as SheetsModel;
    expect(other.pivots?.[1]).toHaveLength(1);
    expect(other.pivots?.[0]).toBeUndefined();
    const cleared = pivotsEdit(1, [placement], []).apply(other) as SheetsModel;
    expect(cleared.pivots).toBeUndefined();
    // The record never leaks into a document model of another kind.
    expect(pivotsEdit(0, [], [placement]).apply({ kind: 'docx', paragraphs: ['x'] }).kind).toBe('docx');
  });
});
