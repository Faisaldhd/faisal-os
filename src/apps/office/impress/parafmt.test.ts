/**
 * Impress — text formatting: the pure XML work, the model helpers, and the real round trip
 * through the surgical save (format a paragraph → patch the package → read it back).
 *
 * The round trip is the part that matters: a formatting command that the patch ignores would
 * look right on screen and vanish from the saved file, which is the failure this file exists to
 * prevent.
 */
import { describe, expect, it } from 'vitest';
import { newDeckPptx } from '../pptx';
import { openZip } from '../../viewer/formats';
import { registeredKeys } from '../../../kernel/i18n';
import { readDeck, type Deck, type DeckPara } from './deck';
import { patchDeck } from './deckpatch';
import { setParaStyle, setShapeText, addShape, newShape } from './ops';
import { autoAlign, paraStyleOf, sameParaStyle, setAttrText, styleParagraphXml, styleRunTag } from './parafmt';
import { readRawZip } from '../zip';
import './strings';

const base = (extra: Partial<DeckPara> = {}): DeckPara => ({
  text: 'Hello', size: 18, bold: false, italic: false, underline: false,
  color: null, align: null, bullet: false, ...extra,
});

async function deckOf(bytes: Uint8Array): Promise<Deck> {
  return readDeck(bytes);
}

/** The uid of the first text shape on slide `at`. */
function firstTextShape(deck: Deck, at = 0): number {
  const shape = deck.slides[at]?.shapes.find((s) => s.kind === 'text' || s.kind === 'shape');
  if (!shape) throw new Error('the fixture slide has no text shape');
  return shape.uid;
}

async function slideXml(bytes: Uint8Array, part = 'ppt/slides/slide1.xml'): Promise<string> {
  const zip = openZip(bytes);
  const raw = await zip.read(part);
  return new TextDecoder().decode(raw ?? new Uint8Array());
}

describe('setAttrText', () => {
  it('adds, replaces and removes one attribute and touches nothing else', () => {
    expect(setAttrText(' lang="en-US" dirty="0"', 'b', '1')).toBe(' lang="en-US" dirty="0" b="1"');
    expect(setAttrText(' lang="en-US" b="0"', 'b', '1')).toBe(' lang="en-US" b="1"');
    expect(setAttrText(' lang="en-US" b="1"', 'b', null)).toBe(' lang="en-US"');
    expect(setAttrText(' lang="en-US"', 'b', null)).toBe(' lang="en-US"');
  });

  it('does not confuse an attribute with a longer name that starts the same way', () => {
    expect(setAttrText(' sz="1200"', 's', '1')).toBe(' sz="1200" s="1"');
  });
});

describe('styleRunTag', () => {
  it('writes the four attributes this editor owns and keeps the others', () => {
    const out = styleRunTag('<a:rPr lang="en-US" dirty="0"/>', base({ bold: true, italic: true, underline: true, size: 24 }));
    expect(out).toContain('lang="en-US"');
    expect(out).toContain('dirty="0"');
    expect(out).toContain('b="1"');
    expect(out).toContain('i="1"');
    expect(out).toContain('u="sng"');
    expect(out).toContain('sz="2400"');
  });

  it('clears what the model turned off', () => {
    const out = styleRunTag('<a:rPr lang="ar-SA" b="1" i="1" u="sng" sz="2400"/>', base({ size: null }));
    expect(out).not.toContain('b="1"');
    expect(out).not.toContain('i="1"');
    expect(out).not.toContain('u="sng"');
    expect(out).not.toContain('sz=');
    expect(out).toContain('lang="ar-SA"');
  });

  it('replaces the colour child, and adds one to a self-closing tag', () => {
    const withColor = styleRunTag('<a:rPr lang="en-US"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr>', base({ size: null, color: '#C8894B' }));
    expect(withColor).toContain('<a:srgbClr val="C8894B"/>');
    expect(withColor).not.toContain('schemeClr');
    expect(withColor).toContain('<a:latin typeface="Calibri"/>');
    expect(styleRunTag('<a:rPr lang="en-US"/>', base({ size: null, color: '#112233' }))).toBe('<a:rPr lang="en-US"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:rPr>');
  });

  it('removes the colour child when the model has none', () => {
    const out = styleRunTag('<a:rPr lang="en-US"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr>', base({ size: null }));
    expect(out).toBe('<a:rPr lang="en-US"></a:rPr>');
  });
});

describe('styleParagraphXml', () => {
  const para = '<a:p><a:pPr algn="l"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US" sz="1800"/><a:t>Hello</a:t></a:r><a:endParaRPr lang="en-US" sz="1800"/></a:p>';

  it('applies the look to every run and keeps the paragraph children', () => {
    const out = styleParagraphXml(para, base({ bold: true, underline: true, color: '#FF0000', size: 32, align: 'r' }));
    expect(out).toContain('<a:buChar char="•"/>');
    expect(out).toContain('algn="r"');
    expect(out).toContain('b="1"');
    expect(out).toContain('u="sng"');
    expect(out).toContain('sz="3200"');
    expect(out).toContain('<a:srgbClr val="FF0000"/>');
    // Both the run and the end-of-paragraph properties are updated, so the next line matches.
    expect(out.match(/sz="3200"/g)?.length).toBe(2);
  });

  it('adds a pPr when the paragraph has none and the model wants direction', () => {
    const out = styleParagraphXml('<a:p><a:r><a:t>مرحبا</a:t></a:r></a:p>', base({ text: 'مرحبا', align: 'r' }));
    expect(out).toContain('<a:pPr algn="r" rtl="1"/>');
    expect(out.indexOf('<a:pPr')).toBeLessThan(out.indexOf('<a:r>'));
  });

  it('leaves a paragraph alone when the model has nothing to say and it is not Arabic', () => {
    const plain = '<a:p><a:r><a:t>Hi</a:t></a:r></a:p>';
    expect(styleParagraphXml(plain, base({ text: 'Hi' }))).toBe(plain);
  });

  it('drops an alignment the model cleared, keeping rtl off for Latin text', () => {
    const out = styleParagraphXml('<a:p><a:pPr algn="ctr" rtl="1"/><a:r><a:t>Hi</a:t></a:r></a:p>', base({ text: 'Hi' }));
    expect(out).toBe('<a:p><a:pPr/><a:r><a:t>Hi</a:t></a:r></a:p>');
  });
});

