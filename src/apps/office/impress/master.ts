/**
 * Impress — writing the slide master (كتابة الشريحة الرئيسية).
 *
 * A master is where a presentation's design lives: the background, the look of the title and
 * body text, the footer and the slide-number placeholder. This module turns one `DeckMaster`
 * into the smallest set of edits that makes the part say it — the background in `<p:cSld>`, the
 * two `txStyles` level-1 run properties, and the footer/slide-number placeholders — and nothing
 * else. Every other element of the part (colour map, layouts list, timing) keeps its bytes, which
 * is what stops a design change from quietly rewriting a deck.
 *
 * The edits work the same way for a master and for a layout that overrides the master's
 * background, because a layout that sets its own `<p:bg>` would otherwise hide the new colour.
 */
import { xmlText } from '../xml';
import { elementText, elementsOf, localName, parsePart, paragraphSlots, type XmlEdit, type XmlElement } from '../xmlscan';
import { child, nextUid, type Deck, type DeckBox, type DeckMaster, type DeckPara, type DeckShape, type MasterText } from './deck';
import { shapeXml } from './deckxml';

const hex = (c: string): string => c.replace('#', '').toUpperCase();

/** The colours a run property may hold, in the order the schema wants them. */
const AFTER_FILL = ['effectLst', 'effectDag', 'highlight', 'uLnTx', 'uLn', 'uFillTx', 'uFill', 'latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst'];

/** `<p:bg>` for a solid colour, the shape PowerPoint writes for "solid fill" backgrounds. */
export function bgXml(color: string | null): string {
  return color
    ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    : '';
}

/** One attribute of an open tag: set, replaced, or removed when the value is null. */
function setAttr(attrs: string, name: string, value: string | null): string {
  const re = new RegExp(`\\s${name}="[^"]*"`);
  const rest = attrs.trimEnd().replace(/\/$/, '');
  if (value === null) return re.test(rest) ? rest.replace(re, '') : rest;
  return re.test(rest) ? rest.replace(re, ` ${name}="${value}"`) : `${rest} ${name}="${value}"`;
}

/**
 * One `<a:defRPr>` with the master's font, colour and size.
 *
 * The element is rebuilt rather than string-patched, because the colour and the font are two
 * different children that have to land in schema order: the fill among the fill group, the Latin
 * typeface after it and before `ea`/`cs`. Everything else the element carried — language, bold,
 * kerning, hyperlink colours — is kept, in its own order.
 */
export function defRPrXml(tag: string, style: MasterText): string {
  const open = /^<([A-Za-z0-9:_.-]+)([^>]*)>/.exec(tag);
  if (!open) return tag;
  const name = open[1];
  const selfClosing = open[2].trimEnd().endsWith('/');
  const attrs = setAttr(open[2], 'sz', style.size ? String(Math.round(style.size * 100)) : null);
  const body = selfClosing ? '' : tag.slice(open[0].length, tag.length - `</${name}>`.length);
  const children = parsePart(body).roots;
  const kept = children.filter((c) => !['solidFill', 'latin'].includes(localName(c.name)));
  const fillAt = children.findIndex((c) => localName(c.name) === 'solidFill');
  const latinAt = children.findIndex((c) => localName(c.name) === 'latin');
  const items = kept.map((c) => body.slice(c.start, c.end));
  const names = kept.map((c) => localName(c.name));
  /** Where an element belongs in the kept list: where it was, else before the first element the
   *  schema puts after it, else at the end. */
  const placeOf = (was: number, list: readonly string[]): number => {
    if (was >= 0) {
      let seen = 0;
      for (let i = 0; i < children.length; i++) {
        if (i === was) return seen;
        if (!['solidFill', 'latin'].includes(localName(children[i].name))) seen++;
      }
    }
    const at = names.findIndex((n) => list.includes(n));
    return at < 0 ? items.length : at;
  };
  // Both positions are read against the same list, so the later element is inserted first and
  // the earlier index stays valid: the fill must land before the Latin typeface, not after it.
  const fillAt2 = style.color ? placeOf(fillAt, AFTER_FILL) : -1;
  const latinAt2 = style.font ? placeOf(latinAt, AFTER_FILL.filter((n) => n !== 'latin')) : -1;
  if (latinAt2 >= 0) items.splice(latinAt2, 0, `<a:latin typeface="${xmlText(style.font as string)}"/>`);
  if (fillAt2 >= 0) items.splice(fillAt2, 0, `<a:solidFill><a:srgbClr val="${hex(style.color as string)}"/></a:solidFill>`);
  if (!items.length) return attrs ? `<${name} ${attrs}/>` : `<${name}/>`;
  return attrs ? `<${name} ${attrs}>${items.join('')}</${name}>` : `<${name}>${items.join('')}</${name}>`;
}

