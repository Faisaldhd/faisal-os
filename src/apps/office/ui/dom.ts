/**
 * Office — small DOM helpers shared by every part of the suite.
 *
 * Text always goes in through `textContent`; nothing here accepts markup.
 */
import { icon, type IconName } from './icons';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A label only screen readers (and `textContent`) see. */
export function srOnly(text: string): HTMLSpanElement {
  return el('span', 'fo-sr', text);
}

export interface ButtonOptions {
  /** Show the label next to the icon (otherwise it is a screen-reader label plus a tooltip). */
  showLabel?: boolean;
  primary?: boolean;
  /** A toggle button: `aria-pressed` is kept by the caller through `setPressed`. */
  toggle?: boolean;
  cls?: string;
  /** Keep the document's selection when the button is pressed with a pointer. */
  keepFocus?: boolean;
}

/**
 * A button with an icon and a label. The label is always part of the button's
 * text, visible or not, so the accessible name and `textContent` are the label
 * itself; the tooltip repeats it for pointer users.
 */
export function button(iconName: IconName | null, label: string, onClick: (ev: MouseEvent) => void, opts: ButtonOptions = {}): HTMLButtonElement {
  const b = el('button', `fo-btn${opts.primary ? ' is-primary' : ''}${opts.showLabel ? ' has-label' : ' is-icon'}${opts.cls ? ` ${opts.cls}` : ''}`);
  b.type = 'button';
  b.title = label;
  if (iconName) b.append(icon(iconName));
  b.append(opts.showLabel ? el('span', 'fo-btn-label', label) : srOnly(label));
  if (opts.toggle) b.setAttribute('aria-pressed', 'false');
  if (opts.keepFocus) b.addEventListener('mousedown', (ev) => ev.preventDefault());
  b.addEventListener('click', onClick);
  return b;
}

export function setPressed(b: HTMLElement, on: boolean): void {
  b.setAttribute('aria-pressed', String(on));
}

/** Clamps a number into a range (used by zoom, sizes and grid math). */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** True when the element (or the window it lives in) should use the phone layout. */
export const NARROW_BREAKPOINT = 700;

/** Is this a coarse pointer (touch) device? Used to size targets, never to hide features. */
export function coarsePointer(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch { return false; }
}

/** Downloads bytes as a file through a temporary object URL. */
export function downloadBytes(bytes: Uint8Array | string, name: string, mime: string): void {
  const blob = new Blob([typeof bytes === 'string' ? bytes : bytes.slice()], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
