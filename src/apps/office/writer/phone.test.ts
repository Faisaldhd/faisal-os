/**
 * Writer — the phone layout (الجوال): reading first, then Edit brings a compact bottom bar whose
 * tools follow what the owner is doing (a selection, a table cell, the caret). The desktop ribbon is
 * never squeezed into it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { t } from '../../../kernel/i18n';
import type { EditorContext } from '../editor';
import type { DocModel } from '../model';
import '../strings';
import './strings';
import { blockText, type DocBlock } from './types';
import { createWriter } from './view';

const live: Array<{ dispose(): void }> = [];
afterEach(() => { while (live.length) live.pop()?.dispose(); document.body.textContent = ''; });

function mountPhone(blocks: DocBlock[], width = 390, editable = true) {
  let model: DocModel = { kind: 'docx', paragraphs: blocks.map(blockText), blocks };
  const office = document.createElement('div');
  office.className = 'faisal-office';
  // jsdom has no layout: the window is as wide as a phone.
  Object.defineProperty(office, 'clientWidth', { configurable: true, get: () => width });
  document.body.append(office);
  let undone = 0;
  const ctx: EditorContext = {
    model: () => model,
    commit: (edit) => { model = edit.apply(model) as DocModel; },
    undo: () => { undone++; },
    redo: () => undefined,
    editable: () => editable,
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
  const bar = (): HTMLElement => editor.element.querySelector<HTMLElement>('.fo-wphone') as HTMLElement;
  const labels = (): string[] => [...bar().querySelectorAll('button')].map((b) => b.textContent ?? '');
  const tap = (label: string): void => {
    const b = [...bar().querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === label);
    if (!b) throw new Error(`no ${label} in ${labels().join(',')}`);
    b.click();
  };
  const flow = (): HTMLElement => editor.element.querySelector<HTMLElement>('.fo-flow') as HTMLElement;
  return { editor, office, bar, labels, tap, flow, model: () => model, undone: () => undone };
}

function select(node: Node, from: number, to: number): void {
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const s = window.getSelection() as Selection;
  s.removeAllRanges();
  s.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('the Writer on a phone', () => {
  it('opens the document to read: nothing is editable and the bar offers Edit', () => {
    const m = mountPhone([{ id: 0, runs: [{ t: 'text', text: 'Hello', props: {} }] }]);
    expect(m.flow().contentEditable).toBe('false');
    expect(m.bar().dataset.mode).toBe('read');
    expect(m.labels()).toContain(t('office.wEdit'));
    expect(m.editor.element.classList.contains('is-reading')).toBe(true);
  });

  it('Edit makes the page editable and shows undo, redo, format, insert and done — five tools', () => {
    const m = mountPhone([{ id: 0, runs: [{ t: 'text', text: 'Hello', props: {} }] }]);
    m.tap(t('office.wEdit'));
    expect(m.flow().contentEditable).toBe('true');
    expect(m.labels()).toEqual([t('office.undo'), t('office.redo'), t('office.wMobileFormat'), t('office.wMobileInsert'), t('office.wDoneEditing')]);
    m.tap(t('office.undo'));
    expect(m.undone()).toBe(1);
  });

  it('turns into bold/italic/underline while text is selected, and Bold formats the selection', () => {
    const m = mountPhone([{ id: 0, runs: [{ t: 'text', text: 'Hello world', props: {} }] }]);
    m.tap(t('office.wEdit'));
    select(m.flow().querySelector('.fo-r')?.firstChild as Text, 0, 5);
    expect(m.bar().dataset.mode).toBe('selection');
    expect(m.labels().slice(0, 3)).toEqual([t('office.formatBold'), t('office.formatItalic'), t('office.formatUnderline')]);
    m.tap(t('office.formatBold'));
    const first = m.model().blocks?.[0].runs[0];
    expect(first?.t === 'text' && first.text === 'Hello' && first.props.b).toBe(true);
  });

  it('offers the table’s rows and columns while the caret is in a new table', () => {
    const cell = (id: number, col: number): DocBlock => ({ id, runs: [{ t: 'text', text: `c${id}`, props: {} }], cell: { table: 3, row: 0, col, rows: 1, cols: 2 } });
    const m = mountPhone([cell(0, 0), cell(1, 1)]);
    m.tap(t('office.wEdit'));
    select(m.flow().querySelector('td .fo-r')?.firstChild as Text, 1, 1);
    expect(m.bar().dataset.mode).toBe('table');
    m.tap(t('office.wTableOps'));
    const sheet = m.office.querySelector('.fo-sheet') as HTMLElement;
    expect(sheet).not.toBeNull();
    const below = [...sheet.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === t('office.wRowBelow'));
    below?.click();
    expect((m.model().blocks ?? []).filter((b) => b.cell)).toHaveLength(4);
  });

  it('Done goes back to reading', () => {
    const m = mountPhone([{ id: 0, runs: [{ t: 'text', text: 'Hello', props: {} }] }]);
    m.tap(t('office.wEdit'));
    m.tap(t('office.wDoneEditing'));
    expect(m.flow().contentEditable).toBe('false');
    expect(m.bar().dataset.mode).toBe('read');
  });

  it('a read-only file on a phone says so instead of offering Edit', () => {
    const m = mountPhone([{ id: 0, runs: [{ t: 'text', text: 'Hello', props: {} }] }], 320, false);
    expect(m.labels()).not.toContain(t('office.wEdit'));
    expect(m.bar().textContent).toContain(t('office.wReadOnlyFile'));
  });

  it('a desktop window opens straight into editing', () => {
    const m = mountPhone([{ id: 0, runs: [{ t: 'text', text: 'Hello', props: {} }] }], 1280);
    expect(m.flow().contentEditable).toBe('true');
    expect(m.editor.element.classList.contains('is-reading')).toBe(false);
  });
});
