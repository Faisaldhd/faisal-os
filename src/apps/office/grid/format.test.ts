/**
 * The owner's formatting layer: the pure deltas (`sheetfmt.ts`), the XML they
 * become (`xlsxstyle.ts`), and the round trip through the surgical save and the
 * rebuild — widths, heights and cell styles come back, and the file's own styles
 * are kept.
 */
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../../viewer/formats';
import { addRowEdit, deleteColumnEdit, type SheetsModel } from '../model';
import { patchPackage, snapshotModel } from '../patch';
import { writeXlsx } from '../ooxml';
import { entryData, readRawZip, utf8, writeZip } from '../zip';
import {
  borderPatch, formatRange, mergeCellFormat, overlayStyle, pxToChars, sameCellFormat, sheetFormatEdit,
  shiftSheetFormat, withColumnWidth, withRowHeight, type SheetFormat,
} from './sheetfmt';
import { addCellStyles, applySheetLook, cellStyleIds, mergeCols, MINIMAL_STYLES, setAttrs } from './xlsxstyle';
import { readBookLook } from './xlsxlook';
import { draggedHeight, MIN_ROW_HEIGHT, openingWidths, stepDecimals } from './helpers';

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function styledBook(): Uint8Array {
  return writeZip([
    { name: 'xl/workbook.xml', data: utf8(`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: utf8(`<styleSheet xmlns="${S}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><color theme="1"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyAlignment="1"><alignment horizontal="center"/><protection locked="0"/></xf></cellXfs></styleSheet>`) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(`<worksheet xmlns="${S}"><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="3" width="12" customWidth="1"/></cols><sheetData>` +
      '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Head</t></is></c><c r="B1" t="inlineStr"><is><t>عنوان</t></is></c></row>' +
      '<row r="2"><c r="A2"><v>5</v></c><c r="B2"><v>1234.5</v></c></row>' +
      '</sheetData></worksheet>') },
  ]);
}

const partText = async (bytes: Uint8Array, name: string): Promise<string> =>
  new TextDecoder().decode((await entryData(readRawZip(bytes), name)) ?? new Uint8Array());

describe('the formatting deltas', () => {
  it('merges named properties and border sides, and compares deeply', () => {
    const a = mergeCellFormat({ bold: true, borders: { top: true } }, { italic: true, borders: { left: true } });
    expect(a).toEqual({ bold: true, italic: true, borders: { top: true, left: true } });
    expect(sameCellFormat(a, { italic: true, borders: { left: true, top: true }, bold: true })).toBe(true);
    expect(sameCellFormat(a, { ...a, bold: false })).toBe(false);
  });

  it('formats a range, draws outer borders only on the edge cells', () => {
    const range = { r0: 0, c0: 0, r1: 1, c1: 1 };
    const fmt = formatRange(undefined, range, borderPatch('outer', range));
    expect(fmt?.cells?.['0:0']).toEqual({ borders: { top: true, left: true } });
    expect(fmt?.cells?.['1:1']).toEqual({ borders: { bottom: true, right: true } });
    const all = formatRange(undefined, range, borderPatch('all', range));
    expect(Object.keys(all?.cells ?? {})).toHaveLength(4);
  });

  it('keeps widths and heights, and clears back to nothing', () => {
    let fmt = withColumnWidth(undefined, 2, 140.4);
    fmt = withRowHeight(fmt, 0, 40);
    expect(fmt).toEqual({ cols: { 2: 140 }, rows: { 0: 40 } });
    expect(withRowHeight(withColumnWidth(fmt, 2, null), 0, null)).toBeUndefined();
  });

  it('moves with inserted and removed rows and columns', () => {
    const fmt: SheetFormat = { cols: { 1: 100, 3: 60 }, rows: { 2: 40 }, cells: { '2:1': { bold: true }, '0:3': { fill: 'FF0000' } } };
    expect(shiftSheetFormat(fmt, 'row', 1, 1)).toEqual({ cols: { 1: 100, 3: 60 }, rows: { 3: 40 }, cells: { '3:1': { bold: true }, '0:3': { fill: 'FF0000' } } });
    expect(shiftSheetFormat(fmt, 'col', 1, -1)).toEqual({ cols: { 2: 60 }, rows: { 2: 40 }, cells: { '0:2': { fill: 'FF0000' } } });
  });

  it('draws the file style with the delta on top', () => {
    const style = overlayStyle({ bold: true, fill: '1F4E79', size: 14 }, { bold: false, fill: null, borders: { bottom: true }, numFmt: '0.00' });
    expect(style).toEqual({ bold: false, size: 14, borders: { bottom: '1px solid #000000' }, numFmt: '0.00' });
  });

  it('is undoable as one step and moves with a row the owner adds', () => {
    let model: SheetsModel = { kind: 'xlsx', grids: [{ name: 'S', rows: [['a'], ['b']], truncated: false }], active: 0, delimiter: ',' };
    const after = formatRange(undefined, { r0: 1, c0: 0, r1: 1, c1: 0 }, { bold: true });
    const edit = sheetFormatEdit(0, undefined, after);
    model = edit.apply(model) as SheetsModel;
    expect(model.sheetFormats?.[0]?.cells?.['1:0']).toEqual({ bold: true });
    const moved = addRowEdit(0, 0).apply(model) as SheetsModel;
    expect(moved.sheetFormats?.[0]?.cells?.['2:0']).toEqual({ bold: true });
    const gone = deleteColumnEdit(0, 0, ['a', 'b']).apply(model) as SheetsModel;
    expect(gone.sheetFormats).toBeUndefined();
    expect((edit.revert(model) as SheetsModel).sheetFormats).toBeUndefined();
  });

  it('converts px to Excel units', () => {
    expect(pxToChars(64)).toBeCloseTo(8.43, 2);
    expect(pxToChars(5)).toBe(0);
  });
});

