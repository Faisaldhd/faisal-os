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
import { collectRefs, parseFormula, translateFormula } from '../formula/parser';
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

/* ───────────────────────────── sorting a range ───────────────────────────── */

/** A block of the sheet, inclusive, in MODEL rows and columns. */
export interface SortRect { r0: number; r1: number; c0: number; c1: number }

export interface RangeSortOptions extends SortOptions {
  /** Rows at the bottom that stay put (a totals row such as `=SUM(A2:A6)`). */
  footer?: number;
}

/** One body row of the range: where it was, and where the sort put it. */
export interface RowMove { from: number; to: number }

/**
 * Sorts the rows of `rect` by `keys` (absolute column indices, inside the rect), moving ONLY the
 * cells inside the rect: the header rows at its top and the footer rows at its bottom stay where
 * they are, and every cell outside it is untouched. The result is a permutation of the body — no
 * value can be lost, duplicated or overwritten — returned as new rows plus the row moves, so the
 * caller can carry each cell's formula along with its value.
 */
export function sortRange(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  rect: SortRect,
  keys: SortKey[],
  opts: RangeSortOptions = {},
): { rows: string[][]; moves: RowMove[] } {
  const out = rows.map((row) => row as string[]);
  const height = rect.r1 - rect.r0 + 1;
  const header = Math.max(0, Math.min(opts.header ?? 0, height));
  const footer = Math.max(0, Math.min(opts.footer ?? 0, height - header));
  const first = rect.r0 + header;
  const count = height - header - footer;
  if (count < 2 || !keys.length) return { rows: out, moves: [] };
  const body = Array.from({ length: count }, (_, i) => rows[first + i] ?? []);
  const perm = sortPermutation(body, keys, { locale: opts.locale });
  const moves: RowMove[] = perm.map((src, k) => ({ from: first + src, to: first + k }));
  // Read every source cell BEFORE writing any target, so the write-back never reads a cell it has
  // already overwritten.
  const cells = moves.map((m) => {
    const line: string[] = [];
    for (let c = rect.c0; c <= rect.c1; c++) line.push(rows[m.from]?.[c] ?? '');
    return line;
  });
  moves.forEach((m, k) => {
    if (m.from === m.to) return;
    while (out.length <= m.to) out.push([]);
    const target = [...(out[m.to] ?? [])];
    cells[k].forEach((value, i) => {
      const c = rect.c0 + i;
      if (value === '' && c >= target.length) return; // never pad a row just to hold a blank
      while (target.length <= c) target.push('');
      target[c] = value;
    });
    out[m.to] = target;
  });
  return { rows: out, moves };
}

/**
 * The formulas of a workbook after `sortRange` on `sheet`: a formula inside the rect travels with
 * its cell, and its relative references follow it as when a formula is copied (`=A2*2` moved to
 * row 5 reads `=A5*2`). Formulas outside the rect, and on other sheets, are kept exactly.
 */
export function sortFormulas(
  formulas: Readonly<Record<string, string>> | undefined,
  sheet: number,
  rect: SortRect,
  moves: readonly RowMove[],
): Record<string, string> | undefined {
  if (!formulas) return undefined;
  const to = new Map(moves.map((m) => [m.from, m.to]));
  const out: Record<string, string> = {};
  const moved: Array<[string, string]> = [];
  for (const [key, formula] of Object.entries(formulas)) {
    const [s, r, c] = key.split(':').map(Number);
    const dest = s === sheet && c >= rect.c0 && c <= rect.c1 ? to.get(r) : undefined;
    if (dest === undefined) { out[key] = formula; continue; }
    moved.push([`${s}:${dest}:${c}`, dest === r ? formula : translateFormula(formula, dest - r, 0)]);
  }
  // Every destination is itself a moved cell, so these never collide with a kept formula.
  for (const [key, formula] of moved) out[key] = formula;
  return Object.keys(out).length ? out : undefined;
}

/**
 * How many rows at the bottom of the rect are totals rows: a row with a formula (inside the rect)
 * that reads a RANGE of the data rows above it, such as `=SUM(A2:A6)`. Such a row stays put: sorted
 * in with the data, its cached result would be taken for a value and the rows it sums would move
 * away from it. `formulaOf(row, col)` gives a cell's formula text (with `=`), or undefined.
 */
export function totalsRows(rect: SortRect, header: number, formulaOf: (row: number, col: number) => string | undefined): number {
  const top = rect.r0 + header;
  let n = 0;
  for (let r = rect.r1; r > top; r--) {
    let total = false;
    for (let c = rect.c0; c <= rect.c1 && !total; c++) {
      const text = formulaOf(r, c);
      const parsed = text ? parseFormula(text) : null;
      if (!parsed?.ok) continue;
      total = collectRefs(parsed.ast).some((ref) => !ref.sheet && ref.r2 > ref.r1 && ref.r1 < r && ref.r2 >= top);
    }
    if (!total) break;
    n++;
  }
  return n;
}