describe('sameParaStyle, autoAlign and paraStyleOf', () => {
  it('compares the look, not the text', () => {
    expect(sameParaStyle(base(), base({ text: 'other' }))).toBe(true);
    expect(sameParaStyle(base(), base({ bold: true }))).toBe(false);
    expect(sameParaStyle(base(), base({ underline: true }))).toBe(false);
    expect(sameParaStyle(base({ color: '#aabbcc' }), base({ color: '#AABBCC' }))).toBe(true);
  });

  it('gives Arabic the right alignment as it is typed, and never overrides a choice', () => {
    expect(autoAlign('مرحبا', null)).toBe('r');
    expect(autoAlign('Hello', null)).toBe(null);
    expect(autoAlign('مرحبا', 'ctr')).toBe('ctr');
    expect(autoAlign('Hello', 'l')).toBe('l');
  });

  it('reports the shared look, and says when paragraphs disagree', () => {
    const style = paraStyleOf([base({ bold: true }), base({ bold: true })]);
    expect(style?.bold).toBe(true);
    expect(style?.mixed).toBe(false);
    expect(paraStyleOf([base({ bold: true }), base()])?.mixed).toBe(true);
    expect(paraStyleOf([])).toBeNull();
  });
});

describe('formatting survives the surgical save', () => {
  it('writes bold, italic, underline, size, colour and alignment into the slide part', async () => {
    const bytes = newDeckPptx('Hello', 'World');
    const before = await deckOf(bytes);
    const uid = firstTextShape(before);
    const after = setParaStyle(before, 0, uid, { bold: true, italic: true, underline: true, size: 40, color: '#C8894B', align: 'r' });

    const patched = await patchDeck(readRawZip(bytes), before, after);
    expect(patched).not.toBeNull();
    const xml = await slideXml(patched!.bytes);
    expect(xml).toContain('b="1"');
    expect(xml).toContain('i="1"');
    expect(xml).toContain('u="sng"');
    expect(xml).toContain('sz="4000"');
    expect(xml).toContain('C8894B');
    expect(xml).toContain('algn="r"');

    // And the reader sees exactly what was asked for.
    const back = await deckOf(patched!.bytes);
    expect(back.slides[0].shapes[firstIndexWithText(back, 'Hello')].paras[0])
      .toMatchObject({ bold: true, italic: true, underline: true, size: 40, color: '#C8894B', align: 'r' });
  });

  it('saves Arabic typed into a plain text box with a right alignment and rtl', async () => {
    const bytes = newDeckPptx('Hello', 'World');
    const before = await deckOf(bytes);
    // A text box with no alignment of its own: this is where the Arabic default applies.
    const added = addShape(before, 0, newShape(before, 'text'));
    const uid = added.slides[0].shapes[added.slides[0].shapes.length - 1].uid;
    const after = setShapeText(added, 0, uid, 'مرحبا بالعالم');

    const patched = await patchDeck(readRawZip(bytes), before, after);
    expect(patched).not.toBeNull();
    const xml = await slideXml(patched!.bytes);
    expect(xml).toContain('rtl="1"');
    expect(xml).toContain('algn="r"');
    expect(xml).toContain('مرحبا بالعالم');

    const back = await deckOf(patched!.bytes);
    const shape = back.slides[0].shapes[firstIndexWithText(back, 'مرحبا بالعالم')];
    expect(shape.paras[0]).toMatchObject({ text: 'مرحبا بالعالم', align: 'r' });
  });

  it('a formatting-only change still produces a patch that changes the part', async () => {
    const bytes = newDeckPptx('Hello', 'World');
    const before = await deckOf(bytes);
    const uid = firstTextShape(before);
    const after = setParaStyle(before, 0, uid, { bold: true });
    const patched = await patchDeck(readRawZip(bytes), before, after);
    expect(patched).not.toBeNull();
    expect(patched!.changed.some((name) => name.startsWith('ppt/slides/slide'))).toBe(true);
  });

  it('does nothing at all when neither text nor look changed', async () => {
    const bytes = newDeckPptx('Hello', 'World');
    const before = await deckOf(bytes);
    const patched = await patchDeck(readRawZip(bytes), before, before);
    expect(patched).not.toBeNull();
    expect(patched!.changed).toEqual([]);
  });
});

/** The index of the first shape whose first paragraph is `text`. */
function firstIndexWithText(deck: Deck, text: string): number {
  const index = deck.slides[0].shapes.findIndex((s) => s.paras[0]?.text === text);
  if (index < 0) throw new Error(`no shape holds ${text}`);
  return index;
}

describe('the strings', () => {
  it('registers the same keys in Arabic and English', () => {
    const keys = (locale: 'ar' | 'en'): string[] => registeredKeys(locale).filter((k) => k.startsWith('impress.'));
    expect(keys('ar').length).toBeGreaterThan(0);
    expect(keys('ar')).toEqual(keys('en'));
  });
});
