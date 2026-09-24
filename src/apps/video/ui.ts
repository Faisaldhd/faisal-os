/**
 * Small DOM builders for Video Studio. Every text goes through `textContent`;
 * nothing here parses markup.
 */
import { t } from '../../kernel/i18n';
import { pushEscapeLayer } from '../../shell/esc';
import { icon, type IconName } from './icons';

/** A string of this app (`video.<key>`). */
export const s = (key: string, vars?: Record<string, string | number>): string => t(`video.${key}`, vars);

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, cls = 'fvs-btn', iconName?: IconName): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  if (iconName) b.append(icon(iconName));
  if (label) b.append(el('span', 'fvs-btn-label', label));
  return b;
}

/** An icon-only button: always an aria-label and a tooltip. */
export function iconButton(label: string, name: IconName, cls = 'fvs-iconbtn'): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(name));
  return b;
}

export function setIcon(b: HTMLElement, name: IconName, label?: string): void {
  const old = b.querySelector('svg');
  const fresh = icon(name);
  if (old) old.replaceWith(fresh);
  else b.prepend(fresh);
  if (label !== undefined) {
    b.title = label;
    b.setAttribute('aria-label', label);
  }
}

export interface Slider {
  root: HTMLElement;
  input: HTMLInputElement;
  set(value: number): void;
}

/**
 * A labelled slider with its value printed beside it. `onInput` runs live,
 * `onCommit` once when the drag ends (the undo step).
 */
export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
  onCommit?: () => void;
}): Slider {
  const root = el('label', 'fvs-slider');
  const head = el('span', 'fvs-slider-head');
  const name = el('span', 'fvs-slider-name', opts.label);
  const value = el('output', 'fvs-slider-value', opts.format(opts.value));
  head.append(name, value);
  const input = el('input', 'fvs-range');
  input.type = 'range';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  input.setAttribute('aria-label', opts.label);
  const paint = () => {
    const v = Number(input.value);
    const pct = ((v - opts.min) / (opts.max - opts.min || 1)) * 100;
    input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
    value.textContent = opts.format(v);
  };
  input.addEventListener('input', () => {
    paint();
    opts.onInput(Number(input.value));
  });
  input.addEventListener('change', () => opts.onCommit?.());
  paint();
  root.append(head, input);
  return {
    root,
    input,
    set(v: number) {
      input.value = String(v);
      paint();
    },
  };
}

/** A row of mutually exclusive buttons (aria-pressed). */
export function segmented<T extends string>(label: string, options: Array<{ value: T; label: string; icon?: IconName }>, value: T, onPick: (v: T) => void): HTMLElement {
  const root = el('div', 'fvs-seg');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);
  const buttons = options.map((o) => {
    const b = button(o.icon ? '' : o.label, 'fvs-seg-btn', o.icon);
    if (o.icon) {
      b.title = o.label;
      b.setAttribute('aria-label', o.label);
    }
    b.setAttribute('aria-pressed', String(o.value === value));
    b.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === b));
      onPick(o.value);
    });
    root.append(b);
    return b;
  });
  return root;
}

export function selectBox<T extends string>(label: string, options: Array<{ value: T; label: string }>, value: T, onPick: (v: T) => void): HTMLElement {
  const root = el('label', 'fvs-field');
  root.append(el('span', 'fvs-field-label', label));
  const select = el('select', 'fvs-select');
  for (const o of options) {
    const opt = el('option', undefined, o.label);
    opt.value = o.value;
    select.append(opt);
  }
  select.value = value;
  select.addEventListener('change', () => onPick(select.value as T));
  root.append(select);
  return root;
}

export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const root = el('label', 'fvs-toggle');
  const input = el('input', 'fvs-toggle-input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('role', 'switch');
  input.addEventListener('change', () => onChange(input.checked));
  root.append(input, el('span', 'fvs-toggle-track'), el('span', 'fvs-toggle-label', label));
  return root;
}

/** A collapsible panel section with a header row (title + chevron). */
export function section(title: string, body: HTMLElement[], open = true): HTMLElement {
  const root = el('section', 'fvs-section');
  const head = el('button', 'fvs-section-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  head.append(el('span', 'fvs-section-title', title), icon('chevronDown'));
  const inner = el('div', 'fvs-section-body');
  inner.append(...body);
  inner.hidden = !open;
  head.addEventListener('click', () => {
    inner.hidden = !inner.hidden;
    head.setAttribute('aria-expanded', String(!inner.hidden));
  });
  root.append(head, inner);
  return root;
}

export function formatClock(seconds: number): string {
  const v = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const m = Math.floor(v / 60);
  const sec = Math.floor(v % 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/* ─────────────────────────────── modal ─────────────────────────────── */

export interface Modal {
  root: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  close(): void;
  onClose(cb: () => void): void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The app's one dialog: overlay + glass card, focus trapped inside, Esc (via the
 * shell's escape stack) and a backdrop click close it, focus returns to where it was.
 * Mounted inside the app window so it follows the window, not the page.
 */
export function openModal(host: HTMLElement, title: string, opts: { wide?: boolean; dismissable?: boolean } = {}): Modal {
  const previous = document.activeElement as HTMLElement | null;
  const overlay = el('div', 'fvs-modal-overlay');
  const card = el('div', `fvs-modal${opts.wide ? ' is-wide' : ''}`);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const heading = el('h2', 'fvs-modal-title', title);
  heading.id = `fvs-modal-${Math.random().toString(36).slice(2)}`;
  card.setAttribute('aria-labelledby', heading.id);
  const closeBtn = iconButton(s('close'), 'close', 'fvs-iconbtn fvs-modal-x');
  const head = el('div', 'fvs-modal-head');
  head.append(heading, closeBtn);
  const body = el('div', 'fvs-modal-body');
  const actions = el('div', 'fvs-modal-actions');
  card.append(head, body, actions);
  overlay.append(card);
  host.append(overlay);
  const listeners: Array<() => void> = [];
  let closed = false;
  const dismissable = opts.dismissable !== false;
  const close = () => {
    if (closed) return;
    closed = true;
    release();
    overlay.remove();
    listeners.forEach((cb) => cb());
    if (previous && previous.isConnected) previous.focus();
  };
  const release = pushEscapeLayer(() => {
    if (dismissable) close();
  });
  closeBtn.addEventListener('click', () => { if (dismissable) close(); });
  closeBtn.hidden = !dismissable;
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay && dismissable) close();
  });
  card.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key !== 'Tab') return;
    const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.hidden && n.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  queueMicrotask(() => {
    const target = card.querySelector<HTMLElement>('[data-autofocus]') ?? card.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  });
  return { root: card, body, actions, close, onClose: (cb) => listeners.push(cb) };
}

/** Name prompt (Save as): resolves the trimmed text, or null when cancelled. */
export function promptName(host: HTMLElement, title: string, label: string, initial: string, okLabel: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = openModal(host, title);
    const field = el('label', 'fvs-field');
    field.append(el('span', 'fvs-field-label', label));
    const input = el('input', 'fvs-input');
    input.type = 'text';
    input.value = initial;
    input.dir = 'auto';
    input.maxLength = 120;
    input.dataset.autofocus = '';
    field.append(input);
    modal.body.append(field);
    const cancel = button(s('cancel'), 'fvs-btn');
    const ok = button(okLabel, 'fvs-btn is-primary');
    modal.actions.append(cancel, ok);
    let answer: string | null = null;
    const submit = () => {
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      answer = value;
      modal.close();
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => modal.close());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    modal.onClose(() => resolve(answer));
    queueMicrotask(() => input.select());
  });
}
