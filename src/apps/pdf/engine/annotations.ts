/**
 * PDF engine — real PDF annotations (تعليقات PDF حقيقية تُفتح في أي قارئ).
 *
 * Every annotation is a real `/Annot` in the page's `/Annots`, with the entries the spec asks
 * for (Subtype, Rect, C, CA, QuadPoints / InkList / L, Contents, T, M, NM, F=Print) AND a
 * normal appearance stream `/AP /N`, so it looks the same in Chrome, Acrobat, Foxit and
 * Preview — none of them has to invent the drawing.
 *
 * The appearance is always rebuilt FROM THE DICTIONARY (`buildAppearance`), whether the
 * annotation is new or edited, so "what the file says" and "what the reader shows" can never
 * drift apart. Its BBox is the annotation's own Rect in page space, which makes moving an
 * annotation a matter of shifting Rect: every reader maps BBox onto Rect.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts,
  type PDFObject, type PDFPage,
} from 'pdf-lib';
import type { Rgb } from '../ops';
import type { OpResult } from '../pdfdoc';
import {
  EngineRefusal, boxOfRect, checkPage, clamp01, colorOf, dictOf, hexOf, num, numbersOf, pdfText, requireColor,
  round2, runOp, textOf, validBox, type Box,
} from './common';
import {
  arrowHead, boundsOf, catmullRom, ellipseOperators, inflate, lerp, pathOperators, quadForRect, quadHeight,
  quadPoints, quadsOf, roundedRectOperators, simplify, type Point,
} from './geometry';
import { blockOperators, embedTextFonts, fontResources, layoutLine, opacityState } from './text';

export type AnnotationKind =
  | 'highlight' | 'underline' | 'strikeout' | 'ink' | 'square' | 'circle' | 'line' | 'arrow' | 'note' | 'freetext' | 'stamp';

export interface AnnotationInput {
  /** 0-based page index. */
  page: number;
  kind: AnnotationKind;
  /** '#rrggbb': the markup / stroke / text colour. */
  color: string;
  /** 0..1 */
  opacity: number;
  /** Stroke width in points (ink, shapes, lines, stamp border, freetext border). */
  width?: number;
  /** Interior colour for square/circle, background for freetext; null/undefined = none. */
  fill?: string | null;
  /** Text markup: flat QuadPoints, 8 numbers per quad, TL TR BL BR. `rect` is used when absent. */
  quads?: number[];
  rect?: Box;
  /** Ink: one list of points per stroke, page space. */
  paths?: Point[][];
  /** Line / arrow: [x1, y1, x2, y2]; an arrow's head is at (x2, y2). */
  line?: [number, number, number, number];
  contents?: string;
  fontSize?: number;
  /** Extension: the author written to /T (sticky notes show it). */
  author?: string;
}

export interface AnnotationOptions {
  /** The Unicode (Arabic) font bytes — needed only when freetext/stamp text is not WinAnsi. */
  arabicFont?: Uint8Array;
  /** Extension: the date written to /M (tests pin it). */
  date?: Date;
}

export interface AnnotationInfo {
  page: number;
  /** Position in the page's /Annots array. */
  index: number;
  /** /NM when present, else `${page}:${index}`. */
  id: string;
  /** null for annotation types this editor does not create (Link, Widget, Popup…). */
  kind: AnnotationKind | null;
  subtype: string;
  rect: Box;
  contents: string;
  color: string | null;
  opacity: number;
}

export interface AnnotationPatch {
  color?: string;
  opacity?: number;
  contents?: string;
  dx?: number;
  dy?: number;
}

const SUBTYPE: Record<AnnotationKind, string> = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', ink: 'Ink', square: 'Square',
  circle: 'Circle', line: 'Line', arrow: 'Line', note: 'Text', freetext: 'FreeText', stamp: 'Stamp',
};

const KINDS = Object.keys(SUBTYPE) as AnnotationKind[];

let serial = 0;
const newId = (): string => `fos-${Date.now().toString(36)}-${(serial++).toString(36)}`;

/* ───────────────────────────── reading helpers ───────────────────────────── */

function arrOf(doc: PDFDocument, obj: PDFObject | undefined): PDFArray | undefined {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFArray ? v : undefined;
}

