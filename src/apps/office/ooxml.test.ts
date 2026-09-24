/**
 * Tests for the OOXML writers: each package is read back with the viewer's reader,
 * and every package is checked for the structure an Office program relies on —
 * valid XML, a content type for every part, and every relationship target present.
 *
 * What these tests cannot prove is stated in the app and in the report: no Word,
 * Excel, PowerPoint or LibreOffice was available here, so "opens in Office" is a
 * structural claim, not an observed one.
 */
import { describe, expect, it } from 'vitest';
import { writeDocx, writeXlsx, contentTypes } from './ooxml';
import { writePptx } from './pptx';
import { cellName, columnName, escapeXml, isNumericText, sanitizeXmlText, sheetName, xmlText } from './xml';
import { openZip, readDocx, readPptx, readXlsx, zipEntries, columnIndex } from '../viewer/formats';
import type { Grid } from './model';

function resolveDots(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Everything that must hold in an OOXML package: the archive reads, every XML part
 * parses, every part has a content type, and every relationship points at a part
 * that exists. Returns the problems found (empty means healthy).
 */
async function packageProblems(bytes: Uint8Array): Promise<string[]> {
  const problems: string[] = [];
  const entries = zipEntries(bytes);
  const names = new Set(entries.map((e) => e.name));
  const zip = openZip(bytes);
  const decode = (data: Uint8Array) => new TextDecoder().decode(data);

  const ct = await zip.read('[Content_Types].xml');
  if (!ct) return ['[Content_Types].xml is missing'];
  const ctDoc = new DOMParser().parseFromString(decode(ct), 'application/xml');
  if (ctDoc.getElementsByTagName('parsererror').length) return ['[Content_Types].xml does not parse'];
  const defaults = new Set([...ctDoc.getElementsByTagName('Default')].map((d) => (d.getAttribute('Extension') ?? '').toLowerCase()));
  const overrides = new Set([...ctDoc.getElementsByTagName('Override')].map((o) => o.getAttribute('PartName') ?? ''));

  for (const entry of entries) {
    if (entry.name === '[Content_Types].xml') continue;
    const ext = (entry.name.split('.').pop() ?? '').toLowerCase();
    if (!defaults.has(ext) && !overrides.has(`/${entry.name}`)) problems.push(`no content type for ${entry.name}`);
    if (!entry.name.endsWith('.xml') && !entry.name.endsWith('.rels')) continue;
    const data = await zip.read(entry.name);
    if (!data) { problems.push(`unreadable part ${entry.name}`); continue; }
    const doc = new DOMParser().parseFromString(decode(data), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) { problems.push(`${entry.name} does not parse`); continue; }
    if (!entry.name.endsWith('.rels')) continue;
    const base = entry.name.replace(/_rels\/[^/]+$/, '');
    for (const rel of doc.getElementsByTagName('Relationship')) {
      const target = rel.getAttribute('Target') ?? '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // an external target
      const resolved = target.startsWith('/') ? target.slice(1) : resolveDots(`${base}${target}`);
      if (!names.has(resolved)) problems.push(`${entry.name}: target not in the package: ${resolved}`);
    }
  }
  return problems;
}

/** Rows padded to the widest row, so "no cell" and "an empty cell" compare equal. */
function pad(rows: string[][]): string[][] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => [...r, ...new Array<string>(width - r.length).fill('')]);
}

describe('xml helpers', () => {
  it('escapes everything that means something to an XML parser', () => {
    expect(escapeXml('a<b & "c" \'d\'')).toBe('a&lt;b &amp; &quot;c&quot; &apos;d&apos;');
    expect(xmlText('&<>')).toBe('&amp;&lt;&gt;');
  });

  it('drops characters XML 1.0 forbids and keeps the legal ones', () => {
    expect(sanitizeXmlText(`ok\t\n\r\u0000\u0007\u001fend`)).toBe('ok\t\n\rend');
    expect(sanitizeXmlText('a\uFFFEb\uFFFFc')).toBe('abc');
  });

  it('names columns exactly as the reader indexes them', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
    for (const index of [0, 1, 25, 26, 27, 51, 52, 701, 702, 1000]) {
      expect(columnIndex(columnName(index))).toBe(index);
    }
    expect(cellName(0, 0)).toBe('A1');
    expect(cellName(11, 27)).toBe('AB12');
  });

  it('sanitizes sheet names to what Excel accepts, and keeps them unique', () => {
    const taken = new Set<string>();
    const first = sheetName('Sales/Q1:2026', 0, taken);
    expect(first).toBe('Sales Q1 2026');
    taken.add(first);
    expect(sheetName('Sales/Q1:2026', 1, taken)).toBe('Sales Q1 2026 (2)');
    expect(sheetName('', 2)).toBe('Sheet3');
    expect(sheetName('x'.repeat(60), 3).length).toBe(31);
    expect(sheetName('   ', 4)).toBe('Sheet5');
  });

  it('recognizes plain numbers, and only those', () => {
    for (const value of ['42', '-7', '3.5', '.5', '1e6', '1.2E-3']) expect(isNumericText(value)).toBe(true);
    for (const value of ['', '4 2', '1,2', 'TRUE', '2026-01-01', 'a1', '1.2.3']) expect(isNumericText(value)).toBe(false);
  });

  it('declares rels and xml content types for every package', () => {
    const types = contentTypes([]);
    expect(types).toContain('<Default Extension="rels"');
    expect(types).toContain('<Default Extension="xml"');
  });
});

