/**
 * The pure pieces behind the sheet's WPS ribbon: the function library, find/replace, remove
 * duplicates, cell styles and the format painter, merged cells, and what the save writes for a
 * font, a size and a merge.
 */
import { describe, expect, it } from 'vitest';
import { getFunction, evaluateInModel } from '../formula/index';
import type { SheetsModel } from '../model';
import { CELL_STYLES, cellStyleFormat, formatFromStyle } from './cellstyles';
import { cellMatches, findAll, findNext, removeDuplicates, replaceInCell } from './find';
import {
  categoryOf, FUNCTION_CATEGORIES, functionEntry, functionsIn, hyperlinkFormula, hyperlinkOf, safeLink, searchFunctions,
} from './functions';
import { mergeAtCell, mergesOf, shiftSheetFormat, withMerge, withMerges, withoutMerges } from './sheetfmt';
import { addCellStyles, applySheetLook, mergeCellsXml } from './xlsxstyle';

describe('the function library', () => {
  it('offers only functions the engine has, in every category', () => {
    for (const cat of FUNCTION_CATEGORIES) {
      const names = functionsIn(cat.id);
      expect(names.length, cat.id).toBeGreaterThan(0);
      for (const n of names) expect(getFunction(n), n).toBeDefined();
    }
    expect(functionsIn('math', ['SUM', 'NOPE'])).toEqual(['SUM']);
    expect(functionsIn('all')).toContain('VLOOKUP');
  });
  it('searches by name first, then by what the function does', () => {
    const names = ['SUM', 'SUMIF', 'DSUM', 'COUNT'];
    expect(searchFunctions('sum', names)).toEqual(['SUM', 'SUMIF', 'DSUM']);
    expect(searchFunctions('عدد', names, (n) => (n === 'COUNT' ? 'عدد الخلايا' : ''))).toEqual(['COUNT']);
    expect(searchFunctions('', names)).toEqual(names);
    expect(categoryOf('vlookup')).toBe('lookup');
  });
  it('puts =NAME( in the cell, or continues the formula being typed', () => {
    expect(functionEntry('SUM')).toBe('=SUM(');
    expect(functionEntry('ROUND', '=1+')).toBe('=1+ROUND(');
    expect(functionEntry('MAX', '=A1')).toBe('=A1+MAX(');
    expect(functionEntry('MIN', 'text')).toBe('=MIN(');
  });
});

describe('links', () => {
  it('opens only http(s) and mailto, never script', () => {
    expect(safeLink('https://example.com')).toBe('https://example.com');
    expect(safeLink('www.example.com')).toBe('https://www.example.com');
    expect(safeLink('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('data:text/html,x')).toBeNull();
  });
  it('is a HYPERLINK formula the cell shows by its name', () => {
    const f = hyperlinkFormula('https://a.b/?q="x"', 'موقع');
    expect(f).toBe('=HYPERLINK("https://a.b/?q=""x""","موقع")');
    expect(hyperlinkOf(f)).toBe('https://a.b/?q="x"');
    expect(hyperlinkOf('=HYPERLINK("javascript:x")')).toBeNull();
    const model: SheetsModel = { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'S', rows: [['']], truncated: false }] };
    const out = evaluateInModel(f, model, 0, { row: 0, col: 0 });
    expect(out.ok && out.value).toBe('موقع');
  });
});

describe('find and replace', () => {
  const rows = [['Apple', 'pear'], ['apple pie', 'Pear'], ['x', 'APPLE']];
  it('finds in reading order, case-blind unless asked', () => {
    expect(findAll(rows, 'apple')).toEqual([{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 1 }]);
    expect(findAll(rows, 'apple', { matchCase: true })).toEqual([{ row: 1, col: 0 }]);
    expect(findAll(rows, 'apple', { wholeCell: true })).toEqual([{ row: 0, col: 0 }, { row: 2, col: 1 }]);
    expect(cellMatches('a.b', '.')).toBe(true);
    expect(cellMatches('ab', '.')).toBe(false);          // the query is text, not a pattern
  });
  it('goes on from the active cell and wraps around', () => {
    expect(findNext(rows, 'pear', { row: 0, col: 1 })).toEqual({ row: 1, col: 1 });
    expect(findNext(rows, 'pear', { row: 1, col: 1 })).toEqual({ row: 0, col: 1 });
    expect(findNext(rows, 'pear', { row: 1, col: 1 }, {}, true)).toEqual({ row: 0, col: 1 });
    expect(findNext(rows, 'zzz', { row: 0, col: 0 })).toBeNull();
  });
  it('replaces every occurrence in a cell', () => {
    expect(replaceInCell('apple Apple', 'apple', 'تفاح')).toBe('تفاح تفاح');
    expect(replaceInCell('apple Apple', 'apple', 'x', { matchCase: true })).toBe('x Apple');
    expect(replaceInCell('$1', '$', '€')).toBe('€1');
  });
});

