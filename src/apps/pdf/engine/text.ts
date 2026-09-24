/**
 * PDF engine — Unicode text layout and drawing (رسم النص العربي والمختلط داخل PDF).
 *
 * One code path draws text for everything the engine writes: added text, FreeText and stamp
 * annotations, watermarks, headers/footers and typed signatures.
 *
 * How a line is drawn:
 *   logical text → `shapeArabic` → `reorderClusters` (visual order, marks kept after their base)
 *   → each cluster is given a font: the embedded Unicode font when it has the glyph, else the
 *   standard Latin font (Helvetica by default) when WinAnsi can encode it, else a refusal
 *   → glyphs are encoded ONE BY ONE, so fontkit's own layout never re-orders them (it reverses
 *   runs it believes are right-to-left, which would undo the bidi pass)
 *   → marks (tashkeel) are centred on their base with a TJ offset and lifted with `Ts` so they
 *   clear tall letters and stack (shadda + fatha), because without GPOS the font cannot do it.
 * Each line is wrapped in `/Span << /ActualText (logical text) >> BDC … EMC`, so copy and search
 * in Acrobat / Chrome return the text as it was typed.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFOperator, PDFOperatorNames as Ops,
  StandardFonts, beginText, endText, popGraphicsState, pushGraphicsState, setFillingRgbColor, setFontAndSize,
  setGraphicsState, setTextMatrix, type PDFFont, type PDFPage, type PDFRef,
} from 'pdf-lib';
import type { Rgb } from '../ops';
import { unsupportedWatermarkChars } from '../ops';
import { baseDirection, bidiClass, isTransparentMark, reorderClusters, shapeArabic, type Direction } from './arabic';
import { EngineRefusal } from './common';

/* ───────────────────────────── fonts ───────────────────────────── */

interface FkGlyph { advanceWidth: number; bbox: { minX: number; minY: number; maxX: number; maxY: number } }
interface FkFont {
  unitsPerEm: number;
  hasGlyphForCodePoint(cp: number): boolean;
  glyphForCodePoint(cp: number): FkGlyph;
}
interface Fontkit { create(bytes: Uint8Array): FkFont }

let fontkitPromise: Promise<Fontkit> | null = null;

/** `@pdf-lib/fontkit` is only loaded when a Unicode font is really embedded. */
export function loadFontkit(): Promise<Fontkit> {
  if (!fontkitPromise) {
    fontkitPromise = import('@pdf-lib/fontkit').then((mod) => {
      const m = mod as unknown as { default?: Fontkit } & Fontkit;
      return (m.default && typeof m.default.create === 'function' ? m.default : m) as Fontkit;
    });
  }
  return fontkitPromise;
}

export interface TextFonts {
  doc: PDFDocument;
  latin: PDFFont;
  unicode?: { pdf: PDFFont; fk: FkFont; upem: number };
}

/** WinAnsi-encodable (what the standard fonts can draw). */
function isWinAnsi(ch: string): boolean {
  return unsupportedWatermarkChars(ch).length === 0;
}

/**
 * Embeds what `text` needs: always the standard Latin font (no file, every reader has it),
 * plus the Unicode font — subset to the glyphs used — only when the text holds a character
 * the standard font cannot encode. Without the font bytes such text is refused honestly.
 */
export async function embedTextFonts(
  doc: PDFDocument,
  text: string,
  fontBytes?: Uint8Array | null,
  latin: StandardFonts = StandardFonts.Helvetica,
): Promise<TextFonts> {
  const fonts: TextFonts = { doc, latin: await doc.embedFont(latin) };
  const needs = [...text.replace(/[\r\n\t]/g, '')].some((ch) => !isWinAnsi(ch));
  if (!needs) return fonts;
  if (!fontBytes || !fontBytes.length) {
    const bad = unsupportedWatermarkChars(text.replace(/[\r\n\t]/g, ''));
    throw new EngineRefusal('textNotRenderable', `needs the Unicode font: ${bad.join(' ')}`);
  }
  const fontkit = await loadFontkit();
  doc.registerFontkit(fontkit as never);
  const fk = fontkit.create(fontBytes);
  const pdf = await doc.embedFont(fontBytes, { subset: true });
  fonts.unicode = { pdf, fk, upem: fk.unitsPerEm || 1000 };
  return fonts;
}

/* ───────────────────────────── layout ───────────────────────────── */

/** One glyph as drawn: which font, its hex code, and the TJ offset (thousandths of an em) before it. */
interface Piece { font: 'u' | 'l'; hex: string; adjust: number; rise: number }

export interface LineLayout {
  logical: string;
  rtl: boolean;
  /** Advance width in points. */
  width: number;
  pieces: Piece[];
  size: number;
}

const hexOf = (h: PDFHexString): string => h.toString().replace(/^<|>$/g, '');

/**
 * Lays out one logical line. Throws `textNotRenderable` naming the characters no font can draw.
 */
