/**
 * Every XML part this app writes has to be XML a STRICT reader accepts.
 *
 * The bug this file exists for: a worksheet with a chart carried `<drawing r:id="rId1"/>` while its
 * root declared no `xmlns:r` — a prefix with no binding. Our own reader is forgiving and read the
 * file happily; Excel refused to open it and openpyxl raised `ExpatError: unbound prefix`. The part
 * existed, the relationships existed, the content types existed: the file was simply not XML.
 *
 * So this test parses EVERY `.xml`/`.rels` part of what the writers produce with a strict parser and
 * fails on a `parsererror`. It is deliberately blind to what the parts mean — it only asks whether
 * they are well-formed — which is exactly the class of mistake the round-trip tests cannot see.
 */
import { describe, expect, it } from 'vitest';
import { entryData, readRawZip, type RawZip } from '../zip';
import { writeDocx, writeXlsx } from '../ooxml';
import { writePptx } from '../pptx';
import type { ChartObject } from './sheetview';
import type { Grid } from '../model';

/** Parses one part the strict way; returns the parser's message, or null when it is well-formed. */
function strictError(xml: string): string | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const bad = doc.getElementsByTagName('parsererror')[0];
  return bad ? (bad.textContent ?? 'parsererror').replace(/\s+/g, ' ').slice(0, 200) : null;
}

/** Every XML-ish part of an archive, with its text. */
async function xmlParts(bytes: Uint8Array): Promise<Array<{ name: string; xml: string }>> {
  const archive: RawZip = readRawZip(bytes);
  const names = archive.entries.map((e) => e.name).filter((n) => n.endsWith('.xml') || n.endsWith('.rels'));
  const out: Array<{ name: string; xml: string }> = [];
  for (const name of names) {
    const data = await entryData(archive, name);
    if (data) out.push({ name, xml: new TextDecoder().decode(data) });
  }
  return out;
}

const grid: Grid = {
  name: 'S',
  rows: [['Cat', 'Qty'], ['ألف', '10'], ['باء', '20'], ['جيم', '30']],
  truncated: false,
};

const chart: ChartObject = {
  id: 'c1', type: 'bar', range: { r0: 1, c0: 0, r1: 3, c1: 1 }, title: 'الميزانية', x: 16, y: 24, w: 320, h: 200,
};

const pie: ChartObject = { ...chart, id: 'c2', type: 'pie', title: 'نصيب', range: { r0: 1, c0: 0, r1: 3, c1: 1 } };

/** Every part is well-formed, and none of them says so out loud. */
async function expectWellFormed(bytes: Uint8Array, what: string): Promise<string[]> {
  const parts = await xmlParts(bytes);
  expect(parts.length, `${what}: no XML parts at all`).toBeGreaterThan(0);
  const broken = parts.map((p) => ({ ...p, error: strictError(p.xml) })).filter((p) => p.error !== null);
  expect(broken.map((p) => `${p.name}: ${p.error}`), `${what}: parts a strict parser rejects`).toEqual([]);
  return parts.map((p) => p.name);
}

describe('a strict parser reads every part the writers produce', () => {
  it('a workbook with a bar chart and a pie chart', async () => {
    const saved = writeXlsx([grid], undefined, undefined, undefined, undefined, { 0: [chart, pie] });
    const names = await expectWellFormed(saved, 'xlsx with charts');
    expect(names).toContain('xl/worksheets/sheet1.xml');
    expect(names).toContain('xl/charts/chart1.xml');
    // The worksheet declares the prefix its `<drawing r:id>` uses.
    const sheet = (await xmlParts(saved)).find((p) => p.name === 'xl/worksheets/sheet1.xml');
    expect(sheet?.xml).toContain('<drawing r:id="rId1"/>');
    expect(sheet?.xml).toMatch(/<worksheet[^>]*xmlns:r="[^"]+"/);
  });

  it('a workbook with a filter, conditional formatting and cell formats', async () => {
    const saved = writeXlsx(
      [grid],
      undefined,
      { 0: { cells: { '1:1': { bold: true, numFmt: '#,##0.00' } } } },
      { 0: [{ col: 1, keys: ['10', '20'] }] },
      { 0: [{ type: 'colorScale', min: { kind: 'min', color: 'F8696B' }, max: { kind: 'max', color: '63BE7B' } }] },
    );
    await expectWellFormed(saved, 'xlsx with a filter and rules');
  });

  it('a plain workbook, a document and a deck', async () => {
    await expectWellFormed(writeXlsx([grid]), 'plain xlsx');
    await expectWellFormed(writeXlsx([{ ...grid, name: 'ثاني' }, grid]), 'two sheets');
    await expectWellFormed(writeDocx(['فقرة عربية', 'سطر\tبتبويب']), 'docx');
    await expectWellFormed(writePptx([['شريحة أولى', 'نص']]), 'pptx');
  });
});
