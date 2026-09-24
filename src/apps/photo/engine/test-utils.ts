/** Small helpers shared by the engine's tests (not used at runtime). */
import { createImg, prng, type Img } from './core';

/** An image from a flat list of RGBA pixels, row-major. */
export function imgFrom(width: number, height: number, pixels: readonly (readonly number[])[]): Img {
  const img = createImg(width, height);
  pixels.forEach((p, i) => img.data.set(p, i * 4));
  return img;
}

export function px(img: Img, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(i, i + 4));
}

/** Deterministic random opaque (or not) image. */
export function randomImg(width: number, height: number, seed = 1, opaque = true): Img {
  const img = createImg(width, height);
  const rnd = prng(seed);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = rnd() * 256; d[i + 1] = rnd() * 256; d[i + 2] = rnd() * 256;
    d[i + 3] = opaque ? 255 : rnd() * 256;
  }
  return img;
}

/** A large image filled fast (a repeating random tile) for performance tests. */
export function bigImg(width: number, height: number): Img {
  const img = createImg(width, height);
  const tile = randomImg(256, 1, 3).data;
  const d = img.data;
  for (let i = 0; i < d.length; i += tile.length) d.set(tile.subarray(0, Math.min(tile.length, d.length - i)), i);
  return img;
}
