/**
 * Sheet — the owner's formatting layer (تنسيق الخلايا والأعمدة).
 *
 * The file's own look (`xlsxlook.ts`) is read once and never changed. What the
 * owner does in this session — a column dragged wider, a row made taller, a cell
 * made bold or given a fill, borders or a number format — lives here, per sheet,
 * as plain data inside the model, so undo/redo and the surgical save see it like
 * any other edit.
 *
 * A `CellFormat` is a *delta*: every property it names is the value the owner
 * chose (`false` and `null` included — "not bold", "no fill"), and a property it
 * does not name keeps whatever the file says. Saving writes a new `cellXfs` entry
 * built from the cell's own style with the delta applied (`xlsxstyle.ts`), so
 * the file's fonts, theme colours and everything else this app never modelled
 * survive.
 *
 * Pure: no DOM, no archive.
 */
import type { CellStyle } from './xlsxlook';
import type { Edit, OfficeModel, SheetsModel } from '../model';

export type HAlign = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'center' | 'bottom';
export interface BorderSides { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean }

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Font colour as RRGGBB; null = automatic. */
  color?: string | null;
  /** Solid fill as RRGGBB; null = no fill. */
  fill?: string | null;
  /** Thin black borders, per side; a side not named keeps the file's own. */
  borders?: BorderSides;
  hAlign?: HAlign | null;
  vAlign?: VAlign | null;
  wrap?: boolean;
  /** Excel number format code; null = General. */
  numFmt?: string | null;
}

export interface SheetFormat {
  /** Column widths in px, by zero-based column. */
  cols?: Record<number, number>;
  /** Row heights in px, by zero-based row. */
  rows?: Record<number, number>;
  /** Cell formats by "row:col". */
  cells?: Record<string, CellFormat>;
}

/** The formatting of one sheet, or undefined when the owner changed nothing there. */
export function sheetFormatOf(model: OfficeModel | null, sheet: number): SheetFormat | undefined {
  if (!model || (model.kind !== 'xlsx' && model.kind !== 'csv')) return undefined;
  return model.sheetFormats?.[sheet];
}

export function cellFormatOf(fmt: SheetFormat | undefined, row: number, col: number): CellFormat | undefined {
  return fmt?.cells?.[`${row}:${col}`];
}

const FORMAT_KEYS: ReadonlyArray<keyof CellFormat> = ['bold', 'italic', 'underline', 'color', 'fill', 'borders', 'hAlign', 'vAlign', 'wrap', 'numFmt'];

/** `patch` laid over `base`: named properties win, border sides merge. */
export function mergeCellFormat(base: CellFormat | undefined, patch: CellFormat): CellFormat {
  const out: CellFormat = { ...(base ?? {}) };
  for (const key of FORMAT_KEYS) {
    if (!(key in patch)) continue;
    if (key === 'borders') out.borders = { ...(out.borders ?? {}), ...(patch.borders ?? {}) };
    else (out as Record<string, unknown>)[key] = patch[key];
  }
  return out;
}

/** True when two formats say the same thing (deep, key order ignored). */
export function sameCellFormat(a: CellFormat | undefined, b: CellFormat | undefined): boolean {
  const norm = (f: CellFormat | undefined): string => {
    if (!f) return '';
    const parts: string[] = [];
    for (const key of FORMAT_KEYS) {
      if (!(key in f)) continue;
      const v = f[key];
      if (key === 'borders') {
        const b = (v ?? {}) as BorderSides;
        parts.push(`borders=${['top', 'bottom', 'left', 'right'].map((s) => String(b[s as keyof BorderSides])).join(',')}`);
      } else parts.push(`${key}=${String(v)}`);
    }
    return parts.join(';');
  };
  return norm(a) === norm(b);
}

function cleanSheet(fmt: SheetFormat): SheetFormat | undefined {
  const out: SheetFormat = {};
  if (fmt.cols && Object.keys(fmt.cols).length) out.cols = fmt.cols;
  if (fmt.rows && Object.keys(fmt.rows).length) out.rows = fmt.rows;
  if (fmt.cells && Object.keys(fmt.cells).length) out.cells = fmt.cells;
  return Object.keys(out).length ? out : undefined;
}

/** The sheet formatting with `patch` applied to every cell of a rectangle. */
export function formatRange(
  fmt: SheetFormat | undefined,
  range: { r0: number; c0: number; r1: number; c1: number },
  patch: CellFormat | ((row: number, col: number) => CellFormat),
): SheetFormat | undefined {
  const cells: Record<string, CellFormat> = { ...(fmt?.cells ?? {}) };
  for (let r = range.r0; r <= range.r1; r++) {
    for (let c = range.c0; c <= range.c1; c++) {
      const key = `${r}:${c}`;
      const p = typeof patch === 'function' ? patch(r, c) : patch;
      if (!Object.keys(p).length) continue;
      cells[key] = mergeCellFormat(cells[key], p);
    }
  }
  return cleanSheet({ ...(fmt ?? {}), cells });
}

/** Border presets for a rectangle: each cell gets the sides the preset draws on it. */
export type BorderPreset = 'all' | 'outer' | 'bottom' | 'top' | 'none';

export function borderPatch(
  preset: BorderPreset,
  range: { r0: number; c0: number; r1: number; c1: number },
): (row: number, col: number) => CellFormat {
  return (r, c) => {
    switch (preset) {
      case 'all': return { borders: { top: true, bottom: true, left: true, right: true } };
      case 'none': return { borders: { top: false, bottom: false, left: false, right: false } };
      case 'bottom': return r === range.r1 ? { borders: { bottom: true } } : {};
      case 'top': return r === range.r0 ? { borders: { top: true } } : {};
      default: {
        const sides: BorderSides = {};
        if (r === range.r0) sides.top = true;
        if (r === range.r1) sides.bottom = true;
        if (c === range.c0) sides.left = true;
        if (c === range.c1) sides.right = true;
        return Object.keys(sides).length ? { borders: sides } : {};
      }
    }
  };
}

