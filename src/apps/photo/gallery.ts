/**
 * Photo Editor — the file-facing views: image thumbnails, the in-app file/folder picker
 * (a real VFS browser, not a typed path), the Pictures gallery grid and its pan-and-zoom
 * viewer. Bytes come only from the VFS; they are decoded by the browser's own decoders
 * (decode.ts) and never reach the DOM as markup.
 */
import type { Stat, VFS } from '../../kernel/types';
import { t } from '../../kernel/i18n';
import { el, icon, iconButton, button, modal, type Modal } from './ui';
import { decodeSource } from './decode';
import { formatForExtension, extensionOf } from './formats';
import { isProjectPath } from './project';
import { bufferCanvas, canvas2d } from './render';
import { fitView, pinchView, screenToImage, wheelFactor, zoomAbout, type View } from './view';
import type { Point } from './types';

export const PICTURES = '/home/user/Pictures';

export function isImagePath(path: string): boolean {
  const info = formatForExtension(extensionOf(path));
  return !!info && info.canOpen;
}

/* ─────────────────────────────── thumbnails ─────────────────────────────── */

const thumbCache = new Map<string, HTMLCanvasElement>();
let running = 0;
const queue: (() => void)[] = [];

function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running++;
      job().then(resolve, reject).finally(() => {
        running--;
        queue.shift()?.();
      });
    };
    if (running < 3) run();
    else queue.push(run);
  });
}

