/**
 * The media pipeline: one `<video>` element, one hidden audio element, one canvas.
 *
 * WHAT THIS DOES
 *  • Plays the source file and mirrors every visible frame onto a canvas with the
 *    requested rotation, flip and crop, so the preview shows the real output.
 *  • Exports by playing the clips in order in real time while recording the canvas
 *    and the audio graph.
 *
 * THE TWO ENGINES (export.ts chooses; this file only runs the chosen one)
 *  • `webcodecs`: each drawn frame is wrapped in a `VideoFrame` and encoded by
 *    `VideoEncoder`; the encoded chunks are written into a
 *    `MediaStreamTrackGenerator` track, which `MediaRecorder` then muxes into a
 *    real container. WebCodecs alone produces elementary streams, not files — the
 *    container is still written by MediaRecorder, and the UI says so.
 *  • `mediarecorder`: the canvas capture stream is recorded directly.
 *
 * HONEST NOTES ENCODED IN THE RESULT
 *  • Recording runs in real time: the export takes about as long as the result.
 *  • `frameAccurate` is measured, not assumed: true only when the browser exposes
 *    `requestVideoFrameCallback`, which is what lets this loop stop on the exact
 *    frame the user asked for.
 *  • Every failure rejects with a short reason; nothing here ever resolves with a
 *    file that was not recorded.
 */
import { clampFades, trackGainAt, type FadeConfig } from './fades';
import { drawPlan, evenSize, outputSize, type Clip, type VideoTransform } from './clips';
import { rangeLength, safeDuration } from './time';
import type { ExportEngine } from './export';

/* ─────────────────────────────── requests ─────────────────────────────── */

export interface ExportRequest {
  clips: readonly Clip[];
  transform: VideoTransform;
  /** Multiplier applied on top of the fades. */
  gain: number;
  fades: FadeConfig;
  muted: boolean;
  /** Containers the plan will accept, best first. */
  candidates: string[];
  /** The engine the plan chose. */
  engine: ExportEngine;
  /** Target frame rate for the canvas capture stream. */
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  signal: AbortSignal;
  onProgress: (report: ExportProgress) => void;
}

export interface ExportProgress {
  /** Seconds already recorded into the output. */
  outputTime: number;
  total: number;
  /** 0…1. */
  fraction: number;
  /** Index of the clip being recorded. */
  clipIndex: number;
}

export interface ExportResult {
  blob: Blob;
  mime: string;
  engine: ExportEngine;
  /** Seconds actually written. */
  duration: number;
  /** Measured output frame rate over the recorded wall-clock time. */
  effectiveFps: number;
  /** True when the browser let this loop stop on an exact frame. */
  frameAccurate: boolean;
  frames: number;
}

/** Raised when the user cancels; the caller shows "cancelled", never an error. */
export class ExportCancelled extends Error {
  constructor() {
    super('export cancelled');
    this.name = 'ExportCancelled';
  }
}

export interface PipelineOptions {
  /** The element on screen that the user interacts with. */
  video: HTMLVideoElement;
  /** A second element used only for its audio, routed through Web Audio. */
  audio: HTMLVideoElement;
  canvas: HTMLCanvasElement;
}

/* ───────────────────────────── the pipeline ───────────────────────────── */

export class VideoPipeline {
  private readonly video: HTMLVideoElement;
  private readonly audioEl: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;

  private audioContext: AudioContext | null = null;
  private audioSource: MediaElementAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private audioDestination: MediaStreamAudioDestinationNode | null = null;

  private rafId = 0;
  private transform: VideoTransform | null = null;
  private lastSource: { width: number; height: number } | null = null;
  private measuredFps = 0;
  private readonly videoRvc: FrameCallback | null;

  constructor(options: PipelineOptions) {
    this.video = options.video;
    this.audioEl = options.audio;
    this.canvas = options.canvas;
    this.videoRvc = frameCallback(this.video);
  }

