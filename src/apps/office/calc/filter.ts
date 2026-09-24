/**
 * Office Calc — AutoFilter model (التصفية التلقائية). Pure, DOM-free.
 *
 *   distinctValues(rows, col, { header?, format? }) → [{ key, label, count }]
 *       the checklist a column's filter menu shows: sorted like a sort (numbers,
 *       text, booleans, errors, then "(Blanks)" with key ''), `label` optionally
 *       passed through a number format function.
 *   filterRows(rows, filters, { header? }) → boolean[]   which rows stay visible
 *   visibleRows(rows, filters, opts?)       → number[]    the visible row indices
 *   matchesCondition(cell, condition, stats?) → boolean
 *   columnStats(rows, col, header?) → { numbers, average } (for top-N / above-average)
 *
 * `filters` maps a column index to a condition:
 *   { kind: 'values', keys: string[] }                        checklist (keys from distinctValues)
 *   { kind: 'compare', op: '=' | '<>' | '>' | '>=' | '<' | '<=', value: string | number }
 *   { kind: 'between', min, max }
 *   { kind: 'text', op: 'contains' | 'notContains' | 'begins' | 'ends', value }   (case-insensitive, Arabic ok)
 *   { kind: 'top', count, bottom?, percent? }
 *   { kind: 'average', below? }
 *   { kind: 'blank', not? }
 *   { kind: 'and' | 'or', a, b }                               two conditions ("custom filter")
 * A row is visible when every column's condition passes. Header rows are always visible.
 */
import { formatGeneral, isError, scalarFromText, textToNumber, type Scalar } from '../formula/values';
import { compareCells, type CellInput } from './sort';

export type FilterCondition =
  | { kind: 'values'; keys: readonly string[] }
  | { kind: 'compare'; op: '=' | '<>' | '>' | '>=' | '<' | '<='; value: string | number }
  | { kind: 'between'; min: number; max: number }
  | { kind: 'text'; op: 'contains' | 'notContains' | 'begins' | 'ends'; value: string }
  | { kind: 'top'; count: number; bottom?: boolean; percent?: boolean }
  | { kind: 'average'; below?: boolean }
  | { kind: 'blank'; not?: boolean }
  | { kind: 'and' | 'or'; a: FilterCondition; b: FilterCondition };

export interface DistinctValue { key: string; label: string; count: number }

function typed(v: CellInput): Scalar {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : scalarFromText(v);
  return v;
}

/** The checklist key of a cell: its General text ('' for a blank). */
export function valueKey(v: CellInput): string {
  const s = typed(v);
  if (s === null) return '';
  if (isError(s)) return s.code;
  if (typeof s === 'number') return formatGeneral(s);
  if (typeof s === 'boolean') return s ? 'TRUE' : 'FALSE';
  return s;
}

export function distinctValues(
  rows: ReadonlyArray<ReadonlyArray<CellInput>>, col: number, opts: { header?: number; format?: (v: Scalar) => string } = {},
): DistinctValue[] {
  const seen = new Map<string, { v: Scalar; count: number }>();
  for (let r = opts.header ?? 0; r < rows.length; r++) {
    const v = typed(rows[r][col]);
    // Text differing only in case is one entry, as in Excel.
    const k = typeof v === 'string' ? v.toLowerCase() : valueKey(v);
    const e = seen.get(k);
    if (e) e.count++;
    else seen.set(k, { v, count: 1 });
  }
  const list = [...seen.values()].sort((a, b) => compareCells(a.v, b.v));
  return list.map(({ v, count }) => ({
    key: valueKey(v),
    label: v === null ? '' : opts.format ? opts.format(v) : valueKey(v),
    count,
  }));
}

export interface ColumnStats { numbers: number[]; average: number }

export function columnStats(rows: ReadonlyArray<ReadonlyArray<CellInput>>, col: number, header = 0): ColumnStats {
  const numbers: number[] = [];
  for (let r = header; r < rows.length; r++) {
    const v = typed(rows[r][col]);
    if (typeof v === 'number') numbers.push(v);
  }
  const average = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
  return { numbers, average };
}

