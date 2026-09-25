import { describe, expect, it } from 'vitest';
import { chooseTarget, ffmpegArgs, hasEncoder, inputName, joinParts, logDuration, logTime, outputName, PART_LIMIT, planParts, progressOf } from './plan';

describe('wasm parts', () => {
  it('cuts a 31 MB file into parts no bigger than 20 MiB, covering every byte once', () => {
    const size = 32_232_419;
    const parts = planParts(size);
    expect(parts).toEqual([{ start: 0, end: PART_LIMIT }, { start: PART_LIMIT, end: size }]);
    expect(parts.every((p) => p.end - p.start <= 20 * 1024 * 1024)).toBe(true);
    expect(PART_LIMIT).toBeLessThan(25 * 1024 * 1024);
  });
  it('handles exact multiples, empty files and refuses a zero part size', () => {
    expect(planParts(20, 10)).toEqual([{ start: 0, end: 10 }, { start: 10, end: 20 }]);
    expect(planParts(0, 10)).toEqual([]);
    expect(() => planParts(10, 0)).toThrow();
  });
  it('reassembles the parts into the original bytes', () => {
    const original = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 255);
    const parts = planParts(original.length, 300).map((r) => original.slice(r.start, r.end));
    expect(parts).toHaveLength(4);
    expect(joinParts(parts, original.length)).toEqual(original);
  });
  it('refuses a missing or extra part instead of building a broken module', () => {
    const a = new Uint8Array(10);
    expect(() => joinParts([a], 20)).toThrow(/expected 20/);
    expect(() => joinParts([a, a, a], 20)).toThrow();
  });
});

describe('encoder choice', () => {
  const log = ' V....D libvpx-vp9           libvpx VP9 (codec vp9)\n A....D aac                  AAC (Advanced Audio Coding)\n';
  it('reads the encoder list', () => {
    expect(hasEncoder(log, 'libvpx-vp9')).toBe(true);
    expect(hasEncoder(log, 'libx264')).toBe(false);
    expect(hasEncoder(' V....D libx264              libx264 H.264\n', 'libx264')).toBe(true);
    expect(hasEncoder(' V....D libx264rgb           x\n', 'libx264')).toBe(false);
  });
  it('picks H.264 MP4 with libx264, VP9 WebM without', () => {
    expect(chooseTarget(' V....D libx264   H.264\n')).toBe('mp4');
    expect(chooseTarget(log)).toBe('webm');
  });
});

describe('names and arguments', () => {
  it('keeps the input extension and names the output after the codec', () => {
    expect(inputName('My Clip.MOV')).toBe('input.mov');
    expect(inputName('noext')).toBe('input.bin');
    expect(outputName('clip.mp4', 'mp4')).toBe('clip-h264.mp4');
    expect(outputName('a.b.mov', 'webm')).toBe('a.b-vp9.webm');
  });
  it('builds H.264/AAC fast-start MP4 and VP9/Opus WebM command lines', () => {
    const mp4 = ffmpegArgs('input.mp4', 'mp4');
    expect(mp4.slice(mp4.indexOf('-i'), mp4.indexOf('-i') + 2)).toEqual(['-i', 'input.mp4']);
    expect(mp4).toContain('libx264');
    expect(mp4).toContain('yuv420p');
    expect(mp4).toContain('+faststart');
    expect(mp4).toContain('0:a:0?');
    expect(mp4.at(-1)).toBe('output.mp4');
    const webm = ffmpegArgs('input.mov', 'webm');
    expect(webm).toContain('libvpx-vp9');
    expect(webm).toContain('libopus');
    expect(webm.at(-1)).toBe('output.webm');
  });
});

describe('progress', () => {
  it('reads times and durations from the log', () => {
    expect(logDuration('  Duration: 00:01:02.50, start: 0.000000, bitrate: 1 kb/s')).toBe(62.5);
    expect(logTime('frame=  10 fps=0.0 q=28.0 size=0kB time=00:00:31.25 bitrate=0.0kbits/s')).toBe(31.25);
    expect(logTime('time=-00:00:00.04')).toBeNull();
    expect(logTime('nothing')).toBeNull();
  });
  it('clamps the fraction and is 0 when the total is unknown', () => {
    expect(progressOf(31.25, 62.5)).toBe(0.5);
    expect(progressOf(80, 62.5)).toBe(1);
    expect(progressOf(5, null)).toBe(0);
    expect(progressOf(null, 10)).toBe(0);
  });
});
