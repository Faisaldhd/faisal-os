/**
 * Time maths for the video app — pure, no DOM.
 *
 * Every value here is seconds (fractional) unless the name says otherwise.
 * `Number.isFinite` guards matter: a media element reports `NaN` for `duration`
 * before metadata is loaded, and `NaN` leaking into a range calculation silently
 * produces an empty timeline instead of a visible error.
 */

/** A half-open time range over the source file: `[start, end)`. */
export interface TimeRange {
  start: number;
  end: number;
}

/** Trim selection in seconds. `end === null` means "to the end of the file". */
export interface TrimSelection {
  in: number;
  out: number | null;
}

export const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

/** A finite, non-negative duration; anything unreadable becomes 0. */
export function safeDuration(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** A finite position inside `[0, duration]`. */
export function clampTime(value: number, duration: number): number {
  const d = safeDuration(duration);
  if (!Number.isFinite(value)) return 0;
  return clamp(value, 0, d);
}

/** The trim selection with `out === null` resolved against the real duration. */
export function resolvedTrim(trim: TrimSelection, duration: number): TimeRange {
  const d = safeDuration(duration);
  const start = clampTime(trim.in, d);
  const out = trim.out === null ? d : clampTime(trim.out, d);
  return { start, end: Math.max(start, out) };
}

/** True when the selection covers nothing (a zero or inverted range). */
export function isEmptyRange(range: TimeRange): boolean {
  return !(range.end > range.start);
}

export function rangeLength(range: TimeRange): number {
  return Math.max(0, range.end - range.start);
}

/** The whole file as a range. */
export function wholeRange(duration: number): TimeRange {
  return { start: 0, end: safeDuration(duration) };
}

/** "1:02:03.400" (hours only when they exist), for toolbars and clip rows. */
export function formatTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMs = Math.round(s * 1000);
  const ms = totalMs % 1000;
  const totalSec = (totalMs - ms) / 1000;
  const sec = totalSec % 60;
  const totalMin = (totalSec - sec) / 60;
  const min = totalMin % 60;
  const hours = (totalMin - min) / 60;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const base = hours > 0 ? `${hours}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
  return `${base}.${pad(ms, 3)}`;
}

/** The same shape without milliseconds — friendlier for a duration badge. */
export function formatDuration(seconds: number): string {
  const parts = formatTime(seconds).split('.');
  return parts[0];
}

/** Nominal frame length of a 30 fps timeline; the real value comes from the media. */
export const DEFAULT_FPS = 30;

/** A frame duration for stepping: the measured fps when known, else 30. */
export function frameDuration(fps: number | null | undefined): number {
  const value = typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  return 1 / value;
}

/**
 * One frame forward/back from `position`, clamped to the file.
 *
 * Stepping back from a position that is not exactly on a frame boundary lands one
 * frame *before* the current one, which is what "previous frame" means when the
 * player stopped mid-frame.
 */
export function stepTime(position: number, direction: -1 | 1, fps: number | null | undefined, duration: number): number {
  const d = safeDuration(duration);
  const now = clampTime(position, d);
  const step = frameDuration(fps);
  if (direction === 1) {
    const next = Math.floor(now / step + 1e-6) + 1;
    return clampTime(next * step, d);
  }
  const prev = Math.ceil(now / step - 1e-6) - 1;
  return clampTime(prev * step, d);
}

/** Between 0 and 1 for a progress bar; an unknown duration yields 0, never NaN. */
export function progressFraction(position: number, duration: number): number {
  const d = safeDuration(duration);
  if (d === 0) return 0;
  return clamp(position / d, 0, 1);
}

/** Estimated output size in bytes for a known bitrate; `null` when it cannot be known. */
export function estimateBytes(seconds: number, bitrate: number | null): number | null {
  if (bitrate === null || !Number.isFinite(bitrate) || bitrate <= 0) return null;
  const s = Math.max(0, seconds);
  return Math.round((s * bitrate) / 8);
}

/** Milliseconds → a `-ss`-style token used in generated file names. */
export function timestampToken(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
