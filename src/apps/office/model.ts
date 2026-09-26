/**
 * Office — the pure part (المنطق الخالص): which formats this app really handles,
 * the editable model of a file, the edit operations, and undo/redo.
 *
 * No DOM and no VFS here: everything is plain data, so it is testable on its own
 * and the window in `index.ts` only renders it.
 *
 * The supported-format table below is the single source of truth for the app's
 * honest format list: the UI prints it and the tests assert it against what the
 * readers in `src/apps/viewer/formats.ts` actually do.
 */
import { t } from '../../kernel/i18n';
import './grid/strings';
import type { Deck } from './impress/deck';
import { MAX_COLS, extensionOf } from '../viewer/formats';
import type { DocBlock } from './writer/types';
import type { RevisionLog } from './writer/revisions';
import type { PivotPlacement } from './grid/pivot';
import { diffText, replaceText } from './writer/docops';
import { shiftSheetFormat, type SheetFormat } from './grid/sheetfmt';
import type { AutoFilterColumn } from './grid/autofilter';
import type { CondRule } from './calc/index';
import type { ChartObject } from './grid/sheetview';
import { shiftFormula } from './formula/index';
import type { StructOp } from './grid/structure';

/**
 * How many rows one sheet holds in this app (سعة الورقة).
 *
 * The reader's own default is far smaller (2000 rows) because the Files app previews a workbook
 * inline; the sheet editor draws only the rows on screen, so it can afford a real spreadsheet's
 * worth of rows and asks the reader for them at its own call site. The columns stay the reader's
 * `MAX_COLS`: a hundred columns of a virtualised row is already a wide sheet.
 */
export const SHEET_ROWS = 10_000;

/** The four shapes a file can have once read, plus plain text. */
export type OfficeKind = 'docx' | 'xlsx' | 'pptx' | 'csv' | 'text';

/** One worksheet (or the single grid of a CSV/TSV file, kept as plain text cells). */
export interface Grid {
  name: string;
  rows: string[][];
  /** The reader stopped at its row/column limit: rows beyond it were never read. */
  truncated: boolean;
}

/** Paragraph alignment written into Word's `<w:jc>` (المحاذاة). */
export type ParagraphAlign = 'left' | 'center' | 'right' | 'justify';

/**
 * The formatting this app can write into a Word paragraph: bold, italic,
 * underline, font size (points) and alignment, written as `<w:rPr>` and
 * `<w:pPr><w:jc>`.
 *
 * `undefined` means "the owner never touched this property" — the file's own
 * value stands and is not rewritten. `null` means "remove it", which is how a
 * property goes back to whatever the file or its styles say.
 */
export interface ParagraphFormat {
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  /** Font size in points; Word stores half-points. */
  size?: number | null;
  align?: ParagraphAlign | null;
  /** Paragraph direction, written as `<w:bidi/>` (the Writer's RTL/LTR buttons). */
  dir?: 'rtl' | 'ltr' | null;
  /** The paragraph style id (`<w:pStyle>`): Heading1, Title, Quote… */
  style?: string | null;
  /** A bulleted or numbered list (`<w:numPr>`); null takes a style's list away. */
  list?: 'bullet' | 'number' | null;
  /** Line spacing as a multiple of a single line (1, 1.15, 1.5, 2). */
  line?: number | null;
}

/** The properties a format can carry, in one place for diffing and copying. */
export const FORMAT_KEYS = ['bold', 'italic', 'underline', 'size', 'align', 'dir', 'style', 'list', 'line'] as const;

/**
 * True when two formats say the same thing. `undefined` (leave the file's own
 * value) and `null` (remove it) compare equal only when a save has already run:
 * `null` and "the property is absent from the file" describe the same finished
 * state, while a real value on either side is a difference the save must write.
 */
export function sameFormat(a: ParagraphFormat | undefined, b: ParagraphFormat | undefined): boolean {
  const value = (format: ParagraphFormat | undefined, key: typeof FORMAT_KEYS[number]): unknown => {
    const raw = format === undefined ? undefined : format[key];
    return raw === null ? undefined : raw;
  };
  return FORMAT_KEYS.every((key) => value(a, key) === value(b, key));
}

