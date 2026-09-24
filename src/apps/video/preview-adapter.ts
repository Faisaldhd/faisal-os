/**
 * The playback, drawing and export implementation behind `StudioEngine`.
 *
 * HOW IT PLAYS
 *  • One hidden media element per clip that is on screen (or about to be): a
 *    small pool, reused by media, so a split clip or a crossfade between two parts
 *    of the same file each get their own element. The next clip is pre-rolled
 *    (loaded and seeked, paused) a second before it starts, so a cut is seamless.
 *  • A master clock drives the timeline. While a video layer is playing the clock
 *    follows that element (so picture and sound stay locked), and when a needed
 *    element is still seeking the clock holds instead of skipping frames.
 *  • Every element's sound goes through Web Audio: element → clip gain → mix bus
 *    → speakers, and the same mix bus → a MediaStream for the recorder. Fades,
 *    transitions and per-clip volume are the clip gain, set on every frame from
 *    the pure model (`audibleAt`).
 *  • Each frame is drawn by `drawFrame` from `visualsAt` — the same function draws
 *    the preview, the export and the PNG capture, so they cannot disagree.
 *
 * HOW IT EXPORTS
 *  • Video: the timeline is played in real time at the export size while
 *    `MediaRecorder` records the canvas and the mix bus. When an element stalls
 *    the recorder is paused, so a slow seek never becomes a frozen frame in the
 *    file. A WebM result gets its real Duration written in (`webm.ts`).
 *  • Audio only: rendered offline (`OfflineAudioContext`), faster than real time
 *    and sample-exact, then written as WAV.
 */
import { drawPlan, outputSize } from './clips';
import type {
  AudioExportOptions,
  EngineBox,
  EngineLabels,
  EngineMedia,
  StudioEngine,
  VideoExportOptions,
  VideoExportResult,
} from './engine-port';
import { ExportCancelled } from './engine-port';
import {
  audibleAt,
  clampSpeed,
  emptyProject,
  isMedia,
  layoutTrack,
  projectDuration,
  sourceTimeAt,
  textAnimAt,
  visualsAt,
  type MediaClip,
  type Project,
  type TextClip,
  type VisualLayer,
} from './project';
import {
  anchorX,
  applyColorAdjust,
  canvasAlign,
  colorFilter,
  FONT_STACKS,
  isNeutral,
  layerRect,
  textDirection,
  wrapLines,
  type Rect,
} from './render-math';
import { encodeWav } from './wav';
import { fixWebmDuration } from './webm';

interface Slot {
  el: HTMLVideoElement;
  mediaId: string;
  owner: string | null;
  node: MediaElementAudioSourceNode | null;
  gain: GainNode | null;
  pending: number | null;
  used: number;
}

interface Need {
  mediaId: string;
  source: number;
  speed: number;
  gain: number;
  active: boolean;
  visual: boolean;
}

interface ExportJob {
  recorder: MediaRecorder;
  end: number;
  start: number;
  startedWall: number;
  onProgress: (fraction: number, elapsed: number) => void;
  finish: () => void;
  frames: number;
}

const MAX_SLOTS = 10;
const PREROLL = 1.0;
const STALL_LIMIT = 2.5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createPreviewEngine(labels: EngineLabels): StudioEngine {
  return new PreviewEngine(labels);
}

class PreviewEngine implements StudioEngine {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly host: HTMLDivElement;
  private project: Project = emptyProject();
  private frame = { width: 1920, height: 1080 };
  private lookup: (id: string) => EngineMedia | undefined = () => undefined;
  private t = 0;
  private isPlaying = false;
  private rate = 1;
  private volume = 1;
  private isMuted = false;
  private loop: { range: { start: number; end: number } | null; enabled: boolean } = { range: null, enabled: false };
  private stopAt: number | null = null;
  private slots: Slot[] = [];
  private audio: AudioContext | null = null;
  private mix: GainNode | null = null;
  private monitor: GainNode | null = null;
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private raf = 0;
  private lastWall = 0;
  private stall = 0;
  private renderQueued = false;
  private tickCbs = new Set<(t: number) => void>();
  private stateCbs = new Set<() => void>();
  private lastBoxes: EngineBox[] = [];
  private job: ExportJob | null = null;
  private previewSize = { width: 1280, height: 720 };
  private filterWorks: boolean;
  private decoded = new Map<string, AudioBuffer>();
  private disposed = false;

