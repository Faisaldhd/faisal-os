/**
 * PDF app — the pdf-lib half (الطبقة التي تنفّذ العمليات فعلاً).
 *
 * Every operation here ends in `finish()`: the new bytes are re-opened with pdf-lib and
 * compared against what the operation promised. A page count, a rotation, a crop box, a
 * page size or a metadata field that does not match makes the operation FAIL — the app
 * never reports success for bytes it has not read back.
 */
import { PDFArray, PDFDocument, StandardFonts, degrees, rgb, type PDFPage } from 'pdf-lib';
import {
  checkOpenable, checkWatermark, cropBoxFor, deletePages as deleteFromOrder, imagePageLayout,
  normalizeRotation, refusalFromError, rotatePages as rotateOrder, sniff, watermarkAnchor,
  type ImagePageMode, type Margins, type PdfRefusalCode, type Rect, type Size, type WatermarkOptions,
} from './ops';

const round = (n: number): number => Math.round(n * 100) / 100;
const TOLERANCE = 0.6;

export interface PageInfo {
  width: number;
  height: number;
  rotation: number;
  crop: Rect;
}

export interface DocInfo {
  pageCount: number;
  pages: PageInfo[];
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
}

export type LoadResult =
  | { ok: true; doc: PDFDocument; info: DocInfo }
  | { ok: false; code: PdfRefusalCode; detail: string };

export type OpResult =
  | { ok: true; bytes: Uint8Array; verified: string }
  | { ok: false; code: PdfRefusalCode; detail: string };

/* ───────────────────────────── reading ───────────────────────────── */

function text(fn: () => unknown): string {
  try {
    const value = fn();
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  } catch {
    return '';
  }
}

