import { describe, expect, it } from 'vitest';
import {
  blankTiled, changedTiles, fromBuffer, isTransparent, readRegion, tileRect, tiledBytes, toBuffer, writeRegion,
} from './tiles';
import type { PixelBuffer } from './types';

function gradient(w: number, h: number): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = i % 251; data[i * 4 + 1] = (i >> 3) % 253; data[i * 4 + 2] = 7; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe('tiles — tiled rasters', () => {
  it('splits and reassembles a buffer exactly, with smaller edge tiles', () => {
    const src = gradient(70, 45);
    const t = fromBuffer(src, 32);
    expect(t.cols).toBe(3);
    expect(t.rows).toBe(2);
    expect(tileRect(t, 2)).toEqual({ x: 64, y: 0, w: 6, h: 32 });
    expect(Array.from(toBuffer(t).data)).toEqual(Array.from(src.data));
    expect(tiledBytes(t)).toBe(70 * 45 * 4);
  });

  it('reads a region that crosses tiles and the raster edge (outside is transparent)', () => {
    const t = fromBuffer(gradient(40, 40), 16);
    const r = readRegion(t, { x: 30, y: 30, w: 20, h: 20 });
    expect(r.width).toBe(20);
    expect(r.data[(5 * 20 + 5) * 4]).toBe((35 * 40 + 35) % 251);
    expect(r.data[(15 * 20 + 15) * 4 + 3]).toBe(0);
  });

  it('writes a region into fresh tiles and shares every untouched tile', () => {
    const t = fromBuffer(gradient(64, 64), 16);
    const patch: PixelBuffer = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(200) };
    const next = writeRegion(t, 14, 14, patch);
    expect(changedTiles(t, next)).toEqual([0, 1, 4, 5]);
    expect(next.tiles[15]).toBe(t.tiles[15]);
    expect(readRegion(next, { x: 15, y: 15, w: 1, h: 1 }).data[0]).toBe(200);
    expect(readRegion(t, { x: 15, y: 15, w: 1, h: 1 }).data[0]).toBe((15 * 64 + 15) % 251);
    expect(writeRegion(t, 500, 500, patch)).toBe(t);
  });

  it('creates transparent rasters and detects them', () => {
    expect(isTransparent(blankTiled(10, 10))).toBe(true);
    expect(isTransparent(fromBuffer(gradient(3, 3)))).toBe(false);
  });
});
