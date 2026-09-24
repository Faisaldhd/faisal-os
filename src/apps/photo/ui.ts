/**
 * Photo Editor — small DOM building blocks. Every visible text goes through `textContent`;
 * the only markup ever parsed is the static icon set (toolbar-icons.ts) via `renderIcon`.
 */
import { renderIcon } from '../../shell/icon';
import { pushEscapeLayer } from '../../shell/esc';
import { ICONS, type IconName } from './toolbar-icons';
import { hexToRgb, hsvToRgb, normaliseHex, rgbToHex, rgbToHsv, SWATCHES, type HSV } from './color';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name: IconName): SVGElement {
  const svg = renderIcon(ICONS[name]);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

/** A text button, optionally with a leading icon. */
export function button(label: string, variant: 'secondary' | 'primary' | 'ghost' | 'danger' = 'secondary', iconName?: IconName): HTMLButtonElement {
  const b = el('button', `fp-btn fp-btn-${variant}`);
  b.type = 'button';
  if (iconName) b.append(icon(iconName));
  b.append(el('span', 'fp-btn-label', label));
  return b;
}

/** An icon-only button: always named (aria-label) and with a tooltip. */
export function iconButton(label: string, name: IconName, cls = ''): HTMLButtonElement {
  const b = el('button', `fp-icon-btn ${cls}`.trim());
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.append(icon(name));
  return b;
}

export interface SliderHandle {
  row: HTMLElement;
  input: HTMLInputElement;
  set(v: number): void;
  get(): number;
}

/** A labelled range slider with a live value label (the suite's slider). */
export function slider(
  label: string, min: number, max: number, value: number, step: number,
  onInput: (v: number) => void, format: (v: number) => string = (v) => String(v),
): SliderHandle {
  const row = el('div', 'fp-slider');
  const head = el('div', 'fp-slider-head');
  const name = el('span', 'fp-slider-name', label);
  const out = el('output', 'fp-slider-value', format(value));
  out.dir = 'ltr';
  head.append(name, out);
  const input = el('input', 'fp-range');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  const paint = () => {
    const v = Number(input.value);
    out.textContent = format(v);
    const pct = ((v - min) / (max - min)) * 100;
    input.style.setProperty('--fp-fill', `${pct}%`);
    // For signed sliders the fill starts at the centre, like a pro "develop" panel.
    input.style.setProperty('--fp-from', min < 0 && max > 0 ? `${(-min / (max - min)) * 100}%` : '0%');
  };
  input.addEventListener('input', () => { paint(); onInput(Number(input.value)); });
  // Double-click (or double-tap) resets a signed slider to zero.
  input.addEventListener('dblclick', () => {
    if (min < 0 && max > 0) { input.value = '0'; paint(); onInput(0); input.dispatchEvent(new Event('change')); }
  });
  paint();
  row.append(head, input);
  return {
    row,
    input,
    set(v: number) { input.value = String(v); paint(); },
    get() { return Number(input.value); },
  };
}

export interface Segmented<T extends string> {
  root: HTMLElement;
  set(v: T): void;
  get(): T;
  buttons: Map<T, HTMLButtonElement>;
}

/** A row of mutually exclusive buttons (aria-pressed), text or icon. */
export function segmented<T extends string>(
  label: string, options: { value: T; label: string; icon?: IconName }[], value: T, onChange: (v: T) => void,
): Segmented<T> {
  const root = el('div', 'fp-seg');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);
  let current = value;
  const buttons = new Map<T, HTMLButtonElement>();
  for (const o of options) {
    const b = o.icon ? iconButton(o.label, o.icon, 'fp-seg-btn') : button(o.label, 'ghost');
    b.classList.add('fp-seg-btn');
    b.addEventListener('click', () => { set(o.value); onChange(o.value); });
    buttons.set(o.value, b);
    root.append(b);
  }
  function set(v: T) {
    current = v;
    for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(k === v));
  }
  set(value);
  return { root, set, get: () => current, buttons };
}

export function selectInput(label: string, options: { value: string; label: string }[], value: string): HTMLSelectElement {
  const s = el('select', 'fp-select');
  s.setAttribute('aria-label', label);
  for (const o of options) {
    const opt = el('option', undefined, o.label);
    opt.value = o.value;
    s.append(opt);
  }
  s.value = value;
  return s;
}

export function numberInput(label: string, min: number, max: number, value: number, step = 1): HTMLInputElement {
  const i = el('input', 'fp-input fp-number');
  i.type = 'number';
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = String(value);
  i.setAttribute('aria-label', label);
  i.inputMode = 'numeric';
  return i;
}

export function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', 'fp-field');
  wrap.append(el('span', 'fp-field-label', label), control);
  return wrap;
}

export function checkbox(label: string, checked: boolean): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', 'fp-check');
  input.type = 'checkbox';
  input.checked = checked;
  const row = el('label', 'fp-checkrow');
  row.append(input, el('span', undefined, label));
  return { row, input };
}

/* ─────────────────────────────── modal ─────────────────────────────── */