function cropOf(page: PDFPage): Rect {
  try {
    const box = page.getCropBox();
    return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function infoOf(doc: PDFDocument): DocInfo {
  return {
    pageCount: doc.getPageCount(),
    pages: doc.getPages().map((page) => {
      const size = page.getSize();
      return {
        width: round(size.width),
        height: round(size.height),
        rotation: normalizeRotation(page.getRotation().angle),
        crop: cropOf(page),
      };
    }),
    title: text(() => doc.getTitle()),
    author: text(() => doc.getAuthor()),
    subject: text(() => doc.getSubject()),
    keywords: text(() => doc.getKeywords()),
    creator: text(() => doc.getCreator()),
    producer: text(() => doc.getProducer()),
  };
}

/**
 * How many content streams a page carries. pdf-lib's `Contents()` returns a `PDFArray`
 * (not a JS array), and drawing adds one stream — plus the graphics-state pair pdf-lib
 * wraps an already-normalised page with. The count is only ever used as "did anything get
 * added", which is why it is compared before and after rather than hard-coded.
 */
function contentsCount(page: PDFPage): number {
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) return contents.size();
  return contents ? 1 : 0;
}

/**
 * Opens a PDF. Refuses empty files, non-PDF bytes, encrypted documents and files the
 * parser cannot read — each with the code that carries its own bilingual message.
 */
export async function loadPdf(bytes: Uint8Array): Promise<LoadResult> {
  if (bytes.length === 0) return { ok: false, code: 'empty', detail: 'zero bytes' };
  const early = checkOpenable(bytes);
  if (early) return { ok: false, code: early, detail: `no %PDF- header (sniffed ${sniff(bytes)})` };
  try {
    // updateMetadata:false — opening a document must not rewrite its Producer/ModDate
    // behind the owner's back. Metadata changes only happen through the metadata form.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const info = infoOf(doc);
    // pdf-lib happily parses some truncated files into a document with no pages. There is
    // nothing this app can do with one, so it is a refusal, not an empty success.
    if (info.pageCount === 0) return { ok: false, code: 'corrupt', detail: 'document has no pages' };
    return { ok: true, doc, info };
  } catch (error) {
    // EncryptedPDFError carries no `.name` in pdf-lib 1.17.1, so the refusal mapping
    // reads its message. A confirmation load with `ignoreEncryption` reports isEncrypted.
    const refusal = refusalFromError(error);
    if (refusal.code === 'encrypted') {
      const probe = await PDFDocument.load(bytes, { ignoreEncryption: true }).catch(() => null);
      if (probe && !probe.isEncrypted) return { ok: false, code: 'corrupt', detail: refusal.detail };
    }
    return { ok: false, code: refusal.code, detail: refusal.detail };
  }
}

/* ─────────────────────────── verification ─────────────────────────── */

export interface OutputExpectation {
  pageCount?: number;
  /** 0-based page index → absolute rotation in degrees. */
  rotations?: Record<number, number>;
  /** 0-based page index → expected crop box. */
  cropBoxes?: Record<number, Rect>;
  /** 0-based page index → expected page size. */
  pageSizes?: Record<number, Size>;
  metadata?: { title?: string; author?: string; subject?: string; keywords?: string };
  /** 0-based page index → the least number of content streams the page must have. */
  minContents?: Record<number, number>;
}

export interface VerifyResult { ok: boolean; summary: string; mismatches: string[] }

const keywordSet = (value: string): string[] => value.split(/[\s,]+/).filter(Boolean).sort();

/** Re-opens the produced bytes and checks the promise the operation made. */
export async function verifyOutput(bytes: Uint8Array, expect: OutputExpectation): Promise<VerifyResult> {
  const bad: string[] = [];
  const notes: string[] = [];
  if (!bytes.length) return { ok: false, summary: '', mismatches: ['zero bytes'] };

  let info: DocInfo;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
    info = infoOf(doc);
  } catch (error) {
    const refusal = refusalFromError(error);
    return { ok: false, summary: '', mismatches: [`reload failed: ${refusal.code}`] };
  }

  if (expect.pageCount !== undefined) {
    notes.push(`pages=${info.pageCount}`);
    if (info.pageCount !== expect.pageCount) bad.push(`pageCount ${info.pageCount} != ${expect.pageCount}`);
  }
  for (const [key, wanted] of Object.entries(expect.rotations ?? {})) {
    const i = Number(key);
    const actual = info.pages[i]?.rotation;
    notes.push(`rot[${i}]=${actual}`);
    if (actual !== wanted) bad.push(`rotation[${i}] ${actual} != ${wanted}`);
  }
  for (const [key, wanted] of Object.entries(expect.cropBoxes ?? {})) {
    const i = Number(key);
    const actual = info.pages[i]?.crop;
    if (!actual) { bad.push(`crop[${i}] missing`); continue; }
    const same = Math.abs(actual.x - wanted.x) <= TOLERANCE && Math.abs(actual.y - wanted.y) <= TOLERANCE
      && Math.abs(actual.width - wanted.width) <= TOLERANCE && Math.abs(actual.height - wanted.height) <= TOLERANCE;
    notes.push(`crop[${i}]=${actual.width}x${actual.height}@${actual.x},${actual.y}`);
    if (!same) bad.push(`crop[${i}] ${actual.width}x${actual.height}@${actual.x},${actual.y} != ${wanted.width}x${wanted.height}@${wanted.x},${wanted.y}`);
  }
  for (const [key, wanted] of Object.entries(expect.pageSizes ?? {})) {
    const i = Number(key);
    const actual = info.pages[i];
    if (!actual) { bad.push(`size[${i}] missing`); continue; }
    const same = Math.abs(actual.width - wanted.width) <= TOLERANCE && Math.abs(actual.height - wanted.height) <= TOLERANCE;
    notes.push(`size[${i}]=${actual.width}x${actual.height}`);
    if (!same) bad.push(`size[${i}] ${actual.width}x${actual.height} != ${wanted.width}x${wanted.height}`);
  }
  if (expect.metadata) {
    const wanted = expect.metadata;
    if (wanted.title !== undefined && info.title !== wanted.title) bad.push(`title "${info.title}" != "${wanted.title}"`);
    if (wanted.author !== undefined && info.author !== wanted.author) bad.push(`author "${info.author}" != "${wanted.author}"`);
    if (wanted.subject !== undefined && info.subject !== wanted.subject) bad.push(`subject "${info.subject}" != "${wanted.subject}"`);
    if (wanted.keywords !== undefined
      && keywordSet(info.keywords).join(',') !== keywordSet(wanted.keywords).join(',')) {
      bad.push(`keywords "${info.keywords}" != "${wanted.keywords}"`);
    }
    notes.push(`title="${info.title}"`);
  }
  for (const [key, wanted] of Object.entries(expect.minContents ?? {})) {
    const i = Number(key);
    const page = doc.getPage(i);
    const actual = page ? contentsCount(page) : -1;
    notes.push(`contents[${i}]=${actual}`);
    if (actual < wanted) bad.push(`contents[${i}] ${actual} < ${wanted}`);
  }
  return { ok: bad.length === 0, summary: notes.join(' '), mismatches: bad };
}