/** The sheet formatting with one column's width set (null clears it back to the file's). */
export function withColumnWidth(fmt: SheetFormat | undefined, col: number, px: number | null): SheetFormat | undefined {
  const cols: Record<number, number> = { ...(fmt?.cols ?? {}) };
  if (px === null) delete cols[col];
  else cols[col] = Math.round(px);
  return cleanSheet({ ...(fmt ?? {}), cols });
}

export function withRowHeight(fmt: SheetFormat | undefined, row: number, px: number | null): SheetFormat | undefined {
  const rows: Record<number, number> = { ...(fmt?.rows ?? {}) };
  if (px === null) delete rows[row];
  else rows[row] = Math.round(px);
  return cleanSheet({ ...(fmt ?? {}), rows });
}

/** Rows or columns inserted (`delta` 1) or removed (-1) at `at`: the formatting moves with its cells. */
export function shiftSheetFormat(fmt: SheetFormat | undefined, axis: 'row' | 'col', at: number, delta: 1 | -1): SheetFormat | undefined {
  if (!fmt) return fmt;
  const moveLine = (line: number): number | null => {
    if (delta < 0 && line === at) return null;
    return line >= at ? line + delta : line;
  };
  const out: SheetFormat = {};
  const lines = axis === 'row' ? fmt.rows : fmt.cols;
  const other = axis === 'row' ? fmt.cols : fmt.rows;
  if (lines) {
    const next: Record<number, number> = {};
    for (const [k, v] of Object.entries(lines)) { const m = moveLine(Number(k)); if (m !== null) next[m] = v; }
    if (axis === 'row') out.rows = next; else out.cols = next;
  }
  if (other) { if (axis === 'row') out.cols = other; else out.rows = other; }
  if (fmt.cells) {
    const cells: Record<string, CellFormat> = {};
    for (const [key, f] of Object.entries(fmt.cells)) {
      const [r, c] = key.split(':').map(Number);
      const m = moveLine(axis === 'row' ? r : c);
      if (m === null) continue;
      cells[axis === 'row' ? `${m}:${c}` : `${r}:${m}`] = f;
    }
    out.cells = cells;
  }
  return cleanSheet(out);
}

/** The model with one sheet's formatting replaced. */
export function putSheetFormat(model: SheetsModel, sheet: number, fmt: SheetFormat | undefined): SheetsModel {
  const all: Record<number, SheetFormat> = { ...(model.sheetFormats ?? {}) };
  if (fmt) all[sheet] = fmt;
  else delete all[sheet];
  const out: SheetsModel = { ...model };
  if (Object.keys(all).length) out.sheetFormats = all;
  else delete out.sheetFormats;
  return out;
}

/** One reversible formatting step: the whole sheet's formatting before and after. */
export function sheetFormatEdit(sheet: number, before: SheetFormat | undefined, after: SheetFormat | undefined, key?: string): Edit {
  const put = (m: OfficeModel, fmt: SheetFormat | undefined): OfficeModel =>
    m.kind === 'xlsx' || m.kind === 'csv' ? putSheetFormat(m, sheet, fmt) : m;
  return { ...(key ? { key } : {}), apply: (m) => put(m, after), revert: (m) => put(m, before) };
}

/* ─────────────────────────── the drawn look ─────────────────────────── */

/** The CSS a drawn border side uses (thin, black: what the save writes). */
export const THIN_BORDER = '1px solid #000000';

/**
 * The style the grid draws: the file's style with the owner's delta on top.
 * Returns undefined when neither says anything.
 */
export function overlayStyle(base: CellStyle | undefined, f: CellFormat | undefined): CellStyle | undefined {
  if (!f) return base;
  const out: CellStyle = { ...(base ?? {}) };
  if (f.bold !== undefined) out.bold = f.bold;
  if (f.italic !== undefined) out.italic = f.italic;
  if (f.underline !== undefined) out.underline = f.underline;
  if (f.color !== undefined) { if (f.color) out.color = f.color; else delete out.color; }
  if (f.fill !== undefined) { if (f.fill) out.fill = f.fill; else delete out.fill; }
  if (f.hAlign !== undefined) { if (f.hAlign) out.hAlign = f.hAlign; else delete out.hAlign; }
  if (f.vAlign !== undefined) { if (f.vAlign) out.vAlign = f.vAlign; else delete out.vAlign; }
  if (f.wrap !== undefined) out.wrap = f.wrap;
  if (f.numFmt !== undefined) { if (f.numFmt) out.numFmt = f.numFmt; else delete out.numFmt; }
  if (f.borders) {
    const b = { ...(out.borders ?? {}) };
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const v = f.borders[side];
      if (v === true) b[side] = THIN_BORDER;
      else if (v === false) delete b[side];
    }
    if (b.top || b.bottom || b.left || b.right) out.borders = b;
    else delete out.borders;
  }
  return out;
}

/* ─────────────────────────── units ─────────────────────────── */

/** CSS px → Excel column width in characters (the inverse of `widthPx`). */
export function pxToChars(px: number): number {
  return Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
}

/** CSS px → points (row heights). */
export function pxToPt(px: number): number {
  return Math.round(px * 0.75 * 100) / 100;
}
