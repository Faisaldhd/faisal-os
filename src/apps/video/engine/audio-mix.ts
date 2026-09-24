/**
 * The audio mix.
 *
 *  • `LiveMixer` — the Web Audio graph used by the preview AND the real-time
 *    export: every audible element (video clips on main/overlay, audio clips on
 *    the audio tracks) runs through its own GainNode into one master bus. The
 *    per-clip gain (volume × fades × transition ramps × mute) comes from
 *    `audibleAt` in the project model, once per tick. Elements play at the
 *    clip's speed with `preservesPitch`, so sped-up speech keeps its pitch.
 *  • `renderMixOffline` — the same mix rendered faster than real time with an
 *    OfflineAudioContext, for the audio-only export (WAV) — exact, sample-timed.
 *  • Waveform peaks for the timeline UI.
 */
import { audibleAt, layoutTrack, isMedia, type MediaClip, type Project } from '../project';
import { computePeaks } from '../render-math';

/* ─────────────────────────────── pure helpers ─────────────────────────────── */

export interface MinMaxPeaks {
  min: Float32Array;
  max: Float32Array;
}

/** Min and max sample per bucket (the classic two-sided waveform), −1…1. */
export function minMaxPeaks(samples: ArrayLike<number>, buckets: number): MinMaxPeaks {
  const count = Math.max(1, Math.floor(Number.isFinite(buckets) ? buckets : 1));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const n = samples.length;
  if (n === 0) return { min, max };
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * n) / count);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / count));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i < to && i < n; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = Number.isFinite(lo) ? Math.max(-1, lo) : 0;
    max[b] = Number.isFinite(hi) ? Math.min(1, hi) : 0;
  }
  return { min, max };
}

/** Averages several channels into one (the waveform shows the mono sum). */
export function mixDown(channels: readonly ArrayLike<number>[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) out[i] += channel[i] / channels.length;
  return out;
}

export interface GainPoint {
  /** Seconds from the start of the rendered range. */
  time: number;
  gain: number;
}

/**
 * The gain envelope of one clip, sampled every `step` seconds across its span
 * — the same numbers the live mixer applies tick by tick, so the offline
 * render and the preview agree. Includes the exact end points of the span.
 */
export function gainEnvelope(project: Project, clipId: string, span: { start: number; end: number }, step = 1 / 50): GainPoint[] {
  const points: GainPoint[] = [];
  const s = step > 0 ? step : 1 / 50;
  const n = Math.max(1, Math.ceil((span.end - span.start) / s));
  for (let i = 0; i <= n; i++) {
    // Sample just inside the span at the tail: `audibleAt` is half-open.
    const t = Math.min(span.start + i * s, span.end - 1e-6);
    const hit = audibleAt(project, t).find((a) => a.clip.id === clipId);
    points.push({ time: t, gain: hit ? hit.gain : 0 });
  }
  return points;
}

/** Every clip that makes sound, with its timeline span (the offline render's work list). */
export function audibleClips(project: Project): Array<{ clip: MediaClip; trackId: string; start: number; end: number }> {
  const out: Array<{ clip: MediaClip; trackId: string; start: number; end: number }> = [];
  for (const track of project.tracks) {
    if (track.kind === 'text' || track.muted) continue;
    for (const p of layoutTrack(track)) {
      if (!isMedia(p.clip) || p.clip.type === 'image' || p.clip.muted || !(p.clip.volume > 0)) continue;
      out.push({ clip: p.clip, trackId: track.id, start: p.start, end: p.end });
    }
  }
  return out;
}

/* ─────────────────────────────── live graph ─────────────────────────────── */

export type MixerOutput = 'speakers' | 'stream';

type AudioCtor = typeof AudioContext;

function audioContextCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext ?? null;
}

interface Channel {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

/**
 * One master bus. `speakers` is the preview; `stream` feeds a
 * MediaStreamAudioDestinationNode for the recorder and stays silent.
 *
 * When Web Audio is missing or refuses an element the mixer falls back to the
 * element's own `volume` (capped at 1), so the preview still has sound.
 */
export class LiveMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private readonly channels = new Map<HTMLMediaElement, Channel>();
  private failed = false;
  private masterVolume = 1;

