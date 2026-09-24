/**
 * Reusable GNOME/Adwaita-style context menu for the shell.
 * Trusted, shell-owned strings only (textContent, no innerHTML).
 */

import { pushEscapeLayer } from './esc';

export interface ContextMenuItem {
  label?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  action?: () => void;
}

export interface ShowContextMenuOptions {
  /** Element to return focus to when the menu closes. Defaults to document.activeElement. */
  invoker?: HTMLElement | null;
}

let currentMenu: { el: HTMLElement; close: () => void } | null = null;

/** Closes any open context menu (menu or shell menu). Safe to call when none is open. */
export function closeAnyContextMenu(): void {
  currentMenu?.close();
}

/**
 * Pure helper: given a desired top-left position, a menu's rendered size and the
 * viewport size, returns a clamped/flipped position that keeps the menu fully
 * on screen. `preferStart` flips the menu to open toward the inline-start side
 * first (used for RTL, where a right-click menu should tend to grow leftwards).
 */
export function placeMenu(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
  viewportW: number,
  viewportH: number,
  rtl: boolean,
): { left: number; top: number } {
  const margin = 4;
  let left = rtl ? x - menuW : x;
  let top = y;

  // Flip horizontally if it would overflow the preferred side.
  if (left + menuW > viewportW - margin) left = x - menuW;
  if (left < margin) left = rtl ? x : Math.min(x, viewportW - menuW - margin);
  left = Math.max(margin, Math.min(left, viewportW - menuW - margin));

  if (top + menuH > viewportH - margin) top = y - menuH;
  if (top < margin) top = margin;
  top = Math.max(margin, Math.min(top, viewportH - menuH - margin));

  return { left, top };
}

const ICON_CHECK =
  '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderMenuIcon(svg: string): SVGElement {
  // Menu icons are always literal, trusted strings authored by the shell.
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return doc.documentElement as unknown as SVGElement;
}

/**
 * Shows a context menu at (x, y) built from `items`. Returns a close() function.
 * Only one menu is ever open at a time — opening a new one closes the previous.
 */
export function showContextMenu(x: number, y: number, items: ContextMenuItem[], opts: ShowContextMenuOptions = {}): () => void {
  closeAnyContextMenu();

  const invoker = opts.invoker ?? (document.activeElement as HTMLElement | null);
  const rtl = document.documentElement.dir === 'rtl';

  const menu = document.createElement('div');
  menu.className = 'faisal-ctxmenu';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;

  const entries: { el: HTMLButtonElement; item: ContextMenuItem }[] = [];

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'faisal-ctxmenu-sep';
      sep.setAttribute('role', 'separator');
      menu.append(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'faisal-ctxmenu-item' + (item.danger ? ' is-danger' : '');
    btn.setAttribute('role', 'menuitem');
    btn.disabled = !!item.disabled;
    if (item.disabled) btn.setAttribute('aria-disabled', 'true');
    if (item.checked !== undefined) btn.setAttribute('aria-checked', String(item.checked));

    const checkSlot = document.createElement('span');
    checkSlot.className = 'faisal-ctxmenu-check';
    if (item.checked) checkSlot.append(renderMenuIcon(ICON_CHECK));
    btn.append(checkSlot);

    if (item.icon) {
      const iconSlot = document.createElement('span');
      iconSlot.className = 'faisal-ctxmenu-icon';
      iconSlot.append(renderMenuIcon(item.icon));
      btn.append(iconSlot);
    }

    const label = document.createElement('span');
    label.className = 'faisal-ctxmenu-label';
    label.textContent = item.label ?? '';
    btn.append(label);

    btn.addEventListener('click', () => {
      if (item.disabled) return;
      close();
      item.action?.();
    });
    menu.append(btn);
    entries.push({ el: btn, item });
  }

  document.body.append(menu);

  // Measure then position, flipping/clamping to stay inside the viewport.
  const rect = menu.getBoundingClientRect();
  const { left, top } = placeMenu(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight, rtl);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  let activeIndex = -1;
  function focusable(): { el: HTMLButtonElement; item: ContextMenuItem }[] {
    return entries.filter((e) => !e.item.disabled);
  }
  function focusIndex(i: number) {
    const list = focusable();
    if (list.length === 0) return;
    activeIndex = ((i % list.length) + list.length) % list.length;
    list[activeIndex].el.focus();
  }

  let releaseEsc: (() => void) | null = null;

  function close() {
    if (currentMenu?.el !== menu) return;
    currentMenu = null;
    menu.remove();
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    releaseEsc?.();
    releaseEsc = null;
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('blur', close);
    if (invoker && document.contains(invoker)) invoker.focus();
  }

  function onOutsidePointerDown(ev: PointerEvent) {
    if (!menu.contains(ev.target as Node)) close();
  }

  function onKeyDown(ev: KeyboardEvent) {
    const list = focusable();
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        focusIndex(activeIndex + 1);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        focusIndex(activeIndex - 1);
        break;
      case 'Home':
        ev.preventDefault();
        focusIndex(0);
        break;
      case 'End':
        ev.preventDefault();
        focusIndex(list.length - 1);
        break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        if (activeIndex >= 0) list[activeIndex].el.click();
        break;
      case 'Tab':
        ev.preventDefault();
        break;
      default:
        break;
    }
  }

  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  // Arrow/Home/End/Enter navigation stays on this handler; Escape is the shell's stack (esc.ts).
  document.addEventListener('keydown', onKeyDown, true);
  releaseEsc = pushEscapeLayer(close);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
  window.addEventListener('blur', close);

  currentMenu = { el: menu, close };

  // Focus the first enabled item for keyboard use.
  requestAnimationFrame(() => focusIndex(0));

  return close;
}