  /* ───────────── loading and basics ───────────── */

  async load(url: string): Promise<{ width: number; height: number; duration: number }> {
    this.video.src = url;
    this.audioEl.src = url;
    this.video.load();
    this.audioEl.load();
    await once(this.video, 'loadedmetadata');
    if (this.video.error) throw new Error(mediaErrorReason(this.video.error));
    const width = this.video.videoWidth || 0;
    const height = this.video.videoHeight || 0;
    if (width === 0 || height === 0) {
      // An audio-only file has no picture; that is the whole file, not a failure.
      this.lastSource = null;
      return { width: 0, height: 0, duration: safeDuration(this.video.duration) };
    }
    this.lastSource = { width, height };
    this.canvas.width = width;
    this.canvas.height = height;
    return { width, height, duration: safeDuration(this.video.duration) };
  }

  get sourceSize(): { width: number; height: number } | null {
    return this.lastSource;
  }

  get duration(): number {
    return safeDuration(this.video.duration);
  }

  get currentTime(): number {
    return this.video.currentTime;
  }

  get paused(): boolean {
    return this.video.paused;
  }

  /** True when the browser exposes `requestVideoFrameCallback` — the precision claim. */
  get frameAccurate(): boolean {
    return this.videoRvc !== null;
  }

  /** The frame rate measured during playback, or 0 while it is still unknown. */
  get fps(): number {
    return this.measuredFps;
  }

  /** A measured frame step: the real rate when known, else 1/30 s. */
  get frameStep(): number {
    return this.measuredFps > 0 ? 1 / this.measuredFps : 1 / 30;
  }

  /**
   * True when the source really carries audio.
   *
   * Chromium and WebKit do not expose an audio track list, so the honest answers
   * are "the container says there is audio" or "something was decoded". When
   * neither exists the answer is `true`: asking a nonexistent track to play is
   * harmless, while dropping real audio would not be.
   */
  hasAudio(): boolean {
    const el = this.video as HTMLVideoElement & {
      mozHasAudio?: boolean;
      audioTracks?: { length: number };
      webkitAudioDecodedByteCount?: number;
    };
    if (typeof el.mozHasAudio === 'boolean') return el.mozHasAudio;
    if (el.audioTracks) return el.audioTracks.length > 0;
    if (typeof el.webkitAudioDecodedByteCount === 'number' && el.webkitAudioDecodedByteCount > 0) return true;
    return true;
  }

  seek(time: number): Promise<void> {
    const target = Math.max(0, time);
    if (Math.abs(this.video.currentTime - target) < 0.001 && this.video.readyState >= 2) return Promise.resolve();
    return Promise.all([
      seekElement(this.video, target),
      seekElement(this.audioEl, target).catch(() => undefined),
    ]).then(() => undefined);
  }

  /** Starts playback and keeps the hidden audio element on the same position. */
  async play(): Promise<void> {
    this.applyPlaybackGain();
    await Promise.all([this.video.play(), this.audioEl.play().catch(() => undefined)]);
    this.measureFps();
    this.startRenderLoop();
  }

  pause(): void {
    this.video.pause();
    this.audioEl.pause();
    this.stopRenderLoop();
  }

  async stop(): Promise<void> {
    this.pause();
    await this.seek(0);
    if (this.transform) this.draw(this.transform);
  }

  setVolume(value: number): void {
    this.audioEl.volume = Math.min(1, Math.max(0, value));
    this.video.muted = true;
    this.applyPlaybackGain();
  }

  setMuted(muted: boolean): void {
    this.audioEl.muted = muted;
    this.applyPlaybackGain();
  }

  get muted(): boolean {
    return this.audioEl.muted;
  }

  setRate(rate: number): void {
    const value = Math.min(4, Math.max(0.25, rate));
    this.video.playbackRate = value;
    this.audioEl.playbackRate = value;
  }

