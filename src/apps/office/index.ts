/**
 * Office (المكتب) — Writer, spreadsheets and slides in one window.
 *
 * It is a **store-only** app: the manifest sets `defaultInstalled: false` and
 * `core: false`, so it appears in the Store as something the owner installs.
 *
 * This file is the window: the app bar (file name, saved state, undo/redo, Save),
 * the ribbon, the status bar, the start screen, and — unchanged in substance —
 * the file lifecycle: open, the surgical save that patches the original package,
 * the one-backup rule, revert, and the close guard. The editors themselves live in
 * `writer/`, `grid/` and `impress/` and change the model only through `commit`.
 *
 * Safety rules that hold everywhere:
 *  • every piece of text is put into the DOM with `textContent` (or `value`),
 *    never as markup — a file's content is never HTML;
 *  • saving writes only inside /home/user, always keeps exactly one `.bak`,
 *    refuses when the model could not be read, and re-reads the file before it
 *    says it saved.
 */
import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { VFSError } from '../../kernel/types';
import { basename, dirname, normalize } from '../../kernel/path';
import { getLocale, t } from '../../kernel/i18n';
import { shellConfirm } from '../../shell/dialog';
import { saveAsDialog } from '../../shell/save-as';
import { MAX_COLS, MAX_ROWS, readDocx } from '../viewer/formats';
import {
  History, VERIFIED_FORMATS, clearTruncated, emptyModel, isTruncated, planFor, textEdit,
  type Edit, type FormatPlan, type OfficeModel, type SheetsModel, type SupportLevel,
} from './model';
import { computeSheets, parseFormula } from './formula/index';
import { loadOfficeFile, serializeModel, type LoadRefusal } from './file';
import { patchPackage, packageKind, snapshotModel, type PatchResult } from './patch';
import { backupPathFor, saveWithBackup, withinHome } from './save';
import { defaultSaveFormat, saveFormatChoices, serializeAs, type SaveFormatId } from './save-as';
import { writePptx } from './pptx';
import { writeDelimited } from './file';
import type { Editor, EditorContext } from './editor';
import { button, clamp, downloadBytes, el, NARROW_BREAKPOINT, observeSize } from './ui/dom';
import { icon } from './ui/icons';
import { closePopovers } from './ui/popover';
import { Ribbon, type RibbonTab } from './ui/ribbon';
import { printNodes } from './ui/print';
import { readDocxDocument, type DocLook } from './writer/docxread';
import { emptyDocxPackage, rebuildDocxRich } from './writer/docxpatch';
import { blockText } from './writer/types';
import { createWriter } from './writer/view';
import { readBookLook, type BookLook } from './grid/xlsxlook';
import { createSheet } from './grid/view';
import { createDeck } from './impress/view';
import { renderStart, rememberRecent, type NewKind } from './start';
import './strings';
import './office.css';

/** A text buffer larger than this is refused: a textarea is not a file viewer. */
const TEXT_LIMIT = 4 * 1024 * 1024;

const KIND_LABEL: Record<string, string> = {
  docx: 'office.kindDoc', xlsx: 'office.kindSheet', csv: 'office.kindCsv', pptx: 'office.kindSlides', text: 'office.kindText',
};

type RefusalView = LoadRefusal | 'outside' | 'toolarge';
const REFUSAL_TITLE: Record<RefusalView, string> = {
  legacy: 'office.legacyTitle', unknown: 'office.unknownTitle', binary: 'office.binaryTitle',
  damaged: 'office.readErrorTitle', outside: 'office.outsideTitle', toolarge: 'office.tooLargeTitle',
};
const REFUSAL_BODY: Record<RefusalView, string> = {
  legacy: 'office.legacyBody', unknown: 'office.unknownBody', binary: 'office.binaryBody',
  damaged: 'office.readErrorBody', outside: 'office.outsideBody', toolarge: 'office.tooLargeBody',
};

