import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString } from 'pdf-lib';
import {
  addAnnotation, annotationGeometry, listAnnotations, removeAnnotation, updateAnnotation, type AnnotationInput,
} from './annotations';
import { numbersOf, streamText, textOf } from './common';
import { annotDicts, arabicFontBytes, blankPdf, get, okBytes } from './test-helpers';

const nums = (doc: PDFDocument, d: PDFDict, key: string): number[] => numbersOf(doc, d.get(PDFName.of(key)));
const name = (doc: PDFDocument, d: PDFDict, key: string): string => {
  const v = get(doc, d, key);
  return v instanceof PDFName ? v.decodeText() : '';
};
/** The decoded /AP /N stream of an annotation. */
const apText = (doc: PDFDocument, d: PDFDict): string => {
  const ap = get(doc, d, 'AP') as PDFDict;
  return streamText(doc, ap.get(PDFName.of('N')));
};

async function one(a: AnnotationInput, opts = {}): Promise<{ doc: PDFDocument; d: PDFDict; bytes: Uint8Array }> {
  const bytes = okBytes(await addAnnotation(await blankPdf(), a, opts));
  const { doc, dicts } = await annotDicts(bytes);
  expect(dicts).toHaveLength(1);
  return { doc, d: dicts[0], bytes };
}

