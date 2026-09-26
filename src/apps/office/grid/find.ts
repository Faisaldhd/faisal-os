/**
 * Find and replace in a sheet (بحث واستبدال), and Remove duplicates — pure functions over rows.
 *
 * Find walks the sheet row by row (Excel's default order) from the cell after the active one and
 * wraps around. Replace works on what a cell HOLDS (a formula's text is not searched: replacing in
 * a result would be overwritten by the next recalculation).
 */

export interface FindOptions { matchCase?: boolean; wholeCell?: boolean }
export interface CellHit { row: number; col: number }

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matcher(query: string, opts: FindOptions): RegExp {
  const body = escape(query);
  return new RegExp(opts.wholeCell ? `^${body}$` : body, opts.matchCase ? 'g' : 'gi');
}

/** Whether a cell's text matches. */
export function cellMatches(text: string, query: string, opts: FindOptions = {}): boolean {
  if (!query) return false;
  return matcher(query, opts).test(text);
}

/** Every matching cell, in reading order. */
export function findAll(rows: readonly (readonly string[])[], query: string, opts: FindOptions = {}): CellHit[] {
  const out: CellHit[] = [];
  if (!query) return out;
  rows.forEach((row, r) => row.forEach((v, c) => { if (cellMatches(v ?? '', query, opts)) out.push({ row: r, col: c }); }));
  return out;
}

/** The next match after `from` (wrapping to the top), or null when nothing matches. */
export function findNext(rows: readonly (readonly string[])[], query: string, from: CellHit, opts: FindOptions = {}, backwards = false): CellHit | null {
  const hits = findAll(rows, query, opts);
  if (!hits.length) return null;
  const after = (h: CellHit): boolean => h.row > from.row || (h.row === from.row && h.col > from.col);
  const before = (h: CellHit): boolean => h.row < from.row || (h.row === from.row && h.col < from.col);
  if (backwards) return [...hits].reverse().find(before) ?? hits[hits.length - 1];
  return hits.find(after) ?? hits[0];
}

/** A cell's text with the query replaced (every occurrence, or the whole cell when asked). */
export function replaceInCell(text: string, query: string, replacement: string, opts: FindOptions = {}): string {
  if (!query) return text;
  return text.replace(matcher(query, opts), () => replacement);
}

/**
 * Remove duplicates: the rows of the block `r0..r1` whose values in `keys` repeat an earlier row
 * are dropped (the first one stays), the rest move up, and the freed rows at the bottom of the
 * block are emptied. `header` keeps the top row out of it. Columns outside `c0..c1` are untouched.
 */
export function removeDuplicates(
  rows: readonly (readonly string[])[],
  rect: { r0: number; r1: number; c0: number; c1: number },
  keys: readonly number[],
  header: boolean,
): { rows: string[][]; removed: number } {
  const out = rows.map((r) => [...r]);
  const start = rect.r0 + (header ? 1 : 0);
  const seen = new Set<string>();
  const kept: string[][] = [];
  for (let r = start; r <= rect.r1; r++) {
    const line = rows[r] ?? [];
    const sig = keys.map((k) => (line[k] ?? '').trim().toLowerCase()).join('\u0001');
    if (seen.has(sig)) continue;
    seen.add(sig);
    kept.push(Array.from({ length: rect.c1 - rect.c0 + 1 }, (_, i) => line[rect.c0 + i] ?? ''));
  }
  const removed = rect.r1 - start + 1 - kept.length;
  for (let r = start; r <= rect.r1; r++) {
    const src = kept[r - start];
    const target = out[r] ?? (out[r] = []);
    for (let c = rect.c0; c <= rect.c1; c++) target[c] = src ? src[c - rect.c0] : '';
  }
  return { rows: out, removed };
}
