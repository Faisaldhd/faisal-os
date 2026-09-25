/**
 * PDF engine — true redaction (الحجب الحقيقي).
 *
 * Unlike «تغطية» (cover), which only paints a box over the page, redaction REMOVES what lies
 * inside the marked areas from the file itself, then paints the box:
 *
 * - text: every glyph whose box sits in an area is taken out of its `Tj`/`TJ` string and replaced
 *   by a positioning gap of the same width, so the text around it does not move;
 * - vector art: a path wholly inside an area is dropped; a path that only crosses an area is
 *   kept but clipped so nothing is painted inside it;
 * - images: an image wholly inside an area is dropped; one that crosses an area is re-written
 *   with the pixels inside the area set to zero (8-bit Flate/raw images here, JPEG through the
 *   optional `decodeImage` hook the window passes in the browser); an image that can be neither
 *   is dropped entirely — safety before looks. Inline images that touch an area are dropped;
 * - form XObjects (stamps, flattened fields, …) are processed recursively as private copies;
 * - annotations touching an area are removed, and a form field touching one is flattened first;
 * - `/ActualText` of a marked-content span that lost a glyph is removed too;
 * - finally every object nothing references any more (the old content streams, the original
 *   images) is deleted, so the removed bytes are not still sitting in the saved file.
 *
 * The output is re-opened and scanned again with the same interpreter: no glyph may remain in
 * an area, or the operation fails. The window additionally re-extracts the text with pdf.js.
 * DOM-free.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream,
  StandardFontEmbedder, StandardFonts, decodePDFRawStream, type PDFObject, type PDFPage,
} from 'pdf-lib';
import { refusalFromError } from '../ops';
import { loadPdf, type OpResult } from '../pdfdoc';
import { colorOf, dictOf, type Box } from './common';
import { hexString, numText, tokText, tokenizeContent, type Op, type Tok } from './content';

export interface RedactionArea extends Box {
  /** 0-based page index. */
  page: number;
}

export interface DecodedImage { width: number; height: number; data: Uint8ClampedArray | Uint8Array }

export interface RedactOptions {
  /** The colour of the boxes painted over the areas (default black). */
  fill?: string;
  /** Decodes an image this engine cannot (JPEG in the browser): RGBA pixels, or null. */
  decodeImage?: (bytes: Uint8Array, filter: string) => Promise<DecodedImage | null>;
}

export interface RedactReport {
  glyphs: number;
  paths: number;
  pathsClipped: number;
  images: number;
  imagesEdited: number;
  annotations: number;
  fieldsFlattened: boolean;
}

export type RedactResult =
  | { ok: true; bytes: Uint8Array; verified: string; report: RedactReport }
  | Extract<OpResult, { ok: false }>;

type M = [number, number, number, number, number, number];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];

export function mul(a: M, b: M): M {
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}
function apply(m: M, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}
function invert(m: M): M | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

interface Rect { x0: number; y0: number; x1: number; y1: number }
function boundsOf(m: M, x0: number, y0: number, x1: number, y1: number): Rect {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
const rectOfBox = (b: Box): Rect => ({ x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height });
const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const intersects = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (a: Rect, b: Rect): boolean => a.x0 >= b.x0 - 0.01 && a.y0 >= b.y0 - 0.01 && a.x1 <= b.x1 + 0.01 && a.y1 <= b.y1 + 0.01;
const pointIn = (x: number, y: number, r: Rect): boolean => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** A glyph is redacted when its centre is in an area or an area covers ≥ 30% of it. */
export function glyphHit(g: Rect, areas: readonly Rect[]): boolean {
  const cx = (g.x0 + g.x1) / 2;
  const cy = (g.y0 + g.y1) / 2;
  const size = (g.x1 - g.x0) * (g.y1 - g.y0);
  for (const a of areas) {
    if (pointIn(cx, cy, a)) return true;
    if (size > 1e-6 && overlap(g, a) >= 0.3 * size) return true;
  }
  return false;
}

/* ───────── fonts: how wide is each glyph ───────── */

interface FontInfo {
  twoByte: boolean;
  /** Width in thousandths of text space units. */
  width(code: number): number;
}

const STANDARD: Record<string, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica, 'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Helvetica-Oblique': StandardFonts.HelveticaOblique, 'Helvetica-BoldOblique': StandardFonts.HelveticaBoldOblique,
  'Times-Roman': StandardFonts.TimesRoman, 'Times-Bold': StandardFonts.TimesRomanBold,
  'Times-Italic': StandardFonts.TimesRomanItalic, 'Times-BoldItalic': StandardFonts.TimesRomanBoldItalic,
  Courier: StandardFonts.Courier, 'Courier-Bold': StandardFonts.CourierBold,
  'Courier-Oblique': StandardFonts.CourierOblique, 'Courier-BoldOblique': StandardFonts.CourierBoldOblique,
  Symbol: StandardFonts.Symbol, ZapfDingbats: StandardFonts.ZapfDingbats,
  Arial: StandardFonts.Helvetica, 'Arial,Bold': StandardFonts.HelveticaBold, TimesNewRoman: StandardFonts.TimesRoman,
  CourierNew: StandardFonts.Courier,
};

