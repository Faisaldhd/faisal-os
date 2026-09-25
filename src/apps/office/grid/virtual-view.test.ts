/**
 * The virtual grid, wired: a sheet with ten thousand rows must put only a screenful of them in
 * the document, follow the scroll position, and still let the active cell be reached, typed into
 * and read back.
 *
 * `src/apps/office/grid/virtual.test.ts` already covers the maths (which rows a scroll offset
 * shows, how a new window recycles the old one). This file covers the INTEGRATION the slice was
 * about: the view honours that window, the spacers carry the rest of the sheet, and editing a
 * cell 9 000 rows down works through the ordinary input elements.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Editor, EditorContext } from '../editor';
import type { Edit, OfficeModel, SheetsModel } from '../model';
import { SHEET_ROWS, formulaCellEdit } from '../model';
import { createSheet } from './view';

const ROWS = 10_000;
const COLS = 8;

function bigSheet(rows = ROWS): SheetsModel {
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: COLS }, (_, c) => `r${r}c${c}`));
  return { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'Big', rows: grid, truncated: false }] };
}

function harness(model: SheetsModel) {
  let current: OfficeModel = model;
  const commits: Edit[] = [];
  const ctx: EditorContext = {
    model: () => current,
    commit: (edit) => { commits.push(edit); current = edit.apply(current); },
    undo: () => {},
    redo: () => {},
    editable: () => true,
    refresh: () => {},
    setStatus: () => {},
    host: () => document.body,
    filePath: () => '/home/user/big.xlsx',
    fileTab: () => ({ id: 'file', label: 'File', groups: [] }),
    exportFile: async () => {},
    print: () => {},
  };
  const editor: Editor = createSheet(ctx, null);
  document.body.append(editor.element);
  editor.render();
  const wrap = editor.element.querySelector<HTMLElement>('.fo-gridwrap') as HTMLElement;
  return { editor, ctx, wrap, commits, model: () => current as SheetsModel };
}

/** jsdom has no layout: give the scroll area a height so the window maths has something to use. */
function withViewport(wrap: HTMLElement, height = 480, width = 900): void {
  Object.defineProperty(wrap, 'clientHeight', { value: height, configurable: true });
  Object.defineProperty(wrap, 'clientWidth', { value: width, configurable: true });
}

const drawnRows = (wrap: HTMLElement): number[] =>
  [...wrap.querySelectorAll<HTMLElement>('.fo-rowhead')].map((th) => Number(th.textContent) - 1);

const spacerHeights = (wrap: HTMLElement): number[] =>
  [...wrap.querySelectorAll<HTMLElement>('.fo-vpad')].map((tr) => Number.parseFloat(tr.style.height || '0'));

beforeEach(() => { document.body.replaceChildren(); });

