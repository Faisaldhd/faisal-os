/**
 * The timeline renderer (DOM): a master clock, the media elements that follow
 * it, the audio mix and the compositor, driving one canvas.
 *
 * The preview uses one of these on the visible canvas (sound to the speakers);
 * the exporter uses another on an off-screen canvas (sound to the recorder).
 * Both draw every frame through `composeFrame`, so the export is the preview.
 */
import { projectDuration, type Project } from '../project';
import { composeFrame, type ComposeReport, type Scratch } from './compositor';
import { LiveMixer, type MixerOutput } from './audio-mix';
import { MediaPool, seekAccurate } from './media-pool';
import { clipsNeeded, Clock, syncAction } from './sync';
import { viewFor, type Size } from './layout';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  pool: MediaPool;
  output: MixerOutput;
  /** Keep ticking with timers when the page is hidden (export). */
  background?: boolean;
}

/** The last instant of a timeline that still shows a picture (`visualsAt` is half-open). */
export function lastFrameTime(duration: number): number {
  return Math.max(0, duration - 1e-3);
}

/** What the tick does at time `t`: keep going, wrap to the loop start, or stop. */
export function tickDecision(
  t: number,
  duration: number,
  loop: { start: number; end: number } | null,
  stopAt: number | null,
): { kind: 'play'; time: number } | { kind: 'wrap'; time: number } | { kind: 'end'; time: number } {
  if (loop && loop.end > loop.start && t >= loop.end) return { kind: 'wrap', time: loop.start };
  const end = Math.min(duration, stopAt !== null && stopAt > 0 ? stopAt : Number.POSITIVE_INFINITY);
  if (t >= end) return { kind: 'end', time: end };
  return { kind: 'play', time: t };
}

