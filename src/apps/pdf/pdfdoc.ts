/**
 * PDF app — the pdf-lib half (الطبقة التي تنفّذ العمليات فعلاً).
 *
 * Every operation here ends in `finish()`: the new bytes are re-opened with pdf-lib and
 * compared against what the operation promised. A page count, a rotation, a crop box, a
 * page size or a metadata field that does not match makes the operation FAIL — the app
 * never reports success for bytes it has not read back.
 */
import {
  PDFArray, PDFBool, PDFCheckBox, PDFDocument, PDFName, PDFRawStream, PDFTextField, StandardFonts,
  decodePDFRawStream, degrees, fill, popGraphicsState, pushGraphicsState, rectangle, rgb,
  setFillingRgbColor, type PDFField, type PDFPage,
} from 'pdf-lib';
import {
  checkAddedText, checkOpenable, checkWatermark, coverRectFor, cropBoxFor,
  deletePages as deleteFromOrder, duplicateOrder, imagePageLayout, normalizeRotation,
  parseHexColor, refusalFromError, rotatePages as rotateOrder, sniff, watermarkAnchor,
  type AddedText, type CoverRegion, type CoverShape, type ImagePageMode, type Margins,
  type PdfRefusalCode, type Rect, type Size, type TextFont, type WatermarkOptions,
} from './ops';

const round = (n: number): number => Math.round(n * 100) / 100;
const TOLERANCE = 0.6;

/** The standard fonts the window offers, mapped to what pdf-lib embeds by reference. */
const STANDARD_FONT: Record<TextFont, StandardFonts> = {
  helvetica: StandardFonts.Helvetica,
  helveticaBold: StandardFonts.HelveticaBold,
  timesRoman: StandardFonts.TimesRoman,
  timesRomanItalic: StandardFonts.TimesRomanItalic,
  courier: StandardFonts.Courier,
};

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
  /**
   * 0-based page index → a literal the page's DECODED content stream must contain. pdf-lib
   * deflates everything it draws, so a raw byte search would prove nothing; the literal is
   * an operator such as `Tj` (show text) or `re` (a rectangle).
   */
  contentContains?: Record<number, string>;
  /** AcroForm field name → the value the produced bytes must carry back. */
  formValues?: Record<string, { text?: string; checked?: boolean }>;
}

export interface VerifyResult { ok: boolean; summary: string; mismatches: string[] }

const keywordSet = (value: string): string[] => value.split(/[\s,]+/).filter(Boolean).sort();

/**
 * A page's content stream decoded back to text — the only way to see what was really drawn,
 * because pdf-lib compresses content streams when it saves. A stream the library cannot
 * inflate is skipped instead of guessed at, so a `contentContains` check can never pass on a
 * stream nobody read.
 */
function contentOf(doc: PDFDocument, index: number): string {
  const page = doc.getPage(index);
  if (!page) return '';
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  let out = '';
  for (const ref of refs) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    try {
      out += new TextDecoder().decode(decodePDFRawStream(stream).decode());
    } catch {
      // An undecodable stream says nothing about the operator, so it is not counted as proof.
    }
  }
  return out;
}

