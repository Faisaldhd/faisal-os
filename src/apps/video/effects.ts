/**
 * Video Editor — clip effects: fade to black, blur, dark frame (pure, no DOM).
 *
 * Everything here is a number as a function of the clip's own clock, so the preview and the
 * export agree by construction: both draw through the compositor, the compositor asks these
 * functions "how black is this frame, right now", and neither path owns a second copy of the
 * curve. That is the lesson this app learned twice — what you see must be what is written.
 */

export interface ClipEffects {
  /** Seconds of fade up from black at the clip's start (0 = none). */
  fadeIn: number;
  /** Seconds of fade down to black at the clip's end (0 = none). */
  fadeOut: number;
  /** Blur strength, 0…1 (0 = sharp). */
  blur: number;
  /** Dark frame strength, 0…1 (0 = none). */
  dark: number;
}

export const NO_EFFECTS: ClipEffects = { fadeIn: 0, fadeOut: 0, blur: 0, dark: 0 };

/** The longest fade the inspector offers, in seconds. */
export const MAX_FADE = 5;
/** The blur radius at full strength, as a fraction of the frame's smaller side. */
const BLUR_FRACTION = 0.012;

function num(value: unknown, min: number, max: number, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Anything read from a project file passes through here: unknown fields go, values are clamped. */
export function normalizeEffects(value: unknown): ClipEffects {
  if (!value || typeof value !== 'object') return { ...NO_EFFECTS };
  const raw = value as Partial<ClipEffects>;
  return {
    fadeIn: num(raw.fadeIn, 0, MAX_FADE),
    fadeOut: num(raw.fadeOut, 0, MAX_FADE),
    blur: num(raw.blur, 0, 1),
    dark: num(raw.dark, 0, 1),
  };
}

export function hasEffects(effects: ClipEffects | undefined | null): boolean {
  if (!effects) return false;
  return effects.fadeIn > 0 || effects.fadeOut > 0 || effects.blur > 0 || effects.dark > 0;
}

/**
 * How black the frame is at `local` seconds into a clip of `duration`: 1 = fully black.
 *
 * Fading in runs from the start towards `fadeIn`; fading out runs the last `fadeOut` seconds.
 * They are combined with `max`, so a clip shorter than its own fades still never goes past
 * fully black, and the middle of such a clip is the darker of the two.
 */
export function blackoutAt(effects: ClipEffects, local: number, duration: number): number {
  const at = Number.isFinite(local) ? local : 0;
  // An unknown clip length has no last second, so a fade out simply never starts.
  const total = Number.isFinite(duration) ? Math.max(0, duration) : Number.POSITIVE_INFINITY;
  let black = 0;
  if (effects.fadeIn > 0) black = Math.max(black, clamp01(1 - at / effects.fadeIn));
  if (effects.fadeOut > 0) black = Math.max(black, clamp01(1 - (total - at) / effects.fadeOut));
  return black;
}

/** Blur strength at this moment (constant today, but the signature keeps the door open). */
export function blurAt(effects: ClipEffects, _local: number, _duration: number): number {
  return clamp01(effects.blur);
}

/** Dark-frame strength at this moment. */
export function darkAt(effects: ClipEffects, _local: number, _duration: number): number {
  return clamp01(effects.dark);
}

/** The blur radius in canvas pixels for a frame of this size. */
export function blurPixels(strength: number, frame: { width: number; height: number }): number {
  const s = clamp01(strength);
  if (s <= 0) return 0;
  return Math.max(1, Math.min(frame.width, frame.height) * BLUR_FRACTION * s);
}

/** The canvas `filter` value for a clip: the colour grade it already had, plus its blur. */
export function effectFilter(colour: string, blur: number): string {
  const parts = colour && colour !== 'none' ? [colour] : [];
  if (blur > 0.01) parts.push(`blur(${blur.toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

/** The dark frame drawn over a clip: a border of this many pixels, at this opacity. */
export function darkFrame(strength: number, rect: { width: number; height: number }): { border: number; alpha: number } {
  const s = clamp01(strength);
  if (s <= 0) return { border: 0, alpha: 0 };
  const shortest = Math.max(1, Math.min(rect.width, rect.height));
  return { border: Math.max(2, shortest * 0.06 * s), alpha: Math.min(0.92, 0.35 + 0.5 * s) };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
