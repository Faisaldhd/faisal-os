import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import {
  addUnicodeText, baseDirection, bidiClass, dataUrlBytes, loadArabicFont, needsUnicodeFont, reorderClusters, reorderLine,
  shapeArabic, visualLine,
} from './arabic';
import { pageContent } from './common';
import { arabicFontBytes, blankPdf, okBytes } from './test-helpers';

const cps = (s: string): number[] => [...s].map((c) => c.codePointAt(0) as number);
const hex = (s: string): string[] => cps(s).map((c) => c.toString(16).toUpperCase().padStart(4, '0'));

describe('Arabic shaping (Presentation Forms-B)', () => {
  it('shapes "السلام عليكم" letter by letter, with the lam-alef ligature', () => {
    expect(hex(shapeArabic('السلام عليكم'))).toEqual([
      'FE8D', 'FEDF', 'FEB4', 'FEFC', 'FEE1', '0020', 'FECB', 'FEE0', 'FEF4', 'FEDC', 'FEE2',
    ]);
  });

  it('turns a lone "لا" into the isolated ligature and a joined one into the final ligature', () => {
    expect(hex(shapeArabic('لا'))).toEqual(['FEFB']);
    expect(hex(shapeArabic('سلا'))).toEqual(['FEB3', 'FEFC']);
    expect(hex(shapeArabic('لأ'))).toEqual(['FEF7']);
    expect(hex(shapeArabic('لإ'))).toEqual(['FEF9']);
    expect(hex(shapeArabic('لآ'))).toEqual(['FEF5']);
  });

  it('keeps tashkeel on its letter and lets it not break the joining', () => {
    // مُحَمَّد
    const word = 'مُحَمَّد';
    expect(hex(shapeArabic(word))).toEqual(['FEE3', '064F', 'FEA4', '064E', 'FEE4', '0651', '064E', 'FEAA']);
  });

  it('keeps marks between lam and alef after the ligature', () => {
    expect(hex(shapeArabic('لَا'))).toEqual(['FEFB', '064E']);
  });

  it('respects right-joining and non-joining letters', () => {
    expect(hex(shapeArabic('ءا'))).toEqual(['FE80', 'FE8D']);
    expect(hex(shapeArabic('دب'))).toEqual(['FEA9', 'FE8F']);
    expect(hex(shapeArabic('بد'))).toEqual(['FE91', 'FEAA']);
    expect(hex(shapeArabic('ببب'))).toEqual(['FE91', 'FE92', 'FE90']);
  });

  it('shapes the Persian letters from Presentation Forms-A', () => {
    expect(hex(shapeArabic('پی'))).toEqual(['FB58', 'FBFD']);
    expect(hex(shapeArabic('گ'))).toEqual(['FB92']);
  });

  it('leaves non-Arabic text untouched and tatweel joining both sides', () => {
    expect(shapeArabic('PDF 2026')).toBe('PDF 2026');
    expect(hex(shapeArabic('بـب'))).toEqual(['FE91', '0640', 'FE90']);
  });
});

describe('bidi (UAX #9 subset, one line)', () => {
  it('classifies the characters it needs', () => {
    expect(bidiClass(0x627)).toBe('AL');
    expect(bidiClass(0x41)).toBe('L');
    expect(bidiClass(0x31)).toBe('EN');
    expect(bidiClass(0x661)).toBe('AN');
    expect(bidiClass(0x64e)).toBe('NSM');
    expect(bidiClass(0x20)).toBe('WS');
    expect(bidiClass(0xfefb)).toBe('AL');
  });

  it('finds the paragraph direction from the first strong character', () => {
    expect(baseDirection('123 abc سلام')).toBe('ltr');
    expect(baseDirection('123 سلام abc')).toBe('rtl');
    expect(baseDirection('123', 'rtl')).toBe('rtl');
  });

  it('leaves pure LTR text alone and reverses pure RTL text', () => {
    expect(reorderLine('abc def', 'ltr')).toBe('abc def');
    expect(reorderLine('سلام', 'rtl')).toBe('مالس');
  });

  it('keeps European numbers left-to-right inside RTL text', () => {
    expect(reorderLine('مرحبا 2026', 'rtl')).toBe('2026 ابحرم');
    expect(reorderLine('رقم 12.5 هنا', 'rtl')).toBe('انه 12.5 مقر');
  });

  it('keeps Arabic-Indic numbers left-to-right too', () => {
    expect(reorderLine('رقم ١٢٣', 'rtl')).toBe('١٢٣ مقر');
  });

  it('keeps a Latin phrase in order inside an RTL line', () => {
    expect(reorderLine('سلام abc def', 'rtl')).toBe('abc def مالس');
  });

  it('keeps an Arabic word reversed inside an LTR line', () => {
    expect(reorderLine('abc سلام def', 'ltr')).toBe('abc مالس def');
  });

  it('attaches percent signs to their number (W5)', () => {
    expect(reorderLine('50% خصم', 'rtl')).toBe('مصخ 50%');
  });

  it('mirrors brackets in RTL runs', () => {
    expect(reorderLine('(سلام)', 'rtl')).toBe('(مالس)');
  });

  it('never separates a mark from its base', () => {
    expect(reorderLine('بَت', 'rtl')).toBe('تبَ');
    const clusters = reorderClusters('بَت', 'rtl');
    expect(clusters.map((c) => c.text)).toEqual(['ت', 'بَ']);
    expect(clusters.every((c) => c.level === 1)).toBe(true);
  });

  it('puts trailing spaces back at paragraph level (L1)', () => {
    expect(reorderLine('abc  ', 'rtl')).toBe('  abc');
    expect(reorderLine('abc سلام  ', 'ltr')).toBe('abc مالس  ');
  });

  it('shapes then orders a mixed line (visualLine)', () => {
    expect(hex(visualLine('لا 1'))).toEqual(['0031', '0020', 'FEFB']);
  });
});

