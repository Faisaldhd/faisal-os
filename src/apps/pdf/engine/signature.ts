/**
 * PDF engine — signatures (التوقيع: مرسوم باليد أو مكتوب، كمتجهات لا كصورة).
 *
 * A drawn signature arrives as strokes of pad pixels (origin top-left, y down, like a canvas).
 * It is smoothed (Catmull-Rom through every sample → cubic Béziers) and written as VECTOR
 * content in a form XObject placed at the target rect — sharp at any zoom, a few KB, and no
 * raster. Pen pressure, when present, varies the width per segment (round caps hide the joins).
 *
 * A typed signature is text in a signature style (Times Italic for Latin, the Arabic font for
 * Arabic), fitted into the rect.
 *
 * The saved-signature library is a small JSON model the app keeps in the VFS.
 */
import {
  PDFName, StandardFonts, drawObject, popGraphicsState, pushGraphicsState, type PDFDocument,
} from 'pdf-lib';
import { HOME } from '../../../kernel/types';
import type { Rgb } from '../ops';
import type { OpResult } from '../pdfdoc';
import { checkPage, num, pageContent, requireColor, runOp, validBox, type Box } from './common';
import { catmullRom, pathOperators, simplify, type Point, type PressurePoint } from './geometry';
import { blockOperators, embedTextFonts, fontResources, layoutLine } from './text';

/* ───────────────────────────── geometry (pure) ───────────────────────────── */

export interface PadTransform { scale: number; dx: number; dy: number; padHeight: number }

/**
 * Pad pixels → PDF points inside `rect`: uniform scale (the signature is never stretched),
 * centred, and y flipped (pad y grows down, PDF y grows up).
 */
export function padTransform(padWidth: number, padHeight: number, rect: Box): PadTransform {
  const scale = Math.min(rect.width / padWidth, rect.height / padHeight);
  return {
    scale,
    dx: rect.x + (rect.width - padWidth * scale) / 2,
    dy: rect.y + (rect.height - padHeight * scale) / 2,
    padHeight,
  };
}

export function toPage(t: PadTransform, p: Point): Point {
  return { x: t.dx + p.x * t.scale, y: t.dy + (t.padHeight - p.y) * t.scale };
}

/** Width multiplier for a pressure sample: 0.5× at no pressure … 1.5× at full; 1× when unknown. */
export function pressureFactor(p: number | undefined): number {
  return typeof p === 'number' && Number.isFinite(p) ? 0.5 + Math.max(0, Math.min(1, p)) : 1;
}

/**
 * The vector drawing of a signature, as content-stream text in page space: smoothed strokes,
 * round caps and joins. `width` is in pad pixels and scales with the strokes, so the page shows
 * the same weight the pad did.
 */
export function signatureOperators(strokes: readonly (readonly PressurePoint[])[], padWidth: number, padHeight: number, rect: Box, color: Rgb, width: number): string {
  const t = padTransform(padWidth, padHeight, rect);
  const lineWidth = Math.max(0.1, width * t.scale);
  const out: string[] = [`${num(color.r)} ${num(color.g)} ${num(color.b)} RG`, '1 J 1 j', `${num(lineWidth)} w`];
  for (const stroke of strokes) {
    const pts = simplify(stroke, 1);
    if (!pts.length) continue;
    const page = pts.map((p) => toPage(t, p));
    const path = catmullRom(page);
    if (!path) continue;
    const hasPressure = pts.some((p) => typeof p.p === 'number');
    if (!hasPressure || !path.segments.length) {
      out.push(pathOperators(path), 'S');
      continue;
    }
    // Pressure: each segment is stroked on its own, at the mean pressure of its two ends.
    let from = path.start;
    path.segments.forEach((seg, i) => {
      const w = lineWidth * pressureFactor(((pts[i].p ?? 0.5) + (pts[i + 1]?.p ?? pts[i].p ?? 0.5)) / 2);
      out.push(`${num(w)} w`, pathOperators({ start: from, segments: [seg] }), 'S');
      from = seg.to;
    });
  }
  return out.join('\n');
}

