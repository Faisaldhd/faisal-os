/**
 * The media pool: every file the project can use, with what the browser really
 * knows about it (duration, size, audio), thumbnails for the pool and the
 * timeline filmstrips, and waveform peaks for audio.
 *
 * Nothing is assumed: a format the browser refuses is kept in the pool as an
 * error that names the extension (the capability rule of this app), and a file
 * that is missing when a project opens is kept "offline" so it can be relinked.
 */
import type { VFS } from '../../kernel/types';
import { basename } from '../../kernel/path';
import { extensionOf } from '../viewer/formats';
import { formatForPath, refusalFor, type CapabilityProbe } from './capabilities';
import { perfBegin, perfMark, perfSpan } from './perf';
import { computePeaks } from './render-math';
import type { MediaType } from './project';
import type { MediaRef } from './project-file';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'];

export type MediaStatus = 'loading' | 'ready' | 'offline' | 'error';

export interface MediaItem {
  id: string;
  name: string;
  path: string | null;
  type: MediaType;
  status: MediaStatus;
  /** Why it is not usable, already localised by the caller's `describe`. */
  error: string;
  url: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  size: number;
  /** Filmstrip frames, evenly spaced over the duration. */
  thumbs: HTMLCanvasElement[];
  image: HTMLImageElement | null;
  peaks: Float32Array | null;
  /** The raw bytes, kept (when small enough) for the offline audio render. */
  bytes: Uint8Array | null;
  /** The decoder refused the codec (HEVC, mp4v…): offer "Convert". */
  convertible?: boolean;
}

const THUMB_COUNT = 12;
const THUMB_HEIGHT = 72;
/** Above this, audio is not decoded for waveforms (it would hold the whole file twice). */
const DECODE_LIMIT = 120 * 1024 * 1024;

/**
 * Where the filmstrip frames are taken from: `count` samples evenly spread over the file, each
 * pulled back a hair from the very end so the last seek lands inside the media (a seek to the
 * exact duration can leave the element with no decodable frame). Pure, because the loop that
 * used to hold this arithmetic is the expensive part of opening a video.
 */
export function thumbnailTimes(duration: number, count: number = THUMB_COUNT): number[] {
  const n = Math.max(1, Math.floor(count));
  if (!(duration > 0)) return [0];
  return Array.from({ length: n }, (_, i) =>
    Math.max(0, Math.min(duration - 0.05, (duration * (i + 0.5)) / n)));
}

let seq = 0;
const newMediaId = () => `m${Date.now().toString(36)}${(++seq).toString(36)}`;

export function mediaTypeFor(name: string): MediaType | null {
  const ext = extensionOf(name).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  const format = formatForPath(name);
  if (format) return format.kind;
  return null;
}

function mimeFor(name: string, type: MediaType): string {
  const ext = extensionOf(name).toLowerCase();
  if (type === 'image') {
    const map: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' };
    return map[ext] ?? 'application/octet-stream';
  }
  // Most .mov files are H.264/AAC in a QuickTime box, which browsers decode as MP4.
  if (ext === '.mov') return 'video/mp4';
  const format = formatForPath(name);
  return format ? format.mime.split(';')[0].trim() : 'application/octet-stream';
}

function waitFor(target: EventTarget, events: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);
    const handlers = events.map((name) => {
      const h = () => { cleanup(); if (name === 'error') reject(new Error('error')); else resolve(name); };
      target.addEventListener(name, h);
      return [name, h] as const;
    });
    const cleanup = () => {
      window.clearTimeout(timer);
      for (const [name, h] of handlers) target.removeEventListener(name, h);
    };
  });
}

/**
 * The real duration. A WebM written by a live recorder reports Infinity until
 * the browser has read to the end, so the element is asked to seek far past the
 * end once, which makes it compute the length, and then brought back.
 */
