/**
 * Sheet — the pivot engine (الجدول المحوري), pure and DOM-free.
 *
 * A pivot reads a rectangular source range and answers one question: for every combination of the
 * chosen ROW fields and COLUMN fields, what do the VALUE fields add up to (sum, count, average, min,
 * max)? Everything here is a function of the source cells and the spec — no DOM, no sheet model, no
 * clock — so the whole engine is testable on its own, and the view only turns the answer into
 * ordinary cells through one undoable edit.
 *
 * Two rules the owner asked for, spelled out because they are the ones that go wrong:
 *  • EMPTY and TEXT: `count` counts every NON-EMPTY cell (a number or a word), like Excel's COUNTA;
 *    `sum`/`average`/`min`/`max` ignore anything that is not a number, and `average`/`min`/`max` with
 *    no number at all are EMPTY (not 0), so a wrong number is never invented.
 *  • ORDER: the result is deterministic. Group keys are sorted (numbers first, ascending, then text
 *    by code unit — never by object-key order, which differs between engines and insertion orders),
 *    so the same source always produces byte-identical cells.
 *
 * All coordinates are indices inside the source range; the caller maps them to sheet rows/columns.
 */

export type PivotAggregate = 'sum' | 'count' | 'average' | 'min' | 'max';

export const PIVOT_AGGREGATES: readonly PivotAggregate[] = ['sum', 'count', 'average', 'min', 'max'];

/** One value field: which column of the source, and what to do with it. */
export interface PivotValue {
  col: number;
  fn: PivotAggregate;
}

export interface PivotSpec {
  /** Field columns (indices in the source) whose values become the table's rows, in order. */
  rows: number[];
  /** Field columns whose values spread across the table, in order. Empty = a single value column. */
  cols: number[];
  /** What the table measures. At least one; with none the engine counts the row field. */
  values: PivotValue[];
  /** The source's first row holds the field names (Excel's own convention). */
  header: boolean;
}

/** A cell the pivot produced: a label, a number, or an empty cell. */
export type PivotCell = string | number;

export interface PivotSize {
  rows: number;
  cols: number;
  /** How many columns before the value columns are label columns. */
  labelCols: number;
  /** Title lines the table carries above its header row. */
  titleRows: number;
}

export interface PivotTable extends PivotSize {
  /** The table as it must land in the sheet, top-left first: titles, then header, then body. */
  cells: PivotCell[][];
}

/** A number the cell holds, or null when it holds nothing numeric. */
export function pivotNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const text = cell.trim();
  if (!text) return null;
  // Excel's own reading of a typed number: a plain decimal, an optional sign, no separators.
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** True when the cell holds anything at all (a word counts: that is what `count` is for). */
export const pivotHasValue = (cell: string | undefined): boolean => (cell ?? '').trim() !== '';