describe('remove duplicates', () => {
  const rows = [['Name', 'City'], ['Ali', 'Riyadh'], ['ali ', 'Riyadh'], ['Sara', 'Jeddah'], ['Ali', 'Jeddah'], ['keep', 'me']];
  it('keeps the first of each, moves the rest up and empties the freed rows', () => {
    const out = removeDuplicates(rows, { r0: 0, r1: 4, c0: 0, c1: 1 }, [0], true);
    expect(out.removed).toBe(2);
    expect(out.rows.slice(0, 5)).toEqual([['Name', 'City'], ['Ali', 'Riyadh'], ['Sara', 'Jeddah'], ['', ''], ['', '']]);
    expect(out.rows[5]).toEqual(['keep', 'me']);          // outside the block: untouched
  });
  it('compares only the columns asked for', () => {
    expect(removeDuplicates(rows, { r0: 0, r1: 4, c0: 0, c1: 1 }, [0, 1], true).removed).toBe(1);
  });
  it('without a header the top row takes part', () => {
    expect(removeDuplicates([['a'], ['a']], { r0: 0, r1: 1, c0: 0, c1: 0 }, [0], false).removed).toBe(1);
  });
});

describe('cell styles and the format painter', () => {
  it('every named style is a format delta, Normal takes the look away', () => {
    expect(CELL_STYLES.length).toBeGreaterThanOrEqual(8);
    expect(cellStyleFormat('good')).toEqual({ fill: 'C6EFCE', color: '006100' });
    expect(cellStyleFormat('normal')).toMatchObject({ bold: false, fill: null, color: null });
  });
  it('the painter copies the whole look, "off" included', () => {
    const f = formatFromStyle({ bold: true, fill: 'FFFF00', hAlign: 'center', font: 'Arial', size: 14, borders: { top: 'thin' } });
    expect(f).toMatchObject({ bold: true, italic: false, fill: 'FFFF00', color: null, hAlign: 'center', font: 'Arial', size: 14 });
    expect(f.borders).toEqual({ top: true, bottom: false, left: false, right: false });
    expect(formatFromStyle(undefined)).toMatchObject({ bold: false, fill: null, numFmt: null });
  });
});

describe('merged cells', () => {
  it('a merge replaces any it overlaps; unmerge takes away what it touches', () => {
    const list = withMerge([{ r0: 0, c0: 0, r1: 0, c1: 1 }], { r0: 0, c0: 1, r1: 1, c1: 2 });
    expect(list).toEqual([{ r0: 0, c0: 1, r1: 1, c1: 2 }]);
    expect(withMerge(list, { r0: 5, c0: 5, r1: 5, c1: 5 })).toEqual(list);      // one cell merges nothing
    expect(withoutMerges(list, { r0: 1, c0: 2, r1: 1, c1: 2 })).toEqual([]);
    expect(mergeAtCell(list, 1, 1)).toEqual(list[0]);
    expect(mergeAtCell(list, 3, 3)).toBeUndefined();
  });
  it('the file’s merges stand until the owner changes them', () => {
    const file = [{ r0: 2, c0: 0, r1: 2, c1: 3 }];
    expect(mergesOf(undefined, file)).toEqual(file);
    expect(mergesOf(withMerges(undefined, []), file)).toEqual([]);
  });
  it('moves with inserted and deleted rows and columns', () => {
    const fmt = withMerges(undefined, [{ r0: 2, c0: 0, r1: 3, c1: 1 }]);
    expect(shiftSheetFormat(fmt, 'row', 0, 1)?.merges).toEqual([{ r0: 3, c0: 0, r1: 4, c1: 1 }]);
    expect(shiftSheetFormat(fmt, 'row', 3, 1)?.merges).toEqual([{ r0: 2, c0: 0, r1: 4, c1: 1 }]);
    expect(shiftSheetFormat(fmt, 'row', 3, -1)?.merges).toEqual([{ r0: 2, c0: 0, r1: 2, c1: 1 }]);
    expect(shiftSheetFormat(fmt, 'col', 0, -1)?.merges).toEqual([{ r0: 2, c0: 0, r1: 3, c1: 0 }]);
  });
  it('is written as <mergeCells> in the schema’s place, and replaced on the next save', () => {
    expect(mergeCellsXml([{ r0: 0, c0: 0, r1: 1, c1: 2 }])).toBe('<mergeCells count="1"><mergeCell ref="A1:C2"/></mergeCells>');
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><pageMargins left="1"/></worksheet>';
    const once = applySheetLook(sheet, { merges: [{ r0: 0, c0: 0, r1: 0, c1: 1 }] });
    expect(once).toContain('</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><pageMargins');
    const twice = applySheetLook(once, { merges: [{ r0: 1, c0: 1, r1: 2, c1: 1 }] });
    expect(twice).toContain('<mergeCell ref="B2:B3"/>');
    expect(twice).not.toContain('A1:B1');
    expect(applySheetLook(twice, { merges: [] })).not.toContain('mergeCell');
    expect(applySheetLook(sheet, {})).toBe(sheet);
  });
});

describe('a chosen font and size reach styles.xml', () => {
  it('writes the size, the family and a strike through into a new font', () => {
    const { xml, ids } = addCellStyles(null, [{ base: 0, format: { font: 'Arial', size: 14, strike: true } }]);
    expect(ids[0]).toBeGreaterThan(0);
    expect(xml).toMatch(/<font><strike\/><sz val="14"\/><name val="Arial"\/><\/font>/);
  });
  it('a null family or size changes nothing', () => {
    const { xml } = addCellStyles(null, [{ base: 0, format: { font: null, size: null, bold: true } }]);
    expect(xml).toMatch(/<font><b\/><sz val="11"\/><name val="Calibri"\/>/);
  });
});