export interface DocModel {
  kind: 'docx';
  paragraphs: string[];
  formats?: Record<number, ParagraphFormat>;
  /**
   * The rich paragraphs (runs with their own formatting, stable ids), parallel to
   * `paragraphs` when the Writer opened the file. Absent in the plain model the
   * older save path and its tests use.
   */
  blocks?: DocBlock[];
  /**
   * Tracked changes the FILE carries (`w:ins`/`w:del`), read when it was opened. The Writer shows
   * them as pending marks and writes them back on save, so a change made elsewhere is never
   * presented as text that is already decided.
   */
  tracked?: RevisionLog;
}
export interface SheetsModel {
  kind: 'xlsx' | 'csv';
  grids: Grid[];
  active: number;
  delimiter: ',' | '\t';
  /**
   * The formulas the owner typed in this session, keyed "sheet:row:col". The cell
   * itself always holds the computed value; the file keeps the formula in `<f>`.
   */
  formulas?: Record<string, string>;
  /**
   * How many row/column insertions or deletions the model holds relative to the
   * file (they move cells, so the save must rebuild). Typing past the last row or
   * column only grows the sheet and does not count. Absent when zero.
   */
  moved?: number;
  /**
   * The owner's formatting per sheet (column widths, row heights, cell formats) —
   * a delta over the file's own look, written by the save (`grid/sheetfmt.ts`).
   */
  sheetFormats?: Record<number, SheetFormat>;
  /**
   * The row/column insertions and deletions behind `moved`, in order, so the save
   * can move the file's own cells instead of rebuilding it (`grid/structure.ts`).
   */
  structure?: StructOp[];
  /**
   * The pivots inserted in this session, per sheet: where each table was written and what it was
   * built from. The TABLE itself is ordinary cells (so it saves like every other cell); this is
   * only what lets the panel offer Refresh and say when the source has moved on.
   */
  pivots?: Record<number, readonly PivotPlacement[]>;
  /**
   * The AutoFilter the owner set, per sheet, as the file spells it (`grid/autofilter.ts`): the
   * save writes it as `<autoFilter>` after `</sheetData>`, and the reader fills it back at open.
   * Only the checklist (values) kind is written; a condition this app cannot spell exactly is
   * left out rather than written as something it is not.
   */
  autoFilters?: Record<number, readonly AutoFilterColumn[]>;
  /**
   * The conditional-formatting rules the owner set, per sheet: the save writes them as
   * `<conditionalFormatting>` with their `<dxfs>` styles, and the reader fills them back at open
   * (`grid/condfmt-xml.ts`). A rule the file cannot carry exactly is left out of the file.
   */
  condRules?: Record<number, readonly CondRule[]>;
  /**
   * The floating charts the owner added, per sheet: the save writes each one as a drawing anchor
   * plus a `c:chartSpace` part, and the reader puts them back at open (`grid/chart-xml.ts`).
   */
  charts?: Record<number, readonly ChartObject[]>;
}
export interface DeckModel {
  kind: 'pptx';
  slides: string[][];
  /**
   * The rich slides (shapes at their real positions, pictures, notes, order), when
   * the file is a complete presentation. `slides` is then derived from it.
   */
  deck?: Deck;
}
export interface TextModel { kind: 'text'; text: string }

export type OfficeModel = DocModel | SheetsModel | DeckModel | TextModel;

/* ───────────────────────────── formats ───────────────────────────── */

/** Why a file is refused. `.doc/.xls/.ppt` are legacy binary; anything else is unknown. */
export type Refusal = 'legacy' | 'unknown';

export interface FormatPlan {
  ext: string;
  /** null when the app has no reader for it (`refusal` then says why). */
  kind: OfficeKind | null;
  refusal: Refusal | null;
  /** `.xlsm` is rendered but never saved: rewriting it as OOXML would drop its macros. */
  readOnly: 'macros' | null;
  delimiter: ',' | '\t';
  /** The file is OpenDocument (`writer/odtread.ts` reads it, `writer/odt.ts` writes it back). */
  odf?: boolean;
}

/** Editing is offered; read-only is rendered but Save/Add/Remove stay hidden. */
export type SupportLevel = 'edit' | 'read-only' | 'unsupported';

export interface FormatRow { ext: string; level: SupportLevel; note: string }

/**
 * Every extension this app knows, and what it really does with it.
 * `note` is a short English reason used by tests and diagnostics — the UI shows a
 * translated sentence built from `level` and the extension instead.
 */
