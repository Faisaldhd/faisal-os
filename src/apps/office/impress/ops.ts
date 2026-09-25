/**
 * Impress — pure operations on the rich deck. Every function returns a new deck
 * and never mutates its input, so an undo step is simply the deck before and the
 * deck after (`deckEdit`), and the save diffs the current deck against the one read.
 */
import type { DeckModel, Edit, OfficeModel } from '../model';
import { deckTexts, nextUid, type Anim, type Deck, type DeckPara, type DeckShape, type DeckSlide, type Transition } from './deck';
import { autoAlign, type ParaStylePatch } from './parafmt';

export type SlideLayoutKind = 'title' | 'content' | 'two' | 'blank';
export const SLIDE_LAYOUTS: readonly SlideLayoutKind[] = ['title', 'content', 'two', 'blank'];
/** The OOXML layout type each choice looks for in the file's masters. */
const LAYOUT_TYPE: Record<SlideLayoutKind, string> = { title: 'title', content: 'obj', two: 'twoObj', blank: 'blank' };

export type NewShapeKind = 'text' | 'rect' | 'ellipse' | 'arrow' | 'line';

/** The model with this deck (and the plain paragraphs that follow from it). */
export function withDeck(m: OfficeModel, deck: Deck): OfficeModel {
  if (m.kind !== 'pptx') return m;
  return { kind: 'pptx', slides: deckTexts(deck), deck } satisfies DeckModel;
}

/** One undo step: the whole deck before and after (decks share untouched slides). */
export function deckEdit(before: Deck, after: Deck, key?: string): Edit {
  return {
    ...(key ? { key } : {}),
    apply: (m) => withDeck(m, after),
    revert: (m) => withDeck(m, before),
  };
}

export function para(text: string, size: number, extra: Partial<DeckPara> = {}): DeckPara {
  return {
    text, size, bold: false, italic: false, color: null, align: null, bullet: false,
    ...extra,
    // `underline` is new here: an explicit default keeps `Partial<DeckPara>` from widening it.
    underline: extra.underline ?? false,
  };
}

function baseShape(kind: DeckShape['kind'], x: number, y: number, w: number, h: number): DeckShape {
  return {
    uid: nextUid(), kind, origin: null, spid: 0, name: '', ph: null, phIdx: null, geom: 'rect',
    x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), rot: 0, flipH: false, flipV: false,
    fill: null, stroke: null, strokeW: 12700, arrow: false, paras: [], ink: null, anchor: 't', fontScale: 1,
    image: null, children: [], box: null, table: null, anim: null, locked: false,
  };
}

function placeholder(ph: string, idx: string | null, x: number, y: number, w: number, h: number, size: number, anchor: DeckShape['anchor'], align: DeckPara['align']): DeckShape {
  const s = baseShape('text', x, y, w, h);
  s.ph = ph;
  s.phIdx = idx;
  s.anchor = anchor;
  s.name = ph === 'title' || ph === 'ctrTitle' ? 'Title' : ph === 'subTitle' ? 'Subtitle' : 'Content';
  s.paras = [para('', size, { align })];
  return s;
}

/** The shapes of a new slide with this layout, placed on a deck of this size. */
export function layoutShapes(kind: SlideLayoutKind, cx: number, cy: number): DeckShape[] {
  const mx = cx * 0.07;
  const w = cx - 2 * mx;
  switch (kind) {
    case 'title': return [
      placeholder('ctrTitle', null, cx * 0.125, cy * 0.2, cx * 0.75, cy * 0.32, 44, 'b', 'ctr'),
      placeholder('subTitle', '1', cx * 0.125, cy * 0.56, cx * 0.75, cy * 0.2, 24, 't', 'ctr'),
    ];
    case 'content': return [
      placeholder('title', null, mx, cy * 0.06, w, cy * 0.16, 36, 'ctr', null),
      placeholder('body', '1', mx, cy * 0.26, w, cy * 0.64, 24, 't', null),
    ];
    case 'two': {
      const gap = cx * 0.03;
      const half = (w - gap) / 2;
      return [
        placeholder('title', null, mx, cy * 0.06, w, cy * 0.16, 36, 'ctr', null),
        placeholder('body', '1', mx, cy * 0.26, half, cy * 0.64, 22, 't', null),
        placeholder('body', '2', mx + half + gap, cy * 0.26, half, cy * 0.64, 22, 't', null),
      ];
    }
    default: return [];
  }
}

