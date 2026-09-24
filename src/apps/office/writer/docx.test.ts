/**
 * The Writer's .docx layer: the reader agrees with the viewer's reader, runs keep
 * their own formatting, tables/pictures/lists/headers are read, and the run-aware
 * save changes only what was edited — and every package it writes reads back.
 */
import { describe, expect, it } from 'vitest';
import { openZip, readDocx, zipEntries } from '../../viewer/formats';
import { readRawZip, utf8, writeZip } from '../zip';
import { contentTypes } from '../ooxml';
import type { DocModel } from '../model';
import { patchPackage, snapshotModel } from '../patch';
import { readDocxDocument } from './docxread';
import { charProps, emptyDocxPackage, paraPropsMarkup, rebuildDocxRich, runPropsMarkup } from './docxpatch';
import { blockSplice, sliceOf } from './docedits';
import { emptyBlock, formatRange, replaceText, splitBlock } from './docops';
import { blockText, type DocBlock } from './types';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const DRAWING = '<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1270000" cy="635000"/><wp:docPr id="5" name="Pic" descr="logo"/>' +
  '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId7"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';

/** mixed runs · RTL · a bordered 2×3 table · a picture · a bullet list · a footer with a page field */
function fixture(): Uint8Array {
  const body =
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title here</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">normal </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:rPr><w:i/><w:color w:val="C00000"/></w:rPr><w:t>italic</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:bidi/><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:rFonts w:hint="cs"/><w:rtl/><w:sz w:val="28"/><w:szCs w:val="32"/></w:rPr><w:t>مرحبا بالعالم</w:t></w:r></w:p>' +
    '<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>' +
    '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
    '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C1</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:shd w:val="clear" w:fill="FFFF00"/></w:tcPr><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C2</w:t></w:r></w:p></w:tc></w:tr>' +
    '</w:tbl>' +
    `<w:p>${DRAWING}</w:p>` +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>first item</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>' +
    '<w:sectPr><w:footerReference w:type="default" r:id="rId9"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="708" w:footer="708"/></w:sectPr>';
  const numbering = `${DECL}<w:numbering xmlns:w="${W}">` +
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>';
  const styles = `${DECL}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:cs="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>';
  const footer = `${DECL}<w:ftr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
  return writeZip([
    {
      name: '[Content_Types].xml', data: utf8(contentTypes([
        '<Default Extension="png" ContentType="image/png"/>',
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>',
        '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>',
      ])),
    },
    { name: '_rels/.rels', data: utf8(`${DECL}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: 'word/document.xml', data: utf8(`${DECL}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`) },
    { name: 'word/styles.xml', data: utf8(styles) },
    { name: 'word/numbering.xml', data: utf8(numbering) },
    { name: 'word/footer1.xml', data: utf8(footer) },
    { name: 'word/media/image1.png', data: PNG },
    {
      name: 'word/_rels/document.xml.rels', data: utf8(`${DECL}<Relationships xmlns="${RELS}">` +
        `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>` +
        `<Relationship Id="rId7" Type="${R}/image" Target="media/image1.png"/><Relationship Id="rId9" Type="${R}/footer" Target="footer1.xml"/></Relationships>`),
    },
  ]);
}

async function load(bytes: Uint8Array): Promise<DocModel> {
  const read = await readDocxDocument(bytes);
  return { kind: 'docx', paragraphs: read.blocks.map(blockText), blocks: read.blocks, ...(Object.keys(read.formats).length ? { formats: read.formats } : {}) };
}

function records(bytes: Uint8Array): Map<string, Uint8Array> {
  const archive = readRawZip(bytes);
  return new Map(archive.entries.map((e) => [e.name, bytes.slice(e.recordStart, e.recordEnd)]));
}
function changedEntries(a: Uint8Array, b: Uint8Array): string[] {
  const ra = records(a);
  const rb = records(b);
  const names = new Set([...ra.keys(), ...rb.keys()]);
  return [...names].filter((n) => { const x = ra.get(n); const y = rb.get(n); return !x || !y || x.length !== y.length || x.some((v, i) => v !== y[i]); }).sort();
}
async function part(bytes: Uint8Array, name: string): Promise<string> {
  return new TextDecoder().decode((await openZip(bytes).read(name)) ?? new Uint8Array());
}
async function wellFormed(bytes: Uint8Array): Promise<boolean> {
  const zip = openZip(bytes);
  for (const name of zip.names()) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const doc = new DOMParser().parseFromString(await part(bytes, name), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return false;
  }
  return true;
}

describe('the Writer reader', () => {
  it('lists exactly the paragraphs the viewer reads, with the same text', async () => {
    const bytes = fixture();
    const read = await readDocxDocument(bytes);
    expect(read.blocks.map(blockText)).toEqual(await readDocx(bytes));
  });

  it('keeps each run’s own bold, italic and colour (mixed runs in one paragraph)', async () => {
    const read = await readDocxDocument(fixture());
    const runs = read.blocks[1].runs.filter((r) => r.t === 'text');
    expect(runs.map((r) => r.text)).toEqual(['normal ', 'bold', ' ', 'italic']);
    expect(runs.map((r) => (r.t === 'text' ? r.props : {}))).toEqual([{}, { b: true }, {}, { i: true, color: 'C00000' }]);
  });

  it('reads an RTL paragraph with its complex-script size and direction', async () => {
    const read = await readDocxDocument(fixture());
    expect(read.formats[2]).toEqual({ dir: 'rtl', align: 'left' });
    const run = read.blocks[2].runs[0];
    expect(run.t === 'text' && run.props).toEqual({ rtl: true, sz: 16 });
  });

  it('resolves styles, tables, pictures, list markers, the page and the footer', async () => {
    const read = await readDocxDocument(fixture());
    const { look } = read;
    expect(look.paras[0].outline).toBe(0);
    expect(look.paras[0].text.b).toBe(true);
    expect(look.paras[0].text.sz).toBe(16);
    expect(look.tables[0].grid).toEqual([100, 150, 200]);
    expect(look.tables[0].rows[0].cells[0].span).toBe(2);
    expect(look.tables[0].rows[1].cells[1].fill).toBe('FFFF00');
    expect(look.paras[3].cell).toEqual({ table: 0, row: 0, cell: 0 });
    expect(look.paras[7].cell).toEqual({ table: 0, row: 1, cell: 2 });
    const pic = read.blocks[8].runs.find((r) => r.t === 'opaque');
    expect(pic && pic.t === 'opaque' && pic.kind).toBe('image');
    expect(pic && pic.t === 'opaque' && pic.image).toMatchObject({ rid: 'rId7', w: 100, h: 50, alt: 'logo' });
    expect(look.media.get('rId7')?.mime).toBe('image/png');
    expect(look.paras.map((p) => p.marker ?? '')).toEqual(['', '', '', '', '', '', '', '', '', '•', '1.', '2.']);
    expect(Math.round(look.page.w)).toBe(595);
    expect(look.page.left).toBe(54);
    expect(look.footers.default?.lines[0]).toMatchObject({ text: 'Page \u0001', align: 'center' });
  });
});

describe('the run-aware save', () => {
  it('changes one word and bolds another, touching only the document part', async () => {
    const original = fixture();
    const base = await load(original);
    const blocks = base.blocks as DocBlock[];
    // "normal bold italic" → "normal BOLD italic", then make "normal" bold.
    let runs = replaceText(blocks[1].runs, 7, 11, 'BOLD');
    runs = formatRange(runs, 0, 6, { b: true });
    const edited = blockSplice(1, sliceOf(base, 1, 1), { blocks: [{ ...blocks[1], runs }], formats: [undefined] });
    const current = edited.apply(base) as DocModel;
    const patched = await patchPackage('docx', original, snapshotModel(base), snapshotModel(current));
    expect(patched).not.toBeNull();
    if (!patched) return;
    expect(changedEntries(original, patched.bytes)).toEqual(['word/document.xml']);
    const again = await readDocxDocument(patched.bytes);
    expect(again.blocks.map(blockText)).toEqual(current.paragraphs);
    expect(charProps(again.blocks[1].runs)).toBe(charProps(runs));
    const xml = await part(patched.bytes, 'word/document.xml');
    expect(xml).toContain('<w:rPr><w:i/><w:color w:val="C00000"/></w:rPr><w:t>italic</w:t>');
    expect(xml).toContain('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title here</w:t></w:r></w:p>');
    expect(xml).toContain(DRAWING);
    expect(await wellFormed(patched.bytes)).toBe(true);
  });

  it('splits a paragraph on Enter; the new one copies the RTL properties', async () => {
    const original = fixture();
    const base = await load(original);
    const blocks = base.blocks as DocBlock[];
    const [left, right] = splitBlock(blocks[2], 5, 100);
    const current = blockSplice(2, sliceOf(base, 2, 1), { blocks: [left, right], formats: [base.formats?.[2], base.formats?.[2]] }).apply(base) as DocModel;
    const patched = await patchPackage('docx', original, snapshotModel(base), snapshotModel(current));
    expect(patched).not.toBeNull();
    if (!patched) return;
    expect(await readDocx(patched.bytes)).toEqual(current.paragraphs);
    const again = await readDocxDocument(patched.bytes);
    expect(again.formats[3]).toEqual({ dir: 'rtl', align: 'left' });
    const run = again.blocks[3].runs[0];
    expect(run.t === 'text' && run.props.rtl).toBe(true);
  });

  it('deletes a paragraph and inserts a bordered table and a picture', async () => {
    const original = fixture();
    const base = await load(original);
    const cells: DocBlock[] = [];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
      cells.push({ id: 200 + r * 2 + c, runs: [{ t: 'text', text: `r${r}c${c}`, props: {} }], cell: { table: 1, row: r, col: c, rows: 2, cols: 2 } });
    }
    const pic: DocBlock = { id: 300, runs: [{ t: 'opaque', text: '', xml: '', kind: 'image', newImage: { data: PNG, ext: 'png', w: 40, h: 20, name: 'dot' } }, { t: 'text', text: '', props: {} }] };
    let m = blockSplice(0, sliceOf(base, 0, 1), { blocks: [], formats: [] }).apply(base) as DocModel; // delete the heading
    m = blockSplice(1, { blocks: [], formats: [] }, { blocks: [...cells, emptyBlock(210), pic], formats: [] }).apply(m) as DocModel;
    const patched = await patchPackage('docx', original, snapshotModel(base), snapshotModel(m));
    expect(patched).not.toBeNull();
    if (!patched) return;
    expect(await readDocx(patched.bytes)).toEqual(m.paragraphs);
    const xml = await part(patched.bytes, 'word/document.xml');
    expect(xml).toContain('<w:tblGrid><w:gridCol');
    expect(xml).toContain('<w:insideV w:val="single"');
    expect(xml).not.toContain('Title here');
    expect(zipEntries(patched.bytes).map((e) => e.name)).toContain('word/media/fo-image1.png');
    expect(await part(patched.bytes, 'word/_rels/document.xml.rels')).toContain('Target="media/fo-image1.png"');
    expect(patched.materialized?.length).toBe(1);
    expect(await wellFormed(patched.bytes)).toBe(true);
    const again = await readDocxDocument(patched.bytes);
    expect(again.look.tables.length).toBe(2);
  });

  it('adds a bullet list and a heading style to a document that has neither', async () => {
    const original = emptyDocxPackage(false);
    const base = await load(original);
    const block = { ...(base.blocks as DocBlock[])[0], runs: [{ t: 'text' as const, text: 'item', props: {} }] };
    const current: DocModel = { kind: 'docx', paragraphs: ['item'], blocks: [block], formats: { 0: { list: 'bullet', style: 'Heading2', align: 'center' } } };
    const patched = await patchPackage('docx', original, snapshotModel(base), snapshotModel(current));
    expect(patched).not.toBeNull();
    if (!patched) return;
    expect(zipEntries(patched.bytes).map((e) => e.name)).toContain('word/numbering.xml');
    expect(await part(patched.bytes, '[Content_Types].xml')).toContain('/word/numbering.xml');
    const again = await readDocxDocument(patched.bytes);
    expect(again.formats[0]).toMatchObject({ list: 'bullet', style: 'Heading2', align: 'center' });
    expect(again.look.paras[0].marker).toBe('•');
    expect(await wellFormed(patched.bytes)).toBe(true);
  });

  it('refuses nothing silently: a new empty document is well-formed and reads as one paragraph', async () => {
    const bytes = emptyDocxPackage(true);
    expect(await readDocx(bytes)).toEqual(['']);
    expect(await wellFormed(bytes)).toBe(true);
    const read = await readDocxDocument(bytes);
    expect(read.formats[0]).toEqual({ dir: 'rtl' });
  });

  it('rebuilds from the rich model with run formatting kept', async () => {
    const base = await load(fixture());
    const bytes = await rebuildDocxRich(base);
    expect(bytes).not.toBeNull();
    if (!bytes) return;
    expect(await readDocx(bytes)).toEqual(base.paragraphs);
    const again = await readDocxDocument(bytes);
    expect(charProps(again.blocks[1].runs)).toBe(charProps((base.blocks as DocBlock[])[1].runs));
  });
});

describe('property markup', () => {
  it('writes only what changed, in schema order, keeping unknown children', () => {
    const raw = '<w:rPr><w:rFonts w:hint="cs"/><w:rtl/></w:rPr>';
    expect(runPropsMarkup(raw, { rtl: true }, { rtl: true, b: true, sz: 12 }, false))
      .toBe('<w:rPr><w:rFonts w:hint="cs"/><w:b/><w:bCs/><w:sz w:val="24"/><w:szCs w:val="24"/><w:rtl/></w:rPr>');
    expect(runPropsMarkup('', {}, {}, true)).toBe('<w:rPr><w:rtl/></w:rPr>');
    expect(runPropsMarkup('<w:rPr><w:b/></w:rPr>', { b: true }, {}, false)).toBe('');
  });

  it('writes paragraph direction, style, list and line spacing', () => {
    const out = paraPropsMarkup('<w:pPr><w:spacing w:after="160"/></w:pPr>', {}, { dir: 'rtl', style: 'Quote', list: 'number', line: 1.5, align: 'justify' }, () => '7');
    expect(out).toBe('<w:pPr><w:pStyle w:val="Quote"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr><w:bidi/><w:spacing w:line="360" w:lineRule="auto" w:after="160"/><w:jc w:val="both"/></w:pPr>');
  });
});