/** A colour array (gray, RGB or CMYK) → channels. */
function rgbOfArray(nums: number[]): Rgb | null {
  if (nums.length === 1) return { r: nums[0], g: nums[0], b: nums[0] };
  if (nums.length === 3) return { r: nums[0], g: nums[1], b: nums[2] };
  if (nums.length === 4) {
    const [c, m, y, k] = nums;
    return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) };
  }
  return null;
}

/** The fill colour a DA string sets (`r g b rg`, `g g`, `c m y k k`). */
function daColor(da: string): Rgb | null {
  const rg = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+rg\b/.exec(da);
  if (rg) return { r: +rg[1], g: +rg[2], b: +rg[3] };
  const g = /(-?[\d.]+)\s+g\b/.exec(da);
  if (g) return { r: +g[1], g: +g[1], b: +g[1] };
  const k = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+k\b/.exec(da);
  return k ? rgbOfArray([+k[1], +k[2], +k[3], +k[4]]) : null;
}

function daSize(da: string): number | null {
  const m = /(-?[\d.]+)\s+Tf\b/.exec(da);
  return m ? +m[1] : null;
}

function nameOf(obj: PDFObject | undefined): string {
  return obj instanceof PDFName ? obj.decodeText() : '';
}

function kindOf(doc: PDFDocument, dict: PDFDict): AnnotationKind | null {
  const subtype = nameOf(dict.get(PDFName.of('Subtype')));
  if (subtype === 'Line') {
    const le = arrOf(doc, dict.get(PDFName.of('LE')));
    const ends = le ? le.asArray().map((o) => nameOf(o)) : [];
    return ends.some((e) => /Arrow/.test(e)) ? 'arrow' : 'line';
  }
  return KINDS.find((k) => SUBTYPE[k] === subtype && k !== 'arrow') ?? null;
}

function widthOf(doc: PDFDocument, dict: PDFDict, fallback: number): number {
  const bs = dictOf(doc, dict.get(PDFName.of('BS')));
  const w = bs?.get(PDFName.of('W'));
  if (w instanceof PDFNumber) return w.asNumber();
  const border = numbersOf(doc, dict.get(PDFName.of('Border')));
  return border.length >= 3 ? border[2] : fallback;
}

function opacityOf(dict: PDFDict): number {
  const ca = dict.get(PDFName.of('CA'));
  return ca instanceof PDFNumber ? clamp01(ca.asNumber()) : 1;
}

/** The colour the owner thinks of: text colour (DA) for freetext, /C for everything else. */
function colorOfDict(doc: PDFDocument, dict: PDFDict, kind: AnnotationKind | null): Rgb | null {
  if (kind === 'freetext') {
    const da = textOf(dict.get(PDFName.of('DA')));
    const c = daColor(da);
    if (c) return c;
  }
  return rgbOfArray(numbersOf(doc, dict.get(PDFName.of('C'))));
}

function annotsOf(doc: PDFDocument, page: PDFPage): PDFArray | undefined {
  return arrOf(doc, page.node.get(PDFName.of('Annots')));
}

/* ───────────────────────────── appearance ───────────────────────────── */

const rgbOp = (c: Rgb, stroke: boolean): string => `${num(c.r)} ${num(c.g)} ${num(c.b)} ${stroke ? 'RG' : 'rg'}`;

/**
 * Builds (or rebuilds) the normal appearance of an annotation from its own dictionary and
 * stores it in /AP /N. Text kinds (freetext, stamp) need `fontBytes` when their text is not
 * WinAnsi; the refusal names the characters otherwise.
 */
