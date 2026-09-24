import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { pageContent, streamText } from './common';
import {
  MAX_SAVED_SIGNATURES, SIGNATURE_LIBRARY_PATH, addSignature, drawnSignature, emptyLibrary, padTransform, parseLibrary,
  pressureFactor, removeSignature, serializeLibrary, signatureOperators, toPage, typedSignature, type SavedSignature,
} from './signature';
import { arabicFontBytes, blankPdf, okBytes } from './test-helpers';

const rect = { x: 100, y: 100, width: 200, height: 50 };

describe('pad → page geometry', () => {
  it('scales uniformly, centres, and flips y', () => {
    const t = padTransform(400, 200, rect);
    expect(t.scale).toBe(0.25);
    // 400×200 pad → 100×50 on the page, centred horizontally in 200×50.
    expect(toPage(t, { x: 0, y: 0 })).toEqual({ x: 150, y: 150 });
    expect(toPage(t, { x: 400, y: 200 })).toEqual({ x: 250, y: 100 });
  });

  it('maps pressure to a width factor', () => {
    expect(pressureFactor(undefined)).toBe(1);
    expect(pressureFactor(0)).toBe(0.5);
    expect(pressureFactor(1)).toBe(1.5);
    expect(pressureFactor(9)).toBe(1.5);
  });

  it('writes one smooth path per stroke, width scaled with the pad', () => {
    const ops = signatureOperators([[{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }]], 400, 200, rect, { r: 0, g: 0, b: 1 }, 4);
    expect(ops).toMatch(/^0 0 1 RG\n1 J 1 j\n1 w\n/);
    expect(ops.match(/ c\n/g)?.length).toBe(2);
    expect(ops.match(/\nS/g)?.length).toBe(1);
  });

  it('varies width per segment with pressure', () => {
    const ops = signatureOperators([[{ x: 0, y: 0, p: 0 }, { x: 100, y: 0, p: 0 }, { x: 200, y: 0, p: 1 }]], 400, 200, rect, { r: 0, g: 0, b: 0 }, 4);
    const widths = [...ops.matchAll(/([\d.]+) w/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([1, 0.5, 1]);
  });
});

describe('drawnSignature', () => {
  const strokes = [[{ x: 10, y: 100 }, { x: 60, y: 20 }, { x: 110, y: 110 }, { x: 160, y: 30 }], [{ x: 20, y: 150 }, { x: 300, y: 150 }]];

  it('places a vector form XObject (Béziers, no image) on the page', async () => {
    const out = okBytes(await drawnSignature(await blankPdf(2), { page: 1, rect, strokes, padWidth: 400, padHeight: 200, color: '#000080', width: 3 }));
    const doc = await PDFDocument.load(out);
    expect(pageContent(doc, 1)).toMatch(/\/Sig\S* Do/);
    expect(pageContent(doc, 0)).toBe('');
    const xo = doc.getPage(1).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    const [key] = xo?.keys() ?? [];
    const form = doc.context.lookup(xo?.get(key)) as PDFRawStream;
    expect(form.dict.get(PDFName.of('Subtype'))?.toString()).toBe('/Form');
    const body = streamText(doc, form);
    expect(body.match(/ c\n/g)?.length).toBeGreaterThanOrEqual(4);
    expect(body).toMatch(/0 0 0.502 RG/);
    expect(body).not.toMatch(/BI|\/Image/);
  });

  it('refuses an empty drawing, a bad pad and a bad box', async () => {
    const pdf = await blankPdf();
    expect(await drawnSignature(pdf, { page: 0, rect, strokes: [], padWidth: 400, padHeight: 200, color: '#000000', width: 2 })).toMatchObject({ ok: false, detail: 'empty signature' });
    expect(await drawnSignature(pdf, { page: 0, rect, strokes, padWidth: 0, padHeight: 200, color: '#000000', width: 2 })).toMatchObject({ ok: false });
    expect(await drawnSignature(pdf, { page: 0, rect: { ...rect, width: 0 }, strokes, padWidth: 400, padHeight: 200, color: '#000000', width: 2 })).toMatchObject({ ok: false });
    expect(await drawnSignature(pdf, { page: 0, rect, strokes, padWidth: 400, padHeight: 200, color: 'x', width: 2 })).toMatchObject({ ok: false });
  });
});

describe('typedSignature', () => {
  it('writes Latin in Times Italic and Arabic with the font', async () => {
    const latin = okBytes(await typedSignature(await blankPdf(), { page: 0, rect, text: 'Faisal', color: '#000080' }));
    let doc = await PDFDocument.load(latin);
    const all = doc.context.enumerateIndirectObjects().map(([, o]) => o.toString()).join('\n');
    expect(all).toMatch(/Times-Italic/);
    const ar = okBytes(await typedSignature(await blankPdf(), { page: 0, rect, text: 'فيصل الشهراني', color: '#000080' }, arabicFontBytes()));
    doc = await PDFDocument.load(ar);
    expect(pageContent(doc, 0)).toMatch(/Do/);
    expect(await typedSignature(await blankPdf(), { page: 0, rect, text: 'فيصل', color: '#000080' })).toMatchObject({ ok: false, code: 'textNotRenderable' });
  });
});

describe('saved-signature library', () => {
  const drawn: SavedSignature = {
    id: 'a', name: 'Main', kind: 'drawn', strokes: [[{ x: 1.234, y: 2.345, p: 0.3333 }, { x: 3, y: 4 }]],
    padWidth: 400, padHeight: 200, color: '#000080', width: 3, createdAt: '2026-09-24T00:00:00.000Z',
  };
  const typed: SavedSignature = { id: 'b', name: 'Typed', kind: 'typed', text: 'فيصل', color: '#000000', createdAt: '' };

  it('adds newest first, replaces by id, removes', () => {
    let lib = addSignature(addSignature(emptyLibrary(), drawn), typed);
    expect(lib.items.map((s) => s.id)).toEqual(['b', 'a']);
    lib = addSignature(lib, { ...drawn, name: 'Renamed' });
    expect(lib.items.map((s) => [s.id, s.name])).toEqual([['a', 'Renamed'], ['b', 'Typed']]);
    expect(removeSignature(lib, 'a').items.map((s) => s.id)).toEqual(['b']);
  });

  it('caps the library size', () => {
    let lib = emptyLibrary();
    for (let i = 0; i < MAX_SAVED_SIGNATURES + 5; i++) lib = addSignature(lib, { ...typed, id: String(i) });
    expect(lib.items).toHaveLength(MAX_SAVED_SIGNATURES);
    expect(lib.items[0].id).toBe(String(MAX_SAVED_SIGNATURES + 4));
  });

  it('round-trips through JSON (coordinates rounded to 0.1 px)', () => {
    const lib = addSignature(addSignature(emptyLibrary(), drawn), typed);
    const back = parseLibrary(serializeLibrary(lib));
    expect(back.items[1].strokes).toEqual([[{ x: 1.2, y: 2.3, p: 0.33 }, { x: 3, y: 4 }]]);
    expect(back.items[0]).toEqual(typed);
    expect(SIGNATURE_LIBRARY_PATH.startsWith('/home/user/')).toBe(true);
  });

  it('drops damaged entries and survives garbage', () => {
    expect(parseLibrary('not json')).toEqual(emptyLibrary());
    expect(parseLibrary('{"items":5}')).toEqual(emptyLibrary());
    const lib = parseLibrary(JSON.stringify({ items: [
      { id: 'x', kind: 'drawn', color: '#000', strokes: [[{ x: 'a', y: 1 }]], padWidth: 10, padHeight: 10 },
      { id: 'y', kind: 'typed', color: '#000', text: '' },
      { id: 'z', kind: 'weird', color: '#000' },
      typed,
    ] }));
    expect(lib.items.map((s) => s.id)).toEqual(['b']);
  });
});
