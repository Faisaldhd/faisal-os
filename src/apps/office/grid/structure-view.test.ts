/**
 * Structural insert/delete, wired into the virtual grid, with a filter on (٣د).
 *
 * The grid draws a SUBSET of the model rows while a filter is active, so "the row the owner is
 * looking at" and "the row the file holds" are two different numbers. Everything that inserts or
 * deletes has to go through `modelRowOf` (slice `#108`): an insert belongs at the MODEL row of the
 * cell the cursor shows, a delete removes exactly that model row, and a blank row the grid draws
 * below the filtered data — which has no model row at all — must delete nothing. A mistake here
 * destroys data the owner cannot even see, which is why this file exists.
 *
 * The last test covers the second half of the same story: the number format the owner chose lives
 * in the VIEW (`sheetView.formats`, keyed `row:col`), and if it does not move with the structure
 * the screen shows the format on a row the owner never formatted — the display contradicting the
 * data until the file is reopened.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import '../strings';
import type { Editor, EditorContext } from '../editor';
import type { Edit, OfficeModel, SheetsModel } from '../model';
import { createSheet } from './view';
import { formatChoices } from './sheetview';

const WORDS = ['ألف', 'باء', 'جيم'];

function sheet(): SheetsModel {
  const rows = [['Cat', 'Qty']];
  for (let r = 1; r <= 12; r++) rows.push([WORDS[(r - 1) % 3], String(r)]);
  return { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'S', rows, truncated: false }] };
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
    filePath: () => '/home/user/budget_2026.xlsx',
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

function withViewport(wrap: HTMLElement, height = 480, width = 900): void {
  Object.defineProperty(wrap, 'clientHeight', { value: height, configurable: true });
  Object.defineProperty(wrap, 'clientWidth', { value: width, configurable: true });
}

const cell = (wrap: HTMLElement, modelRow: number, c: number): HTMLInputElement | null =>
  wrap.querySelector<HTMLInputElement>(`input[data-r="${modelRow}"][data-c="${c}"]`);

/** What the cell SHOWS (the formatted text drawn over the field), not what it holds. */
const shown = (wrap: HTMLElement, modelRow: number, c: number): string =>
  cell(wrap, modelRow, c)?.previousElementSibling?.textContent ?? '';

const nameBoxTo = (editor: Editor, ref: string): void => {
  const box = editor.element.querySelector<HTMLInputElement>('.fo-namebox')!;
  box.value = ref;
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
};

const ribbonControl = (editor: Editor, tabId: string, controlId: string) => {
  const tab = editor.tabs().find((tb) => tb.id === tabId);
  const control = tab?.groups.flatMap((g) => g.controls).find((c) => c.id === controlId);
  if (!control) throw new Error(`no control ${tabId}/${controlId}`);
  return control as unknown as { run: () => void };
};

