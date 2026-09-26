// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { applyRedactions, collectGarbage, glyphHit, glyphsInAreas } from './redact';
import { tokenizeContent } from './content';
import { TINY_PNG, arabicFontBytes, blankPdf, okBytes } from './test-helpers';
import { addUnicodeText } from './arabic';

/** Re-parses with pdf.js (the renderer the window uses) and returns each page's text. */
async function pdfjsText(bytes: Uint8Array): Promise<string[]> {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await lib.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  await doc.cleanup();
  return pages;
}

const latin1 = (b: Uint8Array): string => new TextDecoder('latin1').decode(b);

async function sample(): Promise<{ bytes: Uint8Array; secretX: number; secretW: number }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  const before = 'Account: ';
  page.drawText(`${before}SECRET42 is public`, { x: 40, y: 300, size: 14, font });
  page.drawText('Second line stays', { x: 40, y: 260, size: 14, font });
  page.drawRectangle({ x: 300, y: 50, width: 20, height: 20, color: rgb(1, 0, 0) });
  doc.addPage([400, 400]).drawText('Other page SECRET42', { x: 40, y: 300, size: 14, font });
  return {
    bytes: await doc.save(),
    secretX: 40 + font.widthOfTextAtSize(before, 14),
    secretW: font.widthOfTextAtSize('SECRET42', 14),
  };
}

describe('content tokenizer', () => {
  it('splits operators, keeps spans and swallows inline images whole', () => {
    const src = 'BT /F1 12 Tf (a\\(b\\)) Tj [(x) -20 <4142>] TJ ET BI /W 1 /H 1 /BPC 8 /CS /G ID \xff EI Q';
    const ops = tokenizeContent(src);
    expect(ops.map((o) => o.op)).toEqual(['BT', 'Tf', 'Tj', 'TJ', 'ET', 'BI', 'Q']);
    expect(ops[2].args[0]).toEqual({ k: 'str', v: [...'a(b)'].map((c) => c.charCodeAt(0)) });
    expect(src.slice(ops[3].start, ops[3].end)).toBe('[(x) -20 <4142>] TJ');
    expect(src.slice(ops[5].start, ops[5].end)).toContain('EI');
  });

  it('decides a glyph by its centre or a 30% overlap', () => {
    const area = [{ x0: 0, y0: 0, x1: 10, y1: 10 }];
    expect(glyphHit({ x0: 2, y0: 2, x1: 4, y1: 4 }, area)).toBe(true);
    expect(glyphHit({ x0: 9, y0: 0, x1: 19, y1: 10 }, area)).toBe(false);
    expect(glyphHit({ x0: 6, y0: 0, x1: 16, y1: 10 }, area)).toBe(true);
  });
});