/**
 * Wires long-press (500ms) on touch to open a context menu, and suppresses the
 * native browser context menu on `el` (but not on descendants matching
 * `exclude`, e.g. text inputs or embedded app content).
 */
export function wireContextMenu(
  el: HTMLElement,
  onOpen: (x: number, y: number, target: EventTarget | null) => void,
  opts: { exclude?: (target: EventTarget | null) => boolean } = {},
): () => void {
  const isExcluded = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    if (target.closest('input, textarea, [contenteditable="true"]')) return true;
    return opts.exclude?.(target) ?? false;
  };

  function onContextMenu(ev: MouseEvent) {
    if (isExcluded(ev.target)) return;
    ev.preventDefault();
    onOpen(ev.clientX, ev.clientY, ev.target);
  }

  let pressTimer: number | null = null;
  let startX = 0;
  let startY = 0;
  const LONG_PRESS_MS = 500;
  const MOVE_TOLERANCE = 10;

  function clearTimer() {
    if (pressTimer !== null) { window.clearTimeout(pressTimer); pressTimer = null; }
  }

  function onPointerDown(ev: PointerEvent) {
    if (ev.pointerType !== 'touch') return;
    if (isExcluded(ev.target)) return;
    startX = ev.clientX;
    startY = ev.clientY;
    const target = ev.target;
    const x = ev.clientX;
    const y = ev.clientY;
    clearTimer();
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      onOpen(x, y, target);
    }, LONG_PRESS_MS);
  }
  function onPointerMove(ev: PointerEvent) {
    if (pressTimer === null) return;
    if (Math.abs(ev.clientX - startX) > MOVE_TOLERANCE || Math.abs(ev.clientY - startY) > MOVE_TOLERANCE) clearTimer();
  }
  function onPointerUpOrCancel() { clearTimer(); }

  el.addEventListener('contextmenu', onContextMenu);
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUpOrCancel);
  el.addEventListener('pointercancel', onPointerUpOrCancel);

  return () => {
    clearTimer();
    el.removeEventListener('contextmenu', onContextMenu);
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUpOrCancel);
    el.removeEventListener('pointercancel', onPointerUpOrCancel);
  };
}
