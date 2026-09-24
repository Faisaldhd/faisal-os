import { describe, expect, it } from 'vitest';
import { fixWebmDuration, readWebmInfo, __testing } from './webm';

const { encodeSize } = __testing;

const bytes = (...parts: Array<number[] | Uint8Array>): Uint8Array => {
  const list = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of list) { out.set(p, o); o += p.length; }
  return out;
};

const element = (id: number[], data: Uint8Array | number[]): Uint8Array => {
  const d = data instanceof Uint8Array ? data : new Uint8Array(data);
  return bytes(id, encodeSize(d.length, 1)!, d);
};

const EBML_HEADER = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d])); // DocType "webm"
const TIMECODE_SCALE = element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]); // 1,000,000
const CLUSTER = bytes([0x1f, 0x43, 0xb6, 0x75], [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], [0xe7, 0x81, 0x00]);
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/** What MediaRecorder writes: Segment of unknown size, Info without Duration. */
function recorderFile(): Uint8Array {
  const info = element([0x15, 0x49, 0xa9, 0x66], TIMECODE_SCALE);
  return bytes(EBML_HEADER, [0x18, 0x53, 0x80, 0x67], UNKNOWN, info, CLUSTER);
}

describe('fixWebmDuration', () => {
  it('inserts a Duration into a live recording', () => {
    const file = recorderFile();
    expect(readWebmInfo(file)?.duration).toBeNull();
    const fixed = fixWebmDuration(file, 12.5);
    expect(fixed.length).toBe(file.length + 11);
    expect(readWebmInfo(fixed)?.duration).toBeCloseTo(12.5, 6);
    // The media after the Info is intact.
    expect([...fixed.subarray(fixed.length - CLUSTER.length)]).toEqual([...CLUSTER]);
  });

  it('overwrites an existing Duration in place', () => {
    const once = fixWebmDuration(recorderFile(), 3);
    const twice = fixWebmDuration(once, 7.25);
    expect(twice.length).toBe(once.length);
    expect(readWebmInfo(twice)?.duration).toBeCloseTo(7.25, 6);
  });

  it('leaves a file alone when inserting would break offsets', () => {
    const info = element([0x15, 0x49, 0xa9, 0x66], TIMECODE_SCALE);
    const seekHead = element([0x11, 0x4d, 0x9b, 0x74], [0x00]);
    const known = bytes(EBML_HEADER, [0x18, 0x53, 0x80, 0x67], encodeSize(seekHead.length + info.length, 1)!, seekHead, info);
    expect(fixWebmDuration(known, 5)).toBe(known);
  });

  it('leaves anything that is not WebM alone', () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    expect(fixWebmDuration(junk, 5)).toBe(junk);
    expect(readWebmInfo(junk)).toBeNull();
    expect(fixWebmDuration(recorderFile(), Number.NaN).length).toBe(recorderFile().length);
  });

  it('encodes sizes with the right marker bit', () => {
    expect([...encodeSize(5, 1)!]).toEqual([0x85]);
    expect([...encodeSize(300, 2)!]).toEqual([0x41, 0x2c]);
    expect(encodeSize(200, 1)).toBeNull();
  });
});
