/**
 * Sheet — writing the owner's formatting into an .xlsx (كتابة التنسيق).
 *
 *  • `addCellStyles(stylesXml, requests)` appends the fonts, fills, borders,
 *    number formats and `cellXfs` entries a set of formatted cells needs. Every
 *    new entry is built from the cell's *own* style (its current `s`) with the
 *    owner's delta applied, so a theme colour, a font family or a protection flag
 *    the app never modelled is kept. Existing entries are never changed or
 *    renumbered; an entry identical to one already there is reused.
 *  • `applySheetLook(sheetXml, look)` gives cells their new `s`, rows their `ht`,
 *    and rewrites `<cols>` (other columns' entries kept, split where needed).
 *
 * Both are pure string → string, so the surgical save and the rebuild path share
 * them, and tests read the XML directly.
 */
import { BUILTIN_FORMATS } from '../calc/index';
import { columnIndex } from '../../viewer/formats';
import { cellName, xmlText } from '../xml';
import { applyEdits, attr, elements, localName, parsePart, type XmlEdit, type XmlElement } from '../xmlscan';
import { pxToChars, pxToPt, type CellFormat } from './sheetfmt';
import { parseDxfs } from './condfmt-xml';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** The smallest styles part Excel accepts: one font, the two reserved fills, one border, one xf. */
export const MINIMAL_STYLES = `${DECL}<styleSheet xmlns="${S_NS}">` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** The order `CT_Stylesheet` requires its children in. */
const SHEET_ORDER = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst'];
/** The order Excel writes a font's children in (the schema accepts any, Excel's own readers like this one). */
const FONT_ORDER = ['b', 'i', 'strike', 'condense', 'extend', 'outline', 'shadow', 'u', 'vertAlign', 'sz', 'color', 'name', 'family', 'charset', 'scheme'];
const BORDER_ORDER = ['start', 'left', 'end', 'right', 'top', 'bottom', 'diagonal', 'vertical', 'horizontal'];

export interface StyleRequest {
  /** The cell's current `s` (0 when it has none). */
  base: number;
  format: CellFormat;
}

/** Sets (string) or removes (null) attributes on an opening tag, keeping the rest as written. */
export function setAttrs(openTag: string, values: Record<string, string | null>): string {
  const selfClosing = /\/\s*>$/.test(openTag);
  let body = openTag.replace(/\s*\/?\s*>$/, '');
  for (const [name, value] of Object.entries(values)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\s${escaped}\\s*=\\s*(?:"[^"]*"|'[^']*')`);
    if (value === null) body = body.replace(re, '');
    else if (re.test(body)) body = body.replace(re, ` ${name}="${xmlText(value)}"`);
    else body += ` ${name}="${xmlText(value)}"`;
  }
  return `${body}${selfClosing ? '/>' : '>'}`;
}

interface Section { el: XmlElement | null; items: string[]; added: string[] }

function markupOf(xml: string, el: XmlElement): string {
  return xml.slice(el.start, el.end);
}

/** Children of an element as markup, keyed by local name (first wins). */
function childMap(xml: string, el: XmlElement | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of el?.children ?? []) if (!out.has(localName(c.name))) out.set(localName(c.name), markupOf(xml, c));
  return out;
}

function ordered(children: Map<string, string>, order: readonly string[]): string {
  const known = order.filter((n) => children.has(n)).map((n) => children.get(n) as string);
  const rest = [...children.entries()].filter(([n]) => !order.includes(n)).map(([, m]) => m);
  return [...known, ...rest].join('');
}

/** The element with its children replaced (the opening tag kept). */
function withChildren(openTag: string, name: string, inner: string): string {
  const open = openTag.replace(/\s*\/\s*>$/, '>');
  return inner ? `${open}${inner}</${name}>` : `${open.replace(/>$/, '/>')}`;
}

function argb(hex: string): string {
  return `FF${hex.replace(/^#/, '').toUpperCase()}`;
}