const standardWidths = new Map<string, (code: number) => number | undefined>();
function standardWidth(base: string): ((code: number) => number | undefined) | undefined {
  const std = STANDARD[base.replace(/^[A-Z]{6}\+/, '')];
  if (!std) return undefined;
  let fn = standardWidths.get(std);
  if (!fn) {
    const embedder = StandardFontEmbedder.for(std as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
    const names = new Map<number, string>();
    const enc = embedder.encoding;
    for (const cp of enc.supportedCodePoints) {
      const g = enc.encodeUnicodeCodePoint(cp);
      if (!names.has(g.code)) names.set(g.code, g.name);
    }
    fn = (code) => {
      const name = names.get(code);
      const w = name ? embedder.font.getWidthOfGlyph(name) : undefined;
      return typeof w === 'number' ? w : undefined;
    };
    standardWidths.set(std, fn);
  }
  return fn;
}

function numberAt(doc: PDFDocument, obj: PDFObject | undefined): number | undefined {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}
function arrayOf(doc: PDFDocument, obj: PDFObject | undefined): PDFArray | undefined {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFArray ? v : undefined;
}
function nameOf(doc: PDFDocument, obj: PDFObject | undefined): string {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFName ? v.decodeText() : '';
}
const get = (d: PDFDict, key: string): PDFObject | undefined => d.get(PDFName.of(key));

function fontInfo(doc: PDFDocument, font: PDFDict | undefined): FontInfo {
  if (!font) return { twoByte: false, width: () => 500 };
  const subtype = nameOf(doc, get(font, 'Subtype'));
  if (subtype === 'Type0') {
    const desc = arrayOf(doc, get(font, 'DescendantFonts'));
    const cid = desc ? dictOf(doc, desc.get(0)) : undefined;
    const dw = (cid && numberAt(doc, get(cid, 'DW'))) ?? 1000;
    const widths = new Map<number, number>();
    const w = cid ? arrayOf(doc, get(cid, 'W')) : undefined;
    if (w) {
      const items = w.asArray().map((o) => (o instanceof PDFRef ? doc.context.lookup(o) : o));
      for (let k = 0; k < items.length;) {
        const first = items[k] instanceof PDFNumber ? (items[k] as PDFNumber).asNumber() : NaN;
        const next = items[k + 1];
        if (next instanceof PDFArray) {
          next.asArray().forEach((v, j) => { const n = numberAt(doc, v); if (n !== undefined) widths.set(first + j, n); });
          k += 2;
        } else {
          const last = next instanceof PDFNumber ? next.asNumber() : NaN;
          const val = numberAt(doc, items[k + 2]) ?? dw;
          if (Number.isFinite(first) && Number.isFinite(last) && last - first < 65536) for (let c = first; c <= last; c++) widths.set(c, val);
          k += 3;
        }
      }
    }
    return { twoByte: true, width: (c) => widths.get(c) ?? dw };
  }
  const first = numberAt(doc, get(font, 'FirstChar')) ?? 0;
  const widths = arrayOf(doc, get(font, 'Widths'));
  const descriptor = dictOf(doc, get(font, 'FontDescriptor'));
  const missing = (descriptor && numberAt(doc, get(descriptor, 'MissingWidth'))) ?? undefined;
  let scale = 1;
  if (subtype === 'Type3') {
    const fm = arrayOf(doc, get(font, 'FontMatrix'));
    const a = fm ? numberAt(doc, fm.get(0)) : undefined;
    scale = (a ?? 0.001) * 1000;
  }
  const std = standardWidth(nameOf(doc, get(font, 'BaseFont')));
  return {
    twoByte: false,
    width: (c) => {
      if (widths) {
        const n = numberAt(doc, widths.get(c - first));
        if (n !== undefined && c >= first) return n * scale;
      }
      return std?.(c) ?? missing ?? 500;
    },
  };
}

/* ───────── resources: read, and add a private copy when something changes ───────── */

class Resources {
  private own: PDFDict | undefined;
  changed = false;
  private counter = 0;
  constructor(private readonly doc: PDFDocument, private readonly base: PDFDict | undefined) {}

  get dict(): PDFDict | undefined { return this.own ?? this.base; }

  sub(kind: string, name: string): PDFObject | undefined {
    const d = this.dict ? dictOf(this.doc, get(this.dict, kind)) : undefined;
    return d?.get(PDFName.of(name));
  }

  /** Registers `ref` as a new XObject and returns its name. */
  addXObject(ref: PDFRef): string {
    if (!this.own) {
      this.own = this.base ? this.base.clone(this.doc.context) : this.doc.context.obj({});
      const x = this.base ? dictOf(this.doc, get(this.base, 'XObject')) : undefined;
      this.own.set(PDFName.of('XObject'), x ? x.clone(this.doc.context) : this.doc.context.obj({}));
    }
    const x = dictOf(this.doc, get(this.own, 'XObject'))!;
    let name: string;
    do name = `Rd${++this.counter}`; while (x.has(PDFName.of(name)));
    x.set(PDFName.of(name), ref);
    this.changed = true;
    return name;
  }

  /**
   * Drops the XObjects the rewritten stream no longer draws, so a replaced original (the image
   * before its pixels were cleared, the form before its text was removed) is not kept reachable.
   */
  prune(content: string): void {
    if (!this.own) return;
    const used = new Set(tokenizeContent(content).filter((o) => o.op === 'Do' && o.args[0]?.k === 'name').map((o) => (o.args[0] as { v: string }).v));
    const x = dictOf(this.doc, get(this.own, 'XObject'));
    if (!x) return;
    for (const key of x.keys()) if (!used.has(key.decodeText())) x.delete(key);
  }
}

/* ───────── the interpreter ───────── */

interface TextState { font: FontInfo | undefined; fs: number; tc: number; tw: number; th: number; tl: number; rise: number }
interface GState { ctm: M; text: TextState }

interface Ctx {
  doc: PDFDocument;
  areas: Rect[];
  scan: boolean;
  depth: number;
  report: RedactReport;
  /** Glyphs found in an area (the scan mode's answer). */
  found: number;
  fonts: Map<PDFDict, FontInfo>;
  decodeImage?: RedactOptions['decodeImage'];
}

const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);

