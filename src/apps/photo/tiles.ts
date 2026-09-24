/**
 * Photo Editor — tiled rasters.
 *
 * A raster layer is stored as a grid of immutable 256×256 tiles instead of one big buffer.
 * A brush stroke, a bucket fill or a small paste replaces only the tiles it touches and SHARES
 * every other tile with the previous version. That is what keeps the undo history cheap: on
 * a 12 MP photo a stroke costs a few hundred kilobytes of history instead of 48 MB, so fifty
 * and more steps fit in the memory budget (history.ts).
 *
 * Nothing here touches the DOM; the renderer uploads only the tiles whose object changed.
 */
import type { PixelBuffer, Rect } from './types';

export const TILE_SIZE = 256;

export interface Tiled {
  readonly width: number;
  readonly height: number;
  readonly tile: number;
  readonly cols: number;
  readonly rows: number;
  /** Row-major, `cols × rows`; edge tiles are smaller than `tile`. */
  readonly tiles: readonly PixelBuffer[];
}

function gridOf(width: number, height: number, tile: number) {
  return { cols: Math.max(1, Math.ceil(width / tile)), rows: Math.max(1, Math.ceil(height / tile)) };
}

/** The pixel rectangle tile `index` covers. */
export function tileRect(t: Pick<Tiled, 'width' | 'height' | 'tile' | 'cols'>, index: number): Rect {
  const col = index % t.cols;
  const row = Math.floor(index / t.cols);
  const x = col * t.tile;
  const y = row * t.tile;
  return { x, y, w: Math.min(t.tile, t.width - x), h: Math.min(t.tile, t.height - y) };
}

/** Splits a buffer into tiles (copies the pixels; the source buffer is left alone). */
export function fromBuffer(buf: PixelBuffer, tile = TILE_SIZE): Tiled {
  const { cols, rows } = gridOf(buf.width, buf.height, tile);
  const base = { width: buf.width, height: buf.height, tile, cols, rows };
  const tiles: PixelBuffer[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const r = tileRect(base, i);
    const data = new Uint8ClampedArray(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) {
      const from = ((r.y + y) * buf.width + r.x) * 4;
      data.set(buf.data.subarray(from, from + r.w * 4), y * r.w * 4);
    }
    tiles.push({ width: r.w, height: r.h, data });
  }
  return { ...base, tiles };
}

/** A fully transparent tiled raster. */
export function blankTiled(width: number, height: number, tile = TILE_SIZE): Tiled {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const { cols, rows } = gridOf(w, h, tile);
  const base = { width: w, height: h, tile, cols, rows };
  const tiles: PixelBuffer[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const r = tileRect(base, i);
    tiles.push({ width: r.w, height: r.h, data: new Uint8ClampedArray(r.w * r.h * 4) });
  }
  return { ...base, tiles };
}

/** Reassembles the whole raster into one buffer. */
export function toBuffer(t: Tiled): PixelBuffer {
  return readRegion(t, { x: 0, y: 0, w: t.width, h: t.height });
}

/**
 * Copies a rectangle out of the raster. Any part of `rect` outside the raster reads as
 * transparent, so callers can ask for a brush's bounding box without clamping it first.
 */
export function readRegion(t: Tiled, rect: Rect): PixelBuffer {
  const rx = Math.round(rect.x);
  const ry = Math.round(rect.y);
  const rw = Math.max(1, Math.round(rect.w));
  const rh = Math.max(1, Math.round(rect.h));
  const out = new Uint8ClampedArray(rw * rh * 4);
  const x0 = Math.max(0, rx);
  const y0 = Math.max(0, ry);
  const x1 = Math.min(t.width, rx + rw);
  const y1 = Math.min(t.height, ry + rh);
  if (x1 > x0 && y1 > y0) {
    for (let row = Math.floor(y0 / t.tile); row <= Math.floor((y1 - 1) / t.tile); row++) {
      for (let col = Math.floor(x0 / t.tile); col <= Math.floor((x1 - 1) / t.tile); col++) {
        const index = row * t.cols + col;
        const tr = tileRect(t, index);
        const tile = t.tiles[index];
        const ix0 = Math.max(x0, tr.x);
        const ix1 = Math.min(x1, tr.x + tr.w);
        const iy0 = Math.max(y0, tr.y);
        const iy1 = Math.min(y1, tr.y + tr.h);
        const span = (ix1 - ix0) * 4;
        for (let y = iy0; y < iy1; y++) {
          const from = ((y - tr.y) * tr.w + (ix0 - tr.x)) * 4;
          out.set(tile.data.subarray(from, from + span), ((y - ry) * rw + (ix0 - rx)) * 4);
        }
      }
    }
  }
  return { width: rw, height: rh, data: out };
}

/**
 * Writes `region` at (x, y) and returns a NEW raster. Tiles the region does not touch are the
 * very same objects as before (that is the whole point); touched tiles are fresh copies.
 * Parts of the region outside the raster are ignored.
 */
export function writeRegion(t: Tiled, x: number, y: number, region: PixelBuffer): Tiled {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const x0 = Math.max(0, rx);
  const y0 = Math.max(0, ry);
  const x1 = Math.min(t.width, rx + region.width);
  const y1 = Math.min(t.height, ry + region.height);
  if (x1 <= x0 || y1 <= y0) return t;
  const tiles = [...t.tiles];
  for (let row = Math.floor(y0 / t.tile); row <= Math.floor((y1 - 1) / t.tile); row++) {
    for (let col = Math.floor(x0 / t.tile); col <= Math.floor((x1 - 1) / t.tile); col++) {
      const index = row * t.cols + col;
      const tr = tileRect(t, index);
      const data = new Uint8ClampedArray(t.tiles[index].data);
      const ix0 = Math.max(x0, tr.x);
      const ix1 = Math.min(x1, tr.x + tr.w);
      const iy0 = Math.max(y0, tr.y);
      const iy1 = Math.min(y1, tr.y + tr.h);
      const span = (ix1 - ix0) * 4;
      for (let yy = iy0; yy < iy1; yy++) {
        const from = ((yy - ry) * region.width + (ix0 - rx)) * 4;
        data.set(region.data.subarray(from, from + span), ((yy - tr.y) * tr.w + (ix0 - tr.x)) * 4);
      }
      tiles[index] = { width: tr.w, height: tr.h, data };
    }
  }
  return { ...t, tiles };
}

/** Indices of tiles that are different objects in `a` and `b` (same geometry required). */
export function changedTiles(a: Tiled, b: Tiled): number[] | null {
  if (a.width !== b.width || a.height !== b.height || a.tile !== b.tile) return null;
  const out: number[] = [];
  for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i]) out.push(i);
  return out;
}

/** Total bytes the tiles hold. */
export function tiledBytes(t: Tiled): number {
  let bytes = 0;
  for (const tile of t.tiles) bytes += tile.data.length;
  return bytes;
}

/** True when every pixel of the raster is fully transparent. */
export function isTransparent(t: Tiled): boolean {
  for (const tile of t.tiles) {
    for (let i = 3; i < tile.data.length; i += 4) if (tile.data[i] !== 0) return false;
  }
  return true;
}
