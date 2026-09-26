import { describe, expect, it } from 'vitest';
import { entryData, readRawZip } from '../zip';
import { writeXlsx } from '../ooxml';
import { readBookLook } from './xlsxlook';
import type { ChartObject } from './sheetview';
import { chartSpaceXml, drawingElement, drawingRelsXml, drawingXml, parseAnchors, parseChartSpace, withDrawing, type ChartToWrite } from './chart-xml';

/**
 * A chart in the file is three parts and two relationships. Every one of them has to be right, or a
 * real reader offers to repair the workbook — so this file checks the parts exist, that the rels
 * point at them in both directions, that [Content_Types].xml covers them, and that the whole thing
 * comes back at open.
 */
const chart: ChartToWrite = {
  index: 0,
  kind: 'bar',
  title: 'الميزانية',
  values: [10, 20, 30],
  categories: ['ألف', 'باء', 'جيم'],
  valueRef: 'S!$B$2:$B$4',
  categoryRef: 'S!$A$2:$A$4',
  x: 16,
  y: 24,
  w: 320,
  h: 200,
};

const grid = { name: 'S', rows: [['Cat', 'Qty'], ['ألف', '10'], ['باء', '20'], ['جيم', '30']], truncated: false };
const one = (index: number): ChartObject => ({ id: `c${index}`, type: 'bar', range: { r0: 1, c0: 0, r1: 3, c1: 1 }, title: 'الميزانية', x: 16, y: 24, w: 320, h: 200 });

describe('the chart part', () => {
  it('carries the plot, the cached points and the title', () => {
    const xml = chartSpaceXml(chart);
    expect(xml).toContain('<c:barChart>');
    expect(xml).toContain('<c:catAx>');
    expect(xml).toContain('<c:valAx>');
    expect(xml).toContain('<c:ptCount val="3"/>');
    expect(xml).toContain('<c:v>30</c:v>');
    expect(xml).toContain('S!$B$2:$B$4');
    expect(xml).toContain('<a:t>الميزانية</a:t>');
  });

  it('has no axes on a pie, and a line chart says so', () => {
    const pie = chartSpaceXml({ ...chart, kind: 'pie' });
    expect(pie).toContain('<c:pieChart>');
    expect(pie).not.toContain('<c:catAx>');
    expect(chartSpaceXml({ ...chart, kind: 'line' })).toContain('<c:lineChart>');
  });

  it('reads its own spelling back', () => {
    const parsed = parseChartSpace(chartSpaceXml(chart));
    expect(parsed).toMatchObject({ kind: 'bar', title: 'الميزانية', valueRef: 'S!$B$2:$B$4', categoryRef: 'S!$A$2:$A$4' });
    expect(parsed?.values).toEqual([10, 20, 30]);
    expect(parsed?.categories).toEqual(['ألف', 'باء', 'جيم']);
    expect(parseChartSpace('<c:chartSpace/>')).toBeNull();
  });
});

describe('the drawing part', () => {
  it('anchors each chart in pixels and points at its chart part', () => {
    const xml = drawingXml([chart]);
    expect(xml).toContain(`<xdr:pos x="${16 * 9525}" y="${24 * 9525}"/>`);
    expect(xml).toContain(`<xdr:ext cx="${320 * 9525}" cy="${200 * 9525}"/>`);
    expect(xml).toContain('r:id="rId1"');
    expect(parseAnchors(xml)[0]).toEqual({ x: 16, y: 24, w: 320, h: 200, relId: 'rId1' });
  });

  it('relates the drawing to its charts', () => {
    expect(drawingRelsXml([chart])).toContain('Target="../charts/chart1.xml"');
  });

  it('puts the worksheet element after the page setup and before tableParts', () => {
    const sheet = '<worksheet><sheetData/><pageMargins/><tableParts count="0"/></worksheet>';
    const out = withDrawing(sheet, drawingElement('rId1'));
    expect(out.indexOf('<pageMargins/>')).toBeLessThan(out.indexOf('<drawing'));
    expect(out.indexOf('<drawing')).toBeLessThan(out.indexOf('<tableParts'));
    // Replacing it never leaves two drawings behind, and clearing it takes the element away.
    expect(withDrawing(out, drawingElement('rId1')).match(/<drawing/g)).toHaveLength(1);
    expect(withDrawing(out, null)).not.toContain('<drawing');
  });
});

describe('a workbook with a chart', () => {
  it('writes the drawing, its rels, the chart part and the content types', async () => {
    const saved = writeXlsx([grid], undefined, undefined, undefined, undefined, { 0: [one(0)] });
    const archive = readRawZip(saved);
    const part = async (name: string): Promise<string> => new TextDecoder().decode((await entryData(archive, name)) ?? new Uint8Array());

    const sheet = await part('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<drawing r:id="rId1"/>');
    expect(await part('xl/worksheets/_rels/sheet1.xml.rels')).toContain('Target="../drawings/drawing1.xml"');
    const drawing = await part('xl/drawings/drawing1.xml');
    expect(drawing).toContain('<xdr:wsDr');
    expect(await part('xl/drawings/_rels/drawing1.xml.rels')).toContain('Target="../charts/chart1.xml"');
    expect(await part('xl/charts/chart1.xml')).toContain('<c:barChart>');
    const types = await part('[Content_Types].xml');
    expect(types).toContain('PartName="/xl/drawings/drawing1.xml"');
    expect(types).toContain('PartName="/xl/charts/chart1.xml"');
  });

  it('comes back at open with its place and its data', async () => {
    const saved = writeXlsx([grid], undefined, undefined, undefined, undefined, { 0: [one(0)] });
    const look = await readBookLook(saved);
    const charts = look.sheets[0].charts ?? [];
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ type: 'bar', title: 'الميزانية', x: 16, y: 24, w: 320, h: 200 });
    expect(charts[0].range).toEqual({ r0: 1, c0: 0, r1: 3, c1: 1 });
  });

  it('writes none of those parts for a sheet with no charts', async () => {
    const saved = writeXlsx([grid]);
    const archive = readRawZip(saved);
    const names = (await Promise.all(['xl/drawings/drawing1.xml', 'xl/charts/chart1.xml', 'xl/worksheets/_rels/sheet1.xml.rels']
      .map(async (name) => ((await entryData(archive, name)) ? name : null)))).filter(Boolean);
    expect(names).toEqual([]);
    expect(new TextDecoder().decode((await entryData(archive, '[Content_Types].xml')) ?? new Uint8Array())).not.toContain('drawing1.xml');
    expect((await readBookLook(saved)).sheets[0].charts).toBeUndefined();
  });
});
