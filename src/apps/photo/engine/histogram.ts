/**
 * Photo engine — 256-bin R, G, B and luminance histograms.
 *
 * One pass, integer maths only: each pixel is read as a single 32-bit word (little-endian
 * RGBA) and luminance is the fixed-point Rec. 601 luma `(77R + 150G + 29B + 128) >> 8`,
 * so 12 MP takes a few tens of milliseconds. Nearly transparent pixels (alpha < 8) are not
 * counted: they are not visible, so they should not shape the graph.
 */
import type { Img, Mask } from './core';

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  /** Luminance. */
  l: Uint32Array;
  /** Largest bin over all four (for scaling the graph). */
  max: number;
  /** Pixels counted. */
  count: number;
}

/** Fixed-point Rec. 601 luma of 8-bit samples, 0..255. */
export function lumaIndex(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b + 128) >> 8;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Histogram of `buf`, sampling every `step`-th pixel (1 = all). With a `mask`, only
 * selected pixels (mask ≥ 128) are counted.
 */
export function histogram(buf: Img, step = 1, mask: Mask | null = null): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  const st = Math.max(1, Math.floor(step) || 1);
  const d = buf.data;
  const n = (d.length / 4) | 0;
  let count = 0;
  if (LITTLE_ENDIAN && d.byteOffset % 4 === 0 && !mask) {
    const u = new Uint32Array(d.buffer, d.byteOffset, n);
    for (let p = 0; p < n; p += st) {
      const px = u[p];
      if (px >>> 24 < 8) continue;
      const R = px & 255;
      const G = (px >>> 8) & 255;
      const B = (px >>> 16) & 255;
      r[R]++; g[G]++; b[B]++;
      l[(77 * R + 150 * G + 29 * B + 128) >> 8]++;
      count++;
    }
  } else {
    for (let p = 0; p < n; p += st) {
      const i = p * 4;
      if (d[i + 3] < 8 || (mask && mask[p] < 128)) continue;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r[R]++; g[G]++; b[B]++;
      l[(77 * R + 150 * G + 29 * B + 128) >> 8]++;
      count++;
    }
  }
  let max = 0;
  for (let i = 0; i < 256; i++) {
    if (r[i] > max) max = r[i];
    if (g[i] > max) max = g[i];
    if (b[i] > max) max = b[i];
    if (l[i] > max) max = l[i];
  }
  return { r, g, b, l, max, count };
}

/** The bin at or below which `fraction` of the counted samples lie (for auto-levels). */
export function percentile(bins: Uint32Array, fraction: number): number {
  let total = 0;
  for (let i = 0; i < 256; i++) total += bins[i];
  if (total === 0) return 0;
  const target = total * Math.min(1, Math.max(0, fraction));
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += bins[i];
    if (acc >= target) return i;
  }
  return 255;
}
