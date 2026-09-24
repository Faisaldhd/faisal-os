/**
 * PDF app — small DOM helpers: elements, icon buttons, the in-app modal and popovers.
 *
 * The modal wears the shell's dialog look (`faisal-shell-overlay` / `faisal-shell-dialog`), so
 * it matches `shellConfirm`; it traps Tab inside itself, closes on Escape through the shell's
 * escape stack (topmost surface first) and gives focus back to what opened it. Popovers close on
 * Escape and on a press outside. Nothing here ever parses markup: text goes in by `textContent`.
 */
import { pushEscapeLayer } from '../../shell/esc';
import { icon, type IconName } from './icons';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An icon button: the label is the accessible name and the tooltip; `showLabel` prints it too. */
export function iconButton(name: IconName, label: string, cls = 'faisal-pdf-ibtn', showLabel = false): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.append(icon(name));
  if (showLabel) b.append(el('span', 'faisal-pdf-ibtn-label', label));
  else b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalHandle {
  dialog: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  close(): void;
}

/**
 * Opens a modal. `build` fills the body and actions; `onClose` runs once however it closes.
 * Returns the handle so the caller can close it from a button.
 */
export function openModal(opts: { title: string; wide?: boolean; onClose?: () => void }): ModalHandle {
  const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = el('div', 'faisal-shell-overlay faisal-pdf-modal-overlay');
  const dialog = el('div', `faisal-shell-dialog faisal-pdf-modal${opts.wide ? ' is-wide' : ''}`);
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const title = el('h3', 'faisal-pdf-modal-title', opts.title);
  title.id = `faisal-pdf-modal-${Math.random().toString(36).slice(2, 9)}`;
  dialog.setAttribute('aria-labelledby', title.id);
  const body = el('div', 'faisal-pdf-modal-body');
  const actions = el('div', 'faisal-shell-dialog-actions faisal-pdf-modal-actions');
  dialog.append(title, body, actions);
  overlay.append(dialog);
  document.body.append(overlay);
  let closed = false;
  let release: (() => void) | null = null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    overlay.remove();
    release?.();
    opts.onClose?.();
    if (invoker?.isConnected) invoker.focus();
  };
  release = pushEscapeLayer(close);
  overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
  dialog.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  queueMicrotask(() => {
    const target = body.querySelector<HTMLElement>('[autofocus], input, textarea, select') ?? actions.querySelector<HTMLElement>('.is-primary') ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  });
  return { dialog, body, actions, close };
}

export function dialogButton(label: string, kind: 'primary' | 'danger' | 'plain' = 'plain'): HTMLButtonElement {
  const b = el('button', `faisal-shell-dialog-btn${kind === 'primary' ? ' is-primary' : kind === 'danger' ? ' is-danger' : ''}`, label);
  b.type = 'button';
  return b;
}

let openPopover: (() => void) | null = null;

/** Closes whichever popover is open (a new one replaces the old one). */
export function closePopover(): void {
  openPopover?.();
}

/**
 * A glass popover under (or above) `anchor`, inside `host` so it scales with the window.
 * Closes on Escape, on a press outside it and when another popover opens.
 */
export function openPopoverAt(host: HTMLElement, anchor: HTMLElement, content: HTMLElement, label: string): () => void {
  closePopover();
  const pop = el('div', 'faisal-pdf-popover');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', label);
  pop.append(content);
  host.append(pop);
  const h = host.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const width = pop.offsetWidth || 240;
  const height = pop.offsetHeight || 200;
  let left = a.left - h.left + a.width / 2 - width / 2;
  left = Math.max(8, Math.min(left, h.width - width - 8));
  let top = a.bottom - h.top + 8;
  if (top + height > h.height - 8) top = Math.max(8, a.top - h.top - height - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  let done = false;
  const onDown = (ev: PointerEvent): void => {
    if (!pop.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) close();
  };
  const release = pushEscapeLayer(() => close());
  const close = (): void => {
    if (done) return;
    done = true;
    pop.remove();
    release();
    document.removeEventListener('pointerdown', onDown, true);
    if (openPopover === close) openPopover = null;
  };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  openPopover = close;
  queueMicrotask(() => pop.querySelector<HTMLElement>(FOCUSABLE)?.focus());
  return close;
}