export async function buildAppearance(doc: PDFDocument, dict: PDFDict, fontBytes?: Uint8Array): Promise<void> {
  const kind = kindOf(doc, dict);
  if (!kind) throw new EngineRefusal('unknown', 'no appearance builder for this annotation type');
  const rect = boxOfRect(numbersOf(doc, dict.get(PDFName.of('Rect'))));
  if (!rect) throw new EngineRefusal('unknown', 'annotation has no Rect');
  const color = colorOfDict(doc, dict, kind) ?? { r: 0, g: 0, b: 0 };
  const fill = rgbOfArray(numbersOf(doc, dict.get(PDFName.of(kind === 'freetext' ? 'C' : 'IC'))));
  const opacity = opacityOf(dict);
  const width = widthOf(doc, dict, kind === 'freetext' ? 0 : 1);
  const ctx = doc.context;
  const resources: Record<string, PDFObject> = {};
  const gs = opacityState(doc, opacity, kind === 'highlight' ? 'Multiply' : undefined);
  resources.ExtGState = ctx.obj({ GS0: gs });
  const body: string[] = ['/GS0 gs'];

  switch (kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout': {
      const quads = quadsOf(numbersOf(doc, dict.get(PDFName.of('QuadPoints'))));
      if (!quads.length) throw new EngineRefusal('unknown', 'text markup without QuadPoints');
      if (kind === 'highlight') {
        body.push(rgbOp(color, false));
        for (const q of quads) {
          body.push(`${num(q.bl.x)} ${num(q.bl.y)} m ${num(q.br.x)} ${num(q.br.y)} l ${num(q.tr.x)} ${num(q.tr.y)} l ${num(q.tl.x)} ${num(q.tl.y)} l h f`);
        }
      } else {
        body.push(rgbOp(color, true));
        for (const q of quads) {
          const t = Math.max(0.5, quadHeight(q) / 14);
          let a: Point, b: Point;
          if (kind === 'underline') {
            const up = quadHeight(q) ? t / quadHeight(q) : 0;
            a = lerp(q.bl, q.tl, up);
            b = lerp(q.br, q.tr, up);
          } else {
            a = lerp(q.bl, q.tl, 0.45);
            b = lerp(q.br, q.tr, 0.45);
          }
          body.push(`${num(t)} w ${num(a.x)} ${num(a.y)} m ${num(b.x)} ${num(b.y)} l S`);
        }
      }
      break;
    }
    case 'ink': {
      const list = arrOf(doc, dict.get(PDFName.of('InkList')));
      body.push(rgbOp(color, true), `${num(width)} w 1 J 1 j`);
      for (const item of list ? list.asArray() : []) {
        const nums = numbersOf(doc, item);
        const pts: Point[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
        const path = catmullRom(simplify(pts, 0.5));
        if (path) body.push(pathOperators(path), 'S');
      }
      break;
    }
    case 'square':
    case 'circle': {
      const inner = inflate(rect, -width / 2);
      if (inner.width <= 0 || inner.height <= 0) break;
      const path = kind === 'square' ? `${num(inner.x)} ${num(inner.y)} ${num(inner.width)} ${num(inner.height)} re` : ellipseOperators(inner);
      body.push(rgbOp(color, true), `${num(width)} w`);
      if (fill) body.push(rgbOp(fill, false));
      body.push(path, fill ? (width > 0 ? 'B' : 'f') : 'S');
      break;
    }
    case 'line':
    case 'arrow': {
      const l = numbersOf(doc, dict.get(PDFName.of('L')));
      if (l.length < 4) throw new EngineRefusal('unknown', 'line without L');
      const from = { x: l[0], y: l[1] }, to = { x: l[2], y: l[3] };
      body.push(rgbOp(color, true), `${num(width)} w 1 J 1 j`, `${num(from.x)} ${num(from.y)} m ${num(to.x)} ${num(to.y)} l S`);
      if (kind === 'arrow') {
        const [w1, w2] = arrowHead(from, to, Math.max(6, width * 4));
        body.push(`${num(w1.x)} ${num(w1.y)} m ${num(to.x)} ${num(to.y)} l ${num(w2.x)} ${num(w2.y)} l S`);
      }
      break;
    }
    case 'note': {
      // A small speech-bubble note icon filling the Rect.
      const b = inflate(rect, -0.5);
      body.push(rgbOp(color, false), '0.2 0.2 0.2 RG 1 w', roundedRectOperators(b, Math.min(3, b.width / 5)), 'B');
      body.push('1 1 1 RG', `${num(Math.max(0.8, b.height / 16))} w 1 J`);
      for (const t of [0.72, 0.5, 0.28]) {
        const y = b.y + b.height * t;
        body.push(`${num(b.x + b.width * 0.2)} ${num(y)} m ${num(b.x + b.width * 0.8)} ${num(y)} l S`);
      }
      break;
    }
    case 'freetext':
    case 'stamp': {
      const contents = textOf(dict.get(PDFName.of('Contents')));
      const fonts = await embedTextFonts(doc, contents, fontBytes, kind === 'stamp' ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
      const { dict: fontDict, keys } = fontResources(fonts);
      resources.Font = fontDict;
      if (kind === 'freetext') {
        if (fill) body.push(rgbOp(fill, false), `${num(rect.x)} ${num(rect.y)} ${num(rect.width)} ${num(rect.height)} re f`);
        if (width > 0) {
          const inner = inflate(rect, -width / 2);
          body.push(rgbOp(color, true), `${num(width)} w ${num(inner.x)} ${num(inner.y)} ${num(inner.width)} ${num(inner.height)} re S`);
        }
        const size = daSize(textOf(dict.get(PDFName.of('DA')))) ?? 12;
        const pad = 2 + width;
        if (contents.trim()) {
          const block = blockOperators(fonts, keys, contents, {
            x: rect.x + pad, y: rect.y + rect.height - pad - size * 0.95, size, color,
            maxWidth: Math.max(1, rect.width - 2 * pad),
          });
          body.push(`${num(rect.x)} ${num(rect.y)} ${num(rect.width)} ${num(rect.height)} re W n`);
          body.push(...block.ops.map((o) => o.toString()));
        }
      } else {
        const bw = Math.max(1, width);
        const inner = inflate(rect, -bw / 2);
        body.push(rgbOp(color, true), `${num(bw)} w`, roundedRectOperators(inner, Math.min(8, inner.height / 5)), 'S');
        const text = contents.trim();
        if (text) {
          const probe = layoutLine(fonts, text, 10);
          const byWidth = probe.width > 0 ? (10 * (rect.width * 0.82 - 2 * bw)) / probe.width : 10;
          const size = Math.max(4, Math.min(rect.height * 0.55, byWidth));
          const block = blockOperators(fonts, keys, text, {
            x: rect.x, y: rect.y + rect.height / 2 - size * 0.35, size, color, maxWidth: rect.width, align: 'center',
          });
          body.push(...block.ops.map((o) => o.toString()));
        }
      }
      break;
    }
  }

  const stream = ctx.flateStream(body.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: resources as never,
  });
  const ref = ctx.register(stream);
  dict.set(PDFName.of('AP'), ctx.obj({ N: ref }));
}

