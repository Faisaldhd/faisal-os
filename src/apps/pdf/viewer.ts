/**
 * PDF app — the page viewer (عارض الصفحات): real pages drawn by pdf.js on a grey canvas.
 *
 * Continuous vertical scroll of every page. Each page is a fixed-size box laid out from its real
 * geometry, so the scroll bar is right before anything is drawn; only the pages on screen and
 * one page either side hold a canvas, drawn at the screen's pixel density (capped per canvas),
 * and canvases further away are released — memory stays bounded on a 300-page file.
 *
 * A second view mode lays the SAME page boxes out two at a time inside a `.faisal-pdf-spread` row
 * (`setSpread`), paired by `spread.ts` — the cover alone, then 2‑3 · 4‑5. Because a row is a plain
 * static element, every page's `offsetTop` stays the top of its row, so scrolling, the "current
 * page" probe, the visible range and the release distance keep working untouched.
 *
 * Over each drawn page sit, in order: the text layer (selection, copy, search highlights), the
 * link layer (internal jumps and external links), the form layer (the document's own AcroForm
 * fields as real inputs), the annotation hit layer and the tool overlay used by the window's
 * drawing and placing tools. All text is set with `textContent`.
 */
import { t } from '../../kernel/i18n';
import type { PdfJsDocument, PdfJsLib, PdfJsPage } from './render';
import type { AnnotationInfo } from './writer';
import {
  anchoredScroll, clampZoom, CSS_UNITS, fitZoom, outputScale, pageAtOffset, pageSize, renderOrder,
  totalRotation, viewportTransform, visibleRange, boxToView, type PageGeom, type ZoomMode,
} from './viewport';
import {
  neighbourPage, pagesOfPage, pagesOfSpread, spreadCount, spreadForPage, type Spread, type SpreadOptions,
} from './spread';
import { buildPageText, hitSpans, type Hit } from './search';
import { KIND_KEYS } from './labels';

type TextContent = Awaited<ReturnType<PdfJsPage['getTextContent']>>;
type TextItem = { str: string; hasEOL?: boolean };
type TextLayerInstance = InstanceType<PdfJsLib['TextLayer']>;

export interface FieldWidget {
  name: string;
  kind: 'text' | 'checkbox' | 'radio' | 'choice' | 'button' | 'signature';
  multiline: boolean;
  readOnly: boolean;
  value: string;
  /** The "on" value of a checkbox / radio widget. */
  onValue: string;
  options: { value: string; label: string }[];
  rect: [number, number, number, number];
  maxLen: number;
}

export interface ViewerHooks {
  onPageChange(page: number): void;
  onZoomChange(zoom: number, mode: ZoomMode): void;
  /** First paint of page 1 of a document (the recent list keeps a thumbnail of it). */
  onFirstPaint?(canvas: HTMLCanvasElement): void;
  /** The current value the window holds for a form field (pending edits win over the file). */
  fieldValue(name: string, fallback: string): string;
  onFieldInput(widget: FieldWidget, value: string): void;
  onAnnotationClick?(info: AnnotationInfo, anchor: HTMLElement): void;
  onExternalLink?(url: string): void;
}

interface Slot {
  index: number;
  page: PdfJsPage;
  geom: PageGeom;
  box: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  key: string;
  task: { cancel(): void } | null;
  textDiv: HTMLDivElement;
  textLayer: TextLayerInstance | null;
  textKey: string;
  /** The text items the text layer was built from (same order as its spans). */
  items: TextItem[];
  linkDiv: HTMLDivElement;
  formDiv: HTMLDivElement;
  annotDiv: HTMLDivElement;
  overlay: HTMLDivElement;
  widgetKey: string;
}

const RENDER_EXTRA = 1;
const RELEASE_DISTANCE = 3;

