/**
 * Impress — drawing a slide (رسم الشريحة).
 *
 * A slide is drawn on a canvas of its real size in points (1 CSS px = 1 pt =
 * 12700 EMU), every shape absolutely positioned where the file puts it, and the
 * whole canvas is scaled to fit with one CSS transform. The same drawing serves the
 * editor, the thumbnails, the slideshow and the presenter view. All text goes in
 * through `textContent`; pictures through object URLs of their bytes.
 */
import { t } from '../../../kernel/i18n';
import { el } from '../ui/dom';
import { EMU_PER_PT, type Deck, type DeckMaster, type DeckShape, type DeckSlide, type MasterText } from './deck';

const SVG_NS = 'http://www.w3.org/2000/svg';
const pt = (emu: number): number => emu / EMU_PER_PT;

const urls = new WeakMap<Uint8Array, string>();
function imageUrl(bytes: Uint8Array, mime: string): string {
  let url = urls.get(bytes);
  if (!url && typeof URL.createObjectURL !== 'function') return '';
  if (!url) {
    url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
    urls.set(bytes, url);
  }
  return url;
}

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** The outline of a preset geometry in a w×h box (the common ones; anything else is a rectangle). */
function geometry(geom: string, w: number, h: number): SVGElement {
  const poly = (pts: Array<[number, number]>): SVGElement => svg('polygon', { points: pts.map(([x, y]) => `${x},${y}`).join(' ') });
  const m = Math.min(w, h);
  switch (geom) {
    case 'ellipse': return svg('ellipse', { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 });
    case 'roundRect': return svg('rect', { x: 0, y: 0, width: w, height: h, rx: m * 0.16 });
    case 'triangle': return poly([[w / 2, 0], [w, h], [0, h]]);
    case 'rtTriangle': return poly([[0, 0], [w, h], [0, h]]);
    case 'diamond': return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case 'rightArrow': { const head = Math.min(w, h * 0.5 * 2) * 0.5; return poly([[0, h * 0.25], [w - head, h * 0.25], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h * 0.75], [0, h * 0.75]]); }
    case 'leftArrow': { const head = Math.min(w, h) * 0.5; return poly([[w, h * 0.25], [head, h * 0.25], [head, 0], [0, h / 2], [head, h], [head, h * 0.75], [w, h * 0.75]]); }
    case 'upArrow': { const head = Math.min(w, h) * 0.5; return poly([[w * 0.25, h], [w * 0.25, head], [0, head], [w / 2, 0], [w, head], [w * 0.75, head], [w * 0.75, h]]); }
    case 'downArrow': { const head = Math.min(w, h) * 0.5; return poly([[w * 0.25, 0], [w * 0.25, h - head], [0, h - head], [w / 2, h], [w, h - head], [w * 0.75, h - head], [w * 0.75, 0]]); }
    case 'hexagon': return poly([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]);
    default: return svg('rect', { x: 0, y: 0, width: w, height: h });
  }
}

export interface DrawOptions {
  /** Show the grey "click to add" prompt in empty placeholders (the editor only). */
  prompts?: boolean;
  /** Shapes with an entrance animation start hidden (the slideshow). */
  hideAnimated?: boolean;
  /** The master this slide inherits from: its font and colour fill in what a paragraph leaves open. */
  master?: DeckMaster | null;
}

/** The master text class a shape belongs to: a title, or body text. */
function masterText(s: DeckShape, master: DeckMaster | null | undefined): MasterText | null {
  if (!master || !s.ph) return null;
  return s.ph === 'title' || s.ph === 'ctrTitle' ? master.title : master.body;
}

function drawText(deck: Deck, s: DeckShape, opts: DrawOptions): HTMLElement | null {
  if (s.kind !== 'text' && s.kind !== 'shape') return null;
  const empty = s.paras.every((p) => !p.text);
  if (empty && !(opts.prompts && s.ph)) return null;
  const box = el('div', `fo-sh-text is-${s.anchor}`);
  if (empty) {
    const title = s.ph === 'title' || s.ph === 'ctrTitle';
    const line = el('div', 'fo-sh-p is-prompt', t(title ? 'office.impPromptTitle' : 'office.impPromptBody'));
    line.style.fontSize = `${(s.paras[0]?.size ?? 24) * s.fontScale}px`;
    line.style.textAlign = s.paras[0]?.align === 'ctr' ? 'center' : '';
    box.append(line);
    return box;
  }
  const inherited = masterText(s, opts.master);
  for (const p of s.paras) {
    const line = el('div', 'fo-sh-p', `${p.bullet ? '• ' : ''}${p.text || ' '}`);
    line.dir = 'auto';
    line.style.fontSize = `${(p.size ?? inherited?.size ?? 18) * s.fontScale}px`;
    if (p.bold) line.style.fontWeight = '700';
    if (p.italic) line.style.fontStyle = 'italic';
    if (p.underline) line.style.textDecoration = 'underline';
    line.style.color = p.color ?? s.ink ?? inherited?.color ?? deck.scheme.dk1 ?? '#000';
    if (inherited?.font) line.style.fontFamily = `"${inherited.font}", var(--fo-doc-font)`;
    if (p.align) line.style.textAlign = p.align === 'ctr' ? 'center' : p.align === 'r' ? 'right' : p.align === 'just' ? 'justify' : 'left';
    box.append(line);
  }
  return box;
}

