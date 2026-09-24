/**
 * The sheet's pure helpers (clipboard TSV, number display), the stored-formula
 * reader, and the save rule for a sheet that only grew past its end.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readXlsx } from '../../viewer/formats';
import { addRowEdit, formulaCellEdit, type SheetsModel } from '../model';
import { patchPackage, snapshotModel } from '../patch';
import { utf8, writeZip } from '../zip';
import { compositeEdit, displayValue, parseTsv, toTsv } from './view';
import { readBookLook, shiftFormula } from './xlsxlook';

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function book(): Uint8Array {
  return writeZip([
    { name: 'xl/workbook.xml', data: utf8(`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: utf8(`<styleSheet xmlns="${S}"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts><font><sz val="11"/></font><font><b/><sz val="14"/><color rgb="FFFFFFFF"/></font></fonts><fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/></patternFill></fill></fills><borders><border/></borders><cellXfs><xf fontId="0" fillId="0"/><xf fontId="1" fillId="2" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="164" fontId="0" fillId="0"/></cellXfs></styleSheet>`) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(`<worksheet xmlns="${S}"><sheetViews><sheetView><pane ySplit="1" state="frozen"/></sheetView></sheetViews><cols><col min="2" max="2" width="20" customWidth="1"/></cols><sheetData>` +
      '<row r="1" ht="30"><c r="A1" s="1" t="inlineStr"><is><t>Head</t></is></c></row>' +
      '<row r="2"><c r="A2"><v>5</v></c><c r="B2" s="2"><v>1234.5</v></c><c r="C2"><f t="shared" ref="C2:C3" si="0">A2*2</f><v></v></c></row>' +
      '<row r="3"><c r="A3"><v>7</v></c><c r="C3"><f t="shared" si="0"/><v></v></c></row>' +
      '</sheetData><mergeCells><mergeCell ref="A1:C1"/></mergeCells></worksheet>') },
  ]);
}

describe('the sheet helpers', () => {
  it('round-trips TSV the way spreadsheets put it on the clipboard', () => {
    const rows = [['a', 'b\tc'], ['line\nbreak', 'q"uote']];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
    expect(parseTsv('1\t2\r\n3\t4\r\n')).toEqual([['1', '2'], ['3', '4']]);
  });

  it('shows numbers in their format and leaves text alone', () => {
    expect(displayValue('1234.5', '#,##0.00')).toBe('1,234.50');
    expect(displayValue('0.25', '0%')).toBe('25%');
    expect(displayValue('hello', '0.00')).toBe('hello');
    expect(displayValue('3', undefined)).toBe('3');
  });

  it('moves the relative references of a shared formula', () => {
    expect(shiftFormula('A2*2+$B$1', 1, 0)).toBe('A3*2+$B$1');
    expect(shiftFormula('SUM(A1:B2)', 0, 1)).toBe('SUM(B1:C2)');
  });

  it('undoes a composite edit in reverse order', () => {
    const base: SheetsModel = { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'A', truncated: false, rows: [['1']] }] };
    const edit = compositeEdit([formulaCellEdit(0, 0, 0, { value: '1' }, { value: '2' }), formulaCellEdit(0, 0, 1, { value: '' }, { value: 'x' })]);
    const after = edit.apply(base);
    expect(after.kind === 'xlsx' && after.grids[0].rows).toEqual([['2', 'x']]);
    const back = edit.revert(after);
    expect(back.kind === 'xlsx' && back.grids[0].rows).toEqual([['1', '']]);
  });
});

describe('the sheet look', () => {
  it('reads widths, heights, frozen rows, merges, styles and stored formulas', async () => {
    const look = await readBookLook(book());
    const sheet = look.sheets[0];
    expect(sheet.widths.get(1)).toBe(145);
    expect(sheet.heights.get(0)).toBe(40);
    expect(sheet.frozenRows).toBe(1);
    expect(sheet.merges).toEqual([{ r0: 0, c0: 0, r1: 0, c1: 2 }]);
    expect(look.styles[1]).toMatchObject({ bold: true, size: 14, color: 'FFFFFF', fill: '1F4E79', hAlign: 'center' });
    expect(look.styles[2].numFmt).toBe('#,##0.00');
    expect(sheet.formulas.get('1:2')).toBe('=A2*2');
    expect(sheet.formulas.get('2:2')).toBe('=A3*2');
  });
});

describe('saving a sheet that grew', () => {
  let base: SheetsModel = { kind: 'xlsx', active: 0, delimiter: ',', grids: [] };
  beforeAll(async () => { base = { kind: 'xlsx', active: 0, delimiter: ',', grids: (await readXlsx(book())).map((g) => ({ ...g })) }; });

  it('patches a value typed below the data instead of rebuilding', async () => {
    const grown = formulaCellEdit(0, 4, 0, { value: '' }, { value: 'new' }).apply(base) as SheetsModel;
    const patched = await patchPackage('xlsx', book(), snapshotModel(base), snapshotModel(grown));
    expect(patched).not.toBeNull();
    const back = await readXlsx(patched?.bytes ?? new Uint8Array());
    expect(back[0].rows[4]).toEqual(['new']);
    expect(back[0].rows[1]).toEqual(base.grids[0].rows[1]);
  });

  it('still rebuilds when a row was inserted (cells moved)', async () => {
    const moved = addRowEdit(0, 1).apply(base) as SheetsModel;
    expect(moved.moved).toBe(1);
    expect(addRowEdit(0, 1).revert(moved)).toEqual(base);
    expect(await patchPackage('xlsx', book(), snapshotModel(base), snapshotModel(moved))).toBeNull();
  });
});
