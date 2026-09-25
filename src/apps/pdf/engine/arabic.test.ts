import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import {
  addUnicodeText, ALLAH_LIGATURE, allahLigature, baseDirection, bidiClass, dataUrlBytes, loadArabicFont, needsUnicodeFont,
  reorderClusters, reorderLine, shapeArabic, visualLine,
} from './arabic';
import { pageContent } from './common';
import { blockOperators, embedTextFonts, layoutLine, loadFontkit } from './text';
import { arabicFontBytes, blankPdf, okBytes } from './test-helpers';

const cps = (s: string): number[] => [...s].map((c) => c.codePointAt(0) as number);
const hex = (s: string): string[] => cps(s).map((c) => c.toString(16).toUpperCase().padStart(4, '0'));

/**
 * The Allah ligature. The bundled font carries one glyph for the whole word (U+FDF2), and the
 * page should show it instead of four correctly-joined letters. Each refusal below is a real
 * word that must keep its letters: the connected «بالله», the medial heh of «اللهم», and the
 * shadda of «اللّه».
 */
describe('the Allah ligature (ﷲ)', () => {
  const hasAllah = (cp: number): boolean => cp === ALLAH_LIGATURE;
  const noFont = (): boolean => false;

  it('replaces the isolated word with the font’s single glyph', () => {
    expect(hex(allahLigature('الله', hasAllah))).toEqual(['FDF2']);
    expect(hex(allahLigature('قال الله تعالى', hasAllah))).toEqual([
      '0642', '0627', '0644', '0020', 'FDF2', '0020', '062A', '0639', '0627', '0644', '0649',
    ]);
    expect(hex(allahLigature('عبد الله', hasAllah))).toEqual(['0639', '0628', '062F', '0020', 'FDF2']);
  });

  it('changes nothing when the font has no such glyph', () => {
    expect(allahLigature('الله', noFont)).toBe('الله');
    // Which is exactly the letter-by-letter shaping this engine shipped before.
    expect(hex(shapeArabic(allahLigature('الله', noFont)))).toEqual(['FE8D', 'FEDF', 'FEE0', 'FEEA']);
  });

  it('keeps letter forms where the isolated-word glyph would swallow a letter', () => {
    // «بالله»: the alef is joined to the ب, so it is a final alef, not the word's isolated one.
    expect(allahLigature('بالله', hasAllah)).toBe('بالله');
    expect(hex(shapeArabic('بالله'))).toEqual(['FE91', 'FE8E', 'FEDF', 'FEE0', 'FEEA']);
    // «تالله» — the ت joins on to the alef in the same way.
    expect(allahLigature('تالله', hasAllah)).toBe('تالله');
    // …while «والله» keeps it: a waw never joins forward.
    expect(hex(allahLigature('والله', hasAllah))).toEqual(['0648', 'FDF2']);
  });

  it('keeps letter forms when the heh is not final, or a mark sits between the letters', () => {
    // «اللهم»: the heh is medial, joined to the م, and the ligature ends in a final heh.
    expect(allahLigature('اللهم', hasAllah)).toBe('اللهم');
    expect(hex(shapeArabic('اللهم'))).toEqual(['FE8D', 'FEDF', 'FEE0', 'FEEC', 'FEE2']);
    // «اللّه»: the shadda is part of the ligature's own shape — drawing it again doubles it.
    expect(allahLigature('اللّه', hasAllah)).toBe('اللّه');
  });

  it('touches nothing else on the line', () => {
    expect(allahLigature('PDF 2026', hasAllah)).toBe('PDF 2026');
    expect(allahLigature('', hasAllah)).toBe('');
    // A mark after the word still rides on it.
    expect(hex(allahLigature('اللهُ', hasAllah))).toEqual(['FDF2', '064F']);
  });

  it('survives shaping and bidi ordering (visualLine)', () => {
    expect(hex(visualLine('الله', 'rtl', hasAllah))).toEqual(['FDF2']);
    expect(hex(visualLine('قال الله', 'rtl', hasAllah))).toEqual(['FDF2', '0020', 'FEDD', 'FE8E', 'FED7']);
    expect(hex(visualLine('قال الله', 'auto', hasAllah))).toEqual(['FDF2', '0020', 'FEDD', 'FE8E', 'FED7']);
    // With no font question asked, the page keeps the four letter forms (bidi still applies).
    expect(hex(visualLine('الله', 'rtl'))).toEqual(['FEEA', 'FEE0', 'FEDF', 'FE8D']);
  });

  it('is what the drawn line uses, and the logical text survives for copy/search', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const fonts = await embedTextFonts(doc, 'قال الله تعالى', arabicFontBytes());
    const layout = layoutLine(fonts, 'قال الله تعالى', 12);
    expect(layout.logical).toBe('قال الله تعالى');
    // Eleven glyphs, not fourteen: «الله» is ONE glyph in the page, not four.
    expect(layout.pieces).toHaveLength(11);
    expect(layout.pieces.every((p) => p.font === 'u')).toBe(true);
    expect(layout.width).toBeGreaterThan(0);
  });

  it('is a glyph the bundled font really has', async () => {
    const fk = await loadFontkit().then((kit) => kit.create(arabicFontBytes()));
    expect(fk.hasGlyphForCodePoint(ALLAH_LIGATURE)).toBe(true);
  });
});