/* ───────────────────────────── drawn signature ───────────────────────────── */

export interface DrawnSignatureInput {
  /** 0-based page index. */
  page: number;
  /** Target box in PDF user space. */
  rect: Box;
  /** Strokes in pad pixels (origin top-left); `p` = optional pressure 0..1. */
  strokes: PressurePoint[][];
  padWidth: number;
  padHeight: number;
  color: string;
  /** Pen width in pad pixels. */
  width: number;
}

/** Places a vector form XObject on the page with `Do`, then proves it on reload. */
async function placeForm(doc: PDFDocument, pageIndex: number, content: string, rect: Box, resources: Record<string, unknown>): Promise<void> {
  const page = checkPage(doc, pageIndex);
  const ctx = doc.context;
  const stream = ctx.flateStream(content, {
    Type: 'XObject', Subtype: 'Form', FormType: 1,
    BBox: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Resources: resources as never,
  });
  const ref = ctx.register(stream);
  const key = page.node.newXObject('Sig', ref);
  page.pushOperators(pushGraphicsState(), drawObject(key), popGraphicsState());
}

function verifyDo(pageIndex: number, before: () => number): (doc: PDFDocument) => string[] {
  return (doc) => {
    const content = pageContent(doc, pageIndex);
    const bad: string[] = [];
    if (content.length <= before()) bad.push('page content did not grow');
    if (!/\/Sig\S*\s+Do/.test(content)) bad.push('signature is not invoked on the page');
    const xobjects = doc.getPage(pageIndex).node.Resources()?.lookup(PDFName.of('XObject'));
    if (!xobjects) bad.push('no XObject resources');
    return bad;
  };
}

/**
 * A drawn signature as vector content. Refuses an empty drawing, a bad pad size or an empty
 * target box.
 */
export async function drawnSignature(bytes: Uint8Array, input: DrawnSignatureInput): Promise<OpResult> {
  if (!(input.padWidth > 0) || !(input.padHeight > 0)) return { ok: false, code: 'unknown', detail: 'bad pad size' };
  if (!validBox(input.rect)) return { ok: false, code: 'unknown', detail: 'bad rect' };
  const points = input.strokes.reduce((n, s) => n + s.length, 0);
  if (!points) return { ok: false, code: 'unknown', detail: 'empty signature' };
  let before = 0;
  return runOp(bytes, async (doc) => {
    checkPage(doc, input.page);
    const color = requireColor(input.color);
    before = pageContent(doc, input.page).length;
    const content = signatureOperators(input.strokes, input.padWidth, input.padHeight, input.rect, color, input.width > 0 ? input.width : 2);
    await placeForm(doc, input.page, content, input.rect, {});
    return `signature strokes=${input.strokes.length}`;
  }, verifyDo(input.page, () => before));
}

/* ───────────────────────────── typed signature ───────────────────────────── */

export interface TypedSignatureInput {
  page: number;
  rect: Box;
  text: string;
  color: string;
}

/**
 * A typed signature fitted into the rect (one line, centred). Latin uses Times Italic; Arabic
 * needs `font` (the Arabic font bytes) and is shaped like all engine text.
 */
export async function typedSignature(bytes: Uint8Array, input: TypedSignatureInput, font?: Uint8Array): Promise<OpResult> {
  if (!input.text.trim()) return { ok: false, code: 'unknown', detail: 'emptyText' };
  if (!validBox(input.rect)) return { ok: false, code: 'unknown', detail: 'bad rect' };
  let before = 0;
  return runOp(bytes, async (doc) => {
    checkPage(doc, input.page);
    const color = requireColor(input.color);
    before = pageContent(doc, input.page).length;
    const text = input.text.trim().replace(/\s*\n\s*/g, ' ');
    const fonts = await embedTextFonts(doc, text, font, StandardFonts.TimesRomanItalic);
    const { dict, keys } = fontResources(fonts);
    const probe = layoutLine(fonts, text, 10);
    const r = input.rect;
    const size = Math.max(4, Math.min(r.height * 0.7, probe.width > 0 ? (10 * r.width * 0.96) / probe.width : r.height * 0.7));
    const block = blockOperators(fonts, keys, text, {
      x: r.x, y: r.y + r.height / 2 - size * 0.3, size, color, maxWidth: r.width, align: 'center',
    });
    await placeForm(doc, input.page, block.ops.map((o) => o.toString()).join('\n'), r, { Font: dict });
    return 'typed signature';
  }, verifyDo(input.page, () => before));
}