function builtinId(code: string): number | null {
  for (const [id, pattern] of Object.entries(BUILTIN_FORMATS)) if (pattern === code) return Number(id);
  return null;
}

/**
 * Appends the style entries `requests` need and returns, for each request, the
 * `cellXfs` index to write into the cell's `s`.
 */
export function addCellStyles(stylesXml: string | null, requests: readonly StyleRequest[]): { xml: string; ids: number[] } {
  const xml = stylesXml && /<(?:\w+:)?styleSheet[\s>]/.test(stylesXml) ? stylesXml : MINIMAL_STYLES;
  const doc = parsePart(xml);
  const root = doc.roots.find((r) => localName(r.name) === 'styleSheet');
  if (!root) throw new Error('xlsx: styles.xml has no <styleSheet>');
  if (root.selfClosing) {
    // `<styleSheet/>`: open it, so every new section has somewhere to go.
    const open = xml.slice(root.start, root.end).replace(/\s*\/>$/, '>');
    return addCellStyles(`${xml.slice(0, root.start)}${open}</${root.name}>${xml.slice(root.end)}`, requests);
  }
  const prefix = root.name.includes(':') ? `${root.name.slice(0, root.name.indexOf(':'))}:` : '';
  const find = (name: string): XmlElement | null => root.children.find((c) => localName(c.name) === name) ?? null;
  const section = (name: string, childName: string): Section => {
    const el = find(name);
    return { el, items: (el?.children ?? []).filter((c) => localName(c.name) === childName).map((c) => markupOf(xml, c)), added: [] };
  };
  const numFmts = section('numFmts', 'numFmt');
  const fonts = section('fonts', 'font');
  const fills = section('fills', 'fill');
  const borders = section('borders', 'border');
  const xfs = section('cellXfs', 'xf');
  if (!fonts.items.length) fonts.added.push(`<${prefix}font><${prefix}sz val="11"/><${prefix}name val="Calibri"/></${prefix}font>`);
  if (!fills.items.length) fills.added.push(`<${prefix}fill><${prefix}patternFill patternType="none"/></${prefix}fill>`, `<${prefix}fill><${prefix}patternFill patternType="gray125"/></${prefix}fill>`);
  if (!borders.items.length) borders.added.push(`<${prefix}border><${prefix}left/><${prefix}right/><${prefix}top/><${prefix}bottom/><${prefix}diagonal/></${prefix}border>`);
  if (!xfs.items.length) xfs.added.push(`<${prefix}xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`);

  const all = (s: Section): string[] => [...s.items, ...s.added];
  const intern = (s: Section, markup: string): number => {
    const at = all(s).indexOf(markup);
    if (at >= 0) return at;
    s.added.push(markup);
    return s.items.length + s.added.length - 1;
  };
  const one = (markup: string): { xml: string; el: XmlElement } => {
    const d = parsePart(markup);
    return { xml: markup, el: d.roots[0] };
  };
  const numFmtCode = new Map<string, number>();
  let nextNumFmt = 164;
  for (const m of numFmts.items) {
    const { xml: mx, el } = one(m);
    const id = Number(attr(mx, el, 'numFmtId'));
    if (Number.isFinite(id)) { numFmtCode.set(attr(mx, el, 'formatCode') ?? '', id); nextNumFmt = Math.max(nextNumFmt, id + 1); }
  }

  const ids = requests.map(({ base, format }) => {
    const xfList = all(xfs);
    const baseXf = one(xfList[base] ?? xfList[0]);
    const xfAttr = (name: string): number => Number(attr(baseXf.xml, baseXf.el, name) ?? 0) || 0;
    const openXf = baseXf.xml.slice(0, baseXf.el.openEnd - baseXf.el.start);
    const set: Record<string, string | null> = {};

    if (format.bold !== undefined || format.italic !== undefined || format.underline !== undefined || format.strike !== undefined
      || format.color !== undefined || format.font || format.size) {
      const src = one(all(fonts)[xfAttr('fontId')] ?? all(fonts)[0]);
      const kids = childMap(src.xml, src.el);
      const toggle = (name: string, on: boolean | undefined): void => {
        if (on === undefined) return;
        if (on) kids.set(name, `<${prefix}${name}/>`);
        else kids.delete(name);
      };
      toggle('b', format.bold);
      toggle('i', format.italic);
      toggle('u', format.underline);
      toggle('strike', format.strike);
      // A family or size of null means "the file's own": nothing to write.
      if (format.size && Number.isFinite(format.size)) kids.set('sz', `<${prefix}sz val="${Math.round(format.size * 2) / 2}"/>`);
      if (format.font) {
        kids.set('name', `<${prefix}name val="${format.font.replace(/[<>&"]/g, '')}"/>`);
        // The theme's scheme would override a family chosen by hand.
        kids.delete('scheme');
        kids.delete('family');
      }
      if (format.color !== undefined) {
        if (format.color) kids.set('color', `<${prefix}color rgb="${argb(format.color)}"/>`);
        else kids.delete('color');
      }
      const open = src.xml.slice(0, src.el.openEnd - src.el.start);
      set.fontId = String(intern(fonts, withChildren(open, `${prefix}font`, ordered(kids, FONT_ORDER))));
      set.applyFont = '1';
    }
    if (format.fill !== undefined) {
      set.fillId = format.fill
        ? String(intern(fills, `<${prefix}fill><${prefix}patternFill patternType="solid"><${prefix}fgColor rgb="${argb(format.fill)}"/><${prefix}bgColor indexed="64"/></${prefix}patternFill></${prefix}fill>`))
        : '0';
      set.applyFill = '1';
    }
    if (format.borders && Object.keys(format.borders).length) {
      const src = one(all(borders)[xfAttr('borderId')] ?? all(borders)[0]);
      const kids = childMap(src.xml, src.el);
      for (const side of ['left', 'right', 'top', 'bottom'] as const) {
        const on = format.borders[side];
        if (on === undefined) continue;
        // A file that wrote the logical names (start/end) keeps its other sides; the physical one wins here.
        if (side === 'left') kids.delete('start');
        if (side === 'right') kids.delete('end');
        kids.set(side, on ? `<${prefix}${side} style="thin"><${prefix}color rgb="FF000000"/></${prefix}${side}>` : `<${prefix}${side}/>`);
      }
      for (const side of ['left', 'right', 'top', 'bottom', 'diagonal']) if (!kids.has(side) && !(side === 'left' && kids.has('start')) && !(side === 'right' && kids.has('end'))) kids.set(side, `<${prefix}${side}/>`);
      const open = src.xml.slice(0, src.el.openEnd - src.el.start);
      set.borderId = String(intern(borders, withChildren(open, `${prefix}border`, ordered(kids, BORDER_ORDER))));
      set.applyBorder = '1';
    }
    if (format.numFmt !== undefined) {
      const code = format.numFmt ?? 'General';
      let id = builtinId(code);
      if (id === null) {
        id = numFmtCode.get(code) ?? null;
        if (id === null) {
          id = nextNumFmt++;
          numFmtCode.set(code, id);
          numFmts.added.push(`<${prefix}numFmt numFmtId="${id}" formatCode="${xmlText(code)}"/>`);
        }
      }
      set.numFmtId = String(id);
      set.applyNumberFormat = '1';
    }
    let inner = '';
    const xfKids = childMap(baseXf.xml, baseXf.el);
    if (format.hAlign !== undefined || format.vAlign !== undefined || format.wrap !== undefined) {
      const current = xfKids.get('alignment') ?? `<${prefix}alignment/>`;
      const a = one(current);
      let tag = a.xml.slice(0, a.el.openEnd - a.el.start);
      if (format.hAlign !== undefined) tag = setAttrs(tag, { horizontal: format.hAlign });
      if (format.vAlign !== undefined) tag = setAttrs(tag, { vertical: format.vAlign });
      if (format.wrap !== undefined) tag = setAttrs(tag, { wrapText: format.wrap ? '1' : null });
      const alignment = a.el.selfClosing ? tag : `${tag}${a.xml.slice(a.el.openEnd - a.el.start)}`;
      if (/^<(?:\w+:)?alignment\s*\/>$/.test(alignment)) xfKids.delete('alignment');
      else xfKids.set('alignment', alignment);
      set.applyAlignment = '1';
    }
    inner = ordered(xfKids, ['alignment', 'protection', 'extLst']);
    if (set.fontId === undefined && !/\sfontId=/.test(openXf)) set.fontId = '0';
    if (set.fillId === undefined && !/\sfillId=/.test(openXf)) set.fillId = '0';
    if (set.borderId === undefined && !/\sborderId=/.test(openXf)) set.borderId = '0';
    if (set.numFmtId === undefined && !/\snumFmtId=/.test(openXf)) set.numFmtId = '0';
    const tag = setAttrs(openXf, set);
    return intern(xfs, withChildren(tag, `${prefix}xf`, inner));
  });

  // Write the sections back: new entries appended, counts updated, missing sections created in schema order.
  const edits: XmlEdit[] = [];
  const write = (name: string, s: Section): void => {
    if (!s.added.length) return;
    const count = s.items.length + s.added.length;
    if (s.el) {
      const open = setAttrs(xml.slice(s.el.start, s.el.openEnd), { count: String(count) });
      if (s.el.selfClosing) {
        edits.push({ start: s.el.start, end: s.el.end, xml: `${open.replace(/\/>$/, '>')}${s.added.join('')}</${s.el.name}>` });
      } else {
        const close = xml.lastIndexOf('<', s.el.end - 1);
        edits.push({ start: s.el.start, end: s.el.openEnd, xml: open });
        edits.push({ start: close, end: close, xml: s.added.join('') });
      }
      return;
    }
    const markup = `<${prefix}${name} count="${count}">${s.added.join('')}</${prefix}${name}>`;
    const later = root.children.find((c) => SHEET_ORDER.indexOf(localName(c.name)) > SHEET_ORDER.indexOf(name));
    const at = later ? later.start : xml.lastIndexOf('<', root.end - 1);
    if (at < 0) throw new Error('xlsx: styles.xml cannot be appended to');
    edits.push({ start: at, end: at, xml: markup });
  };
  write('numFmts', numFmts);
  write('fonts', fonts);
  write('fills', fills);
  write('borders', borders);
  write('cellXfs', xfs);
  return { xml: applyEdits(xml, edits), ids };
}