async function realDuration(video: HTMLMediaElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  try {
    const found = waitFor(video, ['durationchange', 'timeupdate', 'seeked'], 4000);
    video.currentTime = 1e101;
    await found;
    for (let i = 0; i < 20 && !Number.isFinite(video.duration); i++) await new Promise((r) => setTimeout(r, 50));
  } catch {
    /* keep whatever the element knows */
  }
  const d = video.duration;
  try { video.currentTime = 0; } catch { /* ignore */ }
  return Number.isFinite(d) && d > 0 ? d : 0;
}

async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) return;
  const done = waitFor(video, ['seeked'], 3000).catch(() => 'timeout');
  video.currentTime = time;
  await done;
}

function frameCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const h = THUMB_HEIGHT;
  const w = Math.max(1, Math.round((width / Math.max(1, height)) * h));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  try {
    ctx?.drawImage(source, 0, 0, w, h);
  } catch {
    /* an undecodable frame stays blank */
  }
  return canvas;
}

async function decodePeaks(bytes: Uint8Array, duration: number): Promise<Float32Array | null> {
  const Offline = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Offline) return null;
  const done = perfSpan('waveform', `${bytes.length}B`);
  try {
    const ctx = new Offline(1, 1, 44100);
    const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
    if (buffer.length === 0) return null;
    const data = buffer.getChannelData(0);
    const buckets = Math.max(200, Math.min(12000, Math.round((duration || buffer.duration) * 60)));
    return computePeaks(data, buckets);
  } catch {
    return null;
  } finally {
    done();
  }
}

export interface MediaDescribe {
  refused(ext: string): string;
  unreadable(reason: string): string;
  /** The browser opened the file but cannot decode its codec (e.g. HEVC). */
  codec(ext: string, size: number): string;
  empty(): string;
  tooBig(): string;
}

export class MediaLibrary {
  readonly items: MediaItem[] = [];
  private listeners = new Set<() => void>();
  private readonly urls = new Set<string>();
  private disposed = false;
  /** Load attempt per item id: a background filmstrip that lost its token writes nothing. */
  private readonly tokens = new Map<string, number>();