/** Is the field's own flag set? A malformed field answers "no" rather than breaking the read. */
function flag(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

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
  for (const [key, wanted] of Object.entries(expect.contentContains ?? {})) {
    const i = Number(key);
    const found = contentOf(doc, i).includes(wanted);
    notes.push(`content[${i}]${found ? '=' : '!'}${wanted}`);
    if (!found) bad.push(`content[${i}] lacks "${wanted}"`);
  }
  if (expect.formValues) {
    const wanted = expect.formValues;
    const acro = doc.catalog.getAcroForm();
    if (!acro) {
      bad.push('form is missing after filling');
    } else {
      const form = doc.getForm();
      for (const [name, want] of Object.entries(wanted)) {
        const field = form.getFieldMaybe(name);
        if (!field) { bad.push(`form field "${name}" missing`); continue; }
        if (want.text !== undefined) {
          const actual = field instanceof PDFTextField ? text(() => field.getText()) : '';
          notes.push(`field[${name}]="${actual}"`);
          if (actual !== want.text) bad.push(`field "${name}" "${actual}" != "${want.text}"`);
        }
        if (want.checked !== undefined) {
          const actual = field instanceof PDFCheckBox ? flag(() => field.isChecked()) : false;
          notes.push(`check[${name}]=${actual}`);
          if (actual !== want.checked) bad.push(`checkbox "${name}" ${actual} != ${want.checked}`);
        }
      }
    }
  }
  return { ok: bad.length === 0, summary: notes.join(' '), mismatches: bad };
}

/* ───────────────────────────── operations ───────────────────────────── */

const failed = (error: unknown): OpResult => {
  const refusal = refusalFromError(error);
  return { ok: false, code: refusal.code, detail: refusal.detail };
};

/**
 * Saves, then proves the result before anyone is told it worked.
 *
 * `saveOptions` exists for one case: pdf-lib's save() rebuilds every dirty form appearance
 * itself with Helvetica, which throws for a value those fonts cannot encode. When the form
 * operation has already handled a field like that (value written, `NeedAppearances` set), the
 * library's second pass must be skipped or the whole save would fail on a value that is
 * correctly written.
 */
