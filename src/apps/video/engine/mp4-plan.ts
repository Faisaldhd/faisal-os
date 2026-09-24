/**
 * MP4 export planning — pure, no DOM.
 *
 * The real MP4 path encodes the frames the compositor draws with WebCodecs
 * (`VideoEncoder` H.264, `AudioEncoder` AAC or Opus) and muxes them with
 * `mp4-muxer`. Everything that decides *what* to configure lives here, so it is
 * tested without a browser: the H.264 level for a size and frame rate, the
 * codec candidates, the pick through `isConfigSupported`, the muxer options,
 * and the frame/sample timestamps.
 */

/** H.264 levels (ITU-T H.264 table A-1): max frame size and max throughput in 16×16 macroblocks. */
const AVC_LEVELS: ReadonlyArray<{ level: number; maxFs: number; maxMbps: number }> = [
  { level: 0x1e, maxFs: 1620, maxMbps: 40500 }, // 3.0
  { level: 0x1f, maxFs: 3600, maxMbps: 108000 }, // 3.1
  { level: 0x20, maxFs: 5120, maxMbps: 216000 }, // 3.2
  { level: 0x28, maxFs: 8192, maxMbps: 245760 }, // 4.0
  { level: 0x2a, maxFs: 8704, maxMbps: 522240 }, // 4.2
  { level: 0x32, maxFs: 22080, maxMbps: 589824 }, // 5.0
  { level: 0x33, maxFs: 36864, maxMbps: 983040 }, // 5.1
  { level: 0x34, maxFs: 36864, maxMbps: 2073600 }, // 5.2
];

/** The smallest H.264 level (as its codec-string byte) that holds `width×height` at `fps`. */
export function avcLevel(width: number, height: number, fps: number): number {
  const mbs = Math.ceil(Math.max(1, width) / 16) * Math.ceil(Math.max(1, height) / 16);
  const rate = mbs * Math.max(1, fps);
  return (AVC_LEVELS.find((l) => mbs <= l.maxFs && rate <= l.maxMbps) ?? AVC_LEVELS[AVC_LEVELS.length - 1]).level;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** H.264 codec strings, best first: High, Main, Constrained Baseline — all at the level the size needs. */
export function avcCandidates(width: number, height: number, fps: number): string[] {
  const level = hex2(avcLevel(width, height, fps));
  return [`avc1.6400${level}`, `avc1.4D00${level}`, `avc1.42E0${level}`];
}

/** Audio codecs the MP4 can carry, best first: AAC-LC (plays everywhere), then Opus. */
export const AUDIO_CANDIDATES: ReadonlyArray<{ codec: string; muxer: 'aac' | 'opus' }> = [
  { codec: 'mp4a.40.2', muxer: 'aac' },
  { codec: 'opus', muxer: 'opus' },
];

export interface Mp4VideoConfig {
  codec: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  /** `avc` = length-prefixed samples + an avcC description (what MP4 needs). */
  avc: { format: 'avc' };
  latencyMode: 'quality';
}

export interface Mp4AudioConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

export interface Mp4Plan {
  video: Mp4VideoConfig;
  /** Null for a silent film. */
  audio: Mp4AudioConfig | null;
  audioMuxer: 'aac' | 'opus' | null;
  fps: number;
}

export interface Mp4Request {
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  /** The timeline has something audible (otherwise no audio track is written). */
  wantsAudio: boolean;
  sampleRate?: number;
  channels?: number;
}

/** The browser's `isConfigSupported`, reduced to a yes/no (never rejects). */
export interface Mp4Probe {
  video(config: Mp4VideoConfig): Promise<boolean>;
  audio(config: Mp4AudioConfig): Promise<boolean>;
}

/**
 * The configuration WebCodecs confirms, or null when this browser cannot make
 * the MP4 (then the MediaRecorder path is used). A film with sound needs an
 * audio encoder too: dropping the sound silently would be worse than WebM.
 */
export async function pickMp4Plan(probe: Mp4Probe, req: Mp4Request): Promise<Mp4Plan | null> {
  const width = Math.max(2, Math.round(req.width / 2) * 2);
  const height = Math.max(2, Math.round(req.height / 2) * 2);
  const fps = Math.min(60, Math.max(1, Math.round(req.fps || 30)));
  let video: Mp4VideoConfig | null = null;
  for (const codec of avcCandidates(width, height, fps)) {
    const config: Mp4VideoConfig = {
      codec, width, height, framerate: fps,
      bitrate: Math.max(100_000, Math.round(req.videoBitrate)),
      avc: { format: 'avc' }, latencyMode: 'quality',
    };
    if (await probe.video(config).catch(() => false)) { video = config; break; }
  }
  if (!video) return null;
  if (!req.wantsAudio) return { video, audio: null, audioMuxer: null, fps };
  for (const cand of AUDIO_CANDIDATES) {
    const config: Mp4AudioConfig = {
      codec: cand.codec,
      sampleRate: req.sampleRate ?? 48000,
      numberOfChannels: req.channels ?? 2,
      bitrate: Math.max(32_000, Math.round(req.audioBitrate)),
    };
    if (await probe.audio(config).catch(() => false)) return { video, audio: config, audioMuxer: cand.muxer, fps };
  }
  return null;
}

/** Options for `new Muxer(...)` (the target is added by the caller). */
export function muxerOptions(plan: Mp4Plan): {
  video: { codec: 'avc'; width: number; height: number; frameRate: number };
  audio?: { codec: 'aac' | 'opus'; numberOfChannels: number; sampleRate: number };
  fastStart: 'in-memory';
  firstTimestampBehavior: 'offset';
} {
  return {
    video: { codec: 'avc', width: plan.video.width, height: plan.video.height, frameRate: plan.fps },
    ...(plan.audio && plan.audioMuxer
      ? { audio: { codec: plan.audioMuxer, numberOfChannels: plan.audio.numberOfChannels, sampleRate: plan.audio.sampleRate } }
      : {}),
    // The moov box goes first: the file plays while it downloads and every player reads its length.
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  };
}

/** Frames in `duration` seconds at `fps` (at least one). */
export function frameCount(duration: number, fps: number): number {
  return Math.max(1, Math.round(Math.max(0, duration) * fps));
}

/** Timestamp and duration of frame `i`, in microseconds, without drift. */
export function frameTiming(i: number, fps: number): { timestamp: number; duration: number } {
  const timestamp = Math.round((i * 1e6) / fps);
  return { timestamp, duration: Math.round(((i + 1) * 1e6) / fps) - timestamp };
}

/** A key frame every two seconds: seekable files, small size cost. */
export function isKeyFrame(i: number, fps: number): boolean {
  return i % Math.max(1, Math.round(fps * 2)) === 0;
}

/** Slices `[0, length)` samples into encoder-sized blocks. */
export function audioBlocks(length: number, block = 4096): Array<{ start: number; frames: number }> {
  const out: Array<{ start: number; frames: number }> = [];
  for (let start = 0; start < length; start += block) out.push({ start, frames: Math.min(block, length - start) });
  return out;
}
