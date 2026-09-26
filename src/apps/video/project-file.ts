/**
 * The project file (`.fvproj`) — pure, no DOM.
 *
 * A project is JSON: the tracks and every setting, plus a media table that names
 * each source file by a path RELATIVE to the project file, so a folder holding a
 * project and its footage can be moved as a whole and still open. Absolute paths
 * are kept as a fallback for media that lives outside the project's folder tree.
 *
 * Parsing never trusts the file: every number is re-clamped, unknown clip types
 * and tracks are dropped, and anything malformed becomes a named error instead of
 * a half-built project. Media that cannot be found when the project opens is not
 * an error: it is shown "offline" with a Relink action (the caller decides).
 */
import { normalize } from '../../kernel/path';
import { normalizeEffects } from './effects';
import { clampCrop, resetTransform, type Rotation, type VideoTransform } from './clips';
import { clamp } from './time';
import {
  defaultTracks,
  MAX_SPEED,
  MAX_TRANSITION,
  MAX_VOLUME,
  MIN_SPEED,
  NEUTRAL_COLOR,
  type AspectKey,
  type Clip,
  type ColorAdjust,
  type FontKey,
  type MediaClip,
  type MediaType,
  type Project,
  type TextAnim,
  type TextClip,
  type Track,
  type TrackKind,
  type TransitionKind,
} from './project';

export const PROJECT_EXTENSION = '.fvproj';
export const PROJECT_FORMAT = 'faisal-video-project';
export const PROJECT_VERSION = 1;

/** One media file the project uses. */
export interface MediaRef {
  id: string;
  /** Absolute VFS path, or null for a file that only lived in memory. */
  path: string | null;
  name: string;
  type: MediaType;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: string;
  project: Project;
  media: Array<Omit<MediaRef, 'path'> & { path: string | null; absolutePath: string | null }>;
}

export class ProjectFileError extends Error {
  constructor(public readonly reason: 'json' | 'format' | 'version' | 'shape') {
    super(`project file: ${reason}`);
    this.name = 'ProjectFileError';
  }
}

/* ─────────────────────────────── paths ─────────────────────────────── */

/** `to` relative to the directory `fromDir` ("../Music/a.mp3"). Both absolute. */
export function relativePath(fromDir: string, to: string): string {
  const from = normalize(fromDir).split('/').filter(Boolean);
  const target = normalize(to).split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < target.length - 1 && from[common] === target[common]) common++;
  const up = from.slice(common).map(() => '..');
  return [...up, ...target.slice(common)].join('/') || '.';
}

/** Resolves a relative (or absolute) path against the project's directory. */
export function resolveRelative(fromDir: string, path: string): string {
  return normalize(path.startsWith('/') ? path : `${fromDir}/${path}`);
}

/* ─────────────────────────────── writing ─────────────────────────────── */

export function serializeProject(project: Project, media: readonly MediaRef[], projectDir: string, savedAt = new Date()): string {
  const used = new Set<string>();
  for (const track of project.tracks) for (const clip of track.clips) if (clip.type !== 'text') used.add(clip.mediaId);
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: savedAt.toISOString(),
    project,
    media: media
      .filter((m) => used.has(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name,
        type: m.type,
        duration: m.duration,
        width: m.width,
        height: m.height,
        hasAudio: m.hasAudio,
        path: m.path ? relativePath(projectDir, m.path) : null,
        absolutePath: m.path,
      })),
  };
  return JSON.stringify(file, null, 2);
}

/* ─────────────────────────────── reading ─────────────────────────────── */

const num = (value: unknown, fallback: number, lo = -Infinity, hi = Infinity): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, lo, hi) : fallback;
const str = (value: unknown, fallback: string, max = 2000): string => (typeof value === 'string' ? value.slice(0, max) : fallback);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const COLOR = /^#[0-9a-fA-F]{6}$/;
const color = (value: unknown, fallback: string): string => (typeof value === 'string' && COLOR.test(value) ? value : fallback);
const colorOrNone = (value: unknown): string => (value === '' ? '' : color(value, ''));