/**
 * Adds the conditional-formatting styles (`<dxf>` entries) a sheet's rules point at by index, and
 * answers the index of each one. The section is created in the schema's place when the file has
 * none, and an identical dxf already in the file is reused rather than written twice — Excel
 * compares them by content anyway, and a smaller file is a smaller file.
 */
export function addDxfs(stylesXml: string | null, bodies: readonly string[]): { xml: string; ids: number[] } {
  const xml = stylesXml && /<(?:\w+:)?styleSheet[\s>]/.test(stylesXml) ? stylesXml : MINIMAL_STYLES;
  const existing = parseDxfs(xml);
  const ids: number[] = [];
  for (const body of bodies) {
    const at = existing.indexOf(body);
    if (at >= 0) ids.push(at);
    else {
      existing.push(body);
      ids.push(existing.length - 1);
    }
  }
  const markup = `<dxfs count="${existing.length}">${existing.join('')}</dxfs>`;
  const open = /<dxfs\b[^>]*>[\s\S]*?<\/dxfs>/.exec(xml) ?? /<dxfs\b[^>]*\/>/.exec(xml);
  if (open) return { xml: xml.slice(0, open.index) + markup + xml.slice(open.index + open[0].length), ids };
  // No section yet: it goes after <cellStyles> and before <tableStyles> (the schema's order).
  const suffix = rootOpen(xml);
  const after = ['cellStyles', 'cellStyleXfs', 'cellXfs', 'borders', 'fills', 'fonts', 'numFmts']
    .map((name) => new RegExp(`</(?:\\w+:)?${name}>|<(?:\\w+:)?${name}\\b[^>]*/>`).exec(xml))
    .filter((m): m is RegExpExecArray => m !== null)
    .reduce((best: RegExpExecArray | null, m) => (best === null || m.index > best.index ? m : best), null);
  const at = after ? after.index + after[0].length : suffix;
  return { xml: `${xml.slice(0, at)}${markup}${xml.slice(at)}`, ids };
}

