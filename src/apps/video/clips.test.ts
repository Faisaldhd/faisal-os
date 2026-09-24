import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampCrop,
  clipFromRange,
  clipIndexAt,
  describeTransform,
  drawPlan,
  evenSize,
  exportOffsets,
  MIN_CROP,
  moveClip,
  outputOffset,
  outputSize,
  pruneClips,
  removeClip,
  resetTransform,
  rotateBy,
  setCropField,
  setIn,
  setOut,
  splitClipAt,
  splitRange,
  toggleFlip,
  totalDuration,
  type Clip,
  type Rotation,
  type VideoTransform,
} from './clips';

const clip = (start: number, end: number): Clip => ({ id: `id-${start}-${end}`, path: '/home/user/a.mp4', range: { start, end } });

/** The default transform with one field changed; `rotation` is narrowed on purpose. */
const withRotation = (rotation: Rotation): VideoTransform => ({ ...resetTransform(), rotation });
const turn = withRotation;

beforeEach(() => {
  // Ids are generated per split; nothing here depends on their exact value.
});

describe('trim in/out', () => {
  it('sets the in point and pushes the out point when it would invert', () => {
    expect(setIn({ in: 0, out: 4 }, 7, 10)).toEqual({ in: 7, out: 7 });
    expect(setIn({ in: 0, out: 9 }, 3, 10)).toEqual({ in: 3, out: 9 });
  });

  it('sets the out point and pulls the in point back when it would invert', () => {
    expect(setOut({ in: 6, out: null }, 2, 10)).toEqual({ in: 2, out: 2 });
    expect(setOut({ in: 1, out: null }, 8, 10)).toEqual({ in: 1, out: 8 });
  });

  it('clamps both ends into the file', () => {
    expect(setIn({ in: 0, out: null }, -4, 10)).toEqual({ in: 0, out: null });
    expect(setOut({ in: 0, out: null }, 99, 10)).toEqual({ in: 0, out: 10 });
  });

  it('keeps the value when the duration is not known yet', () => {
    expect(setOut({ in: 0, out: null }, 5, 0)).toEqual({ in: 0, out: 5 });
  });
});

describe('splitting', () => {
  it('cuts a range into two halves', () => {
    expect(splitRange({ start: 0, end: 10 }, 4)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 10 },
    ]);
  });

  it('refuses a cut outside the range or exactly on an edge', () => {
    expect(splitRange({ start: 2, end: 6 }, 1)).toBeNull();
    expect(splitRange({ start: 2, end: 6 }, 6)).toBeNull();
    expect(splitRange({ start: 2, end: 6 }, 2)).toBeNull();
    expect(splitRange({ start: 4, end: 4 }, 4)).toBeNull();
  });

  it('replaces one clip with the two halves, keeping the order', () => {
    const clips = [clip(0, 10), clip(20, 25)];
    const next = splitClipAt(clips, 0, 4);
    expect(next).toHaveLength(3);
    expect(next.map((c) => c.range)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 10 },
      { start: 20, end: 25 },
    ]);
    // The original array is untouched: the caller assigns the result.
    expect(clips).toHaveLength(2);
  });

  it('leaves the list alone for a cut that misses', () => {
    const clips = [clip(0, 10)];
    expect(splitClipAt(clips, 0, 30)).toBe(clips);
    expect(splitClipAt(clips, 5, 3)).toBe(clips);
  });

  it('gives the halves distinct ids', () => {
    const next = splitClipAt([clip(0, 10)], 0, 5);
    expect(next[0].id).not.toBe(next[1].id);
  });
});

describe('clip list', () => {
  it('sums the durations in order', () => {
    expect(totalDuration([clip(0, 4), clip(10, 13)])).toBe(7);
    expect(totalDuration([])).toBe(0);
  });

  it('computes where each clip starts in the output', () => {
    expect(exportOffsets([clip(0, 4), clip(10, 13), clip(20, 21)])).toEqual([0, 4, 7]);
  });

  it('maps a source position to the output position', () => {
    const clips = [clip(0, 4), clip(10, 13)];
    expect(outputOffset(clips, 1, 11)).toBe(5);
    // A position before the clip start clamps to the clip's own offset.
    expect(outputOffset(clips, 1, 2)).toBe(4);
  });

  it('finds the clip under a position, and -1 for a gap', () => {
    const clips = [clip(0, 4), clip(10, 13)];
    expect(clipIndexAt(clips, 0)).toBe(0);
    expect(clipIndexAt(clips, 3.9)).toBe(0);
    expect(clipIndexAt(clips, 4)).toBe(-1);
    expect(clipIndexAt(clips, 10)).toBe(1);
    expect(clipIndexAt(clips, 13)).toBe(-1);
  });

  it('moves a clip earlier and later', () => {
    const clips = [clip(0, 1), clip(1, 2), clip(2, 3)];
    expect(moveClip(clips, 0, 2).map((c) => c.range.start)).toEqual([1, 2, 0]);
    expect(moveClip(clips, 2, 0).map((c) => c.range.start)).toEqual([2, 0, 1]);
  });

  it('clamps a move into range and ignores a no-op', () => {
    const clips = [clip(0, 1), clip(1, 2)];
    expect(moveClip(clips, 0, 9).map((c) => c.range.start)).toEqual([1, 0]);
    // A no-op still returns a copy: callers assign the result either way.
    expect(moveClip(clips, 1, 1)).toEqual(clips);
    expect(moveClip(clips, 7, 0)).toEqual(clips);
  });

  it('removes one clip and ignores an index that does not exist', () => {
    const clips = [clip(0, 1), clip(1, 2)];
    expect(removeClip(clips, 0).map((c) => c.range.start)).toEqual([1]);
    expect(removeClip(clips, 9)).toHaveLength(2);
  });

  it('drops empty clips, which would only stall the export', () => {
    expect(pruneClips([clip(0, 0), clip(2, 3), clip(5, 5)])).toHaveLength(1);
  });

  it('builds a clip from a range with its own id', () => {
    const a = clipFromRange('/home/user/x.mp4', { start: 1, end: 2 });
    const b = clipFromRange('/home/user/x.mp4', { start: 1, end: 2 });
    expect(a.id).not.toBe(b.id);
    expect(a.range).toEqual({ start: 1, end: 2 });
  });
});