export function layoutLine(fonts: TextFonts, line: string, size: number, direction: Direction = 'auto'): LineLayout {
  const dir = direction === 'auto' ? baseDirection(line, 'ltr') : direction;
  const clusters = reorderClusters(shapeArabic(line), dir);
  const pieces: Piece[] = [];
  const missing: string[] = [];
  const u = fonts.unicode;
  const scale = u ? size / u.upem : 0;
  let width = 0;
  for (const cluster of clusters) {
    const chars = [...cluster.text];
    const base = chars[0];
    const cp = base.codePointAt(0) ?? 0;
    const cls = bidiClass(cp);
    // Latin letters prefer the Latin font; everything else prefers the Unicode font.
    const preferLatin = cls === 'L' && isWinAnsi(base);
    const inUnicode = !!u && u.fk.hasGlyphForCodePoint(cp);
    let baseAdv = 0;
    let baseGlyph: FkGlyph | null = null;
    if ((inUnicode && !preferLatin) || (inUnicode && !isWinAnsi(base))) {
      const pf = u as NonNullable<typeof u>;
      baseGlyph = pf.fk.glyphForCodePoint(cp);
      baseAdv = baseGlyph.advanceWidth * scale;
      pieces.push({ font: 'u', hex: hexOf(pf.pdf.encodeText(base)), adjust: 0, rise: 0 });
    } else if (isWinAnsi(base)) {
      baseAdv = fonts.latin.widthOfTextAtSize(base, size);
      pieces.push({ font: 'l', hex: hexOf(fonts.latin.encodeText(base)), adjust: 0, rise: 0 });
    } else {
      if (!missing.includes(base)) missing.push(base);
      continue;
    }
    // Marks: centred on the base, lifted clear of it, stacked when there are several.
    let above = 0;
    let below = 0;
    let pen = baseAdv; // pen position relative to the base's start, in points
    for (const mark of chars.slice(1)) {
      const mcp = mark.codePointAt(0) ?? 0;
      if (!u || !u.fk.hasGlyphForCodePoint(mcp) || !isTransparentMark(mcp)) {
        if (!u || !u.fk.hasGlyphForCodePoint(mcp)) {
          if (!missing.includes(mark)) missing.push(mark);
        }
        continue;
      }
      const g = u.fk.glyphForCodePoint(mcp);
      const inkW = (g.bbox.maxX - g.bbox.minX) * scale;
      const origin = (baseAdv - inkW) / 2 - g.bbox.minX * scale;
      const gap = u.upem * 0.06;
      let riseUnits = 0;
      if ((g.bbox.minY + g.bbox.maxY) / 2 >= 0) {
        const top = baseGlyph ? baseGlyph.bbox.maxY : u.upem * 0.72;
        riseUnits = Math.max(0, top + gap - g.bbox.minY) + above;
        above += g.bbox.maxY - g.bbox.minY + gap;
      } else {
        const bottom = baseGlyph ? Math.min(0, baseGlyph.bbox.minY) : 0;
        riseUnits = Math.min(0, bottom - gap - g.bbox.maxY) - below;
        below += g.bbox.maxY - g.bbox.minY + gap;
      }
      pieces.push({
        font: 'u',
        hex: hexOf(u.pdf.encodeText(mark)),
        adjust: (-(origin - pen) * 1000) / size,
        rise: riseUnits * scale,
      });
      pen = origin + g.advanceWidth * scale;
    }
    if (Math.abs(pen - baseAdv) > 1e-6) {
      // Put the pen back at the end of the base: a bare TJ offset, no glyph.
      pieces.push({ font: 'u', hex: '', adjust: (-(baseAdv - pen) * 1000) / size, rise: 0 });
    }
    width += baseAdv;
  }
  if (missing.length) throw new EngineRefusal('textNotRenderable', `no glyph for: ${missing.join(' ')}`);
  return { logical: line, rtl: dir === 'rtl', width, pieces, size };
}

/** Greedy word wrap on spaces, measured with the real layout. Explicit newlines always break. */
export function wrapLines(fonts: TextFonts, text: string, size: number, maxWidth: number | undefined, direction: Direction = 'auto'): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!maxWidth || maxWidth <= 0) { out.push(para); continue; }
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || layoutLine(fonts, candidate, size, direction).width <= maxWidth) line = candidate;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/* ───────────────────────────── operators ───────────────────────────── */

export interface FontKeys { u?: PDFName; l: PDFName }

/** Registers the fonts in a resource dictionary through `add(tag, ref) → key`. */
export function registerFonts(fonts: TextFonts, add: (tag: string, ref: PDFRef) => PDFName): FontKeys {
  const keys: FontKeys = { l: add('FL', fonts.latin.ref) };
  if (fonts.unicode) keys.u = add('FU', fonts.unicode.pdf.ref);
  return keys;
}

/** A Resources /Font dictionary for a form XObject (annotation appearances). */
export function fontResources(fonts: TextFonts): { dict: PDFDict; keys: FontKeys } {
  const ctx = fonts.doc.context;
  const dict = ctx.obj({});
  const keys = registerFonts(fonts, (tag, ref) => {
    const name = PDFName.of(tag);
    dict.set(name, ref);
    return name;
  });
  return { dict, keys };
}