/* ───────────────────────────── writing ───────────────────────────── */

const rectArray = (b: Box): number[] => [round2(b.x), round2(b.y), round2(b.x + b.width), round2(b.y + b.height)];

/** Decides the geometry of a new annotation, or refuses. Pure. */
export function annotationGeometry(a: AnnotationInput): {
  rect: Box; quads?: number[]; ink?: number[][]; line?: number[];
} {
  const width = a.width ?? 2;
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout': {
      const quads = a.quads && a.quads.length >= 8 ? a.quads.slice(0, a.quads.length - (a.quads.length % 8)) : a.rect && validBox(a.rect) ? quadForRect(a.rect) : null;
      if (!quads || !quads.every(Number.isFinite)) throw new EngineRefusal('unknown', 'text markup needs quads or rect');
      const b = boundsOf(quadsOf(quads).flatMap(quadPoints));
      if (!b || b.width <= 0 || b.height <= 0) throw new EngineRefusal('unknown', 'empty quads');
      return { rect: inflate(b, 1), quads };
    }
    case 'ink': {
      const paths = (a.paths ?? []).map((p) => p.filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y))).filter((p) => p.length);
      const b = boundsOf(paths.flat());
      if (!b) throw new EngineRefusal('unknown', 'ink needs at least one point');
      return { rect: inflate(b, width / 2 + 1), ink: paths.map((p) => p.flatMap((q) => [round2(q.x), round2(q.y)])) };
    }
    case 'line':
    case 'arrow': {
      const l = a.line;
      if (!l || l.length < 4 || !l.every(Number.isFinite)) throw new EngineRefusal('unknown', 'line needs [x1,y1,x2,y2]');
      if (l[0] === l[2] && l[1] === l[3]) throw new EngineRefusal('unknown', 'zero-length line');
      const b = boundsOf([{ x: l[0], y: l[1] }, { x: l[2], y: l[3] }]) as Box;
      const pad = a.kind === 'arrow' ? Math.max(6, width * 4) + width : width + 1;
      return { rect: inflate(b, pad), line: l.slice(0, 4).map(round2) };
    }
    case 'note': {
      const r = a.rect;
      if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y)) throw new EngineRefusal('unknown', 'note needs rect');
      return { rect: r.width > 0 && r.height > 0 ? r : { x: r.x, y: r.y, width: 22, height: 22 } };
    }
    default: {
      if (!validBox(a.rect)) throw new EngineRefusal('unknown', `${a.kind} needs a rect`);
      return { rect: a.rect };
    }
  }
}