/** The layout part a new slide references: the file's own layout of that type, else a sensible one. */
export function layoutPartFor(deck: Deck, kind: SlideLayoutKind, near: DeckSlide | undefined): string | null {
  const wanted = LAYOUT_TYPE[kind];
  return deck.layouts.find((l) => l.type === wanted)?.part
    ?? (kind === 'blank' ? deck.layouts.find((l) => l.type === 'blank')?.part : undefined)
    ?? near?.layout ?? deck.layouts[0]?.part ?? null;
}

/** Adds a slide with this layout after `after` (-1 = at the start). */
export function addSlide(deck: Deck, after: number, kind: SlideLayoutKind): Deck {
  const near = deck.slides[after] ?? deck.slides[0];
  const slide: DeckSlide = {
    uid: nextUid(), part: null, from: null, layout: layoutPartFor(deck, kind, near),
    shapes: layoutShapes(kind, deck.cx, deck.cy), bg: near?.bg ?? null, notes: '', transition: 'none',
  };
  const slides = deck.slides.slice();
  slides.splice(after + 1, 0, slide);
  return { ...deck, slides };
}

function copyShape(s: DeckShape): DeckShape {
  return { ...s, uid: nextUid(), paras: s.paras.map((p) => ({ ...p })), children: s.children.map(copyShape) };
}

/**
 * A copy of slide `at` right after it. A slide read from the file is copied from its
 * part (so everything this model does not know survives); its speaker notes are not
 * copied — the notes page belongs to the original.
 */
export function duplicateSlide(deck: Deck, at: number): Deck {
  const src = deck.slides[at];
  if (!src) return deck;
  const copy: DeckSlide = { ...src, uid: nextUid(), part: null, from: src.part ?? src.from, shapes: src.shapes.map(copyShape), notes: '' };
  const slides = deck.slides.slice();
  slides.splice(at + 1, 0, copy);
  return { ...deck, slides };
}

/** Removes slide `at`; the last slide is never removed. */
export function deleteSlide(deck: Deck, at: number): Deck {
  if (deck.slides.length <= 1 || !deck.slides[at]) return deck;
  return { ...deck, slides: deck.slides.filter((_, i) => i !== at) };
}

/** Moves slide `from` so it ends up at index `to`. */
export function moveSlide(deck: Deck, from: number, to: number): Deck {
  const n = deck.slides.length;
  if (from < 0 || from >= n) return deck;
  const target = Math.max(0, Math.min(n - 1, to));
  if (target === from) return deck;
  const slides = deck.slides.slice();
  const [moved] = slides.splice(from, 1);
  slides.splice(target, 0, moved);
  return { ...deck, slides };
}

function mapSlide(deck: Deck, at: number, fn: (s: DeckSlide) => DeckSlide): Deck {
  const slide = deck.slides[at];
  if (!slide) return deck;
  const next = fn(slide);
  if (next === slide) return deck;
  const slides = deck.slides.slice();
  slides[at] = next;
  return { ...deck, slides };
}

export function mapShape(deck: Deck, at: number, uid: number, fn: (s: DeckShape) => DeckShape): Deck {
  return mapSlide(deck, at, (slide) => {
    const i = slide.shapes.findIndex((s) => s.uid === uid);
    const shape = slide.shapes[i];
    if (!shape) return slide;
    const next = fn(shape);
    if (next === shape) return slide;
    const shapes = slide.shapes.slice();
    shapes[i] = next;
    return { ...slide, shapes };
  });
}

/** Moves/resizes a shape (EMU), clamped to a positive size. */
export function setBounds(deck: Deck, at: number, uid: number, b: { x: number; y: number; w: number; h: number }): Deck {
  return mapShape(deck, at, uid, (s) => {
    if (s.locked) return s;
    const next = { x: Math.round(b.x), y: Math.round(b.y), w: Math.max(s.kind === 'line' ? 0 : 12700, Math.round(b.w)), h: Math.max(s.kind === 'line' ? 0 : 12700, Math.round(b.h)) };
    if (next.x === s.x && next.y === s.y && next.w === s.w && next.h === s.h) return s;
    return { ...s, ...next };
  });
}

/**
 * Gives a shape this text, one paragraph per line. A paragraph keeps the look of the
 * paragraph it replaces (or of the last one), so typing never loses the formatting — and it
 * picks up the right alignment for Arabic as it is typed (`autoAlign`), which is the owner's
 * "Arabic first" rule showing up where the text is actually entered.
 */
