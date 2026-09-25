import { describe, expect, it } from 'vitest';
import { thumbnailTimes } from './media';

/**
 * Where the filmstrip takes its frames from. The loop around this arithmetic is the expensive
 * part of opening a video (twelve decoder seeks), so the sampling itself is pinned here: an
 * even spread, and a last sample that stays inside the file.
 */
describe('thumbnailTimes', () => {
  it('spreads twelve samples evenly across the clip', () => {
    const times = thumbnailTimes(12, 12);
    expect(times).toHaveLength(12);
    expect(times[0]).toBeCloseTo(0.5, 6);
    expect(times[11]).toBeCloseTo(11.5, 6);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });

  it('never asks for the end of the file, where a seek has no frame to show', () => {
    const times = thumbnailTimes(6.471667, 12);
    expect(Math.max(...times)).toBeLessThanOrEqual(6.471667 - 0.05);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0);
  });

  it('falls back to a single frame at the start when the duration is unknown', () => {
    for (const duration of [0, -3, Number.NaN]) {
      expect(thumbnailTimes(duration, 12)).toEqual([0]);
    }
  });

  it('always asks for at least one sample, whatever count it is given', () => {
    expect(thumbnailTimes(10, 0)).toEqual([5]);
    expect(thumbnailTimes(10, -4)).toEqual([5]);
    expect(thumbnailTimes(10, 1)).toEqual([5]);
    expect(thumbnailTimes(10, 3.8)).toHaveLength(3);
  });

  it('defaults to the pool filmstrip length', () => {
    expect(thumbnailTimes(60)).toHaveLength(12);
  });
});
