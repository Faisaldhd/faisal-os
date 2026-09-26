/**
 * Writer — keyboard shortcuts, `dir="auto"` paragraphs, the selection a shortcut formats, and the
 * right-click menu (اختصارات لوحة المفاتيح واتجاه الفقرة وقائمة الزر الأيمن).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../editor';
import type { DocModel } from '../model';
import '../strings';
import './strings';
import { t } from '../../../kernel/i18n';
import { autoDirection, shortcutOf, typedDirection, type KeyLike } from './keys';
import { tableOp, type CellItem } from './tableops';
import { blockText, type DocBlock, type TextRun } from './types';
import { createWriter } from './view';

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...extra });

describe('shortcutOf — what a key press means', () => {
  it('maps the Word shortcuts', () => {
    expect(shortcutOf(key('b'))).toBe('bold');
    expect(shortcutOf(key('i'))).toBe('italic');
    expect(shortcutOf(key('u'))).toBe('underline');
    expect(shortcutOf(key('e'))).toBe('alignCenter');
    expect(shortcutOf(key('l'))).toBe('alignLeft');
    expect(shortcutOf(key('r'))).toBe('alignRight');
    expect(shortcutOf(key('j'))).toBe('alignJustify');
    expect(shortcutOf(key('k'))).toBe('link');
    expect(shortcutOf(key('m'))).toBe('indent');
    expect(shortcutOf(key('M', { shiftKey: true }))).toBe('outdent');
    expect(shortcutOf(key('X', { shiftKey: true }))).toBe('strike');
    expect(shortcutOf(key('='))).toBe('subscript');
    expect(shortcutOf(key('+', { shiftKey: true }))).toBe('superscript');
    expect(shortcutOf(key(' ', { code: 'Space' }))).toBe('clearFormat');
    expect(shortcutOf(key('Enter'))).toBe('pageBreak');
    expect(shortcutOf(key('a'))).toBe('selectAll');
    expect(shortcutOf(key('f'))).toBe('find');
    expect(shortcutOf(key('h'))).toBe('replace');
    expect(shortcutOf(key('p'))).toBe('print');
  });

  it('maps Ctrl+Home / Ctrl+End, and with Shift extends the selection', () => {
    expect(shortcutOf(key('Home'))).toBe('docStart');
    expect(shortcutOf(key('End'))).toBe('docEnd');
    expect(shortcutOf(key('Home', { shiftKey: true }))).toBe('docStartExtend');
    expect(shortcutOf(key('End', { shiftKey: true }))).toBe('docEndExtend');
  });

  it('reads the physical key on an Arabic layout (Ctrl + the B key types "لا")', () => {
    expect(shortcutOf(key('لا', { code: 'KeyB' }))).toBe('bold');
    expect(shortcutOf(key('ه', { code: 'KeyI' }))).toBe('italic');
  });

  it('ignores keys without Ctrl/⌘, with Alt, and the ones the window owns', () => {
    expect(shortcutOf(key('b', { ctrlKey: false }))).toBeNull();
    expect(shortcutOf(key('b', { altKey: true }))).toBeNull();
    expect(shortcutOf(key('s'))).toBeNull();
    expect(shortcutOf(key('z'))).toBeNull();
    expect(shortcutOf(key('b', { ctrlKey: false, metaKey: true }))).toBe('bold');
  });
});

describe('dir="auto" — a paragraph takes the direction of its first letters', () => {
  it('turns an empty paragraph to the direction of what is typed first', () => {
    expect(typedDirection('', 'Hello', 'rtl')).toBe('ltr');
    expect(typedDirection('', 'مرحبا', 'ltr')).toBe('rtl');
    expect(typedDirection('  12 ', 'مرحبا', 'ltr')).toBe('rtl');
  });

  it('leaves a paragraph that already has letters, or that already reads that way', () => {
    expect(typedDirection('Hi', 'مرحبا', 'ltr')).toBeNull();
    expect(typedDirection('', 'Hello', 'ltr')).toBeNull();
    expect(typedDirection('', '123 ', 'rtl')).toBeNull();
  });

  it('reads the first strong letter', () => {
    expect(autoDirection('1. Hello')).toBe('ltr');
    expect(autoDirection('— مرحبا Hello')).toBe('rtl');
    expect(autoDirection('2024')).toBeNull();
  });
});

describe('tableOp — rows and columns of a new table', () => {
  const cells = (rows: number, cols: number): CellItem[] => {
    const out: CellItem[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ block: { id: r * cols + c, runs: [{ t: 'text', text: `${r}${c}`, props: {} }], cell: { table: 7, row: r, col: c, rows, cols } }, format: undefined });
    return out;
  };
  const grid = (items: CellItem[]): string[] => items.map((it) => blockText(it.block) || '_');
  let id = 100;
  const next = (): number => id++;

  it('inserts a row below and above, in reading order, with the new size on every cell', () => {
    const below = tableOp(cells(2, 2), 'rowBelow', 0, 0, next) ?? [];
    expect(grid(below)).toEqual(['00', '01', '_', '_', '10', '11']);
    expect(below.every((it) => it.block.cell?.rows === 3 && it.block.cell?.cols === 2)).toBe(true);
    const above = tableOp(cells(2, 2), 'rowAbove', 0, 0, next) ?? [];
    expect(grid(above)).toEqual(['_', '_', '00', '01', '10', '11']);
  });

  it('inserts and deletes columns', () => {
    expect(grid(tableOp(cells(2, 2), 'colAfter', 0, 0, next) ?? [])).toEqual(['00', '_', '01', '10', '_', '11']);
    expect(grid(tableOp(cells(2, 2), 'colBefore', 0, 0, next) ?? [])).toEqual(['_', '00', '01', '_', '10', '11']);
    expect(grid(tableOp(cells(2, 3), 'deleteCol', 1, 1, next) ?? [])).toEqual(['00', '02', '10', '12']);
  });

  it('deletes a row, and refuses to delete the last one (the table goes instead)', () => {
    expect(grid(tableOp(cells(3, 1), 'deleteRow', 1, 0, next) ?? [])).toEqual(['00', '20']);
    expect(tableOp(cells(1, 2), 'deleteRow', 0, 0, next)).toBeNull();
  });

  it('gives every cell a fresh id and one fresh table id, so the save writes the table anew', () => {
    const out = tableOp(cells(2, 2), 'rowBelow', 1, 1, next) ?? [];
    const ids = out.map((it) => it.block.id);
    expect(ids.every((n) => n >= 100)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(out.map((it) => it.block.cell?.table)).size).toBe(1);
  });
});

/* ─────────────────────────── the editor itself ─────────────────────────── */

