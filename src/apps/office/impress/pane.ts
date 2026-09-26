/**
 * Impress — the Format pane (لوحة تنسيق الشكل), WPS's task pane for the selected shape.
 *
 * One panel at the side of the slide (a bottom sheet on a phone) with the four things a shape
 * has: its fill, its outline, its text, and its size and position — plus the link a click opens
 * in the show. Every control commits one undoable edit through the handlers; nothing here touches
 * the model. With nothing selected the panel says so and offers the Design tab instead.
 */
import { t } from '../../../kernel/i18n';
import { button, el } from '../ui/dom';
import { icon } from '../ui/icons';
import { EMU_PER_PT, type Deck, type DeckShape } from './deck';
import { canFill, canOutline, type ShapeLook } from './ops';
import { paraStyleOf, type ParaStylePatch } from './parafmt';

/** The font families offered: ones that carry Arabic on Windows, macOS and most phones. */
export const FONT_FAMILIES: readonly string[] = ['Segoe UI', 'Tahoma', 'Arial', 'Calibri', 'Times New Roman', 'Georgia', 'Trebuchet MS', 'Verdana', 'Courier New'];
export const FONT_SIZES: readonly number[] = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 54, 60, 72];
/** Outline weights in points, the list PowerPoint offers. */
const WEIGHTS: readonly number[] = [0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6];
const EMU_PER_CM = 360000;

export interface PaneHandlers {
  look(patch: ShapeLook): void;
  text(patch: ParaStylePatch): void;
  bounds(b: { x: number; y: number; w: number; h: number }): void;
  /** Returns false when the address is refused (the field then says why). */
  link(url: string | null): boolean;
  close(): void;
  /** The empty state's action: open the Design tab. */
  design(): void;
}

export interface FormatPane {
  element: HTMLElement;
  update(deck: Deck | null, shape: DeckShape | null, editable: boolean): void;
}

/** The colours a swatch row offers: the deck's theme first, then black and white. */
function swatchColors(deck: Deck): string[] {
  const keys = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'dk1', 'dk2', 'lt2'];
  const out = keys.map((k) => deck.scheme[k]).filter((c): c is string => !!c);
  for (const c of ['#000000', '#FFFFFF']) if (!out.includes(c)) out.push(c);
  return [...new Set(out.map((c) => c.toUpperCase()))];
}

function section(title: string, ...rows: HTMLElement[]): HTMLElement {
  const box = el('section', 'fo-imp-panesec');
  box.append(el('h3', 'fo-imp-panehead', title), ...rows);
  return box;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const row = el('label', 'fo-imp-panefield');
  row.append(el('span', 'fo-imp-panelabel', label), control);
  return row;
}

/** A row of colour swatches, a "none" chip and a custom colour well. */
function colorRow(deck: Deck, value: string | null, noneLabel: string | null, pick: (c: string | null) => void, disabled: boolean): HTMLElement {
  const row = el('div', 'fo-imp-swatches');
  if (noneLabel) {
    const none = el('button', 'fo-imp-swatch is-none');
    none.type = 'button';
    none.title = noneLabel;
    none.setAttribute('aria-label', noneLabel);
    none.setAttribute('aria-pressed', String(value === null));
    none.disabled = disabled;
    none.addEventListener('click', () => pick(null));
    row.append(none);
  }
  for (const c of swatchColors(deck)) {
    const sw = el('button', 'fo-imp-swatch');
    sw.type = 'button';
    sw.style.background = c;
    sw.title = c;
    sw.setAttribute('aria-label', c);
    sw.setAttribute('aria-pressed', String((value ?? '').toUpperCase() === c));
    sw.disabled = disabled;
    sw.addEventListener('click', () => pick(c));
    row.append(sw);
  }
  const well = el('input', 'fo-imp-well');
  well.type = 'color';
  well.value = value && /^#[0-9A-F]{6}$/i.test(value) ? value.toLowerCase() : '#000000';
  well.setAttribute('aria-label', t('impress.paneCustomColor'));
  well.title = t('impress.paneCustomColor');
  well.disabled = disabled;
  well.addEventListener('change', () => pick(well.value.toUpperCase()));
  row.append(well);
  return row;
}

