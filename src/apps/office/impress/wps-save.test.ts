/**
 * Impress — what the WPS-style tools write into a real .pptx and read back: a shape's fill and
 * outline, a click link, a table, the stacking order, speaker notes, and the new transitions and
 * entrance effects.
 */
import { describe, expect, it } from 'vitest';
import { newDeckPptx } from '../pptx';
import { entryData, readRawZip } from '../zip';
import { readDeck, type Deck } from './deck';
import { patchDeck } from './deckpatch';
import {
  addShape, addSlide, alignShape, arrangeShape, newShape, newTable, safeLink, setAnim, setNotes, setShapeLink, setShapeLook,
  setParaStyle, setTableCell, setTransition,
} from './ops';

const partText = async (bytes: Uint8Array, name: string): Promise<string> =>
  new TextDecoder().decode((await entryData(readRawZip(bytes), name)) ?? new Uint8Array());

/** Saves `cur` over `bytes` (read as `base`), reopens it and saves the reopened deck once more. */
async function roundTrip(bytes: Uint8Array, base: Deck, cur: Deck): Promise<{ bytes: Uint8Array; read: Deck }> {
  const out = await patchDeck(readRawZip(bytes), base, cur);
  expect(out).not.toBeNull();
  const read = await readDeck(out!.bytes);
  const again = await patchDeck(readRawZip(out!.bytes), read, read);
  expect(again?.changed).toEqual([]);
  return { bytes: out!.bytes, read };
}

/** A saved deck with one box on its first slide, reopened: every shape now comes from the file. */
async function savedWithBox(): Promise<{ bytes: Uint8Array; deck: Deck }> {
  const bytes0 = newDeckPptx('T', 'S');
  const base = await readDeck(bytes0);
  const { bytes, read } = await roundTrip(bytes0, base, addShape(base, 0, newShape(base, 'rect')));
  return { bytes, deck: read };
}

describe('fill and outline', () => {
  it('are written into a shape the file already has, and read back', async () => {
    const { bytes, deck } = await savedWithBox();
    const box = deck.slides[0]!.shapes.at(-1)!;
    const cur = setShapeLook(alignShape(deck, 0, box.uid, 'left'), 0, box.uid, { fill: '#112233', stroke: '#C8894B', strokeW: 38100 });
    const { read } = await roundTrip(bytes, deck, cur);
    const back = read.slides[0]!.shapes.at(-1)!;
    expect([back.fill, back.stroke, back.strokeW, back.x]).toEqual(['#112233', '#C8894B', 38100, 0]);
  });

  it('can take the fill and the outline away', async () => {
    const { bytes, deck } = await savedWithBox();
    const box = deck.slides[0]!.shapes.at(-1)!;
    const { read } = await roundTrip(bytes, deck, setShapeLook(deck, 0, box.uid, { fill: null, stroke: null }));
    const back = read.slides[0]!.shapes.at(-1)!;
    expect([back.fill, back.stroke]).toEqual([null, null]);
  });

  it('gives a placeholder that inherited its place a box and a fill in one edit', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    const title = base.slides[0]!.shapes[0]!;
    const moved = { ...base, slides: base.slides.map((s, i) => (i ? s : { ...s, shapes: s.shapes.map((x) => (x.uid === title.uid ? { ...x, x: x.x + 12700 } : x)) })) };
    const { read } = await roundTrip(bytes, base, setShapeLook(moved, 0, title.uid, { fill: '#FFEEDD' }));
    expect(read.slides[0]!.shapes[0]!.fill).toBe('#FFEEDD');
    expect(read.slides[0]!.shapes[0]!.x).toBe(title.x + 12700);
  });
});

describe('links', () => {
  it('accepts web and mail addresses only', () => {
    expect(safeLink('example.com')).toBe('https://example.com/');
    expect(safeLink('https://a.b/c?d=1&e=2')).toBe('https://a.b/c?d=1&e=2');
    expect(safeLink('mailto:x@y.z')).toBe('mailto:x@y.z');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('data:text/html,hi')).toBeNull();
    expect(safeLink('   ')).toBeNull();
  });

  it('are written as external hyperlinks, on a new shape and on one the file has', async () => {
    const bytes0 = newDeckPptx('T', 'S');
    const base = await readDeck(bytes0);
    const box = newShape(base, 'ellipse');
    const first = await roundTrip(bytes0, base, setShapeLink(addShape(base, 0, box), 0, box.uid, 'https://a.b/?x=1&y=2'));
    expect(first.read.slides[0]!.shapes.at(-1)!.link).toBe('https://a.b/?x=1&y=2');
    const rels = await partText(first.bytes, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toContain('TargetMode="External"');
    expect(rels).toContain('https://a.b/?x=1&amp;y=2');
    const title = first.read.slides[0]!.shapes[0]!;
    const second = await roundTrip(first.bytes, first.read, setShapeLink(first.read, 0, title.uid, 'mailto:me@x.y'));
    expect(second.read.slides[0]!.shapes[0]!.link).toBe('mailto:me@x.y');
    const unlinked = await roundTrip(second.bytes, second.read, setShapeLink(second.read, 0, second.read.slides[0]!.shapes[0]!.uid, null));
    expect(await partText(unlinked.bytes, 'ppt/slides/_rels/slide1.xml.rels')).not.toContain('mailto:');
    expect(unlinked.read.slides[0]!.shapes[0]!.link ?? null).toBeNull();
  });
});

