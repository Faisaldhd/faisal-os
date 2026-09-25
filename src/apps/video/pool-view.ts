/**
 * The media pool panel (the mockup's left "Media Pool"): tabs for All / Video /
 * Audio / Images, import from Files or from the device, and a grid of cards with
 * a thumbnail, the duration and the resolution. A card is dragged onto the
 * timeline with a mouse, or added with its "+" button (touch and keyboard).
 */
import type { MediaItem, MediaLibrary } from './media';
import type { MediaType } from './project';
import { MEDIA_DRAG_TYPE } from './timeline-view';
import { button, el, iconButton, s } from './ui';
import { formatMediaTime } from './time';
import { icon } from './icons';

export type PoolFilter = 'all' | MediaType;

export interface PoolHost {
  importFromFiles(filter: PoolFilter): void;
  importFromDevice(): void;
  add(item: MediaItem): void;
  relink(item: MediaItem): void;
  convert(item: MediaItem): void;
  remove(item: MediaItem): void;
  inUse(id: string): boolean;
}

export class PoolView {
  readonly root: HTMLElement;
  private readonly grid: HTMLElement;
  private filter: PoolFilter = 'all';
  private readonly tabButtons = new Map<PoolFilter, HTMLButtonElement>();

  constructor(private readonly library: MediaLibrary, private readonly host: PoolHost) {
    this.root = el('div', 'fvs-pool');
    const head = el('div', 'fvs-panel-head');
    head.append(el('h2', 'fvs-panel-title', s('mediaPool')));
    const tabs = el('div', 'fvs-tabs is-small');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', s('mediaPool'));
    for (const [key, label] of [['all', s('filterAll')], ['video', s('filterVideo')], ['audio', s('filterAudio')], ['image', s('filterImage')]] as Array<[PoolFilter, string]>) {
      const b = el('button', 'fvs-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.setFilter(key));
      this.tabButtons.set(key, b);
      tabs.append(b);
    }
    const actions = el('div', 'fvs-pool-actions');
    const fromFiles = button(s('importFiles'), 'fvs-btn is-primary', 'folder');
    fromFiles.addEventListener('click', () => this.host.importFromFiles(this.filter));
    const fromDevice = button(s('importDevice'), 'fvs-btn', 'upload');
    fromDevice.addEventListener('click', () => this.host.importFromDevice());
    actions.append(fromFiles, fromDevice);
    this.grid = el('div', 'fvs-pool-grid');
    this.grid.setAttribute('role', 'list');
    this.root.append(head, tabs, actions, this.grid);
    this.setFilter('all');
    library.onChange(() => this.render());
  }

  setFilter(filter: PoolFilter): void {
    this.filter = filter;
    for (const [key, b] of this.tabButtons) {
      b.setAttribute('aria-selected', String(key === filter));
      b.tabIndex = key === filter ? 0 : -1;
    }
    this.render();
  }

  render(): void {
    const items = this.library.items.filter((m) => this.filter === 'all' || m.type === this.filter);
    this.grid.replaceChildren();
    if (items.length === 0) {
      const empty = el('div', 'fvs-empty-state is-compact');
      const art = el('div', 'fvs-empty-art');
      art.append(icon(this.filter === 'audio' ? 'music' : this.filter === 'image' ? 'image' : 'film'));
      empty.append(art, el('p', 'fvs-empty-title', s('poolEmpty')), el('p', 'fvs-empty-hint', s('poolEmptyHint')));
      this.grid.append(empty);
      return;
    }
    for (const item of items) this.grid.append(this.card(item));
  }

  private card(item: MediaItem): HTMLElement {
    const card = el('div', `fvs-card is-${item.type} is-${item.status}`);
    card.setAttribute('role', 'listitem');
    const thumb = el('div', 'fvs-card-thumb');
    const poster = item.thumbs[Math.min(1, item.thumbs.length - 1)];
    if (item.status === 'loading') {
      thumb.append(el('span', 'fvs-spinner'));
    } else if (poster) {
      const c = el('canvas', 'fvs-card-canvas');
      c.width = poster.width;
      c.height = poster.height;
      c.getContext('2d')?.drawImage(poster, 0, 0);
      c.setAttribute('aria-hidden', 'true');
      thumb.append(c);
    } else if (item.type === 'audio' && item.peaks) {
      const c = el('canvas', 'fvs-card-canvas');
      c.width = 160;
      c.height = 90;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#3DD68C';
        for (let x = 0; x < 160; x += 3) {
          const v = item.peaks[Math.floor((x / 160) * item.peaks.length)] ?? 0;
          const h = Math.max(2, v * 70);
          ctx.fillRect(x, 45 - h / 2, 2, h);
        }
      }
      thumb.append(c);
    } else {
      thumb.append(icon(item.type === 'audio' ? 'music' : item.type === 'image' ? 'image' : 'film'));
    }
    const kind = el('span', 'fvs-card-kind');
    kind.append(icon(item.type === 'audio' ? 'music' : item.type === 'image' ? 'image' : 'film'));
    thumb.append(kind);
    if (item.type !== 'image' && item.duration > 0) thumb.append(el('span', 'fvs-card-duration', formatMediaTime(item.duration)));
    const name = el('span', 'fvs-card-name', item.name);
    name.dir = 'auto';
    name.title = item.path ?? item.name;
    const meta = el('span', 'fvs-card-meta');
    if (item.status === 'offline') meta.textContent = s('offline');
    else if (item.status === 'error') meta.textContent = item.error;
    else if (item.status === 'loading') meta.textContent = s('loadingMedia');
    else meta.textContent = item.width > 0 ? `${item.width}×${item.height}` : item.hasAudio ? s('audioOnly') : '';
    const info = el('div', 'fvs-card-info');
    info.append(name, meta);
    card.append(thumb, info);
    const row = el('div', 'fvs-card-actions');
    if (item.status === 'ready') {
      card.draggable = true;
      card.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData(MEDIA_DRAG_TYPE, item.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      });
      card.addEventListener('dblclick', () => this.host.add(item));
      const add = iconButton(s('addToTimeline', { name: item.name }), 'plus', 'fvs-iconbtn is-accent');
      add.addEventListener('click', () => this.host.add(item));
      row.append(add);
    } else if (item.status === 'error' && item.convertible) {
      const convert = button(s('convert'), 'fvs-btn is-small is-primary', 'convert');
      convert.setAttribute('aria-label', s('convertName', { name: item.name }));
      convert.addEventListener('click', () => this.host.convert(item));
      row.append(convert);
    } else if (item.status === 'offline') {
      const relink = button(s('relink'), 'fvs-btn is-small', 'link');
      relink.addEventListener('click', () => this.host.relink(item));
      row.append(relink);
    }
    if (!this.host.inUse(item.id) && item.status !== 'loading') {
      const remove = iconButton(s('removeFromPool', { name: item.name }), 'trash', 'fvs-iconbtn');
      remove.addEventListener('click', () => this.host.remove(item));
      row.append(remove);
    }
    card.append(row);
    return card;
  }
}
