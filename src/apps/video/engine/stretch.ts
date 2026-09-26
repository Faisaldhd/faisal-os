/**
 * Video Editor — pitch-preserving time stretch (pure maths, no DOM, no library).
 *
 * The offline mix renders a clip by resampling it (`playbackRate`), which is exactly what makes
 * a sped-up voice sound like a chipmunk: the waveform is squeezed, so every frequency in it
 * moves. This module changes the DURATION without touching the waveform's own frequency.
 *
 * It is WSOLA (waveform-similarity overlap-add), the classic small-footprint method:
 *   • the signal is cut into windowed frames and laid back down at a fixed synthesis hop;
 *   • the analysis hop is the synthesis hop × speed, which is what makes the result shorter;
 *   • before each frame is copied, a short search finds the nearby start whose samples best match
 *     the natural continuation of the previous frame (normalised cross-correlation), so the
 *     overlap regions stay phase-continuous — and a phase-continuous copy of a 440Hz tone is
 *     still a 440Hz tone.
 * Nothing here resamples: the sample RATE never changes, only where each frame is read from.
 *
 * The outputs are normalised by the accumulated window, so a steady tone comes out at the same
 * amplitude it went in, and every channel of one stretch shares the SAME alignment (the search
 * runs once on the mono mix) — otherwise a stereo pair would smear apart.
 */
import { MAX_SPEED, MIN_SPEED } from '../project';

export interface StretchOptions {
  /** Sample rate of the input, for the frame and search windows. Default 48000. */
  sampleRate?: number;
  /** Frame length in seconds (default 0.05 = 50ms). */
  frameSec?: number;
  /** Similarity search window in seconds, each side of the nominal start (default 0.008). */
  searchSec?: number;
}

/** The shortest similarity window worth correlating, in samples. */
const MIN_SIM = 24;
/** Comparing every sample is wasteful; every third is enough to find the best alignment. */
const STRIDE = 3;

export interface StretchPlan {
  /** Analysis frame length in samples (even, so the window halves line up). */
  frame: number;
  /** Synthesis hop: frames are laid down this far apart. Half the frame keeps the window flat. */
  hop: number;
  /** Analysis hop: how far the read position advances per frame (`hop × speed`). */
  hopA: number;
  /** How far around the nominal read position the search looks, in samples. */
  search: number;
  /** Length of the sample window the correlation compares. */
  sim: number;
  /** Frames in the result. */
  outLen: number;
  /** The overlap-add window (Hann), precomputed once per plan. */
  win: Float32Array;
}

/** The clamped, finite speed the rest of the module works with. */
export function safeSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/**
 * True when a stretch has to fall back to a plain resample — a clip too short to hold a couple of
 * frames (well under a tenth of a second), where the pitch is not preserved. Callers report that
 * honestly instead of claiming a guarantee they did not deliver.
 */
export function stretchResamples(inputFrames: number, speed: number, options: StretchOptions = {}): boolean {
  if (Math.abs(safeSpeed(speed) - 1) < 1e-3) return false;
  const n = Math.max(0, Math.floor(inputFrames));
  const plan = stretchPlan(n, speed, options);
  return n > 2 && n < 4 * plan.win.length;
}

/** How many frames a stretch of `speed` produces (speed > 1 = shorter, pitch unchanged). */
export function stretchedFrames(inputFrames: number, speed: number): number {
  const n = Math.max(0, Math.floor(Number.isFinite(inputFrames) ? inputFrames : 0));
  return Math.max(0, Math.round(n / safeSpeed(speed)));
}

/**
 * The frame/hop/window geometry for one stretch. Exported because it is the part worth pinning
 * in a test: a plan that is wrong by a factor makes every later decision wrong too.
 */
export function stretchPlan(inputFrames: number, speed: number, options: StretchOptions = {}): StretchPlan {
  const s = safeSpeed(speed);
  const rate = Math.max(1, Math.round(options.sampleRate ?? 48000));
  const inLen = Math.max(0, Math.floor(Number.isFinite(inputFrames) ? inputFrames : 0));
  // A frame of 50ms, but never longer than the clip can hold two of.
  const wantFrame = Math.max(2, Math.round((options.frameSec ?? 0.05) * rate));
  const frame = Math.max(2, Math.min(wantFrame, Math.max(2, Math.floor(inLen / 2)))) & ~1;
  const hop = Math.max(1, frame >> 1);
  const hopA = Math.max(1, Math.round(hop * s));
  const wantSearch = Math.max(0, Math.round((options.searchSec ?? 0.008) * rate));
  const search = Math.min(wantSearch, Math.max(0, hop - 1));
  const sim = Math.max(MIN_SIM, Math.min(hop, Math.round(0.01 * rate)));
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  return { frame, hop, hopA, search, sim, outLen: stretchedFrames(inLen, s), win };
}

/**
 * Normalised cross-correlation of the two segments starting at `a` and `b` (1 = identical shape,
 * 0 = unrelated). Normalising is what stops the search from simply preferring the loudest part.
 */
