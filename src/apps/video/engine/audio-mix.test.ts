import { describe, expect, it } from 'vitest';
import { audibleClips, gainEnvelope, minMaxPeaks, mixDown, scheduleInRange } from './audio-mix';
import { audio, twoClips, withTrackClips } from './fixtures';

describe('minMaxPeaks', () => {
  it('keeps the lowest and highest sample of each bucket', () => {
    const { min, max } = minMaxPeaks([0.1, -0.5, 0.9, 0.2, -1, 0.3], 3);
    expect(Array.from(min)).toEqual([-0.5, 0.2, -1].map(Math.fround));
    expect(Array.from(max)).toEqual([0.1, 0.9, 0.3].map(Math.fround));
  });

  it('handles more buckets than samples and empty input', () => {
    const { min, max } = minMaxPeaks([0.5], 4);
    expect(max.length).toBe(4);
    expect(max[0]).toBe(0.5);
    expect(minMaxPeaks([], 2)).toEqual({ min: new Float32Array(2), max: new Float32Array(2) });
  });

  it('clamps out-of-range samples and bad bucket counts', () => {
    const { min, max } = minMaxPeaks([3, -3], Number.NaN);
    expect(max[0]).toBe(1);
    expect(min[0]).toBe(-1);
  });
});

describe('mixDown', () => {
  it('averages channels to the shortest length', () => {
    expect(Array.from(mixDown([new Float32Array([1, 0, 1]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5]);
    expect(mixDown([]).length).toBe(0);
  });
});

describe('gainEnvelope', () => {
  it('follows a clip fade exactly as the live mix does', () => {
    const music = audio('M', 'music', 10, { start: 0, fadeIn: 2, fadeOut: 2 });
    const p = withTrackClips(twoClips('none'), 'audio-1', [music]);
    const env = gainEnvelope(p, 'M', { start: 0, end: 10 }, 0.5);
    expect(env[0].gain).toBe(0);
    expect(env.find((e) => Math.abs(e.time - 1) < 1e-9)!.gain).toBeCloseTo(0.5, 6);
    expect(env.find((e) => Math.abs(e.time - 5) < 1e-9)!.gain).toBe(1);
    expect(env[env.length - 1].gain).toBeCloseTo(0, 3);
  });

  it('crossfades two main clips inside the overlap', () => {
    const p = twoClips('crossfade');
    const a = gainEnvelope(p, 'A', { start: 3, end: 4 }, 0.25);
    const b = gainEnvelope(p, 'B', { start: 3, end: 4 }, 0.25);
    expect(a[0].gain).toBeCloseTo(1, 6);
    expect(b[0].gain).toBeCloseTo(0, 6);
    expect(a[2].gain + b[2].gain).toBeCloseTo(1, 6);
  });

  it('is silent for an unknown clip', () => {
    expect(gainEnvelope(twoClips(), 'nope', { start: 0, end: 1 }, 0.5).every((e) => e.gain === 0)).toBe(true);
  });
});

describe('audibleClips', () => {
  it('lists main video and audio-track clips and skips muted ones', () => {
    let p = withTrackClips(twoClips('none'), 'audio-1', [audio('M', 'music', 5, { start: 1 }), audio('Q', 'quiet', 5, { start: 6, muted: true })]);
    p = withTrackClips(p, 'audio-2', [audio('Z', 'zero', 5, { start: 0, volume: 0 })]);
    const ids = audibleClips(p).map((c) => c.clip.id).sort();
    expect(ids).toEqual(['A', 'B', 'M']);
    const m = audibleClips(p).find((c) => c.clip.id === 'M')!;
    expect(m.start).toBe(1);
    expect(m.end).toBe(6);
  });

  it('skips a muted track', () => {
    const p = twoClips('none');
    p.tracks = p.tracks.map((t) => (t.kind === 'main' ? { ...t, muted: true } : t));
    expect(audibleClips(p)).toEqual([]);
  });
});

describe('scheduleInRange', () => {
  it('starts a clip at its place inside the range', () => {
    expect(scheduleInRange({ in: 1, speed: 1 }, { start: 2, end: 6 }, { start: 0, end: 10 })).toEqual({ when: 2, offset: 1, stop: 6 });
  });

  it('cuts into a clip that began before the range, speed-aware', () => {
    expect(scheduleInRange({ in: 1, speed: 2 }, { start: 2, end: 6 }, { start: 3, end: 5 })).toEqual({ when: 0, offset: 3, stop: 2 });
  });

  it('skips clips outside the range', () => {
    expect(scheduleInRange({ in: 0, speed: 1 }, { start: 0, end: 2 }, { start: 2, end: 5 })).toBeNull();
  });
});
