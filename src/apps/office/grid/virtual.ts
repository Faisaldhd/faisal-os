/**
 * Sheet — the virtual grid's maths (حساب الشبكة الافتراضية).
 *
 * The grid used to draw every row it knew about, so the reader had to stop at
 * 2000 rows or the browser would crawl. Everything here is what the view needs to
 * draw only the rows on screen instead: the row offsets, which rows a scroll
 * position shows, how many row elements can be recycled between two windows, the
 * width of a column fitted to its content, and which column border a pointer at
 * some x has grabbed.
 *
 * Nothing here touches the DOM, so all of it is testable with plain numbers. The
 * view measures text through `measureText` and passes the result in.
 */

/* ────────────────────────────────── rows ────────────────────────────────── */

/** Row height when the file states none (matches `.fo-td`'s own height). */
export const DEFAULT_ROW_HEIGHT = 24;
/** Row height on a phone, where a row is also a touch target (matches the CSS breakpoint). */
export const TOUCH_ROW_HEIGHT = 44;
/** Extra rows drawn past each edge, so a fast flick never shows a blank strip. */
export const OVERSCAN_ROWS = 6;
/** Rows drawn even in a viewport that measures zero (a hidden window, a first paint). */
export const MIN_WINDOW_ROWS = 8;

/**
 * Cumulative tops: `offsets[i]` is row `i`'s top and `offsets[count]` the whole
 * sheet's height. Built once per sheet (10 000 rows is ~80 KB and under a
 * millisecond), then every scroll ask is a binary search.
 */
export function rowOffsets(count: number, heightOf: (row: number) => number): Float64Array {
  const rows = Math.max(0, Math.floor(count));
  const offsets = new Float64Array(rows + 1);
  let y = 0;
  for (let r = 0; r < rows; r++) {
    offsets[r] = y;
    const h = heightOf(r);
    y += Number.isFinite(h) && h > 0 ? h : DEFAULT_ROW_HEIGHT;
  }
  offsets[rows] = y;
  return offsets;
}

/** The last row whose top is at or above `y` — the row under a scroll offset. */
export function rowAt(offsets: Float64Array, y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  if (!(y > 0)) return 0; // also catches NaN
  if (y >= offsets[count]) return count - 1;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The rows a scroll position shows, with the spacers that stand in for the rest. */
export interface RowWindow {
  /** First drawn row, inclusive. */
  first: number;
  /** Last drawn row, exclusive. */
  last: number;
  /** Height of the blank strip above the drawn rows. */
  padTop: number;
  /** Height of the blank strip below them. */
  padBottom: number;
  /** Height of every row — the sheet's scrollable length. */
  total: number;
}

/**
 * Which rows to draw for a viewport. `scrollTop` is clamped to the real scroll
 * range first, so a browser that overscrolls (iOS rubber-banding) cannot ask for
 * a window past the end.
 */
export function rowWindow(
  offsets: Float64Array,
  scrollTop: number,
  viewport: number,
  overscan = OVERSCAN_ROWS,
): RowWindow {
  const count = offsets.length - 1;
  const total = count > 0 ? offsets[count] : 0;
  if (count <= 0) return { first: 0, last: 0, padTop: 0, padBottom: 0, total: 0 };
  const height = Number.isFinite(viewport) && viewport > 0 ? viewport : 0;
  const maxScroll = Math.max(0, total - height);
  const top = Math.min(Math.max(Number.isFinite(scrollTop) ? scrollTop : 0, 0), maxScroll);
  const pad = Math.max(0, Math.floor(overscan));
  const first = Math.max(0, rowAt(offsets, top) - pad);
  const bottom = top + height;
  // The row under the last visible pixel, plus the overscan tail.
  const under = height > 0 ? rowAt(offsets, bottom - 1) : first;
  const wanted = height > 0 ? Math.max(under + 1, first + MIN_WINDOW_ROWS) : first + MIN_WINDOW_ROWS;
  const last = Math.min(count, wanted + pad);
  return { first, last, padTop: offsets[first], padBottom: total - offsets[last], total };
}

/** How a new window reuses the row elements the previous one left behind. */
export interface RecyclePlan {
  /** Rows present in both windows: their elements and cells are kept. */
  reuse: number;
  /** Row elements to build (a window that grew, or the first paint). */
  create: number;
  /** Row elements to drop back into the pool. */
  drop: number;
  /** The new window starts after the old one: rows may be shifted instead of refilled. */
  forward: boolean;
}

/**
 * The element budget between two windows. Rows that stay keep their element (and
 * the browser keeps its layout), which is what makes a wheel or a flick cheap.
 */
export function recyclePlan(
  prevFirst: number,
  prevLast: number,
  nextFirst: number,
  nextLast: number,
): RecyclePlan {
  const prev = Math.max(0, prevLast - prevFirst);
  const next = Math.max(0, nextLast - nextFirst);
  const overlap = Math.max(0, Math.min(prevLast, nextLast) - Math.max(prevFirst, nextFirst));
  return { reuse: overlap, create: next - overlap, drop: prev - overlap, forward: nextFirst >= prevFirst };
}

/* ───────────────────────────────── columns ───────────────────────────────── */

/** Narrowest a column may be dragged: still shows the row of the active cell. */
export const MIN_COL_WIDTH = 28;
/** Widest a column may be dragged or fitted. */
export const MAX_COL_WIDTH = 720;
/** Width of a column the file says nothing about and that has no content to fit. */
export const DEFAULT_COL_WIDTH = 88;
/** Cell padding (2 × 4px) plus the 1px column border, added to a fitted width. */
export const COL_PADDING = 10;
/** How many rows auto-fit reads: the whole sheet would be 400 000 measurements. */
export const AUTOFIT_SAMPLE_ROWS = 400;
/** Pointer distance from a border that still counts as grabbing it (mouse). */
export const HIT_SLOP_MOUSE = 5;
/** …and on a touch screen, where the grab band is a full 44px wide. */
export const HIT_SLOP_TOUCH = 22;

/** Column widths the owner set, by zero-based column. Kept small: only set columns appear. */
export type ColumnWidths = Readonly<Record<number, number>>;

export function clampColWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_COL_WIDTH;
  return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(px)));
}

