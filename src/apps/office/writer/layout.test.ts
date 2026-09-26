/**
 * Writer — page layout, header and footer, from the model to the file and back
 * (تخطيط الصفحة والرأس والتذييل: من النموذج إلى الملف والعودة).
 *
 * The owner's margins, orientation, paper and columns are written into the body's `<w:sectPr>`,
 * and the header and footer into their own parts with real PAGE/NUMPAGES fields; the Writer's
 * reader reads them back as the same values. Everything else in the section is kept.
 */
import { describe, expect, it } from 'vitest';
import { readDocx } from '../../viewer/formats';
import type { DocModel } from '../model';
import { patchPackage, snapshotModel } from '../patch';
import { parsePart } from '../xmlscan';
import { readRawZip, entryData } from '../zip';
import { readDocxDocument } from './docxread';
import { emptyDocxPackage, rebuildDocxRich } from './docxpatch';
import {
  DEFAULT_PAGE, MARGINS, PAGES_FIELD, PAGE_FIELD, hfDisplay, hfPartXml, marginsOf, orientationOf, paperOf, readSectPr,
  samePage, sectPrWithPage, sectPrWithReference, withColumns, withMargins, withOrientation, withPaper, type PageSetup,
} from './layout';
import { blockText } from './types';

describe('page setup arithmetic', () => {
  it('names the paper in either orientation, and the margin preset', () => {
    expect(paperOf(DEFAULT_PAGE)).toBe('A4');
    expect(orientationOf(DEFAULT_PAGE)).toBe('portrait');
    const land = withOrientation(DEFAULT_PAGE, 'landscape');
    expect(orientationOf(land)).toBe('landscape');
    expect(paperOf(land)).toBe('A4');
    const letter = withPaper(land, 'Letter');
    expect([letter.w, letter.h]).toEqual([792, 612]);
    expect(marginsOf(DEFAULT_PAGE)).toBe('normal');
    expect(marginsOf(withMargins(DEFAULT_PAGE, MARGINS.wide))).toBe('wide');
    expect(marginsOf(withMargins(DEFAULT_PAGE, { top: 10, bottom: 10, left: 10, right: 11 }))).toBeNull();
  });

  it('refuses margins that leave no room for the text, and keeps columns between 1 and 3', () => {
    expect(withMargins(DEFAULT_PAGE, { top: 72, bottom: 72, left: 288, right: 288 })).toBe(DEFAULT_PAGE);
    expect(withColumns(DEFAULT_PAGE, 5).cols).toBe(3);
    expect(withColumns(DEFAULT_PAGE, 0).cols).toBe(1);
  });

  it('shows the page-number fields as this page’s numbers', () => {
    expect(hfDisplay(`Page ${PAGE_FIELD} of ${PAGES_FIELD}`, 2, 7)).toBe('Page 2 of 7');
  });
});

describe('the section XML', () => {
  const SECT = '<w:sectPr w:rsidR="00AB"><w:headerReference w:type="first" r:id="rId9"/><w:pgSz w:w="11906" w:h="16838" w:code="9"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="120"/>' +
    '<w:pgNumType w:start="3"/><w:titlePg/><w:docGrid w:linePitch="360"/></w:sectPr>';

  it('rewrites size, margins and columns and keeps everything else (the gutter too), in schema order', () => {
    const page: PageSetup = { ...withOrientation(DEFAULT_PAGE, 'landscape'), left: 36, right: 36, cols: 2, colGap: 18 };
    const out = sectPrWithPage(SECT, page);
    expect(out).toContain('w:orient="landscape"');
    expect(out).toContain('w:gutter="120"');
    expect(out).toContain('<w:cols w:space="360" w:num="2"/>');
    expect(out).toContain('<w:pgNumType w:start="3"/>');
    expect(out).toContain('<w:headerReference w:type="first" r:id="rId9"/>');
    const order = parsePart(out).roots[0].children.map((c) => c.name);
    expect(order).toEqual(['w:headerReference', 'w:pgSz', 'w:pgMar', 'w:pgNumType', 'w:cols', 'w:titlePg', 'w:docGrid']);
    expect(samePage(readSectPr(out, parsePart(out).roots[0]), page)).toBe(true);
  });

  it('adds, repoints and removes the default header reference, leaving the first-page one alone', () => {
    const added = sectPrWithReference(SECT, 'header', 'rId20');
    expect(added).toMatch(/<w:headerReference w:type="default" r:id="rId20"\/>.*<w:headerReference w:type="first"|<w:headerReference w:type="first".*<w:headerReference w:type="default" r:id="rId20"\/>/);
    const moved = sectPrWithReference(added, 'header', 'rId21');
    expect(moved).toContain('r:id="rId21"');
    expect(moved).not.toContain('rId20');
    const removed = sectPrWithReference(moved, 'header', null);
    expect(removed).not.toContain('w:type="default"');
    expect(removed).toContain('w:type="first"');
    const footer = sectPrWithReference(SECT, 'footer', 'rId5');
    expect(parsePart(footer).roots[0].children.map((c) => c.name).slice(0, 2)).toEqual(['w:headerReference', 'w:footerReference']);
  });

  it('writes a header part with real PAGE and NUMPAGES fields, one paragraph per line', () => {
    const xml = hfPartXml('footer', { text: `Report\nPage ${PAGE_FIELD} of ${PAGES_FIELD}`, align: 'center' }, false);
    expect(xml).toContain('<w:ftr ');
    expect(xml.match(/<w:p>/g)).toHaveLength(2);
    expect(xml).toContain('w:instr=" PAGE \\* MERGEFORMAT "');
    expect(xml).toContain('w:instr=" NUMPAGES \\* MERGEFORMAT "');
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(hfPartXml('header', { text: 'تقرير', align: 'left' }, true)).toContain('<w:bidi/>');
  });
});