function numberOf(v: Scalar): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return textToNumber(v);
  return null;
}

/** True when a cell passes a condition (`stats` is needed for 'top' and 'average'). */
export function matchesCondition(cell: CellInput, cond: FilterCondition, stats?: ColumnStats): boolean {
  const v = typed(cell);
  switch (cond.kind) {
    case 'values': {
      const key = valueKey(v);
      const lower = key.toLowerCase();
      return cond.keys.some((k) => k === key || k.toLowerCase() === lower);
    }
    case 'blank': return (v === null) !== !!cond.not;
    case 'between': {
      const n = typeof v === 'number' ? v : null;
      return n !== null && n >= Math.min(cond.min, cond.max) && n <= Math.max(cond.min, cond.max);
    }
    case 'compare': {
      const target = typeof cond.value === 'number' ? cond.value : numberOf(cond.value);
      if (target !== null && typeof v === 'number') {
        switch (cond.op) {
          case '=': return v === target;
          case '<>': return v !== target;
          case '>': return v > target;
          case '>=': return v >= target;
          case '<': return v < target;
          default: return v <= target;
        }
      }
      const a = valueKey(v).toLowerCase();
      const b = String(cond.value).toLowerCase();
      if (cond.op === '=') return a === b;
      if (cond.op === '<>') return a !== b;
      if (v === null || typeof v === 'number') return false;
      const c = compareCells(a, b);
      return cond.op === '>' ? c > 0 : cond.op === '>=' ? c >= 0 : cond.op === '<' ? c < 0 : c <= 0;
    }
    case 'text': {
      const a = valueKey(v).toLowerCase();
      const b = cond.value.toLowerCase();
      if (cond.op === 'contains') return a.includes(b);
      if (cond.op === 'notContains') return !a.includes(b);
      if (cond.op === 'begins') return a.startsWith(b);
      return a.endsWith(b);
    }
    case 'top': {
      if (typeof v !== 'number' || !stats || !stats.numbers.length) return false;
      const sorted = [...stats.numbers].sort((x, y) => (cond.bottom ? x - y : y - x));
      const n = cond.percent ? Math.max(1, Math.floor((sorted.length * cond.count) / 100)) : Math.max(0, Math.floor(cond.count));
      if (n === 0) return false;
      const edge = sorted[Math.min(n, sorted.length) - 1];
      return cond.bottom ? v <= edge : v >= edge;
    }
    case 'average': {
      if (typeof v !== 'number' || !stats || !stats.numbers.length) return false;
      return cond.below ? v < stats.average : v > stats.average;
    }
    case 'and': return matchesCondition(cell, cond.a, stats) && matchesCondition(cell, cond.b, stats);
    default: return matchesCondition(cell, cond.a, stats) || matchesCondition(cell, cond.b, stats);
  }
}

function needsStats(c: FilterCondition): boolean {
  if (c.kind === 'top' || c.kind === 'average') return true;
  if (c.kind === 'and' || c.kind === 'or') return needsStats(c.a) || needsStats(c.b);
  return false;
}

export function filterRows(
  rows: ReadonlyArray<ReadonlyArray<CellInput>>, filters: Readonly<Record<number, FilterCondition>>, opts: { header?: number } = {},
): boolean[] {
  const header = opts.header ?? 0;
  const entries = Object.entries(filters).map(([col, cond]) => {
    const c = Number(col);
    return { col: c, cond, stats: needsStats(cond) ? columnStats(rows, c, header) : undefined };
  });
  return rows.map((row, r) => r < header || entries.every(({ col, cond, stats }) => matchesCondition(row[col], cond, stats)));
}

export function visibleRows(
  rows: ReadonlyArray<ReadonlyArray<CellInput>>, filters: Readonly<Record<number, FilterCondition>>, opts: { header?: number } = {},
): number[] {
  const out: number[] = [];
  filterRows(rows, filters, opts).forEach((ok, i) => { if (ok) out.push(i); });
  return out;
}
