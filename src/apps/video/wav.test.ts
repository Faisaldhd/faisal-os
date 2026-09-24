import { describe, expect, it } from 'vitest';
import { encodeWav, readWavHeader } from './wav';

describe('encodeWav', () => {
  it('writes a valid 16-bit stereo header and interleaved samples', () => {
    const left = new Float32Array([0, 1, -1]);
    const right = new Float32Array([0.5, -0.5, 0]);
    const bytes = encodeWav([left, right], 48000);
    expect(bytes.length).toBe(44 + 3 * 2 * 2);
    expect(readWavHeader(bytes)).toEqual({ channels: 2, sampleRate: 48000, frames: 3 });
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(view.getInt16(48, true)).toBe(0x7fff);
    expect(view.getInt16(52, true)).toBe(-0x8000);
  });

  it('clamps out-of-range and NaN samples', () => {
    const bytes = encodeWav([new Float32Array([4, Number.NaN])], 8000);
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(0);
  });

  it('refuses a file that is not WAV', () => {
    expect(readWavHeader(new Uint8Array(10))).toBeNull();
    expect(readWavHeader(new Uint8Array(60))).toBeNull();
  });
});
