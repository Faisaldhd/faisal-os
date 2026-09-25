import { describe, expect, it } from 'vitest';
import {
  clampTime,
  estimateBytes,
  formatDuration,
  formatMediaTime,
  formatRulerTime,
  formatTime,
  frameDuration,
  progressFraction,
  resolvedTrim,
  safeDuration,
  stepTime,
  timestampToken,
  wholeRange,
} from './time';
import { timecode } from './project';

/**
 * The ruler label. This is the one place a frame-accurate time is read on the timeline, and its
 * whole point is that two ticks a frame apart never look the same — so the checks are written
 * against the boundary frames, the hour rollover and the rates a source file can really have.
 */
describe('formatRulerTime', () => {
  it('reads as time and frames: m:ss.ff', () => {
    expect(formatRulerTime(0, 30)).toBe('0:00.00');
    expect(formatRulerTime(1.5, 30)).toBe('0:01.15');
    expect(formatRulerTime(62.25, 30)).toBe('1:02.08');
    expect(formatRulerTime(10, 30)).toBe('0:10.00');
  });

  it('never prints two labels a frame apart the same', () => {
    const a = formatRulerTime(4, 30);
    const b = formatRulerTime(4 + 1 / 30, 30);
    const c = formatRulerTime(4 + 29 / 30, 30);
    expect(a).toBe('0:04.00');
    expect(b).toBe('0:04.01');
    expect(c).toBe('0:04.29');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('carries the hours instead of dropping them', () => {
    expect(formatRulerTime(3600, 30)).toBe('1:00:00.00');
    expect(formatRulerTime(3661.2, 25)).toBe('1:01:01.05');
    expect(formatRulerTime(7325.04, 25)).toBe('2:02:05.01');
  });

  it('follows the rate it is given, and falls back to 30 rather than NaN', () => {
    expect(formatRulerTime(2, 24)).toBe('0:02.00');
    expect(formatRulerTime(2 + 23 / 24, 24)).toBe('0:02.23');
    expect(formatRulerTime(1, 60)).toBe('0:01.00');
    expect(formatRulerTime(1 + 59 / 60, 60)).toBe('0:01.59');
    expect(formatRulerTime(3, null)).toBe('0:03.00');
    expect(formatRulerTime(3, 0)).toBe('0:03.00');
    expect(formatRulerTime(3, Number.NaN)).toBe('0:03.00');
  });

  it('drops the frames only when the caller says the ruler is in seconds', () => {
    expect(formatRulerTime(62.25, 30, { frames: false })).toBe('1:02');
    expect(formatRulerTime(3661.2, 30, { frames: false })).toBe('1:01:01');
    expect(formatRulerTime(0, 30, { frames: false })).toBe('0:00');
  });

  it('treats an unreadable position as the start, never as NaN', () => {
    expect(formatRulerTime(-5, 30)).toBe('0:00.00');
    expect(formatRulerTime(Number.NaN, 30)).toBe('0:00.00');
    expect(formatRulerTime(Number.POSITIVE_INFINITY, 30)).toBe('0:00.00');
  });
});

/**
 * The media clock. This is the fix for the readout mismatch the owner could see: the same
 * 6.47 s clip read `0:06` in the player and `00:06:14` in the editor status. Both surfaces print
 * this function now, so the checks below pin the frame-accurate value, the shape (frames after a
 * DOT, which is what stops `00:06:14` reading as six minutes) and the agreement with the colon
 * timecode the timeline still uses for screen readers.
 */
describe('formatMediaTime', () => {
  it('prints the real length of the sample clip', () => {
    // 6.471667 s at 30 fps is 6 seconds and 14 frames — not "6 seconds" (0:06) and not "6:14".
    expect(formatMediaTime(6.471667)).toBe('0:06.14');
    expect(formatMediaTime(6.471667, 30)).toBe('0:06.14');
  });

  it('puts the frames after a dot so a frame count can never read as seconds', () => {
    expect(formatMediaTime(0)).toBe('0:00.00');
    expect(formatMediaTime(1.5, 30)).toBe('0:01.15');
    expect(formatMediaTime(62.25, 30)).toBe('1:02.08');
    expect(formatMediaTime(3600, 30)).toBe('1:00:00.00');
    expect(formatMediaTime(3661.2, 25)).toBe('1:01:01.05');
  });

  it('is frame-accurate: two positions a frame apart never print the same', () => {
    const a = formatMediaTime(4, 30);
    const b = formatMediaTime(4 + 1 / 30, 30);
    expect(a).toBe('0:04.00');
    expect(b).toBe('0:04.01');
    expect(a).not.toBe(b);
  });

  it('follows the rate it is given and falls back to 30 rather than NaN', () => {
    expect(formatMediaTime(2 + 23 / 24, 24)).toBe('0:02.23');
    expect(formatMediaTime(3, null)).toBe('0:03.00');
    expect(formatMediaTime(3, 0)).toBe('0:03.00');
    expect(formatMediaTime(3, Number.NaN)).toBe('0:03.00');
  });

  it('never shows NaN for an unreadable position', () => {
    expect(formatMediaTime(-5)).toBe('0:00.00');
    expect(formatMediaTime(Number.NaN)).toBe('0:00.00');
    expect(formatMediaTime(Number.POSITIVE_INFINITY)).toBe('0:00.00');
  });

  it('carries the same seconds and frames as the colon timecode the timeline uses', () => {
    // One shared frame maths: a screen reader hearing `00:06:14` and a reader seeing `0:06.14`
    // must be describing the same instant, only spelled differently.
    for (const seconds of [0, 0.5, 1.5, 6.471667, 61.5, 62.25, 3599.99, 3600, 7325.04]) {
      for (const fps of [24, 25, 30, 60]) {
        const media = formatMediaTime(seconds, fps).split('.');
        const code = timecode(seconds, fps).split(':');
        expect(code.slice(-2), `${seconds}s @${fps}`).toEqual([media[0].split(':').pop(), media[1]]);
      }
    }
  });
});

describe('formatTime', () => {
  it('formats minutes, seconds and milliseconds', () => {
    expect(formatTime(0)).toBe('0:00.000');
    expect(formatTime(1.5)).toBe('0:01.500');
    expect(formatTime(62.25)).toBe('1:02.250');
    expect(formatTime(3661.004)).toBe('1:01:01.004');
  });

  it('rounds to whole milliseconds instead of printing float noise', () => {
    expect(formatTime(0.0004)).toBe('0:00.000');
    expect(formatTime(2.9996)).toBe('0:03.000');
  });

  it('treats negative and non-finite input as zero, never as NaN', () => {
    expect(formatTime(-5)).toBe('0:00.000');
    expect(formatTime(Number.NaN)).toBe('0:00.000');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00.000');
  });

  it('drops the milliseconds for a duration badge', () => {
    expect(formatDuration(62.25)).toBe('1:02');
  });
});

describe('clamping', () => {
  it('keeps a position inside the file', () => {
    expect(clampTime(-3, 10)).toBe(0);
    expect(clampTime(3, 10)).toBe(3);
    expect(clampTime(30, 10)).toBe(10);
  });

  it('returns 0 for a position that is not a number', () => {
    expect(clampTime(Number.NaN, 10)).toBe(0);
  });

  it('reads an unknown duration as 0 rather than passing NaN on', () => {
    expect(safeDuration(Number.NaN)).toBe(0);
    expect(safeDuration(-1)).toBe(0);
    expect(safeDuration(null)).toBe(0);
    expect(safeDuration(4.5)).toBe(4.5);
  });
});

describe('trim selection', () => {
  it('resolves an open out point against the real duration', () => {
    expect(resolvedTrim({ in: 1, out: null }, 10)).toEqual({ start: 1, end: 10 });
  });

  it('never lets the range invert', () => {
    expect(resolvedTrim({ in: 9, out: 2 }, 10)).toEqual({ start: 9, end: 9 });
  });

  it('clamps both ends into the file', () => {
    expect(resolvedTrim({ in: -4, out: 99 }, 10)).toEqual({ start: 0, end: 10 });
  });

  it('reports the whole file for a whole-file range', () => {
    expect(wholeRange(12.5)).toEqual({ start: 0, end: 12.5 });
    expect(wholeRange(Number.NaN)).toEqual({ start: 0, end: 0 });
  });
});

describe('frame stepping', () => {
  it('uses the measured frame rate when there is one', () => {
    expect(frameDuration(25)).toBeCloseTo(0.04, 10);
  });

  it('falls back to 30 fps for a rate it does not know', () => {
    expect(frameDuration(0)).toBeCloseTo(1 / 30, 10);
    expect(frameDuration(Number.NaN)).toBeCloseTo(1 / 30, 10);
    expect(frameDuration(null)).toBeCloseTo(1 / 30, 10);
  });

  it('steps forward to the next frame boundary', () => {
    expect(stepTime(0, 1, 25, 10)).toBeCloseTo(0.04, 10);
    expect(stepTime(0.05, 1, 25, 10)).toBeCloseTo(0.08, 10);
  });

  it('steps back from a position between two frames', () => {
    expect(stepTime(0.05, -1, 25, 10)).toBeCloseTo(0.04, 10);
    expect(stepTime(0.04, -1, 25, 10)).toBeCloseTo(0, 10);
  });

  it('never steps outside the file', () => {
    expect(stepTime(0, -1, 30, 10)).toBe(0);
    expect(stepTime(10, 1, 30, 10)).toBe(10);
    expect(stepTime(0, 1, 30, 0)).toBe(0);
  });
});

describe('progress', () => {
  it('is a fraction of the duration', () => {
    expect(progressFraction(5, 10)).toBe(0.5);
    expect(progressFraction(20, 10)).toBe(1);
    expect(progressFraction(-1, 10)).toBe(0);
  });

  it('is 0, not NaN, while the duration is unknown', () => {
    expect(progressFraction(3, 0)).toBe(0);
    expect(progressFraction(3, Number.NaN)).toBe(0);
  });
});

describe('size and tokens', () => {
  it('estimates bytes from a bitrate and refuses to guess without one', () => {
    expect(estimateBytes(8, 8_000_000)).toBe(8_000_000);
    expect(estimateBytes(10, null)).toBeNull();
    expect(estimateBytes(10, 0)).toBeNull();
  });

  it('pads a clock token to six digits', () => {
    expect(timestampToken(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('030405');
  });
});