async function finish(doc: PDFDocument, expect: OutputExpectation, saveOptions: { updateFieldAppearances?: boolean } = {}): Promise<OpResult> {
  let bytes: Uint8Array;
  try {
    // Object streams off: a wider set of readers can open the result, at the cost of size.
    bytes = await doc.save({ useObjectStreams: false, ...saveOptions });
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

/* ───────────────────────── added text ───────────────────────── */

export interface AddTextInput extends AddedText {
  /** 0-based page index. */
  page: number;
}

/**
 * Draws NEW text on one page with a standard font. Nothing already in the page is touched:
 * the text becomes an extra content stream drawn over the content, and the produced bytes are
 * re-read to prove the text-showing operator (`Tj`) really is there. Arabic is refused with
 * its own code before anything is written, because the standard fonts cannot encode it.
 */
export async function addText(bytes: Uint8Array, input: AddTextInput): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  if (!Number.isInteger(input.page) || input.page < 0 || input.page >= loaded.info.pageCount) {
    return { ok: false, code: 'unknown', detail: `page ${input.page + 1} is outside the document` };
  }
  const checked = checkAddedText(input, loaded.info.pages[input.page]);
  if (!checked.ok) {
    return { ok: false, code: checked.error === 'unsupportedChars' ? 'textNotRenderable' : 'unknown', detail: checked.error };
  }
  const doc = loaded.doc;
  const page = doc.getPage(input.page);
  const before = contentsCount(page);
  try {
    const font = await doc.embedFont(STANDARD_FONT[checked.font]);
    page.drawText(input.text, {
      x: input.x,
      y: input.y,
      size: input.size,
      font,
      color: rgb(checked.color.r, checked.color.g, checked.color.b),
    });
  } catch (error) {
    return failed(error);
  }
  if (contentsCount(page) <= before) return { ok: false, code: 'unknown', detail: `text drew nothing on page ${input.page + 1}` };
  return finish(doc, {
    pageCount: loaded.info.pageCount,
    minContents: { [input.page]: before + 1 },
    contentContains: { [input.page]: 'Tj' },
  });
}

/* ───────────────────────── signature ───────────────────────── */

export interface SignatureInput {
  /** 0-based page index. */
  page: number;
  text: string;
  size: number;
  x: number;
  y: number;
  color: string;
}

/**
 * A typed signature: the same drawing path as `addText`, in a large italic standard font.
 * Nothing is verified differently — it is text on the page, and the produced bytes must show
 * the text operator before the window says it worked.
 */
export async function addTypedSignature(bytes: Uint8Array, input: SignatureInput): Promise<OpResult> {
  return addText(bytes, { ...input, font: 'timesRomanItalic' });
}

export interface SignatureImageInput {
  /** 0-based page index. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The picture picked from the device; PNG or JPEG, decided by the bytes, never the name. */
  image: { name: string; bytes: Uint8Array };
}

/**
 * Draws a signature picture on a page. The box must lie inside the page — a signature half off
 * the sheet is refused instead of silently clipped — and the produced bytes are re-read to
 * prove the image was really invoked (`Do`) on that page.
 */
export async function addImageSignature(bytes: Uint8Array, input: SignatureImageInput): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  if (!Number.isInteger(input.page) || input.page < 0 || input.page >= loaded.info.pageCount) {
    return { ok: false, code: 'unknown', detail: `page ${input.page + 1} is outside the document` };
  }
  const kind = sniff(input.image.bytes);
  if (kind !== 'png' && kind !== 'jpeg') return { ok: false, code: 'imageUnsupported', detail: `${input.image.name}: ${kind}` };
  const box = coverRectFor(
    { x: input.x, y: input.y, width: input.width, height: input.height },
    loaded.info.pages[input.page],
  );
  // The clip rounds to two decimals, so a rounded-equal box counts as inside; only a box that
  // really sticks out is refused.
  const same = (a: number, b: number): boolean => Math.abs(a - b) <= 0.01;
  if (!box.ok || !same(box.rect.x, input.x) || !same(box.rect.y, input.y)
    || !same(box.rect.width, input.width) || !same(box.rect.height, input.height)) {
    return { ok: false, code: 'unknown', detail: `signature box ${box.ok ? 'sticks out of' : box.error} the page` };
  }
  const doc = loaded.doc;
  const page = doc.getPage(input.page);
  const before = contentsCount(page);
  try {
    const image = kind === 'png' ? await doc.embedPng(input.image.bytes) : await doc.embedJpg(input.image.bytes);
    page.drawImage(image, { x: input.x, y: input.y, width: input.width, height: input.height });
  } catch (error) {
    const refusal = refusalFromError(error);
    return { ok: false, code: 'imageBroken', detail: `${input.image.name}: ${refusal.detail}` };
  }
  if (contentsCount(page) <= before) return { ok: false, code: 'unknown', detail: `signature drew nothing on page ${input.page + 1}` };
  return finish(doc, {
    pageCount: loaded.info.pageCount,
    minContents: { [input.page]: before + 1 },
    contentContains: { [input.page]: 'Do' },
  });
}

/* ────────────────── cover a region (hiding, not redaction) ────────────────── */
export interface CoverInput extends CoverRegion {
  /** 0-based page index. */
  page: number;
  shape: CoverShape;
  color: string;
}

/**
 * Draws a filled box (or ellipse) over a region of a page.
 *
 * This is COVERING, never redaction: the fill is appended over the content, so the original
 * text is still in the file and still extractable. The window says so in words; this function
 * only proves the shape operator really reached the stream.
 */
