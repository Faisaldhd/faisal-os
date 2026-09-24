/**
 * The multi-track timeline.
 *
 * DIRECTION: the timeline is always left-to-right (`dir="ltr"`), in Arabic too —
 * time flows left to right in every editor and on every ruler, and the numbers on
 * it are Western digits like the timecode. Only the chrome around it mirrors.
 *
 * Gestures (pointer events, so mouse, pen and touch share one path):
 *  • ruler / empty lane: tap or drag to move the playhead (scrub);
 *  • clip: tap selects; drag moves it (mouse at once, touch after a long press so
 *    a swipe still scrolls the timeline); drop on another lane moves it between
 *    compatible tracks; the main track reorders;
 *  • the selected clip's edge handles (44px touch targets) trim it;
 *  • pinch with two fingers, or Ctrl + wheel, zooms the time scale.
 * Every edge snaps to the playhead and to other clip edges while snapping is on.
 */
import {
  clipLength,
  clampZoom,
  fitZoom,
  layoutTrack,
  moveClip,
  projectDuration,
  rulerTicks,
  snapBlock,
  snapPoints,
  snapTime,
  tickStep,
  timecode,
  trackAccepts,
  trimClip,
  clipSpan,
  dropIndex,
  type Clip,
  type MediaClip,
  type Project,
  type Track,
} from './project';
import { peaksSlice } from './render-math';
import { thumbAt, type MediaItem } from './media';
import { el, iconButton, s, setIcon } from './ui';
import { icon, type IconName } from './icons';

export const MEDIA_DRAG_TYPE = 'application/x-faisal-video-media';

export interface TimelineHost {
  project(): Project;
  media(id: string): MediaItem | undefined;
  time(): number;
  playing(): boolean;
  selected(): string | null;
  select(id: string | null): void;
  seek(time: number): void;
  /** Opens an undo gesture (drag/trim). */
  begin(): void;
  /** Live change during a gesture, not yet an undo step. */
  preview(next: Project): void;
  /** Closes the gesture: one undo step. */
  end(): void;
  /** A one-shot change: one undo step. */
  apply(next: Project): void;
  snapping(): boolean;
  dropMedia(mediaId: string, trackId: string, time: number): void;
  toggleTrack(trackId: string, what: 'muted' | 'hidden'): void;
}

type Gesture =
  | { kind: 'scrub'; pointerId: number }
  | { kind: 'pending'; pointerId: number; id: string; x: number; y: number; timer: number; touch: boolean }
  | { kind: 'move'; pointerId: number; id: string; grab: number; startY: number; element: HTMLElement; length: number; fromTrack: string }
  | { kind: 'trim'; pointerId: number; id: string; edge: 'start' | 'end'; x0: number; edgeTime: number; base: Project };

const TRACK_ICON: Record<Track['kind'], IconName> = { main: 'film', overlay: 'layers', text: 'text', audio: 'music' };

export class TimelineView {
  readonly root: HTMLElement;
  private readonly heads: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly content: HTMLElement;
  private readonly ruler: HTMLCanvasElement;
  private readonly lanes: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly snapLine: HTMLElement;
  private readonly dropMark: HTMLElement;
  private readonly empty: HTMLElement;
  private pps = 60;
  private gesture: Gesture | null = null;
  private pinch: { distance: number; pps: number; center: number } | null = null;
  private zoomListeners = new Set<(pps: number) => void>();
  private userZoomed = false;
  private rulerQueued = false;

