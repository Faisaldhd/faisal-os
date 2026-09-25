import { describe, expect, it } from 'vitest';
import { newDeckPptx } from '../pptx';
import { contentTypes } from '../ooxml';
import { readRawZip, utf8, writeZip } from '../zip';
import { openZip, zipEntries } from '../../viewer/formats';
import { deckTexts, readDeck, relativeTarget, resolveTarget, type Deck } from './deck';
import { patchDeck } from './deckpatch';
import {
  addShape, addSlide, deleteShape, deleteSlide, duplicateSlide, moveSlide, newPicture, newShape, setAnim, setBounds,
  setShapeText, setTransition,
} from './ops';
import { formatClock, stepBack, stepForward } from './show';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const decode = (b: Uint8Array | null): string => new TextDecoder().decode(b ?? new Uint8Array());

async function part(bytes: Uint8Array, name: string): Promise<string> {
  return decode(await openZip(bytes).read(name));
}

/** Everything PowerPoint checks first: parts parse, have a content type, rels resolve, ids are unique. */
async function problems(bytes: Uint8Array): Promise<string[]> {
  const out: string[] = [];
  const entries = zipEntries(bytes);
  const names = new Set(entries.map((e) => e.name));
  const ct = new DOMParser().parseFromString(await part(bytes, '[Content_Types].xml'), 'application/xml');
  const defaults = new Set([...ct.getElementsByTagName('Default')].map((d) => (d.getAttribute('Extension') ?? '').toLowerCase()));
  const overrides = [...ct.getElementsByTagName('Override')].map((o) => (o.getAttribute('PartName') ?? '').slice(1));
  for (const o of overrides) if (!names.has(o)) out.push(`override for a missing part ${o}`);
  for (const e of entries) {
    if (e.name === '[Content_Types].xml') continue;
    const ext = (e.name.split('.').pop() ?? '').toLowerCase();
    if (!defaults.has(ext) && !overrides.includes(e.name)) out.push(`no content type for ${e.name}`);
    if (!/\.(xml|rels)$/.test(e.name)) continue;
    const doc = new DOMParser().parseFromString(await part(bytes, e.name), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) { out.push(`${e.name} does not parse`); continue; }
    if (!e.name.endsWith('.rels')) continue;
    const source = e.name.replace('_rels/', '').replace(/\.rels$/, '');
    for (const r of doc.getElementsByTagName('Relationship')) {
      if (r.getAttribute('TargetMode') === 'External') continue;
      const target = resolveTarget(source, r.getAttribute('Target') ?? '');
      if (!names.has(target)) out.push(`${e.name}: missing target ${target}`);
    }
  }
  const pres = new DOMParser().parseFromString(await part(bytes, 'ppt/presentation.xml'), 'application/xml');
  const ids = [...pres.getElementsByTagName('p:sldIdLst')[0]?.getElementsByTagName('p:sldId') ?? []];
  const rels = new DOMParser().parseFromString(await part(bytes, 'ppt/_rels/presentation.xml.rels'), 'application/xml');
  const relIds = new Set([...rels.getElementsByTagName('Relationship')].map((r) => r.getAttribute('Id')));
  if (new Set(ids.map((i) => i.getAttribute('id'))).size !== ids.length) out.push('duplicate slide ids');
  for (const i of ids) if (!relIds.has(i.getAttribute('r:id'))) out.push(`sldId without relationship ${i.getAttribute('r:id')}`);
  const slideRels = [...rels.getElementsByTagName('Relationship')].filter((r) => (r.getAttribute('Type') ?? '').endsWith('/slide'));
  if (slideRels.length !== ids.length) out.push(`slide relationships ${slideRels.length} vs sldIds ${ids.length}`);
  return out;
}

async function save(bytes: Uint8Array, base: Deck, cur: Deck): Promise<Uint8Array> {
  const out = await patchDeck(readRawZip(bytes), base, cur);
  if (!out) throw new Error('patch refused');
  return out.bytes;
}