export function similarity(ref: Float32Array, a: number, b: number, len: number): number {
  const n = ref.length;
  const end = Math.min(len, n - a, n - b);
  if (end <= 1 || a < 0 || b < 0) return 0;
  let dot = 0;
  let ea = 0;
  let eb = 0;
  for (let i = 0; i < end; i++) {
    const x = ref[a + i];
    const y = ref[b + i];
    dot += x * y;
    ea += x * x;
    eb += y * y;
  }
  const den = Math.sqrt(ea * eb);
  return den > 1e-12 ? dot / den : 0;
}

/** The mono reference the alignment is decided on (the mean of the channels). */
export function monoReference(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const channel of channels) {
    const n = Math.min(out.length, channel.length);
    for (let i = 0; i < n; i++) out[i] += channel[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < out.length; i++) out[i] *= scale;
  return out;
}

/**
 * Where each output frame is read from. Frame 0 starts at the beginning, then every frame looks
 * for the start around `k × hopA` whose first samples best continue the previous frame — one
 * synthesis hop after where that frame was read (`prev + hop`), which is the whole idea.
 */
export function analysisPositions(ref: Float32Array, plan: StretchPlan): Int32Array {
  const inLen = ref.length;
  if (inLen === 0 || plan.outLen === 0) return new Int32Array(0);
  const maxStart = Math.max(0, inLen - plan.frame);
  const count = Math.floor((plan.outLen - 1) / plan.hop) + 1;
  const out = new Int32Array(count);
  let prev = 0;
  for (let k = 0; k < count; k++) {
    const nominal = Math.min(maxStart, k * plan.hopA);
    let best = nominal;
    if (k > 0 && plan.search > 0) {
      const target = Math.min(maxStart, prev + plan.hop);
      const lo = Math.max(0, nominal - plan.search);
      const hi = Math.min(maxStart, nominal + plan.search);
      let bestScore = -2;
      for (let a = lo; a <= hi; a += STRIDE) {
        const score = similarity(ref, a, target, plan.sim);
        if (score > bestScore) {
          bestScore = score;
          best = a;
        }
      }
      // The stride can step over the winner: check the very end of the window too.
      const tailScore = similarity(ref, hi, target, plan.sim);
      if (tailScore > bestScore) best = hi;
    }
    out[k] = best;
    prev = best;
  }
  return out;
}

/** Overlap-add one channel at the planned positions, normalised by the accumulated window. */
function render(input: Float32Array, plan: StretchPlan, positions: Int32Array): Float32Array {
  const out = new Float32Array(plan.outLen);
  if (plan.outLen === 0) return out;
  const { frame, hop, win } = plan;
  const inLen = input.length;
  const wsum = new Float32Array(plan.outLen);
  // Prime the head with one plain hop: a windowed first frame would divide by a near-zero sum
  // and fade the first few milliseconds in.
  const first = positions.length ? positions[0] : 0;
  const head = Math.min(hop, plan.outLen, Math.max(0, inLen - first));
  for (let i = 0; i < head; i++) {
    out[i] = input[first + i] || 0;
    wsum[i] = 1;
  }
  for (let k = 0; k < positions.length; k++) {
    const pos = k * hop;
    if (pos >= plan.outLen) break;
    const a = positions[k];
    const n = Math.min(frame, Math.max(0, inLen - a), plan.outLen - pos);
    for (let i = 0; i < n; i++) {
      const w = win[i];
      out[pos + i] += input[a + i] * w;
      wsum[pos + i] += w;
    }
  }
  for (let i = 0; i < out.length; i++) {
    const w = wsum[i];
    out[i] = w > 0.05 ? out[i] / w : 0;
  }
  return out;
}

/** One channel, stretched without changing its pitch. */
export function stretchChannel(input: Float32Array, speed: number, options: StretchOptions = {}): Float32Array {
  const s = safeSpeed(speed);
  if (Math.abs(s - 1) < 1e-3) return input.slice();
  const plan = stretchPlan(input.length, s, options);
  if (plan.outLen === 0) return new Float32Array(0);
  // Too short to frame: a plain resample is the only honest option at this size (a few ms), and
  // it is reported as such by returning the resampled copy rather than pretending otherwise.
  if (input.length < 4 * plan.win.length && input.length > 2) {
    const out = new Float32Array(plan.outLen);
    for (let i = 0; i < out.length; i++) {
      const at = i * s;
      const i0 = Math.floor(at);
      const frac = at - i0;
      const a = input[Math.min(input.length - 1, i0)];
      const b = input[Math.min(input.length - 1, i0 + 1)];
      out[i] = a + (b - a) * frac;
    }
    return out;
  }
  return render(input, plan, analysisPositions(input, plan));
}

/**
 * Every channel of one clip, stretched with a single shared alignment. The search runs on the
 * mono mix, so a stereo pair keeps its phase relationship instead of drifting apart.
 */
export function stretchChannels(
  channels: readonly Float32Array[],
  speed: number,
  options: StretchOptions = {},
): Float32Array[] {
  const s = safeSpeed(speed);
  if (!channels.length) return [];
  if (Math.abs(s - 1) < 1e-3) return channels.map((c) => c.slice());
  const ref = monoReference(channels);
  const plan = stretchPlan(ref.length, s, options);
  if (plan.outLen === 0) return channels.map(() => new Float32Array(0));
  if (ref.length < 4 * plan.win.length) return channels.map((c) => stretchChannel(c, s, options));
  const positions = analysisPositions(ref, plan);
  return channels.map((c) => render(c, plan, positions));
}