const live: Array<{ dispose(): void }> = [];
afterEach(() => { while (live.length) live.pop()?.dispose(); document.body.textContent = ''; });

function mount(blocks: DocBlock[], formats?: DocModel['formats']) {
  let model: DocModel = { kind: 'docx', paragraphs: blocks.map(blockText), blocks, ...(formats ? { formats } : {}) };
  const office = document.createElement('div');
  office.className = 'faisal-office';
  document.body.append(office);
  const ctx: EditorContext = {
    model: () => model,
    commit: (edit) => { model = edit.apply(model) as DocModel; },
    undo: () => undefined,
    redo: () => undefined,
    editable: () => true,
    refresh: () => undefined,
    setStatus: () => undefined,
    host: () => office,
    filePath: () => null,
    fileTab: () => ({ id: 'file', label: 'File', groups: [] }),
    exportFile: async () => undefined,
    print: () => undefined,
  };
  const editor = createWriter(ctx, null);
  office.append(editor.element);
  editor.render();
  live.push(editor);
  const flow = (): HTMLElement => editor.element.querySelector<HTMLElement>('.fo-flow') as HTMLElement;
  const press = (k: string, extra: Partial<KeyboardEventInit> = {}): boolean => {
    const ev = new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true, ...extra });
    flow().dispatchEvent(ev);
    return editor.onKey?.(ev) ?? false;
  };
  return { editor, office, flow, press, model: () => model };
}

function select(anchor: Node, a: number, focus: Node, f: number): void {
  const s = window.getSelection() as Selection;
  s.removeAllRanges();
  const range = document.createRange();
  range.setStart(anchor, a);
  range.setEnd(focus, f);
  s.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

const textRuns = (block: DocBlock | undefined): TextRun[] => (block?.runs ?? []).filter((r): r is TextRun => r.t === 'text' && !!r.text);

describe('the Writer keyboard', () => {
  it('Ctrl+B formats exactly the selected word, even before selectionchange has arrived', () => {
    const m = mount([{ id: 0, runs: [{ t: 'text', text: 'Hello world', props: {} }] }]);
    const text = m.flow().querySelector('.fo-r')?.firstChild as Text;
    // No selectionchange: the browser has not told the editor yet.
    const s = window.getSelection() as Selection;
    s.removeAllRanges();
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 11);
    s.addRange(range);
    expect(m.press('b')).toBe(true);
    expect(textRuns(m.model().blocks?.[0]).map((r) => [r.text, r.props.b ?? false])).toEqual([['Hello ', false], ['world', true]]);
  });

  it('Ctrl+A then Ctrl+I formats every paragraph (the selection ends sit on the page, not in a paragraph)', () => {
    const m = mount([{ id: 0, runs: [{ t: 'text', text: 'one', props: {} }] }, { id: 1, runs: [{ t: 'text', text: 'two', props: {} }] }]);
    select(m.flow(), 0, m.flow(), m.flow().childNodes.length);
    expect(m.press('i')).toBe(true);
    expect(m.model().blocks?.every((b) => textRuns(b).every((r) => r.props.i === true))).toBe(true);
  });

  it('Ctrl+B with no selection formats the next letters there only — moving away drops it', () => {
    const m = mount([{ id: 0, runs: [{ t: 'text', text: 'abc', props: {} }] }, { id: 1, runs: [{ t: 'text', text: 'xyz', props: {} }] }]);
    const first = m.flow().querySelectorAll('.fo-r')[0].firstChild as Text;
    const second = m.flow().querySelectorAll('.fo-r')[1].firstChild as Text;
    select(first, 3, first, 3);
    m.press('b');
    select(second, 1, second, 1);
    m.flow().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'Q', bubbles: true, cancelable: true }));
    expect(textRuns(m.model().blocks?.[1]).every((r) => !r.props.b)).toBe(true);
    expect(blockText(m.model().blocks?.[1] as DocBlock)).toBe('xQyz');
  });

  it('Ctrl+End and Ctrl+Home put the caret at the very end and start of the document', () => {
    const m = mount([{ id: 0, runs: [{ t: 'text', text: 'first', props: {} }] }, { id: 1, runs: [{ t: 'text', text: 'last line', props: {} }] }]);
    m.flow().focus();
    expect(m.press('End')).toBe(true);
    m.flow().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '!', bubbles: true, cancelable: true }));
    expect(m.press('Home')).toBe(true);
    m.flow().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '>', bubbles: true, cancelable: true }));
    expect(m.model().paragraphs).toEqual(['>first', 'last line!']);
  });

  it('keeps a dialog’s text field to itself: Ctrl+B typed there formats nothing', () => {
    const m = mount([{ id: 0, runs: [{ t: 'text', text: 'Hello', props: {} }] }]);
    const input = document.createElement('input');
    m.office.append(input);
    const ev = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true });
    input.dispatchEvent(ev);
    expect(m.editor.onKey?.(ev)).toBe(false);
  });
});