describe('the virtual sheet', () => {
  it('draws a screenful of a ten-thousand-row sheet, not the sheet', () => {
    const h = harness(bigSheet());
    withViewport(h.wrap);
    h.editor.render();
    const rows = drawnRows(h.wrap);
    expect(h.model().grids[0].rows).toHaveLength(SHEET_ROWS);
    expect(rows.length).toBeGreaterThan(8);
    // 480px of 24px rows plus the overscan — nowhere near the sheet.
    expect(rows.length).toBeLessThan(60);
    expect(rows[0]).toBe(0);
    expect(h.wrap.querySelectorAll('.fo-td').length).toBeLessThan(60 * COLS);
  });

  it('follows the scroll offset, and the spacers carry the rest of the sheet', () => {
    const h = harness(bigSheet());
    withViewport(h.wrap);
    h.editor.render();
    expect(spacerHeights(h.wrap)[0]).toBe(0);

    // Scroll 5 000px down at 24px a row: the window is the rows around row 208.
    h.wrap.scrollTop = 5000;
    h.wrap.dispatchEvent(new Event('scroll'));
    const rows = drawnRows(h.wrap);
    expect(rows[0]).toBeLessThanOrEqual(209);       // overscan reaches back a little
    expect(rows[0]).toBeGreaterThan(200);
    expect(rows[rows.length - 1]).toBeGreaterThan(219);
    const [top, bottom] = spacerHeights(h.wrap);
    expect(top).toBe(rows[0] * 24);                 // the strip above is exactly the rows skipped
    // The two spacers plus the drawn rows are the whole scrollable sheet (10 000 rows + the pad
    // rows an editable sheet keeps below the data).
    expect(top + rows.length * 24 + bottom).toBe((ROWS + 30) * 24);

    // Scrolling back to the top draws row 1 again.
    h.wrap.scrollTop = 0;
    h.wrap.dispatchEvent(new Event('scroll'));
    expect(drawnRows(h.wrap)[0]).toBe(0);
  });

  it('keeps the drawn window bounded while flicking through the whole sheet', () => {
    const h = harness(bigSheet());
    withViewport(h.wrap);
    h.editor.render();
    let worst = 0;
    // Big jumps down the sheet plus a few single-row steps: every one of them must leave a
    // screenful in the document, however far it lands.
    const stops = [...Array.from({ length: 40 }, (_, i) => Math.round((ROWS * 24) * (i / 39))), 5000, 5001, 5002, 5003];
    for (const y of stops) {
      h.wrap.scrollTop = y;
      h.wrap.dispatchEvent(new Event('scroll'));
      worst = Math.max(worst, h.wrap.querySelectorAll('tr').length);
      expect(drawnRows(h.wrap).length).toBeLessThan(60);
    }
    expect(worst).toBeLessThan(70);
  });

  it('edits a cell nine thousand rows down through the ordinary input', () => {
    const h = harness(bigSheet());
    withViewport(h.wrap);
    h.editor.render();

    // The name box jumps there the way a person does it (row 9001, column A).
    const nameBox = h.wrap.parentElement?.querySelector<HTMLInputElement>('.fo-namebox');
    expect(nameBox).toBeTruthy();
    nameBox!.value = 'A9001';
    nameBox!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(h.wrap.scrollTop).toBeGreaterThan(9000 * 24 - 480);
    const rows = drawnRows(h.wrap);
    expect(rows).toContain(9000);
    expect(h.wrap.querySelectorAll('tr').length).toBeLessThan(70);

    const input = h.wrap.querySelector<HTMLInputElement>('.faisal-office-cell[data-r="9000"][data-c="0"]');
    expect(input).toBeTruthy();
    input!.value = 'typed';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.commits.length).toBe(1);
    expect(h.model().grids[0].rows[9000][0]).toBe('typed');
    // …and the row that was drawn still shows it after the edit.
    const view = input!.previousElementSibling as HTMLElement | null;
    expect(view?.textContent).toBe('typed');
  });

  it('grows past the end of the sheet without losing the caret', () => {
    const h = harness(bigSheet(5));
    withViewport(h.wrap);
    h.editor.render();
    const before = drawnRows(h.wrap).length;
    const edit = formulaCellEdit(0, 9, 0, { value: '' }, { value: 'new' });
    h.ctx.commit(edit);
    h.editor.render();
    expect(h.model().grids[0].rows[9]?.[0]).toBe('new');
    expect(drawnRows(h.wrap).length).toBeGreaterThanOrEqual(before);
    // The row the owner typed into exists as an input again, with the value in it.
    h.wrap.scrollTop = 0;
    h.wrap.dispatchEvent(new Event('scroll'));
    const input = h.wrap.querySelector<HTMLInputElement>('.faisal-office-cell[data-r="9"][data-c="0"]');
    expect(input?.value).toBe('new');
  });

  it('a read-only sheet still draws its rows and refuses the edit', () => {
    const model = bigSheet(50);
    const ctx: EditorContext = {
      model: () => model,
      commit: () => { throw new Error('a read-only sheet must not commit'); },
      undo: () => {}, redo: () => {}, editable: () => false, refresh: () => {}, setStatus: () => {},
      host: () => document.body, filePath: () => null, fileTab: () => ({ id: 'file', label: 'File', groups: [] }),
      exportFile: async () => {}, print: () => {},
    };
    const editor = createSheet(ctx, null);
    document.body.append(editor.element);
    editor.render();
    const wrap = editor.element.querySelector<HTMLElement>('.fo-gridwrap') as HTMLElement;
    withViewport(wrap);
    editor.render();
    expect(drawnRows(wrap).length).toBeGreaterThan(5);
    expect(wrap.querySelectorAll('.faisal-office-cell[readonly]').length).toBeGreaterThan(0);
  });
});
