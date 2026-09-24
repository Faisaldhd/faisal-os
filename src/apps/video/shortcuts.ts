/**
 * Keyboard shortcuts — ONE table that both binds the keys and draws the F1 sheet,
 * so the help can never disagree with what the keys really do.
 *
 * Keys match on `KeyboardEvent.code` (the physical key), not `key`: with an
 * Arabic keyboard layout `key` for the S key is "س", and a shortcut that only
 * worked in English would be broken for the owner.
 */

export type ShortcutAction =
  | 'playPause'
  | 'shuttleBack'
  | 'shuttleStop'
  | 'shuttleForward'
  | 'frameBack'
  | 'frameForward'
  | 'secondBack'
  | 'secondForward'
  | 'goStart'
  | 'goEnd'
  | 'markIn'
  | 'markOut'
  | 'split'
  | 'delete'
  | 'duplicate'
  | 'undo'
  | 'redo'
  | 'save'
  | 'saveAs'
  | 'open'
  | 'newProject'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'addText'
  | 'loop'
  | 'fullscreen'
  | 'snap'
  | 'export'
  | 'help'
  | 'escape';

export interface KeyLike {
  code: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface Shortcut {
  action: ShortcutAction;
  /** Physical key code. */
  code: string;
  /** Ctrl (or ⌘ on a Mac). */
  mod?: boolean;
  shift?: boolean;
  /** Human label of the key(s), drawn in the help sheet. */
  label: string;
}

/**
 * Order matters twice: the help sheet lists the rows in this order, and the
 * first matching row wins, so a Shift/Ctrl variant is listed before the plain key.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  { action: 'playPause', code: 'Space', label: 'Space' },
  { action: 'shuttleBack', code: 'KeyJ', label: 'J' },
  { action: 'shuttleStop', code: 'KeyK', label: 'K' },
  { action: 'shuttleForward', code: 'KeyL', label: 'L' },
  { action: 'secondBack', code: 'ArrowLeft', shift: true, label: 'Shift + ←' },
  { action: 'secondForward', code: 'ArrowRight', shift: true, label: 'Shift + →' },
  { action: 'frameBack', code: 'ArrowLeft', label: '←' },
  { action: 'frameForward', code: 'ArrowRight', label: '→' },
  { action: 'goStart', code: 'Home', label: 'Home' },
  { action: 'goEnd', code: 'End', label: 'End' },
  { action: 'markIn', code: 'KeyI', label: 'I' },
  { action: 'markOut', code: 'KeyO', label: 'O' },
  { action: 'split', code: 'KeyB', mod: true, label: 'Ctrl + B' },
  { action: 'split', code: 'KeyS', label: 'S' },
  { action: 'delete', code: 'Delete', label: 'Delete' },
  { action: 'delete', code: 'Backspace', label: 'Backspace' },
  { action: 'duplicate', code: 'KeyD', mod: true, label: 'Ctrl + D' },
  { action: 'redo', code: 'KeyZ', mod: true, shift: true, label: 'Ctrl + Shift + Z' },
  { action: 'undo', code: 'KeyZ', mod: true, label: 'Ctrl + Z' },
  { action: 'redo', code: 'KeyY', mod: true, label: 'Ctrl + Y' },
  { action: 'saveAs', code: 'KeyS', mod: true, shift: true, label: 'Ctrl + Shift + S' },
  { action: 'save', code: 'KeyS', mod: true, label: 'Ctrl + S' },
  { action: 'open', code: 'KeyO', mod: true, label: 'Ctrl + O' },
  { action: 'newProject', code: 'KeyN', mod: true, label: 'Ctrl + N' },
  { action: 'export', code: 'KeyE', mod: true, label: 'Ctrl + E' },
  { action: 'zoomIn', code: 'Equal', label: '+' },
  { action: 'zoomIn', code: 'NumpadAdd', label: '+' },
  { action: 'zoomOut', code: 'Minus', label: '−' },
  { action: 'zoomOut', code: 'NumpadSubtract', label: '−' },
  { action: 'zoomFit', code: 'Digit0', mod: true, label: 'Ctrl + 0' },
  { action: 'addText', code: 'KeyT', label: 'T' },
  { action: 'loop', code: 'KeyR', label: 'R' },
  { action: 'snap', code: 'KeyN', label: 'N' },
  { action: 'fullscreen', code: 'KeyF', label: 'F' },
  { action: 'help', code: 'F1', label: 'F1' },
  { action: 'escape', code: 'Escape', label: 'Esc' },
];

/** The action for a key press, or null. Modifiers must match exactly. */
export function matchShortcut(event: KeyLike): ShortcutAction | null {
  const mod = Boolean(event.ctrlKey || event.metaKey);
  const shift = Boolean(event.shiftKey);
  if (event.altKey) return null;
  for (const s of SHORTCUTS) {
    if (s.code !== event.code) continue;
    if (Boolean(s.mod) !== mod) continue;
    // Plain keys ignore Shift only when the table has no Shift variant for them.
    if (Boolean(s.shift) !== shift) {
      const hasShiftVariant = SHORTCUTS.some((o) => o.code === s.code && Boolean(o.mod) === mod && Boolean(o.shift) === shift);
      if (hasShiftVariant || s.shift || mod) continue;
      // `+` on many layouts is Shift+Equal: let it through.
      if (s.code !== 'Equal') continue;
    }
    return s.action;
  }
  return null;
}

/** True when the event comes from somewhere the user is typing. */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  // Sliders, checkboxes and buttons do not take text: shortcuts still work there,
  // except the arrows, which the caller leaves to the slider itself.
  const type = (target.type ?? 'text').toLowerCase();
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file'].includes(type);
}

/** The rows of the help sheet: one per action, every key that triggers it. */
export function helpRows(): Array<{ action: ShortcutAction; keys: string[] }> {
  const rows = new Map<ShortcutAction, string[]>();
  for (const s of SHORTCUTS) {
    const keys = rows.get(s.action) ?? [];
    if (!keys.includes(s.label)) keys.push(s.label);
    rows.set(s.action, keys);
  }
  return [...rows].map(([action, keys]) => ({ action, keys }));
}

/**
 * J/K/L shuttle: each press of L doubles forward speed (1 → 2 → 4), J does the
 * same backwards, the opposite key first brings the speed back toward a stop,
 * and K stops. Returns the new signed rate (0 = stopped).
 */
export function shuttle(rate: number, key: 'J' | 'K' | 'L'): number {
  if (key === 'K') return 0;
  const direction = key === 'L' ? 1 : -1;
  if (rate === 0 || Math.sign(rate) !== direction) {
    if (rate !== 0 && Math.sign(rate) !== direction) return 0;
    return direction;
  }
  return direction * Math.min(4, Math.abs(rate) * 2);
}