  constructor(private readonly output: MixerOutput) {}

  /** Creates the graph on first use; returns null when Web Audio is unavailable. */
  private ensure(): AudioContext | null {
    if (this.ctx || this.failed) return this.ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) {
      this.failed = true;
      return null;
    }
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.masterVolume;
      if (this.output === 'speakers') master.connect(ctx.destination);
      else {
        this.destination = ctx.createMediaStreamDestination();
        master.connect(this.destination);
      }
      this.ctx = ctx;
      this.master = master;
    } catch {
      this.failed = true;
    }
    return this.ctx;
  }

  /** Resumes a suspended context (browsers start it suspended until a gesture). */
  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* stays suspended; the element fallback still plays */ }
    }
  }

  /** The recorder's audio track (stream output only). */
  streamTrack(): MediaStreamTrack | null {
    this.ensure();
    return this.destination?.stream.getAudioTracks()[0] ?? null;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  setMasterVolume(value: number): void {
    const v = Math.max(0, Math.min(2, Number.isFinite(value) ? value : 1));
    this.masterVolume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /** Sets one element's gain (0…2). Routes it through the graph on first call. */
  setGain(element: HTMLMediaElement, gain: number): void {
    const g = Math.max(0, Math.min(2, Number.isFinite(gain) ? gain : 0));
    const channel = this.channel(element);
    if (channel && this.ctx) {
      element.muted = false;
      element.volume = 1;
      channel.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.012);
      return;
    }
    // No graph: the element's own volume, which cannot go above 1.
    if (this.output === 'stream') {
      element.muted = true;
      return;
    }
    const v = Math.min(1, g * this.masterVolume);
    element.muted = v <= 0;
    element.volume = v;
  }

  /** Silences an element without detaching it (it keeps time). */
  silence(element: HTMLMediaElement): void {
    const channel = this.channels.get(element);
    if (channel && this.ctx) channel.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    else element.muted = true;
  }

  private channel(element: HTMLMediaElement): Channel | null {
    const existing = this.channels.get(element);
    if (existing) return existing;
    const ctx = this.ensure();
    if (!ctx || !this.master) return null;
    try {
      const source = ctx.createMediaElementSource(element);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this.master);
      const channel = { source, gain };
      this.channels.set(element, channel);
      return channel;
    } catch {
      return null;
    }
  }

  /** Disconnects an element that is being released. */
  release(element: HTMLMediaElement): void {
    const channel = this.channels.get(element);
    if (!channel) return;
    try {
      channel.source.disconnect();
      channel.gain.disconnect();
    } catch { /* already gone */ }
    this.channels.delete(element);
  }

  dispose(): void {
    for (const element of [...this.channels.keys()]) this.release(element);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.destination = null;
  }
}

/* ─────────────────────────────── offline render ─────────────────────────────── */

