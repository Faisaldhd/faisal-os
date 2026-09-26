/**
 * Where a new chart goes and what it is called — pure.
 *
 * - The data: the selection, or — when one cell is selected — the block of data around it
 *   (Excel's "current region"), so "Insert → Chart" on a cell inside a table charts the table.
 * - The place: beside the data, at its inline-end (to the right in a left-to-right sheet, to the
 *   left in a right-to-left one), level with its top, never on top of it. Positions are sheet
 *   pixels from the corner of cell A1 — what the file's absolute anchor stores.
 * - The title: the header of the first value column, when the data has a header row.
 */

export interface Block { r0: number; c0: number; r1: number; c1: number }

const filled = (rows: readonly (readonly string[])[], r: number, c: number): boolean => (rows[r]?.[c] ?? '').trim() !== '';

/** The block of data around a cell: grows while any row or column touching its edge holds data. */
export function dataRegion(rows: readonly (readonly string[])[], row: number, col: number): Block {
  const b: Block = { r0: row, c0: col, r1: row, c1: col };
  const lineHas = (r0: number, r1: number, c0: number, c1: number): boolean => {
    for (let r = Math.max(0, r0); r <= r1; r++) for (let c = Math.max(0, c0); c <= c1; c++) if (filled(rows, r, c)) return true;
    return false;
  };
  for (let grew = true, guard = 0; grew && guard < 100_000; guard++) {
    grew = false;
    if (b.r0 > 0 && lineHas(b.r0 - 1, b.r0 - 1, b.c0 - 1, b.c1 + 1)) { b.r0--; grew = true; }
    if (lineHas(b.r1 + 1, b.r1 + 1, b.c0 - 1, b.c1 + 1) && b.r1 + 1 < rows.length) { b.r1++; grew = true; }
    if (b.c0 > 0 && lineHas(b.r0 - 1, b.r1 + 1, b.c0 - 1, b.c0 - 1)) { b.c0--; grew = true; }
    if (lineHas(b.r0 - 1, b.r1 + 1, b.c1 + 1, b.c1 + 1)) { b.c1++; grew = true; }
  }
  return b;
}

/** The data a chart is made from: the selection, or the region around a single cell. */
export function chartSource(rows: readonly (readonly string[])[], sel: Block): Block {
  if (sel.r0 !== sel.r1 || sel.c0 !== sel.c1) return sel;
  return dataRegion(rows, sel.r0, sel.c0);
}

/**
 * The chart's top-left corner in sheet pixels: `gap` past the data's last column, level with its
 * first row. `colStart(c)` is where column c begins, `rowTop(r)` where row r begins.
 */
export function chartPlacement(block: Block, colStart: (c: number) => number, rowTop: (r: number) => number, gap = 16): { x: number; y: number } {
  return { x: Math.round(colStart(block.c1 + 1) + gap), y: Math.round(rowTop(block.r0)) };
}

/** The chart's title: the header of its first value column, when the data starts with a header row. */
export function chartTitleFrom(rows: readonly (readonly string[])[], block: Block, fallback: string): string {
  const numeric = (v: string): boolean => /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(v.trim());
  const top = Array.from({ length: block.c1 - block.c0 + 1 }, (_, i) => (rows[block.r0]?.[block.c0 + i] ?? '').trim());
  // A header row: some column has text on top and numbers below it.
  const below = (i: number): string[] => Array.from({ length: block.r1 - block.r0 }, (_, k) => rows[block.r0 + 1 + k]?.[block.c0 + i] ?? '');
  const hasHeader = block.r1 > block.r0 && top.some((v, i) => v !== '' && !numeric(v) && below(i).some((x) => numeric(x)));
  if (!hasHeader) return fallback;
  // The first column is the labels when it holds text below the header; the values start after it.
  const firstIsLabels = block.c1 > block.c0 && Array.from({ length: block.r1 - block.r0 }, (_, i) => rows[block.r0 + 1 + i]?.[block.c0] ?? '').some((v) => v.trim() !== '' && !numeric(v));
  const valueHeaders = top.slice(firstIsLabels ? 1 : 0).filter((v) => v !== '');
  return valueHeaders[0] ?? top.find((v) => v !== '') ?? fallback;
}

/** A chart dragged by (dx, dy) screen pixels: in a right-to-left sheet the x axis runs the other way. */
export function draggedChart(start: { x: number; y: number }, dx: number, dy: number, rtl: boolean): { x: number; y: number } {
  return { x: Math.max(0, Math.round(start.x + (rtl ? -dx : dx))), y: Math.max(0, Math.round(start.y + dy)) };
}

/** A chart resized from its inline-end/bottom corner, never smaller than a readable minimum. */
export function resizedChart(start: { w: number; h: number }, dx: number, dy: number, rtl: boolean): { w: number; h: number } {
  return { w: Math.max(160, Math.round(start.w + (rtl ? -dx : dx))), h: Math.max(120, Math.round(start.h + dy)) };
}