describe('the view’s width and number-format helpers', () => {
  it('fits columns with content on open, never below the default', () => {
    const w = openingWidths([['a', 'a very long heading text here'], ['محمد عبدالله الفيصل', '']], 3, (t) => t.length * 7);
    expect(w.get(0)).toBe(Math.max(88, 'محمد عبدالله الفيصل'.length * 7 + 10));
    expect(w.get(1)).toBe('a very long heading text here'.length * 7 + 10);
    expect(w.get(2)).toBe(88);
  });

  it('clamps a dragged row height', () => {
    expect(draggedHeight(24, 100, 130)).toBe(54);
    expect(draggedHeight(24, 100, 0)).toBe(MIN_ROW_HEIGHT);
  });

  it('steps decimals in every section and leaves quoted text alone', () => {
    expect(stepDecimals('0', 1)).toBe('0.0');
    expect(stepDecimals('#,##0.00', -1)).toBe('#,##0.0');
    expect(stepDecimals('0%', 1)).toBe('0.0%');
    expect(stepDecimals('"$"#,##0.00;("$"#,##0.00)', 1)).toBe('"$"#,##0.000;("$"#,##0.000)');
    expect(stepDecimals('#,##0.00 "ر.س"', -1)).toBe('#,##0.0 "ر.س"');
    expect(stepDecimals('0.00E+00', 1)).toBe('0.000E+00');
  });
});