/** Creates the annotation dictionary (not yet on a page). */
async function createAnnotation(doc: PDFDocument, page: PDFPage, a: AnnotationInput, opts: AnnotationOptions): Promise<{ ref: PDFRef; dict: PDFDict; id: string }> {
  if (!KINDS.includes(a.kind)) throw new EngineRefusal('unknown', `unknown kind ${String(a.kind)}`);
  const color = requireColor(a.color);
  const fill = a.fill ? requireColor(a.fill, 'fill') : null;
  const geo = annotationGeometry(a);
  const width = Math.max(0, a.width ?? (a.kind === 'freetext' ? 0 : 2));
  const ctx = doc.context;
  const id = newId();
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: SUBTYPE[a.kind],
    Rect: rectArray(geo.rect),
    F: 4,
    P: page.ref,
    CA: clamp01(a.opacity),
  });
  dict.set(PDFName.of('NM'), PDFString.of(id));
  dict.set(PDFName.of('M'), PDFString.fromDate(opts.date ?? new Date()));
  if (a.contents) dict.set(PDFName.of('Contents'), pdfText(a.contents));
  if (a.author) dict.set(PDFName.of('T'), pdfText(a.author));
  const c = [color.r, color.g, color.b];
  if (a.kind === 'freetext') {
    const size = a.fontSize && a.fontSize > 0 ? a.fontSize : 12;
    dict.set(PDFName.of('DA'), PDFString.of(`/Helv ${num(size)} Tf ${num(color.r)} ${num(color.g)} ${num(color.b)} rg`));
    if (fill) dict.set(PDFName.of('C'), ctx.obj([fill.r, fill.g, fill.b]));
    if (a.contents && /[֐-ࣿיִ-ﻼ]/.test(a.contents)) dict.set(PDFName.of('Q'), PDFNumber.of(2));
  } else {
    dict.set(PDFName.of('C'), ctx.obj(c));
  }
  if (fill && (a.kind === 'square' || a.kind === 'circle')) dict.set(PDFName.of('IC'), ctx.obj([fill.r, fill.g, fill.b]));
  if (!['highlight', 'underline', 'strikeout', 'note'].includes(a.kind)) {
    dict.set(PDFName.of('BS'), ctx.obj({ Type: 'Border', W: width, S: 'S' }));
    dict.set(PDFName.of('Border'), ctx.obj([0, 0, width]));
  }
  if (geo.quads) dict.set(PDFName.of('QuadPoints'), ctx.obj(geo.quads.map(round2)));
  if (geo.ink) dict.set(PDFName.of('InkList'), ctx.obj(geo.ink));
  if (geo.line) {
    dict.set(PDFName.of('L'), ctx.obj(geo.line));
    dict.set(PDFName.of('LE'), ctx.obj(['None', a.kind === 'arrow' ? 'OpenArrow' : 'None']));
  }
  if (a.kind === 'note') {
    dict.set(PDFName.of('Name'), PDFName.of('Comment'));
    dict.set(PDFName.of('Open'), ctx.obj(false));
  }
  if (a.kind === 'stamp') dict.set(PDFName.of('Name'), PDFName.of('Draft'));
  await buildAppearance(doc, dict, opts.arabicFont);
  return { ref: ctx.register(dict), dict, id };
}

function checkAnnotation(doc: PDFDocument, pageIndex: number, index: number, subtype: string, rect: Box, color: Rgb | null, kind: AnnotationKind): string[] {
  const bad: string[] = [];
  const annots = annotsOf(doc, doc.getPage(pageIndex));
  const dict = annots ? dictOf(doc, annots.get(index)) : undefined;
  if (!dict) return [`annotation ${index} missing on page ${pageIndex + 1}`];
  const st = nameOf(dict.get(PDFName.of('Subtype')));
  if (st !== subtype) bad.push(`subtype ${st} != ${subtype}`);
  const r = boxOfRect(numbersOf(doc, dict.get(PDFName.of('Rect'))));
  if (!r || Math.abs(r.x - rect.x) > 0.6 || Math.abs(r.y - rect.y) > 0.6 || Math.abs(r.width - rect.width) > 0.6 || Math.abs(r.height - rect.height) > 0.6) {
    bad.push('Rect mismatch');
  }
  if (color) {
    const c = colorOfDict(doc, dict, kind);
    if (!c || hexOf(c) !== hexOf(color)) bad.push(`colour ${c ? hexOf(c) : 'none'} != ${hexOf(color)}`);
  }
  const ap = dictOf(doc, dict.get(PDFName.of('AP')));
  if (!ap || !ap.get(PDFName.of('N'))) bad.push('no appearance stream');
  return bad;
}