export class PdfViewer {
  readonly scroller: HTMLDivElement;
  readonly frame: HTMLDivElement;
  private lib: PdfJsLib | null = null;
  private doc: PdfJsDocument | null = null;
  private slots: Slot[] = [];
  private tops: number[] = [];
  private heights: number[] = [];
  private version = 0;
  private zoomValue = 1;
  private modeValue: ZoomMode = 'fitWidth';
  private rotationValue = 0;
  private current = 0;
  private scheduled = 0;
  private rendering = 0;
  private relayoutTimer = 0;
  private textCache = new Map<number, Promise<TextContent>>();
  private hitsByPage = new Map<number, { hit: Hit; index: number }[]>();
  private currentHit = -1;
  private annotations: AnnotationInfo[] = [];
  private firstPaintDone = false;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;
  private spreadValue = false;
  private rows: HTMLDivElement[] = [];
  private pinch: { dist: number; zoom: number; x: number; y: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();

  constructor(private readonly hooks: ViewerHooks) {
    this.scroller = document.createElement('div');
    this.scroller.className = 'faisal-pdf-scroll';
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'document');
    this.frame = document.createElement('div');
    this.frame.className = 'faisal-pdf-frame';
    this.scroller.append(this.frame);
    this.scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.scroller.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false });
    this.scroller.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    this.scroller.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      this.scroller.addEventListener(type, (ev) => this.onPointerEnd(ev));
    }
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.modeValue !== 'custom' && this.slots.length) this.applyMode(false);
        this.schedule();
      });
      this.resizeObserver.observe(this.scroller);
    }
  }

  get pageCount(): number { return this.slots.length; }
  get currentPage(): number { return this.current; }
  get zoom(): number { return this.zoomValue; }
  get mode(): ZoomMode { return this.modeValue; }
  get viewRotation(): number { return this.rotationValue; }
  get document(): PdfJsDocument | null { return this.doc; }
  /** True when the pages are laid out two at a time. */
  get spread(): boolean { return this.spreadValue; }

  private spreadOptions(): SpreadOptions {
    return { spread: this.spreadValue, coverAlone: true };
  }

  /**
   * Shows a new document (or the same one after an edit). With `keep`, the reading position,
   * zoom and rotation stay; the old canvases stay visible until the new ones are painted, so an
   * edit does not flash the page white.
   */
  async setDocument(lib: PdfJsLib, doc: PdfJsDocument, keep: boolean): Promise<void> {
    const old = this.doc;
    const keepPage = keep ? this.current : 0;
    const keepOffset = keep ? this.offsetInPage() : 0;
    this.lib = lib;
    this.doc = doc;
    this.version++;
    this.textCache.clear();
    const pages: PdfJsPage[] = [];
    for (let start = 0; start < doc.numPages; start += 64) {
      const batch = [];
      for (let i = start; i < Math.min(doc.numPages, start + 64); i++) batch.push(doc.getPage(i + 1));
      pages.push(...await Promise.all(batch));
      if (this.destroyed || this.doc !== doc) return;
    }
    const oldSlots = this.slots;
    this.slots = pages.map((page, index) => {
      const reuse = keep ? oldSlots[index] : undefined;
      const geom: PageGeom = { view: page.view as [number, number, number, number], rotate: page.rotate };
      if (reuse) {
        reuse.task?.cancel();
        Object.assign(reuse, { page, geom, key: '', task: null, textKey: '', widgetKey: '' });
        return reuse;
      }
      return this.makeSlot(index, page, geom);
    });
    for (const extra of oldSlots.slice(pages.length)) extra.box.remove();
    if (!keep) {
      this.frame.textContent = '';
      this.rows = [];
    }
    this.buildFrame();
    if (!keep) {
      this.rotationValue = 0;
      this.modeValue = 'fitWidth';
      this.firstPaintDone = false;
    }
    this.layout();
    if (!keep) this.applyMode(false);
    this.goToPage(Math.min(keepPage, this.slots.length - 1), keepOffset);
    this.schedule();
    if (old && old !== doc) void old.loadingTask.destroy().catch(() => {});
  }

  clear(): void {
    for (const slot of this.slots) slot.task?.cancel();
    this.slots = [];
    this.frame.textContent = '';
    this.rows = [];
    this.tops = [];
    this.heights = [];
    if (this.doc) void this.doc.loadingTask.destroy().catch(() => {});
    this.doc = null;
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.clear();
  }

  private makeSlot(index: number, page: PdfJsPage, geom: PageGeom): Slot {
    const box = document.createElement('div');
    box.className = 'faisal-pdf-page';
    box.dataset.page = String(index);
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', t('pdf.pageN', { n: index + 1 }));
    const layer = (cls: string): HTMLDivElement => {
      const div = document.createElement('div');
      div.className = cls;
      box.append(div);
      return div;
    };
    const skeleton = layer('faisal-pdf-skeleton');
    skeleton.setAttribute('aria-hidden', 'true');
    const textDiv = layer('textLayer');
    const linkDiv = layer('faisal-pdf-links');
    const formDiv = layer('faisal-pdf-fields');
    const annotDiv = layer('faisal-pdf-annots');
    const overlay = layer('faisal-pdf-overlay');
    return {
      index, page, geom, box, canvas: null, key: '', task: null, textDiv, textLayer: null, textKey: '', items: [],
      linkDiv, formDiv, annotDiv, overlay, widgetKey: '',
    };
  }

  /* ───────────────────────────── layout ───────────────────────────── */

  /**
   * Puts the page boxes where the current view mode wants them: straight into the frame for one
   * page at a time, or inside one `.faisal-pdf-spread` row per pair. A row is deliberately NOT
   * positioned, so the frame stays the offset parent of every page and `offsetTop` keeps meaning
   * "top of this page's row" — which is what scrolling, `offsetInPage` and the probe rely on.
   */
  private buildFrame(): void {
    if (!this.spreadValue) {
      // Leaving the spread takes every row away and puts the pages back in the frame, in order.
      for (const row of this.rows.splice(0)) row.remove();
      for (const slot of this.slots) if (slot.box.parentElement !== this.frame) this.frame.append(slot.box);
      return;
    }
    const wanted = spreadCount(this.slots.length, this.spreadOptions());
    for (const extra of this.rows.splice(wanted)) extra.remove();
    for (let index = 0; index < wanted; index++) {
      if (!this.rows[index]) {
        const row = document.createElement('div');
        row.className = 'faisal-pdf-spread';
        row.dataset.spread = String(index);
        this.rows[index] = row;
      }
      const row = this.rows[index];
      for (const page of pagesOfSpread(index, this.slots.length, this.spreadOptions())) {
        const slot = this.slots[page];
        if (slot) row.append(slot.box);
      }
      // Appending an existing child moves it, so the rows end up in spread order.
      if (row.childElementCount) this.frame.append(row);
    }
  }

  /** Two pages side by side (or back to one), keeping the reading position and the zoom mode. */
  setSpread(on: boolean): void {
    const next = Boolean(on);
    if (this.spreadValue === next) return;
    this.spreadValue = next;
    this.buildFrame();
    this.layout();
    if (this.modeValue !== 'custom') this.applyMode(false);
    this.goToPage(this.current);
    this.schedule();
  }

  /** The spread the reading position is in: its number, how many there are, and its pages. */
  spreadInfo(): { spread: Spread | null; total: number } {
    const options = this.spreadOptions();
    return { spread: spreadForPage(this.current, this.slots.length, options), total: spreadCount(this.slots.length, options) };
  }

  /** Moves one SPREAD forward (`dir` 1) or back (-1), or one page at a time in single-page mode. */
  goToSpread(dir: 1 | -1): void {
    if (!this.slots.length) return;
    const target = this.spreadValue
      ? neighbourPage(this.current, this.slots.length, this.spreadOptions(), dir)
      : this.current + (dir < 0 ? -1 : 1);
    this.goToPage(target);
  }

  /** The first page of the spread that holds `page` (what the window shows as "the page"). */
  private spreadStartOf(page: number): number {
    if (!this.spreadValue || !this.slots.length) return page;
    const pages = pagesOfPage(page, this.slots.length, this.spreadOptions());
    return pages.length ? pages[0] : page;
  }

  private layout(): void {
    const scale = this.zoomValue * CSS_UNITS;
    for (const slot of this.slots) {
      const size = pageSize(slot.geom, this.rotationValue, this.zoomValue);
      slot.box.style.width = `${Math.floor(size.width)}px`;
      slot.box.style.height = `${Math.floor(size.height)}px`;
      slot.box.style.setProperty('--scale-factor', String(scale));
      slot.box.style.setProperty('--total-scale-factor', String(scale));
    }
    this.measure();
  }

  private measure(): void {
    this.tops = this.slots.map((slot) => slot.box.offsetTop);
    this.heights = this.slots.map((slot) => slot.box.offsetHeight);
    // jsdom (tests) has no layout: fall back to the computed sizes so the math still works.
    if (this.heights.every((h) => h === 0)) {
      let y = 16;
      this.heights = this.slots.map((slot) => parseFloat(slot.box.style.height) || 0);
      this.tops = this.heights.map((h) => { const top = y; y += h + 16; return top; });
    }
  }

  /**
   * The box a page may use: the scroller MINUS the frame's own padding, because the frame keeps
   * that padding around every page. Counting it is what keeps a fit a real fit on a phone — and a
   * presentation page inside the screen instead of one scrollbar below it.
   */
  private availableSize(): { width: number; height: number } {
    return {
      width: Math.max(120, (this.scroller.clientWidth || 800) - this.framePadding('row')),
      height: Math.max(120, (this.scroller.clientHeight || 600) - this.framePadding('column')),
    };
  }

  /** The frame's horizontal (`row`) or vertical (`column`) padding, 0 where there is no layout. */
  private framePadding(direction: 'row' | 'column'): number {
    if (typeof getComputedStyle !== 'function') return 0;
    const style = getComputedStyle(this.frame);
    const first = parseFloat(direction === 'row' ? style.paddingLeft : style.paddingTop) || 0;
    const second = parseFloat(direction === 'row' ? style.paddingRight : style.paddingBottom) || 0;
    return first + second;
  }

  private applyMode(keepPosition: boolean): void {
    if (this.modeValue === 'custom' || !this.slots.length) return;
    const slot = this.slots[Math.max(0, this.current)] ?? this.slots[0];
    // A spread shares the available width between two pages, so a fit stays a fit for the pair.
    const columns = this.spreadValue ? 2 : 1;
    const zoom = fitZoom(this.modeValue, slot.geom, this.rotationValue, this.availableSize(), this.gutter(), columns);
    if (Math.abs(zoom - this.zoomValue) > 0.001) this.setZoomInternal(zoom, keepPosition);
    this.hooks.onZoomChange(this.zoomValue, this.modeValue);
  }

  private gutter(): number {
    return this.availableSize().width < 520 ? 8 : 24;
  }

  setMode(mode: ZoomMode): void {
    this.modeValue = mode;
    this.applyMode(true);
  }

  /** A zoom factor; `anchor` is a point inside the scroller that stays still (pinch, Ctrl+wheel). */
  setZoom(zoom: number, anchor?: { x: number; y: number }): void {
    this.modeValue = 'custom';
    this.setZoomInternal(clampZoom(zoom), true, anchor);
    this.hooks.onZoomChange(this.zoomValue, this.modeValue);
  }

  private setZoomInternal(zoom: number, keepPosition: boolean, anchor?: { x: number; y: number }): void {
    const old = this.zoomValue;
    if (Math.abs(zoom - old) < 0.0001) return;
    const ax = anchor?.x ?? this.scroller.clientWidth / 2;
    const ay = anchor?.y ?? 0;
    const page = this.current;
    const offset = this.offsetInPage();
    const left = this.scroller.scrollLeft;
    const top = this.scroller.scrollTop;
    this.zoomValue = zoom;
    this.layout();
    if (keepPosition) {
      if (anchor) {
        this.scroller.scrollTop = anchoredScroll(top, ay, zoom / old);
        this.scroller.scrollLeft = anchoredScroll(left, ax, zoom / old);
      } else {
        this.goToPage(page, offset);
      }
    }
    // Canvases stretch at once (CSS) and are redrawn sharp after the zoom settles.
    window.clearTimeout(this.relayoutTimer);
    this.relayoutTimer = window.setTimeout(() => this.schedule(), 140);
  }

  rotateView(delta: number): void {
    const page = this.current;
    this.rotationValue = ((this.rotationValue + delta) % 360 + 360) % 360;
    this.layout();
    if (this.modeValue !== 'custom') this.applyMode(false);
    this.goToPage(page);
    this.schedule();
  }

  /* ─────────────────────────── navigation ─────────────────────────── */

  /** Scrolls so page `index` starts at the top (plus `offset` CSS px into the page). */
  goToPage(index: number, offset = 0): void {
    if (!this.slots.length) return;
    const i = Math.max(0, Math.min(this.slots.length - 1, index));
    this.measure();
    this.scroller.scrollTop = Math.max(0, (this.tops[i] ?? 0) - 8 + offset);
    // Both pages of a spread share one top, so "the page" is the first page of the pair.
    this.setCurrent(this.spreadStartOf(i));
    this.schedule();
  }

  /** Scrolls a PDF-space point of a page into view (outline and link targets). */
  goToPoint(index: number, pdfY: number | null): void {
    const slot = this.slots[index];
    if (!slot || pdfY === null || !Number.isFinite(pdfY)) { this.goToPage(index); return; }
    const t = this.transform(index);
    const y = t[1] * 0 + t[3] * pdfY + t[5];
    this.goToPage(index, Math.max(0, y - 24));
  }

  private offsetInPage(): number {
    if (!this.slots.length) return 0;
    this.measure();
    return Math.max(0, this.scroller.scrollTop + 8 - (this.tops[this.current] ?? 0));
  }

  private setCurrent(index: number): void {
    if (index === this.current || index < 0) return;
    this.current = index;
    this.hooks.onPageChange(index);
  }

  /** The viewport transform (PDF → CSS px inside the page box) at the current zoom/rotation. */
  transform(index: number): number[] {
    const slot = this.slots[index];
    if (!slot) return [1, 0, 0, -1, 0, 0];
    return viewportTransform(slot.geom, totalRotation(slot.geom, this.rotationValue), this.zoomValue * CSS_UNITS);
  }

  pageBox(index: number): HTMLDivElement | null { return this.slots[index]?.box ?? null; }
  overlay(index: number): HTMLDivElement | null { return this.slots[index]?.overlay ?? null; }
  pageGeom(index: number): PageGeom | null { return this.slots[index]?.geom ?? null; }

  /** The page under a screen point and the point in CSS px inside that page, or null. */
  pageAt(clientX: number, clientY: number): { page: number; x: number; y: number } | null {
    for (const slot of this.slots) {
      const r = slot.box.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return { page: slot.index, x: clientX - r.left, y: clientY - r.top };
      }
    }
    return null;
  }

  /* ───────────────────────────── drawing ───────────────────────────── */

  schedule(): void {
    if (this.scheduled || this.destroyed) return;
    this.scheduled = requestAnimationFrame(() => {
      this.scheduled = 0;
      this.update();
    });
  }

  private update(): void {
    if (!this.slots.length) return;
    this.measure();
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight || 600;
    const probe = top + height * 0.3;
    /*
     * The probe only means something while the document can SCROLL. When everything fits on screen
     * — a short file, or a page fitted to a phone — the probe stays at page 1, and reading it would
     * undo every move the owner makes (the presentation would look frozen). Then the navigation,
     * not the scroll, decides which page is current.
     */
    if (this.scroller.scrollHeight > height + 2) {
      // In spread mode the two pages of a row share one top, so the probe always reports the FIRST
      // page of the pair: the page box and the spread indicator then describe the whole spread.
      this.setCurrent(this.spreadStartOf(pageAtOffset(this.tops, this.heights, probe)));
    }
    const [first, last] = visibleRange(this.tops, this.heights, top, top + height);
    const order = renderOrder(first, last, this.slots.length, RENDER_EXTRA, this.current);
    const keep = new Set(order);
    for (const slot of this.slots) {
      const far = first >= 0 && (slot.index < first - RELEASE_DISTANCE || slot.index > last + RELEASE_DISTANCE);
      if (far && !keep.has(slot.index)) this.release(slot);
    }
    void this.drawQueue(order);
  }

  private async drawQueue(order: number[]): Promise<void> {
    for (const index of order) {
      if (this.rendering >= 2) return;
      const slot = this.slots[index];
      if (!slot || slot.key === this.keyFor(slot) || slot.task) continue;
      this.rendering++;
      try {
        await this.draw(slot);
      } finally {
        this.rendering--;
      }
      if (this.destroyed) return;
    }
    // Anything that became due while drawing (a scroll, a zoom) gets its turn now.
    if (order.some((i) => this.slots[i] && this.slots[i].key !== this.keyFor(this.slots[i]))) this.schedule();
  }

  private keyFor(slot: Slot): string {
    return `${this.version}|${this.zoomValue.toFixed(4)}|${this.rotationValue}|${window.devicePixelRatio || 1}`;
  }

  private async draw(slot: Slot): Promise<void> {
    if (!this.lib) return;
    const key = this.keyFor(slot);
    const rotation = totalRotation(slot.geom, this.rotationValue);
    const viewport = slot.page.getViewport({ scale: this.zoomValue * CSS_UNITS, rotation });
    const ratio = outputScale(viewport.width, viewport.height, window.devicePixelRatio || 1);
    const canvas = document.createElement('canvas');
    canvas.className = 'faisal-pdf-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
    const task = slot.page.render({
      canvas,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      annotationMode: this.lib.AnnotationMode.ENABLE_FORMS,
    });
    slot.task = task;
    try {
      await task.promise;
    } catch {
      // Cancelled (a newer zoom or a new document) or a broken page: the next update decides.
      if (slot.task === task) slot.task = null;
      return;
    }
    if (slot.task !== task) return;
    slot.task = null;
    if (this.destroyed) return;
    slot.canvas?.remove();
    slot.canvas = canvas;
    slot.box.prepend(canvas);
    slot.box.classList.add('is-drawn');
    slot.key = key;
    if (slot.index === 0 && !this.firstPaintDone) {
      this.firstPaintDone = true;
      this.hooks.onFirstPaint?.(canvas);
    }
    await this.drawText(slot, key);
    await this.drawWidgets(slot, key);
    this.drawAnnotationHits(slot);
  }

  private release(slot: Slot): void {
    slot.task?.cancel();
    slot.task = null;
    if (slot.canvas) {
      // Zero-size first: some engines keep the backing store of a removed canvas alive.
      slot.canvas.width = 0;
      slot.canvas.height = 0;
      slot.canvas.remove();
      slot.canvas = null;
    }
    slot.textLayer?.cancel();
    slot.textLayer = null;
    slot.textDiv.textContent = '';
    slot.linkDiv.textContent = '';
    slot.formDiv.textContent = '';
    slot.box.classList.remove('is-drawn');
    slot.key = '';
    slot.textKey = '';
    slot.widgetKey = '';
  }

  /* ───────────────────────────── text layer ───────────────────────────── */

  textContent(index: number): Promise<TextContent> | null {
    const slot = this.slots[index];
    if (!slot) return null;
    let cached = this.textCache.get(index);
    if (!cached) {
      cached = slot.page.getTextContent();
      this.textCache.set(index, cached);
    }
    return cached;
  }

  /** The page's text items (only those that carry text, in the text layer's order). */
  async textItems(index: number): Promise<TextItem[]> {
    const content = await this.textContent(index);
    if (!content) return [];
    return (content.items as unknown[]).filter((item): item is TextItem => typeof (item as TextItem).str === 'string');
  }

  private async drawText(slot: Slot, key: string): Promise<void> {
    if (!this.lib || slot.textKey === key) return;
    const content = await this.textContent(slot.index);
    if (!content || slot.key !== key) return;
    slot.textLayer?.cancel();
    slot.textDiv.textContent = '';
    const rotation = totalRotation(slot.geom, this.rotationValue);
    const viewport = slot.page.getViewport({ scale: this.zoomValue * CSS_UNITS, rotation });
    const layer = new this.lib.TextLayer({ textContentSource: content, container: slot.textDiv, viewport });
    slot.textLayer = layer;
    try {
      await layer.render();
    } catch {
      return;
    }
    if (slot.textLayer !== layer) return;
    slot.items = (content.items as unknown[]).filter((item): item is TextItem => typeof (item as TextItem).str === 'string');
    slot.textKey = key;
    this.paintHits(slot);
  }

  /** Search hits for the whole document; `current` is the index of the selected hit. */
  setHits(hits: readonly Hit[], current: number): void {
    this.hitsByPage.clear();
    hits.forEach((hit, index) => {
      const list = this.hitsByPage.get(hit.page) ?? [];
      list.push({ hit, index });
      this.hitsByPage.set(hit.page, list);
    });
    this.currentHit = current;
    for (const slot of this.slots) if (slot.textLayer) this.paintHits(slot);
  }

  private paintHits(slot: Slot): void {
    const layer = slot.textLayer;
    if (!layer) return;
    const divs = layer.textDivs as HTMLElement[];
    const strings = layer.textContentItemsStr as string[];
    // Restore every span to its plain text first (a previous search may have split it).
    divs.forEach((div, i) => {
      if (div.dataset.hl) {
        div.textContent = strings[i] ?? '';
        delete div.dataset.hl;
      }
    });
    const hits = this.hitsByPage.get(slot.index);
    if (!hits?.length) return;
    const page = buildPageText(slot.items.length === strings.length ? slot.items : strings.map((str) => ({ str })));
    const lengths = strings.map((s) => s.length);
    const pieces = new Map<number, { start: number; end: number; selected: boolean }[]>();
    for (const { hit, index } of hits) {
      for (const span of hitSpans(page, lengths, hit.start, hit.end)) {
        const list = pieces.get(span.item) ?? [];
        list.push({ start: span.start, end: span.end, selected: index === this.currentHit });
        pieces.set(span.item, list);
      }
    }
    for (const [item, list] of pieces) {
      const div = divs[item];
      const str = strings[item] ?? '';
      if (!div) continue;
      list.sort((a, b) => a.start - b.start);
      div.textContent = '';
      div.dataset.hl = '1';
      let at = 0;
      for (const piece of list) {
        if (piece.start > at) div.append(document.createTextNode(str.slice(at, piece.start)));
        const mark = document.createElement('span');
        mark.className = piece.selected ? 'highlight selected' : 'highlight';
        mark.textContent = str.slice(Math.max(at, piece.start), piece.end);
        div.append(mark);
        at = Math.max(at, piece.end);
      }
      if (at < str.length) div.append(document.createTextNode(str.slice(at)));
    }
  }

  /**
   * Brings a search hit into view: the page first, then (once its text layer exists) the
   * highlighted span itself, centred.
   */
  async revealHit(hit: Hit): Promise<void> {
    const slot = this.slots[hit.page];
    if (!slot) return;
    this.measure();
    const top = this.scroller.scrollTop;
    const bottom = top + this.scroller.clientHeight;
    const inView = this.tops[hit.page] < bottom && this.tops[hit.page] + this.heights[hit.page] > top;
    if (!inView) this.goToPage(hit.page);
    for (let i = 0; i < 40 && !slot.textKey; i++) await new Promise((r) => setTimeout(r, 50));
    const mark = slot.textDiv.querySelector('.highlight.selected') as HTMLElement | null;
    if (mark) {
      const r = mark.getBoundingClientRect();
      const s = this.scroller.getBoundingClientRect();
      if (r.top < s.top + 40 || r.bottom > s.bottom - 40) {
        this.scroller.scrollTop += r.top - s.top - s.height / 3;
      }
    }
  }

  /** The current text selection, cut into page-relative CSS-px boxes (for text markup). */
  selectionBoxes(): { page: number; boxes: { x: number; y: number; width: number; height: number }[] }[] {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    const out = new Map<number, { x: number; y: number; width: number; height: number }[]>();
    for (let r = 0; r < sel.rangeCount; r++) {
      const range = sel.getRangeAt(r);
      if (!this.frame.contains(range.commonAncestorContainer)) continue;
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue;
        const hit = this.pageAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (!hit) continue;
        const box = this.slots[hit.page].box.getBoundingClientRect();
        const list = out.get(hit.page) ?? [];
        list.push({ x: rect.left - box.left, y: rect.top - box.top, width: rect.width, height: rect.height });
        out.set(hit.page, list);
      }
    }
    return [...out.entries()].map(([page, boxes]) => ({ page, boxes }));
  }

  /* ─────────────────────── links and form fields ─────────────────────── */

  private async drawWidgets(slot: Slot, key: string): Promise<void> {
    if (slot.widgetKey === key) return;
    let annots: Record<string, unknown>[];
    try {
      annots = await slot.page.getAnnotations({ intent: 'display' }) as Record<string, unknown>[];
    } catch {
      return;
    }
    if (slot.key !== key) return;
    slot.widgetKey = key;
    slot.linkDiv.textContent = '';
    slot.formDiv.textContent = '';
    const t6 = this.transform(slot.index);
    const place = (el: HTMLElement, rect: number[]): void => {
      const box = boxToView(t6, { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] });
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
    };
    const widgets: { el: HTMLElement; rect: number[] }[] = [];
    for (const a of annots) {
      const rect = a.rect as number[] | undefined;
      if (!rect || rect.length !== 4) continue;
      if (a.subtype === 'Link') {
        const link = this.makeLink(a);
        if (!link) continue;
        place(link, rect);
        slot.linkDiv.append(link);
        continue;
      }
      if (a.subtype !== 'Widget' || a.hidden) continue;
      const widget = widgetFrom(a);
      if (!widget || widget.kind === 'button' || widget.kind === 'signature') continue;
      const el = this.makeField(widget, slot.index);
      if (!el) continue;
      place(el, rect);
      widgets.push({ el, rect });
    }
    // Reading order (top to bottom, then start to end), so Tab moves through the form naturally.
    widgets.sort((a, b) => (b.rect[3] - a.rect[3]) || (a.rect[0] - b.rect[0]));
    for (const w of widgets) slot.formDiv.append(w.el);
  }

  private makeLink(a: Record<string, unknown>): HTMLElement | null {
    const url = typeof a.url === 'string' ? a.url : typeof a.unsafeUrl === 'string' ? a.unsafeUrl : '';
    const dest = a.dest as unknown;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'faisal-pdf-link';
    if (url && /^(https?:|mailto:)/i.test(url)) {
      el.title = url;
      el.setAttribute('aria-label', t('pdf.linkExternal', { url }));
      el.addEventListener('click', () => this.hooks.onExternalLink?.(url));
      return el;
    }
    if (dest) {
      el.setAttribute('aria-label', t('pdf.linkInternal'));
      el.addEventListener('click', () => { void this.goToDest(dest); });
      return el;
    }
    return null;
  }

  /** An outline entry or link destination (named or explicit) → the page and point it shows. */
  async goToDest(dest: unknown): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    try {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit.length) return;
      const ref = explicit[0] as unknown;
      const index = typeof ref === 'number' ? ref : await doc.getPageIndex(ref as Parameters<PdfJsDocument['getPageIndex']>[0]);
      const mode = (explicit[1] as { name?: string } | undefined)?.name;
      const y = mode === 'XYZ' ? explicit[3] as number | null : mode === 'FitH' || mode === 'FitBH' ? explicit[2] as number | null : null;
      this.goToPoint(index, typeof y === 'number' ? y : null);
    } catch {
      // A broken destination is simply not followed.
    }
  }

  private makeField(w: FieldWidget, page: number): HTMLElement | null {
    const value = this.hooks.fieldValue(w.name, w.value);
    const label = w.name;
    if (w.kind === 'text') {
      const input = w.multiline ? document.createElement('textarea') : document.createElement('input');
      if (input instanceof HTMLInputElement) input.type = 'text';
      input.className = 'faisal-pdf-fieldinput';
      input.value = value;
      input.dir = 'auto';
      input.readOnly = w.readOnly;
      if (w.maxLen > 0) input.maxLength = w.maxLen;
      input.setAttribute('aria-label', label);
      input.dataset.field = w.name;
      input.dataset.page = String(page);
      input.addEventListener('input', () => this.hooks.onFieldInput(w, input.value));
      return input;
    }
    if (w.kind === 'checkbox' || w.kind === 'radio') {
      const input = document.createElement('input');
      input.type = w.kind === 'checkbox' ? 'checkbox' : 'radio';
      input.className = 'faisal-pdf-fieldcheck';
      if (w.kind === 'radio') input.name = `faisal-pdf-radio-${w.name}`;
      input.checked = value !== '' && value !== 'Off' && value === w.onValue;
      input.disabled = w.readOnly;
      input.setAttribute('aria-label', label);
      input.dataset.field = w.name;
      input.addEventListener('change', () => {
        const next = input.checked ? w.onValue : 'Off';
        this.hooks.onFieldInput(w, next);
        // Keep the other widgets of the same field (a checkbox shown twice, a radio group) in step.
        for (const other of Array.from(this.frame.querySelectorAll<HTMLInputElement>('input.faisal-pdf-fieldcheck'))) {
          if (other !== input && other.dataset.field === w.name && w.kind === 'checkbox') other.checked = input.checked;
        }
      });
      return input;
    }
    if (w.kind === 'choice') {
      const select = document.createElement('select');
      select.className = 'faisal-pdf-fieldinput';
      select.disabled = w.readOnly;
      select.setAttribute('aria-label', label);
      select.dataset.field = w.name;
      for (const option of w.options) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        select.append(node);
      }
      select.value = value;
      select.addEventListener('change', () => this.hooks.onFieldInput(w, select.value));
      return select;
    }
    return null;
  }

  /* ─────────────────────── annotation hit boxes ─────────────────────── */

  setAnnotations(list: readonly AnnotationInfo[]): void {
    this.annotations = [...list];
    for (const slot of this.slots) this.drawAnnotationHits(slot);
  }

  private drawAnnotationHits(slot: Slot): void {
    slot.annotDiv.textContent = '';
    if (!this.hooks.onAnnotationClick) return;
    const t6 = this.transform(slot.index);
    for (const info of this.annotations) {
      if (info.page !== slot.index || !info.kind) continue;
      const box = boxToView(t6, info.rect);
      const hit = document.createElement('button');
      hit.type = 'button';
      hit.className = 'faisal-pdf-annothit';
      hit.style.left = `${box.x}px`;
      hit.style.top = `${box.y}px`;
      hit.style.width = `${Math.max(box.width, 12)}px`;
      hit.style.height = `${Math.max(box.height, 12)}px`;
      hit.setAttribute('aria-label', t('pdf.annotSelect', { kind: t(KIND_KEYS[info.kind]) }));
      hit.addEventListener('click', () => this.hooks.onAnnotationClick?.(info, hit));
      slot.annotDiv.append(hit);
    }
  }

  /* ─────────────────────── pinch and Ctrl+wheel zoom ─────────────────────── */

  private onWheel(ev: WheelEvent): void {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const r = this.scroller.getBoundingClientRect();
    const factor = Math.exp(-ev.deltaY * 0.0025);
    this.setZoom(this.zoomValue * factor, { x: ev.clientX - r.left, y: ev.clientY - r.top });
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.pointerType !== 'touch') return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const r = this.scroller.getBoundingClientRect();
      this.pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom: this.zoomValue,
        x: (a.x + b.x) / 2 - r.left,
        y: (a.y + b.y) / 2 - r.top,
      };
    }
  }

  private onPointerMove(ev: PointerEvent): void {
    if (!this.pointers.has(ev.pointerId)) return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (!this.pinch || this.pointers.size !== 2) return;
    const [a, b] = [...this.pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const next = this.pinch.zoom * (dist / this.pinch.dist);
    if (Math.abs(next - this.zoomValue) / this.zoomValue > 0.02) this.setZoom(next, { x: this.pinch.x, y: this.pinch.y });
  }

  private onPointerEnd(ev: PointerEvent): void {
    this.pointers.delete(ev.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
  }

  get pinching(): boolean { return this.pinch !== null; }
}

/** pdf.js widget data → the small model the form layer needs. */
export function widgetFrom(a: Record<string, unknown>): FieldWidget | null {
  const name = typeof a.fieldName === 'string' ? a.fieldName : '';
  if (!name) return null;
  const type = a.fieldType;
  const rect = a.rect as [number, number, number, number];
  const str = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v));
  const base = {
    name, rect, readOnly: Boolean(a.readOnly), multiline: Boolean(a.multiLine),
    maxLen: typeof a.maxLen === 'number' ? a.maxLen : 0, options: [] as { value: string; label: string }[],
  };
  if (type === 'Tx') return { ...base, kind: 'text', value: str(a.fieldValue), onValue: '' };
  if (type === 'Btn') {
    if (a.pushButton) return { ...base, kind: 'button', value: '', onValue: '' };
    if (a.radioButton) return { ...base, kind: 'radio', value: str(a.fieldValue), onValue: str(a.buttonValue) };
    return { ...base, kind: 'checkbox', value: str(a.fieldValue), onValue: str(a.exportValue) || 'Yes' };
  }
  if (type === 'Ch') {
    const options = Array.isArray(a.options)
      ? (a.options as { exportValue?: unknown; displayValue?: unknown }[]).map((o) => ({ value: str(o.exportValue), label: str(o.displayValue) || str(o.exportValue) }))
      : [];
    return { ...base, kind: 'choice', value: str(a.fieldValue), onValue: '', options };
  }
  if (type === 'Sig') return { ...base, kind: 'signature', value: '', onValue: '' };
  return null;
}
