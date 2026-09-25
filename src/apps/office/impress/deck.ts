/**
 * Impress — the rich slide model and its reader (نموذج الشرائح).
 *
 * The plain deck model is a list of paragraphs per slide; this is what the slide
 * editor needs on top of it: every shape at its real position and size (EMU, as the
 * file stores them), its fill and outline, its text with the look of each paragraph,
 * pictures with their bytes, the slide size, the order of `sldIdLst`, the speaker
 * notes, the transition and the simple entrance animations.
 *
 * The reader scans the XML with `xmlscan` — the same scanner the save uses — so a
 * shape's `origin` (its index among the shapes of the slide's `spTree`) points at
 * exactly the element the patcher edits. Nothing here is guessed: a shape the model
 * cannot express is kept as a locked frame, drawn as a box and left untouched.
 */
import { attr, attrLocal, elementText, elementsOf, localName, paragraphSlots, parsePart, type XmlElement } from '../xmlscan';
import { entryData, readRawZip, type RawZip } from '../zip';

/** 1 point = 12700 EMU. The canvas is drawn in points, so 1 CSS px = 1 pt before scaling. */
export const EMU_PER_PT = 12700;
export const DEFAULT_CX = 12192000;
export const DEFAULT_CY = 6858000;

export type Transition = 'none' | 'fade' | 'push' | 'other';
export type Anim = 'fade' | 'appear' | null;
export type Align = 'l' | 'ctr' | 'r' | 'just';
export type ShapeKind = 'text' | 'shape' | 'pic' | 'line' | 'group' | 'frame';

export interface DeckPara {
  text: string;
  /** Points; null = the inherited size. */
  size: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
  align: Align | null;
  bullet: boolean;
}

export interface DeckImage {
  /** The media part in the package; null for a picture added in this session. */
  path: string | null;
  bytes: Uint8Array;
  mime: string;
  ext: string;
}

export interface DeckShape {
  /** Unique in the session (selection, undo); never written. */
  uid: number;
  kind: ShapeKind;
  /** Index among the shapes of the source slide's spTree; null for a new shape. */
  origin: number | null;
  /** The `cNvPr id` in the file (0 for a new shape until it is saved). */
  spid: number;
  name: string;
  /** Placeholder type ("title", "body", …) and index, when the shape is one. */
  ph: string | null;
  phIdx: string | null;
  geom: string;
  x: number; y: number; w: number; h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  fill: string | null;
  stroke: string | null;
  /** EMU. */
  strokeW: number;
  /** A line with an arrow head at its end. */
  arrow: boolean;
  paras: DeckPara[];
  /** Default text colour of the shape (a shape style's font colour), null = the theme's. */
  ink: string | null;
  anchor: 't' | 'ctr' | 'b';
  /** normAutofit fontScale, 1 = none. */
  fontScale: number;
  image: DeckImage | null;
  /** A group's children, in the group's child coordinate space (`box`). */
  children: DeckShape[];
  box: { x: number; y: number; w: number; h: number } | null;
  /** A table's cell text (graphic frames). */
  table: string[][] | null;
  anim: Anim;
  /** Cannot be moved or edited here (a shape inside mc:AlternateContent). */
  locked: boolean;
}

export interface DeckSlide {
  uid: number;
  /** The slide part this slide *is* (only one slide ever has a given part). */
  part: string | null;
  /** A duplicate's source part: its XML is copied, then edited like the original. */
  from: string | null;
  /** The layout part a new slide references. */
  layout: string | null;
  shapes: DeckShape[];
  bg: string | null;
  notes: string;
  transition: Transition;
}

export interface DeckLayout { part: string; type: string; name: string }

export interface Deck {
  cx: number;
  cy: number;
  slides: DeckSlide[];
  layouts: DeckLayout[];
  /** Theme colours by scheme name (dk1, lt1, accent1, …) as #RRGGBB. */
  scheme: Record<string, string>;
}

let uidCounter = 0;
/** A fresh session id for a slide or a shape. */
export function nextUid(): number { return ++uidCounter; }

/* ───────────────────────────── small XML helpers ───────────────────────────── */

export function child(el: XmlElement | null | undefined, name: string): XmlElement | null {
  if (!el) return null;
  return el.children.find((c) => localName(c.name) === name) ?? null;
}