export const VERIFIED_FORMATS: readonly FormatRow[] = [
  { ext: '.docx', level: 'edit', note: 'readDocx paragraphs; saved by patching word/document.xml only' },
  { ext: '.odt', level: 'edit', note: 'readOdt paragraphs/runs/lists/tables; saved as a fresh OpenDocument package' },
  { ext: '.xlsx', level: 'edit', note: 'readXlsx cells; saved by patching the affected worksheet and shared strings' },
  { ext: '.xlsm', level: 'read-only', note: 'readXlsx works, but saving would drop the macros' },
  { ext: '.pptx', level: 'edit', note: 'readPptx slide text; saved by patching the affected slide parts' },
  { ext: '.csv', level: 'edit', note: 'parseCsv with a comma; written back as CSV' },
  { ext: '.tsv', level: 'edit', note: 'parseCsv with a tab; written back as TSV' },
  { ext: '.txt', level: 'edit', note: 'plain UTF-8 text (binary files are refused)' },
  { ext: '.md', level: 'edit', note: 'shown and edited as raw text; no Markdown preview' },
  { ext: '.doc', level: 'unsupported', note: 'legacy binary Word format; no reader' },
  { ext: '.xls', level: 'unsupported', note: 'legacy binary Excel format; no reader' },
  { ext: '.ppt', level: 'unsupported', note: 'legacy binary PowerPoint format; no reader' },
];

/** The extensions the manifest offers, in the order the Store description lists them. */
export const OFFICE_EXTENSIONS: readonly string[] = [
  '.docx', '.odt', '.xlsx', '.xlsm', '.pptx', '.csv', '.tsv', '.txt', '.md',
];

const LEGACY: Record<string, Refusal> = { '.doc': 'legacy', '.xls': 'legacy', '.ppt': 'legacy' };

/** What the app will do with a path, decided by its extension alone. */
export function planFor(path: string): FormatPlan {
  const ext = extensionOf(path);
  const base: FormatPlan = { ext, kind: null, refusal: null, readOnly: null, delimiter: ',' };
  switch (ext) {
    case '.docx': return { ...base, kind: 'docx' };
    // An OpenDocument text file is the Writer's own document in another package: same model, and
    // the save writes ODF back (see `odf` above) instead of OOXML into a `.odt` path.
    case '.odt': return { ...base, kind: 'docx', odf: true };
    case '.xlsx': return { ...base, kind: 'xlsx' };
    case '.xlsm': return { ...base, kind: 'xlsx', readOnly: 'macros' };
    case '.pptx': return { ...base, kind: 'pptx' };
    case '.csv': return { ...base, kind: 'csv' };
    case '.tsv': return { ...base, kind: 'csv', delimiter: '\t' };
    case '.txt':
    case '.md': return { ...base, kind: 'text' };
    default: return { ...base, refusal: LEGACY[ext] ?? 'unknown' };
  }
}

/** A model for an empty file of this plan's kind: one empty paragraph/sheet/slide. */
export function emptyModel(plan: FormatPlan, name = 'Sheet1'): OfficeModel {
  switch (plan.kind) {
    case 'docx': return { kind: 'docx', paragraphs: [''] };
    // A new workbook's sheet is named in the UI's language: "ورقة1" or "Sheet1".
    case 'xlsx': return { kind: 'xlsx', grids: [{ name: t('office.defaultSheetName', { n: 1 }), rows: [['']], truncated: false }], active: 0, delimiter: ',' };
    case 'csv': return { kind: 'csv', grids: [{ name, rows: [['']], truncated: false }], active: 0, delimiter: plan.delimiter };
    case 'pptx': return { kind: 'pptx', slides: [['']] };
    default: return { kind: 'text', text: '' };
  }
}

/* ─────────────────────────── edit operations ─────────────────────────── */

/**
 * One reversible step. `apply`/`revert` are pure: they return a new model and
 * never touch the one they are given, which is what makes undo safe after any
 * number of later edits.
 *
 * `key` marks edits that target the same place: typing in one cell pushes an edit
 * per keystroke, and the History merges those into a single undo step instead of
 * making the user press Ctrl+Z once per character.
 */
export interface Edit {
  key?: string;
  apply(model: OfficeModel): OfficeModel;
  revert(model: OfficeModel): OfficeModel;
}

/** The grid at `sheet`, or null when the model has no such sheet. */
export function gridAt(model: OfficeModel, sheet: number): Grid | null {
  if (model.kind !== 'xlsx' && model.kind !== 'csv') return null;
  return model.grids[sheet] ?? null;
}

function replaceGrid(model: SheetsModel, sheet: number, grid: Grid): SheetsModel {
  return { ...model, grids: model.grids.map((g, i) => (i === sheet ? grid : g)) };
}

/** Writes a cell value, growing the row and the grid when the address is past the end. */
export function setCellValue(model: SheetsModel, sheet: number, row: number, col: number, value: string): SheetsModel {
  const grid = model.grids[sheet];
  if (!grid) return model;
  const rows = grid.rows.slice();
  while (rows.length <= row) rows.push([]);
  const line = rows[row].slice();
  while (line.length <= col) line.push('');
  line[col] = value;
  rows[row] = line;
  return replaceGrid(model, sheet, { ...grid, rows });
}