/** Rewrites one content stream; returns null when nothing had to change. */
async function processStream(src: string, ctm0: M, res: Resources, ctx: Ctx): Promise<string | null> {
  const ops = tokenizeContent(src);
  const out: string[] = [];
  let changed = false;
  let gs: GState = { ctm: ctm0, text: { font: undefined, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 } };
  const stack: GState[] = [];
  let tm: M = IDENTITY;
  let tlm: M = IDENTITY;
  /** Path under construction: its source ops and its points in user space. */
  let path: Op[] = [];
  let pts: [number, number][] = [];
  let clip = false;
  /** Output indices of open marked-content operators, and whether each lost a glyph. */
  const marked: { at: number; op: Op; tainted: boolean }[] = [];

  const raw = (o: Op): string => src.slice(o.start, o.end);
  const nums = (o: Op): number[] => o.args.map((a) => (a.k === 'num' ? a.v : 0));
  const cloneGs = (g: GState): GState => ({ ctm: g.ctm, text: { ...g.text } });

  const show = (elements: Tok[]): Tok[] | null => {
    const t = gs.text;
    const font = t.font ?? { twoByte: false, width: () => 500 };
    const result: Tok[] = [];
    let removed = 0;
    let pending = 0; // accumulated TJ adjustment for removed glyphs
    let run: number[] = [];
    const flush = (): void => {
      if (run.length) { result.push({ k: 'str', v: run }); run = []; }
    };
    const pushAdjust = (): void => {
      if (pending !== 0) { flush(); result.push({ k: 'num', v: pending }); pending = 0; }
    };
    for (const el of elements) {
      if (el.k === 'num') {
        pushAdjust();
        flush();
        result.push(el);
        tm = mul([1, 0, 0, 1, (-el.v / 1000) * t.fs * t.th, 0], tm);
        continue;
      }
      if (el.k !== 'str') continue;
      const bytes = el.v;
      const step = font.twoByte ? 2 : 1;
      for (let k = 0; k < bytes.length; k += step) {
        const c = font.twoByte ? (bytes[k] << 8) | (bytes[k + 1] ?? 0) : bytes[k];
        const w0 = font.width(c) / 1000;
        const trm = mul([t.fs * t.th, 0, 0, t.fs, 0, t.rise], mul(tm, gs.ctm));
        const box = boundsOf(trm, 0, -0.25, w0, 0.85);
        const tx = (w0 * t.fs + t.tc + (!font.twoByte && c === 32 ? t.tw : 0)) * t.th;
        const degenerate = box.x1 - box.x0 < 1e-6 || box.y1 - box.y0 < 1e-6;
        const hit = degenerate ? ctx.areas.some((a) => pointIn(box.x0, box.y0, a)) : glyphHit(box, ctx.areas);
        if (hit) {
          removed++;
          const denom = t.fs * t.th;
          pending += denom ? -(tx * 1000) / denom : 0;
        } else {
          if (pending !== 0) pushAdjust();
          run.push(...bytes.slice(k, k + step));
        }
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    }
    pushAdjust();
    flush();
    if (!removed) return null;
    ctx.found += removed;
    ctx.report.glyphs += removed;
    for (const m of marked) m.tainted = true;
    return result;
  };

  const tjText = (items: Tok[]): string => `[${items.map((i) => (i.k === 'str' ? hexString(i.v) : tokText(i))).join(' ')}] TJ`;

  for (const o of ops) {
    const a = nums(o);
    switch (o.op) {
      case 'q': stack.push(cloneGs(gs)); break;
      case 'Q': gs = stack.pop() ?? gs; break;
      case 'cm': if (a.length === 6) gs.ctm = mul(a as M, gs.ctm); break;
      case 'BT': tm = IDENTITY; tlm = IDENTITY; break;
      case 'Tc': gs.text.tc = a[0] ?? 0; break;
      case 'Tw': gs.text.tw = a[0] ?? 0; break;
      case 'Tz': gs.text.th = (a[0] ?? 100) / 100; break;
      case 'TL': gs.text.tl = a[0] ?? 0; break;
      case 'Ts': gs.text.rise = a[0] ?? 0; break;
      case 'Tf': {
        const name = o.args[0]?.k === 'name' ? o.args[0].v : '';
        const fontDict = dictOf(ctx.doc, res.sub('Font', name));
        let info = fontDict ? ctx.fonts.get(fontDict) : undefined;
        if (!info) { info = fontInfo(ctx.doc, fontDict); if (fontDict) ctx.fonts.set(fontDict, info); }
        gs.text.font = info;
        gs.text.fs = a[1] ?? 0;
        break;
      }
      case 'Td': tlm = mul([1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0], tlm); tm = tlm; break;
      case 'TD': gs.text.tl = -(a[1] ?? 0); tlm = mul([1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0], tlm); tm = tlm; break;
      case 'Tm': if (a.length === 6) { tlm = a as M; tm = tlm; } break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -gs.text.tl], tlm); tm = tlm; break;
      case 'BDC': case 'BMC': marked.push({ at: out.length, op: o, tainted: false }); break;
      case 'EMC': {
        const m = marked.pop();
        if (m?.tainted && m.op.op === 'BDC' && !ctx.scan) {
          const props = m.op.args[1];
          if (props?.k === 'dict') {
            const kept: Tok[] = [];
            for (let k = 0; k + 1 < props.v.length; k += 2) {
              const key = props.v[k];
              if (key.k === 'name' && (key.v === 'ActualText' || key.v === 'Alt' || key.v === 'E')) continue;
              kept.push(key, props.v[k + 1]);
            }
            out[m.at] = `${tokText(m.op.args[0])} <<${kept.map(tokText).join(' ')}>> BDC`;
            changed = true;
          }
        }
        break;
      }
      default: break;
    }

    // text showing
    if (o.op === 'Tj' || o.op === 'TJ' || o.op === "'" || o.op === '"') {
      let pre = '';
      let elements: Tok[] = [];
      if (o.op === "'" || o.op === '"') {
        if (o.op === '"') { gs.text.tw = a[0] ?? 0; gs.text.tc = a[1] ?? 0; pre = `${numText(gs.text.tw)} Tw ${numText(gs.text.tc)} Tc `; }
        tlm = mul([1, 0, 0, 1, 0, -gs.text.tl], tlm);
        tm = tlm;
        pre += 'T* ';
      }
      const operand = o.args[o.args.length - 1];
      if (operand?.k === 'arr') elements = operand.v;
      else if (operand?.k === 'str') elements = [operand];
      const next = show(elements);
      if (next && !ctx.scan) { out.push(pre + tjText(next)); changed = true; } else out.push(raw(o));
      continue;
    }

    // paths
    if (PATH_OPS.has(o.op)) {
      path.push(o);
      const ctm = gs.ctm;
      if (o.op === 're' && a.length === 4) {
        const [x, y, w, h] = a;
        pts.push(apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x, y + h), apply(ctm, x + w, y + h));
      } else {
        for (let k = 0; k + 1 < a.length; k += 2) pts.push(apply(ctm, a[k], a[k + 1]));
      }
      continue;
    }
    if (o.op === 'W' || o.op === 'W*') { clip = true; path.push(o); continue; }
    if (PAINT_OPS.has(o.op)) {
      const text = [...path, o].map(raw).join('\n');
      const current = path;
      const hadClip = clip;
      const points = pts;
      path = []; pts = []; clip = false;
      if (o.op === 'n' || !points.length || ctx.scan) { out.push(text); continue; }
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      const bb: Rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      const touching = ctx.areas.filter((r) => intersects(bb, r) || (bb.x0 === bb.x1 && bb.y0 === bb.y1 && pointIn(bb.x0, bb.y0, r)));
      if (!touching.length) { out.push(text); continue; }
      changed = true;
      if (touching.some((r) => inside(bb, r))) {
        ctx.report.paths++;
        // keep a clipping path's effect, drop the painting
        out.push(hadClip ? [...current.map(raw), 'n'].join('\n') : '');
        continue;
      }
      const inv = invert(gs.ctm);
      if (hadClip || !inv) {
        // a clip that also paints, or a degenerate matrix: keep the clip, drop the painting
        ctx.report.paths++;
        out.push(hadClip ? [...current.map(raw), 'n'].join('\n') : '');
        continue;
      }
      ctx.report.pathsClipped++;
      const big = 1e5;
      const clips = touching.map((r) => `${-big} ${-big} ${2 * big} ${2 * big} re ${numText(r.x0)} ${numText(r.y0)} ${numText(r.x1 - r.x0)} ${numText(r.y1 - r.y0)} re W* n`);
      out.push(`q ${inv.map(numText).join(' ')} cm ${clips.join(' ')} ${gs.ctm.map(numText).join(' ')} cm\n${text}\nQ`);
      continue;
    }

    // images and forms
    if (o.op === 'Do') {
      const name = o.args[0]?.k === 'name' ? o.args[0].v : '';
      const ref = res.sub('XObject', name);
      const xobj = ref instanceof PDFRef ? ctx.doc.context.lookup(ref) : ref;
      if (!(xobj instanceof PDFStream)) { out.push(raw(o)); continue; }
      const subtype = nameOf(ctx.doc, get(xobj.dict, 'Subtype'));
      if (subtype === 'Image') {
        const bb = boundsOf(gs.ctm, 0, 0, 1, 1);
        const touching = ctx.areas.filter((r) => intersects(bb, r));
        if (!touching.length || ctx.scan) { out.push(raw(o)); continue; }
        changed = true;
        ctx.report.images++;
        if (touching.some((r) => inside(bb, r))) { out.push(''); continue; }
        const edited = await redactImage(ctx, xobj, gs.ctm);
        if (edited) {
          ctx.report.imagesEdited++;
          out.push(`/${res.addXObject(ctx.doc.context.register(edited))} Do`);
        } else out.push('');
        continue;
      }
      if (subtype === 'Form' && ctx.depth < 8) {
        const matrix = arrayOf(ctx.doc, get(xobj.dict, 'Matrix'));
        const fm = (matrix && matrix.size() === 6 ? matrix.asArray().map((v) => numberAt(ctx.doc, v) ?? 0) : IDENTITY) as M;
        const bbox = arrayOf(ctx.doc, get(xobj.dict, 'BBox'))?.asArray().map((v) => numberAt(ctx.doc, v) ?? 0) ?? [];
        const full = mul(fm, gs.ctm);
        const bb = bbox.length === 4 ? boundsOf(full, bbox[0], bbox[1], bbox[2], bbox[3]) : null;
        if (bb && !ctx.areas.some((r) => intersects(bb, r))) { out.push(raw(o)); continue; }
        const formRes = new Resources(ctx.doc, dictOf(ctx.doc, get(xobj.dict, 'Resources')) ?? res.dict);
        const inner = new TextDecoder('latin1').decode(streamBytes(xobj) ?? new Uint8Array());
        ctx.depth++;
        const next = await processStream(inner, full, formRes, ctx);
        ctx.depth--;
        if (next === null || ctx.scan) { out.push(raw(o)); continue; }
        const dict = xobj.dict.clone(ctx.doc.context);
        for (const k of ['Filter', 'DecodeParms', 'Length']) dict.delete(PDFName.of(k));
        formRes.prune(next);
        if (formRes.changed && formRes.dict) dict.set(PDFName.of('Resources'), formRes.dict);
        const copy = ctx.doc.context.flateStream(latin1Bytes(next));
        for (const [k, v] of dict.entries()) copy.dict.set(k, v);
        changed = true;
        out.push(`/${res.addXObject(ctx.doc.context.register(copy))} Do`);
        continue;
      }
      out.push(raw(o));
      continue;
    }
    if (o.op === 'BI') {
      const bb = boundsOf(gs.ctm, 0, 0, 1, 1);
      if (!ctx.scan && ctx.areas.some((r) => intersects(bb, r))) { ctx.report.images++; changed = true; out.push(''); continue; }
      out.push(raw(o));
      continue;
    }
    if (path.length) {
      // an operator in the middle of a path (not allowed by the spec): keep it as written
      out.push(...path.map(raw));
      path = []; pts = []; clip = false;
    }
    out.push(raw(o));
  }
  if (path.length) out.push(...path.map(raw));
  return changed ? out.filter((s) => s !== '').join('\n') : null;
}