export class TimelineRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly pool: MediaPool;
  readonly mixer: LiveMixer;
  private project: Project | null = null;
  private frame: Size = { width: 1920, height: 1080 };
  private readonly clock = new Clock();
  private loopHandle = 0;
  private loopIsTimer = false;
  private seekSeq = 0;
  private scratchCanvas: HTMLCanvasElement | null = null;
  private readonly background: boolean;
  private lastReport: ComposeReport | null = null;
  guides = false;
  offlineLabel: string | undefined = undefined;
  /** Plays `[start, end)` over and over while set. */
  loop: { start: number; end: number } | null = null;
  /** Stops here instead of at the end of the film. */
  stopAt: number | null = null;
  /** Frames drawn while playing (the exporter reports it). */
  framesDrawn = 0;

  /** Called on every drawn tick while playing, with the timeline time. */
  onTick: ((time: number) => void) | null = null;
  /** Called once when playback reaches its end (or `stopAt`). */
  onEnded: (() => void) | null = null;

  constructor(options: RendererOptions) {
    this.canvas = options.canvas;
    this.pool = options.pool;
    this.mixer = new LiveMixer(options.output);
    this.background = options.background ?? false;
    this.pool.onRelease = (el) => this.mixer.release(el);
  }

  setProject(project: Project, frame: Size): void {
    this.project = project;
    this.frame = { width: Math.max(2, Math.round(frame.width)), height: Math.max(2, Math.round(frame.height)) };
  }

  get frameSize(): Size {
    return { ...this.frame };
  }

  get duration(): number {
    return this.project ? projectDuration(this.project) : 0;
  }

  get time(): number {
    return this.clock.time();
  }

  get playing(): boolean {
    return this.clock.isRunning;
  }

  get report(): ComposeReport | null {
    return this.lastReport;
  }

  setRate(rate: number): void {
    this.clock.setRate(Math.min(4, Math.max(0.1, Number.isFinite(rate) ? rate : 1)));
  }

  /** Draws the frame at `time` with whatever pictures the elements hold now. */
  draw(time = this.time, target: HTMLCanvasElement = this.canvas): ComposeReport | null {
    if (!this.project) return null;
    const ctx = target.getContext('2d');
    if (!ctx) return null;
    const canvas = { width: target.width, height: target.height };
    const report = composeFrame(ctx, this.project, Math.min(time, lastFrameTime(this.duration)), this.frame, this.pool, {
      view: viewFor(this.frame, canvas),
      canvas,
      guides: target === this.canvas ? this.guides : false,
      offlineLabel: this.offlineLabel,
      scratch: (size) => this.scratch(size),
    });
    if (target === this.canvas) this.lastReport = report;
    return report;
  }

  /**
   * Moves to `time` and resolves once the frame there is drawn with every
   * picture decoded. A later seek supersedes an earlier one (only the last one draws).
   */
  async seek(time: number): Promise<void> {
    const t = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, this.duration));
    this.clock.set(t);
    if (this.playing) return; // the next tick re-syncs every element
    const seq = ++this.seekSeq;
    this.draw(t); // immediate feedback with the pictures at hand
    await this.prepare(t);
    if (seq === this.seekSeq && !this.playing) this.draw(t);
  }

  /** Parks every element needed at `time` on its exact frame (bounded wait). */
  private async prepare(time: number): Promise<void> {
    const project = this.project;
    if (!project) return;
    const needs = clipsNeeded(project, time, 0.5);
    const keep = new Set<string>();
    const waits: Promise<void>[] = [];
    for (const need of needs) {
      keep.add(need.clip.id);
      const el = this.pool.element(need.clip);
      if (!el) continue;
      if (!el.paused) el.pause();
      this.mixer.silence(el);
      waits.push(seekAccurate(el, need.sourceTime, 2500));
    }
    this.pool.retain(keep);
    await Promise.all(waits);
  }

  /** Starts playback from `from` (default: where the playhead is). */
  async play(from?: number): Promise<void> {
    if (!this.project || this.playing) return;
    let t = from ?? this.time;
    const end = tickDecision(t, this.duration, null, this.stopAt);
    if (end.kind === 'end') t = this.loop ? this.loop.start : 0;
    this.seekSeq++;
    await this.mixer.resume();
    this.clock.set(t);
    await this.prepare(t);
    // Start the clips that are live now together, then start the clock.
    const starts: Promise<unknown>[] = [];
    for (const need of clipsNeeded(this.project, t, 0)) {
      const el = this.pool.element(need.clip);
      if (!el) continue;
      try { el.playbackRate = need.clip.speed * this.clock.speed; } catch { /* keeps 1 */ }
      if (need.gain !== null) this.mixer.setGain(el, need.gain);
      starts.push(el.play().catch(() => undefined));
    }
    await Promise.race([Promise.all(starts), new Promise((r) => setTimeout(r, 800))]);
    this.framesDrawn = 0;
    this.clock.start(t);
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    const t = this.clock.pause();
    this.stopLoop();
    this.halt();
    this.draw(t);
  }

  private halt(): void {
    this.pool.pauseAll();
    for (const el of this.pool.elements()) this.mixer.silence(el);
  }

  private tick = (): void => {
    this.loopHandle = 0;
    if (!this.project || !this.playing) return;
    const decision = tickDecision(this.clock.time(), this.duration, this.loop, this.stopAt);
    if (decision.kind === 'wrap') this.clock.set(decision.time);
    const t = decision.time;
    if (decision.kind === 'end') {
      this.draw(t);
      this.framesDrawn += 1;
      this.clock.pause();
      this.clock.set(t);
      this.halt();
      this.onTick?.(t);
      this.onEnded?.();
      return;
    }
    this.follow(t);
    this.draw(t);
    this.framesDrawn += 1;
    this.onTick?.(t);
    this.schedule();
  };

  /** Keeps every element on the clock and sets its gain. */
  private follow(t: number): void {
    const project = this.project;
    if (!project) return;
    const keep = new Set<string>();
    const rate = this.clock.speed;
    for (const need of clipsNeeded(project, t)) {
      keep.add(need.clip.id);
      const el = this.pool.element(need.clip);
      if (!el) continue;
      if (need.preroll) {
        if (!el.paused) el.pause();
        this.mixer.silence(el);
        if (!el.seeking && el.readyState >= 1 && Math.abs(el.currentTime - need.sourceTime) > 0.05) el.currentTime = need.sourceTime;
        continue;
      }
      const action = syncAction(el.currentTime, need.sourceTime, need.clip.speed * rate, el.paused);
      if (action.seek !== null && !el.seeking) {
        try { el.currentTime = action.seek; } catch { /* not seekable yet */ }
      }
      if (Math.abs(el.playbackRate - action.rate) > 1e-3) {
        try { el.playbackRate = action.rate; } catch { /* rate refused; keep the old one */ }
      }
      if (el.paused && action.play && !el.ended) void el.play().catch(() => undefined);
      if (need.gain === null) this.mixer.silence(el);
      else this.mixer.setGain(el, need.gain);
    }
    this.pool.retain(keep);
  }

  private schedule(): void {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hidden && this.background) {
      this.loopIsTimer = true;
      this.loopHandle = window.setTimeout(this.tick, 16);
    } else {
      this.loopIsTimer = false;
      this.loopHandle = window.requestAnimationFrame(this.tick);
    }
  }

  private stopLoop(): void {
    if (!this.loopHandle) return;
    if (this.loopIsTimer) window.clearTimeout(this.loopHandle);
    else window.cancelAnimationFrame(this.loopHandle);
    this.loopHandle = 0;
  }

  private scratch(size: Size): Scratch | null {
    if (!this.scratchCanvas) this.scratchCanvas = document.createElement('canvas');
    const c = this.scratchCanvas;
    if (c.width !== size.width) c.width = size.width;
    if (c.height !== size.height) c.height = size.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    return ctx ? { canvas: c, ctx } : null;
  }

  dispose(): void {
    this.stopLoop();
    this.clock.pause();
    this.pool.dispose();
    this.mixer.dispose();
    this.scratchCanvas = null;
    this.onTick = null;
    this.onEnded = null;
  }
}
