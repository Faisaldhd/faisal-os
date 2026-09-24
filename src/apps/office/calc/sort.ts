/**
 * Office Calc — multi-level sort (الفرز متعدد المستويات). Pure, DOM-free.
 *
 *   sortPermutation(rows, keys, { header?, locale? }) → number[]
 *       the new order of row indices (a stable sort); header rows keep their place.
 *   sortRows(rows, keys, opts?) → rows reordered (a new array; the rows themselves are not copied)
 *   compareCells(a, b, key?) → the comparison one key uses (for a custom UI sort)
 *
 * A key is { col, order?: 'asc' | 'desc', caseSensitive?: boolean }. Cells may be
 * the grid's strings ("12" sorts as a number) or engine scalars. Ascending order,
 * as in Excel: numbers < text < booleans < errors; text compares with an
 * Arabic+English collator (ignoring case unless asked). Blanks always go last,
 * in either direction.
 */
import { isError, scalarFromText, type Scalar } from '../formula/values';

export interface SortKey {
  col: number;
  order?: 'asc' | 'desc';
  caseSensitive?: boolean;
}

export interface SortOptions {
  /** Rows at the top that stay put (a header row). */
  header?: number;
  /** Collation locales (default Arabic then English). */
  locale?: string[];
}

export type CellInput = string | number | boolean | null | undefined | Scalar;

const collators = new Map<string, Intl.Collator>();

function collator(locale: string[], caseSensitive: boolean): Intl.Collator {
  const k = `${locale.join(',')}|${caseSensitive}`;
  let c = collators.get(k);
  if (!c) {
    c = new Intl.Collator(locale, { sensitivity: caseSensitive ? 'case' : 'base', numeric: false, caseFirst: 'upper' });
    collators.set(k, c);
  }
  return c;
}

function typed(v: CellInput): Scalar {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return scalarFromText(v.trim() === '' ? '' : v);
  return v;
}

function rank(v: Scalar): number {
  if (v === null || v === '') return 4;
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

/** Compares two cells for one key, blanks last whatever the direction. */
export function compareCells(a: CellInput, b: CellInput, key: Omit<SortKey, 'col'> = {}, locale = ['ar', 'en']): number {
  const x = typed(a);
  const y = typed(b);
  const rx = rank(x);
  const ry = rank(y);
  if (rx === 4 || ry === 4) return rx === ry ? 0 : rx === 4 ? 1 : -1;
  const dir = key.order === 'desc' ? -1 : 1;
  if (rx !== ry) return (rx - ry) * dir;
  let c = 0;
  if (typeof x === 'number') c = x - (y as number);
  else if (typeof x === 'string') c = collator(locale, !!key.caseSensitive).compare(x, y as string);
  else if (typeof x === 'boolean') c = Number(x) - Number(y);
  else if (isError(x) && isError(y)) c = x.code < y.code ? -1 : x.code > y.code ? 1 : 0;
  return Math.sign(c) * dir;
}

export function sortPermutation(rows: ReadonlyArray<ReadonlyArray<CellInput>>, keys: SortKey[], opts: SortOptions = {}): number[] {
  const header = Math.max(0, Math.min(opts.header ?? 0, rows.length));
  const locale = opts.locale ?? ['ar', 'en'];
  const head = Array.from({ length: header }, (_, i) => i);
  const body = Array.from({ length: rows.length - header }, (_, i) => i + header);
  // Pre-type the key columns once.
  const cache = keys.map((k) => rows.map((row) => typed(row[k.col])));
  body.sort((i, j) => {
    for (let n = 0; n < keys.length; n++) {
      const c = compareCells(cache[n][i], cache[n][j], keys[n], locale);
      if (c) return c;
    }
    return i - j; // stable
  });
  return [...head, ...body];
}

export function sortRows<T>(rows: readonly T[], keys: SortKey[], opts: SortOptions = {}): T[] {
  const perm = sortPermutation(rows as unknown as CellInput[][], keys, opts);
  return perm.map((i) => rows[i]);
}
