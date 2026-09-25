/**
 * Real MP4 export (WebCodecs + mp4-muxer).
 *
 * HOW
 *  • Sound: the project mix is rendered offline (`renderMixOffline`, the same
 *    one the WAV export uses) and fed to `AudioEncoder` in blocks.
 *  • Picture: a private `TimelineRenderer` steps through the film frame by
 *    frame on the same timeline clock — each frame waits until every element
 *    sits on its exact source frame (`renderAt`), then the canvas becomes a
 *    `VideoFrame` for `VideoEncoder`. No real-time playback is involved, so it
 *    runs as fast as frames decode and compose (usually faster than real time)
 *    and never drops a frame, even in a hidden tab.
 *  • `mp4-muxer` (loaded only here, on export) writes a fast-start MP4.
 *
 * Cancel: every step checks the signal; encoders are closed, the muxer is never
 * finalised and no Blob is built, so nothing can be written.
 */
import { ExportCancelled, type EngineMedia, type VideoExportOptions, type VideoExportResult } from '../engine-port';
import { projectDuration, type Project } from '../project';
import { audibleClips, decodeBytes, decodeUrl, renderMixOffline } from './audio-mix';
import { exportRange } from './exporter';
import { MediaPool } from './media-pool';
import { audioBlocks, frameCount, frameTiming, isKeyFrame, muxerOptions, pickMp4Plan, type Mp4Plan, type Mp4Probe, type Mp4Request } from './mp4-plan';
import { TimelineRenderer } from './player';
import type { Size } from './layout';

/** True when this browser exposes the WebCodecs encoders at all. */
export function hasWebCodecs(): boolean {
  const g = globalThis as unknown as { VideoEncoder?: unknown; VideoFrame?: unknown };
  return typeof g.VideoEncoder === 'function' && typeof g.VideoFrame === 'function';
}

/** `isConfigSupported` as a yes/no probe for `pickMp4Plan`. */
export const browserMp4Probe: Mp4Probe = {
  async video(config) {
    if (!hasWebCodecs()) return false;
    try { return Boolean((await VideoEncoder.isConfigSupported(config as VideoEncoderConfig)).supported); } catch { return false; }
  },
  async audio(config) {
    if (typeof (globalThis as { AudioEncoder?: unknown }).AudioEncoder !== 'function') return false;
    try { return Boolean((await AudioEncoder.isConfigSupported(config as AudioEncoderConfig)).supported); } catch { return false; }
  },
};

/** The MP4 plan for this project, or null (then MediaRecorder records instead). */
export function planMp4(project: Project, req: Omit<Mp4Request, 'wantsAudio'>, probe: Mp4Probe = browserMp4Probe): Promise<Mp4Plan | null> {
  return pickMp4Plan(probe, { ...req, wantsAudio: req.audioBitrate > 0 && audibleClips(project).length > 0 });
}

/** Waits until the encoder's queue is short, so memory stays bounded (bounded wait). */
function drain(encoder: VideoEncoder | AudioEncoder, max: number): Promise<void> {
  if (encoder.encodeQueueSize <= max) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); encoder.removeEventListener('dequeue', check); resolve(); };
    const check = () => { if (encoder.encodeQueueSize <= max) done(); };
    const timer = setTimeout(done, 1000);
    encoder.addEventListener('dequeue', check);
  });
}

export async function encodeProjectMp4(
  project: Project,
  frame: Size,
  lookup: (id: string) => EngineMedia | undefined,
  plan: Mp4Plan,
  options: VideoExportOptions,
): Promise<VideoExportResult> {
  const signal = options.signal;
  const check = () => { if (signal.aborted) throw new ExportCancelled(); };
  check();
  const range = exportRange(projectDuration(project), options.range);
  const duration = range.end - range.start;
  if (!(duration > 0)) throw new Error('the timeline is empty');
  const started = performance.now();
  const elapsed = () => (performance.now() - started) / 1000;
  const audioShare = plan.audio ? 0.1 : 0;

  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  check();
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, ...muxerOptions(plan) });
  let failure: Error | null = null;
  const fail = (e: unknown) => { failure ??= e instanceof Error ? e : new Error(String(e)); };
  const video = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
  video.configure(plan.video as VideoEncoderConfig);
  let audio: AudioEncoder | null = null;

  const canvas = document.createElement('canvas');
  canvas.width = plan.video.width;
  canvas.height = plan.video.height;
  const pool = new MediaPool();
  pool.setLookup(lookup);
  const renderer = new TimelineRenderer({ canvas, pool, output: 'stream', background: true });
  renderer.setProject(project, frame);
  const guard = () => { check(); if (failure) throw failure; };

  try {
    /* ── sound (offline, exact) ── */
    if (plan.audio) {
      const decode = async (id: string) => {
        const media = lookup(id);
        if (!media) return null;
        if (media.bytes) return decodeBytes(media.bytes);
        return media.url ? decodeUrl(media.url) : null;
      };
      const mix = await renderMixOffline(project, projectDuration(project), decode, {
        range, sampleRate: plan.audio.sampleRate, channels: plan.audio.numberOfChannels, signal,
        onProgress: (f) => options.onProgress(f * audioShare, elapsed()),
      });
      guard();
      audio = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail });
      audio.configure(plan.audio as AudioEncoderConfig);
      const buf = mix.buffer;
      const channels = Array.from({ length: plan.audio.numberOfChannels }, (_, c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
      for (const block of audioBlocks(buf.length)) {
        guard();
        const planar = new Float32Array(block.frames * channels.length);
        channels.forEach((ch, c) => planar.set(ch.subarray(block.start, block.start + block.frames), c * block.frames));
        const data = new AudioData({
          format: 'f32-planar', sampleRate: buf.sampleRate, numberOfFrames: block.frames,
          numberOfChannels: channels.length, timestamp: Math.round((block.start * 1e6) / buf.sampleRate), data: planar,
        });
        audio.encode(data);
        data.close();
        await drain(audio, 16);
      }
    }

    /* ── picture, frame by frame on the timeline clock ── */
    const fps = plan.fps;
    const total = frameCount(duration, fps);
    for (let i = 0; i < total; i++) {
      guard();
      await renderer.renderAt(Math.min(range.start + i / fps, range.end - 1e-3));
      guard();
      const timing = frameTiming(i, fps);
      const vf = new VideoFrame(canvas, { timestamp: timing.timestamp, duration: timing.duration });
      try { video.encode(vf, { keyFrame: isKeyFrame(i, fps) }); } finally { vf.close(); }
      await drain(video, 4);
      options.onProgress(audioShare + (1 - audioShare) * ((i + 1) / total) * 0.98, elapsed());
    }
    guard();
    await video.flush();
    if (audio) await audio.flush();
    guard();
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    options.onProgress(1, elapsed());
    return { blob, mime: 'video/mp4', duration, frames: total };
  } catch (err) {
    if (signal.aborted || err instanceof ExportCancelled) throw new ExportCancelled();
    throw err instanceof Error ? err : new Error('the export failed');
  } finally {
    for (const enc of [video, audio]) {
      if (enc && enc.state !== 'closed') { try { enc.close(); } catch { /* already closed */ } }
    }
    renderer.dispose();
  }
}
