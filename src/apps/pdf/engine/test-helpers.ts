/**
 * Test-only helpers for the engine tests (not imported by app code).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, type PDFObject } from 'pdf-lib';
import type { OpResult } from '../pdfdoc';

let cached: Uint8Array | null = null;

/** The bundled Arabic font, read from disk (the browser path is `loadArabicFont`). */
export function arabicFontBytes(): Uint8Array {
  if (!cached) cached = new Uint8Array(readFileSync(resolve(process.cwd(), 'src/apps/pdf/engine/fonts/NotoNaskhArabic-Regular.ttf')));
  return cached;
}

export async function blankPdf(pages = 1, size: [number, number] = [595, 842]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage(size);
  return doc.save();
}

export function okBytes(r: OpResult): Uint8Array {
  if (!r.ok) throw new Error(`operation failed: ${r.code} ${r.detail}`);
  return r.bytes;
}

export async function annotDicts(bytes: Uint8Array, page = 0): Promise<{ doc: PDFDocument; dicts: PDFDict[] }> {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(page).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  const dicts = annots ? annots.asArray().map((o) => doc.context.lookup(o) as PDFDict) : [];
  return { doc, dicts };
}

export function get(doc: PDFDocument, dict: PDFDict, key: string): PDFObject | undefined {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFRef ? doc.context.lookup(v) : v;
}

/** 1×1 red PNG. */
export const TINY_PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
), (c) => c.charCodeAt(0));
