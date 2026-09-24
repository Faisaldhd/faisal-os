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
  gridAt, gridWidth, type CellState, type Edit, type OfficeModel, type SheetsModel,
} from '../model';
import { evaluateInModel, formatFormula, parseFormula } from '../formula/index';
import { formatValue } from '../calc/index';
import { columnName } from '../xml';
import { MAX_COLS, MAX_ROWS } from '../../viewer/formats';
import { el } from '../ui/dom';
import type { RibbonTab } from '../ui/ribbon';
import type { BookLook, CellStyle } from './xlsxlook';

const VIEW_ROWS = 300;
const VIEW_COLS = 40;
/** The empty grid drawn past the data, so the sheet looks like a sheet. */
const PAD_ROWS = 30;
const PAD_COLS = 12;

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

  let table: HTMLTableElement | null = null;
  let inputs = new Map<string, HTMLInputElement>();
  let tds = new Map<string, HTMLTableCellElement>();

  function styleCell(td: HTMLTableCellElement, input: HTMLInputElement, view: HTMLElement, s: CellStyle | undefined, value: string): void {
    const numeric = /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(value.trim()) && value.trim() !== '';
    const h = s?.hAlign ?? (numeric ? 'right' : undefined);
    const justify = (a: string): string => (a === 'center' || a === 'centerContinuous' ? 'center' : a === 'right' ? 'flex-end' : 'flex-start');
    if (h) { view.style.justifyContent = justify(h); view.style.textAlign = h === 'centerContinuous' ? 'center' : h; }
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
    if (!m) { scroll.replaceChildren(); return; }
    const sheet = m.active >= 0 && m.active < m.grids.length ? m.active : 0;
    const grid = m.grids[sheet];
    const look = lookOf();
    const dataRows = grid ? Math.min(grid.rows.length, VIEW_ROWS) : 0;
    const dataCols = grid ? Math.max(1, Math.min(gridWidth(grid), VIEW_COLS)) : 1;
    const rows = Math.max(dataRows + (ctx.editable() ? 5 : 0), PAD_ROWS);
    const cols = Math.min(Math.max(dataCols + (ctx.editable() ? 3 : 0), PAD_COLS), VIEW_COLS + 3);
    const frozen = freezeTop === null ? look?.frozenRows ?? 0 : freezeTop ? 1 : 0;

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
    const tbody = el('tbody');
    const covered = new Set<string>();
    for (const mg of look?.merges ?? []) {
      for (let r = mg.r0; r <= mg.r1; r++) for (let c = mg.c0; c <= mg.c1; c++) if (r !== mg.r0 || c !== mg.c0) covered.add(`${r}:${c}`);
    }
    let top = 26;
    for (let r = 0; r < rows; r++) {
      const tr = el('tr');
      const height = look?.heights.get(r);
      if (height) tr.style.height = `${height}px`;
      const rh = el('th', 'faisal-office-rowhead fo-rowhead', String(r + 1));
      rh.addEventListener('click', () => { anchor = { row: r, col: 0 }; active = { row: r, col: Math.max(0, dataCols - 1) }; select(false); });
      tr.append(rh);
      if (r < frozen) {
        tr.classList.add('is-frozen');
        tr.style.top = `${top}px`;
        top += height ?? look?.defaultHeight ?? 24;
      }
      for (let c = 0; c < cols; c++) {
        if (covered.has(`${r}:${c}`)) continue;
        const td = el('td', 'faisal-office-celld fo-td');
        const merge = look?.merges.find((mg) => mg.r0 === r && mg.c0 === c);
        if (merge) { td.rowSpan = merge.r1 - merge.r0 + 1; td.colSpan = merge.c1 - merge.c0 + 1; }
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
        inputs.set(`${r}:${c}`, input);
        tds.set(`${r}:${c}`, td);
      }
      tbody.append(tr);
    }
    tbl.append(thead, tbody);
    table = tbl;
    scroll.replaceChildren(tbl);
    renderTabs();
    note.textContent = grid?.truncated
      ? t('office.cutNote', { rows: MAX_ROWS, cols: MAX_COLS })
      : grid && (grid.rows.length > VIEW_ROWS || gridWidth(grid) > VIEW_COLS) ? t('office.viewLimit', { rows: VIEW_ROWS, cols: VIEW_COLS }) : '';
    note.hidden = !note.textContent;
    paintSelection();
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
      if (input && document.activeElement !== input) { shiftFocus = true; input.focus({ preventScroll: false }); }
    }
    ctx.refresh();
  }

  function move(dr: number, dc: number, extend: boolean): void {
    active = { row: Math.max(0, active.row + dr), col: Math.max(0, Math.min(VIEW_COLS + 2, active.col + dc)) };
    if (!extend) anchor = active;
    const input = inputs.get(`${active.row}:${active.col}`);
    if (!input) { renderGrid(); }
    shiftFocus = extend;
    inputs.get(`${active.row}:${active.col}`)?.focus();
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
    },
    ...{ activeCell: () => active },
  } as Editor;
}
