import { describe, expect, it } from 'vitest';
import { chooseMime, exportRange, exportSettings, filmstripTimes, MP4_CANDIDATES, WEBM_CANDIDATES } from './exporter';

const only = (...list: string[]) => (m: string) => list.includes(m);

describe('chooseMime', () => {
  it('prefers MP4 when the recorder says yes (Chrome 126+, Safari)', () => {
    expect(chooseMime(only(MP4_CANDIDATES[2], WEBM_CANDIDATES[0]))).toEqual({
      mime: MP4_CANDIDATES[2], container: 'mp4', extension: '.mp4', fellBack: false,
    });
  });

  it('falls back to WebM VP9, then VP8 (Firefox, older Chrome)', () => {
    expect(chooseMime(only(...WEBM_CANDIDATES))!.mime).toBe('video/webm;codecs=vp9,opus');
    expect(chooseMime(only('video/webm;codecs=vp8,opus', 'video/webm'))!.mime).toBe('video/webm;codecs=vp8,opus');
  });

  it('honours an explicit WebM choice even when MP4 exists', () => {
    const c = chooseMime(only(MP4_CANDIDATES[0], 'video/webm'), 'webm')!;
    expect(c.container).toBe('webm');
    expect(c.fellBack).toBe(false);
  });

  it('says so when the asked container cannot be recorded', () => {
    const c = chooseMime(only('video/webm'), 'mp4')!;
    expect(c).toEqual({ mime: 'video/webm', container: 'webm', extension: '.webm', fellBack: true });
  });

  it('returns null when nothing records, or the probe is missing or throws', () => {
    expect(chooseMime(() => false)).toBeNull();
    expect(chooseMime(undefined)).toBeNull();
    expect(chooseMime(() => { throw new Error('x'); })).toBeNull();
  });
});

describe('exportSettings', () => {
  it('turns resolution, fps and quality into numbers', () => {
    const s = exportSettings({ width: 1920, height: 1080 }, { resolution: '720', fps: 30, quality: 'medium' }, only('video/webm;codecs=vp9,opus'))!;
    expect(s.width).toBe(1280);
    expect(s.height).toBe(720);
    expect(s.fps).toBe(30);
    expect(s.mime).toBe('video/webm;codecs=vp9,opus');
    expect(s.extension).toBe('.webm');
    expect(s.videoBitrate).toBeGreaterThan(1_000_000);
    expect(s.audioBitrate).toBe(128_000);
  });

  it('keeps a vertical frame vertical and clamps fps', () => {
    const s = exportSettings({ width: 1080, height: 1920 }, { resolution: '1080', fps: 240, quality: 'high' }, only('video/mp4'))!;
    expect(s.width).toBe(1080);
    expect(s.height).toBe(1920);
    expect(s.fps).toBe(60);
    expect(s.extension).toBe('.mp4');
  });

  it('is null when the browser records nothing', () => {
    expect(exportSettings({ width: 2, height: 2 }, { resolution: '480', fps: 30, quality: 'low' }, () => false)).toBeNull();
  });
});

describe('exportRange', () => {
  it('defaults to the whole film and clamps a range into it', () => {
    expect(exportRange(10)).toEqual({ start: 0, end: 10 });
    expect(exportRange(10, { start: 2, end: 5 })).toEqual({ start: 2, end: 5 });
    expect(exportRange(10, { start: -1, end: 50 })).toEqual({ start: 0, end: 10 });
    expect(exportRange(10, { start: 6, end: 3 })).toEqual({ start: 6, end: 6 });
    expect(exportRange(Number.NaN)).toEqual({ start: 0, end: 0 });
  });
});

describe('filmstripTimes', () => {
  it('takes the middle of each slice', () => {
    expect(filmstripTimes(10, 5)).toEqual([1, 3, 5, 7, 9]);
    expect(filmstripTimes(1, 1)).toEqual([0.5]);
  });

  it('is empty for nothing to show', () => {
    expect(filmstripTimes(0, 5)).toEqual([]);
    expect(filmstripTimes(10, 0)).toEqual([]);
    expect(filmstripTimes(10, Number.NaN)).toEqual([]);
  });
});