describe('the styles writer', () => {
  it('sets and removes attributes without touching the rest', () => {
    expect(setAttrs('<xf a="1" fontId="0"/>', { fontId: '3', b: '2', a: null })).toBe('<xf fontId="3" b="2"/>');
    expect(setAttrs('<row r="1">', { ht: '30' })).toBe('<row r="1" ht="30">');
  });

  it('builds a new xf over the cell’s own style and keeps what it does not model', () => {
    const styles = `<styleSheet xmlns="${S}"><fonts count="2"><font><sz val="11"/></font><font><b/><sz val="14"/><color theme="1"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0"><alignment horizontal="center"/><protection locked="0"/></xf></cellXfs></styleSheet>`;
    const { xml, ids } = addCellStyles(styles, [
      { base: 1, format: { italic: true } },
      { base: 0, format: { numFmt: '0.0%', borders: { bottom: true }, wrap: true } },
      { base: 1, format: { italic: true } },
    ]);
    expect(ids).toEqual([2, 3, 2]);
    expect(xml).toContain('<cellXfs count="4">');
    expect(xml).toContain('<font><b/><i/><sz val="14"/><color theme="1"/><name val="Arial"/></font>');
    expect(xml).toMatch(/<xf numFmtId="0" fontId="2" fillId="2" borderId="0" applyFont="1"><alignment horizontal="center"\/><protection locked="0"\/><\/xf>/);
    expect(xml).toContain('<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>');
    expect(xml.indexOf('<numFmts')).toBeLessThan(xml.indexOf('<fonts'));
    expect(xml).toContain('<bottom style="thin"><color rgb="FF000000"/></bottom>');
    expect(xml).toContain('wrapText="1"');
  });

  it('reuses built-in number formats and grows a self-closing styles part', () => {
    const { xml, ids } = addCellStyles(`<styleSheet xmlns="${S}"/>`, [{ base: 0, format: { numFmt: '#,##0.00', fill: 'FFFF00' } }]);
    expect(ids).toEqual([1]);
    expect(xml).toContain('numFmtId="4"');
    expect(xml).not.toContain('<numFmts');
    expect(xml).toContain('<fgColor rgb="FFFFFF00"/>');
    expect(xml.indexOf('<fonts')).toBeLessThan(xml.indexOf('<cellXfs'));
  });

  it('splits a <cols> range when one column of it changes width', () => {
    const xml = `<worksheet xmlns="${S}"><cols><col min="1" max="3" width="12" customWidth="1" style="4"/></cols><sheetData/></worksheet>`;
    const cols = mergeCols(xml, new Map([[1, 145], [5, 40]]));
    expect(cols).toBe('<cols><col min="1" max="1" width="12" customWidth="1" style="4"/><col min="2" max="2" width="20" customWidth="1" style="4"/><col min="3" max="3" width="12" customWidth="1" style="4"/><col min="6" max="6" width="5" customWidth="1"/></cols>');
  });

  it('gives cells their style, rows their height, and creates what is missing', () => {
    const xml = `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="B1"><v>1</v></c></row><row r="3"/></sheetData></worksheet>`;
    const out = applySheetLook(xml, {
      cells: new Map([['0:0', 2], ['0:1', 3], ['2:2', 4], ['4:0', 5]]),
      rows: new Map([[0, 40], [1, 30]]),
      cols: new Map([[0, 100]]),
    });
    expect(out).toContain('<cols><col min="1" max="1" width="13.57" customWidth="1"/></cols><sheetData>');
    expect(out).toContain('<row r="1" ht="30" customHeight="1"><c r="A1" s="2"/><c r="B1" s="3"><v>1</v></c></row>');
    expect(out).toContain('<row r="2" ht="22.5" customHeight="1"></row>');
    expect(out).toContain('<row r="3"><c r="C3" s="4"/></row>');
    expect(out).toContain('<row r="5"><c r="A5" s="5"/></row>');
    expect(cellStyleIds(out).get('2:2')).toBe(4);
  });
});