  constructor(private readonly labels: EngineLabels) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    this.filterWorks = typeof (ctx as { filter?: unknown }).filter === 'string';
    this.host = document.createElement('div');
    this.host.className = 'fvs-media-host';
    this.host.setAttribute('aria-hidden', 'true');
    document.body.append(this.host);
  }

  /* ───────────── model ───────────── */

  setProject(project: Project, frame: { width: number; height: number }): void {
    this.project = project;
    if (frame.width !== this.frame.width || frame.height !== this.frame.height) {
      this.frame = { ...frame };
      this.applyPreviewSize();
    }
    if (this.t > this.duration && !this.isPlaying) this.t = this.duration;
    this.requestRender();
  }

  setMedia(lookup: (id: string) => EngineMedia | undefined): void {
    this.lookup = lookup;
    this.requestRender();
  }

  setPreviewSize(width: number, height: number): void {
    this.previewSize = { width: Math.max(2, Math.round(width)), height: Math.max(2, Math.round(height)) };
    this.applyPreviewSize();
  }

  /** The canvas keeps the composition's shape, scaled to fit the preview box. */
  private applyPreviewSize(): void {
    if (this.job) return;
    const scale = Math.min(this.previewSize.width / this.frame.width, this.previewSize.height / this.frame.height, 1);
    const w = Math.max(2, Math.round((this.frame.width * scale) / 2) * 2);
    const h = Math.max(2, Math.round((this.frame.height * scale) / 2) * 2);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.requestRender();
  }

  get time(): number { return this.t; }
  get playing(): boolean { return this.isPlaying; }
  get duration(): number { return projectDuration(this.project); }
  get exporting(): boolean { return this.job !== null; }

  onTick(cb: (t: number) => void): () => void {
    this.tickCbs.add(cb);
    return () => this.tickCbs.delete(cb);
  }

  onState(cb: () => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  private emitState(): void {
    for (const cb of this.stateCbs) cb();
  }

  boxes(): EngineBox[] {
    return this.lastBoxes;
  }

  /* ───────────── transport ───────────── */

  async play(): Promise<void> {
    if (this.job || this.disposed) return;
    const end = this.stopAt ?? this.duration;
    if (this.duration <= 0) return;
    if (this.t >= end - 0.01) this.t = this.loop.enabled && this.loop.range ? this.loop.range.start : 0;
    this.ensureAudio();
    this.startClock();
  }

  private startClock(): void {
    this.isPlaying = true;
    this.lastWall = performance.now();
    this.stall = 0;
    if (this.audio?.state === 'suspended') void this.audio.resume().catch(() => undefined);
    this.sync(true);
    this.loopFrame();
    this.emitState();
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    for (const slot of this.slots) if (!slot.el.paused) slot.el.pause();
    this.sync(false);
    this.requestRender();
    this.emitState();
  }

  seek(time: number): void {
    if (this.job) return;
    const d = this.duration;
    this.t = clamp(Number.isFinite(time) ? time : 0, 0, d);
    this.stall = 0;
    this.sync(this.isPlaying, true);
    this.requestRender();
    for (const cb of this.tickCbs) cb(this.t);
  }

  setRate(rate: number): void {
    this.rate = clamp(Number.isFinite(rate) ? rate : 1, 0.25, 4);
    if (this.isPlaying) this.sync(true);
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    this.applyMixGain();
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    this.applyMixGain();
  }

  setLoop(range: { start: number; end: number } | null, enabled: boolean): void {
    this.loop = { range, enabled };
  }

  setStopAt(end: number | null): void {
    this.stopAt = end;
  }

  private applyMixGain(): void {
    if (this.mix && !this.job) this.mix.gain.value = this.isMuted ? 0 : this.volume;
    if (!this.audio) for (const slot of this.slots) slot.el.muted = this.isMuted;
  }

  /* ───────────── frame loop ───────────── */

  private loopFrame(): void {
    if (this.raf) return;
    const step = () => {
      this.raf = 0;
      if (this.disposed) return;
      if (this.isPlaying) this.advance();
      this.draw();
      for (const cb of this.tickCbs) cb(this.t);
      if (this.isPlaying) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private requestRender(): void {
    if (this.renderQueued || this.isPlaying || this.disposed) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.isPlaying) this.draw();
    });
  }

  /** Moves the clock one frame: follows the leading video element, holds on a stall. */
  private advance(): void {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastWall) / 1000);
    this.lastWall = now;
    const layers = visualsAt(this.project, this.t).layers;
    const stalled = layers.some((layer) => {
      if (layer.clip.type !== 'video') return false;
      const slot = this.slotFor(layer.clip.id);
      const media = this.lookup(layer.clip.mediaId);
      if (!media?.url) return false;
      return !slot || slot.el.readyState < 3 || slot.el.seeking;
    });
    if (stalled && this.stall < STALL_LIMIT) {
      this.stall += dt;
      if (this.job && this.job.recorder.state === 'recording') this.job.recorder.pause();
      this.sync(true);
      return;
    }
    this.stall = 0;
    if (this.job && this.job.recorder.state === 'paused') this.job.recorder.resume();
    let next = this.t + dt * this.rate;
    // Follow the leading video element when it is close: that locks audio and picture.
    const lead = layers.find((l) => l.clip.type === 'video' && l.alpha > 0.5);
    if (lead) {
      const slot = this.slotFor(lead.clip.id);
      if (slot && !slot.el.paused && !slot.el.seeking) {
        const fromEl = lead.placed.start + (slot.el.currentTime - lead.clip.in) / clampSpeed(lead.clip.speed);
        if (Math.abs(fromEl - next) < 0.2 && fromEl >= this.t) next = fromEl;
      }
    }
    const end = this.job ? this.job.end : this.stopAt ?? this.duration;
    if (this.loop.enabled && !this.job) {
      const loopEnd = this.loop.range?.end ?? this.duration;
      if (next >= loopEnd) {
        this.t = this.loop.range?.start ?? 0;
        this.sync(true, true);
        return;
      }
    }
    if (next >= end) {
      this.t = end;
      this.isPlaying = false;
      for (const slot of this.slots) if (!slot.el.paused) slot.el.pause();
      if (this.job) this.job.finish();
      this.emitState();
      return;
    }
    this.t = next;
    this.sync(true);
  }

  /* ───────────── element pool ───────────── */

  private slotFor(owner: string): Slot | undefined {
    return this.slots.find((s) => s.owner === owner);
  }

  private needs(time: number, playing: boolean): Map<string, Need> {
    const needs = new Map<string, Need>();
    for (const layer of visualsAt(this.project, time).layers) {
      if (layer.clip.type !== 'video') continue;
      needs.set(layer.clip.id, { mediaId: layer.clip.mediaId, source: layer.sourceTime, speed: layer.clip.speed, gain: 0, active: true, visual: true });
    }
    for (const a of audibleAt(this.project, time)) {
      const media = this.lookup(a.clip.mediaId);
      const existing = needs.get(a.clip.id);
      const gain = media?.hasAudio === false ? 0 : a.gain;
      if (existing) existing.gain = gain;
      else needs.set(a.clip.id, { mediaId: a.clip.mediaId, source: a.sourceTime, speed: a.clip.speed, gain, active: true, visual: false });
    }
    if (playing) {
      for (const track of this.project.tracks) {
        if (track.kind === 'text') continue;
        for (const p of layoutTrack(track)) {
          const clip = p.clip;
          if (!isMedia(clip) || clip.type === 'image' || needs.has(clip.id)) continue;
          if (p.start > time && p.start - time < PREROLL * this.rate) {
            needs.set(clip.id, { mediaId: clip.mediaId, source: clip.in, speed: clip.speed, gain: 0, active: false, visual: clip.type === 'video' });
          }
        }
      }
    }
    return needs;
  }

  private makeSlot(mediaId: string): Slot {
    const el = document.createElement('video');
    el.preload = 'auto';
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.muted = this.isMuted;
    const slot: Slot = { el, mediaId, owner: null, node: null, gain: null, pending: null, used: 0 };
    el.addEventListener('seeked', () => {
      if (slot.pending !== null) {
        const target = slot.pending;
        slot.pending = null;
        el.currentTime = target;
        return;
      }
      this.requestRender();
    });
    el.addEventListener('loadeddata', () => this.requestRender());
    el.addEventListener('error', () => this.requestRender());
    this.host.append(el);
    this.connect(slot);
    this.slots.push(slot);
    return slot;
  }

  private setSource(slot: Slot, mediaId: string): void {
    const media = this.lookup(mediaId);
    slot.mediaId = mediaId;
    slot.pending = null;
    if (!media?.url) {
      slot.el.removeAttribute('src');
      return;
    }
    if (slot.el.getAttribute('src') !== media.url) {
      slot.el.src = media.url;
      slot.el.load();
    }
  }

  private acquire(owner: string, mediaId: string, claimed: Set<Slot>): Slot {
    const own = this.slots.find((s) => s.owner === owner && s.mediaId === mediaId);
    if (own) return own;
    const free = this.slots.filter((s) => !claimed.has(s) && (s.owner === null || !this.ownerStillNeeded(s)));
    let slot = free.find((s) => s.mediaId === mediaId) ?? null;
    if (!slot && this.slots.length < MAX_SLOTS) slot = this.makeSlot(mediaId);
    if (!slot) slot = free.sort((a, b) => a.used - b.used)[0] ?? this.makeSlot(mediaId);
    if (slot.mediaId !== mediaId || !slot.el.getAttribute('src')) this.setSource(slot, mediaId);
    slot.owner = owner;
    return slot;
  }

  private currentNeeds: Map<string, Need> = new Map();

  private ownerStillNeeded(slot: Slot): boolean {
    return slot.owner !== null && this.currentNeeds.has(slot.owner);
  }

  /** Brings every element to where the model says it should be. */
  private sync(playing: boolean, hard = false): void {
    const needs = this.needs(this.t, playing);
    this.currentNeeds = needs;
    const claimed = new Set<Slot>();
    const stamp = performance.now();
    // Keep existing owners first so a running element is never stolen.
    const ordered = [...needs].sort(([a], [b]) => Number(Boolean(this.slotFor(b))) - Number(Boolean(this.slotFor(a))));
    for (const [owner, need] of ordered) {
      const media = this.lookup(need.mediaId);
      if (!media?.url || media.type === 'image') continue;
      const slot = this.acquire(owner, need.mediaId, claimed);
      claimed.add(slot);
      slot.used = stamp;
      this.drive(slot, need, playing, hard);
    }
    for (const slot of this.slots) {
      if (claimed.has(slot)) continue;
      slot.owner = null;
      if (!slot.el.paused) slot.el.pause();
      this.setGain(slot, 0);
    }
  }

  private drive(slot: Slot, need: Need, playing: boolean, hard: boolean): void {
    const el = slot.el;
    const rate = clamp(clampSpeed(need.speed) * this.rate, 0.0625, 16);
    const drift = el.currentTime - need.source;
    if (playing && need.active) {
      if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
      if (el.paused) {
        if (Math.abs(drift) > 0.08 || hard) this.seekSlot(slot, need.source);
        if (el.readyState >= 1) void el.play().catch(() => undefined);
      } else if (hard || Math.abs(drift) > 0.3 * Math.max(1, rate)) {
        this.seekSlot(slot, need.source);
      }
    } else {
      if (!el.paused) el.pause();
      if (hard || Math.abs(drift) > 0.012) this.seekSlot(slot, need.source);
    }
    this.setGain(slot, need.active ? need.gain : 0);
  }

  private seekSlot(slot: Slot, time: number): void {
    const el = slot.el;
    if (el.readyState === 0) {
      // Not loaded yet: the position is applied once metadata arrives.
      const apply = () => { el.currentTime = time; };
      el.addEventListener('loadedmetadata', apply, { once: true });
      return;
    }
    if (el.seeking) {
      slot.pending = time;
      return;
    }
    try {
      el.currentTime = time;
    } catch {
      /* a refused seek leaves the element where it is */
    }
  }

  /* ───────────── audio graph ───────────── */

  private ensureAudio(): void {
    if (this.audio) return;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.audio = ctx;
      this.mix = ctx.createGain();
      this.monitor = ctx.createGain();
      this.mix.connect(this.monitor);
      this.monitor.connect(ctx.destination);
      this.streamDest = ctx.createMediaStreamDestination();
      this.mix.connect(this.streamDest);
      this.applyMixGain();
      for (const slot of this.slots) this.connect(slot);
    } catch {
      this.audio = null;
    }
  }

  private connect(slot: Slot): void {
    if (!this.audio || !this.mix || slot.node) return;
    try {
      slot.node = this.audio.createMediaElementSource(slot.el);
      slot.gain = this.audio.createGain();
      slot.gain.gain.value = 0;
      slot.node.connect(slot.gain);
      slot.gain.connect(this.mix);
      slot.el.muted = false;
      slot.el.volume = 1;
    } catch {
      slot.node = null;
      slot.gain = null;
    }
  }

  private setGain(slot: Slot, gain: number): void {
    if (slot.gain) {
      const value = clamp(gain, 0, 2);
      if (Math.abs(slot.gain.gain.value - value) > 1e-3) slot.gain.gain.value = value;
      return;
    }
    // No Web Audio: the element's own volume is the only control (capped at 1).
    slot.el.volume = clamp(gain * this.volume, 0, 1);
  }

  /* ───────────── drawing ───────────── */

  private draw(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ready = this.drawFrame(this.ctx, w, h, this.t, !this.job);
    if (!ready) {
      // Keep the previous frame on screen until the element has the new one.
      window.setTimeout(() => this.requestRender(), 40);
    }
    if (this.job) this.job.frames += 1;
  }

  /**
   * Draws the composition at `time` into a `w`×`h` context. Returns false when a
   * video layer's frame is not decoded yet and `waitForFrames` asked to keep the
   * previous picture instead of flashing black.
   */
  private drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number, time: number, waitForFrames: boolean): boolean {
    const vis = visualsAt(this.project, time);
    if (waitForFrames) {
      for (const layer of vis.layers) {
        if (layer.clip.type !== 'video') continue;
        const media = this.lookup(layer.clip.mediaId);
        if (!media?.url) continue;
        const slot = this.slotFor(layer.clip.id);
        if (!slot || slot.el.readyState < 2) return false;
      }
    }
    const boxes: EngineBox[] = [];
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.project.background || '#000000';
    ctx.fillRect(0, 0, w, h);
    let blackDrawn = false;
    for (const layer of vis.layers) {
      if (layer.trackKind === 'overlay' && !blackDrawn) {
        this.drawBlack(ctx, w, h, vis.black);
        blackDrawn = true;
      }
      const rect = this.drawLayer(ctx, w, h, layer);
      if (rect && layer.trackKind === 'overlay') boxes.push({ id: layer.clip.id, kind: 'overlay', rect });
    }
    if (!blackDrawn) this.drawBlack(ctx, w, h, vis.black);
    if (vis.layers.length === 0) this.drawAudioVisual(ctx, w, h, time);
    for (const text of vis.texts) {
      const rect = this.drawText(ctx, w, h, text, time);
      if (rect) boxes.push({ id: text.id, kind: 'text', rect });
    }
    ctx.restore();
    if (ctx === this.ctx) this.lastBoxes = boxes;
    return true;
  }

  private drawBlack(ctx: CanvasRenderingContext2D, w: number, h: number, black: number): void {
    if (black <= 0) return;
    ctx.globalAlpha = black;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  private drawLayer(ctx: CanvasRenderingContext2D, w: number, h: number, layer: VisualLayer): Rect | null {
    const clip = layer.clip;
    const media = this.lookup(clip.mediaId);
    const alpha = clamp(layer.alpha * clip.opacity, 0, 1);
    let source: CanvasImageSource | null = null;
    let size = { width: media?.width || 16, height: media?.height || 9 };
    if (media?.url) {
      if (clip.type === 'image' && media.image) {
        source = media.image;
        size = { width: media.image.naturalWidth, height: media.image.naturalHeight };
      } else if (clip.type === 'video') {
        const slot = this.slotFor(clip.id);
        if (slot && slot.el.readyState >= 2) {
          source = slot.el;
          size = { width: slot.el.videoWidth || size.width, height: slot.el.videoHeight || size.height };
        }
      }
    }
    const out = outputSize(size, clip.transform);
    const rect = layerRect(out, { width: w, height: h }, { fit: clip.fit, scale: clip.scale, cx: clip.x, cy: clip.y, offsetX: layer.offsetX });
    if (alpha <= 0) return rect;
    if (!source) {
      if (media && !media.url) this.drawOffline(ctx, rect);
      return rect;
    }
    const plan = drawPlan(size, clip.transform);
    ctx.save();
    ctx.globalAlpha = alpha;
    const filter = colorFilter(clip.color);
    if (this.filterWorks) ctx.filter = filter;
    ctx.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const k = rect.width / Math.max(1, out.width);
    ctx.scale(k, k);
    ctx.rotate(plan.rotateRadians);
    ctx.scale(plan.scaleX, plan.scaleY);
    try {
      ctx.drawImage(source, plan.source.x, plan.source.y, plan.source.width, plan.source.height,
        plan.destination.x, plan.destination.y, plan.destination.width, plan.destination.height);
    } catch {
      /* a frame that is not ready draws nothing */
    }
    ctx.restore();
    if (!this.filterWorks && !isNeutral(clip.color)) this.pixelColor(ctx, rect, clip);
    return rect;
  }

  /** The colour adjustment on raw pixels, for canvases without `filter`. */
  private pixelColor(ctx: CanvasRenderingContext2D, rect: Rect, clip: MediaClip): void {
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const w = Math.min(ctx.canvas.width - x, Math.ceil(rect.width));
    const h = Math.min(ctx.canvas.height - y, Math.ceil(rect.height));
    if (w <= 0 || h <= 0) return;
    try {
      const img = ctx.getImageData(x, y, w, h);
      applyColorAdjust(img.data, clip.color);
      ctx.putImageData(img, x, y);
    } catch {
      /* unreadable pixels stay unadjusted */
    }
  }

  private drawOffline(ctx: CanvasRenderingContext2D, rect: Rect): void {
    ctx.save();
    ctx.fillStyle = '#1b2233';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = 'rgba(229,72,77,.55)';
    ctx.lineWidth = Math.max(2, rect.width / 200);
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.beginPath();
    for (let x = -rect.height; x < rect.width; x += Math.max(8, rect.height / 6)) {
      ctx.moveTo(rect.x + x, rect.y + rect.height);
      ctx.lineTo(rect.x + x + rect.height, rect.y);
    }
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#E8ECF4';
    ctx.font = `600 ${Math.max(12, rect.height * 0.06)}px ${FONT_STACKS.sans}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.labels.offline, rect.x + rect.width / 2, rect.y + rect.height / 2);
    ctx.restore();
  }

  /** Audio with no picture: a calm waveform "visualiser" from the real peaks. */
  private drawAudioVisual(ctx: CanvasRenderingContext2D, w: number, h: number, time: number): void {
    const sound = audibleAt(this.project, time).find((a) => this.lookup(a.clip.mediaId)?.peaks);
    const media = sound ? this.lookup(sound.clip.mediaId) : undefined;
    if (!sound || !media?.peaks || !(media.duration > 0)) return;
    const bars = 48;
    const barW = (w * 0.7) / bars;
    const x0 = w * 0.15;
    const peaks = media.peaks;
    ctx.save();
    for (let i = 0; i < bars; i++) {
      const at = sound.sourceTime + ((i - bars / 2) / bars) * 2;
      const index = Math.floor((clamp(at, 0, media.duration) / media.duration) * (peaks.length - 1));
      const v = Math.max(0.04, peaks[index] ?? 0);
      const bh = v * h * 0.5;
      ctx.globalAlpha = i < bars / 2 ? 0.95 : 0.45;
      ctx.fillStyle = i < bars / 2 ? '#C8894B' : '#5B8DEF';
      const bx = x0 + i * barW;
      ctx.fillRect(bx + barW * 0.15, h / 2 - bh / 2, barW * 0.7, bh);
    }
    ctx.restore();
  }

  private drawText(ctx: CanvasRenderingContext2D, w: number, h: number, clip: TextClip, time: number): Rect | null {
    const anim = textAnimAt(clip, time);
    const text = clip.text.trim() ? clip.text : ' ';
    const fontPx = Math.max(4, clip.size * h * anim.scale);
    const dir = textDirection(text);
    ctx.save();
    ctx.font = `${clip.bold ? 700 : 400} ${fontPx}px ${FONT_STACKS[clip.font]}`;
    ctx.direction = dir;
    const measure = (s: string) => ctx.measureText(s).width;
    const lines = wrapLines(text, w * 0.88, measure);
    const lineH = fontPx * 1.3;
    const blockW = Math.max(...lines.map(measure), fontPx * 0.5);
    const cx = clip.x * w;
    const cy = clip.y * h + anim.dy * h;
    const pad = fontPx * 0.35;
    const rect: Rect = { x: cx - blockW / 2 - pad, y: cy - (lines.length * lineH) / 2 - pad * 0.6, width: blockW + pad * 2, height: lines.length * lineH + pad * 1.2 };
    if (anim.alpha <= 0) {
      ctx.restore();
      return rect;
    }
    ctx.globalAlpha = anim.alpha;
    if (clip.background) {
      ctx.fillStyle = clip.background;
      const r = Math.min(fontPx * 0.3, rect.height / 2);
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(rect.x, rect.y, rect.width, rect.height, r);
      else ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.fill();
    } else {
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = fontPx * 0.12;
      ctx.shadowOffsetY = fontPx * 0.04;
    }
    const align = canvasAlign(clip.align, dir);
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = clip.color;
    const x = anchorX(align, cx, blockW);
    lines.forEach((line, i) => {
      ctx.fillText(line, x, cy - ((lines.length - 1) * lineH) / 2 + i * lineH);
    });
    ctx.restore();
    return rect;
  }

  /* ───────────── capture ───────────── */

  async captureFrame(size: { width: number; height: number }): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.drawFrame(ctx, size.width, size.height, this.t, false);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('png encode failed'))), 'image/png');
    });
  }

  /* ───────────── export: video ───────────── */

  private waitReady(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const started = performance.now();
      const check = () => {
        const layers = visualsAt(this.project, this.t).layers.filter((l) => l.clip.type === 'video' && this.lookup(l.clip.mediaId)?.url);
        const ok = layers.every((l) => {
          const slot = this.slotFor(l.clip.id);
          return slot && slot.el.readyState >= 2 && !slot.el.seeking;
        });
        if (ok || performance.now() - started > timeout) resolve();
        else window.setTimeout(check, 30);
      };
      check();
    });
  }

  async exportVideo(o: VideoExportOptions): Promise<VideoExportResult> {
    if (this.job) throw new Error('an export is already running');
    const range = o.range ?? { start: 0, end: this.duration };
    if (!(range.end - range.start > 0)) throw new Error('nothing to export');
    const Recorder = (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    if (typeof Recorder !== 'function') throw new Error('MediaRecorder is not available');
    this.pause();
    this.ensureAudio();
    const previous = { width: this.canvas.width, height: this.canvas.height };
    this.canvas.width = o.width;
    this.canvas.height = o.height;
    if (this.mix) this.mix.gain.value = 1;
    if (this.monitor) this.monitor.gain.value = 0;
    this.t = range.start;
    this.sync(false, true);
    await this.waitReady(6000);
    this.drawFrame(this.ctx, o.width, o.height, this.t, false);

    const stream = this.canvas.captureStream(o.fps);
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = this.streamDest?.stream.getAudioTracks()[0] ?? null;
    const recorded = new MediaStream();
    if (videoTrack) recorded.addTrack(videoTrack);
    if (audioTrack && this.hasSound(range)) recorded.addTrack(audioTrack);
    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new Recorder(recorded, { mimeType: o.mime, videoBitsPerSecond: o.videoBitrate, audioBitsPerSecond: o.audioBitrate });
    } catch (err) {
      this.restoreAfterExport(previous, stream);
      throw err instanceof Error ? err : new Error('recorder refused the settings');
    }
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });

    let cancelled = false;
    const result = await new Promise<VideoExportResult>((resolve, reject) => {
      const finishRecording = () => {
        if (!this.job) return;
        const job = this.job;
        const stop = () => {
          recorder.addEventListener('stop', () => {
            if (cancelled) return;
            const recordedLength = Math.max(0, Math.min(this.t, range.end) - range.start);
            void new Blob(chunks, { type: o.mime }).arrayBuffer().then((buffer) => {
              let bytes: Uint8Array = new Uint8Array(buffer);
              if (o.mime.startsWith('video/webm') || o.mime.startsWith('audio/webm')) bytes = fixWebmDuration(bytes, recordedLength);
              resolve({ blob: new Blob([bytes.slice()], { type: o.mime.split(';')[0] }), mime: o.mime, duration: recordedLength, frames: job.frames });
            }, reject);
          }, { once: true });
          try { recorder.stop(); } catch (err) { reject(err); }
        };
        // A short tail so the final frame and the last audio packet are in the file.
        window.setTimeout(stop, 150);
      };
      const onAbort = () => {
        cancelled = true;
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* already stopped */ }
        reject(new ExportCancelled());
      };
      o.signal.addEventListener('abort', onAbort, { once: true });
      recorder.addEventListener('error', () => reject(new Error('the recorder failed')), { once: true });
      this.job = {
        recorder,
        start: range.start,
        end: range.end,
        startedWall: performance.now(),
        frames: 0,
        onProgress: o.onProgress,
        finish: () => {
          o.signal.removeEventListener('abort', onAbort);
          finishRecording();
        },
      };
      const progress = this.onTick((time) => {
        if (!this.job) return;
        const fraction = clamp((time - range.start) / (range.end - range.start), 0, 1);
        this.job.onProgress(fraction, (performance.now() - this.job.startedWall) / 1000);
      });
      const cleanup = () => progress();
      o.signal.addEventListener('abort', cleanup, { once: true });
      recorder.addEventListener('stop', cleanup, { once: true });
      if (o.signal.aborted) {
        onAbort();
        return;
      }
      recorder.start(250);
      this.startClock();
    }).finally(() => {
      this.job = null;
      this.isPlaying = false;
      for (const slot of this.slots) if (!slot.el.paused) slot.el.pause();
      this.restoreAfterExport(previous, stream);
      this.emitState();
    });
    return result;
  }

  private hasSound(range: { start: number; end: number }): boolean {
    for (const track of this.project.tracks) {
      if (track.kind === 'text' || track.muted) continue;
      for (const p of layoutTrack(track)) {
        const clip = p.clip;
        if (!isMedia(clip) || clip.type === 'image' || clip.muted) continue;
        if (p.end <= range.start || p.start >= range.end) continue;
        if (this.lookup(clip.mediaId)?.hasAudio !== false) return true;
      }
    }
    return false;
  }

  private restoreAfterExport(previous: { width: number; height: number }, stream: MediaStream): void {
    stream.getVideoTracks().forEach((track) => track.stop());
    this.canvas.width = previous.width;
    this.canvas.height = previous.height;
    if (this.monitor) this.monitor.gain.value = 1;
    this.applyMixGain();
    this.requestRender();
  }

  /* ───────────── export: audio (offline, WAV) ───────────── */

  async exportAudio(o: AudioExportOptions): Promise<Blob> {
    const range = o.range ?? { start: 0, end: this.duration };
    const length = range.end - range.start;
    if (!(length > 0)) throw new Error('nothing to export');
    const Offline = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!Offline) throw new Error('OfflineAudioContext is not available');
    const rate = 48000;
    const ctx = new Offline(2, Math.ceil(length * rate), rate);
    o.onProgress(0.05);
    const clips: Array<{ clip: MediaClip; start: number; end: number }> = [];
    for (const track of this.project.tracks) {
      if (track.kind === 'text') continue;
      for (const p of layoutTrack(track)) {
        if (!isMedia(p.clip) || p.clip.type === 'image') continue;
        if (p.end <= range.start || p.start >= range.end) continue;
        clips.push({ clip: p.clip, start: p.start, end: p.end });
      }
    }
    let done = 0;
    for (const item of clips) {
      if (o.signal.aborted) throw new ExportCancelled();
      const buffer = await this.decode(item.clip.mediaId);
      done += 1;
      o.onProgress(0.05 + (0.45 * done) / Math.max(1, clips.length));
      if (!buffer) continue;
      const from = Math.max(item.start, range.start);
      const to = Math.min(item.end, range.end);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = clampSpeed(item.clip.speed);
      const gain = ctx.createGain();
      // The gain curve is sampled from the same model the preview uses.
      const steps = Math.max(2, Math.ceil((to - from) * 30));
      for (let i = 0; i <= steps; i++) {
        const at = from + ((to - from) * i) / steps;
        const g = audibleAt(this.project, Math.min(at, to - 1e-4)).find((a) => a.clip.id === item.clip.id)?.gain ?? 0;
        gain.gain.setValueAtTime(g, at - range.start);
      }
      node.connect(gain);
      gain.connect(ctx.destination);
      const offset = sourceTimeAt(item.clip, item.start, from);
      node.start(from - range.start, offset, (to - from) * clampSpeed(item.clip.speed));
    }
    if (o.signal.aborted) throw new ExportCancelled();
    const rendered = await ctx.startRendering();
    if (o.signal.aborted) throw new ExportCancelled();
    o.onProgress(0.95);
    const channels = [rendered.getChannelData(0), rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rendered.getChannelData(0)];
    const wav = encodeWav(channels, rate);
    o.onProgress(1);
    return new Blob([wav.slice()], { type: 'audio/wav' });
  }

  private async decode(mediaId: string): Promise<AudioBuffer | null> {
    const cached = this.decoded.get(mediaId);
    if (cached) return cached;
    const media = this.lookup(mediaId);
    if (!media?.bytes || media.hasAudio === false) return null;
    const Offline = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!Offline) return null;
    try {
      const buffer = await new Offline(2, 1, 48000).decodeAudioData(media.bytes.slice().buffer);
      this.decoded.set(mediaId, buffer);
      return buffer;
    } catch {
      return null;
    }
  }

  /* ───────────── teardown ───────────── */

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const slot of this.slots) {
      slot.el.pause();
      slot.el.removeAttribute('src');
      slot.el.load();
    }
    this.slots = [];
    this.host.remove();
    void this.audio?.close().catch(() => undefined);
    this.audio = null;
    this.tickCbs.clear();
    this.stateCbs.clear();
    this.decoded.clear();
  }
}