function select(label: string, options: ReadonlyArray<{ value: string; label: string }>, value: string, change: (v: string) => void, disabled: boolean): HTMLSelectElement {
  const s = el('select', 'fo-select fo-imp-paneselect');
  s.setAttribute('aria-label', label);
  for (const o of options) { const op = el('option', undefined, o.label); op.value = o.value; s.append(op); }
  if (!options.some((o) => o.value === value)) { const op = el('option', undefined, value); op.value = value; s.append(op); }
  s.value = value;
  s.disabled = disabled;
  s.addEventListener('change', () => change(s.value));
  return s;
}

function numberBox(label: string, emu: number, change: (emu: number) => void, disabled: boolean): HTMLElement {
  const input = el('input', 'fo-input fo-imp-panenum');
  input.type = 'number';
  input.step = '0.01';
  input.min = '0';
  input.inputMode = 'decimal';
  input.value = (emu / EMU_PER_CM).toFixed(2);
  input.disabled = disabled;
  input.dir = 'ltr';
  input.addEventListener('change', () => {
    const cm = Number(input.value);
    if (Number.isFinite(cm) && cm >= 0) change(Math.round(cm * EMU_PER_CM));
  });
  const wrap = el('span', 'fo-imp-paneunit');
  wrap.append(input, el('span', 'fo-imp-paneunitname', t('impress.paneUnit')));
  return field(label, wrap);
}

