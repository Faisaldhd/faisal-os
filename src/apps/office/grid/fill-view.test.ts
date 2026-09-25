/**
 * The fill handle, wired into the virtual grid.
 *
 * FIRST test of this slice, written before the handle existed: a drag must never write into a row
 * an active filter hid. Since the grid draws a *subset* of the model rows while a filter is on,
 * every read and every write of cell data has to go through `modelRowOf(drawnRow)` — that rule
 * (slice `#108`) is what keeps the one thing a spreadsheet must never do from happening silently:
 * putting a value in the wrong row.
 *
 * The rest of the file covers the behaviour the owner asked for: a series, a copy, a live preview
 * while dragging, and the whole drag landing as ONE undoable edit.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import '../strings';
import type { Editor, EditorContext } from '../editor';
import type { Edit, OfficeModel, SheetsModel } from '../model';
import { createSheet } from './view';

/** Column A repeats three words with no digits in them, so a fill COPIES it rather than stepping a
 *  number — which makes a fill that lands in the wrong row visible at a glance. */
const WORDS = ['ألف', 'باء', 'جيم'];

function sheet(): SheetsModel {
  const rows = [['Cat', 'Qty']];
  for (let r = 1; r <= 60; r++) rows.push([WORDS[(r - 1) % 3], String(r)]);
  return { kind: 'xlsx', active: 0, delimiter: ',', grids: [{ name: 'A', rows, truncated: false }] };
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

/** jsdom has no layout: give the scroll area a height so the window maths has something to use. */
function withViewport(wrap: HTMLElement, height = 480, width = 900): void {
  Object.defineProperty(wrap, 'clientHeight', { value: height, configurable: true });
  Object.defineProperty(wrap, 'clientWidth', { value: width, configurable: true });
}

const cell = (wrap: HTMLElement, modelRow: number, c: number): HTMLInputElement | null =>
  wrap.querySelector<HTMLInputElement>(`.faisal-office-cell[data-r="${modelRow}"][data-c="${c}"]`);

/** The cell element at a DRAWN position — the space a drag moves in. */
const tdAt = (wrap: HTMLElement, drawnRow: number, c: number): HTMLElement | null =>
  wrap.querySelector<HTMLElement>(`.fo-td[data-drawn="${drawnRow}"][data-c="${c}"]`);

/** The model row each drawn row shows (column A's input carries `data-r` = model row). */
const drawnRows = (wrap: HTMLElement): number[] =>
  [...wrap.querySelectorAll<HTMLInputElement>('.fo-td[data-drawn] .faisal-office-cell[data-r][data-c="0"]')]
    .map((i) => Number(i.dataset.r))
    .filter((n) => Number.isFinite(n));

/** Ribbon control lookup, the same way `virtual-view.test.ts` reaches the Data tab. */
const ribbonControl = (editor: Editor, tabId: string, controlId: string) => {
  const tab = editor.tabs().find((tb) => tb.id === tabId);
  const control = tab?.groups.flatMap((g) => g.controls).find((c) => c.id === controlId);
  if (!control) throw new Error(`no control ${tabId}/${controlId}`);
  return control as unknown as { run: () => void };
};

/** Filters the Qty column down to the rows whose value is in `keep`, through the real panel. */
function filterTo(h: ReturnType<typeof harness>, keep: string[]): void {
  h.wrap.querySelector<HTMLTableCellElement>('.fo-colhead[data-c="1"]')!.click();
  h.wrap.scrollTop = 0;
  h.wrap.dispatchEvent(new Event('scroll'));
  ribbonControl(h.editor, 'data', 'filter').run();
  const panel = h.editor.element.querySelector<HTMLElement>('.fo-sheetpanel')!;
  const labels = [...panel.querySelectorAll<HTMLElement>('.fo-sheetpanel-check')];
  for (const label of labels) {
    const box = label.querySelector('input');
    if (!box) continue;
    // The label reads "2 (1)" — the value, then how many rows carry it.
    const value = (label.textContent ?? '').replace(/\s*\(\d+\)\s*$/, '').trim();
    box.checked = keep.includes(value);
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  [...panel.querySelectorAll<HTMLButtonElement>('.fo-sheetpanel-btn')].find((b) => b.classList.contains('is-primary'))!.click();
}

/** Selects a cell the way the owner does: type its address in the name box. */
const nameBoxTo = (editor: Editor, ref: string): void => {
  const box = editor.element.querySelector<HTMLInputElement>('.fo-namebox')!;
  box.value = ref;
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
};

/** Drags the fill handle onto a DRAWN cell: pointerdown, hover it, release. */
function dragHandleTo(h: ReturnType<typeof harness>, drawnRow: number, col: number): void {
  const handle = h.wrap.querySelector<HTMLElement>('.fo-fillhandle');
  if (!handle) throw new Error('no fill handle in the selection');
  const target = tdAt(h.wrap, drawnRow, col);
  if (!target) throw new Error(`no cell at drawn row ${drawnRow}`);
  handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
  target.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerId: 1 }));
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
}

beforeEach(() => { document.body.replaceChildren(); });

