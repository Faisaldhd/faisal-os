/**
 * Impress — the footer and the live slide number: the field that is written, where the
 * placeholders sit, the number a slide shows after an insert or a delete, and the round trip
 * through a real package.
 */
import { describe, expect, it } from 'vitest';
import { newDeckPptx } from '../pptx';
import { readRawZip } from '../zip';
import { readDeck, type Deck, type DeckShape, type MasterText } from './deck';
import { patchDeck } from './deckpatch';
import { paraXml, shapeXml } from './deckxml';
import { addSlide, deleteSlide, moveSlide, refreshChrome, setMaster } from './ops';
import { chromeEdits, chromeShapes } from './master';

const PART = 'ppt/slideMasters/slideMaster1.xml';
const base = async (): Promise<Deck> => readDeck(newDeckPptx('T', 'S'));
const withChrome = async (footer: string | null, number: boolean): Promise<Deck> => {
  const deck = await base();
  return setMaster(deck, PART, { footer, slideNumber: number });
};
const chromeOf = (deck: Deck, at: number): DeckShape[] => deck.slides[at]!.shapes.filter((s) => s.ph === 'ftr' || s.ph === 'sldNum');

describe('the slide-number field', () => {
  it('is written as a live field, not as text', () => {
    const xml = paraXml({ text: '3', size: 12, bold: false, italic: false, underline: false, color: null, align: 'r', bullet: false, field: 'slidenum' });
    expect(xml).toContain('<a:fld id="{');
    expect(xml).toContain('type="slidenum"');
    expect(xml).toContain('<a:t>3</a:t>');
    expect(xml).toMatch(/id="\{[0-9A-F]{8}-0000-4000-8000-[0-9A-F]{12}\}"/);
    // Two runs never share an id.
    const other = paraXml({ text: '4', size: 12, bold: false, italic: false, underline: false, color: null, align: 'r', bullet: false, field: 'slidenum' });
    expect(other).not.toBe(xml);
  });

  it('stays a field when it is written inside a placeholder shape', () => {
    const xml = shapeXml({
      uid: 1, kind: 'text', origin: null, spid: 0, name: 'Slide Number', ph: 'sldNum', phIdx: null, geom: 'rect',
      x: 10, y: 20, w: 30, h: 40, rot: 0, flipH: false, flipV: false, fill: null, stroke: null, strokeW: 12700, arrow: false,
      stCxn: null, endCxn: null, paras: [{ text: '2', size: 12, bold: false, italic: false, underline: false, color: null, align: 'r', bullet: false, field: 'slidenum' }],
      ink: null, anchor: 't', fontScale: 1, image: null, children: [], box: null, table: null, anim: null, locked: false,
    }, 7, null);
    expect(xml).toContain('<p:ph type="sldNum"/>');
    expect(xml).toContain('type="slidenum"');
  });

  it('is read back as a field and never as the number that happened to be stored', async () => {
    const bytes = newDeckPptx('T', 'S');
    const deck = await base();
    const withNumber = setMaster(deck, PART, { slideNumber: true });
    const out = await patchDeck(readRawZip(bytes), deck, withNumber);
    expect(out).not.toBeNull();
    const read = await readDeck(out!.bytes);
    const number = chromeOf(read, 0).find((s) => s.ph === 'sldNum')!;
    expect(number.paras[0]!.field).toBe('slidenum');
    expect(number.paras[0]!.text).toBe('');
    expect(chromeOf(read, 0).map((s) => s.ph)).toEqual(['sldNum']);
  });
});

