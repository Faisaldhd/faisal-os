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
import { t } from '../../../kernel/i18n';
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
  root.append(fxbar, scroll, tabsBar, note);

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
    const formula = formulaAt(m, m.active, active.row, active.col);
    if (formula) ctx.setStatus(t('office.formulaResult', { value: cellState(active.row, active.col).value }));
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
    rowCount = Math.max(dataRows + (ctx.editable() ? PAD_ROWS : 0), PAD_ROWS);
    cols = Math.min(Math.max(dataCols + (ctx.editable() ? 3 : 0), PAD_COLS), MAX_COLS);
    rowHeight = baseRowHeight(look);
    offsets = rowOffsets(rowCount, rowHeightOf);
    measured = false;
    frozenRows = Math.min(freezeTop === null ? look?.frozenRows ?? 0 : freezeTop ? 1 : 0, rowCount);
    sheetRtl = sheetIsRtl(grid?.rows ?? [], look?.rtl);
    scroll.dir = sheetRtl ? 'rtl' : 'ltr';
    root.classList.toggle('is-rtl-sheet', sheetRtl);
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
    for (let c = 0; c < cols; c++) {
      const th = el('th', 'faisal-office-colhead fo-colhead', columnName(c));
      th.dataset.c = String(c);
      th.addEventListener('click', () => { anchor = { row: 0, col: c }; active = { row: Math.max(0, dataRows - 1), col: c }; select(false); });
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
    const tr = el('tr');
    // The height the offsets were computed from, so a drawn row is exactly as tall as the window
    // maths believes it is (a touch row is 44px, the touch target G8 asks for). It is set on the
    // cells as well as the row: a `table-layout: fixed` table takes a row height as a minimum,
    // and the cells' own CSS height is what the browser ends up honouring.
    const height = rowHeightOf(r);
    tr.style.height = `${height}px`;
    const rh = el('th', 'faisal-office-rowhead fo-rowhead', String(r + 1));
    rh.addEventListener('click', () => { anchor = { row: r, col: 0 }; active = { row: r, col: Math.max(0, dataCols - 1) }; select(false); });
    tr.append(rh);
    if (r < frozenRows) {
      tr.classList.add('is-frozen');
      tr.style.top = `${HEADER_HEIGHT + (offsets?.[r] ?? 0)}px`;
    }
    const rec: RowRecord = { tr, inputs: [], tds: [], cols: [] };
    for (let c = 0; c < cols; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const td = el('td', 'faisal-office-celld fo-td');
      td.style.height = `${height}px`;
      const merge = mergeAt.get(`${r}:${c}`);
      if (merge) { td.rowSpan = merge.r1 - r + 1; td.colSpan = merge.c1 - c + 1; }
      const inData = r < dataRows && c < dataCols;
      const input = el('input', inData ? 'faisal-office-cell' : 'fo-cell-empty');
      input.type = 'text';
      input.dir = 'auto';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.readOnly = !ctx.editable();
      input.dataset.r = String(r);
      input.dataset.c = String(c);
      input.setAttribute('aria-label', `${columnName(c)}${r + 1}`);
      input.value = rawOf(r, c);
      const view = el('span', 'fo-cellview');
      view.setAttribute('aria-hidden', 'true');
      const value = grid?.rows[r]?.[c] ?? '';
      const s = styleAt(r, c);
      view.textContent = displayValue(value, s?.numFmt);
      styleCell(td, input, view, s, value);
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
      input.addEventListener('input', () => { editing = true; commitCell(r, c, input.value); fx.value = input.value; });
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
      if (document.activeElement !== input) input.value = rawOf(r, c);
      const view = input.previousElementSibling as HTMLElement | null;
      if (view) view.textContent = displayValue(grid?.rows[r]?.[c] ?? '', styleAt(r, c)?.numFmt);
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
    const a = `${columnName(g.c0)}${g.r0 + 1}`;
    return g.r0 === g.r1 && g.c0 === g.c1 ? a : `${a}:${columnName(g.c1)}${g.r1 + 1}`;
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
    if (document.activeElement !== fx) fx.value = rawOf(active.row, active.col);
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
    active = { row: Math.max(0, active.row + dr), col: Math.max(0, Math.min(cols - 1, active.col + dc)) };
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
    if (k === 'Escape' && editing) { editing = false; target.value = rawOf(active.row, active.col); target.select(); return; }
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
      const before = cellState(r, c);
      if (before.value !== '' || before.formula) edits.push(formulaCellEdit(m.active, r, c, before, { value: '' }));
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
    for (let r = g.r0; r <= g.r1; r++) { const row: string[] = []; for (let c = g.c0; c <= g.c1; c++) row.push(grid?.rows[r]?.[c] ?? ''); rows.push(row); }
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
    rows.forEach((row, dr) => row.forEach((value, dc) => {
      const r = active.row + dr;
      const c = active.col + dc;
      edits.push(formulaCellEdit(m.active, r, c, cellState(r, c), { value }));
    }));
    ctx.commit(compositeEdit(edits));
    renderGrid();
  });

  fx.addEventListener('input', () => { if (ctx.editable()) commitCell(active.row, active.col, fx.value); });
  fx.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); move(1, 0, false); }
    if (ev.key === 'Escape') { fx.value = rawOf(active.row, active.col); inputs.get(`${active.row}:${active.col}`)?.focus(); }
  });
  nameBox.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const m = /^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?$/.exec(nameBox.value.trim());
    if (!m) { nameBox.value = refName(); return; }
    const toCell = (col: string, row: string): Cell => ({ row: Math.max(0, Number(row) - 1), col: [...col.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 });
    anchor = toCell(m[1], m[2]);
    active = m[3] ? toCell(m[3], m[4]) : anchor;
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
    if (!m || !grid || !grid.rows[active.row]) return;
    ctx.commit(deleteRowEdit(m.active, active.row, grid.rows[active.row]));
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
      target = { row: g.r1 + 1, col: g.c0 };
      ref = `${columnName(g.c0)}${g.r0 + 1}:${columnName(g.c1)}${g.r1 + 1}`;
    } else {
      const grid = gridAt(m, m.active);
      let top = active.row - 1;
      while (top >= 0 && /^-?\d/.test((grid?.rows[top]?.[active.col] ?? '').trim())) top--;
      target = active;
      ref = `${columnName(active.col)}${top + 2}:${columnName(active.col)}${Math.max(active.row, top + 2)}`;
    }
    commitCell(target.row, target.col, `=${fn}(${ref})`);
    active = target;
    anchor = target;
    renderGrid();
    select(false);
  }

  const enabledSheet = (): boolean => !!sheets() && ctx.editable();

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
      const v = (grid.rows[r]?.[c] ?? '').trim();
      if (v !== '' && Number.isFinite(Number(v))) { sum += Number(v); count++; }
    }
    if (!count) return [];
    const fmt = (n: number): string => String(Number(n.toPrecision(12)));
    return [t('office.statSum', { n: fmt(sum) }), t('office.statAverage', { n: fmt(sum / count) }), t('office.statCount', { n: count })];
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
      return { parts: [refName(), ...selectionStats()] };
    },
    dispose(): void {
      document.removeEventListener('pointerup', onPointerUp);
      sizes?.disconnect();
      sizes = null;
    },
    ...{ activeCell: () => active },
  } as Editor;
}