  constructor(private readonly host: TimelineHost) {
    this.root = el('div', 'fvs-tl');
    this.root.dir = 'ltr';
    this.heads = el('div', 'fvs-tl-heads');
    this.scroller = el('div', 'fvs-tl-scroll');
    this.scroller.setAttribute('role', 'region');
    this.scroller.setAttribute('aria-label', s('timeline'));
    this.scroller.tabIndex = 0;
    this.content = el('div', 'fvs-tl-content');
    this.ruler = el('canvas', 'fvs-tl-ruler');
    this.ruler.setAttribute('aria-hidden', 'true');
    this.lanes = el('div', 'fvs-tl-lanes');
    this.playhead = el('div', 'fvs-tl-playhead');
    this.playhead.append(el('div', 'fvs-tl-playhead-knob'));
    this.snapLine = el('div', 'fvs-tl-snap');
    this.snapLine.hidden = true;
    this.dropMark = el('div', 'fvs-tl-dropmark');
    this.dropMark.hidden = true;
    this.empty = el('div', 'fvs-tl-empty');
    this.content.append(this.ruler, this.lanes, this.playhead, this.snapLine, this.dropMark);
    this.scroller.append(this.content);
    const rulerSpacer = el('div', 'fvs-tl-head-spacer');
    this.heads.append(rulerSpacer);
    this.root.append(this.heads, this.scroller, this.empty);
    this.wire();
  }

  /* ───────────── zoom ───────────── */

  get zoom(): number {
    return this.pps;
  }

  onZoom(cb: (pps: number) => void): () => void {
    this.zoomListeners.add(cb);
    return () => this.zoomListeners.delete(cb);
  }

  /** Sets the time scale, keeping `anchorTime` under the same screen x. */
  setZoom(pps: number, anchorTime?: number): void {
    const next = clampZoom(pps);
    const anchor = anchorTime ?? this.host.time();
    const screenX = anchor * this.pps - this.scroller.scrollLeft;
    this.pps = next;
    this.userZoomed = true;
    this.render();
    this.scroller.scrollLeft = Math.max(0, anchor * this.pps - screenX);
    for (const cb of this.zoomListeners) cb(this.pps);
  }

  zoomBy(factor: number): void {
    this.setZoom(this.pps * factor);
  }

  fit(): void {
    const width = this.scroller.clientWidth || 600;
    this.pps = fitZoom(projectDuration(this.host.project()) || 10, width - 16);
    this.render();
    this.scroller.scrollLeft = 0;
    for (const cb of this.zoomListeners) cb(this.pps);
  }

  /** First content: fit it once, unless the user has chosen a zoom. */
  autoFit(): void {
    if (!this.userZoomed) this.fit();
  }

  /* ───────────── rendering ───────────── */

  private contentWidth(): number {
    const d = projectDuration(this.host.project());
    const visible = (this.scroller.clientWidth || 600) / this.pps;
    return Math.ceil(Math.max(d + Math.max(4, d * 0.15), visible) * this.pps);
  }

  render(): void {
    const project = this.host.project();
    const selected = this.host.selected();
    this.content.style.width = `${this.contentWidth()}px`;
    // Track heads.
    const spacer = this.heads.firstElementChild as HTMLElement;
    this.heads.replaceChildren(spacer);
    this.lanes.replaceChildren();
    for (const track of project.tracks) {
      this.heads.append(this.buildHead(track));
      const lane = el('div', `fvs-lane is-${track.kind}`);
      lane.dataset.track = track.id;
      if (track.hidden) lane.classList.add('is-hidden');
      if (track.muted) lane.classList.add('is-muted');
      for (const placed of layoutTrack(track)) lane.append(this.buildClip(track, placed.clip, placed.start, placed.end, placed.clip.id === selected));
      this.lanes.append(lane);
    }
    const hasClips = project.tracks.some((t) => t.clips.length > 0);
    this.empty.hidden = hasClips;
    if (!hasClips) {
      this.empty.replaceChildren(icon('film'), el('span', undefined, s('timelineEmpty')));
    }
    this.drawRuler();
    this.positionPlayhead();
  }

