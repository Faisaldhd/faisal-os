/**
 * Tests for the ZIP writer, read back with the viewer's own reader — the writer and
 * the reader are the two halves of the same contract, so they are tested together.
 * (`src/apps/viewer` is imported read-only; nothing here modifies it.)
 */
import { describe, expect, it } from 'vitest';
import { crc32, utf8, writeZip } from './zip';
import { openZip, zipEntries } from '../viewer/formats';

describe('crc32', () => {
  it('matches the standard check value of "123456789"', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
  });

  it('is 0 for empty input and stable across calls', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    const data = utf8('Fai$al OS');
    expect(crc32(data)).toBe(crc32(data));
  });
});

describe('writeZip', () => {
  it('round-trips names and bytes through the viewer reader', async () => {
    const parts = [
      { name: '[Content_Types].xml', data: utf8('<Types/>') },
      { name: 'word/document.xml', data: utf8('<w:document/>') },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ];
    const bytes = writeZip(parts);
    const entries = zipEntries(bytes);
    expect(entries.map((e) => e.name)).toEqual(parts.map((p) => p.name));
    for (const entry of entries) {
      expect(entry.method).toBe(0); // stored: no compressor, and the reader accepts it
      expect(entry.compressed).toBe(entry.size);
    }
    const zip = openZip(bytes);
    expect(zip.names()).toEqual(parts.map((p) => p.name));
    for (const part of parts) {
      const data = await zip.read(part.name);
      expect(Array.from(data ?? []), part.name).toEqual(Array.from(part.data));
    }
    await expect(zip.read('missing.xml')).resolves.toBeNull();
  });

  it('writes an empty but readable archive', () => {
    const bytes = writeZip([]);
    expect(bytes.length).toBe(22); // just the end-of-central-directory record
    expect(zipEntries(bytes)).toEqual([]);
  });

  it('keeps UTF-8 names and non-ASCII content intact', async () => {
    const text = 'طابور — صف ١';
    const bytes = writeZip([{ name: 'مجلد/ملف.xml', data: utf8(text) }]);
    const entry = zipEntries(bytes)[0];
    expect(entry.name).toBe('مجلد/ملف.xml');
    expect(entry.compressed).toBeGreaterThan(text.length); // multi-byte, stored as-is
    const data = await openZip(bytes).read('مجلد/ملف.xml');
    expect(new TextDecoder().decode(data ?? new Uint8Array())).toBe(text);
  });

  it('round-trips a large part unchanged', async () => {
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) % 256;
    const bytes = writeZip([{ name: 'xl/worksheets/sheet1.xml', data: big }, { name: 'a.xml', data: utf8('x') }]);
    const data = await openZip(bytes).read('xl/worksheets/sheet1.xml');
    expect(Array.from(data ?? [])).toEqual(Array.from(big));
  });

  it('refuses a duplicate or empty entry name', () => {
    const one = { name: 'a.xml', data: utf8('a') };
    expect(() => writeZip([one, { name: 'a.xml', data: utf8('b') }])).toThrow(/duplicate/);
    expect(() => writeZip([{ name: '', data: utf8('a') }])).toThrow(/empty/);
  });
});
