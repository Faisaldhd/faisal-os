/**
 * The number format the owner picks is SAVED (صيغ الأرقام تُحفظ في الملف).
 *
 * The picker used to write only the view's own map, so the screen showed the format and the file
 * kept `General` — the panel said so itself ("view-level only"). Now it goes into the model
 * (`sheetFormats.cells[…].numFmt`), which is what the surgical save and the rebuild write into
 * `styles.xml` as a `<numFmt numFmtId="164+" formatCode="…"/>` plus the cell's `s=`, and what the
 * reader hands back at open.
 *
 * The first half drives the real sheet view (the Data tab's picker control); the second half takes
 * exactly what the model ended up with and proves the round trip through the file.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readXlsx } from '../../viewer/formats';
import '../strings';
import type { Editor, EditorContext } from '../editor';
import type { OfficeModel, SheetsModel } from '../model';
import { writeXlsx } from '../ooxml';
import { entryData, readRawZip, utf8, writeZip } from '../zip';
import { createSheet } from './view';
import { shownAt } from './cells.testkit';
import { formatChoices } from './sheetview';
import { readBookLook } from './xlsxlook';

function sheet(): SheetsModel {
  const rows = [['Cat', 'Qty'], ['ألف', '2'], ['باء', '3']];
  return { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'S', rows, truncated: false }] };
}

function harness(model: SheetsModel) {
  let current: OfficeModel = model;
  const ctx: EditorContext = {
    model: () => current,
    commit: (edit) => { current = edit.apply(current); },
    undo: () => {}, redo: () => {},
    editable: () => true, refresh: () => {}, setStatus: () => {}, host: () => document.body,
    filePath: () => '/home/user/budget_2026.xlsx',
    fileTab: () => ({ id: 'file', label: 'File', groups: [] }),
    exportFile: async () => {}, print: () => {},
  };
  const editor: Editor = createSheet(ctx, null);
  document.body.append(editor.element);
  editor.render();
  const wrap = editor.element.querySelector<HTMLElement>('.fo-gridwrap') as HTMLElement;
  Object.defineProperty(wrap, 'clientHeight', { value: 480, configurable: true });
  Object.defineProperty(wrap, 'clientWidth', { value: 900, configurable: true });
  editor.render();
  return { editor, wrap, model: () => current as SheetsModel };
}

const ribbonControl = (editor: Editor, tabId: string, controlId: string) => {
  const tab = editor.tabs().find((tb) => tb.id === tabId);
  const control = tab?.groups.flatMap((g) => g.controls).find((c) => c.id === controlId);
  if (!control) throw new Error(`no control ${tabId}/${controlId}`);
  return control as unknown as { onChange: (value: string) => void };
};

const selectCell = (editor: Editor, ref: string): void => {
  const box = editor.element.querySelector<HTMLInputElement>('.fo-namebox')!;
  box.value = ref;
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
};

const shown = (wrap: HTMLElement, row: number, col: number): string =>
  shownAt(wrap, row, col) ?? '';

const PERCENT = (): string => formatChoices().find((c) => c.value.includes('%'))!.value;
const THOUSANDS = (): string => formatChoices().find((c) => c.value.includes(','))?.value ?? '#,##0';

beforeEach(() => { document.body.replaceChildren(); });

describe('choosing a number format', () => {
  it('writes it into the model, so the save has something to write', () => {
    const h = harness(sheet());
    selectCell(h.editor, 'B2');                            // model row 1, column 1 ('2')
    expect(shown(h.wrap, 1, 1)).toBe('2');
    ribbonControl(h.editor, 'home', 'numfmt').onChange(PERCENT());

    expect(h.model().sheetFormats?.[0]?.cells?.['1:1']).toMatchObject({ numFmt: PERCENT() });
    expect(shown(h.wrap, 1, 1)).toContain('%');            // and the screen shows it at once
    // Only the cell the owner picked: nothing else in the sheet was touched.
    expect(h.model().sheetFormats?.[0]?.cells?.['2:1']).toBeUndefined();
  });

  it('takes it away again when General is chosen, so no false format is saved', () => {
    const h = harness(sheet());
    selectCell(h.editor, 'B2');
    ribbonControl(h.editor, 'home', 'numfmt').onChange(THOUSANDS());
    expect(h.model().sheetFormats?.[0]?.cells?.['1:1']?.numFmt).toBe(THOUSANDS());
    ribbonControl(h.editor, 'home', 'numfmt').onChange('General');
    // `null` is the model's "remove it": the save writes the default `xf` for that cell.
    expect(h.model().sheetFormats?.[0]?.cells?.['1:1']).toMatchObject({ numFmt: null });
    expect(shown(h.wrap, 1, 1)).toBe('2');
  });

  it('leaves a filter-hidden row alone: the format goes to the model row on screen', () => {
    const h = harness(sheet());
    selectCell(h.editor, 'B2');
    ribbonControl(h.editor, 'home', 'numfmt').onChange(PERCENT());
    expect(h.model().sheetFormats?.[0]?.cells?.['1:1']?.numFmt).toBe(PERCENT());
    expect(h.model().sheetFormats?.[0]?.cells?.['0:1']).toBeUndefined();
  });
});

describe('what the model holds reaches the file and comes back', () => {
  it('writes a builtin number format as its own numFmtId, and the reader shows it', async () => {
    const h = harness(sheet());
    selectCell(h.editor, 'B2');
    ribbonControl(h.editor, 'home', 'numfmt').onChange(PERCENT());   // 0% is builtin 9
    const model = h.model();

    const saved = writeXlsx(model.grids, model.formulas, model.sheetFormats);
    const styles = new TextDecoder().decode((await entryData(readRawZip(saved), 'xl/styles.xml')) ?? new Uint8Array());
    expect(styles).toMatch(/<xf numFmtId="9"[^>]*applyNumberFormat="1"\/>/);

    // The cell carries a style of its own (`s=`), and reading the file back shows the format.
    const sheetXml = new TextDecoder().decode((await entryData(readRawZip(saved), 'xl/worksheets/sheet1.xml')) ?? new Uint8Array());
    expect(sheetXml).toMatch(/<c r="B2" s="[1-9]\d*"/);
    const rows = await readXlsx(saved);
    expect(rows[0]?.rows[1]?.[1]).toBe('2');

    // The reader's own look carries the number format, which is what the picker shows at open.
    const look = await readBookLook(saved);
    const style = look.styles[look.sheets[0].xf.get('1:1') as number];
    expect(style?.numFmt).toBe('0%');
  });

  it('writes a pattern the file has no id for into <numFmts>, in the schema\'s order', async () => {
    const custom = '#,##0.00 "ر.س"';
    const h = harness(sheet());
    selectCell(h.editor, 'B2');
    ribbonControl(h.editor, 'home', 'numfmt').onChange(custom);
    const model = h.model();

    const saved = writeXlsx(model.grids, model.formulas, model.sheetFormats);
    const styles = new TextDecoder().decode((await entryData(readRawZip(saved), 'xl/styles.xml')) ?? new Uint8Array());
    expect(styles).toContain('<numFmts');
    expect(styles).toContain('formatCode="#,##0.00 &quot;ر.س&quot;"');
    expect(styles).toMatch(/<numFmt numFmtId="(1[6-9]\d|[2-9]\d\d)" formatCode=/);
    expect(styles.indexOf('<numFmts')).toBeLessThan(styles.indexOf('<fonts'));

    const look = await readBookLook(saved);
    const style = look.styles[look.sheets[0].xf.get('1:1') as number];
    expect(style?.numFmt).toBe(custom);
  });

  it('writes nothing for a format the owner took back to General', async () => {
    const h = harness(sheet());
    selectCell(h.editor, 'B2');
    ribbonControl(h.editor, 'home', 'numfmt').onChange(PERCENT());
    ribbonControl(h.editor, 'home', 'numfmt').onChange('General');
    const model = h.model();
    const saved = writeXlsx(model.grids, model.formulas, model.sheetFormats);
    const styles = new TextDecoder().decode((await entryData(readRawZip(saved), 'xl/styles.xml')) ?? new Uint8Array());
    expect(styles).not.toContain('<numFmts');
    expect(styles).toMatch(/<xf numFmtId="0"[^>]*\/>/);
    const look = await readBookLook(saved);
    const style = look.styles[look.sheets[0].xf.get('1:1') as number];
    expect(style?.numFmt ?? 'General').toBe('General');
  });
});

/** A workbook with its own styles, to prove the written format sits beside the file's own. */
function styledBook(): Uint8Array {
  const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return writeZip([
    { name: 'xl/workbook.xml', data: utf8(`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: utf8(`<styleSheet xmlns="${S}"><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(`<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" s="1"><v>1234.5</v></c></row></sheetData></worksheet>`) },
  ]);
}

describe('the file\'s own number format', () => {
  it('is read at open, so a saved sheet opens looking the way it was saved', async () => {
    const look = await readBookLook(styledBook());
    const style = look.styles[look.sheets[0].xf.get('0:0') as number];
    expect(style?.numFmt).toBe('0.00');
  });
});
