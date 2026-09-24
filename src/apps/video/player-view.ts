/**
 * Player mode — the "just watch it" side of Video Studio (the owner's item 2):
 *
 *  • cinematic controls over the picture: play/pause, previous/next, a seek bar,
 *    volume, speed 0.5×–2×, fullscreen;
 *  • a playlist drawer: add several clips, drag to reorder, tap to switch; the
 *    next clip starts when one ends;
 *  • trim: two handles on the seek bar pick a start and an end, playback stays
 *    inside them, and "Save selection" writes only that part.
 *
 * The seek bar is LTR in both languages (time runs left to right); the controls
 * around it mirror with the interface.
 */
import type { StudioEngine } from './engine-port';
import type { MediaItem, MediaLibrary } from './media';
import {
  addToPlaylist,
  EMPTY_PLAYLIST,
  isWholeFile,
  moveTrimHandle,
  nextIndex,
  previousIndex,
  removeFromPlaylist,
  reorderPlaylist,
  selectItem,
  type Playlist,
  type PlaylistItem,
} from './playlist';
import { appendClip, emptyProject, insertClip, makeMediaClip, type Project } from './project';
import { button, el, formatClock, iconButton, s, setIcon } from './ui';
import { icon } from './icons';

export const PLAYER_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export interface PlayerHost {
  engine: StudioEngine;
  library: MediaLibrary;
  showProject(project: Project): void;
  addClips(): void;
  openInEditor(ids: string[]): void;
  saveSelection(item: MediaItem, range: { start: number; end: number }): void;
  toggleFullscreen(target: HTMLElement): void;
  status(text: string): void;
  narrow(): boolean;
  openSheet(panel: HTMLElement, title: string): void;
  closeSheet(): void;
}

export class PlayerView {
  readonly root: HTMLElement;
  readonly stage: HTMLElement;
  readonly drawer: HTMLElement;
  private readonly canvasHost: HTMLElement;
  private readonly list: HTMLElement;
  private readonly seek: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly sel: HTMLElement;
  private readonly inHandle: HTMLElement;
  private readonly outHandle: HTMLElement;
  private readonly timeLabel: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly volume: HTMLInputElement;
  private readonly speedBtn: HTMLButtonElement;
  private readonly trimBtn: HTMLButtonElement;
  private readonly listBtn: HTMLButtonElement;
  private readonly trimBar: HTMLElement;
  private readonly trimInfo: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly empty: HTMLElement;
  private playlist: Playlist = EMPTY_PLAYLIST;
  private trimming = false;
  private speed = 1;
  private muted = false;
  private vol = 1;
  private active = false;
  private drawerOpen = true;
  private wasPlaying = false;
  private drag: { pointerId: number; from: number; row: HTMLElement; startY: number } | null = null;
  private seekDrag: { pointerId: number; what: 'seek' | 'in' | 'out' } | null = null;

