/**
 * Writer — keyboard shortcuts and typing direction (اختصارات لوحة المفاتيح واتجاه الكتابة).
 *
 * Pure, so the mapping is tested without a page: the view asks `shortcutOf` what a
 * key press means and runs that command through the very same path as the ribbon
 * button, so Ctrl+B on a selection formats exactly what the B button formats.
 */
import { startsRtl } from './docops';

export type WriterCommand =
  | 'bold' | 'italic' | 'underline' | 'strike' | 'superscript' | 'subscript' | 'clearFormat'
  | 'alignLeft' | 'alignCenter' | 'alignRight' | 'alignJustify'
  | 'indent' | 'outdent' | 'link' | 'pageBreak'
  | 'docStart' | 'docEnd' | 'docStartExtend' | 'docEndExtend'
  | 'find' | 'replace' | 'print' | 'selectAll';

export interface KeyLike { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

/** The command a key press stands for, or null when the key is not a Writer shortcut. */
export function shortcutOf(ev: KeyLike): WriterCommand | null {
  const mod = ev.ctrlKey || ev.metaKey;
  if (!mod || ev.altKey) return null;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  // Letters by their physical key too, so an Arabic keyboard layout (Ctrl+لا) still means Ctrl+B.
  const letter = /^Key([A-Z])$/.exec(ev.code ?? '')?.[1]?.toLowerCase();
  const is = (ch: string): boolean => key === ch || (letter === ch && !/^[a-z]$/.test(key));
  if (key === 'Home') return ev.shiftKey ? 'docStartExtend' : 'docStart';
  if (key === 'End') return ev.shiftKey ? 'docEndExtend' : 'docEnd';
  if (key === 'Enter' && !ev.shiftKey) return 'pageBreak';
  if (key === ' ' || ev.code === 'Space') return ev.shiftKey ? null : 'clearFormat';
  if (key === '=' || key === '+') return ev.shiftKey ? 'superscript' : 'subscript';
  if (ev.shiftKey) {
    if (is('x')) return 'strike';
    if (is('m')) return 'outdent';
    return null;
  }
  if (is('b')) return 'bold';
  if (is('i')) return 'italic';
  if (is('u')) return 'underline';
  if (is('l')) return 'alignLeft';
  if (is('e')) return 'alignCenter';
  if (is('r')) return 'alignRight';
  if (is('j')) return 'alignJustify';
  if (is('m')) return 'indent';
  if (is('k')) return 'link';
  if (is('f')) return 'find';
  if (is('h')) return 'replace';
  if (is('p')) return 'print';
  if (is('a')) return 'selectAll';
  return null;
}

/**
 * The direction a paragraph takes when the first letters are typed into it (the
 * paragraph held no letter before): Arabic text makes it right-to-left and Latin
 * text left-to-right, like `dir="auto"`. Null when nothing changes — the paragraph
 * already has letters, the typed text has none, or it already reads that way.
 */
export function typedDirection(before: string, typed: string, current: 'rtl' | 'ltr'): 'rtl' | 'ltr' | null {
  if (startsRtl(before) !== null) return null;
  const rtl = startsRtl(typed);
  if (rtl === null) return null;
  const want = rtl ? 'rtl' : 'ltr';
  return want === current ? null : want;
}

/** The direction `dir="auto"` gives a paragraph: its first strong letter, or null for none. */
export function autoDirection(text: string): 'rtl' | 'ltr' | null {
  const rtl = startsRtl(text);
  return rtl === null ? null : rtl ? 'rtl' : 'ltr';
}
