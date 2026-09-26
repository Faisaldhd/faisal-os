import { describe, expect, it } from 'vitest';
import { readBookLook } from './xlsxlook';
import { entryData, readRawZip } from '../zip';
import { writeXlsx } from '../ooxml';
import type { Editor, EditorContext } from '../editor';
import type { OfficeModel, SheetsModel } from '../model';
import '../strings';
import { createSheet } from './view';
import { autoFilterRef, autoFilterXml, parseAutoFilter, withAutoFilter } from './autofilter';

/**
 * The AutoFilter as the file spells it. The element has to land right after `</sheetData>` (Excel
 * rejects the part otherwise), the values are escaped, and reading it back has to give exactly
 * what a spreadsheet wrote — including a blank entry and a value with Arabic and quotes in it.
 */
const SHEET = '<?xml version="1.0"?><worksheet xmlns="S"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row></sheetData><mergeCells count="0"/></worksheet>';

describe('the autoFilter element', () => {
  it('builds a checklist filter per column, escaping the values', () => {
    const xml = autoFilterXml([{ col: 1, keys: ['شهري', 'A&B'] }, { col: 3, keys: [''] }], 'A1:D40');
    expect(xml).toBe('<autoFilter ref="A1:D40"><filterColumn colId="1"><filters><filter val="شهري"/><filter val="A&amp;B"/></filters></filterColumn><filterColumn colId="3"><filters blank="1"/></filterColumn></autoFilter>');
  });

  it('writes nothing when there is nothing to filter on', () => {
    expect(autoFilterXml([], 'A1:B2')).toBeNull();
    expect(autoFilterXml([{ col: 0, keys: [] }], 'A1:B2')).toBeNull();
    expect(autoFilterXml([{ col: -1, keys: ['x'] }], 'A1:B2')).toBeNull();
  });

  it('names the range from the sheet it covers', () => {
    expect(autoFilterRef(40, 4)).toBe('A1:D40');
    expect(autoFilterRef(40, 4, 1)).toBe('A1:D40');
    expect(autoFilterRef(1, 1)).toBe('A1:A1');
    expect(autoFilterRef(0, 4)).toBeNull();
  });
});

describe('putting it in the worksheet', () => {
  it('inserts it right after </sheetData>, where the schema wants it', () => {
    const out = withAutoFilter(SHEET, '<autoFilter ref="A1:B2"><filterColumn colId="0"><filters><filter val="x"/></filters></filterColumn></autoFilter>');
    expect(out.indexOf('</sheetData>')).toBeLessThan(out.indexOf('<autoFilter'));
    expect(out.indexOf('<autoFilter')).toBeLessThan(out.indexOf('<mergeCells'));
  });

  it('replaces an element that is already there instead of writing a second one', () => {
    const first = withAutoFilter(SHEET, '<autoFilter ref="A1:B2"><filterColumn colId="0"><filters><filter val="x"/></filters></filterColumn></autoFilter>');
    const second = withAutoFilter(first, '<autoFilter ref="A1:C9"><filterColumn colId="2"><filters><filter val="y"/></filters></filterColumn></autoFilter>');
    expect(second.match(/<autoFilter/g)).toHaveLength(1);
    expect(second).toContain('colId="2"');
    expect(second).not.toContain('colId="0"');
  });

  it('takes it away when the filter is cleared, leaving the rest of the part alone', () => {
    const withOne = withAutoFilter(SHEET, '<autoFilter ref="A1:B2"><filterColumn colId="0"><filters><filter val="x"/></filters></filterColumn></autoFilter>');
    const cleared = withAutoFilter(withOne, null);
    expect(cleared).not.toContain('<autoFilter');
    expect(cleared).toContain('<mergeCells count="0"/>');
    expect(withAutoFilter(`<worksheet><sheetData/></worksheet>`, '<autoFilter ref="A1:A1"/>')).toContain('<autoFilter ref="A1:A1"/>');
    // A part with no sheetData cannot take one: better to leave it exactly as it was.
    expect(withAutoFilter('<worksheet/>', '<autoFilter ref="A1:A1"/>')).toBe('<worksheet/>');
  });
});