  constructor(private readonly host: PlayerHost) {
    this.root = el('div', 'fvs-player');
    this.stage = el('div', 'fvs-player-stage');
    this.canvasHost = el('div', 'fvs-player-canvas');
    this.empty = el('div', 'fvs-player-empty');
    const emptyArt = el('div', 'fvs-empty-art is-large');
    emptyArt.append(icon('playlist'));
    const addFirst = button(s('addClips'), 'fvs-btn is-primary', 'plus');
    addFirst.addEventListener('click', () => this.host.addClips());
    this.empty.append(emptyArt, el('p', 'fvs-empty-title', s('playerEmpty')), el('p', 'fvs-empty-hint', s('playerEmptyHint')), addFirst);

    // Controls (glass) over the bottom of the picture.
    const controls = el('div', 'fvs-player-controls');
    this.seek = el('div', 'fvs-seek');
    this.seek.dir = 'ltr';
    this.seek.tabIndex = 0;
    this.seek.setAttribute('role', 'slider');
    this.seek.setAttribute('aria-label', s('seekBar'));
    const track = el('div', 'fvs-seek-track');
    this.sel = el('div', 'fvs-seek-sel');
    this.fill = el('div', 'fvs-seek-fill');
    const thumb = el('div', 'fvs-seek-thumb');
    this.fill.append(thumb);
    this.inHandle = el('div', 'fvs-seek-handle is-in');
    this.inHandle.setAttribute('role', 'slider');
    this.inHandle.setAttribute('aria-label', s('trimStart'));
    this.inHandle.tabIndex = 0;
    this.outHandle = el('div', 'fvs-seek-handle is-out');
    this.outHandle.setAttribute('role', 'slider');
    this.outHandle.setAttribute('aria-label', s('trimEnd'));
    this.outHandle.tabIndex = 0;
    track.append(this.sel, this.fill);
    this.seek.append(track, this.inHandle, this.outHandle);

    const row = el('div', 'fvs-player-row');
    const prev = iconButton(s('previousClip'), 'prev');
    prev.addEventListener('click', () => this.step(-1));
    this.playBtn = iconButton(s('play'), 'play', 'fvs-iconbtn is-play');
    this.playBtn.addEventListener('click', () => void this.togglePlay());
    const next = iconButton(s('nextClip'), 'next');
    next.addEventListener('click', () => this.step(1));
    this.timeLabel = el('span', 'fvs-player-time', '0:00 / 0:00');
    this.timeLabel.dir = 'ltr';
    const spacer = el('span', 'fvs-spacer');
    this.muteBtn = iconButton(s('mute'), 'volume');
    this.muteBtn.addEventListener('click', () => this.setMuted(!this.muted));
    this.volume = el('input', 'fvs-range is-volume');
    this.volume.type = 'range';
    this.volume.min = '0';
    this.volume.max = '1';
    this.volume.step = '0.01';
    this.volume.value = '1';
    this.volume.setAttribute('aria-label', s('volume'));
    this.volume.style.setProperty('--fill', '100%');
    this.volume.addEventListener('input', () => {
      this.vol = Number(this.volume.value);
      this.volume.style.setProperty('--fill', `${this.vol * 100}%`);
      this.host.engine.setVolume(this.vol);
      if (this.vol > 0 && this.muted) this.setMuted(false);
    });
    this.speedBtn = button('1×', 'fvs-btn is-ghost fvs-speed');
    this.speedBtn.setAttribute('aria-label', s('speed'));
    this.speedBtn.title = s('speed');
    this.speedBtn.setAttribute('aria-haspopup', 'menu');
    this.speedBtn.addEventListener('click', () => this.speedMenu());
    this.trimBtn = iconButton(s('trimTool'), 'trim');
    this.trimBtn.setAttribute('aria-pressed', 'false');
    this.trimBtn.addEventListener('click', () => this.setTrimming(!this.trimming));
    this.listBtn = iconButton(s('playlist'), 'playlist');
    this.listBtn.setAttribute('aria-pressed', 'true');
    this.listBtn.addEventListener('click', () => this.toggleDrawer());
    const full = iconButton(s('fullscreen'), 'expand');
    full.addEventListener('click', () => this.host.toggleFullscreen(this.stage));
    const edit = button(s('openInEditor'), 'fvs-btn is-ghost fvs-player-edit', 'layers');
    edit.addEventListener('click', () => this.host.openInEditor(this.playlist.items.map((i) => i.mediaId)));
    const volWrap = el('div', 'fvs-volume');
    volWrap.append(this.muteBtn, this.volume);
    row.append(prev, this.playBtn, next, this.timeLabel, spacer, volWrap, this.speedBtn, this.trimBtn, this.listBtn, full, edit);
    controls.append(this.seek, row);

    // Trim bar.
    this.trimBar = el('div', 'fvs-trimbar');
    this.trimBar.hidden = true;
    this.trimInfo = el('span', 'fvs-trim-info');
    this.trimInfo.dir = 'ltr';
    const setIn = button(s('setIn'), 'fvs-btn is-small');
    setIn.addEventListener('click', () => this.markHere('in'));
    const setOut = button(s('setOut'), 'fvs-btn is-small');
    setOut.addEventListener('click', () => this.markHere('out'));
    const reset = button(s('resetTrim'), 'fvs-btn is-small');
    reset.addEventListener('click', () => this.updateItem({ in: 0, out: null }));
    this.saveBtn = button(s('saveSelection'), 'fvs-btn is-primary is-small', 'save');
    this.saveBtn.addEventListener('click', () => this.saveSelection());
    this.trimBar.append(this.trimInfo, setIn, setOut, reset, this.saveBtn);

    this.stage.append(this.canvasHost, this.empty, controls);

    // Playlist drawer.
    this.drawer = el('aside', 'fvs-playlist');
    const head = el('div', 'fvs-panel-head');
    head.append(el('h2', 'fvs-panel-title', s('playlist')));
    const add = iconButton(s('addClips'), 'plus', 'fvs-iconbtn is-accent');
    add.addEventListener('click', () => this.host.addClips());
    head.append(add);
    this.list = el('ol', 'fvs-playlist-list');
    this.list.setAttribute('aria-label', s('playlist'));
    this.drawer.append(head, this.list, el('p', 'fvs-note', s('playlistHint')));

    const main = el('div', 'fvs-player-main');
    main.append(this.stage, this.trimBar);
    this.root.append(main, this.drawer);

    this.wireSeek();
    this.host.engine.onTick(() => { if (this.active) this.paintTime(); });
    this.host.engine.onState(() => { if (this.active) this.onEngineState(); });
    this.host.library.onChange(() => { if (this.active) this.renderList(); });
    this.renderList();
  }