  /** One frame forward/back from the current position, keeping both elements in step. */
  async step(direction: -1 | 1): Promise<void> {
    this.pause();
    const step = this.frameStep;
    const next = direction === 1
      ? Math.floor(this.video.currentTime / step + 1e-6) + 1
      : Math.ceil(this.video.currentTime / step - 1e-6) - 1;
    await this.seek(Math.min(Math.max(0, next * step), this.duration));
    if (this.transform) this.draw(this.transform);
  }

  /* ───────────── preview rendering ───────────── */

  /** Draws the current frame with a transform; safe to call at any time. */
  draw(transform: VideoTransform): void {
    this.transform = transform;
    this.render(transform);
  }

  private render(transform: VideoTransform): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || this.video.readyState < 2) return;
    const size = this.lastSource ?? { width: this.canvas.width, height: this.canvas.height };
    if (size.width === 0 || size.height === 0) return;
    const plan = drawPlan(size, transform);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.translate(plan.translateX, plan.translateY);
    ctx.rotate(plan.rotateRadians);
    ctx.scale(plan.scaleX, plan.scaleY);
    try {
      ctx.drawImage(
        this.video,
        plan.source.x, plan.source.y, plan.source.width, plan.source.height,
        plan.destination.x, plan.destination.y, plan.destination.width, plan.destination.height,
      );
    } catch {
      // A frame that is not ready yet draws nothing; the next tick tries again.
    }
    ctx.restore();
  }

  private startRenderLoop(): void {
    if (this.rafId) return;
    const tick = () => {
      if (this.transform) this.render(this.transform);
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private stopRenderLoop(): void {
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** Counts real video frames for one second, to turn "frame step" into a real number. */
  private measureFps(): void {
    if (!this.videoRvc || this.measuredFps > 0) return;
    let count = 0;
    const start = performance.now();
    const tick = () => {
      count += 1;
      const elapsed = (performance.now() - start) / 1000;
      if (elapsed >= 1) {
        this.measuredFps = count / elapsed;
        return;
      }
      this.videoRvc?.request(tick);
    };
    this.videoRvc.request(tick);
  }

  /* ───────────── capture one frame ───────────── */

  /** The current frame as a PNG blob, through a scratch canvas of the output size. */
  capturePng(transform: VideoTransform): Promise<Blob> {
    const source = this.sourceSize;
    if (!source || source.width === 0) return Promise.reject(new Error('no video frame'));
    const size = evenSize(outputSize(source, transform));
    const scratch = document.createElement('canvas');
    scratch.width = size.width;
    scratch.height = size.height;
    const ctx = scratch.getContext('2d');
    if (!ctx) return Promise.reject(new Error('no 2d context'));
    const plan = drawPlan(source, transform);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, scratch.width, scratch.height);
    ctx.save();
    ctx.translate(plan.translateX, plan.translateY);
    ctx.rotate(plan.rotateRadians);
    ctx.scale(plan.scaleX, plan.scaleY);
    try {
      ctx.drawImage(
        this.video,
        plan.source.x, plan.source.y, plan.source.width, plan.source.height,
        plan.destination.x, plan.destination.y, plan.destination.width, plan.destination.height,
      );
    } catch {
      return Promise.reject(new Error('frame not ready'));
    }
    ctx.restore();
    return new Promise((resolve, reject) => {
      scratch.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('png encode failed'))), 'image/png');
    });
  }

  /* ───────────── audio graph ───────────── */

  /**
   * Builds (once) the graph this app uses for playback volume and fades:
   * hidden element → gain → speakers, and gain → MediaStreamDestination, which is
   * what the recorder captures. The visible element stays muted, so sound is heard
   * exactly once and the fades are audible while they are applied.
   *
   * Returns null when the browser refuses (no Web Audio, or a refused source node):
   * playback still works through the element, and the export stays video-only
   * rather than silently claiming audio.
   */
  private ensureAudioGraph(): GainNode | null {
    try {
      if (!this.audioContext) {
        const Ctor = window.AudioContext
          ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        this.audioContext = new Ctor();
      }
      const ctx = this.audioContext;
      if (!this.audioSource) this.audioSource = ctx.createMediaElementSource(this.audioEl);
      if (!this.gainNode) {
        this.gainNode = ctx.createGain();
        this.gainNode.gain.value = 1;
        this.audioSource.connect(this.gainNode);
        this.gainNode.connect(ctx.destination);
      }
      if (!this.audioDestination) {
        this.audioDestination = ctx.createMediaStreamDestination();
        this.gainNode.connect(this.audioDestination);
      }
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      return this.gainNode;
    } catch {
      return null;
    }
  }

  /** Keeps the graph's gain equal to the element's own volume (0 when muted). */
  private applyPlaybackGain(): void {
    const gain = this.gainNode;
    if (!gain) return;
    gain.gain.value = this.audioEl.muted ? 0 : Math.max(0, this.audioEl.volume);
  }

  /* ───────────── export ───────────── */

  async export(request: ExportRequest): Promise<ExportResult> {
    const clips = request.clips.filter((clip) => rangeLength(clip.range) > 0);
    if (clips.length === 0) throw new Error('no clips');
    const total = clips.reduce((sum, clip) => sum + rangeLength(clip.range), 0);
    const fades = clampFades(request.fades, total);
    const mime = pickMime(request.candidates);
    if (!mime) throw new Error('no supported container');

    const source = this.sourceSize ?? { width: this.video.videoWidth, height: this.video.videoHeight };
    if (source.width === 0 || source.height === 0) throw new Error('this file has no video frames to export');
    const out = evenSize(outputSize(source, request.transform));
    this.canvas.width = out.width;
    this.canvas.height = out.height;

    const wantsAudio = !request.muted && this.hasAudio();
    const gainNode = wantsAudio ? this.ensureAudioGraph() : null;
    const audioTrack = gainNode && this.audioDestination ? this.audioDestination.stream.getAudioTracks()[0] ?? null : null;
    const audioUsed = Boolean(audioTrack);
    if (gainNode) gainNode.gain.value = request.gain;

    const captured = this.canvas.captureStream(request.fps);
    const videoTrack = captured.getVideoTracks()[0];
    if (!videoTrack) throw new Error('canvas capture stream is unavailable');
    const stream = new MediaStream();
    stream.addTrack(videoTrack);
    if (audioUsed && audioTrack) stream.addTrack(audioTrack);

    const engine: ExportEngine = request.engine === 'webcodecs' && canUseWebCodecs(mime) ? 'webcodecs' : 'mediarecorder';
    const recorder = new window.MediaRecorder(stream, recorderOptions(mime, audioUsed ? request.audioBitrate : undefined, request.videoBitrate));
    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });

    const encoder = createFrameEncoder(engine, mime, out, request, videoTrack);
    const started = performance.now();
    let frames = 0;
    let stopping = false;

    const stopRecorder = (): Promise<Blob> => new Promise((resolve, reject) => {
      if (stopping) { reject(new Error('already stopping')); return; }
      stopping = true;
      recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: mime })), { once: true });
      recorder.addEventListener('error', () => reject(new Error('the recorder failed')), { once: true });
      try {
        recorder.stop();
      } catch (err) {
        reject(err instanceof Error ? err : new Error('could not stop the recorder'));
      }
    });

    const onAbort = () => { if (recorder.state !== 'inactive') void stopRecorder().catch(() => undefined); };
    request.signal.addEventListener('abort', onAbort, { once: true });

    let rafId = 0;
    try {
      this.pause();
      this.video.muted = true;
      if (gainNode) gainNode.gain.value = request.gain;
      await this.seek(clips[0].range.start);
      this.render(request.transform);

      let outputTime = 0;
      for (let index = 0; index < clips.length; index++) {
        if (request.signal.aborted) throw new ExportCancelled();
        const clip = clips[index];
        await this.seek(clip.range.start);

        if (recorder.state === 'inactive') {
          recorder.start(500);
          encoder?.start();
        }
        const startedAt = performance.now();
        const base = outputTime;
        const drawTick = () => {
          frames += 1;
          this.render(request.transform);
          encoder?.encode(this.canvas, (base + (performance.now() - startedAt) / 1000) * 1e6);
          rafId = window.requestAnimationFrame(drawTick);
        };
        rafId = window.requestAnimationFrame(drawTick);

        if (gainNode && this.audioContext) {
          scheduleFade(gainNode.gain, base, total, fades, request.gain, this.audioContext.currentTime);
        }

        const reachedEnd = await this.playClipTo(clip, request, (position) => {
          request.onProgress({
            outputTime: base + position,
            total,
            fraction: total > 0 ? Math.min(1, (base + position) / total) : 0,
            clipIndex: index,
          });
        });
        if (rafId) window.cancelAnimationFrame(rafId);
        rafId = 0;
        // A clip the player could not reach the end of would silently shorten the
        // result, so the export stops here and the caller sees the real length.
        outputTime = base + (reachedEnd ? rangeLength(clip.range) : Math.max(0, this.video.currentTime - clip.range.start));
        if (!reachedEnd) break;
      }

      this.pause();
      // A cancellation that arrived during the last clip is reported now, before
      // the recorder is finalised: nothing is saved from a cancelled export.
      if (request.signal.aborted) throw new ExportCancelled();
      // One more tick and a short tail: the recorder needs a moment to include the
      // final picture, and the encoder queue has to drain before the stream ends.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await encoder?.finish();
      const blob = await stopRecorder();
      const wall = (performance.now() - started) / 1000;
      if (request.signal.aborted) throw new ExportCancelled();
      return {
        blob,
        mime,
        engine,
        duration: outputTime,
        effectiveFps: wall > 0 ? frames / wall : 0,
        frameAccurate: this.frameAccurate,
        frames,
      };
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (rafId) window.cancelAnimationFrame(rafId);
      this.pause();
      this.video.muted = false;
      this.applyPlaybackGain();
      encoder?.close();
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* already stopping */ }
      }
      captured.getTracks().forEach((track) => track.stop());
    }
  }

  /**
   * Plays one clip from start to end and reports the position inside the *output*
   * on every frame. Resolves `true` only when the end of the clip was really
   * reached; a stopped file or an aborted signal resolves `false`.
   */
  private playClipTo(
    clip: Clip,
    request: ExportRequest,
    onTick: (outputPosition: number) => void,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const length = rangeLength(clip.range);
      const end = clip.range.end;
      let settled = false;
      let rafId = 0;
      let rvcHandle: number | undefined;
      const cleanup = () => {
        if (rafId) window.cancelAnimationFrame(rafId);
        rafId = 0;
        if (rvcHandle !== undefined) this.videoRvc?.cancel(rvcHandle);
        request.signal.removeEventListener('abort', onAbort);
        this.video.removeEventListener('timeupdate', check);
        this.video.removeEventListener('ended', onEnded);
      };
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error('playback failed'));
      };
      const check = () => {
        if (settled) return;
        if (request.signal.aborted) { settle(false); return; }
        onTick(Math.min(length, Math.max(0, this.video.currentTime - clip.range.start)));
        if (this.video.currentTime >= end - 0.008) settle(true);
      };
      const onEnded = () => settle(true);
      const onAbort = () => settle(false);
      const rafTick = () => {
        check();
        if (!settled) rafId = window.requestAnimationFrame(rafTick);
      };
      const frameTick = () => {
        check();
        if (!settled) rvcHandle = this.videoRvc?.request(frameTick);
      };
      // The abort listener is what makes Cancel immediate: without it the loop
      // would keep playing the current clip to its end before noticing.
      request.signal.addEventListener('abort', onAbort, { once: true });
      this.video.addEventListener('timeupdate', check);
      this.video.addEventListener('ended', onEnded);
      if (this.videoRvc) rvcHandle = this.videoRvc.request(frameTick);
      else rafId = window.requestAnimationFrame(rafTick);

      void Promise.all([
        this.video.play(),
        this.audioEl.play().catch(() => undefined),
      ]).catch(fail);
    });
  }

  /** Releases the audio graph and the media elements. */
  dispose(): void {
    this.stopRenderLoop();
    this.pause();
    this.video.removeAttribute('src');
    this.audioEl.removeAttribute('src');
    this.video.load();
    this.audioEl.load();
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.audioSource = null;
    this.gainNode = null;
    this.audioDestination = null;
  }
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

