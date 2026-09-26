/**
 * Impress — the picture galleries of the ribbon (معارض الشريط): slide layouts drawn as little
 * slides, the shape gallery, the design themes and the table-size grid.
 *
 * Every picture is built node by node (`createElementNS` for SVG, `textContent` for words), so no
 * markup is ever parsed. Each gallery is a grid of real buttons: Tab and Enter work, and each one
 * is at least 44px tall on a touch screen.
 */
import { getLocale, t } from '../../../kernel/i18n';
import { el } from '../ui/dom';
import type { Deck } from './deck';
import { geometry } from './render';
import { layoutShapes, SLIDE_LAYOUTS, type NewShapeKind, type SlideLayoutKind } from './ops';
import { THEMES, type DeckTheme } from './themes';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export const LAYOUT_LABEL: Record<SlideLayoutKind, string> = {
  title: 'office.impLayoutTitle', content: 'office.impLayoutContent', two: 'office.impLayoutTwo', blank: 'office.impLayoutBlank',
};

/**
 * A layout as a little slide: the placeholders where a new slide will have them — a heavy bar for
 * a title, text lines for a body — in the deck's own colours when a theme is given.
 */
export function layoutThumb(kind: SlideLayoutKind, colors: { bg: string; title: string; body: string; accent: string }): SVGElement {
  const W = 96;
  const H = 54;
  const pic = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', class: 'fo-imp-layoutsvg' });
  pic.append(svg('rect', { x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 3, fill: colors.bg, stroke: 'currentColor', 'stroke-opacity': 0.25 }));
  for (const s of layoutShapes(kind, W, H)) {
    const title = s.ph === 'title' || s.ph === 'ctrTitle';
    pic.append(svg('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: 1.5, fill: 'none', stroke: colors.body, 'stroke-opacity': 0.35, 'stroke-dasharray': '2 1.5' }));
    if (title) {
      const w = s.w * 0.6;
      const x = s.paras[0]?.align === 'ctr' ? s.x + (s.w - w) / 2 : s.x + 3;
      pic.append(svg('rect', { x, y: s.y + s.h / 2 - 2.5, width: w, height: 5, rx: 1.5, fill: colors.title }));
    } else {
      const lines = Math.max(1, Math.min(4, Math.floor(s.h / 7)));
      for (let i = 0; i < lines; i++) {
        const w = (i % 2 ? 0.6 : 0.8) * s.w * (s.ph === 'subTitle' ? 0.7 : 1);
        const x = s.ph === 'subTitle' ? s.x + (s.w - w) / 2 : s.x + 3;
        pic.append(svg('rect', { x, y: s.y + 4 + i * 6, width: w, height: 2.5, rx: 1, fill: i === 0 && s.ph !== 'subTitle' ? colors.accent : colors.body, 'fill-opacity': 0.7 }));
      }
    }
  }
  return pic;
}

/** The colours a gallery picture uses for this deck: its master's, else its theme's. */
export function deckColors(deck: Deck): { bg: string; title: string; body: string; accent: string } {
  const m = deck.masters[0];
  return {
    bg: m?.bg ?? deck.scheme.lt1 ?? '#FFFFFF',
    title: m?.title.color ?? deck.scheme.dk2 ?? '#1F2937',
    body: m?.body.color ?? deck.scheme.dk1 ?? '#374151',
    accent: deck.scheme.accent1 ?? '#4472C4',
  };
}

/** The "New slide" gallery: one picture button per layout. */
export function layoutGallery(deck: Deck, pick: (kind: SlideLayoutKind) => void): HTMLElement {
  const grid = el('div', 'fo-imp-gallery is-layouts');
  grid.setAttribute('role', 'listbox');
  grid.setAttribute('aria-label', t('impress.layoutPick'));
  const colors = deckColors(deck);
  for (const kind of SLIDE_LAYOUTS) {
    const b = el('button', 'fo-imp-galitem');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.dataset.layout = kind;
    b.title = t(LAYOUT_LABEL[kind]);
    b.append(layoutThumb(kind, colors), el('span', 'fo-imp-galname', t(LAYOUT_LABEL[kind])));
    b.addEventListener('click', () => pick(kind));
    grid.append(b);
  }
  return grid;
}

/** The shapes the gallery offers, in the groups WPS shows them in. */
export const SHAPE_GROUPS: ReadonlyArray<{ label: string; items: ReadonlyArray<{ kind: NewShapeKind; geom: string; label: string }> }> = [
  { label: 'impress.shapesBasic', items: [
    { kind: 'rect', geom: 'rect', label: 'office.impRect' },
    { kind: 'roundRect', geom: 'roundRect', label: 'impress.shapeRoundRect' },
    { kind: 'ellipse', geom: 'ellipse', label: 'office.impEllipse' },
    { kind: 'triangle', geom: 'triangle', label: 'impress.shapeTriangle' },
    { kind: 'rtTriangle', geom: 'rtTriangle', label: 'impress.shapeRtTriangle' },
    { kind: 'diamond', geom: 'diamond', label: 'impress.shapeDiamond' },
    { kind: 'hexagon', geom: 'hexagon', label: 'impress.shapeHexagon' },
    { kind: 'star5', geom: 'star5', label: 'impress.shapeStar' },
  ] },
  { label: 'impress.shapesArrows', items: [
    { kind: 'arrow', geom: 'rightArrow', label: 'impress.shapeRightArrow' },
    { kind: 'leftArrow', geom: 'leftArrow', label: 'impress.shapeLeftArrow' },
    { kind: 'upArrow', geom: 'upArrow', label: 'impress.shapeUpArrow' },
    { kind: 'downArrow', geom: 'downArrow', label: 'impress.shapeDownArrow' },
  ] },
  { label: 'impress.shapesLines', items: [
    { kind: 'line', geom: 'line', label: 'office.impLine' },
  ] },
];

/** One shape as a 24px glyph, in the current text colour. */
function shapeGlyph(geom: string): SVGElement {
  const pic = svg('svg', { viewBox: '0 0 28 28', width: 28, height: 28, 'aria-hidden': 'true' });
  const g = svg('g', { transform: 'translate(3 5)', fill: 'currentColor', 'fill-opacity': 0.18, stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' });
  if (geom === 'line') g.append(svg('line', { x1: 0, y1: 18, x2: 22, y2: 0, 'stroke-linecap': 'round' }));
  else g.append(geometry(geom, 22, 18));
  pic.append(g);
  return pic;
}

/** The shape gallery: headed groups of glyph buttons. */
export function shapeGallery(pick: (kind: NewShapeKind) => void): HTMLElement {
  const box = el('div', 'fo-imp-shapes');
  for (const group of SHAPE_GROUPS) {
    box.append(el('div', 'fo-imp-galhead', t(group.label)));
    const grid = el('div', 'fo-imp-gallery is-shapes');
    for (const item of group.items) {
      const b = el('button', 'fo-imp-galitem is-glyph');
      b.type = 'button';
      b.dataset.shape = item.kind;
      b.title = t(item.label);
      b.setAttribute('aria-label', t(item.label));
      b.append(shapeGlyph(item.geom));
      b.addEventListener('click', () => pick(item.kind));
      grid.append(b);
    }
    box.append(grid);
  }
  return box;
}

/** The theme's name in the window's language. */
export function themeName(theme: DeckTheme): string {
  return getLocale() === 'ar' ? theme.ar : theme.en;
}

/** A theme as a little title slide: its background, "Aa" in its heading font, and its accents. */
export function themeCard(theme: DeckTheme, current: boolean, pick: (theme: DeckTheme) => void): HTMLButtonElement {
  const b = el('button', 'fo-imp-theme');
  b.type = 'button';
  b.dataset.theme = theme.id;
  b.title = themeName(theme);
  b.setAttribute('aria-pressed', String(current));
  const face = el('span', 'fo-imp-themeface');
  face.style.background = theme.bg;
  const aa = el('span', 'fo-imp-themeaa', 'Aa');
  aa.style.color = theme.title;
  aa.style.fontFamily = `"${theme.major}", var(--fo-doc-font)`;
  const line = el('span', 'fo-imp-themeline');
  line.style.background = theme.body;
  const dots = el('span', 'fo-imp-themedots');
  for (const k of ['accent1', 'accent2', 'accent3', 'accent4'] as const) {
    const d = el('span', 'fo-imp-themedot');
    d.style.background = theme.colors[k];
    dots.append(d);
  }
  face.append(aa, line, dots);
  b.append(face, el('span', 'fo-imp-galname', themeName(theme)));
  b.addEventListener('click', () => pick(theme));
  return b;
}

/** Every theme as a card; `currentId` is marked pressed. */
export function themeGallery(currentId: string | null, pick: (theme: DeckTheme) => void): HTMLElement {
  const grid = el('div', 'fo-imp-gallery is-themes');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', t('impress.themes'));
  for (const theme of THEMES) grid.append(themeCard(theme, theme.id === currentId, pick));
  return grid;
}

/**
 * The table-size grid: point at (or Tab to) a cell and the label says "rows × columns"; a click
 * inserts a table of that size.
 */
export function tablePicker(pick: (rows: number, cols: number) => void): HTMLElement {
  const ROWS = 6;
  const COLS = 6;
  const box = el('div', 'fo-imp-tablepick');
  const label = el('div', 'fo-imp-tablelabel', t('impress.tablePick'));
  label.dir = 'ltr';
  const grid = el('div', 'fo-imp-tablegrid');
  const cells: HTMLButtonElement[] = [];
  const mark = (r: number, c: number): void => {
    cells.forEach((cell) => {
      const cr = Number(cell.dataset.r);
      const cc = Number(cell.dataset.c);
      cell.classList.toggle('is-on', cr <= r && cc <= c);
    });
    label.textContent = `${r} × ${c}`;
  };
  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLS; c++) {
      const cell = el('button', 'fo-imp-tablecell');
      cell.type = 'button';
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.setAttribute('aria-label', t('impress.tableSize', { rows: r, cols: c }));
      cell.addEventListener('pointerenter', () => mark(r, c));
      cell.addEventListener('focus', () => mark(r, c));
      cell.addEventListener('click', () => pick(r, c));
      cells.push(cell);
      grid.append(cell);
    }
  }
  box.append(grid, label);
  return box;
}
