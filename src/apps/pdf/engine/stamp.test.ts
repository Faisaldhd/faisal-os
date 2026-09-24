import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, degrees } from 'pdf-lib';
import { listAnnotations } from './annotations';
import { pageContent } from './common';
import { addHeaderFooter, addImageStamp, addPageNumbers, addStamp, addTextWatermark, fillTokens } from './stamp';
import { TINY_PNG, arabicFontBytes, blankPdf, okBytes } from './test-helpers';

const contents = async (bytes: Uint8Array): Promise<string[]> => {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((_, i) => pageContent(doc, i));
};
const actual = (text: string): string => PDFHexString.fromText(text).toString();

describe('text watermark', () => {
  it('draws only on the selected pages, rotated and translucent', async () => {
    const out = okBytes(await addTextWatermark(await blankPdf(3), { text: 'DRAFT', pages: [1], opacity: 0.3, color: '#ff0000', rotation: 45, size: 60 }));
    const [p0, p1, p2] = await contents(out);
    expect(p0).toBe('');
    expect(p2).toBe('');
    expect(p1).toContain(actual('DRAFT'));
    expect(p1).toMatch(/\/GS\S* gs/);
    // cos 45 / sin 45 rotation matrix.
    expect(p1).toMatch(/0\.707\d* 0\.707\d* -0\.707\d* 0\.707\d* 0 0 cm/);
    expect(p1).toMatch(/297.5 421 cm/);
    expect(p1).toMatch(/1 0 0 rg/);
  });

  it('writes Arabic watermarks with the font and refuses them without', async () => {
    const out = okBytes(await addTextWatermark(await blankPdf(2), { text: 'سري للغاية' }, { arabicFont: arabicFontBytes() }));
    const all = await contents(out);
    expect(all.every((c) => c.includes(actual('سري للغاية')))).toBe(true);
    expect(await addTextWatermark(await blankPdf(), { text: 'سري' })).toMatchObject({ ok: false, code: 'textNotRenderable' });
  });

  it('refuses empty text, bad sizes and an empty page selection', async () => {
    const pdf = await blankPdf(2);
    expect(await addTextWatermark(pdf, { text: '  ' })).toMatchObject({ ok: false });
    expect(await addTextWatermark(pdf, { text: 'X', size: 1000 })).toMatchObject({ ok: false });
    expect(await addTextWatermark(pdf, { text: 'X', pages: [7] })).toMatchObject({ ok: false, code: 'emptyResult' });
  });

  it('centres in the page as SHOWN on a rotated page', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]).setRotation(degrees(90));
    const out = okBytes(await addTextWatermark(await doc.save(), { text: 'X' }));
    const [p] = await contents(out);
    expect(p).toMatch(/0 1 -1 0 600 0 cm/);
    expect(p).toMatch(/400 300 cm/);
  });
});

describe('page numbers and header/footer', () => {
  it('fills {n} and {total}', () => {
    expect(fillTokens('صفحة {n} من {total}', 3, 9)).toBe('صفحة 3 من 9');
  });

  it('numbers every page "x / y" in the footer', async () => {
    const out = okBytes(await addPageNumbers(await blankPdf(3)));
    const all = await contents(out);
    all.forEach((c, i) => expect(c).toContain(actual(`${i + 1} / 3`)));
  });

  it('numbers only the chosen pages, from a chosen start', async () => {
    const out = okBytes(await addPageNumbers(await blankPdf(3), { pages: [1, 2], startAt: 0, format: 'p{n}' }));
    const [a, b, c] = await contents(out);
    expect(a).toBe('');
    expect(b).toContain(actual('p1'));
    expect(c).toContain(actual('p2'));
  });

  it('writes header and footer slots, Arabic included', async () => {
    const out = okBytes(await addHeaderFooter(await blankPdf(1), {
      header: { right: 'تقرير سري', left: 'Fai$al OS' }, footer: { center: '{n}' },
    }, { arabicFont: arabicFontBytes() }));
    const [p] = await contents(out);
    expect(p).toContain(actual('تقرير سري'));
    expect(p).toContain(actual('Fai$al OS'));
    expect(p).toContain(actual('1'));
    expect(await addHeaderFooter(await blankPdf(), {})).toMatchObject({ ok: false });
  });
});

describe('stamps', () => {
  it('addStamp writes a movable /Stamp annotation', async () => {
    const out = okBytes(await addStamp(await blankPdf(), { page: 0, rect: { x: 300, y: 700, width: 150, height: 50 }, text: 'معتمد', color: '#c00000' }, { arabicFont: arabicFontBytes() }));
    const [a] = await listAnnotations(out);
    expect(a).toMatchObject({ kind: 'stamp', subtype: 'Stamp', contents: 'معتمد', color: '#c00000' });
  });

  it('addImageStamp draws a PNG on the chosen pages only, and refuses other bytes', async () => {
    const out = okBytes(await addImageStamp(await blankPdf(2), { pages: [0], rect: { x: 10, y: 10, width: 40, height: 40 }, image: TINY_PNG, opacity: 0.5 }));
    const [a, b] = await contents(out);
    expect(a).toMatch(/Do/);
    expect(b).toBe('');
    expect(await addImageStamp(await blankPdf(), { pages: [0], rect: { x: 1, y: 1, width: 5, height: 5 }, image: new Uint8Array([1, 2, 3]) }))
      .toMatchObject({ ok: false, code: 'imageUnsupported' });
  });
});
