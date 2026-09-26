/**
 * Sheet keyboard — where a key takes the active cell, as pure functions.
 *
 * The sheet has ONE floating editor instead of a text field per cell, so the keyboard is no
 * longer the browser's: the grid decides what every key means. The rules are Excel's (and
 * WPS's): arrows move, Shift extends, Ctrl jumps to the edge of the data, Enter/Tab move after
 * a commit, F2 edits in place, a printable key starts a new entry, Esc cancels. In a
 * right-to-left sheet column A is on the right, so ← moves to the NEXT column.
 *
 * Nothing here touches the DOM; `view.ts` feeds it the key and draws what it returns.
 */

export interface CellPos { row: number; col: number }

/** The drawn extent the caret may move in: the last row and column (inclusive). */
export interface NavBounds { lastRow: number; lastCol: number }

/** What a key does while the grid (not the editor) has the focus. */
export type GridAction =
  | { kind: 'move'; to: CellPos; extend: boolean }
  | { kind: 'edit'; text: string | null }   // null: F2 (keep the content), text: a new entry
  | { kind: 'clear' }
  | { kind: 'selectAll' }
  | { kind: 'none' };

/** What a key does while the floating editor is open. */
export type EditorAction =
  | { kind: 'commit'; dr: number; dc: number }
  | { kind: 'cancel' }
  | { kind: 'type' };                        // the input keeps the key (caret moves, text changes)

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/** The row and column step of an arrow key; ← and → swap in a right-to-left sheet. */
export function arrowStep(key: string, rtl: boolean): { dr: number; dc: number } | null {
  switch (key) {
    case 'ArrowUp': return { dr: -1, dc: 0 };
    case 'ArrowDown': return { dr: 1, dc: 0 };
    case 'ArrowLeft': return { dr: 0, dc: rtl ? 1 : -1 };
    case 'ArrowRight': return { dr: 0, dc: rtl ? -1 : 1 };
    default: return null;
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Ctrl+arrow: Excel's jump. From a filled cell whose neighbour is filled too, go to the last
 * filled cell of that run; otherwise go to the next filled cell, or to the sheet's edge when
 * there is none.
 */
export function jumpTarget(from: CellPos, dr: number, dc: number, filled: (row: number, col: number) => boolean, bounds: NavBounds): CellPos {
  const inside = (p: CellPos): boolean => p.row >= 0 && p.col >= 0 && p.row <= bounds.lastRow && p.col <= bounds.lastCol;
  const step = (p: CellPos): CellPos => ({ row: p.row + dr, col: p.col + dc });
  let at = from;
  let next = step(at);
  if (!inside(next)) return at;
  if (filled(at.row, at.col) && filled(next.row, next.col)) {
    while (inside(next) && filled(next.row, next.col)) { at = next; next = step(at); }
    return at;
  }
  at = next;
  while (inside(at) && !filled(at.row, at.col)) {
    const n = step(at);
    if (!inside(n)) return at;
    at = n;
  }
  return at;
}

/** A key that types a character (and so starts a new entry in the active cell). */
export function isPrintable(ev: KeyLike): boolean {
  if (ev.ctrlKey || ev.metaKey || ev.isComposing) return false;
  return [...ev.key].length === 1;
}

export interface GridKeyState {
  active: CellPos;
  rtl: boolean;
  bounds: NavBounds;
  /** Rows one PageDown moves by (a screenful). */
  page: number;
  /** The last cell that holds data (Ctrl+End). */
  lastUsed: CellPos;
  filled: (row: number, col: number) => boolean;
  editable: boolean;
}

/** What a key pressed on the grid means. */
export function gridKey(ev: KeyLike, s: GridKeyState): GridAction {
  const ctrl = !!(ev.ctrlKey || ev.metaKey);
  const shift = !!ev.shiftKey;
  const b = s.bounds;
  const to = (row: number, col: number, extend = shift): GridAction =>
    ({ kind: 'move', to: { row: clamp(row, 0, b.lastRow), col: clamp(col, 0, b.lastCol) }, extend });
  const arrow = arrowStep(ev.key, s.rtl);
  if (arrow && !ev.altKey) {
    if (ctrl) {
      const hit = jumpTarget(s.active, arrow.dr, arrow.dc, s.filled, b);
      return to(hit.row, hit.col);
    }
    return to(s.active.row + arrow.dr, s.active.col + arrow.dc);
  }
  switch (ev.key) {
    case 'Enter': return to(s.active.row + (shift ? -1 : 1), s.active.col, false);
    case 'Tab': return to(s.active.row, s.active.col + (shift ? -1 : 1), false);
    case 'Home': return ctrl ? to(0, 0) : to(s.active.row, 0);
    case 'End': return ctrl ? to(s.lastUsed.row, s.lastUsed.col) : { kind: 'none' };
    case 'PageDown': return to(s.active.row + s.page, s.active.col);
    case 'PageUp': return to(s.active.row - s.page, s.active.col);
    case 'F2': return s.editable ? { kind: 'edit', text: null } : { kind: 'none' };
    case 'Delete':
    case 'Backspace': return s.editable ? { kind: 'clear' } : { kind: 'none' };
    default: break;
  }
  if (ctrl && !shift && (ev.key === 'a' || ev.key === 'A')) return { kind: 'selectAll' };
  if (s.editable && isPrintable(ev)) return { kind: 'edit', text: ev.key };
  return { kind: 'none' };
}

/**
 * What a key pressed in the floating editor means. An entry started by typing ("enter mode")
 * commits on an arrow and moves; an entry opened with F2 or a double-click ("edit mode") lets the
 * arrows move the caret inside the text.
 */
export function editorKey(ev: KeyLike, mode: 'enter' | 'edit', rtl: boolean): EditorAction {
  if (ev.isComposing) return { kind: 'type' };
  if (ev.key === 'Escape') return { kind: 'cancel' };
  if (ev.key === 'Enter' && !ev.altKey) return { kind: 'commit', dr: ev.shiftKey ? -1 : 1, dc: 0 };
  if (ev.key === 'Tab') return { kind: 'commit', dr: 0, dc: ev.shiftKey ? -1 : 1 };
  if (mode === 'enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
    const arrow = arrowStep(ev.key, rtl);
    if (arrow) return { kind: 'commit', ...arrow };
  }
  return { kind: 'type' };
}

/** The last row and column that hold anything (Ctrl+End), in the rows given. */
export function lastUsedCell(rows: readonly (readonly string[])[]): CellPos {
  let row = 0;
  let col = 0;
  for (let r = 0; r < rows.length; r++) {
    const line = rows[r] ?? [];
    for (let c = line.length - 1; c >= 0; c--) {
      if ((line[c] ?? '') !== '') { row = Math.max(row, r); col = Math.max(col, c); break; }
    }
  }
  return { row, col };
}
