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
import { pushEscapeLayer } from './esc';

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

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }

/**
 * Top-left corner for the panel opened at `pointer`, always fully inside the viewport.
 *
 * The panel prefers the room right/below the cursor and flips to the other side when that would
 * push it off screen — the same rule the Windows clipboard panel uses. The final clamp is what
 * keeps it usable on a 320px phone, where the panel is nearly as wide as the screen.
 */
export function placePanel(pointer: Point, size: Size, viewport: Size, gap = 12, margin = 8): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  const left = pointer.x + gap + size.width > viewport.width - margin ? pointer.x - gap - size.width : pointer.x + gap;
  const top = pointer.y + gap + size.height > viewport.height - margin ? pointer.y - gap - size.height : pointer.y + gap;
  return { left: Math.min(Math.max(left, margin), maxLeft), top: Math.min(Math.max(top, margin), maxTop) };
}

/**
 * The two chords that open the clipboard: Ctrl+Alt+V anywhere, and Super+V where the page
 * receives the Windows key (full screen).
 *
 * Shift is deliberately ignored on the Super chord: the owner wants Win+V to open even while
 * Shift is held. It still suppresses the Ctrl+Alt chord, because Ctrl+Shift+V is "paste without
 * formatting" inside apps (Terminal, Editor) and must stay theirs.
 */
export function isClipboardChord(ev: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>): boolean {
  if (ev.metaKey) return !ev.ctrlKey && !ev.altKey;
  return ev.ctrlKey && ev.altKey && !ev.shiftKey;
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

  // 3. Where the pointer is, so the panel can open under the cursor. Tracked from mount —
  // capture + passive, so an app that stops propagation cannot hide it and never blocks its own
  // scrolling — and kept until the next pointer event, because the shortcut carries no
  // coordinates of its own.
  let pointer: Point | null = null;
  const trackPointer = (ev: PointerEvent) => { pointer = { x: ev.clientX, y: ev.clientY }; };
  window.addEventListener('pointermove', trackPointer, { passive: true, capture: true });
  window.addEventListener('pointerdown', trackPointer, { passive: true, capture: true });

  /* ── the panel ── */

  let panel: HTMLElement | null = null;
  let releaseEsc: (() => void) | null = null;
  let list: HTMLElement;
  let target: Editable | null = null;
  let active = 0;

  /**
   * Opens the panel at the pointer, falling back to the top-right corner under the top bar when
   * no pointer event has been seen yet (keyboard-only or touch session). Runs after the panel is
   * in the DOM, because it needs the measured size to keep the panel inside the viewport, and
   * again on resize so a rotated phone cannot leave it half off screen.
   */
  function place() {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const anchor = pointer ?? {
      x: viewport.width - 12,
      y: (document.querySelector('.faisal-topbar')?.getBoundingClientRect().bottom ?? 0) + 12,
    };
    const { left, top } = placePanel(anchor, { width: rect.width, height: rect.height }, viewport);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }
  window.addEventListener('resize', place);

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
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'faisal-clip-x';
    x.textContent = '×';
    x.setAttribute('aria-label', t('shell.clip.close'));
    x.title = t('shell.clip.close');
    x.addEventListener('click', () => close());
    const tools = document.createElement('div');
    tools.className = 'faisal-clip-tools';
    tools.append(clear, x);
    head.append(h, tools);

    list = document.createElement('div');
    list.className = 'faisal-clip-list';
    list.setAttribute('role', 'listbox');

    const hint = document.createElement('div');
    hint.className = 'faisal-clip-hint';
    hint.textContent = t('shell.clip.hint');

    panel.append(head, list, hint);
    document.body.append(panel);
    render();
    place(); // at the pointer, and before focus so focusing cannot scroll away under the panel
    active = 0;
    items()[0]?.focus();
    document.addEventListener('pointerdown', onOutside, true);
    // Escape belongs to the shell's priority stack (esc.ts): this panel closes first, wherever
    // focus is — even an empty list has nothing to focus.
    releaseEsc = pushEscapeLayer(close);
    panel.addEventListener('keydown', onKey);
  }

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.removeEventListener('pointerdown', onOutside, true);
    releaseEsc?.();
    releaseEsc = null;
    // Give focus back to where the owner was typing.
    if (target?.isConnected) target.focus();
  }

  function onOutside(ev: PointerEvent) {
    if (panel && !panel.contains(ev.target as Node)) close();
  }

  function onKey(ev: KeyboardEvent) {
    const all = items();
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
  // Shift never blocks the Super chord (the owner asked for that explicitly).
  // Capture phase, so the Terminal never receives the chord as input.
  window.addEventListener('keydown', (ev) => {
    const isV = ev.code === 'KeyV' || ev.key.toLowerCase() === 'v';
    if (!isV || ev.isComposing || !isClipboardChord(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (panel) close(); else open();
  }, true);

  return { open, close, isOpen: () => panel !== null, entries: () => history };
}
