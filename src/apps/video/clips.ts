/**
 * Clip maths for the video app — pure, no DOM, no media element.
 *
 * A *clip* is one range of the source file. The export plays the clips in list
 * order and records the result, so the list *is* the edit: reordering it reorders
 * the output, deleting from it deletes from the output.
 *
 * All times are seconds; clip ranges are half-open `[start, end)`.
 */
import { clamp, clampTime, isEmptyRange, rangeLength, safeDuration, type TimeRange } from './time';

export type Rotation = 0 | 90 | 180 | 270;

export interface FlipState {
  horizontal: boolean;
  vertical: boolean;
}

/** A normalised crop rectangle: all four values are fractions of the source. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoTransform {
  rotation: Rotation;
  flip: FlipState;
  crop: CropRect;
}

export interface Clip {
  /** Stable id, used only for DOM keys and removal — never shown. */
  id: string;
  /** Absolute VFS path of the source file. All clips share the same file. */
  path: string;
  range: TimeRange;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

export const DEFAULT_TRANSFORM: VideoTransform = {
  rotation: 0,
  flip: { horizontal: false, vertical: false },
  crop: { ...FULL_CROP },
};

/** Smallest crop the UI allows, so a drag can never produce a zero-size frame. */
export const MIN_CROP = 0.05;

let clipSeq = 0;

export function nextClipId(): string {
  clipSeq += 1;
  return `clip-${clipSeq}`;
}

/** Only for tests: makes ids deterministic. */
export function resetClipIds(): void {
  clipSeq = 0;
}

/* ───────────────────────────── trim selection ───────────────────────────── */

export interface TrimState {
  in: number;
  out: number | null;
}

/** Sets the in point, never letting it pass the out point. */
export function setIn(trim: TrimState, at: number, duration: number): TrimState {
  const d = safeDuration(duration);
  const value = clampTime(at, d);
  const out = trim.out === null ? null : Math.max(value, clampTime(trim.out, d));
  return { in: value, out };
}

/** Sets the out point; a missing duration means "unknown", so the value is kept. */
export function setOut(trim: TrimState, at: number, duration: number): TrimState {
  const d = safeDuration(duration);
  const value = d === 0 ? at : clampTime(at, d);
  return { in: Math.min(trim.in, value), out: value };
}

export function clearTrim(): TrimState {
  return { in: 0, out: null };
}

/** Splits one range at `at`; returns the two halves, or null when the cut misses it. */
export function splitRange(range: TimeRange, at: number): [TimeRange, TimeRange] | null {
  if (isEmptyRange(range)) return null;
  if (!(at > range.start && at < range.end)) return null;
  return [
    { start: range.start, end: at },
    { start: at, end: range.end },
  ];
}

/** Replaces the clip at `index` with the two halves of a split at `at`. */
export function splitClipAt(clips: Clip[], index: number, at: number): Clip[] {
  const clip = clips[index];
  if (!clip) return clips;
  const halves = splitRange(clip.range, at);
  if (!halves) return clips;
  const next = clips.slice();
  next.splice(index, 1, { ...clip, id: nextClipId(), range: halves[0] }, { ...clip, id: nextClipId(), range: halves[1] });
  return next;
}

/* ─────────────────────────────── clip list ─────────────────────────────── */

export function clipFromRange(path: string, range: TimeRange): Clip {
  return { id: nextClipId(), path, range: { start: range.start, end: range.end } };
}

/** Total produced length: the sum of the clip lengths, in order. */
export function totalDuration(clips: readonly Clip[]): number {
  return clips.reduce((sum, clip) => sum + rangeLength(clip.range), 0);
}

/** Where each clip starts inside the produced file. */
export function exportOffsets(clips: readonly Clip[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const clip of clips) {
    offsets.push(at);
    at += rangeLength(clip.range);
  }
  return offsets;
}

/** The offset a playhead inside clip `index` maps to in the output. */
export function outputOffset(clips: readonly Clip[], index: number, sourceTime: number): number {
  const offsets = exportOffsets(clips);
  const clip = clips[index];
  if (!clip) return 0;
  return (offsets[index] ?? 0) + clamp(sourceTime - clip.range.start, 0, rangeLength(clip.range));
}

/** The clip whose range contains `time`, or -1. */
export function clipIndexAt(clips: readonly Clip[], time: number): number {
  for (let i = 0; i < clips.length; i++) {
    const range = clips[i].range;
    if (time >= range.start && time < range.end) return i;
  }
  return -1;
}

/** Moves one clip to a new index, clamped into range. Returns a new array. */
export function moveClip(clips: readonly Clip[], from: number, to: number): Clip[] {
  const next = clips.slice();
  if (from < 0 || from >= next.length) return next;
  const target = clamp(Math.round(to), 0, next.length - 1);
  if (target === from) return next;
  const [clip] = next.splice(from, 1);
  next.splice(target, 0, clip);
  return next;
}