describe('writeDocx', () => {
  const paragraphs = [
    'Hello world',
    '',
    'Tab\there',
    'Line one\nLine two',
    'a<b & "c" \'d\'',
    'عربي — صف',
    '  spaces  kept  ',
    '\u0000\u0007 control chars dropped',
  ];

  it('round-trips paragraphs, tabs and line breaks through readDocx', async () => {
    const back = await readDocx(writeDocx(paragraphs));
    expect(back).toEqual(paragraphs.slice(0, 7).concat([' control chars dropped']));
  });

  it('is a structurally complete package', async () => {
    const bytes = writeDocx(paragraphs);
    const names = zipEntries(bytes).map((e) => e.name);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    expect(names).toContain('word/document.xml');
    expect(names).toContain('word/_rels/document.xml.rels');
    expect(await packageProblems(bytes)).toEqual([]);
  });
});

describe('writeXlsx', () => {
  const grids: Grid[] = [
    {
      name: 'Sheet1',
      rows: [
        ['Name', 'Qty', 'Price'],
        ['Widget', '12', '3.50'],
        ['محمد', '3', '7'],
        ['Only text'],
        ['', '', 'tail'],
      ],
      truncated: false,
    },
    { name: 'Second/Sheet', rows: [['x', 'TRUE']], truncated: false },
  ];

  it('round-trips cells, numbers and sheet names through readXlsx', async () => {
    const sheets = await readXlsx(writeXlsx(grids));
    expect(sheets.map((s) => s.name)).toEqual(['Sheet1', 'Second Sheet']);
    expect(pad(sheets[0].rows)).toEqual(pad(grids[0].rows));
    expect(pad(sheets[1].rows)).toEqual(pad(grids[1].rows));
  });

  it('writes numbers as numbers and text as inline strings', async () => {
    const bytes = writeXlsx([{ name: 'S', rows: [['42', 'x', 'TRUE']], truncated: false }]);
    const xml = new TextDecoder().decode(await openZip(bytes).read('xl/worksheets/sheet1.xml') ?? new Uint8Array());
    expect(xml).toContain('<c r="A1"><v>42</v></c>');
    expect(xml).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">x</t></is></c>');
    expect(xml).toContain('<c r="C1" t="inlineStr">');
  });

  it('keeps every row, including one that is entirely empty', async () => {
    const bytes = writeXlsx([{ name: 'S', rows: [['a'], [], ['', '']], truncated: false }]);
    const sheets = await readXlsx(bytes);
    expect(sheets[0].rows.length).toBe(3);
    expect(sheets[0].rows[0]).toEqual(['a']);
  });

  it('is a structurally complete package with one part per sheet', async () => {
    const bytes = writeXlsx(grids);
    const names = zipEntries(bytes).map((e) => e.name);
    expect(names).toContain('xl/workbook.xml');
    expect(names).toContain('xl/worksheets/sheet1.xml');
    expect(names).toContain('xl/worksheets/sheet2.xml');
    expect(names).toContain('xl/_rels/workbook.xml.rels');
    expect(await packageProblems(bytes)).toEqual([]);
  });

  it('still produces a one-sheet package when the model has no sheets', async () => {
    const bytes = writeXlsx([]);
    expect(zipEntries(bytes).map((e) => e.name)).toContain('xl/worksheets/sheet1.xml');
    expect(await packageProblems(bytes)).toEqual([]);
  });
});

describe('writePptx', () => {
  const slides = [
    ['Quarterly numbers', 'Revenue up\ttwelve percent'],
    ['Risks & mitigations', 'عربي'],
    ['Only one line'],
  ];

  it('round-trips slide text through readPptx', async () => {
    expect(await readPptx(writePptx(slides))).toEqual(slides);
  });

  it('is a structurally complete package with master, layout and theme', async () => {
    const bytes = writePptx(slides);
    const names = zipEntries(bytes).map((e) => e.name);
    for (const part of [
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/theme/theme1.xml',
      'ppt/slides/slide1.xml',
      'ppt/slides/slide3.xml',
      'ppt/slides/_rels/slide3.xml.rels',
      'ppt/presProps.xml',
      'ppt/viewProps.xml',
      'ppt/tableStyles.xml',
    ]) {
      expect(names, part).toContain(part);
    }
    expect(await packageProblems(bytes)).toEqual([]);
  });

  it('lists one slide id per slide, in order', async () => {
    const bytes = writePptx(slides);
    const xml = new TextDecoder().decode(await openZip(bytes).read('ppt/presentation.xml') ?? new Uint8Array());
    expect(xml.match(/<p:sldId /g)?.length).toBe(3);
    expect(xml).toContain('r:id="rId2"');
    expect(xml).toContain('r:id="rId4"');
    const rels = new TextDecoder().decode(await openZip(bytes).read('ppt/_rels/presentation.xml.rels') ?? new Uint8Array());
    expect(rels).toContain('Target="slides/slide3.xml"');
  });

  it('produces one empty slide for a deck with no slides', async () => {
    const bytes = writePptx([]);
    expect(zipEntries(bytes).map((e) => e.name)).toContain('ppt/slides/slide1.xml');
    expect(await packageProblems(bytes)).toEqual([]);
  });
});
