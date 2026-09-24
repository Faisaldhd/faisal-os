/**
 * `CanvasStudioEngine` — the dedicated rendering/export engine behind the UI's
 * `StudioEngine` port (`../engine-port.ts`).
 *
 * It consumes the project model as-is (`../project.ts`): no second timeline
 * model exists. Drop-in for the preview adapter:
 *
 *     const engine = new CanvasStudioEngine({ offline: t('video.offline') });
 *     engine.setMedia((id) => library.engineMedia(id));
 *     engine.setProject(project, frameSize(project.aspect, first));
 *     engine.setPreviewSize(w * devicePixelRatio, h * devicePixelRatio);
 *     host.append(engine.canvas);
 *
 * Preview, scrub, `captureFrame` and `exportVideo` all draw through the same
 * compositor, so the file matches what the user saw.
 */
import {
  ExportCancelled,
  type AudioExportOptions,
  type EngineBox,
  type EngineLabels,
  type EngineMedia,
  type StudioEngine,
  type VideoExportOptions,
  type VideoExportResult,
} from '../engine-port';
import { projectDuration, type Project } from '../project';
import { encodeWav } from '../wav';
import { decodeBytes, decodeUrl, MixCancelled, renderMixOffline } from './audio-mix';
import { recordProject, exportRange } from './exporter';
import { toCanvas, viewFor, type Size } from './layout';
import { MediaPool } from './media-pool';
import { TimelineRenderer } from './player';

export class CanvasStudioEngine implements StudioEngine {
  readonly canvas: HTMLCanvasElement;
  private readonly pool = new MediaPool();
  private readonly renderer: TimelineRenderer;
  private project: Project | null = null;
  private frame: Size = { width: 1920, height: 1080 };
  private readonly tickListeners = new Set<(time: number) => void>();
  private readonly stateListeners = new Set<() => void>();
  private busy = false;
  private volume = 1;
  private muted = false;
  private loopWhole = false;

  constructor(labels?: EngineLabels, canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    this.renderer = new TimelineRenderer({ canvas: this.canvas, pool: this.pool, output: 'speakers' });
    this.renderer.offlineLabel = labels?.offline;
    this.renderer.onTick = (t) => this.emitTick(t);
    this.renderer.onEnded = () => this.emitState();
  }

  /* ───────────── model ───────────── */

  setProject(project: Project, frame: { width: number; height: number }): void {
    this.project = project;
    this.frame = { width: frame.width, height: frame.height };
    this.renderer.setProject(project, frame);
    if (this.loopWhole) this.renderer.loop = { start: 0, end: projectDuration(project) };
    if (!this.renderer.playing) void this.renderer.seek(Math.min(this.renderer.time, this.duration));
  }

  setMedia(lookup: (id: string) => EngineMedia | undefined): void {
    this.pool.setLookup(lookup);
    if (!this.renderer.playing) void this.renderer.seek(this.renderer.time);
  }

  setPreviewSize(width: number, height: number): void {
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.renderer.draw();
  }

  /** Shows the action/title safe areas on the preview (never exported). */
  setGuides(on: boolean): void {
    this.renderer.guides = on;
    this.renderer.draw();
  }

  get time(): number {
    return this.renderer.time;
  }

  get playing(): boolean {
    return this.renderer.playing;
  }

  get duration(): number {
    return this.project ? projectDuration(this.project) : 0;
  }

  get exporting(): boolean {
    return this.busy;
  }

  /* ───────────── transport ───────────── */

  async play(): Promise<void> {
    if (this.busy) return;
    const started = this.renderer.play();
    this.emitState();
    await started;
    this.emitState();
  }

  pause(): void {
    this.renderer.pause();
    this.emitState();
  }

  seek(time: number): void {
    const t = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, this.duration));
    void this.renderer.seek(t);
    this.emitTick(t);
  }

  setRate(rate: number): void {
    this.renderer.setRate(rate);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.renderer.mixer.setMasterVolume(this.muted ? 0 : volume);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.renderer.mixer.setMasterVolume(muted ? 0 : this.volume);
  }

  setLoop(range: { start: number; end: number } | null, enabled: boolean): void {
    this.loopWhole = enabled && range === null;
    this.renderer.loop = !enabled ? null : range ?? { start: 0, end: this.duration };
  }

  setStopAt(end: number | null): void {
    this.renderer.stopAt = end;
  }

  onTick(cb: (time: number) => void): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  onState(cb: () => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private emitTick(t: number): void {
    for (const cb of this.tickListeners) {
      try { cb(t); } catch { /* a listener's failure never stops playback */ }
    }
  }

  private emitState(): void {
    for (const cb of this.stateListeners) {
      try { cb(); } catch { /* a listener's failure never stops playback */ }
    }
  }

  /** Titles and overlays in the frame last drawn, in canvas pixels. */
  boxes(): EngineBox[] {
    const report = this.renderer.report;
    if (!report) return [];
    const view = viewFor(this.frame, { width: this.canvas.width, height: this.canvas.height });
    return report.boxes.map((b) => ({ id: b.id, kind: b.kind, rect: toCanvas(b.rect, view) }));
  }

  /* ───────────── output ───────────── */

  async exportVideo(options: VideoExportOptions): Promise<VideoExportResult> {
    if (!this.project) throw new Error('no project');
    if (this.busy) throw new Error('an export is already running');
    this.pause();
    this.busy = true;
    this.emitState();
    try {
      return await recordProject(this.project, this.frame, this.pool.getLookup(), options);
    } finally {
      this.busy = false;
      this.emitState();
      void this.renderer.seek(this.renderer.time);
    }
  }

  /** The mix as a 16-bit WAV, rendered offline (faster than real time). */
  async exportAudio(options: AudioExportOptions): Promise<Blob> {
    if (!this.project) throw new Error('no project');
    if (options.signal.aborted) throw new ExportCancelled();
    const range = exportRange(this.duration, options.range);
    if (!(range.end > range.start)) throw new Error('the timeline is empty');
    const lookup = this.pool.getLookup();
    const decode = async (id: string) => {
      const media = lookup(id);
      if (!media) return null;
      if (media.bytes) return decodeBytes(media.bytes);
      return media.url ? decodeUrl(media.url) : null;
    };
    this.busy = true;
    this.emitState();
    try {
      const mix = await renderMixOffline(this.project, this.duration, decode, {
        range,
        signal: options.signal,
        onProgress: (f) => options.onProgress(f),
      });
      const channels: Float32Array[] = [];
      for (let c = 0; c < mix.buffer.numberOfChannels; c++) channels.push(mix.buffer.getChannelData(c));
      const wav = encodeWav(channels, mix.buffer.sampleRate);
      return new Blob([wav as BlobPart], { type: 'audio/wav' });
    } catch (err) {
      if (err instanceof MixCancelled || options.signal.aborted) throw new ExportCancelled();
      throw err;
    } finally {
      this.busy = false;
      this.emitState();
    }
  }

  /** The current frame at `size` as PNG, drawn by the same compositor. */
  captureFrame(size: { width: number; height: number }): Promise<Blob> {
    const scratch = document.createElement('canvas');
    scratch.width = Math.max(2, Math.round(size.width));
    scratch.height = Math.max(2, Math.round(size.height));
    this.renderer.draw(this.renderer.time, scratch);
    return new Promise((resolve, reject) => {
      scratch.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('png encode failed'))), 'image/png');
    });
  }

  dispose(): void {
    this.renderer.dispose();
    this.tickListeners.clear();
    this.stateListeners.clear();
  }
}
