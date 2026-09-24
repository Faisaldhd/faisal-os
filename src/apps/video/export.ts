/**
 * Export planning — pure, no DOM.
 *
 * Two engines exist and this file is the only place that chooses between them:
 *
 *  • `webcodecs` — `VideoEncoder`/`AudioEncoder` encode the frames this app draws,
 *    and the encoded track is handed to `MediaRecorder` through a
 *    `MediaStreamTrackGenerator` so the file still gets a real container.
 *  • `mediarecorder` — the canvas capture stream is recorded directly.
 *
 * `webcodecs` is chosen ONLY when every piece it needs is really there and the
 * browser confirms the codec configuration with `isConfigSupported`. Anything less
 * falls back, and when even MediaRecorder cannot produce a container for this
 * source the plan says `none` instead of starting an export that cannot finish.
 */
import type { CapabilityProbe } from './capabilities';

export type ExportEngine = 'webcodecs' | 'mediarecorder' | 'none';

/** Which pieces of the WebCodecs path the browser exposes. */
export interface WebCodecsEnv {
  /** `typeof VideoEncoder === 'function'`. */
  videoEncoder: boolean;
  /** `typeof AudioEncoder === 'function'`. */
  audioEncoder: boolean;
  /** `typeof MediaStreamTrackGenerator === 'function'` — the muxing bridge. */
  trackGenerator: boolean;
  /** `typeof AudioData === 'function'` — needed to feed the audio encoder. */
  audioData: boolean;
  /** `typeof MediaStreamTrackProcessor === 'function'` — needed to read audio. */
  trackProcessor: boolean;
}

/** The state of the browser's recording surface, gathered by the DOM layer. */
export interface ExportEnv {
  webcodecs: WebCodecsEnv;
  /** `typeof MediaRecorder === 'function'`. */
  mediaRecorder: boolean;
  /** `MediaRecorder.isTypeSupported(mime)`; absent means the browser is silent. */
  recorderSupports?: (mime: string) => boolean;
  /** The source file has an audio track. */
  hasAudio: boolean;
}

export interface ExportPlan {
  engine: ExportEngine;
  /** Container the export should ask for; empty when there is no engine. */
  mime: string;
  /** File extension for the produced file, including the leading dot. */
  extension: string;
  /** True when the plan can carry audio through. */
  audio: boolean;
  /** Why this engine, for the UI's status line. */
  reason: 'webcodecs' | 'webcodecs-unsupported' | 'mediarecorder' | 'no-encoder';
}

export interface PlanInput {
  /** Candidate containers, best first (from `recorderMimeCandidates`). */
  candidates: string[];
  env: ExportEnv;
  /** The user asked for a silent export. */
  muted: boolean;
  /** The WebCodecs codec strings this app would configure. */
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
}

/** True when every piece of the WebCodecs path is present. */
export function webCodecsReady(env: WebCodecsEnv): boolean {
  return env.videoEncoder && env.trackGenerator && (!env.audioEncoder || (env.audioData && env.trackProcessor));
}

/** Whether the probe will say yes to the exact video configuration. */
export function encoderAccepts(
  probe: Pick<CapabilityProbe, 'isEncoderSupported'> | undefined,
  codec: string,
  width: number,
  height: number,
): boolean {
  if (!probe?.isEncoderSupported) return false;
  try {
    return probe.isEncoderSupported({ codec, width, height });
  } catch {
    return false;
  }
}

