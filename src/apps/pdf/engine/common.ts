/**
 * PDF engine — shared plumbing (الأساس المشترك لمحرك الكتابة).
 *
 * Every engine operation has the same life as the ones in `pdfdoc.ts`: open the bytes with
 * `loadPdf` (same refusals), change the document, save, RE-OPEN the produced bytes and check
 * what was promised. `runOp` is that life in one place; an operation only supplies the edit and
 * the check. Nothing here touches the DOM.
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString,
  decodePDFRawStream, type PDFObject, type PDFPage,
} from 'pdf-lib';
import { parseHexColor, refusalFromError, type PdfRefusalCode, type Rgb } from '../ops';
import { loadPdf, type OpResult } from '../pdfdoc';

/** A refusal thrown from inside an edit: it becomes `{ ok: false, code, detail }`, never a crash. */
export class EngineRefusal extends Error {
  constructor(readonly code: PdfRefusalCode, readonly detail: string) {
    super(detail);
    this.name = 'EngineRefusal';
  }
}

/** A rectangle in PDF user space: the unrotated page, origin bottom-left. */
export interface Box { x: number; y: number; width: number; height: number }

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The shared operation life. `edit` changes the document and may return a short note;
 * `verify` gets the RE-LOADED document and returns the list of broken promises (empty = ok).
 * The page count must survive every engine operation.
 */
export async function runOp(
  bytes: Uint8Array,
  edit: (doc: PDFDocument) => Promise<string | void> | string | void,
  verify: (doc: PDFDocument) => string[],
  saveOptions: { updateFieldAppearances?: boolean } = {},
): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  const doc = loaded.doc;
  let note = '';
  let out: Uint8Array;
  try {
    note = (await edit(doc)) || '';
    out = await doc.save({ useObjectStreams: false, ...saveOptions });
  } catch (error) {
    if (error instanceof EngineRefusal) return { ok: false, code: error.code, detail: error.detail };
    const refusal = refusalFromError(error);
    return { ok: false, code: refusal.code, detail: refusal.detail };
  }
  let reloaded: PDFDocument;
  try {
    reloaded = await PDFDocument.load(out, { updateMetadata: false });
  } catch (error) {
    return { ok: false, code: 'unknown', detail: `reload failed: ${refusalFromError(error).code}` };
  }
  const bad: string[] = [];
  if (reloaded.getPageCount() !== loaded.info.pageCount) bad.push(`pageCount ${reloaded.getPageCount()} != ${loaded.info.pageCount}`);
  try {
    bad.push(...verify(reloaded));
  } catch (error) {
    bad.push(`verify threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bad.length) return { ok: false, code: 'unknown', detail: bad.join('; ') };
  return { ok: true, bytes: out, verified: `pages=${reloaded.getPageCount()}${note ? ` ${note}` : ''}` };
}

/** The page, or a refusal naming the 1-based page the owner sees. */
export function checkPage(doc: PDFDocument, index: number): PDFPage {
  if (!Number.isInteger(index) || index < 0 || index >= doc.getPageCount()) {
    throw new EngineRefusal('unknown', `page ${index + 1} is outside the document`);
  }
  return doc.getPage(index);
}

/**
 * `'#rrggbb'` (or `#rgb`) → channels, or null. Unlike `ops.parseHexColor` (2 decimals, fine for
 * drawing) this keeps 4 decimals, so a colour written and read back is the same `#rrggbb`.
 */
export function colorOf(value: string | null | undefined): Rgb | null {
  if (typeof value !== 'string' || !parseHexColor(value)) return null;
  const hex = value.trim().replace(/^#/, '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const ch = (at: number): number => Math.round((parseInt(full.slice(at, at + 2), 16) / 255) * 10000) / 10000;
  return { r: ch(0), g: ch(2), b: ch(4) };
}

export function requireColor(value: string | null | undefined, what = 'color'): Rgb {
  const c = colorOf(value);
  if (!c) throw new EngineRefusal('unknown', `bad ${what}: ${String(value)}`);
  return c;
}

/** Channels (0..1) → `'#rrggbb'`. */
export function hexOf(c: Rgb): string {
  const h = (v: number): string => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function clamp01(n: number | undefined, fallback = 1): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

/** A decoded stream's text (content streams are deflated when pdf-lib saves). */
export function streamText(doc: PDFDocument, obj: PDFObject | undefined): string {
  const stream = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (stream instanceof PDFRawStream) {
    try {
      return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
    } catch {
      return '';
    }
  }
  if (stream instanceof PDFStream) {
    try {
      return new TextDecoder('latin1').decode(stream.getContents());
    } catch {
      return '';
    }
  }
  return '';
}

/** A page's content streams, decoded and joined. */
export function pageContent(doc: PDFDocument, index: number): string {
  const page = doc.getPage(index);
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return refs.map((ref) => streamText(doc, ref)).join('\n');
}

/** Numbers of a PDF array (refs resolved), or [] when it is not an array of numbers. */
export function numbersOf(doc: PDFDocument, obj: PDFObject | undefined): number[] {
  const arr = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (!(arr instanceof PDFArray)) return [];
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.lookup(i);
    if (v instanceof PDFNumber) out.push(v.asNumber());
  }
  return out;
}

/** A PDF text string (literal or hex, PDFDocEncoding or UTF-16) → JS string. */
export function textOf(obj: PDFObject | undefined): string {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      return obj.decodeText();
    } catch {
      return '';
    }
  }
  if (obj instanceof PDFName) return obj.decodeText();
  return '';
}

/** Any JS string → the PDF text string readers expect (UTF-16 hex when it is not plain ASCII). */
export function pdfText(value: string): PDFString | PDFHexString {
  return /^[\x20-\x7e]*$/.test(value) ? PDFString.of(value.replace(/[\\()]/g, (c) => `\\${c}`)) : PDFHexString.fromText(value);
}

/** `[llx lly urx ury]` → Box, normalised so width/height are positive. */
export function boxOfRect(nums: number[]): Box | null {
  if (nums.length < 4) return null;
  const [a, b, c, d] = nums;
  return { x: Math.min(a, c), y: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
}

export function validBox(b: Box | undefined | null): b is Box {
  return !!b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0;
}

/** Resolve a dict entry that may be a ref. */
export function dictOf(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | undefined {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFDict ? v : undefined;
}

/** Format a number for a content stream: short, no exponent. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * The matrix that maps "view space" — the page as the reader SHOWS it (after `/Rotate`, crop box
 * origin at bottom-left) — to user space. Page furniture (watermarks, headers, page numbers)
 * is laid out in view space so it stands upright on a rotated page.
 */
export function viewToUser(page: PDFPage): { matrix: [number, number, number, number, number, number]; width: number; height: number } {
  const crop = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const { x, y, width: w, height: h } = crop;
  switch (rot) {
    case 90: return { matrix: [0, 1, -1, 0, x + w, y], width: h, height: w };
    case 180: return { matrix: [-1, 0, 0, -1, x + w, y + h], width: w, height: h };
    case 270: return { matrix: [0, -1, 1, 0, x, y + h], width: h, height: w };
    default: return { matrix: [1, 0, 0, 1, x, y], width: w, height: h };
  }
}
