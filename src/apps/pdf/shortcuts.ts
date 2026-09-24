/**
 * PDF app — the keyboard shortcuts table (اختصارات لوحة المفاتيح).
 *
 * One table decides both what the window binds and what the F1 sheet lists, so the sheet can
 * never promise a key that does nothing. A combo is written `Ctrl+Shift+Z`; `Ctrl` also matches
 * ⌘ on a Mac. Letter keys are matched on `event.code` too, so an Arabic keyboard layout (where
 * Ctrl+S produces "س") still saves.
 */
export type CommandId =
  | 'open' | 'save' | 'saveAs' | 'print' | 'undo' | 'redo' | 'redoAlt' | 'find' | 'findNext' | 'findPrev'
  | 'goto' | 'zoomIn' | 'zoomInAlt' | 'zoomOut' | 'fitPage' | 'actualSize' | 'firstPage' | 'lastPage'
  | 'nextPage' | 'prevPage' | 'deletePages' | 'escape' | 'help' | 'selectAll' | 'newDoc';

export interface Shortcut {
  id: CommandId;
  combo: string;
  /** A strings key suffix describing the command (pdf.key…). */
  label: string;
  /** False: works even while typing in a field (Ctrl+S, Escape…). */
  onlyOutsideFields: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'newDoc', combo: 'Ctrl+N', label: 'keyNew', onlyOutsideFields: false },
  { id: 'open', combo: 'Ctrl+O', label: 'keyOpen', onlyOutsideFields: false },
  { id: 'save', combo: 'Ctrl+S', label: 'keySave', onlyOutsideFields: false },
  { id: 'saveAs', combo: 'Ctrl+Shift+S', label: 'keySaveAs', onlyOutsideFields: false },
  { id: 'print', combo: 'Ctrl+P', label: 'keyPrint', onlyOutsideFields: false },
  { id: 'undo', combo: 'Ctrl+Z', label: 'keyUndo', onlyOutsideFields: true },
  { id: 'redo', combo: 'Ctrl+Y', label: 'keyRedo', onlyOutsideFields: true },
  { id: 'redoAlt', combo: 'Ctrl+Shift+Z', label: 'keyRedo', onlyOutsideFields: true },
  { id: 'find', combo: 'Ctrl+F', label: 'keyFind', onlyOutsideFields: false },
  { id: 'findNext', combo: 'F3', label: 'keyFindNext', onlyOutsideFields: false },
  { id: 'findPrev', combo: 'Shift+F3', label: 'keyFindPrev', onlyOutsideFields: false },
  { id: 'goto', combo: 'Ctrl+G', label: 'keyGoto', onlyOutsideFields: false },
  { id: 'zoomIn', combo: 'Ctrl+=', label: 'keyZoomIn', onlyOutsideFields: false },
  { id: 'zoomInAlt', combo: 'Ctrl++', label: 'keyZoomIn', onlyOutsideFields: false },
  { id: 'zoomOut', combo: 'Ctrl+-', label: 'keyZoomOut', onlyOutsideFields: false },
  { id: 'fitPage', combo: 'Ctrl+0', label: 'keyFit', onlyOutsideFields: false },
  { id: 'actualSize', combo: 'Ctrl+1', label: 'keyActual', onlyOutsideFields: false },
  { id: 'firstPage', combo: 'Home', label: 'keyFirst', onlyOutsideFields: true },
  { id: 'lastPage', combo: 'End', label: 'keyLast', onlyOutsideFields: true },
  { id: 'nextPage', combo: 'PageDown', label: 'keyNextPage', onlyOutsideFields: true },
  { id: 'prevPage', combo: 'PageUp', label: 'keyPrevPage', onlyOutsideFields: true },
  { id: 'selectAll', combo: 'Ctrl+A', label: 'keySelectAll', onlyOutsideFields: true },
  { id: 'deletePages', combo: 'Delete', label: 'keyDelete', onlyOutsideFields: true },
  { id: 'escape', combo: 'Escape', label: 'keyEscape', onlyOutsideFields: false },
  { id: 'help', combo: 'F1', label: 'keyHelp', onlyOutsideFields: false },
];

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

interface Parsed { ctrl: boolean; shift: boolean; alt: boolean; key: string }

export function parseCombo(combo: string): Parsed {
  // "Ctrl++" ends in the plus key itself.
  const parts = combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  return { ctrl: mods.includes('ctrl'), shift: mods.includes('shift'), alt: mods.includes('alt'), key };
}

function keyMatches(ev: KeyLike, want: string): boolean {
  if (want.length === 1 && /[a-z]/i.test(want)) {
    return ev.key.toLowerCase() === want.toLowerCase() || ev.code === `Key${want.toUpperCase()}`;
  }
  if (/^\d$/.test(want)) return ev.key === want || ev.code === `Digit${want}` || ev.code === `Numpad${want}`;
  if (want === '=') return ev.key === '=' || ev.code === 'Equal';
  if (want === '+') return ev.key === '+' || ev.code === 'NumpadAdd';
  if (want === '-') return ev.key === '-' || ev.code === 'Minus' || ev.code === 'NumpadSubtract';
  return ev.key === want;
}

export function matches(ev: KeyLike, combo: string): boolean {
  const want = parseCombo(combo);
  const ctrl = Boolean(ev.ctrlKey || ev.metaKey);
  if (ctrl !== want.ctrl || Boolean(ev.altKey) !== want.alt) return false;
  // Shift is part of typing "+" on most layouts, so it is not required to be absent there.
  if (want.key !== '+' && Boolean(ev.shiftKey) !== want.shift) return false;
  return keyMatches(ev, want.key);
}

/** The command for a key event, honoring "not while typing in a field". */
export function commandFor(ev: KeyLike, inField: boolean): CommandId | null {
  for (const s of SHORTCUTS) {
    if (inField && s.onlyOutsideFields) continue;
    if (matches(ev, s.combo)) return s.id;
  }
  return null;
}

/** The rows of the F1 sheet: one per distinct label, combos of the same command joined. */
export function shortcutSheet(): { label: string; combos: string[] }[] {
  const rows = new Map<string, string[]>();
  for (const s of SHORTCUTS) rows.set(s.label, [...(rows.get(s.label) ?? []), s.combo]);
  return [...rows.entries()].map(([label, combos]) => ({ label, combos }));
}
