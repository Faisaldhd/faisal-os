/**
 * Office (المكتب) — the Word / Excel / PowerPoint editor.
 *
 * It is a **store-only** app: the manifest sets `defaultInstalled: false` and
 * `core: false`, so it appears in the Store as something the owner installs, and
 * the kernel treats `defaultInstalled === false` as "installed only after the
 * Store adds it" (`src/kernel/apps.ts:131`).
 *
 * What it is:
 *  • a reader for .docx/.xlsx/.pptx (through the viewer's dependency-free readers),
 *    plus .csv/.tsv/.txt/.md, that lets the owner change the text that was read;
 *  • a writer of real OOXML packages, built by this directory's own ZIP writer —
 *    no library, no network, no formula engine;
 *  • honest about everything it cannot do: the limits panel is generated from the
 *    same table the tests verify, not from prose that could drift.
 *
 * Safety rules that hold everywhere below:
 *  • every piece of text is put into the DOM with `textContent` (or `value`),
 *    never as markup — a file's content is never HTML;
 *  • saving writes only inside /home/user, always keeps exactly one `.bak`, and
 *    refuses when the model could not be read (so a damaged file is never
 *    overwritten by an empty one).
 */
import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { VFSError } from '../../kernel/types';
import { basename, normalize } from '../../kernel/path';
import { t } from '../../kernel/i18n';
import { shellConfirm } from '../../shell/dialog';
import { MAX_COLS, MAX_ROWS } from '../viewer/formats';
import { columnName } from './xml';
import {
  History, VERIFIED_FORMATS, addColumnEdit, addRowEdit, canDeleteColumn, canDeleteRow, cellEdit,
  clearTruncated, deleteColumnEdit, deleteRowEdit, gridAt, gridWidth, isTruncated, paragraphEdit,
  planFor, slideTextEdit, textEdit,
  type DeckModel, type DocModel, type Edit, type FormatPlan, type OfficeModel, type SheetsModel,
  type SupportLevel, type TextModel,
} from './model';
import { loadOfficeFile, serializeModel, type LoadRefusal } from './file';
import { saveWithBackup, withinHome } from './save';
import './strings';
import './office.css';

/** The window builds at most this many rows/columns/paragraphs at a time. */
const VIEW_ROWS = 300;
const VIEW_COLS = 40;
const VIEW_PARAGRAPHS = 400;
/** A text buffer larger than this is refused: a textarea is not a file viewer. */
const TEXT_LIMIT = 4 * 1024 * 1024;

const KIND_LABEL: Record<string, string> = {
  docx: 'office.kindDoc',
  xlsx: 'office.kindSheet',
  csv: 'office.kindCsv',
  pptx: 'office.kindSlides',
  text: 'office.kindText',
};

type RefusalView = LoadRefusal | 'outside' | 'toolarge';