/** A column's width: the owner's, else the file's, else the default. */
export function columnWidth(widths: ColumnWidths | undefined, col: number, fallback = DEFAULT_COL_WIDTH): number {
  const own = widths?.[col];
  return typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : fallback;
}

/**
 * The width model with one column set. Setting a column back to its fallback
 * removes the entry, so a sheet the owner never resized keeps an empty record and
 * the save writes no `<cols>` at all.
 */
export function setColumnWidth(
  widths: ColumnWidths | undefined,
  col: number,
  px: number,
  fallback = DEFAULT_COL_WIDTH,
): ColumnWidths | undefined {
  const width = clampColWidth(px);
  const next: Record<number, number> = { ...(widths ?? {}) };
  if (width === clampColWidth(fallback)) delete next[col];
  else next[col] = width;
  if (!Object.keys(next).length) return undefined;
  for (const key of Object.keys(next)) if (!Number.isFinite(next[Number(key)])) delete next[Number(key)];
  return next;
}

/**
 * Widths after columns are inserted at `at` (`delta` > 0) or removed from it
 * (`delta` < 0): the widths of the columns after them move with their columns, so
 * a column the owner widened stays widened when a column appears before it. The
 * width of a removed column goes with it.
 */
export function shiftColumnWidths(
  widths: ColumnWidths | undefined,
  at: number,
  delta: number,
): ColumnWidths | undefined {
  if (!widths || !delta) return widths;
  const next: Record<number, number> = {};
  for (const [key, width] of Object.entries(widths)) {
    const col = Number(key);
    if (delta < 0 && col >= at && col < at - delta) continue; // the removed column's own width
    const moved = col >= at ? col + delta : col;
    if (moved >= 0) next[moved] = width;
  }
  return Object.keys(next).length ? next : undefined;
}

/* ───────────────────────────────── auto-fit ───────────────────────────────── */

/** How wide a run of text is, in px, for a given font size. */
export type MeasureText = (text: string, fontSize: number) => number;

/** The cell font: 11pt Calibri, exactly what `.fo-grid` asks the browser for. */
export const CELL_FONT_SIZE = 14.67;

/**
 * A width estimate for when the browser cannot measure (jsdom in tests, a canvas
 * the platform refuses). Calibri-ish advance widths per character class — good
 * enough to fit a column, and deterministic.
 */
