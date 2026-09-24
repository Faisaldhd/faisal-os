/**
 * PDF Documents (مستندات PDF) — the Adobe-Acrobat alternative.
 *
 * WHAT IT DOES: opens a `.pdf`, shows it in the browser's own viewer through a blob URL
 * (the same approach as the File Viewer — no pdf.js is bundled), and edits the pages with
 * pdf-lib: merge, split/extract, reorder, delete, rotate, crop, text watermark, metadata
 * and images → PDF. Every operation ends by re-reading the produced bytes before the window
 * says it worked, and saving writes a NEW file unless the owner explicitly asks to replace
 * the original — and then exactly one `.bak` is written first.
 *
 * WHAT IT REFUSES, and why: encrypted/password-protected PDFs (pdf-lib refuses them),
 * non-PDF files, files that fail to parse, images that are not PNG/JPEG, and watermark text
 * in characters the built-in PDF fonts cannot draw (Arabic included). Each refusal has its
 * own bilingual message and writes nothing.
 *
 * WHAT IT CANNOT DO (also listed in the window): change text that is already in the
 * document, OCR, digital signatures, form filling, or rasterise pages to images.
 *
 * Everything user-visible is set with `textContent`; no `innerHTML` anywhere for file or
 * user content. The only permission is `fs:home`.
 */
import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { basename } from '../../kernel/path';
import { t } from '../../kernel/i18n';
import { nativeWeb } from '../../shell/native-web';
import { formatBytes } from '../files/format';
import {
  buildMergePlan, buildSplitPlan, checkWatermark, cropBoxFor, movePage, parsePageRanges, planSave, sniff,
  type ImagePageMode, type Margins, type PdfRefusalCode, type RangeError,
} from './ops';
import {
  addWatermark, cropPages, extractPages, imagesToPdf, loadPdf, mergePdfs, removePages, reorderPages,
  rotatePages, setMetadata, type DocInfo, type OpResult,
} from './pdfdoc';
import { previewSave, saveBytes } from './save';
import './strings';
import './pdf.css';

/** How many page rows the list draws. Beyond this the range box is the tool (said in the window). */
const PAGE_ROWS = 400;
const LIMIT_KEYS = [
  'pdf.limitTextEdit', 'pdf.limitNoOcr', 'pdf.limitNoSign', 'pdf.limitNoForms', 'pdf.limitNoRaster',
  'pdf.limitNoFonts', 'pdf.limitEncrypted', 'pdf.limitQuality', 'pdf.limitLarge', 'pdf.limitList',
];
const IMAGE_TYPES = 'image/png,image/jpeg,.png,.jpg,.jpeg';
const PDF_TYPES = 'application/pdf,.pdf';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, cls = 'faisal-pdf-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  return b;
}

/** A labelled input row: the label is bound to the field by id, so a tap on the label focuses it. */
function field(id: string, labelKey: string, input: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', 'faisal-pdf-field');
  const label = el('label', 'faisal-pdf-label', t(labelKey));
  label.htmlFor = id;
  input.id = id;
  wrap.append(label, input);
  if (hint) wrap.append(el('div', 'faisal-pdf-hint', hint));
  return wrap;
}

function numberInput(id: string, value: number, min: number, max: number, step = 1): HTMLInputElement {
  const input = el('input', 'faisal-pdf-input');
  input.type = 'number';
  input.id = id;
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.inputMode = 'decimal';
  return input;
}

function textInput(id: string, value = ''): HTMLInputElement {
  const input = el('input', 'faisal-pdf-input');
  input.type = 'text';
  input.id = id;
  input.value = value;
  input.autocomplete = 'off';
  input.spellcheck = false;
  return input;
}

const refusalKey = (code: string): string => code === 'noBytes'
  ? 'pdf.saveNoBytes'
  : `pdf.refusal${code.charAt(0).toUpperCase()}${code.slice(1)}`;

/**
 * A fresh empty buffer. The explicit `Uint8Array` annotation keeps the general buffer type,
 * so bytes coming back from the VFS and bytes coming back from pdf-lib both assign to the
 * same fields without a cast.
 */
const noBytes = (): Uint8Array => new Uint8Array(0);