function filterTo(h: ReturnType<typeof harness>, keep: string[]): void {
  h.wrap.querySelector<HTMLTableCellElement>('.fo-colhead[data-c="1"]')!.click();
  h.wrap.scrollTop = 0;
  h.wrap.dispatchEvent(new Event('scroll'));
  ribbonControl(h.editor, 'data', 'filter').run();
  const panel = h.editor.element.querySelector<HTMLElement>('.fo-sheetpanel')!;
  for (const label of [...panel.querySelectorAll<HTMLElement>('.fo-sheetpanel-check')]) {
    const box = label.querySelector('input');
    if (!box) continue;
    const value = (label.textContent ?? '').replace(/\s*\(\d+\)\s*$/, '').trim();
    box.checked = keep.includes(value);
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  [...panel.querySelectorAll<HTMLButtonElement>('.fo-sheetpanel-btn')].find((b) => b.classList.contains('is-primary'))!.click();
}

beforeEach(() => { document.body.replaceChildren(); });

describe('insert and delete with a filter active', () => {
  it('inserts at the MODEL row of the row the cursor shows', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    filterTo(h, ['5', '9']);
    // Drawn: the header (0), model row 5 (drawn 1) and model row 9 (drawn 2); the rest is hidden.
    const before = h.model().grids[0].rows.map((r) => r.slice());

    nameBoxTo(h.editor, 'A6');                             // sheet row 6 = MODEL row 5, drawn row 1
    ribbonControl(h.editor, 'home', 'addrow').run();

    const rows = h.model().grids[0].rows;
    // A blank row at model row 5 and everything below pushed down one: no hidden row was written.
    expect(rows).toEqual([...before.slice(0, 5), ['', ''], ...before.slice(5)]);
  });

  it('deletes only the MODEL row the cursor shows, and leaves every hidden row alone', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    filterTo(h, ['5', '9']);
    const before = h.model().grids[0].rows.map((r) => r.slice());

    nameBoxTo(h.editor, 'A10');                            // sheet row 10 = MODEL row 9, drawn row 2
    ribbonControl(h.editor, 'home', 'delrow').run();

    const after = h.model().grids[0].rows;
    expect(after).toEqual([...before.slice(0, 9), ...before.slice(10)]);
    // The hidden rows ABOVE the deletion are byte-for-byte what they were.
    for (const hidden of [1, 2, 3, 4, 6, 7, 8]) {
      expect(after[hidden], `model row ${hidden}`).toEqual(before[hidden]);
    }
    // …and the rows below it simply moved up with the data, none of them written.
    expect(after[11]).toEqual(before[12]);
  });

  it('deletes nothing through a blank row the grid draws below the filtered data', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    filterTo(h, ['5', '9']);
    const before = h.model().grids[0].rows.map((r) => r.slice());
    // Drawn rows 0..2 are the header and the two kept rows; drawn 3 is the first BLANK one, and it
    // shows no model row at all (modelRowOf → -1), so there is nothing a delete could remove.
    const blank = h.wrap.querySelector<HTMLInputElement>('.fo-td[data-drawn="3"] input');
    expect(blank).toBeTruthy();
    blank!.focus();
    h.commits.length = 0;

    ribbonControl(h.editor, 'home', 'delrow').run();

    expect(h.commits).toHaveLength(0);
    expect(h.model().grids[0].rows).toEqual(before);
  });
});

describe('the number format the owner chose', () => {
  it('stays on its cell when a row is inserted above it', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    nameBoxTo(h.editor, 'B3');                             // model row 2, the Qty cell '2'
    expect(shown(h.wrap, 2, 1)).toBe('2');
    // The picker is the Data tab's own control; a number format is view-level state.
    const percent = formatChoices().find((c) => c.value.includes('%'))!.value;
    (ribbonControl(h.editor, 'data', 'numfmt') as unknown as { onChange: (v: string) => void }).onChange(percent);
    expect(shown(h.wrap, 2, 1)).toContain('%');

    nameBoxTo(h.editor, 'A1');                             // insert above everything
    ribbonControl(h.editor, 'home', 'addrow').run();

    // The format followed its cell down one row — the screen must not contradict the data.
    expect(shown(h.wrap, 2, 1), 'the format stayed on the row the data left').not.toContain('%');
    expect(shown(h.wrap, 3, 1), 'the moved cell lost its format').toContain('%');
  });

  it('follows the data when a column is inserted to its left', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    nameBoxTo(h.editor, 'B3');                             // model row 2, column 1
    const percent = formatChoices().find((c) => c.value.includes('%'))!.value;
    (ribbonControl(h.editor, 'data', 'numfmt') as unknown as { onChange: (v: string) => void }).onChange(percent);
    expect(shown(h.wrap, 2, 1)).toContain('%');

    nameBoxTo(h.editor, 'A3');                             // the cursor's column is A: insert at 0
    ribbonControl(h.editor, 'home', 'addcol').run();

    expect(shown(h.wrap, 2, 2)).toContain('%');            // the cell moved one column right
    expect(shown(h.wrap, 2, 1)).not.toContain('%');
  });
});
