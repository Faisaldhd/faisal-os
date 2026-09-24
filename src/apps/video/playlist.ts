/**
 * The player's playlist and trim selection — pure, no DOM.
 *
 * Player mode is the "just watch it" side of the app: a playlist drawer of
 * clips (add several, drag to reorder, tap to switch) and a trim bar with two
 * handles whose selection can be saved on its own. The editor's timeline is a
 * separate mode; this module only knows about the playlist.
 */
import { clamp } from './time';

export interface PlaylistItem {
  /** Playlist entry id (the same media may be listed twice). */
  id: string;
  mediaId: string;
  /** Trim selection in source seconds; `out === null` means "to the end". */
  in: number;
  out: number | null;
}

export interface Playlist {
  items: PlaylistItem[];
  /** Index of the item on screen, or -1 when the list is empty. */
  current: number;
}

export const EMPTY_PLAYLIST: Playlist = { items: [], current: -1 };

/** Shortest selection the trim handles allow. */
export const MIN_SELECTION = 0.1;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `p${seq}`;
}

/** Adds media to the end; the first item added becomes current. */
export function addToPlaylist(list: Playlist, mediaIds: readonly string[]): Playlist {
  const items = [...list.items, ...mediaIds.map((mediaId) => ({ id: nextId(), mediaId, in: 0, out: null }))];
  return { items, current: list.current < 0 && items.length ? 0 : list.current };
}

/** Moves an item and keeps the same item current. */
export function reorderPlaylist(list: Playlist, from: number, to: number): Playlist {
  if (from < 0 || from >= list.items.length) return list;
  const target = clamp(Math.round(to), 0, list.items.length - 1);
  if (target === from) return list;
  const currentId = list.items[list.current]?.id;
  const items = list.items.slice();
  const [item] = items.splice(from, 1);
  items.splice(target, 0, item);
  return { items, current: currentId ? items.findIndex((i) => i.id === currentId) : list.current };
}

/** Removes an item; the current index follows the item that was playing, or its neighbour. */
export function removeFromPlaylist(list: Playlist, index: number): Playlist {
  if (index < 0 || index >= list.items.length) return list;
  const items = list.items.filter((_, i) => i !== index);
  let current = list.current;
  if (items.length === 0) current = -1;
  else if (index < current) current -= 1;
  else if (index === current) current = Math.min(current, items.length - 1);
  return { items, current };
}

export function selectItem(list: Playlist, index: number): Playlist {
  if (index < 0 || index >= list.items.length) return list;
  return { ...list, current: index };
}

/** The next index after the current one, or -1 at the end (no wrap unless `loop`). */
export function nextIndex(list: Playlist, loop = false): number {
  if (list.items.length === 0) return -1;
  const next = list.current + 1;
  if (next < list.items.length) return next;
  return loop ? 0 : -1;
}

export function previousIndex(list: Playlist): number {
  if (list.items.length === 0) return -1;
  return Math.max(0, list.current - 1);
}

/**
 * Moves one trim handle, keeping at least MIN_SELECTION between them and both
 * inside the file. Returns the new `{in, out}` with `out` resolved.
 */
export function moveTrimHandle(
  selection: { in: number; out: number | null },
  handle: 'in' | 'out',
  at: number,
  duration: number,
): { in: number; out: number } {
  const d = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const out = selection.out === null ? d : clamp(selection.out, 0, d);
  const inPoint = clamp(selection.in, 0, d);
  const min = Math.min(MIN_SELECTION, d);
  const value = Number.isFinite(at) ? at : 0;
  if (handle === 'in') return { in: clamp(value, 0, Math.max(0, out - min)), out };
  return { in: inPoint, out: clamp(value, Math.min(d, inPoint + min), d) };
}

/** True when the selection is the whole file (nothing to "save selection" of). */
export function isWholeFile(selection: { in: number; out: number | null }, duration: number): boolean {
  return selection.in <= 0.001 && (selection.out === null || selection.out >= duration - 0.001);
}
