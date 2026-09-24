/**
 * Clipboard history (سجل الحافظة).
 *
 * Remembers the last texts copied anywhere in the OS — Ctrl+C / cut in any app,
 * a selection copied in the Terminal, and the copy buttons apps offer (through
 * navigator.clipboard.writeText) — and lets the owner paste one of them back:
 * Ctrl+Alt+V (or Super+V in full screen) opens the list, and picking an item
 * types it into whatever had focus and also puts it on the real clipboard.
 *
 * Kept on this device only (localStorage), text only, capped, and never from
 * a password field. Everything is rendered with textContent.
 */
import type { SystemAPI } from '../kernel/types';
import { t } from '../kernel/i18n';

export const CLIPBOARD_KEY = 'faisal.clipboard.v1';
export const MAX_ENTRIES = 25;
export const MAX_ENTRY_CHARS = 20_000;
const PREVIEW_CHARS = 220;

export interface ClipEntry { text: string; time: number }

/* ─────────────────────────────── pure helpers ─────────────────────────────── */

/** Newest first; a repeat moves to the top; blank text is ignored; capped. */
export function addEntry(list: ClipEntry[], text: string, time: number): ClipEntry[] {
  if (typeof text !== 'string' || !text.trim()) return list;
  const value = text.length > MAX_ENTRY_CHARS ? text.slice(0, MAX_ENTRY_CHARS) : text;
  return [{ text: value, time }, ...list.filter((e) => e.text !== value)].slice(0, MAX_ENTRIES);
}

/** Tolerant read of the stored list: anything malformed is dropped. */
export function parseHistory(raw: string | null): ClipEntry[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((e): e is ClipEntry => !!e && typeof e === 'object'
        && typeof (e as ClipEntry).text === 'string' && typeof (e as ClipEntry).time === 'number')
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** One line for the list: whitespace collapsed, long text cut. */
export function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const isTextField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  !!el && (el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && /^(text|search|url|email|tel|number|)$/i.test((el as HTMLInputElement).type)));

const isPassword = (el: Element | null) => !!el && el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'password';

function isEditable(el: Element | null): el is Editable {
  return isTextField(el) || (!!el && (el as HTMLElement).isContentEditable);
}

/** The text a copy/cut is about to put on the clipboard. */
function copiedText(ev: ClipboardEvent): string {
  const set = ev.clipboardData?.getData('text/plain');
  if (set) return set;
  const active = document.activeElement;
  if (isTextField(active)) {
    const { selectionStart: a, selectionEnd: b, value } = active;
    return a !== null && b !== null && b > a ? value.slice(a, b) : '';
  }
  return document.getSelection()?.toString() ?? '';
}

/** Types `text` into `target` as if pasted (undoable where the browser allows). */
function insertInto(target: Editable, text: string): boolean {
  target.focus();
  // execCommand keeps the field's undo stack and fires a real input event, which the
  // Terminal (xterm) and every framework-free field here listen to.
  if (document.execCommand?.('insertText', false, text)) return true;
  if (isTextField(target)) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, 'end');
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  }
  return false;
}

/* ─────────────────────────────── the service ─────────────────────────────── */

export interface ClipboardPanel {
  open(): void;
  close(): void;
  isOpen(): boolean;
  entries(): ClipEntry[];
}