/** Inserts an empty row at `at` (used by the sheet's "add row" action). */
export function insertRow(model: SheetsModel, sheet: number, at: number): SheetsModel {
  const grid = model.grids[sheet];
  if (!grid) return model;
  const rows = grid.rows.slice();
  const index = Math.max(0, Math.min(at, rows.length));
  const width = gridWidth(grid);
  rows.splice(index, 0, new Array<string>(width).fill(''));
  return shiftFormulas(replaceGrid(model, sheet, { ...grid, rows }), sheet, 'row', index, 1);
}

/**
 * Removes the row at `at`. Removing the last row leaves an empty sheet, which is
 * valid; the window disables the button instead (`canDeleteRow`), so a user cannot
 * empty a sheet by accident while undo stays an exact inverse of the edit.
 */
export function removeRow(model: SheetsModel, sheet: number, at: number): SheetsModel {
  const grid = model.grids[sheet];
  if (!grid || at < 0 || at >= grid.rows.length) return model;
  const rows = grid.rows.slice();
  rows.splice(at, 1);
  return shiftFormulas(replaceGrid(model, sheet, { ...grid, rows }), sheet, 'row', at, -1);
}

/** A sheet keeps its last row: the window greys out "delete row" instead of emptying the grid. */
export function canDeleteRow(model: OfficeModel, sheet: number): boolean {
  const grid = gridAt(model, sheet);
  return !!grid && grid.rows.length > 1;
}

/** The width of a grid: the longest row, since rows may be ragged. */
export function gridWidth(grid: Grid): number {
  return grid.rows.reduce((w, r) => Math.max(w, r.length), 0);
}

/** A sheet keeps its last column, for the same reason as its last row. */
export function canDeleteColumn(model: OfficeModel, sheet: number): boolean {
  const grid = gridAt(model, sheet);
  return !!grid && gridWidth(grid) > 1;
}

/** Inserts a column at `at`, one empty cell per row. */
export function insertColumn(model: SheetsModel, sheet: number, at: number): SheetsModel {
  const grid = model.grids[sheet];
  if (!grid) return model;
  const width = gridWidth(grid);
  const index = Math.max(0, Math.min(at, width));
  const rows = grid.rows.map((r) => {
    const line = r.slice();
    while (line.length < index) line.push('');
    line.splice(index, 0, '');
    return line;
  });
  if (!rows.length) rows.push(['']);
  return shiftFormulas(replaceGrid(model, sheet, { ...grid, rows }), sheet, 'col', index, 1);
}

/** Removes the column at `at`. A row shorter than `at` has no cell there and is left alone. */
export function removeColumn(model: SheetsModel, sheet: number, at: number): SheetsModel {
  const grid = model.grids[sheet];
  if (!grid || at < 0) return model;
  if (at >= gridWidth(grid)) return model;
  const rows = grid.rows.map((r) => {
    const line = r.slice();
    if (line.length > at) line.splice(at, 1);
    return line;
  });
  return shiftFormulas(replaceGrid(model, sheet, { ...grid, rows }), sheet, 'col', at, -1);
}

function sheetsEdit(
  model: OfficeModel,
  change: (m: SheetsModel) => SheetsModel,
): OfficeModel {
  return model.kind === 'xlsx' || model.kind === 'csv' ? change(model) : model;
}

/** A structural edit: the change, plus the `moved` counter going up (apply) or down (revert). */
function structural(model: OfficeModel, delta: 1 | -1, change: (m: SheetsModel) => SheetsModel, op?: StructOp): OfficeModel {
  return sheetsEdit(model, (s) => {
    const next = change(s);
    const moved = (s.moved ?? 0) + delta;
    const out: SheetsModel = { ...next };
    if (moved) out.moved = moved;
    else delete out.moved;
    const ops = (s.structure ?? []).slice();
    if (delta > 0 && op) ops.push(op);
    else if (delta < 0) ops.pop();
    if (ops.length) out.structure = ops;
    else delete out.structure;
    return out;
  });
}

/**
 * A structural edit whose undo is exact: formulas (their text moved or turned to
 * #REF!) and the owner's formatting are put back as they were before it.
 */
function exactStructural(op: StructOp, apply: (s: SheetsModel) => SheetsModel, revertGrid: (s: SheetsModel) => SheetsModel): Edit {
  let kept: { formulas?: Record<string, string>; sheetFormats?: Record<number, SheetFormat> } | null = null;
  return {
    apply: (m) => {
      if (m.kind === 'xlsx' || m.kind === 'csv') kept = { formulas: m.formulas, sheetFormats: m.sheetFormats };
      return structural(m, 1, apply, op);
    },
    revert: (m) => structural(m, -1, (s) => {
      const out: SheetsModel = { ...revertGrid(s) };
      if (kept) {
        if (kept.formulas) out.formulas = kept.formulas; else delete out.formulas;
        if (kept.sheetFormats) out.sheetFormats = kept.sheetFormats; else delete out.sheetFormats;
      }
      return out;
    }),
  };
}

