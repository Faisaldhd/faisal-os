/**
 * The exporter: records the timeline into a video file.
 *
 * HOW: a private `TimelineRenderer` plays the project in real time on an
 * off-screen canvas at the export size; `canvas.captureStream(fps)` plus the
 * mixer's MediaStream audio track go into `MediaRecorder`. It is the same
 * compositor and mixer the preview uses, so the file matches the preview.
 *
 * HONEST LIMITS
 *  • Real time: a 30 s film takes about 30 s to export.
 *  • A hidden tab throttles timers; the export keeps going on timers but may
 *    drop frames.
 *  • MediaRecorder WebM carries no duration; it is written afterwards
 *    (`../webm.ts`). Chromium's MP4 is fragmented and players read its length
 *    from the fragments.
 *  • Cancel stops everything and rejects with `ExportCancelled`: no Blob is
 *    ever built, so nothing can be written.
 */
import { ExportCancelled, type EngineMedia, type VideoExportOptions, type VideoExportResult } from '../engine-port';
import { exportDimensions, projectDuration, videoBitrate, type Project, type QualityKey, type ResolutionKey } from '../project';
import { fixWebmDuration } from '../webm';
import { MediaPool, nextFrame, seekAccurate, waitFor } from './media-pool';
import { lastFrameTime, TimelineRenderer } from './player';
import type { Size } from './layout';

/* ─────────────────────────────── pure planning ─────────────────────────────── */

/** MP4 candidates, best first: H.264 High (1080p-capable), Main, Baseline, then bare. */
export const MP4_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.4d0028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
];

/** WebM candidates, best first. */
export const WEBM_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export type ContainerChoice = 'auto' | 'mp4' | 'webm';

export interface MimeChoice {
  mime: string;
  container: 'mp4' | 'webm';
  extension: '.mp4' | '.webm';
  /** True when the user asked for a container the browser cannot record. */
  fellBack: boolean;
}

/**
 * The container MediaRecorder will really produce. `auto` prefers MP4 (plays
 * everywhere) and falls back to WebM; an explicit choice the browser cannot
 * record falls back too, and says so (`fellBack`). Null when nothing records.
 */
export function chooseMime(isTypeSupported: ((mime: string) => boolean) | undefined, choice: ContainerChoice = 'auto'): MimeChoice | null {
  const supported = (mime: string) => {
    try { return Boolean(isTypeSupported?.(mime)); } catch { return false; }
  };
  const order: Array<'mp4' | 'webm'> = choice === 'webm' ? ['webm', 'mp4'] : ['mp4', 'webm'];
  for (const container of order) {
    const mime = (container === 'mp4' ? MP4_CANDIDATES : WEBM_CANDIDATES).find(supported);
    if (mime) {
      return { mime, container, extension: container === 'mp4' ? '.mp4' : '.webm', fellBack: choice !== 'auto' && choice !== container };
    }
  }
  return null;
}