export function mountClipboard(sys: SystemAPI): ClipboardPanel {
  const read = () => { try { return localStorage.getItem(CLIPBOARD_KEY); } catch { return null; } };
  let history = parseHistory(read());
  const save = () => { try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(history)); } catch { /* full or blocked */ } };
  const remember = (text: string) => {
    const next = addEntry(history, text, Date.now());
    if (next === history) return;
    history = next;
    save();
    if (panel) render();
  };

  // 1. Copies and cuts made anywhere in the page.
  const onCopy = (ev: Event) => {
    if (isPassword(document.activeElement)) return;
    remember(copiedText(ev as ClipboardEvent));
  };
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCopy);

  // 2. Copy buttons in apps go through the async Clipboard API.
  const clip = navigator.clipboard as (Clipboard & { writeText: (s: string) => Promise<void> }) | undefined;
  const nativeWrite = clip?.writeText ? clip.writeText.bind(clip) : null;
  if (clip && nativeWrite) {
    try {
      Object.defineProperty(clip, 'writeText', {
        configurable: true,
        value: (text: string) => { remember(String(text ?? '')); return nativeWrite(text); },
      });
    } catch { /* read-only in this browser: button copies simply are not recorded */ }
  }

  /* ── the panel ── */

  let panel: HTMLElement | null = null;
  let list: HTMLElement;
  let target: Editable | null = null;
  let active = 0;

  function items(): HTMLButtonElement[] {
    return [...list.querySelectorAll<HTMLButtonElement>('.faisal-clip-item')];
  }

  function render() {
    if (!panel) return;
    list.textContent = '';
    if (!history.length) {
      const empty = document.createElement('div');
      empty.className = 'faisal-clip-empty';
      empty.textContent = t('shell.clip.empty');
      list.append(empty);
      return;
    }
    history.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'faisal-clip-row';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'faisal-clip-item';
      pick.setAttribute('role', 'option');
      pick.textContent = preview(entry.text);
      pick.title = entry.text.length > 400 ? `${entry.text.slice(0, 400)}…` : entry.text;
      pick.addEventListener('click', () => { void paste(entry.text); });
      pick.addEventListener('focus', () => { active = i; });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'faisal-clip-del';
      del.textContent = '×';
      del.setAttribute('aria-label', t('shell.clip.remove'));
      del.title = t('shell.clip.remove');
      del.addEventListener('click', () => {
        history = history.filter((e) => e !== entry);
        save();
        render();
        items()[Math.min(i, history.length - 1)]?.focus();
      });
      row.append(pick, del);
      list.append(row);
    });
  }

  async function paste(text: string) {
    const into = target;
    close();
    try { await nativeWrite?.(text); } catch { /* no permission: typing below still works */ }
    if (into && into.isConnected && insertInto(into, text)) return;
    sys.notify(t('shell.clip.copied'), t('shell.clip.copiedBody'));
  }

  function open() {
    if (panel) { items()[0]?.focus(); return; }
    const focused = document.activeElement;
    target = isEditable(focused) && !isPassword(focused) ? focused : null;
    history = parseHistory(read());
    panel = document.createElement('div');
    panel.className = 'faisal-clip';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('shell.clip.title'));

    const head = document.createElement('div');
    head.className = 'faisal-clip-head';
    const h = document.createElement('h3');
    h.textContent = t('shell.clip.title');
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'faisal-clip-clear';
    clear.textContent = t('shell.clip.clear');
    clear.addEventListener('click', () => { history = []; save(); render(); });
    head.append(h, clear);

    list = document.createElement('div');
    list.className = 'faisal-clip-list';
    list.setAttribute('role', 'listbox');

    const hint = document.createElement('div');
    hint.className = 'faisal-clip-hint';
    hint.textContent = t('shell.clip.hint');

    panel.append(head, list, hint);
    document.body.append(panel);
    render();
    active = 0;
    items()[0]?.focus();
    document.addEventListener('pointerdown', onOutside, true);
    panel.addEventListener('keydown', onKey);
  }

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.removeEventListener('pointerdown', onOutside, true);
    // Give focus back to where the owner was typing.
    if (target?.isConnected) target.focus();
  }

  function onOutside(ev: PointerEvent) {
    if (panel && !panel.contains(ev.target as Node)) close();
  }

  function onKey(ev: KeyboardEvent) {
    const all = items();
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (!all.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
      all[active].focus();
    } else if (ev.key === 'Delete' && (ev.target as HTMLElement).classList.contains('faisal-clip-item')) {
      ev.preventDefault();
      all[active]?.parentElement?.querySelector<HTMLButtonElement>('.faisal-clip-del')?.click();
    }
  }

  // Ctrl+Alt+V everywhere, Super+V where the page receives the Windows key (full screen).
  // Capture phase, so the Terminal never receives the chord as input.
  window.addEventListener('keydown', (ev) => {
    const isV = ev.code === 'KeyV' || ev.key.toLowerCase() === 'v';
    if (!isV || ev.isComposing || ev.shiftKey) return;
    const chord = (ev.ctrlKey && ev.altKey && !ev.metaKey) || (ev.metaKey && !ev.ctrlKey && !ev.altKey);
    if (!chord) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (panel) close(); else open();
  }, true);

  return { open, close, isOpen: () => panel !== null, entries: () => history };
}