export async function coverRegion(bytes: Uint8Array, input: CoverInput): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  if (!Number.isInteger(input.page) || input.page < 0 || input.page >= loaded.info.pageCount) {
    return { ok: false, code: 'unknown', detail: `page ${input.page + 1} is outside the document` };
  }
  const color = parseHexColor(input.color);
  if (!color) return { ok: false, code: 'unknown', detail: 'the cover colour is not a hex value' };
  const box = coverRectFor(input, loaded.info.pages[input.page]);
  if (!box.ok) return { ok: false, code: 'unknown', detail: `cover ${box.error}` };
  const doc = loaded.doc;
  const page = doc.getPage(input.page);
  const before = contentsCount(page);
  try {
    if (input.shape === 'ellipse') {
      page.drawEllipse({
        x: box.rect.x + box.rect.width / 2,
        y: box.rect.y + box.rect.height / 2,
        xScale: box.rect.width / 2,
        yScale: box.rect.height / 2,
        color: rgb(color.r, color.g, color.b),
      });
    } else {
      // pdf-lib's own `drawRectangle` writes a move/line path. Pushing the `re` operator
      // instead keeps the stream legible as "a filled rectangle" — and that operator is what
      // the verification below looks for.
      page.pushOperators(
        pushGraphicsState(),
        setFillingRgbColor(color.r, color.g, color.b),
        rectangle(box.rect.x, box.rect.y, box.rect.width, box.rect.height),
        fill(),
        popGraphicsState(),
      );
    }
  } catch (error) {
    return failed(error);
  }
  if (contentsCount(page) <= before) return { ok: false, code: 'unknown', detail: `cover drew nothing on page ${input.page + 1}` };
  return finish(doc, {
    pageCount: loaded.info.pageCount,
    minContents: { [input.page]: before + 1 },
    contentContains: { [input.page]: input.shape === 'ellipse' ? 'c' : 're' },
  });
}

/* ──────────────── blank page and duplicate ──────────────── */

/**
 * Inserts one blank page at a 0-based position. The blank page takes the size of the page it
 * is inserted before (the last page when it goes at the end), so it matches the document
 * instead of dropping an A4 sheet into a Letter file. Every page's size is checked afterwards.
 */
export async function insertBlankPage(bytes: Uint8Array, at: number): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  const index = Math.min(Math.max(Math.trunc(at), 0), loaded.info.pageCount);
  const neighbour = loaded.info.pages[Math.min(index, loaded.info.pageCount - 1)];
  const size: Size = { width: neighbour.width, height: neighbour.height };
  const doc = loaded.doc;
  try {
    doc.insertPage(index, [size.width, size.height]);
  } catch (error) {
    return failed(error);
  }
  const sizes: Record<number, Size> = {};
  for (let i = 0; i < loaded.info.pageCount + 1; i++) {
    sizes[i] = i === index ? size : loaded.info.pages[i < index ? i : i - 1];
  }
  return finish(doc, { pageCount: loaded.info.pageCount + 1, pageSizes: sizes });
}

/**
 * One independent copy of every selected page, placed right after it. Zero selected is
 * refused. `extractPages` cannot be used here: it de-duplicates its page list, which is
 * exactly what a duplication is.
 */
export async function duplicatePages(bytes: Uint8Array, pages: readonly number[]): Promise<OpResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  const target = [...new Set(pages)].filter((p) => p >= 0 && p < loaded.info.pageCount);
  if (!target.length) return { ok: false, code: 'emptyResult', detail: 'no pages selected' };
  const order = duplicateOrder(loaded.info.pages.map((_, i) => i), target);
  try {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(loaded.doc, order);
    copied.forEach((page) => out.addPage(page));
    // The duplicated page must have its original's size, page for page.
    return await finish(out, {
      pageCount: order.length,
      rotations: rotationsOf(loaded.info, order),
      pageSizes: sizesOf(loaded.info, order),
    });
  } catch (error) {
    return failed(error);
  }
}

/* ───────────────────────── form fields ───────────────────────── */

export type FormFieldKind = 'text' | 'checkbox' | 'other';

export interface FormFieldInfo {
  name: string;
  kind: FormFieldKind;
  /** The current text value, or '' when the field has none. */
  value: string;
  checked: boolean;
  multiline: boolean;
  readOnly: boolean;
}

export type FormReadResult =
  | { ok: true; hasForm: boolean; fields: FormFieldInfo[] }
  | { ok: false; code: PdfRefusalCode; detail: string };