async function records(bytes: Uint8Array): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const e of zipEntries(bytes)) map.set(e.name, decode(await openZip(bytes).read(e.name)));
  return map;
}

describe('the rich deck', () => {
  it('reads a new presentation at its real size, with placeholders and layouts', async () => {
    const deck = await readDeck(newDeckPptx('Hello', 'World'));
    expect(deck.cx).toBe(12192000);
    expect(deck.cy).toBe(6858000);
    expect(deck.layouts.map((l) => l.type)).toEqual(['title', 'obj', 'twoObj', 'blank']);
    expect(deck.slides).toHaveLength(1);
    const [title, sub] = deck.slides[0].shapes;
    expect(title.ph).toBe('ctrTitle');
    expect(title.x).toBeGreaterThan(0);
    expect(title.w).toBeGreaterThan(deck.cx / 2);
    expect(sub.paras[0].text).toBe('World');
    expect(deckTexts(deck)).toEqual([['Hello', 'World']]);
    expect(await problems(newDeckPptx('a', 'b'))).toEqual([]);
  });

  it('resolves and builds relative targets', () => {
    expect(resolveTarget('ppt/slides/slide1.xml', '../media/image1.png')).toBe('ppt/media/image1.png');
    expect(relativeTarget('ppt/slides/slide1.xml', 'ppt/media/image1.png')).toBe('../media/image1.png');
    expect(relativeTarget('ppt/presentation.xml', 'ppt/slides/slide2.xml')).toBe('slides/slide2.xml');
  });

  it('adds slides with each layout, duplicates, deletes and reorders, and the file re-parses', async () => {
    const bytes = newDeckPptx('One', 'sub');
    const base = await readDeck(bytes);
    let deck = addSlide(base, 0, 'content');
    deck = setShapeText(deck, 1, deck.slides[1].shapes[0].uid, 'Two');
    deck = addSlide(deck, 1, 'two');
    deck = addSlide(deck, 2, 'blank');
    deck = addSlide(deck, 3, 'title');
    expect(deck.slides.map((s) => s.shapes.length)).toEqual([2, 2, 3, 0, 2]);
    expect(deck.slides[1].layout).toBe('ppt/slideLayouts/slideLayout2.xml');
    expect(deck.slides[3].layout).toBe('ppt/slideLayouts/slideLayout4.xml');
    deck = duplicateSlide(deck, 0); // "One" copied from its part
    deck = deleteSlide(deck, 3); // the two-content slide
    deck = moveSlide(deck, 0, 4); // the original first slide goes last
    const saved = await save(bytes, base, deck);
    expect(await problems(saved)).toEqual([]);
    const read = await readDeck(saved);
    expect(deckTexts(read)).toEqual([['One', 'sub'], ['Two'], [], [], ['One', 'sub']]);
    expect(read.slides[4].part).toBe('ppt/slides/slide1.xml');
    // Untouched parts keep their bytes.
    const before = await records(bytes);
    const after = await records(saved);
    for (const name of ['ppt/theme/theme1.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slides/slide1.xml', 'ppt/slideLayouts/slideLayout2.xml']) {
      expect(after.get(name), name).toBe(before.get(name));
    }
  });

  it('never deletes the last slide and clamps a move', async () => {
    const deck = await readDeck(newDeckPptx('x', 'y'));
    expect(deleteSlide(deck, 0)).toBe(deck);
    const two = addSlide(deck, 0, 'blank');
    expect(moveSlide(two, 0, 99).slides[1]).toBe(two.slides[0]);
  });

  it('saves a second time on top of the first save without repeating new slides', async () => {
    const bytes = newDeckPptx('A', 'B');
    const base = await readDeck(bytes);
    const first = await save(bytes, base, addSlide(base, 0, 'content'));
    const base2 = await readDeck(first);
    const second = await save(first, base2, moveSlide(base2, 1, 0));
    const read = await readDeck(second);
    expect(read.slides).toHaveLength(2);
    expect(deckTexts(read)).toEqual([[], ['A', 'B']]);
    expect(await problems(second)).toEqual([]);
  });

  it('moves, resizes, retypes and deletes shapes in place', async () => {
    const bytes = newDeckPptx('Title', 'Sub');
    const base = await readDeck(bytes);
    const [title, sub] = base.slides[0].shapes;
    let deck = setBounds(base, 0, title.uid, { x: 100000, y: 200000, w: 3000000, h: 1000000 });
    deck = setShapeText(deck, 0, title.uid, 'New title\nsecond line');
    deck = deleteShape(deck, 0, sub.uid);
    const saved = await save(bytes, base, deck);
    expect(await problems(saved)).toEqual([]);
    const xml = await part(saved, 'ppt/slides/slide1.xml');
    expect(xml).toContain('<a:off x="100000" y="200000"/>');
    expect(xml).toContain('<a:ext cx="3000000" cy="1000000"/>');
    expect(xml).not.toContain('Sub');
    const read = await readDeck(saved);
    expect(read.slides[0].shapes).toHaveLength(1);
    expect(read.slides[0].shapes[0].paras.map((p) => p.text)).toEqual(['New title', 'second line']);
    expect(read.slides[0].shapes[0].paras[0].size).toBe(44);
  });

  it('adds a text box, shapes, a line and a picture', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    let deck = base;
    const box = newShape(deck, 'text');
    deck = addShape(deck, 0, box);
    deck = setShapeText(deck, 0, box.uid, 'Boxed <text> & more');
    for (const kind of ['rect', 'ellipse', 'arrow', 'line'] as const) deck = addShape(deck, 0, newShape(deck, kind));
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    deck = addShape(deck, 0, newPicture(deck, png, 'image/png', 'png', 400, 200));
    const saved = await save(bytes, base, deck);
    expect(await problems(saved)).toEqual([]);
    const read = await readDeck(saved);
    const shapes = read.slides[0].shapes;
    expect(shapes.map((s) => s.kind)).toEqual(['text', 'text', 'text', 'shape', 'shape', 'shape', 'line', 'pic']);
    expect(shapes.map((s) => s.geom).slice(3)).toEqual(['rect', 'ellipse', 'rightArrow', 'line', 'rect']);
    expect(shapes[2].paras[0].text).toBe('Boxed <text> & more');
    expect(shapes[7].image?.bytes).toEqual(png);
    expect(shapes[7].w / shapes[7].h).toBeCloseTo(2, 3);
    expect(new Set(shapes.map((s) => s.spid)).size).toBe(shapes.length);
    expect(await part(saved, '[Content_Types].xml')).toContain('Extension="png"');
  });

  it('saves a fade transition and entrance animations, and reads them back', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    let deck = setTransition(base, 0, 'fade');
    deck = setAnim(deck, 0, deck.slides[0].shapes[1].uid, 'fade');
    deck = addSlide(deck, 0, 'blank');
    deck = setTransition(deck, 1, 'push');
    const rect = newShape(deck, 'rect');
    deck = addShape(deck, 1, { ...rect, anim: 'appear' });
    const saved = await save(bytes, base, deck);
    expect(await problems(saved)).toEqual([]);
    const xml = await part(saved, 'ppt/slides/slide1.xml');
    expect(xml).toContain('<p:transition spd="med"><p:fade/></p:transition>');
    expect(xml.indexOf('<p:transition')).toBeGreaterThan(xml.indexOf('</p:clrMapOvr>'));
    expect(xml.indexOf('<p:timing>')).toBeGreaterThan(xml.indexOf('</p:transition>'));
    expect(xml).toContain('presetID="10" presetClass="entr"');
    const read = await readDeck(saved);
    expect(read.slides.map((s) => s.transition)).toEqual(['fade', 'push']);
    expect(read.slides[0].shapes[1].anim).toBe('fade');
    expect(read.slides[1].shapes[0].anim).toBe('appear');
    // Taking the transition away removes the element.
    const again = await save(saved, read, setTransition(read, 0, 'none'));
    expect(await part(again, 'ppt/slides/slide1.xml')).not.toContain('<p:transition');
  });
});

