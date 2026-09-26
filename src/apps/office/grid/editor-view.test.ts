/**
 * The one floating editor, wired: the grid takes the keyboard, a typed key opens the editor over
 * the active cell, Enter/Tab commit and move, Esc throws the entry away, F2 edits in place, Ctrl
 * jumps, Shift selects, and copy/paste speak TSV. `nav.test.ts` covers the key maths; this covers
 * the view that acts on it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import '../strings';
import { setLocale } from '../../../kernel/i18n';
import type { Editor, EditorContext } from '../editor';
import { formulaAt, type Edit, type OfficeModel, type SheetsModel } from '../model';
import { createSheet } from './view';
import { cellEl, clickCell, openEditor, shownAt } from './cells.testkit';

function sheet(): SheetsModel {
  return {
    kind: 'xlsx', active: 0, delimiter: ',',
    grids: [{ name: 'S', truncated: false, rows: [['Name', 'Qty'], ['a', '1'], ['b', '2'], ['c', '3']] }],
  };
}

function harness(model: SheetsModel = sheet(), editable = true) {
  let current: OfficeModel = model;
  const commits: Edit[] = [];
  const ctx: EditorContext = {
    model: () => current,
    commit: (edit) => { commits.push(edit); current = edit.apply(current); },
    undo: () => {}, redo: () => {}, editable: () => editable, refresh: () => {}, setStatus: () => {},
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
  const fx = editor.element.querySelector<HTMLInputElement>('.fo-fxinput') as HTMLInputElement;
  const key = (k: string, init: KeyboardEventInit = {}, target: HTMLElement = wrap): void => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  };
  return { editor, wrap, commits, nameBox, fx, key, model: () => current as SheetsModel };
}

beforeEach(() => { document.body.replaceChildren(); });

/** The arrow that goes to the next column: ← in a right-to-left sheet (column A on the right). */
const nextColumnKey = (h: ReturnType<typeof harness>): string =>
  (h.editor.element.classList.contains('is-rtl-sheet') ? 'ArrowLeft' : 'ArrowRight');