/**
 * An edit that sets one sheet's AutoFilter, so the filter the owner applies is part of the model
 * and therefore reaches the file (and one Ctrl+Z takes it back).
 */
export function autoFilterEdit(sheet: number, before: readonly AutoFilterColumn[], after: readonly AutoFilterColumn[]): Edit {
  const put = (m: OfficeModel, columns: readonly AutoFilterColumn[]): OfficeModel => {
    if (m.kind !== 'xlsx' && m.kind !== 'csv') return m;
    const all: Record<number, readonly AutoFilterColumn[]> = { ...(m.autoFilters ?? {}) };
    if (columns.length) all[sheet] = columns;
    else delete all[sheet];
    const out: SheetsModel = { ...m };
    if (Object.keys(all).length) out.autoFilters = all;
    else delete out.autoFilters;
    return out;
  };
  return {
    key: `autofilter:${sheet}`,
    apply: (m) => put(m, after),
    revert: (m) => put(m, before),
  };
}

/**
 * An edit that sets one sheet's conditional-formatting rules, so what the owner sets reaches the
 * file and one Ctrl+Z takes it back.
 */
export function condRulesEdit(sheet: number, before: readonly CondRule[], after: readonly CondRule[]): Edit {
  const put = (m: OfficeModel, rules: readonly CondRule[]): OfficeModel => {
    if (m.kind !== 'xlsx' && m.kind !== 'csv') return m;
    const all: Record<number, readonly CondRule[]> = { ...(m.condRules ?? {}) };
    if (rules.length) all[sheet] = rules;
    else delete all[sheet];
    const out: SheetsModel = { ...m };
    if (Object.keys(all).length) out.condRules = all;
    else delete out.condRules;
    return out;
  };
  return {
    key: `condrules:${sheet}`,
    apply: (m) => put(m, after),
    revert: (m) => put(m, before),
  };
}

/**
 * An edit that sets one sheet's floating charts, so a chart the owner adds reaches the file and
 * one Ctrl+Z takes it back.
 */
export function chartsEdit(sheet: number, before: readonly ChartObject[], after: readonly ChartObject[]): Edit {
  const put = (m: OfficeModel, list: readonly ChartObject[]): OfficeModel => {
    if (m.kind !== 'xlsx' && m.kind !== 'csv') return m;
    const all: Record<number, readonly ChartObject[]> = { ...(m.charts ?? {}) };
    if (list.length) all[sheet] = list;
    else delete all[sheet];
    const out: SheetsModel = { ...m };
    if (Object.keys(all).length) out.charts = all;
    else delete out.charts;
    return out;
  };
  return {
    key: 'charts:' + sheet,
    apply: (m) => put(m, after),
    revert: (m) => put(m, before),
  };
}

/**
 * An edit that sets one sheet's inserted pivots, so Refresh can find what it wrote and one Ctrl+Z
 * takes the record back with the cells.
 */
export function pivotsEdit(sheet: number, before: readonly PivotPlacement[], after: readonly PivotPlacement[]): Edit {
  const put = (m: OfficeModel, list: readonly PivotPlacement[]): OfficeModel => {
    if (m.kind !== 'xlsx' && m.kind !== 'csv') return m;
    const all: Record<number, readonly PivotPlacement[]> = { ...(m.pivots ?? {}) };
    if (list.length) all[sheet] = list;
    else delete all[sheet];
    const out: SheetsModel = { ...m };
    if (Object.keys(all).length) out.pivots = all;
    else delete out.pivots;
    return out;
  };
  return {
    key: 'pivots:' + sheet,
    apply: (m) => put(m, after),
    revert: (m) => put(m, before),
  };
}

/** An edit that sets one cell, remembering the value it replaced. */
export function cellEdit(sheet: number, row: number, col: number, before: string, after: string): Edit {
  return {
    key: `cell:${sheet}:${row}:${col}`,
    apply: (m) => sheetsEdit(m, (s) => setCellValue(s, sheet, row, col, after)),
    revert: (m) => sheetsEdit(m, (s) => setCellValue(s, sheet, row, col, before)),
  };
}

