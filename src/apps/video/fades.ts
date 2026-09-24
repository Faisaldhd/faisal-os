/**
 * Fade and gain maths — pure, no DOM.
 *
 * The audio the export produces runs through the browser's Web Audio graph, where
 * the gain of one clip is a single number at a moment in time. This module turns
 * "fade in 2s, fade out 1s over a 12s result" into that number, deterministically,
 * so the curve can be tested without an AudioContext.
 */

export interface FadeConfig {
  /** Seconds at the start of the produced audio that ramp 0 → 1. */
  fadeIn: number;
  /** Seconds at the end of the produced audio that ramp 1 → 0. */
  fadeOut: number;
}

export const NO_FADE: FadeConfig = { fadeIn: 0, fadeOut: 0 };

/** A fade longer than half the result is a crossfade with no steady part; the UI caps it here. */
export const MAX_FADE_FRACTION = 0.5;

/** Clamps the two fade lengths so they cannot overlap in the middle of the result. */
export function clampFades(fades: FadeConfig, total: number): FadeConfig {
  const length = Number.isFinite(total) && total > 0 ? total : 0;
  if (length === 0) return NO_FADE;
  const cap = length * MAX_FADE_FRACTION;
  const fadeIn = Math.min(Math.max(0, Number.isFinite(fades.fadeIn) ? fades.fadeIn : 0), cap);
  const fadeOut = Math.min(Math.max(0, Number.isFinite(fades.fadeOut) ? fades.fadeOut : 0), cap);
  return { fadeIn, fadeOut };
}

/**
 * Linear gain at `at` seconds into a `total`-second result.
 *
 * With both fades at their maximum each covers exactly half, so the two ramps meet
 * in the middle at the same value and never overshoot — total gain stays in [0,1].
 */
export function gainAt(at: number, total: number, fades: FadeConfig): number {
  const length = Number.isFinite(total) && total > 0 ? total : 0;
  if (length === 0) return 1;
  const c = clampFades(fades, length);
  const t = Math.min(Math.max(0, Number.isFinite(at) ? at : 0), length);
  let gain = 1;
  if (c.fadeIn > 0 && t < c.fadeIn) gain = Math.min(gain, t / c.fadeIn);
  const outStart = length - c.fadeOut;
  if (c.fadeOut > 0 && t > outStart) gain = Math.min(gain, (length - t) / c.fadeOut);
  return Math.min(1, Math.max(0, gain));
}

/** The final gain applied to a track: the user's multiplier times the fade curve. */
export function trackGainAt(at: number, total: number, fades: FadeConfig, multiplier: number): number {
  const m = Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 1;
  return m * gainAt(at, total, fades);
}

/**
 * Gain curve samples for one finished export, one per `steps + 1` points.
 * Used to schedule the Web Audio ramp so the fade is a straight line, not a ramp
 * per animation frame.
 */
export function fadeCurve(total: number, fades: FadeConfig, steps = 20): Array<{ at: number; gain: number }> {
  const length = Number.isFinite(total) && total > 0 ? total : 0;
  const count = Math.max(2, Math.floor(steps));
  const points: Array<{ at: number; gain: number }> = [];
  for (let i = 0; i <= count; i++) {
    const at = (length * i) / count;
    points.push({ at, gain: gainAt(at, length, fades) });
  }
  return points;
}

/** The dB value of a linear multiplier, for a label the user can compare with other tools. */
export function gainDecibels(multiplier: number): number {
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 0;
  if (m === 0) return -Infinity;
  return 20 * Math.log10(m);
}

/** A short, honest description of what the fades will do. */
export function describeFades(total: number, fades: FadeConfig): { fadeIn: number; fadeOut: number; steady: number } {
  const c = clampFades(fades, total);
  return { ...c, steady: Math.max(0, total - c.fadeIn - c.fadeOut) };
}
