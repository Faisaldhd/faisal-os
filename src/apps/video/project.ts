/**
 * The Video Studio project model — pure, no DOM.
 *
 * A project is a stack of tracks over one timeline (CapCut's layout):
 *
 *  • `text`    — titles and captions, drawn on top of everything.
 *  • `overlay` — picture-in-picture video and images (stickers, logos), drawn over
 *                the main track with their own scale, position and opacity.
 *  • `main`    — the film itself. It is *magnetic*: clips sit end to end in list
 *                order, so reordering the list reorders the film and deleting or
 *                trimming a clip closes the gap by itself (a ripple edit). Clips on
 *                this track can have transitions into the next one.
 *  • `audio`   — music, voice-over and detached audio; two tracks by default.
 *
 * Every track except `main` places its clips by their own `start` time.
 *
 * Times are seconds. A media clip has two clocks: *source* time (`in`/`out`, a
 * range of the file) and *timeline* time (where it plays). They are related by the
 * clip's speed: `timelineLength = (out - in) / speed`. Images have no source clock:
 * their `in` stays 0, `out` is simply how long they are shown, and speed is 1.
 *
 * Everything returns new objects; nothing mutates its input. The UI keeps the
 * previous object for undo, so a mutation here would silently rewrite history.
 */
import { clamp } from './time';
import { gainAt } from './fades';
import { resetTransform, type VideoTransform } from './clips';

/* ─────────────────────────────── types ─────────────────────────────── */

export type MediaType = 'video' | 'image' | 'audio';
export type TrackKind = 'main' | 'overlay' | 'text' | 'audio';

/** Colour adjustments, 1 = unchanged, each within [0, 2]. */
export interface ColorAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
}

export type TransitionKind = 'none' | 'crossfade' | 'dip' | 'slide';

/** How a main-track clip enters from the one before it. Ignored on the first clip. */
export interface Transition {
  kind: TransitionKind;
  /** Seconds of timeline the transition covers. */
  duration: number;
}

export type FitMode = 'contain' | 'cover';

export interface MediaClip {
  id: string;
  type: MediaType;
  mediaId: string;
  /** Length of the source file; 0 means "no limit" (a still image). */
  sourceDuration: number;
  /** Timeline start. Ignored on the magnetic main track, where the layout decides. */
  start: number;
  in: number;
  out: number;
  speed: number;
  /** Linear gain, 0…2. */
  volume: number;
  muted: boolean;
  /** Audio fades, in timeline seconds from the clip's own edges. */
  fadeIn: number;
  fadeOut: number;
  transform: VideoTransform;
  color: ColorAdjust;
  fit: FitMode;
  /** 0…1. */
  opacity: number;
  /** Size relative to the fitted frame; 1 fills it (overlay clips default smaller). */
  scale: number;
  /** Centre of the picture as fractions of the frame (0.5, 0.5 = centred). */
  x: number;
  y: number;
  transition: Transition;
}

export type FontKey = 'sans' | 'naskh' | 'kufi' | 'display' | 'mono';
export type TextAlign = 'start' | 'center' | 'end';
export type TextAnim = 'none' | 'fade' | 'slide' | 'pop';

export interface TextClip {
  id: string;
  type: 'text';
  start: number;
  duration: number;
  text: string;
  font: FontKey;
  /** Font size as a fraction of the frame height. */
  size: number;
  color: string;
  /** Box colour behind the text, or '' for none. */
  background: string;
  bold: boolean;
  align: TextAlign;
  /** Centre of the text block, as fractions of the frame. */
  x: number;
  y: number;
  animIn: TextAnim;
  animOut: TextAnim;
  /** Seconds each animation takes. */
  animDuration: number;
}

export type Clip = MediaClip | TextClip;

export interface Track {
  id: string;
  kind: TrackKind;
  muted: boolean;
  hidden: boolean;
  clips: Clip[];
}

export type AspectKey = 'auto' | '16:9' | '9:16' | '1:1' | '4:5' | '4:3';

export interface Project {
  name: string;
  aspect: AspectKey;
  /** Letterbox colour behind the picture. */
  background: string;
  tracks: Track[];
}

/* ─────────────────────────────── limits ─────────────────────────────── */

/** Shortest clip any edit may leave behind: a little over one 30 fps frame. */
export const MIN_CLIP = 0.05;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const MAX_VOLUME = 2;
export const MAX_TRANSITION = 3;
export const IMAGE_DURATION = 4;
export const DEFAULT_TEXT_DURATION = 3;
export const NEUTRAL_COLOR: ColorAdjust = { brightness: 1, contrast: 1, saturation: 1 };

/* ─────────────────────────────── ids ─────────────────────────────── */

let idSeq = 0;

