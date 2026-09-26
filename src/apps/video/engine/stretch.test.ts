import { describe, expect, it } from 'vitest';
import { MAX_SPEED, MIN_SPEED } from '../project';
import {
  analysisPositions, monoReference, safeSpeed, similarity, stretchChannel, stretchChannels,
  stretchPlan, stretchResamples, stretchedFrames,
} from './stretch';

const RATE = 48000;

/** A pure tone of `seconds` at `hz`, amplitude 0.5. */
function tone(hz: number, seconds: number, rate = RATE, phase = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate + phase);
  return out;
}

/** Energy at one frequency (Goertzel) — enough to tell 440Hz from the 880Hz a resample would give. */
function energyAt(samples: Float32Array, hz: number, rate = RATE): number {
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / Math.max(1, samples.length);
}

/** The loudest frequency in a coarse scan — what "the pitch" actually is. */
function dominantHz(samples: Float32Array, from = 300, to = 700, step = 2, rate = RATE): number {
  let best = from;
  let bestE = -1;
  for (let hz = from; hz <= to; hz += step) {
    const e = energyAt(samples, hz, rate);
    if (e > bestE) {
      bestE = e;
      best = hz;
    }
  }
  return best;
}

/**
 * The test the brief asks for, in the same words: a 440Hz tone played at 2× keeps its pitch
 * (≈440Hz, NOT the 880Hz that resampling would produce) and its duration halves.
 */
describe('speed change keeps the pitch — the brief\'s 440Hz tone at 2×', () => {
  const input = tone(440, 0.5);
  const out = stretchChannel(input, 2, { sampleRate: RATE });

  it('keeps the frequency at ≈440Hz instead of the 880Hz a resample would give', () => {
    const at440 = energyAt(out, 440);
    const at880 = energyAt(out, 880);
    expect(dominantHz(out)).toBeGreaterThanOrEqual(434);
    expect(dominantHz(out)).toBeLessThanOrEqual(446);
    // The resampled twin would put its energy at 880: make sure that is not what happened.
    expect(at440).toBeGreaterThan(10 * at880);
  });

  it('halves the duration', () => {
    expect(out.length).toBe(stretchedFrames(input.length, 2));
    expect(Math.abs(out.length - input.length / 2)).toBeLessThanOrEqual(4);
  });

  it('keeps the level (no fade, no clipped head)', () => {
    const rms = (a: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
      return Math.sqrt(sum / Math.max(1, a.length));
    };
    // A 0.5-amplitude sine has an RMS of 0.5/√2 ≈ 0.3536; allow the edges to cost a few percent.
    expect(rms(out)).toBeGreaterThan(0.3536 * 0.9);
    expect(rms(out)).toBeLessThan(0.3536 * 1.1);
  });
});

describe('stretchPlan and stretchedFrames', () => {
  it('sizes the output from the speed and clamps the speed to the project range', () => {
    expect(stretchedFrames(48000, 2)).toBe(24000);
    expect(stretchedFrames(48000, 0.5)).toBe(96000);
    expect(stretchedFrames(48000, 1)).toBe(48000);
    expect(safeSpeed(99)).toBe(MAX_SPEED);
    expect(safeSpeed(0.01)).toBe(MIN_SPEED);
    expect(safeSpeed(0)).toBe(1);
    expect(safeSpeed(Number.NaN)).toBe(1);
  });

  it('lays frames down at half the frame length and reads them a speed further apart', () => {
    const plan = stretchPlan(48000, 2, { sampleRate: RATE });
    expect(plan.frame).toBe(2400); // 50ms at 48k
    expect(plan.hop).toBe(1200);
    expect(plan.hopA).toBe(2400);
    expect(plan.win.length).toBe(plan.frame);
    // Hann at hop = frame/2 sums to 1, which is why the overlap-add keeps the level.
    expect(plan.win[0]).toBeCloseTo(0, 6);
    expect(plan.win[plan.frame / 2]).toBeCloseTo(1, 6);
    expect(plan.win[plan.frame - 1]).toBeGreaterThan(0);
  });

  it('never asks for a frame longer than the clip can hold', () => {
    const plan = stretchPlan(100, 2, { sampleRate: RATE });
    expect(plan.frame).toBeLessThanOrEqual(100);
    expect(plan.frame % 2).toBe(0);
    expect(plan.hop).toBeGreaterThan(0);
  });
});

