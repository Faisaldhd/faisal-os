/**
 * Office — popovers, bottom sheets and the in-app modal (القوائم المنبثقة والنوافذ).
 *
 * One behaviour for all three: they close on Esc and on a click outside, they
 * give focus back to what opened them, and a modal keeps Tab inside itself.
 * On a narrow window a popover becomes a bottom sheet with a grab handle, so
 * nothing is ever positioned off-screen on a phone.
 */
import { el, NARROW_BREAKPOINT } from './dom';

export interface Popover {
  element: HTMLElement;
  close(): void;
  readonly open: boolean;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let current: Popover | null = null;

/** Closes whatever popover is open (only one exists at a time). */
export function closePopovers(): void {
  current?.close();
}

/** The office root that hosts overlays: they must stay inside the app's window. */
function hostOf(anchor: HTMLElement): HTMLElement {
  return anchor.closest<HTMLElement>('.faisal-office') ?? document.body;
}

/**
 * Opens `content` next to `anchor` (below it, aligned to its inline-start), or as a
 * bottom sheet when the office window is narrow. Returns a handle to close it.
 */
export function openPopover(anchor: HTMLElement, content: HTMLElement, opts: { label: string; onClose?: () => void; sheet?: boolean } = { label: '' }): Popover {
  // Where the anchor is *now*: closing the open popover may move it (a folded ribbon
  // group's dropdown gives its tools back to the hidden group when it closes).
  const a = anchor.getBoundingClientRect();
  closePopovers();
  const host = hostOf(anchor);
  const narrow = opts.sheet || host.clientWidth < NARROW_BREAKPOINT;
  const box = el('div', narrow ? 'fo-sheet' : 'fo-pop');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', opts.label);
  let scrim: HTMLElement | null = null;
  if (narrow) {
    scrim = el('div', 'fo-scrim');
    scrim.addEventListener('click', () => handle.close());
    const grab = el('div', 'fo-sheet-grab');
    grab.setAttribute('aria-hidden', 'true');
    box.append(grab);
    const title = el('div', 'fo-sheet-title', opts.label);
    box.append(title);
  }
  box.append(content);
  if (scrim) host.append(scrim);
  host.append(box);

  if (!narrow) {
    const hostRect = host.getBoundingClientRect();
    const rtl = getComputedStyle(host).direction === 'rtl';
    const width = box.offsetWidth || 240;
    let left = rtl ? a.right - hostRect.left - width : a.left - hostRect.left;
    left = Math.max(8, Math.min(left, hostRect.width - width - 8));
    let top = a.bottom - hostRect.top + 4;
    const height = box.offsetHeight || 200;
    if (top + height > hostRect.height - 8) top = Math.max(8, a.top - hostRect.top - height - 4);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); handle.close(); }
  };
  const onDown = (ev: PointerEvent): void => {
    const target = ev.target as Node;
    if (!box.contains(target) && !anchor.contains(target)) handle.close();
  };
  box.addEventListener('keydown', onKey);
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);

  let isOpen = true;
  const handle: Popover = {
    element: box,
    get open() { return isOpen; },
    close() {
      if (!isOpen) return;
      isOpen = false;
      document.removeEventListener('pointerdown', onDown, true);
      box.remove();
      scrim?.remove();
      if (current === handle) current = null;
      opts.onClose?.();
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
    },
  };
  current = handle;
  const first = box.querySelector<HTMLElement>(FOCUSABLE);
  first?.focus({ preventScroll: true });
  return handle;
}

export interface MenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  /** A trailing hint, such as a shortcut. */
  hint?: string;
  icon?: HTMLElement | SVGElement;
}

/** A vertical menu of actions, for popovers and sheets. */
export function menuList(items: readonly (MenuItem | 'sep')[], close: () => void): HTMLElement {
  const list = el('div', 'fo-menu');
  list.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === 'sep') { list.append(el('div', 'fo-menu-sep')); continue; }
    const b = el('button', `fo-menu-item${item.danger ? ' is-danger' : ''}`);
    b.type = 'button';
    b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (item.checked !== undefined) b.setAttribute('aria-checked', String(item.checked));
    b.disabled = !!item.disabled;
    if (item.icon) b.append(item.icon);
    b.append(el('span', 'fo-menu-label', item.label));
    if (item.hint) b.append(el('span', 'fo-menu-hint', item.hint));
    b.addEventListener('click', () => { close(); item.run(); });
    list.append(b);
  }
  list.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const all = [...list.querySelectorAll<HTMLButtonElement>('.fo-menu-item:not(:disabled)')];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = all[(at + (ev.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    next?.focus();
    ev.preventDefault();
  });
  return list;
}

export interface ModalOptions {
  title: string;
  body: HTMLElement;
  okLabel: string;
  cancelLabel: string;
  /** Returns false to keep the modal open (for example an invalid value). */
  onOk: () => boolean | void;
  host: HTMLElement;
  danger?: boolean;
}

/** The suite's modal: overlay, card, [Cancel][Primary], Esc closes, Tab stays inside. */
export function openModal(opts: ModalOptions): { close(): void } {
  closePopovers();
  const back = document.activeElement as HTMLElement | null;
  const overlay = el('div', 'fo-modal-overlay');
  const card = el('div', 'fo-modal');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const title = el('h2', 'fo-modal-title', opts.title);
  title.id = `fo-modal-${Math.random().toString(36).slice(2)}`;
  card.setAttribute('aria-labelledby', title.id);
  const actions = el('div', 'fo-modal-actions');
  const cancel = el('button', 'fo-btn has-label', opts.cancelLabel);
  cancel.type = 'button';
  const ok = el('button', `fo-btn has-label ${opts.danger ? 'is-danger' : 'is-primary'}`, opts.okLabel);
  ok.type = 'button';
  actions.append(cancel, ok);
  card.append(title, opts.body, actions);
  overlay.append(card);
  opts.host.append(overlay);

  const close = (): void => {
    overlay.remove();
    if (back?.isConnected) back.focus({ preventScroll: true });
  };
  cancel.addEventListener('click', close);
  ok.addEventListener('click', () => { if (opts.onOk() !== false) close(); });
  overlay.addEventListener('pointerdown', (ev) => { if (ev.target === overlay) close(); });
  card.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName === 'INPUT') { ev.preventDefault(); ok.click(); return; }
    if (ev.key !== 'Tab') return;
    const all = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!all.length) return;
    const first = all[0];
    const last = all[all.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  (card.querySelector<HTMLElement>('input, select, textarea') ?? ok).focus();
  return { close };
}