export interface Modal {
  root: HTMLElement;
  card: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  title: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  onClose(cb: () => void): void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The suite's in-app modal: overlay, glass card, title, body, [Cancel][Primary] actions.
 * Traps Tab inside, closes on Esc (through the shell's Escape stack) and on an outside click,
 * and gives focus back to whatever had it before.
 */
export function modal(host: HTMLElement, titleText: string, cls = ''): Modal {
  const root = el('div', 'fp-overlay');
  root.hidden = true;
  const card = el('div', `fp-dialog ${cls}`.trim());
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const title = el('h2', 'fp-dialog-title', titleText);
  title.id = `fp-dlg-${Math.random().toString(36).slice(2)}`;
  card.setAttribute('aria-labelledby', title.id);
  const body = el('div', 'fp-dialog-body');
  const actions = el('div', 'fp-dialog-actions');
  card.append(title, body, actions);
  root.append(card);
  host.append(root);
  let release: (() => void) | null = null;
  let returnTo: HTMLElement | null = null;
  const closers: (() => void)[] = [];
  const api: Modal = {
    root, card, body, actions, title,
    open() {
      if (!root.hidden) return;
      returnTo = document.activeElement as HTMLElement | null;
      root.hidden = false;
      release = pushEscapeLayer(() => { release = null; api.close(); });
      queueMicrotask(() => {
        const first = card.querySelector<HTMLElement>('[autofocus], ' + FOCUSABLE);
        first?.focus();
      });
    },
    close() {
      if (root.hidden) return;
      root.hidden = true;
      release?.();
      release = null;
      closers.forEach((c) => c());
      returnTo?.focus?.();
    },
    isOpen: () => !root.hidden,
    onClose(cb) { closers.push(cb); },
  };
  root.addEventListener('pointerdown', (e) => { if (e.target === root) api.close(); });
  card.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key !== 'Tab') return;
    const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  return api;
}

/* ─────────────────────────── colour picker ─────────────────────────── */

export interface ColorPicker {
  root: HTMLElement;
  set(hex: string): void;
  get(): string;
}

/**
 * Saturation/value square + hue bar + hex field + swatches (the mockup's picker). Works with
 * pointer, touch and keyboard (arrow keys move the square and the hue).
 */
export function colorPicker(labels: { sv: string; hue: string; hex: string; swatches: string }, value: string, onChange: (hex: string) => void): ColorPicker {
  const root = el('div', 'fp-picker');
  const sv = el('div', 'fp-picker-sv');
  sv.tabIndex = 0;
  sv.setAttribute('role', 'slider');
  sv.setAttribute('aria-label', labels.sv);
  const svKnob = el('div', 'fp-picker-knob');
  sv.append(svKnob);
  const hue = el('div', 'fp-picker-hue');
  hue.tabIndex = 0;
  hue.setAttribute('role', 'slider');
  hue.setAttribute('aria-label', labels.hue);
  hue.setAttribute('aria-valuemin', '0');
  hue.setAttribute('aria-valuemax', '360');
  const hueKnob = el('div', 'fp-picker-knob');
  hue.append(hueKnob);
  const row = el('div', 'fp-picker-row');
  const chip = el('span', 'fp-picker-chip');
  const hex = el('input', 'fp-input fp-picker-hex');
  hex.setAttribute('aria-label', labels.hex);
  hex.spellcheck = false;
  hex.maxLength = 7;
  row.append(chip, hex);
  const sw = el('div', 'fp-picker-swatches');
  sw.setAttribute('role', 'group');
  sw.setAttribute('aria-label', labels.swatches);
  for (const c of SWATCHES) {
    const b = el('button', 'fp-swatch');
    b.type = 'button';
    b.style.background = c;
    b.setAttribute('aria-label', c);
    b.title = c;
    b.addEventListener('click', () => { set(c); onChange(c); });
    sw.append(b);
  }
  root.append(sv, hue, row, sw);

  let hsv: HSV = rgbToHsv(hexToRgb(value));
  let current = normaliseHex(value) ?? '#000000';

  function paint() {
    sv.style.setProperty('--fp-hue', `hsl(${hsv.h} 100% 50%)`);
    svKnob.style.left = `${hsv.s * 100}%`;
    svKnob.style.top = `${(1 - hsv.v) * 100}%`;
    hueKnob.style.left = `${(hsv.h / 360) * 100}%`;
    chip.style.background = current;
    if (document.activeElement !== hex) hex.value = current;
    hue.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
    sv.setAttribute('aria-valuetext', current);
  }
  function emit() {
    current = rgbToHex(hsvToRgb(hsv));
    paint();
    onChange(current);
  }
  function set(h: string) {
    const n = normaliseHex(h);
    if (!n) return;
    current = n;
    const next = rgbToHsv(hexToRgb(n));
    // Keep the hue when the colour is grey, so the square does not jump to red.
    hsv = next.s === 0 ? { ...next, h: hsv.h } : next;
    paint();
  }
  const drag = (target: HTMLElement, fn: (fx: number, fy: number) => void) => {
    target.addEventListener('pointerdown', (e) => {
      target.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = target.getBoundingClientRect();
        fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
      };
      move(e);
      const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
    });
  };
  drag(sv, (fx, fy) => { hsv = { ...hsv, s: fx, v: 1 - fy }; emit(); });
  drag(hue, (fx) => { hsv = { ...hsv, h: Math.min(359.9, fx * 360) }; emit(); });
  sv.addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') hsv = { ...hsv, s: Math.max(0, hsv.s - d) };
    else if (e.key === 'ArrowRight') hsv = { ...hsv, s: Math.min(1, hsv.s + d) };
    else if (e.key === 'ArrowUp') hsv = { ...hsv, v: Math.min(1, hsv.v + d) };
    else if (e.key === 'ArrowDown') hsv = { ...hsv, v: Math.max(0, hsv.v - d) };
    else return;
    e.preventDefault();
    emit();
  });
  hue.addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') hsv = { ...hsv, h: (hsv.h - d + 360) % 360 };
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') hsv = { ...hsv, h: (hsv.h + d) % 360 };
    else return;
    e.preventDefault();
    emit();
  });
  hex.addEventListener('change', () => {
    const n = normaliseHex(hex.value);
    if (n) { set(n); onChange(n); } else hex.value = current;
  });
  paint();
  return { root, set, get: () => current };
}