describe('paragraph direction on the page', () => {
  it('draws a paragraph whose direction nothing states with dir="auto"', () => {
    const m = mount([{ id: 0, runs: [{ t: 'text', text: 'Hello', props: {} }] }, { id: 1, runs: [{ t: 'text', text: 'مرحبا', props: {} }] }], { 1: { dir: 'rtl' } });
    const paras = [...m.flow().querySelectorAll<HTMLElement>('.fo-p')];
    expect(paras[0].dir).toBe('auto');
    expect(paras[1].dir).toBe('rtl');
  });

  it('turns an empty right-to-left paragraph left-to-right when English is typed into it (and back for Arabic)', () => {
    const m = mount([{ id: 0, runs: [{ t: 'text', text: '', props: {} }] }, { id: 1, runs: [{ t: 'text', text: '', props: {} }] }], { 0: { dir: 'rtl' } });
    const [p0, p1] = [...m.flow().querySelectorAll<HTMLElement>('.fo-p')];
    select(p0, 0, p0, 0);
    m.flow().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'H', bubbles: true, cancelable: true }));
    expect(m.model().formats?.[0]?.dir).toBe('ltr');
    select(p1, 0, p1, 0);
    m.flow().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'م', bubbles: true, cancelable: true }));
    expect(m.model().formats?.[1]?.dir).toBe('rtl');
    expect([...m.flow().querySelectorAll<HTMLElement>('.fo-p')].map((p) => p.dir)).toEqual(['ltr', 'rtl']);
  });
});

describe('the right-click menu', () => {
  it('opens at the pointer with cut/copy/paste, font, paragraph and link', () => {
    const m = mount([{ id: 0, runs: [{ t: 'text', text: 'Hello', props: {} }] }]);
    m.flow().querySelector('.fo-p')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }));
    const labels = [...m.office.querySelectorAll('.fo-menu-item .fo-menu-label')].map((n) => n.textContent);
    expect(labels).toEqual(expect.arrayContaining([t('office.wCut'), t('office.wCopy'), t('office.wPaste'), t('office.wFont'), t('office.wParagraph'), t('office.wLink')]));
    expect(labels).not.toContain(t('office.wRowBelow'));
  });

  it('adds the table commands in a table, and "Insert row below" grows it', () => {
    const cell = (id: number, row: number, col: number): DocBlock => ({ id, runs: [{ t: 'text', text: `c${id}`, props: {} }], cell: { table: 9, row, col, rows: 1, cols: 2 } });
    const m = mount([cell(0, 0, 0), cell(1, 0, 1), { id: 2, runs: [{ t: 'text', text: 'after', props: {} }] }]);
    const text = m.flow().querySelector('td .fo-r')?.firstChild as Text;
    select(text, 1, text, 1);
    text.parentElement?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const item = [...m.office.querySelectorAll<HTMLButtonElement>('.fo-menu-item')].find((b) => b.textContent?.includes(t('office.wRowBelow')));
    expect(item?.disabled).toBe(false);
    item?.click();
    const cells = (m.model().blocks ?? []).filter((b) => b.cell);
    expect(cells).toHaveLength(4);
    expect(cells.every((b) => b.cell?.rows === 2)).toBe(true);
    expect(m.model().paragraphs).toEqual(['c0', 'c1', '', '', 'after']);
  });
});
