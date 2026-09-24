/**
 * Writer — reading a .docx into runs and a faithful look (قراءة مستند Word).
 *
 * The viewer's `readDocx` gives the text of every paragraph; this reader gives
 * the same paragraphs (the same list, in the same order: it walks the part with
 * the scanner the save uses, and a test holds the two readers to each other)
 * together with what Word would show:
 *
 *  • runs with their own bold/italic/underline/colour/size/font, and the raw
 *    `<w:rPr>` of each, so a save writes back what it does not model untouched;
 *  • the paragraph's look resolved through docDefaults → style chain → direct
 *    properties, with the theme's fonts and colours (Aptos, Arial for Arabic…);
 *  • list markers from numbering.xml, tables (grid widths, merges, borders,
 *    shading), pictures, the page size and margins, headers and footers with
 *    their page-number fields, and comments.
 *
 * Nothing here touches the DOM: the result is plain data, tested on its own.
 */
import { entryData, readRawZip, type RawZip } from '../zip';
import {
  attrLocal as rawAttr, elementText, elementsOf, localName, paragraphElements, paragraphSlots, parsePart,
  type XmlElement,
} from '../xmlscan';
import type { ParagraphAlign, ParagraphFormat } from '../model';
import { blockText, type DocBlock, type ImageInfo, type OpaqueRun, type Run, type RunProps, type TextRun } from './types';

/** An attribute by local name; a missing element simply has no attributes. */
function attrLocal(xml: string, element: XmlElement | undefined | null, name: string): string | null {
  return element ? rawAttr(xml, element, name) : null;
}

/* ───────────────────────────── XML text ───────────────────────────── */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the five XML entities and numeric character references. */
export function decodeXml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

const child = (element: XmlElement | undefined, name: string): XmlElement | undefined =>
  element?.children.find((c) => localName(c.name) === name);

/** The text an element contributes, walked exactly like the viewer's `paragraphText`. */
export function slotsText(xml: string, element: XmlElement): string {
  return paragraphSlots(element).map((slot) => {
    if (slot.kind === 'tab') return '\t';
    if (slot.kind === 'break') return '\n';
    return decodeXml(elementText(xml, slot.element));
  }).join('');
}

/* ───────────────────────────── theme ───────────────────────────── */

export interface Theme {
  major: { latin: string; cs: string };
  minor: { latin: string; cs: string };
  colors: Record<string, string>;
}

const EMPTY_THEME: Theme = { major: { latin: '', cs: '' }, minor: { latin: '', cs: '' }, colors: {} };

export function readTheme(xml: string | null): Theme {
  if (!xml) return EMPTY_THEME;
  const doc = parsePart(xml);
  const theme: Theme = { major: { latin: '', cs: '' }, minor: { latin: '', cs: '' }, colors: {} };
  const all = (root: XmlElement[], name: string): XmlElement[] => root.flatMap((r) => (localName(r.name) === name ? [r] : []).concat(elementsOf(r, name)));
  for (const [kind, slot] of [['majorFont', theme.major], ['minorFont', theme.minor]] as const) {
    const font = all(doc.roots, kind)[0];
    if (!font) continue;
    slot.latin = attrLocal(xml, child(font, 'latin') ?? font, 'typeface') ?? '';
    slot.cs = attrLocal(xml, child(font, 'cs') ?? font, 'typeface') ?? '';
    if (!slot.cs) {
      const arab = font.children.find((c) => localName(c.name) === 'font' && attrLocal(xml, c, 'script') === 'Arab');
      if (arab) slot.cs = attrLocal(xml, arab, 'typeface') ?? '';
    }
  }
  const scheme = all(doc.roots, 'clrScheme')[0];
  for (const entry of scheme?.children ?? []) {
    const value = entry.children[0];
    if (!value) continue;
    const hex = attrLocal(xml, value, 'lastClr') ?? attrLocal(xml, value, 'val');
    if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) theme.colors[localName(entry.name)] = hex.toUpperCase();
  }
  return theme;
}

/** Word's theme-colour names → the scheme slot they read. */
const THEME_COLOR: Record<string, string> = {
  dark1: 'dk1', light1: 'lt1', dark2: 'dk2', light2: 'lt2', text1: 'dk1', background1: 'lt1', text2: 'dk2', background2: 'lt2',
  accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
  hyperlink: 'hlink', followedHyperlink: 'folHlink',
};