function rangeMessage(error: RangeError): string {
  switch (error.code) {
    case 'syntax': return t('pdf.rangeErrorSyntax', { token: error.token });
    case 'reversed': return t('pdf.rangeErrorReversed', { from: error.from, to: error.to });
    case 'outOfRange': return t('pdf.rangeErrorOutOfRange', { page: error.page, count: error.count });
    default: return t('pdf.rangeErrorEmpty');
  }
}

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  win.setTitle(t('pdf.title'));
  win.content.textContent = '';

  const root = el('div', 'faisal-pdf');
  const bar = el('div', 'faisal-pdf-bar');
  const info = el('div', 'faisal-pdf-info');
  const name = el('div', 'faisal-pdf-name', t('pdf.title'));
  const meta = el('div', 'faisal-pdf-meta');
  info.append(name, meta);
  const badge = el('span', 'faisal-pdf-badge', t('pdf.badge'));
  const actions = el('div', 'faisal-pdf-actions');
  bar.append(info, badge, actions);

  const status = el('div', 'faisal-pdf-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const tabs = el('div', 'faisal-pdf-tabs');
  const tabView = button(t('pdf.tabView'), 'faisal-pdf-tab');
  const tabEdit = button(t('pdf.tabEdit'), 'faisal-pdf-tab');
  tabs.append(tabView, tabEdit);

  const main = el('div', 'faisal-pdf-main');
  const view = el('section', 'faisal-pdf-view');
  const frameHost = el('div', 'faisal-pdf-framehost');
  const previewNote = el('div', 'faisal-pdf-note', t('pdf.previewNote'));
  view.append(frameHost, previewNote);
  const ops = el('section', 'faisal-pdf-ops');
  const fail = el('section', 'faisal-pdf-fail');
  main.append(view, ops, fail);
  root.append(bar, status, tabs, main);
  win.content.append(root);

  /* ───────────────────────────── state ───────────────────────────── */

  const state = {
    path: args[0] ?? '',
    original: noBytes(),
    bytes: noBytes(),
    info: null as DocInfo | null,
    selection: new Set<number>(),
    merge: [] as { name: string; bytes: Uint8Array; pageCount: number; ranges: string }[],
    images: [] as { name: string; bytes: Uint8Array }[],
    imageMode: 'a4' as ImagePageMode,
    saved: false,
    pane: 'view' as 'view' | 'edit',
    busy: false,
    confirmOverwrite: false,
    loaded: false,
  };
  const blobUrls: string[] = [];
  let closed = false;
  win.onClose(() => {
    closed = true;
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.length = 0;
  });

  function setStatus(text: string, isError = false): void {
    status.textContent = text;
    status.classList.toggle('is-error', isError);
  }

  function setPane(pane: 'view' | 'edit'): void {
    state.pane = pane;
    root.dataset.pane = pane;
    tabView.setAttribute('aria-pressed', String(pane === 'view'));
    tabEdit.setAttribute('aria-pressed', String(pane === 'edit'));
  }

  /* ───────────────────────── refusal, honestly ───────────────────────── */

  function showFailure(messageKey: string, detail?: string): void {
    root.dataset.mode = 'fail';
    fail.textContent = '';
    const card = el('div', 'faisal-pdf-card is-fail');
    card.append(el('h2', 'faisal-pdf-h2', t('pdf.refusalTitle')));
    card.append(el('p', 'faisal-pdf-p', t(messageKey)));
    card.append(el('p', 'faisal-pdf-p is-muted', t('pdf.noOverwrite')));
    if (detail) {
      const line = el('p', 'faisal-pdf-p is-detail', t('pdf.refusalDetail', { detail }));
      line.dir = 'ltr';
      card.append(line);
    }
    card.append(limitsCard());
    fail.append(card);
  }

  function failWithCode(code: PdfRefusalCode, detail?: string, extra?: string): void {
    const key = refusalKey(code);
    showFailure(key, extra ? `${extra} — ${detail ?? ''}` : detail);
  }

  /* ───────────────────────────── view ───────────────────────────── */

  function refreshView(): void {
    frameHost.textContent = '';
    if (!state.bytes.length) {
      frameHost.append(el('div', 'faisal-pdf-note', t('pdf.noFile')));
      return;
    }
    const nav = navigator as Navigator & { pdfViewerEnabled?: boolean };
    if (nav.pdfViewerEnabled === false) {
      frameHost.append(el('div', 'faisal-pdf-note', t('pdf.viewNoViewer')));
      return;
    }
    const url = URL.createObjectURL(new Blob([state.bytes.slice()], { type: 'application/pdf' }));
    blobUrls.push(url);
    const frame = el('iframe', 'faisal-pdf-frame');
    frame.title = name.textContent ?? t('pdf.title');
    frame.src = url;
    frameHost.append(frame);
  }

  function refreshHeader(): void {
    if (!state.info) return;
    const size = formatBytes(state.bytes.length, sys.locale());
    const count = state.info.pageCount === 1 ? t('pdf.pageCountOne') : t('pdf.pagesCount', { n: state.info.pageCount });
    const parts = [count, t('pdf.sizeLabel', { size })];
    if (!state.saved) parts.push(t('pdf.modified'));
    meta.textContent = parts.join(' · ');
  }

  /* ───────────────────────────── cards ───────────────────────────── */

  function card(titleKey: string | null, descKey: string | null): { box: HTMLElement; body: HTMLElement } {
    const box = el('div', 'faisal-pdf-card');
    if (titleKey) box.append(el('h2', 'faisal-pdf-h2', t(titleKey)));
    if (descKey) box.append(el('p', 'faisal-pdf-p is-muted', t(descKey)));
    const body = el('div', 'faisal-pdf-cardbody');
    box.append(body);
    return { box, body };
  }

  function actionRow(...nodes: (HTMLElement | string)[]): HTMLElement {
    const row = el('div', 'faisal-pdf-row');
    for (const node of nodes) row.append(typeof node === 'string' ? el('span', 'faisal-pdf-hint', node) : node);
    return row;
  }

  function limitsCard(): HTMLElement {
    const { box, body } = card('pdf.limitsTitle', null);
    const list = el('ul', 'faisal-pdf-limits');
    for (const key of LIMIT_KEYS) list.append(el('li', undefined, t(key)));
    body.append(list);
    return box;
  }

  /* ─────────────────────── information card ─────────────────────── */

  const infoCard = card('pdf.infoTitle', 'pdf.infoDesc');
  const infoBody = infoCard.body;
  const infoPagesLine = el('div', 'faisal-pdf-line');
  const infoMetaBox = el('dl', 'faisal-pdf-meta-list');
  infoBody.append(infoPagesLine, infoMetaBox);

  function metaRow(labelKey: string, value: string): HTMLElement {
    const row = el('div', 'faisal-pdf-meta-row');
    row.append(el('dt', undefined, t(labelKey)), el('dd', undefined, value || t('pdf.infoNone')));
    return row;
  }

  function refreshInfo(): void {
    if (!state.info) {
      infoPagesLine.textContent = '';
      infoMetaBox.textContent = '';
      return;
    }
    infoPagesLine.textContent = t('pdf.infoPages', { n: state.info.pageCount });
    infoMetaBox.textContent = '';
    infoMetaBox.append(
      metaRow('pdf.infoMetaTitle', state.info.title),
      metaRow('pdf.infoAuthor', state.info.author),
      metaRow('pdf.infoSubject', state.info.subject),
      metaRow('pdf.infoKeywords', state.info.keywords),
    );
  }

  /* ───────────────────────── pages card ───────────────────────── */

  const pagesCard = card('pdf.pagesTitle', 'pdf.pagesDesc');
  const rangeInput = textInput('faisal-pdf-range');
  rangeInput.placeholder = t('pdf.rangePlaceholder');
  rangeInput.dir = 'ltr';
  const rangeApply = button(t('pdf.rangeApply'), 'faisal-pdf-btn is-primary');
  const rangeRow = el('div', 'faisal-pdf-row');
  rangeRow.append(field('faisal-pdf-range', 'pdf.rangeLabel', rangeInput), rangeApply);
  const selectAll = button(t('pdf.selectAll'));
  const clearSelection = button(t('pdf.clearSelection'));
  const selectionLine = el('div', 'faisal-pdf-line faisal-pdf-selection', t('pdf.selectionNone'));
  const pageList = el('div', 'faisal-pdf-pagelist');
  const listLimited = el('div', 'faisal-pdf-hint');
  const dragHint = el('div', 'faisal-pdf-hint', t('pdf.dragHint'));
  pagesCard.body.append(rangeRow, actionRow(selectAll, clearSelection), selectionLine, listLimited, pageList, dragHint);

  function refreshSelection(): void {
    selectionLine.textContent = state.selection.size
      ? t('pdf.selectedCount', { n: state.selection.size })
      : t('pdf.selectionNone');
  }

  function pageRow(index: number, total: number): HTMLElement {
    const page = state.info?.pages[index];
    const row = el('div', 'faisal-pdf-pagerow');
    const toggle = button('', 'faisal-pdf-pagetoggle');
    toggle.setAttribute('aria-pressed', String(state.selection.has(index)));
    toggle.setAttribute('aria-label', t('pdf.pageN', { n: index + 1 }));
    toggle.dir = 'auto';
    if (state.selection.has(index)) toggle.classList.add('is-selected');
    toggle.append(
      el('span', 'faisal-pdf-pageno', t('pdf.pageN', { n: index + 1 })),
      el('span', 'faisal-pdf-pagemeta', page
        ? t('pdf.infoPageLine', { w: page.width, h: page.height, rot: page.rotation })
        : ''),
    );
    if (page && page.crop.width > 0 && page.crop.height > 0
      && (page.crop.width < page.width - 0.6 || page.crop.height < page.height - 0.6)) {
      toggle.append(el('span', 'faisal-pdf-pagemeta', t('pdf.infoCropLine', {
        w: page.crop.width, h: page.crop.height, x: page.crop.x, y: page.crop.y,
      })));
    }
    toggle.addEventListener('click', () => {
      if (state.selection.has(index)) state.selection.delete(index);
      else state.selection.add(index);
      refreshPages();
    });
    const up = button('▲', 'faisal-pdf-move');
    up.setAttribute('aria-label', t('pdf.moveUp'));
    up.disabled = index === 0;
    up.addEventListener('click', () => { void applyOrder(movePage(range(total), index, index - 1)); });
    const down = button('▼', 'faisal-pdf-move');
    down.setAttribute('aria-label', t('pdf.moveDown'));
    down.disabled = index === total - 1;
    down.addEventListener('click', () => { void applyOrder(movePage(range(total), index, index + 1)); });
    const moves = el('div', 'faisal-pdf-moves');
    moves.append(up, down);

    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', String(index));
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    row.addEventListener('dragover', (event) => event.preventDefault());
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = Number(event.dataTransfer?.getData('text/plain'));
      row.classList.remove('is-dragging');
      if (!Number.isInteger(from) || from === index) return;
      void applyOrder(movePage(range(total), from, index));
    });
    row.append(toggle, moves);
    return row;
  }

  const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

  function refreshPages(): void {
    pageList.textContent = '';
    refreshSelection();
    if (!state.info) return;
    const total = state.info.pageCount;
    listLimited.textContent = total > PAGE_ROWS ? t('pdf.pagesLimited', { n: PAGE_ROWS }) : '';
    for (let i = 0; i < Math.min(total, PAGE_ROWS); i++) pageList.append(pageRow(i, total));
  }

  rangeApply.addEventListener('click', () => {
    if (!state.info) return;
    const parsed = parsePageRanges(rangeInput.value, state.info.pageCount);
    if (!parsed.ok) { setStatus(rangeMessage(parsed.error), true); return; }
    state.selection = new Set(parsed.pages);
    refreshPages();
    setStatus(t('pdf.selectedCount', { n: state.selection.size }));
  });
  selectAll.addEventListener('click', () => {
    if (!state.info) return;
    state.selection = new Set(range(state.info.pageCount));
    refreshPages();
    setStatus(t('pdf.selectedCount', { n: state.selection.size }));
  });
  clearSelection.addEventListener('click', () => {
    state.selection.clear();
    refreshPages();
    setStatus(t('pdf.selectionNone'));
  });

  /* ───────────────────────── operations ───────────────────────── */

  function selected(): number[] {
    return [...state.selection].sort((a, b) => a - b);
  }

  function opMessage(code: PdfRefusalCode | 'noBytes', detail: string): string {
    const base = code === 'noBytes' ? t('pdf.saveNoBytes') : t(refusalKey(code));
    return detail ? `${base} (${detail})` : base;
  }

  function setBusy(on: boolean): void {
    state.busy = on;
    root.classList.toggle('is-busy', on);
    if (on) setStatus(t('pdf.busy'));
  }

  /** Runs one verified operation; the working copy only changes when the bytes were checked. */
  async function applyOp(run: () => Promise<OpResult>, done: string): Promise<boolean> {
    if (state.busy || !state.info) return false;
    setBusy(true);
    let result: OpResult;
    try {
      result = await run();
    } catch (error) {
      result = { ok: false, code: 'unknown', detail: error instanceof Error ? error.message : String(error) };
    }
    setBusy(false);
    if (closed) return false;
    if (!result.ok) {
      setStatus(t('pdf.opFailed', { message: opMessage(result.code, result.detail) }), true);
      return false;
    }
    state.bytes = result.bytes;
    state.saved = false;
    state.selection.clear();
    await refreshWorking();
    setStatus(`${done} · ${t('pdf.opVerified', { summary: result.verified })}`);
    return true;
  }

  async function refreshWorking(): Promise<void> {
    const loaded = await loadPdf(state.bytes);
    if (!loaded.ok) { failWithCode(loaded.code, loaded.detail); return; }
    state.info = loaded.info;
    state.selection = new Set([...state.selection].filter((p) => p < loaded.info.pageCount));
    refreshHeader();
    refreshInfo();
    refreshPages();
    refreshView();
    refreshMetadataForm();
    refreshMergeList();
    void refreshSaveTarget();
  }

  /** Moves one page (up/down buttons and drag use the same path). */
  async function applyOrder(order: number[]): Promise<void> {
    if (!state.info) return;
    await applyOp(() => reorderPages(state.bytes, order), t('pdf.reorderDone'));
  }

  const opsIntro = el('h2', 'faisal-pdf-h2', t('pdf.opsTitle'));
  ops.append(opsIntro);

  /* delete */
  const deleteCard = card('pdf.deleteTitle', 'pdf.deleteDesc');
  const deleteBtn = button(t('pdf.deleteApply'), 'faisal-pdf-btn is-danger');
  deleteCard.body.append(actionRow(deleteBtn));
  deleteBtn.addEventListener('click', () => {
    if (!state.selection.size) { setStatus(t('pdf.selectionNone'), true); return; }
    const count = state.selection.size;
    void applyOp(() => removePages(state.bytes, selected()), t('pdf.deleteDone', { n: count }));
  });

  /* rotate */
  const rotateCard = card('pdf.rotateTitle', 'pdf.rotateDesc');
  const rotateRow = el('div', 'faisal-pdf-row');
  for (const [delta, key] of [[90, 'rotate90'], [180, 'rotate180'], [270, 'rotate270']] as [number, string][]) {
    const b = button(t(`pdf.${key}`));
    b.addEventListener('click', () => {
      if (!state.selection.size) { setStatus(t('pdf.selectionNone'), true); return; }
      const count = state.selection.size;
      void applyOp(() => rotatePages(state.bytes, selected(), delta), t('pdf.rotateDone', { n: count }));
    });
    rotateRow.append(b);
  }
  rotateCard.body.append(rotateRow);

  /* crop */
  const cropCard = card('pdf.cropTitle', 'pdf.cropDesc');
  const cropTop = numberInput('faisal-pdf-crop-top', 0, 0, 5000);
  const cropRight = numberInput('faisal-pdf-crop-right', 0, 0, 5000);
  const cropBottom = numberInput('faisal-pdf-crop-bottom', 0, 0, 5000);
  const cropLeft = numberInput('faisal-pdf-crop-left', 0, 0, 5000);
  cropCard.body.append(
    field('faisal-pdf-crop-top', 'pdf.cropTop', cropTop),
    field('faisal-pdf-crop-right', 'pdf.cropRight', cropRight),
    field('faisal-pdf-crop-bottom', 'pdf.cropBottom', cropBottom),
    field('faisal-pdf-crop-left', 'pdf.cropLeft', cropLeft),
  );
  const cropApply = button(t('pdf.cropApply'), 'faisal-pdf-btn is-primary');
  cropApply.addEventListener('click', () => {
    if (!state.selection.size) { setStatus(t('pdf.selectionNone'), true); return; }
    const margins: Margins = {
      top: Number(cropTop.value), right: Number(cropRight.value),
      bottom: Number(cropBottom.value), left: Number(cropLeft.value),
    };
    if (Object.values(margins).some((v) => !Number.isFinite(v) || v < 0)) {
      setStatus(t('pdf.cropErrorNegative'), true);
      return;
    }
    // Say "the page is smaller than the margins" here, with the page's real size, instead of
    // letting the operation fail later with a generic message.
    const pages = selected();
    const sizes = state.info?.pages ?? [];
    if (pages.some((page) => !sizes[page] || !cropBoxFor(sizes[page], margins).ok)) {
      setStatus(t('pdf.cropErrorNoArea'), true);
      return;
    }
    const count = pages.length;
    void applyOp(() => cropPages(state.bytes, pages, margins), t('pdf.cropDone', { n: count }));
  });
  cropCard.body.append(actionRow(cropApply));

  /* watermark */
  const markCard = card('pdf.watermarkTitle', 'pdf.watermarkDesc');
  const markText = textInput('faisal-pdf-mark-text');
  markText.dir = 'auto';
  const markSize = numberInput('faisal-pdf-mark-size', 60, 4, 400);
  const markOpacity = numberInput('faisal-pdf-mark-opacity', 0.15, 0.05, 1, 0.05);
  const markRotation = numberInput('faisal-pdf-mark-rotation', 45, 0, 359);
  markCard.body.append(
    field('faisal-pdf-mark-text', 'pdf.watermarkText', markText),
    field('faisal-pdf-mark-size', 'pdf.watermarkSize', markSize),
    field('faisal-pdf-mark-opacity', 'pdf.watermarkOpacity', markOpacity),
    field('faisal-pdf-mark-rotation', 'pdf.watermarkRotation', markRotation, t('pdf.watermarkRotationNote')),
  );
  const markApply = button(t('pdf.watermarkApply'), 'faisal-pdf-btn is-primary');
  markApply.addEventListener('click', () => {
    if (!state.selection.size) { setStatus(t('pdf.selectionNone'), true); return; }
    const options = {
      text: markText.value,
      size: Number(markSize.value),
      opacity: Number(markOpacity.value),
      rotation: Number(markRotation.value),
    };
    const check = checkWatermark(options);
    if (!check.ok) {
      const message = check.error === 'emptyText' ? t('pdf.watermarkErrorText')
        : check.error === 'badSize' ? t('pdf.watermarkErrorSize')
          : check.error === 'badOpacity' ? t('pdf.watermarkErrorOpacity')
            : t('pdf.watermarkErrorChars', { chars: check.chars ?? '' });
      setStatus(message, true);
      return;
    }
    const count = state.selection.size;
    void applyOp(() => addWatermark(state.bytes, selected(), options), t('pdf.watermarkDone', { n: count }));
  });
  markCard.body.append(actionRow(markApply));

  /* metadata */
  const metaCard = card('pdf.metadataTitle', 'pdf.metadataDesc');
  const metaTitle = textInput('faisal-pdf-meta-title');
  const metaAuthor = textInput('faisal-pdf-meta-author');
  const metaSubject = textInput('faisal-pdf-meta-subject');
  const metaKeywords = textInput('faisal-pdf-meta-keywords');
  for (const input of [metaTitle, metaAuthor, metaSubject, metaKeywords]) input.dir = 'auto';
  metaCard.body.append(
    field('faisal-pdf-meta-title', 'pdf.infoMetaTitle', metaTitle),
    field('faisal-pdf-meta-author', 'pdf.infoAuthor', metaAuthor),
    field('faisal-pdf-meta-subject', 'pdf.infoSubject', metaSubject),
    field('faisal-pdf-meta-keywords', 'pdf.infoKeywords', metaKeywords, t('pdf.keywordsHint')),
  );
  const metaApply = button(t('pdf.metadataApply'), 'faisal-pdf-btn is-primary');
  metaApply.addEventListener('click', () => {
    const payload = {
      title: metaTitle.value, author: metaAuthor.value,
      subject: metaSubject.value, keywords: metaKeywords.value,
    };
    void applyOp(() => setMetadata(state.bytes, payload), t('pdf.metadataDone'));
  });
  metaCard.body.append(actionRow(metaApply));

  function refreshMetadataForm(): void {
    if (!state.info) return;
    if (document.activeElement !== metaTitle) metaTitle.value = state.info.title;
    if (document.activeElement !== metaAuthor) metaAuthor.value = state.info.author;
    if (document.activeElement !== metaSubject) metaSubject.value = state.info.subject;
    if (document.activeElement !== metaKeywords) metaKeywords.value = state.info.keywords;
  }

  /* split / extract */
  const splitCard = card('pdf.splitTitle', 'pdf.splitDesc');
  const splitInput = textInput('faisal-pdf-split');
  splitInput.placeholder = t('pdf.rangePlaceholder');
  splitInput.dir = 'ltr';
  const splitApply = button(t('pdf.splitApply'), 'faisal-pdf-btn is-primary');
  splitCard.body.append(field('faisal-pdf-split', 'pdf.rangeLabel', splitInput), actionRow(splitApply));
  splitApply.addEventListener('click', () => { void runSplit(); });

  async function runSplit(): Promise<void> {
    if (state.busy || !state.info) return;
    const plan = buildSplitPlan(range(state.info.pageCount), splitInput.value);
    if (!plan.ok) { setStatus(rangeMessage(plan.error), true); return; }
    if (plan.groups.some((group) => group.length === 0)) { setStatus(t('pdf.rangeErrorEmpty'), true); return; }
    setBusy(true);
    const written: string[] = [];
    const failures: string[] = [];
    for (const [index, group] of plan.groups.entries()) {
      const result = await extractPages(state.bytes, group);
      if (!result.ok) { failures.push(opMessage(result.code, result.detail)); continue; }
      const saved = await saveBytes(sys, {
        sourcePath: state.path, suffix: `-${index + 1}`, overwrite: false,
      }, result.bytes);
      if (saved.ok) written.push(saved.path);
      else failures.push(opMessage(saved.code, ''));
    }
    setBusy(false);
    if (closed) return;
    if (written.length && !failures.length) {
      setStatus(written.length === 1 ? t('pdf.splitDone', { path: written[0] }) : t('pdf.splitDoneMany', { n: written.length }));
    } else if (written.length) {
      setStatus(`${t('pdf.splitDoneMany', { n: written.length })} — ${failures.join(' | ')}`, true);
    } else {
      setStatus(t('pdf.opFailed', { message: failures.join(' | ') }), true);
    }
  }

  /* merge */
  const mergeCard = card('pdf.mergeTitle', 'pdf.mergeDesc');
  const mergeList = el('div', 'faisal-pdf-list');
  const mergeAdd = button(t('pdf.mergeAdd'));
  const mergeApply = button(t('pdf.mergeApply'), 'faisal-pdf-btn is-primary');
  mergeCard.body.append(mergeList, actionRow(mergeAdd, mergeApply));
  mergeAdd.addEventListener('click', () => { void addMergeFiles(); });
  mergeApply.addEventListener('click', () => { void runMerge(); });

  function refreshMergeList(): void {
    mergeList.textContent = '';
    if (!state.info) return;
    const opened = el('div', 'faisal-pdf-listrow');
    opened.append(el('div', 'faisal-pdf-listname', t('pdf.mergeOpenDoc')));
    opened.append(el('div', 'faisal-pdf-listmeta', t('pdf.sourcePages', { name: basename(state.path), n: state.info.pageCount })));
    mergeList.append(opened);
    state.merge.forEach((item, index) => {
      const row = el('div', 'faisal-pdf-listrow');
      row.append(el('div', 'faisal-pdf-listname', item.name));
      row.append(el('div', 'faisal-pdf-listmeta', t('pdf.pagesCount', { n: item.pageCount })));
      const ranges = textInput(`faisal-pdf-merge-range-${index}`, item.ranges);
      ranges.placeholder = t('pdf.rangePlaceholder');
      ranges.dir = 'ltr';
      ranges.addEventListener('input', () => { item.ranges = ranges.value; });
      const up = button('▲', 'faisal-pdf-move');
      up.setAttribute('aria-label', t('pdf.moveUp'));
      up.disabled = index === 0;
      up.addEventListener('click', () => { state.merge = moveItem(state.merge, index, index - 1); refreshMergeList(); });
      const down = button('▼', 'faisal-pdf-move');
      down.setAttribute('aria-label', t('pdf.moveDown'));
      down.disabled = index === state.merge.length - 1;
      down.addEventListener('click', () => { state.merge = moveItem(state.merge, index, index + 1); refreshMergeList(); });
      const gone = button(t('pdf.remove'), 'faisal-pdf-move is-wide');
      gone.addEventListener('click', () => { state.merge.splice(index, 1); refreshMergeList(); });
      const controls = el('div', 'faisal-pdf-moves');
      controls.append(up, down, gone);
      row.append(field(`faisal-pdf-merge-range-${index}`, 'pdf.sourceRangeLabel', ranges), controls);
      mergeList.append(row);
    });
  }

  function moveItem<T>(list: T[], from: number, to: number): T[] {
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  }

  async function addMergeFiles(): Promise<void> {
    if (state.busy) return;
    const picked = await pickFiles(PDF_TYPES);
    if (closed || !picked.length) return;
    setBusy(true);
    for (const file of picked) {
      const loaded = await loadPdf(file.bytes);
      if (!loaded.ok) {
        setStatus(`${file.name}: ${t(refusalKey(loaded.code))}`, true);
        continue;
      }
      state.merge.push({ name: file.name, bytes: file.bytes, pageCount: loaded.info.pageCount, ranges: '' });
    }
    setBusy(false);
    refreshMergeList();
  }

  async function runMerge(): Promise<void> {
    if (state.busy || !state.info) return;
    if (!state.merge.length) { setStatus(t('pdf.mergeEmpty'), true); return; }
    const sources: { path: string; name: string; bytes: Uint8Array; pageCount: number; ranges: string }[] = [
      { path: state.path, name: t('pdf.mergeOpenDoc'), bytes: state.bytes, pageCount: state.info.pageCount, ranges: '' },
      ...state.merge.map((item) => ({
        path: '', name: item.name, bytes: item.bytes, pageCount: item.pageCount, ranges: item.ranges,
      })),
    ];
    const plan = buildMergePlan(sources.map((s) => ({ path: s.path, pageCount: s.pageCount, ranges: s.ranges })));
    if (!plan.ok) {
      const problem = plan.error;
      setStatus(problem.code === 'noSources' ? t('pdf.mergeEmpty') : rangeMessage(problem), true);
      return;
    }
    const done = t('pdf.mergeDone', { n: sources.length, pages: plan.items.length });
    await applyOp(() => mergePdfs(sources.map((s) => ({ name: s.name, bytes: s.bytes })), plan.items), done);
  }

  /* images → PDF */
  const imageCard = card('pdf.imagesTitle', 'pdf.imagesDesc');
  const imageList = el('div', 'faisal-pdf-list');
  const imageAdd = button(t('pdf.imagesAdd'));
  const imageApply = button(t('pdf.imagesApply'), 'faisal-pdf-btn is-primary');
  const imageSizeRow = el('div', 'faisal-pdf-row');
  const MODE_LABEL: Record<ImagePageMode, string> = { a4: 'pdf.imagesA4', letter: 'pdf.imagesLetter', fit: 'pdf.imagesFit' };
  const modeInputs: Record<ImagePageMode, HTMLInputElement> = {
    a4: radio('faisal-pdf-mode-a4'), letter: radio('faisal-pdf-mode-letter'), fit: radio('faisal-pdf-mode-fit'),
  };
  for (const mode of ['a4', 'letter', 'fit'] as ImagePageMode[]) {
    const input = modeInputs[mode];
    input.name = 'faisal-pdf-page-size';
    input.checked = mode === state.imageMode;
    input.addEventListener('change', () => { if (input.checked) state.imageMode = mode; });
    imageSizeRow.append(field(input.id, MODE_LABEL[mode], input));
  }
  imageCard.body.append(el('div', 'faisal-pdf-label', t('pdf.imagesPageSize')), imageSizeRow, imageList, actionRow(imageAdd, imageApply));
  imageAdd.addEventListener('click', () => { void addImages(); });
  imageApply.addEventListener('click', () => { void runImages(); });

  function radio(id: string): HTMLInputElement {
    const input = el('input');
    input.type = 'radio';
    input.id = id;
    return input;
  }

  function refreshImageList(): void {
    imageList.textContent = '';
    state.images.forEach((item, index) => {
      const row = el('div', 'faisal-pdf-listrow');
      row.append(el('div', 'faisal-pdf-listname', item.name));
      const up = button('▲', 'faisal-pdf-move');
      up.setAttribute('aria-label', t('pdf.moveUp'));
      up.disabled = index === 0;
      up.addEventListener('click', () => { state.images = moveItem(state.images, index, index - 1); refreshImageList(); });
      const down = button('▼', 'faisal-pdf-move');
      down.setAttribute('aria-label', t('pdf.moveDown'));
      down.disabled = index === state.images.length - 1;
      down.addEventListener('click', () => { state.images = moveItem(state.images, index, index + 1); refreshImageList(); });
      const gone = button(t('pdf.remove'), 'faisal-pdf-move is-wide');
      gone.addEventListener('click', () => { state.images.splice(index, 1); refreshImageList(); });
      const controls = el('div', 'faisal-pdf-moves');
      controls.append(up, down, gone);
      row.append(controls);
      imageList.append(row);
    });
  }

  async function addImages(): Promise<void> {
    if (state.busy) return;
    const picked = await pickFiles(IMAGE_TYPES);
    if (closed || !picked.length) return;
    for (const file of picked) {
      const kind = sniff(file.bytes);
      if (kind !== 'png' && kind !== 'jpeg') {
        setStatus(t('pdf.imagesRefused', { name: file.name, code: kind }), true);
        continue;
      }
      state.images.push(file);
    }
    refreshImageList();
  }

  async function runImages(): Promise<void> {
    if (state.busy) return;
    if (!state.images.length) { setStatus(t('pdf.imagesEmpty'), true); return; }
    const done = t('pdf.imagesDone', { n: state.images.length, pages: state.images.length });
    await applyOp(() => imagesToPdf(state.images, state.imageMode), done);
  }

  /* save */
  const saveCard = card('pdf.saveTitle', 'pdf.saveDesc');
  const saveTarget = el('div', 'faisal-pdf-line faisal-pdf-savetarget');
  saveTarget.dir = 'auto';
  const saveCopy = button(t('pdf.saveCopy'), 'faisal-pdf-btn is-primary');
  const saveOverwrite = button(t('pdf.saveOverwrite'), 'faisal-pdf-btn is-danger');
  const overwriteBox = el('div', 'faisal-pdf-confirm');
  overwriteBox.hidden = true;
  const resetBtn = button(t('pdf.reset'));
  saveCard.body.append(saveTarget, actionRow(saveCopy, saveOverwrite), overwriteBox, actionRow(resetBtn));

  async function refreshSaveTarget(): Promise<void> {
    if (!state.info || !state.path) { saveTarget.textContent = ''; return; }
    const planned = await previewSave(sys, {
      sourcePath: state.path, suffix: t('pdf.saveCopySuffix'), overwrite: false,
    });
    if (closed) return;
    saveTarget.textContent = planned.ok
      ? t('pdf.saveTarget', { path: planned.plan.target })
      : t(refusalKey(planned.error));
  }

  async function runSave(overwrite: boolean): Promise<void> {
    if (state.busy || !state.info) return;
    if (!state.bytes.length) { setStatus(t('pdf.saveNoBytes'), true); return; }
    setBusy(true);
    const saved = await saveBytes(sys, {
      sourcePath: state.path, suffix: t('pdf.saveCopySuffix'), overwrite,
    }, state.bytes);
    setBusy(false);
    if (closed) return;
    if (!saved.ok) {
      setStatus(opMessage(saved.code, ''), true);
      return;
    }
    state.saved = true;
    state.confirmOverwrite = false;
    overwriteBox.hidden = true;
    overwriteBox.textContent = '';
    refreshHeader();
    await refreshSaveTarget();
    setStatus(saved.isCopy
      ? t('pdf.saveDoneCopy', { path: saved.path })
      : t('pdf.saveDoneOverwrite', { path: saved.backup ?? saved.path }));
  }

  saveCopy.addEventListener('click', () => { void runSave(false); });
  saveOverwrite.addEventListener('click', () => { showOverwriteConfirm(); });
  resetBtn.addEventListener('click', () => {
    if (state.busy || !state.original.length) return;
    state.bytes = state.original;
    state.saved = true;
    state.selection.clear();
    overwriteBox.hidden = true;
    setStatus(t('pdf.resetDone'));
    void refreshWorking();
  });

  async function showOverwriteConfirm(): Promise<void> {
    if (!state.info || state.confirmOverwrite) return;
    state.confirmOverwrite = true;
    const planned = await planSave({
      sourcePath: state.path, suffix: t('pdf.saveCopySuffix'), overwrite: true,
    }, (path) => sys.vfs.exists(path));
    if (closed) return;
    overwriteBox.textContent = '';
    if (!planned.ok) { state.confirmOverwrite = false; setStatus(t(refusalKey(planned.error)), true); return; }
    if (!planned.plan.backup) { state.confirmOverwrite = false; setStatus(t('pdf.saveFailed'), true); return; }
    overwriteBox.append(el('p', 'faisal-pdf-p is-error', t('pdf.saveOverwriteWarn', {
      name: basename(state.path), bak: basename(planned.plan.backup),
    })));
    const confirm = button(t('pdf.saveOverwriteConfirm'), 'faisal-pdf-btn is-danger');
    confirm.addEventListener('click', () => { void runSave(true); });
    const cancel = button(t('pdf.cancel'));
    cancel.addEventListener('click', () => {
      state.confirmOverwrite = false;
      overwriteBox.hidden = true;
      overwriteBox.textContent = '';
    });
    overwriteBox.append(actionRow(confirm, cancel));
    overwriteBox.hidden = false;
  }

  /* ───────────────────────── view/download actions ───────────────────────── */

  function downloadResult(): void {
    if (!state.bytes.length) return;
    const url = URL.createObjectURL(new Blob([state.bytes.slice()], { type: 'application/octet-stream' }));
    const a = el('a');
    a.href = url;
    a.download = `${basename(state.path).replace(/\.pdf$/i, '')}${t('pdf.saveCopySuffix')}.pdf`;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const downloadBtn = button(t('pdf.download'));
  downloadBtn.addEventListener('click', downloadResult);
  actions.append(downloadBtn);
  if (!nativeWeb()) {
    const openTab = button(t('pdf.openInTab'));
    openTab.addEventListener('click', () => {
      if (!state.bytes.length) return;
      const url = URL.createObjectURL(new Blob([state.bytes.slice()], { type: 'application/pdf' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    actions.append(openTab);
  }

  async function pickFiles(accept: string): Promise<{ name: string; bytes: Uint8Array }[]> {
    return new Promise((resolve) => {
      const input = el('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = true;
      input.style.display = 'none';
      document.body.append(input);
      const finish = (files: { name: string; bytes: Uint8Array }[]) => { input.remove(); resolve(files); };
      input.addEventListener('change', () => {
        void (async () => {
          const out: { name: string; bytes: Uint8Array }[] = [];
          for (const file of Array.from(input.files ?? [])) {
            out.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
          }
          if (!closed) finish(out);
        })();
      }, { once: true });
      input.addEventListener('cancel', () => finish([]), { once: true });
      input.click();
    });
  }

  tabView.addEventListener('click', () => setPane('view'));
  tabEdit.addEventListener('click', () => setPane('edit'));

  /* ───────────────────────── assembly ───────────────────────── */

  ops.append(infoCard.box, pagesCard.box, deleteCard.box, rotateCard.box, cropCard.box, markCard.box, metaCard.box, splitCard.box, mergeCard.box, imageCard.box, saveCard.box, limitsCard());

  async function openPath(path: string): Promise<void> {
    state.path = path;
    name.textContent = basename(path);
    name.title = path;
    win.setTitle(`${basename(path)} — ${t('pdf.title')}`);
    let bytes: Uint8Array;
    try {
      bytes = await sys.vfs.readFile(path);
    } catch {
      if (closed) return;
      setStatus(t('pdf.readError'), true);
      showFailure('pdf.readError');
      return;
    }
    if (closed) return;
    const loaded = await loadPdf(bytes);
    if (!loaded.ok) { failWithCode(loaded.code, loaded.detail); return; }
    state.original = bytes;
    state.bytes = bytes;
    state.info = loaded.info;
    state.selection.clear();
    state.saved = true;
    state.loaded = true;
    root.dataset.mode = 'ready';
    fail.textContent = '';
    refreshHeader();
    refreshInfo();
    refreshPages();
    refreshMergeList();
    refreshMetadataForm();
    refreshView();
    setPane('view');
    await refreshSaveTarget();
  }

  setPane('view');
  root.dataset.mode = 'loading';
  refreshPages();
  refreshView();
  if (!state.path) {
    root.dataset.mode = 'fail';
    showFailure('pdf.noFile');
    setStatus(t('pdf.noFile'), true);
    return;
  }
  setStatus(t('pdf.loading'));
  void openPath(state.path);
}

const app: AppModule = { manifest, launch };
export default app;