function childPath(el: XmlElement | null | undefined, ...names: string[]): XmlElement | null {
  let at: XmlElement | null = el ?? null;
  for (const name of names) at = child(at, name);
  return at;
}

function num(xml: string, el: XmlElement | null, name: string, fallback = 0): number {
  if (!el) return fallback;
  const v = Number(attr(xml, el, name));
  return Number.isFinite(v) && attr(xml, el, name) !== null ? v : fallback;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML character data → text. */
export function decodeXml(raw: string): string {
  return raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** The text of one `<a:p>`: `<a:t>` text, `<a:tab/>` a tab, `<a:br/>` a line break. */
export function paraText(xml: string, p: XmlElement): string {
  return paragraphSlots(p).map((slot) => (slot.kind === 'tab' ? '\t' : slot.kind === 'break' ? '\n' : decodeXml(elementText(xml, slot.element)))).join('');
}

/** `ppt/slides/slide1.xml` + `../media/image1.png` → `ppt/media/image1.png`. */
export function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromPart.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** The relative target from one part to another: `ppt/slides/a.xml` → `ppt/media/b.png` = `../media/b.png`. */
export function relativeTarget(fromPart: string, toPart: string): string {
  const from = fromPart.split('/').slice(0, -1);
  const to = toPart.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...new Array<string>(from.length - common).fill('..'), ...to.slice(common)].join('/');
}

export interface Rel { id: string; type: string; target: string; external: boolean }

export function parseRels(xml: string | null, part: string): Rel[] {
  if (!xml) return [];
  const doc = parsePart(xml);
  const out: Rel[] = [];
  for (const root of doc.roots) {
    for (const r of elementsOf(root, 'Relationship')) {
      const external = (attr(xml, r, 'TargetMode') ?? '') === 'External';
      const raw = attr(xml, r, 'Target') ?? '';
      out.push({
        id: attr(xml, r, 'Id') ?? '',
        type: (attr(xml, r, 'Type') ?? '').split('/').pop() ?? '',
        target: external ? raw : resolveTarget(part, raw),
        external,
      });
    }
  }
  return out;
}

export function relsPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/* ───────────────────────────────── colours ───────────────────────────────── */

const PRESET: Record<string, string> = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00',
  gray: '#808080', grey: '#808080', orange: '#FFA500', purple: '#800080', darkBlue: '#00008B', darkRed: '#8B0000',
};
const SCHEME_ALIAS: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };

