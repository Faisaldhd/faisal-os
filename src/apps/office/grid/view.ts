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
 * A cell is plain text (its formatted value); there is ONE floating editor, opened over
 * the active cell by typing, F2, a double-click or a tap on the active cell, and the grid
 * itself takes the keyboard the rest of the time (`nav.ts` says what each key means). So
 * the grid shows "30" while the formula bar and the editor hold "=SUM(B1:B2)", and a big
 * sheet costs a text node per cell instead of a text field per cell.
 */
import { t, getLocale } from '../../../kernel/i18n';
import type { Editor, EditorContext, StatusInfo } from '../editor';
import {
  addColumnEdit, addRowEdit, autoFilterEdit, canDeleteColumn, canDeleteRow, cellEdit, chartsEdit, condRulesEdit, deleteColumnEdit, deleteRowEdit, formulaAt, formulaCellEdit, formulaKey,
  gridAt, gridWidth, pivotsEdit, SHEET_ROWS, type CellState, type Edit, type Grid, type OfficeModel, type SheetsModel,
} from '../model';
import {
  PIVOT_AGGREGATES, pivotTable, pivotTarget, sourceSignature,
  type PivotAggregate, type PivotPlacement, type PivotSpec,
} from './pivot';
import type { AutoFilterColumn } from './autofilter';
import { evaluateInModel, formatFormula, parseFormula, translateFormula } from '../formula/index';
import type { CondRule } from '../calc/index';
import type { FilterCondition } from '../calc/index';
import { formatValue } from '../calc/index';
import { columnName } from '../xml';
import { MAX_COLS } from '../../viewer/formats';
import { el, observeSize } from '../ui/dom';
import type { RibbonTab } from '../ui/ribbon';
import { menuList, openModal, openPopover } from '../ui/popover';
import { icon } from '../ui/icons';
import {
  borderPatch, cellFormatOf, formatRange, mergeAtCell, mergesOf, overlayStyle, sheetFormatEdit, sheetFormatOf, withColumnWidth,
  withMerge, withMerges, withoutMerges, withRowHeight,
  type BorderPreset, type CellFormat, type MergeRange, type SheetFormat,
} from './sheetfmt';
import {
  autoFitColumns, clampColWidth, DEFAULT_COL_WIDTH, draggedWidth, isDoubleAct, MAX_COL_WIDTH,
} from './virtual';
import { draggedHeight, isCircularAt, MAX_ROW_HEIGHT, MIN_ROW_HEIGHT, measureCellText, openingWidths, stepDecimals } from './helpers';
import { validationAt, validationProblem, withoutRules, type RangedValidation } from './rules';
import { parseListSource, type CompareOp, type ValidationRule } from '../calc/index';
import type { BookLook, CellStyle } from './xlsxlook';
import { cellAlignment, columnsToDraw, sheetDirection } from './layout';
import { isCoarsePointer } from '../../../shell/device';
import {
  MAX_SORT_LEVELS, addChart, addCondRule, addSortLevel, chartNumber, chartTypeChoices, clearCondRules,
  clearFilter, clearFilters, clearSort, colorScaleRule, conditionalStyles, dataBarRule, displayText,
  emptySheetView, filteredColumns, formatChoices, formatForCell, isFiltered, looksLikeHeader,
  rangeToChartSpec, removeChart, removeSortLevel, setFilter, setSortOrder, shiftViewFor, topRule, visibleRowMap,
  type ChartObject, type SheetRange, type SheetView,
} from './sheetview';
import {
  distinctValues, sortFormulas, sortRange, totalsRows, type CellStyle as CondCellStyle, type SortKey, type SortRect,
} from '../calc/index';
import { buildChart, renderSvg } from '../charts/index';
import {
  DEFAULT_ROW_HEIGHT, OVERSCAN_ROWS, TOUCH_ROW_HEIGHT, rowOffsets, rowWindow, type RowWindow,
} from './virtual';
import { copyIndex, fillCells, fillPlan, seriesFrom, type FillPlan, type FillRect } from './fill';
import { editorKey, gridKey, lastUsedCell } from './nav';
import { calcTabs, type AutoFn, type CalcCommands, type FreezeKind } from './tabs';
import { cellStyleFormat, formatFromStyle } from './cellstyles';
import { DESCRIBED_FUNCTIONS, FUNCTION_CATEGORIES, functionEntry, functionsIn, hyperlinkFormula, hyperlinkOf, safeLink, searchFunctions, type FunctionCategory } from './functions';
import { chartPlacement, chartSource, chartTitleFrom, draggedChart, resizedChart } from './chartplace';
import { cellMatches, findAll, removeDuplicates, replaceInCell, type CellHit, type FindOptions } from './find';
import './strings';

/** Columns drawn past the data on an editable sheet, so a sheet still looks like one. */
const PAD_ROWS = 30;
const PAD_COLS = 12;
/** Height of the column-letter header, which the rows scroll under. */
const HEADER_HEIGHT = 26;