export function setShapeText(deck: Deck, at: number, uid: number, text: string): Deck {
  return mapShape(deck, at, uid, (s) => {
    if (s.locked || (s.kind !== 'text' && s.kind !== 'shape')) return s;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.join('\n') === s.paras.map((p) => p.text).join('\n')) return s;
    const fallback: DeckPara = s.paras[s.paras.length - 1] ?? para('', 18);
    const paras = lines.map((line, i) => {
      const base = s.paras[i] ?? fallback;
      return { ...base, text: line, align: autoAlign(line, base.align) };
    });
    return { ...s, paras };
  });
}

/**
 * Applies one part of the look — bold, italic, underline, size, colour, alignment — to every
 * paragraph of a shape, the way PowerPoint treats a text box with nothing selected inside it.
 * One call is one undoable edit.
 */
export function setParaStyle(deck: Deck, at: number, uid: number, patch: ParaStylePatch): Deck {
  return mapShape(deck, at, uid, (s) => {
    if (s.locked || (s.kind !== 'text' && s.kind !== 'shape')) return s;
    const paras = s.paras.map((p) => ({ ...p, ...patch }));
    return { ...s, paras };
  });
}

export function deleteShape(deck: Deck, at: number, uid: number): Deck {
  return mapSlide(deck, at, (slide) => {
    const shape = slide.shapes.find((s) => s.uid === uid);
    if (!shape || (shape.locked && shape.origin === null)) return slide;
    return { ...slide, shapes: slide.shapes.filter((s) => s.uid !== uid) };
  });
}

export function addShape(deck: Deck, at: number, shape: DeckShape): Deck {
  return mapSlide(deck, at, (slide) => ({ ...slide, shapes: [...slide.shapes, shape] }));
}

export function setTransition(deck: Deck, at: number, transition: Transition): Deck {
  return mapSlide(deck, at, (slide) => (slide.transition === transition ? slide : { ...slide, transition }));
}

export function setAnim(deck: Deck, at: number, uid: number, anim: Anim): Deck {
  return mapShape(deck, at, uid, (s) => (s.anim === anim || s.locked ? s : { ...s, anim }));
}

/** A new shape of this kind, centred on the slide, in the theme's accent colour. */
export function newShape(deck: Deck, kind: NewShapeKind): DeckShape {
  const { cx, cy } = deck;
  const accent = deck.scheme.accent1 ?? '#4472C4';
  if (kind === 'text') {
    const s = baseShape('text', cx * 0.3, cy * 0.42, cx * 0.4, cy * 0.12);
    s.paras = [para('', 24)];
    return s;
  }
  if (kind === 'line') {
    const s = baseShape('line', cx * 0.3, cy * 0.5, cx * 0.4, 0);
    s.geom = 'line';
    s.stroke = accent;
    s.strokeW = 28575;
    return s;
  }
  const w = kind === 'arrow' ? cx * 0.24 : cy * 0.3;
  const h = kind === 'arrow' ? cy * 0.16 : cy * 0.3;
  const s = baseShape('shape', (cx - w) / 2, (cy - h) / 2, w, h);
  s.geom = kind === 'ellipse' ? 'ellipse' : kind === 'arrow' ? 'rightArrow' : 'rect';
  s.fill = accent;
  s.stroke = shade(accent);
  s.anchor = 'ctr';
  s.paras = [para('', 18, { align: 'ctr', color: '#FFFFFF' })];
  return s;
}

/** A picture fitted inside 60% of the slide, centred, keeping its aspect ratio. */
export function newPicture(deck: Deck, bytes: Uint8Array, mime: string, ext: string, width: number, height: number): DeckShape {
  const maxW = deck.cx * 0.6;
  const maxH = deck.cy * 0.6;
  const ratio = width > 0 && height > 0 ? width / height : 4 / 3;
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) { h = maxH; w = h * ratio; }
  const s = baseShape('pic', (deck.cx - w) / 2, (deck.cy - h) / 2, w, h);
  s.image = { path: null, bytes, mime, ext };
  return s;
}

function shade(color: string): string {
  const n = parseInt(color.slice(1), 16);
  const f = (v: number): string => Math.round(v * 0.75).toString(16).padStart(2, '0');
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`.toUpperCase();
}
