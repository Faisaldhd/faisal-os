/**
 * The sheet's ribbon, laid out like WPS Spreadsheets, and a few of its commands wired end to end:
 * merge & center, a chart placed beside its data, Insert function, a link, find & replace, remove
 * duplicates, freeze panes and the format painter.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../../kernel/i18n';
import '../strings';
import type { Editor, EditorContext } from '../editor';
import { formulaAt, type Edit, type OfficeModel, type SheetsModel } from '../model';
import type { Control, MenuControl } from '../ui/ribbon';
import { createSheet } from './view';
import { cellEl, clickCell, openEditor } from './cells.testkit';

function sheet(): SheetsModel {
  return {
    kind: 'xlsx', active: 0, delimiter: ',',
    grids: [{ name: 'S', truncated: false, rows: [['Region', 'Sales'], ['North', '10'], ['South', '20'], ['North', '10'], ['East', '5']] }],
  };
}

function harness(model: SheetsModel = sheet()) {
  let current: OfficeModel = model;
  const commits: Edit[] = [];
  const status: string[] = [];
  const ctx: EditorContext = {
    model: () => current,
    commit: (edit) => { commits.push(edit); current = edit.apply(current); },
    undo: () => {}, redo: () => {}, editable: () => true, refresh: () => {}, setStatus: (s) => { status.push(s); },
    host: () => document.body, filePath: () => '/home/user/t.xlsx',
    fileTab: () => ({ id: 'file', label: 'File', groups: [] }), exportFile: async () => {}, print: () => {},
  };
  const editor: Editor = createSheet(ctx, null);
  document.body.append(editor.element);
  editor.render();
  const wrap = editor.element.querySelector<HTMLElement>('.fo-gridwrap') as HTMLElement;
  Object.defineProperty(wrap, 'clientHeight', { value: 480, configurable: true });
  Object.defineProperty(wrap, 'clientWidth', { value: 900, configurable: true });
  editor.render();
  const nameBox = editor.element.querySelector<HTMLInputElement>('.fo-namebox') as HTMLInputElement;
  const selectRef = (ref: string): void => {
    nameBox.value = ref;
    nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  const control = (tab: string, id: string): Control => {
    const c = editor.tabs().find((tb) => tb.id === tab)?.groups.flatMap((g) => g.controls).find((x) => x.id === id);
    if (!c) throw new Error(`no ${tab}/${id}`);
    return c;
  };
  const run = (tab: string, id: string): void => (control(tab, id) as unknown as { run: () => void }).run();
  const menu = (tab: string, id: string, label: string): void => {
    const item = (control(tab, id) as MenuControl).items().find((i) => i !== 'sep' && i.label === label);
    if (!item || item === 'sep') throw new Error(`no item ${label} in ${tab}/${id}`);
    item.run();
  };
  return { editor, wrap, commits, status, selectRef, control, run, menu, model: () => current as SheetsModel };
}

beforeEach(() => { document.body.replaceChildren(); });

describe('the ribbon, like WPS', () => {
  it('has Home, Insert, Formulas, Data and View after File', () => {
    const h = harness();
    expect(h.editor.tabs().map((tb) => tb.id)).toEqual(['file', 'home', 'insert', 'formulas', 'data', 'view']);
  });

  it('keeps number formats and charts out of Data', () => {
    const h = harness();
    const ids = (tab: string): string[] => h.editor.tabs().find((tb) => tb.id === tab)!.groups.flatMap((g) => g.controls.map((c) => c.id));
    for (const id of ['paste', 'fontname', 'fontsize', 'bold', 'merge', 'numfmt', 'percent', 'currency', 'condfmt', 'cellstyles', 'addrow', 'sortfilter', 'find']) {
      expect(ids('home'), id).toContain(id);
    }
    expect(ids('insert')).toEqual(expect.arrayContaining(['pivot', 'chart', 'link', 'insertfn']));
    expect(ids('formulas')).toEqual(expect.arrayContaining(['fx', 'fnauto', 'fn_math', 'fn_lookup', 'fn_date']));
    expect(ids('data')).toEqual(expect.arrayContaining(['sortasc', 'sortdesc', 'sort', 'filter', 'validation', 'dedupe']));
    expect(ids('data')).not.toContain('numfmt');
    expect(ids('data')).not.toContain('chart');
    expect(ids('view')).toEqual(expect.arrayContaining(['freeze', 'gridlines', 'zoom']));
  });
});

describe('Home commands', () => {
  it('merge & center: one cell spans the block, keeps the first value, and saves in the model', () => {
    const h = harness();
    h.selectRef('A2:B2');
    h.menu('home', 'merge', t('office.mergeCenter'));
    const td = cellEl(h.wrap, 1, 0)!;
    expect(td.colSpan).toBe(2);
    expect(cellEl(h.wrap, 1, 1)).toBeNull();                  // covered by the merge
    expect(h.model().grids[0].rows[1]).toEqual(['North', '']);
    expect(h.model().sheetFormats?.[0]?.merges).toEqual([{ r0: 1, c0: 0, r1: 1, c1: 1 }]);
    expect(h.model().sheetFormats?.[0]?.cells?.['1:0']?.hAlign).toBe('center');
    expect(h.commits).toHaveLength(1);                         // one undo takes it all back
    h.menu('home', 'merge', t('office.unmerge'));
    expect(h.model().sheetFormats?.[0]?.merges).toEqual([]);
  });

  it('font family and size are cell formats', () => {
    const h = harness();
    h.selectRef('A1');
    (h.control('home', 'fontname') as unknown as { onChange: (v: string) => void }).onChange('Arial');
    (h.control('home', 'fontsize') as unknown as { onChange: (v: string) => void }).onChange('16');
    expect(h.model().sheetFormats?.[0]?.cells?.['0:0']).toMatchObject({ font: 'Arial', size: 16 });
  });

  it('the format painter lays the source’s look on the next selection', () => {
    const h = harness();
    h.selectRef('A1');
    h.run('home', 'bold');
    h.run('home', 'painter');
    clickCell(cellEl(h.wrap, 2, 1)!);
    expect(h.model().sheetFormats?.[0]?.cells?.['2:1']?.bold).toBe(true);
    expect((h.control('home', 'painter') as unknown as { pressed: () => boolean }).pressed()).toBe(false);
  });

  it('sort A→Z by the active column keeps the header on top', () => {
    const h = harness();
    h.selectRef('B2');
    h.menu('home', 'sortfilter', t('office.sortDescShort'));
    expect(h.model().grids[0].rows.map((r) => r[1])).toEqual(['Sales', '20', '10', '10', '5']);
  });

  it('find goes to the next match and replace all changes only what matches', () => {
    const h = harness();
    h.run('home', 'find');
    const panel = h.editor.element.querySelector<HTMLElement>('.fo-sheetpanel')!;
    const [what, withText] = [...panel.querySelectorAll<HTMLInputElement>('.fo-sheetpanel-input')];
    what.value = 'north';
    withText.value = 'شمال';
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('.fo-sheetpanel-btn')];
    buttons[0].click();                                        // find next
    expect(h.editor.element.querySelector<HTMLInputElement>('.fo-namebox')!.value).toBe('A2');
    buttons[2].click();                                        // replace all
    expect(h.model().grids[0].rows.map((r) => r[0])).toEqual(['Region', 'شمال', 'South', 'شمال', 'East']);
    expect(h.commits).toHaveLength(1);
  });
});

describe('Insert commands', () => {
  it('a chart goes beside its data, titled from its header, as one edit', () => {
    const h = harness();
    h.selectRef('B3');                                         // one cell inside the table: the whole table
    h.menu('insert', 'chart', t('office.chartBar'));
    const chart = h.model().charts?.[0]?.[0];
    expect(chart).toBeDefined();
    expect(chart!.range).toEqual({ r0: 0, c0: 0, r1: 4, c1: 1 });
    expect(chart!.title).toBe('Sales');
    // Past the data's last column (A and B), level with its top row.
    const box = h.wrap.querySelector<HTMLElement>('.fo-chart')!;
    expect(chart!.x).toBeGreaterThan(0);
    expect(chart!.y).toBe(0);
    expect(box.closest('.fo-gridwrap')).toBe(h.wrap);          // it scrolls with the sheet
    expect(box.querySelector('.fo-chart-grip')).toBeTruthy();  // and can be resized
  });

  it('Insert function puts =NAME( in the cell for the owner to finish', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 5, 1)!);                          // B6, below the data
    h.menu('formulas', 'fn_math', 'ROUND');
    const editor = openEditor(h.wrap)!;
    expect(editor.value).toBe('=ROUND(');
    editor.value = '=ROUND(2.46,1)';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(h.model().grids[0].rows[5][1]).toBe('2.5');
    expect(formulaAt(h.model(), 0, 5, 1)).toBe('=ROUND(2.46,1)');
  });

  it('a link is a HYPERLINK formula the cell shows as a link', () => {
    const h = harness();
    h.selectRef('A5');
    h.run('insert', 'link');
    const modal = document.querySelector<HTMLElement>('.fo-modal')!;
    const [url, text] = [...modal.querySelectorAll<HTMLInputElement>('input')];
    url.value = 'javascript:alert(1)';
    [...modal.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.classList.contains('is-primary'))!.click();
    expect(document.querySelector('.fo-modal')).toBeTruthy();  // refused: stays open
    url.value = 'https://example.com';
    text.value = 'Example';
    [...modal.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.classList.contains('is-primary'))!.click();
    expect(formulaAt(h.model(), 0, 4, 0)).toBe('=HYPERLINK("https://example.com","Example")');
    expect(h.model().grids[0].rows[4][0]).toBe('Example');
    expect(cellEl(h.wrap, 4, 0)!.querySelector('.fo-cellview')!.classList.contains('is-link')).toBe(true);
  });
});

describe('Data and View commands', () => {
  it('remove duplicates drops the repeated rows as one edit', () => {
    const h = harness();
    h.selectRef('A1');
    h.run('data', 'dedupe');
    const panel = h.editor.element.querySelector<HTMLElement>('.fo-sheetpanel')!;
    panel.querySelector<HTMLButtonElement>('.fo-sheetpanel-btn.is-primary')!.click();
    expect(h.model().grids[0].rows).toEqual([['Region', 'Sales'], ['North', '10'], ['South', '20'], ['East', '5'], ['', '']]);
    expect(h.commits).toHaveLength(1);
  });

  it('freezes the top row and the first column', () => {
    const h = harness();
    h.menu('view', 'freeze', t('office.freezeTopRow'));
    expect(h.wrap.querySelector('tr.is-frozen')).toBeTruthy();
    h.menu('view', 'freeze', t('office.freezeFirstCol'));
    expect(h.wrap.querySelector('tr.is-frozen')).toBeNull();
    expect(h.wrap.querySelectorAll('.fo-td.is-frozen-col[data-c="0"]').length).toBeGreaterThan(3);
    h.menu('view', 'freeze', t('office.unfreeze'));
    expect(h.wrap.querySelector('.is-frozen-col')).toBeNull();
  });

  it('turns the gridlines off and on', () => {
    const h = harness();
    h.run('view', 'gridlines');
    expect(h.editor.element.classList.contains('no-gridlines')).toBe(true);
    h.run('view', 'gridlines');
    expect(h.editor.element.classList.contains('no-gridlines')).toBe(false);
  });
});