describe('writing annotations', () => {
  it('writes a Highlight with QuadPoints in TL TR BL BR order, colour, opacity and a Multiply appearance', async () => {
    const quads = [100, 520, 300, 520, 100, 500, 300, 500];
    const { doc, d } = await one({ page: 0, kind: 'highlight', color: '#ffff00', opacity: 0.5, quads, contents: 'note' });
    expect(name(doc, d, 'Type')).toBe('Annot');
    expect(name(doc, d, 'Subtype')).toBe('Highlight');
    expect(nums(doc, d, 'QuadPoints')).toEqual(quads);
    expect(nums(doc, d, 'Rect')).toEqual([99, 499, 301, 521]);
    expect(nums(doc, d, 'C')).toEqual([1, 1, 0]);
    expect((get(doc, d, 'CA') as PDFNumber).asNumber()).toBe(0.5);
    expect((get(doc, d, 'F') as PDFNumber).asNumber()).toBe(4);
    expect(textOf(get(doc, d, 'Contents'))).toBe('note');
    expect(textOf(get(doc, d, 'NM'))).toMatch(/^fos-/);
    const ap = get(doc, d, 'AP') as PDFDict;
    const n = doc.context.lookup(ap.get(PDFName.of('N'))) as PDFRawStream;
    expect(n.dict.get(PDFName.of('Subtype'))?.toString()).toBe('/Subtype'.slice(0, 0) + '/Form');
    expect(numbersOf(doc, n.dict.get(PDFName.of('BBox')))).toEqual([99, 499, 301, 521]);
    expect(apText(doc, d)).toMatch(/1 1 0 rg[\s\S]*100 500 m 300 500 l 300 520 l 100 520 l h f/);
    expect(String(n.dict.get(PDFName.of('Resources')))).toMatch(/\/BM \/Multiply/);
  });

  it('derives QuadPoints from a rect when no quads are given', () => {
    expect(annotationGeometry({ page: 0, kind: 'underline', color: '#000000', opacity: 1, rect: { x: 10, y: 20, width: 100, height: 12 } }).quads)
      .toEqual([10, 32, 110, 32, 10, 20, 110, 20]);
  });

  it('writes Underline and StrikeOut lines at the bottom and the middle of the quad', async () => {
    const quads = [100, 514, 240, 514, 100, 500, 240, 500];
    const u = await one({ page: 0, kind: 'underline', color: '#0000ff', opacity: 1, quads });
    expect(name(u.doc, u.d, 'Subtype')).toBe('Underline');
    expect(apText(u.doc, u.d)).toMatch(/1 w 100 501 m 240 501 l S/);
    const s = await one({ page: 0, kind: 'strikeout', color: '#ff0000', opacity: 1, quads });
    expect(name(s.doc, s.d, 'Subtype')).toBe('StrikeOut');
    expect(apText(s.doc, s.d)).toMatch(/100 506.3 m 240 506.3 l S/);
  });

  it('writes Ink with an InkList per stroke and smooth Bézier appearance', async () => {
    const paths = [[{ x: 10, y: 10 }, { x: 20, y: 30 }, { x: 30, y: 10 }], [{ x: 50, y: 50 }, { x: 60, y: 60 }]];
    const { doc, d } = await one({ page: 0, kind: 'ink', color: '#008000', opacity: 0.8, width: 3, paths });
    expect(name(doc, d, 'Subtype')).toBe('Ink');
    const list = get(doc, d, 'InkList') as PDFArray;
    expect(list.size()).toBe(2);
    expect(numbersOf(doc, list.get(0))).toEqual([10, 10, 20, 30, 30, 10]);
    expect(nums(doc, d, 'Rect')).toEqual([7.5, 7.5, 62.5, 62.5]);
    expect(String(get(doc, d, 'BS'))).toMatch(/\/W 3/);
    const ap = apText(doc, d);
    expect(ap).toMatch(/0 0.502 0 RG/);
    expect(ap.match(/ c\n/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(ap).toMatch(/1 J 1 j/);
  });

  it('writes Square with interior colour and Circle as an ellipse', async () => {
    const sq = await one({ page: 0, kind: 'square', color: '#ff0000', fill: '#00ff00', opacity: 1, width: 2, rect: { x: 100, y: 100, width: 50, height: 40 } });
    expect(name(sq.doc, sq.d, 'Subtype')).toBe('Square');
    expect(nums(sq.doc, sq.d, 'IC')).toEqual([0, 1, 0]);
    expect(apText(sq.doc, sq.d)).toMatch(/101 101 48 38 re\nB/);
    const ci = await one({ page: 0, kind: 'circle', color: '#0000ff', opacity: 1, width: 1, rect: { x: 100, y: 100, width: 50, height: 40 } });
    expect(name(ci.doc, ci.d, 'Subtype')).toBe('Circle');
    expect(ci.d.get(PDFName.of('IC'))).toBeUndefined();
    expect(apText(ci.doc, ci.d).match(/ c\n/g)?.length).toBe(4);
  });

  it('writes Line and Arrow with /L and /LE, and an arrow head in the appearance', async () => {
    const l = await one({ page: 0, kind: 'line', color: '#000000', opacity: 1, width: 2, line: [10, 10, 110, 60] });
    expect(name(l.doc, l.d, 'Subtype')).toBe('Line');
    expect(nums(l.doc, l.d, 'L')).toEqual([10, 10, 110, 60]);
    expect(String(get(l.doc, l.d, 'LE'))).toBe('[ /None /None ]');
    const a = await one({ page: 0, kind: 'arrow', color: '#000000', opacity: 1, width: 2, line: [10, 10, 110, 60] });
    expect(String(get(a.doc, a.d, 'LE'))).toBe('[ /None /OpenArrow ]');
    expect(apText(a.doc, a.d).match(/ S/g)?.length).toBe(2);
  });

  it('writes a sticky note (Text) with contents, author and date', async () => {
    const { doc, d } = await one(
      { page: 0, kind: 'note', color: '#ffd700', opacity: 1, rect: { x: 50, y: 700, width: 0, height: 0 }, contents: 'راجع هذه الفقرة', author: 'فيصل' },
      { date: new Date(Date.UTC(2026, 8, 24, 10, 0, 0)) },
    );
    expect(name(doc, d, 'Subtype')).toBe('Text');
    expect(name(doc, d, 'Name')).toBe('Comment');
    expect(nums(doc, d, 'Rect')).toEqual([50, 700, 72, 722]);
    expect(textOf(get(doc, d, 'Contents'))).toBe('راجع هذه الفقرة');
    expect(textOf(get(doc, d, 'T'))).toBe('فيصل');
    expect((get(doc, d, 'M') as PDFString).decodeDate().toISOString()).toBe('2026-09-24T10:00:00.000Z');
  });

  it('writes FreeText with DA text colour, background, and Arabic shaped in its appearance', async () => {
    const { doc, d } = await one({
      page: 0, kind: 'freetext', color: '#112233', fill: '#eeeeff', opacity: 1, fontSize: 14,
      rect: { x: 50, y: 500, width: 200, height: 60 }, contents: 'مرحبا بالعالم',
    }, { arabicFont: arabicFontBytes() });
    expect(name(doc, d, 'Subtype')).toBe('FreeText');
    expect(textOf(get(doc, d, 'DA'))).toBe('/Helv 14 Tf 0.067 0.133 0.2 rg');
    expect(nums(doc, d, 'C').map((v) => Math.round(v * 255))).toEqual([238, 238, 255]);
    expect((get(doc, d, 'Q') as PDFNumber).asNumber()).toBe(2);
    const ap = apText(doc, d);
    expect(ap).toMatch(/TJ/);
    expect(ap).toMatch(/\/ActualText <FEFF0645/);
    const res = (doc.context.lookup((get(doc, d, 'AP') as PDFDict).get(PDFName.of('N'))) as PDFRawStream).dict.get(PDFName.of('Resources'));
    expect(String(res)).toMatch(/\/FU/);
  });

  it('refuses Arabic FreeText without the font, and bad colours / geometry', async () => {
    const pdf = await blankPdf();
    expect(await addAnnotation(pdf, { page: 0, kind: 'freetext', color: '#000000', opacity: 1, rect: { x: 1, y: 1, width: 50, height: 20 }, contents: 'مرحبا' }))
      .toMatchObject({ ok: false, code: 'textNotRenderable' });
    expect(await addAnnotation(pdf, { page: 0, kind: 'square', color: 'blue', opacity: 1, rect: { x: 1, y: 1, width: 5, height: 5 } })).toMatchObject({ ok: false });
    expect(await addAnnotation(pdf, { page: 0, kind: 'highlight', color: '#ffff00', opacity: 1 })).toMatchObject({ ok: false });
    expect(await addAnnotation(pdf, { page: 0, kind: 'line', color: '#000000', opacity: 1, line: [1, 1, 1, 1] })).toMatchObject({ ok: false });
    expect(await addAnnotation(pdf, { page: 5, kind: 'note', color: '#000000', opacity: 1, rect: { x: 1, y: 1, width: 5, height: 5 } })).toMatchObject({ ok: false });
  });

  it('writes a Stamp with a bordered label', async () => {
    const { doc, d } = await one({ page: 0, kind: 'stamp', color: '#cc0000', opacity: 0.9, rect: { x: 300, y: 600, width: 160, height: 50 }, contents: 'APPROVED' });
    expect(name(doc, d, 'Subtype')).toBe('Stamp');
    expect(apText(doc, d)).toMatch(/0.8 0 0 RG[\s\S]*TJ/);
  });

  it('keeps existing annotations and appends to /Annots', async () => {
    let b = okBytes(await addAnnotation(await blankPdf(2), { page: 1, kind: 'note', color: '#ffff00', opacity: 1, rect: { x: 1, y: 1, width: 20, height: 20 } }));
    b = okBytes(await addAnnotation(b, { page: 1, kind: 'square', color: '#ff0000', opacity: 1, rect: { x: 40, y: 40, width: 20, height: 20 } }));
    const { dicts } = await annotDicts(b, 1);
    expect(dicts).toHaveLength(2);
    expect((await annotDicts(b, 0)).dicts).toHaveLength(0);
  });
});

describe('reading, editing and removing annotations', () => {
  async function sample(): Promise<Uint8Array> {
    let b = await blankPdf(2);
    b = okBytes(await addAnnotation(b, { page: 0, kind: 'highlight', color: '#ffff00', opacity: 0.4, rect: { x: 10, y: 10, width: 100, height: 10 }, contents: 'hi' }));
    b = okBytes(await addAnnotation(b, { page: 0, kind: 'arrow', color: '#0000ff', opacity: 1, line: [10, 100, 60, 150] }));
    b = okBytes(await addAnnotation(b, { page: 1, kind: 'freetext', color: '#00ff00', opacity: 1, rect: { x: 10, y: 10, width: 100, height: 30 }, contents: 'box' }));
    // A foreign Link annotation, as other tools write them.
    const doc = await PDFDocument.load(b);
    const link = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [200, 200, 300, 220], C: [0, 0, 1] });
    doc.getPage(1).node.addAnnot(doc.context.register(link));
    return doc.save();
  }

  it('lists every annotation with page, index, kind, rect, contents, colour and opacity', async () => {
    const list = await listAnnotations(await sample());
    expect(list.map((a) => [a.page, a.index, a.kind, a.subtype])).toEqual([
      [0, 0, 'highlight', 'Highlight'], [0, 1, 'arrow', 'Line'], [1, 0, 'freetext', 'FreeText'], [1, 1, null, 'Link'],
    ]);
    expect(list[0]).toMatchObject({ contents: 'hi', color: '#ffff00', opacity: 0.4, rect: { x: 9, y: 9, width: 102, height: 12 } });
    expect(list[0].id).toMatch(/^fos-/);
    expect(list[2].color).toBe('#00ff00');
    expect(list[3]).toMatchObject({ id: '1:1', color: '#0000ff', opacity: 1 });
    expect(await listAnnotations(new Uint8Array([1, 2, 3]))).toEqual([]);
  });

  it('updates colour, opacity and contents, and rebuilds the appearance', async () => {
    const b = okBytes(await updateAnnotation(await sample(), 0, 0, { color: '#ff00ff', opacity: 0.7, contents: 'تم' }));
    const [a] = await listAnnotations(b);
    expect(a).toMatchObject({ color: '#ff00ff', opacity: 0.7, contents: 'تم' });
    const { doc, dicts } = await annotDicts(b);
    expect(apText(doc, dicts[0])).toMatch(/1 0 1 rg/);
  });

  it('moves an annotation: Rect, QuadPoints and L shift together', async () => {
    let b = okBytes(await updateAnnotation(await sample(), 0, 0, { dx: 5, dy: -3 }));
    b = okBytes(await updateAnnotation(b, 0, 1, { dx: 10, dy: 10 }));
    const { doc, dicts } = await annotDicts(b);
    expect(nums(doc, dicts[0], 'Rect')).toEqual([14, 6, 116, 18]);
    expect(nums(doc, dicts[0], 'QuadPoints')).toEqual([15, 17, 115, 17, 15, 7, 115, 7]);
    expect(nums(doc, dicts[1], 'L')).toEqual([20, 110, 70, 160]);
  });

  it('changes a FreeText colour through its DA', async () => {
    const b = okBytes(await updateAnnotation(await sample(), 1, 0, { color: '#123456' }));
    const list = await listAnnotations(b);
    expect(list[2].color).toBe('#123456');
  });

  it('removes one annotation and keeps the others', async () => {
    const b = okBytes(await removeAnnotation(await sample(), 0, 0));
    const list = await listAnnotations(b);
    expect(list.map((a) => a.subtype)).toEqual(['Line', 'FreeText', 'Link']);
    expect(await removeAnnotation(b, 0, 9)).toMatchObject({ ok: false });
  });

  it('refuses to edit or remove form widgets', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    doc.getForm().createTextField('name').addToPage(page, { x: 10, y: 10, width: 100, height: 20 });
    const b = await doc.save();
    expect(await removeAnnotation(b, 0, 0)).toMatchObject({ ok: false });
    expect(await updateAnnotation(b, 0, 0, { color: '#000000' })).toMatchObject({ ok: false });
  });
});