/** The text-showing operators for one laid-out line with its baseline start at (x, y). */
export function lineOperators(doc: PDFDocument, layout: LineLayout, keys: FontKeys, x: number, y: number): PDFOperator[] {
  const ops: PDFOperator[] = [];
  const ctx = doc.context;
  ops.push(PDFOperator.of(Ops.BeginMarkedContentSequence, [
    // PDFDict serialises inline (`<< … >>`); pdf-lib's arg type just does not list it.
    PDFName.of('Span'), ctx.obj({ ActualText: PDFHexString.fromText(layout.logical) }) as unknown as PDFArray,
  ]));
  ops.push(beginText(), setTextMatrix(1, 0, 0, 1, round3(x), round3(y)));
  let font: 'u' | 'l' | null = null;
  let rise = 0;
  let arr: PDFArray | null = null;
  const flush = (): void => {
    if (arr && arr.size()) ops.push(PDFOperator.of(Ops.ShowTextAdjusted, [arr]));
    arr = null;
  };
  for (const p of layout.pieces) {
    if (p.font !== font) {
      flush();
      const key = p.font === 'u' ? keys.u : keys.l;
      if (!key) throw new EngineRefusal('unknown', 'font key missing');
      ops.push(setFontAndSize(key, layout.size));
      font = p.font;
    }
    // A pure pen offset (no glyph) does not care about the rise; a glyph does.
    if (p.hex && Math.abs(p.rise - rise) > 1e-6) {
      flush();
      ops.push(PDFOperator.of(Ops.SetTextRise, [PDFNumber.of(round3(p.rise))]));
      rise = p.rise;
    }
    if (!arr) arr = PDFArray.withContext(ctx);
    if (Math.abs(p.adjust) > 1e-6) arr.push(PDFNumber.of(round3(p.adjust)));
    if (p.hex) arr.push(PDFHexString.of(p.hex));
  }
  flush();
  if (rise !== 0) ops.push(PDFOperator.of(Ops.SetTextRise, [PDFNumber.of(0)]));
  ops.push(endText(), PDFOperator.of(Ops.EndMarkedContent));
  return ops;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export type Align = 'left' | 'right' | 'center' | 'auto';

export interface BlockOptions {
  /** Left edge of the block. */
  x: number;
  /** Baseline of the first line. */
  y: number;
  size: number;
  color: Rgb;
  direction?: Direction;
  /** Wrap width; also the width the lines are aligned in. */
  maxWidth?: number;
  lineHeight?: number;
  /** 'auto' = right for right-to-left paragraphs, left otherwise. */
  align?: Align;
}

export interface Block { ops: PDFOperator[]; width: number; height: number; lines: LineLayout[] }

/** Lays out and emits a whole block of (possibly multi-line, possibly wrapped) text. */
export function blockOperators(fonts: TextFonts, keys: FontKeys, text: string, o: BlockOptions): Block {
  const lineHeight = o.lineHeight ?? o.size * 1.35;
  const logical = wrapLines(fonts, text, o.size, o.maxWidth, o.direction);
  const lines = logical.map((l) => layoutLine(fonts, l, o.size, o.direction));
  const width = o.maxWidth ?? Math.max(0, ...lines.map((l) => l.width));
  const ops: PDFOperator[] = [setFillingRgbColor(o.color.r, o.color.g, o.color.b)];
  lines.forEach((line, i) => {
    const align = o.align && o.align !== 'auto' ? o.align : line.rtl ? 'right' : 'left';
    const dx = align === 'right' ? width - line.width : align === 'center' ? (width - line.width) / 2 : 0;
    if (line.pieces.length) ops.push(...lineOperators(fonts.doc, line, keys, o.x + dx, o.y - i * lineHeight));
  });
  return { ops, width, height: lines.length * lineHeight, lines };
}

/** An ExtGState with the given fill/stroke opacity (and optional blend mode). */
export function opacityState(doc: PDFDocument, opacity: number, blend?: string): PDFDict {
  const dict: Record<string, unknown> = { Type: 'ExtGState', ca: opacity, CA: opacity };
  if (blend) dict.BM = blend;
  return doc.context.obj(dict as never) as unknown as PDFDict;
}

/** Draws a text block on a page as new content (fonts and opacity registered on the page). */
export function drawTextBlock(page: PDFPage, fonts: TextFonts, text: string, o: BlockOptions & { opacity?: number }): Block {
  const keys = registerFonts(fonts, (tag, ref) => page.node.newFontDictionary(tag, ref));
  const block = blockOperators(fonts, keys, text, o);
  const ops: PDFOperator[] = [pushGraphicsState()];
  if (o.opacity !== undefined && o.opacity < 1) {
    ops.push(setGraphicsState(page.node.newExtGState('GS', opacityState(fonts.doc, o.opacity))));
  }
  ops.push(...block.ops, popGraphicsState());
  page.pushOperators(...ops);
  return block;
}