/**
 * The AcroForm fields a reader would show. Text fields and checkboxes are editable here;
 * anything else (buttons, radio groups, dropdowns, signatures) is listed as `other` and left
 * alone, and the window says how many were left alone.
 *
 * `hasForm` is false when the document carries no AcroForm at all — the window then says so
 * plainly rather than drawing an empty panel.
 */
export async function readFormFields(bytes: Uint8Array): Promise<FormReadResult> {
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  if (!loaded.doc.catalog.getAcroForm()) return { ok: true, hasForm: false, fields: [] };
  try {
    const fields = loaded.doc.getForm().getFields().map((field): FormFieldInfo => {
      if (field instanceof PDFTextField) {
        return {
          name: field.getName(),
          kind: 'text',
          value: text(() => field.getText()),
          checked: false,
          multiline: flag(() => field.isMultiline()),
          readOnly: flag(() => field.isReadOnly()),
        };
      }
      if (field instanceof PDFCheckBox) {
        return {
          name: field.getName(),
          kind: 'checkbox',
          value: '',
          checked: flag(() => field.isChecked()),
          multiline: false,
          readOnly: flag(() => field.isReadOnly()),
        };
      }
      return { name: field.getName(), kind: 'other', value: '', checked: false, multiline: false, readOnly: false };
    });
    return { ok: true, hasForm: fields.length > 0, fields };
  } catch (error) {
    const refusal = refusalFromError(error);
    return { ok: false, code: refusal.code, detail: refusal.detail };
  }
}

export interface FormFillInput {
  name: string;
  kind: 'text' | 'checkbox';
  value?: string;
  checked?: boolean;
}

/**
 * Writes the given values and proves them by re-reading the produced bytes. A field that is
 * read-only, missing or of another type is skipped rather than half-written; if nothing was
 * written the operation fails with `emptyResult`.
 *
 * Setting `/V` alone is not enough for a reader to SHOW the value, so each field's own
 * appearance stream is rebuilt. When the library cannot build one, `/NeedAppearances` is set
 * so the reader builds it from the value instead — either way the value is in the file.
 */
export async function fillFormFields(bytes: Uint8Array, fills: readonly FormFillInput[]): Promise<OpResult> {
  const wanted = fills.filter((fill) => fill.kind === 'text' || fill.kind === 'checkbox');
  if (!wanted.length) return { ok: false, code: 'emptyResult', detail: 'no fields to fill' };
  const loaded = await loadPdf(bytes);
  if (!loaded.ok) return loaded;
  if (!loaded.doc.catalog.getAcroForm()) return { ok: false, code: 'noForm', detail: 'the document has no AcroForm' };
  const doc = loaded.doc;
  const form = doc.getForm();
  const expected: Record<string, { text?: string; checked?: boolean }> = {};
  let needAppearances = false;
  try {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const item of wanted) {
      const field: PDFField | undefined = form.getFieldMaybe(item.name);
      if (!field || flag(() => field.isReadOnly())) continue;
      if (item.kind === 'text') {
        if (!(field instanceof PDFTextField)) continue;
        const value = item.value ?? '';
        field.setText(value);
        expected[item.name] = { text: value };
      } else {
        if (!(field instanceof PDFCheckBox)) continue;
        if (item.checked) field.check();
        else field.uncheck();
        expected[item.name] = { checked: item.checked === true };
      }
      try {
        field.defaultUpdateAppearances(font);
      } catch {
        needAppearances = true;
      }
    }
  } catch (error) {
    return failed(error);
  }
  if (!Object.keys(expected).length) return { ok: false, code: 'emptyResult', detail: 'no matching writable fields' };
  const acro = doc.catalog.getAcroForm();
  if (acro && needAppearances) acro.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  // When a field's appearance could not be built, pdf-lib's own appearance pass at save time
  // would throw on that same value; the value is written and the reader is asked to draw it.
  return finish(doc, { pageCount: loaded.info.pageCount, formValues: expected },
    needAppearances ? { updateFieldAppearances: false } : {});
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