/* ───────── images ───────── */

function streamBytes(stream: PDFStream): Uint8Array | null {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    return stream.getContents();
  } catch {
    return null;
  }
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let k = 0; k < text.length; k++) out[k] = text.charCodeAt(k) & 255;
  return out;
}

function componentsOf(doc: PDFDocument, cs: PDFObject | undefined): number {
  const v = cs instanceof PDFRef ? doc.context.lookup(cs) : cs;
  if (v instanceof PDFName) return ({ DeviceGray: 1, G: 1, DeviceRGB: 3, RGB: 3, DeviceCMYK: 4, CMYK: 4 } as Record<string, number>)[v.decodeText()] ?? 0;
  if (v instanceof PDFArray) {
    const kind = nameOf(doc, v.get(0));
    if (kind === 'Indexed' || kind === 'I') return 1;
    if (kind === 'ICCBased') {
      const s = v.lookup(1);
      return s instanceof PDFStream ? numberAt(doc, get(s.dict, 'N')) ?? 0 : 0;
    }
    if (kind === 'CalRGB' || kind === 'Lab') return 3;
    if (kind === 'CalGray') return 1;
  }
  return 0;
}

/**
 * The same image with every pixel inside an area set to zero, as a new Flate stream — or null
 * when the pixels cannot be read here (then the caller drops the whole image).
 */
