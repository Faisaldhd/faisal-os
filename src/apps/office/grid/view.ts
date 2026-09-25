/**
 * Sheet — the spreadsheet view (الجدول).
 *
 * A grid with column letters and row numbers that stays left-to-right even in
 * Arabic (A1 is A1), a name box and a formula bar, range selection by dragging or
 * Shift+arrows, Excel's keyboard (arrows, Enter, Tab, F2, Esc), TSV copy/paste
 * with other programs, and sheet tabs at the bottom. The file's own look — column
 * widths, row heights, merged cells, frozen panes, fonts, fills, borders and
 * alignment — is drawn as Excel draws it.
 *
 * Every data cell is a text field holding the cell's raw content (the formula when
 * it has one); a formatted value is drawn over it until the field is focused, so the
 * grid shows "30" while the formula bar and the field hold "=SUM(B1:B2)".
 */
import { t, getLocale } from '../../../kernel/i18n';
import type { Editor, EditorContext, StatusInfo } from '../editor';
import {
  addColumnEdit, addRowEdit, canDeleteColumn, canDeleteRow, deleteColumnEdit, deleteRowEdit, formulaAt, formulaCellEdit,
  gridAt, gridWidth, SHEET_ROWS, type CellState, type Edit, type OfficeModel, type SheetsModel,
} from '../model';
import { evaluateInModel, formatFormula, parseFormula } from '../formula/index';
import { formatValue } from '../calc/index';
import { columnName } from '../xml';
import { MAX_COLS } from '../../viewer/formats';
import { el, observeSize } from '../ui/dom';
import type { RibbonTab } from '../ui/ribbon';
import type { BookLook, CellStyle } from './xlsxlook';
import { hasArabic, startsRtl } from '../writer/docops';
import { isCoarsePointer } from '../../../shell/device';
import {
  MAX_SORT_LEVELS, addChart, addCondRule, addSortLevel, chartNumber, chartTypeChoices, clearCondRules,
  clearFilter, clearFilters, clearSort, colorScaleRule, conditionalStyles, dataBarRule, displayText,
  dragPosition, emptySheetView, filteredColumns, formatChoices, formatForCell, isFiltered, looksLikeHeader,
  rangeToChartSpec, removeChart, removeSortLevel, setFilter, setSortOrder, topRule, visibleRowMap,
  type ChartObject, type SheetRange, type SheetView,
} from './sheetview';
import { distinctValues, sortRows, type CellStyle as CondCellStyle, type SortKey } from '../calc/index';
import { buildChart, renderSvg } from '../charts/index';
import {
  DEFAULT_ROW_HEIGHT, OVERSCAN_ROWS, TOUCH_ROW_HEIGHT, rowOffsets, rowWindow, type RowWindow,
} from './virtual';

/** Columns drawn past the data on an editable sheet, so a sheet still looks like one. */
const PAD_ROWS = 30;
const PAD_COLS = 12;
/** Height of the column-letter header, which the rows scroll under. */
const HEADER_HEIGHT = 26;

interface Cell { row: number; col: number }

/** A value shown in its number format (a small subset until the shared formatter lands). */
export function displayValue(value: string, fmt: string | undefined): string {
  if (!fmt || fmt === 'General' || fmt === '@' || value === '' || !/^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(value.trim())) return value;
  try { return formatValue(Number(value), fmt).text; } catch { /* fall back to the small formatter below */ }
  const n = Number(value);
  const section = fmt.split(';')[0].replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, (q) => q);
  if (/[yd]/i.test(section) || /m{1,4}[/-]/.test(section)) {
    const date = new Date(Math.round((n - 25569) * 86400000));
    if (Number.isNaN(date.getTime())) return value;
    const pad = (x: number): string => String(x).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  const percent = section.includes('%');
  const decimals = (/0\.(0+)/.exec(section)?.[1] ?? '').length;
  const grouped = section.includes(',');
  const v = percent ? n * 100 : n;
  let out = v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped });
  if (percent) out += '%';
  const prefix = /^"([^"]*)"/.exec(section)?.[1] ?? (/^[$€£¥]/.exec(section)?.[0] ?? '');
  const suffix = /"([^"]*)"\s*$/.exec(section)?.[1] ?? '';
  return `${prefix}${out}${suffix && suffix !== prefix ? suffix : ''}`;
}

/**
 * Whether a sheet is shown right-to-left (column A on the right): the file's own
 * `rightToLeft` when it states one, otherwise when most of its text cells are
 * Arabic — how Excel shows an Arabic sheet. Display only; the file is not changed.
 */
export function sheetIsRtl(rows: readonly (readonly string[])[], stated: boolean | undefined): boolean {
  if (stated !== undefined) return stated;
  let text = 0;
  let arabic = 0;
  for (const row of rows.slice(0, 500)) {
    for (const cell of row) {
      const v = cell.trim();
      if (!v || /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(v)) continue;
      text++;
      if (hasArabic(v)) arabic++;
    }
  }
  return text > 0 && arabic * 2 > text;
}

/** Parses TSV (what spreadsheets put on the clipboard) into rows of cells. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; continue; }
    if (ch === '\t') { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Rows of cells as TSV, quoting only what must be quoted. */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map((v) => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t')).join('\n');
}

/** Several edits as one undo step (a paste, a fill). */
export function compositeEdit(edits: readonly Edit[]): Edit {
  return {
    apply: (m) => edits.reduce((acc, e) => e.apply(acc), m),
    revert: (m) => [...edits].reverse().reduce((acc, e) => e.revert(acc), m),
  };
}

