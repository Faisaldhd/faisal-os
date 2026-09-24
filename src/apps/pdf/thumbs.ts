/**
 * PDF app — the page thumbnails panel (الصور المصغّرة للصفحات).
 *
 * One small picture per page, drawn by pdf.js only when it scrolls into the panel. A tap jumps
 * to the page and selects it; Ctrl/⌘ adds or removes a page, Shift selects a range, and the
 * "select several" switch makes plain taps toggle (for touch). Dragging reorders: with a mouse
 * anywhere on the card, with a finger on the grip — the grip is the only part that does not
 * scroll the list, so scrolling the panel with one finger keeps working. Right-click or a long
 * press opens the page menu (rotate, delete, extract, duplicate, insert a blank page).
 */
import { t } from '../../kernel/i18n';
import { icon } from './icons';
import type { PdfJsDocument, PdfJsLib } from './render';
import { outputScale } from './viewport';

export interface ThumbHooks {
  onActivate(page: number, ev: { ctrl: boolean; shift: boolean }): void;
  onMove(pages: number[], to: number): void;
  onMenu(page: number, x: number, y: number, invoker: HTMLElement): void;
}

const THUMB_WIDTH = 104;

export class ThumbPanel {
  readonly root: HTMLDivElement;
  readonly list: HTMLDivElement;
  private items: HTMLDivElement[] = [];
  private drawn = new Map<number, string>();
  private doc: PdfJsDocument | null = null;
  private version = 0;
  private observer: IntersectionObserver | null = null;
  private selection = new Set<number>();
  private current = 0;
  private drag: { pages: number[]; pointer: number; startY: number; active: boolean; source: HTMLElement } | null = null;
  private marker: HTMLDivElement;
  private queue: number[] = [];
  private busy = false;