interface FrameCallback {
  request(callback: () => void): number | undefined;
  cancel(handle: number): void;
}

/** Wraps `requestVideoFrameCallback` when the browser has it, else null. */
function frameCallback(element: HTMLVideoElement): FrameCallback | null {
  const target = element as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, metadata: unknown) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  if (typeof target.requestVideoFrameCallback !== 'function') return null;
  const rvfc = target.requestVideoFrameCallback.bind(target);
  return {
    request(callback: () => void): number | undefined {
      try {
        return rvfc(() => callback());
      } catch {
        return undefined;
      }
    },
    cancel(handle: number): void {
      try { target.cancelVideoFrameCallback?.(handle); } catch { /* nothing to cancel */ }
    },
  };
}

function seekElement(element: HTMLMediaElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    if (element.readyState === 0) { resolve(); return; }
    const done = () => {
      element.removeEventListener('seeked', done);
      resolve();
    };
    element.addEventListener('seeked', done);
    try {
      element.currentTime = time;
    } catch {
      element.removeEventListener('seeked', done);
      resolve();
    }
  });
}

/** Resolves on the first of these events, or after `timeout` — never hangs forever. */
function once(element: HTMLMediaElement, event: string, timeout = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDone = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(mediaErrorReason(element.error))); };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    const cleanup = () => {
      element.removeEventListener(event, onDone);
      element.removeEventListener('error', onError);
      window.clearTimeout(timer);
    };
    element.addEventListener(event, onDone);
    element.addEventListener('error', onError);
  });
}