  private buildHead(track: Track): HTMLElement {
    const head = el('div', `fvs-tl-head is-${track.kind}`);
    const label = el('span', 'fvs-tl-head-label');
    label.append(icon(TRACK_ICON[track.kind]), el('span', 'fvs-tl-head-name', this.trackName(track)));
    head.append(label);
    const audible = track.kind !== 'text' && track.kind !== 'overlay' ? true : track.kind === 'overlay';
    if (audible) {
      const mute = iconButton(track.muted ? s('unmuteTrack') : s('muteTrack'), track.muted ? 'mute' : 'volume', 'fvs-iconbtn is-small');
      mute.setAttribute('aria-pressed', String(track.muted));
      mute.addEventListener('click', () => this.host.toggleTrack(track.id, 'muted'));
      head.append(mute);
    }
    if (track.kind !== 'audio') {
      const hide = iconButton(track.hidden ? s('showTrack') : s('hideTrack'), track.hidden ? 'eyeOff' : 'eye', 'fvs-iconbtn is-small');
      hide.setAttribute('aria-pressed', String(track.hidden));
      hide.addEventListener('click', () => this.host.toggleTrack(track.id, 'hidden'));
      head.append(hide);
    }
    return head;
  }

  trackName(track: Track): string {
    const project = this.host.project();
    if (track.kind === 'main') return s('trackMain');
    const same = project.tracks.filter((t) => t.kind === track.kind);
    const n = same.indexOf(track) + 1;
    const base = track.kind === 'audio' ? s('trackAudio') : track.kind === 'overlay' ? s('trackOverlay') : s('trackText');
    return same.length > 1 ? `${base} ${n}` : base;
  }

  private buildClip(track: Track, clip: Clip, start: number, end: number, selected: boolean): HTMLElement {
    const node = el('div', `fvs-clip is-${clip.type}`);
    node.dataset.id = clip.id;
    node.setAttribute('role', 'button');
    node.tabIndex = -1;
    const width = Math.max(4, (end - start) * this.pps);
    node.style.left = `${start * this.pps}px`;
    node.style.width = `${width}px`;
    if (selected) node.classList.add('is-selected');
    let name = '';
    if (clip.type === 'text') {
      name = clip.text.trim() || s('untitledText');
    } else {
      const media = this.host.media(clip.mediaId);
      name = media?.name ?? '';
      if (!media || media.status === 'offline') node.classList.add('is-offline');
      const strip = el('canvas', 'fvs-clip-strip');
      strip.setAttribute('aria-hidden', 'true');
      node.append(strip);
      requestAnimationFrame(() => this.paintStrip(strip, clip, media, width));
      if (track.kind === 'main' && clip.transition.kind !== 'none' && track.clips.indexOf(clip) > 0) {
        const mark = el('span', 'fvs-clip-transition');
        mark.title = s(`transition_${clip.transition.kind}`);
        mark.append(icon('transition'));
        node.append(mark);
      }
    }
    const label = el('span', 'fvs-clip-label', name);
    label.dir = 'auto';
    node.append(label);
    if (clip.type !== 'text') {
      const badges: string[] = [];
      if (clip.type !== 'image' && Math.abs(clip.speed - 1) > 1e-3) badges.push(`${clip.speed}×`);
      if (badges.length) node.append(el('span', 'fvs-clip-badge', badges.join(' ')));
      if (clip.muted && clip.type !== 'image') {
        const m = el('span', 'fvs-clip-muted');
        m.append(icon('mute'));
        node.append(m);
      }
    }
    node.setAttribute('aria-label', `${this.trackName(track)}: ${name} (${timecode(start)} – ${timecode(end)})`);
    node.setAttribute('aria-pressed', String(selected));
    if (selected) {
      for (const edge of ['start', 'end'] as const) {
        const handle = el('div', `fvs-handle is-${edge}`);
        handle.dataset.edge = edge;
        handle.setAttribute('role', 'slider');
        handle.setAttribute('aria-label', edge === 'start' ? s('trimStart') : s('trimEnd'));
        handle.append(el('span', 'fvs-handle-grip'));
        node.append(handle);
      }
    }
    return node;
  }