describe('analysisPositions — the alignment the whole method rests on', () => {
  it('finds the period-aligned start, so the copied frames stay phase-continuous', () => {
    const ref = tone(440, 0.3);
    const plan = stretchPlan(ref.length, 2, { sampleRate: RATE });
    const positions = analysisPositions(ref, plan);
    expect(positions.length).toBeGreaterThan(5);
    expect(positions[0]).toBe(0);
    // Every step lands within the search window of the nominal read position.
    for (let k = 1; k < positions.length; k++) {
      expect(Math.abs(positions[k] - k * plan.hopA)).toBeLessThanOrEqual(plan.search);
    }
    // And the chosen segment really does continue the previous one (a sine repeats itself).
    for (let k = 1; k < Math.min(positions.length, 8); k++) {
      const prev = positions[k - 1];
      const score = similarity(ref, positions[k], Math.min(ref.length - plan.frame, prev + plan.hop), plan.sim);
      expect(score).toBeGreaterThan(0.99);
    }
  });

  it('is monotone enough to actually advance through the clip', () => {
    const ref = tone(220, 1);
    const plan = stretchPlan(ref.length, 2, { sampleRate: RATE });
    const positions = analysisPositions(ref, plan);
    const last = positions[positions.length - 1];
    expect(last).toBeGreaterThan(ref.length * 0.8);
  });
});

describe('stretchChannels — every speed in the range, both channels together', () => {
  it('keeps ≈440Hz at 0.5×, 1.5×, 2× and 4×', () => {
    const input = tone(440, 0.4);
    for (const speed of [0.5, 1.5, 2, 4]) {
      const out = stretchChannel(input, speed, { sampleRate: RATE });
      const frames = stretchedFrames(input.length, speed);
      expect(Math.abs(out.length - frames)).toBeLessThanOrEqual(4);
      const hz = dominantHz(out);
      expect(hz, `speed ${speed}×`).toBeGreaterThanOrEqual(432);
      expect(hz, `speed ${speed}×`).toBeLessThanOrEqual(448);
    }
  });

  it('stretches a slower speed to a longer file at the same pitch', () => {
    const input = tone(440, 0.3);
    const out = stretchChannel(input, 0.25, { sampleRate: RATE });
    expect(out.length).toBeGreaterThan(input.length * 3.9);
    expect(dominantHz(out)).toBeGreaterThanOrEqual(432);
    expect(dominantHz(out)).toBeLessThanOrEqual(448);
  });

  it('leaves 1× alone, sample for sample', () => {
    const input = tone(440, 0.1);
    const out = stretchChannel(input, 1, { sampleRate: RATE });
    expect(out.length).toBe(input.length);
    for (let i = 0; i < input.length; i++) expect(out[i]).toBe(input[i]);
  });

  it('gives both channels the same alignment, so the stereo image survives', () => {
    const left = tone(440, 0.3);
    const right = tone(440, 0.3, RATE, Math.PI / 2);
    const [l, r] = stretchChannels([left, right], 2, { sampleRate: RATE });
    expect(l.length).toBe(r.length);
    // The 90° phase difference between the channels is still there (equal energy, non-identical).
    let same = 0;
    for (let i = 0; i < l.length; i++) if (Math.abs(l[i] - r[i]) < 1e-9) same++;
    expect(same).toBeLessThan(l.length * 0.01);
    expect(dominantHz(l)).toBeGreaterThanOrEqual(432);
    expect(dominantHz(r)).toBeGreaterThanOrEqual(432);
  });

  it('handles silence, a single frame and an empty input without producing NaN', () => {
    const silence = new Float32Array(RATE);
    const stretched = stretchChannel(silence, 2, { sampleRate: RATE });
    expect(stretched.length).toBe(RATE / 2);
    expect(stretched.every((v) => v === 0)).toBe(true);
    const tiny = new Float32Array([0, 0.5, -0.5, 0.25, 0, -0.25, 0.1, -0.1]);
    const tinyOut = stretchChannel(tiny, 2, { sampleRate: RATE });
    expect(tinyOut.length).toBe(stretchedFrames(tiny.length, 2));
    for (const v of tinyOut) expect(Number.isFinite(v)).toBe(true);
    expect(stretchChannel(new Float32Array(0), 2)).toEqual(new Float32Array(0));
    expect(stretchChannels([], 2)).toEqual([]);
  });

  it('mixes down channels for the search, but never resamples them', () => {
    const a = tone(440, 0.2);
    const b = tone(880, 0.2);
    const mono = monoReference([a, b]);
    expect(mono.length).toBe(a.length);
    expect(mono[10]).toBeCloseTo((a[10] + b[10]) / 2, 6);
    const [sa, sb] = stretchChannels([a, b], 2, { sampleRate: RATE });
    expect(sa.length).toBe(sb.length);
    expect(dominantHz(sa, 300, 1200, 2)).toBeGreaterThanOrEqual(434);
    expect(dominantHz(sb, 600, 1400, 2)).toBeGreaterThanOrEqual(868);
  });

  it('says plainly when a clip is too short to stretch, so a caller can tell the user', () => {
    expect(stretchResamples(48000, 2, { sampleRate: RATE })).toBe(false);
    expect(stretchResamples(1000, 2, { sampleRate: RATE })).toBe(true);
    expect(stretchResamples(48000, 1, { sampleRate: RATE })).toBe(false);
  });
});