async function redactImage(ctx: Ctx, image: PDFStream, ctm: M): Promise<PDFRawStream | null> {
  const d = image.dict;
  const doc = ctx.doc;
  const width = numberAt(doc, get(d, 'Width')) ?? 0;
  const height = numberAt(doc, get(d, 'Height')) ?? 0;
  if (!width || !height || width * height > 40e6) return null;
  const filterObj = get(d, 'Filter');
  const filterArr = arrayOf(doc, filterObj);
  const filters = filterArr ? filterArr.asArray().map((f) => nameOf(doc, f)) : filterObj ? [nameOf(doc, filterObj)] : [];
  const imageMask = get(d, 'ImageMask')?.toString() === 'true';
  const bpc = numberAt(doc, get(d, 'BitsPerComponent')) ?? 8;
  let pixels: Uint8Array | null = null;
  let comps = 0;
  let colorSpace: PDFObject | undefined = get(d, 'ColorSpace');
  const hasParams = !!get(d, 'DecodeParms');
  if (!imageMask && bpc === 8 && !hasParams && filters.every((f) => f === 'FlateDecode' || f === 'Fl')) {
    comps = componentsOf(doc, colorSpace);
    const data = comps ? streamBytes(image) : null;
    if (data && data.length >= width * height * comps) pixels = data.slice(0, width * height * comps);
  } else if (!imageMask && ctx.decodeImage && filters.length === 1 && (filters[0] === 'DCTDecode' || filters[0] === 'JPXDecode') && image instanceof PDFRawStream) {
    try {
      const decoded = await ctx.decodeImage(image.contents, filters[0]);
      if (decoded && decoded.width === width && decoded.height === height) {
        comps = 3;
        colorSpace = PDFName.of('DeviceRGB');
        pixels = new Uint8Array(width * height * 3);
        for (let p = 0, q = 0; p < width * height; p++, q += 4) {
          pixels[p * 3] = decoded.data[q]; pixels[p * 3 + 1] = decoded.data[q + 1]; pixels[p * 3 + 2] = decoded.data[q + 2];
        }
      }
    } catch {
      pixels = null;
    }
  }
  if (!pixels || !comps) return null;
  // a pixel is cleared when any part of it lies in an area (strict overlap, so a pixel that
  // only touches the edge is kept)
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const px = boundsOf(ctm, i / width, 1 - (j + 1) / height, (i + 1) / width, 1 - j / height);
      if (ctx.areas.some((r) => intersects(px, r))) pixels.fill(0, (j * width + i) * comps, (j * width + i + 1) * comps);
    }
  }
  const out = doc.context.flateStream(pixels, {
    Type: 'XObject', Subtype: 'Image', Width: width, Height: height, BitsPerComponent: 8,
  });
  if (colorSpace) out.dict.set(PDFName.of('ColorSpace'), colorSpace);
  for (const k of ['SMask', 'Intent', 'Interpolate']) { const v = get(d, k); if (v) out.dict.set(PDFName.of(k), v); }
  if (filters[0] !== 'DCTDecode' && filters[0] !== 'JPXDecode') { const dec = get(d, 'Decode'); if (dec) out.dict.set(PDFName.of('Decode'), dec); }
  return out;
}