/* ─────────────────────────── round trip through the file ─────────────────────────── */

async function load(bytes: Uint8Array): Promise<DocModel> {
  const read = await readDocxDocument(bytes);
  const texts = await readDocx(bytes);
  return { kind: 'docx', paragraphs: texts, blocks: read.blocks, ...(Object.keys(read.formats).length ? { formats: read.formats } : {}) };
}

async function part(bytes: Uint8Array, name: string): Promise<string> {
  const data = await entryData(readRawZip(bytes), name);
  return data ? new TextDecoder().decode(data) : '';
}

describe('page layout and header/footer survive the save (docx round trip)', () => {
  const page: PageSetup = { ...withPaper(withOrientation(DEFAULT_PAGE, 'landscape'), 'Letter'), ...MARGINS.narrow, cols: 2 };
  const headerFooter = { header: { text: 'تقرير الربع الأول', align: 'right' as const }, footer: { text: `Page ${PAGE_FIELD} of ${PAGES_FIELD}`, align: 'center' as const } };

  it('writes margins, orientation, size, columns, header and footer, and reads them back', async () => {
    const source = emptyDocxPackage(false);
    const base = await load(source);
    const current: DocModel = { ...base, page, headerFooter };
    const out = await patchPackage('docx', source, snapshotModel(base), current);
    expect(out).not.toBeNull();
    const bytes = (out as { bytes: Uint8Array }).bytes;
    const doc = await part(bytes, 'word/document.xml');
    expect(doc).toContain('w:orient="landscape"');
    expect(doc).toMatch(/<w:headerReference w:type="default" r:id="rId\d+"\/>/);
    expect(doc).toMatch(/xmlns:r="/);
    expect(await part(bytes, '[Content_Types].xml')).toContain('/word/fo-footer1.xml');
    const back = await readDocxDocument(bytes);
    expect(back.look.page.w).toBeCloseTo(792, 0);
    expect(back.look.page.h).toBeCloseTo(612, 0);
    expect(back.look.page.left).toBe(36);
    expect(back.look.page.cols).toBe(2);
    expect(back.look.headers.default?.lines.map((l) => l.text)).toEqual(['تقرير الربع الأول']);
    expect(back.look.footers.default?.lines.map((l) => l.text)).toEqual([`Page ${PAGE_FIELD} of ${PAGES_FIELD}`]);
    expect(back.look.footers.default?.lines[0].align).toBe('center');
    // Saving again with the same setup changes nothing.
    const again = await patchPackage('docx', bytes, await load(bytes), { ...(await load(bytes)), page, headerFooter });
    expect(again?.changed).toEqual([]);
  });

  it('changes a header that exists, and removes the footer when the owner clears it', async () => {
    const source = emptyDocxPackage(true);
    const base = await load(source);
    const first = await patchPackage('docx', source, snapshotModel(base), { ...base, headerFooter });
    const bytes = (first as { bytes: Uint8Array }).bytes;
    const reopened = await load(bytes);
    const second = await patchPackage('docx', bytes, snapshotModel(reopened), { ...reopened, headerFooter: { header: { text: 'v2', align: 'left' }, footer: null } });
    expect(second).not.toBeNull();
    const back = await readDocxDocument((second as { bytes: Uint8Array }).bytes);
    expect(back.look.headers.default?.lines.map((l) => l.text)).toEqual(['v2']);
    expect(back.look.footers.default).toBeUndefined();
    // The paragraphs are untouched.
    expect((await load((second as { bytes: Uint8Array }).bytes)).paragraphs).toEqual(reopened.paragraphs);
  });

  it('keeps the page and the header of the source file when the document is rebuilt', async () => {
    const source = emptyDocxPackage(false);
    const base = await load(source);
    const withLayout = (await patchPackage('docx', source, snapshotModel(base), { ...base, page, headerFooter }) as { bytes: Uint8Array }).bytes;
    const reopened = await load(withLayout);
    const typed: DocModel = { ...reopened, paragraphs: ['hello'], blocks: [{ ...(reopened.blocks ?? [])[0], runs: [{ t: 'text', text: 'hello', props: { b: true } }] }] };
    const rebuilt = await rebuildDocxRich(typed, [], withLayout);
    expect(rebuilt).not.toBeNull();
    const back = await readDocxDocument(rebuilt as Uint8Array);
    expect(back.look.page.cols).toBe(2);
    expect(back.look.page.w).toBeGreaterThan(back.look.page.h);
    expect(back.look.footers.default?.lines.map((l) => l.text)).toEqual([`Page ${PAGE_FIELD} of ${PAGES_FIELD}`]);
    expect(back.blocks.map(blockText)).toEqual(['hello']);
  });

  it('writes an indent set with the indent buttons, and reads it back', async () => {
    const source = emptyDocxPackage(false);
    const base = await load(source);
    const edited: DocModel = { ...base, paragraphs: ['x'], blocks: [{ ...(base.blocks ?? [])[0], runs: [{ t: 'text', text: 'x', props: {} }] }], formats: { 0: { indent: 72 } } };
    const out = await patchPackage('docx', source, snapshotModel(base), edited);
    expect(out).not.toBeNull();
    const back = await readDocxDocument((out as { bytes: Uint8Array }).bytes);
    expect(back.formats[0]?.indent).toBe(72);
  });
});