describe('round trip: written into the file, read back at open', () => {
  it('puts the element in the worksheet and the reader hands the columns back', async () => {
    const grid = { name: 'S', rows: [['Cat', 'Qty'], ['ألف', '2'], ['باء', '3']], truncated: false };
    const saved = writeXlsx([grid], undefined, undefined, { 0: [{ col: 1, keys: ['2'] }] });
    const sheetXml = new TextDecoder().decode((await entryData(readRawZip(saved), 'xl/worksheets/sheet1.xml')) ?? new Uint8Array());
    expect(sheetXml).toContain('<autoFilter ref="A1:B3">');
    expect(sheetXml.indexOf('</sheetData>')).toBeLessThan(sheetXml.indexOf('<autoFilter'));
    expect(sheetXml).toContain('<filterColumn colId="1"><filters><filter val="2"/></filters></filterColumn>');

    const look = await readBookLook(saved);
    expect(look.sheets[0].filters?.get(1)).toEqual(['2']);
  });

  it('opens the sheet with the file\'s own filter applied, so a saved sheet hides its rows', async () => {
    const grid = { name: 'S', rows: [['Cat', 'Qty'], ['ألف', '2'], ['باء', '3'], ['جيم', '2']], truncated: false };
    const look = await readBookLook(writeXlsx([grid], undefined, undefined, { 0: [{ col: 1, keys: ['2'] }] }));
    let model: OfficeModel = { kind: 'xlsx', active: 0, delimiter: ',', grids: [grid], truncated: false } as SheetsModel;
    const ctx: EditorContext = {
      model: () => model,
      commit: (edit) => { model = edit.apply(model); },
      undo: () => {}, redo: () => {},
      editable: () => true, refresh: () => {}, setStatus: () => {}, host: () => document.body,
      filePath: () => '/home/user/budget_2026.xlsx',
      fileTab: () => ({ id: 'file', label: 'File', groups: [] }),
      exportFile: async () => {}, print: () => {},
    };
    document.body.replaceChildren();
    const editor: Editor = createSheet(ctx, look);
    document.body.append(editor.element);
    editor.render();
    const wrap = editor.element.querySelector<HTMLElement>('.fo-gridwrap') as HTMLElement;
    Object.defineProperty(wrap, 'clientHeight', { value: 480, configurable: true });
    Object.defineProperty(wrap, 'clientWidth', { value: 900, configurable: true });
    editor.render();
    // Drawn: the header plus the two rows whose Qty is 2 — the row '3' is hidden by the file's own filter.
    const drawn = [...wrap.querySelectorAll<HTMLElement>('.fo-td[data-drawn][data-c="1"]')]
      .filter((td) => td.dataset.r !== '')
      .map((td) => td.querySelector('.fo-cellview')?.textContent ?? '');
    expect(drawn.slice(0, 3)).toEqual(['Qty', '2', '2']);   // the header and the two rows the file keeps
    expect(drawn).not.toContain('3');                       // the row the file's own filter hides is not drawn
  });
});

describe('reading it back', () => {
  it('gives the columns and their values, blank entry included', () => {
    const xml = withAutoFilter(SHEET, autoFilterXml([{ col: 1, keys: ['شهري', 'A&B'] }, { col: 3, keys: [''] }], 'A1:D40') as string);
    expect(parseAutoFilter(xml)).toEqual([{ col: 1, keys: ['شهري', 'A&B'] }, { col: 3, keys: [''] }]);
  });

  it('answers an empty list for a sheet with no filter, and for a self-closing one', () => {
    expect(parseAutoFilter(SHEET)).toEqual([]);
    expect(parseAutoFilter('<worksheet><sheetData/><autoFilter ref="A1:B2"/></worksheet>')).toEqual([]);
  });

  it('round-trips exactly what it wrote', () => {
    const columns = [{ col: 0, keys: ['ع', 'ق'] }, { col: 5, keys: ['', 'x'] }];
    const xml = withAutoFilter(SHEET, autoFilterXml(columns, 'A1:F10') as string);
    expect(parseAutoFilter(xml)).toEqual([{ col: 0, keys: ['ع', 'ق'] }, { col: 5, keys: ['', 'x'] }]);
  });
});
