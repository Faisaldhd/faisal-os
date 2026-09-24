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
}

const THUMB_COUNT = 12;
const THUMB_HEIGHT = 72;
/** Above this, audio is not decoded for waveforms (it would hold the whole file twice). */
const DECODE_LIMIT = 120 * 1024 * 1024;

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
  try {
    const ctx = new Offline(1, 1, 44100);
    const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
    if (buffer.length === 0) return null;
    const data = buffer.getChannelData(0);
    const buckets = Math.max(200, Math.min(12000, Math.round((duration || buffer.duration) * 60)));
    return computePeaks(data, buckets);
  } catch {
    return null;
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

  constructor(private readonly vfs: VFS, private readonly probe: () => CapabilityProbe, private readonly describe: MediaDescribe) {}

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
    this.changed();
    try {
      const bytes = await this.vfs.readFile(path);
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
    const bytes = file.size <= DECODE_LIMIT ? new Uint8Array(await file.arrayBuffer()) : null;
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
    item.url = URL.createObjectURL(blob);
    this.urls.add(item.url);
    try {
      if (item.type === 'image') await this.loadImage(item);
      else await this.loadAv(item);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      // Error 3/4 is the decoder saying no: name the codec problem, not a vague failure.
      this.fail(item, /media error [34]|error$/.test(message)
        ? this.describe.codec(extensionOf(item.name).toLowerCase() || '?', item.size)
        : this.describe.unreadable(message));
      return;
    }
    item.status = 'ready';
    item.error = '';
    this.changed();
    if (item.type !== 'image' && bytes && bytes.length <= DECODE_LIMIT) {
      item.bytes = bytes;
      const peaks = await decodePeaks(bytes, item.duration);
      item.peaks = peaks;
      // For video the decode is the honest audio probe: no decodable audio, no audio.
      item.hasAudio = peaks !== null;
      this.changed();
    } else if (item.type !== 'image') {
      item.hasAudio = true;
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

  private async loadAv(item: MediaItem): Promise<void> {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.src = item.url;
    try {
      await waitFor(video, ['loadedmetadata', 'error'], 15000);
      if (video.error) throw new Error(`media error ${video.error.code}`);
      item.duration = await realDuration(video);
      item.width = video.videoWidth || 0;
      item.height = video.videoHeight || 0;
      if (item.width === 0 && item.type === 'video') item.type = 'audio';
      if (item.width > 0 && item.type === 'audio') item.type = 'video';
      if (item.type === 'video') {
        item.thumbs = [];
        const count = item.duration > 0 ? THUMB_COUNT : 1;
        for (let i = 0; i < count; i++) {
          const at = count === 1 ? 0 : Math.min(item.duration - 0.05, (item.duration * (i + 0.5)) / count);
          await seekTo(video, Math.max(0, at));
          item.thumbs.push(frameCanvas(video, item.width, item.height));
          if (i === 0) this.changed();
        }
      }
    } finally {
      video.removeAttribute('src');
      video.load();
    }
  }

  dispose(): void {
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
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