describe('the fill handle and an active filter', () => {
  it('never writes into a row the filter hid', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    // Keep the rows whose Qty is 2 (model row 2) and 40 (model row 40): the filter now hides
    // every row between them, and the grid draws only the header plus those two.
    filterTo(h, ['2', '40']);
    // Drawn: the header (drawn 0 = model 0), the row whose Qty is 2 (drawn 1 = model 2) and the
    // row whose Qty is 40 (drawn 2 = model 40). Everything between them is hidden.
    expect(drawnRows(h.wrap)).toEqual([0, 2, 40]);
    // The rows the filter hid are not in the document at all (drawn row 3 exists, but it is one of
    // the blank rows the grid draws below the data — it carries no model row).
    expect(h.wrap.querySelector('.faisal-office-cell[data-r="3"]')).toBeNull();
    expect(h.wrap.querySelector('.faisal-office-cell[data-r="39"]')).toBeNull();
    expect(cell(h.wrap, 3, 0)).toBeNull();

    // A3 is the sheet address of MODEL row 2 (row numbers are 1-based on screen), drawn row 1.
    nameBoxTo(h.editor, 'A3');
    expect(cell(h.wrap, 2, 0)?.value).toBe(WORDS[1]);
    dragHandleTo(h, 2, 0);                                 // onto drawn row 2 = model row 40

    const rows = h.model().grids[0].rows;
    expect(rows[40][0]).toBe(WORDS[1]);                    // the visible row under the drag got the copy
    // …and every row the filter hid is exactly as it was.
    for (const hidden of [1, 3, 4, 5, 20, 39, 41]) expect(rows[hidden][0], `model row ${hidden}`).toBe(WORDS[(hidden - 1) % 3]);
    expect(h.commits).toHaveLength(1);                     // one undoable edit, not one per cell
  });

  it('leaves the blank rows under a filtered sheet alone instead of appending data', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    filterTo(h, ['2', '40']);
    // The last row the filter kept is drawn 2 (model row 40); everything below it is a blank row
    // the grid draws to look like a sheet. A fill that starts there has nowhere real to go.
    nameBoxTo(h.editor, 'A41');
    expect(cell(h.wrap, 40, 0)?.value).toBe(WORDS[39 % 3]);
    const before = h.model().grids[0].rows.length;
    dragHandleTo(h, 5, 0);                                 // drawn rows 3, 4, 5 are all blank
    expect(h.model().grids[0].rows.length).toBe(before);   // nothing appended
    expect(h.model().grids[0].rows[40][0]).toBe(WORDS[39 % 3]); // and the last real row is untouched
    expect(h.commits).toHaveLength(0);                     // nothing to undo
  });
});

describe('the fill handle', () => {
  it('continues a numeric series downward as one edit, and one undo puts it back', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    const a2 = cell(h.wrap, 1, 0)!;                        // sheet A2 = model row 1
    a2.value = '10';
    a2.dispatchEvent(new Event('input', { bubbles: true }));
    const a3 = cell(h.wrap, 2, 0)!;                        // sheet A3 = model row 2
    a3.value = '20';
    a3.dispatchEvent(new Event('input', { bubbles: true }));
    h.commits.length = 0;                                  // the two seeding edits are not the subject
    nameBoxTo(h.editor, 'A2:A3');                          // select 10 and 20
    dragHandleTo(h, 4, 0);                                 // two rows down: model rows 3 and 4

    const rows = h.model().grids[0].rows;
    expect([rows[3][0], rows[4][0]]).toEqual(['30', '40']);
    expect(h.commits).toHaveLength(1);
    const undone = h.commits[0].revert(h.model()) as SheetsModel;
    expect([undone.grids[0].rows[3][0], undone.grids[0].rows[4][0]]).toEqual([WORDS[2], WORDS[0]]);
  });

  it('copies a text cell down, cycling the pattern of the source', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    const a2 = cell(h.wrap, 1, 0)!;
    a2.value = 'شهري';
    a2.dispatchEvent(new Event('input', { bubbles: true }));
    const a3 = cell(h.wrap, 2, 0)!;
    a3.value = 'سنوي';
    a3.dispatchEvent(new Event('input', { bubbles: true }));
    h.commits.length = 0;
    nameBoxTo(h.editor, 'A2:A3');
    dragHandleTo(h, 4, 0);
    const rows = h.model().grids[0].rows;
    expect([rows[3][0], rows[4][0]]).toEqual(['شهري', 'سنوي']);
    expect(h.commits).toHaveLength(1);
  });

  it('shows a live preview of the cells it is about to write, and clears it on release', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    nameBoxTo(h.editor, 'A2:A3');
    const handle = h.wrap.querySelector<HTMLElement>('.fo-fillhandle')!;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
    tdAt(h.wrap, 4, 0)!.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerId: 1 }));
    // The source is drawn rows 1:2 and the drag reached drawn row 4, so the preview marks 3 and 4.
    expect(h.wrap.querySelectorAll('.fo-td.is-fillpreview').length).toBe(2);
    expect(h.commits).toHaveLength(0);                     // a preview writes nothing
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    expect(h.wrap.querySelectorAll('.fo-td.is-fillpreview').length).toBe(0);
    expect(h.commits).toHaveLength(1);                     // the release is the one edit
  });

  it('keeps the handle on the selection corner, with an accessible name', () => {
    const h = harness(sheet());
    withViewport(h.wrap);
    h.editor.render();
    nameBoxTo(h.editor, 'A2:B3');
    const handle = h.wrap.querySelector<HTMLElement>('.fo-fillhandle');
    expect(handle).toBeTruthy();
    expect(handle!.closest('td')?.classList.contains('fo-td')).toBe(true);
    expect(handle!.closest('.fo-td')?.classList.contains('has-fillhandle')).toBe(true);
    expect(handle!.getAttribute('role')).toBe('button');
    expect(handle!.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(0);
  });
});
