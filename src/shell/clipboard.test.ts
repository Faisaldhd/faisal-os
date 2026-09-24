import { describe, expect, it } from 'vitest';
import { addEntry, parseHistory, preview, MAX_ENTRIES, MAX_ENTRY_CHARS } from './clipboard';

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