export interface OfflineMixOptions {
  /** Timeline range to render; the whole `[0, duration)` when omitted. */
  range?: { start: number; end: number };
  sampleRate?: number;
  channels?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface OfflineMixResult {
  buffer: AudioBuffer;
  /** True when some clip ran at a speed other than 1: offline playback shifts its pitch. */
  pitchShifted: boolean;
  /** Media ids that could not be decoded (their clips are silent in the mix). */
  undecodable: string[];
}

/** Where one clip lands inside a rendered range: when to start, from which source second, until when. */
export function scheduleInRange(
  clip: Pick<MediaClip, 'in' | 'speed'>,
  span: { start: number; end: number },
  range: { start: number; end: number },
): { when: number; offset: number; stop: number } | null {
  const from = Math.max(span.start, range.start);
  const to = Math.min(span.end, range.end);
  if (!(to > from)) return null;
  const speed = clip.speed > 0 ? clip.speed : 1;
  return { when: from - range.start, offset: Math.max(0, clip.in + (from - span.start) * speed), stop: to - range.start };
}

/** Raised when an offline render is cancelled. */
export class MixCancelled extends Error {
  constructor() {
    super('mix cancelled');
    this.name = 'MixCancelled';
  }
}

/**
 * Renders the project's sound with an OfflineAudioContext — exact and faster
 * than real time.
 *
 * `decode(mediaId)` returns the decoded file. Each clip becomes an
 * AudioBufferSourceNode started at its timeline position (offset into its `in`
 * point, at its speed) through a GainNode following the same envelope the live
 * mixer applies (`audibleAt`), so the WAV sounds like the preview. Progress is
 * real: the render suspends every second of output to report it.
 */
export async function renderMixOffline(
  project: Project,
  duration: number,
  decode: (mediaId: string) => Promise<AudioBuffer | null>,
  options: OfflineMixOptions = {},
): Promise<OfflineMixResult> {
  const sampleRate = options.sampleRate ?? 48000;
  const channelCount = options.channels ?? 2;
  const range = options.range ?? { start: 0, end: duration };
  const length = Math.max(1, Math.ceil(Math.max(0, range.end - range.start) * sampleRate));
  const OfflineCtor = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!OfflineCtor) throw new Error('OfflineAudioContext is unavailable');
  const ctx = new OfflineCtor(channelCount, length, sampleRate);
  const cache = new Map<string, AudioBuffer | null>();
  const undecodable = new Set<string>();
  let pitchShifted = false;
  for (const item of audibleClips(project)) {
    if (options.signal?.aborted) throw new MixCancelled();
    const slot = scheduleInRange(item.clip, item, range);
    if (!slot) continue;
    if (!cache.has(item.clip.mediaId)) cache.set(item.clip.mediaId, await decode(item.clip.mediaId).catch(() => null));
    const buffer = cache.get(item.clip.mediaId) ?? null;
    if (!buffer) {
      undecodable.add(item.clip.mediaId);
      continue;
    }
    const speed = item.clip.speed > 0 ? item.clip.speed : 1;
    if (Math.abs(speed - 1) > 1e-3) pitchShifted = true;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speed;
    const gain = ctx.createGain();
    const envelope = gainEnvelope(project, item.clip.id, { start: slot.when + range.start, end: slot.stop + range.start });
    gain.gain.setValueAtTime(envelope[0]?.gain ?? 0, slot.when);
    for (const point of envelope.slice(1)) gain.gain.linearRampToValueAtTime(point.gain, point.time - range.start);
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(slot.when, slot.offset);
    source.stop(slot.stop);
  }
  if (options.signal?.aborted) throw new MixCancelled();
  const total = length / sampleRate;
  const marks = Math.min(100, Math.floor(total));
  let cancelled = false;
  for (let i = 1; i <= marks; i++) {
    const at = (total * i) / (marks + 1);
    ctx.suspend(at).then(() => {
      options.onProgress?.(at / total);
      if (options.signal?.aborted) cancelled = true;
      // A cancelled render still has to finish to release the context; it is
      // thrown away below. Rendering the rest of an offline graph is fast.
      void ctx.resume();
    }, () => undefined);
  }
  const buffer = await ctx.startRendering();
  if (cancelled || options.signal?.aborted) throw new MixCancelled();
  options.onProgress?.(1);
  return { buffer, pitchShifted, undecodable: [...undecodable] };
}

/** Decodes raw file bytes into an AudioBuffer, or null when the browser cannot. */
export async function decodeBytes(bytes: Uint8Array): Promise<AudioBuffer | null> {
  const OfflineCtor = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!OfflineCtor) return null;
  try {
    const ctx = new OfflineCtor(1, 1, 44100);
    return await ctx.decodeAudioData(bytes.slice().buffer);
  } catch {
    return null;
  }
}

/** Decodes a same-origin object URL (never the network), or null. */
export async function decodeUrl(url: string): Promise<AudioBuffer | null> {
  if (!/^(blob:|data:)/.test(url)) return null;
  try {
    return await decodeBytes(new Uint8Array(await (await fetch(url)).arrayBuffer()));
  } catch {
    return null;
  }
}

/** Peaks for the timeline: absolute (`computePeaks`, the lead's format) and min/max. */
export function waveformOf(buffer: AudioBuffer, buckets: number): { peaks: Float32Array; minMax: MinMaxPeaks } {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const mono = mixDown(channels);
  return { peaks: computePeaks(mono, buckets), minMax: minMaxPeaks(mono, buckets) };
}