  /* ───────────── lifecycle ───────────── */

  activate(): void {
    this.active = true;
    this.canvasHost.append(this.host.engine.canvas);
    this.host.engine.setRate(this.speed);
    this.host.engine.setVolume(this.vol);
    this.host.engine.setMuted(this.muted);
    this.host.engine.setLoop(null, false);
    this.load();
    this.renderList();
  }

  deactivate(): void {
    this.active = false;
    this.host.engine.pause();
    this.host.engine.setStopAt(null);
    this.host.engine.setRate(1);
  }

  get items(): PlaylistItem[] {
    return this.playlist.items;
  }

  currentMedia(): MediaItem | undefined {
    const item = this.playlist.items[this.playlist.current];
    return item ? this.host.library.get(item.mediaId) : undefined;
  }

  /** Adds media to the playlist; the first one added plays when `play` is set. */
  add(ids: string[], play = false): void {
    const wasEmpty = this.playlist.items.length === 0;
    const before = this.playlist.items.length;
    this.playlist = addToPlaylist(this.playlist, ids);
    if (play && !wasEmpty) this.playlist = selectItem(this.playlist, before);
    this.renderList();
    if (this.active && (wasEmpty || play)) {
      this.load();
      if (play) void this.host.engine.play();
    }
  }

  /** Builds the one-clip project for the current item and hands it to the engine. */
  private load(): void {
    const media = this.currentMedia();
    this.empty.hidden = Boolean(media) && media?.status !== 'error';
    const [title, hint] = [this.empty.querySelector('.fvs-empty-title'), this.empty.querySelector('.fvs-empty-hint')];
    if (title) title.textContent = media?.status === 'error' ? media.name : s('playerEmpty');
    if (hint) hint.textContent = media?.status === 'error' ? media.error : s('playerEmptyHint');
    if (!media || media.status === 'error') {
      this.host.showProject(emptyProject('auto'));
      this.paintTime();
      return;
    }
    let project = emptyProject('auto', media.name);
    if (media.type === 'audio') project = insertClip(project, 'audio-1', makeMediaClip('audio', media.id, media.duration), 0);
    else project = appendClip(project, 'main', makeMediaClip(media.type, media.id, media.type === 'image' ? 0 : media.duration));
    this.host.showProject(project);
    this.host.engine.seek(this.selection().start);
    this.applyStop();
    this.paintTime();
    this.renderList();
  }

  /* ───────────── transport ───────────── */

  async togglePlay(): Promise<void> {
    const engine = this.host.engine;
    if (!this.currentMedia()) return;
    if (engine.playing) engine.pause();
    else {
      const sel = this.selection();
      if (this.trimming && (engine.time < sel.start || engine.time >= sel.end - 0.02)) engine.seek(sel.start);
      await engine.play();
    }
    this.paintPlay();
  }