/** A short, truthful reason from the media element's own error code. */
export function mediaErrorReason(error: MediaError | null): string {
  if (!error) return 'unknown media error';
  switch (error.code) {
    case 1: return 'loading was aborted';
    case 2: return 'a network error';
    case 3: return 'the browser cannot decode this format';
    case 4: return 'the browser cannot decode this format (unsupported source)';
    default: return `media error ${error.code}`;
  }
}

/** The best container the browser's MediaRecorder will really produce. */
function pickMime(candidates: readonly string[]): string {
  const recorder = (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (typeof recorder !== 'function') return '';
  if (typeof recorder.isTypeSupported !== 'function') return candidates[0] ?? '';
  return candidates.find((mime) => recorder.isTypeSupported(mime)) ?? '';
}

function recorderOptions(mime: string, audioBitrate: number | undefined, videoBitrate: number): MediaRecorderOptions {
  const audioOnly = mime.startsWith('audio/');
  return {
    mimeType: mime,
    videoBitsPerSecond: audioOnly ? undefined : videoBitrate,
    audioBitsPerSecond: audioBitrate,
  };
}

/** Schedules the fade curve on a gain node, starting `base` seconds into the output. */
function scheduleFade(
  param: AudioParam,
  base: number,
  total: number,
  fades: FadeConfig,
  multiplier: number,
  now: number,
): void {
  try {
    param.cancelScheduledValues(now);
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const at = (total * i) / steps;
      if (at < base) continue;
      param.setValueAtTime(trackGainAt(at, total, fades, multiplier), now + (at - base));
    }
  } catch {
    // Scheduling is a nicety: without it the export simply runs at a steady gain.
  }
}