/** An edit that inserts a row, capturing the index so undo removes exactly it. */
export function addRowEdit(sheet: number, at: number): Edit {
  return exactStructural({ sheet, axis: 'row', at, delta: 1 }, (s) => insertRow(s, sheet, at), (s) => removeRowOnly(s, sheet, at));
}

/** An edit that removes a row, keeping its cells so undo restores them exactly. */
export function deleteRowEdit(sheet: number, at: number, row: string[]): Edit {
  const value = row.slice();
  return exactStructural({ sheet, axis: 'row', at, delta: -1 }, (s) => removeRow(s, sheet, at), (s) => {
    const grid = s.grids[sheet];
    if (!grid) return s;
    const rows = grid.rows.slice();
    rows.splice(Math.min(at, rows.length), 0, value.slice());
    return replaceGrid(s, sheet, { ...grid, rows });
  });
}

/** An edit that inserts a column. */
export function addColumnEdit(sheet: number, at: number): Edit {
  return exactStructural({ sheet, axis: 'col', at, delta: 1 }, (s) => insertColumn(s, sheet, at), (s) => removeColumnOnly(s, sheet, at));
}

/** Undo of an insertion: the grid only (formulas and formats are restored by the caller). */
function removeRowOnly(model: SheetsModel, sheet: number, at: number): SheetsModel {
  const grid = model.grids[sheet];
  if (!grid || at < 0 || at >= grid.rows.length) return model;
  const rows = grid.rows.slice();
  rows.splice(at, 1);
  return replaceGrid(model, sheet, { ...grid, rows });
}
function removeColumnOnly(model: SheetsModel, sheet: number, at: number): SheetsModel {
  const grid = model.grids[sheet];
  if (!grid) return model;
  return replaceGrid(model, sheet, { ...grid, rows: grid.rows.map((r) => { const line = r.slice(); if (line.length > at) line.splice(at, 1); return line; }) });
}

/** An edit that removes a column, keeping its cells so undo restores them. */
export function deleteColumnEdit(sheet: number, at: number, values: string[]): Edit {
  const kept = values.slice();
  return exactStructural({ sheet, axis: 'col', at, delta: -1 }, (s) => removeColumn(s, sheet, at), (s) => restoreColumn(s, sheet, at, kept));
}

function restoreColumn(s: SheetsModel, sheet: number, at: number, kept: string[]): SheetsModel {
  const grid = s.grids[sheet];
  if (!grid) return s;
  const rows = grid.rows.map((r, i) => {
    const line = r.slice();
    while (line.length < at) line.push('');
    line.splice(at, 0, kept[i] ?? '');
    return line;
  });
  if (!rows.length) rows.push([kept[0] ?? '']);
  return replaceGrid(s, sheet, { ...grid, rows });
}

/** An edit that replaces one paragraph of a Word document (tab/newline text kept as-is). */
export function paragraphEdit(index: number, before: string, after: string): Edit {
  const set = (m: OfficeModel, text: string): OfficeModel => {
    if (m.kind !== 'docx') return m;
    const paragraphs = m.paragraphs.slice();
    while (paragraphs.length <= index) paragraphs.push('');
    const previous = paragraphs[index] ?? '';
    paragraphs[index] = text;
    // The rich runs follow the plain text: the change lands in the run it touches.
    const blocks = m.blocks && m.blocks[index] ? m.blocks.slice() : m.blocks;
    if (blocks && blocks[index]) {
      const change = diffText(previous, text);
      blocks[index] = { ...blocks[index], runs: replaceText(blocks[index].runs, change.start, change.start + change.del, change.ins) };
    }
    return blocks ? { ...m, paragraphs, blocks } : { ...m, paragraphs };
  };
  return {
    key: `para:${index}`,
    apply: (m) => set(m, after),
    revert: (m) => set(m, before),
  };
}

/** The formatting recorded for one paragraph (empty when the owner never touched it). */
export function paragraphFormatAt(model: OfficeModel, index: number): ParagraphFormat {
  return model.kind === 'docx' ? model.formats?.[index] ?? {} : {};
}

/**
 * An edit that sets one paragraph's formatting. Bold, italic and underline are
 * toggles (`true`/`false`), the size and the alignment are choices (or `null` to
 * hand the property back to the file), and the patch writes exactly that into
 * `<w:rPr>` and `<w:pPr><w:jc>`.
 */
export function paragraphFormatEdit(
  index: number,
  before: ParagraphFormat | undefined,
  after: ParagraphFormat | undefined,
): Edit {
  const put = (m: OfficeModel, format: ParagraphFormat | undefined): OfficeModel => {
    if (m.kind !== 'docx') return m;
    const formats = { ...(m.formats ?? {}) };
    if (format === undefined || !FORMAT_KEYS.some((key) => format[key] !== undefined)) delete formats[index];
    else formats[index] = format;
    return { ...m, formats };
  };
  return {
    key: `format:${index}`,
    apply: (m) => put(m, after),
    revert: (m) => put(m, before),
  };
}

