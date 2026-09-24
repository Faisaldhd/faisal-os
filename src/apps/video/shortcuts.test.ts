import { describe, expect, it } from 'vitest';
import { helpRows, isTypingTarget, matchShortcut, shuttle, SHORTCUTS } from './shortcuts';

describe('matchShortcut', () => {
  it('maps the editing keys by physical code (works on an Arabic layout)', () => {
    expect(matchShortcut({ code: 'Space', key: ' ' })).toBe('playPause');
    expect(matchShortcut({ code: 'KeyS', key: 'س' })).toBe('split');
    expect(matchShortcut({ code: 'KeyB', ctrlKey: true })).toBe('split');
    expect(matchShortcut({ code: 'Delete' })).toBe('delete');
    expect(matchShortcut({ code: 'KeyJ' })).toBe('shuttleBack');
    expect(matchShortcut({ code: 'KeyK' })).toBe('shuttleStop');
    expect(matchShortcut({ code: 'KeyL' })).toBe('shuttleForward');
    expect(matchShortcut({ code: 'KeyI' })).toBe('markIn');
    expect(matchShortcut({ code: 'KeyO' })).toBe('markOut');
    expect(matchShortcut({ code: 'Home' })).toBe('goStart');
    expect(matchShortcut({ code: 'End' })).toBe('goEnd');
  });

  it('tells modifier variants apart', () => {
    expect(matchShortcut({ code: 'KeyS', ctrlKey: true })).toBe('save');
    expect(matchShortcut({ code: 'KeyS', ctrlKey: true, shiftKey: true })).toBe('saveAs');
    expect(matchShortcut({ code: 'KeyZ', ctrlKey: true })).toBe('undo');
    expect(matchShortcut({ code: 'KeyZ', metaKey: true, shiftKey: true })).toBe('redo');
    expect(matchShortcut({ code: 'KeyY', ctrlKey: true })).toBe('redo');
    expect(matchShortcut({ code: 'ArrowLeft' })).toBe('frameBack');
    expect(matchShortcut({ code: 'ArrowLeft', shiftKey: true })).toBe('secondBack');
    expect(matchShortcut({ code: 'ArrowRight', shiftKey: true })).toBe('secondForward');
  });

  it('accepts + typed as Shift+Equal, and ignores Alt chords and unknown keys', () => {
    expect(matchShortcut({ code: 'Equal', shiftKey: true })).toBe('zoomIn');
    expect(matchShortcut({ code: 'Minus' })).toBe('zoomOut');
    expect(matchShortcut({ code: 'KeyS', altKey: true })).toBeNull();
    expect(matchShortcut({ code: 'KeyQ' })).toBeNull();
    expect(matchShortcut({ code: 'KeyX', ctrlKey: true })).toBeNull();
  });
});

describe('typing guard', () => {
  it('treats text fields as typing, sliders and buttons as not', () => {
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('help sheet', () => {
  it('lists every bound action once, with all its keys, from the same table', () => {
    const rows = helpRows();
    const actions = new Set(SHORTCUTS.map((s) => s.action));
    expect(rows.map((r) => r.action).sort()).toEqual([...actions].sort());
    expect(rows.find((r) => r.action === 'split')?.keys).toEqual(['Ctrl + B', 'S']);
    expect(rows.find((r) => r.action === 'delete')?.keys).toEqual(['Delete', 'Backspace']);
  });
});

describe('J/K/L shuttle', () => {
  it('speeds up forward and back, and K stops', () => {
    expect(shuttle(0, 'L')).toBe(1);
    expect(shuttle(1, 'L')).toBe(2);
    expect(shuttle(2, 'L')).toBe(4);
    expect(shuttle(4, 'L')).toBe(4);
    expect(shuttle(0, 'J')).toBe(-1);
    expect(shuttle(-1, 'J')).toBe(-2);
    expect(shuttle(2, 'J')).toBe(0);
    expect(shuttle(-4, 'K')).toBe(0);
  });
});
