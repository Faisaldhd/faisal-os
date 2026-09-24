/**
 * PDF Documents (مستندات PDF) — the Adobe-Acrobat alternative.
 *
 * WHAT IT DOES: opens a `.pdf`, shows it in the browser's own viewer through a blob URL
 * (the same approach as the File Viewer — no pdf.js is bundled), and edits the pages with
 * pdf-lib: merge, split/extract, reorder, delete, rotate, crop, text watermark, metadata,
 * images → PDF, and the content tools — ADD TEXT on a page point, ADD A SIGNATURE (typed in a
 * large italic font, or a PNG/JPEG picture from the device), FILL THE ACOFORM FIELDS the
 * document already carries, COVER a region (hiding, explicitly not redaction), INSERT A BLANK
 * PAGE and DUPLICATE the selected pages. PRINT opens the browser's own print dialog for the
 * working PDF through an off-screen iframe — never `window.print()`, which would print the
 * whole desktop. Every operation ends by re-reading the produced bytes before the window says
 * it worked, and saving writes a NEW file unless the owner explicitly asks to replace the
 * original — and then exactly one `.bak` is written first.
 *
 * WHAT IT REFUSES, and why: encrypted/password-protected PDFs (pdf-lib refuses them),
 * non-PDF files, files that fail to parse, images that are not PNG/JPEG, filling a document
 * that has no AcroForm, and text in characters the standard PDF fonts cannot draw (Arabic
 * included). Each refusal has its own bilingual message and writes nothing.
 *
 * WHAT IT CANNOT DO (also listed in the window): change or delete text that is already in the
 * document, true redaction (covering draws over the content — the words stay in the file and
 * stay extractable), lock or unlock a PDF with a password (pdf-lib has no encryption and no
 * heavy encryption library will be added), reuse the page's own embedded fonts, OCR, digital
 * signatures, creating new form fields, or rasterise pages to images.
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
  buildMergePlan, buildSplitPlan, checkAddedText, checkWatermark, coverRectFor, cropBoxFor,
  insertIndexFor, movePage, parsePageRanges, planSave, sniff, TEXT_FONTS,
  type AddedTextCheck, type CoverShape, type ImagePageMode, type Margins,
  type PdfRefusalCode, type RangeError, type TextFont,
} from './ops';
import {
  addImageSignature, addText, addTypedSignature, addWatermark, coverRegion, cropPages, duplicatePages,
  extractPages, fillFormFields, imagesToPdf, insertBlankPage, loadPdf, mergePdfs, readFormFields,
  removePages, reorderPages, rotatePages, setMetadata,
  type DocInfo, type FormFieldInfo, type FormReadResult, type OpResult, type SignatureImageInput,
} from './pdfdoc';
import { previewSave, saveBytes } from './save';
import './strings';
import './pdf.css';

/** How many page rows the list draws. Beyond this the range box is the tool (said in the window). */
const PAGE_ROWS = 400;
const LIMIT_KEYS = [
  'pdf.limitTextEdit', 'pdf.limitNoRedaction', 'pdf.limitNoOcr', 'pdf.limitNoSign', 'pdf.limitNoForms',
  'pdf.limitNoRaster', 'pdf.limitNoFonts', 'pdf.limitEncrypted', 'pdf.limitNoPassword', 'pdf.limitQuality',
  'pdf.limitLarge', 'pdf.limitList',
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

/** A labelled node whose label is literal text (a field name from the document, not a key). */
function fieldNode(id: string, labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', 'faisal-pdf-field');
  const label = el('label', 'faisal-pdf-label', labelText);
  label.htmlFor = id;
  input.id = id;
  wrap.append(label, input);
  if (hint) wrap.append(el('div', 'faisal-pdf-hint', hint));
  return wrap;
}

/** A labelled input row: the label is bound to the field by id, so a tap on the label focuses it. */
function field(id: string, labelKey: string, input: HTMLElement, hint?: string): HTMLElement {
  return fieldNode(id, t(labelKey), input, hint);
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

/** A colour swatch and its hex value in one control, so a touch device can pick without typing. */
function colorInput(id: string, value: string): HTMLInputElement {
  const input = el('input', 'faisal-pdf-input faisal-pdf-color');
  input.type = 'color';
  input.id = id;
  input.value = value;
  return input;
}

/** A `<select>` styled like the other fields; `options` are [value, label-key] pairs. */
function selectInput(id: string, options: [string, string][]): HTMLSelectElement {
  const select = el('select', 'faisal-pdf-input');
  select.id = id;
  for (const [value, labelKey] of options) {
    const option = el('option', undefined, t(labelKey));
    option.value = value;
    select.append(option);
  }
  return select;
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
    form: null as FormReadResult | null,
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
    // A page the owner selected is the page he is working on, so the text/cover forms follow it
    // (unless he is typing a page number himself).
    if (state.selection.size) {
      const first = String(selected()[0] + 1);
      if (document.activeElement !== textPage) textPage.value = first;
      if (document.activeElement !== coverPage) coverPage.value = first;
      if (document.activeElement !== signPage) signPage.value = first;
    }
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
    refreshEditBounds();
    refreshMetadataForm();
    refreshMergeList();
    await refreshForm();
    void refreshSaveTarget();
  }

  /** Moves one page (up/down buttons and drag use the same path). */
  async function applyOrder(order: number[]): Promise<void> {
    if (!state.info) return;
    await applyOp(() => reorderPages(state.bytes, order), t('pdf.reorderDone'));
  }

  /**
   * Keeps the edit forms inside the open document: no page number can point past the last
   * page, and the coordinate boxes cannot offer a point off the widest/tallest page.
   */
  function refreshEditBounds(): void {
    if (!state.info) return;
    const count = state.info.pageCount;
    let widest = 0;
    let tallest = 0;
    for (const page of state.info.pages) {
      if (page.width > widest) widest = page.width;
      if (page.height > tallest) tallest = page.height;
    }
    textPage.max = String(count);
    coverPage.max = String(count);
    signPage.max = String(count);
    blankAt.max = String(count + 1);
    for (const input of [textX, coverX, signX]) input.max = String(Math.ceil(widest));
    for (const input of [textY, coverY, signY]) input.max = String(Math.ceil(tallest));
  }

  /** Re-reads the AcroForm from the working bytes and redraws the panel (or says there is none). */
  async function refreshForm(): Promise<void> {
    state.form = await readFormFields(state.bytes);
    if (closed) return;
    refreshFormPanel();
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
    if (!state.info) return;
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
    // A watermark is a document-wide mark: with nothing selected it goes on every page,
    // instead of asking the owner to select 51 pages first.
    const pages = state.selection.size ? selected() : range(state.info.pageCount);
    void applyOp(() => addWatermark(state.bytes, pages, options), t('pdf.watermarkDone', { n: pages.length }));
  });
  markCard.body.append(actionRow(markApply));

  /* add text */
  const FONT_LABEL: Record<TextFont, string> = {
    helvetica: 'pdf.textFontHelvetica',
    helveticaBold: 'pdf.textFontHelveticaBold',
    timesRoman: 'pdf.textFontTimesRoman',
    timesRomanItalic: 'pdf.textFontTimesItalic',
    courier: 'pdf.textFontCourier',
  };
  const textCard = card('pdf.textTitle', 'pdf.textDesc');
  const textValue = textInput('faisal-pdf-text-value');
  textValue.dir = 'auto';
  const textPage = numberInput('faisal-pdf-text-page', 1, 1, 1);
  const textFont = selectInput('faisal-pdf-text-font', TEXT_FONTS.map((font): [string, string] => [font, FONT_LABEL[font]]));
  const textSize = numberInput('faisal-pdf-text-size', 18, 4, 400);
  const textColor = colorInput('faisal-pdf-text-color', '#1a1a1a');
  const textX = numberInput('faisal-pdf-text-x', 72, 0, 20000);
  const textY = numberInput('faisal-pdf-text-y', 72, 0, 20000);
  const textApply = button(t('pdf.textApply'), 'faisal-pdf-btn is-primary');
  textCard.body.append(
    field('faisal-pdf-text-value', 'pdf.textValue', textValue),
    actionRow(field('faisal-pdf-text-page', 'pdf.textPage', textPage), field('faisal-pdf-text-font', 'pdf.textFont', textFont)),
    actionRow(field('faisal-pdf-text-size', 'pdf.textSize', textSize), field('faisal-pdf-text-color', 'pdf.textColor', textColor)),
    actionRow(field('faisal-pdf-text-x', 'pdf.textX', textX), field('faisal-pdf-text-y', 'pdf.textY', textY)),
    actionRow(textApply),
    el('div', 'faisal-pdf-hint', t('pdf.textNote')),
  );

  function addedTextMessage(check: Extract<AddedTextCheck, { ok: false }>): string {
    switch (check.error) {
      case 'emptyText': return t('pdf.textErrorText');
      case 'badSize': return t('pdf.textErrorSize');
      case 'badPoint': return t('pdf.textErrorPoint');
      case 'badColor': return t('pdf.textErrorColor');
      case 'badFont': return t('pdf.textErrorFont');
      default: return t('pdf.textErrorChars', { chars: check.chars ?? '' });
    }
  }

  textApply.addEventListener('click', () => {
    if (!state.info) return;
    const page = Number(textPage.value) - 1;
    if (!Number.isInteger(page) || page < 0 || page >= state.info.pageCount) {
      setStatus(t('pdf.textErrorPage', { count: state.info.pageCount }), true);
      return;
    }
    const input = {
      page,
      text: textValue.value,
      size: Number(textSize.value),
      x: Number(textX.value),
      y: Number(textY.value),
      font: textFont.value as TextFont,
      color: textColor.value,
    };
    const check = checkAddedText(input, state.info.pages[page]);
    if (!check.ok) { setStatus(addedTextMessage(check), true); return; }
    void applyOp(() => addText(state.bytes, input), t('pdf.textDone', { n: page + 1 }));
  });

  /* signature: typed (large italic text) or a picture picked from the device */
  const signCard = card('pdf.signTitle', 'pdf.signDesc');
  const signValue = textInput('faisal-pdf-sign-value');
  signValue.dir = 'auto';
  const signPage = numberInput('faisal-pdf-sign-page', 1, 1, 1);
  const signSize = numberInput('faisal-pdf-sign-size', 36, 4, 400);
  const signColor = colorInput('faisal-pdf-sign-color', '#12294f');
  const signX = numberInput('faisal-pdf-sign-x', 72, 0, 20000);
  const signY = numberInput('faisal-pdf-sign-y', 72, 0, 20000);
  const signApply = button(t('pdf.signApply'), 'faisal-pdf-btn is-primary');
  const signImageAdd = button(t('pdf.signImageAdd'));
  const signImageWidth = numberInput('faisal-pdf-sign-image-width', 160, 1, 20000);
  const signImageHeight = numberInput('faisal-pdf-sign-image-height', 60, 1, 20000);
  const signImageName = el('div', 'faisal-pdf-line', t('pdf.signImageNone'));
  const signImageApply = button(t('pdf.signImageApply'), 'faisal-pdf-btn is-primary');
  let signImage: { name: string; bytes: Uint8Array } | null = null;
  signCard.body.append(
    field('faisal-pdf-sign-value', 'pdf.signText', signValue),
    actionRow(
      field('faisal-pdf-sign-page', 'pdf.textPage', signPage),
      field('faisal-pdf-sign-size', 'pdf.textSize', signSize),
      field('faisal-pdf-sign-color', 'pdf.textColor', signColor),
    ),
    actionRow(field('faisal-pdf-sign-x', 'pdf.textX', signX), field('faisal-pdf-sign-y', 'pdf.textY', signY)),
    actionRow(signApply),
    el('div', 'faisal-pdf-label', t('pdf.signImage')),
    actionRow(
      signImageAdd,
      field('faisal-pdf-sign-image-width', 'pdf.signImageWidth', signImageWidth),
      field('faisal-pdf-sign-image-height', 'pdf.signImageHeight', signImageHeight),
    ),
    signImageName,
    actionRow(signImageApply),
  );

  signApply.addEventListener('click', () => {
    if (!state.info) return;
    const page = Number(signPage.value) - 1;
    if (!Number.isInteger(page) || page < 0 || page >= state.info.pageCount) {
      setStatus(t('pdf.textErrorPage', { count: state.info.pageCount }), true);
      return;
    }
    const input = {
      page,
      text: signValue.value,
      size: Number(signSize.value),
      x: Number(signX.value),
      y: Number(signY.value),
      color: signColor.value,
    };
    const check = checkAddedText({ ...input, font: 'timesRomanItalic' }, state.info.pages[page]);
    if (!check.ok) { setStatus(addedTextMessage(check), true); return; }
    void applyOp(() => addTypedSignature(state.bytes, input), t('pdf.signDone', { n: page + 1 }));
  });

  async function pickSignatureImage(): Promise<void> {
    if (state.busy) return;
    const picked = await pickFiles(IMAGE_TYPES);
    if (closed || !picked.length) return;
    const file = picked[0];
    const kind = sniff(file.bytes);
    if (kind !== 'png' && kind !== 'jpeg') {
      setStatus(t('pdf.signImageRefused', { code: kind }), true);
      return;
    }
    signImage = file;
    signImageName.textContent = t('pdf.signImagePicked', { name: file.name });
    setStatus(t('pdf.signImagePicked', { name: file.name }));
  }

  signImageAdd.addEventListener('click', () => { void pickSignatureImage(); });
  signImageApply.addEventListener('click', () => {
    if (!state.info) return;
    const image = signImage;
    if (!image) { setStatus(t('pdf.signImageNone'), true); return; }
    const page = Number(signPage.value) - 1;
    if (!Number.isInteger(page) || page < 0 || page >= state.info.pageCount) {
      setStatus(t('pdf.textErrorPage', { count: state.info.pageCount }), true);
      return;
    }
    const input: SignatureImageInput = {
      page,
      x: Number(signX.value),
      y: Number(signY.value),
      width: Number(signImageWidth.value),
      height: Number(signImageHeight.value),
      image,
    };
    const box = coverRectFor(input, state.info.pages[page]);
    const same = (a: number, b: number): boolean => Math.abs(a - b) <= 0.01;
    if (!box.ok || !same(box.rect.width, input.width) || !same(box.rect.height, input.height)
      || !same(box.rect.x, input.x) || !same(box.rect.y, input.y)) {
      setStatus(t('pdf.signImageErrorRect'), true);
      return;
    }
    void applyOp(() => addImageSignature(state.bytes, input), t('pdf.signImageDone', { n: page + 1 }));
  });

  /* cover a region — hiding, explicitly NOT redaction */
  const coverCard = card('pdf.coverTitle', 'pdf.coverDesc');
  const coverNote = el('p', 'faisal-pdf-p is-honest', t('pdf.coverNote'));
  const coverPage = numberInput('faisal-pdf-cover-page', 1, 1, 1);
  const coverWidth = numberInput('faisal-pdf-cover-width', 300, 1, 20000);
  const coverHeight = numberInput('faisal-pdf-cover-height', 60, 1, 20000);
  const coverX = numberInput('faisal-pdf-cover-x', 72, 0, 20000);
  const coverY = numberInput('faisal-pdf-cover-y', 120, 0, 20000);
  const coverColor = colorInput('faisal-pdf-cover-color', '#ffffff');
  const coverShapes: Record<CoverShape, HTMLInputElement> = {
    rect: radio('faisal-pdf-cover-rect'),
    ellipse: radio('faisal-pdf-cover-ellipse'),
  };
  const coverShapeRow = el('div', 'faisal-pdf-row');
  for (const [shape, labelKey] of [['rect', 'pdf.coverRect'], ['ellipse', 'pdf.coverEllipse']] as [CoverShape, string][]) {
    const input = coverShapes[shape];
    input.name = 'faisal-pdf-cover-shape';
    input.checked = shape === 'rect';
    // The label wraps its input, so the whole 44px row is a touch target — nothing needs hover.
    const label = el('label', 'faisal-pdf-check');
    label.htmlFor = input.id;
    label.append(input, el('span', 'faisal-pdf-label', t(labelKey)));
    coverShapeRow.append(label);
  }
  const coverApply = button(t('pdf.coverApply'), 'faisal-pdf-btn is-primary');
  coverCard.body.append(
    coverNote,
    el('div', 'faisal-pdf-label', t('pdf.coverShape')), coverShapeRow,
    actionRow(field('faisal-pdf-cover-page', 'pdf.textPage', coverPage), field('faisal-pdf-cover-width', 'pdf.coverWidth', coverWidth), field('faisal-pdf-cover-height', 'pdf.coverHeight', coverHeight)),
    actionRow(field('faisal-pdf-cover-x', 'pdf.textX', coverX), field('faisal-pdf-cover-y', 'pdf.textY', coverY), field('faisal-pdf-cover-color', 'pdf.textColor', coverColor)),
    actionRow(coverApply),
  );
  coverApply.addEventListener('click', () => {
    if (!state.info) return;
    const page = Number(coverPage.value) - 1;
    if (!Number.isInteger(page) || page < 0 || page >= state.info.pageCount) {
      setStatus(t('pdf.coverErrorPage', { count: state.info.pageCount }), true);
      return;
    }
    const shape: CoverShape = coverShapes.ellipse.checked ? 'ellipse' : 'rect';
    const input = {
      page,
      shape,
      x: Number(coverX.value),
      y: Number(coverY.value),
      width: Number(coverWidth.value),
      height: Number(coverHeight.value),
      color: coverColor.value,
    };
    const box = coverRectFor(input, state.info.pages[page]);
    if (!box.ok) {
      setStatus(box.error === 'badRect' ? t('pdf.coverErrorRect') : t('pdf.coverErrorOutside'), true);
      return;
    }
    void applyOp(() => coverRegion(state.bytes, input), t('pdf.coverDone', { n: page + 1 }));
  });

  /* blank page + duplicate */
  const pageopsCard = card('pdf.pageopsTitle', 'pdf.pageopsDesc');
  const blankAt = numberInput('faisal-pdf-blank-at', 1, 1, 1);
  const blankApply = button(t('pdf.blankApply'), 'faisal-pdf-btn is-primary');
  const duplicateApply = button(t('pdf.duplicateApply'));
  pageopsCard.body.append(field('faisal-pdf-blank-at', 'pdf.blankAt', blankAt), actionRow(blankApply, duplicateApply));
  blankApply.addEventListener('click', () => {
    if (!state.info) return;
    const at = insertIndexFor(Number(blankAt.value), state.info.pageCount);
    void applyOp(() => insertBlankPage(state.bytes, at), t('pdf.blankDone', { n: at + 1 }));
  });
  duplicateApply.addEventListener('click', () => {
    if (!state.selection.size) { setStatus(t('pdf.pageopsNone'), true); return; }
    const count = state.selection.size;
    void applyOp(() => duplicatePages(state.bytes, selected()), t('pdf.duplicateDone', { n: count }));
  });

  /* form fields */
  const formCard = card('pdf.formTitle', 'pdf.formDesc');
  const formPanel = el('div', 'faisal-pdf-formpanel');
  formCard.body.append(formPanel);
  const formApply = button(t('pdf.formApply'), 'faisal-pdf-btn is-primary');
  let formInputs: { name: string; kind: 'text' | 'checkbox'; input: HTMLInputElement }[] = [];

  /** One form row: a text box for a text field, a labelled checkbox for a checkbox. */
  function formRow(field: FormFieldInfo, index: number): HTMLElement {
    const id = `faisal-pdf-form-${index}`;
    if (field.kind === 'checkbox') {
      const check = el('input', 'faisal-pdf-checkbox');
      check.type = 'checkbox';
      check.id = id;
      check.checked = field.checked;
      check.disabled = field.readOnly;
      formInputs.push({ name: field.name, kind: 'checkbox', input: check });
      const label = el('label', 'faisal-pdf-check');
      label.htmlFor = id;
      label.append(check, el('span', 'faisal-pdf-label', `${field.name} — ${t('pdf.formCheckbox')}`));
      const wrap = el('div', 'faisal-pdf-field');
      wrap.append(label);
      if (field.readOnly) wrap.append(el('div', 'faisal-pdf-hint', t('pdf.formReadOnly')));
      return wrap;
    }
    const input = textInput(id, field.value);
    input.dir = 'auto';
    input.disabled = field.readOnly;
    formInputs.push({ name: field.name, kind: 'text', input });
    return fieldNode(id, field.name, input, field.readOnly ? t('pdf.formReadOnly') : undefined);
  }

  function refreshFormPanel(): void {
    if (!state.info) { formPanel.textContent = ''; formInputs = []; return; }
    // Never rebuild the panel while the owner is typing in one of its fields. The apply button
    // is deliberately excluded, so the panel does refresh after a value is written.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && formPanel.contains(active)) return;
    formPanel.textContent = '';
    formInputs = [];
    const read = state.form;
    if (!read) return;
    if (!read.ok) {
      formPanel.append(el('p', 'faisal-pdf-p is-error', t('pdf.formError', { message: t(refusalKey(read.code)) })));
      return;
    }
    if (!read.hasForm) { formPanel.append(el('p', 'faisal-pdf-p is-muted', t('pdf.formNone'))); return; }
    const fillable = read.fields.filter((item) => item.kind !== 'other');
    if (!fillable.length) { formPanel.append(el('p', 'faisal-pdf-p is-muted', t('pdf.formNoneFillable'))); return; }
    formPanel.append(el('div', 'faisal-pdf-line', t('pdf.formCount', { n: fillable.length })));
    formPanel.append(el('div', 'faisal-pdf-hint', t('pdf.formAppearanceNote')));
    fillable.forEach((item, index) => formPanel.append(formRow(item, index)));
    if (read.fields.length > fillable.length) {
      formPanel.append(el('div', 'faisal-pdf-hint', t('pdf.formOtherHint', { n: read.fields.length - fillable.length })));
    }
    formPanel.append(actionRow(formApply));
  }

  formApply.addEventListener('click', () => {
    const fills = formInputs
      .filter((row) => !row.input.disabled)
      .map((row) => (row.kind === 'text'
        ? { name: row.name, kind: 'text' as const, value: row.input.value }
        : { name: row.name, kind: 'checkbox' as const, checked: row.input.checked }));
    if (!fills.length) { setStatus(t('pdf.formNoneFillable'), true); return; }
    void applyOp(() => fillFormFields(state.bytes, fills), t('pdf.formDone', { n: fills.length }));
  });

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
    // Wrapped in a label like every other choice control: the row is a 44px touch target, and
    // the control itself keeps a 44px box (see `.faisal-pdf-check` in pdf.css).
    const label = el('label', 'faisal-pdf-check');
    label.htmlFor = input.id;
    label.append(input, el('span', 'faisal-pdf-label', t(MODE_LABEL[mode])));
    imageSizeRow.append(label);
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

  /**
   * How long the print frame may stay in the window, in milliseconds. `afterprint` normally
   * removes it the moment the dialog closes; this is the outer bound for environments that
   * never fire that event, so the frame and its blob URL can never be left behind for good.
   * It is deliberately not shorter: removing the frame while a print dialog is still open can
   * cut the print short, and a slow PDF still has to finish loading before `print()` is called.
   */
  const PRINT_FRAME_FALLBACK_MS = 60000;

  /**
   * Opens the browser's own print dialog for the working PDF, WITHOUT downloading it.
   *
   * `window.print()` must NOT be called on the system page: that prints the whole desktop —
   * the shell, this window's frame and every other open app. Printing has to be asked of the
   * DOCUMENT's own window, so the bytes go into an off-screen iframe and that frame's
   * `contentWindow.print()` opens the dialog for the PDF alone.
   *
   * Cleanup has three layers, so the frame can never be left in the window for good: the
   * dialog's own `afterprint` (immediate), the fallback timer started the moment the frame is
   * created, and the window's `onClose` (which revokes every blob URL it knows). Dropping the
   * frame also revokes its blob URL right away.
   *
   * The frame is positioned off-screen (with a real size) rather than `hidden`: `display: none`
   * stops some engines from laying the frame's document out, and a frame that was never laid
   * out cannot print. See `.faisal-pdf-printframe` in `pdf.css`.
   */
  function printResult(): void {
    if (!state.bytes.length) { setStatus(t('pdf.printNoBytes'), true); return; }
    const nav = navigator as Navigator & { pdfViewerEnabled?: boolean };
    if (nav.pdfViewerEnabled === false) { setStatus(t('pdf.printNoViewer'), true); return; }
    const url = URL.createObjectURL(new Blob([state.bytes.slice()], { type: 'application/pdf' }));
    blobUrls.push(url);
    const frame = el('iframe', 'faisal-pdf-printframe');
    frame.title = t('pdf.print');
    let done = false;
    let fallback = 0;
    const drop = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(fallback);
      frame.remove();
      const at = blobUrls.indexOf(url);
      if (at >= 0) blobUrls.splice(at, 1);
      URL.revokeObjectURL(url);
    };
    // Started here, not inside `load`: a frame whose document never loads, and a browser that
    // never fires `afterprint`, both end with the frame gone and the URL revoked.
    fallback = window.setTimeout(drop, PRINT_FRAME_FALLBACK_MS);
    frame.addEventListener('load', () => {
      const target = frame.contentWindow;
      if (!target) { drop(); setStatus(t('pdf.printFailed'), true); return; }
      try {
        target.focus();
        target.print();
      } catch {
        drop();
        setStatus(t('pdf.printFailed'), true);
        return;
      }
      setStatus(t('pdf.printReady'));
      // The dialog reports back when it closes; the fallback timer above covers the
      // environments where it never does.
      target.addEventListener('afterprint', drop, { once: true });
    }, { once: true });
    frame.src = url;
    win.content.append(frame);
  }

  const downloadBtn = button(t('pdf.download'));
  downloadBtn.addEventListener('click', downloadResult);
  actions.append(downloadBtn);
  const printBtn = button(t('pdf.print'));
  printBtn.addEventListener('click', printResult);
  actions.append(printBtn);
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

  ops.append(
    infoCard.box, pagesCard.box,
    textCard.box, signCard.box, coverCard.box, pageopsCard.box, formCard.box,
    deleteCard.box, rotateCard.box, cropCard.box, markCard.box, metaCard.box, splitCard.box,
    mergeCard.box, imageCard.box, saveCard.box, limitsCard(),
  );

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
    refreshEditBounds();
    refreshMergeList();
    refreshMetadataForm();
    refreshView();
    setPane('view');
    await refreshForm();
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