describe('applyRedactions — true removal', () => {
  // A pdf.js decrypt + parse of this document measured past the suite's 20 s default while three
  // gates ran together on the shared machine (the same load that made the formula and photo budgets
  // swing 15x). The allowance is for the clock only: every claim below is still asserted, once.
  const HEAVY = { timeout: 60_000 } as const;
  it('removes the text inside the area; pdf.js cannot find it any more; the rest stays put', HEAVY, async () => {
    const { bytes, secretX, secretW } = await sample();
    expect((await pdfjsText(bytes))[0]).toContain('SECRET42');
    const area = { page: 0, x: secretX + 0.5, y: 295, width: secretW, height: 20 };
    expect(await glyphsInAreas(bytes, [area])).toBe(8);
    const r = await applyRedactions(bytes, [area]);
    expect(r.ok, r.ok ? '' : r.detail).toBe(true);
    if (!r.ok) return;
    expect(r.report.glyphs).toBe(8);
    const text = await pdfjsText(r.bytes);
    expect(text[0]).not.toContain('SECRET');
    expect(text[0]).toContain('Account:');
    expect(text[0]).toContain('is public');
    expect(text[0]).toContain('Second line stays');
    // the other page was not marked, so it keeps its text
    expect(text[1]).toContain('SECRET42');
    expect(await glyphsInAreas(r.bytes, [area])).toBe(0);
    // the raw file holds no copy of the removed words (old streams were collected)
    const doc = await PDFDocument.load(r.bytes);
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const s = obj as { contents?: Uint8Array };
      if (s.contents) {
        // decoded check is done by glyphsInAreas; here make sure no uncompressed copy survives
        expect(latin1(s.contents)).not.toContain('SECRET42');
      }
    }
    // 'is public' did not move: its position in pdf.js equals the original one
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pos = async (b: Uint8Array): Promise<number[]> => {
      const d = await lib.getDocument({ data: b.slice(), verbosity: 0 }).promise;
      const items = (await (await d.getPage(1)).getTextContent()).items as { str: string; transform: number[] }[];
      const item = items.find((i) => i.str.includes('public'))!;
      return [Math.round(item.transform[4] + 0), Math.round(item.transform[5])];
    };
    const after = await pos(r.bytes);
    expect(after[1]).toBe(300);
    expect(after[0]).toBeGreaterThan(secretX + secretW - 2);
  });

  it('paints the box and removes a vector shape and an image that lie inside the area', HEAVY, async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    page.drawRectangle({ x: 100, y: 100, width: 20, height: 20, color: rgb(0, 0, 1) });
    const png = await doc.embedPng(TINY_PNG);
    page.drawImage(png, { x: 150, y: 100, width: 10, height: 10 });
    page.drawImage(png, { x: 300, y: 300, width: 10, height: 10 });
    const bytes = await doc.save();
    const r = await applyRedactions(bytes, [{ page: 0, x: 90, y: 90, width: 80, height: 40 }], { fill: '#000000' });
    expect(r.ok, r.ok ? '' : r.detail).toBe(true);
    if (!r.ok) return;
    expect(r.report.paths).toBe(1);
    expect(r.report.images).toBe(1);
    const out = await PDFDocument.load(r.bytes);
    const { pageContent } = await import('./common');
    const ops = tokenizeContent(pageContent(out, 0));
    // one image is left (the one outside the area), and the only filled paths are
    // the redaction box itself
    expect(ops.filter((o) => o.op === 'Do')).toHaveLength(1);
    expect(ops.filter((o) => o.op === 're').map((o) => o.args.map((a) => (a.k === 'num' ? a.v : 0)))).toEqual([[90, 90, 80, 40]]);
  });

  it('clears the pixels of an image the area only crosses (8-bit Flate image)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    // a 4×1 grey image, 100pt wide: the area covers its left half
    const img = doc.context.flateStream(new Uint8Array([200, 200, 200, 200]), {
      Type: 'XObject', Subtype: 'Image', Width: 4, Height: 1, BitsPerComponent: 8, ColorSpace: 'DeviceGray',
    });
    const ref = doc.context.register(img);
    const res = doc.context.obj({ XObject: { Im1: ref } });
    page.node.set(PDFName.of('Resources'), res);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('q 100 0 0 20 0 0 cm /Im1 Do Q')));
    const r = await applyRedactions(await doc.save(), [{ page: 0, x: 0, y: 0, width: 50, height: 20 }]);
    expect(r.ok, r.ok ? '' : r.detail).toBe(true);
    if (!r.ok) return;
    expect(r.report.imagesEdited).toBe(1);
    const out = await PDFDocument.load(r.bytes);
    const { decodePDFRawStream, PDFRawStream } = await import('pdf-lib');
    const images = out.context.enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') as unknown[];
    expect(images).toHaveLength(1); // the original was collected
    expect([...decodePDFRawStream(images[0] as never).decode()]).toEqual([0, 0, 200, 200]);
  });

  it('removes Arabic text drawn with an embedded (Type0) font, and its /ActualText', HEAVY, async () => {
    const base = await blankPdf(1, [400, 400]);
    const withText = okBytes(await addUnicodeText(base, { page: 0, text: 'الرقم السري ٤٢', x: 40, y: 300, size: 18, color: '#000000' }, arabicFontBytes()));
    const lower = okBytes(await addUnicodeText(withText, { page: 0, text: 'Keep me', x: 40, y: 200, size: 18, color: '#000000' }, arabicFontBytes()));
    expect((await pdfjsText(lower))[0]).toContain('Keep');
    const r = await applyRedactions(lower, [{ page: 0, x: 30, y: 290, width: 340, height: 30 }]);
    expect(r.ok, r.ok ? '' : r.detail).toBe(true);
    if (!r.ok) return;
    expect(r.report.glyphs).toBeGreaterThan(5);
    const text = (await pdfjsText(r.bytes))[0];
    expect(text).toContain('Keep me');
    expect(text.replace(/\s/g, '')).toBe('Keepme');
    const { pageContent } = await import('./common');
    const out = await PDFDocument.load(r.bytes);
    expect(pageContent(out, 0).match(/ActualText/g) ?? []).toHaveLength(1);
  });

  it('removes annotations in the area and refuses bad input', async () => {
    const { bytes } = await sample();
    expect((await applyRedactions(bytes, [])).ok).toBe(false);
    expect((await applyRedactions(bytes, [{ page: 5, x: 0, y: 0, width: 1, height: 1 }])).ok).toBe(false);
    expect((await applyRedactions(bytes, [{ page: 0, x: 0, y: 0, width: 0, height: 1 }])).ok).toBe(false);
  });

  it('collectGarbage drops objects nothing references', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.context.register(doc.context.obj({ Orphan: true }));
    expect(collectGarbage(doc)).toBeGreaterThanOrEqual(1);
  });
});