  /**
   * `busy` answers "is the app playing something right now". The background filmstrip waits for
   * it to say no, because seeking a second decoder while the first one is playing is bad for
   * both: measured on the 1080p sample, twelve seeks took 0.75 s idle and 12 s during playback,
   * and the playback element's own prepares went from 69 ms to 1.2 s. Omitted in tests.
   */
  constructor(
    private readonly vfs: VFS,
    private readonly probe: () => CapabilityProbe,
    private readonly describe: MediaDescribe,
    private readonly busy?: () => boolean,
  ) {}

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }

  get(id: string): MediaItem | undefined {
    return this.items.find((m) => m.id === id);
  }

  byPath(path: string): MediaItem | undefined {
    return this.items.find((m) => m.path === path && m.status !== 'error');
  }

  refs(): MediaRef[] {
    return this.items.map((m) => ({ id: m.id, path: m.path, name: m.name, type: m.type, duration: m.duration, width: m.width, height: m.height, hasAudio: m.hasAudio }));
  }

  private blank(name: string, path: string | null, type: MediaType, id = newMediaId()): MediaItem {
    return { id, name, path, type, status: 'loading', error: '', url: '', duration: 0, width: 0, height: 0, hasAudio: false, size: 0, thumbs: [], image: null, peaks: null, bytes: null };
  }

  /** Adds a file from the VFS (or returns the one already in the pool). */
  async addPath(path: string, knownId?: string): Promise<MediaItem> {
    const existing = knownId ? this.get(knownId) : this.byPath(path);
    if (existing && existing.status === 'ready') return existing;
    const name = basename(path);
    const type = mediaTypeFor(name) ?? 'video';
    const item = existing ?? this.blank(name, path, type, knownId);
    if (!existing) this.items.push(item);
    item.path = path;
    item.status = 'loading';
    item.convertible = false;
    this.changed();
    // The session starts where the user's request does: "open this file".
    perfBegin(`open:${name}`);
    try {
      const read = perfSpan('vfs-read');
      const bytes = await this.vfs.readFile(path);
      read(`${bytes.length}B`);
      if (bytes.length === 0) return this.fail(item, this.describe.empty());
      await this.load(item, new Blob([bytes.slice()], { type: mimeFor(name, type) }), bytes);
    } catch (err) {
      const missing = err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT';
      if (missing) {
        item.status = 'offline';
        item.error = '';
        this.changed();
        return item;
      }
      return this.fail(item, this.describe.unreadable(err instanceof Error ? err.message : ''));
    }
    return item;
  }

  /** Adds a file from the computer; `savedPath` is where it was copied in the VFS, if it was. */
  async addFile(file: File, savedPath: string | null): Promise<MediaItem> {
    const type = mediaTypeFor(file.name) ?? (file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : 'video');
    const item = this.blank(file.name, savedPath, type);
    this.items.push(item);
    this.changed();
    perfBegin(`open:${file.name}`);
    const read = perfSpan('file-read');
    const bytes = file.size <= DECODE_LIMIT ? new Uint8Array(await file.arrayBuffer()) : null;
    read(`${file.size}B`);
    await this.load(item, file, bytes);
    return item;
  }

  /** Placeholder for a project's media that has not been found yet. */
  addOffline(ref: MediaRef): MediaItem {
    const item = this.blank(ref.name, ref.path, ref.type, ref.id);
    item.status = 'offline';
    item.duration = ref.duration;
    item.width = ref.width;
    item.height = ref.height;
    item.hasAudio = ref.hasAudio;
    this.items.push(item);
    this.changed();
    return item;
  }

  /** Points an offline item at a new file and loads it. */
  async relink(id: string, path: string): Promise<MediaItem | null> {
    const item = this.get(id);
    if (!item) return null;
    item.name = basename(path);
    return this.addPath(path, id);
  }

  remove(id: string): void {
    const index = this.items.findIndex((m) => m.id === id);
    if (index < 0) return;
    const [item] = this.items.splice(index, 1);
    this.tokens.delete(item.id);
    if (item.url) {
      URL.revokeObjectURL(item.url);
      this.urls.delete(item.url);
    }
    this.changed();
  }

  private fail(item: MediaItem, message: string): MediaItem {
    item.status = 'error';
    item.error = message;
    this.changed();
    return item;
  }

  private async load(item: MediaItem, blob: Blob, bytes: Uint8Array | null): Promise<void> {
    item.size = blob.size;
    // Every load attempt takes the item's next token: a filmstrip still running for a previous
    // file (a relink) sees its token gone and stops instead of mixing two files' frames.
    const token = (this.tokens.get(item.id) ?? 0) + 1;
    this.tokens.set(item.id, token);
    if (item.type !== 'image') item.thumbs = [];
    if (item.type !== 'image') {
      // A .mov is tried as MP4 (see mimeFor); the decoder itself is the judge.
      const refusal = extensionOf(item.name).toLowerCase() === '.mov' ? null : refusalFor(this.probe(), item.name);
      if (refusal) {
        this.fail(item, this.describe.refused(refusal.ext));
        return;
      }
    }
    if (item.url) {
      URL.revokeObjectURL(item.url);
      this.urls.delete(item.url);
    }
    const blobSpan = perfSpan('blob-url');
    item.url = URL.createObjectURL(blob);
    this.urls.add(item.url);
    blobSpan();
    try {
      if (item.type === 'image') await this.loadImage(item);
      else await this.loadAv(item);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      // Error 3/4 is the decoder saying no: name the codec problem, not a vague failure.
      item.convertible = /media error [34]|error$/.test(message);
      this.fail(item, item.convertible
        ? this.describe.codec(extensionOf(item.name).toLowerCase() || '?', item.size)
        : this.describe.unreadable(message));
      return;
    }
    item.status = 'ready';
    item.error = '';
    // A file that can carry audio is assumed to have it until the decode says otherwise: the
    // probe below is now in the background, and the opposite default would flash the inspector's
    // "no audio track" warning at every clip and drop the track from an export started at once.
    if (item.type !== 'image') item.hasAudio = true;
    perfMark('ready', `${item.width}x${item.height} ${item.duration}s`);
    this.changed();
    // Everything past this point is decoration: the filmstrip and the waveform are useful, but
    // neither is needed to play the clip, and the twelve decoder seeks they cost used to be
    // spent in front of "the file is open". They run on their own now and announce themselves
    // through `changed()` when they land.
    if (item.type !== 'image' && bytes && bytes.length <= DECODE_LIMIT) {
      item.bytes = bytes;
      void this.enrich(item, blob, token);
    }
  }

  /**
   * The background half of loading: filmstrip frames and audio peaks.
   *
   * `token` is the load attempt this job belongs to, so a job that was overtaken (the item was
   * relinked, replaced or removed, or the library was disposed) writes nothing: a stale frame
   * from the previous file in a new item's filmstrip is exactly the kind of silent corruption
   * this app refuses to ship.
   */
  private async enrich(item: MediaItem, blob: Blob, token: number): Promise<void> {
    const alive = () => !this.disposed && this.tokens.get(item.id) === token && this.get(item.id) === item;
    try {
      if (item.type === 'video') {
        // Never while something is playing: the seeks would both crawl and stutter the picture.
        // The settle first is what makes the gate work at all — the player's autoplay calls
        // play(), which spends ~600 ms in prepare() before its clock starts, so `playing` is
        // still false right after the item is ready and a strip that started then would land
        // exactly on top of playback (measured: one seek blocked for 8.6 s and the playback
        // element's own prepares grew to 1.9 s).
        await this.settle(1200, alive);
        if (!alive()) return;
        await this.waitForIdle(60_000, alive);
        if (!alive()) return;
        await this.filmstrip(item, blob, alive);
      }
      if (!alive() || !item.bytes) return;
      const peaks = await decodePeaks(item.bytes, item.duration);
      if (!alive()) return;
      item.peaks = peaks;
      // For video the decode is the honest audio probe: no decodable audio, no audio.
      item.hasAudio = peaks !== null;
      perfMark('peaks', peaks ? 'audio' : 'none');
      this.changed();
    } catch {
      /* decoration: the clip is already playable, so a failed strip changes nothing */
    }
  }

  /** A sleep that stops early when the job it belongs to is no longer wanted. */
  private async settle(ms: number, alive: () => boolean): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && alive()) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))));
    }
  }

  /**
   * Waits for a quiet window in the app's playback, so the filmstrip's seeks do not fight the
   * decoder that is drawing the picture. Two measured reasons: twelve seeks cost 0.75 s while
   * nothing played and 12 s during playback, and the playback element's own prepares went from
   * 69 ms to 1.9 s — a background strip that stutters the film is worse than a late strip.
   *
   * The window has to be *sustained*, not just "not playing this instant". Bounded on purpose —
   * after `maxMs` the strip runs anyway, because a filmstrip that never arrives is worse than one
   * that arrives slowly.
   */
  private async waitForIdle(maxMs: number, alive: () => boolean, quietMs = 500): Promise<void> {
    if (!this.busy) return;
    const deadline = Date.now() + maxMs;
    let quietSince = this.busy() ? 0 : Date.now();
    while (Date.now() < deadline && alive()) {
      if (this.busy()) {
        quietSince = 0;
      } else if (quietSince === 0) {
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Frames for the pool card, the playlist poster and the timeline filmstrip. */
  private async filmstrip(item: MediaItem, blob: Blob, alive: () => boolean): Promise<void> {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.src = url;
    try {
      const metadata = perfSpan('filmstrip:metadata');
      await waitFor(video, ['loadedmetadata', 'error'], 15000);
      metadata(`rs=${video.readyState}`);
      if (video.error || !alive()) return;
      const times = thumbnailTimes(item.duration, item.duration > 0 ? THUMB_COUNT : 1);
      const strip = perfSpan('thumbs', `${times.length}`);
      try {
        for (let i = 0; i < times.length; i++) {
          if (!alive()) return;
          // Playback may have started while the strip was being built: give it the decoder back
          // until it is quiet again (a long clip keeps the strip waiting, which is fine — the
          // strip is decoration and the budget below still lets it finish).
          if (this.busy?.()) await this.waitForIdle(10_000, alive, 300);
          if (!alive()) return;
          const seek = perfSpan('thumb', `#${i}`);
          await seekTo(video, times[i]);
          seek();
          if (!alive()) return;
          item.thumbs.push(frameCanvas(video, item.width, item.height));
          // The poster appears as soon as there is one, and the finished strip once: a
          // `changed()` per frame would re-render every card in the pool twelve times.
          if (i === 0 || i === times.length - 1) this.changed();
        }
      } finally {
        strip();
      }
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  }

  private async loadImage(item: MediaItem): Promise<void> {
    const img = new Image();
    img.decoding = 'async';
    img.src = item.url;
    await img.decode();
    item.image = img;
    item.width = img.naturalWidth;
    item.height = img.naturalHeight;
    item.duration = 0;
    item.thumbs = [frameCanvas(img, img.naturalWidth, img.naturalHeight)];
  }

  /**
   * Metadata only: what the clip *is* (size, duration, whether it is really video or audio).
   * The element is released as soon as it has answered, so the decoder is not held open while
   * the background filmstrip builds its own.
   */
  private async loadAv(item: MediaItem): Promise<void> {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.src = item.url;
    perfMark('av:element');
    // The two events that say "the decoder is ready for this file". They are recorded, never
    // awaited: the app has its own waits, and a missing `canplay` must not hang the pool.
    video.addEventListener('canplay', () => perfMark('av:canplay', `rs=${video.readyState}`), { once: true });
    video.addEventListener('canplaythrough', () => perfMark('av:canplaythrough', `rs=${video.readyState}`), { once: true });
    try {
      const metadata = perfSpan('metadata');
      await waitFor(video, ['loadedmetadata', 'error'], 15000);
      metadata(`rs=${video.readyState}`);
      if (video.error) throw new Error(`media error ${video.error.code}`);
      const duration = perfSpan('duration');
      item.duration = await realDuration(video);
      duration(`${item.duration}s`);
      item.width = video.videoWidth || 0;
      item.height = video.videoHeight || 0;
      if (item.width === 0 && item.type === 'video') item.type = 'audio';
      if (item.width > 0 && item.type === 'audio') item.type = 'video';
    } finally {
      video.removeAttribute('src');
      video.load();
    }
  }

  dispose(): void {
    // Before the URLs go: a filmstrip still running must stop writing into an item whose blob
    // URL has just been revoked, and must not call `changed()` on a cleared listener set.
    this.disposed = true;
    this.tokens.clear();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.items.length = 0;
    this.listeners.clear();
  }
}

/** Every file extension the pool can import. */
export function importableExtensions(videoExts: readonly string[]): string[] {
  return [...new Set([...videoExts, ...IMAGE_EXTENSIONS])];
}

/** The pool item's filmstrip frame closest to a source time. */
export function thumbAt(item: MediaItem, time: number): HTMLCanvasElement | null {
  if (item.thumbs.length === 0) return null;
  if (item.thumbs.length === 1 || !(item.duration > 0)) return item.thumbs[0];
  const index = Math.round((time / item.duration) * item.thumbs.length - 0.5);
  return item.thumbs[Math.max(0, Math.min(item.thumbs.length - 1, index))];
}

export { newMediaId };

/** Loads a blob into a throwaway element and reports its real playable duration (seconds). */
export async function measureDuration(blob: Blob): Promise<number> {
  const done = perfSpan('measureDuration');
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await waitFor(video, ['loadedmetadata', 'error'], 10000);
    if (video.error) return 0;
    return await realDuration(video);
  } catch {
    return 0;
  } finally {
    done();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