/* ───────────────────────────── saved signatures ───────────────────────────── */

export interface SavedSignature {
  id: string;
  name: string;
  kind: 'drawn' | 'typed';
  /** Drawn: strokes in pad pixels. */
  strokes?: PressurePoint[][];
  padWidth?: number;
  padHeight?: number;
  /** Typed: the text. */
  text?: string;
  color: string;
  width?: number;
  /** ISO date. */
  createdAt: string;
}

export interface SignatureLibrary { version: 1; items: SavedSignature[] }

/** Where the app keeps the library in the VFS (a suggestion; the caller owns the path). */
export const SIGNATURE_LIBRARY_PATH = `${HOME}/.config/pdf/signatures.json`;
export const MAX_SAVED_SIGNATURES = 20;

export function emptyLibrary(): SignatureLibrary {
  return { version: 1, items: [] };
}

/** Adds (newest first) or replaces by id; keeps at most `MAX_SAVED_SIGNATURES`. Pure. */
export function addSignature(lib: SignatureLibrary, sig: SavedSignature): SignatureLibrary {
  const items = [sig, ...lib.items.filter((s) => s.id !== sig.id)].slice(0, MAX_SAVED_SIGNATURES);
  return { version: 1, items };
}

export function removeSignature(lib: SignatureLibrary, id: string): SignatureLibrary {
  return { version: 1, items: lib.items.filter((s) => s.id !== id) };
}

/** Rounds stroke coordinates to 0.1 px to keep the JSON small. */
export function serializeLibrary(lib: SignatureLibrary): string {
  const r = (n: number): number => Math.round(n * 10) / 10;
  return JSON.stringify({
    version: 1,
    items: lib.items.map((s) => ({
      ...s,
      strokes: s.strokes?.map((st) => st.map((p) => (typeof p.p === 'number' ? { x: r(p.x), y: r(p.y), p: Math.round(p.p * 100) / 100 } : { x: r(p.x), y: r(p.y) }))),
    })),
  });
}

/**
 * Reads the library JSON. Anything malformed is dropped item by item (a damaged entry never
 * costs the owner the others); unreadable JSON gives an empty library.
 */
export function parseLibrary(json: string): SignatureLibrary {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptyLibrary();
  }
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) return emptyLibrary();
  const out: SavedSignature[] = [];
  for (const it of items) {
    const s = it as Partial<SavedSignature>;
    if (!s || typeof s.id !== 'string' || typeof s.color !== 'string' || (s.kind !== 'drawn' && s.kind !== 'typed')) continue;
    const base = { id: s.id, name: typeof s.name === 'string' ? s.name : '', color: s.color, createdAt: typeof s.createdAt === 'string' ? s.createdAt : '' };
    if (s.kind === 'typed') {
      if (typeof s.text !== 'string' || !s.text.trim()) continue;
      out.push({ ...base, kind: 'typed', text: s.text });
      continue;
    }
    if (!Array.isArray(s.strokes) || !(Number(s.padWidth) > 0) || !(Number(s.padHeight) > 0)) continue;
    const strokes = s.strokes
      .filter(Array.isArray)
      .map((st) => (st as PressurePoint[]).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => (typeof p.p === 'number' && Number.isFinite(p.p) ? { x: p.x, y: p.y, p: p.p } : { x: p.x, y: p.y })))
      .filter((st) => st.length);
    if (!strokes.length) continue;
    out.push({ ...base, kind: 'drawn', strokes, padWidth: Number(s.padWidth), padHeight: Number(s.padHeight), width: Number(s.width) > 0 ? Number(s.width) : 2 });
  }
  return { version: 1, items: out.slice(0, MAX_SAVED_SIGNATURES) };
}