/** Where a part's content starts, for a section that has to be appended before the closing tag. */
function rootOpen(xml: string): number {
  const close = xml.lastIndexOf('</');
  return close < 0 ? xml.length : close;
}

/* ─────────────────────────────── worksheet ─────────────────────────────── */
export interface SheetLookEdits {
  /** "row:col" → cellXfs index. */
  cells?: ReadonlyMap<string, number>;
  /** Row → px (null: back to the default height). */
  rows?: ReadonlyMap<number, number | null>;
  /** Column → px (null: back to the default width). */
  cols?: ReadonlyMap<number, number | null>;
  /** The sheet's whole list of merged ranges; undefined leaves the file's `<mergeCells>` alone. */
  merges?: ReadonlyArray<{ r0: number; c0: number; r1: number; c1: number }>;
}

/** What follows `<mergeCells>` in a worksheet (CT_Worksheet order): a new one goes before these. */
const AFTER_MERGES = ['phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup',
  'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing',
  'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

/** The `<mergeCells>` element for a list of ranges ('' for none). */
export function mergeCellsXml(merges: ReadonlyArray<{ r0: number; c0: number; r1: number; c1: number }>, prefix = ''): string {
  const real = merges.filter((m) => m.r1 > m.r0 || m.c1 > m.c0);
  if (!real.length) return '';
  const refs = real.map((m) => `<${prefix}mergeCell ref="${cellName(m.r0, m.c0)}:${cellName(m.r1, m.c1)}"/>`).join('');
  return `<${prefix}mergeCells count="${real.length}">${refs}</${prefix}mergeCells>`;
}

/** The `s` of every cell the part has, by "row:col" (the reader's addressing). */
export function cellStyleIds(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  const doc = parsePart(xml);
  let count = 0;
  for (const row of elements(doc, 'row')) {
    const rAttr = Number(attr(xml, row, 'r'));
    const r = Number.isInteger(rAttr) && rAttr > 0 ? rAttr - 1 : count;
    count = r + 1;
    let next = 0;
    for (const c of row.children) {
      if (localName(c.name) !== 'c') continue;
      const ref = attr(xml, c, 'r');
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const s = Number(attr(xml, c, 's') ?? 0);
      if (s) out.set(`${r}:${col}`, s);
    }
  }
  return out;
}

/** The `<cols>` element for a set of explicit widths merged over the file's own entries. */
export function mergeCols(xml: string, cols: ReadonlyMap<number, number | null>): string {
  const doc = parsePart(xml);
  const existing = elements(doc, 'cols')[0];
  // One entry per column range, as [min, max, extra attributes, width].
  type Range = { min: number; max: number; tag: string };
  const ranges: Range[] = [];
  for (const col of existing?.children ?? []) {
    if (localName(col.name) !== 'col') continue;
    const min = Number(attr(xml, col, 'min') ?? 0);
    const max = Number(attr(xml, col, 'max') ?? min);
    if (!(min >= 1) || !(max >= min)) continue;
    ranges.push({ min, max, tag: xml.slice(col.start, col.end) });
  }
  const prefix = existing && existing.name.includes(':') ? existing.name.slice(0, existing.name.indexOf(':') + 1) : '';
  for (const [col, px] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
    const n = col + 1;
    // Split any range that covers this column, so the rest keeps its own width.
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (n < r.min || n > r.max) continue;
      const parts: Range[] = [];
      if (r.min < n) parts.push({ ...r, max: n - 1, tag: setAttrs(r.tag, { max: String(n - 1) }) });
      const own = setAttrs(setAttrs(r.tag, { min: String(n) }), { max: String(n) });
      parts.push({ min: n, max: n, tag: own });
      if (r.max > n) parts.push({ ...r, min: n + 1, tag: setAttrs(r.tag, { min: String(n + 1) }) });
      ranges.splice(i, 1, ...parts);
      break;
    }
    const at = ranges.findIndex((r) => r.min === n && r.max === n);
    if (px === null) {
      if (at >= 0) {
        const tag = setAttrs(ranges[at].tag, { width: null, customWidth: null });
        // A range left with nothing but its bounds says nothing: drop it.
        if (/^<(?:\w+:)?col\s+min="\d+"\s+max="\d+"\s*\/>$/.test(tag)) ranges.splice(at, 1);
        else ranges[at] = { ...ranges[at], tag };
      }
      continue;
    }
    const width = String(pxToChars(px));
    if (at >= 0) ranges[at] = { ...ranges[at], tag: setAttrs(ranges[at].tag, { width, customWidth: '1' }) };
    else ranges.push({ min: n, max: n, tag: `<${prefix}col min="${n}" max="${n}" width="${width}" customWidth="1"/>` });
  }
  ranges.sort((a, b) => a.min - b.min);
  if (!ranges.length) return '';
  return `<${prefix}cols>${ranges.map((r) => r.tag).join('')}</${prefix}cols>`;
}