/* ───────────────────────────── operations ───────────────────────────── */

const failed = (error: unknown): OpResult => {
  const refusal = refusalFromError(error);
  return { ok: false, code: refusal.code, detail: refusal.detail };
};

/** Saves, then proves the result before anyone is told it worked. */
async function finish(doc: PDFDocument, expect: OutputExpectation): Promise<OpResult> {
  let bytes: Uint8Array;
  try {
    // Object streams off: a wider set of readers can open the result, at the cost of size.
    bytes = await doc.save({ useObjectStreams: false });
  } catch (error) {
    return failed(error);
  }
  const check = await verifyOutput(bytes, expect);
  if (!check.ok) return { ok: false, code: 'unknown', detail: check.mismatches.join('; ') };
  return { ok: true, bytes, verified: check.summary };
}

function rotationsOf(info: DocInfo, indices: readonly number[]): Record<number, number> {
  const out: Record<number, number> = {};
  indices.forEach((page, at) => { out[at] = info.pages[page]?.rotation ?? 0; });
  return out;
}

function sizesOf(info: DocInfo, indices: readonly number[]): Record<number, Size> {
  const out: Record<number, Size> = {};
  indices.forEach((page, at) => {
    const p = info.pages[page];
    if (p) out[at] = { width: p.width, height: p.height };
  });
  return out;
}

/** Copies the given 0-based pages, in the given order, into a brand-new document. */
export async function extractPages(bytes: Uint8Array, pages: readonly number[]): Promise<OpResult> {
  const unique = [...new Set(pages)];
  if (!unique.length) return { ok: false, code: 'emptyResult', detail: 'no pages selected' };
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  if (unique.some((p) => p < 0 || p >= loaded.info.pageCount)) return { ok: false, code: 'unknown', detail: 'page out of range' };
  try {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(loaded.doc, unique);
    copied.forEach((page) => out.addPage(page));
    // Page sizes and rotations in the new order: a wrong order fails the check.
    return await finish(out, {
      pageCount: unique.length,
      rotations: rotationsOf(loaded.info, unique),
      pageSizes: sizesOf(loaded.info, unique),
    });
  } catch (error) {
    return failed(error);
  }
}

/** A copy of the document with the given 0-based pages removed. Zero pages left is refused, not written. */
export async function removePages(bytes: Uint8Array, pages: readonly number[]): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  const order = loaded.info.pages.map((_, i) => i);
  const kept = deleteFromOrder(order, pages);
  if (!kept.ok) {
    return { ok: false, code: 'emptyResult', detail: kept.error === 'allPages' ? 'every page removed' : 'no pages selected' };
  }
  if (kept.order.length === order.length) return { ok: false, code: 'emptyResult', detail: 'no pages selected' };
  return extractPages(bytes, kept.order);
}

/** `order` is a permutation of every 0-based page index, in the order the pages must end up. */
export async function reorderPages(bytes: Uint8Array, order: readonly number[]): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  const seen = new Set(order);
  if (order.length !== loaded.info.pageCount || seen.size !== order.length
    || order.some((p) => p < 0 || p >= loaded.info.pageCount)) {
    return { ok: false, code: 'unknown', detail: 'order is not a permutation of the pages' };
  }
  return extractPages(bytes, order);
}

