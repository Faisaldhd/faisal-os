/**
 * Fai$al OS — Photo Editor (محرّر الصور). A real raster editor, not a viewer.
 *
 * WHERE THE DATA GOES: every byte read and written stays inside /home/user (`fs:home` only).
 * Nothing is sent anywhere — the app does not even request the network permission. Image
 * bytes are decoded by the browser's own decoders (`createImageBitmap` / an `Image`), drawn
 * into a canvas and edited as pixels. No file or user content ever reaches the DOM as markup:
 * the only place raw bytes touch an element is a `data:` URL given to an `Image` for SVG.
 *
 * WHAT IS PURE AND TESTED: adjustments (pixels.ts), geometry (geometry.ts), drawing
 * primitives (tools.ts), the undo stack and its memory policy (history.ts), the format table
 * and its refusal mapping (formats.ts), the write/backup rule (export-file.ts) and the
 * browser capability probe (decode.ts). This file is the thin part: DOM, canvas plumbing and
 * the dialogs.
 */
import './strings';
import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { HOME } from '../../kernel/types';
import { t } from '../../kernel/i18n';
import { join } from '../../kernel/path';
import { renderIcon } from '../../shell/icon';
import { ICONS } from './toolbar-icons';
import { applyAdjustments, applyPreset, boxBlur, isNeutral, presetById, sharpen, FILTER_PRESETS } from './pixels';
import type { AdjustmentKey, PixelBuffer } from './types';
import {
  applyAspect, clampDimension, clampZoom, fitScale, lockedOtherSide, normaliseCrop, normaliseRotation,
  quarterTurnSize, resizeByPercent, rotatedBounds, sameSize, zoomStep,
} from './geometry';
import {
  blendTextMask, clampBrush, clampFont, paintOp, parseHexColor, textBoxSize,
  MIN_BRUSH, MAX_BRUSH, type DrawOp,
} from './tools';
import { History, HISTORY_PRESETS, formatBytes } from './history';
import {
  EXPORT_FORMAT_LIST, FORMATS, MAX_EXPORT_BYTES, OPEN_EXTENSIONS,
  clampQuality, formatForExtension, type ExportFormat, type RefusalReason, type SourceFormat,
} from './formats';
import { HOME_ROOT, backupPathFor, basenameOf, exportPathFor, isWithinHome, planExport } from './export-file';
import { DecodeRefusal, decodeSource, probeRuntime, refusalText } from './decode';
import './photo.css';

type ToolId = DrawOp['kind'] | 'move' | 'select' | 'crop' | 'text';
interface Point { x: number; y: number }
interface CropRect { x: number; y: number; w: number; h: number }
type Zoom = number | 'fit';

const ADJUSTMENT_LABELS: { key: AdjustmentKey; label: string }[] = [
  { key: 'brightness', label: t('photo.adjBrightness') },
  { key: 'contrast', label: t('photo.adjContrast') },
  { key: 'saturation', label: t('photo.adjSaturation') },
  { key: 'exposure', label: t('photo.adjExposure') },
  { key: 'temperature', label: t('photo.adjTemperature') },
  { key: 'highlights', label: t('photo.adjHighlights') },
  { key: 'shadows', label: t('photo.adjShadows') },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, cls = 'faisal-photo-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  return b;
}

/**
 * Every toolbar/tool control is a labelled <button> at least 44px tall, never a hover menu.
 * Its name is real `textContent`, so a screen reader reads it; the active tool carries
 * `aria-pressed` instead of relying on a colour.
 */
function toolButton(label: string, iconMarkup: string): HTMLButtonElement {
  const b = button(label, 'faisal-photo-tool');
  b.append(renderIcon(iconMarkup));
  return b;
}

function slider(
  label: string, min: number, max: number, value: number, onInput: (v: number) => void,
): { row: HTMLElement; input: HTMLInputElement; output: HTMLElement } {
  const row = el('div', 'faisal-photo-field');
  const input = el('input', 'faisal-photo-range');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  const output = el('output', 'faisal-photo-value', String(value));
  const lab = el('label', 'faisal-photo-label');
  lab.append(el('span', 'faisal-photo-labeltext', label), input);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    output.textContent = String(v);
    onInput(v);
  });
  row.append(lab, output);
  return { row, input, output };
}

function labelled(label: string, control: HTMLElement): HTMLElement {
  const row = el('div', 'faisal-photo-field');
  const lab = el('label', 'faisal-photo-label');
  lab.append(el('span', 'faisal-photo-labeltext', label), control);
  row.appendChild(lab);
  return row;
}

function numberInput(min: number, max: number, value: number, step = 1): HTMLInputElement {
  const input = el('input', 'faisal-photo-number');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  return input;
}

function selectInput(options: { value: string; label: string }[]): HTMLSelectElement {
  const s = el('select', 'faisal-photo-select');
  for (const o of options) {
    const opt = el('option', undefined, o.label);
    opt.value = o.value;
    s.appendChild(opt);
  }
  return s;
}

function textInput(placeholder: string): HTMLInputElement {
  const input = el('input', 'faisal-photo-text');
  input.type = 'text';
  input.placeholder = placeholder;
  return input;
}

function checkboxRow(label: string, checked = false): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', 'faisal-photo-check');
  input.type = 'checkbox';
  input.checked = checked;
  const row = el('label', 'faisal-photo-checkrow');
  row.append(input, el('span', undefined, label));
  return { row, input };
}

function presetLabel(id: string): string {
  const map: Record<string, string> = {
    none: t('photo.filterNone'), mono: t('photo.filterMono'), sepia: t('photo.filterSepia'),
    vivid: t('photo.filterVivid'), soft: t('photo.filterSoft'), punch: t('photo.filterPunch'),
    warm: t('photo.filterWarm'), cool: t('photo.filterCool'),
  };
  return map[id] ?? id;
}

/* ─────────────────────────────── the window ─────────────────────────────── */