  /** Filmstrip for video/image clips, waveform for audio. */
  private paintStrip(canvas: HTMLCanvasElement, clip: MediaClip, media: MediaItem | undefined, width: number): void {
    if (!canvas.isConnected) return;
    const h = canvas.clientHeight || 48;
    const w = Math.min(Math.ceil(width), 8000);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx || !media) return;
    ctx.clearRect(0, 0, w, h);
    if (clip.type === 'audio' || (clip.type === 'video' && media.thumbs.length === 0 && media.peaks)) {
      this.paintWave(ctx, clip, media, w, h, 1);
      return;
    }
    const first = media.thumbs[0];
    if (!first) return;
    const tileW = Math.max(16, (first.width / first.height) * h);
    const speed = clip.type === 'image' ? 0 : clip.speed;
    for (let x = 0; x < w; x += tileW) {
      const at = clip.in + ((x + tileW / 2) / this.pps) * speed;
      const frame = thumbAt(media, at);
      if (frame) ctx.drawImage(frame, x, 0, tileW, h);
    }
    if (clip.type === 'video' && media.peaks && !clip.muted) {
      // A low waveform band along the bottom: the clip's own sound.
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(0, h * 0.72, w, h * 0.28);
      ctx.save();
      ctx.translate(0, h * 0.72);
      this.paintWave(ctx, clip, media, w, h * 0.28, 0.9);
      ctx.restore();
    }
  }

  private paintWave(ctx: CanvasRenderingContext2D, clip: MediaClip, media: MediaItem, w: number, h: number, alpha: number): void {
    const peaks = media.peaks;
    ctx.fillStyle = `rgba(61,214,140,${alpha})`;
    if (!peaks || !(media.duration > 0)) {
      ctx.fillRect(0, h / 2 - 1, w, 2);
      return;
    }
    const slice = peaksSlice(peaks, media.duration, clip.in, clip.out);
    if (slice.length === 0) return;
    const mid = h / 2;
    for (let x = 0; x < w; x += 2) {
      const v = slice[Math.min(slice.length - 1, Math.floor((x / w) * slice.length))] * clip.volume;
      const bar = Math.max(1, Math.min(1, v) * (h - 4));
      ctx.fillRect(x, mid - bar / 2, 1.5, bar);
    }
  }

  private drawRuler(): void {
    const canvas = this.ruler;
    const viewW = this.scroller.clientWidth || 600;
    const left = this.scroller.scrollLeft;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const h = canvas.clientHeight || 28;
    canvas.style.left = `${left}px`;
    canvas.style.width = `${viewW}px`;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, h);
    const styles = getComputedStyle(this.root);
    const muted = styles.getPropertyValue('--app-text-3').trim() || '#6E7890';
    const text = styles.getPropertyValue('--app-text-2').trim() || '#A7B0C2';
    const from = left / this.pps;
    const to = (left + viewW) / this.pps;
    const step = tickStep(this.pps);
    ctx.font = '11px "Cascadia Code", Consolas, ui-monospace, monospace';
    ctx.textBaseline = 'top';
    for (const tick of rulerTicks(from, to, this.pps)) {
      const x = Math.round(tick.time * this.pps - left) + 0.5;
      ctx.strokeStyle = tick.major ? text : muted;
      ctx.globalAlpha = tick.major ? 0.8 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x, tick.major ? h - 10 : h - 5);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (tick.major) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = text;
        ctx.fillText(step < 1 ? timecode(tick.time) : timecode(tick.time).slice(0, 5), x + 4, 6);
      }
    }
  }

  private queueRuler(): void {
    if (this.rulerQueued) return;
    this.rulerQueued = true;
    requestAnimationFrame(() => {
      this.rulerQueued = false;
      this.drawRuler();
    });
  }

  /** Moves the playhead line; while playing, keeps it in view. */
  positionPlayhead(): void {
    const x = this.host.time() * this.pps;
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.host.playing() && !this.gesture) {
      const view = this.scroller.clientWidth;
      const left = this.scroller.scrollLeft;
      if (x < left || x > left + view - 32) this.scroller.scrollLeft = Math.max(0, x - view * 0.2);
    }
  }

  /** Scrolls so `time` is visible (keyboard moves of the playhead). */
  reveal(time: number): void {
    const x = time * this.pps;
    const view = this.scroller.clientWidth;
    const left = this.scroller.scrollLeft;
    if (x < left + 16 || x > left + view - 16) this.scroller.scrollLeft = Math.max(0, x - view / 2);
  }

  /* ───────────── gestures ───────────── */

  private timeAt(clientX: number): number {
    const rect = this.content.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / this.pps);
  }

  private laneAt(clientX: number, clientY: number): HTMLElement | null {
    const lanes = [...this.lanes.children] as HTMLElement[];
    for (const lane of lanes) {
      const r = lane.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return lane;
    }
    void clientX;
    return null;
  }

  private snapThreshold(): number {
    return 10 / this.pps;
  }

  private showSnap(time: number | null): void {
    this.snapLine.hidden = time === null;
    if (time !== null) this.snapLine.style.transform = `translateX(${time * this.pps}px)`;
  }

  private wire(): void {
    this.scroller.addEventListener('scroll', () => this.queueRuler(), { passive: true });
    new ResizeObserver(() => {
      this.content.style.width = `${this.contentWidth()}px`;
      this.queueRuler();
    }).observe(this.scroller);

    this.scroller.addEventListener('pointerdown', (event) => this.onDown(event));
    this.scroller.addEventListener('pointermove', (event) => this.onMove(event));
    this.scroller.addEventListener('pointerup', (event) => this.onUp(event));
    this.scroller.addEventListener('pointercancel', (event) => this.onCancel(event));
    // While a clip is being dragged by touch, the page must not scroll under it.
    this.scroller.addEventListener('touchmove', (event) => {
      if (this.gesture && this.gesture.kind !== 'pending') event.preventDefault();
    }, { passive: false });

    // Pinch zoom (two fingers).
    this.scroller.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 2) return;
      const [a, b] = [event.touches[0], event.touches[1]];
      this.cancelGesture();
      this.pinch = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), pps: this.pps, center: this.timeAt((a.clientX + b.clientX) / 2) };
    }, { passive: true });
    this.scroller.addEventListener('touchmove', (event) => {
      if (!this.pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const [a, b] = [event.touches[0], event.touches[1]];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (this.pinch.distance > 0) this.setZoom(this.pinch.pps * (d / this.pinch.distance), this.pinch.center);
    }, { passive: false });
    this.scroller.addEventListener('touchend', (event) => {
      if (event.touches.length < 2) this.pinch = null;
    });

    this.scroller.addEventListener('wheel', (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        this.setZoom(this.pps * Math.exp(-event.deltaY * 0.0025), this.timeAt(event.clientX));
        return;
      }
      // A plain vertical wheel scrolls time when the tracks already fit.
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && this.scroller.scrollHeight <= this.scroller.clientHeight + 1) {
        this.scroller.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    }, { passive: false });

    // Drag from the media pool (mouse).
    this.scroller.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes(MEDIA_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      this.showSnap(this.timeAt(event.clientX));
    });
    this.scroller.addEventListener('dragleave', () => this.showSnap(null));
    this.scroller.addEventListener('drop', (event) => {
      const id = event.dataTransfer?.getData(MEDIA_DRAG_TYPE);
      this.showSnap(null);
      if (!id) return;
      event.preventDefault();
      const lane = this.laneAt(event.clientX, event.clientY);
      this.host.dropMedia(id, lane?.dataset.track ?? '', this.timeAt(event.clientX));
    });
  }

  private onDown(event: PointerEvent): void {
    if (event.button !== 0 || this.pinch) return;
    const target = event.target as HTMLElement;
    if (target.closest('button')) return;
    const handle = target.closest<HTMLElement>('.fvs-handle');
    const clipEl = target.closest<HTMLElement>('.fvs-clip');
    if (handle && clipEl?.dataset.id) {
      const id = clipEl.dataset.id;
      const span = clipSpan(this.host.project(), id);
      if (!span) return;
      const edge = handle.dataset.edge === 'start' ? 'start' : 'end';
      event.preventDefault();
      this.scroller.setPointerCapture(event.pointerId);
      this.host.begin();
      this.gesture = { kind: 'trim', pointerId: event.pointerId, id, edge, x0: event.clientX, edgeTime: edge === 'start' ? span.start : span.end, base: this.host.project() };
      return;
    }
    if (clipEl?.dataset.id) {
      const id = clipEl.dataset.id;
      if (this.host.selected() !== id) this.host.select(id);
      const touch = event.pointerType === 'touch';
      const timer = touch ? window.setTimeout(() => this.beginMove(event.pointerId, id, event.clientX, event.clientY), 350) : 0;
      this.gesture = { kind: 'pending', pointerId: event.pointerId, id, x: event.clientX, y: event.clientY, timer, touch };
      return;
    }
    // Ruler or empty lane: scrub. Touch on a lane only seeks on release (a swipe scrolls).
    const onRuler = event.clientY - this.content.getBoundingClientRect().top < (this.ruler.clientHeight || 28) + 4;
    if (event.pointerType === 'touch' && !onRuler) {
      this.gesture = { kind: 'pending', pointerId: event.pointerId, id: '', x: event.clientX, y: event.clientY, timer: 0, touch: true };
      return;
    }
    event.preventDefault();
    this.scroller.setPointerCapture(event.pointerId);
    this.gesture = { kind: 'scrub', pointerId: event.pointerId };
    this.host.select(null);
    this.host.seek(this.timeAt(event.clientX));
  }

  private beginMove(pointerId: number, id: string, x: number, y: number): void {
    const g = this.gesture;
    if (!g || g.kind !== 'pending' || g.pointerId !== pointerId) return;
    const element = this.lanes.querySelector<HTMLElement>(`.fvs-clip[data-id="${CSS.escape(id)}"]`);
    const span = clipSpan(this.host.project(), id);
    const lane = element?.closest<HTMLElement>('.fvs-lane');
    if (!element || !span || !lane) return;
    try { this.scroller.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
    element.classList.add('is-dragging');
    if (g.touch && 'vibrate' in navigator) {
      try { navigator.vibrate(12); } catch { /* not allowed */ }
    }
    this.gesture = { kind: 'move', pointerId, id, grab: this.timeAt(x) - span.start, startY: y, element, length: span.end - span.start, fromTrack: lane.dataset.track ?? '' };
  }

  private onMove(event: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.pointerId !== event.pointerId) return;
    if (g.kind === 'scrub') {
      this.host.seek(this.timeAt(event.clientX));
      return;
    }
    if (g.kind === 'pending') {
      const moved = Math.hypot(event.clientX - g.x, event.clientY - g.y);
      if (g.touch) {
        if (moved > 10) {
          window.clearTimeout(g.timer);
          this.gesture = null; // a swipe: let the timeline scroll
        }
        return;
      }
      if (moved > 4 && g.id) this.beginMove(g.pointerId, g.id, g.x, g.y);
      return;
    }
    if (g.kind === 'move') {
      const project = this.host.project();
      const lane = this.laneAt(event.clientX, event.clientY);
      const track = project.tracks.find((t) => t.id === lane?.dataset.track);
      const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === g.id);
      const ok = Boolean(track && clip && trackAccepts(track.kind, clip.type));
      for (const l of this.lanes.children) (l as HTMLElement).classList.toggle('is-drop', ok && l === lane);
      let start = Math.max(0, this.timeAt(event.clientX) - g.grab);
      let snapped: number | null = null;
      if (this.host.snapping()) {
        const r = snapBlock(start, g.length, snapPoints(project, this.host.time(), [g.id]), this.snapThreshold());
        start = Math.max(0, r.start);
        snapped = r.snapped;
      }
      this.showSnap(snapped);
      const fromLane = this.lanes.querySelector<HTMLElement>(`.fvs-lane[data-track="${CSS.escape(g.fromTrack)}"]`);
      const dy = lane && fromLane ? lane.getBoundingClientRect().top - fromLane.getBoundingClientRect().top : event.clientY - g.startY;
      g.element.style.left = `${start * this.pps}px`;
      g.element.style.transform = `translateY(${dy}px)`;
      if (track?.kind === 'main' && ok) {
        const index = dropIndex(track, this.timeAt(event.clientX), g.id);
        const placed = layoutTrack(track).filter((p) => p.clip.id !== g.id);
        const at = index >= placed.length ? (placed[placed.length - 1]?.end ?? 0) : placed[index].start;
        this.dropMark.hidden = false;
        this.dropMark.style.transform = `translateX(${at * this.pps}px)`;
        this.dropMark.style.top = `${lane!.offsetTop + this.lanes.offsetTop}px`;
        this.dropMark.style.height = `${lane!.offsetHeight}px`;
      } else {
        this.dropMark.hidden = true;
      }
      return;
    }
    if (g.kind === 'trim') {
      let edgeTime = g.edgeTime + (event.clientX - g.x0) / this.pps;
      let snapped: number | null = null;
      if (this.host.snapping()) {
        const r = snapTime(edgeTime, snapPoints(g.base, this.host.time(), [g.id]), this.snapThreshold());
        edgeTime = r.time;
        snapped = r.snapped;
      }
      this.showSnap(snapped);
      const next = trimClip(g.base, g.id, g.edge, edgeTime - g.edgeTime);
      this.host.preview(next);
      const span = clipSpan(next, g.id);
      if (span) this.host.seek(g.edge === 'start' ? span.start : Math.max(span.start, span.end - 1 / 30));
    }
  }

  private onUp(event: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.pointerId !== event.pointerId) return;
    this.gesture = null;
    this.showSnap(null);
    this.dropMark.hidden = true;
    for (const l of this.lanes.children) (l as HTMLElement).classList.remove('is-drop');
    if (g.kind === 'pending') {
      window.clearTimeout(g.timer);
      if (!g.id) {
        // A tap on an empty lane (touch): move the playhead there.
        this.host.select(null);
        this.host.seek(this.timeAt(event.clientX));
      }
      return;
    }
    if (g.kind === 'trim') {
      this.host.end();
      return;
    }
    if (g.kind === 'move') {
      const project = this.host.project();
      const lane = this.laneAt(event.clientX, event.clientY);
      const trackId = lane?.dataset.track;
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) {
        this.render();
        return;
      }
      let start = Math.max(0, this.timeAt(event.clientX) - g.grab);
      if (this.host.snapping()) start = Math.max(0, snapBlock(start, g.length, snapPoints(project, this.host.time(), [g.id]), this.snapThreshold()).start);
      const time = track.kind === 'main' ? this.timeAt(event.clientX) : start;
      const next = moveClip(project, g.id, track.id, time);
      if (next === project) this.render();
      else this.host.apply(next);
    }
  }

  private onCancel(event: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.pointerId !== event.pointerId) return;
    this.cancelGesture();
  }

  private cancelGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    this.showSnap(null);
    this.dropMark.hidden = true;
    if (!g) return;
    if (g.kind === 'pending') window.clearTimeout(g.timer);
    if (g.kind === 'trim') this.host.end();
    if (g.kind === 'move') this.render();
  }

  /** The clip under the playhead on a track, for keyboard use. */
  clipLengthOf(project: Project, id: string): number {
    const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    return clip ? clipLength(clip) : 0;
  }
}

export { setIcon };