function shade(hex: string, factor: number, tint: boolean): string {
  const n = parseInt(hex, 16);
  const channel = (v: number): number => Math.round(tint ? v + (255 - v) * (1 - factor) : v * factor);
  const r = channel((n >> 16) & 255);
  const g = channel((n >> 8) & 255);
  const b = channel(n & 255);
  return [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/* ─────────────────────────── run and paragraph properties ─────────────────────────── */

/** A resolved text look (what CSS needs), including complex-script variants. */
export interface TextLook {
  font?: string;
  fontCs?: string;
  sz?: number;
  szCs?: number;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  color?: string;
  hl?: string;
  caps?: boolean;
}

function toggleOf(xml: string, element: XmlElement | undefined): boolean | undefined {
  if (!element) return undefined;
  const value = (attrLocal(xml, element, 'val') ?? '').toLowerCase();
  return !(value === '0' || value === 'false' || value === 'off');
}

function fontName(xml: string, fonts: XmlElement | undefined, theme: Theme, cs: boolean): string | undefined {
  if (!fonts) return undefined;
  const themeRef = attrLocal(xml, fonts, cs ? 'cstheme' : 'asciiTheme');
  if (themeRef) {
    const major = themeRef.startsWith('major');
    const slot = major ? theme.major : theme.minor;
    const name = cs || /Bidi$/.test(themeRef) ? slot.cs || slot.latin : slot.latin;
    if (name) return name;
  }
  return attrLocal(xml, fonts, cs ? 'cs' : 'ascii') ?? attrLocal(xml, fonts, 'hAnsi') ?? undefined;
}

function colorOf(xml: string, element: XmlElement | undefined, theme: Theme): string | undefined {
  if (!element) return undefined;
  const themeColor = attrLocal(xml, element, 'themeColor');
  if (themeColor && THEME_COLOR[themeColor] && theme.colors[THEME_COLOR[themeColor]]) {
    let hex = theme.colors[THEME_COLOR[themeColor]];
    const shadeVal = attrLocal(xml, element, 'themeShade');
    const tintVal = attrLocal(xml, element, 'themeTint');
    if (shadeVal) hex = shade(hex, parseInt(shadeVal, 16) / 255, false);
    else if (tintVal) hex = shade(hex, parseInt(tintVal, 16) / 255, true);
    return hex;
  }
  const value = attrLocal(xml, element, 'val');
  if (!value || value === 'auto' || !/^[0-9a-fA-F]{6}$/.test(value)) return undefined;
  return value.toUpperCase();
}

/** Every text property an `<w:rPr>` states (the look layer). */
export function readTextLook(xml: string, rPr: XmlElement | undefined, theme: Theme): TextLook {
  const out: TextLook = {};
  if (!rPr) return out;
  const fonts = child(rPr, 'rFonts');
  const font = fontName(xml, fonts, theme, false);
  const fontCs = fontName(xml, fonts, theme, true);
  if (font) out.font = font;
  if (fontCs) out.fontCs = fontCs;
  const b = toggleOf(xml, child(rPr, 'b'));
  if (b !== undefined) out.b = b;
  const i = toggleOf(xml, child(rPr, 'i'));
  if (i !== undefined) out.i = i;
  const strike = toggleOf(xml, child(rPr, 'strike'));
  if (strike !== undefined) out.strike = strike;
  const caps = toggleOf(xml, child(rPr, 'caps'));
  if (caps !== undefined) out.caps = caps;
  const u = child(rPr, 'u');
  if (u) out.u = (attrLocal(xml, u, 'val') ?? 'single').toLowerCase() !== 'none';
  const color = colorOf(xml, child(rPr, 'color'), theme);
  if (color) out.color = color;
  const sz = Number(attrLocal(xml, child(rPr, 'sz') ?? rPr, 'val'));
  if (child(rPr, 'sz') && Number.isFinite(sz) && sz > 0) out.sz = sz / 2;
  const szCs = Number(attrLocal(xml, child(rPr, 'szCs') ?? rPr, 'val'));
  if (child(rPr, 'szCs') && Number.isFinite(szCs) && szCs > 0) out.szCs = szCs / 2;
  const hl = child(rPr, 'highlight');
  if (hl) {
    const value = attrLocal(xml, hl, 'val');
    if (value && value !== 'none') out.hl = value;
  } else {
    const shd = child(rPr, 'shd');
    const fill = shd ? attrLocal(xml, shd, 'fill') : null;
    if (fill && /^[0-9a-fA-F]{6}$/.test(fill)) out.hl = `#${fill.toUpperCase()}`;
  }
  return out;
}

/**
 * The editable run properties an `<w:rPr>` states directly. A complex-script run
 * (`<w:rtl/>` or `w:hint="cs"`) reports its complex-script font and size, which is
 * what Word uses to draw Arabic text.
 */
export function readRunProps(xml: string, rPr: XmlElement | undefined, theme: Theme): RunProps {
  const props: RunProps = {};
  if (!rPr) return props;
  const look = readTextLook(xml, rPr, theme);
  const rtl = toggleOf(xml, child(rPr, 'rtl'));
  const hint = attrLocal(xml, child(rPr, 'rFonts') ?? rPr, 'hint');
  const cs = rtl === true || (hint === 'cs' && !!child(rPr, 'rFonts'));
  if (rtl !== undefined) props.rtl = rtl;
  if (look.b !== undefined) props.b = look.b;
  if (look.i !== undefined) props.i = look.i;
  if (look.u !== undefined) props.u = look.u;
  if (look.strike !== undefined) props.strike = look.strike;
  if (look.color) props.color = look.color;
  if (look.hl && !look.hl.startsWith('#')) props.hl = look.hl;
  const sz = cs ? look.szCs ?? look.sz : look.sz ?? look.szCs;
  if (sz !== undefined) props.sz = sz;
  const font = cs ? look.fontCs ?? look.font : look.font;
  if (font) props.font = font;
  const va = child(rPr, 'vertAlign');
  const vaVal = va ? attrLocal(xml, va, 'val') : null;
  if (vaVal === 'superscript' || vaVal === 'subscript') props.va = vaVal;
  return props;
}

export interface ParaLookProps {
  align?: ParagraphAlign;
  bidi?: boolean;
  /** Spacing in points; `line` is a multiple when `lineRule` is auto, else points. */
  before?: number;
  after?: number;
  line?: number;
  lineExact?: boolean;
  indStart?: number;
  indEnd?: number;
  firstLine?: number;
  numId?: string;
  ilvl?: number;
  outline?: number;
  pageBreakBefore?: boolean;
  keepNext?: boolean;
  shade?: string;
}

const twip = (value: string | null): number | undefined => {
  const n = Number(value);
  return value !== null && Number.isFinite(n) ? n / 20 : undefined;
};

export function alignOf(value: string | null | undefined): ParagraphAlign | undefined {
  switch ((value ?? '').toLowerCase()) {
    case 'both': case 'distribute': case 'justify': return 'justify';
    case 'center': return 'center';
    case 'right': case 'end': return 'right';
    case 'left': case 'start': return 'left';
    default: return undefined;
  }
}

export function readParaProps(xml: string, pPr: XmlElement | undefined, theme: Theme): ParaLookProps {
  const out: ParaLookProps = {};
  if (!pPr) return out;
  const jc = child(pPr, 'jc');
  if (jc) {
    const align = alignOf(attrLocal(xml, jc, 'val'));
    if (align) out.align = align;
  }
  const bidi = toggleOf(xml, child(pPr, 'bidi'));
  if (bidi !== undefined) out.bidi = bidi;
  const spacing = child(pPr, 'spacing');
  if (spacing) {
    const before = twip(attrLocal(xml, spacing, 'before'));
    const after = twip(attrLocal(xml, spacing, 'after'));
    if (before !== undefined) out.before = before;
    if (after !== undefined) out.after = after;
    const line = Number(attrLocal(xml, spacing, 'line'));
    const rule = attrLocal(xml, spacing, 'lineRule') ?? 'auto';
    if (Number.isFinite(line) && line > 0) {
      if (rule === 'auto') out.line = line / 240;
      else { out.line = line / 20; out.lineExact = true; }
    }
  }
  const ind = child(pPr, 'ind');
  if (ind) {
    const start = twip(attrLocal(xml, ind, 'start') ?? attrLocal(xml, ind, 'left'));
    const end = twip(attrLocal(xml, ind, 'end') ?? attrLocal(xml, ind, 'right'));
    const first = twip(attrLocal(xml, ind, 'firstLine'));
    const hanging = twip(attrLocal(xml, ind, 'hanging'));
    if (start !== undefined) out.indStart = start;
    if (end !== undefined) out.indEnd = end;
    if (first !== undefined) out.firstLine = first;
    else if (hanging !== undefined) out.firstLine = -hanging;
  }
  const numPr = child(pPr, 'numPr');
  if (numPr) {
    const numId = attrLocal(xml, child(numPr, 'numId') ?? numPr, 'val');
    const ilvl = Number(attrLocal(xml, child(numPr, 'ilvl') ?? numPr, 'val') ?? 0);
    if (numId !== null && child(numPr, 'numId')) out.numId = numId;
    out.ilvl = Number.isFinite(ilvl) ? ilvl : 0;
  }
  const outline = child(pPr, 'outlineLvl');
  if (outline) out.outline = Number(attrLocal(xml, outline, 'val') ?? 9);
  const pbb = toggleOf(xml, child(pPr, 'pageBreakBefore'));
  if (pbb !== undefined) out.pageBreakBefore = pbb;
  const keep = toggleOf(xml, child(pPr, 'keepNext'));
  if (keep !== undefined) out.keepNext = keep;
  const shd = child(pPr, 'shd');
  const fill = shd ? attrLocal(xml, shd, 'fill') : null;
  if (fill && /^[0-9a-fA-F]{6}$/.test(fill)) out.shade = fill.toUpperCase();
  if (theme === undefined) return out;
  return out;
}

/* ───────────────────────────── styles ───────────────────────────── */

export interface StyleDef {
  id: string;
  name: string;
  type: string;
  basedOn?: string;
  para: ParaLookProps;
  text: TextLook;
  isDefault: boolean;
  /** The style is offered in Word's quick gallery. */
  quick: boolean;
}

export interface Styles {
  defs: Map<string, StyleDef>;
  defaultPara: string;
  docText: TextLook;
  docPara: ParaLookProps;
}

export function readStyles(xml: string | null, theme: Theme): Styles {
  const styles: Styles = { defs: new Map(), defaultPara: 'Normal', docText: {}, docPara: {} };
  if (!xml) return styles;
  const doc = parsePart(xml);
  const root = doc.roots.find((r) => localName(r.name) === 'styles');
  if (!root) return styles;
  const defaults = child(root, 'docDefaults');
  styles.docText = readTextLook(xml, child(child(defaults, 'rPrDefault'), 'rPr'), theme);
  styles.docPara = readParaProps(xml, child(child(defaults, 'pPrDefault'), 'pPr'), theme);
  for (const style of root.children) {
    if (localName(style.name) !== 'style') continue;
    const id = attrLocal(xml, style, 'styleId') ?? '';
    if (!id) continue;
    const type = attrLocal(xml, style, 'type') ?? 'paragraph';
    const def: StyleDef = {
      id,
      type,
      name: attrLocal(xml, child(style, 'name') ?? style, 'val') ?? id,
      basedOn: child(style, 'basedOn') ? attrLocal(xml, child(style, 'basedOn') as XmlElement, 'val') ?? undefined : undefined,
      para: readParaProps(xml, child(style, 'pPr'), theme),
      text: readTextLook(xml, child(style, 'rPr'), theme),
      isDefault: ['1', 'true', 'on'].includes((attrLocal(xml, style, 'default') ?? '').toLowerCase()),
      quick: !!child(style, 'qFormat'),
    };
    styles.defs.set(id, def);
    if (type === 'paragraph' && def.isDefault) styles.defaultPara = id;
  }
  return styles;
}

/** Built-in looks for the common styles, used when a file does not define them. */
const BUILTIN: Record<string, { para: ParaLookProps; text: TextLook; name: string }> = {
  Normal: { name: 'Normal', para: {}, text: {} },
  Title: { name: 'Title', para: { after: 6 }, text: { sz: 28, color: '17365D' } },
  Subtitle: { name: 'Subtitle', para: { after: 8 }, text: { sz: 15, color: '595959', i: true } },
  Heading1: { name: 'heading 1', para: { before: 18, after: 6, outline: 0 }, text: { sz: 18, b: true, color: '1F3864' } },
  Heading2: { name: 'heading 2', para: { before: 12, after: 4, outline: 1 }, text: { sz: 14, b: true, color: '2F5496' } },
  Heading3: { name: 'heading 3', para: { before: 10, after: 4, outline: 2 }, text: { sz: 12, b: true, color: '1F3763' } },
  Quote: { name: 'Quote', para: { before: 8, after: 8, indStart: 36, indEnd: 36, align: 'center' }, text: { i: true, color: '404040' } },
  ListParagraph: { name: 'List Paragraph', para: { indStart: 36 }, text: {} },
};

/** The paragraph and text look a style id resolves to, following `basedOn`. */
export function resolveStyle(styles: Styles, id: string | undefined): { para: ParaLookProps; text: TextLook; outline?: number } {
  const chain: StyleDef[] = [];
  const seen = new Set<string>();
  let at = id ?? styles.defaultPara;
  while (at && !seen.has(at)) {
    seen.add(at);
    const def = styles.defs.get(at);
    if (!def) break;
    chain.unshift(def);
    at = def.basedOn ?? '';
  }
  let para: ParaLookProps = { ...styles.docPara };
  let text: TextLook = { ...styles.docText };
  if (!chain.length && id && BUILTIN[id]) {
    const normal = styles.defs.get(styles.defaultPara);
    if (normal) { para = { ...para, ...normal.para }; text = { ...text, ...normal.text }; }
    para = { ...para, ...BUILTIN[id].para };
    text = { ...text, ...BUILTIN[id].text };
  }
  for (const def of chain) {
    para = { ...para, ...def.para };
    text = { ...text, ...def.text };
  }
  const nameLevel = /^heading ([1-9])$/i.exec(chain[chain.length - 1]?.name ?? '');
  const outline = para.outline ?? (nameLevel ? Number(nameLevel[1]) - 1 : undefined) ?? (id && /^Heading([1-9])$/.test(id) ? Number(id.slice(7)) - 1 : undefined);
  return { para, text, outline };
}

/** The styles a gallery offers: the file's quick styles first, then the built-in ones it lacks. */
export function galleryStyles(styles: Styles): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  const wanted = ['Normal', 'Title', 'Subtitle', 'Heading1', 'Heading2', 'Heading3', 'Quote'];
  for (const id of wanted) {
    const def = styles.defs.get(id);
    out.push({ id, name: def?.name ?? BUILTIN[id]?.name ?? id });
    seen.add(id);
  }
  for (const def of styles.defs.values()) {
    if (def.type === 'paragraph' && def.quick && !seen.has(def.id) && out.length < 16) {
      out.push({ id: def.id, name: def.name });
      seen.add(def.id);
    }
  }
  return out;
}

/* ───────────────────────────── numbering ───────────────────────────── */

export interface NumLevel { fmt: string; text: string; start: number; indStart?: number; hanging?: number }
export interface Numbering { nums: Map<string, string>; abstracts: Map<string, Map<number, NumLevel>> }

export function readNumbering(xml: string | null): Numbering {
  const out: Numbering = { nums: new Map(), abstracts: new Map() };
  if (!xml) return out;
  const doc = parsePart(xml);
  const root = doc.roots.find((r) => localName(r.name) === 'numbering');
  if (!root) return out;
  for (const node of root.children) {
    const local = localName(node.name);
    if (local === 'abstractNum') {
      const levels = new Map<number, NumLevel>();
      for (const lvl of node.children) {
        if (localName(lvl.name) !== 'lvl') continue;
        const level = Number(attrLocal(xml, lvl, 'ilvl') ?? 0);
        const ind = child(child(lvl, 'pPr'), 'ind');
        levels.set(level, {
          fmt: attrLocal(xml, child(lvl, 'numFmt') ?? lvl, 'val') ?? 'decimal',
          text: decodeXml(attrLocal(xml, child(lvl, 'lvlText') ?? lvl, 'val') ?? ''),
          start: Number(attrLocal(xml, child(lvl, 'start') ?? lvl, 'val') ?? 1) || 1,
          indStart: ind ? twip(attrLocal(xml, ind, 'start') ?? attrLocal(xml, ind, 'left')) : undefined,
          hanging: ind ? twip(attrLocal(xml, ind, 'hanging')) : undefined,
        });
      }
      out.abstracts.set(attrLocal(xml, node, 'abstractNumId') ?? '', levels);
    } else if (local === 'num') {
      const abs = child(node, 'abstractNumId');
      out.nums.set(attrLocal(xml, node, 'numId') ?? '', abs ? attrLocal(xml, abs, 'val') ?? '' : '');
    }
  }
  return out;
}

const ROMAN: Array<[number, string]> = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const ARABIC_ABJAD = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح', 'ط', 'ي'];

/** One counter value in a numbering format ("decimal" 3 → "3", "lowerRoman" 4 → "iv"). */
export function formatCounter(fmt: string, n: number): string {
  switch (fmt) {
    case 'lowerLetter': case 'upperLetter': {
      let s = '';
      let v = n;
      while (v > 0) { v--; s = String.fromCharCode(97 + (v % 26)) + s; v = Math.floor(v / 26); }
      return fmt === 'upperLetter' ? s.toUpperCase() : s;
    }
    case 'lowerRoman': case 'upperRoman': {
      let s = '';
      let v = n;
      for (const [value, sym] of ROMAN) while (v >= value) { s += sym; v -= value; }
      return fmt === 'upperRoman' ? s.toUpperCase() : s;
    }
    case 'arabicAbjad': case 'arabicAlpha': return ARABIC_ABJAD[(n - 1) % ARABIC_ABJAD.length] ?? String(n);
    case 'hindiNumbers': case 'arabicIndic': return String(n).replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
    default: return String(n);
  }
}

/** A bullet character as a web font can draw it (Symbol/Wingdings private-use → Unicode). */
export function bulletChar(text: string): string {
  const map: Record<string, string> = { '': '•', '': '▪', '': '➢', '': '✓', '': '❖', '': '◦', o: '◦', '-': '–' };
  const ch = text.trim() || '•';
  return map[ch] ?? (ch.charCodeAt(0) >= 0xf000 ? '•' : ch);
}

/* ───────────────────────────── the document ───────────────────────────── */

export interface ParaLook {
  styleId: string;
  para: ParaLookProps;
  /** The text look every run starts from (docDefaults → style chain). */
  text: TextLook;
  /** Heading level 0–8 when the paragraph is an outline heading. */
  outline?: number;
  /** The list marker Word draws, already counted ("1.", "•"). */
  marker?: string;
  /** Where the paragraph sits in a table of the file. */
  cell?: { table: number; row: number; cell: number };
  inTextBox?: boolean;
}

export interface CellLook { gridCol: number; span: number; vMerge: 'restart' | 'continue' | null; width?: number; fill?: string; vAlign?: string; borders: BorderSet }
export interface BorderSet { top?: string; bottom?: string; start?: string; end?: string; insideH?: string; insideV?: string }
export interface TableLook { grid: number[]; rtl: boolean; borders: BorderSet; rows: Array<{ height?: number; cells: CellLook[] }>; align?: ParagraphAlign }

export interface PageLook {
  /** Page size and margins in points. */
  w: number; h: number; top: number; bottom: number; left: number; right: number;
  header: number; footer: number;
  cols: number; colGap: number;
  titlePage: boolean;
}

export interface HeaderFooter { lines: Array<{ text: string; align?: ParagraphAlign; rtl: boolean; size?: number }> }

export interface CommentInfo { id: string; author: string; initials: string; date: string; text: string; block: number | null }

export interface Media { path: string; mime: string; bytes: Uint8Array }

export interface DocLook {
  page: PageLook;
  paras: ParaLook[];
  tables: TableLook[];
  styles: Styles;
  theme: Theme;
  headers: { default?: HeaderFooter; first?: HeaderFooter };
  footers: { default?: HeaderFooter; first?: HeaderFooter };
  comments: CommentInfo[];
  media: Map<string, Media>;
  numbering: Numbering;
}

export interface ReadDoc {
  blocks: DocBlock[];
  /** Paragraph-level direct formatting the editor edits (alignment, direction, style, list). */
  formats: Record<number, ParagraphFormat>;
  look: DocLook;
}

async function partText(archive: RawZip, name: string): Promise<string | null> {
  const bytes = await entryData(archive, name);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/** "media/image1.png" relative to "word" → "word/media/image1.png". */
export function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base ? base.split('/') : [];
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

export async function readRels(archive: RawZip, partName: string): Promise<Map<string, { type: string; target: string; external: boolean }>> {
  const dir = partName.includes('/') ? partName.slice(0, partName.lastIndexOf('/')) : '';
  const file = partName.slice(partName.lastIndexOf('/') + 1);
  const relsName = `${dir ? `${dir}/` : ''}_rels/${file}.rels`;
  const xml = await partText(archive, relsName);
  const out = new Map<string, { type: string; target: string; external: boolean }>();
  if (!xml) return out;
  const doc = parsePart(xml);
  for (const root of doc.roots) {
    for (const rel of elementsOf(root, 'Relationship')) {
      const id = attrLocal(xml, rel, 'Id');
      const target = attrLocal(xml, rel, 'Target');
      if (!id || !target) continue;
      const external = (attrLocal(xml, rel, 'TargetMode') ?? '') === 'External';
      out.set(id, { type: (attrLocal(xml, rel, 'Type') ?? '').split('/').pop() ?? '', target: external ? target : resolvePath(dir, target), external });
    }
  }
  return out;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

/** Elements a text run may hold and still be edited as plain text. */
const TEXT_CHILDREN = new Set(['rPr', 't', 'tab', 'br', 'cr', 'lastRenderedPageBreak', 'noBreakHyphen', 'softHyphen']);

function borderOf(xml: string, element: XmlElement | undefined): string | undefined {
  if (!element) return undefined;
  const val = (attrLocal(xml, element, 'val') ?? 'single').toLowerCase();
  if (val === 'nil' || val === 'none') return 'none';
  const size = Math.max(0.5, Number(attrLocal(xml, element, 'sz') ?? 4) / 8);
  const color = attrLocal(xml, element, 'color');
  const hex = color && /^[0-9a-fA-F]{6}$/.test(color) ? `#${color}` : 'currentColor';
  const style = val === 'double' ? 'double' : val === 'dashed' ? 'dashed' : val === 'dotted' ? 'dotted' : 'solid';
  return `${Math.max(0.75, val === 'double' ? size * 3 : size)}pt ${style} ${hex}`;
}

function bordersOf(xml: string, element: XmlElement | undefined): BorderSet {
  const out: BorderSet = {};
  if (!element) return out;
  const set = (key: keyof BorderSet, ...names: string[]): void => {
    for (const name of names) {
      const value = borderOf(xml, child(element, name));
      if (value) { out[key] = value; return; }
    }
  };
  set('top', 'top');
  set('bottom', 'bottom');
  set('start', 'start', 'left');
  set('end', 'end', 'right');
  set('insideH', 'insideH');
  set('insideV', 'insideV');
  return out;
}

function imageOf(xml: string, element: XmlElement): ImageInfo | null {
  const blip = elementsOf(element, 'blip')[0];
  const rid = blip ? attrLocal(xml, blip, 'embed') : null;
  if (!rid) return null;
  const anchor = elementsOf(element, 'anchor')[0];
  const extent = elementsOf(element, 'extent')[0];
  const cx = Number(extent ? attrLocal(xml, extent, 'cx') : 0);
  const cy = Number(extent ? attrLocal(xml, extent, 'cy') : 0);
  const docPr = elementsOf(element, 'docPr')[0];
  const info: ImageInfo = { rid, w: cx / 12700 || 100, h: cy / 12700 || 100 };
  const alt = docPr ? attrLocal(xml, docPr, 'descr') ?? attrLocal(xml, docPr, 'title') : null;
  if (alt) info.alt = decodeXml(alt);
  if (anchor) {
    const square = elementsOf(anchor, 'wrapSquare')[0] ?? elementsOf(anchor, 'wrapTight')[0] ?? elementsOf(anchor, 'wrapThrough')[0];
    if (!square) info.float = 'none';
    else {
      const h = elementsOf(anchor, 'positionH')[0];
      const align = h ? elementsOf(h, 'align')[0] : undefined;
      const value = align ? elementText(xml, align).trim() : '';
      info.float = value === 'right' || value === 'outside' ? 'end' : 'start';
    }
  }
  return info;
}

/** One paragraph child → a run of the model. */
function runOf(xml: string, element: XmlElement, index: number, theme: Theme, styles: Styles): Run {
  const local = localName(element.name);
  const raw = xml.slice(element.start, element.end);
  if (local === 'r') {
    const plain = element.children.every((c) => TEXT_CHILDREN.has(localName(c.name)) && !(localName(c.name) === 'br' && /type\s*=\s*["'](page|column)/.test(xml.slice(c.start, c.openEnd))));
    if (plain) {
      const rPr = child(element, 'rPr');
      const text = slotsText(xml, element);
      const props = readRunProps(xml, rPr, theme);
      const run: TextRun = { t: 'text', text, props, base: { ...props }, rpr: rPr ? xml.slice(rPr.start, rPr.end) : '', src: index };
      const rStyle = child(rPr, 'rStyle');
      if (rStyle) {
        const def = styles.defs.get(attrLocal(xml, rStyle, 'val') ?? '');
        if (def) {
          const t = def.text;
          const styled: RunProps = {};
          if (t.b !== undefined) styled.b = t.b;
          if (t.i !== undefined) styled.i = t.i;
          if (t.u !== undefined) styled.u = t.u;
          if (t.color) styled.color = t.color;
          if (t.sz) styled.sz = t.sz;
          if (t.font) styled.font = t.font;
          run.styled = styled;
        }
      }
      return run;
    }
    const text = slotsText(xml, element);
    if (elementsOf(element, 'drawing').length || elementsOf(element, 'pict').length) {
      const image = imageOf(xml, element);
      return { t: 'opaque', text, xml: raw, kind: image ? 'image' : 'object', ...(image ? { image } : {}), src: index };
    }
    const br = child(element, 'br');
    if (br && /type\s*=\s*["']page/.test(xml.slice(br.start, br.openEnd))) return { t: 'opaque', text, xml: raw, kind: 'page', src: index };
    if (br) return { t: 'opaque', text, xml: raw, kind: 'break', src: index };
    if (child(element, 'fldChar') || child(element, 'instrText')) return { t: 'opaque', text, xml: raw, kind: 'field', src: index };
    if (child(element, 'footnoteReference') || child(element, 'endnoteReference') || child(element, 'commentReference')) {
      return { t: 'opaque', text, xml: raw, kind: 'note', src: index };
    }
    return { t: 'opaque', text, xml: raw, kind: 'object', src: index };
  }
  const text = slotsText(xml, element);
  if (local === 'hyperlink') return { t: 'opaque', text, xml: raw, kind: 'link', src: index };
  if (local === 'fldSimple') return { t: 'opaque', text, xml: raw, kind: 'field', src: index };
  if (!text && (local.endsWith('Start') || local.endsWith('End') || local === 'proofErr')) return { t: 'opaque', text, xml: raw, kind: 'mark', src: index };
  return { t: 'opaque', text, xml: raw, kind: text ? 'object' : 'mark', src: index };
}

function headerFooterOf(xml: string | null, theme: Theme, styles: Styles): HeaderFooter | undefined {
  if (!xml) return undefined;
  const doc = parsePart(xml);
  const lines: HeaderFooter['lines'] = [];
  for (const p of paragraphElements(doc)) {
    // Page-number fields become markers the view replaces per page.
    let text = '';
    let fieldDepth = 0;
    let fieldIsPage: string | null = null;
    const walk = (element: XmlElement): void => {
      for (const c of element.children) {
        const local = localName(c.name);
        if (local === 'p' || local === 'Fallback') continue;
        if (local === 'fldSimple') {
          const instr = (attrLocal(xml, c, 'instr') ?? '').trim().toUpperCase();
          if (instr.startsWith('PAGE')) text += '\u0001';
          else if (instr.startsWith('NUMPAGES')) text += '\u0002';
          else walk(c);
          continue;
        }
        if (local === 'fldChar') {
          const type = attrLocal(xml, c, 'fldCharType');
          if (type === 'begin') { fieldDepth++; fieldIsPage = null; }
          else if (type === 'separate' && fieldIsPage) { text += fieldIsPage === 'PAGE' ? '\u0001' : '\u0002'; }
          else if (type === 'end') { fieldDepth = Math.max(0, fieldDepth - 1); fieldIsPage = null; }
          continue;
        }
        if (local === 'instrText') {
          const instr = decodeXml(elementText(xml, c)).trim().toUpperCase();
          if (instr.startsWith('PAGE')) fieldIsPage = 'PAGE';
          else if (instr.startsWith('NUMPAGES')) fieldIsPage = 'NUMPAGES';
          continue;
        }
        if (local === 't') { if (!(fieldDepth > 0 && fieldIsPage)) text += decodeXml(elementText(xml, c)); continue; }
        if (local === 'tab') { text += '\t'; continue; }
        walk(c);
      }
    };
    walk(p);
    if (!text.trim()) continue;
    const pPr = child(p, 'pPr');
    const props = readParaProps(xml, pPr, theme);
    const style = resolveStyle(styles, attrLocal(xml, child(pPr, 'pStyle') ?? p, 'val') ?? undefined);
    const firstR = elementsOf(p, 'r').find((r) => child(r, 'rPr'));
    const rp = readTextLook(xml, child(firstR, 'rPr'), theme);
    const inBox = !!p.parent && elementsOf(doc.roots[0], 'txbxContent').some((box) => box.start < p.start && box.end > p.end);
    lines.push({ text, align: props.align ?? style.para.align ?? (inBox ? 'center' : undefined), rtl: props.bidi ?? style.para.bidi ?? false, size: rp.sz ?? style.text.sz });
  }
  return lines.length ? { lines } : undefined;
}

/** Reads a whole .docx for the Writer. Throws on a package that is not a Word document. */
export async function readDocxDocument(bytes: Uint8Array): Promise<ReadDoc> {
  const archive = readRawZip(bytes);
  const xml = await partText(archive, 'word/document.xml');
  if (!xml) throw new Error('docx: no word/document.xml');
  const rels = await readRels(archive, 'word/document.xml');
  const relOf = (type: string): string | undefined => [...rels.values()].find((r) => r.type === type)?.target;
  const theme = readTheme(await partText(archive, relOf('theme') ?? 'word/theme/theme1.xml'));
  const styles = readStyles(await partText(archive, relOf('styles') ?? 'word/styles.xml'), theme);
  const numbering = readNumbering(await partText(archive, relOf('numbering') ?? 'word/numbering.xml'));

  const doc = parsePart(xml);
  const body = doc.roots.flatMap((r) => (localName(r.name) === 'body' ? [r] : elementsOf(r, 'body')))[0];
  const paragraphs = paragraphElements(doc);

  /* tables: the outermost ones, in document order */
  const tableIndex = new Map<XmlElement, number>();
  const tables: TableLook[] = [];
  const topTables = body ? body.children.filter((c) => localName(c.name) === 'tbl') : [];
  const tableStyleBorders = (tblPr: XmlElement | undefined): BorderSet => {
    const styleId = attrLocal(xml, child(tblPr, 'tblStyle') ?? (tblPr as XmlElement), 'val');
    return styleId && child(tblPr, 'tblStyle') ? tableStyleCache.get(styleId) ?? {} : {};
  };
  const tableStyleCache = new Map<string, BorderSet>();
  const stylesXml = await partText(archive, relOf('styles') ?? 'word/styles.xml');
  if (stylesXml) {
    const sdoc = parsePart(stylesXml);
    for (const root of sdoc.roots) {
      for (const style of elementsOf(root, 'style')) {
        if (attrLocal(stylesXml, style, 'type') !== 'table') continue;
        const tblBorders = child(child(style, 'tblPr'), 'tblBorders');
        if (tblBorders) tableStyleCache.set(attrLocal(stylesXml, style, 'styleId') ?? '', bordersOf(stylesXml, tblBorders));
      }
    }
  }
  for (const tbl of topTables) {
    tableIndex.set(tbl, tables.length);
    const tblPr = child(tbl, 'tblPr');
    const grid = (child(tbl, 'tblGrid')?.children ?? []).filter((c) => localName(c.name) === 'gridCol').map((c) => twip(attrLocal(xml, c, 'w')) ?? 72);
    const look: TableLook = {
      grid,
      rtl: toggleOf(xml, child(tblPr, 'bidiVisual')) === true,
      borders: { ...tableStyleBorders(tblPr), ...bordersOf(xml, child(tblPr, 'tblBorders')) },
      rows: [],
      align: alignOf(child(tblPr, 'jc') ? attrLocal(xml, child(tblPr, 'jc') as XmlElement, 'val') : null),
    };
    for (const tr of tbl.children.filter((c) => localName(c.name) === 'tr')) {
      const trH = child(child(tr, 'trPr'), 'trHeight');
      const row: TableLook['rows'][number] = { height: trH ? twip(attrLocal(xml, trH, 'val')) : undefined, cells: [] };
      let gridCol = 0;
      for (const tc of tr.children.filter((c) => localName(c.name) === 'tc')) {
        const tcPr = child(tc, 'tcPr');
        const span = Number(attrLocal(xml, child(tcPr, 'gridSpan') ?? (tcPr as XmlElement), 'val') ?? 1) || 1;
        const vm = child(tcPr, 'vMerge');
        const shd = child(tcPr, 'shd');
        const fill = shd ? attrLocal(xml, shd, 'fill') : null;
        const tcW = child(tcPr, 'tcW');
        row.cells.push({
          gridCol,
          span: child(tcPr, 'gridSpan') ? span : 1,
          vMerge: vm ? ((attrLocal(xml, vm, 'val') ?? 'continue') === 'restart' ? 'restart' : 'continue') : null,
          width: tcW && (attrLocal(xml, tcW, 'type') ?? 'dxa') === 'dxa' ? twip(attrLocal(xml, tcW, 'w')) : undefined,
          fill: fill && /^[0-9a-fA-F]{6}$/.test(fill) ? fill.toUpperCase() : undefined,
          vAlign: child(tcPr, 'vAlign') ? attrLocal(xml, child(tcPr, 'vAlign') as XmlElement, 'val') ?? undefined : undefined,
          borders: bordersOf(xml, child(tcPr, 'tcBorders')),
        });
        gridCol += child(tcPr, 'gridSpan') ? span : 1;
      }
      look.rows.push(row);
    }
    if (!look.grid.length) look.grid = new Array(Math.max(1, ...look.rows.map((r) => r.cells.reduce((n, c) => n + c.span, 0)))).fill(72);
    tables.push(look);
  }

  /* comments */
  const comments: CommentInfo[] = [];
  const commentsXml = await partText(archive, relOf('comments') ?? 'word/comments.xml');
  if (commentsXml) {
    const cdoc = parsePart(commentsXml);
    for (const root of cdoc.roots) {
      for (const c of elementsOf(root, 'comment').concat(localName(root.name) === 'comment' ? [root] : [])) {
        comments.push({
          id: attrLocal(commentsXml, c, 'id') ?? '',
          author: decodeXml(attrLocal(commentsXml, c, 'author') ?? ''),
          initials: decodeXml(attrLocal(commentsXml, c, 'initials') ?? ''),
          date: attrLocal(commentsXml, c, 'date') ?? '',
          text: paragraphElements({ xml: commentsXml, roots: [c] }).map((p) => slotsText(commentsXml, p)).join('\n'),
          block: null,
        });
      }
    }
  }

  /* paragraphs */
  const blocks: DocBlock[] = [];
  const paras: ParaLook[] = [];
  const formats: Record<number, ParagraphFormat> = {};
  const counters = new Map<string, number[]>();
  paragraphs.forEach((p, index) => {
    const pPr = child(p, 'pPr');
    const direct = readParaProps(xml, pPr, theme);
    const styleId = attrLocal(xml, child(pPr, 'pStyle') ?? p, 'val') ?? '';
    const style = resolveStyle(styles, child(pPr, 'pStyle') ? styleId : undefined);
    const para: ParaLookProps = { ...style.para, ...direct };
    const look: ParaLook = { styleId: child(pPr, 'pStyle') ? styleId : styles.defaultPara, para, text: style.text };
    const outline = direct.outline ?? style.outline;
    if (outline !== undefined && outline < 9) look.outline = outline;

    // Ancestors: table cell, text box.
    let tc: XmlElement | null = null;
    let top: XmlElement | null = null;
    let inBox = false;
    for (let a = p.parent; a; a = a.parent) {
      const local = localName(a.name);
      if (local === 'txbxContent') inBox = true;
      if (local === 'tbl' && tableIndex.has(a)) top = a;
      if (local === 'tc' && a.parent?.parent && tableIndex.has(a.parent.parent)) tc = a;
    }
    if (inBox) look.inTextBox = true;
    if (top && tc && !inBox) {
      const tr = tc.parent as XmlElement;
      const rowIndex = top.children.filter((c) => localName(c.name) === 'tr').indexOf(tr);
      const cellIndex = tr.children.filter((c) => localName(c.name) === 'tc').indexOf(tc);
      look.cell = { table: tableIndex.get(top) ?? 0, row: rowIndex, cell: cellIndex };
    }

    // List marker, counted in reading order per list.
    if (para.numId && para.numId !== '0') {
      const abs = numbering.abstracts.get(numbering.nums.get(para.numId) ?? '');
      const lvl = para.ilvl ?? 0;
      const level = abs?.get(lvl);
      if (level) {
        const counts = counters.get(para.numId) ?? [];
        for (let l = 0; l < lvl; l++) if (counts[l] === undefined) counts[l] = (abs?.get(l)?.start ?? 1);
        counts[lvl] = (counts[lvl] ?? (level.start - 1)) + 1;
        counts.length = lvl + 1;
        counters.set(para.numId, counts);
        look.marker = level.fmt === 'bullet'
          ? bulletChar(level.text)
          : level.text.replace(/%([1-9])/g, (_, d: string) => formatCounter(abs?.get(Number(d) - 1)?.fmt ?? 'decimal', counts[Number(d) - 1] ?? 1));
        if (para.indStart === undefined && level.indStart !== undefined) para.indStart = level.indStart;
        if (para.firstLine === undefined && level.hanging !== undefined) para.firstLine = -level.hanging;
      }
    }

    const runs: Run[] = [];
    const nested = elementsOf(p, 'p').length > 0;
    p.children.forEach((c, i) => {
      if (localName(c.name) === 'pPr') return;
      runs.push(runOf(xml, c, i, theme, styles));
    });
    if (!runs.some((r) => r.t === 'text')) {
      // An empty paragraph still needs somewhere to type: its paragraph-mark formatting.
      const markRPr = child(pPr, 'rPr');
      const props = readRunProps(xml, markRPr, theme);
      runs.push({ t: 'text', text: '', props, base: { ...props }, rpr: markRPr ? xml.slice(markRPr.start, markRPr.end) : '' });
    }
    const block: DocBlock = { id: index, runs };
    if (nested) block.locked = true;
    blocks.push(block);
    paras.push(look);

    const format: ParagraphFormat = {};
    if (direct.align) format.align = direct.align;
    if (direct.bidi !== undefined) format.dir = direct.bidi ? 'rtl' : 'ltr';
    if (child(pPr, 'pStyle')) format.style = styleId;
    if (direct.numId !== undefined) {
      const abs = numbering.abstracts.get(numbering.nums.get(direct.numId) ?? '');
      if (direct.numId === '0') format.list = null;
      else if (abs) format.list = abs.get(direct.ilvl ?? 0)?.fmt === 'bullet' ? 'bullet' : 'number';
    }
    if (direct.line !== undefined && !direct.lineExact) format.line = Math.round(direct.line * 100) / 100;
    if (Object.keys(format).length) formats[index] = format;

    for (const marker of elementsOf(p, 'commentRangeStart')) {
      const id = attrLocal(xml, marker, 'id');
      const found = comments.find((c) => c.id === id);
      if (found && found.block === null) found.block = index;
    }
  });

  /* page */
  const sectPr = body ? child(body, 'sectPr') : undefined;
  const pgSz = child(sectPr, 'pgSz');
  const pgMar = child(sectPr, 'pgMar');
  const cols = child(sectPr, 'cols');
  const pt = (element: XmlElement | undefined, name: string, fallback: number): number => {
    const v = element ? twip(attrLocal(xml, element, name)) : undefined;
    return v !== undefined && Number.isFinite(v) ? Math.abs(v) : fallback;
  };
  const page: PageLook = {
    w: pt(pgSz, 'w', 595.3), h: pt(pgSz, 'h', 841.9),
    top: pt(pgMar, 'top', 72), bottom: pt(pgMar, 'bottom', 72), left: pt(pgMar, 'left', 72), right: pt(pgMar, 'right', 72),
    header: pt(pgMar, 'header', 36), footer: pt(pgMar, 'footer', 36),
    cols: Math.max(1, Math.min(4, Number(cols ? attrLocal(xml, cols, 'num') ?? 1 : 1) || 1)),
    colGap: pt(cols, 'space', 36),
    titlePage: toggleOf(xml, child(sectPr, 'titlePg')) === true,
  };
  if (pgSz && (attrLocal(xml, pgSz, 'orient') ?? '') === 'landscape' && page.w < page.h) [page.w, page.h] = [page.h, page.w];

  /* headers and footers */
  const headers: DocLook['headers'] = {};
  const footers: DocLook['footers'] = {};
  for (const ref of sectPr?.children ?? []) {
    const local = localName(ref.name);
    if (local !== 'headerReference' && local !== 'footerReference') continue;
    const type = attrLocal(xml, ref, 'type') ?? 'default';
    if (type !== 'default' && type !== 'first') continue;
    const target = rels.get(attrLocal(xml, ref, 'id') ?? '')?.target;
    if (!target) continue;
    const hf = headerFooterOf(await partText(archive, target), theme, styles);
    if (hf) (local === 'headerReference' ? headers : footers)[type as 'default' | 'first'] = hf;
  }

  /* pictures */
  const media = new Map<string, Media>();
  for (const [id, rel] of rels) {
    if (rel.type !== 'image' || rel.external) continue;
    const data = await entryData(archive, rel.target);
    const ext = (rel.target.split('.').pop() ?? '').toLowerCase();
    if (data && MIME[ext]) media.set(id, { path: rel.target, mime: MIME[ext], bytes: data });
  }

  return { blocks, formats, look: { page, paras, tables, styles, theme, headers, footers, comments, media, numbering } };
}

/** The plain paragraph texts of a read document (what `readDocx` returns). */
export function plainTexts(blocks: readonly DocBlock[]): string[] {
  return blocks.map(blockText);
}

/** The opaque runs of a block, for callers that list pictures or links. */
export function opaqueRuns(block: DocBlock): OpaqueRun[] {
  return block.runs.filter((r): r is OpaqueRun => r.t === 'opaque');
}