/* ──────────────────────────── cell formulas ──────────────────────────── */

/** The key one cell's formula is stored under: "sheet:row:col", zero-based. */
export function formulaKey(sheet: number, row: number, col: number): string {
  return `${sheet}:${row}:${col}`;
}

/** The formula the owner typed in this cell, or undefined for a plain value. */
export function formulaAt(model: OfficeModel, sheet: number, row: number, col: number): string | undefined {
  if (model.kind !== 'xlsx' && model.kind !== 'csv') return undefined;
  return model.formulas?.[formulaKey(sheet, row, col)];
}

/** Sets or clears one cell's formula, leaving every other formula alone. */
export function setFormula(model: SheetsModel, sheet: number, row: number, col: number, formula: string | null): SheetsModel {
  const key = formulaKey(sheet, row, col);
  const formulas = { ...(model.formulas ?? {}) };
  if (!formula) delete formulas[key];
  else formulas[key] = formula;
  const empty = !Object.keys(formulas).length;
  return { ...model, formulas: empty ? undefined : formulas };
}

/** A cell's value together with its formula, as one reversible state. */
export interface CellState { value: string; formula?: string }

/**
 * An edit that sets a cell's value and formula together, so undoing a formula
 * restores the value it had before, not just the text of the formula.
 */
export function formulaCellEdit(sheet: number, row: number, col: number, before: CellState, after: CellState): Edit {
  const put = (m: OfficeModel, state: CellState): OfficeModel => {
    if (m.kind !== 'xlsx' && m.kind !== 'csv') return m;
    const withValue = setCellValue(m, sheet, row, col, state.value);
    return setFormula(withValue, sheet, row, col, state.formula ?? null);
  };
  return {
    key: `cell:${sheet}:${row}:${col}`,
    apply: (m) => put(m, after),
    revert: (m) => put(m, before),
  };
}

/**
 * Moves the formula keys of one sheet when its rows or columns move, so a formula
 * stays attached to the cell the owner typed it in. Entries on the removed line
 * are dropped; the formula text itself is kept exactly as it was written.
 */
function shiftFormulas(
  model: SheetsModel,
  sheet: number,
  axis: 'row' | 'col',
  at: number,
  delta: 1 | -1,
): SheetsModel {
  model = shiftFormats(model, sheet, axis, at, delta);
  if (!model.formulas) return model;
  const formulas: Record<string, string> = {};
  for (const [key, formula] of Object.entries(model.formulas)) {
    const [keySheet, rowText, colText] = key.split(':');
    const row = Number(rowText);
    const col = Number(colText);
    if (Number(keySheet) !== sheet || !Number.isInteger(row) || !Number.isInteger(col)) {
      formulas[key] = formula;
      continue;
    }
    const line = axis === 'row' ? row : col;
    if (line === at && delta === -1) continue; // the line that was removed takes its formula with it
    const moved = line >= at ? line + delta : line;
    formulas[formulaKey(sheet, axis === 'row' ? moved : row, axis === 'col' ? moved : col)] = formula;
  }
  // References follow their cells, in every sheet (a deleted cell becomes #REF!, as in Excel).
  const target = model.grids[sheet]?.name;
  if (target !== undefined) {
    for (const [key, formula] of Object.entries(formulas)) {
      const own = model.grids[Number(key.split(':')[0])]?.name ?? target;
      formulas[key] = shiftFormula(formula, own, { sheet: target, axis, at, count: delta });
    }
  }
  return { ...model, formulas: Object.keys(formulas).length ? formulas : undefined };
}

/** The owner's formatting of one sheet moves with its rows or columns. */
function shiftFormats(model: SheetsModel, sheet: number, axis: 'row' | 'col', at: number, delta: 1 | -1): SheetsModel {
  const fmt = model.sheetFormats?.[sheet];
  if (!fmt) return model;
  const all: Record<number, SheetFormat> = { ...model.sheetFormats };
  const next = shiftSheetFormat(fmt, axis, at, delta);
  if (next) all[sheet] = next;
  else delete all[sheet];
  const out: SheetsModel = { ...model };
  if (Object.keys(all).length) out.sheetFormats = all;
  else delete out.sheetFormats;
  return out;
}