describe('the slideshow steps', () => {
  it('reveals animated shapes one click at a time, then moves on; back shows the previous slide complete', async () => {
    const bytes = newDeckPptx('T', 'S');
    let deck = await readDeck(bytes);
    deck = setAnim(deck, 0, deck.slides[0].shapes[0].uid, 'fade');
    deck = setAnim(deck, 0, deck.slides[0].shapes[1].uid, 'appear');
    deck = addSlide(deck, 0, 'blank');
    expect(stepForward(deck, { at: 0, step: 0 })).toEqual({ at: 0, step: 1 });
    expect(stepForward(deck, { at: 0, step: 2 })).toEqual({ at: 1, step: 0 });
    expect(stepForward(deck, { at: 1, step: 0 })).toBeNull();
    expect(stepBack(deck, { at: 1, step: 0 })).toEqual({ at: 0, step: 2 });
    expect(stepBack(deck, { at: 0, step: 0 })).toBeNull();
    expect(formatClock(65_000)).toBe('01:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });
});

/* A deck as PowerPoint writes it: inherited placeholder positions, a picture, notes, sections. */
function officeDeck(): Uint8Array {
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = (body: string): Uint8Array => utf8(`${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`);
  const r = (id: string, type: string, target: string): string => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`;
  const tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
  const titleSp = (text: string): string => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const pic = '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 2"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
  const slide = (body: string): Uint8Array => utf8(`${DECL}<p:sld ${NS}><p:cSld><p:spTree>${tree}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
  const ct = (n: string, type: string): string => `<Override PartName="/${n}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`;
  return writeZip([
    {
      name: '[Content_Types].xml', data: utf8(contentTypes([
        '<Default Extension="png" ContentType="image/png"/>', ct('ppt/presentation.xml', 'presentation.main'),
        ct('ppt/slideMasters/slideMaster1.xml', 'slideMaster'), ct('ppt/slideLayouts/slideLayout1.xml', 'slideLayout'),
        ct('ppt/slides/slide1.xml', 'slide'), ct('ppt/slides/slide2.xml', 'slide'), ct('ppt/notesSlides/notesSlide1.xml', 'notesSlide'),
      ])),
    },
    { name: '_rels/.rels', data: rels(r('rId1', 'officeDocument', 'ppt/presentation.xml')) },
    {
      name: 'ppt/presentation.xml', data: utf8(`${DECL}<p:presentation ${NS} xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">` +
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
        '<p:sldIdLst><p:sldId id="300" r:id="rId3"/><p:sldId id="301" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/>' +
        '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst>' +
        '<p14:section name="A" id="{1}"><p14:sldIdLst><p14:sldId id="300"/></p14:sldIdLst></p14:section>' +
        '<p14:section name="B" id="{2}"><p14:sldIdLst><p14:sldId id="301"/></p14:sldIdLst></p14:section>' +
        '</p14:sectionLst></p:ext></p:extLst></p:presentation>'),
    },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels(r('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml') + r('rId2', 'slide', 'slides/slide1.xml') + r('rId3', 'slide', 'slides/slide2.xml')) },
    {
      name: 'ppt/slideMasters/slideMaster1.xml', data: utf8(`${DECL}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg><p:spTree>${tree}` +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm></p:spPr></p:sp>' +
        '</p:spTree></p:cSld><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle></p:txStyles></p:sldMaster>'),
    },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels(r('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')) },
    {
      name: 'ppt/slideLayouts/slideLayout1.xml', data: utf8(`${DECL}<p:sldLayout ${NS} type="obj"><p:cSld name="Title and Content"><p:spTree>${tree}` +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr></p:sp>' +
        '</p:spTree></p:cSld></p:sldLayout>'),
    },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels(r('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')) },
    { name: 'ppt/slides/slide1.xml', data: slide(titleSp('Second in order') + pic) },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels(r('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml') + r('rId2', 'image', '../media/image1.png') + r('rId3', 'notesSlide', '../notesSlides/notesSlide1.xml')) },
    { name: 'ppt/slides/slide2.xml', data: slide(titleSp('First &amp; foremost')) },
    { name: 'ppt/slides/_rels/slide2.xml.rels', data: rels(r('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')) },
    {
      name: 'ppt/notesSlides/notesSlide1.xml', data: utf8(`${DECL}<p:notes ${NS}><p:cSld><p:spTree>${tree}` +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="n"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Say hello</a:t></a:r></a:p><a:p><a:r><a:t>then go on</a:t></a:r></a:p></p:txBody></p:sp>' +
        '</p:spTree></p:cSld></p:notes>'),
    },
    { name: 'ppt/notesSlides/_rels/notesSlide1.xml.rels', data: rels(r('rId1', 'slide', '../slides/slide1.xml')) },
    { name: 'ppt/media/image1.png', data: new Uint8Array([137, 80, 78, 71]) },
  ]);
}