export function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  const vfs = sys.vfs;

  win.setTitle(t('photo.title'));

  const root = el('div', 'faisal-photo');

  /* ---- toolbar ---- */
  const toolbar = el('div', 'faisal-photo-toolbar');
  const openBtn = button(t('photo.openFile'));
  const undoBtn = button(t('photo.undo'));
  const redoBtn = button(t('photo.redo'));
  const revertBtn = button(t('photo.reset'));
  const zoomOutBtn = button(t('photo.zoomOut'), 'faisal-photo-btn faisal-photo-iconbtn');
  const zoomInBtn = button(t('photo.zoomIn'), 'faisal-photo-btn faisal-photo-iconbtn');
  const fitBtn = button(t('photo.zoomFit'));
  const actualBtn = button(t('photo.zoomActual'));
  const saveCopyBtn = button(t('photo.saveAsCopy'), 'faisal-photo-btn faisal-photo-primary');
  const overwriteBtn = button(t('photo.overwrite'));
  const limitsBtn = button(t('photo.limitsTitle'));
  zoomOutBtn.prepend(renderIcon(ICONS.zoomOut));
  zoomInBtn.prepend(renderIcon(ICONS.zoomIn));
  const statusEl = el('div', 'faisal-photo-status');
  statusEl.setAttribute('role', 'status');
  toolbar.append(
    openBtn, undoBtn, redoBtn, revertBtn, zoomOutBtn, zoomInBtn, fitBtn, actualBtn,
    saveCopyBtn, overwriteBtn, limitsBtn, statusEl,
  );

  /* ---- tools ---- */
  const toolsBar = el('div', 'faisal-photo-tools');
  toolsBar.setAttribute('role', 'toolbar');
  toolsBar.setAttribute('aria-label', t('photo.toolsTitle'));
  const toolDefs: { id: ToolId; label: string; icon: string }[] = [
    { id: 'move', label: t('photo.toolMove'), icon: ICONS.move },
    { id: 'select', label: t('photo.toolSelect'), icon: ICONS.select },
    { id: 'crop', label: t('photo.toolCrop'), icon: ICONS.crop },
    { id: 'brush', label: t('photo.toolBrush'), icon: ICONS.brush },
    { id: 'line', label: t('photo.toolLine'), icon: ICONS.line },
    { id: 'rect', label: t('photo.toolRect'), icon: ICONS.rect },
    { id: 'ellipse', label: t('photo.toolEllipse'), icon: ICONS.ellipse },
    { id: 'arrow', label: t('photo.toolArrow'), icon: ICONS.arrow },
    { id: 'text', label: t('photo.toolText'), icon: ICONS.text },
  ];
  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  for (const def of toolDefs) {
    const b = toolButton(def.label, def.icon);
    b.addEventListener('click', () => setTool(def.id));
    toolButtons.set(def.id, b);
    toolsBar.appendChild(b);
  }

  /* ---- stage ---- */
  const stage = el('div', 'faisal-photo-stage');
  stage.tabIndex = 0;
  stage.setAttribute('role', 'group');
  stage.setAttribute('aria-label', t('photo.title'));
  const viewport = el('div', 'faisal-photo-viewport');
  const frame = el('div', 'faisal-photo-frame');
  const canvas = el('canvas', 'faisal-photo-canvas');
  canvas.width = 1;
  canvas.height = 1;
  canvas.setAttribute('aria-label', t('photo.toolsTitle'));
  const overlay = el('canvas', 'faisal-photo-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  frame.append(canvas, overlay);
  viewport.appendChild(frame);
  const emptyEl = el('div', 'faisal-photo-empty', t('photo.noImage'));
  const zoomLabel = el('div', 'faisal-photo-zoomlabel');
  zoomLabel.setAttribute('aria-hidden', 'true');
  stage.append(viewport, zoomLabel, emptyEl);

  /* ---- inspector ---- */
  const inspector = el('aside', 'faisal-photo-inspector');
  const panels: Record<string, HTMLElement> = {};

  const docPanel = el('section', 'faisal-photo-panel');
  docPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.fileTitle')));
  const docInfo = el('dl', 'faisal-photo-dl');
  docPanel.appendChild(docInfo);
  panels.doc = docPanel;

  const transformPanel = el('section', 'faisal-photo-panel');
  transformPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.transformTitle')));
  const rotLeft = button(t('photo.rotateLeft'));
  const rotRight = button(t('photo.rotateRight'));
  const flipH = button(t('photo.flipH'));
  const flipV = button(t('photo.flipV'));
  const rotRow = el('div', 'faisal-photo-row');
  rotRow.append(rotLeft, rotRight, flipH, flipV);
  transformPanel.appendChild(rotRow);
  const freeAngle = numberInput(-180, 180, 0, 0.1);
  const freeApply = button(t('photo.apply'));
  const freeRow = el('div', 'faisal-photo-row');
  freeRow.append(labelled(t('photo.rotateFree'), freeAngle), freeApply);
  transformPanel.appendChild(freeRow);
  panels.transform = transformPanel;

  const cropPanel = el('section', 'faisal-photo-panel');
  cropPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.cropTitle')));
  const aspectSel = selectInput([
    { value: 'free', label: t('photo.cropFree') },
    { value: '1:1', label: '1:1' },
    { value: '4:3', label: '4:3' },
    { value: '3:2', label: '3:2' },
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
  ]);
  cropPanel.appendChild(labelled(t('photo.cropAspect'), aspectSel));
  const cropApply = button(t('photo.cropApply'));
  const cropClear = button(t('photo.cropReset'));
  const cropRow = el('div', 'faisal-photo-row');
  cropRow.append(cropApply, cropClear);
  cropPanel.append(cropRow, el('p', 'faisal-photo-note', t('photo.cropHint')));
  panels.crop = cropPanel;

  const resizePanel = el('section', 'faisal-photo-panel');
  resizePanel.appendChild(el('h2', 'faisal-photo-h', t('photo.resizeTitle')));
  const wInput = numberInput(1, 16384, 1);
  const hInput = numberInput(1, 16384, 1);
  const lockAspect = checkboxRow(t('photo.resizeLock'), true);
  const pctInput = numberInput(1, 800, 100);
  const resizeApply = button(t('photo.resizeApply'));
  const resizeRow = el('div', 'faisal-photo-row');
  resizeRow.append(labelled(t('photo.resizeWidth'), wInput), labelled(t('photo.resizeHeight'), hInput));
  const pctRow = el('div', 'faisal-photo-row');
  pctRow.append(labelled(t('photo.resizePercent'), pctInput), resizeApply);
  resizePanel.append(resizeRow, lockAspect.row, pctRow);
  panels.resize = resizePanel;

  const adjustPanel = el('section', 'faisal-photo-panel');
  adjustPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.adjustTitle')));
  const adjInputs = new Map<AdjustmentKey, HTMLInputElement>();
  const adjOutputs = new Map<AdjustmentKey, HTMLElement>();
  for (const a of ADJUSTMENT_LABELS) {
    const s = slider(a.label, -100, 100, 0, (v) => { adjustments[a.key] = v; renderPreviewSoon(); });
    adjInputs.set(a.key, s.input);
    adjOutputs.set(a.key, s.output);
    adjustPanel.appendChild(s.row);
  }
  const adjReset = button(t('photo.adjResetAll'));
  adjReset.addEventListener('click', () => { resetAdjustments(); renderPreviewSoon(); });
  adjustPanel.appendChild(adjReset);
  panels.adjust = adjustPanel;

  const effectsPanel = el('section', 'faisal-photo-panel');
  effectsPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.filtersTitle')));
  const presetSel = selectInput(FILTER_PRESETS.map((p) => ({ value: p.id, label: presetLabel(p.id) })));
  effectsPanel.append(labelled(t('photo.filtersTitle'), presetSel), el('p', 'faisal-photo-note', t('photo.filterHint')));
  effectsPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.blurTitle')));
  const blurRadius = numberInput(0, 100, 6);
  const blurApply = button(t('photo.applyBlur'));
  effectsPanel.append(labelled(t('photo.effectRadius'), blurRadius), blurApply);
  effectsPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.sharpenTitle')));
  const sharpenAmount = numberInput(0, 5, 1, 0.1);
  const sharpenApply = button(t('photo.applySharpen'));
  effectsPanel.append(labelled(t('photo.effectAmount'), sharpenAmount), sharpenApply);
  panels.effects = effectsPanel;

  const drawPanel = el('section', 'faisal-photo-panel');
  drawPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.toolsTitle')));
  const colorInput = el('input', 'faisal-photo-color');
  colorInput.type = 'color';
  colorInput.value = '#ff3b30';
  colorInput.setAttribute('aria-label', t('photo.brushColor'));
  const sizeSlider = slider(t('photo.brushSize'), MIN_BRUSH, MAX_BRUSH, 12, (v) => { brushSize = v; });
  const fillCheck = checkboxRow(t('photo.shapeFill'));
  drawPanel.append(labelled(t('photo.brushColor'), colorInput), sizeSlider.row, fillCheck.row);
  panels.draw = drawPanel;

  const textPanel = el('section', 'faisal-photo-panel');
  textPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.toolText')));
  const textArea = el('textarea', 'faisal-photo-textarea');
  textArea.rows = 3;
  textArea.placeholder = t('photo.textPlaceholder');
  const fontSize = numberInput(8, 400, 48);
  const textColor = el('input', 'faisal-photo-color');
  textColor.type = 'color';
  textColor.value = '#ffffff';
  textColor.setAttribute('aria-label', t('photo.textColor'));
  const textAdd = button(t('photo.textAdd'), 'faisal-photo-btn faisal-photo-primary');
  textPanel.append(
    labelled(t('photo.textContent'), textArea),
    labelled(t('photo.textSize'), fontSize),
    labelled(t('photo.textColor'), textColor),
    textAdd,
    el('p', 'faisal-photo-note', t('photo.textHint')),
  );
  panels.text = textPanel;

  const historyPanel = el('section', 'faisal-photo-panel');
  historyPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.historyTitle')));
  const historyList = el('ol', 'faisal-photo-history');
  const memoryLine = el('p', 'faisal-photo-note');
  const policyLine = el('p', 'faisal-photo-note');
  historyPanel.append(historyList, memoryLine, policyLine);
  panels.history = historyPanel;

  const capsPanel = el('section', 'faisal-photo-panel');
  capsPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.capTitle')));
  const capsList = el('div', 'faisal-photo-caps');
  capsPanel.appendChild(capsList);
  panels.caps = capsPanel;

  const limitsPanel = el('section', 'faisal-photo-panel faisal-photo-limits');
  limitsPanel.appendChild(el('h2', 'faisal-photo-h', t('photo.limitsTitle')));
  const limitsList = el('ul', 'faisal-photo-list');
  for (const key of [
    'limitLayers', 'limitCmyk', 'limitRaw', 'limitAnim', 'limitVector', 'limitText',
    'limitBrush', 'limitQuota', 'limitColors', 'limitNoOriginal', 'limitClosing',
  ]) {
    limitsList.appendChild(el('li', undefined, t(`photo.${key}`)));
  }
  limitsPanel.appendChild(limitsList);
  panels.limits = limitsPanel;

  for (const key of ['doc', 'transform', 'crop', 'resize', 'adjust', 'effects', 'draw', 'text', 'history', 'caps', 'limits']) {
    inspector.appendChild(panels[key]);
  }

  /* ---- dialogs (kept outside .faisal-photo so their fixed position is not transformed) ---- */
  const openDialog = el('div', 'faisal-photo-dialog');
  openDialog.setAttribute('role', 'dialog');
  openDialog.setAttribute('aria-modal', 'true');
  openDialog.setAttribute('aria-label', t('photo.openTitle'));
  openDialog.hidden = true;
  const openInput = textInput(t('photo.openPlaceholder'));
  openInput.value = join(HOME, 'Pictures');
  const openGo = button(t('photo.openAction'), 'faisal-photo-btn faisal-photo-primary');
  const openCancel = button(t('photo.openCancel'));
  const openRow = el('div', 'faisal-photo-row');
  openRow.append(openGo, openCancel);
  openDialog.append(
    el('h2', 'faisal-photo-h', t('photo.openTitle')),
    labelled(t('photo.openTitle'), openInput),
    el('p', 'faisal-photo-note', t('photo.openHint')),
    openRow,
  );

  const exportDialog = el('div', 'faisal-photo-dialog');
  exportDialog.setAttribute('role', 'dialog');
  exportDialog.setAttribute('aria-modal', 'true');
  exportDialog.setAttribute('aria-label', t('photo.exportTitle'));
  exportDialog.hidden = true;
  const exportTitle = el('h2', 'faisal-photo-h', t('photo.exportTitle'));
  const formatSel = selectInput(EXPORT_FORMAT_LIST.map((f) => ({ value: f, label: f.toUpperCase() })));
  const qualitySlider = slider(t('photo.exportQuality'), 5, 100, 92, () => {});
  const targetInput = textInput(`${HOME_ROOT}/untitled.png`);
  const exportNote = el('p', 'faisal-photo-note', t('photo.exportHint'));
  const exportGo = button(t('photo.exportConfirm'), 'faisal-photo-btn faisal-photo-primary');
  const exportCancel = button(t('photo.cancel'));
  const exportRow = el('div', 'faisal-photo-row');
  exportRow.append(exportGo, exportCancel);
  exportDialog.append(
    exportTitle,
    labelled(t('photo.exportFormat'), formatSel),
    qualitySlider.row,
    labelled(t('photo.exportTarget'), targetInput),
    exportNote,
    exportRow,
  );

  const errorDialog = el('div', 'faisal-photo-dialog');
  errorDialog.setAttribute('role', 'alertdialog');
  errorDialog.setAttribute('aria-modal', 'true');
  errorDialog.hidden = true;
  const errorBody = el('p', 'faisal-photo-note');
  const errorClose = button(t('photo.close'));
  errorDialog.append(el('h2', 'faisal-photo-h', t('photo.errorTitle')), errorBody, errorClose);

  root.append(toolbar, toolsBar, stage, inspector);
  win.content.append(root, openDialog, exportDialog, errorDialog);

  /* ─────────────────────────────── state ─────────────────────────────── */

  let doc: PixelBuffer | null = null;
  let originalBuffer: PixelBuffer | null = null;
  let originalPath: string | null = null;
  let adjustments: Partial<Record<AdjustmentKey, number>> = {};
  let tool: ToolId = 'move';
  let brushSize = 12;
  let zoom: Zoom = 'fit';
  let currentZoom = 1;
  let pan: Point = { x: 0, y: 0 };
  let cropRect: CropRect | null = null;
  let dragStart: Point | null = null;
  let dragRect: CropRect | null = null;
  let brushPath: Point[] = [];
  let textAt: Point | null = null;
  let dirty = false;
  let busy = false;
  let exportAction: 'copy' | 'overwrite' = 'copy';
  let runtimeSupport: Partial<Record<SourceFormat, boolean>> = {};
  let history = new History<PixelBuffer>(HISTORY_PRESETS[0]);
  let previewRaf = 0;

  const offscreen = document.createElement('canvas');
  const offscreenCtx = offscreen.getContext('2d', { willReadFrequently: true });
  const displayCtx = canvas.getContext('2d', { willReadFrequently: true });
  const overlayCtx = overlay.getContext('2d');

  /* ─────────────────────────── small helpers ─────────────────────────── */

  function cloneBuffer(buffer: PixelBuffer): PixelBuffer {
    return { width: buffer.width, height: buffer.height, data: new Uint8ClampedArray(buffer.data) };
  }

  function bufferFromCanvas(source: HTMLCanvasElement): PixelBuffer {
    const ctx = source.getContext('2d', { willReadFrequently: true })!;
    const data = ctx.getImageData(0, 0, source.width, source.height);
    return { width: source.width, height: source.height, data: data.data };
  }

  /** A canvas holding a copy of `buffer`, for the canvas 2D transforms to read from. */
  function scratchWith(buffer: PixelBuffer): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = buffer.width;
    c.height = buffer.height;
    c.getContext('2d', { willReadFrequently: true })!.putImageData(
      new ImageData(buffer.data.slice(), buffer.width, buffer.height), 0, 0,
    );
    return c;
  }

  /** Runs `draw` into a freshly sized canvas and reads the pixels back. */
  function renderBuffer(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): PixelBuffer {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width));
    c.height = Math.max(1, Math.round(height));
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    draw(ctx);
    return bufferFromCanvas(c);
  }

  /** The image the canvas shows: the committed buffer with the sliders/preset applied. */
  function previewBuffer(): PixelBuffer | null {
    if (!doc) return null;
    const presetId = presetSel.value;
    const preset = presetById(presetId);
    if (preset && presetId !== 'none') return applyPreset(doc, preset, adjustments);
    if (isNeutral(adjustments)) return doc;
    return applyAdjustments(doc, adjustments);
  }

  function renderPreviewSoon(): void {
    if (previewRaf) return;
    previewRaf = window.requestAnimationFrame(() => {
      previewRaf = 0;
      renderPreview();
    });
  }

  function renderPreview(): void {
    const buffer = previewBuffer();
    if (!buffer || !doc) return;
    if (offscreen.width !== buffer.width || offscreen.height !== buffer.height) {
      offscreen.width = buffer.width;
      offscreen.height = buffer.height;
    }
    if (offscreenCtx && displayCtx) {
      offscreenCtx.putImageData(new ImageData(buffer.data.slice(), buffer.width, buffer.height), 0, 0);
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      displayCtx.drawImage(offscreen, 0, 0);
    }
    applyView();
    drawOverlay();
  }

  function applyView(): void {
    if (!doc) return;
    const base = zoom === 'fit' ? fitFactor() : clampZoom(zoom);
    currentZoom = base;
    frame.style.width = `${doc.width}px`;
    frame.style.height = `${doc.height}px`;
    frame.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${base})`;
    zoomLabel.textContent = `${Math.round(base * 100)}%`;
  }

  function fitFactor(): number {
    if (!doc) return 1;
    return fitScale(
      { width: doc.width, height: doc.height },
      { width: viewport.clientWidth, height: viewport.clientHeight },
    );
  }

  /* ─────────────────────────── history & commit ─────────────────────────── */

  function changed(label: string, buffer: PixelBuffer, dedupeKey?: string): void {
    if (!doc) return;
    doc = buffer;
    history.push(label, buffer, buffer.data.length, dedupeKey);
    dirty = true;
    if (canvas.width !== buffer.width || canvas.height !== buffer.height) {
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      overlay.width = buffer.width;
      overlay.height = buffer.height;
    }
    renderPreview();
    renderHistory();
    syncChrome();
  }

  function renderHistory(): void {
    historyList.replaceChildren();
    history.steps.forEach((step, index) => {
      const b = button(step.label, 'faisal-photo-historybtn');
      if (index === history.index) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => {
        const buffer = history.goTo(index);
        if (!buffer) return;
        doc = buffer;
        dirty = true;
        renderPreview();
        renderHistory();
        syncChrome();
      });
      const li = el('li');
      li.appendChild(b);
      historyList.appendChild(li);
    });
    const limits = history.limitsValue;
    memoryLine.textContent = t('photo.historyMemory', {
      steps: history.length,
      size: formatBytes(history.bytes),
      budget: formatBytes(limits.maxBytes),
    });
    policyLine.textContent = t('photo.historyPolicy', {
      budget: formatBytes(limits.maxBytes),
      steps: limits.maxSteps,
    }) + (history.trimmed ? ` — ${t('photo.historyTrimmed', { count: history.trimmed })}` : '');
  }

  function syncChrome(): void {
    const open = !!doc;
    emptyEl.hidden = open;
    frame.hidden = !open;
    undoBtn.disabled = !open || !history.canUndo;
    redoBtn.disabled = !open || !history.canRedo;
    revertBtn.disabled = !open;
    saveCopyBtn.disabled = !open;
    overwriteBtn.disabled = !open || !originalPath;
    for (const b of toolButtons.values()) b.disabled = !open;
    for (const b of [cropApply, cropClear, rotLeft, rotRight, flipH, flipV, freeApply, resizeApply, blurApply, sharpenApply, textAdd, zoomInBtn, zoomOutBtn, fitBtn, actualBtn]) {
      b.disabled = !open;
    }
    renderDocInfo();
  }

  function renderDocInfo(): void {
    docInfo.replaceChildren();
    const add = (label: string, value: string) => {
      docInfo.appendChild(el('dt', undefined, label));
      docInfo.appendChild(el('dd', undefined, value));
    };
    if (!doc) { add(t('photo.sizeLabel'), '—'); return; }
    add(t('photo.sizeLabel'), `${doc.width} × ${doc.height}`);
    add(t('photo.colorspace'), t('photo.colorspaceRgb'));
    add(t('photo.history'), `${history.index + 1}/${history.length}`);
  }

  function renderCaps(): void {
    capsList.replaceChildren();
    const line = (label: string, value: string, cls?: string) => {
      capsList.appendChild(el('p', cls ? `faisal-photo-note ${cls}` : 'faisal-photo-note', `${label} ${value}`.trim()));
    };
    const supported = (ext: string) => {
      const info = formatForExtension(ext);
      return !!info && info.canOpen && runtimeSupport[info.id] !== false;
    };
    const yes = OPEN_EXTENSIONS.filter(supported);
    const no = OPEN_EXTENSIONS.filter((e) => !supported(e));
    line(t('photo.capOpens'), yes.join(', ') || '—');
    line(t('photo.capExports'), EXPORT_FORMAT_LIST.map((f) => FORMATS[f].extensions[0]).join(', '));
    line(t('photo.capProbe'), '');
    if (no.length) line(t('photo.capUnsupported'), no.join(', '), 'faisal-photo-bad');
    capsList.appendChild(el('p', 'faisal-photo-note', t('photo.capAnimFirst')));
  }

  /* ─────────────────────────────── tools ─────────────────────────────── */

  function setTool(id: ToolId): void {
    tool = id;
    for (const [key, b] of toolButtons) b.setAttribute('aria-pressed', String(key === id));
    panels.crop.hidden = id !== 'crop';
    panels.draw.hidden = !(id === 'brush' || id === 'line' || id === 'rect' || id === 'ellipse' || id === 'arrow');
    panels.text.hidden = id !== 'text';
    statusEl.textContent = id === 'select' ? t('photo.selectHint') : id === 'move' ? t('photo.moveHint') : '';
    drawOverlay();
  }

  function aspectValue(value: string): number | null {
    if (value === 'free') return null;
    const [a, b] = value.split(':').map(Number);
    return a > 0 && b > 0 ? a / b : null;
  }

  function resetAdjustments(): void {
    for (const [key, input] of adjInputs) {
      input.value = '0';
      adjOutputs.get(key)!.textContent = '0';
    }
    adjustments = {};
    presetSel.value = 'none';
  }

  /* ───────────────────────── overlay & pointer input ───────────────────────── */

  function imagePoint(e: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    const z = currentZoom || 1;
    return { x: (e.clientX - rect.left) / z, y: (e.clientY - rect.top) / z };
  }

  function drawOverlay(): void {
    if (!overlayCtx) return;
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    if (!doc) return;
    const thin = Math.max(0.5, 1 / (currentZoom || 1));
    overlayCtx.lineWidth = thin;
    if (cropRect) {
      overlayCtx.fillStyle = 'rgba(0,0,0,0.45)';
      overlayCtx.beginPath();
      overlayCtx.rect(0, 0, overlay.width, overlay.height);
      overlayCtx.rect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      overlayCtx.fill('evenodd');
      overlayCtx.strokeStyle = '#ffcc00';
      overlayCtx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    }
    if (dragStart && tool === 'brush' && brushPath.length > 1) {
      overlayCtx.strokeStyle = colorInput.value;
      overlayCtx.lineWidth = brushSize;
      overlayCtx.beginPath();
      overlayCtx.moveTo(brushPath[0].x, brushPath[0].y);
      for (const p of brushPath.slice(1)) overlayCtx.lineTo(p.x, p.y);
      overlayCtx.stroke();
    }
    if (dragRect && tool !== 'crop') {
      overlayCtx.strokeStyle = colorInput.value;
      overlayCtx.lineWidth = brushSize;
      overlayCtx.strokeRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
    }
    if (textAt) {
      const size = clampFont(Number(fontSize.value));
      const box = textBoxSize(textArea.value || ' ', size);
      overlayCtx.strokeStyle = '#4da3ff';
      overlayCtx.lineWidth = thin;
      overlayCtx.strokeRect(textAt.x, textAt.y, box.width, box.height);
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!doc || busy || tool === 'move') return;
    canvas.setPointerCapture(e.pointerId);
    const p = imagePoint(e);
    dragStart = p;
    dragRect = null;
    if (tool === 'brush') brushPath = [p];
    if (tool === 'text') { textAt = p; drawOverlay(); return; }
    drawOverlay();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!doc || !dragStart) return;
    const p = imagePoint(e);
    if (tool === 'crop') {
      let next = normaliseCrop(dragStart, p, { width: doc.width, height: doc.height });
      const aspect = aspectValue(aspectSel.value);
      if (next && aspect) next = applyAspect(next, aspect, { width: doc.width, height: doc.height });
      cropRect = next;
      drawOverlay();
      return;
    }
    if (tool === 'brush') { brushPath.push(p); drawOverlay(); return; }
    dragRect = {
      x: Math.min(dragStart.x, p.x), y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y),
    };
    drawOverlay();
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!doc || !dragStart) return;
    const p = imagePoint(e);
    const from = dragStart;
    dragStart = null;
    dragRect = null;
    if (tool === 'crop' || tool === 'text') { drawOverlay(); return; }
    const working = cloneBuffer(doc);
    if (tool === 'brush') {
      const path = brushPath.length ? brushPath : [from, p];
      paintOp(working, { kind: 'brush', from, to: p, path, color: colorInput.value, size: brushSize });
      brushPath = [];
    } else if (tool === 'line' || tool === 'rect' || tool === 'ellipse' || tool === 'arrow') {
      paintOp(working, { kind: tool, from, to: p, color: colorInput.value, size: brushSize, filled: fillCheck.input.checked });
    }
    changed(`draw:${tool}`, working, `${tool}:${from.x},${from.y}:${p.x},${p.y}:${brushSize}:${colorInput.value}`);
    drawOverlay();
  });

  canvas.addEventListener('pointercancel', () => { dragStart = null; dragRect = null; brushPath = []; drawOverlay(); });

  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoom = zoomStep(currentZoom, e.deltaY < 0 ? 1 : -1);
    applyView();
  }, { passive: false });

  /* ─────────────────────── canvas transformations ─────────────────────── */

  function rotateQuarter(direction: 1 | -1): void {
    if (!doc || busy) return;
    const src = doc;
    const size = quarterTurnSize({ width: src.width, height: src.height }, 1);
    const source = scratchWith(src);
    const out = renderBuffer(size.width, size.height, (ctx) => {
      ctx.translate(size.width / 2, size.height / 2);
      ctx.rotate((direction * Math.PI) / 2);
      ctx.drawImage(source, -src.width / 2, -src.height / 2);
    });
    changed(direction > 0 ? 'rotate:90' : 'rotate:-90', out);
  }

  function flip(axis: 'h' | 'v'): void {
    if (!doc || busy) return;
    const src = doc;
    const source = scratchWith(src);
    const out = renderBuffer(src.width, src.height, (ctx) => {
      if (axis === 'h') { ctx.translate(src.width, 0); ctx.scale(-1, 1); }
      else { ctx.translate(0, src.height); ctx.scale(1, -1); }
      ctx.drawImage(source, 0, 0);
    });
    changed(axis === 'h' ? 'flip:h' : 'flip:v', out);
  }

  function rotateFree(): void {
    if (!doc || busy) return;
    const rotation = normaliseRotation({ quarter: 0, free: Number(freeAngle.value) });
    if (rotation.free === 0) { statusEl.textContent = t('photo.resizeSame'); return; }
    const src = doc;
    const bounds = rotatedBounds({ width: src.width, height: src.height }, rotation.free);
    const source = scratchWith(src);
    const out = renderBuffer(bounds.width, bounds.height, (ctx) => {
      ctx.translate(bounds.width / 2, bounds.height / 2);
      ctx.rotate((rotation.free * Math.PI) / 180);
      ctx.drawImage(source, -src.width / 2, -src.height / 2);
    });
    changed(`rotate:${rotation.free.toFixed(2)}`, out);
  }

  function applyCrop(): void {
    if (!doc || busy) return;
    if (!cropRect) { statusEl.textContent = t('photo.cropInvalid'); return; }
    const src = doc;
    const rect = cropRect;
    const source = scratchWith(src);
    const out = renderBuffer(rect.w, rect.h, (ctx) => {
      ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    });
    cropRect = null;
    changed(`crop:${rect.w}x${rect.h}`, out, `crop:${rect.x},${rect.y},${rect.w},${rect.h}`);
  }

  function applyResize(width: number, height: number): void {
    if (!doc || busy) return;
    const w = clampDimension(width);
    const h = clampDimension(height);
    if (sameSize({ width: w, height: h }, { width: doc.width, height: doc.height })) {
      statusEl.textContent = t('photo.resizeSame');
      return;
    }
    const source = scratchWith(doc);
    const out = renderBuffer(w, h, (ctx) => ctx.drawImage(source, 0, 0, w, h));
    changed(`resize:${w}x${h}`, out);
  }

  function applyEffect(kind: 'blur' | 'sharpen'): void {
    if (!doc || busy) return;
    busy = true;
    statusEl.textContent = t('photo.loading');
    // A short delay lets the status text paint before a synchronous raster pass blocks the thread.
    window.setTimeout(() => {
      try {
        if (!doc) return;
        const out = kind === 'blur'
          ? boxBlur(doc, Number(blurRadius.value))
          : sharpen(doc, Number(sharpenAmount.value));
        changed(kind === 'blur' ? `blur:${blurRadius.value}` : `sharpen:${sharpenAmount.value}`, out);
      } finally {
        busy = false;
        statusEl.textContent = '';
      }
    }, 16);
  }

  function addText(): void {
    if (!doc || busy) return;
    const value = textArea.value;
    if (!value.trim()) { statusEl.textContent = t('photo.textNeedsContent'); return; }
    const size = clampFont(Number(fontSize.value));
    const at = textAt ?? { x: Math.round(doc.width * 0.05), y: Math.round(doc.height * 0.05) };
    const box = textBoxSize(value, size);
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = Math.max(1, Math.min(box.width, doc.width));
    maskCanvas.height = Math.max(1, Math.min(box.height, doc.height));
    const mctx = maskCanvas.getContext('2d', { willReadFrequently: true })!;
    mctx.font = `${size}px system-ui, "Segoe UI", sans-serif`;
    mctx.textBaseline = 'top';
    mctx.fillStyle = '#ffffff';
    value.split('\n').forEach((line, i) => mctx.fillText(line, size / 2, i * size * 1.25));
    const image = mctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const mask = new Uint8ClampedArray(maskCanvas.width * maskCanvas.height);
    for (let i = 0, p = 0; i < image.data.length; i += 4, p++) mask[p] = image.data[i + 3];
    const working = cloneBuffer(doc);
    blendTextMask(working, mask, maskCanvas.width, maskCanvas.height, at, parseHexColor(textColor.value));
    changed(`text:${value.slice(0, 12)}`, working);
    textAt = null;
    drawOverlay();
  }

  /* ─────────────────────────────── opening ─────────────────────────────── */

  function showError(message: string): void {
    errorBody.textContent = message;
    errorDialog.hidden = false;
    errorClose.focus();
  }

  function describeOpenFailure(error: unknown, named: string): string {
    if (error instanceof DecodeRefusal) {
      // A refusal that names the pixel limit gets the export-size sentence; everything else
      // gets the sentence for its own reason, with the format/extension actually refused.
      if (error.reason === 'too-large') return t('photo.exportTooBig');
      return refusalText(error.reason, sys.locale(), named);
    }
    const code = (error as { code?: string })?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.message) return error.message;
    return t('photo.errorUnknown');
  }

  async function openPath(path: string): Promise<boolean> {
    if (busy) return false;
    busy = true;
    statusEl.textContent = t('photo.loading');
    const named = path.slice(path.lastIndexOf('.') + 1) || path;
    try {
      const data = await vfs.readFile(path);
      const decoded = await decodeSource(data, path);
      const buffer = decoded.buffer;
      doc = buffer;
      originalBuffer = cloneBuffer(buffer);
      originalPath = path;
      history = new History<PixelBuffer>(HISTORY_PRESETS[0]);
      history.push(t('photo.openFile'), buffer, buffer.data.length);
      resetAdjustments();
      cropRect = null;
      textAt = null;
      zoom = 'fit';
      pan = { x: 0, y: 0 };
      dirty = false;
      win.setTitle(`${path.slice(path.lastIndexOf('/') + 1)} — ${t('photo.title')}`);
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      overlay.width = buffer.width;
      overlay.height = buffer.height;
      renderPreview();
      renderHistory();
      renderCaps();
      syncChrome();
      statusEl.textContent = decoded.note ?? '';
      return true;
    } catch (error) {
      showError(describeOpenFailure(error, named));
      return false;
    } finally {
      busy = false;
    }
  }

  /* ─────────────────────────────── exporting ─────────────────────────────── */

  function refusalFor(reason: RefusalReason, named: string): string {
    return refusalText(reason, sys.locale(), named);
  }

  function exportFormatOf(path: string): ExportFormat {
    const info = formatForExtension(path.slice(path.lastIndexOf('.')).toLowerCase());
    return info?.id === 'jpeg' || info?.id === 'webp' ? info.id : 'png';
  }

  function canEncode(format: ExportFormat): boolean {
    const mime = FORMATS[format].exportMime;
    if (!mime) return false;
    // A 1×1 encode is the only honest check: `toDataURL` silently falls back to PNG when the
    // browser cannot encode the requested type, which would write a ".webp" file full of PNG.
    return canvas.toDataURL(mime, 0.8).startsWith(`data:${mime}`);
  }

  async function encode(buffer: PixelBuffer, format: ExportFormat, quality: number): Promise<Uint8Array> {
    const scratch = document.createElement('canvas');
    scratch.width = buffer.width;
    scratch.height = buffer.height;
    scratch.getContext('2d', { willReadFrequently: true })!.putImageData(
      new ImageData(buffer.data.slice(), buffer.width, buffer.height), 0, 0,
    );
    const mime = FORMATS[format].exportMime!;
    const blob: Blob | null = await new Promise((resolve) => {
      scratch.toBlob((b) => resolve(b), mime, FORMATS[format].lossy ? clampQuality(quality) : undefined);
    });
    if (!blob) throw new Error('encode-failed');
    if (blob.type && blob.type !== mime) throw new Error('encode-unsupported');
    return new Uint8Array(await blob.arrayBuffer());
  }

  function openExportDialog(action: 'copy' | 'overwrite'): void {
    if (!doc) return;
    exportAction = action;
    const format: ExportFormat = originalPath ? exportFormatOf(originalPath) : 'png';
    formatSel.value = format;
    targetInput.value = originalPath
      ? exportPathFor(originalPath, format)
      : `${HOME_ROOT}/untitled${FORMATS[format].extensions[0]}`;
    exportTitle.textContent = action === 'copy' ? t('photo.saveAsCopy') : t('photo.overwrite');
    qualitySlider.row.hidden = !FORMATS[format].lossy;
    exportDialog.hidden = false;
    targetInput.focus();
    targetInput.select();
  }

  async function existingInDir(target: string): Promise<string[]> {
    const dir = target.slice(0, target.lastIndexOf('/')) || '/';
    try {
      return (await vfs.readdir(dir)).map((e) => e.path);
    } catch {
      return [];
    }
  }

  async function runExport(): Promise<void> {
    if (!doc) return;
    const format = formatSel.value as ExportFormat;
    if (!canEncode(format)) {
      showError(t('photo.exportUnsupported', { format: format.toUpperCase() }));
      return;
    }
    const typed = targetInput.value.trim();
    if (!isWithinHome(typed)) {
      showError(refusalFor('out-of-home', typed));
      return;
    }
    const existing = await existingInDir(typed);
    const plan = planExport({
      original: originalPath,
      action: exportAction,
      format,
      // The typed path is the destination for a copy; the overwrite action always targets
      // the original. `existing` is what the copy suffix consults to avoid a collision.
      existing: exportAction === 'copy' ? [...existing, typed] : existing,
    });
    if (plan.error) {
      showError(plan.error === 'out-of-home' ? refusalFor('out-of-home', typed) : t('photo.exportNoTarget'));
      return;
    }
    const target = exportAction === 'copy' ? typed : plan.target;
    const backup = exportAction === 'overwrite' ? plan.backup : false;

    let bytes: Uint8Array;
    try {
      bytes = await encode(previewBuffer() ?? doc, format, Number(qualitySlider.input.value));
    } catch {
      showError(t('photo.exportUnsupported', { format: format.toUpperCase() }));
      return;
    }
    if (bytes.length > MAX_EXPORT_BYTES) { showError(t('photo.exportTooBig')); return; }

    try {
      if (backup) {
        const bak = backupPathFor(target);
        await vfs.rename(target, bak);
        try {
          await vfs.writeFile(target, bytes);
        } catch (error) {
          // Put the original back rather than leaving the user with only a `.bak`.
          await vfs.rename(bak, target).catch(() => {});
          throw error;
        }
        statusEl.textContent = t('photo.exportDoneOverwrite', { path: target, bak });
      } else {
        await vfs.writeFile(target, bytes);
        statusEl.textContent = exportAction === 'overwrite'
          ? t('photo.exportDoneOverwriteNoBak', { path: target })
          : t('photo.exportDoneCopy', { path: target });
      }
      if (exportAction === 'overwrite') {
        originalPath = target;
        dirty = false;
      }
      exportDialog.hidden = true;
      syncChrome();
    } catch (error) {
      const code = (error as { code?: string })?.code;
      showError(t('photo.exportFailed', {
        reason: code === 'EINVAL' ? t('photo.exportQuota') : code ?? (error instanceof Error ? error.message : String(error)),
      }));
    }
  }

  /* ─────────────────────────────── events ─────────────────────────────── */

  openBtn.addEventListener('click', () => { openDialog.hidden = false; openInput.focus(); openInput.select(); });
  openCancel.addEventListener('click', () => { openDialog.hidden = true; });
  openGo.addEventListener('click', () => {
    const path = openInput.value.trim();
    if (!path) return;
    openDialog.hidden = true;
    void openPath(path);
  });
  openInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') openGo.click(); });

  const stepHistory = (direction: 'undo' | 'redo') => {
    const buffer = direction === 'undo' ? history.undo() : history.redo();
    if (!buffer) return;
    doc = buffer;
    renderPreview();
    renderHistory();
    syncChrome();
  };
  undoBtn.addEventListener('click', () => stepHistory('undo'));
  redoBtn.addEventListener('click', () => stepHistory('redo'));
  revertBtn.addEventListener('click', () => {
    if (!originalBuffer) return;
    changed(t('photo.reset'), cloneBuffer(originalBuffer));
  });
  zoomInBtn.addEventListener('click', () => { zoom = zoomStep(currentZoom, 1); applyView(); });
  zoomOutBtn.addEventListener('click', () => { zoom = zoomStep(currentZoom, -1); applyView(); });
  fitBtn.addEventListener('click', () => { zoom = 'fit'; pan = { x: 0, y: 0 }; applyView(); });
  actualBtn.addEventListener('click', () => { zoom = 1; pan = { x: 0, y: 0 }; applyView(); });
  saveCopyBtn.addEventListener('click', () => openExportDialog('copy'));
  overwriteBtn.addEventListener('click', () => openExportDialog('overwrite'));
  limitsBtn.addEventListener('click', () => { panels.limits.hidden = !panels.limits.hidden; });

  rotLeft.addEventListener('click', () => rotateQuarter(-1));
  rotRight.addEventListener('click', () => rotateQuarter(1));
  flipH.addEventListener('click', () => flip('h'));
  flipV.addEventListener('click', () => flip('v'));
  freeApply.addEventListener('click', rotateFree);

  cropApply.addEventListener('click', applyCrop);
  cropClear.addEventListener('click', () => { cropRect = null; drawOverlay(); });
  aspectSel.addEventListener('change', () => {
    if (!doc || !cropRect) return;
    const aspect = aspectValue(aspectSel.value);
    if (aspect) cropRect = applyAspect(cropRect, aspect, { width: doc.width, height: doc.height });
    drawOverlay();
  });

  wInput.addEventListener('input', () => {
    if (!doc || !lockAspect.input.checked) return;
    hInput.value = String(lockedOtherSide('width', Number(wInput.value), { width: doc.width, height: doc.height }));
  });
  hInput.addEventListener('input', () => {
    if (!doc || !lockAspect.input.checked) return;
    wInput.value = String(lockedOtherSide('height', Number(hInput.value), { width: doc.width, height: doc.height }));
  });
  pctInput.addEventListener('input', () => {
    if (!doc) return;
    const size = resizeByPercent({ width: doc.width, height: doc.height }, Number(pctInput.value));
    wInput.value = String(size.width);
    hInput.value = String(size.height);
  });
  resizeApply.addEventListener('click', () => applyResize(Number(wInput.value), Number(hInput.value)));
  blurApply.addEventListener('click', () => applyEffect('blur'));
  sharpenApply.addEventListener('click', () => applyEffect('sharpen'));

  presetSel.addEventListener('change', renderPreviewSoon);
  textAdd.addEventListener('click', addText);

  exportCancel.addEventListener('click', () => { exportDialog.hidden = true; });
  qualitySlider.row.hidden = true;
  formatSel.addEventListener('change', () => {
    const format = formatSel.value as ExportFormat;
    qualitySlider.row.hidden = !FORMATS[format].lossy;
    const dir = targetInput.value.slice(0, targetInput.value.lastIndexOf('/')) || HOME_ROOT;
    const stem = (originalPath ? basenameOf(originalPath) : 'untitled').replace(/\.[^.]+$/, '');
    targetInput.value = `${dir}/${stem}${FORMATS[format].extensions[0]}`;
  });
  exportGo.addEventListener('click', () => void runExport());
  errorClose.addEventListener('click', () => { errorDialog.hidden = true; });

  root.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); stepHistory('undo'); return; }
    if (mod && (key === 'y' || (e.shiftKey && key === 'z'))) { e.preventDefault(); stepHistory('redo'); return; }
    if (mod && e.key === '0') { e.preventDefault(); zoom = 1; applyView(); return; }
    if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoom = zoomStep(currentZoom, 1); applyView(); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoom = zoomStep(currentZoom, -1); applyView(); }
  });

  const resizeObserver = new ResizeObserver(() => { if (zoom === 'fit') applyView(); });
  resizeObserver.observe(viewport);

  win.setCloseGuard(() => {
    if (!dirty) return true;
    return window.confirm(`${t('photo.discardTitle')}\n\n${t('photo.discardBody')}`);
  });

  win.onClose(() => {
    resizeObserver.disconnect();
    if (previewRaf) window.cancelAnimationFrame(previewRaf);
  });

  /* ─────────────────────────────── boot ─────────────────────────────── */

  void (async () => {
    runtimeSupport = await probeRuntime();
    renderCaps();
    setTool('move');
    syncChrome();
    if (args[0]) await openPath(args[0]);
  })();
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