/** A small canvas thumbnail of an image file (cover-cropped square when `square`). */
export async function thumbnail(vfs: VFS, st: Pick<Stat, 'path' | 'mtime' | 'size'>, size = 160): Promise<HTMLCanvasElement | null> {
  const key = `${st.path}|${st.mtime}|${size}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  if (st.size > 30 * 1024 * 1024) return null;
  return schedule(async () => {
    try {
      const bytes = await vfs.readFile(st.path);
      const info = formatForExtension(extensionOf(st.path));
      let source: CanvasImageSource;
      let w: number;
      let h: number;
      // SVG needs the data: URL path and HEIC the on-demand codec, both inside decodeSource.
      if (info && info.id !== 'svg' && info.id !== 'heic' && typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(new Blob([bytes.slice()], { type: info.mime }));
        source = bmp; w = bmp.width; h = bmp.height;
      } else {
        const decoded = await decodeSource(bytes, st.path);
        source = bufferCanvas(decoded.buffer); w = decoded.buffer.width; h = decoded.buffer.height;
      }
      const s = Math.min(1, (size * 2) / Math.max(w, h));
      const { canvas, ctx } = canvas2d(Math.max(1, w * s), Math.max(1, h * s));
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      if ('close' in source && typeof (source as ImageBitmap).close === 'function') (source as ImageBitmap).close();
      thumbCache.set(key, canvas);
      return canvas;
    } catch {
      return null;
    }
  });
}

/* ─────────────────────────────── file picker ─────────────────────────────── */

export interface PickerOptions {
  mode: 'open' | 'folder';
  start: string;
}

/**
 * A modal VFS browser. Resolves to the chosen path, or null when cancelled. Opens folders on
 * click, shows image thumbnails, and lists `.fphoto` projects alongside images.
 */
export function pickFile(host: HTMLElement, vfs: VFS, opts: PickerOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const dlg: Modal = modal(host, opts.mode === 'open' ? t('photo.pickerTitle') : t('photo.pickerFolderTitle'), 'fp-dialog-wide fp-picker-dialog');
    let result: string | null = null;
    let dir = opts.start;
    const bar = el('div', 'fp-picker-bar');
    const up = iconButton(t('photo.pickerUp'), 'up');
    const home = iconButton(t('photo.pickerHome'), 'folder');
    const crumbs = el('div', 'fp-crumbs');
    crumbs.dir = 'ltr';
    bar.append(up, home, crumbs);
    const list = el('div', 'fp-file-grid');
    list.setAttribute('role', 'list');
    dlg.body.append(bar, list);
    const cancel = button(t('photo.cancel'));
    cancel.addEventListener('click', () => dlg.close());
    dlg.actions.append(cancel);
    if (opts.mode === 'folder') {
      const choose = button(t('photo.pickerChooseFolder'), 'primary', 'check');
      choose.addEventListener('click', () => { result = dir; dlg.close(); });
      dlg.actions.append(choose);
    }
    dlg.onClose(() => { dlg.root.remove(); resolve(result); });

    async function show(path: string): Promise<void> {
      dir = path;
      crumbs.replaceChildren();
      const parts = path.split('/').filter(Boolean);
      parts.forEach((part, i) => {
        const target = `/${parts.slice(0, i + 1).join('/')}`;
        const b = el('button', 'fp-crumb', part);
        b.type = 'button';
        b.disabled = !target.startsWith('/home/user');
        b.addEventListener('click', () => void show(target));
        crumbs.append(b);
        if (i < parts.length - 1) crumbs.append(el('span', 'fp-crumb-sep', '/'));
      });
      up.disabled = path === '/home/user';
      list.replaceChildren(el('p', 'fp-muted', t('photo.pickerLoading')));
      let entries: Stat[] = [];
      try {
        entries = await vfs.readdir(path);
      } catch {
        entries = [];
      }
      if (dir !== path) return;
      const shown = entries
        .filter((e) => !e.name.startsWith('.'))
        .filter((e) => e.type === 'dir' || (opts.mode === 'open' && (isImagePath(e.path) || isProjectPath(e.path))))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
      list.replaceChildren();
      if (!shown.length) list.append(el('p', 'fp-muted', t('photo.pickerEmpty')));
      for (const e of shown) {
        const item = el('button', 'fp-file');
        item.type = 'button';
        item.setAttribute('role', 'listitem');
        item.title = e.name;
        const thumb = el('span', 'fp-file-thumb');
        if (e.type === 'dir') thumb.append(icon('folder'));
        else if (isProjectPath(e.path)) thumb.append(icon('layers'));
        else {
          thumb.append(icon('image'));
          void thumbnail(vfs, e, 96).then((c) => { if (c) { c.className = 'fp-thumb-canvas'; thumb.replaceChildren(c); } });
        }
        const name = el('span', 'fp-file-name', e.name);
        name.dir = 'auto';
        item.append(thumb, name);
        item.addEventListener('click', () => {
          if (e.type === 'dir') void show(e.path);
          else { result = e.path; dlg.close(); }
        });
        list.append(item);
      }
    }
    up.addEventListener('click', () => void show(dir.slice(0, dir.lastIndexOf('/')) || '/home/user'));
    home.addEventListener('click', () => void show('/home/user'));
    dlg.open();
    void vfs.exists(opts.start).then((ok) => show(ok ? opts.start : '/home/user'));
  });
}

/* ─────────────────────────────── gallery ─────────────────────────────── */

export interface GalleryDeps {
  vfs: VFS;
  host: HTMLElement;
  onEdit(path: string, mode: 'quick' | 'pro'): void;
  onImport(): void;
  notify(message: string): void;
}

export interface Gallery {
  root: HTMLElement;
  refresh(): Promise<void>;
  closeViewer(): void;
  destroy(): void;
}

/** The Pictures grid, plus a full-window viewer with pan and zoom. */
export function createGallery(deps: GalleryDeps): Gallery {
  const root = el('section', 'fp-gallery');
  root.setAttribute('aria-label', t('photo.galleryTitle'));
  const head = el('div', 'fp-gallery-head');
  const title = el('h2', 'fp-gallery-title', t('photo.galleryTitle'));
  const count = el('span', 'fp-muted');
  const spacer = el('span', 'fp-spacer');
  const refreshBtn = iconButton(t('photo.galleryRefresh'), 'history');
  const importBtn = button(t('photo.galleryImport'), 'secondary', 'upload');
  head.append(title, count, spacer, refreshBtn, importBtn);
  const grid = el('div', 'fp-gallery-grid');
  grid.setAttribute('role', 'list');
  const empty = el('div', 'fp-empty');
  root.append(head, grid, empty);

  let files: Stat[] = [];
  let destroyed = false;

  /* viewer */
  const viewer = el('div', 'fp-viewer');
  viewer.hidden = true;
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-label', t('photo.galleryTitle'));
  const vbar = el('div', 'fp-viewer-bar');
  const back = iconButton(t('photo.viewerBack'), 'back', 'fp-flip-rtl');
  const vname = el('span', 'fp-viewer-name');
  vname.dir = 'auto';
  const prev = iconButton(t('photo.viewerPrev'), 'back', 'fp-flip-rtl');
  const next = iconButton(t('photo.viewerNext'), 'next', 'fp-flip-rtl');
  const fitBtn = iconButton(t('photo.zoomFit'), 'resize');
  const quick = button(t('photo.viewerEdit'), 'secondary', 'sliders');
  const pro = button(t('photo.viewerPro'), 'primary', 'layers');
  vbar.append(back, vname, el('span', 'fp-spacer'), prev, next, fitBtn, quick, pro);
  const vstage = el('div', 'fp-viewer-stage');
  const vcanvas = el('canvas', 'fp-viewer-canvas');
  vcanvas.setAttribute('aria-hidden', 'true');
  const vstatus = el('div', 'fp-viewer-status fp-muted');
  vstatus.setAttribute('role', 'status');
  vstage.append(vcanvas, vstatus);
  viewer.append(vbar, vstage);
  deps.host.append(viewer);

  let index = -1;
  let image: HTMLCanvasElement | null = null;
  let view: View = { zoom: 1, panX: 0, panY: 0 };
  const pointers = new Map<number, Point>();
  let pinch: { base: View; a: Point; b: Point } | null = null;
  let dragFrom: { p: Point; view: View } | null = null;

  function drawViewer() {
    const r = vstage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    vcanvas.width = Math.max(1, Math.round(r.width * dpr));
    vcanvas.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = vcanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, vcanvas.width, vcanvas.height);
    if (!image) return;
    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
    ctx.imageSmoothingEnabled = view.zoom < 4;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0);
  }

  function fit() {
    if (!image) return;
    const r = vstage.getBoundingClientRect();
    view = fitView({ width: image.width, height: image.height }, { width: r.width, height: r.height }, 16);
    drawViewer();
  }

  async function openViewer(i: number) {
    if (i < 0 || i >= files.length) return;
    index = i;
    const st = files[i];
    viewer.hidden = false;
    vname.textContent = st.name;
    prev.disabled = i === 0;
    next.disabled = i === files.length - 1;
    vstatus.textContent = t('photo.viewerLoading');
    image = null;
    drawViewer();
    try {
      const decoded = await decodeSource(await deps.vfs.readFile(st.path), st.path);
      if (index !== i) return;
      image = bufferCanvas(decoded.buffer);
      vstatus.textContent = '';
      fit();
    } catch {
      vstatus.textContent = t('photo.errorTitle');
    }
    back.focus();
  }

  function closeViewer() {
    viewer.hidden = true;
    image = null;
  }

  back.addEventListener('click', closeViewer);
  prev.addEventListener('click', () => void openViewer(index - 1));
  next.addEventListener('click', () => void openViewer(index + 1));
  fitBtn.addEventListener('click', fit);
  quick.addEventListener('click', () => { const f = files[index]; closeViewer(); if (f) deps.onEdit(f.path, 'quick'); });
  pro.addEventListener('click', () => { const f = files[index]; closeViewer(); if (f) deps.onEdit(f.path, 'pro'); });
  viewer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeViewer(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); void openViewer(index + (document.dir === 'rtl' ? -1 : 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); void openViewer(index + (document.dir === 'rtl' ? 1 : -1)); }
  });
  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = vstage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  vstage.addEventListener('wheel', (e) => {
    e.preventDefault();
    view = zoomAbout(view, view.zoom * wheelFactor(e.deltaY, e.deltaMode), local(e));
    drawViewer();
  }, { passive: false });
  vstage.addEventListener('pointerdown', (e) => {
    vstage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { base: view, a, b };
      dragFrom = null;
    } else {
      dragFrom = { p: local(e), view };
    }
  });
  vstage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      view = pinchView(pinch.base, { a: pinch.a, b: pinch.b }, { a, b });
      drawViewer();
    } else if (dragFrom) {
      const p = local(e);
      view = { ...dragFrom.view, panX: dragFrom.view.panX + p.x - dragFrom.p.x, panY: dragFrom.view.panY + p.y - dragFrom.p.y };
      drawViewer();
    }
  });
  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) dragFrom = null;
  };
  vstage.addEventListener('pointerup', endPointer);
  vstage.addEventListener('pointercancel', endPointer);
  vstage.addEventListener('dblclick', (e) => {
    if (!image) return;
    view = view.zoom >= 1 ? view : zoomAbout(view, 1, local(e));
    drawViewer();
  });
  const ro = new ResizeObserver(() => { if (!viewer.hidden) fit(); });
  ro.observe(vstage);

  function renderEmpty() {
    empty.replaceChildren();
    empty.hidden = files.length > 0;
    if (files.length) return;
    empty.append(emptyIllustration(), el('h3', 'fp-empty-title', t('photo.galleryEmpty')), el('p', 'fp-muted', t('photo.galleryEmptyHint')));
    const act = button(t('photo.galleryImport'), 'primary', 'upload');
    act.addEventListener('click', () => deps.onImport());
    empty.append(act);
  }

  async function refresh(): Promise<void> {
    let entries: Stat[] = [];
    try {
      await deps.vfs.mkdir(PICTURES, { recursive: true });
      entries = await deps.vfs.readdir(PICTURES);
    } catch {
      entries = [];
    }
    if (destroyed) return;
    files = entries.filter((e) => e.type === 'file' && isImagePath(e.path))
      .sort((a, b) => b.mtime - a.mtime);
    count.textContent = files.length ? t('photo.galleryCount', { count: files.length }) : '';
    grid.replaceChildren();
    files.forEach((st, i) => {
      const card = el('button', 'fp-gallery-item');
      card.type = 'button';
      card.setAttribute('role', 'listitem');
      card.title = st.name;
      card.setAttribute('aria-label', st.name);
      const ph = el('span', 'fp-skeleton');
      card.append(ph);
      const cap = el('span', 'fp-gallery-cap', st.name);
      cap.dir = 'auto';
      card.append(cap);
      card.addEventListener('click', () => void openViewer(i));
      grid.append(card);
      void thumbnail(deps.vfs, st, 180).then((c) => {
        if (!c) { ph.replaceChildren(icon('image')); ph.classList.add('fp-thumb-fallback'); return; }
        c.className = 'fp-gallery-img';
        ph.replaceWith(c);
      });
    });
    renderEmpty();
  }

  refreshBtn.addEventListener('click', () => void refresh());
  importBtn.addEventListener('click', () => deps.onImport());

  return {
    root,
    refresh,
    closeViewer,
    destroy() { destroyed = true; ro.disconnect(); viewer.remove(); },
  };
}

/** The empty-state drawing: a stack of photos with a mountain and sun (static SVG). */
export function emptyIllustration(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 160 120');
  svg.setAttribute('class', 'fp-illustration');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attrs: Record<string, string>) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
    return n;
  };
  add('rect', { x: '34', y: '22', width: '92', height: '70', rx: '10', transform: 'rotate(-8 80 57)', class: 'fp-ill-back' });
  add('rect', { x: '30', y: '26', width: '100', height: '74', rx: '10', class: 'fp-ill-card' });
  add('circle', { cx: '58', cy: '50', r: '8', class: 'fp-ill-sun' });
  add('path', { d: 'M36 92l26-26 16 16 14-14 32 24', class: 'fp-ill-line' });
  return svg;
}
