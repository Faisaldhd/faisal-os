/** Rows/columns inserted or deleted inside the file: addresses, formulas, merges, widths — and the save keeps styles. */
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../../viewer/formats';
import { addColumnEdit, addRowEdit, deleteRowEdit, type SheetsModel } from '../model';
import { patchPackage, snapshotModel } from '../patch';
import { utf8, writeZip } from '../zip';
import { shiftFormulasIn, shiftSheetPart, workbookBlocks } from './structure';
import { readBookLook } from './xlsxlook';

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

describe('moving a worksheet part', () => {
  const xml = `<worksheet xmlns="${S}"><dimension ref="A1:C3"/><cols><col min="2" max="3" width="20" customWidth="1"/></cols><sheetData>` +
    '<row r="1" spans="1:3"><c r="A1"><v>1</v></c><c r="B1" s="2"><v>2</v></c></row>' +
    '<row r="2"><c r="A2"><v>3</v></c><c r="C2"><f>SUM(A1:A2)</f><v>4</v></c></row>' +
    '<row r="3"><c r="A3"><f>A1*2</f><v>2</v></c></row>' +
    '</sheetData><mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells></worksheet>';

  it('inserts a row: rows below move, formulas follow, merges move', () => {
    const out = shiftSheetPart(xml, 'S', { sheet: 0, axis: 'row', at: 1, delta: 1 }) as string;
    expect(out).toContain('<row r="1"><c r="A1"><v>1</v></c><c r="B1" s="2"><v>2</v></c></row>');
    expect(out).toContain('<row r="3"><c r="A3"><v>3</v></c><c r="C3"><f>SUM(A1:A3)</f>');
    expect(out).toContain('<row r="4"><c r="A4"><f>A1*2</f>');
    expect(out).toContain('<mergeCell ref="A4:B4"/>');
    expect(out).not.toContain('<dimension');
  });

  it('deletes a column: its cells go, references to it become #REF!, widths shrink', () => {
    const out = shiftSheetPart(xml, 'S', { sheet: 0, axis: 'col', at: 0, delta: -1 });
    expect(out).toBeNull(); // the merge A3:B3 would be cut: rebuild instead
    const plain = xml.replace(/<mergeCells.*<\/mergeCells>/, '');
    const cut = shiftSheetPart(plain, 'S', { sheet: 0, axis: 'col', at: 0, delta: -1 }) as string;
    expect(cut).toContain('<row r="1"><c r="A1" s="2"><v>2</v></c></row>');
    expect(cut).toContain('<c r="B2"><f>SUM(#REF!)</f>');
    expect(cut).toContain('<col min="1" max="2" width="20" customWidth="1"/>');
  });

  it('shifts references to the sheet from another sheet, and refuses shared formulas and defined names', () => {
    const other = `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><f>S!A5+1</f></c><c r="B1"><f>A5</f></c></row></sheetData></worksheet>`;
    expect(shiftFormulasIn(other, 'T', 'S', { sheet: 0, axis: 'row', at: 0, delta: 1 })).toContain('<f>S!A6+1</f></c><c r="B1"><f>A5</f>');
    expect(shiftFormulasIn('<x><f t="shared" si="0">A1</f></x>', 'T', 'S', { sheet: 0, axis: 'row', at: 0, delta: 1 })).toBeNull();
    expect(workbookBlocks(`<workbook><definedNames><definedName name="x">S!A1</definedName></definedNames></workbook>`)).toBe(true);
    expect(workbookBlocks('<workbook><sheets/></workbook>')).toBe(false);
  });
});

describe('the save after rows and columns move', () => {
  function book(): Uint8Array {
    return writeZip([
      { name: 'xl/workbook.xml', data: utf8(`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/></Relationships>`) },
      { name: 'xl/styles.xml', data: utf8(`<styleSheet xmlns="${S}"><fonts count="2"><font><sz val="11"/></font><font><b/><sz val="11"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`) },
      { name: 'xl/worksheets/sheet1.xml', data: utf8(`<worksheet xmlns="${S}"><sheetData>` +
        '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Head</t></is></c></row>' +
        '<row r="2"><c r="A2"><v>5</v></c><c r="B2"><f>A2*2</f><v>10</v></c></row>' +
        '</sheetData></worksheet>') },
    ]);
  }

  it('writes the moved cells into the file and keeps their styles', async () => {
    const bytes = book();
    const model: SheetsModel = { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'S', truncated: false, rows: [['Head'], ['5', '10']] }], formulas: { '0:1:1': '=A2*2' } };
    let current = addRowEdit(0, 0).apply(model) as SheetsModel;
    current = addColumnEdit(0, 0).apply(current) as SheetsModel;
    expect(current.structure).toHaveLength(2);
    expect(current.formulas?.['0:2:2']).toBe('=B3*2');
    const result = await patchPackage('xlsx', bytes, snapshotModel(model), current);
    expect(result).not.toBeNull();
    const read = await readXlsx(result?.bytes as Uint8Array);
    expect(read[0].rows).toEqual([[], ['', 'Head'], ['', '5', '10']]);
    const look = await readBookLook(result?.bytes as Uint8Array);
    expect(look.styles[look.sheets[0].xf.get('1:1') as number]?.bold).toBe(true);
    expect(look.sheets[0].formulas.get('2:2')).toBe('=B3*2');
  });

  it('undoes a delete exactly, formulas included', () => {
    const model: SheetsModel = { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'S', truncated: false, rows: [['1'], ['2'], ['3']] }], formulas: { '0:2:0': '=A1+A2' } };
    const edit = deleteRowEdit(0, 0, ['1']);
    const after = edit.apply(model) as SheetsModel;
    expect(after.formulas?.['0:1:0']).toBe('=#REF!+A1');
    const back = edit.revert(after) as SheetsModel;
    expect(back.grids[0].rows).toEqual(model.grids[0].rows);
    expect(back.formulas).toEqual(model.formulas);
    expect(back.structure).toBeUndefined();
    expect(back.moved).toBeUndefined();
  });
});