describe('rotation and flip', () => {
  it('wraps a quarter turn in both directions', () => {
    expect(rotateBy(0, 90)).toBe(90);
    expect(rotateBy(270, 90)).toBe(0);
    expect(rotateBy(0, 270)).toBe(270);
    expect(rotateBy(90, 180)).toBe(270);
    expect(rotateBy(180, 180)).toBe(0);
  });

  it('flips one axis without touching the other', () => {
    expect(toggleFlip({ horizontal: false, vertical: false }, 'horizontal')).toEqual({ horizontal: true, vertical: false });
    expect(toggleFlip({ horizontal: true, vertical: true }, 'vertical')).toEqual({ horizontal: true, vertical: false });
  });

  it('describes the transform for the status line', () => {
    const t = resetTransform();
    expect(describeTransform(t)).toEqual({ deg: 0, h: false, v: false, cw: 100, ch: 100 });
    expect(describeTransform({ ...t, rotation: 90, flip: { horizontal: true, vertical: false }, crop: { x: 0, y: 0, width: 0.5, height: 0.25 } }))
      .toEqual({ deg: 90, h: true, v: false, cw: 50, ch: 25 });
  });
});

describe('crop maths', () => {
  it('clamps a rectangle into the frame', () => {
    expect(clampCrop({ x: 0.8, y: 0.8, width: 0.5, height: 0.5 })).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
    expect(clampCrop({ x: -2, y: -2, width: 0.5, height: 0.5 })).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
  });

  it('never lets the rectangle collapse', () => {
    expect(clampCrop({ x: 0, y: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: MIN_CROP, height: MIN_CROP });
  });

  it('repairs non-finite input instead of propagating NaN', () => {
    expect(clampCrop({ x: Number.NaN, y: 0, width: Number.NaN, height: 1 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('sets one field and re-clamps the rest', () => {
    const crop = setCropField({ x: 0.6, y: 0, width: 0.5, height: 1 }, 'width', 0.8);
    expect(crop.width).toBe(0.8);
    expect(crop.x).toBeCloseTo(0.2, 10);
    expect(setCropField({ x: 0, y: 0, width: 1, height: 1 }, 'x', Number.NaN)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('swaps the output size on a quarter turn', () => {
    const source = { width: 1920, height: 1080 };
    expect(outputSize(source, resetTransform())).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(source, withRotation(90))).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(source, withRotation(270))).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(source, withRotation(180))).toEqual({ width: 1920, height: 1080 });
  });

  it('applies the crop before the quarter turn', () => {
    const source = { width: 1000, height: 500 };
    const transform: VideoTransform = { ...withRotation(90), crop: { x: 0, y: 0, width: 0.5, height: 1 } };
    expect(outputSize(source, transform)).toEqual({ width: 500, height: 500 });
  });

  it('rounds an encoder size down to even numbers, never below 2', () => {
    expect(evenSize({ width: 1921, height: 1081 })).toEqual({ width: 1920, height: 1080 });
    expect(evenSize({ width: 1, height: 1 })).toEqual({ width: 2, height: 2 });
  });
});

describe('draw plan', () => {
  it('crops the source rectangle in source pixels', () => {
    const plan = drawPlan({ width: 1000, height: 500 }, { ...resetTransform(), crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } });
    expect(plan.source).toEqual({ x: 100, y: 100, width: 500, height: 200 });
    expect(plan.destination).toEqual({ x: -250, y: -100, width: 500, height: 200 });
  });

  it('centres the output and mirrors the scale for a flip', () => {
    const plan = drawPlan({ width: 800, height: 600 }, { ...resetTransform(), flip: { horizontal: true, vertical: true } });
    expect(plan.translateX).toBe(400);
    expect(plan.translateY).toBe(300);
    expect(plan.scaleX).toBe(-1);
    expect(plan.scaleY).toBe(-1);
    expect(plan.rotateRadians).toBe(0);
  });

  it('converts the rotation to radians', () => {
    expect(drawPlan({ width: 100, height: 100 }, turn(90)).rotateRadians).toBeCloseTo(Math.PI / 2, 10);
    expect(drawPlan({ width: 100, height: 100 }, turn(180)).rotateRadians).toBeCloseTo(Math.PI, 10);
  });
});
