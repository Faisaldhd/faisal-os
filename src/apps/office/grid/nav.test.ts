import { describe, expect, it } from 'vitest';
import { arrowStep, editorKey, gridKey, isPrintable, jumpTarget, lastUsedCell, type GridKeyState } from './nav';

const rows = [
  ['a', 'b', '', 'd'],
  ['1', '', '', '4'],
  ['2', '', '', ''],
  ['', '', '', ''],
  ['5', '', '', ''],
];
const filled = (r: number, c: number): boolean => (rows[r]?.[c] ?? '') !== '';
const bounds = { lastRow: 9, lastCol: 5 };

function state(over: Partial<GridKeyState> = {}): GridKeyState {
  return { active: { row: 0, col: 0 }, rtl: false, bounds, page: 10, lastUsed: lastUsedCell(rows), filled, editable: true, ...over };
}

describe('sheet keyboard: arrows', () => {
  it('moves one cell, and mirrors ← → in a right-to-left sheet', () => {
    expect(arrowStep('ArrowRight', false)).toEqual({ dr: 0, dc: 1 });
    expect(arrowStep('ArrowRight', true)).toEqual({ dr: 0, dc: -1 });
    expect(arrowStep('ArrowLeft', true)).toEqual({ dr: 0, dc: 1 });
    expect(arrowStep('ArrowDown', true)).toEqual({ dr: 1, dc: 0 });
    expect(arrowStep('x', false)).toBeNull();
  });

  it('stays inside the sheet', () => {
    expect(gridKey({ key: 'ArrowUp' }, state())).toEqual({ kind: 'move', to: { row: 0, col: 0 }, extend: false });
    expect(gridKey({ key: 'ArrowLeft' }, state())).toEqual({ kind: 'move', to: { row: 0, col: 0 }, extend: false });
    expect(gridKey({ key: 'ArrowRight' }, state({ active: { row: 0, col: 5 } }))).toMatchObject({ kind: 'move', to: { col: 5 } });
  });

  it('Shift extends the selection instead of moving it', () => {
    expect(gridKey({ key: 'ArrowDown', shiftKey: true }, state())).toEqual({ kind: 'move', to: { row: 1, col: 0 }, extend: true });
  });

  it('← in a right-to-left sheet goes to the next column', () => {
    expect(gridKey({ key: 'ArrowLeft' }, state({ rtl: true }))).toMatchObject({ to: { row: 0, col: 1 } });
  });
});

describe('sheet keyboard: Ctrl jumps', () => {
  it('runs to the end of a filled block', () => {
    expect(jumpTarget({ row: 0, col: 0 }, 1, 0, filled, bounds)).toEqual({ row: 2, col: 0 });
  });
  it('from the end of a block jumps to the next filled cell', () => {
    expect(jumpTarget({ row: 2, col: 0 }, 1, 0, filled, bounds)).toEqual({ row: 4, col: 0 });
  });
  it('goes to the edge when nothing lies ahead', () => {
    expect(jumpTarget({ row: 4, col: 0 }, 1, 0, filled, bounds)).toEqual({ row: 9, col: 0 });
    expect(jumpTarget({ row: 0, col: 3 }, 0, 1, filled, bounds)).toEqual({ row: 0, col: 5 });
  });
  it('skips the gap across a row', () => {
    expect(jumpTarget({ row: 0, col: 1 }, 0, 1, filled, bounds)).toEqual({ row: 0, col: 3 });
  });
  it('Ctrl+Home is A1 and Ctrl+End the last used cell', () => {
    expect(gridKey({ key: 'Home', ctrlKey: true }, state({ active: { row: 4, col: 3 } }))).toMatchObject({ to: { row: 0, col: 0 } });
    expect(gridKey({ key: 'End', ctrlKey: true }, state())).toMatchObject({ to: { row: 4, col: 3 } });
    expect(gridKey({ key: 'Home' }, state({ active: { row: 4, col: 3 } }))).toMatchObject({ to: { row: 4, col: 0 } });
  });
  it('Ctrl+Shift+arrow extends to the edge of the data', () => {
    expect(gridKey({ key: 'ArrowDown', ctrlKey: true, shiftKey: true }, state())).toEqual({ kind: 'move', to: { row: 2, col: 0 }, extend: true });
  });
});

describe('sheet keyboard: entering data', () => {
  it('a printable key starts a new entry with that character', () => {
    expect(gridKey({ key: 'ب' }, state())).toEqual({ kind: 'edit', text: 'ب' });
    expect(gridKey({ key: '=' }, state())).toEqual({ kind: 'edit', text: '=' });
    expect(isPrintable({ key: 'c', ctrlKey: true })).toBe(false);
    expect(isPrintable({ key: 'Shift' })).toBe(false);
  });
  it('F2 edits in place; Delete clears; a read-only sheet does neither', () => {
    expect(gridKey({ key: 'F2' }, state())).toEqual({ kind: 'edit', text: null });
    expect(gridKey({ key: 'Delete' }, state())).toEqual({ kind: 'clear' });
    expect(gridKey({ key: 'F2' }, state({ editable: false }))).toEqual({ kind: 'none' });
    expect(gridKey({ key: 'x' }, state({ editable: false }))).toEqual({ kind: 'none' });
  });
  it('Enter and Tab move without extending', () => {
    expect(gridKey({ key: 'Enter', shiftKey: true }, state({ active: { row: 3, col: 1 } }))).toEqual({ kind: 'move', to: { row: 2, col: 1 }, extend: false });
    expect(gridKey({ key: 'Tab' }, state())).toEqual({ kind: 'move', to: { row: 0, col: 1 }, extend: false });
  });
  it('Ctrl+A selects everything', () => {
    expect(gridKey({ key: 'a', ctrlKey: true }, state())).toEqual({ kind: 'selectAll' });
  });
});

describe('the floating editor', () => {
  it('commits and moves on Enter and Tab, cancels on Esc', () => {
    expect(editorKey({ key: 'Enter' }, 'edit', false)).toEqual({ kind: 'commit', dr: 1, dc: 0 });
    expect(editorKey({ key: 'Tab', shiftKey: true }, 'edit', false)).toEqual({ kind: 'commit', dr: 0, dc: -1 });
    expect(editorKey({ key: 'Escape' }, 'enter', false)).toEqual({ kind: 'cancel' });
  });
  it('arrows commit a typed entry but move the caret after F2', () => {
    expect(editorKey({ key: 'ArrowDown' }, 'enter', false)).toEqual({ kind: 'commit', dr: 1, dc: 0 });
    expect(editorKey({ key: 'ArrowLeft' }, 'enter', true)).toEqual({ kind: 'commit', dr: 0, dc: 1 });
    expect(editorKey({ key: 'ArrowDown' }, 'edit', false)).toEqual({ kind: 'type' });
  });
  it('leaves an IME composition alone', () => {
    expect(editorKey({ key: 'Enter', isComposing: true }, 'enter', false)).toEqual({ kind: 'type' });
  });
});

describe('lastUsedCell', () => {
  it('finds the far corner of the data', () => {
    expect(lastUsedCell(rows)).toEqual({ row: 4, col: 3 });
    expect(lastUsedCell([])).toEqual({ row: 0, col: 0 });
  });
});