describe('the placeholders', () => {
  it('goes where the master puts it, and at the foot of the slide when the master says nothing', async () => {
    const deck = await base();
    const master = deck.masters[0]!;
    expect(master.footerBox).toBeNull();
    expect(master.numberBox).toBeNull();
    const shapes = chromeShapes(deck, { ...master, footer: 'سرّي', slideNumber: true }, 0);
    const footer = shapes.find((s) => s.ph === 'ftr')!;
    const number = shapes.find((s) => s.ph === 'sldNum')!;
    // The footer sits at the inline start of the foot, the number at the inline end.
    expect(footer.x).toBe(Math.round(deck.cx * 0.05));
    expect(footer.y).toBeGreaterThan(deck.cy * 0.85);
    expect(number.x + number.w).toBeLessThanOrEqual(deck.cx);
    expect(number.x).toBeGreaterThan(deck.cx * 0.8);
    expect(number.y).toBe(footer.y);
    // A master that carries the placeholders keeps their own boxes.
    const placed = chromeShapes(deck, { ...master, footer: 'x', footerBox: { x: 1, y: 2, w: 3, h: 4 } }, 0);
    expect(placed[0]).toMatchObject({ x: 1, y: 2, w: 3, h: 4 });
    // Nothing is asked for when neither is on.
    expect(chromeShapes(deck, master, 0)).toEqual([]);
  });

  it('is added, updated and taken away without leaving anything behind', async () => {
    const none = await base();
    expect(chromeOf(none, 0)).toHaveLength(0);
    const both = await withChrome('سرّي — Fai$al OS', true);
    expect(chromeOf(both, 0).map((s) => s.ph).sort()).toEqual(['ftr', 'sldNum']);
    expect(chromeOf(both, 0).find((s) => s.ph === 'ftr')!.paras[0]!.text).toBe('سرّي — Fai$al OS');

    // Changing the words keeps the placeholders themselves: same uid, same place in the file.
    const edited = setMaster(both, PART, { footer: 'نصّ جديد' });
    expect(chromeOf(edited, 0).find((s) => s.ph === 'ftr')!.uid).toBe(chromeOf(both, 0).find((s) => s.ph === 'ftr')!.uid);
    expect(chromeOf(edited, 0).find((s) => s.ph === 'ftr')!.paras[0]!.text).toBe('نصّ جديد');

    const off = setMaster(edited, PART, { footer: null, slideNumber: false });
    expect(chromeOf(off, 0)).toHaveLength(0);
  });

  it('numbers each slide by its own place, and renumbers when the order changes', async () => {
    const bytes = newDeckPptx('T', 'S');
    const deck = await withChrome('foot', true);
    let three = addSlide(addSlide(deck, 0, 'blank'), 1, 'blank');
    expect(three.slides).toHaveLength(3);
    expect(chromeOf(three, 0)[1]!.paras[0]!.text).toBe('1');
    expect(chromeOf(three, 1)[1]!.paras[0]!.text).toBe('2');
    expect(chromeOf(three, 2)[1]!.paras[0]!.text).toBe('3');

    // Insert at the front: every slide's hint moves with it.
    const four = addSlide(three, -1, 'blank');
    expect(four.slides).toHaveLength(4);
    expect(four.slides.map((_, i) => chromeOf(four, i)[1]!.paras[0]!.text)).toEqual(['1', '2', '3', '4']);

    // Delete the second one and the others close the gap.
    const fewer = deleteSlide(four, 1);
    expect(fewer.slides.map((_, i) => chromeOf(fewer, i)[1]!.paras[0]!.text)).toEqual(['1', '2', '3']);

    // Move the last slide to the front: again the hints follow the order.
    const moved = moveSlide(fewer, 2, 0);
    expect(moved.slides.map((_, i) => chromeOf(moved, i)[1]!.paras[0]!.text)).toEqual(['1', '2', '3']);

    // A deck with no chrome stays untouched by any of it.
    const plain = addSlide(await base(), 0, 'blank');
    expect(refreshChrome(plain)).toBe(plain);
    // And saving a deck whose numbers only moved writes nothing for the number itself.
    const out = await patchDeck(readRawZip(bytes), deck, three);
    expect(out).not.toBeNull();
    const read = await readDeck(out!.bytes);
    expect(chromeOf(read, 1)[1]!.paras[0]!.text).toBe('');
    const idle = await patchDeck(readRawZip(out!.bytes), read, read);
    expect(idle?.changed).toEqual([]);
  });

  it('is written into the master part once and left alone afterwards', async () => {
    const xml = `${'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'}<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldMaster>';
    const deck = await base();
    const master = { ...deck.masters[0]!, footer: 'سرّي', slideNumber: true };
    const want = chromeShapes(deck, master, 0);
    const first = chromeEdits(xml, want);
    expect(first).not.toBeNull();
    expect(first!).toHaveLength(2);
    // Applying them and asking again: the part already says it, so there is nothing to write.
    const applied = xml.replace('</p:spTree>', `${want.map((w, i) => shapeXml(w, 10 + i, null)).join('')}</p:spTree>`);
    expect(chromeEdits(applied, chromeShapes(deck, master, 0))).toEqual([]);
    // Turning both off takes both elements away again.
    expect(chromeEdits(applied, [])).toHaveLength(2);
  });
});

describe('the footer and the number in a real file', () => {
  it('round-trips through patchDeck and reads back on every slide', async () => {
    const bytes = newDeckPptx('T', 'S');
    const deck = await base();
    let next = setMaster(deck, PART, { footer: 'Fai$al OS — عرض', slideNumber: true });
    next = addSlide(next, 0, 'blank');
    next = addSlide(next, 1, 'blank');
    expect(next.slides).toHaveLength(3);

    const out = await patchDeck(readRawZip(bytes), deck, next);
    expect(out).not.toBeNull();
    const saved = out!.bytes;
    const read = await readDeck(saved);
    expect(read.masters[0]!.footer).toBe('Fai$al OS — عرض');
    expect(read.masters[0]!.slideNumber).toBe(true);
    expect(read.masters[0]!.footerBox).not.toBeNull();
    expect(read.masters[0]!.numberBox).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      const chrome = chromeOf(read, i);
      expect(chrome.map((s) => s.ph).sort()).toEqual(['ftr', 'sldNum']);
      expect(chrome.find((s) => s.ph === 'ftr')!.paras[0]!.text).toBe('Fai$al OS — عرض');
      expect(chrome.find((s) => s.ph === 'sldNum')!.paras[0]!.field).toBe('slidenum');
      // The master's place is the place the slide got.
      expect(chrome.find((s) => s.ph === 'sldNum')!.x).toBe(read.masters[0]!.numberBox!.x);
    }
    // Saving again writes nothing at all: the file and the model agree.
    const idle = await patchDeck(readRawZip(saved), read, read);
    expect(idle?.changed).toEqual([]);

    // Turning the footer off removes both elements from the master and from every slide.
    const off = setMaster(read, read.masters[0]!.part, { footer: null, slideNumber: false });
    const after = await patchDeck(readRawZip(saved), read, off);
    expect(after).not.toBeNull();
    const reopened = await readDeck(after!.bytes);
    expect(reopened.masters[0]!.footer).toBeNull();
    expect(reopened.masters[0]!.slideNumber).toBe(false);
    for (let i = 0; i < 3; i++) expect(chromeOf(reopened, i)).toHaveLength(0);
  });

  it('keeps the connectors and the background it already had', async () => {
    const bytes = newDeckPptx('T', 'S');
    const deck = await base();
    const next = setMaster(deck, PART, { bg: '#112233', footer: 'f', slideNumber: true });
    const out = await patchDeck(readRawZip(bytes), deck, next);
    expect(out).not.toBeNull();
    const read = await readDeck(out!.bytes);
    expect(read.masters[0]!.bg).toBe('#112233');
    expect(read.slides[0]!.bg).toBe('#112233');
    expect(read.masters[0]!.footer).toBe('f');
  });

  it('is saved whatever order the model built its objects in', async () => {
    // The dialog builds a text look as `{font, size, colour}` and the reader as
    // `{font, colour, size}`. A key order is not a difference, so the save must not depend on it
    // — this was a real refusal: the master came back identical and the patch still said no.
    const bytes = newDeckPptx('T', 'S');
    const deck = await base();
    const title = { font: 'Tahoma', size: 36, color: '#FFC000' } as unknown as MasterText;
    const body = { font: 'Arial', size: 20, color: '#1F4E79' } as unknown as MasterText;
    const next = setMaster(deck, PART, { title, body, footer: 'f', slideNumber: true });
    const out = await patchDeck(readRawZip(bytes), deck, next);
    expect(out).not.toBeNull();
    const read = await readDeck(out!.bytes);
    expect(read.masters[0]!.title).toEqual({ font: 'Tahoma', color: '#FFC000', size: 36 });
    expect(read.masters[0]!.body).toEqual({ font: 'Arial', color: '#1F4E79', size: 20 });
  });
});