export function createFormatPane(h: PaneHandlers): FormatPane {
  const root = el('aside', 'fo-imp-pane');
  root.setAttribute('aria-label', t('impress.paneTitle'));
  const head = el('div', 'fo-imp-panetop');
  const grab = el('div', 'fo-imp-panegrab');
  grab.setAttribute('aria-hidden', 'true');
  head.append(grab, el('h2', 'fo-imp-panetitle', t('impress.paneTitle')), button('close', t('impress.paneClose'), () => h.close(), { cls: 'fo-imp-paneclose' }));
  const body = el('div', 'fo-imp-panebody');
  root.append(head, body);
  let shown = '';

  function empty(): void {
    const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    art.setAttribute('viewBox', '0 0 120 72');
    art.setAttribute('width', '120');
    art.setAttribute('height', '72');
    art.setAttribute('aria-hidden', 'true');
    art.classList.add('fo-imp-paneart');
    const add = (tag: string, attrs: Record<string, string>): void => {
      const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      art.append(n);
    };
    add('rect', { x: '8', y: '8', width: '104', height: '56', rx: '6', fill: 'none', stroke: 'currentColor', 'stroke-opacity': '.35' });
    add('rect', { x: '26', y: '22', width: '44', height: '28', rx: '4', fill: 'var(--app-copper)', 'fill-opacity': '.35', stroke: 'var(--app-copper)' });
    add('path', { d: 'M78 40l14 14M78 40v12l4-4h8z', fill: 'var(--app-blue)', stroke: 'var(--app-blue)', 'stroke-linejoin': 'round' });
    const box = el('div', 'fo-imp-paneempty');
    box.append(art, el('p', undefined, t('impress.paneEmpty')), button('theme', t('impress.paneEmptyAction'), () => h.design(), { showLabel: true }));
    body.replaceChildren(box);
  }

  function update(deck: Deck | null, shape: DeckShape | null, editable: boolean): void {
    // Typing in one of the pane's own fields must not be interrupted by the redraw it caused.
    if (root.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT' && shown === `${shape?.uid}`) return;
    shown = `${shape?.uid}`;
    if (!deck || !shape) { empty(); return; }
    if (shape.locked) { body.replaceChildren(el('p', 'fo-imp-panenote', t('impress.paneLocked'))); return; }
    const off = !editable;
    const parts: HTMLElement[] = [];
    if (canFill(shape)) {
      parts.push(section(t('impress.paneFill'), colorRow(deck, shape.fill, t('impress.noFill'), (c) => h.look({ fill: c }), off)));
    }
    if (canOutline(shape)) {
      const weight = select(t('impress.paneWidth'), WEIGHTS.map((w) => ({ value: String(w), label: `${w} pt` })),
        String(Math.round((shape.strokeW / EMU_PER_PT) * 100) / 100), (v) => h.look({ strokeW: Number(v) * EMU_PER_PT }), off || !shape.stroke);
      parts.push(section(t('impress.paneOutline'),
        colorRow(deck, shape.stroke, shape.kind === 'line' ? null : t('impress.noOutline'), (c) => h.look({ stroke: c }), off),
        field(t('impress.paneWidth'), weight)));
    }
    const style = (shape.kind === 'text' || shape.kind === 'shape') ? paraStyleOf(shape.paras) : null;
    if (style) {
      const font = select(t('impress.font'), [{ value: '', label: t('impress.fontTheme') }, ...FONT_FAMILIES.map((f) => ({ value: f, label: f }))],
        style.font ?? '', (v) => h.text({ font: v || null }), off);
      const size = select(t('impress.fontSize'), FONT_SIZES.map((n) => ({ value: String(n), label: String(n) })),
        String(style.size ?? 18), (v) => h.text({ size: Number(v) }), off);
      const toggles = el('div', 'fo-imp-panetoggles');
      const toggle = (name: 'bold' | 'italic' | 'underline', on: boolean): void => {
        const b = button(name, t(`impress.${name}`), () => h.text({ [name]: !on }), { toggle: true });
        b.setAttribute('aria-pressed', String(on));
        b.disabled = off;
        toggles.append(b);
      };
      toggle('bold', style.bold);
      toggle('italic', style.italic);
      toggle('underline', style.underline);
      for (const [a, name, label] of [['r', 'alignRight', 'impress.alignRight'], ['ctr', 'alignCenter', 'impress.alignCenter'], ['l', 'alignLeft', 'impress.alignLeft'], ['just', 'alignJustify', 'impress.alignJustify']] as const) {
        const b = button(name, t(label), () => h.text({ align: a }), { toggle: true });
        b.setAttribute('aria-pressed', String(style.align === a));
        b.disabled = off;
        toggles.append(b);
      }
      parts.push(section(t('impress.paneText'), field(t('impress.font'), font), field(t('impress.fontSize'), size), toggles,
        colorRow(deck, style.color, t('impress.colorAuto'), (c) => h.text({ color: c }), off)));
    }
    const b = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    const grid = el('div', 'fo-imp-panegrid');
    grid.append(
      numberBox(t('impress.paneW'), b.w, (v) => h.bounds({ ...b, w: Math.max(12700, v) }), off),
      numberBox(t('impress.paneH'), b.h, (v) => h.bounds({ ...b, h: shape.kind === 'line' ? v : Math.max(12700, v) }), off),
      numberBox(t('impress.paneX'), b.x, (v) => h.bounds({ ...b, x: v }), off),
      numberBox(t('impress.paneY'), b.y, (v) => h.bounds({ ...b, y: v }), off),
    );
    parts.push(section(t('impress.paneSize'), grid));
    if (shape.kind !== 'group') {
      const input = el('input', 'fo-input fo-imp-panelink');
      input.type = 'url';
      input.dir = 'ltr';
      input.placeholder = 'https://';
      input.value = shape.link ?? '';
      input.disabled = off;
      input.setAttribute('aria-label', t('impress.link'));
      const error = el('p', 'fo-imp-paneerror');
      error.setAttribute('role', 'status');
      const setLink = (): void => {
        const v = input.value.trim();
        error.textContent = h.link(v || null) ? '' : t('impress.linkBad');
      };
      input.addEventListener('change', setLink);
      const row = el('div', 'fo-imp-panelinkrow');
      const clear = button('close', t('impress.linkRemove'), () => { input.value = ''; setLink(); }, { cls: 'fo-imp-panelinkclear' });
      clear.disabled = off || !shape.link;
      row.append(icon('link'), input, clear);
      parts.push(section(t('impress.paneLink'), row, error, el('p', 'fo-imp-panenote', t('impress.linkHint'))));
    }
    body.replaceChildren(...parts);
  }

  return { element: root, update };
}
