/**
 * Writer — page layout, header and footer (تخطيط الصفحة والرأس والتذييل).
 *
 * The owner's page setup (paper, orientation, margins, columns) and the text of the
 * default header and footer live in the model as plain values, so an edit is undoable
 * like any other. The save turns them into the section's `<w:sectPr>` and into header
 * and footer parts; the reader (`docxread.ts`) reads the very same XML back.
 *
 * Everything here is pure: sizes are in points (Word stores twips, 1/20 pt), and the
 * page-number fields of a header or footer are the two markers the reader already
 * uses: U+0001 for PAGE and U+0002 for NUMPAGES.
 */
import type { ParagraphAlign } from '../model';
import { insertPointIn, textElement } from '../patch';
import { jcValue } from '../xml';
import { attrLocal, localName, parsePart, type XmlElement } from '../xmlscan';

/** Page size, margins, header/footer distances and columns, all in points. */
export interface PageSetup {
  w: number; h: number;
  top: number; bottom: number; left: number; right: number;
  header: number; footer: number;
  cols: number; colGap: number;
}

/** One header or footer: its text (U+0001 = page number, U+0002 = page count) and its alignment. */
export interface HfSetup { text: string; align: ParagraphAlign }

/** The document's default header and footer as the owner set them (null = none). */
export interface HeaderFooterSetup { header: HfSetup | null; footer: HfSetup | null }

export const PAGE_FIELD = '\u0001';
export const PAGES_FIELD = '\u0002';

export type PaperName = 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5';
/** Portrait width × height in points. */
export const PAPERS: Record<PaperName, [number, number]> = {
  A4: [595.3, 841.9],
  Letter: [612, 792],
  Legal: [612, 1008],
  A3: [841.9, 1190.6],
  A5: [419.5, 595.3],
};

export type MarginName = 'normal' | 'narrow' | 'moderate' | 'wide';
/** Word's margin presets: top, bottom, inside-start (left), inside-end (right). */
export const MARGINS: Record<MarginName, { top: number; bottom: number; left: number; right: number }> = {
  normal: { top: 72, bottom: 72, left: 72, right: 72 },
  narrow: { top: 36, bottom: 36, left: 36, right: 36 },
  moderate: { top: 72, bottom: 72, left: 54, right: 54 },
  wide: { top: 72, bottom: 72, left: 144, right: 144 },
};

/** A new document's page: A4 portrait, normal margins, one column. */
export const DEFAULT_PAGE: PageSetup = {
  w: 595.3, h: 841.9, top: 72, bottom: 72, left: 72, right: 72, header: 35.4, footer: 35.4, cols: 1, colGap: 35.4,
};

const near = (a: number, b: number, eps = 1.5): boolean => Math.abs(a - b) <= eps;

export function orientationOf(page: PageSetup): 'portrait' | 'landscape' {
  return page.w > page.h ? 'landscape' : 'portrait';
}

/** The named paper the page is (either orientation), or null for a custom size. */
export function paperOf(page: PageSetup): PaperName | null {
  const short = Math.min(page.w, page.h);
  const long = Math.max(page.w, page.h);
  for (const [name, [w, h]] of Object.entries(PAPERS) as Array<[PaperName, [number, number]]>) {
    if (near(short, w) && near(long, h)) return name;
  }
  return null;
}

/** The named margin preset the page uses, or null for custom margins. */
export function marginsOf(page: PageSetup): MarginName | null {
  for (const [name, m] of Object.entries(MARGINS) as Array<[MarginName, typeof MARGINS[MarginName]]>) {
    if (near(page.top, m.top, 0.6) && near(page.bottom, m.bottom, 0.6) && near(page.left, m.left, 0.6) && near(page.right, m.right, 0.6)) return name;
  }
  return null;
}

export function withOrientation(page: PageSetup, o: 'portrait' | 'landscape'): PageSetup {
  if (orientationOf(page) === o) return page;
  return { ...page, w: page.h, h: page.w };
}

export function withPaper(page: PageSetup, name: PaperName): PageSetup {
  const [w, h] = PAPERS[name];
  return orientationOf(page) === 'landscape' ? { ...page, w: h, h: w } : { ...page, w, h };
}

