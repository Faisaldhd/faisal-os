/**
 * PDF Studio (مستندات PDF) — a Foxit-style PDF editor for Fai$al OS.
 *
 * WHAT IT DOES: pages are drawn in the window by pdf.js (lazy-loaded, see render.ts) on a grey
 * canvas with continuous scroll, zoom (fit width / fit page / %), page thumbnails you can drag to
 * reorder, the outline, text selection and search with highlighted hits. A ribbon (Home /
 * Comment / Edit / Organize / Forms / Protect & Sign / View) holds the tools: comment tools
 * saved as real PDF annotations, text, a drawn or typed signature, pictures and covering boxes
 * placed by tapping the page and dragging/resizing a box, form fields filled on the page itself,
 * and every pdf-lib page operation of the previous version (merge, split, reorder, delete,
 * rotate, crop, watermark, metadata, images → PDF, blank page, duplicate, print, download).
 *
 * THE RULES that do not change: every edit ends by re-reading the produced bytes before the
 * window says it worked (pdfdoc.ts); saving writes a NEW file unless the owner explicitly asks to
 * replace the original — and then exactly one `.bak` is written first; the saved file is read
 * back before "saved" is shown. Undo/redo keeps up to 100 verified states (memory-bounded).
 *
 * WHAT IT REFUSES / CANNOT DO is listed in the "limits" panel under the ? button, in plain words.
 * Everything user-visible is set with `textContent`; no `innerHTML` anywhere. The only
 * permission is `fs:home`.
 */
import { manifest } from './manifest';
import { HOME, type AppContext, type AppModule } from '../../kernel/types';
import { basename, dirname } from '../../kernel/path';
import { t } from '../../kernel/i18n';
import { nativeWeb } from '../../shell/native-web';
import { shellConfirm } from '../../shell/dialog';
import { saveAsDialog } from '../../shell/save-as';
import { showContextMenu, type ContextMenuItem } from '../../shell/contextmenu';
import { pushEscapeLayer } from '../../shell/esc';
import { formatBytes } from '../files/format';
import {
  buildMergePlan, buildSplitPlan, checkAddedText, checkWatermark, coverRectFor, cropBoxFor,
  insertIndexFor, isIdentityOrder, moveBlock, movePage, parsePageRanges, planSave, sniff, TEXT_FONTS,
  type AddedTextCheck, type CoverShape, type ImagePageMode, type Margins,
  type PdfRefusalCode, type RangeError, type TextFont,
} from './ops';
import {
  addImageSignature, addText, addTypedSignature, addWatermark, coverRegion, createBlankPdf, cropPages,
  duplicatePages, extractPages, fillFormFields, imagesToPdf, insertBlankPage, loadPdf, mergePdfs,
  readFormFields, removePages, reorderPages, rotatePages, setMetadata,
  type DocInfo, type FormFieldInfo, type FormReadResult, type OpResult, type SignatureImageInput,
} from './pdfdoc';
import { previewSave, saveBytes, writePlan } from './save';
import * as writer from './writer';
import { engineSupported, loadEngine, openForRender, type PdfJsDocument, type PdfJsLib } from './render';
import { PdfViewer, type FieldWidget } from './viewer';
import { ThumbPanel } from './thumbs';
import { ByteHistory } from './history';
import {
  addRecent, freePdfPath, loadRecent, removeRecent, setThumb, storeRecent, type RecentEntry,
} from './recent';
import { buildPageText, findAll, firstHitFrom, snippet, stepHit, type Hit } from './search';
import { commandFor, shortcutSheet, type CommandId } from './shortcuts';
import { icon, type IconName } from './icons';
import { closePopover, dialogButton, el, iconButton, openModal, openPopoverAt } from './ui';
import {
  boxToPdf, clampBox, CSS_UNITS, nextZoom, parseZoomInput, quadsFromBoxes, strokesBounds, toPdf,
  ZOOM_MAX, ZOOM_MIN, type Box, type Point, type ZoomMode,
} from './viewport';
import { KIND_KEYS, TOOL_KEYS } from './labels';
import './strings';
import './pdf.css';
import './pdf-pointer.css';

/** How many page rows the list draws. Beyond this the range box is the tool (said in the window). */
const PAGE_ROWS = 400;
const LIMIT_KEYS = [
  'pdf.limitTextEdit', 'pdf.limitNoRedaction', 'pdf.limitNoOcr', 'pdf.limitNoSign', 'pdf.limitNoForms',
  'pdf.limitNoRaster', 'pdf.limitNoFonts', 'pdf.limitEncrypted', 'pdf.limitNoPassword', 'pdf.limitQuality',
  'pdf.limitLarge', 'pdf.limitList',
];
const IMAGE_TYPES = 'image/png,image/jpeg,.png,.jpg,.jpeg';
const PDF_TYPES = 'application/pdf,.pdf';
/** The window width under which the layout turns into the phone layout (drawers, bottom bar). */
const NARROW = 700;

type ToolId =
  | 'select' | 'hand' | 'highlight' | 'underline' | 'strikeout' | 'pen' | 'rect' | 'ellipse' | 'line' | 'arrow'
  | 'note' | 'textbox' | 'stamp' | 'text' | 'cover' | 'image' | 'signature';

const MARKUP_TOOLS: ReadonlySet<ToolId> = new Set(['highlight', 'underline', 'strikeout']);
const DRAW_TOOLS: ReadonlySet<ToolId> = new Set(['pen', 'rect', 'ellipse', 'line', 'arrow', 'note', 'textbox', 'stamp', 'text', 'cover', 'image', 'signature']);

interface ToolStyle { color: string; opacity: number; width: number; size: number }

const PALETTE = [
  '#FFD54F', '#FFB74D', '#F06292', '#E5484D', '#BA68C8', '#7E57C2',
  '#5B8DEF', '#4FC3F7', '#3DD68C', '#8BC34A', '#1A1D26', '#FFFFFF',
];

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

const kindLabel = (kind: string): string => t(KIND_KEYS[kind as writer.AnnotKind] ?? 'pdf.kindNote');