/** What a sort changes, kept whole so its undo restores exactly. */
interface SortState { rows: string[][]; formulas?: Record<string, string>; moved?: number }

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
  return sheetDirection(rows, stated, false);
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
  let dragging = false;
  /** Frozen rows and columns the owner chose (null: the file's own). */
  let freezeRowsSet: number | null = null;
  let freezeColsSet: number | null = null;
  /** The status bar's zoom: CSS `zoom` on the scroll box, so its scroll metrics stay in sheet
   *  pixels; only what is read from the screen (rects, pointer deltas) is divided by it. */
  let zoom = 1;

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
  // The grid itself holds the keyboard focus between entries (arrows, typing, copy, paste).
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', t('office.sheetGrid'));
  /** The one floating editor: parked out of the document until an entry starts. */
  const cellEditor = el('input', 'fo-celleditor');
  cellEditor.type = 'text';
  cellEditor.dir = 'auto';
  cellEditor.spellcheck = false;
  cellEditor.autocomplete = 'off';
  /** The cell being edited (drawn row, model row, column); null when no entry is open. */
  let editAt: { row: number; mr: number; col: number } | null = null;
  /** 'enter': started by typing, so an arrow commits; 'edit': F2 or a double-click, arrows move the caret. */
  let editMode: 'enter' | 'edit' = 'enter';
  const tabsBar = el('div', 'fo-sheettabs');
  tabsBar.setAttribute('role', 'tablist');
  tabsBar.setAttribute('aria-label', t('office.sheets'));
  const note = el('div', 'faisal-office-more fo-gridnote');
  // Charts float over the sheet; the panels (sort, filter, chart) open inside the sheet area.
  const canvas = el('div', 'fo-sheetcanvas');
  const chartsLayer = el('div', 'fo-chartlayer');
  const panels = el('div', 'fo-sheetpanels');
  canvas.append(scroll, panels);
  root.append(fxbar, canvas, tabsBar, note);

  const lookOf = (): BookLook['sheets'][number] | undefined => book?.sheets[sheets()?.active ?? 0];
  /** The owner's formatting of the active sheet (widths, heights, cell formats), saved into the file. */
  const fmtOf = (): SheetFormat | undefined => sheetFormatOf(ctx.model(), sheets()?.active ?? 0);
  /** The file's style for a cell (model row) with the owner's formatting on top. */
  const styleAt = (r: number, c: number): CellStyle | undefined => {
    const s = lookOf()?.xf.get(`${r}:${c}`);
    return overlayStyle(s !== undefined ? book?.styles[s] : undefined, cellFormatOf(fmtOf(), r, c));
  };
  /** Auto-fitted widths for a sheet whose file states none (display only). */
  let autoWidths = new Map<number, number>();
  const widthOf = (c: number): number => {
    const own = fmtOf()?.cols?.[c];
    if (own) return own;
    const look = lookOf();
    return look?.widths.get(c) ?? autoWidths.get(c) ?? look?.defaultWidth ?? DEFAULT_COL_WIDTH;
  };
  const fitsOnOpen = (): boolean => !(lookOf()?.widths.size);
  function shownText(r: number, c: number): string {
    const m = sheets();
    const value = m ? gridAt(m, m.active)?.rows[r]?.[c] ?? '' : '';
    const chosen = formatForCell(sheetView.formats, r, c);
    return chosen ? displayText(value, chosen, getLocale() === 'ar' ? 'ar' : 'en') : displayValue(value, styleAt(r, c)?.numFmt);
  }
  function computeAutoWidths(rows: number, count: number): void {
    autoWidths = new Map();
    if (!fitsOnOpen()) return;
    const texts: string[][] = [];
    for (let r = 0; r < Math.min(rows, 400); r++) { const line: string[] = []; for (let c = 0; c < count; c++) line.push(shownText(r, c)); texts.push(line); }
    autoWidths = openingWidths(texts, count, measureCellText, lookOf()?.defaultWidth ?? DEFAULT_COL_WIDTH);
  }
  /** The width that fits column `c`'s content (double-click on its border). */
  function fitWidth(c: number): number {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    const texts = (grid?.rows ?? []).slice(0, 400).map((_, r) => [shownText(r, c)]);
    return Math.max(autoFitColumns(texts, [0], measureCellText).get(0) ?? DEFAULT_COL_WIDTH, 40);
  }

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
    // The cell typed in is the active one (`r` is a model row: a filter may draw it elsewhere).
    const drawn = drawnRowOf(r);
    if (active.row !== drawn || active.col !== c) { active = { row: drawn, col: c }; anchor = active; }
    const before = cellState(r, c);
    const after = cellStateFor(typed, r, c, sheet);
    if (after.value === before.value && (after.formula ?? null) === (before.formula ?? null)) return;
    const growsGrid = r >= grid.rows.length || c >= gridWidth(grid);
    ctx.commit(formulaCellEdit(sheet, r, c, before, after));
    showResult();
    if (growsGrid) renderGrid(); else refreshValues();
  }

  /**
   * The state a typed text produces for one cell: a formula is evaluated and canonicalised, so
   * the file keeps `=SUM(A1:A2)` and the cell shows its value. Shared by typing and by the fill
   * handle, which must not invent a second way to write a cell.
   */
  function cellStateFor(typed: string, r: number, c: number, sheet: number): CellState {
    const m = sheets();
    if (!m) return { value: typed };
    if (m.kind !== 'xlsx' || !typed.trimStart().startsWith('=')) return { value: typed };
    const outcome = evaluateInModel(typed.trim(), m, sheet, { row: r, col: c });
    const parsed = outcome.ok ? parseFormula(typed.trim()) : null;
    const canonical = parsed && parsed.ok ? formatFormula(parsed.ast) : outcome.canonical;
    return outcome.ok && canonical ? { value: outcome.value, formula: `=${canonical}` } : { value: typed };
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
    tds: HTMLTableCellElement[];
    views: HTMLElement[];
    cols: number[];
  }

  let table: HTMLTableElement | null = null;
  let colEls: HTMLTableColElement[] = [];
  let body: HTMLTableSectionElement | null = null;
  let spacerTop: HTMLTableRowElement | null = null;
  let spacerBottom: HTMLTableRowElement | null = null;
  let tds = new Map<string, HTMLTableCellElement>();
  /** Each drawn cell's text holder, by the same `drawn:col` key. */
  let viewOf = new Map<string, HTMLElement>();
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
  let frozenCols = 0;
  /** Where each drawn column starts, in sheet pixels from column A (for frozen columns). */
  let colStarts: number[] = [];
  let winFirst = -1;
  let winLast = -1;
  let sheetRtl = false;
  let covered = new Set<string>();
  let mergeAt = new Map<string, { r1: number; c1: number }>();
  let sizes: { disconnect(): void } | null = null;

  /* ───────────────────── the sheet's view-level state ───────────────────── */
  // Sort is applied to the model (undoable, saved), and so is the AutoFilter (it is written into
  // the file as `<autoFilter>`); number formats go to the model's cell formats (styles.xml), while
  // conditional formatting and charts still change only what the screen shows — see grid/sheetview.ts.
  let sheetView: SheetView = seededView();
  /**
   * The view state a sheet starts with: the file's own AutoFilter (read from its `<autoFilter>` by
   * `xlsxlook`) shows at open, so a filtered sheet opens looking the way it was saved.
   */
  function seededView(): SheetView {
    const view = emptySheetView();
    const look = book?.sheets[sheets()?.active ?? 0];
    if (!look) return view;
    const filters: Record<number, FilterCondition> = {};
    for (const [col, keys] of look.filters ?? []) filters[col] = { kind: 'values', keys };
    return {
      ...view,
      ...(Object.keys(filters).length ? { filters } : {}),
      // The file's own conditional formatting shows too: a saved rule must not disappear.
      ...(look.condRules?.length ? { condRules: [...look.condRules] } : {}),
      // — and the charts the file carries, drawn where the file put them.
      ...(look.charts?.length ? { charts: [...look.charts] } : {}),
    };
  }

  /**
   * Sets the conditional-formatting rules in the view AND in the model (one undoable edit), so what
   * the owner sets is what the file gets — the panel no longer has to call itself display-only.
   */
  function setCondState(next: readonly CondRule[]): void {
    const before = [...sheetView.condRules];
    const after = [...next];
    sheetView = { ...sheetView, condRules: after };
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      ctx.commit(condRulesEdit(sheets()?.active ?? 0, before, after));
    }
    renderGrid();
    ctx.refresh();
  }

  /**
   * Sets the floating charts in the view AND in the model (one undoable edit), so a chart the owner
   * adds or removes reaches the file — the panel no longer has to call itself display-only.
   */
  function setChartsState(next: readonly ChartObject[]): void {
    const before = [...sheetView.charts];
    const after = [...next];
    sheetView = { ...sheetView, charts: after };
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      ctx.commit(chartsEdit(sheets()?.active ?? 0, before, after));
    }
    renderCharts();
    ctx.refresh();
  }

  /** The AutoFilter the model holds for a view: only the checklist kind has an `<autoFilter>` shape. */
  function autoFilterColumns(view: SheetView): AutoFilterColumn[] {
    return Object.entries(view.filters)
      .filter(([, condition]) => condition.kind === 'values')
      .map(([col, condition]) => ({ col: Number(col), keys: [...(condition as { kind: 'values'; keys: readonly string[] }).keys] }))
      .sort((a, b) => a.col - b.col);
  }

  /**
   * Sets the view's filters AND the model's copy of them (one undoable edit), so what the owner
   * filters is what the file gets. The panel no longer has to say "view-level only".
   */
  function setFilterState(next: SheetView): void {
    const before = autoFilterColumns(sheetView);
    const after = autoFilterColumns(next);
    sheetView = next;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      ctx.commit(autoFilterEdit(sheets()?.active ?? 0, before, after));
    }
    renderGrid();
    ctx.refresh();
  }

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

  /**
   * Lines a cell's text up (`layout.ts`): a number, or a formula's numeric result, on the right;
   * text at the start of its own direction, so text too long for its cell is clipped at its
   * inline end and an Arabic word keeps its beginning visible.
   */
  function alignCell(view: HTMLElement, s: CellStyle | undefined, value: string): void {
    const a = cellAlignment(value, s?.hAlign);
    view.dir = a.dir;
    view.style.justifyContent = a.justify;
    view.style.textAlign = a.textAlign;
  }

  function styleCell(td: HTMLTableCellElement, view: HTMLElement, s: CellStyle | undefined, value: string): void {
    alignCell(view, s, value);
    if (!s) return;
    if (s.fill) td.style.backgroundColor = `#${s.fill}`;
    const color = s.color && s.color !== '000000' ? `#${s.color}` : s.fill ? '#000000' : '';
    if (s.bold) view.style.fontWeight = '700';
    if (s.italic) view.style.fontStyle = 'italic';
    if (s.underline || s.strike) view.style.textDecorationLine = `${s.underline ? 'underline ' : ''}${s.strike ? 'line-through' : ''}`;
    if (s.size && s.size !== 11) view.style.fontSize = `${Math.round(s.size * 4 / 3)}px`;
    if (s.font) view.style.fontFamily = `"${s.font.replace(/"/g, '')}", var(--faisal-font)`;
    if (color) view.style.color = color;
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
    // A redraw replaces every cell, the one being edited too: the entry is committed first.
    if (editAt) commitEdit(0, 0, false);
    const hadGrid = gridHasFocus();
    const m = sheets();
    tds = new Map();
    viewOf = new Map();
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
    rowHeight = baseRowHeight(look);
    offsets = rowOffsets(rowCount, rowHeightOf);
    measured = false;
    frozenRows = Math.min(freezeRowsSet ?? look?.frozenRows ?? 0, rowCount);
    frozenCols = Math.min(freezeColsSet ?? look?.frozenCols ?? 0, MAX_COLS);
    // An Arabic UI opens a sheet right-to-left (column A on the right), as WPS does; the file's own
    // `rightToLeft` still wins, and an English UI follows the text of the sheet.
    sheetRtl = sheetDirection(grid?.rows ?? [], look?.rtl, getLocale() === 'ar');
    scroll.dir = sheetRtl ? 'rtl' : 'ltr';
    root.classList.toggle('is-rtl-sheet', sheetRtl);
    // Conditional formatting runs once per render over the rows in the order they are drawn.
    condCache = sheetView.condRules.length
      ? conditionalStyles(Array.from({ length: viewRows }, (_, r) => grid?.rows[modelRowOf(r)] ?? []), sheetView.condRules)
      : [];
    covered = new Set();
    mergeAt = new Map();
    for (const mg of mergesOf(fmtOf(), look?.merges)) {
      for (let r = mg.r0; r <= mg.r1; r++) for (let c = mg.c0; c <= mg.c1; c++) if (r !== mg.r0 || c !== mg.c0) covered.add(`${r}:${c}`);
      mergeAt.set(`${mg.r0}:${mg.c0}`, { r1: mg.r1, c1: mg.c1 });
    }

    const tbl = el('table', 'faisal-office-table fo-grid');
    const colgroup = el('colgroup');
    const corner = el('col');
    corner.style.width = '48px';
    colgroup.append(corner);
    computeAutoWidths(dataRows, Math.min(dataCols, MAX_COLS));
    // The data, a few columns to type into, then as many more as it takes to reach the far edge of
    // the window: a sheet never ends in an empty strip.
    cols = columnsToDraw(dataCols, ctx.editable() ? 3 : 0, PAD_COLS, MAX_COLS, viewportWidth(), widthOf);
    colEls = [];
    colStarts = [];
    let startX = 0;
    for (let c = 0; c < cols; c++) {
      const col = el('col');
      colStarts.push(startX);
      startX += widthOf(c);
      col.style.width = `${widthOf(c)}px`;
      colgroup.append(col);
      colEls.push(col);
    }
    tbl.append(colgroup);
    fitTableWidth(tbl);
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', 'faisal-office-corner fo-corner', ''));
    const filtered = new Set(filteredColumns(sheetView));
    for (let c = 0; c < cols; c++) {
      const th = el('th', 'faisal-office-colhead fo-colhead', columnName(c));
      th.dataset.c = String(c);
      if (c < frozenCols) frozeColumn(th, c);
      // A filtered column says so in its own header: the state must never be invisible.
      if (filtered.has(c)) { th.classList.add('is-filtered'); th.title = t('office.filterTitle', { name: columnName(c) }); }
      th.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('.fo-colgrip')) return;
        anchor = { row: 0, col: c }; active = { row: Math.max(0, viewRows - 1), col: c }; select(false);
      });
      th.append(colGrip(c));
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
    // The charts ride on the sheet (they scroll with it), above the cells and under the headers.
    scroll.replaceChildren(tbl, chartsLayer);
    updateWindow(true);
    renderTabs();
    renderCharts();
    note.textContent = grid?.truncated
      ? t('office.cutNote', { rows: SHEET_ROWS, cols: MAX_COLS })
      : '';
    note.hidden = !note.textContent;
    paintSelection();
    // The waiting editor lived in a cell that is gone: put it back on the active cell.
    parkEditor();
    if (hadGrid) focusGrid();
  }

  /** A cell holding a HYPERLINK formula looks like a link and says how to open it. */
  function markLink(view: HTMLElement, mr: number, c: number): void {
    const url = hyperlinkOf(rawOf(mr, c));
    view.classList.toggle('is-link', !!url);
    if (url) view.title = `${url} — ${t('office.linkOpenHint')}`; else view.removeAttribute('title');
  }

  /** A cell of a frozen column: sticky beside the row numbers, the last one drawing the split line. */
  function frozeColumn(cell: HTMLElement, c: number): void {
    cell.classList.add('is-frozen-col');
    if (c === frozenCols - 1) cell.classList.add('is-frozen-edge');
    cell.style.insetInlineStart = `${48 + (colStarts[c] ?? 0)}px`;
  }

  /** The scroll box's width in sheet pixels (the status bar's zoom scales what is drawn). */
  function viewportWidth(): number {
    return scroll.clientWidth / (zoom || 1);
  }

  /** The row height a row gets when the file states none: 44px on a touch screen (G8). */
  function baseRowHeight(look: BookLook['sheets'][number] | undefined): number {
    if (isCoarsePointer()) return TOUCH_ROW_HEIGHT;
    return look?.defaultHeight ?? DEFAULT_ROW_HEIGHT;
  }

  function rowHeightOf(r: number): number {
    // `r` is a drawn row: its height is the model row's (the owner's, else the file's).
    const mr = modelRowOf(r);
    return (mr >= 0 ? fmtOf()?.rows?.[mr] ?? lookOf()?.heights.get(mr) : undefined) ?? rowHeight;
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
    // The row being edited is scrolling out of the window: the entry is committed, as Excel does.
    if (editAt && editAt.row >= frozenRows && (editAt.row < first || editAt.row >= last)) commitEdit(0, 0, false);
    const hadGrid = gridHasFocus();
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
    tds = new Map();
    viewOf = new Map();
    for (const [r, rec] of keep) rec.cols.forEach((c, i) => { tds.set(`${r}:${c}`, rec.tds[i]); viewOf.set(`${r}:${c}`, rec.views[i]); });
    paintSelection();
    parkEditor();
    if (hadGrid && !gridHasFocus()) focusGrid();
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
    const height = (rec?.tr.getBoundingClientRect().height ?? 0) / zoom;
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
    if (!blank) {
      rh.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('.fo-rowgrip')) return;
        anchor = { row: r, col: 0 }; active = { row: r, col: Math.max(0, dataCols - 1) }; select(false);
      });
      rh.append(rowGrip(mr, tr));
    }
    tr.append(rh);
    // A frozen row stays under the column letters: every cell of it (the row number too) is sticky
    // at the row's own offset, and the last frozen row draws the split line.
    const frozenTop = r < frozenRows ? `${HEADER_HEIGHT + (offsets?.[r] ?? 0)}px` : '';
    if (r < frozenRows) {
      tr.classList.add('is-frozen');
      if (r === frozenRows - 1) tr.classList.add('is-frozen-edge');
      tr.style.top = frozenTop;
      rh.style.top = frozenTop;
      rh.classList.add('is-frozen-row');
    }
    const rec: RowRecord = { tr, tds: [], views: [], cols: [] };
    const rules = condCache[r];
    for (let c = 0; c < cols; c++) {
      if (!blank && covered.has(`${mr}:${c}`)) continue;
      const inData = !blank && mr < dataRows && c < dataCols;
      const td = el('td', `faisal-office-celld fo-td ${inData ? 'faisal-office-cell' : 'fo-cell-empty'}`);
      td.style.height = `${height}px`;
      if (frozenTop) td.style.top = frozenTop;
      if (c < frozenCols) frozeColumn(td, c);
      // DRAWN coordinates (`data-drawn`: what the selection and the fill handle walk) and the MODEL
      // row (`data-r`: where the data lives — blank for a row below a filtered sheet).
      td.dataset.drawn = String(r);
      td.dataset.r = blank ? '' : String(mr);
      td.dataset.c = String(c);
      const merge = blank ? undefined : mergeAt.get(`${mr}:${c}`);
      if (merge) { td.rowSpan = merge.r1 - mr + 1; td.colSpan = merge.c1 - c + 1; }
      // With a filter on, the blank rows below the visible data take no typing: a row the filter
      // hid must never be edited through a row that merely looks empty (clear the filter first).
      if (!ctx.editable() || (blank && !!rowMap)) td.setAttribute('aria-readonly', 'true');
      const view = el('span', 'fo-cellview');
      const value = blank ? '' : grid?.rows[mr]?.[c] ?? '';
      const s = blank ? undefined : styleAt(mr, c);
      // A chosen number format wins over the file's own: the owner asked for it just now.
      const chosen = blank ? '' : formatForCell(sheetView.formats, mr, c);
      view.textContent = chosen ? displayText(value, chosen, getLocale() === 'ar' ? 'ar' : 'en') : displayValue(value, s?.numFmt);
      styleCell(td, view, s, value);
      styleConditional(td, view, blank ? null : rules?.[c] ?? null);
      if (!blank && value !== '') markLink(view, mr, c);
      td.append(view);
      if (!blank) decorateCell(td, mr, c);
      tr.append(td);
      rec.tds.push(td);
      rec.views.push(view);
      rec.cols.push(c);
    }
    rowCells.set(r, rec);
    return rec;
  }

  /* ─────────────────────── pointer: one set of listeners for every cell ─────────────────────── */

  /** The drawn cell an event happened in (the cells carry no listeners of their own). */
  function cellOf(target: EventTarget | null): { td: HTMLTableCellElement; row: number; col: number } | null {
    const node = target instanceof Element ? target : null;
    const td = node?.closest<HTMLTableCellElement>('.fo-td');
    if (!td || td.dataset.drawn === undefined || !scroll.contains(td)) return null;
    return { td, row: Number(td.dataset.drawn), col: Number(td.dataset.c) };
  }
  /** A tap on the cell that is already active opens the editor (the phone's F2). */
  let tapToEdit = false;

  scroll.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const hit = cellOf(ev.target);
    if (!hit || (ev.target as Element).closest('.fo-celleditor, .fo-listbtn, .fo-fillhandle, .fo-filterbtn')) return;
    if (editAt) commitEdit(0, 0, false);
    // Ctrl+click (Cmd on a Mac) opens a link cell, as in Excel; only http(s) and mailto ever open.
    if (ev.ctrlKey || ev.metaKey) {
      const mr = modelRowOf(hit.row);
      const url = mr >= 0 ? hyperlinkOf(rawOf(mr, hit.col)) : null;
      if (url) { ev.preventDefault(); window.open(url, '_blank', 'noopener,noreferrer'); return; }
    }
    const single = anchor.row === active.row && anchor.col === active.col;
    tapToEdit = ev.pointerType !== 'mouse' && isCoarsePointer() && !ev.shiftKey && single && hit.row === active.row && hit.col === active.col;
    if (ev.shiftKey) { ev.preventDefault(); active = { row: hit.row, col: hit.col }; select(false); return; }
    // A finger drag scrolls the sheet; a mouse (or pen) drag selects — without the browser moving
    // the focus to the scroll box or starting a text selection.
    dragging = ev.pointerType !== 'touch';
    if (dragging) ev.preventDefault();
    anchor = { row: hit.row, col: hit.col };
    active = anchor;
    paintSelection();
    showResult();
    focusGrid();
    ctx.refresh();
  });
  const onCellEnter = (ev: Event): void => {
    const hit = cellOf(ev.target);
    if (hit) enterCell(hit.row, hit.col);
  };
  scroll.addEventListener('pointerover', onCellEnter);
  scroll.addEventListener('pointerenter', onCellEnter);
  /** The pointer is over a drawn cell: a fill drag previews, a selection drag extends. */
  function enterCell(r: number, c: number): void {
    if (filling) {
      // The live preview: which cells the release would write, marked while the pointer is
      // over them. Nothing is written until the pointer goes up.
      fillTarget = fillSource ? fillPlan(fillSource, { row: r, col: c }) : null;
      fillPreview = fillSource && fillTarget ? fillCells(fillSource, fillTarget) : [];
      paintFillPreview();
      return;
    }
    if (!dragging || (active.row === r && active.col === c)) return;
    active = { row: r, col: c };
    paintSelection();
  }
  scroll.addEventListener('click', (ev) => {
    if (!tapToEdit) return;
    tapToEdit = false;
    if (cellOf(ev.target)) startEdit(null);
  });
  scroll.addEventListener('dblclick', (ev) => {
    if ((ev.target as Element).closest?.('.fo-celleditor') || !cellOf(ev.target)) return;
    startEdit(null);
  });

  /* ─────────────────────────── the floating editor ─────────────────────────── */
  //
  // Between entries the editor waits, invisible, on the active cell and holds the keyboard focus
  // (on a touch screen the grid itself does, so the on-screen keyboard only opens on purpose).
  // Arrows, Tab, Enter, F2, Delete, copy and paste are the grid's; a typed character — from a key,
  // an input method or dictation alike — lands in the waiting editor and opens the entry with it.

  /** The editor is only waiting on the active cell (no entry is open). */
  const idle = (): boolean => !editAt;

  /** Parks the waiting editor on the active cell (after a move, a redraw, a scroll). */
  function parkEditor(): void {
    if (editAt || isCoarsePointer()) return;
    const host = tds.get(`${active.row}:${active.col}`);
    const mr = modelRowOf(active.row);
    cellEditor.readOnly = !ctx.editable() || mr < 0;
    cellEditor.classList.add('is-idle');
    cellEditor.setAttribute('aria-label', mr >= 0 ? `${columnName(active.col)}${mr + 1}` : columnName(active.col));
    if (host && cellEditor.parentElement !== host) {
      const had = document.activeElement === cellEditor;
      host.append(cellEditor);
      if (had) cellEditor.focus({ preventScroll: true });
    }
    if (!host && cellEditor.parentElement) {
      // The active cell scrolled out of the window: the grid keeps the keyboard until it is back.
      const had = document.activeElement === cellEditor;
      cellEditor.remove();
      if (had) scroll.focus({ preventScroll: true });
    }
  }

  /** Gives the keyboard to the sheet: the waiting editor on a desktop, the grid itself on touch. */
  function focusGrid(): void {
    parkEditor();
    const target = !isCoarsePointer() && cellEditor.isConnected && cellEditor.classList.contains('is-idle') ? cellEditor : scroll;
    if (document.activeElement !== target) target.focus({ preventScroll: true });
  }

  /** Whether the keyboard is the grid's (between entries). */
  const gridHasFocus = (): boolean => document.activeElement === scroll || (document.activeElement === cellEditor && idle());

  /**
   * Opens the editor over the active cell: `text` starts a new entry (a typed key), `null` edits
   * what is there (F2, a double-click, a tap). The formula bar opens it without taking the focus.
   */
  function startEdit(text: string | null, focus = true): boolean {
    if (!ctx.editable() || !sheets() || editAt) return false;
    const mr = modelRowOf(active.row);
    if (mr < 0) return false;                    // a blank row below a filtered sheet takes nothing
    revealRow(active.row);
    revealCol(active.col);
    updateWindow();
    const host = tds.get(`${active.row}:${active.col}`);
    if (!host) return false;
    editAt = { row: active.row, mr, col: active.col };
    editMode = text === null ? 'edit' : 'enter';
    cellEditor.value = text ?? rawOf(mr, active.col);
    showEditor(host, mr);
    fx.value = cellEditor.value;
    if (!focus) return true;
    cellEditor.focus({ preventScroll: true });
    const end = cellEditor.value.length;
    try { cellEditor.setSelectionRange(end, end); } catch { /* not a text field in every engine */ }
    return true;
  }

  /** Makes the editor visible over its cell, in the cell's own font. */
  function showEditor(host: HTMLTableCellElement, mr: number): void {
    const view = viewOf.get(`${active.row}:${active.col}`);
    const st = cellEditor.style;
    st.fontWeight = view?.style.fontWeight ?? '';
    st.fontStyle = view?.style.fontStyle ?? '';
    st.fontSize = view?.style.fontSize ?? '';
    st.fontFamily = view?.style.fontFamily ?? '';
    cellEditor.readOnly = false;
    cellEditor.classList.remove('is-idle');
    cellEditor.setAttribute('aria-label', `${columnName(active.col)}${mr + 1}`);
    host.classList.add('is-editing');
    if (cellEditor.parentElement !== host) host.append(cellEditor);
    root.classList.add('is-editing');
  }

  /** A character reached the waiting editor: the entry opens with it (Excel's "enter" mode). */
  function beginFromIdle(): void {
    const mr = modelRowOf(active.row);
    const host = tds.get(`${active.row}:${active.col}`);
    if (!ctx.editable() || mr < 0 || !host) { cellEditor.value = ''; return; }
    editAt = { row: active.row, mr, col: active.col };
    editMode = 'enter';
    showEditor(host, mr);
  }

  function closeEditor(): void {
    cellEditor.parentElement?.classList.remove('is-editing');
    editAt = null;
    cellEditor.value = '';
    cellEditor.classList.add('is-idle');
    root.classList.remove('is-editing');
  }

  /** Writes the entry (one undoable edit), checks it, then moves as Enter, Tab or an arrow asks. */
  function commitEdit(dr: number, dc: number, refocus = true): void {
    const at = editAt;
    if (!at) return;
    const text = cellEditor.value;
    const hadFocus = document.activeElement === cellEditor;
    closeEditor();
    commitCell(at.mr, at.col, text);
    checkEntry(at.mr, at.col);
    if (dr || dc) move(dr, dc, false);
    else if (refocus || hadFocus) focusGrid();
    else parkEditor();
    syncBars();
  }

  /** Esc: the cell keeps what it had. */
  function cancelEdit(): void {
    if (!editAt) return;
    closeEditor();
    focusGrid();
    syncBars();
  }

  cellEditor.addEventListener('compositionstart', () => { if (idle()) beginFromIdle(); });
  cellEditor.addEventListener('input', () => {
    if (idle()) beginFromIdle();
    fx.value = cellEditor.value;
  });
  cellEditor.addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    const k = ev.key.toLowerCase();
    if (idle()) {
      // Waiting: the key is the grid's. Undo/redo/save go on to the window.
      if (mod && ['z', 'y', 's', 'o', 'p'].includes(k)) return;
      handleGridKey(ev, true);
      return;
    }
    // Undo and redo while typing are the field's own (the window's would undo the sheet under it).
    if (mod && (k === 'z' || k === 'y')) { ev.stopPropagation(); return; }
    // A save writes what is being typed too.
    if (mod && k === 's') { commitEdit(0, 0); return; }
    const action = editorKey(ev, editMode, sheetRtl);
    if (action.kind === 'type') return;
    ev.preventDefault();
    ev.stopPropagation();
    if (action.kind === 'cancel') cancelEdit(); else commitEdit(action.dr, action.dc);
  });
  cellEditor.addEventListener('blur', (ev) => {
    // Moving into the formula bar keeps the same entry open; anywhere else writes it.
    if (!editAt || ev.relatedTarget === fx) return;
    commitEdit(0, 0, false);
  });

  /* ─────────────────────────── moving around ─────────────────────────── */

  /** Scrolls `row` into view (below the sticky header) so it can be drawn and focused. */
  function revealRow(row: number): void {
    if (!offsets) return;
    const top = offsets[row];
    const bottom = offsets[Math.min(row + 1, rowCount)];
    const view = Math.max(0, scroll.clientHeight - HEADER_HEIGHT);
    if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (view > 0 && bottom > scroll.scrollTop + view) scroll.scrollTop = bottom - view;
  }

  /** Scrolls column `col` into view beside the sticky row numbers (either direction). */
  function revealCol(col: number): void {
    let start = 0;
    for (let i = 0; i < col; i++) start += widthOf(i);
    const end = start + widthOf(col);
    const view = Math.max(0, scroll.clientWidth - 48);
    const cur = Math.abs(scroll.scrollLeft);
    let next = cur;
    if (start < cur) next = start;
    else if (view > 0 && end > cur + view) next = end - view;
    if (next !== cur) scroll.scrollLeft = sheetRtl ? -next : next;
  }

  /** Makes the active cell exist in the document (scrolling to it if it is out of the window). */
  function focusCell(row: number, col: number): void {
    revealRow(row);
    revealCol(col);
    updateWindow();
    focusGrid();
  }
  document.addEventListener('pointerup', onPointerUp);
  function onPointerUp(): void {
    // A fill drag ends here: the preview becomes one edit (or nothing, if it never left the source).
    if (filling) { applyFill(); return; }
    if (!dragging) return;
    dragging = false;
    paintSelection();
    if (painter) applyPainter();
    ctx.refresh();
  }

  function refreshValues(): void {
    const m = sheets();
    if (!m) return;
    const grid = m.grids[m.active];
    for (const [key, view] of viewOf) {
      const [r, c] = key.split(':').map(Number);
      // `key` holds drawn rows; the data lives at the model row a filter maps them to.
      const mr = modelRowOf(r);
      if (mr < 0) continue;
      const chosen = formatForCell(sheetView.formats, mr, c);
      const raw = grid?.rows[mr]?.[c] ?? '';
      const s = styleAt(mr, c);
      view.textContent = chosen ? displayText(raw, chosen, getLocale() === 'ar' ? 'ar' : 'en') : displayValue(raw, s?.numFmt);
      alignCell(view, s, raw);
      markLink(view, mr, c);
      const td = tds.get(key);
      if (td) styleConditional(td, view, condCache[r]?.[c] ?? null);
    }
    // A sheet whose file has no widths keeps its columns fitted while the owner types.
    if (fitsOnOpen() && !fmtOf()?.cols?.[active.col] && colEls[active.col]) {
      const fitted = Math.max(lookOf()?.defaultWidth ?? DEFAULT_COL_WIDTH, fitWidth(active.col));
      autoWidths.set(active.col, fitted);
      colEls[active.col].style.width = `${fitted}px`;
      fitTableWidth();
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

  /* ─────────────────────────── the fill handle ─────────────────────────── */
  // A small square on the corner of the selection: drag it to copy the source cells or continue
  // their series. The maths lives in `fill.ts`; this is only the dragging, the live preview and
  // the single edit it commits. Every target row is mapped through `modelRowOf`, so a drag can
  // never write into a row an active filter hid (the rule slice #108 rests on).
  const fillHandle = el('span', 'fo-fillhandle');
  fillHandle.setAttribute('role', 'button');
  fillHandle.setAttribute('aria-label', t('office.fillHandle'));
  fillHandle.title = t('office.fillHandle');
  fillHandle.hidden = true;
  let filling = false;
  let fillSource: FillRect | null = null;
  let fillTarget: FillPlan | null = null;
  let fillPreview: Array<{ row: number; col: number }> = [];

  fillHandle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !ctx.editable()) return;
    ev.preventDefault();
    ev.stopPropagation();                       // never start a selection drag from the handle
    filling = true;
    fillSource = range();
    fillTarget = null;
    fillPreview = [];
    try { fillHandle.setPointerCapture(ev.pointerId); } catch { /* no capture outside a browser */ }
  });

  /** Marks the cells the release would write. Preview only — the model is untouched. */
  function paintFillPreview(): void {
    for (const [, td] of tds) td.classList.remove('is-fillpreview');
    if (!filling) return;
    for (const at of fillPreview) tds.get(`${at.row}:${at.col}`)?.classList.add('is-fillpreview');
  }

  /** Writes the previewed fill as ONE undoable edit (a rejected cell leaves the edit empty). */
  function applyFill(): void {
    const m = sheets();
    const source = fillSource;
    const plan = fillTarget;
    const cells = fillPreview;
    filling = false;
    fillSource = null;
    fillTarget = null;
    fillPreview = [];
    for (const [, td] of tds) td.classList.remove('is-fillpreview');
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid || !source || !plan || !cells.length || !ctx.editable()) { paintSelection(); return; }

    // One series per line of the source: each column for a vertical drag, each row for a
    // horizontal one — exactly how a spreadsheet fills a block.
    const vertical = plan.direction === 'down' || plan.direction === 'up';
    const lines: Array<{ values: string[]; row: number; col: number }> = [];
    if (vertical) {
      for (let c = source.c0; c <= source.c1; c++) {
        const values: string[] = [];
        for (let r = source.r0; r <= source.r1; r++) { const mr = modelRowOf(r); values.push(mr < 0 ? '' : rawOf(mr, c)); }
        lines.push({ values, row: source.r0, col: c });
      }
    } else {
      for (let r = source.r0; r <= source.r1; r++) {
        const mr = modelRowOf(r);
        const values: string[] = [];
        for (let c = source.c0; c <= source.c1; c++) values.push(mr < 0 ? '' : rawOf(mr, c));
        lines.push({ values, row: r, col: source.c0 });
      }
    }
    const series = lines.map((line) => seriesFrom(line.values, plan.direction, plan.count));
    const backwards = plan.direction === 'up' || plan.direction === 'left';
    /** Which value of a line's series a cell at `step` (1-based, from the source edge) takes. */
    const at = (step: number): number => (backwards ? plan.count - step : step - 1);

    const edits: Edit[] = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      for (let step = 1; step <= plan.count; step++) {
        const row = vertical ? (plan.direction === 'down' ? source.r1 + step : source.r0 - step) : line.row;
        const col = vertical ? line.col : (plan.direction === 'right' ? source.c1 + step : source.c0 - step);
        const mr = modelRowOf(row);
        if (mr < 0) continue;                    // a hidden row or a blank row below the data
        let text = series[li][at(step)] ?? '';
        if (text.trimStart().startsWith('=')) {
          // A formula copies the way Excel copies it: its relative references move with the cell.
          const index = copyIndex(backwards ? -step : step, line.values.length);
          const fromRow = vertical ? source.r0 + index : line.row;
          const fromCol = vertical ? line.col : source.c0 + index;
          const fromMr = modelRowOf(fromRow);
          text = translateFormula(text, fromMr < 0 ? 0 : mr - fromMr, col - fromCol);
        }
        const before = cellState(mr, col);
        const after = cellStateFor(text, mr, col, m.active);
        if (after.value === before.value && (after.formula ?? null) === (before.formula ?? null)) continue;
        edits.push(formulaCellEdit(m.active, mr, col, before, after));
      }
    }
    if (edits.length) {
      ctx.commit(compositeEdit(edits));          // one edit: one undo puts the whole fill back
      refreshValues();
      ctx.setStatus(t('office.filled', { n: edits.length }));
    }
    paintSelection();
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
    // The handle rides on the corner of the selection — the cell the fill would continue from.
    // While a drag is running it stays there, so the pointer can leave the source and come back.
    const corner = (filling && fillSource ? fillSource : g);
    fillHandle.remove();
    const host = tds.get(`${corner.r1}:${corner.c1}`);
    const showHandle = ctx.editable() && !!host;
    if (host) {
      host.append(fillHandle);
      host.classList.add('has-fillhandle');
    }
    fillHandle.hidden = !showHandle;
    for (const [key, td] of tds) if (key !== `${corner.r1}:${corner.c1}`) td.classList.remove('has-fillhandle');
    syncBars();
  }

  function syncBars(): void {
    if (document.activeElement !== nameBox) nameBox.value = refName();
    if (document.activeElement !== fx) fx.value = rawOf(modelRowOf(active.row), active.col);
    fx.readOnly = !ctx.editable();
  }

  function select(fromFocus: boolean): void {
    paintSelection();
    if (!fromFocus) focusCell(active.row, active.col);
    showResult();
    ctx.refresh();
  }

  /** Puts the active cell at `to` (Shift keeps the anchor, so the selection grows). */
  function goTo(to: Cell, extend: boolean): void {
    active = to;
    if (!extend) anchor = active;
    // The target may be outside the drawn window: this scrolls to it and draws it.
    focusCell(active.row, active.col);
    paintSelection();
    showResult();
    ctx.refresh();
  }

  /** The last drawn row the caret may reach: inside the rows a filter left visible. */
  const lastNavRow = (): number => (rowMap ? Math.max(0, rowMap.length - 1) : Math.max(0, rowCount - 1));

  function move(dr: number, dc: number, extend: boolean): void {
    goTo({
      row: Math.max(0, Math.min(lastNavRow(), active.row + dr)),
      col: Math.max(0, Math.min(cols - 1, active.col + dc)),
    }, extend);
  }

  /** Whether the drawn cell holds anything (Ctrl+arrow stops at the edges of the data). */
  function filledAt(r: number, c: number): boolean {
    const m = sheets();
    const mr = modelRowOf(r);
    return !!m && mr >= 0 && (gridAt(m, m.active)?.rows[mr]?.[c] ?? '') !== '';
  }

  scroll.addEventListener('keydown', (ev) => {
    if (ev.target !== scroll) return;            // the editor, a list button, a filter arrow: their own keys
    handleGridKey(ev, false);
  });

  /**
   * A key pressed between entries. `inEditor`: it reached the waiting editor, so a typed character
   * is left to land in it (the input event opens the entry); from the grid itself the entry is
   * opened here with that character.
   */
  function handleGridKey(ev: KeyboardEvent, inEditor: boolean): void {
    const m = sheets();
    if (!m) return;
    const grid = gridAt(m, m.active);
    const used = lastUsedCell(grid?.rows ?? []);
    const action = gridKey(ev, {
      active,
      rtl: sheetRtl,
      bounds: { lastRow: lastNavRow(), lastCol: cols - 1 },
      page: Math.max(1, Math.floor((scroll.clientHeight - HEADER_HEIGHT) / rowHeight) - 1),
      lastUsed: { row: drawnRowOf(used.row), col: used.col },
      filled: filledAt,
      editable: ctx.editable(),
    });
    switch (action.kind) {
      case 'move': ev.preventDefault(); goTo(action.to, action.extend); return;
      case 'edit':
        if (inEditor && action.text !== null) return;   // the character types itself into the waiting editor
        ev.preventDefault();
        startEdit(action.text);
        return;
      case 'clear': ev.preventDefault(); clearRange(); return;
      case 'selectAll': {
        ev.preventDefault();
        anchor = { row: 0, col: 0 };
        active = { row: Math.max(0, drawnRowOf(used.row)), col: Math.max(0, dataCols - 1) };
        select(true);
        return;
      }
      default:
        // An input method (Arabic, Japanese…) announces itself without a character: open an empty
        // entry and let the composition land in it.
        if (!inEditor && (ev.key === 'Process' || ev.keyCode === 229) && ctx.editable()) startEdit('');
    }
  }

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

  /** The selection as TSV (what other spreadsheets read from the clipboard). */
  function selectionTsv(): string {
    const g = range();
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    const rows: string[][] = [];
    for (let r = g.r0; r <= g.r1; r++) { const mr = modelRowOf(r); const row: string[] = []; for (let c = g.c0; c <= g.c1; c++) row.push(mr < 0 ? '' : grid?.rows[mr]?.[c] ?? ''); rows.push(row); }
    return toTsv(rows);
  }
  /** Copy and cut act on the grid only; an open entry, the formula bar and the name box keep their own. */
  root.addEventListener('copy', (ev) => {
    if (!gridHasFocus()) return;
    ev.clipboardData?.setData('text/plain', selectionTsv());
    ev.preventDefault();
  });
  root.addEventListener('cut', (ev) => {
    if (!gridHasFocus()) return;
    ev.clipboardData?.setData('text/plain', selectionTsv());
    ev.preventDefault();
    if (ctx.editable()) clearRange();
  });
  root.addEventListener('paste', (ev) => {
    if (!gridHasFocus() || !ctx.editable()) return;
    ev.preventDefault();
    pasteText(ev.clipboardData?.getData('text/plain') ?? '');
  });

  /** Pastes TSV (or one value) from the active cell down and across, as one edit, and selects it. */
  function pasteText(text: string): void {
    if (!ctx.editable()) return;
    const m = sheets();
    if (!m) return;
    const base = modelRowOf(active.row);
    if (base < 0) return;                        // a blank row below a filtered sheet takes nothing
    const rows = parseTsv(text.replace(/\r?\n$/, ''));
    const edits: Edit[] = [];
    rows.forEach((row, dr) => row.forEach((value, dc) => {
      const r = base + dr;
      const c = active.col + dc;
      const before = cellState(r, c);
      const after = cellStateFor(value, r, c, m.active);
      if (after.value !== before.value || (after.formula ?? null) !== (before.formula ?? null)) edits.push(formulaCellEdit(m.active, r, c, before, after));
    }));
    if (!edits.length) return;
    ctx.commit(compositeEdit(edits));
    // The pasted block is selected, as a spreadsheet does.
    const height = Math.max(1, rows.length);
    const width = Math.max(1, ...rows.map((r) => r.length));
    // The pasted block is selected with the cursor on its first cell, as a spreadsheet does.
    anchor = { row: drawnRowOf(base + height - 1), col: active.col + width - 1 };
    active = { row: drawnRowOf(base), col: active.col };
    renderGrid();
  }

  // The formula bar is a second way into the same entry: typing there opens the editor on the cell
  // (without taking the focus) and keeps both in step; Enter, Tab and Esc work as in the cell.
  fx.addEventListener('input', () => {
    if (!ctx.editable()) return;
    if (!editAt) { startEdit(fx.value, false); editMode = 'edit'; }
    if (editAt) cellEditor.value = fx.value;
  });
  fx.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault();
      if (editAt) commitEdit(ev.key === 'Tab' ? 0 : ev.shiftKey ? -1 : 1, ev.key === 'Tab' ? (ev.shiftKey ? -1 : 1) : 0);
      else move(ev.key === 'Tab' ? 0 : 1, ev.key === 'Tab' ? 1 : 0, false);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (editAt) cancelEdit(); else focusGrid();
      fx.value = rawOf(modelRowOf(active.row), active.col);
    }
  });
  fx.addEventListener('blur', (ev) => {
    if (editAt && ev.relatedTarget !== cellEditor) commitEdit(0, 0, false);
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

  /* ─────────────────────────── widths and heights ─────────────────────────── */

  /**
   * A fixed-layout table as wide as its columns: without it a narrow window (a
   * phone) squeezes every column to fit and cuts the text in them.
   */
  function fitTableWidth(tbl: HTMLTableElement | null = table): void {
    if (!tbl) return;
    let total = 48;
    for (const col of colEls) total += parseFloat(col.style.width) || DEFAULT_COL_WIDTH;
    tbl.style.width = `${total}px`;
    tbl.style.minWidth = `${total}px`;
  }

  /** Commits a new formatting for the active sheet (one undo step) and redraws. */
  function commitFormat(change: (fmt: SheetFormat | undefined) => SheetFormat | undefined): void {
    const m = sheets();
    if (!m || m.kind !== 'xlsx' || !ctx.editable()) return;
    const before = sheetFormatOf(m, m.active);
    const after = change(before);
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return;
    ctx.commit(sheetFormatEdit(m.active, before, after));
    renderGrid();
    ctx.refresh();
  }
  const canFormat = (): boolean => sheets()?.kind === 'xlsx' && ctx.editable();

  function setColWidth(c: number, px: number): void {
    commitFormat((f) => withColumnWidth(f, c, clampColWidth(px)));
  }
  function fitColumn(c: number): void {
    setColWidth(c, Math.min(MAX_COL_WIDTH, fitWidth(c)));
  }
  function fitRow(mr: number): void {
    // Excel's double-click on a row border: as tall as its tallest wrapped cell, else back to the default.
    let tallest = 0;
    const drawn = drawnRowOf(mr);
    for (const [key, td] of tds) {
      if (!key.startsWith(`${drawn}:`)) continue;
      const view = td.querySelector<HTMLElement>('.fo-cellview.is-wrap');
      if (view) tallest = Math.max(tallest, view.scrollHeight);
    }
    commitFormat((f) => withRowHeight(f, mr, tallest > 0 ? Math.min(MAX_ROW_HEIGHT, tallest + 4) : null));
  }

  /** A drag handler with a double-act (double-click or double-tap) of its own. */
  function dragGrip(grip: HTMLElement, onDouble: () => void, onDrag: (dx: number, dy: number) => void, onEnd: (moved: boolean) => void): void {
    let last = { at: -1e9, x: 0 };
    grip.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !canFormat()) return;
      ev.preventDefault();
      ev.stopPropagation();
      const now = performance.now();
      if (isDoubleAct(last.at, last.x, now, ev.clientX)) { last = { at: -1e9, x: 0 }; onDouble(); return; }
      last = { at: now, x: ev.clientX };
      const startX = ev.clientX;
      const startY = ev.clientY;
      let moved = false;
      try { grip.setPointerCapture(ev.pointerId); } catch { /* the move events still reach the grip while the pointer is over it */ }
      root.classList.add('is-resizing');
      const move = (e: PointerEvent): void => {
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 2) moved = true;
        onDrag((e.clientX - startX) / zoom, (e.clientY - startY) / zoom);
      };
      const done = (): void => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', done);
        grip.removeEventListener('pointercancel', done);
        root.classList.remove('is-resizing');
        onEnd(moved);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', done);
      grip.addEventListener('pointercancel', done);
    });
    grip.addEventListener('click', (ev) => ev.stopPropagation());
  }

  function colGrip(c: number): HTMLElement {
    const grip = el('span', 'fo-colgrip');
    grip.setAttribute('aria-hidden', 'true');
    grip.title = t('office.resizeColumnHint');
    let start = 0;
    let width = 0;
    dragGrip(grip, () => fitColumn(c), (dx) => {
      if (!start) start = widthOf(c);
      // The trailing border of a right-to-left sheet's column is its left edge.
      width = draggedWidth(start, 0, scroll.dir === 'rtl' ? -dx : dx);
      const col = colEls[c];
      if (col) col.style.width = `${width}px`;
      fitTableWidth();
    }, (moved) => {
      if (moved && width && width !== start) setColWidth(c, width);
      start = 0;
      width = 0;
    });
    return grip;
  }

  function rowGrip(mr: number, tr: HTMLTableRowElement): HTMLElement {
    const grip = el('span', 'fo-rowgrip');
    grip.setAttribute('aria-hidden', 'true');
    grip.title = t('office.resizeRowHint');
    let start = 0;
    let height = 0;
    dragGrip(grip, () => fitRow(mr), (_dx, dy) => {
      if (!start) start = tr.getBoundingClientRect().height / zoom || 24;
      height = draggedHeight(start, 0, dy);
      tr.style.height = `${height}px`;
    }, (moved) => {
      if (moved && height && height !== start) commitFormat((f) => withRowHeight(f, mr, height));
      start = 0;
      height = 0;
    });
    return grip;
  }

  /** "Column width…" / "Row height…": the keyboard's and the phone's way, where a border is hard to grab. */
  function askSize(kind: 'col' | 'row'): void {
    const label = kind === 'col' ? t('office.columnWidthPx') : t('office.rowHeightPx');
    const input = el('input', 'fo-input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = String(kind === 'col' ? 28 : MIN_ROW_HEIGHT);
    input.max = String(kind === 'col' ? MAX_COL_WIDTH : MAX_ROW_HEIGHT);
    input.value = String(Math.round(kind === 'col' ? widthOf(active.col) : rowHeightOf(active.row)));
    const body = el('label', 'fo-field');
    body.append(el('span', 'fo-field-label', label), input);
    const g = range();
    openModal({
      title: kind === 'col' ? t('office.columnWidth') : t('office.rowHeight'),
      body, okLabel: t('office.apply'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v <= 0) return false;
        commitFormat((f) => {
          let next = f;
          if (kind === 'col') for (let c = g.c0; c <= g.c1; c++) next = withColumnWidth(next, c, clampColWidth(v));
          else for (let r = g.r0; r <= g.r1; r++) { const mr = modelRowOf(r); if (mr >= 0) next = withRowHeight(next, mr, draggedHeight(v, 0, 0)); }
          return next;
        });
        return true;
      },
    });
  }
  function fitSelectedColumns(): void {
    const g = range();
    commitFormat((f) => {
      let next = f;
      for (let c = g.c0; c <= g.c1; c++) next = withColumnWidth(next, c, Math.min(MAX_COL_WIDTH, fitWidth(c)));
      return next;
    });
  }

  /* ─────────────────────────── cell formatting (saved into styles.xml) ─────────────────────────── */

  const activeStyle = (): CellStyle | undefined => {
    const mr = modelRowOf(active.row);
    return mr < 0 ? undefined : styleAt(mr, active.col);
  };
  /** Applies a format delta to every selected cell, at its model row (a filter may skip rows). */
  function formatSelection(patch: CellFormat | ((row: number, col: number) => CellFormat)): void {
    const g = range();
    commitFormat((f) => {
      let next = f;
      for (let r = g.r0; r <= g.r1; r++) {
        const mr = modelRowOf(r);
        if (mr < 0) continue;
        for (let c = g.c0; c <= g.c1; c++) {
          const p = typeof patch === 'function' ? patch(r, c) : patch;
          if (Object.keys(p).length) next = formatRange(next, { r0: mr, c0: c, r1: mr, c1: c }, p);
        }
      }
      return next;
    });
  }
  function toggleStyle(key: 'bold' | 'italic' | 'underline' | 'strike' | 'wrap'): void {
    formatSelection({ [key]: !activeStyle()?.[key] });
  }
  function setBorders(preset: BorderPreset): void {
    formatSelection(borderPatch(preset, range()));
  }
  const alignOf = (): string => activeStyle()?.hAlign ?? '';
  /** One more or one fewer decimal place, through the sheet's own number-format choice. */
  function changeDecimals(delta: 1 | -1): void {
    const mr = modelRowOf(active.row);
    const code = (mr >= 0 ? formatForCell(sheetView.formats, mr, active.col) : '') || activeStyle()?.numFmt || '';
    applyNumberFormat(stepDecimals(code && code !== 'General' && code !== '@' ? code : '0', delta));
  }

  /* ─────────────────────────── data validation ─────────────────────────── */

  const validations = new Map<number, RangedValidation[]>();
  const validationsOf = (): RangedValidation[] => validations.get(sheets()?.active ?? 0) ?? [];
  /** The selection in model rows (validation rules are kept by the sheet's own rows). */
  function modelSelection(): SheetRange {
    const g = range();
    const a = modelRowOf(g.r0);
    const b = modelRowOf(g.r1);
    return { r0: a < 0 ? g.r0 : a, r1: b < 0 ? Math.max(a, g.r1) : b, c0: g.c0, c1: g.c1 };
  }
  function decorateCell(td: HTMLTableCellElement, mr: number, c: number): void {
    const rule = validationAt(validationsOf(), mr, c);
    if (rule?.kind === 'list' && ctx.editable()) td.append(listButton(mr, c, rule.items));
  }
  function listButton(mr: number, c: number, items: readonly string[]): HTMLElement {
    const b = el('button', 'fo-listbtn');
    b.type = 'button';
    b.title = t('office.chooseFromList');
    b.setAttribute('aria-label', `${t('office.chooseFromList')} ${columnName(c)}${mr + 1}`);
    b.setAttribute('aria-haspopup', 'menu');
    b.append(icon('chevronDown', 14));
    b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const pop = openPopover(b, menuList(items.map((item) => ({ label: item, run: () => { commitCell(mr, c, item); refreshValues(); } })), () => pop.close()), { label: t('office.chooseFromList') });
    });
    return b;
  }
  /** Checks an entry against the cell's rule and for a circular reference, and says what is wrong. */
  function checkEntry(mr: number, c: number, td?: HTMLTableCellElement | null): void {
    const cellTd = td ?? tds.get(`${drawnRowOf(mr)}:${c}`);
    const m = sheets();
    if (m && m.kind === 'xlsx' && formulaAt(m, m.active, mr, c) && isCircularAt(m, mr, c)) {
      cellTd?.classList.add('is-invalid');
      ctx.setStatus(t('office.circularWarning', { cell: `${columnName(c)}${mr + 1}` }));
      return;
    }
    const rule = validationAt(validationsOf(), mr, c);
    if (!rule) { cellTd?.classList.remove('is-invalid'); return; }
    const problem = validationProblem(cellState(mr, c).value, rule);
    cellTd?.classList.toggle('is-invalid', !!problem);
    if (problem) ctx.setStatus(`${problem.prefix ? t('office.validation_lengthPrefix') : ''}${t(problem.key, problem.params)}`);
  }
  function validationDialog(): void {
    const within = modelSelection();
    const body = el('div', 'fo-validdlg');
    const field = (label: string, input: HTMLElement): HTMLElement => { const f = el('label', 'fo-field'); f.append(el('span', 'fo-field-label', label), input); return f; };
    const kind = el('select', 'fo-select');
    for (const k of ['list', 'whole', 'decimal', 'date', 'textLength'] as const) { const o = el('option', undefined, t(`office.valid_${k}`)); o.value = k; kind.append(o); }
    const items = el('input', 'fo-input');
    items.dir = 'auto';
    items.placeholder = t('office.listItemsHint');
    const op = el('select', 'fo-select');
    for (const k of ['between', 'notBetween', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte'] as const) { const o = el('option', undefined, t(`office.op_${k}`)); o.value = k; op.append(o); }
    const min = el('input', 'fo-input');
    const max = el('input', 'fo-input');
    const listF = field(t('office.listItems'), items);
    const opF = field(t('office.filterCondition'), op);
    const minF = field(t('office.minimum'), min);
    const maxF = field(t('office.maximum'), max);
    const blank = el('input');
    blank.type = 'checkbox';
    blank.checked = true;
    const blankLine = el('label', 'fo-check');
    blankLine.append(blank, el('span', undefined, t('office.allowBlank')));
    const sync = (): void => {
      const list = kind.value === 'list';
      listF.hidden = !list;
      opF.hidden = list;
      minF.hidden = list;
      maxF.hidden = list || !['between', 'notBetween'].includes(op.value);
    };
    kind.addEventListener('change', sync);
    op.addEventListener('change', sync);
    body.append(field(t('office.allow'), kind), listF, opF, minF, maxF, blankLine);
    sync();
    openModal({
      title: t('office.dataValidation'), body, okLabel: t('office.apply'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => {
        let rule: ValidationRule;
        const allowBlank = blank.checked;
        if (kind.value === 'list') {
          const list = parseListSource(items.value);
          if (!list.length) return false;
          rule = { kind: 'list', items: list, allowBlank };
        } else {
          const num = (x: string): number | undefined => (x.trim() === '' ? undefined : Number(x));
          const a = kind.value === 'date' ? min.value.trim() || undefined : num(min.value);
          const b = kind.value === 'date' ? max.value.trim() || undefined : num(max.value);
          if (a === undefined || (typeof a === 'number' && !Number.isFinite(a))) return false;
          rule = kind.value === 'date'
            ? { kind: 'date', op: op.value as CompareOp, min: a, max: b, allowBlank }
            : { kind: kind.value as 'whole' | 'decimal' | 'textLength', op: op.value as CompareOp, min: a as number, max: b as number | undefined, allowBlank };
        }
        const m = sheets();
        if (!m) return true;
        validations.set(m.active, [...withoutRules(validationsOf(), within), { range: within, rule }]);
        renderGrid();
        ctx.refresh();
        return true;
      },
    });
  }
  function clearValidation(): void {
    const m = sheets();
    if (!m) return;
    validations.set(m.active, withoutRules(validationsOf(), modelSelection()));
    renderGrid();
    ctx.refresh();
  }

  /* ─────────────────────────── commands ─────────────────────────── */

  function addRow(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid) return;
    // Excel's "insert row": above the active row (past the data it simply adds one).
    const mr = modelRowOf(active.row);
    const at = mr < 0 ? grid.rows.length : Math.min(mr, grid.rows.length);
    ctx.commit(addRowEdit(m.active, at));
    // The model moves its cells and the file's own look; this moves the copies the SCREEN is drawn
    // from (the chosen number formats, the charts, the filter and sort keys), with the same rule, so
    // a format cannot stay on the row the data just left.
    sheetView = shiftViewFor(sheetView, 'row', at, 1);
    renderGrid();
  }
  function addColumn(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid) return;
    const at = Math.min(active.col, gridWidth(grid));
    ctx.commit(addColumnEdit(m.active, at));
    sheetView = shiftViewFor(sheetView, 'col', at, 1);
    renderGrid();
  }
  function deleteRow(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    const mr = modelRowOf(active.row);
    if (!m || !grid || !grid.rows[mr]) return;
    ctx.commit(deleteRowEdit(m.active, mr, grid.rows[mr]));
    sheetView = shiftViewFor(sheetView, 'row', mr, -1);
    const last = grid.rows.length - 2;
    if (active.row > last) active = { ...active, row: Math.max(0, last) };
    anchor = active;
    renderGrid();
  }
  function deleteColumn(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid) return;
    const at = active.col;
    ctx.commit(deleteColumnEdit(m.active, at, grid.rows.map((r) => r[at] ?? '')));
    sheetView = shiftViewFor(sheetView, 'col', at, -1);
    const last = gridWidth(grid) - 2;
    if (active.col > last) active = { ...active, col: Math.max(0, last) };
    anchor = active;
    renderGrid();
  }
  function autoSum(fn: AutoFn): void {
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

  /**
   * Applies a chosen number format to every cell of the selection.
   *
   * It goes into the MODEL (`sheetFormats.cells[…]`, which the save writes into `styles.xml` as a
   * `<numFmt>` plus the cell's `s=`) and into the view's own copy, so the screen shows it at once.
   * Writing only the view is what made the picker a display-only feature: the file kept General.
   */
  function applyNumberFormat(pattern: string): void {
    const g = range();
    const next = { ...sheetView.formats };
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
      const key = `${modelRowOf(r)}:${c}`;
      if (!pattern || pattern === 'General') delete next[key];
      else next[key] = pattern;
    }
    sheetView = { ...sheetView, formats: next };
    const chosen = !pattern || pattern === 'General' ? null : pattern;
    formatSelection(() => ({ numFmt: chosen }));
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
    // Sheet pixels from the corner of A1 (the file's absolute anchor), measured from the sheet's own
    // start edge: the right one in a right-to-left sheet, as Excel mirrors its drawings.
    box.style.insetInlineStart = `${chart.x}px`;
    box.style.top = `${chart.y}px`;
    box.style.width = `${chart.w}px`;
    box.style.height = `${chart.h}px`;
    const bar = el('div', 'fo-chart-bar');
    bar.append(el('span', 'fo-chart-title', chart.title || t(`office.${chartTypeChoices().find((c) => c.value === chart.type)?.labelKey.split('.')[1] ?? 'chartBar'}`)));
    const close = el('button', 'fo-chart-close');
    close.type = 'button';
    close.append(icon('close', 16));
    close.setAttribute('aria-label', t('office.chartRemove'));
    close.title = t('office.chartRemove');
    close.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    close.addEventListener('click', () => setChartsState(removeChart(sheetView, chart.id).charts));
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
    // Dragging the bar moves the chart and the corner grip resizes it; a finger works as a mouse
    // does. The drag draws live and commits ONE undoable edit when it ends.
    const grip = el('span', 'fo-chart-grip');
    grip.setAttribute('aria-hidden', 'true');
    box.append(grip);
    const drag = (handle: HTMLElement, kind: 'move' | 'size'): void => {
      handle.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const from = { x: ev.clientX, y: ev.clientY };
        let next = { x: chart.x, y: chart.y, w: chart.w, h: chart.h };
        try { handle.setPointerCapture(ev.pointerId); } catch { /* the window listeners still see the moves */ }
        box.classList.add('is-dragging');
        const move = (e: PointerEvent): void => {
          const dx = (e.clientX - from.x) / zoom;
          const dy = (e.clientY - from.y) / zoom;
          if (kind === 'move') {
            const at = draggedChart(chart, dx, dy, sheetRtl);
            next = { ...next, ...at };
            box.style.insetInlineStart = `${at.x}px`;
            box.style.top = `${at.y}px`;
          } else {
            const size = resizedChart(chart, dx, dy, sheetRtl);
            next = { ...next, ...size };
            box.style.width = `${size.w}px`;
            box.style.height = `${size.h}px`;
          }
        };
        const up = (): void => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          box.classList.remove('is-dragging');
          if (next.x === chart.x && next.y === chart.y && next.w === chart.w && next.h === chart.h) return;
          setChartsState(sheetView.charts.map((c) => (c.id === chart.id ? { ...c, ...next } : c)));
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    };
    drag(bar, 'move');
    drag(grip, 'size');
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
    const close = el('button', 'fo-sheetpanel-close');
    close.append(icon('close', 18));
    close.title = t('office.cancel');
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

  /** The block the sort panel works on, fixed when the panel opens (the sort resets the selection). */
  let sortRect: SortRect | null = null;
  /** The owner's answer to "is the top row a header?" for that block; null means auto-detected. */
  let sortHeader: boolean | null = null;
  /**
   * The panel's last sort: the model it produced and the state it started from. While the model is
   * still exactly that one, changing a level or the header sorts the ORIGINAL rows again instead of
   * stacking a second sort on the first (so a wrongly guessed header can still be put right).
   */
  let lastSort: { model: OfficeModel | null; sheet: number; base: SortState } | null = null;

  /**
   * The block to sort: the selection when it spans more than one row, else every data row; its
   * columns when it spans more than one, else the whole width, so a row is never torn apart.
   * Rows are MODEL rows (through `modelRowOf`), clamped to the data.
   */
  function sortBlockOf(grid: Grid): SortRect {
    const g = range();
    const width = Math.max(1, gridWidth(grid));
    const last = Math.max(0, grid.rows.length - 1);
    let r0 = 0;
    let r1 = last;
    if (g.r1 > g.r0) {
      const a = modelRowOf(g.r0);
      const b = modelRowOf(g.r1);
      r0 = a < 0 ? 0 : Math.min(a, last);
      r1 = b < 0 ? last : Math.min(b, last);
      if (r1 < r0) [r0, r1] = [r1, r0];
    }
    const wide = g.c1 > g.c0;
    return { r0, r1, c0: wide ? Math.min(g.c0, width - 1) : 0, c1: wide ? Math.min(g.c1, width - 1) : width - 1 };
  }

  /** The block widened to the whole width when a sort key lies outside its columns. */
  function sortBlockFor(rect: SortRect, keys: readonly SortKey[], width: number): SortRect {
    return keys.every((k) => k.col >= rect.c0 && k.col <= rect.c1) ? rect : { ...rect, c0: 0, c1: Math.max(width - 1, ...keys.map((k) => k.col)) };
  }

  /** Whether the top row of the block is a header: the owner's answer, else the auto-detection. */
  function sortHeaderOf(rows: readonly string[][], rect: SortRect): boolean {
    if (sortHeader !== null) return sortHeader;
    return looksLikeHeader(rows.slice(rect.r0, rect.r1 + 1).map((row) => row.slice(rect.c0, rect.c1 + 1)));
  }

  function openSortPanel(keep = false): void {
    if (!keep) {
      const m = sheets();
      const grid = m ? gridAt(m, m.active) : null;
      sortRect = grid ? sortBlockOf(grid) : null;
      sortHeader = null;
      lastSort = null;
    }
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
        openSortPanel(true);
        applySort();
      });
      dir.addEventListener('change', () => {
        if (!current) return;
        sheetView = setSortOrder(sheetView, current.col, dir.value === 'desc' ? 'desc' : 'asc');
        applySort();
        openSortPanel(true);
      });
      row.append(el('span', 'fo-sheetpanel-level', `${i + 1}`), pick, dir);
      grid2.append(row);
    }
    body.append(grid2);
    // "The top row is a header": auto-detected for the block, and the owner can say otherwise.
    const cur = sheets();
    const g0 = cur ? gridAt(cur, cur.active) : null;
    const headerBox = el('input', 'fo-sort-header');
    headerBox.type = 'checkbox';
    headerBox.checked = !!g0 && !!sortRect && sortHeaderOf(g0.rows, sortRect);
    headerBox.addEventListener('change', () => {
      sortHeader = headerBox.checked;
      if (sheetView.sort.length) applySort();
      openSortPanel(true);
    });
    const headerLabel = el('label', 'fo-sheetpanel-check');
    headerLabel.append(headerBox, el('span', undefined, t('office.sortHeaderOn')));
    body.append(headerLabel);
    const actions = el('div', 'fo-sheetpanel-actions');
    actions.append(
      panelButton(t('office.sortApply'), () => { applySort(); closePanel(); }, true),
      panelButton(t('office.sortClear'), () => { sheetView = clearSort(sheetView); renderGrid(); closePanel(); ctx.refresh(); }),
    );
    body.append(actions);
    showPanel(t('office.sortTitle'), body);
  }

  /**
   * Applies the sort keys to the MODEL: it is an ordinary edit, so it is undoable and it saves.
   *
   * Only the block moves (see `sortBlockOf`), its header row and any totals row at its bottom stay
   * put, and each formula travels with its cell. The grid holds a formula's RESULT while the
   * formula itself is keyed by position in `model.formulas`, so permuting the values alone left
   * every formula behind: a `=SUM` row sorted into the data, and the formula then overwrote
   * whichever value landed in its old cell — a value silently lost.
   */
  function applySort(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid || !sheetView.sort.length) { renderGrid(); return; }
    const sheet = m.active;
    const current: SortState = { rows: grid.rows, formulas: m.formulas, moved: m.moved };
    const base = lastSort && lastSort.sheet === sheet && lastSort.model === ctx.model() ? lastSort.base : current;
    const keys = sheetView.sort as SortKey[];
    const rect = sortBlockFor(sortRect ?? sortBlockOf(grid), keys, Math.max(1, gridWidth({ ...grid, rows: base.rows })));
    const header = sortHeaderOf(base.rows, rect) ? 1 : 0;
    const look = lookOf();
    const footer = totalsRows(rect, header, (r, c) => base.formulas?.[formulaKey(sheet, r, c)] ?? (base === current ? look?.formulas.get(`${r}:${c}`) : undefined));
    const sorted = sortRange(base.rows, rect, keys, { header, footer });
    const after: SortState = {
      rows: sorted.rows,
      formulas: sortFormulas(base.formulas, sheet, rect, sorted.moves),
      moved: (base.moved ?? 0) + 1,
    };
    const put = (model: OfficeModel, state: SortState): OfficeModel => {
      if (model.kind !== 'xlsx' && model.kind !== 'csv') return model;
      const out: SheetsModel = { ...model, grids: model.grids.map((g, i) => (i === sheet ? { ...g, rows: state.rows } : g)) };
      if (state.formulas) out.formulas = state.formulas; else delete out.formulas;
      if (state.moved) out.moved = state.moved; else delete out.moved;
      return out;
    };
    ctx.commit({ key: `sort:${sheet}`, apply: (model) => put(model, after), revert: (model) => put(model, current) });
    lastSort = { model: ctx.model(), sheet, base };
    sortRect = rect;
    anchor = { row: drawnRowOf(rect.r0), col: rect.c0 };
    active = { row: drawnRowOf(rect.r1), col: rect.c1 };
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
        const next = keys.length === values.length ? clearFilter(sheetView, col) : setFilter(sheetView, col, { kind: 'values', keys });
        closePanel();
        setFilterState(next);
      }, true),
      panelButton(t('office.filterClearColumn'), () => { const next = clearFilter(sheetView, col); closePanel(); setFilterState(next); }),
      panelButton(t('office.filterClearAll'), () => { const next = clearFilters(sheetView); closePanel(); setFilterState(next); }),
    );
    body.append(actions, el('div', 'fo-sheetpanel-note', t('office.filterSavedNote')));
    showPanel(t('office.filterTitle', { name: columnLabel(col) }), body);
  }

  /**
   * The pivot panel (الجدول المحوري): pick a row field, an optional column field and what to
   * measure, and the table lands in the sheet as ORDINARY CELLS — so it saves like every other
   * cell, sorts and filters with them, and one Ctrl+Z takes the whole table back.
   *
   * Recalculation is a DECISION, declared here and in the panel: it is never automatic. The result
   * is normal cells, so recomputing on every source keystroke would overwrite whatever the owner
   * typed inside the table and flood the undo history with edits nobody asked for. Instead the
   * panel says when the source has moved on (a fingerprint of the cells the pivot reads) and offers
   * an explicit Refresh, which rewrites the same anchor from live data.
   */
  function pivotSourceRange(): { r0: number; c0: number; r1: number; c1: number } {
    const g = range();
    // Drawn rows are mapped through `modelRowOf`, the same rule sorting, filling and the charts
    // use: a pivot never reads or writes a row an active filter hid.
    const picked = { r0: modelRowOf(g.r0), c0: g.c0, r1: modelRowOf(g.r1), c1: g.c1 };
    // One cell selected means "the table I am standing in": the whole used block, header included,
    // which is what a person means by clicking inside their data. A wider selection is taken as-is.
    if (picked.r0 !== picked.r1 || picked.c0 !== picked.c1) return picked;
    const rows = sheets() ? gridAt(sheets() as SheetsModel, (sheets() as SheetsModel).active)?.rows ?? [] : [];
    let lastCol = 0;
    for (let r = 0; r <= lastUsedRow() && r < rows.length; r++) {
      for (let c = 0; c < (rows[r]?.length ?? 0); c++) if ((rows[r][c] ?? '').trim() !== '') lastCol = Math.max(lastCol, c);
    }
    return { r0: 0, c0: 0, r1: lastUsedRow(), c1: lastCol };
  }

  function pivotSourceRows(source: { r0: number; c0: number; r1: number; c1: number }): string[][] {
    const m = sheets();
    const rows = m ? gridAt(m, m.active)?.rows ?? [] : [];
    const out: string[][] = [];
    for (let r = source.r0; r <= source.r1; r++) {
      const line: string[] = [];
      for (let c = source.c0; c <= source.c1; c++) line.push(rows[r]?.[c] ?? '');
      out.push(line);
    }
    return out;
  }

  /** The last row of the sheet that holds anything — where a new pivot must not land on top of. */
  function lastUsedRow(): number {
    const rows = sheets() ? gridAt(sheets() as SheetsModel, (sheets() as SheetsModel).active)?.rows ?? [] : [];
    for (let r = rows.length - 1; r >= 0; r--) {
      if ((rows[r] ?? []).some((cell) => (cell ?? '').trim() !== '')) return r;
    }
    return 0;
  }

  /** The field choices for the current selection: the header row's names, or the column letters. */
  function pivotFields(source: { r0: number; c0: number; r1: number; c1: number }): Array<{ col: number; name: string }> {
    const rows = pivotSourceRows({ ...source, r1: source.r0 });
    const out: Array<{ col: number; name: string }> = [];
    for (let c = source.c0; c <= source.c1; c++) {
      const header = (rows[0]?.[c - source.c0] ?? '').trim();
      out.push({ col: c, name: header || t('office.pivotColumn', { name: columnName(c) }) });
    }
    return out;
  }

  function insertPivot(source: { r0: number; c0: number; r1: number; c1: number }, spec: PivotSpec): PivotPlacement | null {
    const m = sheets();
    if (!m) return null;
    const table = pivotTable(pivotSourceRows(source), spec);
    const target = pivotTarget({ r0: source.r0, c0: source.c0, r1: source.r1 }, lastUsedRow());
    const edits: Edit[] = [];
    for (const [dr, line] of table.cells.entries()) {
      for (const [dc, value] of line.entries()) {
        const row = target.row + dr;
        const col = target.col + dc;
        const before = gridAt(m, m.active)?.rows[row]?.[col] ?? '';
        const after = value === '' ? '' : String(value);
        if (before !== after) edits.push(cellEdit(m.active, row, col, before, after));
      }
    }
    const placement: PivotPlacement = {
      anchor: target, source, spec, signature: sourceSignature(pivotSourceRows(source), spec),
      size: { rows: table.rows, cols: table.cols },
    };
    const before = pivotPlacements(m.active);
    if (edits.length || before.length !== 1) edits.push(pivotsEdit(m.active, before, [placement]));
    if (edits.length) ctx.commit(compositeEdit(edits));
    refreshValues();
    return placement;
  }

  const pivotPlacements = (sheet: number): readonly PivotPlacement[] => sheets()?.pivots?.[sheet] ?? [];

  function openPivotPanel(): void {
    const m = sheets();
    if (!m || !enabledSheet()) return;
    const source = pivotSourceRange();
    const fields = pivotFields(source);
    if (!fields.length) return;
    const existing = pivotPlacements(m.active);
    const body = el('div', 'fo-sheetpanel-body');
    const rows = el('div', 'fo-sheetpanel-rows');

    const picker = (label: string, choices: Array<{ col: number; name: string }>, none?: string): HTMLSelectElement => {
      const select = el('select', 'fo-sheetpanel-select');
      select.setAttribute('aria-label', label);
      if (none) {
        const option = el('option', undefined, none);
        option.value = '';
        select.append(option);
      }
      for (const field of choices) {
        const option = el('option', undefined, field.name);
        option.value = String(field.col);
        select.append(option);
      }
      const row = el('div', 'fo-sheetpanel-row');
      row.append(el('span', 'fo-sheetpanel-level', label), select);
      rows.append(row);
      return select;
    };

    const rowField = picker(t('office.pivotRows'), fields);
    rowField.value = String(fields[0].col);
    const colField = picker(t('office.pivotColumns'), fields, t('office.pivotNone'));
    colField.value = '';
    const valueField = picker(t('office.pivotValues'), fields);
    valueField.value = String(fields[fields.length - 1].col);
    const fn = el('select', 'fo-sheetpanel-select');
    fn.setAttribute('aria-label', t('office.pivotFunction'));
    for (const choice of PIVOT_AGGREGATES) {
      const option = el('option', undefined, t(`office.pivotFn_${choice}`));
      option.value = choice;
      fn.append(option);
    }
    fn.value = 'sum';
    const fnRow = el('div', 'fo-sheetpanel-row');
    fnRow.append(el('span', 'fo-sheetpanel-level', t('office.pivotFunction')), fn);
    rows.append(fnRow);
    body.append(rows);

    /** The spec the pickers currently describe. */
    const specNow = (): PivotSpec => {
      const row = Number(rowField.value);
      const col = colField.value === '' ? null : Number(colField.value);
      const valueCol = Number(valueField.value);
      return {
        rows: Number.isFinite(row) ? [row - source.c0] : [],
        cols: col === null ? [] : [col - source.c0],
        values: Number.isFinite(valueCol) ? [{ col: valueCol - source.c0, fn: fn.value as PivotAggregate }] : [],
        header: true,
      };
    };

    const target = pivotTarget({ r0: source.r0, c0: source.c0, r1: source.r1 }, lastUsedRow());
    body.append(el('div', 'fo-sheetpanel-note', t('office.pivotWhere', {
      range: `${columnName(source.c0)}${source.r0 + 1}:${columnName(source.c1)}${source.r1 + 1}`,
      cell: `${columnName(target.col)}${target.row + 1}`,
    })));

    const actions = el('div', 'fo-sheetpanel-actions');
    actions.append(panelButton(t('office.pivotInsert'), () => {
      const placed = insertPivot(source, specNow());
      closePanel();
      if (placed) ctx.setStatus(t('office.pivotDone', { cell: `${columnName(placed.anchor.col)}${placed.anchor.row + 1}` }));
    }, true));

    // Refresh: an explicit button, never a background recompute (see the note above the panel).
    const stale = existing.length
      ? sourceSignature(pivotSourceRows(existing[0].source), existing[0].spec) !== existing[0].signature
      : false;
    if (existing.length) {
      actions.append(panelButton(t('office.pivotRefresh'), () => {
        const previous = existing[0];
        const live = pivotSourceRows(previous.source);
        const table = pivotTable(live, previous.spec);
        const edits: Edit[] = [];
        // Clear whatever the previous table occupied, then write the new one: rows can shrink.
        for (let dr = 0; dr < Math.max(previous.size.rows, table.rows); dr++) {
          for (let dc = 0; dc < Math.max(previous.size.cols, table.cols); dc++) {
            const row = previous.anchor.row + dr;
            const col = previous.anchor.col + dc;
            const before = gridAt(m, m.active)?.rows[row]?.[col] ?? '';
            const value = table.cells[dr]?.[dc];
            const after = value === undefined || value === '' ? '' : String(value);
            if (before !== after) edits.push(cellEdit(m.active, row, col, before, after));
          }
        }
        const refreshed: PivotPlacement = { ...previous, signature: sourceSignature(live, previous.spec), size: { rows: table.rows, cols: table.cols } };
        edits.push(pivotsEdit(m.active, [previous], [refreshed]));
        ctx.commit(compositeEdit(edits));
        refreshValues();
        closePanel();
        ctx.setStatus(t('office.pivotRefreshed'));
      }));
    }
    body.append(actions);
    if (stale) body.append(el('div', 'fo-sheetpanel-note is-stale', t('office.pivotStale')));
    body.append(el('div', 'fo-sheetpanel-note', t('office.pivotSaved')));
    showPanel(t('office.pivotTitle'), body);
  }

  /* ─────────────────────────── the ribbon's commands ─────────────────────────── */

  /** The format painter's loaded format: laid on the next selection the pointer makes. */
  let painter: CellFormat | null = null;
  function applyPainter(): void {
    if (!painter) return;
    const f = painter;
    painter = null;
    formatSelection(f);
    root.classList.remove('is-painting');
  }

  /** Copy/cut through the system clipboard (the ribbon buttons; Ctrl+C/X go through the events). */
  function clipboardCopy(cut: boolean): void {
    const text = selectionTsv();
    try { void navigator.clipboard?.writeText(text); } catch { /* no clipboard API: nothing to do */ }
    if (cut && ctx.editable()) clearRange();
    focusGrid();
  }
  function clipboardPaste(): void {
    const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
    if (!read) { ctx.setStatus(t('office.pasteBlocked')); return; }
    read().then((text) => { pasteText(text); focusGrid(); }, () => ctx.setStatus(t('office.pasteBlocked')));
  }

  /** Merge & center / merge / unmerge the selection (the file keeps the first cell's value, as Excel does). */
  function mergeSelection(kind: 'center' | 'cells' | 'unmerge'): void {
    const m = sheets();
    if (!m || m.kind !== 'xlsx' || !ctx.editable()) return;
    const g = modelSelection();
    const before = sheetFormatOf(m, m.active);
    const list = mergesOf(before, lookOf()?.merges);
    if (kind === 'unmerge') {
      const next = withoutMerges(list, g);
      if (next.length !== list.length) { ctx.commit(sheetFormatEdit(m.active, before, withMerges(before, next))); renderGrid(); ctx.refresh(); }
      return;
    }
    if (g.r0 === g.r1 && g.c0 === g.c1) return;
    let after = withMerges(before, withMerge(list, g));
    if (kind === 'center') after = formatRange(after, { r0: g.r0, c0: g.c0, r1: g.r0, c1: g.c0 }, { hAlign: 'center', vAlign: 'center' });
    const edits: Edit[] = [];
    let cleared = false;
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
      if (r === g.r0 && c === g.c0) continue;
      const state = cellState(r, c);
      if (state.value !== '' || state.formula) { edits.push(formulaCellEdit(m.active, r, c, state, { value: '' })); cleared = true; }
    }
    edits.push(sheetFormatEdit(m.active, before, after));
    ctx.commit(compositeEdit(edits));
    if (cleared) ctx.setStatus(t('office.mergeKeepsFirst'));
    anchor = { row: drawnRowOf(g.r0), col: g.c0 };
    active = anchor;
    renderGrid();
    ctx.refresh();
  }
  const currentMerges = (): MergeRange[] => mergesOf(fmtOf(), lookOf()?.merges);

  /** Sort A→Z / Z→A by the active column, over the same block the custom sort would use. */
  function quickSort(order: 'asc' | 'desc'): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!grid) return;
    const col = active.col;
    sortRect = sortBlockOf(grid);
    sortHeader = null;
    lastSort = null;
    sheetView = addSortLevel(clearSort(sheetView), col, order);
    applySort();
    ctx.refresh();
  }

  /** The chart menu: a chart of that kind from the data, placed beside it and titled from its header. */
  function insertChart(type: ChartObject['type']): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid) return;
    const sel = modelSelection();
    const block = chartSource(grid.rows, sel);
    const colStart = (c: number): number => { let x = 0; for (let i = 0; i < c; i++) x += widthOf(i); return x; };
    const rowTop = (mr: number): number => offsets?.[Math.min(drawnRowOf(mr), rowCount)] ?? mr * rowHeight;
    const at = chartPlacement(block, colStart, rowTop);
    const title = chartTitleFrom(grid.rows, block, t('office.chartInsert'));
    const added = addChart(sheetView, { type, range: block, title, x: at.x, y: at.y, w: 420, h: 280 });
    setChartsState(added.charts);
    // Show the new chart: it sits beside the data, which may be past the window's edge.
    revealCol(Math.min(cols - 1, block.c1 + 1));
    ctx.setStatus(t('office.chartFromRange', { range: `${columnName(block.c0)}${block.r0 + 1}:${columnName(block.c1)}${block.r1 + 1}` }));
  }

  /** Insert → Link: a HYPERLINK formula, which saves and reopens like any other. */
  function linkDialog(): void {
    const mr = modelRowOf(active.row);
    if (mr < 0) return;
    const body = el('div', 'fo-validdlg');
    const field = (label: string, input: HTMLElement): HTMLElement => { const f = el('label', 'fo-field'); f.append(el('span', 'fo-field-label', label), input); return f; };
    const url = el('input', 'fo-input');
    url.type = 'url';
    url.dir = 'ltr';
    url.placeholder = 'https://';
    url.value = hyperlinkOf(rawOf(mr, active.col)) ?? '';
    const text = el('input', 'fo-input');
    text.dir = 'auto';
    text.value = hyperlinkOf(rawOf(mr, active.col)) ? cellState(mr, active.col).value : cellState(mr, active.col).value;
    const note = el('div', 'fo-field-note');
    body.append(field(t('office.linkAddress'), url), field(t('office.linkText'), text), note);
    const col = active.col;
    openModal({
      title: t('office.linkTitle'), body, okLabel: t('office.fnInsert'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => {
        const safe = safeLink(url.value);
        if (!safe) { note.textContent = t('office.linkInvalid'); return false; }
        commitCell(mr, col, hyperlinkFormula(safe, text.value));
        renderGrid();
        return true;
      },
    });
    url.focus();
  }

  /** Puts `=NAME(` in the active cell (or into the entry being typed), for the owner to finish. */
  function applyFunction(name: string): void {
    if (!ctx.editable()) return;
    if (editAt) {
      cellEditor.value = functionEntry(name, cellEditor.value);
      fx.value = cellEditor.value;
      editMode = 'edit';
      cellEditor.focus({ preventScroll: true });
      return;
    }
    startEdit(functionEntry(name, ''));
    editMode = 'edit';
  }

  /** Insert function (fx): a category, a search, the list, and one line saying what it does. */
  function functionDialog(): void {
    const body = el('div', 'fo-fndlg');
    const search = el('input', 'fo-input');
    search.type = 'search';
    search.dir = 'auto';
    search.placeholder = t('office.fnSearch');
    search.setAttribute('aria-label', t('office.fnSearch'));
    const cat = el('select', 'fo-select');
    cat.setAttribute('aria-label', t('office.fnCategory'));
    for (const id of ['all', ...FUNCTION_CATEGORIES.map((c) => c.id)]) {
      const o = el('option', undefined, t(`office.fnCat_${id}`));
      o.value = id;
      cat.append(o);
    }
    const list = el('div', 'fo-fnlist');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('office.fnPick'));
    const help = el('div', 'fo-fnhelp');
    let chosen = '';
    const helpOf = (n: string): string => (DESCRIBED_FUNCTIONS.includes(n) ? t(`office.fnHelp_${n}`) : '');
    const draw = (): void => {
      const names = searchFunctions(search.value, functionsIn(cat.value as FunctionCategory | 'all'), helpOf);
      list.replaceChildren();
      if (!names.length) list.append(el('div', 'fo-fnempty', t('office.fnNone')));
      for (const n of names.slice(0, 200)) {
        const b = el('button', 'fo-fnitem', n);
        b.type = 'button';
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(n === chosen));
        b.addEventListener('click', () => { chosen = n; pick(); });
        b.addEventListener('dblclick', () => { chosen = n; modal.close(); applyFunction(n); });
        list.append(b);
      }
      if (!names.includes(chosen)) chosen = names[0] ?? '';
      pick();
    };
    const pick = (): void => {
      list.querySelectorAll<HTMLElement>('.fo-fnitem').forEach((b) => b.setAttribute('aria-selected', String(b.textContent === chosen)));
      help.replaceChildren();
      if (!chosen) return;
      help.append(el('strong', undefined, `${chosen}( )`), el('span', undefined, helpOf(chosen) || t('office.fnNoHelp')));
    };
    search.addEventListener('input', draw);
    cat.addEventListener('change', draw);
    body.append(search, cat, list, help);
    const modal = openModal({
      title: t('office.insertFunction'), body, okLabel: t('office.fnInsert'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => { if (!chosen) return false; const n = chosen; setTimeout(() => applyFunction(n), 0); return true; },
    });
    draw();
    search.focus();
  }

  /** Find and replace: a panel in the sheet area. */
  function findPanel(): void {
    const body = el('div', 'fo-sheetpanel-body');
    const what = el('input', 'fo-sheetpanel-input');
    what.type = 'search';
    what.dir = 'auto';
    what.placeholder = t('office.findWhat');
    what.setAttribute('aria-label', t('office.findWhat'));
    const withText = el('input', 'fo-sheetpanel-input');
    withText.dir = 'auto';
    withText.placeholder = t('office.replaceWith');
    withText.setAttribute('aria-label', t('office.replaceWith'));
    const check = (label: string): HTMLInputElement => {
      const box = el('input');
      box.type = 'checkbox';
      const line = el('label', 'fo-sheetpanel-check');
      line.append(box, el('span', undefined, label));
      body.append(line);
      return box;
    };
    body.append(what, withText);
    const matchCase = check(t('office.matchCase'));
    const whole = check(t('office.wholeCell'));
    const result = el('div', 'fo-sheetpanel-note');
    result.setAttribute('role', 'status');
    const opts = (): FindOptions => ({ matchCase: matchCase.checked, wholeCell: whole.checked });
    const rows = (): readonly string[][] => { const m = sheets(); return m ? gridAt(m, m.active)?.rows ?? [] : []; };
    /** Only a row the filter shows can be found (a hidden row cannot be selected). */
    const visible = (mr: number): boolean => !rowMap || rowMap.includes(mr);
    const next = (): void => {
      const hits = findAll(rows(), what.value, opts()).filter((h) => visible(h.row));
      if (!hits.length) { result.textContent = t('office.findNone'); return; }
      const here = { row: modelRowOf(active.row), col: active.col };
      const hit = hits.find((h) => h.row > here.row || (h.row === here.row && h.col > here.col)) ?? hits[0];
      goTo({ row: drawnRowOf(hit.row), col: hit.col }, false);
      result.textContent = t('office.findFound', { cell: `${columnName(hit.col)}${hit.row + 1}` });
    };
    const replaceAt = (hits: readonly CellHit[]): number => {
      const m = sheets();
      if (!m || !ctx.editable()) return 0;
      const edits: Edit[] = [];
      for (const h of hits) {
        const before = cellState(h.row, h.col);
        if (before.formula) continue;                  // a formula's result is not text to replace
        const text = replaceInCell(before.value, what.value, withText.value, opts());
        const after = cellStateFor(text, h.row, h.col, m.active);
        if (after.value !== before.value) edits.push(formulaCellEdit(m.active, h.row, h.col, before, after));
      }
      if (edits.length) { ctx.commit(compositeEdit(edits)); refreshValues(); }
      return edits.length;
    };
    const actions = el('div', 'fo-sheetpanel-actions');
    actions.append(
      panelButton(t('office.findNext'), next, true),
      panelButton(t('office.replace'), () => {
        const mr = modelRowOf(active.row);
        if (mr >= 0 && cellMatches(cellState(mr, active.col).value, what.value, opts())) replaceAt([{ row: mr, col: active.col }]);
        next();
      }),
      panelButton(t('office.replaceAll'), () => {
        const n = replaceAt(findAll(rows(), what.value, opts()).filter((h) => visible(h.row)));
        result.textContent = n ? t('office.replacedCount', { n }) : t('office.findNone');
      }),
    );
    what.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); next(); } });
    body.append(actions, result);
    showPanel(t('office.findReplace'), body);
    what.focus();
  }

  /** Remove duplicates: which columns decide, whether the top row is headers, then one undoable edit. */
  function dedupePanel(): void {
    const m = sheets();
    const grid = m ? gridAt(m, m.active) : null;
    if (!m || !grid) return;
    const rect = sortBlockOf(grid);
    const body = el('div', 'fo-sheetpanel-body');
    body.append(el('div', 'fo-sheetpanel-note', t('office.dedupeColumns')));
    const list = el('div', 'fo-sheetpanel-list');
    const boxes: Array<{ col: number; box: HTMLInputElement }> = [];
    for (let c = rect.c0; c <= rect.c1; c++) {
      const line = el('label', 'fo-sheetpanel-check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = true;
      line.append(box, el('span', undefined, columnLabel(c)));
      list.append(line);
      boxes.push({ col: c, box });
    }
    const headerBox = el('input');
    headerBox.type = 'checkbox';
    headerBox.checked = looksLikeHeader(grid.rows.slice(rect.r0, rect.r1 + 1));
    const headerLine = el('label', 'fo-sheetpanel-check');
    headerLine.append(headerBox, el('span', undefined, t('office.dedupeHeader')));
    const actions = el('div', 'fo-sheetpanel-actions');
    actions.append(panelButton(t('office.dedupeApply'), () => {
      const keys = boxes.filter((b) => b.box.checked).map((b) => b.col);
      if (!keys.length) return;
      const hasFormula = Object.keys(m.formulas ?? {}).some((k) => { const [s, r, c] = k.split(':').map(Number); return s === m.active && r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1; })
        || [...(lookOf()?.formulas.keys() ?? [])].some((k) => { const [r, c] = k.split(':').map(Number); return r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1; });
      if (hasFormula) { ctx.setStatus(t('office.dedupeFormulas')); closePanel(); return; }
      const out = removeDuplicates(grid.rows, rect, keys, headerBox.checked);
      closePanel();
      if (!out.removed) { ctx.setStatus(t('office.dedupeNone')); return; }
      const edits: Edit[] = [];
      for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) {
        const before = grid.rows[r]?.[c] ?? '';
        const after = out.rows[r]?.[c] ?? '';
        if (before !== after) edits.push(cellEdit(m.active, r, c, before, after));
      }
      ctx.commit(compositeEdit(edits));
      renderGrid();
      ctx.setStatus(t('office.dedupeDone', { n: out.removed }));
    }, true));
    body.append(list, headerLine, actions);
    showPanel(t('office.dedupeTitle'), body);
  }

  /** Freeze panes: the top row, the first column, everything above and before the active cell, or nothing. */
  function freezeAt(kind: FreezeKind): void {
    if (kind === 'none') { freezeRowsSet = 0; freezeColsSet = 0; }
    else if (kind === 'row') { freezeRowsSet = 1; freezeColsSet = 0; }
    else if (kind === 'col') { freezeRowsSet = 0; freezeColsSet = 1; }
    else {
      freezeRowsSet = active.row;
      freezeColsSet = active.col;
      if (!active.row && !active.col) freezeRowsSet = 1;
    }
    renderGrid();
    ctx.refresh();
  }

  function setZoom(value: number): void {
    zoom = Math.max(0.5, Math.min(2, value));
    scroll.style.zoom = zoom === 1 ? '' : String(zoom);
    updateWindow();
    ctx.refresh();
  }

  const canFormula = (): boolean => enabledSheet() && sheets()?.kind === 'xlsx';
  const commands: CalcCommands = {
    fileTab: () => ctx.fileTab(),
    editable: enabledSheet,
    canFormat,
    canFormula,
    style: activeStyle,
    copy: () => clipboardCopy(false),
    cut: () => clipboardCopy(true),
    paste: clipboardPaste,
    painterOn: () => !!painter,
    togglePainter: () => {
      painter = painter ? null : formatFromStyle(activeStyle());
      root.classList.toggle('is-painting', !!painter);
      if (painter) ctx.setStatus(t('office.painterHint'));
      ctx.refresh();
    },
    toggle: (key) => toggleStyle(key),
    setFont: (name) => formatSelection({ font: name }),
    setSize: (pt) => formatSelection({ size: pt }),
    setColor: (hex) => formatSelection({ color: hex }),
    setFill: (hex) => formatSelection({ fill: hex }),
    borders: setBorders,
    align: (h) => formatSelection({ hAlign: alignOf() === h ? null : h }),
    valign: (v) => formatSelection({ vAlign: v }),
    toggleWrap: () => toggleStyle('wrap'),
    merge: mergeSelection,
    isMerged: () => !!mergeAtCell(currentMerges(), modelRowOf(active.row), active.col),
    numFmt: () => formatForCell(sheetView.formats, modelRowOf(active.row), active.col) || activeStyle()?.numFmt || '',
    setNumFmt: applyNumberFormat,
    decimals: changeDecimals,
    addCond: (kind) => setCondState(addCondRule(sheetView, kind === 'scale' ? colorScaleRule() : kind === 'bars' ? dataBarRule() : topRule(10)).condRules),
    clearCond: () => setCondState(clearCondRules(sheetView).condRules),
    hasCond: () => sheetView.condRules.length > 0,
    cellStyle: (id) => formatSelection(cellStyleFormat(id)),
    addRow, addColumn, deleteRow, deleteColumn,
    canDeleteRow: () => canDeleteRow(sheets() as OfficeModel, sheets()?.active ?? 0),
    canDeleteColumn: () => canDeleteColumn(sheets() as OfficeModel, sheets()?.active ?? 0),
    fitColumns: fitSelectedColumns,
    askSize,
    autoSum,
    sort: quickSort,
    customSort: () => openSortPanel(),
    toggleFilter: () => openFilterPanel(active.col),
    filterOn: () => isFiltered(sheetView),
    isFiltered: () => isFiltered(sheetView),
    clearFilters: () => setFilterState(clearFilters(sheetView)),
    find: findPanel,
    pivot: openPivotPanel,
    chart: insertChart,
    hasCharts: () => sheetView.charts.length > 0,
    removeCharts: () => setChartsState([]),
    link: linkDialog,
    insertFunction: (name) => (name ? applyFunction(name) : functionDialog()),
    validation: validationDialog,
    clearValidation,
    hasValidation: () => validationsOf().length > 0,
    dedupe: dedupePanel,
    freeze: freezeAt,
    frozen: () => ({ rows: frozenRows, cols: frozenCols }),
    gridlines: () => !root.classList.contains('no-gridlines'),
    toggleGridlines: () => { root.classList.toggle('no-gridlines'); ctx.refresh(); },
    zoom: () => zoom,
    setZoom,
  };

  function tabs(): RibbonTab[] {
    return calcTabs(commands);
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
  sizes = observeSize(scroll, () => {
    // A wider window draws the extra columns that now fit; the rows follow the height.
    if (table && columnsToDraw(dataCols, ctx.editable() ? 3 : 0, PAD_COLS, MAX_COLS, viewportWidth(), widthOf) > cols) renderGrid();
    else updateWindow();
  });

  return {
    element: root,
    tabs,
    render(): void {
      const m = sheets();
      if (m && active.row === 0 && active.col === 0 && !tds.size) anchor = active;
      renderGrid();
      syncBars();
    },
    status(): StatusInfo {
      return { parts: [refName(), ...viewParts(), ...selectionStats()], zoom: { value: zoom, set: setZoom } };
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