/** Turns the given 0-based pages by `delta` degrees (90/180/270, negative allowed). */
export async function rotatePages(bytes: Uint8Array, pages: readonly number[], delta: number): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  const target = [...new Set(pages)].filter((p) => p >= 0 && p < loaded.info.pageCount);
  if (!target.length) return { ok: false, code: 'emptyResult', detail: 'no pages selected' };
  const doc = loaded.doc;
  for (const index of target) {
    const page = doc.getPage(index);
    page.setRotation(degrees(normalizeRotation(page.getRotation().angle + delta)));
  }
  const absolute = rotateOrder(loaded.info.pages.map((p) => p.rotation), target, delta);
  const rotations: Record<number, number> = {};
  absolute.forEach((value, i) => { rotations[i] = value; });
  return finish(doc, { pageCount: loaded.info.pageCount, rotations });
}

/** Sets the crop box on the given 0-based pages, cutting the given margins off each side. */
export async function cropPages(bytes: Uint8Array, pages: readonly number[], margins: Margins): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  const target = [...new Set(pages)].filter((p) => p >= 0 && p < loaded.info.pageCount);
  if (!target.length) return { ok: false, code: 'emptyResult', detail: 'no pages selected' };
  const boxes: Record<number, Rect> = {};
  const wanted: Record<number, Rect> = {};
  for (const index of target) {
    const box = cropBoxFor(loaded.info.pages[index], margins);
    if (!box.ok) return { ok: false, code: 'unknown', detail: `crop ${box.error}` };
    wanted[index] = box.box;
    boxes[index] = box.box;
  }
  const doc = loaded.doc;
  try {
    for (const index of target) doc.getPage(index).setCropBox(wanted[index].x, wanted[index].y, wanted[index].width, wanted[index].height);
  } catch (error) {
    return failed(error);
  }
  return finish(doc, { pageCount: loaded.info.pageCount, cropBoxes: boxes });
}

/**
 * Draws the watermark on the given pages. A page that reports no new content stream after
 * drawing is a failure, and every page is re-read from the produced bytes afterwards.
 */
export async function addWatermark(bytes: Uint8Array, pages: readonly number[], options: WatermarkOptions): Promise<OpResult> {
  const checked = checkWatermark(options);
  if (!checked.ok) {
    return { ok: false, code: checked.error === 'unsupportedChars' ? 'textNotRenderable' : 'unknown', detail: checked.error };
  }
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  const target = [...new Set(pages)].filter((p) => p >= 0 && p < loaded.info.pageCount);
  if (!target.length) return { ok: false, code: 'emptyResult', detail: 'no pages selected' };
  const doc = loaded.doc;
  const minContents: Record<number, number> = {};
  try {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const index of target) {
      const page = doc.getPage(index);
      const size = page.getSize();
      const textWidth = font.widthOfTextAtSize(options.text, options.size);
      const at = watermarkAnchor(size, textWidth, options.size, options.rotation);
      const before = contentsCount(page);
      page.drawText(options.text, {
        x: at.x,
        y: at.y,
        size: options.size,
        font,
        color: rgb(0.5, 0.5, 0.5),
        opacity: options.opacity,
        rotate: degrees(normalizeRotation(options.rotation)),
      });
      if (contentsCount(page) <= before) return { ok: false, code: 'unknown', detail: `watermark drew nothing on page ${index + 1}` };
      minContents[index] = before + 1;
    }
  } catch (error) {
    return failed(error);
  }
  return finish(doc, { pageCount: loaded.info.pageCount, rotations: rotationsOf(loaded.info, loaded.info.pages.map((_, i) => i)), minContents });
}

export interface MetadataInput { title: string; author: string; subject: string; keywords: string }

