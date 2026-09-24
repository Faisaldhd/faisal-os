import { describe, expect, it } from 'vitest';
import {
  addEntry, isClipboardChord, mountClipboard, parseHistory, placePanel, preview,
  MAX_ENTRIES, MAX_ENTRY_CHARS,
} from './clipboard';
import type { SystemAPI } from '../kernel/types';

describe('clipboard history', () => {
  it('keeps the newest first and moves a repeat to the top', () => {
    let list = addEntry([], 'a', 1);
    list = addEntry(list, 'b', 2);
    list = addEntry(list, 'a', 3);
    expect(list.map((e) => e.text)).toEqual(['a', 'b']);
    expect(list[0].time).toBe(3);
  });

  it('ignores blank text and caps size and length', () => {
    const start = addEntry([], 'x', 1);
    expect(addEntry(start, '   \n', 2)).toBe(start);
    let list: ReturnType<typeof addEntry> = [];
    for (let i = 0; i < MAX_ENTRIES + 10; i++) list = addEntry(list, `t${i}`, i);
    expect(list).toHaveLength(MAX_ENTRIES);
    expect(list[0].text).toBe(`t${MAX_ENTRIES + 9}`);
    expect(addEntry([], 'y'.repeat(MAX_ENTRY_CHARS + 50), 1)[0].text).toHaveLength(MAX_ENTRY_CHARS);
  });

  it('reads stored history tolerantly', () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory('{bad')).toEqual([]);
    expect(parseHistory('[{"text":"ok","time":1},{"text":5},null]')).toEqual([{ text: 'ok', time: 1 }]);
  });

  it('previews on one line', () => {
    expect(preview('  سطر\nثاني\t ثالث ')).toBe('سطر ثاني ثالث');
    expect(preview('z'.repeat(500)).length).toBe(220);
  });
});

// The panel is a floating one: it opens where the pointer is, and it must stay on screen on a
// 320px phone where it is nearly as wide as the viewport.
describe('clipboard panel placement', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 300, height: 200 };

  it('opens just below and after the pointer', () => {
    expect(placePanel({ x: 100, y: 100 }, size, viewport)).toEqual({ left: 112, top: 112 });
  });

  it('flips to the other side near the right and bottom edges', () => {
    expect(placePanel({ x: 950, y: 100 }, size, viewport)).toEqual({ left: 638, top: 112 });
    expect(placePanel({ x: 100, y: 780 }, size, viewport)).toEqual({ left: 112, top: 568 });
  });

  it('stays inside the viewport even when the panel is wider or taller than it', () => {
    const phone = { width: 320, height: 568 };
    expect(placePanel({ x: 300, y: 500 }, { width: 296, height: 560 }, phone)).toEqual({ left: 8, top: 8 });
    expect(placePanel({ x: 10, y: 10 }, { width: 296, height: 700 }, phone)).toEqual({ left: 8, top: 8 });
  });
});

describe('the clipboard chord', () => {
  const chord = (keys: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => ({
    ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...keys,
  });

  it('accepts Ctrl+Alt+V and Super+V', () => {
    expect(isClipboardChord(chord({ ctrlKey: true, altKey: true }))).toBe(true);
    expect(isClipboardChord(chord({ metaKey: true }))).toBe(true);
  });

  it('opens Super+V no matter what Shift is doing', () => {
    expect(isClipboardChord(chord({ metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('leaves Ctrl+Shift+V to the apps (paste without formatting)', () => {
    expect(isClipboardChord(chord({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(isClipboardChord(chord({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('ignores plain V, Ctrl+V and Ctrl+Alt+Super+V', () => {
    expect(isClipboardChord(chord())).toBe(false);
    expect(isClipboardChord(chord({ ctrlKey: true }))).toBe(false);
    expect(isClipboardChord(chord({ ctrlKey: true, altKey: true, metaKey: true }))).toBe(false);
  });
});

describe('opening the panel from the keyboard', () => {
  it('opens at the last pointer position, even with Shift held down', () => {
    localStorage.clear();
    const panel = mountClipboard({ notify: () => {} } as unknown as SystemAPI);
    expect(document.querySelector('.faisal-clip')).toBeNull();

    // jsdom has no PointerEvent; the tracker only reads clientX/clientY, which MouseEvent has.
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }));
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'v', code: 'KeyV', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }));

    const el = document.querySelector<HTMLElement>('.faisal-clip');
    expect(el).not.toBeNull();
    expect(panel.isOpen()).toBe(true);
    // jsdom lays nothing out, so the panel measures 0×0: this is the pointer plus the 12px gap.
    expect(el!.style.left).toBe('312px');
    expect(el!.style.top).toBe('212px');

    panel.close();
    expect(document.querySelector('.faisal-clip')).toBeNull();
  });
});
