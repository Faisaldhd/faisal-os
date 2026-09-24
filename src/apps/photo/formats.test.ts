import { describe, expect, it } from 'vitest';
import {
  EXPORT_FORMAT_LIST, FORMATS, MAX_EXPORT_BYTES, MAX_PIXELS, OPEN_EXTENSIONS, PROBE_PNG,
  REFUSAL_MESSAGES, SOURCE_FORMAT_LIST, canonicalExtension, clampQuality, decideDecode,
  decodeFailureReason, exportFormatForExtension, extensionOf, formatForExtension,
  formatOfTarget, pixelLimitExceeded, probeFormats, refusalSentence, sourceFormatOf,
  type ProbeSamples, type SourceFormat,
} from './formats';

const fullSupport: Partial<Record<SourceFormat, boolean>> = {
  png: true, jpeg: true, webp: true, gif: true, bmp: true, avif: true, svg: true,
};

describe('formats — the capability table', () => {
  it('opens exactly the seven formats the task lists, and writes the three it promises', () => {
    expect(SOURCE_FORMAT_LIST).toEqual(['png', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg']);
    expect(EXPORT_FORMAT_LIST).toEqual(['png', 'jpeg', 'webp']);
    for (const id of EXPORT_FORMAT_LIST) expect(FORMATS[id].canExport).toBe(true);
    // A format the editor cannot write must not advertise an export mime.
    expect(FORMATS.gif.exportMime).toBeUndefined();
    expect(FORMATS.bmp.exportMime).toBeUndefined();
    expect(FORMATS.svg.exportMime).toBeUndefined();
    expect(FORMATS.avif.exportMime).toBeUndefined();
  });

  it('marks exactly the animation-capable formats as animated', () => {
    expect(FORMATS.gif.animated).toBe(true);
    expect(FORMATS.webp.animated).toBe(true);
    expect(FORMATS.png.animated).toBe(true);
    expect(FORMATS.jpeg.animated).toBe(false);
    expect(FORMATS.bmp.animated).toBe(false);
  });

  it('requires a probe only where a browser can plausibly lack the codec', () => {
    expect(FORMATS.avif.needsProbe).toBe(true);
    expect(FORMATS.png.needsProbe).toBe(false);
    expect(FORMATS.jpeg.needsProbe).toBe(false);
  });

  it('maps every extension to its format, case-insensitively and with the dot', () => {
    expect(extensionOf('/home/user/Pictures/a.PNG')).toBe('.png');
    expect(extensionOf('/home/user/a.tar.gz')).toBe('.gz');
    expect(extensionOf('/home/user/README')).toBe('');
    expect(formatForExtension('.jpeg')?.id).toBe('jpeg');
    expect(formatForExtension('JPG')?.id).toBe('jpeg');
    expect(formatForExtension('.tiff')).toBeNull();
    expect(sourceFormatOf('/home/user/a.avif')).toBe('avif');
    expect(exportFormatForExtension('.webp')).toBe('webp');
    expect(exportFormatForExtension('.gif')).toBeNull();
  });

  it('advertises the extensions the manifest and the open dialog name', () => {
    expect(OPEN_EXTENSIONS).toEqual(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg']);
    for (const ext of OPEN_EXTENSIONS) expect(formatForExtension(ext)).not.toBeNull();
    expect(canonicalExtension('jpeg')).toBe('.jpg');
    expect(canonicalExtension('png')).toBe('.png');
  });
});

describe('formats — the refusal mapping', () => {
  it('accepts a supported format the runtime confirmed', () => {
    expect(decideDecode('/home/user/a.png', fullSupport, 1000, MAX_PIXELS)).toEqual(
      { kind: 'ok', format: 'png', named: '.png' },
    );
  });

  it('refuses a format the runtime probe could not decode, and names it', () => {
    const decision = decideDecode('/home/user/a.avif', { avif: false }, 100, MAX_PIXELS);
    expect(decision.kind).toBe('refuse');
    expect(decision.reason).toBe('runtime-decode');
    expect(decision.named).toBe('.avif');
    expect(decision.format).toBe('avif');
  });

  it('refuses a format that needs a probe and was never confirmed (never guesses yes)', () => {
    expect(decideDecode('/home/user/a.avif', {}, 100, MAX_PIXELS)).toMatchObject({ kind: 'refuse', reason: 'runtime-decode' });
    expect(decideDecode('/home/user/a.avif', { avif: true }, 100, MAX_PIXELS)).toMatchObject({ kind: 'ok' });
  });

  it('refuses an unknown extension, a missing extension and an empty path', () => {
    expect(decideDecode('/home/user/a.tiff', fullSupport, 1, MAX_PIXELS)).toMatchObject({ reason: 'not-an-image' });
    expect(decideDecode('/home/user/README', fullSupport, 1, MAX_PIXELS)).toMatchObject({ reason: 'no-extension' });
    expect(decideDecode('', fullSupport, 1, MAX_PIXELS)).toMatchObject({ reason: 'no-path' });
  });

  it('refuses an image over the pixel budget with the limit named', () => {
    const decision = decideDecode('/home/user/big.png', fullSupport, MAX_PIXELS + 1, MAX_PIXELS);
    expect(decision.reason).toBe('too-large');
    expect(pixelLimitExceeded(MAX_PIXELS + 1)).toBe(true);
    expect(pixelLimitExceeded(MAX_PIXELS)).toBe(false);
  });

  it('separates "this browser has no codec" from "this file is broken"', () => {
    expect(decodeFailureReason('avif', false)).toBe('runtime-decode');
    expect(decodeFailureReason('avif', true)).toBe('decode-failed');
    expect(decodeFailureReason('png', undefined)).toBe('decode-failed');
  });

  it('has one sentence for every refusal reason, in both languages, naming the form at issue', () => {
    const reasons = Object.keys(REFUSAL_MESSAGES) as (keyof typeof REFUSAL_MESSAGES)[];
    expect(reasons.sort()).toEqual([
      'cannot-export', 'cannot-open', 'decode-failed', 'no-extension', 'no-path',
      'not-an-image', 'out-of-home', 'runtime-decode', 'too-large',
    ].sort());
    for (const reason of reasons) {
      for (const locale of ['ar', 'en'] as const) {
        const text = refusalSentence(reason, locale, '.avif');
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain('{named}');
      }
      // The two languages must actually differ; identical strings mean one was never written.
      expect(refusalSentence(reason, 'ar', '.avif')).not.toBe(refusalSentence(reason, 'en', '.avif'));
    }
    expect(refusalSentence('runtime-decode', 'en', '.avif')).toContain('.avif');
  });
});

describe('formats — the runtime probe', () => {
  const samples: ProbeSamples = {
    png: { bytes: PROBE_PNG, mime: 'image/png' },
    avif: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/avif' },
    svg: { bytes: new Uint8Array([4, 5]), mime: 'image/svg+xml' },
  };

  it('asks the decoder only about the formats that need a probe', async () => {
    const asked: string[] = [];
    const result = await probeFormats(
      { decodes: async (bytes, mime) => { asked.push(mime); return mime !== 'image/avif'; } },
      samples,
    );
    expect(asked.sort()).toEqual(['image/avif', 'image/svg+xml']);
    expect(result.support.avif).toBe(false);
    expect(result.support.svg).toBe(true);
    expect(result.support.png).toBe(true);
  });

  it('reports a format with no sample bytes as unknown, not as supported', async () => {
    const result = await probeFormats({ decodes: async () => true }, { png: { bytes: PROBE_PNG, mime: 'image/png' } });
    expect(result.unknown.sort()).toEqual(['avif', 'svg']);
    expect(result.support.avif).toBeUndefined();
    expect(result.support.svg).toBeUndefined();
    // And an unconfirmed probe target is refused rather than opened.
    expect(decideDecode('/home/user/x.avif', result.support, 10, MAX_PIXELS).kind).toBe('refuse');
  });

  it('turns a thrown decoder into a refusal for that format only', async () => {
    const result = await probeFormats(
      {
        decodes: async (_bytes, mime) => {
          if (mime === 'image/svg+xml') throw new Error('no svg');
          return true;
        },
      },
      samples,
    );
    expect(result.support.svg).toBe(false);
    expect(result.support.avif).toBe(true);
  });

  it('the sample PNG really is a PNG', () => {
    expect(Array.from(PROBE_PNG.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(PROBE_PNG.length).toBeGreaterThan(40);
  });
});

describe('formats — export limits and quality', () => {
  it('caps the quality into a usable fraction', () => {
    expect(clampQuality(0.92)).toBeCloseTo(0.92, 6);
    expect(clampQuality(0)).toBe(0.05);
    expect(clampQuality(1)).toBe(1);
    expect(clampQuality(5)).toBe(1);
    expect(clampQuality(Number.NaN)).toBe(0.92);
  });

  it('states the export cap the VFS enforces', () => {
    expect(MAX_EXPORT_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_PIXELS).toBe(24_000_000);
  });

  it('derives the format a typed target name implies', () => {
    expect(formatOfTarget('/home/user/a.jpg')).toBe('jpeg');
    expect(formatOfTarget('/home/user/a.png')).toBe('png');
    expect(formatOfTarget('/home/user/a.gif')).toBeNull();
  });
});