  constructor(private readonly hooks: ThumbHooks) {
    this.root = document.createElement('div');
    this.root.className = 'faisal-pdf-thumbs';
    this.list = document.createElement('div');
    this.list.className = 'faisal-pdf-thumblist';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-multiselectable', 'true');
    this.list.setAttribute('aria-label', t('pdf.sideThumbs'));
    this.marker = document.createElement('div');
    this.marker.className = 'faisal-pdf-dropmark';
    this.marker.hidden = true;
    this.root.append(this.list);
    if (typeof IntersectionObserver === 'function') {
      this.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.page);
          this.enqueue(index);
        }
      }, { root: this.list, rootMargin: '200px 0px' });
    }
    this.list.addEventListener('pointermove', (ev) => this.onDragMove(ev));
    this.list.addEventListener('pointerup', (ev) => this.onDragEnd(ev, true));
    this.list.addEventListener('pointercancel', (ev) => this.onDragEnd(ev, false));
    this.list.addEventListener('keydown', (ev) => this.onKey(ev));
  }

  /** A new or edited document: rebuild the cards; pictures are redrawn lazily. */
  setDocument(lib: PdfJsLib | null, doc: PdfJsDocument | null, count: number): void {
    this.doc = lib ? doc : null;
    this.version++;
    this.drawn.clear();
    this.queue = [];
    this.observer?.disconnect();
    this.list.textContent = '';
    this.items = [];
    for (let i = 0; i < count; i++) {
      const item = this.makeItem(i);
      this.items.push(item);
      this.list.append(item);
      this.observer?.observe(item);
    }
    this.list.append(this.marker);
    this.refresh();
  }

  setSelection(selection: ReadonlySet<number>, current: number): void {
    this.selection = new Set(selection);
    this.current = current;
    this.refresh();
  }

  /** Keeps the current page's card visible in the panel. */
  reveal(page: number): void {
    const item = this.items[page];
    if (!item || !this.list.isConnected) return;
    const l = this.list.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    if (r.top < l.top || r.bottom > l.bottom) this.list.scrollTop += r.top - l.top - l.height / 3;
  }

  private refresh(): void {
    this.items.forEach((item, i) => {
      const selected = this.selection.has(i);
      item.classList.toggle('is-selected', selected);
      item.classList.toggle('is-current', i === this.current);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = i === this.current ? 0 : -1;
    });
  }

  private makeItem(index: number): HTMLDivElement {
    const item = document.createElement('div');
    item.className = 'faisal-pdf-thumb';
    item.dataset.page = String(index);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-label', t('pdf.pageN', { n: index + 1 }));
    const pic = document.createElement('div');
    pic.className = 'faisal-pdf-thumbpic';
    const foot = document.createElement('div');
    foot.className = 'faisal-pdf-thumbfoot';
    const num = document.createElement('span');
    num.className = 'faisal-pdf-thumbnum';
    num.textContent = String(index + 1);
    const grip = document.createElement('span');
    grip.className = 'faisal-pdf-thumbgrip';
    grip.setAttribute('aria-hidden', 'true');
    grip.append(icon('grip'));
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'faisal-pdf-thumbmore';
    more.setAttribute('aria-label', t('pdf.pageMenu', { n: index + 1 }));
    more.title = t('pdf.pageMenu', { n: index + 1 });
    more.append(icon('more'));
    more.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const r = more.getBoundingClientRect();
      this.hooks.onMenu(index, r.left, r.bottom, more);
    });
    foot.append(grip, num, more);
    item.append(pic, foot);
    item.addEventListener('click', (ev) => {
      if (this.drag?.active) return;
      this.hooks.onActivate(index, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey });
    });
    item.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.hooks.onMenu(index, ev.clientX, ev.clientY, item);
    });
    // Long press (touch) opens the page menu; moving the finger cancels it, so scrolling works.
    let press = 0;
    let pressAt = { x: 0, y: 0 };
    item.addEventListener('pointerdown', (ev) => {
      const onGrip = (ev.target as Element).closest('.faisal-pdf-thumbgrip');
      if (ev.pointerType === 'mouse' && ev.button === 0 || onGrip) this.startDrag(ev, index, item);
      if (ev.pointerType === 'touch' && !onGrip) {
        pressAt = { x: ev.clientX, y: ev.clientY };
        window.clearTimeout(press);
        press = window.setTimeout(() => this.hooks.onMenu(index, pressAt.x, pressAt.y, item), 550);
      }
    });
    item.addEventListener('pointermove', (ev) => {
      if (Math.hypot(ev.clientX - pressAt.x, ev.clientY - pressAt.y) > 10) window.clearTimeout(press);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      item.addEventListener(type, () => window.clearTimeout(press));
    }
    return item;
  }

  /* ───────────────────────────── drawing ───────────────────────────── */

  private enqueue(index: number): void {
    if (this.drawn.get(index) === String(this.version) || this.queue.includes(index)) return;
    this.queue.push(index);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const index = this.queue.shift() as number;
        await this.draw(index);
      }
    } finally {
      this.busy = false;
    }
  }

  private async draw(index: number): Promise<void> {
    const doc = this.doc;
    const version = this.version;
    const item = this.items[index];
    if (!doc || !item) return;
    try {
      const page = await doc.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
      const ratio = outputScale(viewport.width, viewport.height, Math.min(2, window.devicePixelRatio || 1), 400_000);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.setAttribute('aria-hidden', 'true');
      await page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
      if (version !== this.version) return;
      const pic = item.querySelector('.faisal-pdf-thumbpic');
      if (!pic) return;
      pic.textContent = '';
      pic.append(canvas);
      (pic as HTMLElement).style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      this.drawn.set(index, String(version));
    } catch {
      // A page that cannot be drawn keeps its placeholder; the number still identifies it.
    }
  }

  /* ───────────────────────────── reordering ───────────────────────────── */

  private startDrag(ev: PointerEvent, index: number, source: HTMLElement): void {
    const pages = this.selection.has(index) ? [...this.selection].sort((a, b) => a - b) : [index];
    this.drag = { pages, pointer: ev.pointerId, startY: ev.clientY, active: false, source };
  }

  private dropIndex(clientY: number): number {
    for (let i = 0; i < this.items.length; i++) {
      const r = this.items[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return this.items.length;
  }

  private onDragMove(ev: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointer !== ev.pointerId) return;
    if (!drag.active) {
      if (Math.abs(ev.clientY - drag.startY) < 8) return;
      drag.active = true;
      try { this.list.setPointerCapture(ev.pointerId); } catch { /* the pointer already ended */ }
      this.root.classList.add('is-dragging');
      for (const p of drag.pages) this.items[p]?.classList.add('is-dragged');
    }
    ev.preventDefault();
    const to = this.dropIndex(ev.clientY);
    const anchor = this.items[Math.min(to, this.items.length - 1)];
    if (!anchor) return;
    const l = this.list.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    const y = to >= this.items.length ? r.bottom + 4 : r.top - 4;
    this.marker.hidden = false;
    this.marker.style.top = `${y - l.top + this.list.scrollTop}px`;
    // Scroll the panel while dragging near its edges.
    if (ev.clientY < l.top + 32) this.list.scrollTop -= 12;
    else if (ev.clientY > l.bottom - 32) this.list.scrollTop += 12;
  }

  private onDragEnd(ev: PointerEvent, drop: boolean): void {
    const drag = this.drag;
    if (!drag || drag.pointer !== ev.pointerId) return;
    this.drag = null;
    this.marker.hidden = true;
    this.root.classList.remove('is-dragging');
    for (const item of this.items) item.classList.remove('is-dragged');
    if (!drag.active || !drop) return;
    // The click that follows a drag must not also select the page.
    const swallow = (e: Event): void => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    const to = this.dropIndex(ev.clientY);
    this.hooks.onMove(drag.pages, to);
  }

  private onKey(ev: KeyboardEvent): void {
    const item = (ev.target as HTMLElement).closest('.faisal-pdf-thumb') as HTMLElement | null;
    if (!item) return;
    const index = Number(item.dataset.page);
    let next = index;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight' && document.dir !== 'rtl') next = index + 1;
    else if (ev.key === 'ArrowUp') next = index - 1;
    else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      this.hooks.onActivate(index, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey });
      return;
    } else if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
      ev.preventDefault();
      const r = item.getBoundingClientRect();
      this.hooks.onMenu(index, r.left + 16, r.top + 16, item);
      return;
    } else return;
    ev.preventDefault();
    const target = this.items[Math.max(0, Math.min(this.items.length - 1, next))];
    target?.focus();
  }
}