/** `<p:txStyles>` entry edited in place: level-1 run properties carry the master's text look. */
function textStyleEdits(xml: string, tx: XmlElement, styleName: 'titleStyle' | 'bodyStyle', after: MasterText): XmlEdit[] | null {
  const style = child(tx, styleName);
  const defRPr = style ? childPath(style, 'lvl1pPr', 'defRPr') : null;
  if (!defRPr) return null;
  return [{ start: defRPr.start, end: defRPr.end, xml: defRPrXml(xml.slice(defRPr.start, defRPr.end), after) }];
}

/** A path of child elements by local name, the way `deck.ts` walks a part. */
function childPath(el: XmlElement | null, ...names: string[]): XmlElement | null {
  let at: XmlElement | null = el;
  for (const name of names) at = child(at, name);
  return at;
}

/** The same text look, from the same place, for both classes the ribbon can change. */
function txStyleEdits(xml: string, before: DeckMaster, after: DeckMaster): XmlEdit[] | null {
  if (sameText(before.title, after.title) && sameText(before.body, after.body)) return [];
  const root = parsePart(xml).roots[0];
  const tx = child(root, 'txStyles');
  // A master without `txStyles` cannot be given one without inventing a whole style sheet: the
  // save is refused instead, and the window warns before it rebuilds the file.
  if (!tx) return null;
  const title = textStyleEdits(xml, tx, 'titleStyle', after.title);
  const body = textStyleEdits(xml, tx, 'bodyStyle', after.body);
  if (!title || !body) return null;
  return [...title, ...body];
}

function sameText(a: MasterText, b: MasterText): boolean {
  return a.font === b.font && a.size === b.size && hex(a.color ?? '') === hex(b.color ?? '');
}

/**
 * The edits that give a master (or a layout that overrides it) this background and text look.
 * `undefined` means "nothing to do", `null` means "this part cannot express it".
 */
export function masterEdits(xml: string, before: DeckMaster, after: DeckMaster): XmlEdit[] | null {
  const root = parsePart(xml).roots[0];
  const cSld = child(root, 'cSld');
  if (!cSld) return null;
  const edits: XmlEdit[] = [];
  const bg = child(cSld, 'bg');
  if (before.bg !== after.bg) {
    if (bg) edits.push({ start: bg.start, end: bg.end, xml: bgXml(after.bg) });
    else if (after.bg) edits.push({ start: cSld.openEnd, end: cSld.openEnd, xml: bgXml(after.bg) });
  }
  const tx = txStyleEdits(xml, before, after);
  if (!tx) return null;
  return [...edits, ...tx];
}

/**
 * The same background on a layout part, only when the layout sets a background of its own:
 * a layout that overrides the master would otherwise keep showing the old colour.
 */
export function layoutBgEdits(xml: string, bg: string | null): XmlEdit[] {
  const root = parsePart(xml).roots[0];
  const cSld = child(root, 'cSld');
  const own = child(cSld, 'bg');
  if (!cSld || !own) return [];
  return [{ start: own.start, end: own.end, xml: bgXml(bg) }];
}

/* ─────────────────────────── footer and slide number ─────────────────────────── */

/** The placeholder types the footer and the slide number use, and what they are called. */
const CHROME: ReadonlyArray<{ ph: 'ftr' | 'sldNum'; name: string; size: number; align: DeckPara['align'] }> = [
  { ph: 'ftr', name: 'Footer', size: 12, align: 'l' },
  { ph: 'sldNum', name: 'Slide Number', size: 12, align: 'r' },
];

function chromePara(text: string, size: number, align: DeckPara['align'], field: 'slidenum' | null): DeckPara {
  return { text, size, bold: false, italic: false, underline: false, color: null, align, bullet: false, field };
}

/**
 * The footer and the slide-number placeholders a master asks for, as shapes of one slide.
 *
 * PowerPoint shows neither from the master alone: the master carries the design and the place,
 * and every slide that should show them carries its own placeholder. `index` is the slide's own
 * position — it becomes the hint text of the live number field, and the canvas draws the number
 * itself, so a slide inserted earlier changes what is shown without touching the file.
 */
export function chromeShapes(deck: Deck, master: DeckMaster, index: number): DeckShape[] {
  const out: DeckShape[] = [];
  for (const { ph, name, size, align } of CHROME) {
    const on = ph === 'ftr' ? master.footer !== null : master.slideNumber;
    if (!on) continue;
    const box = boxFor(deck, master, ph);
    out.push({
      uid: nextUid(), kind: 'text', origin: null, spid: 0, name, ph, phIdx: null, geom: 'rect',
      ...box, rot: 0, flipH: false, flipV: false, fill: null, stroke: null, strokeW: 12700, arrow: false,
      stCxn: null, endCxn: null,
      paras: [ph === 'ftr' ? chromePara(master.footer ?? '', size, align, null) : chromePara(String(index + 1), size, align, 'slidenum')],
      ink: null, anchor: 't', fontScale: 1, image: null, children: [], box: null, table: null, anim: null, locked: false,
    });
  }
  return out;
}