  step(direction: -1 | 1): void {
    const index = direction > 0 ? nextIndex(this.playlist) : previousIndex(this.playlist);
    if (index < 0) return;
    const playing = this.host.engine.playing;
    this.host.engine.pause();
    this.playlist = selectItem(this.playlist, index);
    this.load();
    if (playing) void this.host.engine.play();
  }

  setSpeed(rate: number): void {
    this.speed = rate;
    this.host.engine.setRate(rate);
    this.speedBtn.querySelector('.fvs-btn-label')!.textContent = `${rate}×`;
    this.host.status(s('speedIs', { x: rate }));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.host.engine.setMuted(muted);
    setIcon(this.muteBtn, muted ? 'mute' : 'volume', muted ? s('unmute') : s('mute'));
  }

  private onEngineState(): void {
    this.paintPlay();
    const engine = this.host.engine;
    const sel = this.selection();
    const ended = !engine.playing && this.wasPlaying && engine.time >= sel.end - 0.05;
    this.wasPlaying = engine.playing;
    if (ended && !this.trimming) {
      const next = nextIndex(this.playlist);
      if (next >= 0) {
        this.playlist = selectItem(this.playlist, next);
        this.load();
        void engine.play();
      }
    }
  }

  private paintPlay(): void {
    const playing = this.host.engine.playing;
    setIcon(this.playBtn, playing ? 'pause' : 'play', playing ? s('pause') : s('play'));
    this.stage.classList.toggle('is-playing', playing);
  }

  private duration(): number {
    return this.host.engine.duration;
  }

  paintTime(): void {
    const d = this.duration();
    const t = this.host.engine.time;
    this.timeLabel.textContent = `${formatClock(t)} / ${formatClock(d)}`;
    const pct = d > 0 ? (t / d) * 100 : 0;
    this.fill.style.width = `${pct}%`;
    this.seek.setAttribute('aria-valuemin', '0');
    this.seek.setAttribute('aria-valuemax', String(Math.round(d)));
    this.seek.setAttribute('aria-valuenow', String(Math.round(t)));
    this.seek.setAttribute('aria-valuetext', `${formatClock(t)} / ${formatClock(d)}`);
    const sel = this.selection();
    const a = d > 0 ? (sel.start / d) * 100 : 0;
    const b = d > 0 ? (sel.end / d) * 100 : 100;
    this.sel.style.left = `${a}%`;
    this.sel.style.width = `${Math.max(0, b - a)}%`;
    this.inHandle.style.left = `${a}%`;
    this.outHandle.style.left = `${b}%`;
    this.inHandle.setAttribute('aria-valuetext', formatClock(sel.start));
    this.outHandle.setAttribute('aria-valuetext', formatClock(sel.end));
    this.trimInfo.textContent = s('selectionInfo', { from: formatClock(sel.start), to: formatClock(sel.end), len: formatClock(sel.end - sel.start) });
    const media = this.currentMedia();
    this.saveBtn.disabled = !media || media.type === 'image' || isWholeFile(this.item() ?? { in: 0, out: null }, d);
  }

  /* ───────────── trim ───────────── */

  private item(): PlaylistItem | undefined {
    return this.playlist.items[this.playlist.current];
  }

  selection(): { start: number; end: number } {
    const item = this.item();
    const d = this.duration();
    if (!item) return { start: 0, end: d };
    return { start: Math.min(item.in, d), end: item.out === null ? d : Math.min(item.out, d) };
  }

  setTrimming(on: boolean): void {
    this.trimming = on;
    this.trimBtn.setAttribute('aria-pressed', String(on));
    this.root.classList.toggle('is-trimming', on);
    this.trimBar.hidden = !on;
    this.applyStop();
    this.paintTime();
    if (on) this.host.status(s('trimHint'));
  }

  get isTrimming(): boolean {
    return this.trimming;
  }

  private applyStop(): void {
    const sel = this.selection();
    this.host.engine.setStopAt(this.trimming ? sel.end : null);
  }

  private updateItem(patch: { in: number; out: number | null }): void {
    const index = this.playlist.current;
    if (index < 0) return;
    const items = this.playlist.items.slice();
    items[index] = { ...items[index], ...patch };
    this.playlist = { ...this.playlist, items };
    this.applyStop();
    this.paintTime();
  }