/* ───────── pages, annotations, clean-up ───────── */

function pageSource(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  const parts = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return parts.map((p) => {
    const s = p instanceof PDFRef ? doc.context.lookup(p) : p;
    return s instanceof PDFStream ? new TextDecoder('latin1').decode(streamBytes(s) ?? new Uint8Array()) : '';
  }).join('\n');
}

function annotRect(doc: PDFDocument, annot: PDFDict): Rect | null {
  const r = arrayOf(doc, get(annot, 'Rect'))?.asArray().map((v) => numberAt(doc, v) ?? NaN) ?? [];
  if (r.length !== 4 || r.some((v) => !Number.isFinite(v))) return null;
  return { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) };
}

function annotationsTouching(doc: PDFDocument, page: PDFPage, areas: Rect[]): PDFObject[] {
  const annots = arrayOf(doc, page.node.get(PDFName.of('Annots')));
  if (!annots) return [];
  return annots.asArray().filter((o) => {
    const d = dictOf(doc, o);
    const r = d ? annotRect(doc, d) : null;
    return !!r && areas.some((a) => intersects(r, a));
  });
}

/** Deletes every indirect object the document no longer reaches from its trailer. */
export function collectGarbage(doc: PDFDocument): number {
  const ctx = doc.context;
  const seen = new Set<string>();
  const todo: PDFObject[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt].filter((o): o is PDFObject => !!o);
  while (todo.length) {
    const o = todo.pop()!;
    if (o instanceof PDFRef) {
      const key = o.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const v = ctx.lookup(o);
      if (v) todo.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) todo.push(v);
    } else if (o instanceof PDFArray) {
      todo.push(...o.asArray());
    } else if (o instanceof PDFStream) {
      todo.push(o.dict);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) { ctx.delete(ref); removed++; }
  }
  return removed;
}