const ASPECT_KEYS: readonly AspectKey[] = ['auto', '16:9', '9:16', '1:1', '4:5', '4:3'];
const TRACK_KINDS: readonly TrackKind[] = ['main', 'overlay', 'text', 'audio'];
const TRANSITIONS: readonly TransitionKind[] = ['none', 'crossfade', 'dip', 'slide'];
const FONTS: readonly FontKey[] = ['sans', 'naskh', 'kufi', 'display', 'mono'];
const ANIMS: readonly TextAnim[] = ['none', 'fade', 'slide', 'pop'];
const MEDIA_TYPES: readonly MediaType[] = ['video', 'image', 'audio'];

function readTransform(value: unknown): VideoTransform {
  const t = obj(value);
  const flip = obj(t.flip);
  const crop = obj(t.crop);
  const rotation = [0, 90, 180, 270].includes(t.rotation as number) ? (t.rotation as Rotation) : 0;
  return {
    rotation,
    flip: { horizontal: bool(flip.horizontal, false), vertical: bool(flip.vertical, false) },
    crop: clampCrop({ x: num(crop.x, 0), y: num(crop.y, 0), width: num(crop.width, 1), height: num(crop.height, 1) }),
  };
}

function readColor(value: unknown): ColorAdjust {
  const c = obj(value);
  return {
    brightness: num(c.brightness, NEUTRAL_COLOR.brightness, 0, 2),
    contrast: num(c.contrast, NEUTRAL_COLOR.contrast, 0, 2),
    saturation: num(c.saturation, NEUTRAL_COLOR.saturation, 0, 2),
  };
}

function readClip(value: unknown): Clip | null {
  const c = obj(value);
  const id = str(c.id, '', 80);
  if (!id) return null;
  if (c.type === 'text') {
    const clip: TextClip = {
      id,
      type: 'text',
      start: num(c.start, 0, 0),
      duration: num(c.duration, 3, 0.05, 36_000),
      text: str(c.text, '', 5000),
      font: oneOf(c.font, FONTS, 'sans'),
      size: num(c.size, 0.09, 0.02, 0.5),
      color: color(c.color, '#ffffff'),
      background: colorOrNone(c.background),
      bold: bool(c.bold, true),
      align: oneOf(c.align, ['start', 'center', 'end'] as const, 'center'),
      x: num(c.x, 0.5, 0, 1),
      y: num(c.y, 0.5, 0, 1),
      animIn: oneOf(c.animIn, ANIMS, 'none'),
      animOut: oneOf(c.animOut, ANIMS, 'none'),
      animDuration: num(c.animDuration, 0.4, 0.05, 5),
    };
    return clip;
  }
  const type = oneOf(c.type, MEDIA_TYPES, 'video');
  if (!MEDIA_TYPES.includes(c.type as MediaType)) return null;
  const mediaId = str(c.mediaId, '', 80);
  if (!mediaId) return null;
  const sourceDuration = num(c.sourceDuration, 0, 0);
  const inPoint = num(c.in, 0, 0);
  const outLimit = type === 'image' || sourceDuration === 0 ? 36_000 : sourceDuration;
  const out = num(c.out, inPoint + 1, inPoint + 0.01, Math.max(inPoint + 0.01, outLimit));
  const transition = obj(c.transition);
  const clip: MediaClip = {
    id,
    type,
    mediaId,
    sourceDuration,
    start: num(c.start, 0, 0),
    in: type === 'image' ? 0 : inPoint,
    out,
    effects: normalizeEffects(c.effects),
    speed: type === 'image' ? 1 : num(c.speed, 1, MIN_SPEED, MAX_SPEED),
    volume: num(c.volume, 1, 0, MAX_VOLUME),
    muted: bool(c.muted, false),
    fadeIn: num(c.fadeIn, 0, 0, 600),
    fadeOut: num(c.fadeOut, 0, 0, 600),
    transform: c.transform ? readTransform(c.transform) : resetTransform(),
    color: readColor(c.color),
    fit: oneOf(c.fit, ['contain', 'cover'] as const, 'contain'),
    opacity: num(c.opacity, 1, 0, 1),
    scale: num(c.scale, 1, 0.05, 5),
    x: num(c.x, 0.5, -0.5, 1.5),
    y: num(c.y, 0.5, -0.5, 1.5),
    transition: { kind: oneOf(transition.kind, TRANSITIONS, 'none'), duration: num(transition.duration, 0.6, 0, MAX_TRANSITION) },
  };
  return clip;
}

