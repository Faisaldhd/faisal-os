/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { budgetSide, decodeWithLib, HeicError, pickPrimary, sniffHeif, type HeifImageLike, type HeifLibLike } from './heic-core';
import { DecodeRefusal, decodeSource } from './decode';
import { FORMATS, MANIFEST_OPENS, PICKER_ACCEPT, PROJECT_OPEN_EXT, formatForExtension, refusalSentence } from './formats';
import { PROJECT_EXT } from './project';

/** An `ftyp` box: size, 'ftyp', major brand, minor version, compatible brands. */
function ftyp(major: string, compatible: string[] = []): Uint8Array {
  const size = 16 + compatible.length * 4;
  const out = new Uint8Array(size + 8);
  out[3] = size;
  const put = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  put(4, 'ftyp');
  put(8, major);
  compatible.forEach((b, i) => put(16 + i * 4, b));
  return out;
}

function fakeImage(w: number, h: number, rgba: number[], primary = false): HeifImageLike & { handle: { primary: boolean } } {
  return {
    handle: { primary },
    get_width: () => w,
    get_height: () => h,
    display(target, done) {
      for (let i = 0; i < target.data.length; i += 4) target.data.set(rgba, i);
      setTimeout(() => done(target), 0);
    },
  };
}

function fakeLib(images: HeifImageLike[], opts: { throws?: boolean } = {}): HeifLibLike & { freed: number } {
  const lib = {
    freed: 0,
    HeifDecoder: class {
      decoder = {};
      decode(): HeifImageLike[] {
        if (opts.throws) throw new Error('bad');
        return images;
      }
    },
    heif_image_handle_is_primary_image: (h: unknown) => ((h as { primary: boolean }).primary ? 1 : 0),
    heif_context_free: () => { lib.freed++; },
  };
  return lib;
}

describe('HEIC — container sniffing and primary image', () => {
  it('recognises HEIF brands and rejects AVIF, JPEG and short input', () => {
    expect(sniffHeif(ftyp('heic'))).toBe(true);
    expect(sniffHeif(ftyp('mif1', ['heic']))).toBe(true);
    expect(sniffHeif(ftyp('isom', ['mif1']))).toBe(true);
    expect(sniffHeif(ftyp('avif', ['mif1']))).toBe(false);
    expect(sniffHeif(ftyp('isom', ['mp41']))).toBe(false);
    expect(sniffHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(sniffHeif(new Uint8Array(4))).toBe(false);
  });

  it('picks the flagged primary image, else the first; a throwing flag is ignored', () => {
    expect(pickPrimary(3, (i) => i === 2)).toBe(2);
    expect(pickPrimary(3, () => false)).toBe(0);
    expect(pickPrimary(2, (i) => { if (i === 0) throw new Error('x'); return true; })).toBe(1);
  });

  it('keeps pictures inside the pixel budget', () => {
    expect(budgetSide(100, 100, 10_000)).toBeNull();
    const side = budgetSide(8064, 6048, 24_000_000)!;
    expect(side).toBeLessThan(8064);
    expect(side * Math.round(side * 6048 / 8064)).toBeLessThanOrEqual(24_000_000);
  });
});

describe('HEIC — decode through the codec seam', () => {
  it('decodes the primary image of a multi-image file and frees the context', async () => {
    const lib = fakeLib([fakeImage(2, 2, [1, 2, 3, 255]), fakeImage(3, 1, [200, 100, 50, 255], true)]);
    const out = await decodeWithLib(lib, new Uint8Array(8), 1000);
    expect([out.buffer.width, out.buffer.height, out.images]).toEqual([3, 1, 2]);
    expect(Array.from(out.buffer.data.slice(0, 4))).toEqual([200, 100, 50, 255]);
    expect(out.note).toBeUndefined();
    expect(lib.freed).toBe(1);
  });

  it('scales an over-budget picture down and says so', async () => {
    const out = await decodeWithLib(fakeLib([fakeImage(40, 20, [9, 9, 9, 255])]), new Uint8Array(8), 200);
    expect(out.note).toBe('scaled');
    expect(out.buffer.width * out.buffer.height).toBeLessThanOrEqual(200);
    expect(out.buffer.data[0]).toBe(9);
  });

  it('turns a parse error, an empty file and a failed decode into HeicError("failed")', async () => {
    await expect(decodeWithLib(fakeLib([], { throws: true }), new Uint8Array(8), 100)).rejects.toMatchObject({ reason: 'failed' });
    await expect(decodeWithLib(fakeLib([]), new Uint8Array(8), 100)).rejects.toBeInstanceOf(HeicError);
    const broken: HeifImageLike = { get_width: () => 2, get_height: () => 2, display: (_t, done) => done(null) };
    await expect(decodeWithLib(fakeLib([broken]), new Uint8Array(8), 100)).rejects.toMatchObject({ reason: 'failed' });
  });

  it('refuses with a named, localised "decoder unavailable" when the codec cannot start', async () => {
    // jsdom has no Worker and no createImageBitmap: exactly the "cannot load" path.
    const err = await decodeSource(ftyp('heic'), '/home/user/Pictures/IMG_0001.HEIC').catch((e) => e);
    expect(err).toBeInstanceOf(DecodeRefusal);
    expect((err as DecodeRefusal).reason).toBe('decoder-unavailable');
    expect(refusalSentence('decoder-unavailable', 'ar', 'heic')).toContain('heic');
    expect(refusalSentence('decoder-unavailable', 'en', 'heic')).toContain('heic');
  });
});

describe('HEIC — wiring', () => {
  it('opens .heic/.heif (never exports them), from the manifest and the device picker', () => {
    expect(formatForExtension('.HEIC')?.id).toBe('heic');
    expect(formatForExtension('.heif')?.id).toBe('heic');
    expect(FORMATS.heic.canExport).toBe(false);
    expect(FORMATS.heic.exportMime).toBeUndefined();
    expect(MANIFEST_OPENS).toEqual(expect.arrayContaining(['.heic', '.heif', '.fphoto']));
    expect(PICKER_ACCEPT.split(',')).toEqual(expect.arrayContaining(['image/*', '.heic', '.heif', '.fphoto']));
    expect(PROJECT_OPEN_EXT).toBe(PROJECT_EXT);
  });

  it('loads the codec lazily: only the worker imports libheif, and only dynamically from decode.ts', () => {
    const src = (f: string) => readFileSync(resolve(__dirname, f), 'utf8');
    for (const f of ['index.ts', 'decode.ts', 'gallery.ts', 'heic.ts', 'heic-core.ts', 'formats.ts', 'manifest.ts']) {
      expect(src(f), f).not.toMatch(/from ['"]libheif-js|from ['"]\.\/heic-lib/);
    }
    expect(src('decode.ts')).not.toMatch(/from ['"]\.\/heic['"]/);
    expect(src('decode.ts')).toMatch(/import\(['"]\.\/heic['"]\)/);
    expect(src('heic.worker.ts')).toMatch(/from ['"]\.\/heic-lib['"]/);
    // Our own origin: the wasm comes from the bundle (`?url`), never from a CDN.
    expect(src('heic-lib.ts')).toMatch(/libheif\.wasm\?url/);
    expect(src('heic-lib.ts')).not.toMatch(/https?:\/\//);
  });
});