describe('formatting through the save', () => {
  it('patches styles, widths and heights into the file and keeps its own styles', async () => {
    const bytes = styledBook();
    const model: SheetsModel = { kind: 'xlsx', grids: (await readXlsx(bytes)).map((s) => ({ ...s })), active: 0, delimiter: ',' };
    const baseline = snapshotModel(model);
    const range = { r0: 1, c0: 1, r1: 1, c1: 1 };
    let fmt = formatRange(undefined, { r0: 0, c0: 0, r1: 0, c1: 0 }, { italic: true });
    fmt = formatRange(fmt, range, { bold: true, fill: 'FFC000', numFmt: '#,##0.00', hAlign: 'right' });
    fmt = formatRange(fmt, range, borderPatch('outer', range));
    fmt = withColumnWidth(fmt, 1, 160);
    fmt = withRowHeight(fmt, 3, 40);
    const current: SheetsModel = { ...model, sheetFormats: { 0: fmt as SheetFormat } };
    const result = await patchPackage('xlsx', bytes, baseline, current);
    expect(result).not.toBeNull();
    expect(result?.changed.sort()).toEqual(['xl/styles.xml', 'xl/worksheets/sheet1.xml']);
    const look = await readBookLook(result?.bytes as Uint8Array);
    const sheet = look.sheets[0];
    const a1 = look.styles[sheet.xf.get('0:0') as number];
    expect(a1).toMatchObject({ bold: true, italic: true, size: 14, font: 'Arial', fill: '1F4E79', hAlign: 'center' });
    const b2 = look.styles[sheet.xf.get('1:1') as number];
    expect(b2).toMatchObject({ bold: true, fill: 'FFC000', numFmt: '#,##0.00', hAlign: 'right' });
    expect(b2.borders?.top).toContain('solid');
    expect(sheet.widths.get(1)).toBe(160);
    expect(sheet.widths.get(0)).toBe(89); // the file's own 12-character width, kept for column A
    expect(sheet.heights.get(3)).toBe(40);
    // The values are untouched.
    expect((await readXlsx(result?.bytes as Uint8Array))[0].rows.slice(0, 2)).toEqual([['Head', 'عنوان'], ['5', '1234.5']]);
  });

  it('adds a styles part to a package that had none, and a save with nothing new changes nothing', async () => {
    const plain = writeZip([
      { name: '[Content_Types].xml', data: utf8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>') },
      { name: 'xl/workbook.xml', data: utf8(`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`) },
      { name: 'xl/worksheets/sheet1.xml', data: utf8(`<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`) },
    ]);
    const model: SheetsModel = { kind: 'xlsx', grids: [{ name: 'A', rows: [['1']], truncated: false }], active: 0, delimiter: ',' };
    const current: SheetsModel = { ...model, sheetFormats: { 0: { cells: { '0:0': { bold: true } } } } };
    const result = await patchPackage('xlsx', plain, snapshotModel(model), current);
    expect(result?.changed).toContain('xl/styles.xml');
    expect(await partText(result?.bytes as Uint8Array, '[Content_Types].xml')).toContain('/xl/styles.xml');
    expect(await partText(result?.bytes as Uint8Array, 'xl/_rels/workbook.xml.rels')).toContain('styles.xml');
    const look = await readBookLook(result?.bytes as Uint8Array);
    expect(look.styles[look.sheets[0].xf.get('0:0') as number]?.bold).toBe(true);
    const again = await patchPackage('xlsx', result?.bytes as Uint8Array, snapshotModel(current), current);
    expect(again?.changed).toEqual([]);
  });

  it('writes an undone format back as off after an earlier save', async () => {
    const bytes = styledBook();
    const model: SheetsModel = { kind: 'xlsx', grids: (await readXlsx(bytes)).map((s) => ({ ...s })), active: 0, delimiter: ',' };
    const saved: SheetsModel = { ...model, sheetFormats: { 0: { cells: { '1:0': { bold: true } } } } };
    const first = await patchPackage('xlsx', bytes, snapshotModel(model), saved);
    const undone = await patchPackage('xlsx', first?.bytes as Uint8Array, snapshotModel(saved), model);
    const look = await readBookLook(undone?.bytes as Uint8Array);
    expect(look.styles[look.sheets[0].xf.get('1:0') as number]?.bold).toBe(false);
  });

  it('keeps formatting through the rebuild writer', async () => {
    const bytes = writeXlsx([{ name: 'S', rows: [['a', '1']], truncated: false }], undefined, {
      0: { cols: { 0: 120 }, rows: { 0: 32 }, cells: { '0:1': { bold: true, numFmt: '0.00' }, '2:2': { fill: '00B050' } } },
    });
    const look = await readBookLook(bytes);
    expect(look.sheets[0].widths.get(0)).toBe(120);
    expect(look.sheets[0].heights.get(0)).toBe(32);
    expect(look.styles[look.sheets[0].xf.get('0:1') as number]).toMatchObject({ bold: true, numFmt: '0.00' });
    expect(look.styles[look.sheets[0].xf.get('2:2') as number]?.fill).toBe('00B050');
    expect(MINIMAL_STYLES).toContain('<cellXfs count="1">');
  });
});