export function withMargins(page: PageSetup, m: { top: number; bottom: number; left: number; right: number }): PageSetup {
  const clampM = (v: number): number => Math.max(0, Math.min(v, 288));
  const next = { ...page, top: clampM(m.top), bottom: clampM(m.bottom), left: clampM(m.left), right: clampM(m.right) };
  // The text area never collapses: at least 72pt of width and height stay for the text.
  if (next.w - next.left - next.right < 72 || next.h - next.top - next.bottom < 72) return page;
  return next;
}

export function withColumns(page: PageSetup, cols: number): PageSetup {
  return { ...page, cols: Math.max(1, Math.min(3, Math.round(cols))) };
}

export function samePage(a: PageSetup | undefined, b: PageSetup | undefined): boolean {
  if (!a || !b) return a === b;
  return (['w', 'h', 'top', 'bottom', 'left', 'right', 'header', 'footer', 'colGap'] as const).every((k) => near(a[k], b[k], 0.1)) && a.cols === b.cols;
}

export function sameHf(a: HfSetup | null | undefined, b: HfSetup | null | undefined): boolean {
  if (!a || !b) return !a === !b;
  return a.text === b.text && (a.align ?? 'left') === (b.align ?? 'left');
}

/* ─────────────────────────── the section's XML ─────────────────────────── */

/** The children of `<w:sectPr>` in schema order. */
export const SECT_ORDER = [
  'headerReference', 'footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders',
  'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter',
  'docGrid', 'printerSettings', 'sectPrChange',
];

const tw = (pt: number): number => Math.round(pt * 20);

/** Reads a `<w:sectPr>` back as a page setup (the same rules the reader applies). */
export function readSectPr(xml: string, sect: XmlElement | undefined): PageSetup {
  const kid = (name: string): XmlElement | undefined => sect?.children.find((c) => localName(c.name) === name);
  const pgSz = kid('pgSz');
  const pgMar = kid('pgMar');
  const cols = kid('cols');
  const pt = (element: XmlElement | undefined, name: string, fallback: number): number => {
    const raw = element ? attrLocal(xml, element, name) : null;
    const n = Number(raw);
    return raw !== null && Number.isFinite(n) ? Math.abs(n) / 20 : fallback;
  };
  const page: PageSetup = {
    w: pt(pgSz, 'w', 595.3), h: pt(pgSz, 'h', 841.9),
    top: pt(pgMar, 'top', 72), bottom: pt(pgMar, 'bottom', 72), left: pt(pgMar, 'left', 72), right: pt(pgMar, 'right', 72),
    header: pt(pgMar, 'header', 36), footer: pt(pgMar, 'footer', 36),
    cols: Math.max(1, Math.min(4, Number(cols ? attrLocal(xml, cols, 'num') ?? 1 : 1) || 1)),
    colGap: pt(cols, 'space', 36),
  };
  if (pgSz && (attrLocal(xml, pgSz, 'orient') ?? '') === 'landscape' && page.w < page.h) [page.w, page.h] = [page.h, page.w];
  return page;
}

/**
 * Rewrites a `<w:sectPr>…</w:sectPr>` so it says `page`: `pgSz`, `pgMar` and `cols` are
 * replaced (a margin's gutter is kept), everything else in the section is left as it is.
 */