export function createSheet(ctx: EditorContext, book: BookLook | null): Editor {
  const sheets = (): SheetsModel | null => {
    const m = ctx.model();
    return m && (m.kind === 'xlsx' || m.kind === 'csv') ? m : null;
  };
  let active: Cell = { row: 0, col: 0 };
  let anchor: Cell = { row: 0, col: 0 };
  let editing = false;
  let dragging = false;
  let freezeTop: boolean | null = null;

  const root = el('div', 'fo-calc');
  const fxbar = el('div', 'fo-fxbar');
  const nameBox = el('input', 'fo-namebox');
  nameBox.setAttribute('aria-label', t('office.nameBox'));
  nameBox.spellcheck = false;
  const fxLabel = el('span', 'fo-fxlabel', 'fx');
  fxLabel.setAttribute('aria-hidden', 'true');
  const fx = el('input', 'fo-fxinput');
  fx.setAttribute('aria-label', t('office.formulaBar'));
  fx.dir = 'auto';
  fx.spellcheck = false;
  fxbar.append(nameBox, fxLabel, fx);
  const scroll = el('div', 'faisal-office-gridwrap fo-gridwrap');
  scroll.dir = 'ltr';
  const tabsBar = el('div', 'fo-sheettabs');
  tabsBar.setAttribute('role', 'tablist');
  tabsBar.setAttribute('aria-label', t('office.sheets'));
  const note = el('div', 'faisal-office-more fo-gridnote');
  // Charts float over the sheet; the panels (sort, filter, chart) open inside the sheet area.
  const canvas = el('div', 'fo-sheetcanvas');
  const chartsLayer = el('div', 'fo-chartlayer');
  const panels = el('div', 'fo-sheetpanels');
  canvas.append(scroll, chartsLayer, panels);
  root.append(fxbar, canvas, tabsBar, note);

  const lookOf = (): BookLook['sheets'][number] | undefined => book?.sheets[sheets()?.active ?? 0];
  const styleAt = (r: number, c: number): CellStyle | undefined => {
    const s = lookOf()?.xf.get(`${r}:${c}`);
    return s !== undefined ? book?.styles[s] : undefined;
  };

  function cellState(r: number, c: number): CellState {
    const m = sheets();
    if (!m) return { value: '' };
    const value = gridAt(m, m.active)?.rows[r]?.[c] ?? '';
    const formula = formulaAt(m, m.active, r, c);
    return formula ? { value, formula } : { value };
  }

  /** What the cell's field and the formula bar hold: the formula (the model's, or the file's own), else the value. */
  function rawOf(r: number, c: number): string {
    const state = cellState(r, c);
    return state.formula ?? lookOf()?.formulas.get(`${r}:${c}`) ?? state.value;
  }

  function commitCell(r: number, c: number, typed: string): void {
    const m = sheets();
    if (!m || !ctx.editable()) return;
    const sheet = m.active;
    const grid = gridAt(m, sheet);
    if (!grid) return;
    if (active.row !== r || active.col !== c) { active = { row: r, col: c }; anchor = active; } // the cell typed in is the active one
    const before = cellState(r, c);
    let after: CellState;
    if (m.kind === 'xlsx' && typed.trimStart().startsWith('=')) {
      const outcome = evaluateInModel(typed.trim(), m, sheet, { row: r, col: c });
      const parsed = outcome.ok ? parseFormula(typed.trim()) : null;
      const canonical = parsed && parsed.ok ? formatFormula(parsed.ast) : outcome.canonical;
      after = outcome.ok && canonical ? { value: outcome.value, formula: `=${canonical}` } : { value: typed };
    } else {
      after = { value: typed };
    }
    if (after.value === before.value && (after.formula ?? null) === (before.formula ?? null)) return;
    const growsGrid = r >= grid.rows.length || c >= gridWidth(grid);
    ctx.commit(formulaCellEdit(sheet, r, c, before, after));
    showResult();
    if (growsGrid) {
      // The grid grew under the caret: redraw, then put the caret back where the owner is typing.
      const wasFocused = document.activeElement instanceof HTMLInputElement && document.activeElement.dataset.r === String(r) && document.activeElement.dataset.c === String(c);
      renderGrid();
      const input = inputs.get(`${r}:${c}`);
      if (wasFocused && input) {
        keepCaret = true;
        input.value = typed;
        input.focus();
        input.setSelectionRange(typed.length, typed.length);
        editing = true;
      }
    } else refreshValues();
  }

  function showResult(): void {
    const m = sheets();
    if (!m || m.kind !== 'xlsx') return;
    const formula = formulaAt(m, m.active, modelRowOf(active.row), active.col);
    if (formula) ctx.setStatus(t('office.formulaResult', { value: cellState(modelRowOf(active.row), active.col).value }));
  }

  /* ─────────────────────────── drawing ─────────────────────────── */

  /** One drawn row: its element and the cells it currently holds, in column order. */
  interface RowRecord {
    tr: HTMLTableRowElement;
    inputs: HTMLInputElement[];
    tds: HTMLTableCellElement[];
    cols: number[];
  }

  let table: HTMLTableElement | null = null;
  let body: HTMLTableSectionElement | null = null;
  let spacerTop: HTMLTableRowElement | null = null;
  let spacerBottom: HTMLTableRowElement | null = null;
  let inputs = new Map<string, HTMLInputElement>();
  let tds = new Map<string, HTMLTableCellElement>();
  /** The rows in the document right now — never the whole sheet. */
  let rowCells = new Map<number, RowRecord>();
  /** Cumulative row tops; rebuilt when the sheet or its row heights change. */
  let offsets: Float64Array | null = null;
  let rowHeight = DEFAULT_ROW_HEIGHT;
  /** False until a drawn row has been measured: see `measureRowHeight`. */
  let measured = false;
  let rowCount = 0;
  let cols = 0;
  let dataRows = 0;
  let dataCols = 0;
  let frozenRows = 0;
  let winFirst = -1;
  let winLast = -1;
  let sheetRtl = false;
  let covered = new Set<string>();
  let mergeAt = new Map<string, { r1: number; c1: number }>();
  let sizes: { disconnect(): void } | null = null;

  /* ───────────────────── the sheet's view-level state ───────────────────── */
  // Sort is applied to the model (undoable, saved); filters, number formats, conditional
  // formatting and charts change only what the screen shows — see grid/sheetview.ts.
  let sheetView: SheetView = emptySheetView();
  /** The model rows to draw, when a filter is on: `null` means drawn row i is model row i. */
  let rowMap: number[] | null = null;
  /** Conditional styles in DRAWN order, computed once per render (never per cell). */
  let condCache: Array<Array<CondCellStyle | null>> = [];
  /** 1 when the top row reads as a header, so sort and filter leave it alone. */
  let headerRows = 0;
  /** The model row a drawn row shows. Every read or write of cell data goes through this. */
  const modelRowOf = (r: number): number => {
    if (!rowMap) return r;
    // Past the end of the filtered rows are the sheet's own blank rows: they hold no data at all,
    // so they are marked with -1 rather than silently aliasing onto a row the filter hid.
    return r < rowMap.length ? rowMap[r] : -1;
  };
  /** The first blank row drawn below the sheet's data (only meaningful while a filter is on). */
  const blankFrom = (): number => (rowMap ? rowMap.length : Number.POSITIVE_INFINITY);
  /** The model row a blank drawn row would append to. */
  function appendRowOf(r: number): number {
    return rowMap ? dataRows + (r - rowMap.length) : r;
  }
  /** The drawn row for a model row; a hidden row lands on the nearest visible one. */
  function drawnRowOf(modelRow: number): number {
    if (!rowMap) return Math.max(0, modelRow);
    const at = rowMap.indexOf(modelRow);
    if (at >= 0) return at;
    let best = 0;
    for (let i = 0; i < rowMap.length; i++) if (Math.abs(rowMap[i] - modelRow) < Math.abs(rowMap[best] - modelRow)) best = i;
    return best;
  }

  function styleCell(td: HTMLTableCellElement, input: HTMLInputElement, view: HTMLElement, s: CellStyle | undefined, value: string): void {
    const numeric = /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(value.trim()) && value.trim() !== '';
    const h = s?.hAlign ?? (numeric ? 'right' : undefined);
    // The overlay takes the text's own direction, so text too long for its cell is
    // clipped at its inline end and an Arabic word keeps its beginning visible.
    const rtl = !numeric && startsRtl(value) === true;
    view.dir = numeric ? 'ltr' : rtl ? 'rtl' : 'ltr';
    const physical = (a: string): string => {
      if (a === 'center' || a === 'centerContinuous') return 'center';
      const right = a === 'right';
      return right !== rtl ? 'flex-end' : 'flex-start';
    };
    if (h) { view.style.justifyContent = physical(h); view.style.textAlign = h === 'centerContinuous' ? 'center' : h; }
    if (!s) return;
    if (s.fill) td.style.backgroundColor = `#${s.fill}`;
    const color = s.color && s.color !== '000000' ? `#${s.color}` : s.fill ? '#000000' : '';
    for (const node of [input, view]) {
      if (s.bold) node.style.fontWeight = '700';
      if (s.italic) node.style.fontStyle = 'italic';
      if (s.underline || s.strike) node.style.textDecorationLine = `${s.underline ? 'underline ' : ''}${s.strike ? 'line-through' : ''}`;
      if (s.size && s.size !== 11) node.style.fontSize = `${Math.round(s.size * 4 / 3)}px`;
      if (s.font) node.style.fontFamily = `"${s.font.replace(/"/g, '')}", var(--faisal-font)`;
      if (color) node.style.color = color;
    }
    if (s.vAlign === 'center') view.style.alignItems = 'center';
    else if (s.vAlign === 'top') view.style.alignItems = 'flex-start';
    if (s.wrap) view.classList.add('is-wrap');
    const b = s.borders;
    if (b?.top) td.style.borderTop = b.top;
    if (b?.bottom) td.style.borderBottom = b.bottom;
    if (b?.left) td.style.borderLeft = b.left;
    if (b?.right) td.style.borderRight = b.right;
  }

  function renderGrid(): void {
    const m = sheets();
    inputs = new Map();
    tds = new Map();
    rowCells = new Map();
    winFirst = -1;
    winLast = -1;
    if (!m) { scroll.replaceChildren(); table = null; body = null; spacerTop = null; spacerBottom = null; offsets = null; return; }
    const sheet = m.active >= 0 && m.active < m.grids.length ? m.active : 0;
    const grid = m.grids[sheet];
    const look = lookOf();
    // The whole sheet, not a fixed window: the rows that are DRAWN are the visible ones (below),
    // and the row count only decides how far the scrollbar goes.
    dataRows = grid ? grid.rows.length : 0;
    dataCols = grid ? Math.max(1, gridWidth(grid)) : 1;
    // A header row stays put under sort and filter, so both need to know whether there is one.
    headerRows = grid && looksLikeHeader(grid.rows) ? 1 : 0;
    // The filter decides WHICH model rows are drawn; the windowing maths is untouched by it.
    const map = visibleRowMap(grid?.rows ?? [], sheetView, headerRows);
    rowMap = map.filtered ? map.rows : null;
    const viewRows = rowMap ? rowMap.length : dataRows;
    rowCount = Math.max(viewRows + (ctx.editable() ? PAD_ROWS : 0), PAD_ROWS);
    cols = Math.min(Math.max(dataCols + (ctx.editable() ? 3 : 0), PAD_COLS), MAX_COLS);
    rowHeight = baseRowHeight(look);
    offsets = rowOffsets(rowCount, rowHeightOf);
    measured = false;
    frozenRows = Math.min(freezeTop === null ? look?.frozenRows ?? 0 : freezeTop ? 1 : 0, rowCount);
    sheetRtl = sheetIsRtl(grid?.rows ?? [], look?.rtl);
    scroll.dir = sheetRtl ? 'rtl' : 'ltr';
    root.classList.toggle('is-rtl-sheet', sheetRtl);
    // Conditional formatting runs once per render over the rows in the order they are drawn.
    condCache = sheetView.condRules.length
      ? conditionalStyles(Array.from({ length: viewRows }, (_, r) => grid?.rows[modelRowOf(r)] ?? []), sheetView.condRules)
      : [];
    covered = new Set();
    mergeAt = new Map();
    for (const mg of look?.merges ?? []) {
      for (let r = mg.r0; r <= mg.r1; r++) for (let c = mg.c0; c <= mg.c1; c++) if (r !== mg.r0 || c !== mg.c0) covered.add(`${r}:${c}`);
      mergeAt.set(`${mg.r0}:${mg.c0}`, { r1: mg.r1, c1: mg.c1 });
    }

    const tbl = el('table', 'faisal-office-table fo-grid');
    const colgroup = el('colgroup');
    const corner = el('col');
    corner.style.width = '48px';
    colgroup.append(corner);
    for (let c = 0; c < cols; c++) {
      const col = el('col');
      col.style.width = `${look?.widths.get(c) ?? look?.defaultWidth ?? 88}px`;
      colgroup.append(col);
    }
    tbl.append(colgroup);
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', 'faisal-office-corner fo-corner', ''));
    const filtered = new Set(filteredColumns(sheetView));
    for (let c = 0; c < cols; c++) {
      const th = el('th', 'faisal-office-colhead fo-colhead', columnName(c));
      th.dataset.c = String(c);
      // A filtered column says so in its own header: the state must never be invisible.
      if (filtered.has(c)) { th.classList.add('is-filtered'); th.title = t('office.filterTitle', { name: columnName(c) }); }
      th.addEventListener('click', () => { anchor = { row: 0, col: c }; active = { row: Math.max(0, viewRows - 1), col: c }; select(false); });
      hr.append(th);
    }
    thead.append(hr);
    // The blank strips that stand in for the rows above and below the drawn ones. They are what
    // makes a 10 000-row sheet scroll correctly while only a screenful of rows exists in the DOM.
    const makeSpacer = (): HTMLTableRowElement => {
      const tr = el('tr', 'fo-vpad');
      tr.setAttribute('aria-hidden', 'true');
      tr.append(el('td', 'fo-vpad-cell'));
      return tr;
    };
    spacerTop = makeSpacer();
    spacerBottom = makeSpacer();
    body = el('tbody');
    tbl.append(thead, spacerTop, body, spacerBottom);
    table = tbl;
    scroll.replaceChildren(tbl);
    updateWindow(true);
    renderTabs();
    renderCharts();
    note.textContent = grid?.truncated
      ? t('office.cutNote', { rows: SHEET_ROWS, cols: MAX_COLS })
      : '';
    note.hidden = !note.textContent;
    paintSelection();
  }

  /** The row height a row gets when the file states none: 44px on a touch screen (G8). */
  function baseRowHeight(look: BookLook['sheets'][number] | undefined): number {
    if (isCoarsePointer()) return TOUCH_ROW_HEIGHT;
    return look?.defaultHeight ?? DEFAULT_ROW_HEIGHT;
  }

  function rowHeightOf(r: number): number {
    return lookOf()?.heights.get(r) ?? rowHeight;
  }

  /** The rows a scroll position shows, with the spacers that stand in for the rest. */
  function updateWindow(force = false): void {
    if (!body || !offsets) return;
    const win: RowWindow = rowWindow(offsets, scroll.scrollTop, scroll.clientHeight, OVERSCAN_ROWS);
    if (!force && win.first === winFirst && win.last === winLast) return;
    winFirst = win.first;
    winLast = win.last;
    // Frozen rows are drawn whatever the scroll position (they are sticky at the top), so the
    // scrolling window starts after them and the top spacer only covers the gap between.
    const first = Math.max(win.first, frozenRows);
    const last = Math.max(first, win.last);
    if (spacerTop) spacerTop.style.height = `${Math.max(0, offsets[Math.min(first, rowCount)] - offsets[Math.min(frozenRows, rowCount)])}px`;
    if (spacerBottom) spacerBottom.style.height = `${Math.max(0, win.padBottom)}px`;
    renderRows(first, last);
  }

  /**
   * Draws `[first, last)` into the body, REUSING the row elements that were already on screen:
   * a one-row scroll keeps every element (and the browser keeps its layout) and only builds the
   * row that actually entered the window.
   */
  function renderRows(first: number, last: number): void {
    if (!body) return;
    const keep = new Map<number, RowRecord>();
    const frag = document.createDocumentFragment();
    for (let r = 0; r < frozenRows; r++) {
      const rec = rowCells.get(r) ?? buildRow(r);
      keep.set(r, rec);
      frag.append(rec.tr);
    }
    for (let r = first; r < last; r++) {
      if (r < frozenRows || r >= rowCount) continue;
      const rec = rowCells.get(r) ?? buildRow(r);
      keep.set(r, rec);
      frag.append(rec.tr);
    }
    body.replaceChildren(frag);
    rowCells = keep;
    inputs = new Map();
    tds = new Map();
    for (const [r, rec] of keep) rec.cols.forEach((c, i) => { inputs.set(`${r}:${c}`, rec.inputs[i]); tds.set(`${r}:${c}`, rec.tds[i]); });
    paintSelection();
    measureRowHeight();
  }

  /**
   * The offsets, the spacers and the scroll positions only agree with the pixels if they use the
   * height the browser really gives a row. The stylesheet says one number and the platform may
   * render another (borders, a user font, a forced line height), so the FIRST drawn row is
   * measured once and the offsets are rebuilt from it when they disagree.
   */
  function measureRowHeight(): void {
    if (measured || !offsets || rowCells.size === 0) return;
    const rec = rowCells.values().next().value as RowRecord | undefined;
    const height = rec?.tr.getBoundingClientRect().height ?? 0;
    // A zero height means there was no layout yet (a hidden window, the first paint): come back
    // for it next time rather than believing 0px forever.
    if (!(height > 4)) return;
    measured = true;
    if (Math.abs(height - rowHeight) < 0.5) return;
    rowHeight = height;
    offsets = rowOffsets(rowCount, rowHeightOf);
    winFirst = -1;
    winLast = -1;
    updateWindow(true);
  }

  /** One row element with its cells, for `rowCells` to keep and reuse. */
  function buildRow(r: number): RowRecord {
    const grid = sheets() ? gridAt(sheets() as SheetsModel, (sheets() as SheetsModel).active) : null;
    const look = lookOf();
    // `r` is the DRAWN row; `mr` is the row the file holds. A filter can make them differ, and a
    // drawn row past the filtered ones is a blank row that holds nothing (-1).
    const mr = modelRowOf(r);
    const blank = mr < 0;
    const tr = el('tr');
    // The height the offsets were computed from, so a drawn row is exactly as tall as the window
    // maths believes it is (a touch row is 44px, the touch target G8 asks for). It is set on the
    // cells as well as the row: a `table-layout: fixed` table takes a row height as a minimum,
    // and the cells' own CSS height is what the browser ends up honouring.
    const height = rowHeightOf(r);
    tr.style.height = `${height}px`;
    // The row number is the SHEET's own number, so hiding rows leaves the others where they were.
    const rh = el('th', 'faisal-office-rowhead fo-rowhead', String((blank ? appendRowOf(r) : mr) + 1));
    if (!blank) rh.addEventListener('click', () => { anchor = { row: r, col: 0 }; active = { row: r, col: Math.max(0, dataCols - 1) }; select(false); });
    tr.append(rh);
    if (r < frozenRows) {
      tr.classList.add('is-frozen');
      tr.style.top = `${HEADER_HEIGHT + (offsets?.[r] ?? 0)}px`;
    }
    const rec: RowRecord = { tr, inputs: [], tds: [], cols: [] };
    const rules = condCache[r];
    for (let c = 0; c < cols; c++) {
      if (!blank && covered.has(`${mr}:${c}`)) continue;
      const td = el('td', 'faisal-office-celld fo-td');
      td.style.height = `${height}px`;
      const merge = blank ? undefined : mergeAt.get(`${mr}:${c}`);
      if (merge) { td.rowSpan = merge.r1 - mr + 1; td.colSpan = merge.c1 - c + 1; }
      const inData = !blank && mr < dataRows && c < dataCols;
      const input = el('input', inData ? 'faisal-office-cell' : 'fo-cell-empty');
      input.type = 'text';
      input.dir = 'auto';
      input.spellcheck = false;
      input.autocomplete = 'off';
      // With a filter on, the blank rows below the visible data take no typing: a row the filter
      // hid must never be edited through a row that merely looks empty (clear the filter first).
      input.readOnly = !ctx.editable() || (blank && !!rowMap);
      input.dataset.r = blank ? '' : String(mr);
      input.dataset.c = String(c);
      input.setAttribute('aria-label', blank ? '' : `${columnName(c)}${mr + 1}`);
      input.value = blank ? '' : rawOf(mr, c);
      const view = el('span', 'fo-cellview');
      view.setAttribute('aria-hidden', 'true');
      const value = blank ? '' : grid?.rows[mr]?.[c] ?? '';
      const s = blank ? undefined : styleAt(mr, c);
      // A chosen number format wins over the file's own: the owner asked for it just now.
      const chosen = blank ? '' : formatForCell(sheetView.formats, mr, c);
      view.textContent = chosen ? displayText(value, chosen, getLocale() === 'ar' ? 'ar' : 'en') : displayValue(value, s?.numFmt);
      styleCell(td, input, view, s, value);
      styleConditional(td, view, blank ? null : rules?.[c] ?? null);
      input.addEventListener('focus', () => {
        if (keepCaret) { keepCaret = false; active = { row: r, col: c }; anchor = active; paintSelection(); return; }
        active = { row: r, col: c };
        if (!dragging && !shiftFocus) anchor = active;
        shiftFocus = false;
        editing = false;
        input.select();
        select(true);
        showResult();
      });
      input.addEventListener('input', () => { if (mr < 0) return; editing = true; commitCell(mr, c, input.value); fx.value = input.value; });
      input.addEventListener('dblclick', () => { editing = true; input.setSelectionRange(input.value.length, input.value.length); });
      td.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        if (ev.shiftKey) { ev.preventDefault(); active = { row: r, col: c }; select(false); return; }
        dragging = true;
        anchor = { row: r, col: c };
        active = anchor;
      });
      td.addEventListener('pointerenter', () => {
        if (!dragging) return;
        active = { row: r, col: c };
        paintSelection();
      });
      td.append(view, input);
      tr.append(td);
      rec.inputs.push(input);
      rec.tds.push(td);
      rec.cols.push(c);
    }
    rowCells.set(r, rec);
    return rec;
  }

  /** Scrolls `row` into view (below the sticky header) so it can be drawn and focused. */
  function revealRow(row: number): void {
    if (!offsets) return;
    const top = offsets[row];
    const bottom = offsets[Math.min(row + 1, rowCount)];
    const view = Math.max(0, scroll.clientHeight - HEADER_HEIGHT);
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (view > 0 && bottom > scroll.scrollTop + view) scroll.scrollTop = bottom - view;
  }

  /** Makes the active cell exist in the document (scrolling to it if it is out of the window). */
  function focusCell(row: number, col: number): void {
    revealRow(row);
    updateWindow();
    const input = inputs.get(`${row}:${col}`);
    if (input) focusInput(input);
  }

  function focusInput(input: HTMLInputElement): void {
    shiftFocus = true;
    input.focus({ preventScroll: true });
  }
  let shiftFocus = false;
  let keepCaret = false;
  document.addEventListener('pointerup', onPointerUp);
  function onPointerUp(): void {
    if (!dragging) return;
    dragging = false;
    paintSelection();
    ctx.refresh();
  }

  function refreshValues(): void {
    const m = sheets();
    if (!m) return;
    const grid = m.grids[m.active];
    for (const [key, input] of inputs) {
      const [r, c] = key.split(':').map(Number);
      // `key` holds drawn rows; the data lives at the model row a filter maps them to.
      const mr = modelRowOf(r);
      if (document.activeElement !== input) input.value = rawOf(mr, c);
      const view = input.previousElementSibling as HTMLElement | null;
      if (view) {
        const chosen = formatForCell(sheetView.formats, mr, c);
        const raw = grid?.rows[mr]?.[c] ?? '';
        view.textContent = chosen ? displayText(raw, chosen, getLocale() === 'ar' ? 'ar' : 'en') : displayValue(raw, styleAt(mr, c)?.numFmt);
      }
      const td = input.parentElement as HTMLTableCellElement | null;
      if (td) styleConditional(td, view, condCache[r]?.[c] ?? null);
    }
    syncBars();
    ctx.refresh();
  }

  function renderTabs(): void {
    const m = sheets();
    tabsBar.replaceChildren();
    if (!m) return;
    m.grids.forEach((grid, i) => {
      const tab = el('button', 'faisal-office-tab fo-sheettab', grid.name);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(i === m.active));
      tab.addEventListener('click', () => {
        const cur = sheets();
        if (!cur) return;
        cur.active = i;
        active = { row: 0, col: 0 };
        anchor = active;
        renderGrid();
        ctx.refresh();
      });
      tabsBar.append(tab);
    });
  }

  function range(): { r0: number; c0: number; r1: number; c1: number } {
    return {
      r0: Math.min(anchor.row, active.row), r1: Math.max(anchor.row, active.row),
      c0: Math.min(anchor.col, active.col), c1: Math.max(anchor.col, active.col),
    };
  }

  function refName(): string {
    const g = range();
    // The name box names the SHEET's own cells, so a filter never renumbers the rows.
    const nameOf = (drawn: number): number => {
      const mr = modelRowOf(drawn);
      return mr < 0 ? appendRowOf(drawn) : mr;
    };
    const a = `${columnName(g.c0)}${nameOf(g.r0) + 1}`;
    return g.r0 === g.r1 && g.c0 === g.c1 ? a : `${a}:${columnName(g.c1)}${nameOf(g.r1) + 1}`;
  }

  function paintSelection(): void {
    const g = range();
    for (const [key, td] of tds) {
      const [r, c] = key.split(':').map(Number);
      td.classList.toggle('is-sel', r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1 && !(g.r0 === g.r1 && g.c0 === g.c1));
      td.classList.toggle('is-active', r === active.row && c === active.col);
    }
    table?.querySelectorAll('.fo-colhead').forEach((th) => { const c = Number((th as HTMLElement).dataset.c); th.classList.toggle('is-sel', c >= g.c0 && c <= g.c1); });
    syncBars();
  }

  function syncBars(): void {
    if (document.activeElement !== nameBox) nameBox.value = refName();
    if (document.activeElement !== fx) fx.value = rawOf(modelRowOf(active.row), active.col);
    fx.readOnly = !ctx.editable();
  }

  function select(fromFocus: boolean): void {
    paintSelection();
    if (!fromFocus) {
      const input = inputs.get(`${active.row}:${active.col}`);
      if (input && document.activeElement !== input) focusInput(input);
      else if (!input) focusCell(active.row, active.col);
    }
    ctx.refresh();
  }

  function move(dr: number, dc: number, extend: boolean): void {
    // While a filter is on, the caret stays inside the rows the filter left visible.
    const lastRow = rowMap ? Math.max(0, rowMap.length - 1) : Number.POSITIVE_INFINITY;
    active = {
      row: Math.max(0, Math.min(lastRow, active.row + dr)),
      col: Math.max(0, Math.min(cols - 1, active.col + dc)),
    };
    if (!extend) anchor = active;
    shiftFocus = extend;
    // The target may be outside the drawn window: this scrolls to it, draws it, then focuses it.
    focusCell(active.row, active.col);
    if (extend) paintSelection();
  }

  scroll.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement;
    if (!(target instanceof HTMLInputElement) || !target.dataset.r) return;
    const k = ev.key;
    if (k === 'Enter') { ev.preventDefault(); editing = false; move(ev.shiftKey ? -1 : 1, 0, false); return; }
    if (k === 'Tab') { ev.preventDefault(); editing = false; move(0, ev.shiftKey ? -1 : 1, false); return; }
    if (k === 'F2') { editing = true; target.setSelectionRange(target.value.length, target.value.length); ev.preventDefault(); return; }
    if (k === 'Escape' && editing) { editing = false; target.value = rawOf(modelRowOf(active.row), active.col); target.select(); return; }
    if ((k === 'Delete' || (k === 'Backspace' && !editing)) && ctx.editable()) {
      ev.preventDefault();
      clearRange();
      return;
    }
    if (!editing && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) {
      ev.preventDefault();
      const dr = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
      const dc = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0;
      move(dr, dc, ev.shiftKey);
    }
  });

  function clearRange(): void {
    const m = sheets();
    if (!m) return;
    const g = range();
    const edits: Edit[] = [];
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
      const mr = modelRowOf(r);
      if (mr < 0) continue;                      // a blank row below a filtered sheet holds nothing
      const before = cellState(mr, c);
      if (before.value !== '' || before.formula) edits.push(formulaCellEdit(m.active, mr, c, before, { value: '' }));
    }
    if (edits.length) { ctx.commit(compositeEdit(edits)); refreshValues(); }
  }

  root.addEventListener('copy', (ev) => {
    if (document.activeElement === fx || document.activeElement === nameBox) return;
    const input = document.activeElement as HTMLInputElement | null;
    const g = range();
    if (input && editing && input.selectionStart !== input.selectionEnd) return;
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    const rows: string[][] = [];
    for (let r = g.r0; r <= g.r1; r++) { const mr = modelRowOf(r); const row: string[] = []; for (let c = g.c0; c <= g.c1; c++) row.push(mr < 0 ? '' : grid?.rows[mr]?.[c] ?? ''); rows.push(row); }
    ev.clipboardData?.setData('text/plain', toTsv(rows));
    ev.preventDefault();
  });
  root.addEventListener('paste', (ev) => {
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    if (document.activeElement === fx || document.activeElement === nameBox || !ctx.editable()) return;
    if (!/[\t\n]/.test(text.replace(/\n$/, ''))) return; // a single value: the field takes it itself
    ev.preventDefault();
    const m = sheets();
    if (!m) return;
    const rows = parseTsv(text);
    const edits: Edit[] = [];
    const base = modelRowOf(active.row);
    if (base < 0) return;                        // a blank row below a filtered sheet takes nothing
    rows.forEach((row, dr) => row.forEach((value, dc) => {
      const r = base + dr;
      const c = active.col + dc;
      edits.push(formulaCellEdit(m.active, r, c, cellState(r, c), { value }));
    }));
    ctx.commit(compositeEdit(edits));
    renderGrid();
  });

  fx.addEventListener('input', () => { if (ctx.editable()) commitCell(modelRowOf(active.row), active.col, fx.value); });
  fx.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); move(1, 0, false); }
    if (ev.key === 'Escape') { fx.value = rawOf(modelRowOf(active.row), active.col); inputs.get(`${active.row}:${active.col}`)?.focus(); }
  });
  nameBox.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const m = /^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?$/.exec(nameBox.value.trim());
    if (!m) { nameBox.value = refName(); return; }
    const toCell = (col: string, row: string): Cell => ({ row: Math.max(0, Number(row) - 1), col: [...col.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 });
    // A name box reference is a SHEET address, so a filter maps it onto the row that is drawn.
    const from = toCell(m[1], m[2]);
    const to = m[3] ? toCell(m[3], m[4]) : from;
    anchor = { row: drawnRowOf(from.row), col: from.col };
    active = { row: drawnRowOf(to.row), col: to.col };
    select(false);
  });

  /* ─────────────────────────── commands ─────────────────────────── */

  function addRow(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid) return;
    ctx.commit(addRowEdit(m.active, grid.rows.length));
    renderGrid();
  }
  function addColumn(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid) return;
    ctx.commit(addColumnEdit(m.active, gridWidth(grid)));
    renderGrid();
  }
  function deleteRow(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    const mr = modelRowOf(active.row);
    if (!m || !grid || !grid.rows[mr]) return;
    ctx.commit(deleteRowEdit(m.active, mr, grid.rows[mr]));
    const last = grid.rows.length - 2;
    if (active.row > last) active = { ...active, row: Math.max(0, last) };
    anchor = active;
    renderGrid();
  }
  function deleteColumn(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid) return;
    ctx.commit(deleteColumnEdit(m.active, active.col, grid.rows.map((r) => r[active.col] ?? '')));
    const last = gridWidth(grid) - 2;
    if (active.col > last) active = { ...active, col: Math.max(0, last) };
    anchor = active;
    renderGrid();
  }
  function autoSum(fn: 'SUM' | 'AVERAGE'): void {
    const m = sheets();
    if (!m || m.kind !== 'xlsx') return;
    const g = range();
    let target: Cell;
    let ref: string;
    if (g.r0 !== g.r1 || g.c0 !== g.c1) {
      const r0 = modelRowOf(g.r0);
      const r1 = modelRowOf(g.r1);
      target = { row: r1 + 1, col: g.c0 };
      ref = `${columnName(g.c0)}${r0 + 1}:${columnName(g.c1)}${r1 + 1}`;
    } else {
      const grid = gridAt(m, m.active);
      // Walk up the SHEET's own rows: the number the formula sums is a file address, not a drawn one.
      const here = modelRowOf(active.row);
      let top = here - 1;
      while (top >= 0 && /^-?\d/.test((grid?.rows[top]?.[active.col] ?? '').trim())) top--;
      target = { row: here, col: active.col };
      ref = `${columnName(active.col)}${top + 2}:${columnName(active.col)}${Math.max(here, top + 2)}`;
    }
    commitCell(target.row, target.col, `=${fn}(${ref})`);
    active = { row: drawnRowOf(target.row), col: target.col };
    anchor = active;
    renderGrid();
    select(false);
  }

  const enabledSheet = (): boolean => !!sheets() && ctx.editable();

  /* ─────────────── conditional formatting, formats, charts, panels ─────────────── */

  /** Paints a conditional style onto a cell: a fill, a font colour, and the data bar itself. */
  function styleConditional(td: HTMLTableCellElement, view: HTMLElement | null, style: CondCellStyle | null): void {
    td.classList.toggle('has-cond', !!style);
    td.style.backgroundImage = '';
    if (view) {
      view.style.boxShadow = '';
      if (style?.bar) {
        // The bar is drawn behind the value from the cell's start edge to `end` of its width.
        td.style.backgroundImage = `linear-gradient(90deg, ${style.bar.color} ${Math.round(style.bar.end * 100)}%, transparent ${Math.round(style.bar.end * 100)}%)`;
      }
      if (style?.fill && !style.bar) td.style.backgroundColor = style.fill;
      if (style?.color) view.style.color = style.color;
      if (style?.bold) view.style.fontWeight = '700';
      if (style?.hideValue) view.style.visibility = 'hidden';
    }
  }

  /** Applies a chosen number format to every cell of the selection (view-level). */
  function applyNumberFormat(pattern: string): void {
    const g = range();
    const next = { ...sheetView.formats };
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
      const key = `${modelRowOf(r)}:${c}`;
      if (!pattern || pattern === 'General') delete next[key];
      else next[key] = pattern;
    }
    sheetView = { ...sheetView, formats: next };
    renderGrid();
    select(true);
    ctx.refresh();
  }

  /** The sheet's own rows, in the order they are drawn — what the engines read. */
  function drawnMatrix(): string[][] {
    const grid = sheets() ? gridAt(sheets() as SheetsModel, (sheets() as SheetsModel).active) : null;
    if (!grid) return [];
    const count = rowMap ? rowMap.length : grid.rows.length;
    return Array.from({ length: count }, (_, r) => grid.rows[modelRowOf(r)] ?? []);
  }

  /* ──────────────────────────────── charts ──────────────────────────────── */

  /** Draws every floating chart over the sheet, from the engine's scene. */
  function renderCharts(): void {
    if (!chartsLayer) return;
    chartsLayer.replaceChildren(...sheetView.charts.map((c) => chartElement(c)));
  }

  function chartElement(chart: ChartObject): HTMLElement {
    const box = el('div', 'fo-chart');
    box.dataset.chart = chart.id;
    box.style.left = `${chart.x}px`;
    box.style.top = `${chart.y}px`;
    box.style.width = `${chart.w}px`;
    box.style.height = `${chart.h}px`;
    const bar = el('div', 'fo-chart-bar');
    bar.append(el('span', 'fo-chart-title', chart.title || t(`office.${chartTypeChoices().find((c) => c.value === chart.type)?.labelKey.split('.')[1] ?? 'chartBar'}`)));
    const close = el('button', 'fo-chart-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', t('office.chartRemove'));
    close.addEventListener('click', () => { sheetView = removeChart(sheetView, chart.id); renderCharts(); ctx.refresh(); });
    bar.append(close);
    box.append(bar);
    const body = el('div', 'fo-chart-body');
    try {
      // The engine draws the scene; parsing its SVG keeps user text out of innerHTML entirely.
      const spec = rangeToChartSpec(drawnMatrix(), chart.range, {
        type: chart.type, title: chart.title, theme: 'light', rtl: sheetRtl,
        width: Math.max(120, chart.w - 12), height: Math.max(80, chart.h - 40),
      });
      const svgText = renderSvg(buildChart(spec), chart.title ? { title: chart.title } : {});
      const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      body.append(document.importNode(parsed.documentElement, true));
    } catch {
      body.append(el('div', 'fo-chart-empty', t('office.chartEmpty')));
    }
    box.append(body);
    // Dragging the bar moves the chart; the pointer events work for a finger as well as a mouse.
    bar.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const start = { x: chart.x, y: chart.y };
      const from = { x: ev.clientX, y: ev.clientY };
      const bounds = { w: canvas.clientWidth, h: canvas.clientHeight };
      const move = (e: PointerEvent): void => {
        const at = dragPosition(start, e.clientX - from.x, e.clientY - from.y, bounds, { w: chart.w, h: chart.h });
        box.style.left = `${at.x}px`;
        box.style.top = `${at.y}px`;
        chart.x = at.x;
        chart.y = at.y;
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        ctx.refresh();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return box;
  }

  /* ──────────────────────────────── panels ──────────────────────────────── */

  let openPanel: HTMLElement | null = null;

  function closePanel(): void {
    openPanel?.remove();
    openPanel = null;
  }

  /** A panel in the sheet area: a title, a body, and a close button that a finger can hit. */
  function showPanel(title: string, body: HTMLElement): void {
    closePanel();
    const panel = el('div', 'fo-sheetpanel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', title);
    const head = el('div', 'fo-sheetpanel-head');
    head.append(el('span', 'fo-sheetpanel-title', title));
    const close = el('button', 'fo-sheetpanel-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', t('office.cancel'));
    close.addEventListener('click', closePanel);
    head.append(close);
    panel.append(head, body);
    panel.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closePanel(); } });
    panels.replaceChildren(panel);
    openPanel = panel;
    panel.querySelector<HTMLElement>('select, input, button:not(.fo-sheetpanel-close)')?.focus();
  }

  /** The label of a column: its header cell when there is one, else the letter. */
  function columnLabel(c: number): string {
    const grid = sheets() ? gridAt(sheets() as SheetsModel, (sheets() as SheetsModel).active) : null;
    const head = headerRows ? String(grid?.rows[0]?.[c] ?? '').trim() : '';
    return head ? `${columnName(c)} — ${head}` : columnName(c);
  }

  function panelButton(label: string, run: () => void, primary = false): HTMLButtonElement {
    const b = el('button', `fo-sheetpanel-btn${primary ? ' is-primary' : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  function openSortPanel(): void {
    const body = el('div', 'fo-sheetpanel-body');
    const columns = Math.max(1, Math.min(dataCols, cols));
    const levels = el('div', 'fo-sheetpanel-note', t('office.sortBody', {
      columns: sheetView.sort.length
        ? sheetView.sort.map((k) => `${columnLabel(k.col)} ${k.order === 'desc' ? '↓' : '↑'}`).join('، ')
        : t('office.filterAllShown'),
    }));
    body.append(levels);
    // One row per sort column: pick the column, then its direction.
    const grid2 = el('div', 'fo-sheetpanel-rows');
    for (let i = 0; i < MAX_SORT_LEVELS; i++) {
      const row = el('div', 'fo-sheetpanel-row');
      const pick = el('select', 'fo-sheetpanel-select');
      pick.setAttribute('aria-label', t('office.sortColumns'));
      const none = el('option', undefined, t('office.filterAllShown'));
      none.value = '';
      pick.append(none);
      for (let c = 0; c < columns; c++) {
        const opt = el('option', undefined, columnLabel(c));
        opt.value = String(c);
        pick.append(opt);
      }
      const current = sheetView.sort[i];
      pick.value = current ? String(current.col) : '';
      const dir = el('select', 'fo-sheetpanel-select');
      dir.setAttribute('aria-label', t('office.sortAsc'));
      for (const [value, label] of [['asc', t('office.sortAsc')], ['desc', t('office.sortDesc')]]) {
        const opt = el('option', undefined, label);
        opt.value = value;
        dir.append(opt);
      }
      dir.value = current?.order ?? 'asc';
      pick.addEventListener('change', () => {
        const col = Number(pick.value);
        const next = Number.isFinite(col) && pick.value !== ''
          ? addSortLevel(sheetView, col, dir.value === 'desc' ? 'desc' : 'asc')
          : { ...sheetView, sort: sheetView.sort.filter((k) => k.col !== (current?.col ?? -1)) };
        sheetView = next;
        openSortPanel();
        applySort();
      });
      dir.addEventListener('change', () => {
        if (!current) return;
        sheetView = setSortOrder(sheetView, current.col, dir.value === 'desc' ? 'desc' : 'asc');
        applySort();
        openSortPanel();
      });
      row.append(el('span', 'fo-sheetpanel-level', `${i + 1}`), pick, dir);
      grid2.append(row);
    }
    body.append(grid2);
    const actions = el('div', 'fo-sheetpanel-actions');
    actions.append(
      panelButton(t('office.sortApply'), () => { applySort(); closePanel(); }, true),
      panelButton(t('office.sortClear'), () => { sheetView = clearSort(sheetView); renderGrid(); closePanel(); ctx.refresh(); }),
    );
    body.append(actions, el('div', 'fo-sheetpanel-note', t('office.sortHeaderOn')));
    showPanel(t('office.sortTitle'), body);
  }

  /** Applies the sort keys to the MODEL: it is an ordinary edit, so it is undoable and it saves. */
  function applySort(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid || !sheetView.sort.length) { renderGrid(); return; }
    const before = grid.rows.map((row) => [...row]);
    const after = sortRows(before, sheetView.sort as SortKey[], { header: headerRows });
    const swap = (model: OfficeModel, rows: string[][]): OfficeModel =>
      model.kind === 'xlsx' || model.kind === 'csv'
        ? { ...model, moved: 1, grids: model.grids.map((g, i) => (i === m.active ? { ...g, rows } : g)) }
        : model;
    ctx.commit({ key: `sort:${m.active}`, apply: (model) => swap(model, after), revert: (model) => swap(model, before) });
    active = { row: 0, col: active.col };
    anchor = active;
    renderGrid();
  }

  function openFilterPanel(col: number): void {
    const grid = sheets() ? gridAt(sheets() as SheetsModel, (sheets() as SheetsModel).active) : null;
    if (!grid) return;
    const body = el('div', 'fo-sheetpanel-body');
    const values = distinctValues(grid.rows, col, { header: headerRows }).slice(0, 300);
    if (!values.length) body.append(el('div', 'fo-sheetpanel-note', t('office.filterEmpty')));
    const chosen = new Set<string>();
    const existing = sheetView.filters[col];
    if (existing?.kind === 'values') for (const key of existing.keys) chosen.add(key);
    const all = existing === undefined;
    const list = el('div', 'fo-sheetpanel-list');
    for (const value of values) {
      const row = el('label', 'fo-sheetpanel-check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = all || chosen.has(value.key);
      box.addEventListener('change', () => { if (box.checked) chosen.add(value.key); else chosen.delete(value.key); });
      const text = el('span', undefined, `${value.label === '' ? '∅' : value.label} (${value.count})`);
      row.append(box, text);
      list.append(row);
    }
    body.append(list);
    const actions = el('div', 'fo-sheetpanel-actions');
    actions.append(
      panelButton(t('office.filterApply'), () => {
        const keys = values.filter((v) => chosen.has(v.key)).map((v) => v.key);
        // Unticking nothing at all is the same as clearing the column.
        sheetView = keys.length === values.length ? clearFilter(sheetView, col) : setFilter(sheetView, col, { kind: 'values', keys });
        closePanel();
        renderGrid();
        ctx.refresh();
      }, true),
      panelButton(t('office.filterClearColumn'), () => { sheetView = clearFilter(sheetView, col); closePanel(); renderGrid(); ctx.refresh(); }),
      panelButton(t('office.filterClearAll'), () => { sheetView = clearFilters(sheetView); closePanel(); renderGrid(); ctx.refresh(); }),
    );
    body.append(actions, el('div', 'fo-sheetpanel-note', t('office.filterViewOnly')));
    showPanel(t('office.filterTitle', { name: columnLabel(col) }), body);
  }

  function openChartPanel(): void {
    const g = range();
    const body = el('div', 'fo-sheetpanel-body');
    const kinds = chartTypeChoices();
    const kind = el('select', 'fo-sheetpanel-select');
    kind.setAttribute('aria-label', t('office.chartKind'));
    for (const choice of kinds) {
      const opt = el('option', undefined, t(choice.labelKey));
      opt.value = choice.value;
      kind.append(opt);
    }
    const title = el('input', 'fo-sheetpanel-input');
    title.type = 'text';
    title.placeholder = t('office.chartName');
    title.setAttribute('aria-label', t('office.chartName'));
    const rows = el('div', 'fo-sheetpanel-rows');
    const kindRow = el('div', 'fo-sheetpanel-row');
    kindRow.append(el('span', 'fo-sheetpanel-level', t('office.chartKind')), kind);
    const titleRow = el('div', 'fo-sheetpanel-row');
    titleRow.append(el('span', 'fo-sheetpanel-level', t('office.chartName')), title);
    rows.append(kindRow, titleRow);
    body.append(rows, el('div', 'fo-sheetpanel-note', t('office.chartSeries', { range: refName() })));
    const actions = el('div', 'fo-sheetpanel-actions');
    actions.append(panelButton(t('office.chartAdd'), () => {
      const range2: SheetRange = { r0: modelRowOf(g.r0), c0: g.c0, r1: modelRowOf(g.r1), c1: g.c1 };
      const size = { w: Math.min(420, Math.max(260, canvas.clientWidth - 40)), h: 280 };
      sheetView = addChart(sheetView, {
        type: kind.value as ChartObject['type'],
        range: range2,
        title: title.value.trim() || t('office.chartInsert'),
        x: 16, y: 16, w: size.w, h: size.h,
      });
      closePanel();
      renderCharts();
      ctx.refresh();
    }, true));
    body.append(actions, el('div', 'fo-sheetpanel-note', t('office.chartViewOnly')));
    showPanel(t('office.chartTitle'), body);
  }

  function tabs(): RibbonTab[] {
    return [
      ctx.fileTab(),
      {
        id: 'home', label: t('office.tabHome'), groups: [
          {
            label: t('office.groupCells'), controls: [
              { type: 'button', id: 'addrow', icon: 'rowAdd', label: t('office.addRow'), showLabel: true, phone: true, enabled: enabledSheet, run: addRow },
              { type: 'button', id: 'addcol', icon: 'colAdd', label: t('office.addColumn'), showLabel: true, enabled: enabledSheet, run: addColumn },
              { type: 'button', id: 'delrow', icon: 'rowDelete', label: t('office.deleteRow'), showLabel: true, enabled: () => enabledSheet() && canDeleteRow(sheets() as OfficeModel, sheets()?.active ?? 0), run: deleteRow },
              { type: 'button', id: 'delcol', icon: 'colDelete', label: t('office.deleteColumn'), showLabel: true, enabled: () => enabledSheet() && canDeleteColumn(sheets() as OfficeModel, sheets()?.active ?? 0), run: deleteColumn },
            ],
          },
          {
            label: t('office.groupFormulas'), controls: [
              { type: 'button', id: 'autosum', icon: 'sum', label: t('office.autoSum'), showLabel: true, phone: true, enabled: () => enabledSheet() && sheets()?.kind === 'xlsx', run: () => autoSum('SUM') },
              { type: 'button', id: 'average', icon: 'fx', label: t('office.autoAverage'), showLabel: true, enabled: () => enabledSheet() && sheets()?.kind === 'xlsx', run: () => autoSum('AVERAGE') },
            ],
          },
        ],
      },
      {
        id: 'data', label: t('office.tabData'), groups: [
          {
            label: t('office.groupSortFilter'), controls: [
              { type: 'button', id: 'sort', icon: 'sortAsc', label: t('office.sortTitle'), showLabel: true, phone: true, enabled: enabledSheet, run: openSortPanel },
              { type: 'button', id: 'filter', icon: 'filter', label: t('office.filterTitle', { name: columnName(active.col) }), showLabel: true, phone: true, pressed: () => isFiltered(sheetView), enabled: enabledSheet, run: () => openFilterPanel(active.col) },
              { type: 'button', id: 'unfilter', icon: 'close', label: t('office.filterClearAll'), showLabel: true, enabled: () => isFiltered(sheetView), run: () => { sheetView = clearFilters(sheetView); renderGrid(); ctx.refresh(); } },
            ],
          },
          {
            label: t('office.groupCondFmt'), controls: [
              { type: 'button', id: 'colorscale', icon: 'fill', label: t('office.condScale'), showLabel: true, enabled: enabledSheet, run: () => { sheetView = addCondRule(sheetView, colorScaleRule()); renderGrid(); ctx.refresh(); } },
              { type: 'button', id: 'databars', icon: 'chart', label: t('office.condBars'), showLabel: true, enabled: enabledSheet, run: () => { sheetView = addCondRule(sheetView, dataBarRule()); renderGrid(); ctx.refresh(); } },
              { type: 'button', id: 'condtop', icon: 'check', label: t('office.condTop'), showLabel: true, enabled: enabledSheet, run: () => { sheetView = addCondRule(sheetView, topRule(10)); renderGrid(); ctx.refresh(); } },
              { type: 'button', id: 'condclear', icon: 'close', label: t('office.condClear'), showLabel: true, enabled: () => sheetView.condRules.length > 0, run: () => { sheetView = clearCondRules(sheetView); renderGrid(); ctx.refresh(); } },
            ],
          },
          {
            label: t('office.groupNumFmt'), controls: [
              {
                type: 'select', id: 'numfmt', label: t('office.numFormat'), width: 170,
                options: () => formatChoices().map((c) => ({ value: c.value, label: t(c.labelKey) })),
                value: () => formatForCell(sheetView.formats, modelRowOf(active.row), active.col) || 'General',
                onChange: (value) => applyNumberFormat(value),
              },
              { type: 'button', id: 'numclear', icon: 'close', label: t('office.numGeneral'), showLabel: true, run: () => applyNumberFormat('General') },
            ],
          },
          {
            label: t('office.groupCharts'), controls: [
              { type: 'button', id: 'chart', icon: 'chart', label: t('office.chartInsert'), showLabel: true, phone: true, enabled: enabledSheet, run: openChartPanel },
              { type: 'button', id: 'chartclear', icon: 'close', label: t('office.chartRemove'), showLabel: true, enabled: () => sheetView.charts.length > 0, run: () => { for (const c of [...sheetView.charts]) sheetView = removeChart(sheetView, c.id); renderCharts(); ctx.refresh(); } },
            ],
          },
        ],
      },
      {
        id: 'view', label: t('office.tabView'), groups: [
          {
            label: t('office.groupViews'), controls: [
              { type: 'button', id: 'freeze', icon: 'freeze', label: t('office.freezeTopRow'), showLabel: true, phone: true, pressed: () => (freezeTop ?? (lookOf()?.frozenRows ?? 0) > 0), run: () => { freezeTop = !(freezeTop ?? (lookOf()?.frozenRows ?? 0) > 0); renderGrid(); } },
            ],
          },
        ],
      },
    ];
  }

  function selectionStats(): string[] {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    const g = range();
    if (!grid || (g.r0 === g.r1 && g.c0 === g.c1)) return [];
    let sum = 0;
    let count = 0;
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
      const mr = modelRowOf(r);
      if (mr < 0) continue;
      const v = (grid.rows[mr]?.[c] ?? '').trim();
      if (v !== '' && Number.isFinite(Number(v))) { sum += Number(v); count++; }
    }
    if (!count) return [];
    const fmt = (n: number): string => String(Number(n.toPrecision(12)));
    return [t('office.statSum', { n: fmt(sum) }), t('office.statAverage', { n: fmt(sum / count) }), t('office.statCount', { n: count })];
  }

  /** The sheet's own honest state line: what is filtered, sorted, formatted or charted. */
  function viewParts(): string[] {
    const parts: string[] = [];
    if (isFiltered(sheetView)) {
      const shown = rowMap ? rowMap.length : dataRows;
      parts.push(t('office.filterShown', { n: shown, total: dataRows }));
    }
    if (sheetView.sort.length) parts.push(t('office.sortedBy', { columns: sheetView.sort.map((k) => `${columnName(k.col)}${k.order === 'desc' ? '↓' : '↑'}`).join(' ') }));
    if (sheetView.condRules.length) parts.push(t('office.condActive', { n: sheetView.condRules.length }));
    return parts;
  }

  // Redraw the window on every scroll (passive: the wheel is never blocked) and whenever the
  // viewport changes size, so a resized window draws the rows that really fit.
  scroll.addEventListener('scroll', () => updateWindow(), { passive: true });
  sizes = observeSize(scroll, () => updateWindow());

  return {
    element: root,
    tabs,
    render(): void {
      const m = sheets();
      if (m && active.row === 0 && active.col === 0 && !inputs.size) anchor = active;
      renderGrid();
      syncBars();
    },
    status(): StatusInfo {
      return { parts: [refName(), ...viewParts(), ...selectionStats()] };
    },
    dispose(): void {
      document.removeEventListener('pointerup', onPointerUp);
      sizes?.disconnect();
      sizes = null;
      closePanel();
    },
    ...{ activeCell: () => active },
  } as Editor;
}