/** The plan, with each downgrade named so the UI can say why. */
export function planExport(input: PlanInput, probe?: Pick<CapabilityProbe, 'isEncoderSupported'>): ExportPlan {
  const wantsAudio = input.env.hasAudio && !input.muted;
  const supported = input.env.recorderSupports ?? (() => false);
  const pick = (list: string[]): string => list.find((m) => supported(m)) ?? '';

  // WebCodecs first: it is the better encoder, and it only ever runs when the
  // container bridge (`MediaStreamTrackGenerator`) exists to carry its output.
  // A source with audio needs a working audio encoder too — a video-only
  // WebCodecs path would silently drop the sound.
  const videoOk = input.env.webcodecs.videoEncoder
    && input.env.webcodecs.trackGenerator
    && encoderAccepts(probe, input.videoCodec, input.width, input.height);
  const audioOk = !wantsAudio
    || (input.env.webcodecs.audioEncoder
      && input.env.webcodecs.audioData
      && input.env.webcodecs.trackProcessor
      && encoderAccepts(probe, input.audioCodec, input.width, input.height));
  if (videoOk && audioOk) {
    const mime = pick(input.candidates);
    if (mime) return { engine: 'webcodecs', mime, extension: extOf(mime), audio: wantsAudio, reason: 'webcodecs' };
  }

  if (input.env.mediaRecorder) {
    const mime = pick(input.candidates);
    if (mime) {
      const reason = input.env.webcodecs.videoEncoder ? 'webcodecs-unsupported' : 'mediarecorder';
      return { engine: 'mediarecorder', mime, extension: extOf(mime), audio: wantsAudio, reason };
    }
  }

  return { engine: 'none', mime: '', extension: '', audio: false, reason: 'no-encoder' };
}

/** The file extension a produced container gets, including the leading dot. */
export function extensionForExport(mime: string): string {
  const type = mime.split(';')[0].trim().toLowerCase();
  if (type === 'video/webm' || type === 'audio/webm') return '.webm';
  if (type === 'video/mp4' || type === 'audio/mp4') return '.mp4';
  if (type === 'audio/ogg' || type === 'video/ogg') return '.ogg';
  if (type === 'audio/mpeg') return '.mp3';
  if (type === 'video/x-matroska') return '.mkv';
  return '.webm';
}

/** Internal alias: the plan carries the extension next to the MIME type. */
const extOf = extensionForExport;

/* ───────────────────────────── file naming ───────────────────────────── */

/** Strips the extension from a base name: "a.b.mp4" → "a.b". */
export function baseNameWithoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export interface NamePlan {
  /** The file the export will write. */
  path: string;
  /** The file kept as a backup when `path` already exists, or null when it does not. */
  backup: string | null;
}

/** `-edited-HHMMSS` keeps two exports in the same minute apart only if the clock moved. */
export function exportName(base: string, extension: string, token: string): string {
  const clean = base.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'video';
  return `${clean}-edited-${token}${extension}`;
}

/**
 * Where the export goes, and what gets kept when it already exists.
 *
 * One backup only, always the same name: `.bak` files do not accumulate, and the
 * user is told the exact name before the overwrite happens.
 */
export function planName(dir: string, name: string, exists: boolean): NamePlan {
  const path = `${dir.replace(/\/+$/, '')}/${name}`;
  return { path, backup: exists ? `${path}.bak` : null };
}

/* ─────────────────────────── storage limits ─────────────────────────── */

/** The per-file limit enforced by src/vfs/index.ts (FILE_QUOTA). */
export const VFS_FILE_LIMIT = 20 * 1024 * 1024;
/** The total limit enforced by src/vfs/index.ts (TOTAL_QUOTA). */
export const VFS_TOTAL_LIMIT = 50 * 1024 * 1024;

export type QuotaVerdict = 'ok' | 'file-too-big' | 'total-too-big';

/** Judged before writing, so a long export fails with a reason instead of a VFS error. */
export function checkQuota(bytes: number, usedBytes: number): QuotaVerdict {
  if (bytes > VFS_FILE_LIMIT) return 'file-too-big';
  if (usedBytes + bytes > VFS_TOTAL_LIMIT) return 'total-too-big';
  return 'ok';
}

/** Percentage of the estimated size against the per-file limit, for the warning line. */
export function quotaFraction(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.min(1, bytes / VFS_FILE_LIMIT);
}