describe('the grid keyboard', () => {
  it('has no text field per cell: one editor, opened only while typing', () => {
    const h = harness();
    expect(h.wrap.querySelectorAll('input').length).toBe(0);
    expect(h.wrap.tabIndex).toBe(0);
    h.key('x');
    expect(h.wrap.querySelectorAll('input').length).toBe(1);
  });

  it('moves with the arrows and names the cell in the name box', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 0, 0)!);
    h.key('ArrowDown');
    h.key(nextColumnKey(h));
    expect(h.nameBox.value).toBe('B2');
    expect(h.fx.value).toBe('1');
    expect(cellEl(h.wrap, 1, 1)?.classList.contains('is-active')).toBe(true);
  });

  it('runs right-to-left in an Arabic UI: ← goes to the next column', () => {
    setLocale('ar');
    const h = harness();
    expect(h.editor.element.classList.contains('is-rtl-sheet')).toBe(true);
    expect(h.wrap.dir).toBe('rtl');
    clickCell(cellEl(h.wrap, 0, 0)!);
    h.key('ArrowLeft');
    expect(h.nameBox.value).toBe('B1');
    setLocale('en');
    const e = harness();
    expect(e.wrap.dir).toBe('ltr');                 // an English UI with English text runs left to right
    clickCell(cellEl(e.wrap, 0, 0)!);
    e.key('ArrowRight');
    expect(e.nameBox.value).toBe('B1');
    setLocale('ar');
  });

  it('Shift+arrows select a block', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 1, 0)!);
    h.key('ArrowDown', { shiftKey: true });
    h.key(nextColumnKey(h), { shiftKey: true });
    expect(h.nameBox.value).toBe('A2:B3');
  });

  it('Ctrl+End goes to the last used cell and Ctrl+Home back to A1', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 1, 0)!);
    h.key('End', { ctrlKey: true });
    expect(h.nameBox.value).toBe('B4');
    h.key('Home', { ctrlKey: true });
    expect(h.nameBox.value).toBe('A1');
  });

  it('Ctrl+arrow jumps to the edge of the data', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 0, 1)!);
    h.key('ArrowDown', { ctrlKey: true });
    expect(h.nameBox.value).toBe('B4');
  });

  it('a typed key starts a new entry that Enter commits, moving down', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 1, 1)!);
    h.key('9');
    const editor = openEditor(h.wrap)!;
    expect(editor.value).toBe('9');                 // the key replaced the content, as in Excel
    editor.value = '95';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    expect(h.fx.value).toBe('95');                  // the formula bar follows the entry
    h.key('Enter', {}, editor);
    expect(h.model().grids[0].rows[1][1]).toBe('95');
    expect(h.commits).toHaveLength(1);
    expect(openEditor(h.wrap)).toBeNull();
    expect(h.nameBox.value).toBe('B3');
  });

  it('Tab commits and moves right; an arrow commits a typed entry', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 1, 0)!);
    h.key('z');
    h.key('Tab', {}, openEditor(h.wrap)!);
    expect(h.model().grids[0].rows[1][0]).toBe('z');
    expect(h.nameBox.value).toBe('B2');
    h.key('7');
    h.key('ArrowDown', {}, openEditor(h.wrap)!);
    expect(h.model().grids[0].rows[1][1]).toBe('7');
    expect(h.nameBox.value).toBe('B3');
  });

  it('Esc cancels the entry and the cell keeps what it had', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 2, 0)!);
    h.key('q');
    h.key('Escape', {}, openEditor(h.wrap)!);
    expect(h.model().grids[0].rows[2][0]).toBe('b');
    expect(h.commits).toHaveLength(0);
    expect(shownAt(h.wrap, 2, 0)).toBe('b');
  });

  it('F2 edits the content in place, and arrows then move the caret, not the cell', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 3, 0)!);
    h.key('F2');
    const editor = openEditor(h.wrap)!;
    expect(editor.value).toBe('c');
    h.key('ArrowLeft', {}, editor);
    expect(openEditor(h.wrap)).toBe(editor);        // still editing
    editor.value = 'cc';
    h.key('Enter', {}, editor);
    expect(h.model().grids[0].rows[3][0]).toBe('cc');
  });

  it('Delete clears the selection as one edit', () => {
    const h = harness();
    h.nameBox.value = 'A2:B3';
    h.nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    h.key('Delete');
    expect(h.model().grids[0].rows.slice(1, 3)).toEqual([['', ''], ['', '']]);
    expect(h.commits).toHaveLength(1);
  });

  it('typing in the formula bar writes the active cell on Enter', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 1, 1)!);
    h.fx.value = '=1+1';
    h.fx.dispatchEvent(new Event('input', { bubbles: true }));
    h.key('Enter', {}, h.fx);
    expect(h.model().grids[0].rows[1][1]).toBe('2');
    expect(formulaAt(h.model(), 0, 1, 1)).toBe('=1+1');
  });

  it('a read-only sheet moves but never opens the editor', () => {
    const h = harness(sheet(), false);
    clickCell(cellEl(h.wrap, 1, 0)!);
    h.key('x');
    h.key('F2');
    expect(openEditor(h.wrap)).toBeNull();
    h.key('ArrowDown');
    expect(h.nameBox.value).toBe('A3');
  });
});

describe('copy and paste', () => {
  function clip(text = ''): DataTransfer {
    const store = new Map<string, string>([['text/plain', text]]);
    return { getData: (k: string) => store.get(k) ?? '', setData: (k: string, v: string) => { store.set(k, v); } } as unknown as DataTransfer;
  }
  function clipEvent(type: string, data: DataTransfer): Event {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: data });
    return ev;
  }

  it('copies the selection as TSV', () => {
    const h = harness();
    h.nameBox.value = 'A1:B2';
    h.nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    h.wrap.focus();
    const data = clip();
    h.wrap.dispatchEvent(clipEvent('copy', data));
    expect(data.getData('text/plain')).toBe('Name\tQty\na\t1');
  });

  it('pastes a TSV block from the active cell, as one edit, and selects it', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 1, 0)!);
    h.wrap.focus();
    h.wrap.dispatchEvent(clipEvent('paste', clip('x\t10\ny\t20\n')));
    expect(h.model().grids[0].rows.slice(1, 3)).toEqual([['x', '10'], ['y', '20']]);
    expect(h.commits).toHaveLength(1);
    expect(h.nameBox.value).toBe('A2:B3');
  });

  it('pastes a single value into the active cell', () => {
    const h = harness();
    clickCell(cellEl(h.wrap, 2, 1)!);
    h.wrap.focus();
    h.wrap.dispatchEvent(clipEvent('paste', clip('42')));
    expect(h.model().grids[0].rows[2][1]).toBe('42');
  });
});