/** A decorative empty-state drawing (static, trusted markup built with DOM calls). */
function emptyArt(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 96');
  svg.setAttribute('class', 'faisal-pdf-emptyart');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attrs: Record<string, string>): void => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  };
  add('rect', { x: '30', y: '10', width: '52', height: '68', rx: '6', class: 'art-page' });
  add('rect', { x: '40', y: '18', width: '52', height: '68', rx: '6', class: 'art-page art-front' });
  add('path', { d: 'M50 36h32M50 46h24M50 56h28', class: 'art-line' });
  add('circle', { cx: '86', cy: '74', r: '11', class: 'art-seal' });
  add('path', { d: 'M81 74l4 4 7-8', class: 'art-check' });
  return svg;
}

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  win.setTitle(t('pdf.title'));
  win.content.textContent = '';

  /* ───────────────────────────── skeleton ───────────────────────────── */

  const root = el('div', 'faisal-pdf');
  root.dir = sys.locale() === 'ar' ? 'rtl' : 'ltr';
  root.lang = sys.locale();

  // App bar: sidebar toggle, file name with the unsaved dot, undo/redo, quick actions, save.
  const bar = el('header', 'faisal-pdf-bar');
  const sideToggle = iconButton('sidebar', t('pdf.sideToggle'), 'faisal-pdf-ibtn faisal-pdf-sidetoggle');
  const info = el('div', 'faisal-pdf-info');
  const nameRow = el('div', 'faisal-pdf-namerow');
  const name = el('div', 'faisal-pdf-name', t('pdf.title'));
  const dirtyDot = el('span', 'faisal-pdf-dirty', '•');
  dirtyDot.hidden = true;
  const dirtyText = el('span', 'faisal-pdf-sr', t('pdf.modified'));
  dirtyDot.append(dirtyText);
  nameRow.append(name, dirtyDot);
  const meta = el('div', 'faisal-pdf-meta');
  info.append(nameRow, meta);
  const readOnlyBadge = el('span', 'faisal-pdf-badge', t('pdf.readOnlyBadge'));
  readOnlyBadge.hidden = true;
  const quick = el('div', 'faisal-pdf-quick');
  const undoBtn = iconButton('undo', `${t('pdf.undo')} (Ctrl+Z)`);
  const redoBtn = iconButton('redo', `${t('pdf.redo')} (Ctrl+Y)`);
  const searchBtn = iconButton('search', `${t('pdf.search')} (Ctrl+F)`);
  const printQuick = iconButton('print', `${t('pdf.printTitle')} (Ctrl+P)`);
  const downloadQuick = iconButton('download', t('pdf.download'));
  const helpBtn = iconButton('help', t('pdf.help'));
  const saveMain = button(t('pdf.save'), 'faisal-pdf-primary');
  saveMain.prepend(icon('save'));
  saveMain.title = `${t('pdf.save')} (Ctrl+S)`;
  const actions = el('div', 'faisal-pdf-actions');
  quick.append(undoBtn, redoBtn, el('span', 'faisal-pdf-sep'), searchBtn, printQuick, downloadQuick, helpBtn);
  bar.append(sideToggle, info, readOnlyBadge, quick, actions, saveMain);

  // Ribbon: a tab strip and one row of grouped tools.
  const tabs = el('nav', 'faisal-pdf-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', t('pdf.ribbonLabel'));
  const ribbon = el('div', 'faisal-pdf-ribbon');
  ribbon.setAttribute('role', 'toolbar');
  ribbon.setAttribute('aria-label', t('pdf.ribbonLabel'));

  const banner = el('div', 'faisal-pdf-banner');
  banner.hidden = true;
  banner.setAttribute('role', 'alert');

  const main = el('div', 'faisal-pdf-main');
  const side = el('aside', 'faisal-pdf-side');
  side.setAttribute('aria-label', t('pdf.sideLabel'));
  const view = el('section', 'faisal-pdf-view');
  view.setAttribute('aria-label', t('pdf.viewLabel'));
  const viewNote = el('div', 'faisal-pdf-viewnote');
  viewNote.hidden = true;
  const ops = el('section', 'faisal-pdf-ops');
  ops.setAttribute('aria-label', t('pdf.paneLabel'));
  const fail = el('section', 'faisal-pdf-fail');
  const start = el('section', 'faisal-pdf-start');
  const scrim = el('div', 'faisal-pdf-scrim');
  main.append(side, view, ops, scrim);

  // Status bar: page navigation, the status message slot, zoom.
  const statusbar = el('footer', 'faisal-pdf-statusbar');
  const status = el('div', 'faisal-pdf-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const progress = el('div', 'faisal-pdf-progress');
  progress.hidden = true;
  progress.setAttribute('aria-hidden', 'true');

  root.append(bar, tabs, ribbon, banner, main, statusbar, start, fail, progress);
  win.content.append(root);
  // Start fetching the page renderer now, in parallel with reading and checking the file.
  if (args[0]) void loadEngine();

  /* ───────────────────────────── state ───────────────────────────── */

  const state = {
    path: args[0] ?? '',
    /** A document with no file yet (made here, or opened from the device): saving names it. */
    untitled: false,
    suggestedName: '',
    original: noBytes(),
    bytes: noBytes(),
    info: null as DocInfo | null,
    selection: new Set<number>(),
    selectionAnchor: 0,
    multiSelect: false,
    merge: [] as { name: string; bytes: Uint8Array; pageCount: number; ranges: string }[],
    images: [] as { name: string; bytes: Uint8Array }[],
    imageMode: 'a4' as ImagePageMode,
    form: null as FormReadResult | null,
    saved: false,
    busy: false,
    confirmOverwrite: false,
    loaded: false,
    readOnly: false,
    password: undefined as string | undefined,
    tool: 'select' as ToolId,
    tab: 'home',
    task: '' as string,
    sidePanel: 'thumbs' as 'thumbs' | 'outline' | 'comments' | 'search',
    sideOpen: true,
    paneOpen: false,
    narrow: false,
    night: false,
    annotations: [] as writer.AnnotationInfo[],
    pendingFields: new Map<string, { widget: FieldWidget; value: string }>(),
    signature: null as { bytes: Uint8Array; url: string; aspect: number; strokes: Point[][]; pad: Box; color: string } | null,
    picture: null as { name: string; bytes: Uint8Array; url: string; aspect: number } | null,
    stamp: '',
  };
  const styles: Record<string, ToolStyle> = {
    highlight: { color: '#FFD54F', opacity: 0.45, width: 1, size: 12 },
    underline: { color: '#5B8DEF', opacity: 1, width: 1, size: 12 },
    strikeout: { color: '#E5484D', opacity: 1, width: 1, size: 12 },
    pen: { color: '#E5484D', opacity: 1, width: 2, size: 12 },
    rect: { color: '#5B8DEF', opacity: 1, width: 2, size: 12 },
    ellipse: { color: '#5B8DEF', opacity: 1, width: 2, size: 12 },
    line: { color: '#E5484D', opacity: 1, width: 2, size: 12 },
    arrow: { color: '#E5484D', opacity: 1, width: 2, size: 12 },
    note: { color: '#FFD54F', opacity: 1, width: 1, size: 12 },
    textbox: { color: '#1A1D26', opacity: 1, width: 1, size: 12 },
    stamp: { color: '#E5484D', opacity: 1, width: 2, size: 18 },
    text: { color: '#1A1D26', opacity: 1, width: 1, size: 14 },
    cover: { color: '#FFFFFF', opacity: 1, width: 1, size: 12 },
    signature: { color: '#12294F', opacity: 1, width: 2.5, size: 12 },
  };
  const history = new ByteHistory();
  const blobUrls: string[] = [];
  let closed = false;
  let lib: PdfJsLib | null = null;
  let renderToken = 0;
  let arabicFont: Promise<Uint8Array> | null = null;
  const unsubs: (() => void)[] = [];
  win.onClose(() => {
    closed = true;
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.length = 0;
    viewer.destroy();
    unsubs.forEach((fn) => fn());
    closePopover();
  });

  const style = (tool: ToolId): ToolStyle => styles[tool] ?? styles.pen;
  const dirty = (): boolean => state.loaded && (!state.saved || state.pendingFields.size > 0);
  win.setCloseGuard(async () => {
    if (!dirty()) return true;
    return shellConfirm({
      title: t('pdf.closeTitle'),
      message: t('pdf.closeMessage', { name: name.textContent ?? '' }),
      okLabel: t('pdf.closeDiscard'),
      cancelLabel: t('pdf.cancel'),
      danger: true,
    });
  });

  function setStatus(text: string, isError = false): void {
    status.textContent = text;
    status.classList.toggle('is-error', isError);
    status.title = text;
    if (isError) showBanner(text); else hideBanner();
  }

  function showBanner(text: string, action?: { label: string; run: () => void }): void {
    banner.textContent = '';
    banner.append(icon('info'), el('span', 'faisal-pdf-banner-text', text));
    if (action) {
      const act = button(action.label, 'faisal-pdf-chip');
      act.addEventListener('click', action.run);
      banner.append(act);
    }
    const x = iconButton('close', t('pdf.dismiss'));
    x.addEventListener('click', hideBanner);
    banner.append(x);
    banner.hidden = false;
  }

  function hideBanner(): void {
    banner.hidden = true;
    banner.textContent = '';
  }

  /* ───────────────────────── refusal, honestly ───────────────────────── */

  function showFailure(messageKey: string, detail?: string): void {
    root.dataset.mode = 'fail';
    fail.textContent = '';
    const card = el('div', 'faisal-pdf-card is-fail');
    card.append(emptyArt());
    card.append(el('h2', 'faisal-pdf-h2', t('pdf.refusalTitle')));
    card.append(el('p', 'faisal-pdf-p', t(messageKey)));
    card.append(el('p', 'faisal-pdf-p is-muted', t('pdf.noOverwrite')));
    if (detail) {
      const line = el('p', 'faisal-pdf-p is-detail', t('pdf.refusalDetail', { detail }));
      line.dir = 'ltr';
      card.append(line);
    }
    const another = button(t('pdf.chooseAnother'), 'faisal-pdf-primary');
    another.addEventListener('click', () => showStart());
    card.append(actionRow(another));
    card.append(limitsCard());
    fail.append(card);
  }

  function failWithCode(code: PdfRefusalCode, detail?: string, extra?: string): void {
    const key = refusalKey(code);
    showFailure(key, extra ? `${extra} — ${detail ?? ''}` : detail);
  }

  function refreshHeader(): void {
    dirtyDot.hidden = !dirty();
    undoBtn.disabled = !history.canUndo || state.busy;
    redoBtn.disabled = !history.canRedo || state.busy;
    if (!state.info) { meta.textContent = ''; return; }
    const size = formatBytes(state.bytes.length, sys.locale());
    const count = state.info.pageCount === 1 ? t('pdf.pageCountOne') : t('pdf.pagesCount', { n: state.info.pageCount });
    const parts = [count, t('pdf.sizeLabel', { size })];
    if (dirty()) parts.push(t('pdf.modified'));
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
    for (const key of LIMIT_KEYS) list.append(el('li', undefined, t(key, { n: PAGE_ROWS })));
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
    const dd = el('dd', undefined, value || t('pdf.infoNone'));
    dd.dir = 'auto';
    row.append(el('dt', undefined, t(labelKey)), dd);
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
    thumbs.setSelection(state.selection, viewer.currentPage);
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
  selectAll.addEventListener('click', () => { selectAllPages(); });
  clearSelection.addEventListener('click', () => {
    state.selection.clear();
    refreshPages();
    setStatus(t('pdf.selectionNone'));
  });

  function selectAllPages(): void {
    if (!state.info) return;
    state.selection = new Set(range(state.info.pageCount));
    refreshPages();
    setStatus(t('pdf.selectedCount', { n: state.selection.size }));
  }

  /* ───────────────────────── operations ───────────────────────── */

  function selected(): number[] {
    return [...state.selection].sort((a, b) => a - b);
  }

  /** The pages a page command acts on: the selection, or the page being read. */
  function targetPages(): number[] {
    return state.selection.size ? selected() : [Math.max(0, viewer.currentPage)];
  }

  function opMessage(code: PdfRefusalCode | 'noBytes', detail: string): string {
    const base = code === 'noBytes' ? t('pdf.saveNoBytes') : t(refusalKey(code));
    return detail ? `${base} (${detail})` : base;
  }

  let idle: Promise<void> = Promise.resolve();
  let release: () => void = () => {};

  function setBusy(on: boolean): void {
    state.busy = on;
    root.classList.toggle('is-busy', on);
    progress.hidden = !on;
    if (on) {
      idle = new Promise((resolve) => { release = resolve; });
      setStatus(t('pdf.busy'));
    } else {
      release();
    }
    refreshHeader();
  }

  /**
   * Runs one verified operation; the working copy only changes when the bytes were checked.
   * Operations queue: a stroke committed while another edit is still being written waits for it
   * instead of being dropped.
   */
  async function applyOp(run: () => Promise<OpResult>, done: string, keepSelection = false): Promise<boolean> {
    if (!state.info) return false;
    if (state.readOnly) { setStatus(t('pdf.readOnlyRefused'), true); return false; }
    while (state.busy) await idle;
    if (closed || !state.info) return false;
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
    history.record(state.bytes);
    state.bytes = result.bytes;
    state.saved = false;
    if (!keepSelection) state.selection.clear();
    await refreshWorking();
    console.debug('[pdf] verified:', result.verified);
    setStatus(`${done} · ${t('pdf.opVerified')}`);
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
    void refreshView(true);
    refreshEditBounds();
    refreshMetadataForm();
    refreshMergeList();
    await refreshForm();
    void refreshSaveTarget();
    void refreshAnnotations();
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
    state.form = state.readOnly ? { ok: true, hasForm: false, fields: [] } : await readFormFields(state.bytes);
    if (closed) return;
    refreshFormPanel();
  }

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
  const textPlaceBtn = button(t('pdf.placeOnPage'), 'faisal-pdf-btn is-primary');
  textPlaceBtn.addEventListener('click', () => setTool('text'));
  const textAdvanced = el('details', 'faisal-pdf-advanced');
  textAdvanced.append(el('summary', undefined, t('pdf.advancedCoords')));
  const textValue = textInput('faisal-pdf-text-value');
  textValue.dir = 'auto';
  const textPage = numberInput('faisal-pdf-text-page', 1, 1, 1);
  const textFont = selectInput('faisal-pdf-text-font', TEXT_FONTS.map((font): [string, string] => [font, FONT_LABEL[font]]));
  const textSize = numberInput('faisal-pdf-text-size', 18, 4, 400);
  const textColor = colorInput('faisal-pdf-text-color', '#1a1a1a');
  const textX = numberInput('faisal-pdf-text-x', 72, 0, 20000);
  const textY = numberInput('faisal-pdf-text-y', 72, 0, 20000);
  const textApply = button(t('pdf.textApply'), 'faisal-pdf-btn is-primary');
  textAdvanced.append(
    field('faisal-pdf-text-value', 'pdf.textValue', textValue),
    actionRow(field('faisal-pdf-text-page', 'pdf.textPage', textPage), field('faisal-pdf-text-font', 'pdf.textFont', textFont)),
    actionRow(field('faisal-pdf-text-size', 'pdf.textSize', textSize), field('faisal-pdf-text-color', 'pdf.textColor', textColor)),
    actionRow(field('faisal-pdf-text-x', 'pdf.textX', textX), field('faisal-pdf-text-y', 'pdf.textY', textY)),
    actionRow(textApply),
  );
  textCard.body.append(actionRow(textPlaceBtn), textAdvanced, el('div', 'faisal-pdf-hint', t('pdf.textNote')));

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
    if (writer.needsUnicodeFont(input.text)) {
      void addUnicode({ page, text: input.text, size: input.size, x: input.x, y: input.y, color: input.color });
      return;
    }
    const check = checkAddedText(input, state.info.pages[page]);
    if (!check.ok) { setStatus(addedTextMessage(check), true); return; }
    void applyOp(() => addText(state.bytes, input), t('pdf.textDone', { n: page + 1 }));
  });

  /** Arabic or mixed text: drawn by the engine with the embedded Arabic font. */
  async function addUnicode(input: writer.UnicodeTextInput): Promise<boolean> {
    let font: Uint8Array;
    try {
      font = await getArabicFont();
    } catch {
      setStatus(t('pdf.fontUnavailable'), true);
      return false;
    }
    return applyOp(() => writer.addUnicodeText(state.bytes, input, font), t('pdf.textDone', { n: input.page + 1 }));
  }

  function getArabicFont(): Promise<Uint8Array> {
    arabicFont ??= writer.loadArabicFont().catch((error: unknown) => { arabicFont = null; throw error; });
    return arabicFont;
  }

  /* signature: drawn, typed (large italic text) or a picture picked from the device */
  const signCard = card('pdf.signTitle', 'pdf.signDesc');
  const signDrawBtn = button(t('pdf.signDraw'), 'faisal-pdf-btn is-primary');
  signDrawBtn.addEventListener('click', () => { void startSignature(); });
  const signAdvanced = el('details', 'faisal-pdf-advanced');
  signAdvanced.append(el('summary', undefined, t('pdf.advancedCoords')));
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
  signAdvanced.append(
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
  signCard.body.append(actionRow(signDrawBtn), signAdvanced);

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
    if (writer.needsUnicodeFont(input.text)) { void addUnicode(input); return; }
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
  const coverPlaceBtn = button(t('pdf.placeOnPage'), 'faisal-pdf-btn is-primary');
  coverPlaceBtn.addEventListener('click', () => setTool('cover'));
  const coverAdvanced = el('details', 'faisal-pdf-advanced');
  coverAdvanced.append(el('summary', undefined, t('pdf.advancedCoords')));
  const coverPage = numberInput('faisal-pdf-cover-page', 1, 1, 1);
  const coverWidth = numberInput('faisal-pdf-cover-width', 300, 1, 20000);
  const coverHeight = numberInput('faisal-pdf-cover-height', 60, 1, 20000);
  const coverX = numberInput('faisal-pdf-cover-x', 72, 0, 20000);
  const coverY = numberInput('faisal-pdf-cover-y', 120, 0, 20000);
  const coverColor = colorInput('faisal-pdf-cover-color', '#ffffff');
  coverColor.addEventListener('input', () => { styles.cover.color = coverColor.value; });
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
  coverAdvanced.append(
    actionRow(field('faisal-pdf-cover-page', 'pdf.textPage', coverPage), field('faisal-pdf-cover-width', 'pdf.coverWidth', coverWidth), field('faisal-pdf-cover-height', 'pdf.coverHeight', coverHeight)),
    actionRow(field('faisal-pdf-cover-x', 'pdf.textX', coverX), field('faisal-pdf-cover-y', 'pdf.textY', coverY)),
    actionRow(coverApply),
  );
  coverCard.body.append(
    coverNote,
    el('div', 'faisal-pdf-label', t('pdf.coverShape')), coverShapeRow,
    actionRow(field('faisal-pdf-cover-color', 'pdf.textColor', coverColor), coverPlaceBtn),
    coverAdvanced,
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
  function formRow(item: FormFieldInfo, index: number): HTMLElement {
    const id = `faisal-pdf-form-${index}`;
    if (item.kind === 'checkbox') {
      const check = el('input', 'faisal-pdf-checkbox');
      check.type = 'checkbox';
      check.id = id;
      check.checked = item.checked;
      check.disabled = item.readOnly;
      formInputs.push({ name: item.name, kind: 'checkbox', input: check });
      const label = el('label', 'faisal-pdf-check');
      label.htmlFor = id;
      label.append(check, el('span', 'faisal-pdf-label', `${item.name} — ${t('pdf.formCheckbox')}`));
      const wrap = el('div', 'faisal-pdf-field');
      wrap.append(label);
      if (item.readOnly) wrap.append(el('div', 'faisal-pdf-hint', t('pdf.formReadOnly')));
      return wrap;
    }
    const input = textInput(id, item.value);
    input.dir = 'auto';
    input.disabled = item.readOnly;
    formInputs.push({ name: item.name, kind: 'text', input });
    return fieldNode(id, item.name, input, item.readOnly ? t('pdf.formReadOnly') : undefined);
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
    formPanel.append(el('div', 'faisal-pdf-hint', t('pdf.formOnPageHint')));
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

  /** Where new files made from this document go: next to it, or Documents for a new document. */
  function sourceForCopies(): string {
    if (!state.untitled && state.path) return state.path;
    return `${HOME}/Documents/${(state.suggestedName || t('pdf.untitled')).replace(/\.pdf$/i, '')}.pdf`;
  }

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
        sourcePath: sourceForCopies(), suffix: `-${index + 1}`, overwrite: false,
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

  /** Extract: the selected pages (or the current one) become a new file next to this one. */
  async function extractSelection(): Promise<void> {
    if (state.busy || !state.info) return;
    const pages = targetPages();
    setBusy(true);
    const result = await extractPages(state.bytes, pages);
    let message = '';
    let isError = false;
    if (!result.ok) {
      message = t('pdf.opFailed', { message: opMessage(result.code, result.detail) });
      isError = true;
    } else {
      const saved = await saveBytes(sys, { sourcePath: sourceForCopies(), suffix: t('pdf.extractSuffix'), overwrite: false }, result.bytes);
      if (saved.ok) message = t('pdf.extractDone', { n: pages.length, path: saved.path });
      else { message = opMessage(saved.code, ''); isError = true; }
    }
    setBusy(false);
    if (!closed) setStatus(message, isError);
  }

  /* merge */
  const mergeCard = card('pdf.mergeTitle', 'pdf.mergeDesc');
  const mergeList = el('div', 'faisal-pdf-list');
  const mergeAdd = button(t('pdf.mergeAdd'));
  const mergeAddFiles = button(t('pdf.mergeAddFiles'));
  const mergeApply = button(t('pdf.mergeApply'), 'faisal-pdf-btn is-primary');
  mergeCard.body.append(mergeList, actionRow(mergeAdd, mergeAddFiles, mergeApply));
  mergeAdd.addEventListener('click', () => { void addMergeFiles(); });
  mergeAddFiles.addEventListener('click', () => {
    void pickFromHome(true).then(async (paths) => {
      for (const path of paths) {
        try {
          const bytes = await sys.vfs.readFile(path);
          await addMergeBytes([{ name: basename(path), bytes }]);
        } catch {
          setStatus(`${basename(path)}: ${t('pdf.readError')}`, true);
        }
      }
    });
  });
  mergeApply.addEventListener('click', () => { void runMerge(); });

  function refreshMergeList(): void {
    mergeList.textContent = '';
    if (!state.info) return;
    const opened = el('div', 'faisal-pdf-listrow');
    opened.append(el('div', 'faisal-pdf-listname', t('pdf.mergeOpenDoc')));
    opened.append(el('div', 'faisal-pdf-listmeta', t('pdf.sourcePages', { name: basename(state.path) || state.suggestedName, n: state.info.pageCount })));
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

  async function addMergeBytes(files: { name: string; bytes: Uint8Array }[]): Promise<void> {
    setBusy(true);
    for (const file of files) {
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

  async function addMergeFiles(): Promise<void> {
    if (state.busy) return;
    const picked = await pickFiles(PDF_TYPES);
    if (closed || !picked.length) return;
    await addMergeBytes(picked);
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
    if (!state.info) {
      // From the start screen: the pictures become a new, untitled document.
      const result = await imagesToPdf(state.images, state.imageMode);
      if (!result.ok) { setStatus(opMessage(result.code, result.detail), true); return; }
      await openBytes(result.bytes, { name: t('pdf.newFromImagesName') });
      setStatus(done);
      return;
    }
    await applyOp(() => imagesToPdf(state.images, state.imageMode), done);
  }

  /* save */
  const saveCard = card('pdf.saveTitle', 'pdf.saveDesc');
  const saveTarget = el('div', 'faisal-pdf-line faisal-pdf-savetarget');
  saveTarget.dir = 'auto';
  const saveCopy = button(t('pdf.saveCopy'), 'faisal-pdf-btn is-primary');
  const saveOverwrite = button(t('pdf.saveOverwrite'), 'faisal-pdf-btn is-danger');
  const saveAsBtn = button(t('pdf.saveAs'));
  const overwriteBox = el('div', 'faisal-pdf-confirm');
  overwriteBox.hidden = true;
  const resetBtn = button(t('pdf.reset'));
  saveCard.body.append(saveTarget, actionRow(saveCopy, saveOverwrite, saveAsBtn), overwriteBox, actionRow(resetBtn));

  async function refreshSaveTarget(): Promise<void> {
    if (!state.info) { saveTarget.textContent = ''; return; }
    if (state.untitled) {
      const planned = await untitledTarget();
      if (closed) return;
      saveTarget.textContent = planned ? t('pdf.saveTarget', { path: planned }) : t('pdf.saveFailed');
      return;
    }
    if (!state.path) { saveTarget.textContent = ''; return; }
    const planned = await previewSave(sys, {
      sourcePath: state.path, suffix: t('pdf.saveCopySuffix'), overwrite: false,
    });
    if (closed) return;
    saveTarget.textContent = planned.ok
      ? t('pdf.saveTarget', { path: planned.plan.target })
      : t(refusalKey(planned.error));
  }

  async function untitledTarget(): Promise<string | null> {
    const docs = `${HOME}/Documents`;
    const dir = await sys.vfs.exists(docs).catch(() => false) ? docs : HOME;
    return freePdfPath(dir, state.suggestedName || t('pdf.untitled'), (p) => sys.vfs.exists(p));
  }

  /** Pending on-page form values are written into the document before any save. */
  async function flushFields(): Promise<boolean> {
    if (!state.pendingFields.size) return true;
    const entries = [...state.pendingFields.values()];
    const simple = entries.every((e) => e.widget.kind === 'text' || e.widget.kind === 'checkbox');
    let run: () => Promise<OpResult>;
    if (writer.ENGINE_READY) {
      let font: Uint8Array | undefined;
      if (entries.some((e) => writer.needsUnicodeFont(e.value))) {
        try { font = await getArabicFont(); } catch { setStatus(t('pdf.fontUnavailable'), true); return false; }
      }
      const opts = font ? { arabicFont: font } : {};
      run = () => writer.fillFields(state.bytes, entries.map((e) => ({
        name: e.widget.name,
        value: e.widget.kind === 'checkbox' ? e.value !== 'Off' && e.value !== '' : e.value,
      })), opts);
    } else if (simple) {
      run = () => fillFormFields(state.bytes, entries.map((e) => (e.widget.kind === 'text'
        ? { name: e.widget.name, kind: 'text' as const, value: e.value }
        : { name: e.widget.name, kind: 'checkbox' as const, checked: e.value !== 'Off' && e.value !== '' })));
    } else {
      setStatus(t('pdf.fieldsNeedEngine'), true);
      return false;
    }
    const ok = await applyOp(run, t('pdf.formDone', { n: entries.length }), true);
    if (ok) state.pendingFields.clear();
    refreshHeader();
    return ok;
  }

  /** Reads the saved file back and compares it before the window says "saved". */
  async function verifySaved(path: string, bytes: Uint8Array): Promise<boolean> {
    try {
      const back = await sys.vfs.readFile(path);
      if (back.length !== bytes.length) return false;
      for (let i = 0; i < back.length; i += Math.max(1, Math.floor(back.length / 64))) if (back[i] !== bytes[i]) return false;
      return back[back.length - 1] === bytes[bytes.length - 1];
    } catch {
      return false;
    }
  }

  function markSaved(path: string): void {
    state.saved = true;
    state.original = state.bytes;
    rememberRecent(path);
    refreshHeader();
  }

  async function runSave(overwrite: boolean): Promise<void> {
    if (state.busy || !state.info) return;
    if (state.readOnly) { setStatus(t('pdf.readOnlyRefused'), true); return; }
    if (!(await flushFields())) return;
    if (!state.bytes.length) { setStatus(t('pdf.saveNoBytes'), true); return; }
    if (state.untitled) { await saveUntitled(); return; }
    setBusy(true);
    const saved = await saveBytes(sys, {
      sourcePath: state.path, suffix: t('pdf.saveCopySuffix'), overwrite,
    }, state.bytes);
    const verified = saved.ok ? await verifySaved(saved.path, state.bytes) : false;
    setBusy(false);
    if (closed) return;
    if (!saved.ok) {
      setStatus(opMessage(saved.code, ''), true);
      return;
    }
    if (!verified) { setStatus(t('pdf.saveVerifyFailed', { path: saved.path }), true); return; }
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

  async function saveUntitled(): Promise<void> {
    const target = await untitledTarget();
    if (!target) { setStatus(t('pdf.saveFailed'), true); return; }
    await saveTo(target, false);
  }

  /** Writes to `target` (a new file, or an existing one after its single `.bak`), then adopts it. */
  async function saveTo(target: string, replacing: boolean): Promise<void> {
    setBusy(true);
    const saved = await writePlan(sys, { source: target, target, backup: replacing ? `${target}.bak` : null, isCopy: !replacing }, state.bytes);
    const verified = saved.ok ? await verifySaved(saved.path, state.bytes) : false;
    setBusy(false);
    if (closed) return;
    if (!saved.ok) { setStatus(opMessage(saved.code, ''), true); return; }
    if (!verified) { setStatus(t('pdf.saveVerifyFailed', { path: saved.path }), true); return; }
    state.path = target;
    state.untitled = false;
    setDocName(basename(target), target);
    markSaved(target);
    await refreshSaveTarget();
    refreshMergeList();
    setStatus(t('pdf.saveDoneCopy', { path: target }));
  }

  /**
   * «حفظ باسم» — the shared shell dialog. It replaces the old form that asked the owner to TYPE
   * a path: the folder is browsed inside /home/user, the file name and the format are picked
   * there, replacing is confirmed by the same dialog (one `.bak`, never two), and a cancelled or
   * failed save writes nothing. The bytes are the ones this window holds, and the written file is
   * read back by the dialog before it reports "saved".
   */
  async function saveAs(): Promise<void> {
    if (!state.info || state.readOnly) return;
    if (!(await flushFields())) return;
    const suggestion = state.untitled
      ? await untitledTarget()
      : (await previewSave(sys, { sourcePath: state.path, suffix: t('pdf.saveCopySuffix'), overwrite: false }));
    const initial = typeof suggestion === 'string' ? suggestion : suggestion?.ok ? suggestion.plan.target : `${HOME}/document.pdf`;
    const outcome = await saveAsDialog({
      vfs: sys.vfs,
      host: win.content,
      title: t('pdf.saveAs'),
      dir: dirname(initial),
      name: basename(initial).replace(/\.pdf$/i, '') || t('pdf.untitled'),
      formats: [{ value: 'pdf', label: t('pdf.formatPdf'), ext: 'pdf', mime: 'application/pdf' }],
      format: 'pdf',
      saveLabel: t('pdf.save'),
      encode: async () => state.bytes,
    });
    if (outcome.status !== 'saved') return;
    state.path = outcome.path;
    state.untitled = false;
    setDocName(basename(outcome.path), outcome.path);
    markSaved(outcome.path);
    await refreshSaveTarget();
    refreshMergeList();
    setStatus(t('pdf.saveDoneCopy', { path: outcome.path }));
  }

  saveCopy.addEventListener('click', () => { void runSave(false); });
  saveOverwrite.addEventListener('click', () => { void showOverwriteConfirm(); });
  saveAsBtn.addEventListener('click', () => { void saveAs(); });
  resetBtn.addEventListener('click', () => {
    if (state.busy || !state.original.length) return;
    history.record(state.bytes);
    state.bytes = state.original;
    state.saved = true;
    state.selection.clear();
    state.pendingFields.clear();
    overwriteBox.hidden = true;
    setStatus(t('pdf.resetDone'));
    void refreshWorking();
  });

  async function showOverwriteConfirm(): Promise<void> {
    if (!state.info || state.confirmOverwrite) return;
    if (state.untitled) { await saveUntitled(); return; }
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
    showTask('save');
  }

  /* security (honest: what the document allows, what this app can and cannot lock) */
  const securityCard = card('pdf.securityTitle', 'pdf.securityDesc');
  const securityState = el('div', 'faisal-pdf-line');
  const permList = el('ul', 'faisal-pdf-limits');
  const lockRow = el('div', 'faisal-pdf-soon');
  lockRow.append(icon('lock'), el('span', undefined, t('pdf.limitNoPassword')));
  securityCard.body.append(securityState, permList, lockRow);

  async function refreshSecurity(): Promise<void> {
    securityState.textContent = state.readOnly ? t('pdf.securityEncrypted') : t('pdf.securityOpen');
    permList.textContent = '';
    const doc = viewer.document;
    if (!doc || !lib) return;
    let perms: ReadonlySet<number> | readonly number[] | null = null;
    try { perms = await doc.getPermissions() as ReadonlySet<number> | readonly number[] | null; } catch { perms = null; }
    if (!perms) { permList.append(el('li', undefined, t('pdf.permAll'))); return; }
    const flags = lib.PermissionFlag;
    const has = (flag: number): boolean => (perms instanceof Set ? perms.has(flag) : (perms as readonly number[] | null)?.includes(flag)) ?? false;
    permList.append(
      el('li', undefined, `${t('pdf.permPrint')}: ${has(flags.PRINT) ? t('pdf.permYes') : t('pdf.permNo')}`),
      el('li', undefined, `${t('pdf.permCopy')}: ${has(flags.COPY) ? t('pdf.permYes') : t('pdf.permNo')}`),
      el('li', undefined, `${t('pdf.permModify')}: ${has(flags.MODIFY_CONTENTS) ? t('pdf.permYes') : t('pdf.permNo')}`),
      el('li', undefined, `${t('pdf.permAnnotate')}: ${has(flags.MODIFY_ANNOTATIONS) ? t('pdf.permYes') : t('pdf.permNo')}`),
    );
  }

  /* ───────────────────────── view/download actions ───────────────────────── */

  function downloadResult(): void {
    if (!state.bytes.length) return;
    const url = URL.createObjectURL(new Blob([state.bytes.slice()], { type: 'application/octet-stream' }));
    const a = el('a');
    a.href = url;
    const stem = (state.untitled ? state.suggestedName || t('pdf.untitled') : basename(state.path)).replace(/\.pdf$/i, '');
    a.download = `${stem}${state.untitled ? '' : t('pdf.saveCopySuffix')}.pdf`;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus(t('pdf.downloadDone'));
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

  function openInTab(): void {
    if (!state.bytes.length) return;
    const url = URL.createObjectURL(new Blob([state.bytes.slice()], { type: 'application/pdf' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function pickFiles(accept: string, multiple = true): Promise<{ name: string; bytes: Uint8Array }[]> {
    return new Promise((resolve) => {
      const input = el('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
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

  /* ───────────────────────────── the viewer ───────────────────────────── */

  const viewer = new PdfViewer({
    onPageChange: (page) => {
      refreshPageBox();
      thumbs.setSelection(state.selection, page);
      thumbs.reveal(page);
    },
    onZoomChange: () => refreshZoomBox(),
    onFirstPaint: (canvas) => rememberThumb(canvas),
    fieldValue: (fieldName, fallback) => state.pendingFields.get(fieldName)?.value ?? fallback,
    onFieldInput: (widget, value) => {
      if (state.readOnly) return;
      state.pendingFields.set(widget.name, { widget, value });
      refreshHeader();
      fieldsHint.hidden = false;
    },
    onAnnotationClick: (info, anchor) => { if (state.tool === 'select') openAnnotationPopover(info, anchor); },
    onExternalLink: (url) => { void openExternal(url); },
  });

  async function openExternal(url: string): Promise<void> {
    const yes = await shellConfirm({
      title: t('pdf.linkOpenTitle'), message: t('pdf.linkOpenMessage', { url }),
      okLabel: t('pdf.linkOpen'), cancelLabel: t('pdf.cancel'),
    });
    if (yes) window.open(url, '_blank', 'noopener,noreferrer');
  }

  const fieldsHint = el('div', 'faisal-pdf-fieldshint');
  fieldsHint.hidden = true;
  const fieldsHintText = el('span', undefined, t('pdf.fieldsPending'));
  const fieldsWrite = button(t('pdf.fieldsWrite'), 'faisal-pdf-chip is-primary');
  fieldsWrite.addEventListener('click', () => { void flushFields().then((ok) => { if (ok) fieldsHint.hidden = true; }); });
  fieldsHint.append(fieldsHintText, fieldsWrite);
  view.append(viewNote, fieldsHint);

  /** (Re)draws the working bytes with pdf.js. `keep` holds the reading position after an edit. */
  async function refreshView(keep: boolean): Promise<void> {
    if (!state.bytes.length) return;
    if (!viewer.scroller.isConnected) view.prepend(viewer.scroller);
    const token = ++renderToken;
    lib = await loadEngine();
    if (closed || token !== renderToken) return;
    if (!lib) {
      viewNote.hidden = false;
      viewNote.textContent = '';
      viewNote.append(emptyArt(), el('p', 'faisal-pdf-p', engineSupported() ? t('pdf.viewNoViewer') : t('pdf.viewNoCanvas')));
      thumbs.setDocument(null, null, state.info?.pageCount ?? 0);
      return;
    }
    viewNote.hidden = true;
    let doc: PdfJsDocument;
    try {
      doc = await openForRender(lib, state.bytes, { password: state.password });
    } catch (error) {
      if (closed || token !== renderToken) return;
      viewNote.hidden = false;
      viewNote.textContent = '';
      viewNote.append(el('p', 'faisal-pdf-p', t('pdf.viewRenderFailed')));
      console.warn('[pdf] render open failed', error);
      return;
    }
    if (closed || token !== renderToken) { void doc.loadingTask.destroy(); return; }
    await viewer.setDocument(lib, doc, keep);
    if (closed || token !== renderToken) return;
    thumbs.setDocument(lib, doc, doc.numPages);
    thumbs.setSelection(state.selection, viewer.currentPage);
    refreshPageBox();
    refreshZoomBox();
    void refreshOutline(doc);
    void refreshPageLabels(doc);
    void refreshSecurity();
    if (searchInput.value.trim()) void runSearch(searchInput.value, true);
  }

  /* ───────────────────────────── sidebar ───────────────────────────── */

  const rail = el('div', 'faisal-pdf-rail');
  rail.setAttribute('role', 'tablist');
  rail.setAttribute('aria-orientation', 'vertical');
  const sidePanel = el('div', 'faisal-pdf-sidepanel');
  const sideHead = el('div', 'faisal-pdf-panelhead');
  const sideTitle = el('h2', 'faisal-pdf-paneltitle');
  const sideClose = iconButton('close', t('pdf.close'));
  sideClose.addEventListener('click', () => setSide(false));
  const multiToggle = iconButton('check', t('pdf.multiSelect'), 'faisal-pdf-ibtn faisal-pdf-multitoggle');
  multiToggle.setAttribute('aria-pressed', 'false');
  multiToggle.addEventListener('click', () => {
    state.multiSelect = !state.multiSelect;
    multiToggle.setAttribute('aria-pressed', String(state.multiSelect));
    setStatus(state.multiSelect ? t('pdf.multiSelectOn') : t('pdf.multiSelectOff'));
  });
  sideHead.append(sideTitle, multiToggle, sideClose);
  const sideBody = el('div', 'faisal-pdf-sidebody');
  sidePanel.append(sideHead, sideBody);
  side.append(rail, sidePanel);

  const thumbs = new ThumbPanel({
    onActivate: (page, mods) => {
      if (mods.shift) {
        const [a, b] = [Math.min(state.selectionAnchor, page), Math.max(state.selectionAnchor, page)];
        state.selection = new Set(range(b - a + 1).map((i) => a + i));
      } else if (mods.ctrl || state.multiSelect) {
        if (state.selection.has(page)) state.selection.delete(page); else state.selection.add(page);
        state.selectionAnchor = page;
      } else {
        state.selection = new Set([page]);
        state.selectionAnchor = page;
        viewer.goToPage(page);
        if (state.narrow) setSide(false);
      }
      refreshPages();
    },
    onMove: (pages, to) => {
      if (!state.info) return;
      const order = moveBlock(state.info.pageCount, pages, to);
      if (isIdentityOrder(order)) return;
      const moved = new Set(pages);
      void applyOp(() => reorderPages(state.bytes, order), t('pdf.reorderDone')).then((ok) => {
        if (!ok) return;
        state.selection = new Set(order.map((p, i) => (moved.has(p) ? i : -1)).filter((i) => i >= 0));
        refreshPages();
      });
    },
    onMenu: (page, x, y, invoker) => {
      if (!state.selection.has(page)) { state.selection = new Set([page]); state.selectionAnchor = page; refreshPages(); }
      showContextMenu(x, y, pageMenuItems(), { invoker });
    },
  });

  function pageMenuItems(): ContextMenuItem[] {
    const n = targetPages().length;
    return [
      { label: t('pdf.rotateLeft'), action: () => rotateTargets(-90) },
      { label: t('pdf.rotateRight'), action: () => rotateTargets(90) },
      { separator: true },
      { label: t('pdf.duplicateCmd'), action: () => { void applyOp(() => duplicatePages(state.bytes, targetPages()), t('pdf.duplicateDone', { n })); } },
      { label: t('pdf.insertBefore'), action: () => insertBlank(Math.min(...targetPages())) },
      { label: t('pdf.insertAfter'), action: () => insertBlank(Math.max(...targetPages()) + 1) },
      { label: t('pdf.extractCmd'), action: () => { void extractSelection(); } },
      { separator: true },
      { label: t('pdf.deleteCmd'), danger: true, action: () => { void deleteTargets(); } },
    ];
  }

  function rotateTargets(delta: number): void {
    const pages = targetPages();
    void applyOp(() => rotatePages(state.bytes, pages, (delta + 360) % 360), t('pdf.rotateDone', { n: pages.length }), true);
  }

  function insertBlank(at: number): void {
    void applyOp(() => insertBlankPage(state.bytes, at), t('pdf.blankDone', { n: at + 1 }));
  }

  async function deleteTargets(): Promise<void> {
    if (!state.info) return;
    const pages = targetPages();
    if (pages.length >= state.info.pageCount) { setStatus(t('pdf.refusalEmptyResult'), true); return; }
    const yes = await shellConfirm({
      title: t('pdf.deleteTitle'), message: t('pdf.deleteConfirm', { n: pages.length }),
      okLabel: t('pdf.deleteCmd'), cancelLabel: t('pdf.cancel'), danger: true,
    });
    if (yes) await applyOp(() => removePages(state.bytes, pages), t('pdf.deleteDone', { n: pages.length }));
  }

  // Outline
  const outlineBox = el('div', 'faisal-pdf-outline');
  async function refreshOutline(doc: PdfJsDocument): Promise<void> {
    outlineBox.textContent = '';
    let outline: Awaited<ReturnType<PdfJsDocument['getOutline']>> | null = null;
    try { outline = await doc.getOutline(); } catch { outline = null; }
    if (!outline?.length) { outlineBox.append(emptyState(t('pdf.outlineEmpty'))); return; }
    type Node = { title: string; dest: unknown; items: Node[] };
    const build = (items: Node[], depth: number): HTMLElement => {
      const list = el('ul', 'faisal-pdf-tree');
      list.setAttribute('role', depth ? 'group' : 'tree');
      for (const item of items) {
        const li = el('li');
        li.setAttribute('role', 'treeitem');
        const b = button(item.title || '—', 'faisal-pdf-treeitem');
        b.dir = 'auto';
        b.style.setProperty('--depth', String(depth));
        b.addEventListener('click', () => {
          void viewer.goToDest(item.dest);
          if (state.narrow) setSide(false);
        });
        li.append(b);
        if (item.items?.length && depth < 6) li.append(build(item.items, depth + 1));
        list.append(li);
      }
      return list;
    };
    outlineBox.append(build(outline as unknown as Node[], 0));
  }

  // Comments list
  const commentsBox = el('div', 'faisal-pdf-comments');
  function refreshCommentsList(): void {
    commentsBox.textContent = '';
    const list = state.annotations.filter((a) => a.kind);
    if (!list.length) {
      commentsBox.append(emptyState(writer.ENGINE_READY ? t('pdf.commentsEmpty') : t('pdf.engineMissing')));
      return;
    }
    let lastPage = -1;
    for (const info of list) {
      if (info.page !== lastPage) {
        commentsBox.append(el('div', 'faisal-pdf-listhead', t('pdf.pageN', { n: info.page + 1 })));
        lastPage = info.page;
      }
      const row = button('', 'faisal-pdf-commentrow');
      const dot = el('span', 'faisal-pdf-swatchdot');
      dot.style.background = info.color ?? 'transparent';
      const text = el('span', 'faisal-pdf-commenttext', info.contents);
      text.dir = 'auto';
      row.append(dot, el('span', 'faisal-pdf-commentkind', kindLabel(info.kind ?? 'note')), text);
      row.addEventListener('click', () => {
        viewer.goToPoint(info.page, info.rect.y + info.rect.height);
        if (state.narrow) setSide(false);
      });
      commentsBox.append(row);
    }
  }

  async function refreshAnnotations(): Promise<void> {
    if (state.readOnly) { state.annotations = []; return; }
    try { state.annotations = await writer.listAnnotations(state.bytes); } catch { state.annotations = []; }
    if (closed) return;
    viewer.setAnnotations(state.annotations);
    refreshCommentsList();
  }

  // Search panel
  const searchBox = el('div', 'faisal-pdf-searchbox');
  const searchInput = el('input', 'faisal-pdf-searchinput');
  searchInput.type = 'search';
  searchInput.dir = 'auto';
  searchInput.placeholder = t('pdf.searchPlaceholder');
  searchInput.setAttribute('aria-label', t('pdf.search'));
  const searchPrev = iconButton('chevronPrev', `${t('pdf.searchPrev')} (Shift+F3)`);
  const searchNext = iconButton('chevronNext', `${t('pdf.searchNext')} (F3)`);
  const searchCount = el('div', 'faisal-pdf-searchcount');
  searchCount.setAttribute('aria-live', 'polite');
  const searchResults = el('div', 'faisal-pdf-results');
  const searchRow = el('div', 'faisal-pdf-searchrow');
  searchRow.append(searchInput, searchPrev, searchNext);
  searchBox.append(searchRow, searchCount, searchResults);
  let hits: Hit[] = [];
  let hitIndex = -1;
  let searchToken = 0;
  let searchTimer = 0;
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { void runSearch(searchInput.value, false); }, 220);
  });
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); stepSearch(ev.shiftKey ? -1 : 1); }
  });
  searchPrev.addEventListener('click', () => stepSearch(-1));
  searchNext.addEventListener('click', () => stepSearch(1));

  async function runSearch(query: string, keepIndex: boolean): Promise<void> {
    const token = ++searchToken;
    hits = [];
    if (!keepIndex) hitIndex = -1;
    searchResults.textContent = '';
    viewer.setHits([], -1);
    if (!query.trim() || !viewer.pageCount) { searchCount.textContent = ''; return; }
    searchCount.textContent = t('pdf.searching');
    const texts: string[] = [];
    for (let page = 0; page < viewer.pageCount; page++) {
      const items = await viewer.textItems(page).catch(() => []);
      if (token !== searchToken || closed) return;
      const text = buildPageText(items).text;
      texts[page] = text;
      for (const [s, e] of findAll(text, query)) {
        const hit = { page, start: s, end: e };
        hits.push(hit);
        if (hits.length <= 500) searchResults.append(resultRow(hit, hits.length - 1, text));
      }
      if (page % 8 === 7) await new Promise((r) => setTimeout(r, 0));
    }
    if (token !== searchToken) return;
    if (!hits.length) {
      searchCount.textContent = t('pdf.searchNone');
      searchResults.append(emptyState(t('pdf.searchNoneHint')));
      return;
    }
    if (hitIndex < 0 || hitIndex >= hits.length) hitIndex = firstHitFrom(hits, viewer.currentPage);
    showHit(!keepIndex);
  }

  function resultRow(hit: Hit, index: number, text: string): HTMLElement {
    const row = button('', 'faisal-pdf-resultrow');
    row.dataset.hit = String(index);
    const s = snippet(text, hit.start, hit.end);
    const line = el('span', 'faisal-pdf-resulttext');
    line.dir = 'auto';
    line.append(document.createTextNode(s.before), el('mark', undefined, s.match), document.createTextNode(s.after));
    row.append(el('span', 'faisal-pdf-resultpage', t('pdf.pageN', { n: hit.page + 1 })), line);
    row.addEventListener('click', () => {
      hitIndex = index;
      showHit(true);
      if (state.narrow) setSide(false);
    });
    return row;
  }

  function showHit(reveal: boolean): void {
    viewer.setHits(hits, hitIndex);
    searchCount.textContent = hits.length ? t('pdf.searchCount', { n: hitIndex + 1, total: hits.length }) : '';
    for (const row of Array.from(searchResults.querySelectorAll('.faisal-pdf-resultrow'))) {
      row.classList.toggle('is-current', (row as HTMLElement).dataset.hit === String(hitIndex));
    }
    if (reveal && hits[hitIndex]) void viewer.revealHit(hits[hitIndex]);
  }

  function stepSearch(dir: 1 | -1): void {
    if (!hits.length) { if (searchInput.value.trim()) void runSearch(searchInput.value, false); return; }
    hitIndex = stepHit(hits.length, hitIndex, dir);
    showHit(true);
  }

  function openSearch(): void {
    setSidePanel('search');
    setSide(true);
    queueMicrotask(() => { searchInput.focus(); searchInput.select(); });
  }

  function emptyState(text: string): HTMLElement {
    const box = el('div', 'faisal-pdf-empty');
    box.append(emptyArt(), el('p', 'faisal-pdf-p is-muted', text));
    return box;
  }

  const SIDE_PANELS: { id: typeof state.sidePanel; icon: IconName; label: string; body: HTMLElement }[] = [
    { id: 'thumbs', icon: 'thumbs', label: t('pdf.sideThumbs'), body: thumbs.root },
    { id: 'outline', icon: 'bookmark', label: t('pdf.sideOutline'), body: outlineBox },
    { id: 'comments', icon: 'comments', label: t('pdf.sideComments'), body: commentsBox },
    { id: 'search', icon: 'search', label: t('pdf.search'), body: searchBox },
  ];
  const railButtons = new Map<string, HTMLButtonElement>();
  for (const panel of SIDE_PANELS) {
    const b = iconButton(panel.icon, panel.label, 'faisal-pdf-railbtn');
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => {
      if (state.sidePanel === panel.id && state.sideOpen && !state.narrow) setSide(false);
      else { setSidePanel(panel.id); setSide(true); }
    });
    railButtons.set(panel.id, b);
    rail.append(b);
  }

  function setSidePanel(id: typeof state.sidePanel): void {
    state.sidePanel = id;
    const panel = SIDE_PANELS.find((p) => p.id === id) ?? SIDE_PANELS[0];
    sideTitle.textContent = panel.label;
    sideBody.textContent = '';
    sideBody.append(panel.body);
    multiToggle.hidden = id !== 'thumbs';
    for (const [key, b] of railButtons) {
      b.setAttribute('aria-selected', String(key === id && state.sideOpen));
      b.classList.toggle('is-active', key === id && state.sideOpen);
    }
    if (id === 'thumbs') thumbs.reveal(viewer.currentPage);
  }

  function setSide(open: boolean): void {
    state.sideOpen = open;
    root.classList.toggle('is-side-open', open);
    sideToggle.setAttribute('aria-pressed', String(open));
    setSidePanel(state.sidePanel);
    syncScrim();
    if (open && state.narrow) {
      releaseSideEsc?.();
      releaseSideEsc = pushEscapeLayer(() => setSide(false));
    } else {
      releaseSideEsc?.();
      releaseSideEsc = null;
    }
  }
  let releaseSideEsc: (() => void) | null = null;
  sideToggle.addEventListener('click', () => setSide(!state.sideOpen));

  /* ───────────────────────────── task pane ───────────────────────────── */

  const paneHead = el('div', 'faisal-pdf-panelhead');
  const paneGrab = el('div', 'faisal-pdf-grab');
  paneGrab.setAttribute('aria-hidden', 'true');
  const paneTitle = el('h2', 'faisal-pdf-paneltitle');
  const paneClose = iconButton('close', t('pdf.close'));
  paneClose.addEventListener('click', () => setPane(false));
  paneHead.append(paneTitle, paneClose);
  const paneBody = el('div', 'faisal-pdf-panebody');
  const opsIntro = el('h2', 'faisal-pdf-h2 faisal-pdf-sr', t('pdf.opsTitle'));
  const limitsBox = limitsCard();
  const allCards: HTMLElement[] = [
    infoCard.box, pagesCard.box,
    textCard.box, signCard.box, coverCard.box, pageopsCard.box, formCard.box,
    deleteCard.box, rotateCard.box, cropCard.box, markCard.box, metaCard.box, splitCard.box,
    mergeCard.box, imageCard.box, saveCard.box, securityCard.box, limitsBox,
  ];
  paneBody.append(opsIntro, ...allCards);
  ops.append(paneGrab, paneHead, paneBody);

  const TASKS: Record<string, { title: string; cards: HTMLElement[] }> = {
    pages: { title: 'pdf.taskPages', cards: [pagesCard.box, rotateCard.box, deleteCard.box, pageopsCard.box, cropCard.box, splitCard.box] },
    merge: { title: 'pdf.mergeTitle', cards: [mergeCard.box] },
    images: { title: 'pdf.imagesTitle', cards: [imageCard.box] },
    text: { title: 'pdf.textTitle', cards: [textCard.box] },
    sign: { title: 'pdf.signTitle', cards: [signCard.box] },
    cover: { title: 'pdf.coverTitle', cards: [coverCard.box] },
    form: { title: 'pdf.formTitle', cards: [formCard.box] },
    watermark: { title: 'pdf.watermarkTitle', cards: [markCard.box] },
    properties: { title: 'pdf.propertiesTitle', cards: [infoCard.box, metaCard.box] },
    save: { title: 'pdf.saveTitle', cards: [saveCard.box] },
    security: { title: 'pdf.securityTitle', cards: [securityCard.box] },
    limits: { title: 'pdf.limitsTitle', cards: [limitsBox] },
  };

  function showTask(task: string): void {
    const def = TASKS[task];
    if (!def) return;
    state.task = task;
    paneTitle.textContent = t(def.title);
    for (const c of allCards) c.hidden = !def.cards.includes(c);
    paneBody.scrollTop = 0;
    setPane(true);
    if (task === 'security') void refreshSecurity();
  }

  let releasePaneEsc: (() => void) | null = null;
  function setPane(open: boolean): void {
    state.paneOpen = open;
    root.classList.toggle('is-pane-open', open);
    syncScrim();
    releasePaneEsc?.();
    releasePaneEsc = open ? pushEscapeLayer(() => setPane(false)) : null;
  }
  for (const c of allCards) c.hidden = true;

  function syncScrim(): void {
    scrim.classList.toggle('is-on', state.narrow && (state.paneOpen || state.sideOpen));
  }
  scrim.addEventListener('click', () => { setSide(false); setPane(false); });

  /* ───────────────────────────── ribbon ───────────────────────────── */

  interface Cmd {
    id: string;
    icon: IconName;
    label: string;
    run: (anchor: HTMLElement) => void;
    tool?: ToolId;
    needsDoc?: boolean;
    edits?: boolean;
    hidden?: boolean;
    disabled?: boolean;
  }

  const cmd = (id: string, iconName: IconName, labelKey: string, run: (anchor: HTMLElement) => void, extra: Partial<Cmd> = {}): Cmd =>
    ({ id, icon: iconName, label: t(labelKey), run, needsDoc: true, edits: false, ...extra });
  const toolCmd = (tool: ToolId, iconName: IconName, labelKey: string, edits = true): Cmd =>
    cmd(`tool-${tool}`, iconName, labelKey, () => setTool(state.tool === tool && tool !== 'select' ? 'select' : tool), { tool, edits });

  const zoomGroup = (): { label: string; cmds: Cmd[] } => ({
    label: t('pdf.groupZoom'),
    cmds: [
      cmd('zoom-out', 'zoomOut', 'pdf.zoomOut', () => zoomStep(-1)),
      cmd('zoom-in', 'zoomIn', 'pdf.zoomIn', () => zoomStep(1)),
      cmd('fit-width', 'fitWidth', 'pdf.fitWidth', () => viewer.setMode('fitWidth')),
      cmd('fit-page', 'fitPage', 'pdf.fitPage', () => viewer.setMode('fitPage')),
    ],
  });

  const TABS: { id: string; label: string; groups: { label: string; cmds: Cmd[] }[] }[] = [
    {
      id: 'home', label: t('pdf.tabHome'), groups: [
        {
          label: t('pdf.groupFile'), cmds: [
            cmd('open', 'open', 'pdf.openCmd', () => { void openFromFiles(); }, { needsDoc: false }),
            cmd('save', 'save', 'pdf.save', () => { void runSave(false); }, { edits: true }),
            cmd('download', 'download', 'pdf.download', () => downloadResult()),
            cmd('print', 'print', 'pdf.print', () => printResult()),
            cmd('open-tab', 'external', 'pdf.openInTab', () => openInTab(), { hidden: nativeWeb() !== null }),
          ],
        },
        { label: t('pdf.groupTools'), cmds: [toolCmd('hand', 'hand', 'pdf.toolHand', false), toolCmd('select', 'select', 'pdf.toolSelect', false)] },
        zoomGroup(),
        {
          label: t('pdf.groupQuick'), cmds: [
            cmd('highlight', 'highlight', 'pdf.toolHighlight', (a) => markupCommand('highlight', a), { tool: 'highlight', edits: true }),
            toolCmd('note', 'note', 'pdf.toolNote'),
            toolCmd('text', 'text', 'pdf.toolText'),
            cmd('sign-draw', 'signature', 'pdf.signDraw', () => { void startSignature(); }, { edits: true }),
          ],
        },
      ],
    },
    {
      id: 'comment', label: t('pdf.tabComment'), groups: [
        {
          label: t('pdf.groupMarkup'), cmds: [
            cmd('highlight2', 'highlight', 'pdf.toolHighlight', (a) => markupCommand('highlight', a), { tool: 'highlight', edits: true }),
            cmd('underline', 'underline', 'pdf.toolUnderline', (a) => markupCommand('underline', a), { tool: 'underline', edits: true }),
            cmd('strikeout', 'strike', 'pdf.toolStrikeout', (a) => markupCommand('strikeout', a), { tool: 'strikeout', edits: true }),
          ],
        },
        { label: t('pdf.groupNotes'), cmds: [toolCmd('note', 'note', 'pdf.toolNote'), toolCmd('textbox', 'textbox', 'pdf.toolTextbox'), cmd('stamp', 'stamp', 'pdf.toolStamp', (a) => chooseStamp(a), { tool: 'stamp', edits: true })] },
        { label: t('pdf.groupDraw'), cmds: [toolCmd('pen', 'pen', 'pdf.toolPen'), toolCmd('rect', 'rect', 'pdf.toolRect'), toolCmd('ellipse', 'ellipse', 'pdf.toolEllipse'), toolCmd('line', 'line', 'pdf.toolLine'), toolCmd('arrow', 'arrow', 'pdf.toolArrow')] },
        { label: t('pdf.groupStyle'), cmds: [cmd('style', 'palette', 'pdf.styleCmd', (a) => openStylePopover(a))] },
        { label: t('pdf.groupManage'), cmds: [cmd('comments', 'comments', 'pdf.sideComments', () => { setSidePanel('comments'); setSide(true); })] },
      ],
    },
    {
      id: 'edit', label: t('pdf.tabEditRibbon'), groups: [
        { label: t('pdf.groupAdd'), cmds: [toolCmd('text', 'text', 'pdf.toolText'), cmd('picture', 'images', 'pdf.toolImage', () => { void startPicture(); }, { edits: true }), toolCmd('cover', 'cover', 'pdf.toolCover')] },
        { label: t('pdf.groupMarks'), cmds: [cmd('watermark', 'watermark', 'pdf.watermarkCmd', () => showTask('watermark'), { edits: true }), cmd('page-numbers', 'pages', 'pdf.pageNumbersCmd', () => { void applyOp(() => writer.addPageNumbers(state.bytes, {}), t('pdf.pageNumbersDone')); }, { edits: true })] },
        { label: t('pdf.groupDocument'), cmds: [cmd('properties', 'info', 'pdf.propertiesTitle', () => showTask('properties')), cmd('text-card', 'form', 'pdf.advancedText', () => showTask('text'), { edits: true })] },
      ],
    },
    {
      id: 'organize', label: t('pdf.tabOrganize'), groups: [
        {
          label: t('pdf.groupInsert'), cmds: [
            cmd('blank', 'blank', 'pdf.blankCmd', () => insertBlank(viewer.currentPage + 1), { edits: true }),
            cmd('merge', 'merge', 'pdf.mergeCmd', () => showTask('merge'), { edits: true }),
            cmd('images', 'images', 'pdf.imagesCmd', () => showTask('images'), { edits: true }),
          ],
        },
        {
          label: t('pdf.groupPages'), cmds: [
            cmd('rot-left', 'rotateLeft', 'pdf.rotateLeft', () => rotateTargets(-90), { edits: true }),
            cmd('rot-right', 'rotateRight', 'pdf.rotateRight', () => rotateTargets(90), { edits: true }),
            cmd('delete', 'trash', 'pdf.deleteCmd', () => { void deleteTargets(); }, { edits: true }),
            cmd('duplicate', 'duplicate', 'pdf.duplicateCmd', () => { const n = targetPages().length; void applyOp(() => duplicatePages(state.bytes, targetPages()), t('pdf.duplicateDone', { n })); }, { edits: true }),
            cmd('extract', 'extract', 'pdf.extractCmd', () => { void extractSelection(); }),
            cmd('crop', 'crop', 'pdf.cropCmd', () => showTask('pages'), { edits: true }),
          ],
        },
        { label: t('pdf.groupManage'), cmds: [cmd('pages', 'pages', 'pdf.taskPages', () => showTask('pages')), cmd('split', 'extract', 'pdf.splitCmd', () => showTask('pages'))] },
      ],
    },
    {
      id: 'forms', label: t('pdf.tabForms'), groups: [
        {
          label: t('pdf.groupFill'), cmds: [
            cmd('fields-write', 'check', 'pdf.fieldsWrite', () => { void flushFields(); }, { edits: true }),
            cmd('fields-list', 'form', 'pdf.formListCmd', () => showTask('form'), { edits: true }),
            cmd('fields-reset', 'undo', 'pdf.fieldsDiscard', () => { state.pendingFields.clear(); fieldsHint.hidden = true; refreshHeader(); void refreshView(true); }),
          ],
        },
        { label: t('pdf.groupAdd'), cmds: [toolCmd('text', 'text', 'pdf.toolText')] },
      ],
    },
    {
      id: 'protect', label: t('pdf.tabProtect'), groups: [
        { label: t('pdf.groupSign'), cmds: [cmd('sign-draw2', 'signature', 'pdf.signDraw', () => { void startSignature(); }, { edits: true }), cmd('sign-card', 'text', 'pdf.signTyped', () => showTask('sign'), { edits: true })] },
        { label: t('pdf.groupHide'), cmds: [toolCmd('cover', 'cover', 'pdf.toolCover')] },
        { label: t('pdf.groupSecurity'), cmds: [cmd('security', 'lock', 'pdf.securityCmd', () => showTask('security'))] },
      ],
    },
    {
      id: 'view', label: t('pdf.tabViewRibbon'), groups: [
        { ...zoomGroup(), cmds: [...zoomGroup().cmds, cmd('actual', 'actual', 'pdf.actualSize', () => viewer.setZoom(1))] },
        { label: t('pdf.groupRotateView'), cmds: [cmd('view-left', 'rotateLeft', 'pdf.viewRotateLeft', () => viewer.rotateView(-90)), cmd('view-right', 'rotateRight', 'pdf.viewRotateRight', () => viewer.rotateView(90))] },
        {
          label: t('pdf.groupPanels'), cmds: [
            cmd('panel-thumbs', 'thumbs', 'pdf.sideThumbs', () => { setSidePanel('thumbs'); setSide(true); }),
            cmd('panel-outline', 'bookmark', 'pdf.sideOutline', () => { setSidePanel('outline'); setSide(true); }),
            cmd('panel-search', 'search', 'pdf.search', () => openSearch()),
          ],
        },
        { label: t('pdf.groupReading'), cmds: [cmd('night', 'moon', 'pdf.nightMode', () => toggleNight()), cmd('keys', 'keyboard', 'pdf.shortcutsTitle', () => showShortcuts(), { needsDoc: false })] },
      ],
    },
  ];

  const tabButtons = new Map<string, HTMLButtonElement>();
  const cmdButtons: { cmd: Cmd; b: HTMLButtonElement }[] = [];
  for (const tab of TABS) {
    const b = button(tab.label, 'faisal-pdf-tab');
    b.setAttribute('role', 'tab');
    b.id = `faisal-pdf-tab-${tab.id}`;
    b.addEventListener('click', () => setTab(tab.id));
    tabButtons.set(tab.id, b);
    tabs.append(b);
  }

  function makeCmdButton(c: Cmd): HTMLButtonElement {
    const b = el('button', 'faisal-pdf-rbtn');
    b.type = 'button';
    b.dataset.cmd = c.id;
    b.append(icon(c.icon), el('span', 'faisal-pdf-rbtn-label', c.label));
    b.title = c.label;
    if (c.tool) b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => c.run(b));
    cmdButtons.push({ cmd: c, b });
    return b;
  }

  function setTab(id: string): void {
    state.tab = id;
    const tab = TABS.find((x) => x.id === id) ?? TABS[0];
    for (const [key, b] of tabButtons) {
      b.setAttribute('aria-selected', String(key === tab.id));
      b.tabIndex = key === tab.id ? 0 : -1;
    }
    ribbon.textContent = '';
    for (let i = cmdButtons.length - 1; i >= 0; i--) if (!cmdButtons[i].b.isConnected || true) cmdButtons.splice(i, 1);
    for (const group of tab.groups) {
      const g = el('div', 'faisal-pdf-group');
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', group.label);
      const row = el('div', 'faisal-pdf-groupcmds');
      for (const c of group.cmds) if (!c.hidden) row.append(makeCmdButton(c));
      g.append(row, el('div', 'faisal-pdf-grouplabel', group.label));
      ribbon.append(g);
    }
    const more = iconButton('more', t('pdf.more'), 'faisal-pdf-rbtn faisal-pdf-morebtn', true);
    more.addEventListener('click', () => openMoreSheet());
    ribbon.append(more);
    refreshCommands();
  }

  tabs.addEventListener('keydown', (ev) => {
    const ids = TABS.map((x) => x.id);
    const at = ids.indexOf(state.tab);
    const rtl = root.dir === 'rtl';
    let next = -1;
    if (ev.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = (at + 1) % ids.length;
    else if (ev.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = (at - 1 + ids.length) % ids.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = ids.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    setTab(ids[next]);
    tabButtons.get(ids[next])?.focus();
  });

  function refreshCommands(): void {
    const hasDoc = Boolean(state.info);
    for (const { cmd: c, b } of cmdButtons) {
      b.disabled = Boolean((c.needsDoc && !hasDoc) || (c.edits && state.readOnly) || c.disabled);
      if (c.tool) {
        const on = state.tool === c.tool;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('is-active', on);
      }
    }
    for (const b of [printQuick, downloadQuick, searchBtn]) b.disabled = !hasDoc;
    saveMain.disabled = !hasDoc || state.readOnly;
    refreshHeader();
  }

  /** The phone's "More" sheet: every command of every tab, grouped, with its label. */
  function openMoreSheet(): void {
    const m = openModal({ title: t('pdf.more'), wide: true });
    m.dialog.classList.add('is-sheet');
    for (const tab of TABS) {
      const section = el('section', 'faisal-pdf-sheetsection');
      section.append(el('h4', 'faisal-pdf-sheethead', tab.label));
      const grid = el('div', 'faisal-pdf-sheetgrid');
      for (const group of tab.groups) {
        for (const c of group.cmds) {
          if (c.hidden) continue;
          const b = el('button', 'faisal-pdf-rbtn');
          b.type = 'button';
          b.append(icon(c.icon), el('span', 'faisal-pdf-rbtn-label', c.label));
          b.disabled = Boolean((c.needsDoc && !state.info) || (c.edits && state.readOnly));
          b.addEventListener('click', () => { m.close(); c.run(tabButtons.get(state.tab) ?? b); });
          grid.append(b);
        }
      }
      section.append(grid);
      m.body.append(section);
    }
    const close = dialogButton(t('pdf.close'));
    close.addEventListener('click', () => m.close());
    m.actions.append(close);
  }

  /* ───────────────────────────── status bar ───────────────────────────── */

  const nav = el('div', 'faisal-pdf-nav');
  const prevBtn = iconButton('chevronPrev', t('pdf.prevPage'), 'faisal-pdf-sbtn');
  const nextBtn = iconButton('chevronNext', t('pdf.nextPage'), 'faisal-pdf-sbtn');
  const pageInput = el('input', 'faisal-pdf-pagebox');
  pageInput.type = 'text';
  pageInput.inputMode = 'numeric';
  pageInput.dir = 'ltr';
  pageInput.setAttribute('aria-label', t('pdf.pageNumber'));
  const pageTotal = el('span', 'faisal-pdf-pagetotal');
  pageTotal.dir = 'ltr';
  const pageLabel = el('span', 'faisal-pdf-pagelabel');
  nav.append(prevBtn, pageInput, pageTotal, nextBtn, pageLabel);
  let pageLabels: string[] | null = null;

  const zoomBox = el('div', 'faisal-pdf-zoom');
  const zoomOutBtn = iconButton('zoomOut', t('pdf.zoomOut'), 'faisal-pdf-sbtn');
  const zoomInBtn = iconButton('zoomIn', t('pdf.zoomIn'), 'faisal-pdf-sbtn');
  const zoomSlider = el('input', 'faisal-pdf-slider');
  zoomSlider.type = 'range';
  zoomSlider.min = String(ZOOM_MIN * 100);
  zoomSlider.max = String(ZOOM_MAX * 100);
  zoomSlider.step = '5';
  zoomSlider.setAttribute('aria-label', t('pdf.zoomLevel'));
  const zoomValue = el('button', 'faisal-pdf-zoomvalue');
  zoomValue.type = 'button';
  zoomValue.dir = 'ltr';
  zoomValue.setAttribute('aria-haspopup', 'dialog');
  zoomValue.title = t('pdf.zoomLevel');
  zoomBox.append(zoomOutBtn, zoomSlider, zoomInBtn, zoomValue);
  statusbar.append(nav, status, zoomBox);

  prevBtn.addEventListener('click', () => viewer.goToPage(viewer.currentPage - 1));
  nextBtn.addEventListener('click', () => viewer.goToPage(viewer.currentPage + 1));
  pageInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    gotoTyped(pageInput.value);
  });
  pageInput.addEventListener('blur', () => refreshPageBox());
  pageInput.addEventListener('focus', () => pageInput.select());
  zoomOutBtn.addEventListener('click', () => zoomStep(-1));
  zoomInBtn.addEventListener('click', () => zoomStep(1));
  zoomSlider.addEventListener('input', () => viewer.setZoom(Number(zoomSlider.value) / 100));
  zoomValue.addEventListener('click', () => openZoomPopover(zoomValue));

  function gotoTyped(text: string): void {
    const digits = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).trim();
    let index = Number(digits) - 1;
    if (pageLabels) {
      const byLabel = pageLabels.indexOf(text.trim());
      if (byLabel >= 0 && !/^\d+$/.test(digits)) index = byLabel;
    }
    if (!Number.isInteger(index) || index < 0 || index >= viewer.pageCount) {
      setStatus(t('pdf.textErrorPage', { count: viewer.pageCount }), true);
      refreshPageBox();
      return;
    }
    viewer.goToPage(index);
    viewer.scroller.focus({ preventScroll: true });
  }

  function refreshPageBox(): void {
    const count = viewer.pageCount || state.info?.pageCount || 0;
    const page = Math.min(viewer.currentPage, Math.max(0, count - 1));
    if (document.activeElement !== pageInput) pageInput.value = count ? String(page + 1) : '';
    pageTotal.textContent = count ? `/ ${count}` : '';
    const label = pageLabels?.[page];
    pageLabel.textContent = label && label !== String(page + 1) ? t('pdf.pageLabel', { label }) : '';
    prevBtn.disabled = page <= 0;
    nextBtn.disabled = page >= count - 1;
  }

  async function refreshPageLabels(doc: PdfJsDocument): Promise<void> {
    try { pageLabels = await doc.getPageLabels(); } catch { pageLabels = null; }
    refreshPageBox();
  }

  let lastZoom = 1;
  function refreshZoomBox(): void {
    const pct = Math.round(viewer.zoom * 100);
    zoomSlider.value = String(pct);
    zoomSlider.style.setProperty('--fill', `${((pct - ZOOM_MIN * 100) / ((ZOOM_MAX - ZOOM_MIN) * 100)) * 100}%`);
    zoomSlider.setAttribute('aria-valuetext', `${pct}%`);
    zoomValue.textContent = `${pct}%`;
    zoomValue.setAttribute('aria-label', `${t('pdf.zoomLevel')}: ${pct}%`);
    zoomOutBtn.disabled = viewer.zoom <= ZOOM_MIN + 0.001;
    zoomInBtn.disabled = viewer.zoom >= ZOOM_MAX - 0.001;
    // A box being placed is in screen pixels: a real zoom change drops it, a redraw at the same zoom keeps it.
    if (Math.abs(viewer.zoom - lastZoom) > 0.0001) cancelPlacement();
    lastZoom = viewer.zoom;
  }

  function zoomStep(dir: 1 | -1): void {
    viewer.setZoom(nextZoom(viewer.zoom, dir));
  }

  function openZoomPopover(anchor: HTMLElement): void {
    const box = el('div', 'faisal-pdf-zoommenu');
    const input = el('input', 'faisal-pdf-input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.dir = 'ltr';
    input.value = `${Math.round(viewer.zoom * 100)}%`;
    input.setAttribute('aria-label', t('pdf.zoomLevel'));
    let close = (): void => {};
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const z = parseZoomInput(input.value);
      if (z !== null) { viewer.setZoom(z); close(); }
    });
    box.append(input);
    const items: [string, () => void][] = [
      [t('pdf.fitWidth'), () => viewer.setMode('fitWidth')],
      [t('pdf.fitPage'), () => viewer.setMode('fitPage')],
      [t('pdf.actualSize'), () => viewer.setZoom(1)],
      ['50%', () => viewer.setZoom(0.5)], ['100%', () => viewer.setZoom(1)], ['150%', () => viewer.setZoom(1.5)],
      ['200%', () => viewer.setZoom(2)], ['400%', () => viewer.setZoom(4)],
    ];
    for (const [label, run] of items) {
      const b = button(label, 'faisal-pdf-menuitem');
      b.addEventListener('click', () => { run(); close(); });
      box.append(b);
    }
    close = openPopoverAt(root, anchor, box, t('pdf.zoomLevel'));
  }

  function toggleNight(): void {
    state.night = !state.night;
    root.classList.toggle('is-night', state.night);
    setStatus(state.night ? t('pdf.nightOn') : t('pdf.nightOff'));
  }

  /* ───────────────────────────── tools ───────────────────────────── */

  function setTool(tool: ToolId): void {
    if (!state.info) return;
    if (tool !== 'select' && tool !== 'hand' && state.readOnly) { setStatus(t('pdf.readOnlyRefused'), true); return; }
    commitInk();
    cancelPlacement();
    state.tool = tool;
    root.dataset.tool = tool;
    refreshCommands();
    const hint = TOOL_HINT[tool];
    if (hint) setStatus(t(hint));
    if (state.narrow && tool !== 'select' && tool !== 'hand') setPane(false);
  }

  const TOOL_HINT: Partial<Record<ToolId, string>> = {
    hand: 'pdf.hintHand', select: 'pdf.hintSelect', highlight: 'pdf.hintMarkup', underline: 'pdf.hintMarkup',
    strikeout: 'pdf.hintMarkup', pen: 'pdf.hintPen', rect: 'pdf.hintShape', ellipse: 'pdf.hintShape',
    line: 'pdf.hintShape', arrow: 'pdf.hintShape', note: 'pdf.hintNote', textbox: 'pdf.hintTextbox',
    text: 'pdf.hintText', cover: 'pdf.hintCover', signature: 'pdf.hintPlace', image: 'pdf.hintPlace', stamp: 'pdf.hintPlace',
  };

  /** A markup button: with text already selected it marks it at once; otherwise it arms the tool. */
  function markupCommand(tool: ToolId, _anchor: HTMLElement): void {
    if (state.tool === tool && !viewer.selectionBoxes().length) { setTool('select'); return; }
    if (viewer.selectionBoxes().length) {
      setTool(tool);
      void commitMarkup(tool);
      return;
    }
    setTool(tool);
  }

  async function commitMarkup(tool: ToolId): Promise<void> {
    const groups = viewer.selectionBoxes();
    if (!groups.length) return;
    const s = style(tool);
    window.getSelection()?.removeAllRanges();
    for (const group of groups) {
      const quads = quadsFromBoxes(viewer.transform(group.page), group.boxes);
      if (!quads) continue;
      await commitAnnotation({
        page: group.page, kind: tool as writer.AnnotKind, color: s.color, opacity: s.opacity,
        quads: quads.quads, rect: quads.rect,
      });
    }
  }

  async function commitAnnotation(a: writer.NewAnnotation): Promise<boolean> {
    let opts: { arabicFont?: Uint8Array } | undefined;
    if (a.contents && writer.needsUnicodeFont(a.contents) && (a.kind === 'freetext' || a.kind === 'stamp')) {
      try { opts = { arabicFont: await getArabicFont() }; } catch { setStatus(t('pdf.fontUnavailable'), true); return false; }
    }
    return applyOp(() => writer.addAnnotation(state.bytes, a, opts), t('pdf.annotDone', { kind: kindLabel(a.kind) }), true);
  }

  // Pointer gestures on the pages.
  interface Gesture { page: number; start: Point; last: Point; points: Point[]; svg: SVGSVGElement; shape: SVGElement; pointer: number; moved: boolean }
  let gesture: Gesture | null = null;
  let hand: { x: number; y: number; left: number; top: number; pointer: number } | null = null;
  let ink: { page: number; strokes: Point[][]; svg: SVGSVGElement } | null = null;
  let inkTimer = 0;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgLayer(page: number): SVGSVGElement | null {
    const overlay = viewer.overlay(page);
    if (!overlay) return null;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'faisal-pdf-draft');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    overlay.append(svg);
    return svg;
  }

  viewer.frame.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    if ((ev.target as Element).closest('.faisal-pdf-place, .faisal-pdf-fieldinput, .faisal-pdf-fieldcheck, .faisal-pdf-link, .faisal-pdf-annothit')) return;
    if (state.tool === 'hand') {
      hand = { x: ev.clientX, y: ev.clientY, left: viewer.scroller.scrollLeft, top: viewer.scroller.scrollTop, pointer: ev.pointerId };
      viewer.frame.setPointerCapture(ev.pointerId);
      root.classList.add('is-grabbing');
      return;
    }
    if (!DRAW_TOOLS.has(state.tool) || viewer.pinching) return;
    const hit = viewer.pageAt(ev.clientX, ev.clientY);
    if (!hit) return;
    ev.preventDefault();
    if (ink && ink.page !== hit.page) commitInk();
    const svg = state.tool === 'pen' && ink ? ink.svg : svgLayer(hit.page);
    if (!svg) return;
    const s = style(state.tool);
    const tag = state.tool === 'ellipse' ? 'ellipse' : state.tool === 'pen' || state.tool === 'line' || state.tool === 'arrow' ? 'polyline' : 'rect';
    const shape = document.createElementNS(SVG_NS, tag);
    shape.setAttribute('fill', state.tool === 'cover' ? s.color : 'none');
    shape.setAttribute('stroke', state.tool === 'cover' ? 'var(--app-blue)' : s.color);
    shape.setAttribute('stroke-width', String(Math.max(1, s.width * viewer.zoom * CSS_UNITS)));
    shape.setAttribute('stroke-linecap', 'round');
    shape.setAttribute('stroke-linejoin', 'round');
    if (['text', 'textbox', 'note', 'signature', 'image', 'stamp'].includes(state.tool)) {
      shape.setAttribute('stroke', 'var(--app-blue)');
      shape.setAttribute('stroke-dasharray', '4 3');
    }
    svg.append(shape);
    const p = { x: hit.x, y: hit.y };
    gesture = { page: hit.page, start: p, last: p, points: [p], svg, shape, pointer: ev.pointerId, moved: false };
    viewer.frame.setPointerCapture(ev.pointerId);
  });

  viewer.frame.addEventListener('pointermove', (ev) => {
    if (hand && hand.pointer === ev.pointerId) {
      viewer.scroller.scrollLeft = hand.left - (ev.clientX - hand.x);
      viewer.scroller.scrollTop = hand.top - (ev.clientY - hand.y);
      return;
    }
    const g = gesture;
    if (!g || g.pointer !== ev.pointerId) return;
    const box = viewer.pageBox(g.page)?.getBoundingClientRect();
    if (!box) return;
    const p = { x: Math.min(Math.max(ev.clientX - box.left, 0), box.width), y: Math.min(Math.max(ev.clientY - box.top, 0), box.height) };
    if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > 4) g.moved = true;
    g.last = p;
    if (state.tool === 'pen') {
      g.points.push(p);
      g.shape.setAttribute('points', g.points.map((q) => `${q.x},${q.y}`).join(' '));
      return;
    }
    if (state.tool === 'line' || state.tool === 'arrow') {
      g.shape.setAttribute('points', `${g.start.x},${g.start.y} ${p.x},${p.y}`);
      return;
    }
    const x = Math.min(g.start.x, p.x);
    const y = Math.min(g.start.y, p.y);
    const w = Math.abs(p.x - g.start.x);
    const h = Math.abs(p.y - g.start.y);
    if (state.tool === 'ellipse') {
      g.shape.setAttribute('cx', String(x + w / 2)); g.shape.setAttribute('cy', String(y + h / 2));
      g.shape.setAttribute('rx', String(w / 2)); g.shape.setAttribute('ry', String(h / 2));
    } else {
      g.shape.setAttribute('x', String(x)); g.shape.setAttribute('y', String(y));
      g.shape.setAttribute('width', String(w)); g.shape.setAttribute('height', String(h));
    }
  });

  const endGesture = (ev: PointerEvent, cancelled: boolean): void => {
    if (hand && hand.pointer === ev.pointerId) { hand = null; root.classList.remove('is-grabbing'); return; }
    const g = gesture;
    if (!g || g.pointer !== ev.pointerId) return;
    gesture = null;
    if (cancelled) { if (state.tool !== 'pen') g.svg.remove(); else g.shape.remove(); return; }
    void finishGesture(g);
  };
  viewer.frame.addEventListener('pointerup', (ev) => endGesture(ev, false));
  viewer.frame.addEventListener('pointercancel', (ev) => endGesture(ev, true));

  // Text markup follows a finished selection while a markup tool is armed.
  viewer.frame.addEventListener('pointerup', () => {
    if (!MARKUP_TOOLS.has(state.tool)) return;
    setTimeout(() => { if (viewer.selectionBoxes().length) void commitMarkup(state.tool); }, 0);
  });

  function boxFromGesture(g: Gesture, fallback: { width: number; height: number }): Box {
    if (!g.moved) {
      return { x: g.start.x, y: g.start.y, width: fallback.width, height: fallback.height };
    }
    return {
      x: Math.min(g.start.x, g.last.x), y: Math.min(g.start.y, g.last.y),
      width: Math.abs(g.last.x - g.start.x), height: Math.abs(g.last.y - g.start.y),
    };
  }

  async function finishGesture(g: Gesture): Promise<void> {
    const tool = state.tool;
    const t6 = viewer.transform(g.page);
    const s = style(tool);
    const pageBox = viewer.pageBox(g.page);
    const pw = pageBox?.clientWidth ?? 0;
    const ph = pageBox?.clientHeight ?? 0;
    const px = viewer.zoom * CSS_UNITS;
    if (tool === 'pen') {
      if (g.points.length < 2) { g.shape.remove(); return; }
      ink ??= { page: g.page, strokes: [], svg: g.svg };
      ink.strokes.push(g.points);
      window.clearTimeout(inkTimer);
      inkTimer = window.setTimeout(commitInk, 1200);
      return;
    }
    if (tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow') {
      g.svg.remove();
      if (!g.moved) return;
      if (tool === 'line' || tool === 'arrow') {
        const a = toPdf(t6, g.start.x, g.start.y);
        const b = toPdf(t6, g.last.x, g.last.y);
        const pad = s.width * 4 + 4;
        await commitAnnotation({
          page: g.page, kind: tool, color: s.color, opacity: s.opacity, width: s.width,
          line: [a.x, a.y, b.x, b.y],
          rect: { x: Math.min(a.x, b.x) - pad, y: Math.min(a.y, b.y) - pad, width: Math.abs(a.x - b.x) + 2 * pad, height: Math.abs(a.y - b.y) + 2 * pad },
        });
        return;
      }
      const rect = boxToPdf(t6, g.start, g.last);
      await commitAnnotation({ page: g.page, kind: tool === 'rect' ? 'square' : 'circle', color: s.color, opacity: s.opacity, width: s.width, fill: null, rect });
      return;
    }
    g.svg.remove();
    if (tool === 'note') {
      const text = await askText(t('pdf.toolNote'), t('pdf.noteLabel'), '', true);
      if (text === null) return;
      const at = toPdf(t6, g.start.x, g.start.y);
      await commitAnnotation({ page: g.page, kind: 'note', color: s.color, opacity: 1, contents: text, rect: { x: at.x, y: at.y - 20, width: 20, height: 20 } });
      return;
    }
    if (tool === 'cover') {
      const box = clampBox(boxFromGesture(g, { width: 180, height: 44 }), pw, ph);
      const fill = el('div', 'faisal-pdf-placefill');
      fill.style.background = s.color;
      placeBox(g.page, box, fill, false, async (b) => {
        const rect = boxToPdf(t6, { x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height });
        const shape: CoverShape = coverShapes.ellipse.checked ? 'ellipse' : 'rect';
        const size = state.info?.pages[g.page];
        const fit = size ? coverRectFor(rect, size) : { ok: false as const, error: 'outside' as const };
        if (!fit.ok) { setStatus(t('pdf.coverErrorOutside'), true); return false; }
        return applyOp(() => coverRegion(state.bytes, { page: g.page, shape, ...fit.rect, color: s.color }), t('pdf.coverDone', { n: g.page + 1 }), true);
      });
      return;
    }
    if (tool === 'text' || tool === 'textbox') {
      const fontPx = (tool === 'text' ? s.size : s.size) * px;
      const box = clampBox(boxFromGesture(g, { width: Math.min(pw - g.start.x, 260), height: fontPx * 1.6 + 8 }), pw, ph, 24);
      const area = el('textarea', 'faisal-pdf-placetext');
      area.dir = 'auto';
      area.rows = 1;
      area.placeholder = t('pdf.typeHere');
      area.setAttribute('aria-label', t('pdf.typeHere'));
      area.style.fontSize = `${fontPx}px`;
      area.style.color = s.color;
      placeBox(g.page, box, area, false, async (b) => {
        const text = area.value.replace(/\s+$/g, '');
        if (!text.trim()) { setStatus(t('pdf.textErrorText'), true); return false; }
        const sizePt = s.size * (b.height / box.height);
        const tl = toPdf(t6, b.x + 4, b.y + 4);
        if (tool === 'textbox') {
          const rect = boxToPdf(t6, { x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height });
          return commitAnnotation({ page: g.page, kind: 'freetext', color: s.color, opacity: s.opacity, contents: text, fontSize: sizePt, rect });
        }
        return addPlacedText(g.page, text, tl.x, tl.y - sizePt * 0.9, sizePt, s.color);
      }, (b, old) => { area.style.fontSize = `${fontPx * (b.height / old.height)}px`; });
      queueMicrotask(() => area.focus());
      return;
    }
    if (tool === 'signature' || tool === 'image') {
      const pic = tool === 'signature' ? state.signature : state.picture;
      if (!pic) { if (tool === 'signature') void startSignature(); else void startPicture(); return; }
      const width = Math.min(pw * 0.4, 220);
      const box = clampBox({ x: g.start.x, y: g.start.y, width, height: width / pic.aspect }, pw, ph);
      const img = el('img', 'faisal-pdf-placeimg');
      img.src = pic.url;
      img.alt = '';
      placeBox(g.page, box, img, true, async (b) => {
        const rect = boxToPdf(t6, { x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height });
        const size = state.info?.pages[g.page];
        const fit = size ? coverRectFor(rect, size) : { ok: false as const, error: 'outside' as const };
        if (!fit.ok) { setStatus(t('pdf.signImageErrorRect'), true); return false; }
        const sig = state.signature;
        if (tool === 'signature' && sig && writer.ENGINE_READY) {
          const input = { page: g.page, rect: fit.rect, strokes: sig.strokes, padWidth: sig.pad.width, padHeight: sig.pad.height, color: sig.color, width: 2.6 };
          return applyOp(() => writer.drawnSignature(state.bytes, input), t('pdf.signPlaced', { n: g.page + 1 }), true);
        }
        const input: SignatureImageInput = { page: g.page, ...fit.rect, image: { name: tool === 'signature' ? 'signature.png' : (state.picture?.name ?? 'image'), bytes: pic.bytes } };
        return applyOp(() => addImageSignature(state.bytes, input), t(tool === 'signature' ? 'pdf.signPlaced' : 'pdf.imagePlaced', { n: g.page + 1 }), true);
      });
      return;
    }
    if (tool === 'stamp') {
      if (!state.stamp) { setStatus(t('pdf.stampChoose'), true); return; }
      const box = clampBox({ x: g.start.x, y: g.start.y, width: 170 * px / CSS_UNITS, height: 48 * px / CSS_UNITS }, pw, ph);
      const preview = el('div', 'faisal-pdf-placestamp', state.stamp);
      preview.style.color = s.color;
      preview.style.borderColor = s.color;
      placeBox(g.page, box, preview, false, async (b) => {
        const rect = boxToPdf(t6, { x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height });
        return commitAnnotation({ page: g.page, kind: 'stamp', color: s.color, opacity: 1, contents: state.stamp, rect });
      });
    }
  }

  /** Added text: Latin lines through pdf-lib's standard font, anything else through the engine. */
  async function addPlacedText(page: number, text: string, x: number, y: number, size: number, color: string): Promise<boolean> {
    const clampedX = Math.max(0, x);
    const clampedY = Math.max(0, y);
    if (writer.needsUnicodeFont(text)) return addUnicode({ page, text, x: clampedX, y: clampedY, size, color });
    const lines = text.split('\n');
    const font = textFont.value as TextFont;
    return applyOp(async () => {
      let bytes = state.bytes;
      let last: OpResult | null = null;
      for (const [i, line] of lines.entries()) {
        if (!line.trim()) continue;
        const input = { page, text: line, size, x: clampedX, y: Math.max(0, clampedY - i * size * 1.25), font, color };
        const check = checkAddedText(input, state.info?.pages[page]);
        if (!check.ok) return { ok: false, code: check.error === 'unsupportedChars' ? 'textNotRenderable' : 'unknown', detail: addedTextMessage(check) } as OpResult;
        last = await addText(bytes, input);
        if (!last.ok) return last;
        bytes = last.bytes;
      }
      return last ?? { ok: false, code: 'unknown', detail: t('pdf.textErrorText') } as OpResult;
    }, t('pdf.textDone', { n: page + 1 }), true);
  }

  function commitInk(): void {
    window.clearTimeout(inkTimer);
    const pending = ink;
    ink = null;
    if (!pending) return;
    pending.svg.remove();
    const t6 = viewer.transform(pending.page);
    const s = style('pen');
    const paths = pending.strokes.map((stroke) => stroke.map((p) => toPdf(t6, p.x, p.y)));
    const bounds = strokesBounds(paths, s.width * 2 + 2);
    if (!bounds) return;
    void commitAnnotation({ page: pending.page, kind: 'ink', color: s.color, opacity: s.opacity, width: s.width, paths, rect: bounds });
  }

  /* placement box: drag to move, corners to resize, ✓ to apply */
  let placement: { el: HTMLElement; release: () => void } | null = null;

  function cancelPlacement(): void {
    const p = placement;
    placement = null;
    if (!p) return;
    p.el.remove();
    p.release();
  }

  function placeBox(page: number, initial: Box, content: HTMLElement, keepAspect: boolean, apply: (box: Box) => Promise<boolean>, onResize?: (box: Box, old: Box) => void): void {
    cancelPlacement();
    const overlay = viewer.overlay(page);
    const pageEl = viewer.pageBox(page);
    if (!overlay || !pageEl) return;
    const pw = pageEl.clientWidth;
    const ph = pageEl.clientHeight;
    let box = { ...initial };
    const wrap = el('div', 'faisal-pdf-place');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', t('pdf.placeLabel'));
    const frameEl = el('div', 'faisal-pdf-placeframe');
    frameEl.append(content);
    const handles = (['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
      const h = el('div', `faisal-pdf-handle is-${corner}`);
      h.dataset.corner = corner;
      h.setAttribute('aria-hidden', 'true');
      return h;
    });
    const bar2 = el('div', 'faisal-pdf-placebar');
    const ok = iconButton('check', `${t('pdf.apply')} (Enter)`, 'faisal-pdf-ibtn is-primary');
    const no = iconButton('close', `${t('pdf.cancel')} (Esc)`, 'faisal-pdf-ibtn');
    bar2.append(no, ok);
    wrap.append(frameEl, ...handles, bar2);
    overlay.append(wrap);
    const paint = (): void => {
      wrap.style.left = `${box.x}px`;
      wrap.style.top = `${box.y}px`;
      wrap.style.width = `${box.width}px`;
      wrap.style.height = `${box.height}px`;
      wrap.classList.toggle('bar-below', box.y < 56);
    };
    paint();
    let drag: { mode: string; x: number; y: number; start: Box; pointer: number } | null = null;
    wrap.addEventListener('pointerdown', (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest('.faisal-pdf-placebar')) return;
      const corner = target.dataset.corner;
      if (!corner && target.closest('textarea') && document.activeElement === target) return;
      ev.preventDefault();
      ev.stopPropagation();
      drag = { mode: corner ?? 'move', x: ev.clientX, y: ev.clientY, start: { ...box }, pointer: ev.pointerId };
      wrap.setPointerCapture(ev.pointerId);
    });
    wrap.addEventListener('pointermove', (ev) => {
      if (!drag || drag.pointer !== ev.pointerId) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      const s0 = drag.start;
      let next: Box;
      if (drag.mode === 'move') next = { ...s0, x: s0.x + dx, y: s0.y + dy };
      else {
        const west = drag.mode.includes('w');
        const north = drag.mode.includes('n');
        let w = Math.max(16, s0.width + (west ? -dx : dx));
        let h = Math.max(16, s0.height + (north ? -dy : dy));
        if (keepAspect) h = w * (s0.height / s0.width);
        if (keepAspect && h < 16) { h = 16; w = h * (s0.width / s0.height); }
        next = { x: west ? s0.x + s0.width - w : s0.x, y: north ? s0.y + s0.height - h : s0.y, width: w, height: h };
      }
      const old = box;
      box = clampBox(next, pw, ph, 16);
      if (drag.mode !== 'move') onResize?.(box, old === box ? s0 : initial);
      paint();
    });
    const endDrag = (ev: PointerEvent): void => { if (drag?.pointer === ev.pointerId) drag = null; };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);
    const doApply = async (): Promise<void> => {
      ok.disabled = true;
      const done = await apply(box);
      if (done) cancelPlacement(); else ok.disabled = false;
    };
    ok.addEventListener('click', () => { void doApply(); });
    no.addEventListener('click', () => cancelPlacement());
    wrap.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !(ev.target instanceof HTMLTextAreaElement && !ev.ctrlKey)) { ev.preventDefault(); void doApply(); }
    });
    placement = { el: wrap, release: pushEscapeLayer(() => cancelPlacement()) };
  }

  /* dialogs: text, drawn signature, stamps, style */

  function askText(title: string, label: string, initial: string, multiline: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      let result: string | null = null;
      const m = openModal({ title, onClose: () => resolve(result) });
      const input = multiline ? el('textarea', 'faisal-pdf-input faisal-pdf-textarea') : textInput('faisal-pdf-ask');
      input.id = 'faisal-pdf-ask';
      input.dir = 'auto';
      input.value = initial;
      m.body.append(field('faisal-pdf-ask', label, input));
      m.body.querySelector('label')!.textContent = label;
      const cancel = dialogButton(t('pdf.cancel'));
      const ok = dialogButton(t('pdf.apply'), 'primary');
      cancel.addEventListener('click', () => m.close());
      ok.addEventListener('click', () => { result = input.value; m.close(); });
      input.addEventListener('keydown', (e) => {
        const ev = e as KeyboardEvent;
        if (ev.key === 'Enter' && (!multiline || ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); result = input.value; m.close(); }
      });
      m.actions.append(cancel, ok);
    });
  }

  /** The signature pad: draw with a finger, a pen or the mouse; the result is placed by dragging. */
  function startSignature(): Promise<void> {
    if (!state.info) return Promise.resolve();
    return new Promise((resolve) => {
      const m = openModal({ title: t('pdf.signDraw'), wide: true, onClose: () => resolve() });
      const pad = el('canvas', 'faisal-pdf-sigpad');
      pad.setAttribute('aria-label', t('pdf.signPadLabel'));
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const W = 560;
      const H = 200;
      pad.width = W * ratio;
      pad.height = H * ratio;
      const g2 = pad.getContext('2d');
      const colorRow = el('div', 'faisal-pdf-sigcolors');
      let penColor = styles.signature.color;
      for (const c of ['#12294F', '#1A1D26', '#1F4FD1', '#B3261E']) {
        const sw = el('button', 'faisal-pdf-swatch');
        sw.type = 'button';
        sw.style.background = c;
        sw.setAttribute('aria-label', c);
        sw.setAttribute('aria-pressed', String(c === penColor));
        sw.addEventListener('click', () => {
          penColor = c;
          for (const other of Array.from(colorRow.children)) other.setAttribute('aria-pressed', String(other === sw));
          redraw();
        });
        colorRow.append(sw);
      }
      const strokes: Point[][] = [];
      let current: Point[] | null = null;
      const redraw = (): void => {
        if (!g2) return;
        g2.setTransform(ratio, 0, 0, ratio, 0, 0);
        g2.clearRect(0, 0, W, H);
        g2.strokeStyle = 'rgba(128,128,128,.35)';
        g2.lineWidth = 1;
        g2.beginPath(); g2.moveTo(24, H - 44); g2.lineTo(W - 24, H - 44); g2.stroke();
        g2.strokeStyle = penColor;
        g2.lineWidth = 2.6;
        g2.lineCap = 'round';
        g2.lineJoin = 'round';
        for (const s of strokes) {
          g2.beginPath();
          s.forEach((p, i) => (i ? g2.lineTo(p.x, p.y) : g2.moveTo(p.x, p.y)));
          if (s.length === 1) g2.lineTo(s[0].x + 0.1, s[0].y);
          g2.stroke();
        }
      };
      const at = (ev: PointerEvent): Point => {
        const r = pad.getBoundingClientRect();
        return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
      };
      pad.addEventListener('pointerdown', (ev) => { ev.preventDefault(); pad.setPointerCapture(ev.pointerId); current = [at(ev)]; strokes.push(current); redraw(); });
      pad.addEventListener('pointermove', (ev) => { if (!current) return; current.push(at(ev)); redraw(); });
      const end = (): void => { current = null; };
      pad.addEventListener('pointerup', end);
      pad.addEventListener('pointercancel', end);
      redraw();
      m.body.append(pad, colorRow, el('div', 'faisal-pdf-hint', t('pdf.signPadHint')));
      const clear = dialogButton(t('pdf.signClear'));
      const cancel = dialogButton(t('pdf.cancel'));
      const ok = dialogButton(t('pdf.signUse'), 'primary');
      clear.addEventListener('click', () => { strokes.length = 0; redraw(); });
      cancel.addEventListener('click', () => m.close());
      ok.addEventListener('click', () => {
        const bounds = strokesBounds(strokes, 6);
        if (!bounds || bounds.width < 12) { setStatus(t('pdf.signEmpty'), true); return; }
        // Crop to the ink, on a transparent background, at the pad's density.
        const out = document.createElement('canvas');
        out.width = Math.ceil(bounds.width * ratio);
        out.height = Math.ceil(bounds.height * ratio);
        const o = out.getContext('2d');
        if (!o) return;
        o.setTransform(ratio, 0, 0, ratio, -bounds.x * ratio, -bounds.y * ratio);
        o.strokeStyle = penColor;
        o.lineWidth = 2.6;
        o.lineCap = 'round';
        o.lineJoin = 'round';
        for (const s of strokes) {
          o.beginPath();
          s.forEach((p, i) => (i ? o.lineTo(p.x, p.y) : o.moveTo(p.x, p.y)));
          if (s.length === 1) o.lineTo(s[0].x + 0.1, s[0].y);
          o.stroke();
        }
        out.toBlob((blob) => {
          if (!blob) return;
          void blob.arrayBuffer().then((buf) => {
            if (state.signature) URL.revokeObjectURL(state.signature.url);
            const url = URL.createObjectURL(blob);
            blobUrls.push(url);
            state.signature = { bytes: new Uint8Array(buf), url, aspect: bounds.width / bounds.height, strokes: strokes.map((st) => st.map((p) => ({ x: p.x - bounds.x, y: p.y - bounds.y }))), pad: bounds, color: penColor };
            m.close();
            setTool('signature');
          });
        }, 'image/png');
      });
      m.actions.append(clear, cancel, ok);
    });
  }

  async function startPicture(): Promise<void> {
    if (!state.info) return;
    const picked = await pickFiles(IMAGE_TYPES, false);
    if (closed || !picked.length) return;
    const file = picked[0];
    const kind = sniff(file.bytes);
    if (kind !== 'png' && kind !== 'jpeg') { setStatus(t('pdf.signImageRefused', { code: kind }), true); return; }
    const url = URL.createObjectURL(new Blob([file.bytes.slice()], { type: kind === 'png' ? 'image/png' : 'image/jpeg' }));
    blobUrls.push(url);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { setStatus(t('pdf.refusalImageBroken'), true); return; }
    state.picture = { name: file.name, bytes: file.bytes, url, aspect: img.naturalWidth / Math.max(1, img.naturalHeight) };
    setTool('image');
  }

  const STAMPS = ['pdf.stampApproved', 'pdf.stampDraft', 'pdf.stampConfidential', 'pdf.stampFinal', 'pdf.stampReviewed'];
  function chooseStamp(anchor: HTMLElement): void {
    const box = el('div', 'faisal-pdf-stampmenu');
    let close = (): void => {};
    for (const key of STAMPS) {
      const b = button(t(key), 'faisal-pdf-stampitem');
      b.addEventListener('click', () => { state.stamp = t(key); close(); setTool('stamp'); });
      box.append(b);
    }
    close = openPopoverAt(root, anchor, box, t('pdf.toolStamp'));
  }

  function openStylePopover(anchor: HTMLElement): void {
    const tool = DRAW_TOOLS.has(state.tool) || MARKUP_TOOLS.has(state.tool) ? state.tool : 'pen';
    const s = style(tool);
    const box = el('div', 'faisal-pdf-stylebox');
    box.append(el('div', 'faisal-pdf-paneltitle', t('pdf.styleFor', { tool: t(TOOL_KEYS[tool] ?? 'pdf.toolPen') })));
    const grid = el('div', 'faisal-pdf-palette');
    for (const c of PALETTE) {
      const sw = el('button', 'faisal-pdf-swatch');
      sw.type = 'button';
      sw.style.background = c;
      sw.setAttribute('aria-label', c);
      sw.setAttribute('aria-pressed', String(c.toLowerCase() === s.color.toLowerCase()));
      sw.addEventListener('click', () => {
        s.color = c;
        for (const other of Array.from(grid.children)) other.setAttribute('aria-pressed', String(other === sw));
      });
      grid.append(sw);
    }
    const custom = colorInput('faisal-pdf-style-color', s.color);
    custom.addEventListener('input', () => { s.color = custom.value; });
    const slider = (id: string, labelKey: string, min: number, max: number, step: number, value: number, onChange: (v: number) => void, fmt: (v: number) => string): HTMLElement => {
      const input = el('input', 'faisal-pdf-slider');
      input.type = 'range';
      input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
      const out = el('output', 'faisal-pdf-slidervalue', fmt(value));
      const paintFill = (): void => input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
      paintFill();
      input.addEventListener('input', () => { onChange(Number(input.value)); out.textContent = fmt(Number(input.value)); paintFill(); });
      const row = el('div', 'faisal-pdf-sliderrow');
      row.append(input, out);
      return field(id, labelKey, row);
    };
    box.append(grid, field('faisal-pdf-style-color', 'pdf.customColor', custom),
      slider('faisal-pdf-style-opacity', 'pdf.opacity', 10, 100, 5, Math.round(s.opacity * 100), (v) => { s.opacity = v / 100; }, (v) => `${v}%`),
      slider('faisal-pdf-style-width', 'pdf.strokeWidth', 1, 12, 0.5, s.width, (v) => { s.width = v; }, (v) => `${v}`),
      slider('faisal-pdf-style-size', 'pdf.fontSize', 6, 72, 1, s.size, (v) => { s.size = v; }, (v) => `${v}`));
    openPopoverAt(root, anchor, box, t('pdf.styleCmd'));
  }

  /** An existing annotation: recolour, change opacity or text, delete. */
  function openAnnotationPopover(info: writer.AnnotationInfo, anchor: HTMLElement): void {
    const box = el('div', 'faisal-pdf-stylebox');
    box.append(el('div', 'faisal-pdf-paneltitle', kindLabel(info.kind ?? 'note')));
    let close = (): void => {};
    const grid = el('div', 'faisal-pdf-palette');
    for (const c of PALETTE) {
      const sw = el('button', 'faisal-pdf-swatch');
      sw.type = 'button';
      sw.style.background = c;
      sw.setAttribute('aria-label', c);
      sw.addEventListener('click', () => {
        close();
        void applyOp(() => writer.updateAnnotation(state.bytes, info.page, info.index, { color: c }), t('pdf.annotUpdated'), true);
      });
      grid.append(sw);
    }
    box.append(grid);
    const row = el('div', 'faisal-pdf-row');
    if (info.kind === 'note' || info.kind === 'freetext') {
      const edit = button(t('pdf.annotEditText'), 'faisal-pdf-chip');
      edit.addEventListener('click', () => {
        close();
        void askText(kindLabel(info.kind ?? 'note'), t('pdf.noteLabel'), info.contents, true).then((text) => {
          if (text === null) return;
          void (async () => {
            let opts: { arabicFont?: Uint8Array } | undefined;
            if (writer.needsUnicodeFont(text)) {
              try { opts = { arabicFont: await getArabicFont() }; } catch { setStatus(t('pdf.fontUnavailable'), true); return; }
            }
            await applyOp(() => writer.updateAnnotation(state.bytes, info.page, info.index, { contents: text }, opts), t('pdf.annotUpdated'), true);
          })();
        });
      });
      row.append(edit);
    }
    const del = button(t('pdf.annotDelete'), 'faisal-pdf-chip is-danger');
    del.addEventListener('click', () => {
      close();
      void applyOp(() => writer.removeAnnotation(state.bytes, info.page, info.index), t('pdf.annotDeleted'), true);
    });
    row.append(del);
    box.append(row);
    if (info.contents) {
      const p = el('p', 'faisal-pdf-p', info.contents);
      p.dir = 'auto';
      box.append(p);
    }
    close = openPopoverAt(root, anchor, box, kindLabel(info.kind ?? 'note'));
  }

  function showShortcuts(): void {
    const m = openModal({ title: t('pdf.shortcutsTitle'), wide: true });
    const table = el('dl', 'faisal-pdf-keys');
    for (const row of shortcutSheet()) {
      const dt = el('dt', undefined, t(`pdf.${row.label}`));
      const dd = el('dd');
      for (const combo of row.combos) {
        const k = el('kbd', undefined, combo);
        k.dir = 'ltr';
        dd.append(k);
      }
      table.append(dt, dd);
    }
    m.body.append(table);
    const close = dialogButton(t('pdf.close'), 'primary');
    close.addEventListener('click', () => m.close());
    m.actions.append(close);
  }

  function openHelpMenu(anchor: HTMLElement): void {
    const box = el('div', 'faisal-pdf-zoommenu');
    let close = (): void => {};
    const items: [string, () => void][] = [
      [t('pdf.shortcutsTitle'), () => showShortcuts()],
      [t('pdf.limitsTitle'), () => showTask('limits')],
      [t('pdf.propertiesTitle'), () => showTask('properties')],
    ];
    for (const [label, run] of items) {
      const b = button(label, 'faisal-pdf-menuitem');
      b.addEventListener('click', () => { close(); run(); });
      box.append(b);
    }
    close = openPopoverAt(root, anchor, box, t('pdf.help'));
  }

  /* ───────────────────────────── undo / redo ───────────────────────────── */

  async function undoRedo(dir: 'undo' | 'redo'): Promise<void> {
    if (state.busy || !state.info) return;
    const next = dir === 'undo' ? history.undo(state.bytes) : history.redo(state.bytes);
    if (!next) return;
    state.bytes = next;
    state.saved = next === state.original;
    await refreshWorking();
    setStatus(dir === 'undo' ? t('pdf.undone') : t('pdf.redone'));
  }

  undoBtn.addEventListener('click', () => { void undoRedo('undo'); });
  redoBtn.addEventListener('click', () => { void undoRedo('redo'); });
  searchBtn.addEventListener('click', () => openSearch());
  printQuick.addEventListener('click', () => printResult());
  downloadQuick.addEventListener('click', () => downloadResult());
  helpBtn.addEventListener('click', () => openHelpMenu(helpBtn));
  saveMain.addEventListener('click', () => { void runSave(false); });

  /* ───────────────────────────── keyboard ───────────────────────────── */

  root.addEventListener('keydown', (ev) => {
    // The shared Save as dialog owns the keyboard while it is open (Ctrl+S inside it is its own).
    if (win.content.querySelector('.faisal-saveas-overlay')) return;
    const target = ev.target as HTMLElement;
    const inField = Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    const id: CommandId | null = commandFor(ev, inField);
    if (!id) return;
    const inThumbs = Boolean(target.closest('.faisal-pdf-thumblist'));
    const run = (fn: () => void): void => { ev.preventDefault(); ev.stopPropagation(); fn(); };
    const hasDoc = Boolean(state.info);
    switch (id) {
      case 'newDoc': run(() => { void newBlank(); }); break;
      case 'open': run(() => { void openFromFiles(); }); break;
      case 'save': if (hasDoc) run(() => { void runSave(false); }); break;
      case 'saveAs': if (hasDoc) run(() => { void saveAs(); }); break;
      case 'print': if (hasDoc) run(() => printResult()); break;
      case 'undo': if (hasDoc) run(() => { void undoRedo('undo'); }); break;
      case 'redo': case 'redoAlt': if (hasDoc) run(() => { void undoRedo('redo'); }); break;
      case 'find': if (hasDoc) run(() => openSearch()); break;
      case 'findNext': if (hasDoc) run(() => stepSearch(1)); break;
      case 'findPrev': if (hasDoc) run(() => stepSearch(-1)); break;
      case 'goto': if (hasDoc) run(() => { pageInput.focus(); pageInput.select(); }); break;
      case 'zoomIn': case 'zoomInAlt': if (hasDoc) run(() => zoomStep(1)); break;
      case 'zoomOut': if (hasDoc) run(() => zoomStep(-1)); break;
      case 'fitPage': if (hasDoc) run(() => viewer.setMode('fitPage')); break;
      case 'actualSize': if (hasDoc) run(() => viewer.setZoom(1)); break;
      case 'firstPage': if (hasDoc && !inThumbs) run(() => viewer.goToPage(0)); break;
      case 'lastPage': if (hasDoc && !inThumbs) run(() => viewer.goToPage(viewer.pageCount - 1)); break;
      case 'nextPage': if (hasDoc) run(() => viewer.goToPage(viewer.currentPage + 1)); break;
      case 'prevPage': if (hasDoc) run(() => viewer.goToPage(viewer.currentPage - 1)); break;
      case 'selectAll': if (hasDoc && inThumbs) run(() => selectAllPages()); break;
      case 'deletePages': if (hasDoc && inThumbs) run(() => { void deleteTargets(); }); break;
      case 'escape':
        if (state.tool !== 'select' && !placement) run(() => setTool('select'));
        break;
      case 'help': run(() => showShortcuts()); break;
      default: break;
    }
  });

  /* ───────────────────────────── responsive ───────────────────────────── */

  const applyWidth = (width: number): void => {
    const narrow = width > 0 && width < NARROW;
    if (narrow === state.narrow && root.dataset.narrow !== undefined) return;
    state.narrow = narrow;
    root.dataset.narrow = String(narrow);
    if (narrow) { setSide(false); setPane(false); } else setSide(state.loaded);
    syncScrim();
  };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver((entries) => applyWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(root);
    unsubs.push(() => ro.disconnect());
  }
  applyWidth(win.content.clientWidth || 1024);

  /* ───────────────────────────── start screen ───────────────────────────── */

  function showStart(): void {
    root.dataset.mode = state.loaded ? root.dataset.mode ?? 'ready' : 'start';
    if (state.loaded) { root.dataset.mode = 'start-over'; }
    else root.dataset.mode = 'start';
    buildStart();
    refreshCommands();
  }

  function buildStart(): void {
    start.textContent = '';
    const inner = el('div', 'faisal-pdf-startinner');
    const hero = el('div', 'faisal-pdf-hero');
    const heroIcon = el('div', 'faisal-pdf-heroicon');
    heroIcon.append(icon('file'));
    const heroText = el('div');
    heroText.append(el('h1', 'faisal-pdf-herotitle', t('pdf.startTitle')), el('p', 'faisal-pdf-herosub', t('pdf.startSub')));
    hero.append(heroIcon, heroText);
    if (state.loaded) {
      const back = button(t('pdf.backToDoc'), 'faisal-pdf-chip');
      back.prepend(icon('back'));
      back.addEventListener('click', () => { root.dataset.mode = 'ready'; refreshCommands(); });
      hero.append(back);
    }
    const cards = el('div', 'faisal-pdf-startcards');
    const tile = (iconName: IconName, titleKey: string, hintKey: string, run: () => void): HTMLButtonElement => {
      const b = el('button', 'faisal-pdf-starttile');
      b.type = 'button';
      const ic = el('span', 'faisal-pdf-tileicon');
      ic.append(icon(iconName));
      b.append(ic, el('span', 'faisal-pdf-tiletitle', t(titleKey)), el('span', 'faisal-pdf-tilehint', t(hintKey)));
      b.addEventListener('click', run);
      return b;
    };
    cards.append(
      tile('open', 'pdf.startOpenFiles', 'pdf.startOpenFilesHint', () => { void openFromFiles(); }),
      tile('device', 'pdf.startOpenDevice', 'pdf.startOpenDeviceHint', () => { void openFromDevice(); }),
      tile('blank', 'pdf.startBlank', 'pdf.startBlankHint', () => { void newBlank(); }),
      tile('images', 'pdf.startImages', 'pdf.startImagesHint', () => { void startFromImages(); }),
      tile('merge', 'pdf.startMerge', 'pdf.startMergeHint', () => { void startMerge(); }),
    );
    const recentHead = el('h2', 'faisal-pdf-sectiontitle', t('pdf.recentTitle'));
    const recentList = el('div', 'faisal-pdf-recent');
    const recent = loadRecent();
    if (!recent.length) {
      const empty = emptyState(t('pdf.recentEmpty'));
      const act = button(t('pdf.startOpenFiles'), 'faisal-pdf-primary');
      act.addEventListener('click', () => { void openFromFiles(); });
      empty.append(act);
      recentList.append(empty);
    }
    for (const entry of recent) recentList.append(recentRow(entry));
    inner.append(hero, cards, recentHead, recentList);
    start.append(inner);
  }

  function recentRow(entry: RecentEntry): HTMLElement {
    const row = el('div', 'faisal-pdf-recentrow');
    const openBtn = el('button', 'faisal-pdf-recentopen');
    openBtn.type = 'button';
    const thumb = el('span', 'faisal-pdf-recentthumb');
    if (entry.thumb) {
      const img = el('img');
      img.src = entry.thumb;
      img.alt = '';
      thumb.append(img);
    } else thumb.append(icon('file'));
    const text = el('span', 'faisal-pdf-recenttext');
    const nm = el('span', 'faisal-pdf-recentname', entry.name);
    nm.dir = 'auto';
    const where = el('span', 'faisal-pdf-recentpath', dirname(entry.path));
    where.dir = 'ltr';
    const when = el('span', 'faisal-pdf-recentdate', new Date(entry.time).toLocaleString(sys.locale() === 'ar' ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short' }));
    text.append(nm, where, when);
    openBtn.append(thumb, text);
    openBtn.addEventListener('click', () => { void openVfsPath(entry.path); });
    const forget = iconButton('close', t('pdf.recentForget', { name: entry.name }));
    forget.addEventListener('click', () => { storeRecent(removeRecent(loadRecent(), entry.path)); buildStart(); });
    row.append(openBtn, forget);
    return row;
  }

  function rememberRecent(path: string): void {
    if (!path.startsWith(`${HOME}/`)) return;
    storeRecent(addRecent(loadRecent(), { path, name: basename(path), time: Date.now(), pages: state.info?.pageCount }));
  }

  function rememberThumb(canvas: HTMLCanvasElement): void {
    if (state.untitled || !state.path) return;
    try {
      const w = 96;
      const h = Math.round((canvas.height / Math.max(1, canvas.width)) * w);
      const small = document.createElement('canvas');
      small.width = w;
      small.height = Math.max(1, h);
      small.getContext('2d')?.drawImage(canvas, 0, 0, w, small.height);
      storeRecent(setThumb(loadRecent(), state.path, small.toDataURL('image/jpeg', 0.6)));
    } catch {
      // A tainted or zero-size canvas: the recent entry simply keeps its icon.
    }
  }

  /** Lists every PDF in the home folder (a few levels deep) and lets the owner pick. */
  async function pickFromHome(multiple: boolean): Promise<string[]> {
    const found: { path: string; size: number; mtime: number }[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 5 || found.length > 400) return;
      let entries;
      try { entries = await sys.vfs.readdir(dir); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.type === 'dir') await walk(e.path, depth + 1);
        else if (/\.pdf$/i.test(e.name)) found.push({ path: e.path, size: e.size, mtime: e.mtime });
      }
    };
    await walk(HOME, 0);
    found.sort((a, b) => b.mtime - a.mtime);
    return new Promise((resolve) => {
      const chosen = new Set<string>();
      let result: string[] = [];
      const m = openModal({ title: multiple ? t('pdf.pickManyTitle') : t('pdf.pickTitle'), wide: true, onClose: () => resolve(result) });
      const filter = el('input', 'faisal-pdf-input');
      filter.type = 'search';
      filter.dir = 'auto';
      filter.placeholder = t('pdf.pickFilter');
      filter.setAttribute('aria-label', t('pdf.pickFilter'));
      const list = el('div', 'faisal-pdf-picklist');
      list.setAttribute('role', 'listbox');
      const draw = (): void => {
        list.textContent = '';
        const q = filter.value.trim().toLowerCase();
        const rows = found.filter((f) => !q || f.path.toLowerCase().includes(q));
        if (!rows.length) { list.append(emptyState(found.length ? t('pdf.pickNoMatch') : t('pdf.pickNone'))); return; }
        for (const f of rows) {
          const b = el('button', 'faisal-pdf-pickrow');
          b.type = 'button';
          b.setAttribute('role', 'option');
          b.setAttribute('aria-selected', String(chosen.has(f.path)));
          const ic = el('span', 'faisal-pdf-pickicon');
          ic.append(icon('file'));
          const text = el('span', 'faisal-pdf-recenttext');
          const nm = el('span', 'faisal-pdf-recentname', basename(f.path));
          nm.dir = 'auto';
          const where = el('span', 'faisal-pdf-recentpath', `${dirname(f.path)} · ${formatBytes(f.size, sys.locale())}`);
          where.dir = 'ltr';
          text.append(nm, where);
          b.append(ic, text);
          b.addEventListener('click', () => {
            if (!multiple) { result = [f.path]; m.close(); return; }
            if (chosen.has(f.path)) chosen.delete(f.path); else chosen.add(f.path);
            b.setAttribute('aria-selected', String(chosen.has(f.path)));
            ok.disabled = !chosen.size;
          });
          list.append(b);
        }
      };
      filter.addEventListener('input', draw);
      m.body.append(filter, list);
      const cancel = dialogButton(t('pdf.cancel'));
      const ok = dialogButton(t('pdf.pickAdd'), 'primary');
      ok.disabled = true;
      cancel.addEventListener('click', () => m.close());
      ok.addEventListener('click', () => { result = [...chosen]; m.close(); });
      m.actions.append(cancel);
      if (multiple) m.actions.append(ok);
      draw();
    });
  }

  async function confirmReplace(): Promise<boolean> {
    if (!dirty()) return true;
    return shellConfirm({
      title: t('pdf.closeTitle'), message: t('pdf.closeMessage', { name: name.textContent ?? '' }),
      okLabel: t('pdf.closeDiscard'), cancelLabel: t('pdf.cancel'), danger: true,
    });
  }

  async function openFromFiles(): Promise<void> {
    const [path] = await pickFromHome(false);
    if (!path) return;
    await openVfsPath(path);
  }

  /** Opens a file of the VFS here — or, when a document with changes is open, in a new window. */
  async function openVfsPath(path: string): Promise<void> {
    if (state.loaded && dirty()) {
      await sys.apps.launch(manifest.id, [path]).catch(() => undefined);
      return;
    }
    await openPath(path);
  }

  async function openFromDevice(): Promise<void> {
    const picked = await pickFiles(PDF_TYPES, false);
    if (closed || !picked.length || !(await confirmReplace())) return;
    await openBytes(picked[0].bytes, { name: picked[0].name });
  }

  async function newBlank(): Promise<void> {
    if (!(await confirmReplace())) return;
    const result = await createBlankPdf();
    if (!result.ok) { setStatus(opMessage(result.code, result.detail), true); return; }
    await openBytes(result.bytes, { name: t('pdf.untitled') });
  }

  async function startFromImages(): Promise<void> {
    const picked = await pickFiles(IMAGE_TYPES);
    if (closed || !picked.length || !(await confirmReplace())) return;
    const images = picked.filter((f) => { const k = sniff(f.bytes); return k === 'png' || k === 'jpeg'; });
    if (!images.length) { setStatus(t('pdf.imagesEmpty'), true); return; }
    setBusy(true);
    const result = await imagesToPdf(images, state.imageMode);
    setBusy(false);
    if (!result.ok) { setStatus(opMessage(result.code, result.detail), true); return; }
    await openBytes(result.bytes, { name: t('pdf.newFromImagesName') });
    setStatus(t('pdf.imagesDone', { n: images.length, pages: images.length }));
  }

  async function startMerge(): Promise<void> {
    const choice = await pickFromHome(true);
    let files: { name: string; bytes: Uint8Array }[] = [];
    for (const path of choice) {
      try { files.push({ name: basename(path), bytes: await sys.vfs.readFile(path) }); } catch { /* unreadable: skipped and said below */ }
    }
    if (!choice.length) files = await pickFiles(PDF_TYPES);
    if (closed || files.length < 1 || !(await confirmReplace())) return;
    setBusy(true);
    const infos: DocInfo[] = [];
    for (const f of files) {
      const loaded = await loadPdf(f.bytes);
      if (!loaded.ok) { setBusy(false); setStatus(`${f.name}: ${t(refusalKey(loaded.code))}`, true); return; }
      infos.push(loaded.info);
    }
    const plan = infos.flatMap((info, source) => range(info.pageCount).map((page) => ({ source, page })));
    const result = await mergePdfs(files, plan);
    setBusy(false);
    if (!result.ok) { setStatus(opMessage(result.code, result.detail), true); return; }
    await openBytes(result.bytes, { name: t('pdf.mergedName') });
    setStatus(t('pdf.mergeDone', { n: files.length, pages: plan.length }));
  }

  /* ───────────────────────────── opening ───────────────────────────── */

  function setDocName(display: string, full: string): void {
    name.textContent = display;
    name.title = full;
    name.dir = 'auto';
    win.setTitle(`${display} — ${t('pdf.title')}`);
  }

  async function openPath(path: string): Promise<void> {
    state.path = path;
    state.untitled = false;
    setDocName(basename(path), path);
    setStatus(t('pdf.loading'));
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
    await openBytes(bytes, { path, name: basename(path) });
  }

  /** Makes `bytes` the open document (from a file, the device, or something made here). */
  async function openBytes(bytes: Uint8Array, source: { path?: string; name: string }): Promise<void> {
    root.dataset.mode = 'loading';
    const loaded = await loadPdf(bytes);
    if (closed) return;
    if (!loaded.ok) {
      if (loaded.code === 'encrypted' && engineSupported()) { await openReadOnly(bytes, source, loaded.detail); return; }
      failWithCode(loaded.code, loaded.detail);
      return;
    }
    adopt(bytes, source, loaded.info, false);
    await refreshForm();
    await refreshSaveTarget();
    void refreshAnnotations();
    if (source.path) rememberRecent(source.path);
  }

  function adopt(bytes: Uint8Array, source: { path?: string; name: string }, info: DocInfo, readOnly: boolean): void {
    state.path = source.path ?? '';
    state.untitled = !source.path;
    state.suggestedName = source.name.replace(/\.pdf$/i, '');
    state.original = bytes;
    state.bytes = bytes;
    state.info = info;
    state.readOnly = readOnly;
    state.selection.clear();
    state.pendingFields.clear();
    state.saved = !state.untitled;
    state.loaded = true;
    state.merge = [];
    history.clear();
    readOnlyBadge.hidden = !readOnly;
    root.dataset.readonly = String(readOnly);
    setDocName(source.name, source.path ?? source.name);
    root.dataset.mode = 'ready';
    fail.textContent = '';
    hideBanner();
    refreshHeader();
    refreshInfo();
    refreshPages();
    refreshEditBounds();
    refreshMergeList();
    refreshMetadataForm();
    void refreshView(false);
    if (!state.narrow) setSide(true);
    setTool('select');
    refreshCommands();
    setStatus(readOnly ? t('pdf.readOnlyOpened') : t('pdf.opened', { n: info.pageCount }));
  }

  /** A password-protected PDF: pdf-lib cannot edit it, but pdf.js can show it after a password. */
  async function openReadOnly(bytes: Uint8Array, source: { path?: string; name: string }, detail: string): Promise<void> {
    const engine = await loadEngine();
    if (!engine) { failWithCode('encrypted', detail); return; }
    let password: string | undefined;
    let doc: PdfJsDocument;
    try {
      doc = await openForRender(engine, bytes, {
        onPassword: async (retry) => {
          const answer = await askText(t('pdf.passwordTitle'), retry ? t('pdf.passwordRetry') : t('pdf.passwordLabel'), '', false);
          password = answer ?? undefined;
          return answer;
        },
      });
    } catch {
      failWithCode('encrypted', detail);
      return;
    }
    const pages: DocInfo['pages'] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const [x0, y0, x1, y1] = p.view;
      pages.push({ width: x1 - x0, height: y1 - y0, rotation: p.rotate, crop: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
    }
    void doc.loadingTask.destroy();
    state.password = password;
    adopt(bytes, source, {
      pageCount: pages.length, pages, title: '', author: '', subject: '', keywords: '', creator: '', producer: '',
    }, true);
    if (source.path) rememberRecent(source.path);
  }

  /* ───────────────────────────── assembly ───────────────────────────── */

  setTab('home');
  setSidePanel('thumbs');
  setPane(false);
  refreshCommands();
  refreshPageBox();
  refreshZoomBox();
  if (!state.path) {
    showStart();
    setStatus(t('pdf.startHint'));
    return;
  }
  root.dataset.mode = 'loading';
  setStatus(t('pdf.loading'));
  void openPath(state.path);
}

const app: AppModule = { manifest, launch };
export default app;