const REFUSAL_TITLE: Record<RefusalView, string> = {
  legacy: 'office.legacyTitle',
  unknown: 'office.unknownTitle',
  binary: 'office.binaryTitle',
  damaged: 'office.readErrorTitle',
  outside: 'office.outsideTitle',
  toolarge: 'office.tooLargeTitle',
};
const REFUSAL_BODY: Record<RefusalView, string> = {
  legacy: 'office.legacyBody',
  unknown: 'office.unknownBody',
  binary: 'office.binaryBody',
  damaged: 'office.readErrorBody',
  outside: 'office.outsideBody',
  toolarge: 'office.tooLargeBody',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The extensions of one support level, as a comma-separated list for the UI. */
function extList(level: SupportLevel): string {
  return VERIFIED_FORMATS.filter((f) => f.level === level).map((f) => f.ext).join(', ');
}

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  const vfs = sys.vfs;
  const filePath = args[0] ? normalize(args[0]) : null;

  let plan: FormatPlan = planFor(filePath ?? '');
  let model: OfficeModel | null = null;
  let editable = false;
  let busy = false;
  let closed = false;
  /** The cell the sheet buttons act on; null until one is focused. */
  let active: { row: number; col: number } | null = null;
  const history = new History();

  win.content.textContent = '';
  const root = el('div', 'faisal-office');
  const bar = el('div', 'faisal-office-bar');
  const info = el('div', 'faisal-office-info');
  const nameEl = el('div', 'faisal-office-name', t('office.title'));
  const metaEl = el('div', 'faisal-office-meta');
  info.append(nameEl, metaEl);

  function action(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = el('button', `faisal-office-btn${primary ? ' is-primary' : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  const undoBtn = action(t('office.undo'), () => { undo(); });
  const redoBtn = action(t('office.redo'), () => { redo(); });
  const saveBtn = action(t('office.save'), () => { void save(); }, true);
  const revertBtn = action(t('office.revert'), () => { void revert(); });
  const actions = el('div', 'faisal-office-actions');
  actions.append(undoBtn, redoBtn, saveBtn, revertBtn);
  bar.append(info, actions);

  const tools = el('div', 'faisal-office-tools');
  const addRowBtn = action(t('office.addRow'), () => { addRow(); });
  const addColumnBtn = action(t('office.addColumn'), () => { addColumn(); });
  const deleteRowBtn = action(t('office.deleteRow'), () => { deleteRow(); });
  const deleteColumnBtn = action(t('office.deleteColumn'), () => { deleteColumn(); });
  const hint = el('span', 'faisal-office-hint', t('office.toolsHint'));
  tools.append(addRowBtn, addColumnBtn, deleteRowBtn, deleteColumnBtn, hint);

  const noteEl = el('div', 'faisal-office-notice');
  noteEl.setAttribute('role', 'note');
  noteEl.hidden = true;
  const contentHost = el('div', 'faisal-office-body');
  const limits = buildLimits();
  const statusEl = el('div', 'faisal-office-status');
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  const pathEl = el('div', 'faisal-office-path', filePath ?? '');
  pathEl.dir = 'ltr';
  const footer = el('div', 'faisal-office-footer');
  footer.append(statusEl, pathEl);

  root.append(bar, tools, noteEl, contentHost, limits, footer);
  win.content.append(root);

  /* ─────────────────────────── the limits panel ─────────────────────────── */

  function buildLimits(): HTMLElement {
    const details = el('details', 'faisal-office-limits');
    details.append(el('summary', 'faisal-office-summary', t('office.limitsTitle')));
    const body = el('div', 'faisal-office-limits-body');
    const rows: Array<[string, Record<string, string | number>?]> = [
      ['office.limitFormulas'],
      ['office.limitStyling'],
      ['office.limitRewrite'],
      ['office.limitImages'],
      ['office.limitLegacy'],
      ['office.limitTruncated', { rows: MAX_ROWS, cols: MAX_COLS }],
      ['office.limitSlideBlank'],
      ['office.limitText'],
      ['office.limitBackup'],
    ];
    const list = el('ul', 'faisal-office-limitlist');
    for (const [key, vars] of rows) list.append(el('li', undefined, t(key, vars)));
    body.append(list, el('div', 'faisal-office-blocktitle', t('office.formatsTitle')));
    const formats = el('ul', 'faisal-office-formatlist');
    formats.append(el('li', undefined, t('office.formatsEdit', { list: extList('edit') })));
    formats.append(el('li', undefined, t('office.formatsReadOnly', { list: extList('read-only') })));
    formats.append(el('li', undefined, t('office.formatsUnsupported', { list: extList('unsupported') })));
    body.append(formats);
    details.append(body);
    return details;
  }

  /* ─────────────────────────────── state ─────────────────────────────── */

  function setStatus(text: string): void { statusEl.textContent = text; }

  function setNote(text: string): void {
    noteEl.textContent = text;
    noteEl.hidden = !text;
  }

  function errorMessage(err: unknown): string {
    if (err instanceof VFSError) return `${err.code}: ${err.path}`;
    return err instanceof Error ? err.message : String(err);
  }

  function isSheets(m: OfficeModel | null): m is SheetsModel {
    return !!m && (m.kind === 'xlsx' || m.kind === 'csv');
  }

  function syncTools(): void {
    const sheets = isSheets(model) ? model : null;
    tools.hidden = !sheets || !editable;
    if (!sheets) return;
    const at = active;
    addRowBtn.disabled = busy;
    addColumnBtn.disabled = busy;
    deleteRowBtn.disabled = busy || !at || !canDeleteRow(sheets, sheets.active);
    deleteColumnBtn.disabled = busy || !at || !canDeleteColumn(sheets, sheets.active);
  }

  function syncBar(): void {
    const name = filePath ? basename(filePath) : t('office.title');
    nameEl.textContent = name;
    nameEl.title = filePath ?? '';
    const parts = [t(KIND_LABEL[plan.kind ?? ''] ?? 'office.kindOther')];
    if (plan.readOnly) parts.push(t('office.readOnlyBadge'));
    parts.push(history.dirty ? t('office.dirty') : t('office.clean'));
    if (model && isTruncated(model)) parts.push(t('office.truncatedBadge'));
    metaEl.textContent = parts.join(' · ');
    win.setTitle(`${history.dirty ? '● ' : ''}${name} — ${t('office.title')}`);
    undoBtn.disabled = !model || history.undoSteps === 0;
    redoBtn.disabled = !model || history.redoSteps === 0;
    saveBtn.disabled = !model || !editable || busy;
    revertBtn.disabled = busy || !filePath;
    syncTools();
  }

  function commit(edit: Edit): void {
    if (!model) return;
    model = edit.apply(model);
    history.push(edit);
    syncBar();
  }

  function undo(): void {
    if (!model || history.undoSteps === 0) return;
    model = history.undo(model);
    render();
  }

  function redo(): void {
    if (!model || history.redoSteps === 0) return;
    model = history.redo(model);
    render();
  }

  /* ─────────────────────────── sheet buttons ─────────────────────────── */

  function addRow(): void {
    if (!isSheets(model)) return;
    const grid = gridAt(model, model.active);
    if (!grid) return;
    commit(addRowEdit(model.active, grid.rows.length));
    render();
  }

  function addColumn(): void {
    if (!isSheets(model)) return;
    const grid = gridAt(model, model.active);
    if (!grid) return;
    commit(addColumnEdit(model.active, gridWidth(grid)));
    render();
  }

  function deleteRow(): void {
    const at = active;
    if (!isSheets(model) || !at) return;
    const grid = gridAt(model, model.active);
    if (!grid || !grid.rows[at.row]) return;
    const sheet = model.active;
    commit(deleteRowEdit(sheet, at.row, grid.rows[at.row]));
    const last = grid.rows.length - 2; // one row is gone
    if (at.row > last) active = { ...at, row: Math.max(0, last) };
    render();
  }

  function deleteColumn(): void {
    const at = active;
    if (!isSheets(model) || !at) return;
    const grid = gridAt(model, model.active);
    if (!grid) return;
    const sheet = model.active;
    commit(deleteColumnEdit(sheet, at.col, grid.rows.map((r) => r[at.col] ?? '')));
    const last = gridWidth(grid) - 2;
    if (at.col > last) active = { ...at, col: Math.max(0, last) };
    render();
  }

  /* ───────────────────────────── rendering ───────────────────────────── */

  function grow(area: HTMLTextAreaElement): void {
    // jsdom reports scrollHeight 0; the explicit height is a convenience only.
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight || 0, 480)}px`;
  }

  function textField(value: string, onInput: (area: HTMLTextAreaElement) => void): HTMLTextAreaElement {
    const area = el('textarea', 'faisal-office-para');
    area.value = value;
    area.rows = 1;
    area.dir = 'auto';
    area.spellcheck = false;
    area.readOnly = !editable;
    grow(area);
    area.addEventListener('input', () => { grow(area); onInput(area); });
    return area;
  }

  function renderDoc(m: DocModel): HTMLElement {
    const wrap = el('div', 'faisal-office-doc');
    const shown = Math.min(m.paragraphs.length, VIEW_PARAGRAPHS);
    for (let i = 0; i < shown; i++) {
      const row = el('div', 'faisal-office-para-row');
      row.append(el('span', 'faisal-office-para-index', t('office.paragraphLabel', { n: i + 1 })));
      row.append(textField(m.paragraphs[i] ?? '', (area) => {
        if (model?.kind !== 'docx') return;
        const before = model.paragraphs[i] ?? '';
        if (before !== area.value) commit(paragraphEdit(i, before, area.value));
      }));
      wrap.append(row);
    }
    if (m.paragraphs.length > shown) {
      wrap.append(el('div', 'faisal-office-more', t('office.moreParagraphs', { n: shown })));
    }
    return wrap;
  }

  function renderDeck(m: DeckModel): HTMLElement {
    const list = el('div', 'faisal-office-slides');
    m.slides.forEach((paragraphs, slide) => {
      const section = el('section', 'faisal-office-slide');
      section.append(el('h3', 'faisal-office-slidehead', t('office.slide', { n: slide + 1 })));
      if (!paragraphs.length) section.append(el('p', 'faisal-office-note', t('office.emptySlide')));
      paragraphs.forEach((text, index) => {
        section.append(textField(text, (area) => {
          if (model?.kind !== 'pptx') return;
          const before = model.slides[slide]?.[index] ?? '';
          if (before !== area.value) commit(slideTextEdit(slide, index, before, area.value));
        }));
      });
      list.append(section);
    });
    return list;
  }

  function renderText(m: TextModel): HTMLElement {
    const area = el('textarea', 'faisal-office-text');
    area.value = m.text;
    area.dir = 'auto';
    area.spellcheck = false;
    area.readOnly = !editable;
    area.addEventListener('input', () => {
      if (model?.kind !== 'text') return;
      const before = model.text;
      if (before !== area.value) commit(textEdit(before, area.value));
    });
    return area;
  }

  function renderSheets(m: SheetsModel): HTMLElement {
    const wrap = el('div', 'faisal-office-sheets');
    const sheet = m.active >= 0 && m.active < m.grids.length ? m.active : 0;
    if (m.grids.length > 1) {
      const tabs = el('div', 'faisal-office-tabs');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', t('office.formatsTitle'));
      m.grids.forEach((grid, i) => {
        const tab = action(grid.name, () => {
          if (!isSheets(model)) return;
          model.active = i;
          active = null;
          render();
        });
        tab.className = 'faisal-office-tab';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(i === sheet));
        tabs.append(tab);
      });
      wrap.append(tabs);
    }

    const grid = m.grids[sheet];
    if (!grid) {
      wrap.append(el('div', 'faisal-office-note', t('office.emptyNote')));
      return wrap;
    }
    const width = Math.max(1, Math.min(gridWidth(grid), VIEW_COLS));
    const shownRows = Math.min(grid.rows.length, VIEW_ROWS);
    const scroll = el('div', 'faisal-office-gridwrap');
    // Spreadsheets keep column order left-to-right even in Arabic: A1 is A1.
    scroll.dir = 'ltr';
    const table = el('table', 'faisal-office-table');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', 'faisal-office-corner', ''));
    for (let c = 0; c < width; c++) headRow.append(el('th', 'faisal-office-colhead', columnName(c)));
    thead.append(headRow);
    const tbody = el('tbody');
    for (let r = 0; r < shownRows; r++) {
      const tr = el('tr');
      tr.append(el('th', 'faisal-office-rowhead', String(r + 1)));
      for (let c = 0; c < width; c++) {
        const cell = el('td', 'faisal-office-celld');
        const input = el('input', 'faisal-office-cell');
        input.type = 'text';
        input.dir = 'auto';
        input.spellcheck = false;
        input.readOnly = !editable;
        input.value = grid.rows[r]?.[c] ?? '';
        input.dataset.r = String(r);
        input.dataset.c = String(c);
        input.setAttribute('aria-label', `${columnName(c)}${r + 1}`);
        input.addEventListener('focus', () => { active = { row: r, col: c }; syncTools(); });
        input.addEventListener('input', () => {
          if (!isSheets(model)) return;
          const before = gridAt(model, sheet)?.rows[r]?.[c] ?? '';
          if (before !== input.value) commit(cellEdit(sheet, r, c, before, input.value));
        });
        cell.append(input);
        tr.append(cell);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    scroll.append(table);
    wrap.append(scroll);

    // Two different limits, said differently: the reader's cut is permanent for the
    // model, the window's cut is only about what is drawn.
    if (grid.truncated) wrap.append(el('div', 'faisal-office-more', t('office.cutNote', { rows: MAX_ROWS, cols: MAX_COLS })));
    else if (grid.rows.length > shownRows || gridWidth(grid) > width) {
      wrap.append(el('div', 'faisal-office-more', t('office.viewLimit', { rows: shownRows, cols: width })));
    }
    return wrap;
  }

  function bodyFor(m: OfficeModel): HTMLElement {
    switch (m.kind) {
      case 'docx': return renderDoc(m);
      case 'pptx': return renderDeck(m);
      case 'text': return renderText(m);
      default: return renderSheets(m);
    }
  }

  function focusActive(): void {
    const at = active;
    if (!at) return;
    const input = contentHost.querySelector<HTMLInputElement>(`input[data-r="${at.row}"][data-c="${at.col}"]`);
    input?.focus();
  }

  function render(): void {
    if (!model) return;
    const keepFocus = contentHost.contains(document.activeElement);
    contentHost.replaceChildren(bodyFor(model));
    if (keepFocus) focusActive();
    syncBar();
  }

  /* ─────────────────────────── refusal screens ─────────────────────────── */

  function showRefusal(kind: RefusalView): void {
    model = null;
    editable = false;
    active = null;
    const card = el('div', 'faisal-office-card');
    card.append(el('div', 'faisal-office-card-title', t(REFUSAL_TITLE[kind])));
    const vars = kind === 'unknown'
      ? { edit: extList('edit'), read: extList('read-only') }
      : undefined;
    card.append(el('p', 'faisal-office-card-text', t(REFUSAL_BODY[kind], vars)));
    contentHost.replaceChildren(card);
    setNote('');
    syncBar();
  }

  /* ──────────────────────────────── load ──────────────────────────────── */

  async function open(): Promise<void> {
    if (!filePath) return;
    if (!withinHome(filePath)) { showRefusal('outside'); return; }
    plan = planFor(filePath);
    model = null;
    editable = false;
    active = null;
    history.reset();
    contentHost.replaceChildren(el('div', 'faisal-office-note', t('office.loading')));
    setStatus(t('office.loading'));
    setNote('');
    syncBar();

    let bytes: Uint8Array;
    try {
      bytes = await vfs.readFile(filePath);
    } catch (err) {
      if (closed) return;
      showRefusal('damaged');
      setStatus(errorMessage(err));
      return;
    }
    if (closed) return;
    if (plan.kind === 'text' && bytes.length > TEXT_LIMIT) { showRefusal('toolarge'); return; }

    const result = await loadOfficeFile(filePath, bytes);
    if (closed) return;
    if (!result.ok) { showRefusal(result.refusal); return; }

    plan = result.plan;
    model = result.model;
    history.reset();
    active = isSheets(model) ? { row: 0, col: 0 } : null;
    editable = !plan.readOnly;
    render();
    setStatus('');
    if (result.empty) setNote(t('office.emptyNote'));
    else if (plan.readOnly) setNote(t('office.macrosBody'));
    else if (plan.ext === '.md') setNote(t('office.markdownNote'));
    else setNote('');
  }

  /* ──────────────────────────── save / revert ──────────────────────────── */

  async function save(): Promise<void> {
    if (!filePath || !model || !editable || busy) return;
    if (isTruncated(model)) {
      const proceed = await shellConfirm({
        title: t('office.truncatedTitle'),
        message: t('office.truncatedBody', { rows: MAX_ROWS, cols: MAX_COLS }),
        okLabel: t('office.truncatedOk'),
        cancelLabel: t('office.cancel'),
        danger: true,
      });
      if (!proceed) return;
    }
    busy = true;
    syncBar();
    try {
      const result = await saveWithBackup(vfs, filePath, serializeModel(model));
      history.markSaved();
      model = clearTruncated(model);
      render();
      setStatus(result.backup ? t('office.savedWithBackup', { name: basename(result.backup) }) : t('office.saved'));
    } catch (err) {
      setStatus(t('office.saveFailed', { message: errorMessage(err) }));
    } finally {
      busy = false;
      syncBar();
    }
  }

  async function revert(): Promise<void> {
    if (!filePath || busy) return;
    if (history.dirty) {
      const proceed = await shellConfirm({
        title: t('office.revertTitle'),
        message: t('office.revertBody', { name: basename(filePath) }),
        okLabel: t('office.revertOk'),
        cancelLabel: t('office.cancel'),
        danger: true,
      });
      if (!proceed) return;
    }
    await open();
  }

  /* ───────────────────────────── wiring ───────────────────────────── */

  root.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      void save();
    }
  });

  win.setCloseGuard(() => {
    if (!history.dirty) return true;
    return shellConfirm({
      title: t('office.discardTitle'),
      message: t('office.discardBody', { name: filePath ? basename(filePath) : t('office.title') }),
      okLabel: t('office.discard'),
      cancelLabel: t('office.keep'),
      danger: true,
    });
  });

  const onBeforeUnload = (ev: BeforeUnloadEvent) => { if (history.dirty) ev.preventDefault(); };
  window.addEventListener('beforeunload', onBeforeUnload);
  win.onClose(() => {
    closed = true;
    window.removeEventListener('beforeunload', onBeforeUnload);
  });

  if (!filePath) {
    contentHost.replaceChildren(el('div', 'faisal-office-note', t('office.noFile')));
    syncBar();
    return;
  }
  void open();
}

const app: AppModule = { manifest, launch };
export default app;