function readTrack(value: unknown): Track | null {
  const t = obj(value);
  const id = str(t.id, '', 80);
  const kind = oneOf(t.kind, TRACK_KINDS, 'audio');
  if (!id || !TRACK_KINDS.includes(t.kind as TrackKind)) return null;
  const clips = Array.isArray(t.clips) ? t.clips.map(readClip).filter((c): c is Clip => c !== null) : [];
  // A clip on a track that cannot hold it (a text on an audio track) is dropped.
  const fits = clips.filter((c) => (kind === 'text' ? c.type === 'text' : kind === 'audio' ? c.type === 'audio' : c.type === 'video' || c.type === 'image'));
  return { id, kind, muted: bool(t.muted, false), hidden: bool(t.hidden, false), clips: fits };
}

/** Parses and validates a project file. Media paths come back absolute. */
export function parseProjectFile(text: string, projectDir: string): { project: Project; media: MediaRef[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFileError('json');
  }
  const file = obj(raw);
  if (file.format !== PROJECT_FORMAT) throw new ProjectFileError('format');
  const version = num(file.version, 0);
  if (version < 1 || version > PROJECT_VERSION) throw new ProjectFileError('version');
  const p = obj(file.project);
  if (!Array.isArray(p.tracks)) throw new ProjectFileError('shape');
  let tracks = p.tracks.map(readTrack).filter((t): t is Track => t !== null);
  // Ids must be unique, and there must be exactly one main track.
  const seen = new Set<string>();
  tracks = tracks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  const mains = tracks.filter((t) => t.kind === 'main');
  if (mains.length === 0) tracks.splice(Math.min(2, tracks.length), 0, defaultTracks()[2]);
  else if (mains.length > 1) tracks = tracks.filter((t) => t.kind !== 'main' || t === mains[0]);
  const project: Project = {
    name: str(p.name, '', 200),
    aspect: oneOf(p.aspect, ASPECT_KEYS, 'auto'),
    background: color(p.background, '#000000'),
    tracks,
  };
  const media: MediaRef[] = (Array.isArray(file.media) ? file.media : []).flatMap((value): MediaRef[] => {
    const m = obj(value);
    const id = str(m.id, '', 80);
    if (!id) return [];
    const rel = typeof m.path === 'string' && m.path ? m.path : null;
    const abs = typeof m.absolutePath === 'string' && m.absolutePath.startsWith('/') ? normalize(m.absolutePath) : null;
    return [{
      id,
      path: rel ? resolveRelative(projectDir, rel) : abs,
      name: str(m.name, id, 300),
      type: oneOf(m.type, MEDIA_TYPES, 'video'),
      duration: num(m.duration, 0, 0),
      width: num(m.width, 0, 0, 16384),
      height: num(m.height, 0, 0, 16384),
      hasAudio: bool(m.hasAudio, false),
    }];
  });
  return { project, media };
}

/**
 * The absolute path a media entry was saved with, for the Relink fallback:
 * when the relative path is missing (the project moved without its media), the
 * original location may still hold the file.
 */
export function absoluteFallback(text: string, id: string): string | null {
  try {
    const file = obj(JSON.parse(text));
    const entry = (Array.isArray(file.media) ? file.media : []).map(obj).find((m) => m.id === id);
    return entry && typeof entry.absolutePath === 'string' ? normalize(entry.absolutePath) : null;
  } catch {
    return null;
  }
}