export function newId(prefix: string): string {
  idSeq += 1;
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}`;
}

/* ─────────────────────────────── creation ─────────────────────────────── */

/** The default track stack, top to bottom as the timeline shows it. */
export function defaultTracks(): Track[] {
  return [
    { id: 'text-1', kind: 'text', muted: false, hidden: false, clips: [] },
    { id: 'overlay-1', kind: 'overlay', muted: false, hidden: false, clips: [] },
    { id: 'main', kind: 'main', muted: false, hidden: false, clips: [] },
    { id: 'audio-1', kind: 'audio', muted: false, hidden: false, clips: [] },
    { id: 'audio-2', kind: 'audio', muted: false, hidden: false, clips: [] },
  ];
}

export function emptyProject(aspect: AspectKey = 'auto', name = ''): Project {
  return { name, aspect, background: '#000000', tracks: defaultTracks() };
}

function finite(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A clip for a media item; images get IMAGE_DURATION, overlays start smaller. */
export function makeMediaClip(type: MediaType, mediaId: string, duration: number, opts: { start?: number; overlay?: boolean } = {}): MediaClip {
  const d = type === 'image' ? 0 : Math.max(0, finite(duration, 0));
  return {
    id: newId('c'),
    type,
    mediaId,
    sourceDuration: d,
    start: Math.max(0, finite(opts.start ?? 0, 0)),
    in: 0,
    out: type === 'image' ? IMAGE_DURATION : d,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    transform: resetTransform(),
    color: { ...NEUTRAL_COLOR },
    fit: 'contain',
    opacity: 1,
    scale: opts.overlay ? 0.4 : 1,
    x: opts.overlay ? 0.72 : 0.5,
    y: opts.overlay ? 0.28 : 0.5,
    transition: { kind: 'none', duration: 0.6 },
  };
}

export function makeTextClip(start: number, text: string, overrides: Partial<TextClip> = {}): TextClip {
  return {
    id: newId('t'),
    type: 'text',
    start: Math.max(0, finite(start, 0)),
    duration: DEFAULT_TEXT_DURATION,
    text,
    font: 'sans',
    size: 0.09,
    color: '#ffffff',
    background: '',
    bold: true,
    align: 'center',
    x: 0.5,
    y: 0.5,
    animIn: 'fade',
    animOut: 'fade',
    animDuration: 0.4,
    ...overrides,
  };
}

/* ─────────────────────────────── lengths ─────────────────────────────── */

export function clampSpeed(speed: number): number {
  return clamp(finite(speed, 1), MIN_SPEED, MAX_SPEED);
}

export function isMedia(clip: Clip): clip is MediaClip {
  return clip.type !== 'text';
}

/** Timeline seconds a clip occupies. */
export function clipLength(clip: Clip): number {
  if (clip.type === 'text') return Math.max(0, clip.duration);
  const speed = clip.type === 'image' ? 1 : clampSpeed(clip.speed);
  return Math.max(0, (clip.out - clip.in) / speed);
}

/** Which clip types a track holds. */
export function trackAccepts(kind: TrackKind, type: Clip['type']): boolean {
  if (kind === 'main' || kind === 'overlay') return type === 'video' || type === 'image';
  if (kind === 'text') return type === 'text';
  return type === 'audio';
}

/**
 * The transition length actually used between `prev` and `cur`: never more than
 * half of either clip, so a transition can never swallow a whole clip.
 */
export function effectiveTransition(prev: Clip | undefined, cur: Clip): number {
  if (!prev || !isMedia(cur) || cur.transition.kind === 'none') return 0;
  const cap = Math.min(clipLength(prev), clipLength(cur)) / 2;
  return clamp(finite(cur.transition.duration, 0), 0, Math.min(cap, MAX_TRANSITION));
}

export interface Placed {
  clip: Clip;
  index: number;
  start: number;
  end: number;
  /** Seconds this clip overlaps the previous one (crossfade and slide). */
  overlap: number;
  /** Dip-to-black length centred on the join with the previous clip. */
  dip: number;
}

/** Where each clip of a track sits on the timeline. */
export function layoutTrack(track: Track): Placed[] {
  if (track.kind !== 'main') {
    return track.clips.map((clip, index) => ({ clip, index, start: clip.start, end: clip.start + clipLength(clip), overlap: 0, dip: 0 }));
  }
  const placed: Placed[] = [];
  let cursor = 0;
  track.clips.forEach((clip, index) => {
    const t = effectiveTransition(track.clips[index - 1], clip);
    const kind = isMedia(clip) ? clip.transition.kind : 'none';
    const overlap = kind === 'crossfade' || kind === 'slide' ? t : 0;
    const dip = kind === 'dip' ? t : 0;
    const start = Math.max(0, cursor - overlap);
    const end = start + clipLength(clip);
    placed.push({ clip, index, start, end, overlap, dip });
    cursor = end;
  });
  return placed;
}

export function mainTrack(project: Project): Track {
  return project.tracks.find((t) => t.kind === 'main') ?? { id: 'main', kind: 'main', muted: false, hidden: false, clips: [] };
}

export function trackEnd(track: Track): number {
  return layoutTrack(track).reduce((end, p) => Math.max(end, p.end), 0);
}

/** The whole film: the latest end across every track. */
export function projectDuration(project: Project): number {
  return project.tracks.reduce((end, track) => Math.max(end, trackEnd(track)), 0);
}

export function isEmptyProject(project: Project): boolean {
  return project.tracks.every((t) => t.clips.length === 0);
}

export function allClips(project: Project): Clip[] {
  return project.tracks.flatMap((t) => t.clips);
}

/* ─────────────────────────────── time mapping ─────────────────────────────── */

/** Source time for a timeline time inside a clip that starts at `start`. */
export function sourceTimeAt(clip: MediaClip, start: number, time: number): number {
  const local = Math.max(0, time - start);
  if (clip.type === 'image') return 0;
  const at = clip.in + local * clampSpeed(clip.speed);
  // Stay one hair inside the range: `out` itself is the first frame *not* shown.
  return clamp(at, clip.in, Math.max(clip.in, clip.out - 1e-3));
}

/** Timeline time for a source time inside a clip (the inverse of sourceTimeAt). */
export function timelineTimeAt(clip: MediaClip, start: number, source: number): number {
  return start + (source - clip.in) / clampSpeed(clip.speed);
}

/** Index of the main clip that owns `time` (the later one inside an overlap), or -1. */
export function mainIndexAt(project: Project, time: number): number {
  const placed = layoutTrack(mainTrack(project));
  for (let i = placed.length - 1; i >= 0; i--) {
    if (time >= placed[i].start && time < placed[i].end) return i;
  }
  return -1;
}

export interface VisualLayer {
  trackId: string;
  trackKind: 'main' | 'overlay';
  placed: Placed;
  clip: MediaClip;
  sourceTime: number;
  /** Opacity multiplier from transitions (the clip's own opacity is applied on top). */
  alpha: number;
  /** Horizontal offset as a fraction of the frame width (slide transition). */
  offsetX: number;
}

export interface VisualState {
  /** Bottom-most first: the main track, then overlays from bottom to top. */
  layers: VisualLayer[];
  /** Black drawn over the main track for a dip-to-black transition, 0…1. */
  black: number;
  /** Titles on screen, bottom-most first. */
  texts: TextClip[];
}

/** Everything the frame at `time` shows, in draw order. */
export function visualsAt(project: Project, time: number): VisualState {
  const layers: VisualLayer[] = [];
  let black = 0;
  const texts: TextClip[] = [];
  const main = mainTrack(project);
  if (!main.hidden) {
    const placed = layoutTrack(main);
    for (const p of placed) {
      if (!(time >= p.start && time < p.end) || !isMedia(p.clip)) continue;
      let alpha = 1;
      let offsetX = 0;
      if (p.overlap > 0 && time < p.start + p.overlap) {
        const progress = clamp((time - p.start) / p.overlap, 0, 1);
        if (p.clip.transition.kind === 'slide') offsetX = 1 - progress;
        else alpha = progress;
      }
      const next = placed[p.index + 1];
      if (next && next.overlap > 0 && time >= next.start && isMedia(next.clip) && next.clip.transition.kind === 'slide') {
        offsetX = -clamp((time - next.start) / next.overlap, 0, 1);
      }
      layers.push({ trackId: main.id, trackKind: 'main', placed: p, clip: p.clip, sourceTime: sourceTimeAt(p.clip, p.start, time), alpha, offsetX });
    }
    // Dip to black: the last half of the outgoing clip darkens, the first half of the
    // incoming clip brightens, and the join itself is fully black.
    for (let i = 1; i < placed.length; i++) {
      const p = placed[i];
      if (p.dip <= 0) continue;
      const half = p.dip / 2;
      const distance = Math.abs(time - p.start);
      if (distance < half) black = Math.max(black, 1 - distance / half);
    }
  }
  // Overlay tracks: the one listed lowest in the stack is drawn first.
  const overlays = project.tracks.filter((t) => t.kind === 'overlay' && !t.hidden).reverse();
  for (const track of overlays) {
    for (const p of layoutTrack(track)) {
      if (!(time >= p.start && time < p.end) || !isMedia(p.clip)) continue;
      layers.push({ trackId: track.id, trackKind: 'overlay', placed: p, clip: p.clip, sourceTime: sourceTimeAt(p.clip, p.start, time), alpha: 1, offsetX: 0 });
    }
  }
  for (const track of project.tracks.filter((t) => t.kind === 'text' && !t.hidden).reverse()) {
    for (const clip of track.clips) {
      if (clip.type === 'text' && time >= clip.start && time < clip.start + clip.duration) texts.push(clip);
    }
  }
  return { layers, black: clamp(black, 0, 1), texts };
}

/** Transition gain of the placed clip at `time` (1 outside any transition). */
function transitionGain(placed: readonly Placed[], index: number, time: number): number {
  const p = placed[index];
  let gain = 1;
  const local = time - p.start;
  if (p.overlap > 0 && local < p.overlap) gain *= local / p.overlap;
  const next = placed[index + 1];
  if (next && next.overlap > 0 && time >= next.start) gain *= clamp((p.end - time) / next.overlap, 0, 1);
  if (p.dip > 0 && local < p.dip / 2) gain *= local / (p.dip / 2);
  if (next && next.dip > 0 && time > next.start - next.dip / 2) gain *= clamp((next.start - time) / (next.dip / 2), 0, 1);
  return clamp(gain, 0, 1);
}

export interface AudibleClip {
  trackId: string;
  clip: MediaClip;
  start: number;
  sourceTime: number;
  gain: number;
}

/**
 * Every clip whose sound plays at `time`, with its gain: video clips on the main
 * and overlay tracks carry their own audio, and audio tracks carry theirs.
 * A muted clip or a muted track still appears (its element must keep time) with
 * gain 0, so unmuting mid-playback is instant.
 */
export function audibleAt(project: Project, time: number): AudibleClip[] {
  const out: AudibleClip[] = [];
  for (const track of project.tracks) {
    if (track.kind === 'text') continue;
    const placed = layoutTrack(track);
    placed.forEach((p, index) => {
      const clip = p.clip;
      if (!isMedia(clip) || clip.type === 'image') return;
      if (!(time >= p.start && time < p.end)) return;
      const length = p.end - p.start;
      const local = time - p.start;
      let gain = clip.muted || track.muted ? 0 : clamp(clip.volume, 0, MAX_VOLUME);
      gain *= gainAt(local, length, { fadeIn: clip.fadeIn, fadeOut: clip.fadeOut });
      if (track.kind === 'main') gain *= transitionGain(placed, index, time);
      out.push({ trackId: track.id, clip, start: p.start, sourceTime: sourceTimeAt(clip, p.start, time), gain: clamp(gain, 0, MAX_VOLUME) });
    });
  }
  return out;
}

export interface TextAnimState {
  alpha: number;
  /** Vertical offset as a fraction of the frame height. */
  dy: number;
  scale: number;
}

/** The in/out animation of a title at `time`. */
export function textAnimAt(clip: TextClip, time: number): TextAnimState {
  const local = time - clip.start;
  if (local < 0 || local >= clip.duration) return { alpha: 0, dy: 0, scale: 1 };
  const d = clamp(clip.animDuration, 0.05, Math.max(0.05, clip.duration / 2));
  const state: TextAnimState = { alpha: 1, dy: 0, scale: 1 };
  const apply = (anim: TextAnim, progress: number, entering: boolean) => {
    // progress: 0 = fully hidden, 1 = fully shown.
    const eased = 1 - (1 - progress) * (1 - progress);
    if (anim === 'fade') state.alpha *= eased;
    else if (anim === 'slide') {
      state.alpha *= eased;
      state.dy += (entering ? 1 : -1) * (1 - eased) * 0.08;
    } else if (anim === 'pop') {
      state.alpha *= eased;
      state.scale *= 0.6 + 0.4 * eased;
    }
  };
  if (clip.animIn !== 'none' && local < d) apply(clip.animIn, clamp(local / d, 0, 1), true);
  const remaining = clip.duration - local;
  if (clip.animOut !== 'none' && remaining < d) apply(clip.animOut, clamp(remaining / d, 0, 1), false);
  return state;
}

/* ─────────────────────────────── lookup ─────────────────────────────── */

export interface ClipLocation {
  trackIndex: number;
  clipIndex: number;
  track: Track;
  clip: Clip;
}

export function findClip(project: Project, id: string): ClipLocation | null {
  for (let trackIndex = 0; trackIndex < project.tracks.length; trackIndex++) {
    const track = project.tracks[trackIndex];
    const clipIndex = track.clips.findIndex((c) => c.id === id);
    if (clipIndex >= 0) return { trackIndex, clipIndex, track, clip: track.clips[clipIndex] };
  }
  return null;
}

/** Timeline start/end of any clip, whichever track it lives on. */
export function clipSpan(project: Project, id: string): { start: number; end: number } | null {
  const where = findClip(project, id);
  if (!where) return null;
  const p = layoutTrack(where.track)[where.clipIndex];
  return { start: p.start, end: p.end };
}

/* ─────────────────────────────── editing helpers ─────────────────────────────── */

function withTrack(project: Project, trackIndex: number, clips: Clip[]): Project {
  const tracks = project.tracks.slice();
  tracks[trackIndex] = { ...tracks[trackIndex], clips };
  return { ...project, tracks };
}

function copyClip<T extends Clip>(clip: T): T {
  return JSON.parse(JSON.stringify(clip)) as T;
}

/** Replaces a clip wherever it lives. */
export function updateClip(project: Project, clip: Clip): Project {
  const where = findClip(project, clip.id);
  if (!where) return project;
  const clips = where.track.clips.slice();
  clips[where.clipIndex] = clip;
  return withTrack(project, where.trackIndex, clips);
}

export function updateTrack(project: Project, trackId: string, patch: Partial<Pick<Track, 'muted' | 'hidden'>>): Project {
  return { ...project, tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) };
}

/**
 * Moves `start` forward until `[start, start+length)` overlaps no clip on the
 * track (ignoring `ignoreId`). Tracks other than main never stack two clips on
 * top of each other: a drop onto an occupied spot lands right after the clip
 * that was in the way.
 */
export function freeStart(track: Track, start: number, length: number, ignoreId?: string): number {
  const spans = layoutTrack(track)
    .filter((p) => p.clip.id !== ignoreId)
    .map((p) => ({ start: p.start, end: p.end }))
    .sort((a, b) => a.start - b.start);
  let at = Math.max(0, start);
  for (let guard = 0; guard < spans.length + 1; guard++) {
    const hit = spans.find((s) => at < s.end - 1e-6 && at + length > s.start + 1e-6);
    if (!hit) return at;
    at = hit.end;
  }
  return at;
}

/** The main-track index a clip dropped at timeline `time` lands on. */
export function dropIndex(track: Track, time: number, ignoreId?: string): number {
  let index = 0;
  for (const p of layoutTrack(track)) {
    if (p.clip.id === ignoreId) continue;
    if (time > (p.start + p.end) / 2) index += 1;
  }
  return index;
}

/**
 * Puts a clip onto a track at timeline `time`: on the main track it is inserted
 * at the matching position in the sequence, elsewhere it takes the first free
 * spot at or after `time`. Returns the project unchanged for a track that does
 * not hold this kind of clip.
 */
export function insertClip(project: Project, trackId: string, clip: Clip, time: number): Project {
  const trackIndex = project.tracks.findIndex((t) => t.id === trackId);
  if (trackIndex < 0) return project;
  const track = project.tracks[trackIndex];
  if (!trackAccepts(track.kind, clip.type)) return project;
  const clips = track.clips.slice();
  if (track.kind === 'main') {
    clips.splice(clamp(dropIndex(track, time), 0, clips.length), 0, clip);
  } else {
    clips.push({ ...clip, start: freeStart(track, time, clipLength(clip)) });
  }
  return withTrack(project, trackIndex, clips);
}

/** Appends a clip to the end of a track. */
export function appendClip(project: Project, trackId: string, clip: Clip): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return project;
  return insertClip(project, trackId, clip, track.kind === 'main' ? Number.POSITIVE_INFINITY : trackEnd(track));
}

/** The first track of a kind that has room for `length` seconds at `time`, or the first of that kind. */
export function trackFor(project: Project, kind: TrackKind, time: number, length: number): Track | null {
  const tracks = project.tracks.filter((t) => t.kind === kind);
  if (tracks.length === 0) return null;
  if (kind === 'main') return tracks[0];
  return tracks.find((t) => freeStart(t, time, length) === Math.max(0, time)) ?? tracks[0];
}

/**
 * Moves a clip to `targetTrackId` at timeline `time`. Works within a track (a
 * reorder on main, a new start elsewhere) and between compatible tracks
 * (main ↔ overlay, audio ↔ audio).
 */
export function moveClip(project: Project, id: string, targetTrackId: string, time: number): Project {
  const where = findClip(project, id);
  const targetIndex = project.tracks.findIndex((t) => t.id === targetTrackId);
  if (!where || targetIndex < 0) return project;
  const target = project.tracks[targetIndex];
  if (!trackAccepts(target.kind, where.clip.type)) return project;
  const clip = where.clip;
  if (where.trackIndex === targetIndex) {
    const clips = where.track.clips.slice();
    if (target.kind === 'main') {
      clips.splice(where.clipIndex, 1);
      const rest = { ...target, clips };
      clips.splice(clamp(dropIndex(rest, time), 0, clips.length), 0, clip);
    } else {
      clips[where.clipIndex] = { ...clip, start: freeStart(target, time, clipLength(clip), clip.id) };
    }
    return withTrack(project, targetIndex, clips);
  }
  const removed = withTrack(project, where.trackIndex, where.track.clips.filter((c) => c.id !== id));
  let moved: Clip = clip;
  if (isMedia(clip) && target.kind !== 'main') moved = { ...clip, transition: { ...clip.transition, kind: 'none' } };
  return insertClip(removed, targetTrackId, moved, time);
}

/** Deletes a clip. On the magnetic main track this is a ripple delete by nature. */
export function removeClip(project: Project, id: string): Project {
  const where = findClip(project, id);
  if (!where) return project;
  return withTrack(project, where.trackIndex, where.track.clips.filter((c) => c.id !== id));
}

/** A copy placed right after the original; returns the project and the new id. */
export function duplicateClip(project: Project, id: string): { project: Project; id: string | null } {
  const where = findClip(project, id);
  if (!where) return { project, id: null };
  const copy = { ...copyClip(where.clip), id: newId(where.clip.type === 'text' ? 't' : 'c') } as Clip;
  const clips = where.track.clips.slice();
  if (where.track.kind === 'main') {
    if (isMedia(copy)) copy.transition = { ...copy.transition, kind: 'none' };
    clips.splice(where.clipIndex + 1, 0, copy);
    return { project: withTrack(project, where.trackIndex, clips), id: copy.id };
  }
  const span = layoutTrack(where.track)[where.clipIndex];
  copy.start = freeStart(where.track, span.end, clipLength(copy));
  clips.push(copy);
  return { project: withTrack(project, where.trackIndex, clips), id: copy.id };
}

export interface SplitResult {
  project: Project;
  /** Ids of the two halves, or null when the cut missed. */
  left: string | null;
  right: string | null;
}

/**
 * Cuts one clip at timeline `time`. The left half keeps the clip's entry (its
 * transition, fade-in and title in-animation), the right half keeps its exit, so
 * the film looks and sounds the same until something else is changed. A cut
 * closer than MIN_CLIP to either edge is refused.
 */
export function splitClip(project: Project, id: string, time: number): SplitResult {
  const miss: SplitResult = { project, left: null, right: null };
  const where = findClip(project, id);
  if (!where) return miss;
  const p = layoutTrack(where.track)[where.clipIndex];
  if (time - p.start < MIN_CLIP || p.end - time < MIN_CLIP) return miss;
  let left: Clip;
  let right: Clip;
  const clip = where.clip;
  if (clip.type === 'text') {
    left = { ...copyClip(clip), id: newId('t'), duration: time - p.start, animOut: 'none' };
    right = { ...copyClip(clip), id: newId('t'), start: time, duration: p.end - time, animIn: 'none' };
  } else {
    const at = clip.type === 'image' ? time - p.start : sourceTimeAt(clip, p.start, time);
    left = { ...copyClip(clip), id: newId('c'), out: at, fadeOut: 0 };
    right = {
      ...copyClip(clip),
      id: newId('c'),
      start: time,
      in: clip.type === 'image' ? 0 : at,
      out: clip.type === 'image' ? p.end - time : clip.out,
      fadeIn: 0,
      transition: { ...clip.transition, kind: 'none' },
    };
  }
  const clips = where.track.clips.slice();
  clips.splice(where.clipIndex, 1, left, right);
  return { project: withTrack(project, where.trackIndex, clips), left: left.id, right: right.id };
}

/**
 * Splits what sits under the playhead: the selected clip when the playhead is
 * inside it, otherwise the main-track clip at that time.
 */
export function splitAtPlayhead(project: Project, time: number, selectedId: string | null): SplitResult {
  if (selectedId) {
    const span = clipSpan(project, selectedId);
    if (span && time > span.start && time < span.end) return splitClip(project, selectedId, time);
  }
  const main = mainTrack(project);
  const index = mainIndexAt(project, time);
  if (index < 0) return { project, left: null, right: null };
  return splitClip(project, main.clips[index].id, time);
}

/**
 * Moves one edge of a clip by `delta` timeline seconds.
 *
 * `edge === 'start'` trims the head (positive delta = shorter); `'end'` moves the
 * tail (positive delta = longer). Source ranges never leave the file, and no clip
 * becomes shorter than MIN_CLIP. On the magnetic main track the clips after it
 * follow by themselves; on other tracks the tail stays put while the head moves.
 */
export function trimClip(project: Project, id: string, edge: 'start' | 'end', delta: number): Project {
  const where = findClip(project, id);
  if (!where || !Number.isFinite(delta)) return project;
  const clip = where.clip;
  const main = where.track.kind === 'main';
  if (clip.type === 'text') {
    const end = clip.start + clip.duration;
    if (edge === 'start') {
      const start = clamp(clip.start + delta, 0, end - MIN_CLIP);
      return updateClip(project, { ...clip, start, duration: end - start });
    }
    return updateClip(project, { ...clip, duration: Math.max(MIN_CLIP, clip.duration + delta) });
  }
  const speed = clip.type === 'image' ? 1 : clampSpeed(clip.speed);
  const minSource = MIN_CLIP * speed;
  const unlimited = clip.type === 'image' || !(clip.sourceDuration > 0);
  if (edge === 'start') {
    if (clip.type === 'image') {
      // A still has no source position to move: trimming its head shortens it.
      const length = clamp(clip.out - delta, MIN_CLIP, Number.POSITIVE_INFINITY);
      const moved = clip.out - length;
      return updateClip(project, { ...clip, out: length, start: main ? clip.start : Math.max(0, clip.start + moved) });
    }
    let nextIn = clamp(clip.in + delta * speed, 0, clip.out - minSource);
    let start = clip.start + (nextIn - clip.in) / speed;
    if (!main && start < 0) {
      nextIn += -start * speed;
      start = 0;
    }
    return updateClip(project, { ...clip, in: nextIn, start: main ? clip.start : start });
  }
  const limit = unlimited ? Number.POSITIVE_INFINITY : clip.sourceDuration;
  const nextOut = clamp(clip.out + delta * speed, clip.in + minSource, limit);
  return updateClip(project, { ...clip, out: nextOut });
}

/** Trims the clip's head or tail to the playhead (I / O, CapCut's Q / W). */
export function trimToPlayhead(project: Project, id: string, edge: 'start' | 'end', time: number): Project {
  const span = clipSpan(project, id);
  if (!span || !(time > span.start && time < span.end)) return project;
  return edge === 'start'
    ? trimClip(project, id, 'start', time - span.start)
    : trimClip(project, id, 'end', time - span.end);
}

/**
 * Separates a video clip's sound onto an audio track: the new audio clip covers
 * exactly the same source range at the same time, and the video clip is muted.
 */
export function detachAudio(project: Project, id: string): { project: Project; id: string | null } {
  const where = findClip(project, id);
  if (!where || where.clip.type !== 'video') return { project, id: null };
  const clip = where.clip;
  const span = layoutTrack(where.track)[where.clipIndex];
  const length = span.end - span.start;
  const audio: MediaClip = {
    ...copyClip(clip),
    id: newId('c'),
    type: 'audio',
    start: span.start,
    transition: { kind: 'none', duration: clip.transition.duration },
    muted: false,
    scale: 1,
    x: 0.5,
    y: 0.5,
  };
  const muted = updateClip(project, { ...clip, muted: true });
  const target = trackFor(muted, 'audio', span.start, length);
  if (!target) return { project, id: null };
  const trackIndex = muted.tracks.findIndex((t) => t.id === target.id);
  const clips = [...target.clips, { ...audio, start: freeStart(target, span.start, length) }];
  return { project: withTrack(muted, trackIndex, clips), id: audio.id };
}

/* ─────────────────────────────── snapping ─────────────────────────────── */

/** Every clip edge on every track, plus zero and the playhead. */
export function snapPoints(project: Project, playhead: number, exclude: readonly string[] = []): number[] {
  const skip = new Set(exclude);
  const points = new Set<number>([0, playhead]);
  for (const track of project.tracks) {
    for (const p of layoutTrack(track)) {
      if (skip.has(p.clip.id)) continue;
      points.add(p.start);
      points.add(p.end);
    }
  }
  return [...points].filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
}

/** Pulls `time` onto the nearest point within `threshold` seconds. */
export function snapTime(time: number, points: readonly number[], threshold: number): { time: number; snapped: number | null } {
  let best: number | null = null;
  let bestDistance = threshold;
  for (const p of points) {
    const d = Math.abs(p - time);
    if (d <= bestDistance) {
      best = p;
      bestDistance = d;
    }
  }
  return best === null ? { time, snapped: null } : { time: best, snapped: best };
}

/** Snaps a moving block by whichever of its two edges is closer to a point. */
export function snapBlock(start: number, length: number, points: readonly number[], threshold: number): { start: number; snapped: number | null } {
  const head = snapTime(start, points, threshold);
  const tail = snapTime(start + length, points, threshold);
  const headD = head.snapped === null ? Infinity : Math.abs(head.time - start);
  const tailD = tail.snapped === null ? Infinity : Math.abs(tail.time - (start + length));
  if (headD === Infinity && tailD === Infinity) return { start, snapped: null };
  if (headD <= tailD) return { start: head.time, snapped: head.snapped };
  return { start: tail.time - length, snapped: tail.snapped };
}

/* ─────────────────────────────── zoom and ruler ─────────────────────────────── */

export const MIN_ZOOM = 2;
export const MAX_ZOOM = 600;

/** Pixels per second, clamped. The top end shows single frames at 30 fps. */
export function clampZoom(pxPerSecond: number): number {
  return clamp(finite(pxPerSecond, 60), MIN_ZOOM, MAX_ZOOM);
}

/** A zoom that fits `duration` into `width` pixels, with a little air at the end. */
export function fitZoom(duration: number, width: number): number {
  if (!(duration > 0) || !(width > 0)) return 60;
  return clampZoom((width * 0.9) / duration);
}

export const timeToX = (time: number, pxPerSecond: number): number => time * pxPerSecond;
export const xToTime = (x: number, pxPerSecond: number): number => (pxPerSecond > 0 ? Math.max(0, x / pxPerSecond) : 0);

const TICK_STEPS = [1 / 30, 2 / 30, 5 / 30, 10 / 30, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

/** The smallest "nice" step whose labels are at least `minPx` apart. */
export function tickStep(pxPerSecond: number, minPx = 72): number {
  for (const step of TICK_STEPS) if (step * pxPerSecond >= minPx) return step;
  return TICK_STEPS[TICK_STEPS.length - 1];
}

export interface Tick {
  time: number;
  /** Labelled tick; the minor ones in between are drawn shorter. */
  major: boolean;
}

/** Ticks covering `[from, to]`: majors at `tickStep`, minors between them. */
export function rulerTicks(from: number, to: number, pxPerSecond: number): Tick[] {
  const step = tickStep(pxPerSecond);
  const divisions = step <= 1 / 30 + 1e-9 ? 1 : 5;
  const minor = step / divisions;
  const ticks: Tick[] = [];
  const first = Math.max(0, Math.floor(from / minor));
  const last = Math.ceil(to / minor);
  for (let i = first; i <= last && ticks.length < 5000; i++) {
    ticks.push({ time: i * minor, major: i % divisions === 0 });
  }
  return ticks;
}

/** A timecode `mm:ss:ff` at 30 fps (hours prefixed only when there are any). */
export function timecode(time: number, fps = 30): string {
  const totalFrames = Math.max(0, Math.round((Number.isFinite(time) ? time : 0) * fps));
  const frames = totalFrames % fps;
  const totalSeconds = (totalFrames - frames) / fps;
  const seconds = totalSeconds % 60;
  const totalMinutes = (totalSeconds - seconds) / 60;
  const minutes = totalMinutes % 60;
  const hours = (totalMinutes - minutes) / 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
  return hours > 0 ? `${hours}:${base}` : base;
}

/* ─────────────────────────────── frame size ─────────────────────────────── */

export const ASPECTS: Record<Exclude<AspectKey, 'auto'>, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
  '4:3': 4 / 3,
};

function even(size: { width: number; height: number }): { width: number; height: number } {
  const e = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: e(size.width), height: e(size.height) };
}

/**
 * The frame the film is composed in. `auto` follows the first main-track clip
 * (after its rotation and crop); a fixed ratio uses a 1080-line frame.
 */
export function frameSize(aspect: AspectKey, firstClip: { width: number; height: number } | null): { width: number; height: number } {
  if (aspect === 'auto') {
    if (firstClip && firstClip.width > 0 && firstClip.height > 0) return even(firstClip);
    return { width: 1920, height: 1080 };
  }
  const ratio = ASPECTS[aspect];
  return ratio >= 1 ? even({ width: 1080 * ratio, height: 1080 }) : even({ width: 1080, height: 1080 / ratio });
}

export type ResolutionKey = 'source' | '1080' | '720' | '480';

/** Scales a frame so its short side is the preset's line count; `source` is capped at 4K. */
export function exportDimensions(frame: { width: number; height: number }, preset: ResolutionKey): { width: number; height: number } {
  const w = Math.max(2, frame.width);
  const h = Math.max(2, frame.height);
  if (preset === 'source') {
    const scale = Math.min(1, 3840 / Math.max(w, h));
    return even({ width: w * scale, height: h * scale });
  }
  const scale = Number(preset) / Math.min(w, h);
  return even({ width: w * scale, height: h * scale });
}

export type QualityKey = 'high' | 'medium' | 'low';

const BITS_PER_PIXEL: Record<QualityKey, number> = { high: 0.16, medium: 0.09, low: 0.05 };

/** Target video bitrate for a size, rate and quality, held within sane bounds. */
export function videoBitrate(size: { width: number; height: number }, fps: number, quality: QualityKey): number {
  const raw = size.width * size.height * clamp(finite(fps, 30), 1, 120) * BITS_PER_PIXEL[quality];
  return Math.round(clamp(raw, 400_000, 24_000_000));
}

/** Rough output size in bytes, for the export dialog. */
export function estimateExportBytes(seconds: number, videoBps: number, audioBps: number): number {
  return Math.round((Math.max(0, seconds) * (videoBps + audioBps)) / 8);
}

/* ─────────────────────────────── serialisation helpers ─────────────────────────────── */

/** A deep, independent copy — what undo keeps. */
export function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project;
}

/** Media ids the project refers to. */
export function usedMediaIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const clip of allClips(project)) if (isMedia(clip)) ids.add(clip.mediaId);
  return ids;
}
