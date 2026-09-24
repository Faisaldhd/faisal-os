/**
 * Photo Editor — the decode layer: raw file bytes → pixels, plus the runtime capability
 * probe behind the format table.
 *
 * Only the browser's own decoders are used. `createImageBitmap` is preferred (it decodes off
 * the main thread and can downscale in one step); the fallback is an `Image` loaded from a
 * `data:` URL, which is also the only path used for SVG because `createImageBitmap` refuses
 * SVG in most browsers. Nothing is fetched from the network: the bytes come from the VFS.
 *
 * The probe runs once per window and answers the honest question "can THIS browser decode this
 * format?" by pushing a tiny sample through the same code a real file takes. A format whose
 * sample cannot be built is reported `unknown` and refused rather than promised.
 */
import type { PixelBuffer } from './types';
import {
  REFUSAL_MESSAGES, MAX_PIXELS, PROBE_PNG, decideDecode, decodeFailureReason, extensionOf,
  formatForExtension, probeFormats, type ProbeSamples, type RefusalReason, type SourceFormat,
} from './formats';

export interface DecodedImage {
  buffer: PixelBuffer;
  /** Filled when the result had to be reduced; shown to the user instead of staying silent. */
  note?: 'scaled';
}

/** A refusal raised during decode; the window turns `reason` into a sentence that names it. */
export class DecodeRefusal extends Error {
  constructor(public reason: RefusalReason) {
    super(`refuse:${reason}`);
    this.name = 'DecodeRefusal';
  }
}

export function refusalText(reason: RefusalReason, locale: 'ar' | 'en', named: string): string {
  const entry = REFUSAL_MESSAGES[reason];
  return (locale === 'ar' ? entry.ar : entry.en).split('{named}').join(named);
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  // Chunked, so a large file does not blow the argument limit of String.fromCharCode.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function loadViaImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // A data: URL is the sandbox this editor relies on for SVG: it cannot load sub-resources,
    // scripts never run, and no external reference is followed.
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode-failed'));
    img.src = source;
  });
}