export function sectPrWithPage(sectXml: string, page: PageSetup): string {
  let src = sectXml;
  let root = parsePart(src).roots[0];
  if (!root) return sectXml;
  if (root.selfClosing) {
    src = `<${root.name}${src.slice(root.start + 1 + root.name.length, root.end - 2)}></${root.name}>`;
    root = parsePart(src).roots[0];
  }
  const prefix = root.name.includes(':') ? `${root.name.split(':')[0]}:` : '';
  const kid = (name: string): XmlElement | undefined => root.children.find((c) => localName(c.name) === name);
  const oldMar = kid('pgMar');
  const gutter = oldMar ? attrLocal(src, oldMar, 'gutter') : null;
  const landscape = page.w > page.h;
  const wanted: Array<[string, string]> = [
    ['pgSz', `<${prefix}pgSz ${prefix}w="${tw(page.w)}" ${prefix}h="${tw(page.h)}"${landscape ? ` ${prefix}orient="landscape"` : ''}/>`],
    ['pgMar', `<${prefix}pgMar ${prefix}top="${tw(page.top)}" ${prefix}right="${tw(page.right)}" ${prefix}bottom="${tw(page.bottom)}" ${prefix}left="${tw(page.left)}" ${prefix}header="${tw(page.header)}" ${prefix}footer="${tw(page.footer)}" ${prefix}gutter="${gutter ?? '0'}"/>`],
    ['cols', `<${prefix}cols ${prefix}space="${tw(page.colGap)}"${page.cols > 1 ? ` ${prefix}num="${page.cols}"` : ''}/>`],
  ];
  const edits: Array<{ start: number; end: number; xml: string }> = [];
  for (const [name, markup] of wanted) {
    const existing = kid(name);
    if (existing) edits.push({ start: existing.start, end: existing.end, xml: markup });
    else {
      const at = insertPointIn(src, root, SECT_ORDER, name);
      edits.push({ start: at, end: at, xml: markup });
    }
  }
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const e of edits) { out += src.slice(at, e.start) + e.xml; at = e.end; }
  return out + src.slice(at);
}

/**
 * Points a section's default header or footer at `rid` (or removes it when `rid` is null),
 * keeping every other reference (a first-page header, say) as it is.
 */
export function sectPrWithReference(sectXml: string, kind: 'header' | 'footer', rid: string | null): string {
  let src = sectXml;
  let root = parsePart(src).roots[0];
  if (!root) return sectXml;
  if (root.selfClosing) {
    src = `<${root.name}${src.slice(root.start + 1 + root.name.length, root.end - 2)}></${root.name}>`;
    root = parsePart(src).roots[0];
  }
  const prefix = root.name.includes(':') ? `${root.name.split(':')[0]}:` : '';
  const local = `${kind}Reference`;
  const current = root.children.find((c) => localName(c.name) === local && (attrLocal(src, c, 'type') ?? 'default') === 'default');
  const markup = rid ? `<${prefix}${local} ${prefix}type="default" r:id="${rid}"/>` : '';
  if (current) return `${src.slice(0, current.start)}${markup}${src.slice(current.end)}`;
  if (!markup) return src;
  const at = insertPointIn(src, root, SECT_ORDER, local);
  return `${src.slice(0, at)}${markup}${src.slice(at)}`;
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** A header or footer part holding `hf`: one paragraph per line, page numbers as PAGE/NUMPAGES fields. */
export function hfPartXml(kind: 'header' | 'footer', hf: HfSetup, rtl: boolean): string {
  const tag = kind === 'header' ? 'w:hdr' : 'w:ftr';
  const rPr = rtl ? '<w:rPr><w:rtl/></w:rPr>' : '';
  const paras = hf.text.split('\n').map((line) => {
    let runs = '';
    for (const piece of line.split(/([\u0001\u0002])/)) {
      if (!piece) continue;
      if (piece === PAGE_FIELD || piece === PAGES_FIELD) {
        const instr = piece === PAGE_FIELD ? 'PAGE' : 'NUMPAGES';
        runs += `<w:fldSimple w:instr=" ${instr} \\* MERGEFORMAT "><w:r>${rPr}<w:t>1</w:t></w:r></w:fldSimple>`;
      } else runs += `<w:r>${rPr}${textElement('w:t', null, piece)}</w:r>`;
    }
    const pPr = `<w:pPr>${rtl ? '<w:bidi/>' : ''}<w:jc w:val="${jcValue(hf.align)}"/></w:pPr>`;
    return `<w:p>${pPr}${runs}</w:p>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${tag} xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${paras || '<w:p/>'}</${tag}>`;
}

/** The text a header/footer line reads back as, for comparing a setup with what a file holds. */
export function hfText(lines: ReadonlyArray<{ text: string }> | undefined): string {
  return (lines ?? []).map((l) => l.text).join('\n');
}

/** A header or footer line as the page shows it: the fields replaced by this page's numbers. */
export function hfDisplay(text: string, page: number, pages: number): string {
  return text.split(PAGE_FIELD).join(String(page)).split(PAGES_FIELD).join(String(pages));
}
