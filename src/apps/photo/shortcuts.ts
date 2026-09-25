/**
 * Photo Editor — the keyboard table. The key bindings AND the F1 shortcuts sheet are both
 * generated from this one list, so the sheet can never describe a key that does not work.
 */

export type ToolId =
  | 'move' | 'hand' | 'zoom' | 'marquee' | 'ellipse' | 'lasso' | 'wand' | 'crop'
  | 'brush' | 'eraser' | 'bucket' | 'gradient' | 'eyedropper' | 'clone' | 'text' | 'shape' | 'transform';

export type Action =
  | { kind: 'tool'; tool: ToolId }
  | { kind: 'command'; command: Command };

export type Command =
  | 'undo' | 'redo' | 'new' | 'open' | 'save' | 'saveAs' | 'export' | 'zoomFit' | 'zoom100'
  | 'zoomIn' | 'zoomOut' | 'selectAll' | 'deselect' | 'invertSelection' | 'delete' | 'copy'
  | 'cut' | 'paste' | 'swapColors' | 'resetColors' | 'brushSmaller' | 'brushBigger'
  | 'apply' | 'cancel' | 'help' | 'duplicateLayer' | 'newLayer';

export interface Shortcut {
  /** `KeyboardEvent.key`, lower-cased for letters. */
  key: string;
  mod?: boolean;
  shift?: boolean;
  /** Also accept the same key with Shift (for "+" which is Shift+= on many layouts). */
  anyShift?: boolean;
  action: Action;
  /** strings.ts key of the description, under `photo.`. */
  label: string;
}

const tool = (key: string, t: ToolId, label: string): Shortcut => ({ key, action: { kind: 'tool', tool: t }, label });
const cmd = (key: string, c: Command, label: string, mod = false, shift = false): Shortcut =>
  ({ key, mod, shift, action: { kind: 'command', command: c }, label });

export const SHORTCUTS: Shortcut[] = [
  tool('v', 'move', 'toolMove'),
  tool('m', 'marquee', 'toolMarquee'),
  tool('l', 'lasso', 'toolLasso'),
  tool('w', 'wand', 'toolWand'),
  tool('c', 'crop', 'toolCrop'),
  tool('b', 'brush', 'toolBrush'),
  tool('e', 'eraser', 'toolEraser'),
  tool('g', 'bucket', 'toolBucket'),
  tool('d', 'gradient', 'toolGradient'),
  tool('i', 'eyedropper', 'toolEyedropper'),
  tool('s', 'clone', 'toolClone'),
  tool('t', 'text', 'toolText'),
  tool('u', 'shape', 'toolShape'),
  tool('z', 'zoom', 'toolZoom'),
  tool('h', 'hand', 'toolHand'),
  cmd('z', 'undo', 'undo', true),
  cmd('y', 'redo', 'redo', true),
  cmd('z', 'redo', 'redo', true, true),
  cmd('n', 'new', 'newCanvas', true),
  cmd('o', 'open', 'openFile', true),
  cmd('s', 'save', 'saveProject', true),
  cmd('s', 'saveAs', 'saveProjectAs', true, true),
  cmd('e', 'export', 'exportTitle', true, true),
  cmd('0', 'zoomFit', 'zoomFit', true),
  cmd('1', 'zoom100', 'zoomActual', true),
  { key: '=', mod: true, anyShift: true, action: { kind: 'command', command: 'zoomIn' }, label: 'zoomIn' },
  { key: '+', mod: true, anyShift: true, action: { kind: 'command', command: 'zoomIn' }, label: 'zoomIn' },
  cmd('-', 'zoomOut', 'zoomOut', true),
  cmd('a', 'selectAll', 'selectAll', true),
  cmd('d', 'deselect', 'deselect', true),
  cmd('i', 'invertSelection', 'invertSelection', true, true),
  cmd('delete', 'delete', 'deleteSelection'),
  cmd('backspace', 'delete', 'deleteSelection'),
  cmd('c', 'copy', 'copy', true),
  cmd('x', 'cut', 'cut', true),
  cmd('v', 'paste', 'paste', true),
  cmd('j', 'duplicateLayer', 'layerDuplicate', true),
  cmd('n', 'newLayer', 'layerAdd', true, true),
  cmd('x', 'swapColors', 'swapColors'),
  cmd('[', 'brushSmaller', 'brushSmaller'),
  cmd(']', 'brushBigger', 'brushBigger'),
  cmd('enter', 'apply', 'apply'),
  cmd('escape', 'cancel', 'cancel'),
  cmd('f1', 'help', 'shortcutsTitle'),
];

/** The action for a key event, or null. `key` is `KeyboardEvent.key`. */
export function matchShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): Action | null {
  if (e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  for (const s of SHORTCUTS) {
    if (s.key !== key || !!s.mod !== mod) continue;
    if (!s.anyShift && !!s.shift !== e.shiftKey) continue;
    return s.action;
  }
  return null;
}

/** "Ctrl+Shift+S" style text for the sheet (⌘ on Apple platforms). */
export function describeKeys(s: Shortcut, apple = false): string {
  const parts: string[] = [];
  if (s.mod) parts.push(apple ? '⌘' : 'Ctrl');
  if (s.shift) parts.push('Shift');
  const names: Record<string, string> = { delete: 'Del', backspace: '⌫', enter: 'Enter', escape: 'Esc', f1: 'F1' };
  parts.push(names[s.key] ?? s.key.toUpperCase());
  return parts.join('+');
}

/** Tool → its one-key shortcut letter (for tooltips). */
export function toolKey(t: ToolId): string | null {
  const s = SHORTCUTS.find((x) => x.action.kind === 'tool' && x.action.tool === t && !x.mod);
  return s ? s.key.toUpperCase() : null;
}