function hex(r: number, g: number, b: number): string {
  const c = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** lumMod/lumOff/tint/shade, the modifiers theme colours usually carry. */
function modify(color: string, xml: string, el: XmlElement): string {
  let r = parseInt(color.slice(1, 3), 16);
  let g = parseInt(color.slice(3, 5), 16);
  let b = parseInt(color.slice(5, 7), 16);
  for (const m of el.children) {
    const v = Number(attrLocal(xml, m, 'val')) / 100000;
    if (!Number.isFinite(v)) continue;
    const name = localName(m.name);
    if (name === 'shade') { r *= v; g *= v; b *= v; }
    else if (name === 'tint') { r += (255 - r) * (1 - v); g += (255 - g) * (1 - v); b += (255 - b) * (1 - v); }
    else if (name === 'lumMod' || name === 'lumOff') {
      // HSL lightness scale/offset.
      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      let l = (max + min) / 2;
      const d = max - min;
      let h = 0;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      if (d !== 0) {
        const rn = r / 255; const gn = g / 255; const bn = b / 255;
        if (max === rn) h = ((gn - bn) / d) % 6; else if (max === gn) h = (bn - rn) / d + 2; else h = (rn - gn) / d + 4;
        h *= 60;
      }
      l = name === 'lumMod' ? l * v : l + v;
      l = Math.max(0, Math.min(1, l));
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m0 = l - c / 2;
      const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
      r = (r1 + m0) * 255; g = (g1 + m0) * 255; b = (b1 + m0) * 255;
    }
  }
  return hex(r, g, b);
}

/** The colour held by a colour element's parent (solidFill, fillRef, …), or null. */
export function colorOf(xml: string, holder: XmlElement | null, scheme: Record<string, string>): string | null {
  if (!holder) return null;
  for (const c of holder.children) {
    const name = localName(c.name);
    let base: string | null = null;
    if (name === 'srgbClr') base = `#${(attr(xml, c, 'val') ?? '000000').toUpperCase()}`;
    else if (name === 'schemeClr') { const v = attr(xml, c, 'val') ?? ''; base = scheme[SCHEME_ALIAS[v] ?? v] ?? null; }
    else if (name === 'sysClr') base = `#${(attr(xml, c, 'lastClr') ?? '000000').toUpperCase()}`;
    else if (name === 'prstClr') base = PRESET[attr(xml, c, 'val') ?? ''] ?? null;
    else if (name === 'scrgbClr') base = '#808080';
    else continue;
    if (!base || !/^#[0-9A-F]{6}$/i.test(base)) return null;
    return modify(base, xml, c);
  }
  return null;
}

/** A fill (`solidFill`, `gradFill`, `noFill`, …) among an element's children: undefined = none specified. */
function fillOf(xml: string, el: XmlElement | null, scheme: Record<string, string>): string | null | undefined {
  if (!el) return undefined;
  for (const c of el.children) {
    const name = localName(c.name);
    if (name === 'noFill') return null;
    if (name === 'solidFill') return colorOf(xml, c, scheme);
    if (name === 'gradFill') return colorOf(xml, childPath(c, 'gsLst', 'gs'), scheme);
    if (name === 'pattFill') return colorOf(xml, child(c, 'fgClr'), scheme);
    if (name === 'blipFill' || name === 'grpFill') return null;
  }
  return undefined;
}

export function readScheme(xml: string | null): Record<string, string> {
  const scheme: Record<string, string> = {
    dk1: '#000000', lt1: '#FFFFFF', dk2: '#44546A', lt2: '#E7E6E6', accent1: '#4472C4', accent2: '#ED7D31',
    accent3: '#A5A5A5', accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47', hlink: '#0563C1', folHlink: '#954F72',
  };
  if (!xml) return scheme;
  const doc = parsePart(xml);
  const clr = doc.roots.flatMap((r) => elementsOf(r, 'clrScheme'))[0];
  if (!clr) return scheme;
  for (const c of clr.children) {
    const color = colorOf(xml, c, {});
    if (color) scheme[localName(c.name)] = color;
  }
  return scheme;
}

/* ────────────────────────────── inheritance ────────────────────────────── */

interface PhInfo { type: string; idx: string | null; xfrm: Xfrm | null; size: number | null; anchor: 't' | 'ctr' | 'b' | null }
interface Xfrm { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean }

/** What a layout or master says about placeholders, backgrounds and default sizes. */
interface Template {
  phs: PhInfo[];
  bg: string | null;
  /** titleStyle / bodyStyle / otherStyle lvl1 sizes (points) — masters only. */
  titleSize?: number | null;
  bodySize?: number | null;
  otherSize?: number | null;
  bodyBullet?: boolean;
}

function readXfrm(xml: string, x: XmlElement | null): Xfrm | null {
  if (!x) return null;
  const off = child(x, 'off');
  const ext = child(x, 'ext');
  if (!off || !ext) return null;
  return {
    x: num(xml, off, 'x'), y: num(xml, off, 'y'), w: num(xml, ext, 'cx'), h: num(xml, ext, 'cy'),
    rot: num(xml, x, 'rot') / 60000, flipH: attr(xml, x, 'flipH') === '1', flipV: attr(xml, x, 'flipV') === '1',
  };
}

function lvl1Size(xml: string, style: XmlElement | null): number | null {
  const defRPr = childPath(style, 'lvl1pPr', 'defRPr');
  const sz = defRPr ? Number(attr(xml, defRPr, 'sz')) : NaN;
  return Number.isFinite(sz) && sz > 0 ? sz / 100 : null;
}

function bgOf(xml: string, cSld: XmlElement | null, scheme: Record<string, string>): string | null {
  const bg = child(cSld, 'bg');
  if (!bg) return null;
  const bgPr = child(bg, 'bgPr');
  if (bgPr) return fillOf(xml, bgPr, scheme) ?? null;
  const bgRef = child(bg, 'bgRef');
  return bgRef ? colorOf(xml, bgRef, scheme) : null;
}

function readTemplate(xml: string | null, scheme: Record<string, string>): Template {
  if (!xml) return { phs: [], bg: null };
  const doc = parsePart(xml);
  const root = doc.roots[0];
  const cSld = child(root, 'cSld');
  const phs: PhInfo[] = [];
  for (const sp of elementsOf(cSld ?? root, 'sp')) {
    const ph = childPath(sp, 'nvSpPr', 'nvPr', 'ph');
    if (!ph) continue;
    const defRPr = childPath(sp, 'txBody', 'lstStyle', 'lvl1pPr', 'defRPr');
    const sz = defRPr ? Number(attr(xml, defRPr, 'sz')) : NaN;
    const anchor = attr(xml, childPath(sp, 'txBody', 'bodyPr') ?? sp, 'anchor');
    phs.push({
      type: attr(xml, ph, 'type') ?? 'body', idx: attr(xml, ph, 'idx'),
      xfrm: readXfrm(xml, childPath(sp, 'spPr', 'xfrm')),
      size: Number.isFinite(sz) && sz > 0 ? sz / 100 : null,
      anchor: anchor === 'ctr' || anchor === 'b' || anchor === 't' ? anchor : null,
    });
  }
  const out: Template = { phs, bg: bgOf(xml, cSld, scheme) };
  const tx = child(root, 'txStyles');
  if (tx) {
    out.titleSize = lvl1Size(xml, child(tx, 'titleStyle'));
    out.bodySize = lvl1Size(xml, child(tx, 'bodyStyle'));
    out.otherSize = lvl1Size(xml, child(tx, 'otherStyle'));
    const lvl1 = childPath(tx, 'bodyStyle', 'lvl1pPr');
    out.bodyBullet = !!lvl1 && !!(child(lvl1, 'buChar') || child(lvl1, 'buAutoNum')) && !child(lvl1, 'buNone');
  }
  return out;
}

const TITLE_TYPES = new Set(['title', 'ctrTitle']);

function findPh(t: Template | null, type: string, idx: string | null, master: boolean): PhInfo | null {
  if (!t) return null;
  if (!master && idx !== null) {
    const byIdx = t.phs.find((p) => p.idx === idx);
    if (byIdx) return byIdx;
  }
  if (master) {
    const cls = TITLE_TYPES.has(type) ? 'title' : ['dt', 'ftr', 'sldNum'].includes(type) ? type : 'body';
    return t.phs.find((p) => p.type === cls) ?? null;
  }
  return t.phs.find((p) => p.type === type) ?? (type === 'ctrTitle' ? t.phs.find((p) => p.type === 'title') ?? null : null);
}

/* ───────────────────────────────── shapes ───────────────────────────────── */

interface Ctx {
  xml: string;
  scheme: Record<string, string>;
  rels: Rel[];
  layout: Template | null;
  master: Template | null;
  media: Map<string, Uint8Array>;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp',
};

function readParas(ctx: Ctx, txBody: XmlElement | null, isBodyPh: boolean): DeckPara[] {
  if (!txBody) return [];
  const { xml, scheme } = ctx;
  const out: DeckPara[] = [];
  for (const p of txBody.children.filter((c) => localName(c.name) === 'p')) {
    const pPr = child(p, 'pPr');
    const firstRun = p.children.find((c) => localName(c.name) === 'r' || localName(c.name) === 'fld');
    const rPr = child(firstRun, 'rPr') ?? child(p, 'endParaRPr');
    const sz = rPr ? Number(attr(xml, rPr, 'sz')) : NaN;
    const algn = pPr ? attr(xml, pPr, 'algn') : null;
    const explicitBullet = !!pPr && !!(child(pPr, 'buChar') || child(pPr, 'buAutoNum'));
    const noBullet = !!pPr && !!child(pPr, 'buNone');
    const text = paraText(xml, p);
    out.push({
      text,
      size: Number.isFinite(sz) && sz > 0 ? sz / 100 : null,
      bold: !!rPr && ['1', 'true'].includes(attr(xml, rPr, 'b') ?? ''),
      italic: !!rPr && ['1', 'true'].includes(attr(xml, rPr, 'i') ?? ''),
      // `u="none"` is an explicit "not underlined"; anything else (sng, dbl, dotted…) is on.
      underline: !!rPr && !!attr(xml, rPr, 'u') && attr(xml, rPr, 'u') !== 'none',
      color: rPr ? colorOf(xml, child(rPr, 'solidFill'), scheme) : null,
      align: algn === 'ctr' || algn === 'r' || algn === 'just' || algn === 'l' ? algn : algn === 'dist' ? 'just' : null,
      bullet: explicitBullet || (isBodyPh && !noBullet && !!ctx.master?.bodyBullet && text.trim() !== ''),
    });
  }
  return out;
}

function blank(kind: ShapeKind, origin: number | null): DeckShape {
  return {
    uid: nextUid(), kind, origin, spid: 0, name: '', ph: null, phIdx: null, geom: 'rect',
    x: 0, y: 0, w: 0, h: 0, rot: 0, flipH: false, flipV: false, fill: null, stroke: null, strokeW: 12700, arrow: false,
    paras: [], ink: null, anchor: 't', fontScale: 1, image: null, children: [], box: null, table: null, anim: null, locked: false,
  };
}

function applyXfrm(shape: DeckShape, x: Xfrm | null): void {
  if (!x) return;
  shape.x = x.x; shape.y = x.y; shape.w = x.w; shape.h = x.h;
  shape.rot = x.rot; shape.flipH = x.flipH; shape.flipV = x.flipV;
}

function readLine(ctx: Ctx, spPr: XmlElement | null, style: XmlElement | null, shape: DeckShape): void {
  const { xml, scheme } = ctx;
  const ln = child(spPr, 'ln');
  const lnFill = fillOf(xml, ln, scheme);
  const lnRef = child(style, 'lnRef');
  if (lnFill !== undefined) shape.stroke = lnFill;
  else if (lnRef && num(xml, lnRef, 'idx') > 0) shape.stroke = colorOf(xml, lnRef, scheme);
  if (ln && attr(xml, ln, 'w') !== null) shape.strokeW = num(xml, ln, 'w');
  const tail = child(ln, 'tailEnd');
  shape.arrow = !!tail && !['none', null].includes(attr(xml, tail, 'type'));
}

/** One top-level (or grouped) shape element, or null for something that is not a shape. */
function readShape(ctx: Ctx, el: XmlElement, origin: number | null): DeckShape | null {
  const { xml, scheme } = ctx;
  const name = localName(el.name);
  if (name === 'AlternateContent') {
    const branch = child(el, 'Fallback') ?? child(el, 'Choice');
    const inner = branch?.children[0];
    const shape = inner ? readShape(ctx, inner, origin) : null;
    if (shape) { shape.locked = true; for (const c of shape.children) c.locked = true; }
    return shape;
  }
  if (name === 'sp' || name === 'cxnSp') {
    const nv = child(el, name === 'sp' ? 'nvSpPr' : 'nvCxnSpPr');
    const cNvPr = child(nv, 'cNvPr');
    const ph = childPath(nv, 'nvPr', 'ph');
    const spPr = child(el, 'spPr');
    const style = child(el, 'style');
    const geom = attr(xml, child(spPr, 'prstGeom') ?? el, 'prst') ?? (child(spPr, 'custGeom') ? 'rect' : 'rect');
    const isLine = name === 'cxnSp' || geom === 'line' || geom.startsWith('straightConnector') || geom.startsWith('bentConnector') || geom.startsWith('curvedConnector');
    const txBox = attr(xml, child(nv, 'cNvSpPr') ?? el, 'txBox') === '1';
    const shape = blank(isLine ? 'line' : 'text', origin);
    shape.spid = num(xml, cNvPr, 'id');
    shape.name = cNvPr ? decodeXml(attr(xml, cNvPr, 'name') ?? '') : '';
    shape.geom = isLine ? 'line' : geom;
    if (ph) { shape.ph = attr(xml, ph, 'type') ?? 'body'; shape.phIdx = attr(xml, ph, 'idx'); }
    let own = readXfrm(xml, child(spPr, 'xfrm'));
    let inherited: PhInfo | null = null;
    if (shape.ph) {
      inherited = findPh(ctx.layout, shape.ph, shape.phIdx, false);
      const fromMaster = findPh(ctx.master, shape.ph, shape.phIdx, true);
      if (!own) own = inherited?.xfrm ?? fromMaster?.xfrm ?? null;
      if (!inherited) inherited = fromMaster;
      else if (inherited.size === null && fromMaster?.size) inherited = { ...inherited, size: fromMaster.size };
    }
    applyXfrm(shape, own);
    const fill = fillOf(xml, spPr, scheme);
    const fillRef = child(style, 'fillRef');
    if (fill !== undefined) shape.fill = fill;
    else if (fillRef && num(xml, fillRef, 'idx') > 0) shape.fill = colorOf(xml, fillRef, scheme);
    readLine(ctx, spPr, style, shape);
    if (!isLine) {
      const fontRef = child(style, 'fontRef');
      shape.ink = fontRef ? colorOf(xml, fontRef, scheme) : null;
      const txBody = child(el, 'txBody');
      const bodyPr = child(txBody, 'bodyPr');
      const anchor = bodyPr ? attr(xml, bodyPr, 'anchor') : null;
      shape.anchor = anchor === 'ctr' || anchor === 'b' || anchor === 't' ? anchor : inherited?.anchor ?? (shape.ph && TITLE_TYPES.has(shape.ph) ? 'ctr' : geom !== 'rect' || (!txBox && shape.fill) ? 'ctr' : 't');
      const scale = Number(attr(xml, child(bodyPr, 'normAutofit') ?? el, 'fontScale'));
      if (Number.isFinite(scale) && scale > 0) shape.fontScale = scale / 100000;
      const isBody = !!shape.ph && !TITLE_TYPES.has(shape.ph) && !['subTitle', 'dt', 'ftr', 'sldNum'].includes(shape.ph);
      shape.paras = readParas(ctx, txBody, isBody);
      const fallbackSize = inherited?.size
        ?? (shape.ph ? (TITLE_TYPES.has(shape.ph) ? ctx.master?.titleSize : ctx.master?.bodySize) : ctx.master?.otherSize)
        ?? (shape.ph && TITLE_TYPES.has(shape.ph) ? 44 : shape.ph ? 28 : 18);
      for (const p of shape.paras) if (p.size === null) p.size = fallbackSize;
      if (!txBox && !shape.ph && (shape.fill || shape.stroke)) shape.kind = 'shape';
    }
    return shape;
  }
  if (name === 'pic') {
    const cNvPr = childPath(el, 'nvPicPr', 'cNvPr');
    const shape = blank('pic', origin);
    shape.spid = num(xml, cNvPr, 'id');
    shape.name = cNvPr ? decodeXml(attr(xml, cNvPr, 'name') ?? '') : '';
    const spPr = child(el, 'spPr');
    applyXfrm(shape, readXfrm(xml, child(spPr, 'xfrm')));
    readLine(ctx, spPr, child(el, 'style'), shape);
    const blip = childPath(el, 'blipFill', 'blip');
    const rid = blip ? attrLocal(xml, blip, 'embed') : null;
    const rel = ctx.rels.find((r) => r.id === rid && !r.external);
    const bytes = rel ? ctx.media.get(rel.target) : undefined;
    if (rel && bytes) {
      const ext = (rel.target.split('.').pop() ?? '').toLowerCase();
      shape.image = { path: rel.target, bytes, mime: MIME[ext] ?? 'application/octet-stream', ext };
    }
    return shape;
  }
  if (name === 'grpSp') {
    const grpSpPr = child(el, 'grpSpPr');
    const x = child(grpSpPr, 'xfrm');
    const shape = blank('group', origin);
    const cNvPr = childPath(el, 'nvGrpSpPr', 'cNvPr');
    shape.spid = num(xml, cNvPr, 'id');
    shape.name = cNvPr ? decodeXml(attr(xml, cNvPr, 'name') ?? '') : '';
    applyXfrm(shape, readXfrm(xml, x));
    const chOff = child(x, 'chOff');
    const chExt = child(x, 'chExt');
    shape.box = { x: num(xml, chOff, 'x'), y: num(xml, chOff, 'y'), w: num(xml, chExt, 'cx', shape.w), h: num(xml, chExt, 'cy', shape.h) };
    for (const c of el.children) {
      const inner = readShape(ctx, c, null);
      if (inner) { inner.locked = true; shape.children.push(inner); }
    }
    return shape;
  }
  if (name === 'graphicFrame') {
    const shape = blank('frame', origin);
    const cNvPr = childPath(el, 'nvGraphicFramePr', 'cNvPr');
    shape.spid = num(xml, cNvPr, 'id');
    shape.name = cNvPr ? decodeXml(attr(xml, cNvPr, 'name') ?? '') : '';
    applyXfrm(shape, readXfrm(xml, child(el, 'xfrm')));
    const tbl = childPath(el, 'graphic', 'graphicData', 'tbl');
    if (tbl) {
      shape.table = tbl.children.filter((c) => localName(c.name) === 'tr').map((tr) =>
        tr.children.filter((c) => localName(c.name) === 'tc').map((tc) =>
          elementsOf(tc, 'p').map((p) => paraText(xml, p)).join('\n')));
    }
    return shape;
  }
  return null;
}

/** The shape elements of a spTree, in order: what `origin` counts. */
export function shapeElements(spTree: XmlElement): XmlElement[] {
  return spTree.children.filter((c) => ['sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame', 'AlternateContent', 'contentPart'].includes(localName(c.name)));
}

/** The transition of a slide: a direct `<p:transition>` or one inside mc:AlternateContent. */
export function transitionElement(root: XmlElement): XmlElement | null {
  for (const c of root.children) {
    const name = localName(c.name);
    if (name === 'transition') return c;
    if (name === 'AlternateContent' && elementsOf(c, 'transition').length) return c;
  }
  return null;
}

function readTransition(xml: string, root: XmlElement): Transition {
  const el = transitionElement(root);
  if (!el) return 'none';
  const t = localName(el.name) === 'transition' ? el : (elementsOf(child(el, 'Fallback') ?? el, 'transition')[0] ?? elementsOf(el, 'transition')[0]);
  const kind = t?.children.find((c) => !['sndAc', 'extLst'].includes(localName(c.name)));
  if (!kind) return t ? 'other' : 'none';
  const name = localName(kind.name);
  return name === 'fade' ? 'fade' : name === 'push' ? 'push' : 'other';
}

/** Entrance effects by shape id: presetID 10 is Fade, anything else is drawn as Appear. */
function readTiming(xml: string, root: XmlElement): Map<number, Anim> {
  const out = new Map<number, Anim>();
  const timing = child(root, 'timing');
  if (!timing) return out;
  for (const cTn of elementsOf(timing, 'cTn')) {
    if (attr(xml, cTn, 'presetClass') !== 'entr') continue;
    const tgt = elementsOf(cTn, 'spTgt')[0];
    const spid = tgt ? Number(attr(xml, tgt, 'spid')) : NaN;
    if (!Number.isFinite(spid) || out.has(spid)) continue;
    out.set(spid, attr(xml, cTn, 'presetID') === '10' ? 'fade' : 'appear');
  }
  return out;
}

function readNotes(xml: string | null): string {
  if (!xml) return '';
  const doc = parsePart(xml);
  const root = doc.roots[0];
  if (!root) return '';
  for (const sp of elementsOf(root, 'sp')) {
    const ph = childPath(sp, 'nvSpPr', 'nvPr', 'ph');
    if (!ph || attr(xml, ph, 'type') !== 'body') continue;
    const body = child(sp, 'txBody');
    return body ? body.children.filter((c) => localName(c.name) === 'p').map((p) => paraText(xml, p)).join('\n').trim() : '';
  }
  return '';
}

/* ───────────────────────────────── the deck ───────────────────────────────── */

async function text(archive: RawZip, name: string): Promise<string | null> {
  const bytes = await entryData(archive, name);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/** The slide parts in presentation order (sldIdLst), with their sldId ids. */
export function slideOrder(presXml: string, presRels: Rel[]): Array<{ part: string; id: number; rid: string }> {
  const doc = parsePart(presXml);
  const root = doc.roots[0];
  const lst = child(root, 'sldIdLst');
  if (!lst) return [];
  return lst.children.filter((c) => localName(c.name) === 'sldId').map((s) => {
    // `id` (the slide id) and `r:id` (the relationship) share a local name: read both explicitly.
    const open = presXml.slice(s.start, s.openEnd);
    const plain = /\sid\s*=\s*["'](\d+)["']/.exec(open)?.[1];
    const rId = /\s[\w.-]+:id\s*=\s*["']([^"']*)["']/.exec(open)?.[1] ?? '';
    const rel = presRels.find((r) => r.id === rId);
    return { part: rel?.target ?? '', id: Number(plain ?? 0), rid: rId };
  }).filter((s) => s.part);
}

/**
 * Reads a .pptx into the rich model. Throws when the package is not a presentation
 * (no `ppt/presentation.xml`); the window then keeps the plain paragraph view.
 */
export async function readDeck(bytes: Uint8Array): Promise<Deck> {
  const archive = readRawZip(bytes);
  const presPart = 'ppt/presentation.xml';
  const presXml = await text(archive, presPart);
  if (!presXml) throw new Error('impress: no presentation.xml');
  const presRels = parseRels(await text(archive, relsPath(presPart)), presPart);
  const presDoc = parsePart(presXml);
  const sldSz = child(presDoc.roots[0], 'sldSz');
  const cx = num(presXml, sldSz, 'cx', DEFAULT_CX) || DEFAULT_CX;
  const cy = num(presXml, sldSz, 'cy', DEFAULT_CY) || DEFAULT_CY;

  const themeRel = presRels.find((r) => r.type === 'theme');
  const scheme = readScheme(themeRel ? await text(archive, themeRel.target) : null);

  const media = new Map<string, Uint8Array>();
  const templates = new Map<string, Template>();
  const relsCache = new Map<string, Rel[]>();
  const relsOf = async (part: string): Promise<Rel[]> => {
    let r = relsCache.get(part);
    if (!r) { r = parseRels(await text(archive, relsPath(part)), part); relsCache.set(part, r); }
    return r;
  };
  const template = async (part: string | undefined): Promise<Template | null> => {
    if (!part) return null;
    let t = templates.get(part);
    if (!t) { t = readTemplate(await text(archive, part), scheme); templates.set(part, t); }
    return t;
  };

  // Layouts, through the masters, in the masters' order.
  const layouts: DeckLayout[] = [];
  for (const masterRel of presRels.filter((r) => r.type === 'slideMaster')) {
    for (const lr of (await relsOf(masterRel.target)).filter((r) => r.type === 'slideLayout')) {
      if (layouts.some((l) => l.part === lr.target)) continue;
      const lx = await text(archive, lr.target);
      if (!lx) continue;
      const root = parsePart(lx).roots[0];
      const cSld = child(root, 'cSld');
      layouts.push({ part: lr.target, type: root ? attr(lx, root, 'type') ?? 'cust' : 'cust', name: cSld ? decodeXml(attr(lx, cSld, 'name') ?? '') : '' });
    }
  }

  const slides: DeckSlide[] = [];
  for (const { part } of slideOrder(presXml, presRels)) {
    const xml = await text(archive, part);
    if (xml === null) continue;
    const rels = await relsOf(part);
    const layoutPart = rels.find((r) => r.type === 'slideLayout')?.target;
    const layout = await template(layoutPart);
    const masterPart = layoutPart ? (await relsOf(layoutPart)).find((r) => r.type === 'slideMaster')?.target : undefined;
    const master = await template(masterPart);
    for (const r of rels) {
      if (r.type === 'image' && !r.external && !media.has(r.target)) {
        const data = await entryData(archive, r.target);
        if (data) media.set(r.target, data);
      }
    }
    const ctx: Ctx = { xml, scheme, rels, layout, master, media };
    const root = parsePart(xml).roots[0];
    if (!root) continue;
    const cSld = child(root, 'cSld');
    const spTree = child(cSld, 'spTree');
    const shapes: DeckShape[] = [];
    if (spTree) {
      shapeElements(spTree).forEach((el, i) => {
        const s = readShape(ctx, el, i);
        if (s) shapes.push(s);
      });
    }
    const anims = readTiming(xml, root);
    for (const s of shapes) s.anim = anims.get(s.spid) ?? null;
    const notesRel = rels.find((r) => r.type === 'notesSlide');
    slides.push({
      uid: nextUid(), part, from: null, layout: layoutPart ?? null, shapes,
      bg: bgOf(xml, cSld, scheme) ?? layout?.bg ?? master?.bg ?? null,
      notes: readNotes(notesRel ? await text(archive, notesRel.target) : null),
      transition: readTransition(xml, root),
    });
  }
  return { cx, cy, slides, layouts, scheme };
}

/** The plain paragraphs of every slide (non-blank, in shape order), for the text model. */
export function deckTexts(deck: Deck): string[][] {
  const walk = (shapes: readonly DeckShape[], out: string[]): void => {
    for (const s of shapes) {
      for (const p of s.paras) if (p.text.trim()) out.push(p.text);
      if (s.table) for (const row of s.table) for (const cell of row) if (cell.trim()) out.push(cell);
      walk(s.children, out);
    }
  };
  return deck.slides.map((slide) => { const out: string[] = []; walk(slide.shapes, out); return out; });
}