/**
 * One line, one direction — and the five shapes a stamped paragraph really carries. Every
 * expected string below is the browser's own visual order for that line (Chrome/ICU, measured
 * with a Range per character): the engine has to agree with the browser it runs inside, or the
 * PDF will not look like the box the user typed in.
 *
 * The engine prints the DRAWN glyph sequence, so a mirrored bracket appears as its mirror here
 * (`الجدول [1]` → `[1]` reads as a pair with the brackets swapped) while the browser measurement
 * reports the character that was mirrored. Both describe the same picture.
 */
describe('direction, per line and mixed', () => {
  const required: Array<[string, 'ltr' | 'rtl', string, string]> = [
    // logical text, its own direction, the browser's visual order, the engine's visual order
    ['مرحبا بالعالم', 'rtl', 'ملاعلاب ابحرم', 'ملاعلاب ابحرم'],
    ['Hello world 2026', 'ltr', 'Hello world 2026', 'Hello world 2026'],
    ['الفاتورة 1250 ريال', 'rtl', 'لاير 1250 ةروتافلا', 'لاير 1250 ةروتافلا'],
    ['Report التقرير final', 'ltr', 'Report ريرقتلا final', 'Report ريرقتلا final'],
    ['التاريخ 05/01/2026 م', 'rtl', 'م 05/01/2026 خيراتلا', 'م 05/01/2026 خيراتلا'],
  ];

  it('orders each required line the way the browser does', () => {
    for (const [line, dir, browser, engine] of required) {
      expect(baseDirection(line), line).toBe(dir);
      expect(reorderLine(line, dir), line).toBe(engine);
      expect(reorderLine(line, dir), line).toBe(browser);
    }
  });

  it('keeps digits, decimals, times and dates in one left-to-right run', () => {
    expect(reorderLine('الميزانية 1,250.50 ريال', 'rtl')).toBe('لاير 1,250.50 ةينازيملا');
    expect(reorderLine('الوقت 10:30 صباحًا', 'rtl')).toBe('احًابص 10:30 تقولا');
    expect(reorderLine('الاجتماع يوم 2026-01-05 في الرياض', 'rtl')).toBe('ضايرلا يف 05-01-2026 موي عامتجالا');
    expect(reorderLine('سعر 12.5% فقط', 'rtl')).toBe('طقف %12.5 رعس');
  });

  it('keeps a bracketed aside together (N0), the rule this engine used to skip', () => {
    // Before N0 the closing bracket landed after the last Arabic word of the line.
    expect(reorderLine('PDF: التقرير النهائي (نسخة 2)', 'ltr')).toBe('PDF: (2 ةخسن) يئاهنلا ريرقتلا');
    // The pair inside an Arabic line is right-to-left like its contents; the digits stay LTR.
    expect(reorderLine('التقرير (2026) النهائي', 'rtl')).toBe('يئاهنلا (2026) ريرقتلا');
    expect(reorderLine('الملف (نسخة 2) جاهز', 'rtl')).toBe('زهاج (2 ةخسن) فلملا');
    // Two pairs on one line, both mirrored, both intact.
    expect(reorderLine('الجدول [1] والتقرير (2)', 'rtl')).toBe('(2) ريرقتلاو [1] لودجلا');
  });

  it('gives the pair the embedding direction when the text before it already is (N0 c)', () => {
    // Inside an LTR line with LTR context before the bracket, the pair stays LTR: both brackets
    // keep their even level, which is why this one is NOT mirrored.
    expect(reorderLine('Report (نسخة 2)', 'ltr')).toBe('Report (2 ةخسن)');
    expect(reorderLine('(نسخة 2) Report', 'ltr')).toBe('(2 ةخسن) Report');
    // The same words in an RTL paragraph are resolved as RTL.
    expect(reorderLine('Report (نسخة 2)', 'rtl')).toBe('(2 ةخسن) Report');
  });

  it('resolves the direction of every line of a paragraph on its own', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const fonts = await embedTextFonts(doc, 'مرحبا Hello 2026', arabicFontBytes());
    const lines = ['مرحبا بالعالم', 'Hello world 2026', 'التقرير 2026 Report النهائي', '10:30'];
    expect(lines.map((l) => layoutLine(fonts, l, 12).rtl)).toEqual([true, false, true, false]);
  });

  it('aligns each line by its own direction, not the first line of the block', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const fonts = await embedTextFonts(doc, 'مرحبا Hello', arabicFontBytes());
    const block = blockOperators(fonts, { l: PDFName.of('FL'), u: PDFName.of('FU') }, 'مرحبا\nHello', {
      x: 50, y: 700, size: 12, maxWidth: 120, color: { r: 0, g: 0, b: 0 },
    });
    expect(block.lines.map((l) => l.rtl)).toEqual([true, false]);
    // A `Tm` per drawn line: the Arabic line is pushed to the right edge of the box, the English
    // one starts at x. One direction for the whole block would put both at the same x.
    const xs = [...block.ops.map((o) => o.toString()).join('\n').matchAll(/([-\d.]+) ([-\d.]+) Tm/g)].map((m) => Number(m[1]));
    expect(xs).toHaveLength(2);
    expect(xs[1]).toBe(50);
    expect(xs[0]).toBeGreaterThan(50);
  });
});

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
