import { describe, expect, it } from 'vitest';
import { clipsNeeded, Clock, HARD_DRIFT, MAX_NUDGE, progressOf, SOFT_DRIFT, syncAction } from './sync';
import { tickDecision, lastFrameTime } from './player';
import { audio, title, twoClips, withTrackClips } from './fixtures';

describe('syncAction', () => {
  it('starts a paused element and seeks it when it is off', () => {
    expect(syncAction(0, 2, 1, true)).toEqual({ seek: 2, rate: 1, play: true });
    expect(syncAction(2.01, 2, 1.5, true)).toEqual({ seek: null, rate: 1.5, play: true });
  });

  it('leaves an element alone inside the soft window', () => {
    expect(syncAction(2 + SOFT_DRIFT / 2, 2, 1, false)).toEqual({ seek: null, rate: 1, play: true });
  });

  it('nudges the rate for moderate drift, slower when ahead and faster when behind', () => {
    const ahead = syncAction(2.1, 2, 1, false);
    expect(ahead.seek).toBeNull();
    expect(ahead.rate).toBeLessThan(1);
    expect(ahead.rate).toBeGreaterThanOrEqual(1 - MAX_NUDGE);
    const behind = syncAction(1.9, 2, 1, false);
    expect(behind.rate).toBeGreaterThan(1);
    expect(behind.rate).toBeLessThanOrEqual(1 + MAX_NUDGE);
  });

  it('scales the nudge with the clip speed', () => {
    const a = syncAction(2.1, 2, 2, false);
    expect(a.rate).toBeLessThan(2);
    expect(a.rate).toBeGreaterThanOrEqual(2 * (1 - MAX_NUDGE));
  });

  it('seeks hard for large drift (scaled by speed)', () => {
    expect(syncAction(2 + HARD_DRIFT + 0.1, 2, 1, false).seek).toBe(2);
    expect(syncAction(2 + HARD_DRIFT + 0.1, 2, 4, false).seek).toBeNull();
  });

  it('repairs bad input', () => {
    expect(syncAction(Number.NaN, 1, 0, false)).toEqual({ seek: 1, rate: 1, play: true });
  });
});

describe('Clock', () => {
  it('runs, pauses, restarts and changes rate without a jump', () => {
    let now = 100;
    const clock = new Clock(() => now);
    expect(clock.time()).toBe(0);
    clock.start(2);
    now += 1.5;
    expect(clock.time()).toBeCloseTo(3.5, 10);
    clock.setRate(2);
    expect(clock.time()).toBeCloseTo(3.5, 10);
    now += 1;
    expect(clock.time()).toBeCloseTo(5.5, 10);
    expect(clock.pause()).toBeCloseTo(5.5, 10);
    now += 10;
    expect(clock.time()).toBeCloseTo(5.5, 10);
    expect(clock.isRunning).toBe(false);
    clock.set(1);
    expect(clock.time()).toBe(1);
    clock.setRate(-1);
    expect(clock.speed).toBe(1);
  });
});

describe('clipsNeeded', () => {
  it('lists the one clip on screen before the transition, with its audio gain', () => {
    const needs = clipsNeeded(twoClips(), 1, 0);
    expect(needs.map((n) => n.clip.id)).toEqual(['A']);
    expect(needs[0].visual).toBe(true);
    expect(needs[0].gain).toBe(1);
    expect(needs[0].sourceTime).toBeCloseTo(1, 10);
  });

  it('lists both clips inside a crossfade, each at its own source time', () => {
    const needs = clipsNeeded(twoClips(), 3.5, 0);
    const a = needs.find((n) => n.clip.id === 'A')!;
    const b = needs.find((n) => n.clip.id === 'B')!;
    expect(a.sourceTime).toBeCloseTo(3.5, 10);
    expect(b.sourceTime).toBeCloseTo(0.5, 10);
    expect(b.gain).toBeCloseTo(0.5, 6);
    expect(a.gain).toBeCloseTo(0.5, 6);
  });

  it('prerolls a clip starting soon, parked on its in point', () => {
    const needs = clipsNeeded(twoClips(), 2, 1.5);
    const b = needs.find((n) => n.clip.id === 'B')!;
    expect(b.preroll).toBe(true);
    expect(b.sourceTime).toBe(0);
    expect(b.visual).toBe(false);
  });

  it('includes audio-track clips and never lists titles', () => {
    const p = withTrackClips(twoClips('none', (x) => withTrackClips(x, 'text-1', [title('T', 0, 'عنوان')])), 'audio-1', [audio('M', 'music', 20, { start: 0, volume: 0.5 })]);
    const needs = clipsNeeded(p, 1, 0);
    const music = needs.find((n) => n.clip.id === 'M')!;
    expect(music.visual).toBe(false);
    expect(music.gain).toBeCloseTo(0.5, 6);
    expect(needs.some((n) => n.clip.id === 'T')).toBe(false);
  });

  it('keeps a muted clip in the list with gain 0 (it must keep time)', () => {
    const p = twoClips('none');
    p.tracks = p.tracks.map((t) => (t.kind === 'main' ? { ...t, muted: true } : t));
    const needs = clipsNeeded(p, 1, 0);
    expect(needs[0].gain).toBe(0);
  });

  it('returns nothing past the end', () => {
    expect(clipsNeeded(twoClips(), 100, 0)).toEqual([]);
  });
});

describe('progressOf', () => {
  it('reports fraction and a steady ETA', () => {
    expect(progressOf(0, 10, 0)).toEqual({ fraction: 0, eta: null });
    const p = progressOf(5, 10, 5);
    expect(p.fraction).toBe(0.5);
    expect(p.eta).toBeCloseTo(5, 10);
    expect(progressOf(20, 10, 20).fraction).toBe(1);
    expect(progressOf(1, 0, 1)).toEqual({ fraction: 0, eta: null });
  });
});

describe('tickDecision', () => {
  it('plays, wraps inside a loop and ends at the film end or stop point', () => {
    expect(tickDecision(1, 10, null, null)).toEqual({ kind: 'play', time: 1 });
    expect(tickDecision(10.2, 10, null, null)).toEqual({ kind: 'end', time: 10 });
    expect(tickDecision(5.1, 10, null, 5)).toEqual({ kind: 'end', time: 5 });
    expect(tickDecision(4.01, 10, { start: 2, end: 4 }, null)).toEqual({ kind: 'wrap', time: 2 });
    expect(tickDecision(3, 10, { start: 2, end: 4 }, null)).toEqual({ kind: 'play', time: 3 });
    expect(tickDecision(3, 10, { start: 4, end: 2 }, null)).toEqual({ kind: 'play', time: 3 });
  });

  it('keeps the last picture inside the half-open timeline', () => {
    expect(lastFrameTime(3)).toBeLessThan(3);
    expect(lastFrameTime(0)).toBe(0);
  });
});