/** The groups' key, compared in a fixed order: numbers first, then text, then by code unit. */
function compareKeys(a: string, b: string): number {
  const na = pivotNumber(a);
  const nb = pivotNumber(b);
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  // Code-unit order, not locale order: the same source must sort the same everywhere.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One aggregate over the collected cell texts. */
export function aggregate(fn: PivotAggregate, cells: readonly string[]): PivotCell {
  if (fn === 'count') return cells.filter(pivotHasValue).length;
  const numbers: number[] = [];
  for (const cell of cells) {
    const value = pivotNumber(cell);
    if (value !== null) numbers.push(value);
  }
  switch (fn) {
    case 'sum':
      // SUM over nothing is 0 in Excel, and text is skipped rather than treated as 0.
      return numbers.reduce((total, value) => total + value, 0);
    case 'average':
      return numbers.length ? Math.round((numbers.reduce((total, value) => total + value, 0) / numbers.length) * 1e10) / 1e10 : '';
    case 'min':
      return numbers.length ? Math.min(...numbers) : '';
    default:
      return numbers.length ? Math.max(...numbers) : '';
  }
}

/** A field's name: the source's header cell, or the column letter when the source has no header. */
export function pivotFieldName(source: readonly (readonly string[])[], spec: PivotSpec, col: number): string {
  if (spec.header) {
    const header = source[0]?.[col];
    if (header !== undefined && header.trim()) return header.trim();
  }
  return `Column ${colName(col)}`;
}

/** `0 → A`, `27 → AB`: the same letters the sheet itself shows. */
export function colName(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** "Sum of Amount": what a value column is called, the way a spreadsheet labels it. */
export function pivotValueLabel(fn: PivotAggregate, field: string): string {
  const verb = fn === 'sum' ? 'Sum' : fn === 'count' ? 'Count' : fn === 'average' ? 'Average' : fn === 'min' ? 'Min' : 'Max';
  return `${verb} of ${field}`;
}

/** The rows the engine walks: everything below the header when the source has one. */
function bodyRows(source: readonly (readonly string[])[], header: boolean): readonly (readonly string[])[] {
  return header ? source.slice(1) : source;
}

/**
 * The pivot table for a source range and a spec.
 *
 * The layout is the one a spreadsheet uses: the row fields' values as leading columns, then one
 * column per value field (crossed by the column fields when there are any), with a header row and a
 * title line that names the source. `rows` must name at least one field; with no value field the
 * table counts the rows, which is still a useful answer.
 */
export function pivotTable(source: readonly (readonly string[])[], spec: PivotSpec): PivotTable {
  const rows = bodyRows(source, spec.header);
  const rowFields = spec.rows.length ? spec.rows : spec.cols.length ? [spec.cols[0]] : [];
  const colFields = spec.rows.length ? spec.cols : [];
  const values: PivotValue[] = spec.values.length ? spec.values : rowFields.length ? [{ col: rowFields[0], fn: 'count' }] : [];
  if (!rowFields.length) {
    return { cells: [[pivotValueLabel('count', 'rows')], [0]], rows: 2, cols: 1, labelCols: 0, titleRows: 0 };
  }

  const keyOf = (cells: readonly string[], fields: readonly number[]): string[] =>
    fields.map((col) => (cells[col] ?? '').trim());

  /** Group every source row by its row key; inside, by its column key. */
  const groups = new Map<string, { keys: string[]; columns: Map<string, { keys: string[]; cells: string[][] }> }>();
  for (const cells of rows) {
    const rowKeys = keyOf(cells, rowFields);
    const rowKey = rowKeys.join('\u0001');
    let group = groups.get(rowKey);
    if (!group) { group = { keys: rowKeys, columns: new Map() }; groups.set(rowKey, group); }
    const colKeys = keyOf(cells, colFields);
    const colKey = colKeys.join('\u0001');
    let bucket = group.columns.get(colKey);
    if (!bucket) { bucket = { keys: colKeys, cells: values.map(() => []) }; group.columns.set(colKey, bucket); }
    for (const [index, value] of values.entries()) bucket.cells[index].push(cells[value.col] ?? '');
  }

  const rowOrder = [...groups.values()].sort((a, b) => {
    for (let i = 0; i < a.keys.length; i++) {
      const order = compareKeys(a.keys[i] ?? '', b.keys[i] ?? '');
      if (order) return order;
    }
    return 0;
  });
  const columnOrder = colFields.length
    ? [...new Map([...groups.values()].flatMap((group) => [...group.columns.values()].map((bucket) => [bucket.keys.join('\u0001'), bucket]))).values()]
      .sort((a, b) => {
        for (let i = 0; i < a.keys.length; i++) {
          const order = compareKeys(a.keys[i] ?? '', b.keys[i] ?? '');
          if (order) return order;
        }
        return 0;
      })
    : [];

  const labelNames = rowFields.map((col) => pivotFieldName(source, spec, col));
  const valueNames = values.map((value) => pivotValueLabel(value.fn, pivotFieldName(source, spec, value.col)));
  const cells: PivotCell[][] = [];

  // A title line, so the table is recognisable in the file and in Excel's formula bar.
  cells.push([pivotTitle(rowFields, colFields, valueNames)]);
  if (colFields.length) {
    // Two header lines, the classic spreadsheet stack: the column field's values span their block of
    // value columns, and the value names repeat underneath. The label sits in the first column of the
    // block and the rest stay empty — this sheet has no merged cells, and pretending otherwise would
    // make the header unsortable and unfilterable.
    const columnNames = colFields.map((col) => pivotFieldName(source, spec, col));
    const label = (keys: readonly string[]): string =>
      keys.map((key, index) => (colFields.length > 1 ? `${columnNames[index] ?? ''}: ${key}` : key)).join(' · ');
    const over: PivotCell[] = [...labelNames, ...columnOrder.flatMap((bucket) => [label(bucket.keys), ...Array(values.length - 1).fill('')])];
    const under: PivotCell[] = [...labelNames, ...columnOrder.flatMap(() => valueNames)];
    cells.push(over, under);
  } else {
    cells.push([...labelNames, ...valueNames]);
  }

  for (const group of rowOrder) {
    const line: PivotCell[] = [...group.keys];
    if (colFields.length) {
      for (const key of columnOrder) {
        const bucket = group.columns.get(key.keys.join('\u0001'));
        for (const [index, value] of values.entries()) line.push(bucket ? aggregate(value.fn, bucket.cells[index]) : '');
      }
    } else {
      const bucket = group.columns.values().next().value as { cells: string[][] } | undefined;
      for (const [index, value] of values.entries()) line.push(bucket ? aggregate(value.fn, bucket.cells[index]) : '');
    }
    cells.push(line);
  }

  // A grand total row: the same aggregates over every row, which is what people look at first.
  const totals: PivotCell[] = ['Total'];
  while (totals.length < labelNames.length) totals.push('');
  const collect = (bucket: { cells: string[][] } | undefined, index: number): string[] => (bucket ? bucket.cells[index] : []);
  if (colFields.length) {
    for (const key of columnOrder) {
      for (const [index, value] of values.entries()) {
        const all: string[] = [];
        for (const group of rowOrder) all.push(...collect(group.columns.get(key.keys.join('\u0001')), index));
        totals.push(aggregate(value.fn, all));
      }
    }
  } else {
    for (const [index, value] of values.entries()) {
      const all: string[] = [];
      for (const group of rowOrder) for (const bucket of group.columns.values()) all.push(...collect(bucket, index));
      totals.push(aggregate(value.fn, all));
    }
  }
  cells.push(totals);

  const cols = Math.max(...cells.map((line) => line.length));
  for (const line of cells) while (line.length < cols) line.push('');
  return { cells, rows: cells.length, cols, labelCols: labelNames.length, titleRows: 1 };
}

/** The line above the header: what this table is, so a reader is never guessing. */
function pivotTitle(rowFields: readonly number[], colFields: readonly number[], valueNames: readonly string[]): string {
  const by = rowFields.length ? `rows ${rowFields.map((c) => colName(c)).join('+')}` : 'rows';
  const across = colFields.length ? `, columns ${colFields.map((c) => colName(c)).join('+')}` : '';
  return `Pivot: ${by}${across} · ${valueNames.join(', ')}`;
}

/**
 * A fingerprint of the cells a pivot was built from.
 *
 * It is what lets the panel say "the source changed, press Refresh" without recomputing anything by
 * itself: the pivot lands in the sheet as ORDINARY CELLS, so a silent rewrite on every keystroke
 * would overwrite whatever the owner typed inside the result and flood the undo history.
 */
export function sourceSignature(source: readonly (readonly string[])[], spec: PivotSpec): string {
  const rows = bodyRows(source, spec.header);
  const cols = [...new Set([...spec.rows, ...spec.cols, ...spec.values.map((value) => value.col)])].sort((a, b) => a - b);
  let hash = 2166136261;
  for (const row of rows) {
    for (const col of cols) {
      const text = (row[col] ?? '').trim();
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      hash ^= 0x1f; // a separator, so ["ab","c"] and ["a","bc"] never collide
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${rows.length}:${cols.join(',')}:${(hash >>> 0).toString(16)}`;
}

/**
 * Where a pivot is written: two rows below the source — and below everything else the sheet already
 * holds, because the owner's own numbers come first. Landing "below the selection" is not enough: a
 * selection of one cell would put the table on top of the next rows of real data (seen on a real
 * sheet during the browser proof, which is why `usedThrough` exists).
 */
export function pivotTarget(
  source: { r0: number; c0: number; r1: number },
  usedThrough = source.r1,
): { row: number; col: number } {
  return { row: Math.max(source.r1, usedThrough) + 2, col: source.c0 };
}

/** Where a pivot was written and what it was built from — enough to refresh it later. */
export interface PivotPlacement {
  /** The written table's top-left cell, in MODEL coordinates (never a drawn/hidden row). */
  anchor: { row: number; col: number };
  /** The source range, in model coordinates. */
  source: { r0: number; c0: number; r1: number; c1: number };
  spec: PivotSpec;
  /** The source's fingerprint when the table was written: what makes "needs refresh" knowable. */
  signature: string;
  /** How many rows and columns the written table occupies, so a refresh knows what it replaces. */
  size: { rows: number; cols: number };
}

/** True when a spec can produce a table at all (the panel disables Insert otherwise). */
export const pivotSpecUsable = (spec: PivotSpec): boolean =>
  spec.rows.length > 0 || spec.cols.length > 0 || spec.values.length > 0;