describe('tables', () => {
  it('are written as a graphic frame, and a cell edit reaches the file', async () => {
    const bytes0 = newDeckPptx('T', 'S');
    const base = await readDeck(bytes0);
    let cur = addSlide(base, 0, 'blank');
    const table = newTable(cur, 3, 2);
    cur = addShape(cur, 1, table);
    cur = setTableCell(cur, 1, table.uid, 0, 0, 'الاسم');
    cur = setTableCell(cur, 1, table.uid, 2, 1, 'B3');
    const first = await roundTrip(bytes0, base, cur);
    const back = first.read.slides[1]!.shapes.find((s) => s.kind === 'frame')!;
    expect(back.table).toEqual([['الاسم', ''], ['', ''], ['', 'B3']]);
    const edited = setTableCell(first.read, 1, back.uid, 1, 0, 'two\nlines');
    const second = await roundTrip(first.bytes, first.read, edited);
    expect(second.read.slides[1]!.shapes.find((s) => s.kind === 'frame')!.table).toEqual([['الاسم', ''], ['two\nlines', ''], ['', 'B3']]);
  });
});

describe('the stacking order', () => {
  it('is the order of the spTree', async () => {
    const { bytes, deck } = await savedWithBox();
    const box = deck.slides[0]!.shapes.at(-1)!;
    const cur = arrangeShape(deck, 0, box.uid, 'back');
    expect(cur.slides[0]!.shapes[0]!.uid).toBe(box.uid);
    const { read } = await roundTrip(bytes, deck, cur);
    expect(read.slides[0]!.shapes[0]!.geom).toBe('rect');
    expect(read.slides[0]!.shapes[0]!.fill).toBe(box.fill);
  });
});

describe('speaker notes', () => {
  it('create a notes master and a notes page in a file that never had notes, then edit them in place', async () => {
    const bytes0 = newDeckPptx('T', 'S');
    const base = await readDeck(bytes0);
    const first = await roundTrip(bytes0, base, setNotes(addSlide(base, 0, 'content'), 0, 'مرحبا\nsecond line'));
    expect(first.read.slides[0]!.notes).toBe('مرحبا\nsecond line');
    expect(first.read.slides[1]!.notes).toBe('');
    const pres = await partText(first.bytes, 'ppt/presentation.xml');
    expect(pres).toMatch(/<\/p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId\d+"\/><\/p:notesMasterIdLst>/);
    const ct = await partText(first.bytes, '[Content_Types].xml');
    expect(ct).toContain('/ppt/notesMasters/notesMaster1.xml');
    expect(ct).toContain('/ppt/notesSlides/notesSlide1.xml');
    const second = await roundTrip(first.bytes, first.read, setNotes(setNotes(first.read, 0, 'changed'), 1, 'new too'));
    expect(second.read.slides.map((s) => s.notes)).toEqual(['changed', 'new too']);
    // One notes master only, however many notes pages.
    expect((await partText(second.bytes, 'ppt/presentation.xml')).match(/notesMasterId /g)?.length).toBe(1);
  });
});

describe('a text box’s own typeface', () => {
  it('is written as <a:latin> of its runs, and back to the theme font when cleared', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    const title = base.slides[0]!.shapes[0]!;
    const first = await roundTrip(bytes, base, setParaStyle(base, 0, title.uid, { font: 'Georgia' }));
    expect(first.read.slides[0]!.shapes[0]!.paras[0]!.font).toBe('Georgia');
    expect(await partText(first.bytes, 'ppt/slides/slide1.xml')).toContain('<a:latin typeface="Georgia"/>');
    const back = first.read.slides[0]!.shapes[0]!;
    const second = await roundTrip(first.bytes, first.read, setParaStyle(first.read, 0, back.uid, { font: null }));
    expect(second.read.slides[0]!.shapes[0]!.paras[0]!.font ?? null).toBeNull();
  });
});

describe('transitions and entrance effects', () => {
  it('writes wipe, cover and fly in, and reads them back', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    let cur = setTransition(addSlide(base, 0, 'content'), 0, 'wipe');
    cur = setTransition(cur, 1, 'cover');
    cur = setAnim(cur, 0, cur.slides[0]!.shapes[0]!.uid, 'fly');
    const { read } = await roundTrip(bytes, base, cur);
    expect(read.slides.map((s) => s.transition)).toEqual(['wipe', 'cover']);
    expect(read.slides[0]!.shapes[0]!.anim).toBe('fly');
  });
});
