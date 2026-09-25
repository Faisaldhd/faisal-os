/**
 * Office (المكتب) — Writer, spreadsheets and slides in one window.
 *
 * It ships **installed by default** (the owner's decision, 2026-09-25): the manifest sets
 * `defaultInstalled: true` and keeps `core: false`, so the editor is in the launcher from the
 * first run and a .docx or .xlsx opens here instead of the read-only File Viewer — while still
 * being removable from the Store.
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
import { entryData, readRawZip } from './zip';
import { emptyLog, type Revision, type RevisionLog } from './writer/revisions';
import { trackedRevisionsIn } from './writer/trackfile';
import { backupPathFor, saveFailure, saveWithBackup, withinHome } from './save';
import { formatBytes } from '../files/format';
import {
  defaultSaveFormat, saveFormatChoices, serializeAs, type SaveFormatId,
} from './save-as';
import { newDeckPptx } from './pptx';
import { odtTitleOf, toOdt } from './writer/odt';
import { deckTexts, readDeck } from './impress/deck';
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
import {
  AUTOSAVE_INTERVALS, AUTOSAVE_KEY, AUTOSAVE_TICK_MS, clampInterval, formatClock,
  newestRecovery, parseAutosavePrefs, recoveryPathFor, serializeAutosavePrefs, shouldAutosave,
  type AutosavePrefs,
} from './writer/autosave';
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

  /* ───────────────────────────── autosave state ───────────────────────────── */
  // The recovery copy never touches the document or its `.bak`: it is a separate file beside it.
  let autosave: AutosavePrefs = loadAutosavePrefs();
  /** Grows with every change; compared against `recoverySeq` so idle documents are not rewritten. */
  let editSeq = 0;
  /** The `editSeq` the recovery copy was last written for. */
  let recoverySeq = 0;
  /** When the last change happened (ms). */
  let lastEditAt = 0;
  /** True while a recovery write is in flight, so two ticks cannot overlap. */
  let recoveryBusy = false;
  let autosaveTimer: ReturnType<typeof setInterval> | null = null;

  function loadAutosavePrefs(): AutosavePrefs {
    try {
      return parseAutosavePrefs(localStorage.getItem(AUTOSAVE_KEY));
    } catch {
      return parseAutosavePrefs(null); // private mode: the default, for this window only
    }
  }

  function storeAutosavePrefs(): void {
    try {
      localStorage.setItem(AUTOSAVE_KEY, serializeAutosavePrefs(autosave));
    } catch { /* private mode: lives for this window only */ }
  }

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
  /**
   * What to tell the owner about a failed write. A refusal by the storage limits becomes a
   * translated sentence naming the limit that was hit — never the raw `EINVAL: /path` the kernel
   * throws, which says nothing to anyone who does not read the source.
   */
  function errorMessage(err: unknown, bytes?: number): string {
    if (err instanceof VFSError) {
      if (typeof bytes === 'number') {
        const why = saveFailure(err, bytes, vfs.quota);
        if (why === 'file-too-big') return t('office.saveTooBig', { max: formatBytes(vfs.quota.file, getLocale()) });
        if (why === 'storage-full') return t('office.storeFull', { total: formatBytes(vfs.quota.total, getLocale()) });
        if (why === 'outside-home') return t('office.outsideHome');
      } else if (err.code === 'EACCES') {
        return t('office.outsideHome');
      }
      return `${err.code}: ${err.path}`;
    }
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
    editSeq++;
    lastEditAt = Date.now();
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
    const writer = editor as (Editor & { printDoc?: () => void; exportHtml?: () => void; exportMd?: () => void; exportOdt?: () => void }) | null;
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
              { type: 'button' as const, id: 'odt', icon: 'draft' as const, label: t('office.exportOdt'), showLabel: true, run: () => writer?.exportOdt?.() },
            ] : []),
            ...(kind === 'xlsx' ? [{ type: 'button' as const, id: 'csv', icon: 'csv' as const, label: t('office.exportCsv'), showLabel: true, run: exportCsv }] : []),
          ],
        },
        // Writer's autosave settings, where the rest of the app's settings live. The recovery copy
        // is the only thing it writes — never the document, never its `.bak`.
        {
          label: t('office.groupAutosave'), controls: [
            {
              type: 'button', id: 'autosave', icon: 'save', label: t('office.autosaveToggle'), showLabel: true,
              pressed: () => autosave.on,
              run: () => setAutosave({ on: !autosave.on }),
            },
            {
              type: 'select', id: 'autosaveevery', label: t('office.autosaveEvery', { n: autosave.seconds }), width: 150,
              options: () => AUTOSAVE_INTERVALS.map((n) => ({ value: String(n), label: t('office.autosaveEvery', { n }) })),
              value: () => String(autosave.seconds),
              onChange: (value) => setAutosave({ seconds: Number(value) }),
            },
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
  /** The tracked changes of a Word package, or an empty log when it carries none. */
  async function trackedInDocument(bytes: Uint8Array, blocks: readonly number[]): Promise<RevisionLog> {
    try {
      const xml = await entryData(readRawZip(bytes), 'word/document.xml');
      return xml ? trackedRevisionsIn(new TextDecoder().decode(xml), blocks) : emptyLog();
    } catch {
      return emptyLog();
    }
  }

  /** The pending tracked changes of the open document, as the Writer's own log holds them. */
  function pendingTracked(): Revision[] {
    const writer = editor as (Editor & { pendingRevisions?: () => Revision[] }) | null;
    return writer?.pendingRevisions?.() ?? [];
  }

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
          // The tracked changes the file already carries come with it: a change made in Word shows
          // up as a pending mark here instead of being presented as decided text.
          const tracked = await trackedInDocument(bytes, read.blocks.map((block) => block.id));
          return {
            kind: 'docx', paragraphs: texts, blocks: read.blocks,
            ...(Object.keys(read.formats).length ? { formats: read.formats } : {}),
            ...(tracked.items.length ? { tracked } : {}),
          };
        }
      } catch { /* the plain paragraphs still edit and save */ }
      return { kind: 'docx', paragraphs: m.paragraphs, blocks: m.paragraphs.map((text, id) => ({ id, runs: [{ t: 'text', text, props: {} }] })), ...(m.formats ? { formats: m.formats } : {}) };
    }
    if (m.kind === 'docx') {
      return { kind: 'docx', paragraphs: m.paragraphs, blocks: m.paragraphs.map((text, id) => ({ id, runs: [{ t: 'text', text, props: {} }] })) };
    }
    if (m.kind === 'pptx' && bytes.length) {
      // A complete presentation opens in the slide editor; a package without
      // ppt/presentation.xml keeps the plain paragraph view.
      try {
        const deck = await readDeck(bytes);
        if (deck.slides.length) return { kind: 'pptx', slides: deckTexts(deck), deck };
      } catch { /* the plain paragraphs still edit and save */ }
      return m;
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
    // A recovery copy newer than the file it belongs to is offered, never applied silently.
    void offerRecovery();
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
    if (kind === 'pptx') return newDeckPptx(t('office.newDeckTitle'), t('office.newDeckSubtitle'));
    return serializeModel(emptyModel(planFor('a.xlsx')));
  }

  async function createNew(kind: NewKind): Promise<void> {
    const base = kind === 'docx' ? t('office.untitledDoc') : kind === 'xlsx' ? t('office.untitledSheet') : t('office.untitledDeck');
    // Built outside the try so a refused write can name the size it tried to store.
    const fresh = newBytes(kind);
    try {
      const dir = '/home/user/Documents';
      if (!(await vfs.exists(dir))) await vfs.mkdir(dir, { recursive: true });
      const target = await uniquePath(dir, base, kind);
      await vfs.writeFile(target, fresh);
      filePath = target;
      await open();
      setStatus(t('office.created', { name: basename(target) }));
    } catch (err) {
      setStatus(t('office.saveFailed', { message: errorMessage(err, fresh.length) }));
    }
  }

  function openDevice(): void {
    const input = el('input');
    input.type = 'file';
    input.accept = VERIFIED_FORMATS.filter((f) => f.level !== 'unsupported').map((f) => f.ext).join(',');
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const incoming = new Uint8Array(await file.arrayBuffer());
      try {
        const dir = '/home/user/Documents';
        if (!(await vfs.exists(dir))) await vfs.mkdir(dir, { recursive: true });
        const dot = file.name.lastIndexOf('.');
        const target = await uniquePath(dir, dot > 0 ? file.name.slice(0, dot) : file.name, dot > 0 ? file.name.slice(dot + 1) : 'txt');
        await vfs.writeFile(target, incoming);
        await openPath(target);
      } catch (err) {
        setStatus(t('office.saveFailed', { message: errorMessage(err, incoming.length) }));
      }
    });
    input.click();
  }

  /* ──────────────────────────── save / revert ──────────────────────────── */

  async function save(): Promise<void> {
    if (!filePath || !model || !editable || busy) return;
    const kind = packageKind(plan.kind);
    let patched: PatchResult | null = null;
    if (kind && onDiskBytes && onDiskModel) patched = await patchPackage(kind, onDiskBytes, onDiskModel, model, pendingTracked());
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
    // Known before the try so a refused write can name the size it tried to store.
    let attempt = 0;
    // Set once the write and the read-back both succeeded; the editor is re-rendered from it in
    // the finally, AFTER `busy` is false (see there).
    let showSaved = false;
    try {
      let data: Uint8Array;
      if (patched) data = patched.bytes;
      // A document opened from an `.odt` is written back as OpenDocument: OOXML bytes inside a
      // `.odt` path would be a file no reader opens.
      else if (plan.odf && model.kind === 'docx') data = toOdt(model, { title: odtTitleOf(model, basename(filePath)), created: new Date().toISOString() });
      else if (model.kind === 'docx' && model.blocks) data = (await rebuildDocxRich(model, pendingTracked())) ?? serializeModel(model);
      else data = serializeModel(model);
      attempt = data.length;
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
      } else if (model.kind === 'pptx' && model.deck && patched.changed.length) {
        // New slides and shapes now live in parts of their own: re-read so the next
        // save edits them in place instead of adding them again.
        model = await enrich(model, data);
      } else if (model.kind === 'xlsx' && bookLook === null) {
        bookLook = await readBookLook(data).catch(() => null);
      }
      // The file now holds this structure: nothing has moved relative to it any more.
      if ((model.kind === 'xlsx' || model.kind === 'csv') && (model.moved || model.structure)) { model = { ...model }; delete (model as SheetsModel).moved; delete (model as SheetsModel).structure; }
      onDiskBytes = data;
      onDiskModel = snapshotModel(model);
      showSaved = true;
      setStatus(result.backup ? t('office.savedWithBackup', { name: basename(result.backup) }) : t('office.saved'));
    } catch (err) {
      setStatus(t('office.saveFailed', { message: errorMessage(err, attempt) }));
    } finally {
      busy = false;
      // Re-rendered HERE, with `busy` already false: a render during the save re-applies
      // `ctx.editable()`, which is false while a save is in flight, so the editor (or the one a
      // rebuild just mounted) would be left read-only — and a saved Writer document could not be
      // typed into again, which is also what autosave waits for.
      if (showSaved) editor?.render();
      syncBar();
    }
  }

  /* ──────────────────────────── autosave (Writer) ──────────────────────────── */

  /**
   * The bytes an explicit save would write — the recovery copy must hold exactly the document the
   * owner is looking at, so it is serialised the same way.
   */
  async function currentBytes(source: OfficeModel): Promise<Uint8Array> {
    if (source.kind === 'docx' && source.blocks) return (await rebuildDocxRich(source, pendingTracked())) ?? serializeModel(source);
    return serializeModel(source);
  }

  /**
   * Writes the recovery copy of the open document. It NEVER touches the document and never rotates
   * its `.bak`: the copy is a separate file (`<name>.autosave`) and the explicit save keeps its
   * own meaning exactly. A refused write is said plainly in the status line and breaks nothing.
   */
  async function writeRecovery(): Promise<void> {
    if (!filePath || !model || closed || recoveryBusy) return;
    const target = recoveryPathFor(filePath);
    const source = model;
    const seq = editSeq;
    recoveryBusy = true;
    let attempt = 0;
    try {
      const data = await currentBytes(source);
      attempt = data.length;
      if (closed) return;
      await vfs.writeFile(target, data);
      recoverySeq = seq;
      if (closed) return;
      setStatus(t('office.autosaved', { time: formatClock(new Date()) }));
    } catch (err) {
      if (!closed) setStatus(t('office.autosaveFailed', { message: errorMessage(err, attempt) }));
    } finally {
      recoveryBusy = false;
    }
  }

  /** Asked by the timer; the decision itself is the tested, pure `shouldAutosave`. */
  function autosaveTick(): void {
    if (closed || !filePath || !model) return;
    // Writer slice: the sheet and the deck get their own turn later, so nothing changes for them.
    if (model.kind !== 'docx') return;
    if (!shouldAutosave({
      on: autosave.on,
      seconds: autosave.seconds,
      dirty: history.dirty,
      saving: busy || recoveryBusy,
      editSeq,
      writtenSeq: recoverySeq,
      sinceEditMs: Date.now() - lastEditAt,
    })) return;
    void writeRecovery();
  }

  function setAutosave(patch: { on?: boolean; seconds?: number }): void {
    autosave = {
      on: patch.on ?? autosave.on,
      seconds: clampInterval(patch.seconds ?? autosave.seconds),
    };
    storeAutosavePrefs();
    ribbon.sync();
    syncBar();
  }

  /**
   * Offers the recovery copy of the document that was just opened — and only when that copy is
   * NEWER than the file, and only after asking. The restored text becomes an unsaved change with
   * the file's own content as its undo step: the document on disk is not written until the owner
   * saves it, exactly like any other edit.
   */
  async function offerRecovery(): Promise<void> {
    if (!filePath || closed || !model || plan.readOnly || model.kind !== 'docx') return;
    const doc = filePath;
    const wanted = recoveryPathFor(doc);
    let entry: { path: string; mtime: number } | null = null;
    let docMtime = 0;
    try {
      const dir = dirname(doc);
      const [stat, entries] = await Promise.all([vfs.stat(doc), vfs.readdir(dir)]);
      docMtime = stat.mtime;
      entry = newestRecovery(entries.map((e) => ({ path: e.path, mtime: e.mtime })), doc, docMtime);
    } catch {
      return; // no copy, or a directory we cannot read: nothing to offer
    }
    if (closed || !entry) return;
    const proceed = await shellConfirm({
      title: t('office.recoveryTitle'),
      message: t('office.recoveryBody', { name: basename(wanted), time: formatClock(new Date(entry.mtime)) }),
      okLabel: t('office.recoveryRestore'),
      cancelLabel: t('office.recoveryKeep'),
      danger: true,
    });
    if (!proceed || closed) return;
    let bytes: Uint8Array;
    try {
      bytes = await vfs.readFile(wanted);
    } catch (err) {
      setStatus(t('office.autosaveFailed', { message: errorMessage(err) }));
      return;
    }
    const result = await loadOfficeFile(doc, bytes);
    if (closed || !result.ok) return;
    const restored = recompute(await enrich(result.model, bytes));
    if (closed) return;
    const before = model;
    model = restored;
    // Undo goes back to what the file holds; nothing is saved until the owner says so.
    history.push({ apply: () => restored, revert: () => before });
    editSeq++;
    lastEditAt = Date.now();
    mountEditor();
    setStatus(t('office.recoveryRestored', { name: basename(wanted) }));
    // The bar must show the restored text as an unsaved change: the file still holds the old one.
    syncBar();
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
    let written: SaveFormatId | null = null;
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
        written = format;
        // A rich Word document is rebuilt (runs, images, tables), exactly like the in-place save.
        if (format === 'docx' && source.kind === 'docx' && source.blocks) {
          return (await rebuildDocxRich(source, source.tracked?.items ?? pendingTracked())) ?? serializeAs(source, 'docx');
        }
        // A slide deck is patched from the file it came from, so nothing is lost.
        if (format === 'pptx' && source.kind === 'pptx' && source.deck && onDiskBytes && onDiskModel) {
          const patched = await patchPackage('pptx', onDiskBytes, onDiskModel, source);
          if (patched) return patched.bytes;
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
    if (autosaveTimer !== null) { clearInterval(autosaveTimer); autosaveTimer = null; }
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

  // Writer's autosave: awake while the window is, writing only when the tested rule says so. It
  // runs even on the start screen, because a document opened from there must be covered too.
  autosaveTimer = setInterval(autosaveTick, AUTOSAVE_TICK_MS);
  if (!filePath) { void goStart(); return; }
  void open();
}

const app: AppModule = { manifest, launch };
export default app;