function groupAreas(areas: readonly RedactionArea[], pageCount: number): Map<number, Rect[]> {
  const byPage = new Map<number, Rect[]>();
  for (const a of areas) {
    if (!Number.isInteger(a.page) || a.page < 0 || a.page >= pageCount) throw new Error(`page ${a.page + 1} is outside the document`);
    if (![a.x, a.y, a.width, a.height].every(Number.isFinite) || a.width <= 0 || a.height <= 0) throw new Error('bad area');
    const list = byPage.get(a.page) ?? [];
    list.push(rectOfBox(a));
    byPage.set(a.page, list);
  }
  return byPage;
}

function newCtx(doc: PDFDocument, areas: Rect[], scan: boolean, decodeImage?: RedactOptions['decodeImage']): Ctx {
  return {
    doc, areas, scan, depth: 0, found: 0, fonts: new Map(), decodeImage,
    report: { glyphs: 0, paths: 0, pathsClipped: 0, images: 0, imagesEdited: 0, annotations: 0, fieldsFlattened: false },
  };
}

/**
 * Counts the glyphs that still sit inside the given areas (0 after a redaction). Used to verify
 * the output, and handy for a "what would be removed" preview.
 */
export async function glyphsInAreas(bytes: Uint8Array, areas: readonly RedactionArea[]): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const byPage = groupAreas(areas, doc.getPageCount());
  let total = 0;
  for (const [index, rects] of byPage) {
    const page = doc.getPage(index);
    const ctx = newCtx(doc, rects, true);
    await processStream(pageSource(doc, page), IDENTITY, new Resources(doc, page.node.Resources()), ctx);
    total += ctx.found;
  }
  return total;
}