/** One shape, positioned in its parent's coordinates (`ox`, `oy`, scale `sx`, `sy`). */
function drawShape(deck: Deck, s: DeckShape, opts: DrawOptions, ox = 0, oy = 0, sx = 1, sy = 1): HTMLElement {
  const node = el('div', `fo-sh is-${s.kind}`);
  const w = pt(s.w) * sx;
  const h = pt(s.h) * sy;
  node.style.left = `${pt(s.x - ox) * sx}px`;
  node.style.top = `${pt(s.y - oy) * sy}px`;
  node.style.width = `${w}px`;
  node.style.height = `${h}px`;
  const transforms: string[] = [];
  if (s.rot) transforms.push(`rotate(${s.rot}deg)`);
  if (s.kind !== 'line' && (s.flipH || s.flipV)) transforms.push(`scale(${s.flipH ? -1 : 1},${s.flipV ? -1 : 1})`);
  if (transforms.length) node.style.transform = transforms.join(' ');

  if (s.kind === 'pic') {
    if (s.image) {
      const img = el('img', 'fo-sh-img');
      img.alt = s.name;
      img.draggable = false;
      img.src = imageUrl(s.image.bytes, s.image.mime);
      node.append(img);
    } else node.classList.add('is-missing');
  } else if (s.kind === 'line') {
    const sw = Math.max(1, pt(s.strokeW));
    const canvas = svg('svg', { width: Math.max(w, 1), height: Math.max(h, 1), overflow: 'visible' });
    const [x1, y1, x2, y2] = [s.flipH ? w : 0, s.flipV ? h : 0, s.flipH ? 0 : w, s.flipV ? 0 : h];
    canvas.append(svg('line', { x1, y1, x2, y2, stroke: s.stroke ?? '#000', 'stroke-width': sw, 'stroke-linecap': 'round' }));
    if (s.arrow) {
      const a = Math.atan2(y2 - y1, x2 - x1);
      const len = sw * 4;
      const p = (d: number): string => `${x2 - len * Math.cos(a + d)},${y2 - len * Math.sin(a + d)}`;
      canvas.append(svg('polygon', { points: `${x2},${y2} ${p(0.45)} ${p(-0.45)}`, fill: s.stroke ?? '#000' }));
    }
    node.append(canvas);
  } else if (s.kind === 'group') {
    const box = s.box ?? { x: 0, y: 0, w: s.w, h: s.h };
    const gx = box.w ? pt(s.w) / pt(box.w) : 1;
    const gy = box.h ? pt(s.h) / pt(box.h) : 1;
    for (const c of s.children) node.append(drawShape(deck, c, opts, box.x, box.y, gx * sx, gy * sy));
  } else if (s.kind === 'frame') {
    if (s.table) {
      const table = el('table', 'fo-sh-table');
      for (const row of s.table) {
        const tr = el('tr');
        for (const cell of row) { const td = el('td', undefined, cell); td.dir = 'auto'; tr.append(td); }
        table.append(tr);
      }
      node.append(table);
    } else {
      node.classList.add('is-object');
      node.append(el('span', 'fo-sh-label', t('office.impObject')));
    }
  } else {
    if (s.fill || s.stroke) {
      const sw = s.stroke ? Math.max(0.75, pt(s.strokeW)) : 0;
      const canvas = svg('svg', { width: Math.max(w, 1), height: Math.max(h, 1), overflow: 'visible', class: 'fo-sh-geom' });
      const g = geometry(s.geom, w, h);
      g.setAttribute('fill', s.fill ?? 'none');
      if (s.stroke) { g.setAttribute('stroke', s.stroke); g.setAttribute('stroke-width', String(sw)); }
      canvas.append(g);
      node.append(canvas);
    }
    const text = drawText(deck, s, opts);
    if (text) {
      if (s.flipH || s.flipV) text.style.transform = `scale(${s.flipH ? -1 : 1},${s.flipV ? -1 : 1})`;
      node.append(text);
    }
  }
  return node;
}

/** The slide at its real size in points (scale it with `fitSlide`). */
export function drawSlide(deck: Deck, slide: DeckSlide, opts: DrawOptions = {}): HTMLElement {
  const canvas = el('div', 'fo-canvas');
  const master = opts.master ?? deck.masters.find((m) => m.part === slide.master) ?? null;
  canvas.style.width = `${pt(deck.cx)}px`;
  canvas.style.height = `${pt(deck.cy)}px`;
  // The background the slide really has: its own, else its layout's, else its master's — read
  // from the master as it is *now*, so editing the master paints the slides immediately.
  canvas.style.background = slide.bgOwn ?? slide.bgLayout ?? master?.bg ?? deck.scheme.lt1 ?? '#fff';
  for (const s of slide.shapes) {
    const node = drawShape(deck, s, { ...opts, master });
    node.dataset.uid = String(s.uid);
    if (opts.hideAnimated && s.anim) node.classList.add('is-pending');
    canvas.append(node);
  }
  return canvas;
}

/** A frame `width` px wide holding the slide scaled to fit it. */
export function fitSlide(deck: Deck, canvas: HTMLElement, width: number): { frame: HTMLElement; scale: number } {
  const scale = width / pt(deck.cx);
  const frame = el('div', 'fo-canvasframe');
  frame.style.width = `${width}px`;
  frame.style.height = `${pt(deck.cy) * scale}px`;
  canvas.style.transform = `scale(${scale})`;
  frame.append(canvas);
  return { frame, scale };
}

/** The largest width at which a slide fits in a w×h box. */
export function fitWidth(deck: Deck, w: number, h: number): number {
  return Math.max(40, Math.floor(Math.min(w, h * (deck.cx / deck.cy))));
}