/** Writes the four fields the form owns; keywords are split on commas or spaces. */
export async function setMetadata(bytes: Uint8Array, meta: MetadataInput): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  const doc = loaded.doc;
  try {
    doc.setTitle(meta.title);
    doc.setAuthor(meta.author);
    doc.setSubject(meta.subject);
    doc.setKeywords(meta.keywords.split(/[\s,،]+/).filter(Boolean));
  } catch (error) {
    return failed(error);
  }
  return finish(doc, {
    pageCount: loaded.info.pageCount,
    metadata: { title: meta.title, author: meta.author, subject: meta.subject, keywords: meta.keywords },
  });
}

export interface ImageInput { name: string; bytes: Uint8Array }

/**
 * One image per page, PNG or JPEG only (pdf-lib cannot embed GIF/WebP/BMP).
 *
 * The type comes from the bytes, never the name, and the two refusals are kept apart: a
 * GIF is `imageUnsupported` ("not a PNG or JPEG"), while a file that carries a real PNG or
 * JPEG signature but a broken body is `imageBroken` — this is where @pdf-lib/upng throws a
 * bare `RangeError: Invalid typed array length`, which says nothing to the owner.
 */
export async function imagesToPdf(images: readonly ImageInput[], mode: ImagePageMode): Promise<OpResult> {
  if (!images.length) return { ok: false, code: 'emptyResult', detail: 'no images' };
  const out = await PDFDocument.create();
  const pageSizes: Record<number, Size> = {};
  for (const [index, image] of images.entries()) {
    const kind = sniff(image.bytes);
    if (kind !== 'png' && kind !== 'jpeg') return { ok: false, code: 'imageUnsupported', detail: `${image.name}: ${kind}` };
    try {
      const embedded = kind === 'png' ? await out.embedPng(image.bytes) : await out.embedJpg(image.bytes);
      const layout = imagePageLayout({ width: embedded.width, height: embedded.height }, mode);
      const page = out.addPage([layout.page.width, layout.page.height]);
      page.drawImage(embedded, { x: layout.x, y: layout.y, width: layout.width, height: layout.height });
      pageSizes[index] = layout.page;
    } catch (error) {
      const refusal = refusalFromError(error);
      return { ok: false, code: 'imageBroken', detail: `${image.name}: ${refusal.detail}` };
    }
  }
  return finish(out, { pageCount: images.length, pageSizes });
}

export interface MergeInput { name: string; bytes: Uint8Array }

/** Merges sources in the order of `plan` (see `buildMergePlan` in ops.ts). */
export async function mergePdfs(sources: readonly MergeInput[], plan: readonly { source: number; page: number }[]): Promise<OpResult> {
  if (!sources.length) return { ok: false, code: 'emptyResult', detail: 'no sources' };
  if (!plan.length) return { ok: false, code: 'emptyResult', detail: 'no pages in the plan' };
  const loaded: DocInfo[] = [];
  const docs: PDFDocument[] = [];
  for (const source of sources) {
    const one = await loadPdf(source.bytes);
    if (!one.ok) return { ok: false, code: one.code, detail: `${source.name}: ${one.detail}` };
    docs.push(one.doc);
    loaded.push(one.info);
  }
  try {
    const out = await PDFDocument.create();
    const rotations: Record<number, number> = {};
    const pageSizes: Record<number, Size> = {};
    let at = 0;
    for (const ref of plan) {
      const source = loaded[ref.source];
      if (!source || ref.page < 0 || ref.page >= source.pageCount) return { ok: false, code: 'unknown', detail: 'merge plan out of range' };
      const [copied] = await out.copyPages(docs[ref.source], [ref.page]);
      out.addPage(copied);
      rotations[at] = source.pages[ref.page].rotation;
      pageSizes[at] = { width: source.pages[ref.page].width, height: source.pages[ref.page].height };
      at++;
    }
    return await finish(out, { pageCount: plan.length, rotations, pageSizes });
  } catch (error) {
    return failed(error);
  }
}

/** Page count and sizes only — cheap enough to call after every edit. */
export async function readInfo(bytes: Uint8Array): Promise<LoadResult> {
  return loadPdf(bytes);
}