/** The shortcut table: the F1 sheet is generated from the same list the handler reads. */
export const SHORTCUTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: 'Ctrl+S', label: 'office.save' },
  { keys: 'Ctrl+Z', label: 'office.undo' },
  { keys: 'Ctrl+Y / Ctrl+Shift+Z', label: 'office.redo' },
  { keys: 'Ctrl+B', label: 'office.formatBold' },
  { keys: 'Ctrl+I', label: 'office.formatItalic' },
  { keys: 'Ctrl+U', label: 'office.formatUnderline' },
  { keys: 'Ctrl+F', label: 'office.find' },
  { keys: 'Ctrl+H', label: 'office.replace' },
  { keys: 'Ctrl+P', label: 'office.print' },
  { keys: 'F5', label: 'office.presentFromStart' },
  { keys: 'F1', label: 'office.shortcuts' },
];

function extList(level: SupportLevel): string {
  return VERIFIED_FORMATS.filter((f) => f.level === level).map((f) => f.ext).join(', ');
}

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  const vfs = sys.vfs;
  let filePath: string | null = args[0] ? normalize(args[0]) : null;

  let plan: FormatPlan = planFor(filePath ?? '');
  let model: OfficeModel | null = null;
  let editable = false;
  let busy = false;
  let closed = false;
  let onDiskBytes: Uint8Array | null = null;
  let onDiskModel: OfficeModel | null = null;
  let editor: Editor | null = null;
  let docLook: DocLook | null = null;
  let bookLook: BookLook | null = null;
  let statusMessage = '';
  const history = new History();

  /* ─────────────────────────────── frame ─────────────────────────────── */

  win.content.textContent = '';
  const root = el('div', 'faisal-office');
  root.setAttribute('lang', getLocale());

  const appbar = el('header', 'fo-appbar');
  const brand = el('span', 'fo-appicon');
  brand.append(icon('doc'));
  const info = el('div', 'faisal-office-info fo-info');
  const nameEl = el('div', 'faisal-office-name fo-docname', t('office.title'));
  const metaEl = el('div', 'faisal-office-meta fo-docmeta');
  info.append(nameEl, metaEl);
  const undoBtn = button('undo', t('office.undo'), () => undo());
  const redoBtn = button('redo', t('office.redo'), () => redo());
  const helpBtn = button('help', t('office.help'), () => toggleHelp());
  const saveBtn = button('save', t('office.save'), () => { void save(); }, { primary: true, showLabel: true });
  const actions = el('div', 'fo-appactions');
  actions.append(undoBtn, redoBtn, helpBtn, saveBtn);
  appbar.append(brand, info, actions);

  const ribbon = new Ribbon({ more: t('office.more'), tabs: t('office.ribbon') });
  const noteEl = el('div', 'faisal-office-notice fo-banner');
  noteEl.setAttribute('role', 'note');
  noteEl.hidden = true;
  const contentHost = el('div', 'faisal-office-body fo-body');

  const statusBar = el('footer', 'fo-statusbar');
  const statusParts = el('div', 'fo-status-parts');
  const statusEl = el('div', 'faisal-office-status fo-status-msg');
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  const zoomBox = el('div', 'fo-zoom');
  const zoomOut = button('minus', t('office.zoomOut'), () => zoomBy(-0.1));
  const zoomLabel = el('span', 'fo-zoom-value');
  const zoomIn = button('plus', t('office.zoomIn'), () => zoomBy(0.1));
  zoomBox.append(zoomOut, zoomLabel, zoomIn);
  const pathEl = el('div', 'faisal-office-path fo-path', filePath ?? '');
  pathEl.dir = 'ltr';
  statusBar.append(statusParts, statusEl, pathEl, zoomBox);

  const help = buildHelp();
  root.append(appbar, ribbon.element, noteEl, contentHost, ribbon.phoneBar, statusBar, help);
  win.content.append(root);

  const narrowObserver = observeSize(root, () => {
    root.classList.toggle('is-narrow', root.clientWidth > 0 && root.clientWidth < NARROW_BREAKPOINT);
  });
  // A roomy window for a document editor on a desktop screen.
  try {
    if (window.innerWidth >= 1024 && win.content.clientWidth > 0 && win.content.clientWidth < 820) sys.wm?.toggleMaximize(win.id);
  } catch { /* no window manager here (tests) */ }

  function buildHelp(): HTMLElement {
    const panel = el('div', 'fo-help');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('office.help'));
    const head = el('div', 'fo-panel-head');
    head.append(el('h2', 'fo-panel-title', t('office.help')), button('close', t('office.closePanel'), () => toggleHelp(false)));
    const body = el('div', 'fo-panel-body');
    body.append(el('h3', 'fo-section-title', t('office.shortcuts')));
    const keys = el('dl', 'fo-keys');
    for (const s of SHORTCUTS) keys.append(el('dt', undefined, s.keys), el('dd', undefined, t(s.label)));
    body.append(keys);
    const details = el('details', 'faisal-office-limits');
    details.append(el('summary', 'faisal-office-summary', t('office.limitsTitle')));
    const list = el('ul', 'faisal-office-limitlist');
    for (const [key, vars] of [
      ['office.limitFormulas'], ['office.limitFormulaEngine'], ['office.limitStyling'], ['office.limitRewrite'], ['office.limitImages'],
      ['office.limitLegacy'], ['office.limitTruncated', { rows: MAX_ROWS, cols: MAX_COLS }], ['office.limitSlideBlank'], ['office.limitText'], ['office.limitBackup'],
    ] as Array<[string, Record<string, number>?]>) list.append(el('li', undefined, t(key, vars)));
    const formats = el('ul', 'faisal-office-formatlist');
    formats.append(el('li', undefined, t('office.formatsEdit', { list: extList('edit') })));
    formats.append(el('li', undefined, t('office.formatsReadOnly', { list: extList('read-only') })));
    formats.append(el('li', undefined, t('office.formatsUnsupported', { list: extList('unsupported') })));
    details.append(list, el('div', 'faisal-office-blocktitle', t('office.formatsTitle')), formats);
    body.append(details);
    panel.append(head, body);
    panel.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); toggleHelp(false); } });
    return panel;
  }

  function toggleHelp(force?: boolean): void {
    help.hidden = force === undefined ? !help.hidden : !force;
    if (!help.hidden) help.querySelector<HTMLElement>('button')?.focus();
    else helpBtn.focus({ preventScroll: true });
  }

  /* ─────────────────────────────── state ─────────────────────────────── */

  function setStatus(text: string): void { statusMessage = text; statusEl.textContent = text; }
  function setNote(text: string): void { noteEl.textContent = text; noteEl.hidden = !text; }
  function errorMessage(err: unknown): string {
    if (err instanceof VFSError) return `${err.code}: ${err.path}`;
    return err instanceof Error ? err.message : String(err);
  }
  function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function syncStatus(): void {
    const info2 = editor?.status();
    statusParts.replaceChildren(...(info2?.parts ?? []).map((p) => el('span', 'fo-status-part', p)));
    const zoom = info2?.zoom;
    zoomBox.hidden = !zoom;
    if (zoom) zoomLabel.textContent = `${Math.round(zoom.value * 100)}%`;
    statusEl.textContent = statusMessage;
  }

  function zoomBy(step: number): void {
    const zoom = editor?.status().zoom;
    if (zoom) zoom.set(clamp(zoom.value + step, 0.5, 2));
    syncStatus();
  }

  function syncBar(): void {
    const name = filePath ? basename(filePath) : t('office.title');
    nameEl.textContent = name;
    nameEl.title = filePath ?? '';
    const parts: string[] = [];
    if (filePath) parts.push(t(KIND_LABEL[plan.kind ?? ''] ?? 'office.kindOther'));
    if (plan.readOnly) parts.push(t('office.readOnlyBadge'));
    if (filePath) parts.push(history.dirty ? t('office.dirty') : t('office.clean'));
    if (model && isTruncated(model)) parts.push(t('office.truncatedBadge'));
    metaEl.textContent = parts.join(' · ');
    root.classList.toggle('is-dirty', history.dirty);
    win.setTitle(`${history.dirty ? '● ' : ''}${name} — ${t('office.title')}`);
    undoBtn.disabled = !model || history.undoSteps === 0;
    redoBtn.disabled = !model || history.redoSteps === 0;
    saveBtn.disabled = !model || !editable || busy;
    const kind = model?.kind;
    brand.replaceChildren(icon(kind === 'xlsx' || kind === 'csv' ? 'sheet' : kind === 'pptx' ? 'slides' : 'doc'));
    brand.className = `fo-appicon is-${kind === 'xlsx' || kind === 'csv' ? 'sheet' : kind === 'pptx' ? 'slides' : 'doc'}`;
    ribbon.sync();
    syncStatus();
  }

  /** Every formula's value follows the values it reads, on every model change. */
  function recompute(m: OfficeModel): OfficeModel {
    return m.kind === 'xlsx' || m.kind === 'csv' ? computeSheets(m) : m;
  }

  function commit(edit: Edit): void {
    if (!model) return;
    model = recompute(edit.apply(model));
    history.push(edit);
    syncBar();
  }
  function undo(): void {
    if (!model || history.undoSteps === 0) return;
    model = recompute(history.undo(model));
    editor?.render();
    syncBar();
  }
  function redo(): void {
    if (!model || history.redoSteps === 0) return;
    model = recompute(history.redo(model));
    editor?.render();
    syncBar();
  }

  /* ─────────────────────────────── editors ─────────────────────────────── */

  const editorCtx: EditorContext = {
    model: () => model,
    commit,
    undo,
    redo,
    editable: () => editable && !busy,
    refresh: () => { ribbon.sync(); syncStatus(); },
    setStatus,
    host: () => root,
    filePath: () => filePath,
    fileTab,
    exportFile,
    print: (content, css) => printNodes(content, css, filePath ? basename(filePath) : t('office.title')),
  };

  function fileTab(): RibbonTab {
    const kind = model?.kind;
    const writer = editor as (Editor & { printDoc?: () => void; exportHtml?: () => void; exportMd?: () => void }) | null;
    return {
      id: 'file', label: t('office.tabFile'), groups: [
        {
          label: t('office.groupFile'), controls: [
            { type: 'button', id: 'new', icon: 'plus', label: t('office.newFile'), showLabel: true, run: () => { void goStart(); } },
            { type: 'button', id: 'opendevice', icon: 'upload', label: t('office.openDevice'), showLabel: true, run: openDevice },
            { type: 'button', id: 'save2', icon: 'save', label: t('office.saveNow'), showLabel: true, enabled: () => !!model && editable && !busy, run: () => { void save(); } },
            { type: 'button', id: 'saveas', icon: 'save', label: t('office.saveAs'), showLabel: true, enabled: () => !!model && editable && !busy, run: () => { void saveAs(); } },
            { type: 'button', id: 'revert', icon: 'revert', label: t('office.revert'), showLabel: true, enabled: () => !busy && !!filePath, run: () => { void revert(); } },
          ],
        },
        {
          label: t('office.groupExport'), controls: [
            { type: 'button', id: 'print', icon: 'print', label: t('office.print'), showLabel: true, enabled: () => !!model, run: printCurrent },
            { type: 'button', id: 'pdf', icon: 'pdf', label: t('office.exportPdf'), showLabel: true, enabled: () => !!model, run: printCurrent },
            ...(kind === 'docx' ? [
              { type: 'button' as const, id: 'html', icon: 'doc' as const, label: t('office.exportHtml'), showLabel: true, run: () => writer?.exportHtml?.() },
              { type: 'button' as const, id: 'md', icon: 'draft' as const, label: t('office.exportMd'), showLabel: true, run: () => writer?.exportMd?.() },
            ] : []),
            ...(kind === 'xlsx' ? [{ type: 'button' as const, id: 'csv', icon: 'csv' as const, label: t('office.exportCsv'), showLabel: true, run: exportCsv }] : []),
          ],
        },
      ],
    };
  }

  function printCurrent(): void {
    const writer = editor as (Editor & { printDoc?: () => void }) | null;
    if (writer?.printDoc) { writer.printDoc(); return; }
    if (!model) return;
    const box = el('div');
    if (model.kind === 'xlsx' || model.kind === 'csv') {
      const grid = model.grids[model.active];
      const table = el('table');
      for (const row of grid?.rows ?? []) {
        const tr = el('tr');
        for (const cell of row) { const td = el('td', undefined, cell); td.dir = 'auto'; tr.append(td); }
        table.append(tr);
      }
      box.append(table);
      printNodes(box, 'table{border-collapse:collapse;font:10pt Calibri,Arial,sans-serif}td{border:1px solid #999;padding:2px 6px}', basename(filePath ?? ''));
    } else if (model.kind === 'pptx') {
      for (const slide of model.slides) {
        const page = el('section');
        slide.forEach((p, i) => { const n = el(i === 0 ? 'h1' : 'p', undefined, p); n.dir = 'auto'; page.append(n); });
        box.append(page);
      }
      printNodes(box, '@page{size:landscape}section{break-after:page;font-family:Calibri,Arial,sans-serif}h1{font-size:32pt}p{font-size:18pt}', basename(filePath ?? ''));
    } else if (model.kind === 'text') {
      const pre = el('pre', undefined, model.text);
      box.append(pre);
      printNodes(box, 'pre{white-space:pre-wrap;font:11pt monospace}', basename(filePath ?? ''));
    }
  }

  function exportCsv(): void {
    if (!model || (model.kind !== 'xlsx' && model.kind !== 'csv')) return;
    void exportFile(writeDelimited(model.grids[model.active]?.rows ?? [], ','), 'csv', 'text/csv');
  }

  async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
    let n = 0;
    for (;;) {
      const candidate = `${dir}/${base}${n ? ` (${n})` : ''}.${ext}`;
      if (!(await vfs.exists(candidate))) return candidate;
      n++;
    }
  }

  async function exportFile(data: Uint8Array | string, ext: string, mime: string): Promise<void> {
    const dir = filePath ? dirname(filePath) : '/home/user/Documents';
    const base = filePath ? basename(filePath).replace(/\.[^.]+$/, '') : t('office.untitled');
    try {
      const target = await uniquePath(dir, base, ext);
      await vfs.writeFile(target, data);
      downloadBytes(data, basename(target), mime);
      setStatus(t('office.exported', { name: basename(target) }));
    } catch (err) {
      setStatus(t('office.exportFailed', { message: errorMessage(err) }));
    }
  }

  function mountEditor(): void {
    editor?.dispose();
    editor = null;
    if (!model) return;
    switch (model.kind) {
      case 'docx': editor = createWriter(editorCtx, docLook); break;
      case 'xlsx': case 'csv': editor = createSheet(editorCtx, bookLook); break;
      case 'pptx': editor = createDeck(editorCtx); break;
      default: editor = createTextEditor(); break;
    }
    contentHost.replaceChildren(editor.element);
    ribbon.setTabs(editor.tabs(), model.kind === 'pptx' ? 'home' : 'home');
    root.dataset.kind = model.kind;
    editor.render();
  }

  function createTextEditor(): Editor {
    const area = el('textarea', 'faisal-office-text fo-textedit');
    area.dir = 'auto';
    area.spellcheck = false;
    area.setAttribute('aria-label', t('office.kindText'));
    area.addEventListener('input', () => {
      if (model?.kind !== 'text') return;
      if (model.text !== area.value) commit(textEdit(model.text, area.value));
    });
    const wrap = el('div', 'fo-textwrap');
    wrap.append(area);
    return {
      element: wrap,
      tabs: () => [fileTab()],
      render: () => { if (model?.kind === 'text') area.value = model.text; area.readOnly = !editable; },
      status: () => ({ parts: model?.kind === 'text' ? [t('office.statusChars', { n: model.text.length })] : [] }),
      dispose: () => undefined,
    };
  }

  /* ─────────────────────────── refusal screens ─────────────────────────── */

  function showRefusal(kind: RefusalView): void {
    model = null;
    editable = false;
    onDiskBytes = null;
    onDiskModel = null;
    editor?.dispose();
    editor = null;
    const card = el('div', 'faisal-office-card fo-refusal');
    const art = el('span', 'fo-refusal-art');
    art.append(icon('info', 32));
    card.append(art, el('div', 'faisal-office-card-title', t(REFUSAL_TITLE[kind])));
    const vars = kind === 'unknown' ? { edit: extList('edit'), read: extList('read-only') } : undefined;
    card.append(el('p', 'faisal-office-card-text', t(REFUSAL_BODY[kind], vars)));
    const back = button('back', t('office.backToStart'), () => { void goStart(); }, { showLabel: true });
    card.append(back);
    contentHost.replaceChildren(card);
    ribbon.setTabs([fileTab()], 'file');
    setNote('');
    syncBar();
  }

  /* ──────────────────────────────── load ──────────────────────────────── */

  /** Adds what the editors need beyond the plain model: runs and look for Word, look and stored formulas for Excel. */
  async function enrich(m: OfficeModel, bytes: Uint8Array): Promise<OfficeModel> {
    docLook = null;
    bookLook = null;
    if (m.kind === 'docx' && bytes.length) {
      try {
        const read = await readDocxDocument(bytes);
        const texts = await readDocx(bytes);
        const same = read.blocks.length === texts.length && read.blocks.every((b, i) => blockText(b) === texts[i]);
        if (same) {
          docLook = read.look;
          return { kind: 'docx', paragraphs: texts, blocks: read.blocks, ...(Object.keys(read.formats).length ? { formats: read.formats } : {}) };
        }
      } catch { /* the plain paragraphs still edit and save */ }
      return { kind: 'docx', paragraphs: m.paragraphs, blocks: m.paragraphs.map((text, id) => ({ id, runs: [{ t: 'text', text, props: {} }] })), ...(m.formats ? { formats: m.formats } : {}) };
    }
    if (m.kind === 'docx') {
      return { kind: 'docx', paragraphs: m.paragraphs, blocks: m.paragraphs.map((text, id) => ({ id, runs: [{ t: 'text', text, props: {} }] })) };
    }
    if (m.kind === 'xlsx' && bytes.length) {
      try {
        bookLook = await readBookLook(bytes);
        // The file's own formulas this app can compute join the model, so totals show even
        // when the file stored no cached value; the rest stay as the values Excel saved.
        const formulas: Record<string, string> = { ...(m.formulas ?? {}) };
        bookLook.sheets.forEach((sheet, s) => {
          const grid = m.grids[s];
          if (!grid) return;
          for (const [key, formula] of sheet.formulas) {
            const [r, c] = key.split(':').map(Number);
            if (parseFormula(formula).ok) formulas[`${s}:${r}:${c}`] = formula;
          }
        });
        if (Object.keys(formulas).length) return { ...m, formulas } as SheetsModel;
      } catch { bookLook = null; }
    }
    return m;
  }

  async function open(): Promise<void> {
    if (!filePath) return;
    pathEl.textContent = filePath;
    if (!withinHome(filePath)) { showRefusal('outside'); return; }
    plan = planFor(filePath);
    model = null;
    editable = false;
    history.reset();
    const loading = el('div', 'fo-loading');
    loading.append(el('span', 'fo-spinner'), el('span', undefined, t('office.loading')));
    contentHost.replaceChildren(loading);
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
    const enriched = await enrich(result.model, bytes);
    if (closed) return;
    // The disk state is what the file reads as, before this app recomputes anything.
    onDiskBytes = bytes;
    onDiskModel = snapshotModel(enriched);
    model = recompute(enriched);
    history.reset();
    editable = !plan.readOnly;
    rememberRecent(filePath);
    mountEditor();
    setStatus('');
    if (result.empty) setNote(t('office.emptyNote'));
    else if (plan.readOnly) setNote(t('office.macrosBody'));
    else if (plan.ext === '.md') setNote(t('office.markdownNote'));
    else setNote('');
    syncBar();
  }

  async function openPath(path: string): Promise<void> {
    if (history.dirty && model) {
      const proceed = await shellConfirm({
        title: t('office.discardTitle'), message: t('office.discardBody', { name: filePath ? basename(filePath) : t('office.title') }),
        okLabel: t('office.discard'), cancelLabel: t('office.keep'), danger: true,
      });
      if (!proceed) return;
    }
    filePath = normalize(path);
    await open();
  }

  /* ─────────────────────────── start screen & new files ─────────────────────────── */

  async function goStart(): Promise<void> {
    if (history.dirty && model) {
      const proceed = await shellConfirm({
        title: t('office.discardTitle'), message: t('office.discardBody', { name: filePath ? basename(filePath) : t('office.title') }),
        okLabel: t('office.discard'), cancelLabel: t('office.keep'), danger: true,
      });
      if (!proceed) return;
    }
    editor?.dispose();
    editor = null;
    model = null;
    filePath = null;
    plan = planFor('');
    history.reset();
    pathEl.textContent = '';
    root.dataset.kind = 'start';
    contentHost.replaceChildren(renderStart({ create: (k) => { void createNew(k); }, open: (p) => { void openPath(p); }, openDevice }, vfs));
    ribbon.setTabs([fileTab()], 'file');
    setNote('');
    syncBar();
  }

  function newBytes(kind: NewKind): Uint8Array {
    if (kind === 'docx') return emptyDocxPackage(getLocale() === 'ar');
    if (kind === 'pptx') return writePptx([[t('office.newDeckTitle'), t('office.newDeckSubtitle')]]);
    return serializeModel(emptyModel(planFor('a.xlsx')));
  }

  async function createNew(kind: NewKind): Promise<void> {
    const base = kind === 'docx' ? t('office.untitledDoc') : kind === 'xlsx' ? t('office.untitledSheet') : t('office.untitledDeck');
    try {
      const dir = '/home/user/Documents';
      if (!(await vfs.exists(dir))) await vfs.mkdir(dir, { recursive: true });
      const target = await uniquePath(dir, base, kind);
      await vfs.writeFile(target, newBytes(kind));
      filePath = target;
      await open();
      setStatus(t('office.created', { name: basename(target) }));
    } catch (err) {
      setStatus(t('office.saveFailed', { message: errorMessage(err) }));
    }
  }

  function openDevice(): void {
    const input = el('input');
    input.type = 'file';
    input.accept = VERIFIED_FORMATS.filter((f) => f.level !== 'unsupported').map((f) => f.ext).join(',');
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const dir = '/home/user/Documents';
        if (!(await vfs.exists(dir))) await vfs.mkdir(dir, { recursive: true });
        const dot = file.name.lastIndexOf('.');
        const target = await uniquePath(dir, dot > 0 ? file.name.slice(0, dot) : file.name, dot > 0 ? file.name.slice(dot + 1) : 'txt');
        await vfs.writeFile(target, new Uint8Array(await file.arrayBuffer()));
        await openPath(target);
      } catch (err) {
        setStatus(t('office.saveFailed', { message: errorMessage(err) }));
      }
    });
    input.click();
  }

  /* ──────────────────────────── save / revert ──────────────────────────── */

  async function save(): Promise<void> {
    if (!filePath || !model || !editable || busy) return;
    const kind = packageKind(plan.kind);
    let patched: PatchResult | null = null;
    if (kind && onDiskBytes && onDiskModel) patched = await patchPackage(kind, onDiskBytes, onDiskModel, model);
    if (kind && !patched) {
      const proceed = await shellConfirm({
        title: t('office.rebuildTitle'),
        message: t('office.rebuildBody', { name: basename(backupPathFor(filePath)) }),
        okLabel: t('office.rebuildOk'),
        cancelLabel: t('office.cancel'),
        danger: true,
      });
      if (!proceed) return;
    }
    if (!patched && isTruncated(model)) {
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
    setStatus(t('office.saving'));
    try {
      let data: Uint8Array;
      if (patched) data = patched.bytes;
      else if (model.kind === 'docx' && model.blocks) data = (await rebuildDocxRich(model)) ?? serializeModel(model);
      else data = serializeModel(model);
      const result = await saveWithBackup(vfs, filePath, data);
      const written = await vfs.readFile(filePath);
      if (!sameBytes(written, data)) {
        throw new Error(`read-back mismatch: wrote ${data.length} bytes, the file holds ${written.length}`);
      }
      history.markSaved();
      // New pictures now live in the file: the model adopts the markup the save generated.
      for (const m of patched?.materialized ?? []) { m.run.xml = m.xml; delete m.run.newImage; }
      if (!patched) {
        model = clearTruncated(model);
        // A rebuilt file is re-read, so what the editor shows is what the file now holds.
        model = recompute(await enrich(model, data));
        editor?.dispose();
        mountEditor();
      } else if (model.kind === 'xlsx' && bookLook === null) {
        bookLook = await readBookLook(data).catch(() => null);
      }
      // The file now holds this structure: nothing has moved relative to it any more.
      if ((model.kind === 'xlsx' || model.kind === 'csv') && model.moved) { model = { ...model }; delete (model as SheetsModel).moved; }
      onDiskBytes = data;
      onDiskModel = snapshotModel(model);
      editor?.render();
      setStatus(result.backup ? t('office.savedWithBackup', { name: basename(result.backup) }) : t('office.saved'));
    } catch (err) {
      setStatus(t('office.saveFailed', { message: errorMessage(err) }));
    } finally {
      busy = false;
      syncBar();
    }
  }

  /**
   * «حفظ باسم» — the shared shell dialog (Ctrl+Shift+S, and the File tab).
   *
   * Unlike the in-place save this always writes a COMPLETE document, so a package the patcher
   * refused is perfectly fine here; the truncation warning still applies, because writing a
   * fresh file is exactly what would drop the rows past the cap. Afterwards the new file is
   * re-opened, so the editor shows what the file really holds.
   */
  async function saveAs(): Promise<void> {
    if (!model || !editable || busy) return;
    const source = model;
    if (isTruncated(source)) {
      const proceed = await shellConfirm({
        title: t('office.truncatedTitle'),
        message: t('office.truncatedBody', { rows: MAX_ROWS, cols: MAX_COLS }),
        okLabel: t('office.truncatedOk'),
        cancelLabel: t('office.cancel'),
        danger: true,
      });
      if (!proceed) return;
    }
    const currentExt = filePath ? plan.ext.replace(/^\./, '') : '';
    const formats = saveFormatChoices(source, currentExt).map((choice) => ({
      value: choice.value, label: t(choice.labelKey), ext: choice.ext, mime: choice.mime,
    }));
    const dir = filePath ? dirname(filePath) : '/home/user/Documents';
    const name = filePath ? basename(filePath).replace(/\.[^.]+$/, '') : t('office.untitled');

    busy = true;
    syncBar();
    const outcome = await saveAsDialog({
      vfs,
      host: win.content,
      title: t('office.saveAs'),
      dir,
      name,
      formats,
      format: defaultSaveFormat(source, currentExt),
      encode: async (target) => {
        const format = target.format as SaveFormatId;
        // A rich Word document is rebuilt (runs, images, tables), exactly like the in-place save.
        if (format === 'docx' && source.kind === 'docx' && source.blocks) {
          return (await rebuildDocxRich(source)) ?? serializeAs(source, 'docx');
        }
        return serializeAs(source, format);
      },
    });
    busy = false;
    syncBar();
    if (outcome.status !== 'saved') return;
    filePath = normalize(outcome.path);
    await open();
    setStatus(t('office.saveAsDone', { name: basename(filePath) }));
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
    // The shared Save as dialog owns the keyboard while it is open (it is mounted in this
    // window, so its overlay is the honest test — the component itself is not modified here).
    if (win.content.querySelector('.faisal-saveas-overlay')) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    if (ev.key === 'F1') { ev.preventDefault(); toggleHelp(true); return; }
    if (mod && key === 's' && ev.shiftKey) { ev.preventDefault(); void saveAs(); return; }
    if (mod && key === 's') { ev.preventDefault(); void save(); return; }
    if (mod && key === 'z' && !ev.shiftKey) {
      const target = ev.target as HTMLElement;
      // A plain text field keeps its own undo while it has focus in the sheet's formula bar.
      if (target.classList.contains('fo-fxinput') || target.classList.contains('fo-namebox')) return;
      ev.preventDefault(); undo(); return;
    }
    if (mod && (key === 'y' || (key === 'z' && ev.shiftKey))) { ev.preventDefault(); redo(); return; }
    if (mod && key === 'o') { ev.preventDefault(); openDevice(); return; }
    if (editor?.onKey?.(ev)) { ev.preventDefault(); return; }
    if (mod && key === 'p') { ev.preventDefault(); printCurrent(); }
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

  const onBeforeUnload = (ev: BeforeUnloadEvent): void => { if (history.dirty) ev.preventDefault(); };
  window.addEventListener('beforeunload', onBeforeUnload);
  win.onClose(() => {
    closed = true;
    closePopovers();
    narrowObserver.disconnect();
    editor?.dispose();
    window.removeEventListener('beforeunload', onBeforeUnload);
  });

  root.addEventListener('dragover', (ev) => { if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault(); });
  root.addEventListener('drop', (ev) => {
    const file = ev.dataTransfer?.files?.[0];
    if (!file) return;
    ev.preventDefault();
    void (async () => {
      const dir = '/home/user/Documents';
      if (!(await vfs.exists(dir))) await vfs.mkdir(dir, { recursive: true });
      const dot = file.name.lastIndexOf('.');
      const target = await uniquePath(dir, dot > 0 ? file.name.slice(0, dot) : file.name, dot > 0 ? file.name.slice(dot + 1) : 'txt');
      await vfs.writeFile(target, new Uint8Array(await file.arrayBuffer()));
      await openPath(target);
    })();
  });

  if (!filePath) { void goStart(); return; }
  void open();
}

const app: AppModule = { manifest, launch };
export default app;
