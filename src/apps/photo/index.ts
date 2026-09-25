/**
 * Fai$al OS — Image Studio (استوديو الصور): gallery, quick editor and a layered pro editor.
 *
 * WHERE THE DATA GOES: every byte read and written stays inside /home/user (`fs:home` only).
 * Nothing is sent anywhere — the app does not request the network permission. Image bytes are
 * decoded by the browser's own decoders and edited as pixels; no file or user content ever
 * reaches the DOM as markup (text is `textContent`, icons are static SVG from this folder).
 *
 * WHAT IS PURE AND TESTED: the document and layer model (layers.ts), tiled rasters (tiles.ts),
 * affine matrices (transform.ts), selections (selection.ts), painting helpers (paint.ts), the
 * pixel engine behind ops.ts (engine/), the project format (project.ts), view maths
 * (view.ts), shortcuts (shortcuts.ts), history (history.ts), the format table (formats.ts)
 * and the write/backup rule (export-file.ts). This file is the DOM and canvas wiring.
 */
import './strings';
import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { t, getLocale } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import { shellConfirm } from '../../shell/dialog';
import { pushEscapeLayer } from '../../shell/esc';
import { dragPaths, isInternalDrag } from '../../shell/file-drop';
import { ICONS, type IconName } from './toolbar-icons';
import {
  button, checkbox, colorPicker, el, field, icon, iconButton, modal, numberInput, segmented, selectInput, slider,
  type Modal, type SliderHandle,
} from './ui';
import type { PixelBuffer, Point, Rect } from './types';
import {
  BLEND_MODES, activeLayer, addLayer, adjustLayer, maskSize, setLayerMask, updateAdjust, cropDoc, docFromBuffer, duplicateLayer, flipDoc, isBlendMode, layerById,
  layerBounds, moveLayerTo, newBufferBytes, nextLayerName, pickVectorLayer, rasterLayer, removeLayer, replaceLayer,
  resizeDoc, rotateDocFree, rotateDocQuarter, setActive, setRaster, shapeLayer, solidBuffer, textLayer,
  translateLayer, updateLayer, type BlendMode, type Layer, type PhotoDoc, type RasterLayer, type ShapeKind,
  type ShapeLayer, type TextLayer, type TextSpec,
} from './layers';
import { blankTiled, fromBuffer, readRegion, writeRegion } from './tiles';
import {
  FT_IDENTITY, corners as ftCorners, dragHandle, ftMatrix, ftReadout, handlePoints, hitHandle, isIdentity as ftIsIdentity,
  type FreeTransform, type FtHandle,
} from './freetransform';
import { multiply, tidy } from './transform';
import { downscale, presetThumbnails } from './engine';
import { addLayerMask, applyLayerMask, invertLayerMask, maskPaintHides } from './masks';
import { apply as applyMatrix, invert, isTranslationOnly, scaleOf, type Matrix } from './transform';
import {
  combine, cropSelection, ellipseMask, invertSelection, modeFromModifiers, polygonMask, rectMask, selectAll,
  selectionFromMask, traceEdges, type Selection, type SelectionMode,
} from './selection';
import {
  clearMasked, clipRect, compositeStroke, dabsAlong, fillMasked, floodMask, intersectMasks, maskBounds, maskRegion,
  mixMasked, unionRect,
} from './paint';
import {
  ADJUST_GROUPS, FILTER_IDS, NEUTRAL_ADJUST, adjust, adjustAsync, adjustRange, applyFilter, filterAsync,
  histogram, isNeutralAdjust, isSpatial, type AdjustKey, type AdjustParams, type FilterId,
} from './ops';
import {
  CANVAS_PRESETS, CROP_RATIOS, PIXELATED_ABOVE, centredAspect, dragCrop, exportSize, fitView, formatSize,
  imageToScreen, pinchView, screenToImage, wheelFactor, zoomAbout, zoomStop, type CropHandle, type View,
} from './view';
import { formatCursor, formatTick, labelAnchor, rulerCursor, rulerStep, rulerTicks } from './rulers';
import {
  FONT_IDS, LayerCanvases, PNG_CODEC, bufferCanvas, canvas2d, canvasToBytes, drawDoc, drawLayerContent,
  measureText, proxyScale, putBuffer, readCanvas, renderDoc,
} from './render';
import { PROJECT_EXT, ProjectError, isProjectPath, parseProject, serializeProject } from './project';
import { loadRecent, pushRecent, removeRecent, saveRecent, type RecentItem } from './recent';
import { SHORTCUTS, describeKeys, matchShortcut, toolKey, type Command, type ToolId } from './shortcuts';
import { PICTURES, createGallery, emptyIllustration, isImagePath, pickFile, thumbnail } from './gallery';
import { History, HISTORY_PRESETS } from './history';
import {
  EXPORT_FORMAT_LIST, FORMATS, OPEN_EXTENSIONS, PICKER_ACCEPT, clampQuality, formatForExtension, formatOfTarget,
  type ExportFormat, type SourceFormat,
} from './formats';
import { basenameOf, dirnameOf, isWithinHome, stemOf } from './export-file';
import { DecodeRefusal, decodeSource, probeRuntime, refusalText } from './decode';
import { saveAsDialog } from '../../shell/save-as';
import './photo.css';

type Mode = 'gallery' | 'quick' | 'pro';
type PanelId =
  | 'histogram' | 'layers' | 'filters' | 'export' | 'adjust' | 'image' | 'history'
  | 'quickCrop' | 'quickAdjust' | 'tools' | 'more';

const cap = (s: string) => s.replace(/(^|-)([a-z])/g, (_m, _d, c: string) => c.toUpperCase());
const filterLabel = (id: FilterId) => t(`photo.filter${cap(id)}`);
const blendLabel = (m: BlendMode) => t(`photo.blend${cap(m)}`);
const adjLabel = (k: AdjustKey) => t(`photo.adj${cap(k)}`);

/**
 * Every tool is a labelled <button> at least 44px tall, never a hover menu. Its name is real
 * text (visually hidden in the desktop rail, where the icon and the tooltip carry it), and
 * the active tool carries `aria-pressed` instead of relying on a colour.
 */
function toolButton(label: string, iconMarkup: string): HTMLButtonElement {
  const b = el('button', 'faisal-photo-tool');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  const svg = renderIcon(iconMarkup);
  svg.setAttribute('aria-hidden', 'true');
  b.append(svg, el('span', 'fp-tool-label', label));
  return b;
}

const TOOLS: { id: ToolId; icon: IconName; label: string; hint: string }[] = [
  { id: 'move', icon: 'move', label: 'toolMove', hint: 'hintMove' },
  { id: 'marquee', icon: 'marquee', label: 'toolMarquee', hint: 'hintMarquee' },
  { id: 'lasso', icon: 'lasso', label: 'toolLasso', hint: 'hintLasso' },
  { id: 'wand', icon: 'wand', label: 'toolWand', hint: 'hintWand' },
  { id: 'crop', icon: 'crop', label: 'toolCrop', hint: 'hintCrop' },
  { id: 'transform', icon: 'transform', label: 'toolTransform', hint: 'hintTransform' },
  { id: 'brush', icon: 'brush', label: 'toolBrush', hint: 'hintBrush' },
  { id: 'eraser', icon: 'eraser', label: 'toolEraser', hint: 'hintEraser' },
  { id: 'clone', icon: 'clone', label: 'toolClone', hint: 'hintClone' },
  { id: 'bucket', icon: 'bucket', label: 'toolBucket', hint: 'hintBucket' },
  { id: 'gradient', icon: 'gradient', label: 'toolGradient', hint: 'hintGradient' },
  { id: 'eyedropper', icon: 'eyedropper', label: 'toolEyedropper', hint: 'hintEyedropper' },
  { id: 'text', icon: 'text', label: 'toolText', hint: 'hintText' },
  { id: 'shape', icon: 'shape', label: 'toolShape', hint: 'hintShape' },
  { id: 'zoom', icon: 'zoom', label: 'toolZoom', hint: 'hintZoom' },
  { id: 'hand', icon: 'hand', label: 'toolHand', hint: 'hintHand' },
];

/** Filter thumbnail backing size: 2× the ~96px it is shown at, so looks stay distinct on phones. */
const THUMB_W = 192;
const THUMB_H = 144;

const PAINT_TOOLS: ToolId[] = ['brush', 'eraser', 'clone', 'bucket', 'gradient'];

/* ─────────────────────────────── the window ─────────────────────────────── */

