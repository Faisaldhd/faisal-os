/**
 * Impress — the slide master: what is read out of the part, what the edits write into it, and
 * that a design change survives a real save and reopen.
 */
import { describe, expect, it } from 'vitest';
import { newDeckPptx } from '../pptx';
import { readRawZip } from '../zip';
import { readDeck, type Deck, type DeckMaster } from './deck';
import { patchDeck } from './deckpatch';
import { addSlide, setMaster } from './ops';
import { bgXml, defRPrXml, layoutBgEdits, masterEdits } from './master';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const PART = 'ppt/slideMasters/slideMaster1.xml';
const text = (over: Partial<DeckMaster['title']> = {}): DeckMaster['title'] => ({ font: null, color: null, size: null, ...over });
const master = (over: Partial<DeckMaster> = {}): DeckMaster => ({
  part: PART, bg: null, title: text(), body: text(), footer: null, slideNumber: false, ...over,
});

/** A master part as PowerPoint writes one: a background, a colour map and a style sheet. */
function masterXml(opts: { bg?: string; latin?: boolean; extra?: string } = {}): string {
  const bg = opts.bg ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${opts.bg}"/></a:solidFill></p:bgPr></p:bg>` : '';
  const latin = opts.latin === false ? '' : '<a:latin typeface="+mn-lt"/>';
  return `${DECL}<p:sldMaster ${NS}><p:cSld>${bg}<p:spTree/></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1"/>' +
    '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400" b="0">' + latin + '<a:ea typeface=""/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
    '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800">' + latin + '</a:defRPr></a:lvl1pPr></p:bodyStyle>' +
    '<p:otherStyle><a:lvl1pPr><a:defRPr/></a:lvl1pPr></p:otherStyle></p:txStyles>' +
    `${opts.extra ?? ''}</p:sldMaster>`;
}

describe('the run properties of a master', () => {
  it('sets the size, the colour and the font, and keeps everything else in schema order', () => {
    const xml = defRPrXml('<a:defRPr sz="4400" b="0" lang="ar-SA"><a:latin typeface="+mn-lt"/><a:ea typeface=""/></a:defRPr>', text({ size: 36, color: '#C00000', font: 'Tahoma' }));
    expect(xml).toContain('sz="3600"');
    expect(xml).toContain('b="0"');
    expect(xml).toContain('lang="ar-SA"');
    expect(xml).toContain('<a:solidFill><a:srgbClr val="C00000"/></a:solidFill>');
    expect(xml).toContain('<a:latin typeface="Tahoma"/>');
    expect(xml).not.toContain('+mn-lt');
    // The fill comes before the Latin typeface, which comes before the East-Asian one.
    expect(xml.indexOf('<a:solidFill')).toBeLessThan(xml.indexOf('<a:latin'));
    expect(xml.indexOf('<a:latin')).toBeLessThan(xml.indexOf('<a:ea'));
  });

  it('takes a font and a colour away again without leaving the old ones behind', () => {
    const source = '<a:defRPr sz="4400"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:latin typeface="Tahoma"/></a:defRPr>';
    const xml = defRPrXml(source, text());
    expect(xml).toBe('<a:defRPr/>');
    expect(xml).not.toContain('srgbClr');
    expect(xml).not.toContain('latin');
    expect(xml).not.toContain('sz=');
  });

  it('writes a self-closing run property as a real element when it gains children', () => {
    const xml = defRPrXml('<a:defRPr/>', text({ color: '#112233' }));
    expect(xml).toBe('<a:defRPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:defRPr>');
  });
});

describe('the edits a master takes', () => {
  it('replaces the background it already has, and inserts one when it has none', () => {
    const before = master({ bg: '#FFFFFF' });
    const replaced = masterEdits(masterXml({ bg: 'FFFFFF' }), before, master({ bg: '#112233' }));
    expect(replaced).toHaveLength(1);
    expect(replaced?.[0].xml).toBe(bgXml('#112233'));

    const inserted = masterEdits(masterXml(), before, master({ bg: '#112233' }));
    expect(inserted).toHaveLength(1);
    expect(inserted?.[0].xml).toContain('<p:bg>');
  });

  it('takes the background away when the master is asked to have none', () => {
    const edits = masterEdits(masterXml({ bg: '112233' }), master({ bg: '#112233' }), master({ bg: null }));
    expect(edits).toHaveLength(1);
    expect(edits?.[0].xml).toBe('');
  });

  it('edits both text classes, and does nothing when neither changed', () => {
    const edits = masterEdits(masterXml(), master(), master({ title: text({ size: 40 }), body: text({ color: '#4472C4' }) }));
    expect(edits).toHaveLength(2);
    expect(edits?.[0].xml).toContain('sz="4000"');
    expect(edits?.[1].xml).toContain('4472C4');
    expect(masterEdits(masterXml(), master(), master())).toEqual([]);
  });

  it('refuses a master it cannot express instead of writing half of the change', () => {
    const noStyles = `${DECL}<p:sldMaster ${NS}><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="lt1"/></p:sldMaster>`;
    expect(masterEdits(noStyles, master(), master({ title: text({ font: 'Tahoma' }) }))).toBeNull();
    const noBg = `${DECL}<p:sldMaster ${NS}><p:spTree/></p:sldMaster>`;
    expect(masterEdits(noBg, master(), master({ bg: '#FFFFFF' }))).toBeNull();
  });

  it('rewrites a layout that sets a background of its own, and leaves one that does not alone', () => {
    const own = `${DECL}<p:sldLayout ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldLayout>`;
    const edits = layoutBgEdits(own, '#112233');
    expect(edits).toHaveLength(1);
    expect(edits[0].xml).toContain('112233');
    const inherited = `${DECL}<p:sldLayout ${NS}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`;
    expect(layoutBgEdits(inherited, '#112233')).toEqual([]);
  });
});

describe('a master in a real file', () => {
  it('reads the background, the text look, the footer and the slide number', async () => {
    const deck = await readDeck(newDeckPptx('T', 'S'));
    expect(deck.masters).toHaveLength(1);
    const m = deck.masters[0];
    expect(m.part).toBe(PART);
    expect(m.bg).toBe('#FFFFFF');
    expect(m.title.size).toBe(44);
    expect(m.body.size).toBe(28);
    expect(m.footer).toBeNull();
    expect(m.slideNumber).toBe(false);
    expect(deck.slides[0].master).toBe(PART);
  });

  it('saves a background and a text look into slideMaster1.xml and reads them back', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    let deck = setMaster(base, PART, {
      bg: '#112233',
      title: { font: 'Tahoma', color: '#C00000', size: 36 },
      body: { font: 'Arial', color: '#1F4E79', size: 20 },
    });
    expect(deck.slides[0].bg).toBe('#112233');
    const out = await patchDeck(readRawZip(bytes), base, deck);
    expect(out).not.toBeNull();
    const saved = out!.bytes;
    expect(out!.changed).toContain(PART);

    const read = await readDeck(saved);
    expect(read.masters[0]).toEqual(deck.masters[0]);
    expect(read.slides[0].bg).toBe('#112233');
    // And the same deck saved again writes nothing: the model and the file agree.
    const idle = await patchDeck(readRawZip(saved), read, read);
    expect(idle?.changed).toEqual([]);
    const again = await readDeck(saved);
    expect(again.masters[0].title.font).toBe('Tahoma');
  });

  it('keeps the master when a slide that inherits it is added, and clears the background again', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    let deck = addSlide(base, 0, 'blank');
    expect(deck.slides[1].master).toBe(PART);
    deck = setMaster(deck, PART, { bg: '#FFC000' });
    expect(deck.slides.map((s) => s.bg)).toEqual(['#FFC000', '#FFC000']);
    deck = setMaster(deck, PART, { bg: null });
    expect(deck.slides.map((s) => s.bg)).toEqual([null, null]);
    const out = await patchDeck(readRawZip(bytes), base, deck);
    expect(out).not.toBeNull();
    expect((await readDeck(out!.bytes)).masters[0].bg).toBeNull();
  });

  it('lets a slide keep its own background when the master changes', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    // A slide with a background of its own is a slide the master no longer paints.
    const own: Deck = { ...base, slides: base.slides.map((s) => ({ ...s, bgOwn: '#92D050', bg: '#92D050' })) };
    const deck = setMaster(own, PART, { bg: '#112233' });
    expect(deck.slides[0].bg).toBe('#92D050');
  });

  it('gives a new size to the placeholder paragraphs of every slide that inherits it', async () => {
    const bytes = newDeckPptx('T', 'S');
    const base = await readDeck(bytes);
    const [title, sub] = base.slides[0].shapes;
    expect([title.ph, title.paras[0].size]).toEqual(['ctrTitle', 44]);
    expect([sub.ph, sub.paras[0].size]).toEqual(['subTitle', 24]);

    const deck = setMaster(base, PART, { title: { ...base.masters[0].title, size: 36 }, body: { ...base.masters[0].body, size: 20 } });
    const [title2, sub2] = deck.slides[0].shapes;
    expect(title2.paras[0].size).toBe(36);
    expect(sub2.paras[0].size).toBe(20);
    // A change that is not a size leaves the slides' own sizes alone.
    const colours = setMaster(base, PART, { bg: '#112233' });
    expect(colours.slides[0].shapes[1].paras[0].size).toBe(24);
    expect(colours).not.toBe(base);
    expect(setMaster(base, 'ppt/slideMasters/nope.xml', { bg: '#112233' })).toBe(base);
  });
});
