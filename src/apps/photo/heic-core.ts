/**
 * Photo Editor — HEIC/HEIF (iPhone photos): the pure part of the decode.
 *
 * The codec itself is libheif compiled to WebAssembly (`libheif-js`, see heic-lib.ts), which
 * is only downloaded when a .heic/.heif file is actually opened. Everything that can be
 * decided without the codec lives here so it is unit-tested: sniffing the container, picking
 * the PRIMARY image of a multi-image file (bursts, depth maps, Live Photo stills) and the
 * pixel budget. The codec is injected as a tiny interface, so a
 * test can hand in a fake one.
 */
import type { PixelBuffer } from './types';
import { downscale } from './engine/core';

/** Why a HEIC decode stopped; the window turns each into a sentence (formats.ts). */
export type HeicFailure = 'unavailable' | 'failed';

export class HeicError extends Error {
  constructor(public reason: HeicFailure, detail?: string) {
    super(`heic:${reason}${detail ? `:${detail}` : ''}`);
    this.name = 'HeicError';
  }
}

/** ISO-BMFF brands that mean "a HEIF still image" (HEVC or the generic MIAF/HEIF brands). */
export const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2', 'miaf'];

/**
 * True when the bytes start like a HEIF file: an `ftyp` box whose major or compatible brand is
 * a HEIF brand. AVIF also uses `mif1`, but its major brand is `avif`, which is checked first.
 */
export function sniffHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const str = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (str(4) !== 'ftyp') return false;
  const major = str(8);
  if (major === 'avif' || major === 'avis') return false;
  if (HEIF_BRANDS.includes(major)) return true;
  const size = Math.min(bytes.length, ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0);
  for (let at = 16; at + 4 <= size; at += 4) if (HEIF_BRANDS.includes(str(at))) return true;
  return false;
}

/** The index of the primary image; the first top-level image when none is flagged. */
export function pickPrimary(count: number, isPrimary: (index: number) => boolean): number {
  for (let i = 0; i < count; i++) {
    try {
      if (isPrimary(i)) return i;
    } catch {
      // A codec build without the flag: fall back to the first image below.
    }
  }
  return 0;
}

/** The longest side that keeps `width × height` within `maxPixels` (the editor's budget). */
export function budgetSide(width: number, height: number, maxPixels: number): number | null {
  if (width * height <= maxPixels) return null;
  const f = Math.sqrt(maxPixels / (width * height));
  return Math.max(1, Math.floor(Math.max(width, height) * f));
}

/* ─────────────────────────────── the codec seam ─────────────────────────────── */

/** The part of a libheif image handle this editor uses. */
export interface HeifImageLike {
  handle?: unknown;
  get_width(): number;
  get_height(): number;
  display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (result: unknown) => void): void;
}

/** The part of the libheif module this editor uses. */
export interface HeifLibLike {
  HeifDecoder: new () => { decoder?: unknown; decode(bytes: Uint8Array): HeifImageLike[] };
  heif_image_handle_is_primary_image?(handle: unknown): number | boolean;
  heif_context_free?(ctx: unknown): void;
}

export interface HeicDecoded {
  buffer: PixelBuffer;
  note?: 'scaled';
  /** How many top-level images the file held (the editor opens the primary one). */
  images: number;
}

/**
 * Decodes the primary image of a HEIF file into straight RGBA. A picture above `maxPixels`
 * (a 48 MP iPhone shot) is reduced to the budget with an area average and flagged `scaled`.
 */
export async function decodeWithLib(lib: HeifLibLike, bytes: Uint8Array, maxPixels: number): Promise<HeicDecoded> {
  const decoder = new lib.HeifDecoder();
  try {
    let images: HeifImageLike[];
    try {
      images = decoder.decode(bytes);
    } catch (e) {
      throw new HeicError('failed', e instanceof Error ? e.message : undefined);
    }
    if (!images || images.length === 0) throw new HeicError('failed', 'no-image');
    const index = pickPrimary(images.length, (i) => !!lib.heif_image_handle_is_primary_image?.(images[i].handle));
    const image = images[index];
    const width = image.get_width();
    const height = image.get_height();
    if (!(width > 0 && height > 0)) throw new HeicError('failed', 'size');
    const target = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    const ok = await new Promise<boolean>((resolve) => {
      try {
        image.display(target, (result) => resolve(!!result));
      } catch {
        resolve(false);
      }
    });
    if (!ok) throw new HeicError('failed', 'decode');
    const side = budgetSide(width, height, maxPixels);
    if (side === null) return { buffer: target, images: images.length };
    const small = downscale(target, side);
    return { buffer: { width: small.width, height: small.height, data: small.data }, note: 'scaled', images: images.length };
  } finally {
    try { if (decoder.decoder) lib.heif_context_free?.(decoder.decoder); } catch { /* already freed */ }
  }
}