/**
 * Adds one real annotation to a page. The produced bytes are re-read: the page must carry one
 * more /Annots entry, with the right Subtype, Rect, colour and an /AP /N appearance.
 */
export async function addAnnotation(bytes: Uint8Array, a: AnnotationInput, opts: AnnotationOptions = {}): Promise<OpResult> {
  let expected: { index: number; rect: Box; color: Rgb | null } | null = null;
  return runOp(bytes, async (doc) => {
    const page = checkPage(doc, a.page);
    const before = annotsOf(doc, page)?.size() ?? 0;
    const made = await createAnnotation(doc, page, a, opts);
    page.node.addAnnot(made.ref);
    const rect = boxOfRect(numbersOf(doc, made.dict.get(PDFName.of('Rect')))) as Box;
    expected = { index: before, rect, color: colorOf(a.color) };
    return `annot=${SUBTYPE[a.kind]} id=${made.id}`;
  }, (doc) => {
    if (!expected) return ['nothing written'];
    return checkAnnotation(doc, a.page, expected.index, SUBTYPE[a.kind], expected.rect, expected.color, a.kind);
  });
}

/* ───────────────────────────── listing ───────────────────────────── */

/** Reads every annotation of an already-open document (all subtypes; `kind` is null for foreign ones). */
export function readAnnotations(doc: PDFDocument): AnnotationInfo[] {
  const out: AnnotationInfo[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const annots = annotsOf(doc, page);
    if (!annots) return;
    for (let index = 0; index < annots.size(); index++) {
      const dict = dictOf(doc, annots.get(index));
      if (!dict) continue;
      const kind = kindOf(doc, dict);
      const rect = boxOfRect(numbersOf(doc, dict.get(PDFName.of('Rect')))) ?? { x: 0, y: 0, width: 0, height: 0 };
      const nm = textOf(dict.get(PDFName.of('NM')));
      const color = colorOfDict(doc, dict, kind);
      out.push({
        page: pageIndex,
        index,
        id: nm || `${pageIndex}:${index}`,
        kind,
        subtype: nameOf(dict.get(PDFName.of('Subtype'))),
        rect: { x: round2(rect.x), y: round2(rect.y), width: round2(rect.width), height: round2(rect.height) },
        contents: textOf(dict.get(PDFName.of('Contents'))),
        color: color ? hexOf(color) : null,
        opacity: opacityOf(dict),
      });
    }
  });
  return out;
}

/** Every annotation in the file. A file that cannot be opened lists nothing. */
export async function listAnnotations(bytes: Uint8Array): Promise<AnnotationInfo[]> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return readAnnotations(doc);
  } catch {
    return [];
  }
}

/* ───────────────────────────── editing ───────────────────────────── */

function locate(doc: PDFDocument, pageIndex: number, index: number): { page: PDFPage; annots: PDFArray; dict: PDFDict } {
  const page = checkPage(doc, pageIndex);
  const annots = annotsOf(doc, page);
  const dict = annots && Number.isInteger(index) && index >= 0 && index < annots.size() ? dictOf(doc, annots.get(index)) : undefined;
  if (!annots || !dict) throw new EngineRefusal('unknown', `no annotation ${index} on page ${pageIndex + 1}`);
  return { page, annots, dict };
}

function shiftNumbers(doc: PDFDocument, dict: PDFDict, key: string, dx: number, dy: number, nested = false): void {
  const arr = arrOf(doc, dict.get(PDFName.of(key)));
  if (!arr) return;
  if (nested) {
    const lists = arr.asArray().map((item) => numbersOf(doc, item));
    dict.set(PDFName.of(key), doc.context.obj(lists.map((l) => l.map((v, i) => round2(v + (i % 2 ? dy : dx))))));
    return;
  }
  const nums = numbersOf(doc, arr);
  dict.set(PDFName.of(key), doc.context.obj(nums.map((v, i) => round2(v + (i % 2 ? dy : dx)))));
}

/**
 * Changes colour, opacity, contents and/or position of one annotation, then rebuilds its
 * appearance from the updated dictionary (for the kinds this editor knows). Moving shifts
 * Rect and every geometry array (QuadPoints, InkList, L), and the attached popup.
 * Form widgets are refused: they belong to the form, not to the comment layer.
 */
