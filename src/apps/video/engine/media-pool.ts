/**
 * Media elements for the engine (DOM).
 *
 * One element per *clip* (not per file): two clips cut from the same file can
 * be on screen together during a crossfade, each at its own position. Images
 * come already decoded from the UI's media library (`EngineMedia.image`).
 *
 * Seeking is frame-accurate where the browser allows it: after `seeked`, the
 * pool waits for `requestVideoFrameCallback` so the picture drawn is the frame
 * that was asked for, not the one before it. Every wait is bounded by a
 * timeout, so a broken file can never hang the preview or the export.
 */
import type { EngineMedia } from '../engine-port';
import type { MediaClip } from '../project';
import { perfMark } from '../perf';
import type { FrameImage, FrameProvider } from './compositor';

type RvfcElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** Resolves true on `event`, false on error or after `ms` — whichever first. Never rejects. */
export function waitFor(target: EventTarget, event: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
      clearTimeout(timer);
      resolve(ok);
    };
    const onEvent = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), ms);
    target.addEventListener(event, onEvent);
    target.addEventListener('error', onError);
  });
}

/** Waits for the next presented video frame, when the browser can say so (bounded). */
export function nextFrame(video: HTMLVideoElement, ms = 150): Promise<void> {
  const el = video as RvfcElement;
  if (typeof el.requestVideoFrameCallback !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let handle = 0;
    const timer = setTimeout(() => {
      try { el.cancelVideoFrameCallback?.(handle); } catch { /* nothing to cancel */ }
      resolve();
    }, ms);
    try {
      handle = el.requestVideoFrameCallback!(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * Moves an element to `time` and resolves when that frame can be drawn (bounded).
 * When another seek on the same element is still running, it keeps waiting
 * until the element settles (or the time budget runs out).
 * `waitFrame: false` skips waiting for the frame to be *presented* (an
 * off-screen element may never present one); after `seeked` the decoded frame
 * is already drawable, which is all the frame-by-frame export needs.
 */
export async function seekAccurate(el: HTMLMediaElement, time: number, ms = 2000, waitFrame = true): Promise<void> {
  const deadline = Date.now() + ms;
  const left = () => Math.max(10, deadline - Date.now());
  if (el.readyState === 0) await waitFor(el, 'loadedmetadata', ms);
  const target = Math.max(0, Math.min(time, Number.isFinite(el.duration) && el.duration > 0 ? el.duration - 1e-3 : time));
  if (Math.abs(el.currentTime - target) < 1e-3 && el.readyState >= 2 && !el.seeking) return;
  const isVideo = typeof HTMLVideoElement !== 'undefined' && el instanceof HTMLVideoElement;
  const frame = isVideo && waitFrame ? nextFrame(el as HTMLVideoElement, ms) : Promise.resolve();
  const seeked = waitFor(el, 'seeked', ms);
  try {
    el.currentTime = target;
  } catch {
    return;
  }
  await seeked;
  for (let guard = 0; guard < 4 && el.seeking && Date.now() < deadline; guard++) await waitFor(el, 'seeked', left());
  if (el.readyState < 2) await waitFor(el, 'loadeddata', Math.min(500, left()));
  if (waitFrame) await Promise.race([frame, new Promise((r) => setTimeout(r, Math.min(200, left())))]);
}

interface Entry {
  el: HTMLMediaElement;
  mediaId: string;
  url: string;
}

/**
 * Elements for the clips on screen or about to be. Media comes from the UI's
 * library through `lookup` (object URL, decoded image, size); an id the lookup
 * does not know, or one with no URL and no image, is *offline* and draws a
 * placeholder instead of crashing.
 */
export class MediaPool implements FrameProvider {
  private readonly entries = new Map<string, Entry>();
  private lookup: (id: string) => EngineMedia | undefined = () => undefined;

  /** Called with an element that is about to be dropped (the mixer disconnects it). */
  onRelease: ((el: HTMLMediaElement) => void) | null = null;

  setLookup(lookup: (id: string) => EngineMedia | undefined): void {
    this.lookup = lookup;
  }

  getLookup(): (id: string) => EngineMedia | undefined {
    return this.lookup;
  }

  media(mediaId: string): EngineMedia | undefined {
    return this.lookup(mediaId);
  }

  /** The element for a video/audio clip, created on first use; null for offline media or images. */
  element(clip: MediaClip): HTMLMediaElement | null {
    if (clip.type === 'image') return null;
    const media = this.lookup(clip.mediaId);
    const existing = this.entries.get(clip.id);
    if (existing && media && existing.mediaId === clip.mediaId && existing.url === media.url) return existing.el;
    if (existing) this.drop(clip.id);
    if (!media || !media.url) return null;
    const el = clip.type === 'video' ? document.createElement('video') : document.createElement('audio');
    el.preload = 'auto';
    el.muted = true;
    if (el instanceof HTMLVideoElement) el.playsInline = true;
    (el as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = true;
    el.src = media.url;
    // The playback element the engine will actually draw from: this is the "sync" side of
    // readiness, and it happens after the pool has finished its own probing element.
    perfMark('engine:element', clip.type);
    el.addEventListener('canplay', () => perfMark('engine:canplay', `rs=${el.readyState}`), { once: true });
    this.entries.set(clip.id, { el, mediaId: clip.mediaId, url: media.url });
    return el;
  }

  /** The drawable picture of a clip right now, or null when it has none yet. */
  frameFor(clip: MediaClip): FrameImage | null {
    if (clip.type === 'image') {
      const img = this.lookup(clip.mediaId)?.image;
      return img && img.naturalWidth > 0 ? { image: img, width: img.naturalWidth, height: img.naturalHeight } : null;
    }
    if (clip.type !== 'video') return null;
    const el = this.entries.get(clip.id)?.el as HTMLVideoElement | undefined;
    if (!el || el.readyState < 2 || !el.videoWidth) return null;
    return { image: el, width: el.videoWidth, height: el.videoHeight };
  }

  /** Size and state for a clip with no picture: offline media gets a labelled placeholder. */
  missing(clip: MediaClip): { width: number; height: number; offline: boolean } | null {
    const media = this.lookup(clip.mediaId);
    const offline = !media || (!media.url && !media.image);
    const width = media && media.width > 0 ? media.width : 16;
    const height = media && media.height > 0 ? media.height : 9;
    return offline ? { width, height, offline } : null;
  }

  /** Pauses and drops every element whose clip is not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    for (const clipId of [...this.entries.keys()]) if (!keep.has(clipId)) this.drop(clipId);
  }

  pauseAll(): void {
    for (const entry of this.entries.values()) if (!entry.el.paused) entry.el.pause();
  }

  elements(): HTMLMediaElement[] {
    return [...this.entries.values()].map((e) => e.el);
  }

  private drop(clipId: string): void {
    const entry = this.entries.get(clipId);
    if (!entry) return;
    this.entries.delete(clipId);
    this.onRelease?.(entry.el);
    try {
      entry.el.pause();
      entry.el.removeAttribute('src');
      entry.el.load();
    } catch { /* already released */ }
  }

  dispose(): void {
    for (const clipId of [...this.entries.keys()]) this.drop(clipId);
  }
}