function toBuffer(source: CanvasImageSource, width: number, height: number): PixelBuffer {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('decode-failed');
  ctx.drawImage(source, 0, 0, width, height);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

/**
 * Decodes through a blob URL + `createImageBitmap`, downscaling anything above the editor's
 * pixel budget. Returns `scaled` as the note when it had to reduce, so the UI can say so.
 */
export async function decodeViaBitmap(bytes: Uint8Array, mime: string): Promise<DecodedImage> {
  const blob = new Blob([bytes.slice()], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    let bitmap = await createImageBitmap(blob);
    let width = bitmap.width;
    let height = bitmap.height;
    let note: DecodedImage['note'];
    if (width * height > MAX_PIXELS) {
      const scale = Math.sqrt(MAX_PIXELS / (width * height));
      const scaled = await createImageBitmap(blob, {
        resizeWidth: Math.max(1, Math.floor(width * scale)),
        resizeHeight: Math.max(1, Math.floor(height * scale)),
        resizeQuality: 'high',
      });
      bitmap.close();
      bitmap = scaled;
      width = bitmap.width;
      height = bitmap.height;
      note = 'scaled';
    }
    if (!width || !height) throw new Error('decode-failed');
    const buffer = toBuffer(bitmap, width, height);
    bitmap.close();
    return { buffer, note };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The data: URL path: used for SVG, and as the fallback when `createImageBitmap` is absent. */
export async function decodeViaDataUrl(bytes: Uint8Array, mime: string): Promise<DecodedImage> {
  const img = await loadViaImage(toDataUrl(bytes, mime));
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error('decode-failed');
  if (width * height > MAX_PIXELS) throw new DecodeRefusal('too-large');
  return { buffer: toBuffer(img, width, height) };
}

/** The single entry point a window uses: extension → refusal (naming the format) → pixels. */
export async function decodeSource(bytes: Uint8Array, path: string): Promise<DecodedImage> {
  const named = extensionOf(path) || path;
  const info = formatForExtension(named);
  if (!info) throw new DecodeRefusal('not-an-image');
  if (!info.canOpen) throw new DecodeRefusal('cannot-open');

  try {
    if (info.id === 'svg' || typeof createImageBitmap !== 'function') {
      return await decodeViaDataUrl(bytes, info.mime);
    }
    return await decodeViaBitmap(bytes, info.mime);
  } catch (error) {
    if (error instanceof DecodeRefusal) throw error;
    // A codec the browser does not have and a broken file look identical from here, so the
    // message names the format and says both possibilities rather than guessing.
    throw new DecodeRefusal(decodeFailureReason(info.id, undefined));
  }
}

/* ─────────────────────────────── runtime probe ─────────────────────────────── */

/** True when the sample decoded into a real RGBA buffer of the expected size. */
async function decodes(bytes: Uint8Array, mime: string): Promise<boolean> {
  const decoded = mime === 'image/svg+xml'
    ? await decodeViaDataUrl(bytes, mime)
    : await decodeViaBitmap(bytes, mime);
  return decoded.buffer.width > 0 && decoded.buffer.height > 0 && decoded.buffer.data.length > 0;
}

/** A 1×1 GIF89a (transparent), a literal sample because a canvas cannot encode GIF. */
export const GIF_1PX = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

/** A 1×1 24-bit BMP (54-byte header plus one padded pixel row). */
export const BMP_1PX = new Uint8Array([
  0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00, 0x28, 0x00,
  0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x18, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00,
]);

const SVG_1PX = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#3366ff"/></svg>',
);

/**
 * 1×1 samples built once, in memory. PNG/GIF/BMP/SVG have literal bytes; JPEG and WebP come
 * from the canvas encoder, and a browser that cannot encode them simply has no sample — which
 * `probeFormats` reports as `unknown`, never as supported.
 */
export function buildProbeSamples(): ProbeSamples {
  const samples: ProbeSamples = {
    png: { bytes: PROBE_PNG, mime: 'image/png' },
    gif: { bytes: GIF_1PX, mime: 'image/gif' },
    bmp: { bytes: BMP_1PX, mime: 'image/bmp' },
    svg: { bytes: SVG_1PX, mime: 'image/svg+xml' },
  };
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return samples;
    ctx.fillStyle = '#3366ff';
    ctx.fillRect(0, 0, 1, 1);
    for (const [mime, id, quality] of [
      ['image/jpeg', 'jpeg', 0.8],
      ['image/webp', 'webp', 0.8],
      ['image/avif', 'avif', 0.8],
    ] as const) {
      // `toDataURL` silently falls back to PNG when the browser cannot encode the type, so
      // the prefix is checked: a WebP sample that is really a PNG would report a false "yes".
      const url = canvas.toDataURL(mime, quality);
      if (!url.startsWith(`data:${mime}`)) continue;
      const base64 = url.slice(url.indexOf(',') + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      samples[id] = { bytes, mime };
    }
  } catch {
    // No canvas encoder in this context: the literal samples above are still used.
  }
  return samples;
}

/**
 * Probes this browser once, returning `{ format: isDecodable }`. Formats not listed keep
 * `undefined`, which `decideDecode` treats as "not confirmed" — the honest direction.
 */
export async function probeRuntime(): Promise<Partial<Record<SourceFormat, boolean>>> {
  try {
    const result = await probeFormats({ decodes }, buildProbeSamples());
    return result.support;
  } catch {
    return {};
  }
}

/**
 * Confirms one path can be decoded right now, for the open dialog and the launch argument.
 * Returns the refusal reason instead of a boolean so the caller can name the format.
 */
export function refusalForPath(path: string): RefusalReason | null {
  const named = path ? extensionOf(path) : '';
  if (!path) return 'no-path';
  if (!named) return 'no-extension';
  const info = formatForExtension(named);
  if (!info) return 'not-an-image';
  if (!info.canOpen) return 'cannot-open';
  return null;
}

/** Re-exported so the window can call `decideDecode` for the pixel-budget check. */
export { decideDecode };