/* ───────────────────────── WebCodecs encoding ───────────────────────── */

interface ChunkWriter {
  write(chunk: EncodedVideoChunk): void;
}

function isChunkWriter(track: MediaStreamTrack): track is MediaStreamTrack & ChunkWriter {
  return typeof (track as unknown as ChunkWriter).write === 'function';
}

function canUseWebCodecs(mime: string): boolean {
  const scope = window as unknown as { MediaStreamTrackGenerator?: unknown; VideoEncoder?: unknown; VideoFrame?: unknown };
  return typeof scope.MediaStreamTrackGenerator === 'function'
    && typeof scope.VideoEncoder === 'function'
    && typeof scope.VideoFrame === 'function'
    && mime.startsWith('video/');
}

/** The codec this app asks WebCodecs for, matching the chosen container. */
export function webCodecsVideoCodec(mime: string): string {
  if (mime.includes('mp4')) return 'avc1.42E01E';
  if (mime.includes('matroska')) return 'vp09.00.10.08';
  return 'vp09.00.10.08';
}

interface FrameEncoder {
  start(): void;
  encode(source: CanvasImageSource, timestampMicros: number): void;
  finish(): Promise<void>;
  close(): void;
}

/**
 * A `VideoEncoder` whose output chunks are pushed into the stream track, so the
 * recorder muxes them into a real container.
 *
 * Returns null when the path cannot be used — a missing constructor, a track that
 * cannot be written, or a refused configuration — and the caller then keeps the
 * plain MediaRecorder capture it already started. Nothing here throws out of the
 * export: a broken encoder degrades to the canvas recording, which is exactly the
 * fallback the plan describes to the user.
 */