/** An edit that replaces one paragraph of a PowerPoint slide. */
export function slideTextEdit(slide: number, paragraph: number, before: string, after: string): Edit {
  const set = (m: OfficeModel, text: string): OfficeModel => {
    if (m.kind !== 'pptx') return m;
    const slides = m.slides.map((s, i) => {
      if (i !== slide) return s;
      const parts = s.slice();
      while (parts.length <= paragraph) parts.push('');
      parts[paragraph] = text;
      return parts;
    });
    return { ...m, slides };
  };
  return {
    key: `slide:${slide}:${paragraph}`,
    apply: (m) => set(m, after),
    revert: (m) => set(m, before),
  };
}

/** An edit that replaces the whole text of a .txt/.md buffer. */
export function textEdit(before: string, after: string): Edit {
  return {
    key: 'text',
    apply: (m) => (m.kind === 'text' ? { ...m, text: after } : m),
    revert: (m) => (m.kind === 'text' ? { ...m, text: before } : m),
  };
}

/* ───────────────────────────── history ───────────────────────────── */

/** How many edit steps the user can walk back (the suite promises at least 100). */
export const HISTORY_LIMIT = 200;
/** Two edits to the same target closer than this merge into one undo step. */
export const COALESCE_MS = 700;

/**
 * Undo/redo over reversible edits.
 *
 * The model itself is never stored: each edit knows how to undo itself from the
 * current model, so 50 steps cost a few strings, not 50 copies of a spreadsheet.
 * When the oldest edit falls off the end of the limit, the "saved" position is
 * marked unreachable (`saved = -1`) so a file can never be reported as saved when
 * its disk state can no longer be reached.
 */
export class History {
  private edits: Edit[] = [];
  private times: number[] = [];
  private cursor = 0;
  private saved = 0;

  constructor(
    private readonly limit: number = HISTORY_LIMIT,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True when the model differs from the last saved/loaded state. */
  get dirty(): boolean { return this.saved !== this.cursor; }
  get undoSteps(): number { return this.cursor; }
  get redoSteps(): number { return this.edits.length - this.cursor; }

  push(edit: Edit): void {
    const last = this.cursor > 0 ? this.edits[this.cursor - 1] : undefined;
    if (edit.key && last?.key === edit.key && this.now() - this.times[this.cursor - 1] <= COALESCE_MS) {
      // Same target, same burst of typing: keep the newest change and the oldest
      // "before", so one undo still goes back to the value before the burst.
      this.edits[this.cursor - 1] = { key: edit.key, apply: edit.apply, revert: last.revert };
      this.times[this.cursor - 1] = this.now();
      return;
    }
    this.edits.length = this.cursor;
    this.times.length = this.cursor;
    this.edits.push(edit);
    this.times.push(this.now());
    this.cursor++;
    while (this.edits.length > this.limit) {
      this.edits.shift();
      this.times.shift();
      this.cursor--;
      this.saved = this.saved >= 1 ? this.saved - 1 : -1;
    }
  }

  undo(model: OfficeModel): OfficeModel {
    if (this.cursor === 0) return model;
    this.cursor--;
    return this.edits[this.cursor].revert(model);
  }

  redo(model: OfficeModel): OfficeModel {
    if (this.cursor >= this.edits.length) return model;
    const edit = this.edits[this.cursor];
    this.cursor++;
    return edit.apply(model);
  }

  /** Called after a successful save: the current model is now the disk state. */
  markSaved(): void { this.saved = this.cursor; }

  /** Called after loading (or re-loading) a file: nothing to undo, nothing dirty. */
  reset(): void {
    this.edits = [];
    this.times = [];
    this.cursor = 0;
    this.saved = 0;
  }
}

/* ─────────────────────────── model helpers ─────────────────────────── */

/** True when the reader hit its limit, so saving would drop rows/columns it never read. */
export function isTruncated(model: OfficeModel): boolean {
  return (model.kind === 'xlsx' || model.kind === 'csv') && model.grids.some((g) => g.truncated);
}

/** After a successful save the file on disk equals the model: nothing is truncated any more. */
export function clearTruncated(model: OfficeModel): OfficeModel {
  if (model.kind !== 'xlsx' && model.kind !== 'csv') return model;
  return { ...model, grids: model.grids.map((g) => (g.truncated ? { ...g, truncated: false } : g)) };
}

/** A one-line summary of a model, for the window's meta text. */
export function describeModel(model: OfficeModel): string {
  switch (model.kind) {
    case 'docx': return `${model.paragraphs.length}`;
    case 'xlsx': return `${model.grids.length}`;
    case 'csv': return `${model.grids[0]?.rows.length ?? 0}`;
    case 'pptx': return `${model.slides.length}`;
    default: return `${model.text.length}`;
  }
}