/** Where a placeholder goes: the master's own box, else the usual place at the foot of a slide. */
function boxFor(deck: Deck, master: DeckMaster, ph: 'ftr' | 'sldNum'): DeckBox {
  const own = ph === 'ftr' ? master.footerBox : master.numberBox;
  if (own) return own;
  return ph === 'ftr'
    ? { x: Math.round(deck.cx * 0.05), y: Math.round(deck.cy * 0.92), w: Math.round(deck.cx * 0.5), h: Math.round(deck.cy * 0.06) }
    : { x: Math.round(deck.cx * 0.85), y: Math.round(deck.cy * 0.92), w: Math.round(deck.cx * 0.1), h: Math.round(deck.cy * 0.06) };
}

/**
 * The master with the boxes its placeholders really use.
 *
 * The model has to know where it put them: the save is refused unless the master read back from
 * the file says exactly what the model says, so a box that only ever existed inside the written
 * XML would make every save of that deck fail. A placeholder that is off has no box, because the
 * part will not have one either.
 */
export function withChromeBoxes(deck: Deck, master: DeckMaster): DeckMaster {
  return {
    ...master,
    footerBox: master.footer !== null ? boxFor(deck, master, 'ftr') : null,
    numberBox: master.slideNumber ? boxFor(deck, master, 'sldNum') : null,
  };
}

/** The `<p:sp>` elements of a spTree that are the footer and the slide-number placeholders. */
function chromeElements(spTree: XmlElement, xml: string): Map<string, XmlElement> {
  const out = new Map<string, XmlElement>();
  for (const sp of spTree.children) {
    if (localName(sp.name) !== 'sp') continue;
    const ph = child(child(child(sp, 'nvSpPr'), 'nvPr'), 'ph');
    const type = ph ? attrOf(xml, ph, 'type') : null;
    if (type === 'ftr' || type === 'sldNum') out.set(type, sp);
  }
  return out;
}

function attrOf(xml: string, el: XmlElement, name: string): string | null {
  const open = xml.slice(el.start, el.openEnd);
  const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(open);
  return m ? m[1] ?? null : null;
}

function numberOf(xml: string, el: XmlElement | null, name: string): number | null {
  if (!el) return null;
  const v = Number(attrOf(xml, el, name));
  return Number.isFinite(v) && attrOf(xml, el, name) !== null ? v : null;
}

/** True when a placeholder in the file already says exactly what the model asks for. */
function sameChrome(xml: string, el: XmlElement, want: DeckShape): boolean {
  const xfrm = child(child(el, 'spPr'), 'xfrm');
  if (numberOf(xml, child(xfrm, 'off'), 'x') !== want.x || numberOf(xml, child(xfrm, 'off'), 'y') !== want.y) return false;
  if (numberOf(xml, child(xfrm, 'ext'), 'cx') !== want.w || numberOf(xml, child(xfrm, 'ext'), 'cy') !== want.h) return false;
  const body = child(el, 'txBody');
  const paras = (body?.children ?? []).filter((c) => localName(c.name) === 'p');
  const field = paras.some((p) => p.children.some((c) => localName(c.name) === 'fld' && attrOf(xml, c, 'type') === 'slidenum'));
  const wanted = want.paras[0];
  if (field !== (wanted?.field === 'slidenum')) return false;
  const text = paras.map((p) => paragraphSlots(p).map((slot) => (slot.kind === 'text' ? elementText(xml, slot.element) : '')).join('')).join('\n');
  return text === (wanted?.text ?? '');
}

/**
 * The master's own footer and slide-number placeholders: added, replaced or taken away so the
 * part says what the model says — and left completely alone when it already does, so a save that
 * changed nothing writes nothing.
 */
export function chromeEdits(xml: string, wanted: readonly DeckShape[]): XmlEdit[] | null {
  const doc = parsePart(xml);
  const root = doc.roots[0];
  const spTree = child(child(root, 'cSld'), 'spTree');
  if (!spTree || spTree.selfClosing) return null;
  const holders = chromeElements(spTree, xml);
  const keep = new Set(wanted.map((w) => w.ph));
  const edits: XmlEdit[] = [];
  for (const [type, el] of holders) if (!keep.has(type)) edits.push({ start: el.start, end: el.end, xml: '' });
  let maxId = 1;
  for (const c of elementsOf(root, 'cNvPr')) maxId = Math.max(maxId, numberOf(xml, c, 'id') ?? 0);
  for (const want of wanted) {
    const el = holders.get(want.ph ?? '');
    if (el && sameChrome(xml, el, want)) continue;
    const markup = shapeXml(want, ++maxId, null);
    if (el) edits.push({ start: el.start, end: el.end, xml: markup });
    else {
      const closeAt = xml.lastIndexOf('<', spTree.end - 1);
      edits.push({ start: closeAt, end: closeAt, xml: markup });
    }
  }
  return edits;
}
