/**
 * Office — the status bar (شريط الحالة), shared by every editor.
 *
 * Inline-start: what the editor reports about the caret or the selection (page and
 * words in Writer, the cell and the sum in the sheet, "slide n of N" in the deck).
 * Middle: the last message (saved, exported…), announced politely to screen readers.
 * Inline-end: the file's path and the zoom control (minus, a slider with its value,
 * plus), shown only when the editor offers a zoom.
 *
 * Everything is written with `textContent`; the bar holds no document state, it is
 * redrawn from `update()` after every change.
 */
import type { StatusInfo } from '../editor';
import { button, clamp, el } from './dom';

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

/** A zoom value rounded to whole percent and kept within the bar's range. */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return clamp(Math.round(value * 100) / 100, ZOOM_MIN, ZOOM_MAX);
}

/** The next step up or down, snapped to the 10% grid so 93% + 10% lands on 100%. */
export function stepZoom(value: number, dir: 1 | -1): number {
  const pct = Math.round(value * 100);
  const grid = ZOOM_STEP * 100;
  const snapped = dir > 0 ? Math.floor(pct / grid) * grid + grid : Math.ceil(pct / grid) * grid - grid;
  return clampZoom(snapped / 100);
}

export interface StatusBarLabels {
  bar: string;
  zoomIn: string;
  zoomOut: string;
  zoomLevel: string;
}

export class StatusBar {
  readonly element: HTMLElement;
  /** The live message line (role=status). */
  readonly message: HTMLElement;
  /** The file's path (always left-to-right). */
  readonly path: HTMLElement;
  private readonly parts: HTMLElement;
  private readonly zoomBox: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly zoomValue: HTMLElement;
  private readonly zoomOut: HTMLButtonElement;
  private readonly zoomIn: HTMLButtonElement;
  private zoom: StatusInfo['zoom'];
  private sig = '';

  constructor(labels: StatusBarLabels) {
    this.element = el('footer', 'fo-statusbar');
    this.element.setAttribute('aria-label', labels.bar);
    this.parts = el('div', 'fo-status-parts');
    this.message = el('div', 'faisal-office-status fo-status-msg');
    this.message.setAttribute('role', 'status');
    this.message.setAttribute('aria-live', 'polite');
    this.path = el('div', 'faisal-office-path fo-path');
    this.path.dir = 'ltr';

    this.zoomBox = el('div', 'fo-zoom');
    this.zoomBox.setAttribute('role', 'group');
    this.zoomBox.setAttribute('aria-label', labels.zoomLevel);
    this.zoomOut = button('minus', labels.zoomOut, () => this.setZoom(stepZoom(this.zoom?.value ?? 1, -1)));
    this.zoomIn = button('plus', labels.zoomIn, () => this.setZoom(stepZoom(this.zoom?.value ?? 1, 1)));
    this.slider = el('input', 'fo-zoom-slider');
    this.slider.type = 'range';
    this.slider.min = String(ZOOM_MIN * 100);
    this.slider.max = String(ZOOM_MAX * 100);
    this.slider.step = String(ZOOM_STEP * 100);
    this.slider.setAttribute('aria-label', labels.zoomLevel);
    this.slider.addEventListener('input', () => this.setZoom(Number(this.slider.value) / 100));
    this.zoomValue = el('output', 'fo-zoom-value');
    this.zoomValue.dir = 'ltr';
    this.zoomBox.append(this.zoomOut, this.slider, this.zoomIn, this.zoomValue);
    this.zoomBox.hidden = true;

    this.element.append(this.parts, this.message, this.path, this.zoomBox);
  }

  /** Redraws from what the editor reports (none: the start screen) and the current message. */
  update(info: StatusInfo | undefined, message: string): void {
    const parts = info?.parts ?? [];
    const sig = parts.join('\u0001');
    if (sig !== this.sig) {
      this.sig = sig;
      this.parts.replaceChildren(...parts.map((p) => el('span', 'fo-status-part', p)));
    }
    if (this.message.textContent !== message) this.message.textContent = message;
    this.zoom = info?.zoom;
    this.zoomBox.hidden = !this.zoom;
    if (this.zoom) this.showZoom(this.zoom.value);
  }

  private showZoom(value: number): void {
    const pct = Math.round(value * 100);
    this.zoomValue.textContent = `${pct}%`;
    this.slider.value = String(pct);
    this.slider.setAttribute('aria-valuetext', `${pct}%`);
    this.slider.style.setProperty('--fo-fill', `${((value - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100}%`);
    this.zoomOut.disabled = value <= ZOOM_MIN + 1e-6;
    this.zoomIn.disabled = value >= ZOOM_MAX - 1e-6;
  }

  private setZoom(value: number): void {
    const zoom = this.zoom;
    if (!zoom) return;
    const next = clampZoom(value);
    zoom.set(next);
    // The editor may clamp further (a fitted page); show what it kept.
    this.showZoom(next);
  }
}