/** The browser's own answer, for `chooseMime` (false when MediaRecorder is missing). */
export function browserRecorderSupports(mime: string): boolean {
  const R = (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  return typeof R === 'function' && typeof R.isTypeSupported === 'function' && R.isTypeSupported(mime);
}

export const AUDIO_BITRATE: Record<QualityKey, number> = { high: 192_000, medium: 128_000, low: 96_000 };

/** Everything `exportVideo` needs, from the project frame and three choices. */
export function exportSettings(
  frame: Size,
  choice: { resolution: ResolutionKey; fps: number; quality: QualityKey; container?: ContainerChoice },
  isTypeSupported: ((mime: string) => boolean) | undefined = browserRecorderSupports,
): { width: number; height: number; fps: number; mime: string; extension: string; videoBitrate: number; audioBitrate: number; fellBack: boolean } | null {
  const mime = chooseMime(isTypeSupported, choice.container ?? 'auto');
  if (!mime) return null;
  const fps = Math.min(60, Math.max(1, Math.round(Number.isFinite(choice.fps) ? choice.fps : 30)));
  const size = exportDimensions(frame, choice.resolution);
  return {
    ...size,
    fps,
    mime: mime.mime,
    extension: mime.extension,
    videoBitrate: videoBitrate(size, fps, choice.quality),
    audioBitrate: AUDIO_BITRATE[choice.quality] ?? AUDIO_BITRATE.medium,
    fellBack: mime.fellBack,
  };
}

/** The timeline range an export covers, clamped to the film. */
export function exportRange(duration: number, range?: { start: number; end: number }): { start: number; end: number } {
  const d = Math.max(0, Number.isFinite(duration) ? duration : 0);
  if (!range) return { start: 0, end: d };
  const start = Math.min(Math.max(0, Number.isFinite(range.start) ? range.start : 0), d);
  const end = Math.min(Math.max(start, Number.isFinite(range.end) ? range.end : d), d);
  return { start, end };
}

/** Times for `count` thumbnails: the middle of each equal slice of the file. */
export function filmstripTimes(duration: number, count: number): number[] {
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  if (!(duration > 0) || n === 0) return [];
  return Array.from({ length: n }, (_, i) => Math.min(duration - 1e-3, ((i + 0.5) * duration) / n));
}

/* ─────────────────────────────── recording ─────────────────────────────── */

/**
 * Records `project` and resolves with the file. `lookup` is the UI's media
 * library; the export has its own elements, so the preview is left alone.
 */
export async function recordProject(
  project: Project,
  frame: Size,
  lookup: (id: string) => EngineMedia | undefined,
  options: VideoExportOptions,
): Promise<VideoExportResult> {
  const signal = options.signal;
  if (signal.aborted) throw new ExportCancelled();
  const range = exportRange(projectDuration(project), options.range);
  const duration = range.end - range.start;
  if (!(duration > 0)) throw new Error('the timeline is empty');
  const Recorder = (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (typeof Recorder !== 'function') throw new Error('this browser cannot record video (no MediaRecorder)');
  const fps = Math.min(60, Math.max(1, Math.round(options.fps || 30)));
  const width = Math.max(2, Math.round(options.width / 2) * 2);
  const height = Math.max(2, Math.round(options.height / 2) * 2);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const pool = new MediaPool();
  pool.setLookup(lookup);
  const renderer = new TimelineRenderer({ canvas, pool, output: 'stream', background: true });
  renderer.setProject(project, frame);
  renderer.stopAt = range.end;

  const captured = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(fps);
  const stream = new MediaStream();
  for (const track of captured.getVideoTracks()) stream.addTrack(track);
  // A codec list that names only a video codec (e.g. `codecs=vp9`) cannot carry sound.
  const codecs = /codecs=([^;]*)/.exec(options.mime)?.[1] ?? '';
  const wantsAudio = options.audioBitrate > 0 && (!codecs || /opus|mp4a|vorbis|aac/i.test(codecs));
  const audioTrack = wantsAudio ? renderer.mixer.streamTrack() : null;
  if (audioTrack) stream.addTrack(audioTrack);

  const cleanup = () => {
    renderer.dispose();
    captured.getTracks().forEach((t) => t.stop());
  };

  let recorder: MediaRecorder;
  try {
    recorder = new Recorder(stream, {
      mimeType: options.mime,
      videoBitsPerSecond: options.videoBitrate,
      audioBitsPerSecond: audioTrack ? options.audioBitrate : undefined,
    });
  } catch {
    cleanup();
    throw new Error(`the recorder refused ${options.mime}`);
  }
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });

  let cancelled = false;
  let finish: () => void = () => undefined;
  let fail: (err: Error) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  done.catch(() => undefined); // awaited below; this only keeps an early cancel from being "unhandled"
  const onAbort = () => {
    cancelled = true;
    renderer.pause();
    fail(new ExportCancelled());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  recorder.addEventListener('error', () => fail(new Error('the recorder failed')));

  const started = performance.now();
  const elapsed = () => (performance.now() - started) / 1000;
  renderer.onTick = (t) => {
    options.onProgress(Math.min(1, Math.max(0, (t - range.start) / duration)), elapsed());
  };
  renderer.onEnded = () => finish();

  const stopRecorder = (): Promise<void> => new Promise((resolve) => {
    if (recorder.state === 'inactive') { resolve(); return; }
    recorder.addEventListener('stop', () => resolve(), { once: true });
    try { recorder.stop(); } catch { resolve(); }
  });

  try {
    // Park every first frame before the recorder starts, so frame one is real.
    await renderer.seek(range.start);
    if (cancelled) throw new ExportCancelled();
    recorder.start(1000);
    await renderer.play(range.start);
    await done;
    // The canvas stream needs one more frame to carry the final picture.
    renderer.draw(lastFrameTime(range.end));
    await new Promise((r) => setTimeout(r, Math.max(120, 2000 / fps)));
    if (cancelled) throw new ExportCancelled();
    await stopRecorder();
    if (cancelled) throw new ExportCancelled();
    const type = options.mime.split(';')[0];
    let blob = new Blob(chunks, { type });
    if (type === 'video/webm') {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const fixed = fixWebmDuration(bytes, duration);
      if (fixed !== bytes) blob = new Blob([fixed as BlobPart], { type });
    }
    options.onProgress(1, elapsed());
    return { blob, mime: options.mime, duration, frames: renderer.framesDrawn };
  } catch (err) {
    if (cancelled || err instanceof ExportCancelled) throw new ExportCancelled();
    throw err instanceof Error ? err : new Error('the export failed');
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* already stopping */ }
    }
    if (cancelled) chunks.length = 0;
    cleanup();
  }
}

/* ─────────────────────────────── thumbnails ─────────────────────────────── */

/**
 * `count` thumbnails across a video element, `height` pixels tall. The element
 * is seeked and put back where it was. Bounded: a frame that will not decode
 * within the timeout is skipped rather than hanging the timeline.
 */
export async function filmstrip(video: HTMLVideoElement, count: number, height = 72, signal?: AbortSignal): Promise<ImageBitmap[]> {
  if (video.readyState === 0) await waitFor(video, 'loadedmetadata', 5000);
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const times = filmstripTimes(duration, count);
  const back = video.currentTime;
  const wasPaused = video.paused;
  if (!wasPaused) video.pause();
  const out: ImageBitmap[] = [];
  const h = Math.max(8, Math.round(height));
  const w = video.videoHeight > 0 ? Math.max(8, Math.round((video.videoWidth / video.videoHeight) * h)) : h;
  try {
    for (const t of times) {
      if (signal?.aborted) break;
      await seekAccurate(video, t, 2000);
      if (video.readyState < 2) continue;
      try {
        out.push(await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' }));
      } catch { /* a frame that cannot be copied is skipped */ }
    }
  } finally {
    await seekAccurate(video, back, 2000);
    await nextFrame(video, 50);
    if (!wasPaused) void video.play().catch(() => undefined);
  }
  return out;
}