export async function updateAnnotation(
  bytes: Uint8Array, page: number, index: number, patch: AnnotationPatch, opts: AnnotationOptions = {},
): Promise<OpResult> {
  let want: { rect: Box; color: Rgb | null; subtype: string; kind: AnnotationKind | null } | null = null;
  return runOp(bytes, async (doc) => {
    const { dict } = locate(doc, page, index);
    const subtype = nameOf(dict.get(PDFName.of('Subtype')));
    if (subtype === 'Widget') throw new EngineRefusal('unknown', 'form fields are edited through the form');
    const kind = kindOf(doc, dict);
    const ctx = doc.context;
    let color: Rgb | null = null;
    if (patch.color !== undefined) {
      color = requireColor(patch.color);
      if (kind === 'freetext') {
        const size = daSize(textOf(dict.get(PDFName.of('DA')))) ?? 12;
        dict.set(PDFName.of('DA'), PDFString.of(`/Helv ${num(size)} Tf ${num(color.r)} ${num(color.g)} ${num(color.b)} rg`));
      } else {
        dict.set(PDFName.of('C'), ctx.obj([color.r, color.g, color.b]));
      }
    }
    if (patch.opacity !== undefined) dict.set(PDFName.of('CA'), PDFNumber.of(clamp01(patch.opacity)));
    if (patch.contents !== undefined) dict.set(PDFName.of('Contents'), pdfText(patch.contents));
    const dx = Number.isFinite(patch.dx) ? (patch.dx as number) : 0;
    const dy = Number.isFinite(patch.dy) ? (patch.dy as number) : 0;
    if (dx || dy) {
      shiftNumbers(doc, dict, 'Rect', dx, dy);
      shiftNumbers(doc, dict, 'QuadPoints', dx, dy);
      shiftNumbers(doc, dict, 'L', dx, dy);
      shiftNumbers(doc, dict, 'Vertices', dx, dy);
      shiftNumbers(doc, dict, 'InkList', dx, dy, true);
      const popup = dictOf(doc, dict.get(PDFName.of('Popup')));
      if (popup) shiftNumbers(doc, popup, 'Rect', dx, dy);
    }
    dict.set(PDFName.of('M'), PDFString.fromDate(opts.date ?? new Date()));
    if (kind) await buildAppearance(doc, dict, opts.arabicFont);
    const rect = boxOfRect(numbersOf(doc, dict.get(PDFName.of('Rect')))) as Box;
    want = { rect, color, subtype, kind };
    return `updated ${subtype}`;
  }, (doc) => {
    if (!want) return ['nothing written'];
    if (!want.kind) {
      const { dict } = locate(doc, page, index);
      return nameOf(dict.get(PDFName.of('Subtype'))) === want.subtype ? [] : ['subtype changed'];
    }
    const bad = checkAnnotation(doc, page, index, want.subtype, want.rect, want.color, want.kind);
    if (patch.contents !== undefined) {
      const { dict } = locate(doc, page, index);
      if (textOf(dict.get(PDFName.of('Contents'))) !== patch.contents) bad.push('contents not written');
    }
    return bad;
  });
}

/**
 * Removes one annotation (and its popup) from a page. Form widgets are refused. The produced
 * bytes must have exactly one entry fewer in that page's /Annots.
 */
export async function removeAnnotation(bytes: Uint8Array, page: number, index: number): Promise<OpResult> {
  let before = 0;
  return runOp(bytes, (doc) => {
    const { annots, dict } = locate(doc, page, index);
    if (nameOf(dict.get(PDFName.of('Subtype'))) === 'Widget') throw new EngineRefusal('unknown', 'form fields are removed through the form');
    before = annots.size();
    const target = annots.get(index);
    const popupRef = dict.get(PDFName.of('Popup'));
    annots.remove(index);
    let removed = 1;
    if (popupRef instanceof PDFRef) {
      const at = annots.asArray().findIndex((o) => o instanceof PDFRef && o.toString() === popupRef.toString());
      if (at >= 0) { annots.remove(at); removed++; }
      doc.context.delete(popupRef);
    }
    if (target instanceof PDFRef) doc.context.delete(target);
    before -= removed - 1; // the check below expects exactly one fewer than `before`
    return `removed ${removed}`;
  }, (doc) => {
    const n = annotsOf(doc, doc.getPage(page))?.size() ?? 0;
    return n === before - 1 ? [] : [`annots ${n} != ${before - 1}`];
  });
}