/**
 * The worksheet part with new cell styles, row heights and column widths. Cells
 * and rows that do not exist are created (empty, styled); nothing else changes.
 */
export function applySheetLook(xml: string, look: SheetLookEdits): string {
  const doc = parsePart(xml);
  const root = doc.roots.find((r) => localName(r.name) === 'worksheet');
  if (!root) throw new Error('xlsx: the sheet has no <worksheet>');
  const prefix = root.name.includes(':') ? root.name.slice(0, root.name.indexOf(':') + 1) : '';
  const sheetData = elements(doc, 'sheetData')[0];
  if (!sheetData) throw new Error('xlsx: the sheet has no <sheetData>');
  const edits: XmlEdit[] = [];

  // Work grouped by row.
  const byRow = new Map<number, { cells: Map<number, number>; height?: number | null }>();
  const need = (r: number): { cells: Map<number, number>; height?: number | null } => {
    let e = byRow.get(r);
    if (!e) { e = { cells: new Map() }; byRow.set(r, e); }
    return e;
  };
  for (const [key, s] of look.cells ?? []) { const [r, c] = key.split(':').map(Number); need(r).cells.set(c, s); }
  for (const [r, h] of look.rows ?? []) need(r).height = h;

  const rows: Array<{ index: number; el: XmlElement }> = [];
  let count = 0;
  for (const row of sheetData.children) {
    if (localName(row.name) !== 'row') continue;
    const rAttr = Number(attr(xml, row, 'r'));
    const index = Number.isInteger(rAttr) && rAttr > 0 ? rAttr - 1 : count;
    count = index + 1;
    rows.push({ index, el: row });
  }
  const rowTagFor = (open: string, height: number | null | undefined): string => {
    if (height === undefined) return open;
    return height === null ? setAttrs(open, { ht: null, customHeight: null }) : setAttrs(open, { ht: String(pxToPt(height)), customHeight: '1' });
  };
  const cellMarkup = (r: number, c: number, s: number): string => `<${prefix}c r="${cellName(r, c)}" s="${s}"/>`;

  for (const [r, want] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const found = rows.filter((x) => x.index === r).pop();
    if (!found) {
      if (want.height === null && !want.cells.size) continue;
      if (rows.some((x) => attr(xml, x.el, 'r') === null)) throw new Error('xlsx: rows are not addressed by r');
      const after = rows.find((x) => x.index > r);
      const at = after ? after.el.start : sheetData.selfClosing ? -1 : xml.lastIndexOf('<', sheetData.end - 1);
      if (at < 0) throw new Error('xlsx: cannot insert a row here');
      const open = rowTagFor(`<${prefix}row r="${r + 1}">`, want.height);
      const cells = [...want.cells.entries()].sort((a, b) => a[0] - b[0]).map(([c, s]) => cellMarkup(r, c, s)).join('');
      edits.push({ start: at, end: at, xml: `${open}${cells}</${prefix}row>` });
      continue;
    }
    const row = found.el;
    const openTag = xml.slice(row.start, row.openEnd);
    const newOpen = rowTagFor(openTag, want.height);
    const cells: Array<{ col: number; el: XmlElement }> = [];
    let next = 0;
    for (const c of row.children) {
      if (localName(c.name) !== 'c') continue;
      const ref = attr(xml, c, 'r');
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      cells.push({ col, el: c });
    }
    if (row.selfClosing) {
      const inner = [...want.cells.entries()].sort((a, b) => a[0] - b[0]).map(([c, s]) => cellMarkup(r, c, s)).join('');
      edits.push({ start: row.start, end: row.end, xml: inner ? `${newOpen.replace(/\s*\/>$/, '>')}${inner}</${row.name}>` : newOpen });
      continue;
    }
    if (newOpen !== openTag) edits.push({ start: row.start, end: row.openEnd, xml: newOpen });
    const close = xml.lastIndexOf('<', row.end - 1);
    for (const [c, s] of [...want.cells.entries()].sort((a, b) => a[0] - b[0])) {
      const existing = cells.find((x) => x.col === c);
      if (existing) {
        const tag = xml.slice(existing.el.start, existing.el.openEnd);
        edits.push({ start: existing.el.start, end: existing.el.openEnd, xml: setAttrs(tag, { s: s ? String(s) : null }) });
        continue;
      }
      if (!s) continue;
      const after = cells.find((x) => x.col > c);
      if (cells.some((x) => attr(xml, x.el, 'r') === null)) throw new Error('xlsx: cells are not addressed by r');
      const at = after ? after.el.start : close;
      edits.push({ start: at, end: at, xml: cellMarkup(r, c, s) });
    }
  }

  if (look.merges) {
    const markup = mergeCellsXml(look.merges, prefix);
    const existing = elements(doc, 'mergeCells')[0];
    if (existing) edits.push({ start: existing.start, end: existing.end, xml: markup });
    else if (markup) {
      const next = root.children.find((c) => AFTER_MERGES.includes(localName(c.name)));
      const at = next ? next.start : xml.lastIndexOf('<', root.end - 1);
      edits.push({ start: at, end: at, xml: markup });
    }
  }

  if (look.cols && look.cols.size) {
    const cols = mergeCols(xml, look.cols);
    const existing = elements(doc, 'cols')[0];
    if (existing) edits.push({ start: existing.start, end: existing.end, xml: cols });
    else if (cols) edits.push({ start: sheetData.start, end: sheetData.start, xml: cols });
  }
  return applyEdits(xml, edits);
}

/** Excel's own `<c>`-less check: does this sheet part hold any `s` that points past the styles list? */
export function maxStyleId(xml: string): number {
  let max = 0;
  for (const m of xml.matchAll(/<(?:\w+:)?c\s[^>]*\bs="(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max;
}