export function removeClip(clips: readonly Clip[], index: number): Clip[] {
  const next = clips.slice();
  if (index >= 0 && index < next.length) next.splice(index, 1);
  return next;
}

/** Drops every clip that covers no time — an empty clip would only stall the export. */
export function pruneClips(clips: readonly Clip[]): Clip[] {
  return clips.filter((clip) => !isEmptyRange(clip.range));
}

/* ──────────────────────────── transform maths ──────────────────────────── */

export function rotateBy(rotation: Rotation, delta: 90 | 180 | 270): Rotation {
  const sum = (rotation + delta) % 360;
  return (sum < 0 ? sum + 360 : sum) as Rotation;
}

export function toggleFlip(flip: FlipState, axis: 'horizontal' | 'vertical'): FlipState {
  return { ...flip, [axis]: !flip[axis] };
}

export function resetTransform(): VideoTransform {
  return { rotation: 0, flip: { horizontal: false, vertical: false }, crop: { ...FULL_CROP } };
}

/** Clamps a crop rectangle into the frame and never lets it collapse below MIN_CROP. */
export function clampCrop(crop: CropRect): CropRect {
  const width = clamp(Number.isFinite(crop.width) ? crop.width : 1, MIN_CROP, 1);
  const height = clamp(Number.isFinite(crop.height) ? crop.height : 1, MIN_CROP, 1);
  const x = clamp(Number.isFinite(crop.x) ? crop.x : 0, 0, 1 - width);
  const y = clamp(Number.isFinite(crop.y) ? crop.y : 0, 0, 1 - height);
  return { x, y, width, height };
}

/**
 * Sets one crop field from a fraction and re-clamps the rest, so a rectangle can
 * never leave the frame or collapse: the caller only ever assigns one number.
 */
export function setCropField(crop: CropRect, key: keyof CropRect, value: number): CropRect {
  if (!Number.isFinite(value)) return clampCrop(crop);
  const next: CropRect = { ...crop, [key]: value };
  if (key === 'width' || key === 'height') {
    // Growing the box shrinks the room left for its origin; clampCrop does that.
    return clampCrop(next);
  }
  return clampCrop(next);
}

/** The output frame size after a crop and a quarter-turn rotation. */
export function outputSize(source: { width: number; height: number }, transform: VideoTransform): { width: number; height: number } {
  const crop = clampCrop(transform.crop);
  const width = Math.max(1, Math.round(source.width * crop.width));
  const height = Math.max(1, Math.round(source.height * crop.height));
  return transform.rotation === 90 || transform.rotation === 270 ? { width: height, height: width } : { width, height };
}

/** Rounds down to an even number — encoders generally refuse odd dimensions. */
export function evenSize(size: { width: number; height: number }): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  return { width: even(size.width), height: even(size.height) };
}

/**
 * The numbers a canvas 2D context needs to draw the cropped, rotated, flipped
 * frame so it fills an output of `out` size. Kept here (not in the canvas code)
 * so the geometry is testable without a browser.
 */
export interface DrawPlan {
  /** Canvas transform, applied in order by the caller. */
  translateX: number;
  translateY: number;
  rotateRadians: number;
  scaleX: number;
  scaleY: number;
  /** Source rectangle to draw, in source pixels. */
  source: { x: number; y: number; width: number; height: number };
  /** Destination box inside the output canvas. */
  destination: { x: number; y: number; width: number; height: number };
}

export function drawPlan(source: { width: number; height: number }, transform: VideoTransform): DrawPlan {
  const crop = clampCrop(transform.crop);
  const sx = Math.round(source.width * crop.x);
  const sy = Math.round(source.height * crop.y);
  const sw = Math.max(1, Math.round(source.width * crop.width));
  const sh = Math.max(1, Math.round(source.height * crop.height));
  const out = outputSize(source, transform);
  const flip = transform.flip;
  return {
    translateX: out.width / 2,
    translateY: out.height / 2,
    rotateRadians: (transform.rotation * Math.PI) / 180,
    scaleX: flip.horizontal ? -1 : 1,
    scaleY: flip.vertical ? -1 : 1,
    source: { x: sx, y: sy, width: sw, height: sh },
    // The caller translates to the canvas centre first, so the destination is a
    // box centred on the origin and the flip scale mirrors it in place.
    destination: { x: -sw / 2, y: -sh / 2, width: sw, height: sh },
  };
}

/** A compact description of the transform for the status line. */
export function describeTransform(transform: VideoTransform): {
  deg: Rotation;
  h: boolean;
  v: boolean;
  cw: number;
  ch: number;
} {
  const crop = clampCrop(transform.crop);
  return {
    deg: transform.rotation,
    h: transform.flip.horizontal,
    v: transform.flip.vertical,
    cw: Math.round(crop.width * 100),
    ch: Math.round(crop.height * 100),
  };
}
