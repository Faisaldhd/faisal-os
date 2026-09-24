import { describe, expect, it } from 'vitest';
import {
  addToPlaylist,
  EMPTY_PLAYLIST,
  isWholeFile,
  moveTrimHandle,
  nextIndex,
  previousIndex,
  removeFromPlaylist,
  reorderPlaylist,
  selectItem,
} from './playlist';

describe('playlist', () => {
  it('adds clips and makes the first one current', () => {
    const list = addToPlaylist(EMPTY_PLAYLIST, ['a', 'b', 'c']);
    expect(list.items.map((i) => i.mediaId)).toEqual(['a', 'b', 'c']);
    expect(list.current).toBe(0);
    expect(addToPlaylist(selectItem(list, 2), ['d']).current).toBe(2);
  });

  it('keeps the same clip playing when the list is reordered', () => {
    let list = selectItem(addToPlaylist(EMPTY_PLAYLIST, ['a', 'b', 'c']), 1);
    list = reorderPlaylist(list, 1, 0);
    expect(list.items.map((i) => i.mediaId)).toEqual(['b', 'a', 'c']);
    expect(list.current).toBe(0);
    list = reorderPlaylist(list, 2, 0);
    expect(list.items.map((i) => i.mediaId)).toEqual(['c', 'b', 'a']);
    expect(list.items[list.current].mediaId).toBe('b');
  });

  it('removes items and moves the current index sensibly', () => {
    let list = selectItem(addToPlaylist(EMPTY_PLAYLIST, ['a', 'b', 'c']), 2);
    list = removeFromPlaylist(list, 0);
    expect(list.items[list.current].mediaId).toBe('c');
    list = removeFromPlaylist(list, 1);
    expect(list.current).toBe(0);
    list = removeFromPlaylist(list, 0);
    expect(list.current).toBe(-1);
  });

  it('steps next and previous, wrapping only when looping', () => {
    const list = selectItem(addToPlaylist(EMPTY_PLAYLIST, ['a', 'b']), 1);
    expect(nextIndex(list)).toBe(-1);
    expect(nextIndex(list, true)).toBe(0);
    expect(previousIndex(list)).toBe(0);
    expect(nextIndex(EMPTY_PLAYLIST)).toBe(-1);
  });
});

describe('trim handles', () => {
  it('keeps the handles apart and inside the file', () => {
    expect(moveTrimHandle({ in: 0, out: null }, 'in', 3, 10)).toEqual({ in: 3, out: 10 });
    expect(moveTrimHandle({ in: 0, out: 5 }, 'in', 9, 10)).toEqual({ in: 4.9, out: 5 });
    expect(moveTrimHandle({ in: 4, out: 5 }, 'out', 1, 10)).toEqual({ in: 4, out: 4.1 });
    expect(moveTrimHandle({ in: 0, out: null }, 'out', 99, 10)).toEqual({ in: 0, out: 10 });
  });

  it('knows when the selection is the whole file', () => {
    expect(isWholeFile({ in: 0, out: null }, 10)).toBe(true);
    expect(isWholeFile({ in: 0, out: 10 }, 10)).toBe(true);
    expect(isWholeFile({ in: 1, out: 10 }, 10)).toBe(false);
  });
});