export function estimateTextWidth(text: string, fontSize = CELL_FONT_SIZE): number {
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9) { em += 2; continue; }
    if (code < 32) continue;
    if (code < 128) {
      if ('iljtfrI.,;:!\'|[]() '.includes(ch)) em += 0.30;
      else if ('mwMW@'.includes(ch)) em += 0.92;
      else if (ch >= 'A' && ch <= 'Z') em += 0.63;
      else if (ch >= '0' && ch <= '9') em += 0.55;
      else em += 0.52;
      continue;
    }
    // Arabic, Hebrew and the other cursive scripts sit close to half an em.
    if ((code >= 0x0590 && code <= 0x08ff) || (code >= 0xfb1d && code <= 0xfeff)) em += 0.50;
    // CJK, Hangul and full-width forms are a full em.
    else if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff01 && code <= 0xff60) || (code >= 0x20000 && code <= 0x3ffff)) em += 1;
    else em += 0.6;
  }
  return em * fontSize;
}

/** The widest of some texts, plus cell padding, clamped to the legal range. */
export function autoFitWidth(
  texts: Iterable<string>,
  measure: MeasureText,
  fontSize = CELL_FONT_SIZE,
): number {
  let widest = 0;
  for (const text of texts) {
    if (!text) continue;
    const w = measure(text, fontSize);
    if (Number.isFinite(w) && w > widest) widest = w;
  }
  return clampColWidth(widest + COL_PADDING);
}

/**
 * Auto-fit for a set of columns. Only the first `AUTOFIT_SAMPLE_ROWS` rows are
 * read: a 10 000-row sheet would otherwise cost 400 000 text measurements before
 * the first paint, and a column's widest cell is nearly always near the top
 * (headers, labels) — Excel's own "fit to contents" reads further but this is the
 * price of opening instantly.
 */
export function autoFitColumns(
  rows: readonly (readonly string[])[],
  cols: readonly number[],
  measure: MeasureText,
  sampleRows = AUTOFIT_SAMPLE_ROWS,
): Map<number, number> {
  const out = new Map<number, number>();
  if (!cols.length) return out;
  const limit = Math.min(rows.length, Math.max(0, sampleRows));
  const widest = new Map<number, number>();
  for (let r = 0; r < limit; r++) {
    const row = rows[r];
    if (!row) continue;
    for (const c of cols) {
      const text = row[c];
      if (!text) continue;
      const w = measure(text, CELL_FONT_SIZE);
      if (Number.isFinite(w) && w > (widest.get(c) ?? 0)) widest.set(c, w);
    }
  }
  for (const c of cols) out.set(c, clampColWidth((widest.get(c) ?? 0) + COL_PADDING));
  return out;
}

/* ─────────────────────────────── border dragging ─────────────────────────────── */

/** The grab band around a column border: 44px wide on touch, 10px with a mouse. */
export function hitSlop(coarse: boolean): number {
  return coarse ? HIT_SLOP_TOUCH : HIT_SLOP_MOUSE;
}

/** A laid-out column header, as `getBoundingClientRect` reports it (visual, so RTL-safe). */
export interface EdgeRect { left: number; right: number }

/**
 * Which column a pointer at `x` resizes: the one whose trailing border is nearest
 * and within `slop`. `rects` must be in column order (`rects[0]` is column A) and
 * in visual coordinates, so a right-to-left sheet needs no special case for the
 * positions — only `rtl`, which says whether a column's trailing border is its
 * left or its right edge. Each internal border belongs to exactly one column, so
 * the two columns it separates never fight over the same pointer.
 *
 * The table's own outer edges are not borders: there is no column before A to
 * resize, and the far edge belongs to the last column like every other trailing
 * edge.
 */
export function borderGrab(rects: readonly EdgeRect[], x: number, slop: number, rtl = false): number | null {
  if (!(slop > 0)) return null;
  let best: number | null = null;
  let nearest = slop;
  for (let c = 0; c < rects.length; c++) {
    const rect = rects[c];
    if (!rect) continue;
    const distance = Math.abs(x - (rtl ? rect.left : rect.right));
    if (distance <= nearest) { nearest = distance; best = c; }
  }
  return best;
}

/** The width a column ends up with after a drag: the start plus the pointer's travel. */
export function draggedWidth(startWidth: number, startX: number, x: number): number {
  return clampColWidth(startWidth + (x - startX));
}

/**
 * A double-click's two hits, or two taps, that mean "fit this column": close in
 * time and in place, so a slow second click elsewhere is not read as one.
 */
export function isDoubleAct(firstAt: number, firstX: number, at: number, x: number): boolean {
  const DOUBLE_MS = 400;
  const DOUBLE_PX = 8;
  return at - firstAt <= DOUBLE_MS && Math.abs(x - firstX) <= DOUBLE_PX;
}