describe('needsUnicodeFont', () => {
  it('is false for what the standard fonts encode and true for Arabic', () => {
    expect(needsUnicodeFont('Hello, world!')).toBe(false);
    expect(needsUnicodeFont('café € — “x”')).toBe(false);
    expect(needsUnicodeFont('line1\nline2')).toBe(false);
    expect(needsUnicodeFont('مرحبا')).toBe(true);
    expect(needsUnicodeFont('abc ١')).toBe(true);
  });
});

describe('the font file', () => {
  it('decodes a data URL', () => {
    expect([...dataUrlBytes('data:font/ttf;base64,AAEAAA==')]).toEqual([0, 1, 0, 0]);
  });

  it('loadArabicFont returns the bundled TrueType font, cached', async () => {
    const a = await loadArabicFont();
    expect([...a.slice(0, 4)]).toEqual([0, 1, 0, 0]);
    expect(a.length).toBe(arabicFontBytes().length);
    expect(await loadArabicFont()).toBe(a);
  });
});

describe('addUnicodeText', () => {
  it('writes shaped Arabic with an embedded font subset and a logical ActualText', async () => {
    const out = okBytes(await addUnicodeText(await blankPdf(), {
      page: 0, text: 'السلام عليكم\nلا 2026', x: 50, y: 700, size: 20, color: '#112233',
    }, arabicFontBytes()));
    const doc = await PDFDocument.load(out);
    const content = pageContent(doc, 0);
    expect(content).toContain('TJ');
    expect(content).toContain(PDFHexString.fromText('السلام عليكم').toString());
    expect(content).toContain(PDFHexString.fromText('لا 2026').toString());
    expect(content).toContain('0.0667 0.1333 0.2 rg');
    const fonts = doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'));
    const text = String(fonts);
    expect(text).toMatch(/FU/);
    // A Type0 font with an embedded TrueType program is somewhere in the file.
    const all = doc.context.enumerateIndirectObjects().map(([, o]) => o.toString()).join('\n');
    expect(all).toMatch(/\/Subtype \/Type0/);
    expect(all).toMatch(/\/FontFile2/);
    expect(out.length).toBeLessThan(80_000); // subset, not the whole 155 KB font
  });

  it('does not embed the Unicode font for plain Latin', async () => {
    const out = okBytes(await addUnicodeText(await blankPdf(), { page: 0, text: 'Hello', x: 50, y: 700, size: 20, color: '#000000' }, arabicFontBytes()));
    const doc = await PDFDocument.load(out);
    const all = doc.context.enumerateIndirectObjects().map(([, o]) => o.toString()).join('\n');
    expect(all).not.toMatch(/\/Type0/);
  });

  it('refuses Arabic without the font, and bad input, before writing', async () => {
    const pdf = await blankPdf();
    const noFont = await addUnicodeText(pdf, { page: 0, text: 'مرحبا', x: 1, y: 1, size: 12, color: '#000000' }, new Uint8Array());
    expect(noFont).toMatchObject({ ok: false, code: 'textNotRenderable' });
    expect(await addUnicodeText(pdf, { page: 3, text: 'a', x: 1, y: 1, size: 12, color: '#000000' }, arabicFontBytes())).toMatchObject({ ok: false });
    expect(await addUnicodeText(pdf, { page: 0, text: ' ', x: 1, y: 1, size: 12, color: '#000000' }, arabicFontBytes())).toMatchObject({ ok: false, detail: 'emptyText' });
    expect(await addUnicodeText(pdf, { page: 0, text: 'a', x: 1, y: 1, size: 12, color: 'red' }, arabicFontBytes())).toMatchObject({ ok: false, detail: 'badColor' });
  });

  it('refuses a character no font has (emoji)', async () => {
    const r = await addUnicodeText(await blankPdf(), { page: 0, text: 'سلام 😀', x: 1, y: 100, size: 12, color: '#000000' }, arabicFontBytes());
    expect(r).toMatchObject({ ok: false, code: 'textNotRenderable' });
  });
});