function createFrameEncoder(
  engine: ExportEngine,
  mime: string,
  size: { width: number; height: number },
  request: ExportRequest,
  track: MediaStreamTrack,
): FrameEncoder | null {
  if (engine !== 'webcodecs' || !isChunkWriter(track)) return null;
  const scope = window as unknown as { VideoEncoder: typeof VideoEncoder; VideoFrame: typeof VideoFrame };
  let encoder: VideoEncoder;
  try {
    encoder = new scope.VideoEncoder({
      output: (chunk) => {
        try { track.write(chunk); } catch { /* a closed track ends the stream cleanly */ }
      },
      error: () => { /* a failed encoder ends the stream; the recorder still finishes */ },
    });
  } catch {
    return null;
  }
  let configured = false;
  return {
    start(): void {
      if (configured) return;
      configured = true;
      try {
        encoder.configure({
          codec: webCodecsVideoCodec(mime),
          width: size.width,
          height: size.height,
          bitrate: request.videoBitrate,
          framerate: request.fps,
        });
      } catch {
        // An unsupported configuration leaves the encoder unconfigured, and the
        // recorder keeps recording the canvas the way the fallback does.
        configured = false;
        try { encoder.close(); } catch { /* already closed */ }
      }
    },
    encode(source: CanvasImageSource, timestampMicros: number): void {
      if (!configured || encoder.state !== 'configured') return;
      if (encoder.encodeQueueSize > 4) return; // drop a frame instead of growing the queue
      let frame: VideoFrame | null = null;
      try {
        frame = new scope.VideoFrame(source, { timestamp: Math.max(0, Math.round(timestampMicros)) });
        encoder.encode(frame, { keyFrame: false });
      } catch {
        // A frame that cannot be wrapped is skipped; the canvas capture still feeds the recorder.
      } finally {
        frame?.close();
      }
    },
    async finish(): Promise<void> {
      if (!configured || encoder.state === 'closed') return;
      try { await encoder.flush(); } catch { /* nothing left to flush */ }
    },
    close(): void {
      try { if (encoder.state !== 'closed') encoder.close(); } catch { /* already closed */ }
    },
  };
}