describe('a deck written by PowerPoint', () => {
  it('follows sldIdLst, inherits placeholder places and sizes, reads pictures, notes and the background', async () => {
    const deck = await readDeck(officeDeck());
    expect(deck.cx).toBe(9144000);
    expect(deckTexts(deck)).toEqual([['First & foremost'], ['Second in order']]);
    const title = deck.slides[0].shapes[0];
    expect([title.x, title.y, title.w, title.h]).toEqual([457200, 274638, 8229600, 1143000]);
    expect(title.paras[0].size).toBe(32);
    expect(deck.slides[1].shapes[1].image?.path).toBe('ppt/media/image1.png');
    expect(deck.slides[1].notes).toBe('Say hello\nthen go on');
    expect(deck.slides[0].bg).toBe('#112233');
  });

  it('gives a moved placeholder its own xfrm, and deletes a slide with its notes page and section entry', async () => {
    const bytes = officeDeck();
    const base = await readDeck(bytes);
    let deck = setBounds(base, 0, base.slides[0].shapes[0].uid, { x: 0, y: 0, w: 5000000, h: 900000 });
    deck = deleteSlide(deck, 1);
    deck = addSlide(deck, 0, 'content');
    const saved = await save(bytes, base, deck);
    expect(await problems(saved)).toEqual([]);
    const names = zipEntries(saved).map((e) => e.name);
    expect(names).not.toContain('ppt/slides/slide1.xml');
    expect(names).not.toContain('ppt/notesSlides/notesSlide1.xml');
    expect(await part(saved, '[Content_Types].xml')).not.toContain('notesSlide1');
    expect(await part(saved, 'ppt/slides/slide2.xml')).toContain('<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5000000" cy="900000"/></a:xfrm></p:spPr>');
    const pres = await part(saved, 'ppt/presentation.xml');
    expect(pres).toContain('<p:sldIdLst><p:sldId id="300" r:id="rId3"/><p:sldId id="302" r:id="rId4"/></p:sldIdLst>');
    expect(pres).toContain('<p14:sldIdLst><p14:sldId id="300"/><p14:sldId id="302"/></p14:sldIdLst>');
    expect(pres).toContain('<p14:section name="B" id="{2}"><p14:sldIdLst></p14:sldIdLst>');
    const read = await readDeck(saved);
    expect(read.slides.map((s) => s.layout)).toEqual(['ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/slideLayout1.xml']);
    // The image the deleted slide used stays; nothing else refers to it, and it is harmless.
    expect(names).toContain('ppt/media/image1.png');
  });

  it('duplicates a slide with a picture without copying its notes', async () => {
    const bytes = officeDeck();
    const base = await readDeck(bytes);
    const saved = await save(bytes, base, duplicateSlide(base, 1));
    expect(await problems(saved)).toEqual([]);
    const read = await readDeck(saved);
    expect(read.slides).toHaveLength(3);
    expect(read.slides[2].shapes[1].image?.bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(read.slides[2].notes).toBe('');
    expect(await part(saved, 'ppt/slides/_rels/slide3.xml.rels')).not.toContain('notesSlide');
  });
});