export function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  const vfs = sys.vfs;
  const L = (key: string, vars?: Record<string, string | number>) => t(`photo.${key}`, vars);

  win.setTitle(L('appName'));

  /* ───────────────────────────── state ───────────────────────────── */

  let mode: Mode = 'pro';
  let doc: PhotoDoc | null = null;
  let history = new History<PhotoDoc>(HISTORY_PRESETS[0]);
  let savedDoc: PhotoDoc | null = null;
  let originalDoc: PhotoDoc | null = null;
  let sourcePath: string | null = null;
  let projectPath: string | null = null;
  let docName = L('untitled');
  let tool: ToolId = 'move';
  let fg = '#1a1d26';
  let bg = '#ffffff';
  let selection: Selection | null = null;
  let view: View = { zoom: 1, panX: 0, panY: 0 };
  let autoFit = true;
  let compareOn = false;
  let busy = false;
  let runtimeSupport: Partial<Record<SourceFormat, boolean>> = {};
  let recent: RecentItem[] = loadRecent();
  let clipboard: { buf: PixelBuffer; x: number; y: number } | null = null;
  const cache = new LayerCanvases();
  const overrides = new Map<string, { canvas: HTMLCanvasElement; width: number; height: number }>();

  const opts = {
    size: 24, hardness: 80, opacity: 100, tolerance: 32, contiguous: true, sampleAll: true,
    selShape: 'rect' as 'rect' | 'ellipse', selMode: 'replace' as SelectionMode,
    shape: 'rect' as ShapeKind, shapeFill: true, shapeStroke: false, strokeWidth: 6, radius: 0,
    gradType: 'linear' as 'linear' | 'radial', gradToTransparent: false,
    font: 'system', fontSize: 64, bold: true, italic: false,
    align: 'center' as TextSpec['align'], direction: 'auto' as TextSpec['direction'],
    outline: false, strokeColor: '#ffffff',
  };
  let cropBox: Rect | null = null;
  let cropAspect: number | null = null;
  let cloneSource: Point | null = null;
  let settingCloneSource = false;
  /** True while brush/eraser/fill/delete target the active layer's MASK instead of its pixels. */
  let maskEdit = false;
  /** An open free transform: the active layer (live preview in `doc`) or the selection. */
  let ft: { target: 'layer' | 'selection'; id: string; box: Rect; cur: FreeTransform; base: PhotoDoc } | null = null;
  const FT_ROTATE_GAP = 28;
  /** The last pointer position in viewport pixels (mouse or finger): where the rulers point. */
  let cursorAt: Point | null = null;
  /** Rulers on/off; null means automatic — they stay off in a phone-width window until asked for. */
  let rulersOn: boolean | null = null;

  /* ───────────────────────────── DOM ───────────────────────────── */

  const root = el('div', 'faisal-photo');
  root.dataset.mode = mode;
  root.tabIndex = -1;

  /* app bar + options bar (grid area "bar") */
  const toolbar = el('header', 'faisal-photo-toolbar');
  const appbar = el('div', 'fp-appbar');
  const menuBtn = iconButton(L('menu'), 'menu');
  menuBtn.setAttribute('aria-haspopup', 'menu');
  const titleWrap = el('div', 'fp-title');
  const titleIcon = el('span', 'fp-title-icon');
  titleIcon.append(icon('image'));
  const titleText = el('span', 'fp-title-text');
  titleText.dir = 'auto';
  const dirtyDot = el('span', 'fp-dirty');
  dirtyDot.setAttribute('role', 'img');
  titleWrap.append(titleIcon, titleText, dirtyDot);
  const modeSeg = segmented<Mode>(L('modeLabel'), [
    { value: 'gallery', label: L('modeGallery') },
    { value: 'quick', label: L('modeQuick') },
    { value: 'pro', label: L('modePro') },
  ], mode, (m) => setMode(m));
  modeSeg.root.classList.add('fp-modes');
  const undoBtn = iconButton(`${L('undo')} (Ctrl+Z)`, 'undo', 'fp-flip-rtl');
  const redoBtn = iconButton(`${L('redo')} (Ctrl+Y)`, 'redo', 'fp-flip-rtl');
  const compareBtn = iconButton(L('compareHint'), 'compare', 'fp-hide-compact');
  compareBtn.setAttribute('aria-pressed', 'false');
  const helpBtn = iconButton(`${L('shortcutsTitle')} (F1)`, 'help', 'fp-hide-compact');
  const saveBtn = button(L('saveProject'), 'secondary', 'save');
  saveBtn.classList.add('fp-hide-compact');
  const exportBtn = button(L('exportTitle'), 'primary', 'export');
  appbar.append(menuBtn, titleWrap, modeSeg.root, el('span', 'fp-spacer'), undoBtn, redoBtn, compareBtn, helpBtn, saveBtn, exportBtn);
  const optionsBar = el('div', 'fp-options');
  optionsBar.setAttribute('role', 'toolbar');
  optionsBar.setAttribute('aria-label', L('toolOptions'));
  toolbar.append(appbar, optionsBar);

  /* tool rail (grid area "tools") */
  const toolsBar = el('nav', 'faisal-photo-tools');
  toolsBar.setAttribute('role', 'toolbar');
  toolsBar.setAttribute('aria-label', L('toolsTitle'));
  toolsBar.setAttribute('aria-orientation', 'vertical');
  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  for (const def of TOOLS) {
    const key = toolKey(def.id);
    const label = key ? `${L(def.label)} (${key})` : L(def.label);
    const b = toolButton(label, ICONS[def.icon]);
    b.dataset.tool = def.id;
    b.addEventListener('click', () => { setTool(def.id); if (sheetOpen === 'tools') closeSheet(); });
    toolButtons.set(def.id, b);
    toolsBar.append(b);
  }
  const swatches = el('div', 'fp-colors');
  const fgBtn = el('button', 'fp-color-chip fp-fg');
  fgBtn.type = 'button';
  fgBtn.setAttribute('aria-label', L('foreground'));
  fgBtn.title = L('foreground');
  const bgBtn = el('button', 'fp-color-chip fp-bg');
  bgBtn.type = 'button';
  bgBtn.setAttribute('aria-label', L('background'));
  bgBtn.title = L('background');
  const swapBtn = iconButton(`${L('swapColors')} (X)`, 'swap', 'fp-swap');
  swatches.append(fgBtn, bgBtn, swapBtn);
  toolsBar.append(swatches);

  /* stage (grid area "stage") */
  const stage = el('main', 'faisal-photo-stage');
  const viewport = el('div', 'fp-viewport');
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'img');
  viewport.setAttribute('aria-label', L('appName'));
  const displayCanvas = el('canvas', 'fp-canvas');
  const overlayCanvas = el('canvas', 'fp-overlay-canvas');
  overlayCanvas.setAttribute('aria-hidden', 'true');
  viewport.append(displayCanvas, overlayCanvas);
  /*
   * The rulers own a reserved strip above and beside the canvas — a grid row and column, not an
   * overlay — so they never cover the picture, and the viewport keeps its own size (which is what
   * every zoom and pan calculation reads). The corner cell carries the unit, not a control: the
   * on/off button lives in the status bar where it can be a full 44px touch target.
   */
  const rulerH = el('canvas', 'fp-ruler fp-ruler-h');
  const rulerV = el('canvas', 'fp-ruler fp-ruler-v');
  rulerH.setAttribute('aria-hidden', 'true');
  rulerV.setAttribute('aria-hidden', 'true');
  const rulerCorner = el('div', 'fp-ruler-corner', L('rulerUnit'));
  rulerCorner.dir = 'ltr';
  const rulers = el('div', 'fp-rulers');
  rulers.append(rulerCorner, rulerH, rulerV, viewport);
  const banner = el('div', 'fp-banner');
  banner.hidden = true;
  banner.setAttribute('role', 'alert');
  const sessionBar = el('div', 'fp-session');
  sessionBar.hidden = true;
  const startScreen = el('section', 'fp-start');
  const dropOverlay = el('div', 'fp-drop', L('dropHere'));
  dropOverlay.hidden = true;
  stage.append(rulers, sessionBar, banner, startScreen, dropOverlay);

  /* side panels */
  const left = el('aside', 'fp-left');
  left.setAttribute('aria-label', L('layersTitle'));
  const inspector = el('aside', 'faisal-photo-inspector');
  inspector.setAttribute('aria-label', L('toolOptions'));

  /* status bar */
  const statusBar = el('footer', 'fp-statusbar');
  const statusInfo = el('span', 'fp-status-info');
  statusInfo.dir = 'ltr';
  const statusEl = el('span', 'faisal-photo-status');
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  const zoomOutBtn = iconButton(`${L('zoomOut')} (Ctrl+-)`, 'zoomOut');
  const zoomLabel = el('button', 'fp-zoom-value');
  zoomLabel.type = 'button';
  zoomLabel.title = `${L('zoomFit')} (Ctrl+0)`;
  const zoomInBtn = iconButton(`${L('zoomIn')} (Ctrl++)`, 'zoomIn');
  const zoomGroup = el('div', 'fp-zoom');
  zoomGroup.dir = 'ltr';
  zoomGroup.append(zoomOutBtn, zoomLabel, zoomInBtn);
  // The rulers' on/off switch: a real button, in the bar, at the full control size — a corner
  // chip inside a 20px strip could never be a 44px touch target.
  const rulersBtn = iconButton(L('rulers'), 'ruler', 'fp-rulers-btn');
  rulersBtn.setAttribute('aria-pressed', 'false');
  statusBar.append(statusInfo, statusEl, rulersBtn, zoomGroup);

  /* phone: bottom sheet + bottom bar */
  const sheet = el('section', 'fp-sheet');
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  const sheetHead = el('div', 'fp-sheet-head');
  const grab = el('span', 'fp-grab');
  grab.setAttribute('aria-hidden', 'true');
  const sheetTitle = el('h2', 'fp-sheet-title');
  const sheetClose = iconButton(L('sheetClose'), 'close');
  sheetHead.append(grab, sheetTitle, sheetClose);
  const sheetBody = el('div', 'fp-sheet-body');
  sheet.append(sheetHead, sheetBody);
  const bottomBar = el('nav', 'fp-bottombar');
  bottomBar.setAttribute('aria-label', L('toolsTitle'));

  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = PICKER_ACCEPT;
  fileInput.hidden = true;

  const galleryHost = el('div', 'fp-gallery-host');

  root.append(toolbar, left, toolsBar, stage, inspector, statusBar, sheet, bottomBar, fileInput, galleryHost);
  win.content.append(root);

  const gallery = createGallery({
    vfs,
    host: root,
    onEdit: (path, m) => void openPath(path, m),
    onImport: () => { importTarget = 'gallery'; fileInput.multiple = true; fileInput.click(); },
    notify: (m) => say(m),
  });
  galleryHost.append(gallery.root);

  /* ───────────────────────────── panels ───────────────────────────── */

  interface Panel { id: PanelId; section: HTMLElement; body: HTMLElement; title: string }
  const panels = new Map<PanelId, Panel>();

  function panel(id: PanelId, title: string, iconName: IconName, collapsed = false): Panel {
    const section = el('section', 'fp-panel');
    section.dataset.panel = id;
    const head = el('div', 'fp-panel-head');
    const h = el('h2', 'fp-panel-title');
    h.append(icon(iconName), el('span', undefined, title));
    const toggle = iconButton(L('panelCollapse', { name: title }), 'down', 'fp-panel-toggle');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const body = el('div', 'fp-panel-body');
    body.hidden = collapsed;
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden;
      toggle.setAttribute('aria-expanded', String(!body.hidden));
      if (!body.hidden) scheduleThumbs();
    });
    head.append(h, toggle);
    section.append(head, body);
    const p: Panel = { id, section, body, title };
    panels.set(id, p);
    return p;
  }

  /* histogram */
  const pHist = panel('histogram', L('histogramTitle'), 'histogram');
  const histCanvas = el('canvas', 'fp-hist');
  histCanvas.setAttribute('role', 'img');
  histCanvas.setAttribute('aria-label', L('histogramLabel'));
  pHist.body.append(histCanvas);

  /* layers */
  const pLayers = panel('layers', L('layersTitle'), 'layers');
  const layerProps = el('div', 'fp-layer-props');
  const blendSel = selectInput(L('layerBlend'), BLEND_MODES.map((m) => ({ value: m, label: blendLabel(m) })), 'normal');
  const layerOpacity = slider(L('layerOpacity'), 0, 100, 100, 1, (v) => {
    if (!doc) return;
    doc = updateLayer(doc, doc.activeId, { opacity: v / 100 });
    requestRender();
  }, (v) => `${v}%`);
  layerOpacity.input.addEventListener('change', () => commit(L('hLayerProps')));
  blendSel.addEventListener('change', () => {
    if (!doc || !isBlendMode(blendSel.value)) return;
    doc = updateLayer(doc, doc.activeId, { blend: blendSel.value });
    commit(L('hLayerProps'));
  });
  layerProps.append(field(L('layerBlend'), blendSel), layerOpacity.row);
  const maskRow = el('div', 'fp-mask-row');
  const maskTarget = segmented<'layer' | 'mask'>(L('layerMaskTitle'), [
    { value: 'layer', label: L('layerMaskEditLayer') }, { value: 'mask', label: L('layerMaskEdit') },
  ], 'layer', (v) => { maskEdit = v === 'mask'; renderLayers(); say(maskEdit ? L('layerMaskHint') : ''); });
  maskTarget.root.classList.add('fp-seg-fill');
  const mInvert = iconButton(L('layerMaskInvert'), 'invert');
  const mApply = iconButton(L('layerMaskApply'), 'check');
  const mDelete = iconButton(L('layerMaskDelete'), 'trash', 'fp-danger-icon');
  const maskBtns = el('div', 'fp-icon-row');
  maskBtns.append(mInvert, mApply, mDelete);
  maskRow.append(maskTarget.root, maskBtns);
  const layerList = el('ul', 'fp-layer-list');
  layerList.setAttribute('aria-label', L('layersTitle'));
  const layerActions = el('div', 'fp-layer-actions');
  const lAdd = iconButton(`${L('layerAdd')} (Ctrl+Shift+N)`, 'plus');
  const lDup = iconButton(`${L('layerDuplicate')} (Ctrl+J)`, 'duplicate');
  const lUp = iconButton(L('layerUp'), 'up');
  const lDown = iconButton(L('layerDown'), 'down');
  const lMerge = iconButton(L('layerMergeDown'), 'merge');
  const lFlatten = iconButton(L('layerFlatten'), 'flatten');
  const lDel = iconButton(L('layerDelete'), 'trash', 'fp-danger-icon');
  const lMask = iconButton(L('layerMaskAdd'), 'mask');
  const lAdj = iconButton(L('layerAdjAdd'), 'adjustLayer');
  layerActions.append(lAdd, lAdj, lMask, lDup, lUp, lDown, lMerge, lFlatten, lDel);
  pLayers.body.append(layerProps, maskRow, layerList, layerActions);

  /* filters */
  const pFilters = panel('filters', L('filtersTitle'), 'sparkle');
  const filterGrid = el('div', 'fp-filter-grid');
  const filterButtons = new Map<FilterId, { btn: HTMLButtonElement; canvas: HTMLCanvasElement }>();
  for (const id of FILTER_IDS) {
    const b = el('button', 'fp-filter');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    const c = el('canvas', 'fp-filter-thumb');
    c.width = THUMB_W;
    c.height = THUMB_H;
    b.append(c, el('span', 'fp-filter-name', filterLabel(id)));
    b.addEventListener('click', () => pickFilter(id));
    filterButtons.set(id, { btn: b, canvas: c });
    filterGrid.append(b);
  }
  const filterAmount = slider(L('filterAmount'), 0, 100, 100, 1, (v) => {
    if (session && session.kind === 'filter') { session.amount = v; previewSession(); }
  }, (v) => `${v}%`);
  const filterNote = el('p', 'fp-muted fp-small');
  pFilters.body.append(filterGrid, filterAmount.row, filterNote);

  /* export (quick) */
  const pExport = panel('export', L('exportTitle'), 'export');
  let quickFormat: ExportFormat = 'png';
  const quickFmt = segmented<ExportFormat>(L('exportFormat'), [
    { value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPG' }, { value: 'webp', label: 'WebP' },
  ], 'png', (f) => { quickFormat = f; });
  quickFmt.root.classList.add('fp-seg-fill');
  const quickExportBtn = button(L('exportTitle'), 'primary', 'export');
  const quickDownloadBtn = button(L('exportDownload'), 'secondary', 'download');
  const quickProject = button(L('saveProject'), 'ghost', 'save');
  pExport.body.append(quickFmt.root, quickExportBtn, quickDownloadBtn, quickProject, el('p', 'fp-muted fp-small', L('projectExtNote')));

  /* adjustments */
  const pAdjust = panel('adjust', L('adjustTitle'), 'sliders');
  const adjTarget = el('p', 'fp-muted fp-small');
  pAdjust.body.append(adjTarget);
  const adjSliders = new Map<AdjustKey, SliderHandle>();
  for (const g of ADJUST_GROUPS) {
    pAdjust.body.append(el('h3', 'fp-group-title', L(g.id === 'light' ? 'groupLight' : 'groupColor')));
    for (const k of g.keys) {
      const [min, max] = adjustRange(k);
      const s = slider(adjLabel(k), min, max, 0, 1, (v) => setAdjust(k, v), (v) => (v > 0 ? `+${v}` : String(v)));
      adjSliders.set(k, s);
      pAdjust.body.append(s.row);
    }
  }
  const invChk = checkbox(L('adjInvert'), false);
  const grayChk = checkbox(L('adjGrayscale'), false);
  invChk.input.addEventListener('change', () => setAdjustFlag('invert', invChk.input.checked));
  grayChk.input.addEventListener('change', () => setAdjustFlag('grayscale', grayChk.input.checked));
  pAdjust.body.append(invChk.row, grayChk.row);
  const adjActions = el('div', 'fp-row-end');
  const adjCancel = button(L('adjCancel'));
  const adjApply = button(L('adjApply'), 'primary', 'check');
  const adjAsLayer = button(L('adjAsLayer'), 'ghost', 'adjustLayer');
  adjActions.append(adjAsLayer, adjCancel, adjApply);
  pAdjust.body.append(adjActions);

  /* image (transform, resize) */
  const pImage = panel('image', L('imageTitle'), 'resize', true);
  const imgRot = el('div', 'fp-icon-row');
  const rotL = iconButton(L('rotateLeft'), 'rotateLeft');
  const rotR = iconButton(L('rotateRight'), 'rotateRight');
  const flH = iconButton(L('flipH'), 'flipH');
  const flV = iconButton(L('flipV'), 'flipV');
  imgRot.append(rotL, rotR, flH, flV);
  const freeAngle = numberInput(L('rotateFree'), -180, 180, 0, 0.5);
  const freeApply = button(L('apply'));
  const freeRow = el('div', 'fp-row');
  freeRow.append(field(L('rotateFree'), freeAngle), freeApply);
  const rw = numberInput(L('resizeWidth'), 1, 16384, 1);
  const rh = numberInput(L('resizeHeight'), 1, 16384, 1);
  const rLock = checkbox(L('resizeLock'), true);
  const rApply = button(L('resizeApply'));
  const resizeRow = el('div', 'fp-row');
  resizeRow.append(field(L('resizeWidth'), rw), field(L('resizeHeight'), rh));
  const infoDl = el('dl', 'fp-dl');
  const capsBtn = button(L('capTitle'), 'ghost', 'info');
  pImage.body.append(el('h3', 'fp-group-title', L('rotateTitle')), imgRot, freeRow,
    el('h3', 'fp-group-title', L('resizeTitle')), resizeRow, rLock.row, rApply, infoDl, capsBtn);

  /* history */
  const pHistory = panel('history', L('historyTitle'), 'history');
  const historyList = el('ol', 'fp-history');
  const memoryLine = el('p', 'fp-muted fp-small');
  pHistory.body.append(historyList, memoryLine);

  /* quick: crop & rotate */
  const pQCrop = panel('quickCrop', L('quickCropTitle'), 'crop');
  const ratioSeg = segmented<string>(L('cropAspect'), CROP_RATIOS.map((r) => ({ value: r.id, label: r.id === 'free' ? L('cropFree') : r.id })), 'free', (id) => setCropRatio(id));
  ratioSeg.root.classList.add('fp-seg-wrap');
  const qCropStart = button(L('cropTitle'), 'secondary', 'crop');
  const qCropApply = button(L('cropApply'), 'primary', 'check');
  const qCropCancel = button(L('cancel'));
  const qCropRow = el('div', 'fp-row-end');
  qCropRow.append(qCropCancel, qCropApply);
  const qRot = el('div', 'fp-icon-row');
  const qRotL = iconButton(L('rotateLeft'), 'rotateLeft');
  const qRotR = iconButton(L('rotateRight'), 'rotateRight');
  const qFlH = iconButton(L('flipH'), 'flipH');
  const qFlV = iconButton(L('flipV'), 'flipV');
  qRot.append(qRotL, qRotR, qFlH, qFlV);
  pQCrop.body.append(ratioSeg.root, qCropStart, qCropRow, el('h3', 'fp-group-title', L('rotateTitle')), qRot);

  /* quick: light */
  const pQAdjust = panel('quickAdjust', L('quickLight'), 'sliders');
  const qSliders = new Map<AdjustKey, SliderHandle>();
  for (const k of ['brightness', 'contrast', 'saturation'] as AdjustKey[]) {
    const s = slider(adjLabel(k), -100, 100, 0, 1, (v) => setAdjust(k, v), (v) => (v > 0 ? `+${v}` : String(v)));
    qSliders.set(k, s);
    pQAdjust.body.append(s.row);
  }
  const qAdjRow = el('div', 'fp-row-end');
  const qAdjCancel = button(L('adjCancel'));
  const qAdjApply = button(L('adjApply'), 'primary', 'check');
  qAdjRow.append(qAdjCancel, qAdjApply);
  pQAdjust.body.append(qAdjRow);

  /* "more" (phone) */
  const pMore = panel('more', L('navMore'), 'more');
  const moreList = el('div', 'fp-more');
  pMore.body.append(moreList);

  /* ───────────────────────────── dialogs ───────────────────────────── */

  const newDlg = modal(root, L('newTitle'), 'fp-dialog-wide');
  const projectDlg = modal(root, L('saveProjectAs'));
  const helpDlg = modal(root, L('shortcutsTitle'), 'fp-dialog-wide');
  const capsDlg = modal(root, L('limitsTitle'), 'fp-dialog-wide');
  const renameDlg = modal(root, L('layerRename'));
  const colorDlg = modal(root, L('optColor'), 'fp-dialog-picker');

  /* ─────────────────────────── helpers ─────────────────────────── */

  function say(message: string): void {
    statusEl.textContent = message;
  }

  function showError(message: string, retry?: () => void): void {
    banner.replaceChildren();
    banner.hidden = false;
    const text = el('p', 'fp-banner-text', message);
    const actions = el('div', 'fp-banner-actions');
    if (retry) {
      const r = button(L('errorRetry'), 'secondary');
      r.addEventListener('click', () => { banner.hidden = true; retry(); });
      actions.append(r);
    }
    const other = button(L('errorChooseAnother'), 'ghost', 'folderOpen');
    other.addEventListener('click', () => { banner.hidden = true; void openFromFiles(); });
    const close = iconButton(L('close'), 'close');
    close.addEventListener('click', () => { banner.hidden = true; });
    actions.append(other, close);
    banner.append(icon('info'), text, actions);
  }

  const isDirty = () => !!doc && doc !== savedDoc;

  function updateChrome(): void {
    const has = !!doc;
    root.dataset.view = mode === 'gallery' ? 'gallery' : has ? 'editor' : 'start';
    titleText.textContent = mode === 'gallery' ? L('galleryTitle') : has ? docName : L('appName');
    const dirty = isDirty();
    dirtyDot.hidden = !dirty;
    dirtyDot.setAttribute('aria-label', L('unsavedMark'));
    dirtyDot.title = L('unsavedMark');
    win.setTitle(has ? `${dirty ? '• ' : ''}${docName} — ${L('appName')}` : L('appName'));
    undoBtn.disabled = !has || !history.canUndo;
    redoBtn.disabled = !has || !history.canRedo;
    for (const b of [compareBtn, saveBtn, exportBtn, quickExportBtn, quickDownloadBtn, quickProject, zoomInBtn, zoomOutBtn, zoomLabel]) b.disabled = !has;
    statusInfo.textContent = doc ? `${L('statusSize', { w: doc.width, h: doc.height })} · ${L('statusLayers', { count: doc.layers.length })}` : '';
    zoomLabel.textContent = L('zoomValue', { value: Math.round(view.zoom * 100) });
    fgBtn.style.setProperty('--fp-chip', fg);
    bgBtn.style.setProperty('--fp-chip', bg);
  }

  /* ─────────────────────────── history ─────────────────────────── */

  /** Records the current document as a new undo step (no-op when nothing changed). */
  function commit(label: string): void {
    if (!doc) return;
    const cur = history.current()?.payload;
    if (cur === doc) { afterChange(); return; }
    history.push(label, doc, newBufferBytes(cur, doc));
    afterChange();
  }

  function afterChange(): void {
    if (tool === 'transform' && ft?.target === 'layer' && doc && ft.id !== doc.activeId && !gesture) initTransform();
    if (doc && selection && (selection.width !== doc.width || selection.height !== doc.height)) selection = null;
    requestRender();
    renderLayers();
    renderHistory();
    renderAdjustTarget();
    updateChrome();
    scheduleThumbs();
    if (tool === 'text' || tool === 'shape') scheduleOptions();
  }

  /**
   * The options bar is rebuilt on the next frame, never inside the event that changed the
   * document: a textarea's "change" fires during its own blur, and replacing it right then
   * throws in Chromium. A focused field inside the bar is left alone (the user is typing).
   */
  let optionsQueued = false;
  function scheduleOptions(): void {
    if (optionsQueued) return;
    optionsQueued = true;
    requestAnimationFrame(() => {
      optionsQueued = false;
      if (optionsBar.contains(document.activeElement) && document.activeElement !== document.body) return;
      renderOptions();
    });
  }

  /** Throws away uncommitted live changes (a cancelled gesture). */
  function revertLive(): void {
    const cur = history.current()?.payload;
    if (cur && doc !== cur) doc = cur;
  }

  function stepHistory(dir: 'undo' | 'redo'): void {
    if (!doc) return;
    if (session) cancelSession();
    abortGesture();
    revertLive();
    if (ft) { if (ft.target === 'layer') doc = ft.base; ft = null; }
    const next = dir === 'undo' ? history.undo() : history.redo();
    if (!next) { if (tool === 'transform') initTransform(); return; }
    doc = next;
    if (tool === 'transform') initTransform();
    afterChange();
    say(`${dir === 'undo' ? L('undo') : L('redo')}: ${history.current()?.label.split('#')[0] ?? ''}`);
  }

  function renderHistory(): void {
    historyList.replaceChildren();
    history.steps.forEach((step, index) => {
      const li = el('li');
      const b = el('button', 'fp-history-item', step.label.split('#')[0]);
      b.type = 'button';
      b.dir = 'auto';
      if (index === history.index) b.setAttribute('aria-current', 'step');
      if (index > history.index) b.classList.add('is-future');
      b.addEventListener('click', () => {
        if (session) cancelSession();
        abortGesture();
        const p = history.goTo(index);
        if (!p) return;
        doc = p;
        afterChange();
      });
      li.append(b);
      historyList.append(li);
    });
    historyList.querySelector('[aria-current]')?.scrollIntoView?.({ block: 'nearest' });
    memoryLine.textContent = L('historyMemory', {
      steps: history.length,
      size: formatSize(history.bytes, getLocale()),
      budget: formatSize(history.limitsValue.maxBytes, getLocale()),
    }) + (history.trimmed ? ` — ${L('historyTrimmed', { count: history.trimmed })}` : '');
  }

  /* ─────────────────────────── rendering ─────────────────────────── */

  const comp = canvas2d(1, 1);
  let checker: CanvasPattern | null = null;
  let renderQueued = false;
  let hover: Point | null = null;

  function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    if (checker) return checker;
    const { canvas, ctx: c } = canvas2d(16, 16);
    c.fillStyle = '#f1f2f4';
    c.fillRect(0, 0, 16, 16);
    c.fillStyle = '#d5d8de';
    c.fillRect(0, 0, 8, 8);
    c.fillRect(8, 8, 8, 8);
    checker = ctx.createPattern(canvas, 'repeat');
    return checker;
  }

  function requestRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderNow(); });
  }

  function viewportSize() {
    return { width: Math.max(1, viewport.clientWidth), height: Math.max(1, viewport.clientHeight) };
  }

  /* ─────────────────────────── rulers ─────────────────────────── */

  /** On unless the owner said otherwise; automatic keeps them off on a phone-width window. */
  function rulersVisible(): boolean {
    return rulersOn ?? viewportSize().width >= 560;
  }

  /**
   * The two ruler strips. Ticks are placed at SCREEN positions from `rulers.ts` (so they follow
   * the image through zoom and pan) while the numbers are the DOCUMENT pixels under them; the
   * cursor is the last pointer position, mouse or finger, so touch has an indicator too.
   */
  function drawRulers(): void {
    const on = rulersVisible() && !!doc;
    rulers.classList.toggle('is-off', !on);
    rulersBtn.setAttribute('aria-pressed', String(on));
    // The button says what pressing it does, so its name is honest in both states.
    const label = on ? L('rulersHide') : L('rulersShow');
    rulersBtn.setAttribute('aria-label', label);
    rulersBtn.title = label;
    if (!on) return;
    const vs = viewportSize();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const cs = getComputedStyle(rulers);
    const ink = cs.color || '#8b93a5';
    const accent = cs.getPropertyValue('--fp-ruler-accent').trim() || ink;
    const step = rulerStep(view.zoom);
    const stripH = rulerH.clientHeight || 20;
    const stripV = rulerV.clientWidth || 20;
    const prepare = (canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D => {
      const W = Math.max(1, Math.round(w * dpr));
      const H = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      const c = canvas.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      c.font = cs.font;
      c.direction = 'ltr';
      return c;
    };
    // horizontal ruler
    const ch = prepare(rulerH, vs.width, stripH);
    ch.textAlign = 'center';
    ch.textBaseline = 'top';
    for (const t of rulerTicks(vs.width, view.panX, view.zoom)) {
      const x = Math.round(t.pos) + 0.5;
      ch.strokeStyle = ink;
      ch.globalAlpha = t.major ? 0.8 : 0.35;
      ch.beginPath();
      ch.moveTo(x, t.major ? stripH - 9 : stripH - 5);
      ch.lineTo(x, stripH);
      ch.stroke();
      if (t.major) {
        ch.globalAlpha = 0.95;
        ch.fillStyle = ink;
        ch.fillText(formatTick(t.value, step), labelAnchor(x, vs.width, 12), 2);
      }
    }
    // vertical ruler
    const cv = prepare(rulerV, stripV, vs.height);
    cv.textBaseline = 'middle';
    for (const t of rulerTicks(vs.height, view.panY, view.zoom)) {
      const y = Math.round(t.pos) + 0.5;
      cv.strokeStyle = ink;
      cv.globalAlpha = t.major ? 0.8 : 0.35;
      cv.beginPath();
      cv.moveTo(t.major ? stripV - 9 : stripV - 5, y);
      cv.lineTo(stripV, y);
      cv.stroke();
    }
    // the vertical numbers rotate: a ruler reads bottom-to-top, and the digits stay LTR
    cv.globalAlpha = 0.95;
    cv.fillStyle = ink;
    cv.textAlign = 'center';
    for (const t of rulerTicks(vs.height, view.panY, view.zoom)) {
      if (!t.major) continue;
      cv.save();
      cv.translate(2, labelAnchor(Math.round(t.pos) + 0.5, vs.height, 12));
      cv.rotate(-Math.PI / 2);
      cv.textBaseline = 'top';
      cv.fillText(formatTick(t.value, step), 0, 0);
      cv.restore();
    }
    // the pointer indicator, on both strips
    if (cursorAt) {
      const cx = rulerCursor(cursorAt.x, vs.width);
      if (cx !== null) {
        ch.globalAlpha = 1;
        ch.strokeStyle = accent;
        ch.beginPath();
        ch.moveTo(Math.round(cx) + 0.5, 0);
        ch.lineTo(Math.round(cx) + 0.5, stripH);
        ch.stroke();
        ch.fillStyle = accent;
        ch.textAlign = cx > vs.width / 2 ? 'right' : 'left';
        ch.fillText(formatCursor(cursorAt.x, view.panX, view.zoom), cx > vs.width / 2 ? cx - 4 : cx + 4, 2);
      }
      const cy = rulerCursor(cursorAt.y, vs.height);
      if (cy !== null) {
        cv.globalAlpha = 1;
        cv.strokeStyle = accent;
        cv.beginPath();
        cv.moveTo(0, Math.round(cy) + 0.5);
        cv.lineTo(stripV, Math.round(cy) + 0.5);
        cv.stroke();
      }
    }
  }

  function renderNow(): void {
    const vs = viewportSize();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.round(vs.width * dpr);
    const H = Math.round(vs.height * dpr);
    for (const c of [displayCanvas, overlayCanvas, comp.canvas]) {
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    }
    const ctx = displayCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const shown = compareOn && originalDoc ? originalDoc : doc;
    if (shown) {
      if (autoFit && doc) view = fitView(doc, vs);
      const x0 = view.panX * dpr;
      const y0 = view.panY * dpr;
      const w = shown.width * view.zoom * dpr;
      const h = shown.height * view.zoom * dpr;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 24 * dpr;
      ctx.shadowOffsetY = 6 * dpr;
      ctx.fillStyle = '#e4e6ea';
      ctx.fillRect(x0, y0, w, h);
      ctx.restore();
      ctx.save();
      ctx.fillStyle = checkerPattern(ctx) ?? '#e4e6ea';
      ctx.fillRect(x0, y0, w, h);
      ctx.restore();
      const cctx = comp.ctx;
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, W, H);
      cctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, x0, y0);
      cctx.save();
      cctx.beginPath();
      cctx.rect(0, 0, shown.width, shown.height);
      cctx.clip();
      drawDoc(cctx, shown, cache, { overrides: shown === doc ? overrides : undefined, smooth: view.zoom < PIXELATED_ABOVE });
      cctx.restore();
      ctx.drawImage(comp.canvas, 0, 0);
    }
    zoomLabel.textContent = L('zoomValue', { value: Math.round(view.zoom * 100) });
    drawOverlay();
    drawRulers();
  }

  function drawOverlay(): void {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const ctx = overlayCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!doc || compareOn) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = (p: Point) => imageToScreen(view, p);
    const accent = '#C8894B';
    // selection: marching ants
    if (selection) {
      ctx.save();
      ctx.lineWidth = 1;
      const path = new Path2D();
      const o = selection.outline;
      if (o?.kind === 'rect') {
        const a = S({ x: o.rect.x, y: o.rect.y });
        path.rect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, o.rect.w * view.zoom, o.rect.h * view.zoom);
      } else if (o?.kind === 'ellipse') {
        const c = S({ x: o.rect.x + o.rect.w / 2, y: o.rect.y + o.rect.h / 2 });
        path.ellipse(c.x, c.y, Math.max(0.5, (o.rect.w / 2) * view.zoom), Math.max(0.5, (o.rect.h / 2) * view.zoom), 0, 0, Math.PI * 2);
      } else if (o?.kind === 'poly') {
        o.points.forEach((p, i) => { const q = S(p); if (i) path.lineTo(q.x, q.y); else path.moveTo(q.x, q.y); });
        path.closePath();
      } else {
        const tr = edgesFor(selection);
        for (let i = 0; i < tr.length; i += 4) {
          const a = S({ x: tr[i], y: tr[i + 1] });
          const b = S({ x: tr[i + 2], y: tr[i + 3] });
          path.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
          path.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
        }
      }
      ctx.strokeStyle = '#000';
      ctx.stroke(path);
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = -antsOffset;
      ctx.strokeStyle = '#fff';
      ctx.stroke(path);
      ctx.restore();
    }
    // in-progress gestures
    if (gesture?.kind === 'marquee' && gesture.to) {
      const r = rectFrom(gesture.from, gesture.to, gesture.square);
      const a = S({ x: r.x, y: r.y });
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (opts.selShape === 'ellipse') ctx.ellipse(a.x + (r.w * view.zoom) / 2, a.y + (r.h * view.zoom) / 2, (r.w * view.zoom) / 2, (r.h * view.zoom) / 2, 0, 0, Math.PI * 2);
      else ctx.rect(a.x, a.y, r.w * view.zoom, r.h * view.zoom);
      ctx.stroke();
      ctx.restore();
    }
    if (gesture?.kind === 'lasso' && gesture.points.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      gesture.points.forEach((p, i) => { const q = S(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      ctx.stroke();
      ctx.restore();
    }
    if (gesture?.kind === 'gradient' && gesture.to) {
      const a = S(gesture.from);
      const b = S(gesture.to);
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill(); ctx.stroke(); }
      ctx.restore();
    }
    // crop box
    if (tool === 'crop' && cropBox) {
      const a = S({ x: cropBox.x, y: cropBox.y });
      const w = cropBox.w * view.zoom;
      const h = cropBox.h * view.zoom;
      const d0 = S({ x: 0, y: 0 });
      ctx.save();
      ctx.fillStyle = 'rgba(8, 10, 18, 0.55)';
      ctx.beginPath();
      ctx.rect(d0.x, d0.y, doc.width * view.zoom, doc.height * view.zoom);
      ctx.rect(a.x, a.y, w, h);
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const f of [1 / 3, 2 / 3]) {
        ctx.moveTo(a.x + w * f, a.y); ctx.lineTo(a.x + w * f, a.y + h);
        ctx.moveTo(a.x, a.y + h * f); ctx.lineTo(a.x + w, a.y + h * f);
      }
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x, a.y, w, h);
      ctx.fillStyle = '#fff';
      for (const [hx, hy] of cropHandlePoints(a.x, a.y, w, h)) {
        ctx.beginPath();
        ctx.arc(hx, hy, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.stroke();
      }
      ctx.restore();
    }
    // active vector layer box
    const active = activeLayer(doc);
    if ((tool === 'move' || tool === 'text' || tool === 'shape') && active.kind !== 'raster' && active.visible) {
      const b = layerBounds(active, measureText);
      const a = S({ x: b.x, y: b.y });
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x - 2, a.y - 2, b.w * view.zoom + 4, b.h * view.zoom + 4);
      ctx.restore();
    }
    // free transform box and handles
    if (tool === 'transform' && ft) {
      const pts = ftCorners(ft.box, ft.cur).map(S);
      ctx.save();
      if (ft.target === 'selection' && selection) {
        const m = ftMatrix(ft.box, ft.cur);
        const tr = edgesFor(selection);
        const path = new Path2D();
        for (let i = 0; i < tr.length; i += 4) {
          const a = S(applyMatrix(m, { x: tr[i], y: tr[i + 1] }));
          const b = S(applyMatrix(m, { x: tr[i + 2], y: tr[i + 3] }));
          path.moveTo(a.x, a.y);
          path.lineTo(b.x, b.y);
        }
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = '#fff';
        ctx.stroke(path);
        ctx.setLineDash([]);
      }
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = accent;
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.stroke();
      const hs = handlePoints(ft.box, ft.cur, FT_ROTATE_GAP / view.zoom);
      const top = S(hs.find((h) => h.id === 'n')!);
      const rot = S(hs.find((h) => h.id === 'rotate')!);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(rot.x, rot.y);
      ctx.stroke();
      for (const h of hs) {
        const q = S(h);
        ctx.beginPath();
        if (h.id === 'rotate') ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
        else ctx.rect(q.x - 5, q.y - 5, 10, 10);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
    // brush cursor
    if (hover && (tool === 'brush' || tool === 'eraser' || tool === 'clone')) {
      const p = S(hover);
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, (opts.size / 2) * view.zoom), 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, (opts.size / 2) * view.zoom - 1), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (tool === 'clone' && cloneSource) {
      const p = S(cloneSource);
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x - 8, p.y); ctx.lineTo(p.x + 8, p.y);
      ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x, p.y + 8);
      ctx.stroke();
      ctx.restore();
    }
  }

  let edgeCache: { sel: Selection; segments: number[] } | null = null;
  function edgesFor(sel: Selection): number[] {
    if (edgeCache?.sel !== sel) edgeCache = { sel, segments: traceEdges(sel).segments };
    return edgeCache.segments;
  }

  let antsOffset = 0;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const antsTimer = window.setInterval(() => {
    if (!selection || reducedMotion || document.hidden) return;
    antsOffset = (antsOffset + 1) % 10;
    drawOverlay();
  }, 120);

  function cropHandlePoints(x: number, y: number, w: number, h: number): [number, number, CropHandle][] {
    return [
      [x, y, 'nw'], [x + w / 2, y, 'n'], [x + w, y, 'ne'], [x + w, y + h / 2, 'e'],
      [x + w, y + h, 'se'], [x + w / 2, y + h, 's'], [x, y + h, 'sw'], [x, y + h / 2, 'w'],
    ];
  }

  /* ─────────────────────────── view ─────────────────────────── */

  function setZoom(z: number, anchor?: Point): void {
    if (!doc) return;
    autoFit = false;
    const vs = viewportSize();
    view = zoomAbout(view, z, anchor ?? { x: vs.width / 2, y: vs.height / 2 });
    requestRender();
  }
  function fit(): void {
    autoFit = true;
    requestRender();
  }

  /* ─────────────────────────── layers panel ─────────────────────────── */

  const thumbs = new WeakMap<Layer, HTMLCanvasElement>();
  function layerThumb(layer: Layer): HTMLCanvasElement {
    let c = thumbs.get(layer);
    if (c || !doc) return c ?? canvas2d(1, 1).canvas;
    const size = 80;
    const made = canvas2d(size, size);
    const s = Math.min(size / doc.width, size / doc.height);
    const ox = (size - doc.width * s) / 2;
    const oy = (size - doc.height * s) / 2;
    made.ctx.setTransform(s, 0, 0, s, ox, oy);
    const m = layer.matrix;
    made.ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    if (layer.kind === 'adjust') {
      // No pixels of its own: a split light/dark swatch, the usual sign of an adjustment layer.
      made.ctx.setTransform(1, 0, 0, 1, 0, 0);
      made.ctx.fillStyle = '#1a1d26';
      made.ctx.fillRect(0, 0, size, size);
      made.ctx.fillStyle = '#E8ECF4';
      made.ctx.beginPath();
      made.ctx.arc(size / 2, size / 2, size * 0.3, -Math.PI / 2, Math.PI / 2);
      made.ctx.fill();
    } else drawLayerContent(made.ctx, layer, cache);
    c = made.canvas;
    c.className = 'fp-layer-thumb';
    thumbs.set(layer, c);
    return c;
  }

  const maskThumbs = new WeakMap<object, HTMLCanvasElement>();
  function maskThumb(layer: Layer): HTMLCanvasElement {
    const key = layer.mask as object;
    let c = maskThumbs.get(key);
    if (c) return c;
    const size = 80;
    const made = canvas2d(size, size);
    made.ctx.fillStyle = '#000';
    made.ctx.fillRect(0, 0, size, size);
    const mc = cache.mask(layer);
    if (mc) {
      const k = Math.min(size / mc.width, size / mc.height);
      made.ctx.drawImage(mc, (size - mc.width * k) / 2, (size - mc.height * k) / 2, mc.width * k, mc.height * k);
    }
    c = made.canvas;
    c.className = 'fp-layer-thumb';
    maskThumbs.set(key, c);
    return c;
  }

  let dragLayer: { id: string; startY: number; over: number } | null = null;

  function renderLayers(): void {
    layerList.replaceChildren();
    if (!doc) return;
    const active = activeLayer(doc);
    if (!active.mask) maskEdit = false;
    blendSel.value = active.blend;
    blendSel.disabled = active.kind === 'adjust';
    layerOpacity.set(Math.round(active.opacity * 100));
    maskRow.hidden = !active.mask;
    maskTarget.set(maskEdit ? 'mask' : 'layer');
    mApply.disabled = active.kind !== 'raster' || active.locked;
    mInvert.disabled = active.locked;
    mDelete.disabled = active.locked;
    lMask.disabled = !maskSize(active) || !!active.mask || active.locked;
    const count = doc.layers.length;
    for (let i = count - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      const li = el('li', 'fp-layer');
      li.dataset.id = layer.id;
      li.dataset.index = String(i);
      if (layer.id === active.id) li.classList.add('is-active');
      if (!layer.visible) li.classList.add('is-hidden');
      const eye = iconButton(layer.visible ? L('layerHide') : L('layerShow'), layer.visible ? 'eye' : 'eyeOff', 'fp-layer-eye');
      eye.setAttribute('aria-pressed', String(layer.visible));
      eye.addEventListener('click', () => {
        if (!doc) return;
        doc = updateLayer(doc, layer.id, { visible: !layer.visible });
        commit(L('hLayerProps'));
      });
      const pick = el('button', 'fp-layer-pick');
      pick.type = 'button';
      pick.setAttribute('aria-pressed', String(layer.id === active.id));
      pick.append(layerThumb(layer));
      const names = el('span', 'fp-layer-names');
      const name = el('span', 'fp-layer-name', layer.name);
      name.dir = 'auto';
      const kind = el('span', 'fp-layer-kind', `${L(layer.kind === 'raster' ? 'layerKindRaster' : layer.kind === 'text' ? 'layerKindText' : layer.kind === 'adjust' ? 'layerKindAdjust' : 'layerKindShape')}${layer.blend !== 'normal' ? ` · ${blendLabel(layer.blend)}` : ''}${layer.opacity < 1 ? ` · ${Math.round(layer.opacity * 100)}%` : ''}`);
      names.append(name, kind);
      pick.append(names);
      pick.addEventListener('click', () => {
        if (!doc) return;
        maskEdit = false;
        doc = setActive(doc, layer.id);
        if (history.current()?.payload !== doc) history.push(L('hLayerProps'), doc, 0, 'active');
        afterChange();
      });
      pick.addEventListener('dblclick', () => openRename(layer));
      // Drag to reorder: the grip is the whole row, pointer based so touch works too.
      pick.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dragLayer = { id: layer.id, startY: e.clientY, over: i };
      });
      const lock = iconButton(layer.locked ? L('layerUnlock') : L('layerLock'), layer.locked ? 'lock' : 'unlock', 'fp-layer-lock');
      lock.setAttribute('aria-pressed', String(layer.locked));
      lock.addEventListener('click', () => {
        if (!doc) return;
        doc = updateLayer(doc, layer.id, { locked: !layer.locked });
        commit(L('hLayerProps'));
      });
      li.append(eye, pick);
      if (layer.mask) {
        const mb = el('button', 'fp-layer-mask');
        mb.type = 'button';
        mb.setAttribute('aria-label', L('layerMaskThumb', { name: layer.name }));
        mb.title = `${L('layerMaskThumb', { name: layer.name })} — ${L('layerMaskEdit')}`;
        mb.setAttribute('aria-pressed', String(layer.id === active.id && maskEdit));
        mb.append(maskThumb(layer));
        mb.addEventListener('click', () => {
          if (!doc) return;
          maskEdit = true;
          doc = setActive(doc, layer.id);
          if (history.current()?.payload !== doc) history.push(L('hLayerProps'), doc, 0, 'active');
          afterChange();
          say(L('layerMaskHint'));
        });
        li.append(mb);
      }
      li.append(lock);
      layerList.append(li);
    }
    const idx = doc.layers.findIndex((l) => l.id === active.id);
    lUp.disabled = idx >= count - 1;
    lDown.disabled = idx <= 0;
    lMerge.disabled = idx <= 0;
    lDel.disabled = count <= 1 || active.locked;
    lFlatten.disabled = count <= 1;
  }

  window.addEventListener('pointermove', onLayerDragMove);
  window.addEventListener('pointerup', onLayerDragEnd);
  function onLayerDragMove(e: PointerEvent): void {
    if (!dragLayer || !doc) return;
    if (Math.abs(e.clientY - dragLayer.startY) < 8) return;
    layerList.classList.add('is-dragging');
    let target = dragLayer.over;
    for (const li of Array.from(layerList.children) as HTMLElement[]) {
      const r = li.getBoundingClientRect();
      li.classList.remove('drop-above', 'drop-below');
      if (e.clientY >= r.top && e.clientY <= r.bottom) {
        target = Number(li.dataset.index);
        li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
      }
    }
    dragLayer.over = target;
  }
  function onLayerDragEnd(): void {
    if (!dragLayer) return;
    const d = dragLayer;
    dragLayer = null;
    const moved = layerList.classList.contains('is-dragging');
    layerList.classList.remove('is-dragging');
    if (!doc || !moved) return;
    const next = moveLayerTo(doc, d.id, d.over);
    if (next !== doc) { doc = next; commit(L('hLayerOrder')); } else renderLayers();
  }

  function openRename(layer: Layer): void {
    renameDlg.body.replaceChildren();
    renameDlg.actions.replaceChildren();
    const input = el('input', 'fp-input');
    input.value = layer.name;
    input.dir = 'auto';
    input.setAttribute('aria-label', L('layerRename'));
    input.autofocus = true;
    renameDlg.body.append(input);
    const cancel = button(L('cancel'));
    const ok = button(L('apply'), 'primary');
    cancel.addEventListener('click', () => renameDlg.close());
    const done = () => {
      const v = input.value.trim().slice(0, 120);
      renameDlg.close();
      if (!doc || !v || v === layer.name) return;
      doc = updateLayer(doc, layer.id, { name: v });
      commit(L('hLayerProps'));
    };
    ok.addEventListener('click', done);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    renameDlg.actions.append(cancel, ok);
    renameDlg.open();
    queueMicrotask(() => input.select());
  }

  function blankLayer(): RasterLayer {
    return rasterLayer(blankTiled(doc!.width, doc!.height), nextLayerName(doc!, L('layerName')));
  }

  lAdd.addEventListener('click', () => { if (!doc) return; doc = addLayer(doc, blankLayer()); commit(L('hLayerAdd')); });
  lDup.addEventListener('click', () => { if (!doc) return; doc = duplicateLayer(doc, doc.activeId, L('layerCopySuffix')); commit(L('hLayerDup')); });
  lDel.addEventListener('click', () => {
    if (!doc) return;
    const a = activeLayer(doc);
    if (a.locked) { say(L('layerLocked', { name: a.name })); return; }
    doc = removeLayer(doc, a.id);
    commit(L('hLayerDelete'));
  });
  lUp.addEventListener('click', () => { if (!doc) return; const i = doc.layers.findIndex((l) => l.id === doc!.activeId); doc = moveLayerTo(doc, doc.activeId, i + 1); commit(L('hLayerOrder')); });
  lDown.addEventListener('click', () => { if (!doc) return; const i = doc.layers.findIndex((l) => l.id === doc!.activeId); doc = moveLayerTo(doc, doc.activeId, i - 1); commit(L('hLayerOrder')); });
  lMerge.addEventListener('click', () => mergeDown());
  lMask.addEventListener('click', () => {
    if (!doc) return;
    const a = activeLayer(doc);
    if (!maskSize(a)) { say(L('layerMaskNeedsLayer')); return; }
    const next = addLayerMask(doc, a.id, selection ? selectionForLayer(a) : null);
    if (next === doc) return;
    doc = next;
    maskEdit = true;
    commit(L('hMaskAdd'));
    say(L('layerMaskHint'));
  });
  mInvert.addEventListener('click', () => { if (!doc) return; doc = invertLayerMask(doc, doc.activeId); commit(L('hMaskInvert')); });
  mApply.addEventListener('click', () => { if (!doc) return; maskEdit = false; doc = applyLayerMask(doc, doc.activeId); commit(L('hMaskApply')); });
  mDelete.addEventListener('click', () => { if (!doc) return; maskEdit = false; doc = setLayerMask(doc, doc.activeId, null); commit(L('hMaskDelete')); });
  lAdj.addEventListener('click', () => addAdjustLayer({ ...NEUTRAL_ADJUST }));

  /** A non-destructive adjustment layer above the active one (masked by the selection). */
  function addAdjustLayer(params: AdjustParams): void {
    if (!doc) return;
    const layer = adjustLayer(params, doc.width, doc.height, nextLayerName(doc, L('layerAdjName')));
    doc = addLayer(doc, layer);
    if (selection) doc = addLayerMask(doc, layer.id, selectionForLayer(layer));
    maskEdit = false;
    commit(L('hAdjLayerAdd'));
  }
  lFlatten.addEventListener('click', () => flatten());

  /** Composites a set of layers into one full-canvas raster (identity matrix). */
  function rasterise(ids: Set<string>, includeHidden: boolean): PixelBuffer {
    const c = renderDoc({ ...doc!, layers: doc!.layers.map((l) => (ids.has(l.id) ? l : l)) }, cache, 1, { only: ids, includeHidden });
    return readCanvas(c);
  }

  function mergeDown(): void {
    if (!doc) return;
    const i = doc.layers.findIndex((l) => l.id === doc!.activeId);
    if (i <= 0) return;
    const upper = doc.layers[i];
    const lower = doc.layers[i - 1];
    if (lower.locked) { say(L('layerLocked', { name: lower.name })); return; }
    const lowerSolid = { ...lower, opacity: 1, blend: 'normal' as BlendMode, visible: true } as Layer;
    const tmp: PhotoDoc = { ...doc, layers: [lowerSolid, { ...upper, visible: upper.visible } as Layer] };
    const buf = readCanvas(renderDoc(tmp, cache, 1));
    const merged: RasterLayer = { ...rasterLayer(fromBuffer(buf), lower.name), opacity: lower.opacity, blend: lower.blend, visible: lower.visible };
    const layers = [...doc.layers];
    layers.splice(i - 1, 2, merged);
    doc = { ...doc, layers, activeId: merged.id };
    commit(L('hMerge'));
  }

  function flatten(): void {
    if (!doc || doc.layers.length < 2) return;
    const buf = readCanvas(renderDoc(doc, cache, 1));
    const bgLayer = rasterLayer(fromBuffer(buf), L('layerBackground'));
    doc = { ...doc, layers: [bgLayer], activeId: bgLayer.id };
    commit(L('hFlatten'));
  }
  void rasterise;

  /* ─────────────────────────── histogram & filter thumbs ─────────────────────────── */

  let thumbTimer = 0;
  function scheduleThumbs(): void {
    window.clearTimeout(thumbTimer);
    thumbTimer = window.setTimeout(updateThumbs, 280);
  }

  function visible(p: Panel): boolean {
    return p.section.isConnected && !p.body.hidden && p.section.offsetParent !== null;
  }

  function updateThumbs(): void {
    if (!doc) return;
    if (visible(pHist)) drawHistogram();
    if (visible(pFilters)) drawFilterThumbs();
  }

  function drawHistogram(): void {
    if (!doc) return;
    const s = proxyScale(doc.width, doc.height, 90_000);
    const src = readCanvas(renderDoc(doc, cache, s, { overrides }));
    const h = histogram(src);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round((histCanvas.clientWidth || 240) * dpr);
    const H = Math.round((histCanvas.clientHeight || 96) * dpr);
    histCanvas.width = W;
    histCanvas.height = H;
    const c = histCanvas.getContext('2d')!;
    c.clearRect(0, 0, W, H);
    if (!h.max) return;
    const peak = Math.log1p(h.max);
    const draw = (bins: Uint32Array, color: string) => {
      c.beginPath();
      c.moveTo(0, H);
      for (let i = 0; i < 256; i++) c.lineTo((i / 255) * W, H - (Math.log1p(bins[i]) / peak) * (H - 2));
      c.lineTo(W, H);
      c.closePath();
      c.fillStyle = color;
      c.fill();
    };
    c.globalCompositeOperation = 'lighter';
    draw(h.r, 'rgba(229, 72, 77, 0.55)');
    draw(h.g, 'rgba(61, 214, 140, 0.5)');
    draw(h.b, 'rgba(91, 141, 239, 0.6)');
    c.globalCompositeOperation = 'source-over';
    draw(h.l, 'rgba(200, 137, 75, 0.28)');
  }

  function drawFilterThumbs(): void {
    if (!doc) return;
    // The real image, once, at thumbnail size; every look is then the engine's own
    // `presetThumbnails` (the exact preset maths), and the effects run on the same copy.
    const s = Math.min(1, (THUMB_W * 1.5) / Math.max(doc.width, doc.height));
    const small = downscale(readCanvas(renderDoc(doc, cache, s)), THUMB_W);
    const scale = small.width / doc.width;
    const looks = presetThumbnails(small, THUMB_W);
    for (const [id, { canvas }] of filterButtons) {
      const out = looks.get(id) ?? applyFilter(small, id, 100, scale);
      const c = canvas.getContext('2d')!;
      canvas.width = THUMB_W;
      canvas.height = THUMB_H;
      c.clearRect(0, 0, THUMB_W, THUMB_H);
      const src = bufferCanvas(out);
      const k = Math.max(THUMB_W / out.width, THUMB_H / out.height);
      c.imageSmoothingQuality = 'high';
      c.drawImage(src, (THUMB_W - out.width * k) / 2, (THUMB_H - out.height * k) / 2, out.width * k, out.height * k);
    }
  }

  /* ─────────────────────────── adjust / filter sessions ─────────────────────────── */

  interface Session {
    kind: 'adjust' | 'filter';
    layerId: string;
    proxy: PixelBuffer;
    scale: number;
    mask: Uint8Array | null;
    canvas: HTMLCanvasElement;
    params: AdjustParams;
    filter: FilterId | null;
    amount: number;
  }
  let session: Session | null = null;
  let previewQueued = false;

  /** The selection mask in a layer's own pixel space (null = the whole layer). */
  function selectionForLayer(layer: Layer, scale = 1): Uint8Array | null {
    const size = maskSize(layer);
    if (!selection || !doc || !size) return null;
    const w = Math.max(1, Math.round(size.width * scale));
    const h = Math.max(1, Math.round(size.height * scale));
    const m = layer.matrix;
    if (scale === 1 && isTranslationOnly(m) && m[4] === 0 && m[5] === 0 && w === doc.width && h === doc.height) {
      return selection.mask;
    }
    const selCanvas = maskCanvas(selection);
    const { canvas, ctx } = canvas2d(w, h, true);
    const inv = invert(m);
    if (!inv) return new Uint8Array(w * h);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.transform(inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]);
    ctx.drawImage(selCanvas, 0, 0);
    const data = readCanvas(canvas).data;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3];
    return out;
  }

  let maskCanvasCache: { sel: Selection; canvas: HTMLCanvasElement } | null = null;
  function maskCanvas(sel: Selection): HTMLCanvasElement {
    if (maskCanvasCache?.sel === sel) return maskCanvasCache.canvas;
    const data = new Uint8ClampedArray(sel.width * sel.height * 4);
    for (let i = 0; i < sel.mask.length; i++) data[i * 4 + 3] = sel.mask[i];
    const canvas = bufferCanvas({ width: sel.width, height: sel.height, data });
    maskCanvasCache = { sel, canvas };
    return canvas;
  }

  function editableRaster(forAdjust: boolean): RasterLayer | null {
    if (!doc) return null;
    const a = activeLayer(doc);
    if (a.locked) { say(L('layerLocked', { name: a.name })); return null; }
    if (a.kind !== 'raster') {
      if (forAdjust) { say(L('layerAdjustNeedsRaster')); return null; }
      const layer = blankLayer();
      doc = addLayer(doc, layer);
      say(L('layerNeedsRaster', { name: a.name }));
      return layer;
    }
    return a;
  }

  function ensureSession(kind: Session['kind']): Session | null {
    if (session && session.kind === kind) return session;
    if (session) cancelSession();
    const layer = editableRaster(true);
    if (!layer) return null;
    const scale = proxyScale(layer.tiled.width, layer.tiled.height, 700_000);
    const base = cache.get(layer);
    const { canvas, ctx } = canvas2d(layer.tiled.width * scale, layer.tiled.height * scale, true);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
    const proxy = readCanvas(canvas);
    const mask = selectionForLayer(layer, canvas.width / layer.tiled.width);
    session = { kind, layerId: layer.id, proxy, scale: canvas.width / layer.tiled.width, mask, canvas, params: { ...NEUTRAL_ADJUST }, filter: null, amount: 100 };
    overrides.set(layer.id, { canvas, width: layer.tiled.width, height: layer.tiled.height });
    renderSessionUi();
    return session;
  }

  function previewSession(): void {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      if (!session) return;
      const s = session;
      const out = s.kind === 'adjust' ? adjust(s.proxy, s.params) : s.filter ? applyFilter(s.proxy, s.filter, s.amount, s.scale) : s.proxy;
      putBuffer(s.canvas.getContext('2d')!, mixMasked(s.proxy, out, s.mask));
      requestRender();
      scheduleThumbs();
    });
  }

  let adjCommitTimer = 0;
  function editAdjustLayer(patch: Partial<AdjustParams>): boolean {
    const a = doc && activeLayer(doc);
    if (!a || a.kind !== 'adjust' || !doc) return false;
    if (a.locked) { say(L('layerLocked', { name: a.name })); renderAdjustTarget(); return true; }
    doc = updateAdjust(doc, a.id, patch);
    requestRender();
    window.clearTimeout(adjCommitTimer);
    adjCommitTimer = window.setTimeout(() => commit(L('hAdjLayer')), 400);
    return true;
  }

  function setAdjust(k: AdjustKey, v: number): void {
    if (editAdjustLayer({ [k]: v })) { adjSliders.get(k)?.set(v); return; }
    const s = ensureSession('adjust');
    if (!s) { adjSliders.get(k)?.set(0); qSliders.get(k)?.set(0); return; }
    s.params = { ...s.params, [k]: v };
    adjSliders.get(k)?.set(v);
    qSliders.get(k)?.set(v);
    previewSession();
  }

  function setAdjustFlag(k: 'invert' | 'grayscale', v: boolean): void {
    if (editAdjustLayer({ [k]: v })) return;
    const s = ensureSession('adjust');
    if (!s) { invChk.input.checked = false; grayChk.input.checked = false; return; }
    s.params = { ...s.params, [k]: v };
    previewSession();
  }

  function pickFilter(id: FilterId): void {
    if (!doc) return;
    if (mode === 'quick') { void applyFilterNow(id); return; }
    const s = ensureSession('filter');
    if (!s) return;
    s.filter = id;
    s.amount = isSpatial(id) ? 50 : 100;
    filterAmount.set(s.amount);
    renderSessionUi();
    previewSession();
  }

  async function applyFilterNow(id: FilterId): Promise<void> {
    const s = ensureSession('filter');
    if (!s) return;
    s.filter = id;
    s.amount = isSpatial(id) ? 50 : 100;
    await applySession();
  }

  function resetSessionControls(): void {
    for (const s of adjSliders.values()) s.set(0);
    for (const s of qSliders.values()) s.set(0);
    invChk.input.checked = false;
    grayChk.input.checked = false;
    filterAmount.set(100);
  }

  function cancelSession(): void {
    if (!session) return;
    overrides.delete(session.layerId);
    session = null;
    resetSessionControls();
    renderSessionUi();
    requestRender();
    scheduleThumbs();
  }

  async function applySession(): Promise<void> {
    if (!session || !doc || busy) return;
    const s = session;
    const layer = layerById(doc, s.layerId);
    if (!layer || layer.kind !== 'raster') { cancelSession(); return; }
    const neutral = s.kind === 'adjust' ? isNeutralAdjust(s.params) : !s.filter || s.amount === 0;
    if (neutral) { cancelSession(); return; }
    busy = true;
    root.classList.add('is-busy');
    say(L('applying'));
    try {
      const mask = selectionForLayer(layer);
      const bounds = mask ? maskBounds(mask, layer.tiled.width, layer.tiled.height) : { x: 0, y: 0, w: layer.tiled.width, h: layer.tiled.height };
      if (!bounds) { cancelSession(); return; }
      // Spatial filters read a margin around the selection so blur has real neighbours.
      const pad = s.kind === 'filter' && s.filter && isSpatial(s.filter) ? 40 : 0;
      const region = clipRect({ x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 }, layer.tiled.width, layer.tiled.height)!;
      const src = readRegion(layer.tiled, region);
      const out = s.kind === 'adjust' ? await adjustAsync(src, s.params) : await filterAsync(src, s.filter!, s.amount);
      const mixed = mixMasked(src, out, maskRegion(mask, layer.tiled.width, region));
      const current = doc && layerById(doc, s.layerId);
      if (!doc || !current || current.kind !== 'raster') return;
      doc = setRaster(doc, s.layerId, writeRegion(current.tiled, region.x, region.y, mixed));
      overrides.delete(s.layerId);
      session = null;
      const label = s.kind === 'adjust' ? L('hAdjust') : L('hFilter', { name: filterLabel(s.filter!) });
      commit(label);
      resetSessionControls();
      renderSessionUi();
      say(L('appliedName', { name: s.kind === 'adjust' ? L('adjustTitle') : filterLabel(s.filter!) }));
    } catch (e) {
      showError(L('exportFailed', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      busy = false;
      root.classList.remove('is-busy');
    }
  }

  function renderSessionUi(): void {
    const active = !!session;
    adjApply.disabled = !(session?.kind === 'adjust');
    adjCancel.disabled = !(session?.kind === 'adjust');
    qAdjApply.disabled = adjApply.disabled;
    qAdjCancel.disabled = adjCancel.disabled;
    filterAmount.row.hidden = !(session?.kind === 'filter') || mode === 'quick';
    filterNote.textContent = mode === 'quick' ? L('quickFiltersHint') : session?.kind === 'filter' ? L('filterPreviewHint') : '';
    for (const [id, { btn }] of filterButtons) btn.setAttribute('aria-pressed', String(session?.filter === id));
    sessionBar.replaceChildren();
    sessionBar.hidden = !active;
    if (session) {
      const name = session.kind === 'adjust' ? L('adjustTitle') : session.filter ? filterLabel(session.filter) : L('filtersTitle');
      sessionBar.append(el('span', 'fp-session-name', name));
      const c = button(L('adjCancel'), 'secondary');
      c.addEventListener('click', cancelSession);
      const a = button(L('adjApply'), 'primary', 'check');
      a.addEventListener('click', () => void applySession());
      sessionBar.append(c, a);
    }
    renderAdjustTarget();
  }

  function renderAdjustTarget(): void {
    if (!doc) { adjTarget.textContent = ''; return; }
    const a = activeLayer(doc);
    adjCancel.hidden = adjApply.hidden = a.kind === 'adjust';
    adjAsLayer.hidden = a.kind === 'adjust';
    if (a.kind === 'adjust') {
      adjTarget.textContent = L('adjLayerTarget', { layer: a.name });
      for (const [k, sl] of adjSliders) sl.set(a.adjust[k]);
      invChk.input.checked = a.adjust.invert;
      grayChk.input.checked = a.adjust.grayscale;
      return;
    }
    if (!session) {
      for (const sl of adjSliders.values()) sl.set(0);
      invChk.input.checked = false;
      grayChk.input.checked = false;
    }
    adjTarget.textContent = selection ? L('adjTargetSel', { layer: a.name }) : L('adjTarget', { layer: a.name });
  }

  adjApply.addEventListener('click', () => void applySession());
  adjAsLayer.addEventListener('click', () => {
    const params = session?.kind === 'adjust' ? { ...session.params } : { ...NEUTRAL_ADJUST };
    if (session) cancelSession();
    addAdjustLayer(params);
  });
  qAdjApply.addEventListener('click', () => void applySession());
  adjCancel.addEventListener('click', cancelSession);
  qAdjCancel.addEventListener('click', cancelSession);

  /* ─────────────────────────── tools & options bar ─────────────────────────── */

  function setTool(id: ToolId): void {
    if (gesture) abortGesture();
    if (tool === 'crop' && id !== 'crop') cropBox = null;
    if (tool === 'transform' && id !== 'transform') applyTransform();
    tool = id;
    if (id === 'transform' && !initTransform()) { tool = 'move'; id = 'move'; say(L('transformNothing')); }
    for (const [key, b] of toolButtons) b.setAttribute('aria-pressed', String(key === id));
    if (id === 'crop' && doc) cropBox = centredAspect(doc, cropAspect);
    settingCloneSource = false;
    viewport.dataset.tool = id;
    renderOptions();
    renderNav();
    requestRender();
    const def = TOOLS.find((d) => d.id === id);
    if (def) say(L(def.hint));
  }

  function colorChip(label: string, get: () => string, set: (v: string) => void): HTMLButtonElement {
    const b = el('button', 'fp-color-chip');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.style.setProperty('--fp-chip', get());
    b.addEventListener('click', () => openColor(label, get(), (v) => { set(v); b.style.setProperty('--fp-chip', v); }));
    return b;
  }

  function optSlider(label: string, min: number, max: number, get: () => number, set: (v: number) => void, unit = ''): HTMLElement {
    const s = slider(label, min, max, get(), 1, set, (v) => `${v}${unit}`);
    s.row.classList.add('fp-opt-slider');
    return s.row;
  }

  function activeText(): TextLayer | null {
    const a = doc && activeLayer(doc);
    return a && a.kind === 'text' ? a : null;
  }
  function activeShape(): ShapeLayer | null {
    const a = doc && activeLayer(doc);
    return a && a.kind === 'shape' ? a : null;
  }

  function updateText(patch: Partial<TextSpec>, label = L('hTextEdit'), live = false): void {
    const layer = activeText();
    if (!layer || !doc) return;
    if (layer.locked) { say(L('layerLocked', { name: layer.name })); return; }
    const text = { ...layer.text, ...patch };
    const name = patch.text !== undefined ? (patch.text.split('\n')[0].slice(0, 40) || layer.name) : layer.name;
    doc = replaceLayer(doc, { ...layer, text, name });
    if (live) { requestRender(); return; }
    commit(label);
  }

  function updateShape(patch: Partial<ShapeLayer['shape']>): void {
    const layer = activeShape();
    if (!layer || !doc || layer.locked) return;
    doc = replaceLayer(doc, { ...layer, shape: { ...layer.shape, ...patch } });
    commit(L('hShapeEdit'));
  }

  let textArea: HTMLTextAreaElement | null = null;

  function renderOptions(): void {
    optionsBar.replaceChildren();
    if (mode !== 'pro' || !doc) return;
    const def = TOOLS.find((d) => d.id === tool)!;
    const name = el('span', 'fp-opt-tool');
    name.append(icon(def.icon), el('span', undefined, L(def.label)));
    optionsBar.append(name);
    const add = (...n: HTMLElement[]) => optionsBar.append(...n);
    switch (tool) {
      case 'brush':
      case 'eraser':
      case 'clone':
        add(optSlider(L('optSize'), 1, 400, () => opts.size, (v) => { opts.size = v; drawOverlay(); }, 'px'));
        add(optSlider(L('optHardness'), 0, 100, () => opts.hardness, (v) => { opts.hardness = v; }, '%'));
        add(optSlider(L('optOpacity'), 1, 100, () => opts.opacity, (v) => { opts.opacity = v; }, '%'));
        if (tool === 'brush') add(colorChip(L('optColor'), () => fg, (v) => setFg(v)));
        if (tool === 'clone') {
          const b = button(L('cloneSetSource'), settingCloneSource ? 'primary' : 'secondary', 'clone');
          b.setAttribute('aria-pressed', String(settingCloneSource));
          b.addEventListener('click', () => { settingCloneSource = !settingCloneSource; renderOptions(); say(L('hintCloneSource')); });
          add(b);
        }
        break;
      case 'bucket':
        add(colorChip(L('optColor'), () => fg, (v) => setFg(v)));
        add(optSlider(L('optTolerance'), 0, 255, () => opts.tolerance, (v) => { opts.tolerance = v; }));
        add(optSlider(L('optOpacity'), 1, 100, () => opts.opacity, (v) => { opts.opacity = v; }, '%'));
        add(toggle(L('optContiguous'), () => opts.contiguous, (v) => { opts.contiguous = v; }));
        break;
      case 'gradient': {
        add(colorChip(L('foreground'), () => fg, (v) => setFg(v)), colorChip(L('background'), () => bg, (v) => setBg(v)));
        const g = segmented(L('toolGradient'), [
          { value: 'linear', label: L('gradLinear') }, { value: 'radial', label: L('gradRadial') },
        ], opts.gradType, (v) => { opts.gradType = v; });
        add(g.root, toggle(L('gradToTransparent'), () => opts.gradToTransparent, (v) => { opts.gradToTransparent = v; }));
        add(optSlider(L('optOpacity'), 1, 100, () => opts.opacity, (v) => { opts.opacity = v; }, '%'));
        break;
      }
      case 'marquee':
      case 'lasso':
      case 'wand': {
        if (tool === 'marquee') {
          const sh = segmented(L('toolMarquee'), [
            { value: 'rect', label: L('shapeRectSel'), icon: 'marquee' as IconName },
            { value: 'ellipse', label: L('shapeEllipseSel'), icon: 'ellipseSel' as IconName },
          ], opts.selShape, (v) => { opts.selShape = v; });
          add(sh.root);
        }
        const m = segmented<SelectionMode>(L('optMode'), [
          { value: 'replace', label: L('selReplace') }, { value: 'add', label: L('selAdd') },
          { value: 'subtract', label: L('selSubtract') }, { value: 'intersect', label: L('selIntersect') },
        ], opts.selMode, (v) => { opts.selMode = v; });
        add(m.root);
        if (tool === 'wand') {
          add(optSlider(L('optTolerance'), 0, 255, () => opts.tolerance, (v) => { opts.tolerance = v; }));
          add(toggle(L('optContiguous'), () => opts.contiguous, (v) => { opts.contiguous = v; }));
          add(toggle(L('optSampleAll'), () => opts.sampleAll, (v) => { opts.sampleAll = v; }));
        }
        add(...selectionButtons());
        break;
      }
      case 'crop': {
        const r = segmented<string>(L('cropAspect'), CROP_RATIOS.map((x) => ({ value: x.id, label: x.id === 'free' ? L('cropFree') : x.id })),
          CROP_RATIOS.find((x) => x.value === cropAspect)?.id ?? 'free', (id) => setCropRatio(id));
        add(r.root);
        if (cropBox) add(el('span', 'fp-opt-readout', L('cropSize', { w: cropBox.w, h: cropBox.h })));
        const rl = iconButton(L('rotateLeft'), 'rotateLeft');
        rl.addEventListener('click', () => rotate(-1));
        const rr = iconButton(L('rotateRight'), 'rotateRight');
        rr.addEventListener('click', () => rotate(1));
        const fh = iconButton(L('flipH'), 'flipH');
        fh.addEventListener('click', () => flip('h'));
        const fv = iconButton(L('flipV'), 'flipV');
        fv.addEventListener('click', () => flip('v'));
        const c = button(L('cancel'));
        c.addEventListener('click', () => setTool('move'));
        const a = button(L('cropApply'), 'primary', 'check');
        a.addEventListener('click', applyCrop);
        add(rl, rr, fh, fv, el('span', 'fp-spacer'), c, a);
        break;
      }
      case 'text': {
        const layer = activeText();
        const spec = layer?.text;
        const ta = el('textarea', 'fp-input fp-textarea');
        ta.rows = 1;
        ta.dir = 'auto';
        ta.placeholder = L('textPlaceholder');
        ta.setAttribute('aria-label', L('textField'));
        ta.value = spec?.text ?? '';
        ta.disabled = !layer;
        ta.addEventListener('input', () => updateText({ text: ta.value }, L('hTextEdit'), true));
        ta.addEventListener('change', () => commit(L('hTextEdit')));
        textArea = ta;
        const font = selectInput(L('optFont'), FONT_IDS.map((f) => ({ value: f, label: L(`font${cap(f)}`) })), spec?.font ?? opts.font);
        font.addEventListener('change', () => { opts.font = font.value; updateText({ font: font.value }); });
        const size = numberInput(L('textSize'), 4, 2000, spec?.size ?? opts.fontSize);
        size.addEventListener('change', () => { const v = Math.max(4, Math.min(2000, Number(size.value) || 48)); opts.fontSize = v; updateText({ size: v }); });
        const bold = iconButton(L('optBold'), 'bold', 'fp-toggle');
        bold.setAttribute('aria-pressed', String(spec?.bold ?? opts.bold));
        bold.addEventListener('click', () => { opts.bold = !(spec?.bold ?? opts.bold); updateText({ bold: opts.bold }); renderOptions(); });
        const italic = iconButton(L('optItalic'), 'italic', 'fp-toggle');
        italic.setAttribute('aria-pressed', String(spec?.italic ?? opts.italic));
        italic.addEventListener('click', () => { opts.italic = !(spec?.italic ?? opts.italic); updateText({ italic: opts.italic }); renderOptions(); });
        const align = segmented<TextSpec['align']>(L('optAlign'), [
          { value: 'start', label: L('alignStart'), icon: 'alignStart' }, { value: 'center', label: L('alignCenter'), icon: 'alignCenter' },
          { value: 'end', label: L('alignEnd'), icon: 'alignEnd' },
        ], spec?.align ?? opts.align, (v) => { opts.align = v; updateText({ align: v }); });
        const dir = selectInput(L('optDirection'), [
          { value: 'auto', label: L('dirAuto') }, { value: 'rtl', label: L('dirRtl') }, { value: 'ltr', label: L('dirLtr') },
        ], spec?.direction ?? opts.direction);
        dir.addEventListener('change', () => { opts.direction = dir.value as TextSpec['direction']; updateText({ direction: opts.direction }); });
        const colour = colorChip(L('textColor'), () => activeText()?.text.color ?? fg, (v) => { setFg(v); updateText({ color: v }); });
        const outline = toggle(L('optOutline'), () => !!(spec?.outline ?? (opts.outline ? opts.strokeColor : null)), (v) => {
          opts.outline = v;
          updateText({ outline: v ? opts.strokeColor : null, outlineWidth: v ? Math.max(2, Math.round((spec?.size ?? 48) / 16)) : 0 });
        });
        add(ta, font, size, bold, italic, align.root, dir, colour, outline);
        break;
      }
      case 'shape': {
        const layer = activeShape();
        const spec = layer?.shape;
        const kind = segmented<ShapeKind>(L('toolShape'), [
          { value: 'rect', label: L('toolRect'), icon: 'rect' }, { value: 'ellipse', label: L('toolEllipse'), icon: 'ellipse' },
          { value: 'line', label: L('toolLine'), icon: 'line' }, { value: 'arrow', label: L('toolArrow'), icon: 'arrow' },
        ], spec?.shape ?? opts.shape, (v) => { opts.shape = v; updateShape({ shape: v }); });
        const fillOn = toggle(L('optFill'), () => (spec ? !!spec.fill : opts.shapeFill), (v) => { opts.shapeFill = v; updateShape({ fill: v ? fg : null }); });
        const fillC = colorChip(L('optFill'), () => spec?.fill ?? fg, (v) => { setFg(v); updateShape({ fill: v }); });
        const strokeOn = toggle(L('optStroke'), () => (spec ? !!spec.stroke : opts.shapeStroke), (v) => { opts.shapeStroke = v; updateShape({ stroke: v ? opts.strokeColor : null }); });
        const strokeC = colorChip(L('optStroke'), () => spec?.stroke ?? opts.strokeColor, (v) => { opts.strokeColor = v; updateShape({ stroke: v }); });
        const sw = optSlider(L('optStrokeWidth'), 1, 200, () => spec?.strokeWidth ?? opts.strokeWidth, (v) => { opts.strokeWidth = v; updateShapeLive({ strokeWidth: v }); }, 'px');
        const rad = optSlider(L('optRadius'), 0, 400, () => spec?.radius ?? opts.radius, (v) => { opts.radius = v; updateShapeLive({ radius: v }); }, 'px');
        add(kind.root, fillOn, fillC, strokeOn, strokeC, sw, rad);
        break;
      }
      case 'eyedropper':
        add(colorChip(L('foreground'), () => fg, (v) => setFg(v)), toggle(L('optSampleAll'), () => opts.sampleAll, (v) => { opts.sampleAll = v; }));
        break;
      case 'zoom':
      case 'hand': {
        const zo = iconButton(L('zoomOut'), 'zoomOut');
        zo.addEventListener('click', () => setZoom(zoomStop(view.zoom, -1)));
        const zi = iconButton(L('zoomIn'), 'zoomIn');
        zi.addEventListener('click', () => setZoom(zoomStop(view.zoom, 1)));
        const f = button(L('zoomFit'));
        f.addEventListener('click', fit);
        const a = button(L('zoomActual'));
        a.addEventListener('click', () => setZoom(1));
        add(zo, zi, f, a);
        break;
      }
      case 'move':
        add(...selectionButtons().slice(0, 1));
        break;
      case 'transform': {
        if (ft) {
          const r = ftReadout(ft.box, ft.cur);
          add(el('span', 'fp-opt-readout', L('transformSize', { w: r.w, h: r.h, angle: r.angle })));
        }
        const fh = iconButton(L('flipH'), 'flipH');
        fh.addEventListener('click', () => flipTransform('h'));
        const fv = iconButton(L('flipV'), 'flipV');
        fv.addEventListener('click', () => flipTransform('v'));
        const c = button(L('cancel'));
        c.addEventListener('click', cancelTransform);
        const a = button(L('transformApply'), 'primary', 'check');
        a.addEventListener('click', () => { applyTransform(); setTool('move'); });
        add(fh, fv, el('span', 'fp-spacer'), c, a);
        break;
      }
    }
    add(el('span', 'fp-opt-hint', L(def.hint)));
  }

  let shapeLiveTimer = 0;
  function updateShapeLive(patch: Partial<ShapeLayer['shape']>): void {
    const layer = activeShape();
    if (!layer || !doc || layer.locked) return;
    doc = replaceLayer(doc, { ...layer, shape: { ...layer.shape, ...patch } });
    requestRender();
    window.clearTimeout(shapeLiveTimer);
    shapeLiveTimer = window.setTimeout(() => commit(L('hShapeEdit')), 400);
  }

  function toggle(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const c = checkbox(label, get());
    c.row.classList.add('fp-opt-check');
    c.input.addEventListener('change', () => set(c.input.checked));
    return c.row;
  }

  function selectionButtons(): HTMLElement[] {
    const all = button(L('selectAll'), 'ghost');
    all.addEventListener('click', () => runCommand('selectAll'));
    const none = button(L('deselect'), 'ghost');
    none.disabled = !selection;
    none.addEventListener('click', () => runCommand('deselect'));
    const inv = button(L('invertSelection'), 'ghost');
    inv.addEventListener('click', () => runCommand('invertSelection'));
    const crop = button(L('cropToSelection'), 'ghost', 'crop');
    crop.disabled = !selection;
    crop.addEventListener('click', cropToSelection);
    const fill = button(L('fillSelection'), 'ghost', 'bucket');
    fill.disabled = !selection;
    fill.addEventListener('click', fillSelection);
    const del = button(L('deleteSelection'), 'ghost', 'trash');
    del.disabled = !selection;
    del.addEventListener('click', () => runCommand('delete'));
    return tool === 'move' ? [none] : [all, none, inv, crop, fill, del];
  }

  function setFg(v: string): void { fg = v; updateChrome(); }
  function setBg(v: string): void { bg = v; updateChrome(); }

  /* colour picker (modal on phones, the same card on desktop) */
  function openColor(label: string, value: string, onPick: (v: string) => void): void {
    colorDlg.title.textContent = label;
    colorDlg.body.replaceChildren();
    colorDlg.actions.replaceChildren();
    let v = value;
    const picker = colorPicker({ sv: L('pickerSv'), hue: L('pickerHue'), hex: L('pickerHex'), swatches: L('pickerSwatches') }, value, (c) => { v = c; onPick(c); });
    colorDlg.body.append(picker.root);
    const done = button(L('apply'), 'primary', 'check');
    done.addEventListener('click', () => { onPick(v); colorDlg.close(); });
    colorDlg.actions.append(done);
    colorDlg.open();
  }

  fgBtn.addEventListener('click', () => openColor(L('foreground'), fg, (v) => { setFg(v); renderOptions(); }));
  bgBtn.addEventListener('click', () => openColor(L('background'), bg, (v) => { setBg(v); renderOptions(); }));
  swapBtn.addEventListener('click', () => runCommand('swapColors'));

  /* ─────────────────────────── free transform ─────────────────────────── */

  /** Opens a free transform on the selection (when there is one) or the active layer. */
  function initTransform(): boolean {
    ft = null;
    if (!doc) return false;
    if (selection) {
      ft = { target: 'selection', id: '', box: { ...selection.bounds }, cur: { ...FT_IDENTITY }, base: doc };
      return true;
    }
    const a = activeLayer(doc);
    if (a.locked) return false;
    const box = layerBounds(a, measureText);
    if (!(box.w >= 1 && box.h >= 1)) return false;
    ft = { target: 'layer', id: a.id, box, cur: { ...FT_IDENTITY }, base: doc };
    return true;
  }

  function previewTransform(): void {
    if (!ft) return;
    if (ft.target === 'layer') {
      const l = layerById(ft.base, ft.id);
      if (l) doc = updateLayer(ft.base, ft.id, { matrix: tidy(multiply(ftMatrix(ft.box, ft.cur), l.matrix)) });
      requestRender();
    } else drawOverlay();
    if (tool === 'transform') renderOptions();
  }

  function applyTransform(): void {
    const t = ft;
    ft = null;
    if (!t || !doc || ftIsIdentity(t.cur)) return;
    if (t.target === 'layer') { commit(L('hTransform')); return; }
    if (!selection) return;
    const m = ftMatrix(t.box, t.cur);
    const { canvas, ctx } = canvas2d(doc.width, doc.height, true);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(maskCanvas(selection), 0, 0);
    const data = readCanvas(canvas).data;
    const mask = new Uint8Array(doc.width * doc.height);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3];
    selection = selectionFromMask(doc.width, doc.height, mask);
    afterSelection();
    say(L('hTransformSel'));
  }

  function cancelTransform(): void {
    if (ft?.target === 'layer') doc = ft.base;
    ft = null;
    setTool('move');
    requestRender();
  }

  function flipTransform(axis: 'h' | 'v'): void {
    if (!ft) return;
    ft.cur = axis === 'h' ? { ...ft.cur, sx: -ft.cur.sx } : { ...ft.cur, sy: -ft.cur.sy };
    previewTransform();
  }

  /* ─────────────────────────── crop ─────────────────────────── */

  function setCropRatio(id: string): void {
    if (!doc) return;
    cropAspect = CROP_RATIOS.find((r) => r.id === id)?.value ?? null;
    ratioSeg.set(id);
    if (tool !== 'crop') { setTool('crop'); return; }
    cropBox = centredAspect(doc, cropAspect);
    renderOptions();
    requestRender();
  }

  function applyCrop(): void {
    if (!doc || !cropBox) return;
    const r = cropBox;
    if (r.w < 1 || r.h < 1) { say(L('cropInvalid')); return; }
    doc = cropDoc(doc, r);
    selection = cropSelection(selection, r);
    cropBox = null;
    commit(L('hCrop'));
    fit();
    setTool(mode === 'quick' ? 'move' : 'move');
  }

  function rotate(dir: 1 | -1): void {
    if (!doc) return;
    doc = rotateDocQuarter(doc, dir);
    selection = null;
    commit(L('hRotate'));
    if (tool === 'crop') cropBox = centredAspect(doc, cropAspect);
    fit();
  }

  function flip(axis: 'h' | 'v'): void {
    if (!doc) return;
    doc = flipDoc(doc, axis);
    selection = null;
    commit(L('hFlip'));
  }

  /* ─────────────────────────── selection commands ─────────────────────────── */

  function cropToSelection(): void {
    if (!doc || !selection) { say(L('selectionNone')); return; }
    const r = selection.bounds;
    doc = cropDoc(doc, r);
    selection = null;
    commit(L('hCrop'));
    fit();
  }

  /** Fill (reveal) or delete (hide) the selection inside the active layer's mask. */
  function maskSelection(reveal: boolean): boolean {
    const t = maskEdit ? maskTarget_() : null;
    if (!t || !t.mask || !doc) return false;
    const m = selectionForLayer(t);
    const b = m && maskBounds(m, t.mask.width, t.mask.height);
    if (!b || !m) return true;
    const region = readRegion(t.mask, b);
    const mr = maskRegion(m, t.mask.width, b);
    const out = reveal ? fillMasked(region, mr, [255, 255, 255], 1) : clearMasked(region, mr);
    doc = setLayerMask(doc, t.id, writeRegion(t.mask, b.x, b.y, out));
    commit(L('hMaskPaint'));
    return true;
  }

  function fillSelection(): void {
    if (!doc || !selection) { say(L('selectionNone')); return; }
    if (maskSelection(true)) return;
    const layer = editableRaster(false);
    if (!layer) return;
    const mask = selectionForLayer(layer);
    const b = mask && maskBounds(mask, layer.tiled.width, layer.tiled.height);
    if (!b || !mask) return;
    const region = readRegion(layer.tiled, b);
    const out = fillMasked(region, maskRegion(mask, layer.tiled.width, b), hexRgb(fg), opts.opacity / 100);
    doc = setRaster(doc, layer.id, writeRegion(layer.tiled, b.x, b.y, out));
    commit(L('hFill'));
  }

  function deleteSelected(): void {
    if (!doc || !selection) { say(L('selectionNone')); return; }
    if (maskSelection(false)) return;
    const layer = editableRaster(true);
    if (!layer) return;
    const mask = selectionForLayer(layer);
    const b = mask && maskBounds(mask, layer.tiled.width, layer.tiled.height);
    if (!b || !mask) return;
    const out = clearMasked(readRegion(layer.tiled, b), maskRegion(mask, layer.tiled.width, b));
    doc = setRaster(doc, layer.id, writeRegion(layer.tiled, b.x, b.y, out));
    commit(L('hDelete'));
  }

  function copySelection(cut: boolean): void {
    if (!doc) return;
    const layer = activeLayer(doc);
    if (layer.kind !== 'raster') return;
    const mask = selectionForLayer(layer);
    const b = mask ? maskBounds(mask, layer.tiled.width, layer.tiled.height) : { x: 0, y: 0, w: layer.tiled.width, h: layer.tiled.height };
    if (!b) return;
    const region = readRegion(layer.tiled, b);
    const m = maskRegion(mask, layer.tiled.width, b);
    if (m) for (let i = 0; i < m.length; i++) region.data[i * 4 + 3] = (region.data[i * 4 + 3] * m[i]) / 255;
    const origin = applyMatrix(layer.matrix, { x: b.x, y: b.y });
    clipboard = { buf: region, x: Math.round(origin.x), y: Math.round(origin.y) };
    try {
      const Item = (window as unknown as { ClipboardItem?: new (d: Record<string, Blob>) => unknown }).ClipboardItem;
      if (Item && navigator.clipboard?.write) {
        void canvasToBytes(bufferCanvas(region), 'image/png').then((bytes) =>
          navigator.clipboard.write([new Item({ 'image/png': new Blob([bytes.slice()], { type: 'image/png' }) }) as ClipboardItem]),
        ).catch(() => {});
      }
    } catch { /* the in-app clipboard still works */ }
    say(L('copied'));
    if (cut) deleteSelected();
  }

  async function pasteBuffer(buf: PixelBuffer, at?: Point): Promise<void> {
    if (!doc) { newDocFromBuffer(buf, L('untitled'), 'pro'); return; }
    const layer = rasterLayer(fromBuffer(buf), nextLayerName(doc, L('layerName')), [1, 0, 0, 1,
      at ? at.x : Math.round((doc.width - buf.width) / 2), at ? at.y : Math.round((doc.height - buf.height) / 2)]);
    doc = addLayer(doc, layer);
    commit(L('hPaste'));
    say(L('pasted'));
    if (tool !== 'move') setTool('move');
  }

  root.addEventListener('paste', (e) => {
    if (isTyping(e.target)) return;
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
    e.preventDefault();
    if (file) {
      void file.arrayBuffer().then((ab) => decodeSource(new Uint8Array(ab), file.name || 'pasted.png'))
        .then((d) => pasteBuffer(d.buffer)).catch(() => say(L('nothingToPaste')));
    } else if (clipboard) void pasteBuffer(clipboard.buf, { x: clipboard.x, y: clipboard.y });
    else say(L('nothingToPaste'));
  });

  /* ─────────────────────────── pointer input ─────────────────────────── */

  type Gesture =
    | { kind: 'pan'; start: Point; view: View }
    | { kind: 'move'; start: Point; base: PhotoDoc; id: string; raster: boolean }
    | { kind: 'marquee'; from: Point; to: Point | null; square: boolean; mode: SelectionMode }
    | { kind: 'lasso'; points: Point[]; mode: SelectionMode }
    | { kind: 'crop'; handle: CropHandle; start: Point; box: Rect }
    | { kind: 'stroke'; s: StrokeState }
    | { kind: 'gradient'; from: Point; to: Point | null; layer: RasterLayer; work: HTMLCanvasElement }
    | { kind: 'shape'; from: Point; base: PhotoDoc; id: string }
    | { kind: 'ft'; handle: FtHandle; from: Point; start: FreeTransform };
  let gesture: Gesture | null = null;
  const pointers = new Map<number, Point>();
  let pinch: { base: View; a: Point; b: Point } | null = null;
  let spaceDown = false;

  function local(e: { clientX: number; clientY: number }): Point {
    const r = viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function abortGesture(): void {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    if (g.kind === 'stroke') overrides.delete(g.s.target === 'mask' ? `mask:${g.s.layerId}` : g.s.layerId);
    if (g.kind === 'gradient') overrides.delete(g.layer.id);
    if (g.kind === 'move' || g.kind === 'shape') doc = g.base;
    if (g.kind === 'ft' && ft) { ft.cur = g.start; previewTransform(); }
    requestRender();
  }

  viewport.addEventListener('contextmenu', (e) => e.preventDefault());

  viewport.addEventListener('pointerdown', (e) => {
    if (!doc || compareOn) return;
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      // Two fingers: whatever the first finger started is cancelled; pinch and pan instead.
      abortGesture();
      const [a, b] = [...pointers.values()];
      pinch = { base: view, a, b };
      autoFit = false;
      return;
    }
    if (pointers.size > 2 || busy) return;
    if (e.button === 1 || spaceDown || tool === 'hand' || (e.button === 0 && e.pointerType === 'mouse' && e.altKey && tool === 'move')) {
      gesture = { kind: 'pan', start: p, view };
      autoFit = false;
      viewport.classList.add('is-panning');
      return;
    }
    if (e.button !== 0) return;
    startTool(p, e);
  });

  viewport.addEventListener('pointermove', (e) => {
    const p = local(e);
    cursorAt = p;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (doc && e.pointerType === 'mouse') { hover = screenToImage(view, p); if (!gesture) drawOverlay(); }
    if (!gesture && !pinch && doc) drawRulers();
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      view = pinchView(pinch.base, { a: pinch.a, b: pinch.b }, { a, b });
      requestRender();
      return;
    }
    if (!gesture || !pointers.has(e.pointerId)) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    moveTool(p, e, events.length ? events.map((c) => local(c)) : [p]);
  });

  const endPointer = (e: PointerEvent, cancelled: boolean) => {
    const had = pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    if (!had || !gesture) return;
    if (cancelled) { abortGesture(); return; }
    endTool(local(e), e);
  };
  viewport.addEventListener('pointerup', (e) => endPointer(e, false));
  viewport.addEventListener('pointercancel', (e) => endPointer(e, true));
  viewport.addEventListener('pointerleave', () => { hover = null; cursorAt = null; drawOverlay(); drawRulers(); });

  viewport.addEventListener('wheel', (e) => {
    if (!doc) return;
    e.preventDefault();
    const p = local(e);
    if (e.ctrlKey || e.metaKey || (!e.shiftKey && Math.abs(e.deltaX) < 1 && e.deltaMode !== 0)) {
      setZoom(view.zoom * wheelFactor(e.deltaY, e.deltaMode), p);
    } else if (e.shiftKey) {
      autoFit = false;
      view = { ...view, panX: view.panX - (e.deltaY || e.deltaX) };
      requestRender();
    } else {
      autoFit = false;
      view = { ...view, panX: view.panX - e.deltaX, panY: view.panY - e.deltaY };
      requestRender();
    }
  }, { passive: false });

  viewport.addEventListener('dblclick', (e) => {
    if (!doc) return;
    const p = screenToImage(view, local(e));
    const hit = pickVectorLayer(doc, p, measureText);
    if (hit?.kind === 'text') {
      doc = setActive(doc, hit.id);
      setTool('text');
      afterChange();
      queueMicrotask(() => { textArea?.focus(); textArea?.select(); });
    }
  });

  function rectFrom(a: Point, b: Point, square: boolean): Rect {
    let w = b.x - a.x;
    let h = b.y - a.y;
    if (square) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
    return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h) };
  }

  function startTool(screen: Point, e: PointerEvent): void {
    if (!doc) return;
    const p = screenToImage(view, screen);
    switch (tool) {
      case 'move': {
        const hit = pickVectorLayer(doc, p, measureText);
        if (hit && hit.id !== doc.activeId) { doc = setActive(doc, hit.id); renderLayers(); }
        const layer = activeLayer(doc);
        if (layer.locked) { say(L('layerLocked', { name: layer.name })); return; }
        gesture = { kind: 'move', start: p, base: doc, id: layer.id, raster: layer.kind === 'raster' };
        return;
      }
      case 'zoom':
        setZoom(zoomStop(view.zoom, e.altKey ? -1 : 1), screen);
        return;
      case 'transform': {
        if (!ft && !initTransform()) return;
        const reach = (e.pointerType === 'touch' ? 26 : 12) / view.zoom;
        const handle = hitHandle(ft!.box, ft!.cur, p, reach, FT_ROTATE_GAP / view.zoom);
        if (handle) gesture = { kind: 'ft', handle, from: p, start: { ...ft!.cur } };
        return;
      }
      case 'marquee':
        gesture = { kind: 'marquee', from: p, to: null, square: e.shiftKey && opts.selMode === 'replace', mode: modeFromModifiers(opts.selMode, e.shiftKey, e.altKey) };
        return;
      case 'lasso':
        gesture = { kind: 'lasso', points: [p], mode: modeFromModifiers(opts.selMode, e.shiftKey, e.altKey) };
        return;
      case 'wand':
        wandAt(p, modeFromModifiers(opts.selMode, e.shiftKey, e.altKey));
        return;
      case 'crop': {
        if (!cropBox) cropBox = centredAspect(doc, cropAspect);
        const a = imageToScreen(view, { x: cropBox.x, y: cropBox.y });
        const w = cropBox.w * view.zoom;
        const h = cropBox.h * view.zoom;
        const reach = e.pointerType === 'touch' ? 26 : 14;
        let handle: CropHandle | null = null;
        for (const [hx, hy, id] of cropHandlePoints(a.x, a.y, w, h)) {
          if (Math.hypot(screen.x - hx, screen.y - hy) <= reach) { handle = id; break; }
        }
        if (!handle && screen.x > a.x && screen.x < a.x + w && screen.y > a.y && screen.y < a.y + h) handle = 'move';
        if (!handle) {
          // A drag outside the box draws a new one from that corner.
          const q = { x: Math.max(0, Math.min(doc.width, p.x)), y: Math.max(0, Math.min(doc.height, p.y)) };
          cropBox = { x: Math.round(q.x), y: Math.round(q.y), w: 1, h: 1 };
          handle = 'se';
        }
        gesture = { kind: 'crop', handle, start: p, box: { ...cropBox } };
        return;
      }
      case 'eyedropper':
        pickColorAt(p);
        return;
      case 'bucket':
        bucketAt(p);
        return;
      case 'text': {
        const hit = pickVectorLayer(doc, p, measureText);
        if (hit && hit.kind === 'text') {
          doc = setActive(doc, hit.id);
          afterChange();
          if (!hit.locked) gesture = { kind: 'move', start: p, base: doc, id: hit.id, raster: false };
          return;
        }
        const spec: TextSpec = {
          text: L('textDefault'), font: opts.font, size: Math.max(12, Math.round(opts.fontSize)), color: fg,
          bold: opts.bold, italic: opts.italic, align: opts.align, direction: opts.direction,
          outline: opts.outline ? opts.strokeColor : null, outlineWidth: opts.outline ? Math.max(2, Math.round(opts.fontSize / 16)) : 0,
        };
        const layer = textLayer(spec, { x: Math.round(p.x), y: Math.round(p.y - spec.size * 0.6) }, L('textDefault'));
        doc = addLayer(doc, layer);
        commit(L('hText'));
        renderOptions();
        queueMicrotask(() => { textArea?.focus(); textArea?.select(); });
        return;
      }
      case 'shape': {
        const hit = pickVectorLayer(doc, p, measureText);
        if (hit && hit.kind === 'shape') {
          doc = setActive(doc, hit.id);
          afterChange();
          if (!hit.locked) gesture = { kind: 'move', start: p, base: doc, id: hit.id, raster: false };
          return;
        }
        const base = doc;
        const layer = shapeLayer({
          shape: opts.shape, from: p, to: p, fill: opts.shapeFill && (opts.shape === 'rect' || opts.shape === 'ellipse') ? fg : null,
          stroke: opts.shapeStroke || opts.shape === 'line' || opts.shape === 'arrow' ? (opts.shape === 'line' || opts.shape === 'arrow' ? fg : opts.strokeColor) : null,
          strokeWidth: opts.strokeWidth, radius: opts.radius,
        }, `${L('toolShape')} ${doc.layers.length + 1}`);
        doc = addLayer(doc, layer);
        gesture = { kind: 'shape', from: p, base, id: layer.id };
        return;
      }
      case 'gradient': {
        const layer = editableRaster(false);
        if (!layer) return;
        const work = canvas2d(layer.tiled.width, layer.tiled.height).canvas;
        gesture = { kind: 'gradient', from: p, to: null, layer, work };
        return;
      }
      case 'brush':
      case 'eraser':
      case 'clone': {
        if (tool === 'clone' && (e.altKey || settingCloneSource)) {
          cloneSource = p;
          settingCloneSource = false;
          renderOptions();
          drawOverlay();
          return;
        }
        if (tool === 'clone' && !cloneSource) { say(L('hintClone')); return; }
        const s = beginStroke(p);
        if (s) gesture = { kind: 'stroke', s };
        return;
      }
      default:
    }
  }

  function moveTool(screen: Point, e: PointerEvent, trail: Point[]): void {
    if (!gesture || !doc) return;
    const p = screenToImage(view, screen);
    const g = gesture;
    switch (g.kind) {
      case 'pan':
        view = { ...g.view, panX: g.view.panX + screen.x - g.start.x, panY: g.view.panY + screen.y - g.start.y };
        requestRender();
        return;
      case 'move': {
        let dx = p.x - g.start.x;
        let dy = p.y - g.start.y;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (g.raster) { dx = Math.round(dx); dy = Math.round(dy); }
        doc = translateLayer(g.base, g.id, dx, dy);
        requestRender();
        return;
      }
      case 'ft':
        if (!ft) return;
        ft.cur = dragHandle(ft.box, g.start, g.handle, g.from, p, e.shiftKey);
        previewTransform();
        return;
      case 'marquee':
        g.to = p;
        g.square = e.shiftKey && g.mode === 'replace';
        drawOverlay();
        return;
      case 'lasso': {
        const last = g.points[g.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * view.zoom > 2) g.points.push(p);
        drawOverlay();
        return;
      }
      case 'crop':
        cropBox = dragCrop(g.box, g.handle, p.x - g.start.x, p.y - g.start.y, cropAspect, doc, 4);
        drawOverlay();
        return;
      case 'stroke':
        for (const q of trail) extendStroke(g.s, screenToImage(view, q));
        return;
      case 'gradient':
        g.to = p;
        paintGradient(g.layer, g.work, g.from, p);
        return;
      case 'shape': {
        const layer = layerById(doc, g.id);
        if (!layer || layer.kind !== 'shape') return;
        let to = p;
        if (e.shiftKey) {
          const dx = p.x - g.from.x;
          const dy = p.y - g.from.y;
          if (layer.shape.shape === 'line' || layer.shape.shape === 'arrow') {
            const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(dx, dy);
            to = { x: g.from.x + Math.cos(ang) * len, y: g.from.y + Math.sin(ang) * len };
          } else {
            const s = Math.max(Math.abs(dx), Math.abs(dy));
            to = { x: g.from.x + Math.sign(dx || 1) * s, y: g.from.y + Math.sign(dy || 1) * s };
          }
        }
        doc = replaceLayer(doc, { ...layer, shape: { ...layer.shape, to } });
        requestRender();
        return;
      }
    }
  }

  function endTool(screen: Point, _e: PointerEvent): void {
    const g = gesture;
    gesture = null;
    viewport.classList.remove('is-panning');
    if (!g || !doc) return;
    const p = screenToImage(view, screen);
    switch (g.kind) {
      case 'move':
        if (doc !== g.base) commit(L('hMove'));
        return;
      case 'marquee': {
        const r = g.to ? rectFrom(g.from, g.to, g.square) : null;
        if (!r || r.w * view.zoom < 3 || r.h * view.zoom < 3) {
          if (g.mode === 'replace') { selection = null; afterSelection(); }
          return;
        }
        const mask = opts.selShape === 'ellipse' ? ellipseMask(doc.width, doc.height, r) : rectMask(doc.width, doc.height, r);
        selection = combine(selection, doc.width, doc.height, mask, { kind: opts.selShape === 'ellipse' ? 'ellipse' : 'rect', rect: r }, g.mode);
        afterSelection();
        return;
      }
      case 'lasso': {
        if (g.points.length < 3) { if (g.mode === 'replace') { selection = null; afterSelection(); } return; }
        const mask = polygonMask(doc.width, doc.height, g.points);
        selection = combine(selection, doc.width, doc.height, mask, { kind: 'poly', points: g.points }, g.mode);
        afterSelection();
        return;
      }
      case 'crop':
        renderOptions();
        drawOverlay();
        return;
      case 'stroke':
        extendStroke(g.s, p);
        finishStroke(g.s);
        return;
      case 'gradient':
        if (g.to && Math.hypot(g.to.x - g.from.x, g.to.y - g.from.y) > 1) finishGradient(g.layer, g.work);
        else overrides.delete(g.layer.id);
        requestRender();
        return;
      case 'shape': {
        const layer = layerById(doc, g.id);
        if (!layer || layer.kind !== 'shape' || Math.hypot(layer.shape.to.x - layer.shape.from.x, layer.shape.to.y - layer.shape.from.y) * view.zoom < 4) {
          doc = g.base;
          requestRender();
          return;
        }
        commit(L('hShape'));
        return;
      }
      case 'pan':
    }
  }

  function afterSelection(): void {
    edgeCache = null;
    if (session) {
      const kind = session.kind;
      const params = session.params;
      const filter = session.filter;
      const amount = session.amount;
      cancelSession();
      const s = ensureSession(kind);
      if (s) { s.params = params; s.filter = filter; s.amount = amount; previewSession(); }
    }
    renderOptions();
    renderAdjustTarget();
    drawOverlay();
  }

  /* ─────────────────────────── painting ─────────────────────────── */

  interface StrokeState {
    layerId: string;
    /** 'mask': the stroke edits the layer's mask (white = reveal via source-over, black = hide via erase). */
    target: 'layer' | 'mask';
    kind: 'brush' | 'eraser' | 'clone';
    base: HTMLCanvasElement;
    work: HTMLCanvasElement;
    stroke: HTMLCanvasElement;
    inv: Matrix;
    last: Point;
    carry: number;
    dirty: Rect | null;
    tip: HTMLCanvasElement;
    radius: number;
    mask: HTMLCanvasElement | null;
    cloneOffset: Point | null;
    opacity: number;
    queued: Rect | null;
  }

  function brushTip(diameter: number, hardness: number, color: string): HTMLCanvasElement {
    const d = Math.max(1, Math.ceil(diameter));
    const { canvas, ctx } = canvas2d(d + 2, d + 2);
    const r = d / 2;
    const c = (d + 2) / 2;
    const [R, G, B] = hexRgb(color);
    const grad = ctx.createRadialGradient(c, c, 0, c, c, r);
    const h = Math.min(0.99, Math.max(0, hardness));
    grad.addColorStop(0, `rgba(${R},${G},${B},1)`);
    grad.addColorStop(h, `rgba(${R},${G},${B},1)`);
    grad.addColorStop(1, `rgba(${R},${G},${B},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fill();
    return canvas;
  }

  /** The active layer when its mask is the paint target (brush, eraser, fill, delete). */
  function maskTarget_(): Layer | null {
    const a = doc && activeLayer(doc);
    if (!a || !maskEdit || !a.mask) return null;
    if (a.locked) { say(L('layerLocked', { name: a.name })); return null; }
    return a;
  }

  function beginStroke(p: Point): StrokeState | null {
    const masked = maskEdit ? maskTarget_() : null;
    if (maskEdit && !masked) return null;
    if (masked && tool === 'clone') { say(L('layerMaskNoClone')); return null; }
    const layer = masked ?? editableRaster(false);
    if (!layer || !doc) return null;
    const inv = invert(layer.matrix);
    if (!inv) return null;
    const size = maskSize(layer)!;
    const lw = size.width;
    const lh = size.height;
    const base = masked ? cache.mask(masked)! : cache.get(layer as RasterLayer);
    const work = canvas2d(lw, lh).canvas;
    work.getContext('2d')!.drawImage(base, 0, 0);
    const stroke = canvas2d(lw, lh).canvas;
    const scale = scaleOf(layer.matrix) || 1;
    const radius = Math.max(0.5, opts.size / 2 / scale);
    let mask: HTMLCanvasElement | null = null;
    if (selection) {
      const m = selectionForLayer(layer);
      if (m) {
        const data = new Uint8ClampedArray(lw * lh * 4);
        for (let i = 0; i < m.length; i++) data[i * 4 + 3] = m[i];
        mask = bufferCanvas({ width: lw, height: lh, data });
      }
    }
    const kind = masked
      ? (maskPaintHides(tool === 'eraser' ? bg : fg) ? 'eraser' : 'brush')
      : tool === 'eraser' ? 'eraser' : tool === 'clone' ? 'clone' : 'brush';
    const lp = applyMatrix(inv, p);
    const s: StrokeState = {
      layerId: layer.id, target: masked ? 'mask' : 'layer', kind, base, work, stroke, inv, last: lp, carry: 0, dirty: null,
      tip: brushTip(radius * 2, opts.hardness / 100, masked ? '#ffffff' : kind === 'brush' ? fg : '#000000'), radius, mask,
      cloneOffset: kind === 'clone' && cloneSource ? (() => { const c = applyMatrix(inv, cloneSource); return { x: c.x - lp.x, y: c.y - lp.y }; })() : null,
      opacity: opts.opacity / 100, queued: null,
    };
    overrides.set(masked ? `mask:${layer.id}` : layer.id, { canvas: work, width: lw, height: lh });
    dab(s, lp);
    flushStroke(s);
    return s;
  }

  function dab(s: StrokeState, lp: Point): void {
    const ctx = s.stroke.getContext('2d')!;
    const size = s.tip.width;
    const x = lp.x - size / 2;
    const y = lp.y - size / 2;
    if (s.kind === 'clone' && s.cloneOffset) {
      const { canvas: d, ctx: dc } = canvas2d(size, size);
      dc.drawImage(s.tip, 0, 0);
      dc.globalCompositeOperation = 'source-in';
      dc.drawImage(s.base, -(x + s.cloneOffset.x), -(y + s.cloneOffset.y));
      ctx.drawImage(d, x, y);
    } else {
      ctx.drawImage(s.tip, x, y);
    }
    const r: Rect = { x: Math.floor(x), y: Math.floor(y), w: size + 2, h: size + 2 };
    s.queued = unionRect(s.queued, r);
  }

  function extendStroke(s: StrokeState, p: Point): void {
    const lp = applyMatrix(s.inv, p);
    const spacing = Math.max(0.5, s.radius * 2 * 0.12);
    const { points, carry } = dabsAlong(s.last, lp, spacing, s.carry);
    for (const q of points) dab(s, q);
    s.carry = carry;
    s.last = lp;
    flushStroke(s);
  }

  /** Re-composites only the dirty rectangle of the working layer canvas. */
  function flushStroke(s: StrokeState): void {
    if (!s.queued) return;
    const r = clipRect(s.queued, s.work.width, s.work.height);
    s.queued = null;
    if (!r) return;
    s.dirty = unionRect(s.dirty, r);
    if (s.mask) {
      const sc = s.stroke.getContext('2d')!;
      sc.save();
      sc.globalCompositeOperation = 'destination-in';
      sc.drawImage(s.mask, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      sc.restore();
    }
    const w = s.work.getContext('2d')!;
    w.save();
    w.clearRect(r.x, r.y, r.w, r.h);
    w.drawImage(s.base, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    w.globalAlpha = s.opacity;
    w.globalCompositeOperation = s.kind === 'eraser' ? 'destination-out' : 'source-over';
    w.drawImage(s.stroke, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    w.restore();
    requestRender();
  }

  function finishStroke(s: StrokeState): void {
    overrides.delete(s.target === 'mask' ? `mask:${s.layerId}` : s.layerId);
    if (!doc || !s.dirty) { requestRender(); return; }
    if (s.target === 'mask') {
      const ml = layerById(doc, s.layerId);
      if (!ml?.mask) return;
      const region = readRegion(ml.mask, s.dirty);
      const out = compositeStroke(region, readCanvas(s.stroke, s.dirty), s.opacity, s.kind === 'eraser');
      doc = setLayerMask(doc, ml.id, writeRegion(ml.mask, s.dirty.x, s.dirty.y, out));
      commit(L('hMaskPaint'));
      return;
    }
    const layer = layerById(doc, s.layerId);
    if (!layer || layer.kind !== 'raster') return;
    const r = s.dirty;
    const region = readRegion(layer.tiled, r);
    const strokePix = readCanvas(s.stroke, r);
    const out = compositeStroke(region, strokePix, s.opacity, s.kind === 'eraser');
    doc = setRaster(doc, layer.id, writeRegion(layer.tiled, r.x, r.y, out));
    commit(L(s.kind === 'brush' ? 'hBrush' : s.kind === 'eraser' ? 'hEraser' : 'hClone'));
  }

  function paintGradient(layer: RasterLayer, work: HTMLCanvasElement, from: Point, to: Point): void {
    const ctx = work.getContext('2d')!;
    const inv = invert(layer.matrix);
    if (!inv) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, work.width, work.height);
    // stroke layer = the gradient itself (masked), then shown over the layer at opacity
    const g = canvas2d(work.width, work.height);
    g.ctx.setTransform(inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]);
    const grad = opts.gradType === 'radial'
      ? g.ctx.createRadialGradient(from.x, from.y, 0, from.x, from.y, Math.max(1, Math.hypot(to.x - from.x, to.y - from.y)))
      : g.ctx.createLinearGradient(from.x, from.y, to.x, to.y);
    const [r2, g2, b2] = hexRgb(bg);
    grad.addColorStop(0, fg);
    grad.addColorStop(1, opts.gradToTransparent ? `rgba(${hexRgb(fg).join(',')},0)` : `rgb(${r2},${g2},${b2})`);
    g.ctx.fillStyle = grad;
    const corners = [[0, 0], [work.width, 0], [0, work.height], [work.width, work.height]].map(([x, y]) => applyMatrix(layer.matrix, { x, y }));
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    g.ctx.fillRect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (selection) {
      const m = selectionForLayer(layer);
      if (m) {
        const data = new Uint8ClampedArray(work.width * work.height * 4);
        for (let i = 0; i < m.length; i++) data[i * 4 + 3] = m[i];
        g.ctx.setTransform(1, 0, 0, 1, 0, 0);
        g.ctx.globalCompositeOperation = 'destination-in';
        g.ctx.drawImage(bufferCanvas({ width: work.width, height: work.height, data }), 0, 0);
      }
    }
    (work as HTMLCanvasElement & { gradientLayer?: HTMLCanvasElement }).gradientLayer = g.canvas;
    ctx.drawImage(cache.get(layer), 0, 0);
    ctx.globalAlpha = opts.opacity / 100;
    ctx.drawImage(g.canvas, 0, 0);
    ctx.globalAlpha = 1;
    overrides.set(layer.id, { canvas: work, width: work.width, height: work.height });
    requestRender();
    drawOverlay();
  }

  function finishGradient(layer: RasterLayer, work: HTMLCanvasElement): void {
    overrides.delete(layer.id);
    const g = (work as HTMLCanvasElement & { gradientLayer?: HTMLCanvasElement }).gradientLayer;
    if (!doc || !g) return;
    const current = layerById(doc, layer.id);
    if (!current || current.kind !== 'raster') return;
    const full = { x: 0, y: 0, w: current.tiled.width, h: current.tiled.height };
    const out = compositeStroke(readRegion(current.tiled, full), readCanvas(g), opts.opacity / 100, false);
    doc = setRaster(doc, current.id, writeRegion(current.tiled, 0, 0, out));
    commit(L('hGradient'));
  }

  function bucketAt(p: Point): void {
    const layer = editableRaster(false);
    if (!layer || !doc) return;
    const inv = invert(layer.matrix);
    if (!inv) return;
    const lp = applyMatrix(inv, p);
    const full = { x: 0, y: 0, w: layer.tiled.width, h: layer.tiled.height };
    const buf = readRegion(layer.tiled, full);
    const flood = floodMask(buf, lp.x, lp.y, opts.tolerance, opts.contiguous);
    if (!flood) return;
    const mask = intersectMasks(flood.mask, selectionForLayer(layer));
    const b = maskBounds(mask, full.w, full.h);
    if (!b) return;
    const out = fillMasked(readRegion(layer.tiled, b), maskRegion(mask, full.w, b), hexRgb(fg), opts.opacity / 100);
    doc = setRaster(doc, layer.id, writeRegion(layer.tiled, b.x, b.y, out));
    commit(L('hFill'));
  }

  function sampleBuffer(): PixelBuffer {
    if (!doc) return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    if (opts.sampleAll) return readCanvas(renderDoc(doc, cache, 1));
    return readCanvas(renderDoc(doc, cache, 1, { only: new Set([doc.activeId]), includeHidden: true }));
  }

  function wandAt(p: Point, m: SelectionMode): void {
    if (!doc) return;
    const flood = floodMask(sampleBuffer(), p.x, p.y, opts.tolerance, opts.contiguous);
    if (!flood) return;
    selection = m === 'replace' ? selectionFromMask(doc.width, doc.height, flood.mask) : combine(selection, doc.width, doc.height, flood.mask, null, m);
    afterSelection();
  }

  function pickColorAt(p: Point): void {
    if (!doc) return;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    const { canvas, ctx } = canvas2d(1, 1, true);
    ctx.setTransform(1, 0, 0, 1, -x, -y);
    drawDoc(ctx, opts.sampleAll ? doc : { ...doc, layers: [activeLayer(doc)] }, cache, { overrides });
    const d = readCanvas(canvas).data;
    if (d[3] === 0) return;
    const hex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    setFg(hex);
    renderOptions();
    say(L('colorPicked', { color: hex }));
  }

  function hexRgb(hex: string): [number, number, number] {
    const s = hex.replace('#', '');
    return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
  }

  /* ─────────────────────────── commands & keyboard ─────────────────────────── */

  function isTyping(target: EventTarget | null): boolean {
    const n = target as HTMLElement | null;
    if (!n) return false;
    const tag = n.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = (n as HTMLInputElement).type;
      return !['range', 'checkbox', 'button', 'radio', 'color'].includes(type);
    }
    return n.isContentEditable;
  }

  function runCommand(c: Command): void {
    switch (c) {
      case 'undo': stepHistory('undo'); return;
      case 'redo': stepHistory('redo'); return;
      case 'new': openNewDialog(); return;
      case 'open': void openFromFiles(); return;
      case 'save': void saveProject(false); return;
      case 'saveAs': void saveProject(true); return;
      case 'export': openExport(); return;
      case 'zoomFit': fit(); return;
      case 'zoom100': setZoom(1); return;
      case 'zoomIn': setZoom(zoomStop(view.zoom, 1)); return;
      case 'zoomOut': setZoom(zoomStop(view.zoom, -1)); return;
      case 'selectAll': if (doc) { selection = selectAll(doc.width, doc.height); afterSelection(); } return;
      case 'deselect': selection = null; afterSelection(); return;
      case 'invertSelection': if (doc) { selection = invertSelection(selection, doc.width, doc.height); afterSelection(); } return;
      case 'delete': deleteSelected(); return;
      case 'copy': copySelection(false); return;
      case 'cut': copySelection(true); return;
      case 'paste': return; // handled by the native paste event (it carries the clipboard image)
      case 'swapColors': { const f = fg; setFg(bg); setBg(f); renderOptions(); return; }
      case 'resetColors': setFg('#000000'); setBg('#ffffff'); renderOptions(); return;
      case 'brushSmaller': opts.size = Math.max(1, Math.round(opts.size / 1.2)); renderOptions(); drawOverlay(); return;
      case 'brushBigger': opts.size = Math.min(400, Math.round(opts.size * 1.2) + 1); renderOptions(); drawOverlay(); return;
      case 'apply':
        if (tool === 'crop') applyCrop();
        else if (tool === 'transform') { applyTransform(); setTool('move'); }
        else if (session) void applySession();
        return;
      case 'cancel':
        if (gesture) abortGesture();
        else if (tool === 'transform') cancelTransform();
        else if (session) cancelSession();
        else if (tool === 'crop') setTool('move');
        else if (selection) { selection = null; afterSelection(); }
        return;
      case 'help': openHelp(); return;
      case 'duplicateLayer': lDup.click(); return;
      case 'newLayer': lAdd.click(); return;
    }
  }

  root.addEventListener('keydown', (e) => {
    // The shared Save as / Export dialog owns the keyboard while it is open.
    if (win.content.querySelector('.faisal-saveas-overlay') || newDlg.isOpen() || helpDlg.isOpen()) return;
    if (isTyping(e.target)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    if (e.key === ' ' && mode !== 'gallery') {
      e.preventDefault();
      if (!spaceDown) { spaceDown = true; viewport.classList.add('is-space'); }
      return;
    }
    if (tool === 'move' && doc && e.key.startsWith('Arrow') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
      const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      doc = translateLayer(doc, doc.activeId, dx, dy);
      commit(L('hMove'));
      return;
    }
    const action = matchShortcut(e);
    if (!action) return;
    if (mode === 'gallery' && !(action.kind === 'command' && ['open', 'new', 'help'].includes(action.command))) return;
    if (action.kind === 'command' && (action.command === 'copy' || action.command === 'cut') && !doc) return;
    if (action.kind === 'command' && action.command === 'paste') return; // let the paste event fire
    if (action.kind === 'command' && action.command === 'cancel' && !gesture && !session && tool !== 'crop' && tool !== 'transform' && !selection) return;
    e.preventDefault();
    e.stopPropagation();
    if (action.kind === 'tool') {
      if (!doc || mode !== 'pro') return;
      setTool(action.tool);
    } else runCommand(action.command);
  });
  root.addEventListener('keyup', (e) => {
    if (e.key === ' ') { spaceDown = false; viewport.classList.remove('is-space'); }
  });

  /* ─────────────────────────── modes & layout ─────────────────────────── */

  function placePanels(): void {
    closeSheet();
    left.replaceChildren();
    inspector.replaceChildren();
    if (mode === 'pro') {
      left.append(pHist.section, pLayers.section, pFilters.section);
      inspector.append(pExport.section, pAdjust.section, pImage.section, pHistory.section);
    } else if (mode === 'quick') {
      inspector.append(pQCrop.section, pQAdjust.section, pFilters.section, pExport.section);
    }
  }

  function setMode(m: Mode): void {
    if (session) cancelSession();
    abortGesture();
    mode = m;
    root.dataset.mode = m;
    modeSeg.set(m);
    placePanels();
    if (m === 'gallery') void gallery.refresh();
    else gallery.closeViewer();
    if (m === 'quick' && tool !== 'crop' && tool !== 'move') setTool('move');
    renderOptions();
    renderNav();
    renderSessionUi();
    updateChrome();
    requestRender();
    scheduleThumbs();
    renderStart();
  }

  /* phone: sheets and the bottom bar */
  let sheetOpen: PanelId | null = null;
  let sheetHome: { parent: HTMLElement; next: Node | null } | null = null;
  let sheetEsc: (() => void) | null = null;

  function openSheet(id: PanelId): void {
    if (sheetOpen === id) { closeSheet(); return; }
    closeSheet();
    const node = id === 'tools' ? toolsBar : panels.get(id)?.section;
    if (!node) return;
    sheetHome = node.parentElement ? { parent: node.parentElement, next: node.nextSibling } : null;
    sheetOpen = id;
    sheetTitle.textContent = id === 'tools' ? L('navTools') : panels.get(id)!.title;
    sheet.setAttribute('aria-label', sheetTitle.textContent);
    sheetBody.replaceChildren(node);
    if (id !== 'tools') { panels.get(id)!.body.hidden = false; }
    sheet.hidden = false;
    root.dataset.sheet = id;
    sheetEsc = pushEscapeLayer(() => { sheetEsc = null; closeSheet(); });
    renderNav();
    scheduleThumbs();
    requestRender();
  }

  function closeSheet(): void {
    if (!sheetOpen) return;
    const node = sheetBody.firstElementChild as HTMLElement | null;
    if (node && sheetHome) sheetHome.parent.insertBefore(node, sheetHome.next && sheetHome.next.parentNode === sheetHome.parent ? sheetHome.next : null);
    else if (node === toolsBar) root.insertBefore(toolsBar, stage);
    sheetHome = null;
    sheetOpen = null;
    sheet.hidden = true;
    delete root.dataset.sheet;
    sheetEsc?.();
    sheetEsc = null;
    renderNav();
    requestRender();
  }
  sheetClose.addEventListener('click', closeSheet);
  let sheetDrag: number | null = null;
  sheetHead.addEventListener('pointerdown', (e) => { sheetDrag = e.clientY; });
  sheetHead.addEventListener('pointerup', (e) => { if (sheetDrag !== null && e.clientY - sheetDrag > 40) closeSheet(); sheetDrag = null; });

  function renderNav(): void {
    bottomBar.replaceChildren();
    if (mode === 'gallery' || !doc) return;
    const items: { id: PanelId; label: string; icon: IconName }[] = mode === 'pro'
      ? [
          { id: 'tools', label: L('navTools'), icon: TOOLS.find((d) => d.id === tool)?.icon ?? 'move' },
          { id: 'adjust', label: L('navAdjust'), icon: 'sliders' },
          { id: 'filters', label: L('navFilters'), icon: 'sparkle' },
          { id: 'layers', label: L('navLayers'), icon: 'layers' },
          { id: 'more', label: L('navMore'), icon: 'more' },
        ]
      : [
          { id: 'quickCrop', label: L('navCrop'), icon: 'crop' },
          { id: 'quickAdjust', label: L('navAdjust'), icon: 'sliders' },
          { id: 'filters', label: L('navFilters'), icon: 'sparkle' },
          { id: 'export', label: L('navExport'), icon: 'export' },
        ];
    for (const it of items) {
      const b = el('button', 'fp-nav-btn');
      b.type = 'button';
      b.append(icon(it.icon), el('span', 'fp-nav-label', it.label));
      b.setAttribute('aria-pressed', String(sheetOpen === it.id));
      b.addEventListener('click', () => openSheet(it.id));
      bottomBar.append(b);
    }
  }

  function renderMore(): void {
    moreList.replaceChildren();
    const item = (label: string, ic: IconName, fn: () => void) => {
      const b = button(label, 'ghost', ic);
      b.classList.add('fp-more-item');
      b.addEventListener('click', () => { closeSheet(); fn(); });
      moreList.append(b);
    };
    item(L('compare'), 'compare', () => compareBtn.click());
    item(L('historyTitle'), 'history', () => openSheet('history'));
    item(L('histogramTitle'), 'histogram', () => openSheet('histogram'));
    item(L('imageTitle'), 'resize', () => openSheet('image'));
    item(L('exportTitle'), 'export', () => openExport());
    item(L('saveProject'), 'save', () => void saveProject(false));
    item(L('openFile'), 'folderOpen', () => void openFromFiles());
    item(L('newCanvas'), 'newFile', () => openNewDialog());
    item(L('shortcutsTitle'), 'help', () => openHelp());
    item(L('limitsTitle'), 'info', () => openCaps());
  }
  renderMore();

  const layoutObserver = new ResizeObserver(() => {
    const compact = root.clientWidth <= 760;
    if (compact !== (root.dataset.compact === '1')) {
      if (compact) root.dataset.compact = '1';
      else { delete root.dataset.compact; closeSheet(); }
      renderNav();
    }
    requestRender();
  });
  layoutObserver.observe(root);
  const viewportObserver = new ResizeObserver(() => requestRender());
  viewportObserver.observe(viewport);

  /* ─────────────────────────── menu ─────────────────────────── */

  const menu = el('div', 'fp-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  root.append(menu);
  let menuEsc: (() => void) | null = null;
  function menuItem(label: string, ic: IconName, keys: string, fn: () => void): void {
    const b = el('button', 'fp-menu-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(icon(ic), el('span', 'fp-menu-label', label), el('span', 'fp-menu-keys', keys));
    b.addEventListener('click', () => { closeMenu(); fn(); });
    menu.append(b);
  }
  menuItem(L('newCanvas'), 'newFile', 'Ctrl+N', () => openNewDialog());
  menuItem(L('startOpen'), 'folderOpen', 'Ctrl+O', () => void openFromFiles());
  menuItem(L('startDevice'), 'device', '', () => openFromDevice());
  menuItem(L('startGallery'), 'grid', '', () => setMode('gallery'));
  menuItem(L('saveProject'), 'save', 'Ctrl+S', () => void saveProject(false));
  menuItem(L('saveProjectAs'), 'save', 'Ctrl+Shift+S', () => void saveProject(true));
  menuItem(L('exportTitle'), 'export', 'Ctrl+Shift+E', () => openExport());
  menuItem(L('shortcutsTitle'), 'help', 'F1', () => openHelp());
  menuItem(L('limitsTitle'), 'info', '', () => openCaps());
  function openMenu(): void {
    for (const b of Array.from(menu.querySelectorAll<HTMLButtonElement>('.fp-menu-item')).slice(4, 7)) b.disabled = !doc;
    menu.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    menuEsc = pushEscapeLayer(() => { menuEsc = null; closeMenu(); });
    menu.querySelector<HTMLElement>('.fp-menu-item')?.focus();
  }
  function closeMenu(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    menuEsc?.();
    menuEsc = null;
  }
  menuBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  root.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== menuBtn && !menuBtn.contains(e.target as Node)) closeMenu();
  });
  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('.fp-menu-item:not(:disabled)'));
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });

  /* ─────────────────────────── start screen ─────────────────────────── */

  function renderStart(): void {
    startScreen.replaceChildren();
    if (doc || mode === 'gallery') return;
    const hero = el('div', 'fp-start-hero');
    const logo = el('span', 'fp-start-logo');
    logo.append(icon('image'));
    hero.append(logo, el('h1', 'fp-start-title', L('startTitle')), el('p', 'fp-muted', L('startSubtitle')));
    const cards = el('div', 'fp-start-cards');
    const card = (ic: IconName, title: string, hint: string, fn: () => void, primary = false) => {
      const b = el('button', `fp-card${primary ? ' is-primary' : ''}`);
      b.type = 'button';
      const i = el('span', 'fp-card-icon');
      i.append(icon(ic));
      b.append(i, el('span', 'fp-card-title', title), el('span', 'fp-card-hint', hint));
      b.addEventListener('click', fn);
      cards.append(b);
    };
    card('newFile', L('startNew'), L('startNewHint'), openNewDialog, true);
    card('folderOpen', L('startOpen'), L('startOpenHint'), () => void openFromFiles());
    card('device', L('startDevice'), L('startDeviceHint'), openFromDevice);
    card('grid', L('startGallery'), L('startGalleryHint'), () => setMode('gallery'));
    const recentBox = el('section', 'fp-recent');
    recentBox.append(el('h2', 'fp-section-title', L('recentTitle')));
    if (!recent.length) {
      recentBox.append(el('p', 'fp-muted', L('recentEmpty')));
    } else {
      const list = el('ul', 'fp-recent-list');
      for (const r of recent) {
        const li = el('li');
        const b = el('button', 'fp-recent-item');
        b.type = 'button';
        const th = el('span', 'fp-recent-thumb');
        th.append(icon(isProjectPath(r.path) ? 'layers' : 'image'));
        const txt = el('span', 'fp-recent-text');
        const n = el('span', 'fp-recent-name', r.name);
        n.dir = 'auto';
        const pth = el('span', 'fp-recent-path', `${dirnameOf(r.path)} · ${new Date(r.at).toLocaleDateString(getLocale() === 'ar' ? 'ar' : 'en')}`);
        pth.dir = 'ltr';
        txt.append(n, pth);
        b.append(th, txt);
        b.addEventListener('click', () => void openPath(r.path));
        li.append(b);
        list.append(li);
        if (isImagePath(r.path)) {
          void vfs.stat(r.path).then((st) => thumbnail(vfs, st, 64)).then((c) => { if (c) { c.className = 'fp-thumb-canvas'; th.replaceChildren(c); } }).catch(() => {});
        }
      }
      recentBox.append(list);
    }
    startScreen.append(hero, cards, el('p', 'fp-muted fp-drop-hint', L('dropHint')), recentBox);
  }

  function rememberRecent(path: string): void {
    recent = pushRecent(recent, path, Date.now());
    saveRecent(recent);
  }

  /* ─────────────────────────── opening ─────────────────────────── */

  function describeFailure(error: unknown, named: string): string {
    if (error instanceof ProjectError) {
      const map: Record<ProjectError['reason'], string> = {
        'not-json': 'projectNotJson', 'wrong-format': 'projectWrongFormat', 'newer-version': 'projectNewer',
        'bad-layer': 'projectBadLayer', 'too-large': 'projectTooLarge',
      };
      return L(map[error.reason]);
    }
    if (error instanceof DecodeRefusal) {
      if (error.reason === 'too-large') return refusalText('too-large', sys.locale(), '24,000,000');
      return refusalText(error.reason, sys.locale(), named);
    }
    const code = (error as { code?: string })?.code;
    if (code === 'ENOENT') return refusalText('decode-failed', sys.locale(), named);
    if (error instanceof Error && error.message) return error.message;
    return L('errorUnknown');
  }

  function installDoc(next: PhotoDoc, name: string, label: string): void {
    if (session) cancelSession();
    abortGesture();
    cache.clear();
    overrides.clear();
    doc = next;
    history = new History<PhotoDoc>(HISTORY_PRESETS[0]);
    history.push(label, next, newBufferBytes(null, next));
    savedDoc = next;
    originalDoc = next;
    selection = null;
    docName = name;
    compareOn = false;
    compareBtn.setAttribute('aria-pressed', 'false');
    autoFit = true;
    banner.hidden = true;
    cropBox = null;
    cloneSource = null;
    const r = next.width;
    rw.value = String(r);
    rh.value = String(next.height);
    afterChange();
    renderStart();
    renderNav();
    renderOptions();
    renderInfo();
  }

  async function openPath(path: string, targetMode?: Mode): Promise<boolean> {
    if (busy) return false;
    const name = basenameOf(path);
    const named = path.slice(path.lastIndexOf('.') + 1) || path;
    if (!(await confirmDiscard())) return false;
    busy = true;
    root.classList.add('is-busy');
    say(L('busyOpening', { name }));
    try {
      if (isProjectPath(path)) {
        const next = await parseProject(await vfs.readText(path), PNG_CODEC);
        projectPath = path;
        sourcePath = null;
        installDoc(next, name, L('hOpen'));
      } else {
        const decoded = await decodeSource(await vfs.readFile(path), path);
        projectPath = null;
        sourcePath = path;
        installDoc(docFromBuffer(decoded.buffer, L('layerBackground')), name, L('hOpen'));
        if (decoded.note === 'scaled') say(L('openScaled'));
      }
      rememberRecent(path);
      setMode(targetMode ?? (mode === 'gallery' ? 'pro' : mode));
      if (!statusEl.textContent || statusEl.textContent === L('busyOpening', { name })) say(L('statusReady'));
      return true;
    } catch (error) {
      if ((error as { code?: string })?.code === 'ENOENT') {
        recent = removeRecent(recent, path);
        saveRecent(recent);
        renderStart();
        say(L('recentMissing', { name }));
      }
      showError(L('errorFile', { name, reason: describeFailure(error, named) }), () => void openPath(path, targetMode));
      say('');
      return false;
    } finally {
      busy = false;
      root.classList.remove('is-busy');
    }
  }

  function newDocFromBuffer(buf: PixelBuffer, name: string, m: Mode): void {
    projectPath = null;
    sourcePath = null;
    installDoc(docFromBuffer(buf, L('layerBackground')), name, L('hNew'));
    setMode(m === 'gallery' ? 'pro' : m);
  }

  async function openFromFiles(): Promise<void> {
    const start = sourcePath ? dirnameOf(sourcePath) : projectPath ? dirnameOf(projectPath) : PICTURES;
    const path = await pickFile(root, vfs, { mode: 'open', start });
    if (path) await openPath(path);
  }

  let importTarget: 'open' | 'gallery' = 'open';
  function openFromDevice(): void {
    importTarget = 'open';
    fileInput.multiple = false;
    fileInput.value = '';
    fileInput.click();
  }

  async function openFile(file: File, targetMode?: Mode): Promise<void> {
    if (!(await confirmDiscard())) return;
    busy = true;
    root.classList.add('is-busy');
    say(L('busyOpening', { name: file.name }));
    try {
      if (file.name.toLowerCase().endsWith(PROJECT_EXT)) {
        const next = await parseProject(await file.text(), PNG_CODEC);
        projectPath = null;
        sourcePath = null;
        installDoc(next, file.name, L('hOpen'));
      } else {
        const decoded = await decodeSource(new Uint8Array(await file.arrayBuffer()), file.name);
        projectPath = null;
        sourcePath = null;
        installDoc(docFromBuffer(decoded.buffer, L('layerBackground')), file.name, L('hOpen'));
      }
      setMode(targetMode ?? (mode === 'gallery' ? 'pro' : mode));
      say(L('statusReady'));
    } catch (error) {
      showError(L('errorFile', { name: file.name, reason: describeFailure(error, file.name.slice(file.name.lastIndexOf('.') + 1)) }));
    } finally {
      busy = false;
      root.classList.remove('is-busy');
    }
  }

  async function importToPictures(files: File[]): Promise<void> {
    say(L('importing'));
    await vfs.mkdir(PICTURES, { recursive: true }).catch(() => {});
    let existing: string[] = [];
    try { existing = (await vfs.readdir(PICTURES)).map((e) => e.path); } catch { existing = []; }
    let count = 0;
    for (const f of files) {
      if (!isImagePath(f.name)) continue;
      const safe = f.name.replace(/[/\\]/g, '_').replace(/^\.+/, '') || 'image.png';
      let target = `${PICTURES}/${safe}`;
      if (existing.includes(target)) {
        const dot = safe.lastIndexOf('.');
        const stem = dot > 0 ? safe.slice(0, dot) : safe;
        const ext = dot > 0 ? safe.slice(dot) : '';
        for (let n = 2; existing.includes(target); n++) target = `${PICTURES}/${stem} ${n}${ext}`;
      }
      try {
        await vfs.writeFile(target, new Uint8Array(await f.arrayBuffer()));
        existing.push(target);
        count++;
      } catch (error) {
        showError(L('exportFailed', { reason: (error as { code?: string })?.code === 'EINVAL' ? L('exportQuota') : String((error as Error)?.message ?? error) }));
        break;
      }
    }
    say(L('galleryImported', { count }));
    await gallery.refresh();
  }

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    if (!files.length) return;
    if (importTarget === 'gallery') void importToPictures(files);
    else void openFile(files[0]);
  });

  async function confirmDiscard(): Promise<boolean> {
    if (!isDirty()) return true;
    return shellConfirm({
      title: L('discardTitle'), message: L('discardBody'), okLabel: L('discardOk'), cancelLabel: L('discardCancel'), danger: true,
    });
  }

  /* drag & drop onto the window */
  root.addEventListener('dragover', (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const ext = [...dt.types].includes('Files');
    if (!ext && !isInternalDrag(dt)) return;
    e.preventDefault();
    dt.dropEffect = 'copy';
    dropOverlay.hidden = false;
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) dropOverlay.hidden = true;
  });
  root.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    dropOverlay.hidden = true;
    if (!dt) return;
    const internal = isInternalDrag(dt);
    const files = Array.from(dt.files ?? []);
    if (!internal && !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (internal) {
      const path = dragPaths(dt).find((p) => isImagePath(p) || isProjectPath(p));
      if (path) void openPath(path);
      return;
    }
    if (mode === 'gallery') void importToPictures(files);
    else void openFile(files[0]);
  });

  /* ─────────────────────────── new canvas ─────────────────────────── */

  function openNewDialog(): void {
    newDlg.body.replaceChildren();
    newDlg.actions.replaceChildren();
    const grid = el('div', 'fp-preset-grid');
    let w = 1080;
    let h = 1080;
    const wIn = numberInput(L('widthLabel'), 1, 16384, w);
    const hIn = numberInput(L('heightLabel'), 1, 16384, h);
    const presetButtons: HTMLButtonElement[] = [];
    const labels: Record<string, string> = { square: 'presetSquare', story: 'presetStory', hd: 'presetHd', a4: 'presetA4', web: 'presetWeb' };
    for (const p of CANVAS_PRESETS) {
      const b = el('button', 'fp-preset');
      b.type = 'button';
      const shape = el('span', 'fp-preset-shape');
      const k = 40 / Math.max(p.width, p.height);
      shape.style.width = `${Math.round(p.width * k)}px`;
      shape.style.height = `${Math.round(p.height * k)}px`;
      const dims = el('span', 'fp-preset-dims', L('pxUnit', { w: p.width, h: p.height }));
      dims.dir = 'ltr';
      b.append(shape, el('span', 'fp-preset-name', L(labels[p.id])), dims);
      b.setAttribute('aria-pressed', String(p.id === 'square'));
      b.addEventListener('click', () => {
        w = p.width; h = p.height;
        wIn.value = String(w); hIn.value = String(h);
        presetButtons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      });
      presetButtons.push(b);
      grid.append(b);
    }
    const custom = el('div', 'fp-row');
    custom.append(field(L('widthLabel'), wIn), field(L('heightLabel'), hIn));
    const clear = () => presetButtons.forEach((x) => x.setAttribute('aria-pressed', 'false'));
    wIn.addEventListener('input', clear);
    hIn.addEventListener('input', clear);
    let bgChoice: 'white' | 'transparent' | 'fg' = 'white';
    const bgSeg = segmented<'white' | 'transparent' | 'fg'>(L('bgLabel'), [
      { value: 'white', label: L('bgWhite') }, { value: 'transparent', label: L('bgTransparent') }, { value: 'fg', label: L('bgColor') },
    ], 'white', (v) => { bgChoice = v; });
    newDlg.body.append(grid, el('h3', 'fp-group-title', L('presetCustom')), custom, field(L('bgLabel'), bgSeg.root));
    const cancel = button(L('cancel'));
    cancel.addEventListener('click', () => newDlg.close());
    const create = button(L('create'), 'primary', 'plus');
    create.addEventListener('click', async () => {
      const W = Math.max(1, Math.min(16384, Math.round(Number(wIn.value) || 1)));
      const H = Math.max(1, Math.min(16384, Math.round(Number(hIn.value) || 1)));
      if (W * H > 24_000_000) { say(refusalText('too-large', sys.locale(), '24,000,000')); return; }
      newDlg.close();
      if (!(await confirmDiscard())) return;
      const [r, g, b] = hexRgb(fg);
      const rgba: [number, number, number, number] = bgChoice === 'white' ? [255, 255, 255, 255] : bgChoice === 'transparent' ? [0, 0, 0, 0] : [r, g, b, 255];
      newDocFromBuffer(solidBuffer(W, H, rgba), L('untitled'), mode === 'gallery' ? 'pro' : mode);
    });
    newDlg.actions.append(cancel, create);
    newDlg.open();
  }

  /* ─────────────────────────── saving ─────────────────────────── */

  async function saveProject(as: boolean): Promise<void> {
    if (!doc) return;
    let path = projectPath;
    if (!path || as) {
      path = await askProjectPath();
      if (!path) return;
    }
    if (!isWithinHome(path)) { showError(refusalText('out-of-home', sys.locale(), path)); return; }
    busy = true;
    root.classList.add('is-busy');
    say(L('applying'));
    try {
      const snapshot = doc;
      const json = await serializeProject(snapshot, PNG_CODEC);
      await vfs.writeFile(path, json);
      const back = await vfs.readText(path);
      if (back.length !== json.length) throw new Error(L('exportVerifyFailed'));
      projectPath = path;
      savedDoc = snapshot;
      docName = basenameOf(path);
      rememberRecent(path);
      updateChrome();
      say(L('projectSaved', { path }));
    } catch (error) {
      const code = (error as { code?: string })?.code;
      showError(L('exportFailed', { reason: code === 'EINVAL' ? L('exportQuota') : (error as Error)?.message ?? String(error) }), () => void saveProject(as));
    } finally {
      busy = false;
      root.classList.remove('is-busy');
    }
  }

  function askProjectPath(): Promise<string | null> {
    return new Promise((resolve) => {
      projectDlg.body.replaceChildren();
      projectDlg.actions.replaceChildren();
      const dir0 = projectPath ? dirnameOf(projectPath) : sourcePath ? dirnameOf(sourcePath) : PICTURES;
      const nameIn = el('input', 'fp-input');
      nameIn.dir = 'auto';
      nameIn.value = stemOf(projectPath ?? sourcePath ?? docName) || L('untitled');
      nameIn.setAttribute('aria-label', L('exportName'));
      nameIn.autofocus = true;
      const folder = el('input', 'fp-input');
      folder.dir = 'ltr';
      folder.value = dir0;
      folder.setAttribute('aria-label', L('exportFolder'));
      const browse = button(L('exportBrowse'), 'secondary', 'folderOpen');
      browse.addEventListener('click', async () => {
        const d = await pickFile(root, vfs, { mode: 'folder', start: folder.value || PICTURES });
        if (d) folder.value = d;
      });
      const folderRow = el('div', 'fp-row');
      folderRow.append(field(L('exportFolder'), folder), browse);
      projectDlg.body.append(field(L('exportName'), nameIn), folderRow, el('p', 'fp-muted fp-small', L('projectExtNote')));
      let result: string | null = null;
      const cancel = button(L('cancel'));
      cancel.addEventListener('click', () => projectDlg.close());
      const ok = button(L('saveProject'), 'primary', 'save');
      ok.addEventListener('click', () => {
        const n = nameIn.value.trim().replace(/[/\\]/g, '_').replace(/\.fphoto$/i, '');
        if (!n) return;
        result = `${(folder.value.trim() || PICTURES).replace(/\/+$/, '')}/${n}${PROJECT_EXT}`;
        projectDlg.close();
      });
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
      projectDlg.actions.append(cancel, ok);
      const done = () => resolve(result);
      projectDlg.onClose(done);
      projectDlg.open();
      queueMicrotask(() => nameIn.select());
    });
  }

  /* ─────────────────────────── export ─────────────────────────── */

  function canEncode(format: ExportFormat): boolean {
    const mime = FORMATS[format].exportMime!;
    try { return canvas2d(1, 1).canvas.toDataURL(mime, 0.8).startsWith(`data:${mime}`); } catch { return false; }
  }

  async function encodeDoc(format: ExportFormat, quality: number, percent: number): Promise<Uint8Array> {
    const d = doc!;
    const size = exportSize(d, percent);
    const { canvas, ctx } = canvas2d(size.width, size.height);
    if (format === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size.width, size.height); }
    ctx.setTransform(size.width / d.width, 0, 0, size.height / d.height, 0, 0);
    drawDoc(ctx, d, cache, { overrides: new Map() });
    return canvasToBytes(canvas, FORMATS[format].exportMime!, FORMATS[format].lossy ? clampQuality(quality) : undefined);
  }

  function download(bytes: Uint8Array, name: string, mime: string): void {
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    say(L('downloadDone', { name }));
  }

  /**
   * Export — the shared shell dialog (`src/shell/save-as.ts`) plus this app's own controls.
   *
   * The folder browsing, the new-folder button, the file name, the format picker, the replace
   * question (one `.bak`, never two), the read-back before "saved" and "Download to my device"
   * all belong to the shared component; Photo only contributes what is specific to pixels:
   * quality, scale, and the size estimate.
   */
  function openExport(initial?: ExportFormat): void {
    if (!doc) return;
    if (session) cancelSession();
    const srcFmt = sourcePath ? formatOfTarget(sourcePath) : null;
    let format: ExportFormat = initial ?? srcFmt ?? 'png';
    if (!canEncode(format)) format = 'png';
    let quality = 92;
    let percent = 100;
    const fmts = EXPORT_FORMAT_LIST.filter(canEncode);
    const dir0 = sourcePath ? dirnameOf(sourcePath) : projectPath ? dirnameOf(projectPath) : PICTURES;
    const name0 = stemOf(sourcePath ?? projectPath ?? docName) || L('untitled');

    void saveAsDialog({
      vfs,
      host: win.content,
      title: L('exportTitle'),
      dir: dir0,
      name: name0,
      format,
      saveLabel: L('exportSave'),
      formats: fmts.map((f) => ({
        value: f,
        label: f === 'jpeg' ? 'JPG' : f.toUpperCase(),
        ext: FORMATS[f].extensions[0].replace(/^\./, ''),
        mime: FORMATS[f].exportMime!,
      })),
      extras: (host, api) => {
        const q = slider(L('exportQuality'), 5, 100, quality, 1, (v) => { quality = v; estimate(); }, (v) => `${v}%`);
        const sc = slider(L('exportScale'), 5, 200, percent, 1, (v) => { percent = v; sync(); }, (v) => `${v}%`);
        const dims = el('p', 'fp-muted fp-small');
        dims.dir = 'ltr';
        const est = el('p', 'fp-estimate');
        est.setAttribute('aria-live', 'polite');
        const note = el('p', 'fp-muted fp-small', L('exportJpegNote'));
        host.append(q.row, sc.row, dims, est, note);

        let estTimer = 0;
        let estToken = 0;
        function estimate(): void {
          window.clearTimeout(estTimer);
          est.textContent = L('exportEstimating');
          const token = ++estToken;
          estTimer = window.setTimeout(async () => {
            try {
              const bytes = await api.encode();
              if (token === estToken) est.textContent = L('exportEstimate', { size: formatSize(bytes.length, getLocale()) });
            } catch {
              if (token === estToken) est.textContent = '';
            }
          }, 350);
        }
        function sync(): void {
          const chose = api.format() as ExportFormat;
          q.row.hidden = !FORMATS[chose].lossy;
          note.hidden = chose !== 'jpeg';
          const s = exportSize(doc!, percent);
          dims.textContent = L('exportDims', { w: s.width, h: s.height });
          estimate();
        }
        api.onChange(() => {
          const chose = api.format() as ExportFormat;
          q.row.hidden = !FORMATS[chose].lossy;
          note.hidden = chose !== 'jpeg';
          estimate();
        });
        sync();
      },
      encode: async (target) => encodeDoc(target.format as ExportFormat, quality, percent),
    }).then((outcome) => {
      if (outcome.status === 'saved') {
        rememberRecent(outcome.path);
        if (!projectPath) savedDoc = doc;
        updateChrome();
        say(outcome.backup
          ? L('exportDoneOverwrite', { path: outcome.path, bak: outcome.backup })
          : L('exportSaved', { path: outcome.path }));
      } else if (outcome.status === 'downloaded') {
        say(L('downloadDone', { name: outcome.path }));
      }
    }).catch((error: unknown) => {
      const code = (error as { code?: string })?.code;
      showError(L('exportFailed', { reason: code === 'EINVAL' ? L('exportQuota') : (error as Error)?.message ?? String(error) }));
    });
  }

  quickExportBtn.addEventListener('click', () => openExport(quickFormat));
  quickDownloadBtn.addEventListener('click', async () => {
    if (!doc) return;
    try {
      const bytes = await encodeDoc(quickFormat, 92, 100);
      download(bytes, `${stemOf(sourcePath ?? docName) || 'image'}${FORMATS[quickFormat].extensions[0]}`, FORMATS[quickFormat].exportMime!);
    } catch {
      showError(L('exportUnsupported', { format: quickFormat.toUpperCase() }));
    }
  });
  quickProject.addEventListener('click', () => void saveProject(false));

  /* ─────────────────────────── help & limits ─────────────────────────── */

  function openHelp(): void {
    helpDlg.body.replaceChildren();
    helpDlg.actions.replaceChildren();
    const apple = /Mac|iPhone|iPad/.test(navigator.platform);
    const table = el('dl', 'fp-keys');
    const seen = new Set<string>();
    for (const s of SHORTCUTS) {
      const label = s.action.kind === 'tool' ? L(s.label) : L(s.label);
      const id = `${label}|${describeKeys(s, apple)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      table.append(el('dt', undefined, label));
      const dd = el('dd');
      const kbd = el('kbd', undefined, describeKeys(s, apple));
      kbd.dir = 'ltr';
      dd.append(kbd);
      table.append(dd);
    }
    helpDlg.body.append(table);
    const close = button(L('close'), 'primary');
    close.addEventListener('click', () => helpDlg.close());
    helpDlg.actions.append(close);
    helpDlg.open();
  }

  function openCaps(): void {
    capsDlg.body.replaceChildren();
    capsDlg.actions.replaceChildren();
    const supported = (ext: string) => {
      const info = formatForExtension(ext);
      return !!info && info.canOpen && runtimeSupport[info.id] !== false;
    };
    const yes = OPEN_EXTENSIONS.filter(supported);
    const no = OPEN_EXTENSIONS.filter((e) => !supported(e));
    capsDlg.body.append(el('h3', 'fp-group-title', L('capTitle')));
    const caps = el('ul', 'fp-list');
    caps.append(el('li', undefined, L('capOpens', { list: `${yes.join(', ')}, ${PROJECT_EXT}` })));
    caps.append(el('li', undefined, L('capExports', { list: `${EXPORT_FORMAT_LIST.map((f) => FORMATS[f].extensions[0]).join(', ')}, ${PROJECT_EXT}` })));
    if (no.length) caps.append(el('li', 'fp-bad', L('capUnsupported', { list: no.join(', ') })));
    caps.append(el('li', undefined, L('capAnimFirst')));
    caps.append(el('li', undefined, L('capProbe')));
    const limits = el('ul', 'fp-list');
    // The quota line quotes the limits the file system is enforcing RIGHT NOW (`vfs.quota`
    // follows the platform tier), so the panel can never drift back to a hard-coded number.
    const quotaVars = { file: formatSize(vfs.quota.file, getLocale()), total: formatSize(vfs.quota.total, getLocale()) };
    for (const key of ['limitLayers', 'limitCmyk', 'limitRaw', 'limitAnim', 'limitVector', 'limitText', 'limitBrush', 'limitQuota', 'limitColors', 'limitNoOriginal', 'limitClosing']) {
      limits.append(el('li', undefined, key === 'limitQuota' ? L(key, quotaVars) : L(key)));
    }
    capsDlg.body.append(caps, el('h3', 'fp-group-title', L('limitsTitle')), limits);
    const close = button(L('close'), 'primary');
    close.addEventListener('click', () => capsDlg.close());
    capsDlg.actions.append(close);
    capsDlg.open();
  }
  capsBtn.addEventListener('click', openCaps);

  function renderInfo(): void {
    infoDl.replaceChildren();
    if (!doc) return;
    const add = (k: string, v: string) => { infoDl.append(el('dt', undefined, k)); const dd = el('dd', undefined, v); dd.dir = 'ltr'; infoDl.append(dd); };
    add(L('canvasSize'), L('pxUnit', { w: doc.width, h: doc.height }));
    add(L('colorspace'), L('colorspaceRgb'));
  }

  /* ─────────────────────────── image panel wiring ─────────────────────────── */

  rotL.addEventListener('click', () => rotate(-1));
  rotR.addEventListener('click', () => rotate(1));
  flH.addEventListener('click', () => flip('h'));
  flV.addEventListener('click', () => flip('v'));
  qRotL.addEventListener('click', () => rotate(-1));
  qRotR.addEventListener('click', () => rotate(1));
  qFlH.addEventListener('click', () => flip('h'));
  qFlV.addEventListener('click', () => flip('v'));
  qCropStart.addEventListener('click', () => setTool('crop'));
  qCropApply.addEventListener('click', applyCrop);
  qCropCancel.addEventListener('click', () => setTool('move'));
  freeApply.addEventListener('click', () => {
    if (!doc) return;
    const deg = Number(freeAngle.value);
    if (!Number.isFinite(deg) || !deg) return;
    doc = rotateDocFree(doc, deg);
    selection = null;
    commit(L('hRotate'));
    fit();
    renderInfo();
  });
  rw.addEventListener('input', () => { if (doc && rLock.input.checked) rh.value = String(Math.max(1, Math.round((Number(rw.value) * doc.height) / doc.width))); });
  rh.addEventListener('input', () => { if (doc && rLock.input.checked) rw.value = String(Math.max(1, Math.round((Number(rh.value) * doc.width) / doc.height))); });
  rApply.addEventListener('click', () => {
    if (!doc) return;
    const W = Math.max(1, Math.min(16384, Math.round(Number(rw.value))));
    const H = Math.max(1, Math.min(16384, Math.round(Number(rh.value))));
    if (W === doc.width && H === doc.height) { say(L('resizeSame')); return; }
    doc = resizeDoc(doc, { width: W, height: H });
    selection = null;
    commit(L('hResize'));
    fit();
    renderInfo();
  });

  /* ─────────────────────────── app bar wiring ─────────────────────────── */

  undoBtn.addEventListener('click', () => stepHistory('undo'));
  redoBtn.addEventListener('click', () => stepHistory('redo'));
  compareBtn.addEventListener('click', () => {
    compareOn = !compareOn;
    compareBtn.setAttribute('aria-pressed', String(compareOn));
    requestRender();
  });
  helpBtn.addEventListener('click', openHelp);
  saveBtn.addEventListener('click', () => void saveProject(false));
  exportBtn.addEventListener('click', () => openExport());
  zoomInBtn.addEventListener('click', () => setZoom(zoomStop(view.zoom, 1)));
  zoomOutBtn.addEventListener('click', () => setZoom(zoomStop(view.zoom, -1)));
  zoomLabel.addEventListener('click', fit);
  // The rulers remember the choice for this session; without one they follow the window width.
  rulersBtn.addEventListener('click', () => {
    const next = !rulersVisible();
    rulersOn = next;
    drawRulers();
    say(next ? L('rulersShow') : L('rulersHide'));
  });

  /* ─────────────────────────── lifecycle ─────────────────────────── */

  win.setCloseGuard(async () => {
    if (!isDirty()) return true;
    return shellConfirm({
      title: L('discardTitle'), message: L('discardBody'), okLabel: L('discardOk'), cancelLabel: L('discardCancel'), danger: true,
    });
  });

  win.onClose(() => {
    window.clearInterval(antsTimer);
    window.clearTimeout(thumbTimer);
    layoutObserver.disconnect();
    viewportObserver.disconnect();
    window.removeEventListener('pointermove', onLayerDragMove);
    window.removeEventListener('pointerup', onLayerDragEnd);
    closeMenu();
    closeSheet();
    gallery.destroy();
    cache.clear();
  });

  // Boot.
  setMode('pro');
  setTool('move');
  say(L('statusReady'));
  void (async () => {
    runtimeSupport = await probeRuntime();
    if (args[0]) await openPath(args[0]);
  })();

  // Expose nothing global; every listener above is scoped to this window.
  void (modal as unknown as Modal);
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