  markHere(which: 'in' | 'out'): void {
    const item = this.item();
    if (!item) return;
    if (!this.trimming) this.setTrimming(true);
    this.updateItem(moveTrimHandle(item, which, this.host.engine.time, this.duration()));
  }

  private saveSelection(): void {
    const media = this.currentMedia();
    if (!media) return;
    this.host.engine.pause();
    this.host.saveSelection(media, this.selection());
  }

  /* ───────────── seek bar ───────────── */

  private seekTime(clientX: number): number {
    const r = this.seek.getBoundingClientRect();
    const f = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return Math.max(0, Math.min(1, f)) * this.duration();
  }

  private wireSeek(): void {
    const down = (what: 'seek' | 'in' | 'out') => (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      this.seekDrag = { pointerId: event.pointerId, what };
      this.wasPlaying = this.host.engine.playing;
      this.move(event);
    };
    this.seek.addEventListener('pointerdown', down('seek'));
    this.inHandle.addEventListener('pointerdown', down('in'));
    this.outHandle.addEventListener('pointerdown', down('out'));
    for (const target of [this.seek, this.inHandle, this.outHandle]) {
      target.addEventListener('pointermove', (event) => this.move(event));
      target.addEventListener('pointerup', (event) => {
        if (this.seekDrag?.pointerId === event.pointerId) this.seekDrag = null;
      });
      target.addEventListener('pointercancel', () => { this.seekDrag = null; });
    }
    const keys = (which: 'seek' | 'in' | 'out') => (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 5 : 1);
      if (which === 'seek') this.host.engine.seek(this.host.engine.time + delta);
      else {
        const sel = this.selection();
        this.updateItem(moveTrimHandle(this.item() ?? { in: 0, out: null }, which, (which === 'in' ? sel.start : sel.end) + delta * 0.1, this.duration()));
      }
      this.paintTime();
    };
    this.seek.addEventListener('keydown', keys('seek'));
    this.inHandle.addEventListener('keydown', keys('in'));
    this.outHandle.addEventListener('keydown', keys('out'));
  }

  private move(event: PointerEvent): void {
    const drag = this.seekDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const t = this.seekTime(event.clientX);
    if (drag.what === 'seek') {
      this.host.engine.seek(t);
    } else {
      const item = this.item();
      if (!item) return;
      const next = moveTrimHandle(item, drag.what, t, this.duration());
      this.updateItem(next);
      this.host.engine.seek(drag.what === 'in' ? next.in : Math.max(next.in, next.out - 1 / 30));
    }
    this.paintTime();
  }

  /* ───────────── speed menu ───────────── */

  private speedMenu(): void {
    const menu = el('div', 'fvs-menu');
    menu.setAttribute('role', 'menu');
    const close = () => {
      menu.remove();
      document.removeEventListener('pointerdown', outside, true);
      this.speedBtn.setAttribute('aria-expanded', 'false');
      this.speedBtn.focus();
    };
    const outside = (event: Event) => {
      if (!menu.contains(event.target as Node) && event.target !== this.speedBtn) close();
    };
    for (const rate of PLAYER_SPEEDS) {
      const item = button(`${rate}×`, 'fvs-menu-item');
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(rate === this.speed));
      item.addEventListener('click', () => {
        this.setSpeed(rate);
        close();
      });
      menu.append(item);
    }
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    });
    this.stage.append(menu);
    this.speedBtn.setAttribute('aria-expanded', 'true');
    const b = this.speedBtn.getBoundingClientRect();
    const st = this.stage.getBoundingClientRect();
    menu.style.insetInlineStart = 'auto';
    menu.style.left = `${Math.max(8, Math.min(st.width - 120, b.left - st.left))}px`;
    menu.style.bottom = `${Math.max(8, st.bottom - b.top + 8)}px`;
    document.addEventListener('pointerdown', outside, true);
    (menu.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
  }

  /* ───────────── playlist drawer ───────────── */

  toggleDrawer(): void {
    if (this.host.narrow()) {
      this.host.openSheet(this.drawer, s('playlist'));
      return;
    }
    this.drawerOpen = !this.drawerOpen;
    this.root.classList.toggle('is-drawer-closed', !this.drawerOpen);
    this.listBtn.setAttribute('aria-pressed', String(this.drawerOpen));
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (this.playlist.items.length === 0) {
      this.list.append(el('li', 'fvs-note', s('playlistEmpty')));
      return;
    }
    this.playlist.items.forEach((item, index) => {
      const media = this.host.library.get(item.mediaId);
      const row = el('li', 'fvs-pl-row');
      if (index === this.playlist.current) row.classList.add('is-current');
      const grip = el('span', 'fvs-pl-grip');
      grip.title = s('dragToReorder');
      grip.setAttribute('aria-hidden', 'true');
      grip.append(icon('grip'));
      const main = el('button', 'fvs-pl-main');
      main.type = 'button';
      main.setAttribute('aria-current', String(index === this.playlist.current));
      const thumb = el('span', 'fvs-pl-thumb');
      const poster = media?.thumbs[Math.min(1, (media?.thumbs.length ?? 1) - 1)];
      if (poster) {
        const c = el('canvas');
        c.width = poster.width;
        c.height = poster.height;
        c.getContext('2d')?.drawImage(poster, 0, 0);
        thumb.append(c);
      } else {
        thumb.append(icon(media?.type === 'audio' ? 'music' : media?.type === 'image' ? 'image' : 'film'));
      }
      const text = el('span', 'fvs-pl-text');
      const name = el('span', 'fvs-pl-name', media?.name ?? '');
      name.dir = 'auto';
      const meta = el('span', 'fvs-pl-meta', media?.status === 'loading' ? s('loadingMedia') : media?.status === 'error' ? media.error : media && media.duration > 0 ? formatClock(media.duration) : '');
      text.append(name, meta);
      if (index === this.playlist.current) {
        const now = el('span', 'fvs-pl-now');
        now.append(icon('play'));
        text.append(now);
      }
      main.append(thumb, text);
      main.addEventListener('click', () => {
        if (this.drag) return;
        this.playlist = selectItem(this.playlist, index);
        this.load();
        void this.host.engine.play();
        if (this.host.narrow()) this.host.closeSheet();
      });
      const up = iconButton(s('moveUp'), 'chevronDown', 'fvs-iconbtn is-small fvs-pl-up');
      up.disabled = index === 0;
      up.addEventListener('click', () => { this.playlist = reorderPlaylist(this.playlist, index, index - 1); this.renderList(); });
      const remove = iconButton(s('removeFromPlaylist'), 'close', 'fvs-iconbtn is-small');
      remove.addEventListener('click', () => {
        const wasCurrent = index === this.playlist.current;
        this.playlist = removeFromPlaylist(this.playlist, index);
        if (wasCurrent) {
          this.host.engine.pause();
          this.load();
        }
        this.renderList();
      });
      row.append(grip, main, up, remove);
      grip.addEventListener('pointerdown', (event) => this.startDrag(event, index, row));
      this.list.append(row);
    });
  }

  private startDrag(event: PointerEvent, index: number, row: HTMLElement): void {
    event.preventDefault();
    const grip = event.currentTarget as HTMLElement;
    grip.setPointerCapture(event.pointerId);
    this.drag = { pointerId: event.pointerId, from: index, row, startY: event.clientY };
    row.classList.add('is-dragging');
    const move = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      row.style.transform = `translateY(${e.clientY - this.drag.startY}px)`;
    };
    const up = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const rows = [...this.list.querySelectorAll<HTMLElement>('.fvs-pl-row')];
      let target = 0;
      rows.forEach((r, i) => {
        if (i === this.drag!.from) return;
        const rect = r.getBoundingClientRect();
        if (e.clientY > rect.top + rect.height / 2) target = i < this.drag!.from ? i + 1 : i;
      });
      if (e.clientY <= (rows[0]?.getBoundingClientRect().top ?? 0)) target = 0;
      const from = this.drag.from;
      this.drag = null;
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      this.playlist = reorderPlaylist(this.playlist, from, target);
      this.renderList();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }
}