/** Applies the redactions: removes the content in every area, paints the boxes, cleans up. */
export async function applyRedactions(
  bytes: Uint8Array, areas: readonly RedactionArea[], opts: RedactOptions = {},
): Promise<RedactResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  if (!areas.length) return { ok: false, code: 'unknown', detail: 'no areas to redact' };
  const fill = colorOf(opts.fill ?? '#000000');
  if (!fill) return { ok: false, code: 'unknown', detail: 'bad fill colour' };
  const doc = loaded.doc;
  let byPage: Map<number, Rect[]>;
  try {
    byPage = groupAreas(areas, doc.getPageCount());
  } catch (error) {
    return { ok: false, code: 'unknown', detail: error instanceof Error ? error.message : String(error) };
  }
  const report = newCtx(doc, [], false).report;
  let out: Uint8Array;
  try {
    // A form field in an area: flatten the form first, so its value becomes page content that
    // the pass below can remove (a widget alone would leave the value in the field dictionary).
    const widgetHit = [...byPage].some(([index, rects]) => annotationsTouching(doc, doc.getPage(index), rects)
      .some((o) => nameOf(doc, get(dictOf(doc, o)!, 'Subtype')) === 'Widget'));
    if (widgetHit) {
      doc.getForm().flatten({ updateFieldAppearances: true });
      report.fieldsFlattened = true;
    }
    for (const [index, rects] of byPage) {
      const page = doc.getPage(index);
      const ctx = newCtx(doc, rects, false, opts.decodeImage);
      ctx.report = report;
      const res = new Resources(doc, page.node.Resources());
      const src = pageSource(doc, page);
      const next = (await processStream(src, IDENTITY, res, ctx)) ?? src;
      res.prune(next);
      if (res.changed && res.dict) page.node.set(PDFName.of('Resources'), res.dict);
      const boxes = rects.map((r) => `${numText(r.x0)} ${numText(r.y0)} ${numText(r.x1 - r.x0)} ${numText(r.y1 - r.y0)} re f`).join('\n');
      const content = `q\n${next}\nQ\nq ${numText(fill.r)} ${numText(fill.g)} ${numText(fill.b)} rg\n${boxes}\nQ\n`;
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(latin1Bytes(content))));
      const touching = annotationsTouching(doc, page, rects);
      if (touching.length) {
        const annots = arrayOf(doc, page.node.get(PDFName.of('Annots')))!;
        const drop = new Set(touching.map((o) => o.toString()));
        const kept = annots.asArray().filter((o) => {
          if (drop.has(o.toString())) return false;
          const parent = dictOf(doc, o) ? get(dictOf(doc, o)!, 'Parent') : undefined;
          return !(parent && drop.has(parent.toString()));
        });
        report.annotations += annots.size() - kept.length;
        page.node.set(PDFName.of('Annots'), doc.context.obj(kept));
      }
    }
    collectGarbage(doc);
    out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  } catch (error) {
    const refusal = refusalFromError(error);
    return { ok: false, code: refusal.code, detail: refusal.detail };
  }
  // verify: same page count, and no glyph left in any area
  try {
    const again = await PDFDocument.load(out, { updateMetadata: false });
    if (again.getPageCount() !== loaded.info.pageCount) return { ok: false, code: 'unknown', detail: 'page count changed' };
    const left = await glyphsInAreas(out, areas);
    if (left) return { ok: false, code: 'unknown', detail: `${left} glyph(s) still in the redacted areas` };
    for (const [index, rects] of byPage) {
      if (annotationsTouching(again, again.getPage(index), rects).length) return { ok: false, code: 'unknown', detail: 'an annotation is still in a redacted area' };
    }
  } catch (error) {
    return { ok: false, code: 'unknown', detail: `reload failed: ${refusalFromError(error).code}` };
  }
  return {
    ok: true, bytes: out, report,
    verified: `pages=${loaded.info.pageCount} glyphs=${report.glyphs} images=${report.images} paths=${report.paths + report.pathsClipped} annots=${report.annotations}`,
  };
}
