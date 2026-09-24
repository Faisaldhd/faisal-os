import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, degrees } from 'pdf-lib';
import {
  addImageSignature, addText, addTypedSignature, addWatermark, coverRegion, cropPages, duplicatePages,
  extractPages, fillFormFields, imagesToPdf, insertBlankPage, loadPdf, mergePdfs, readFormFields,
  removePages, reorderPages, rotatePages, setMetadata, verifyOutput,
  type DocInfo, type LoadResult, type OpResult,
} from './pdfdoc';
import { imagePageLayout } from './ops';

/* ───────────────────────────── fixtures ───────────────────────────── */

/** A real PDF built by pdf-lib: one page per entry, with its own size, rotation and a text label. */
async function makePdf(pages: { w: number; h: number; rotation?: number; label?: string }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage([spec.w, spec.h]);
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
    if (spec.label) page.drawText(spec.label, { x: 8, y: 8, size: 10, font });
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * A real, valid 4×3 RGB PNG (built byte by byte, 80 bytes) held as base64 in the test: no
 * file is read from disk, and pdf-lib decodes it for real (it reports 4×3).
 */
const PNG_4x3 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAF0lEQVR4nGP4z8DAAMb/kVkgGsH6zwAAIhMO8vL5IVQAAAAASUVORK5CYII=';
const png = (): Uint8Array => Uint8Array.from(atob(PNG_4x3), (ch) => ch.charCodeAt(0));

/**
 * jsdom's `TextEncoder` returns a Uint8Array from another realm, and pdf-lib's
 * `instanceof Uint8Array` check rejects it (it reports the value's type as "NaN"). Copying
 * the bytes into this realm's constructor is what a real browser does not need.
 */
const bytesOf = (text: string): Uint8Array => Uint8Array.from(new TextEncoder().encode(text));

/**
 * A structurally valid JPEG header (SOI + SOF0): pdf-lib's JpegEmbedder reads only the
 * header (dimensions and components) and copies the bytes through with DCTDecode, which is
 * the same path a camera JPEG takes. The declared size is 4×3 px.
 */
function jpegHeader(width = 4, height = 3): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

/**
 * A minimal but structurally valid PDF with an optional real /Encrypt entry in the trailer:
 * pdf-lib cannot *write* an encrypted document, so the trailer is hand-built. The same
 * builder without `/Encrypt` is asserted to load, which is what proves the encrypted case
 * fails for encryption and not because the fixture is unreadable.
 */
function handwrittenPdf(pages: { w: number; h: number }[], encrypt = false): Uint8Array {
  let pdf = '%PDF-1.7\n';
  const offsets: Record<number, number> = {};
  const add = (number: number, body: string) => {
    offsets[number] = pdf.length;
    pdf += `${number} 0 obj\n${body}\nendobj\n`;
  };
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const pageNumbers = pages.map((_, i) => 3 + i);
  add(2, `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((page, i) => add(pageNumbers[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.w} ${page.h}] >>`));
  const highestPage = Math.max(2, ...pageNumbers);
  let highest = highestPage;
  let extra = '';
  if (encrypt) {
    highest = highestPage + 1;
    add(highest, '<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -1 >>');
    extra = `/Encrypt ${highest} 0 R `;
  }
  const total = highest + 1;
  const xref = pdf.length;
  pdf += `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) pdf += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${total} /Root 1 0 R ${extra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return bytesOf(pdf);
}

async function opened(bytes: Uint8Array): Promise<{ doc: PDFDocument; info: DocInfo }> {
  const result: LoadResult = await loadPdf(bytes);
  if (!result.ok) throw new Error(`expected a loadable PDF, got ${result.code}: ${result.detail}`);
  return { doc: result.doc, info: result.info };
}

async function produced(result: OpResult): Promise<Uint8Array> {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.detail}`);
  return result.bytes;
}

/** Reads the produced bytes back with pdf-lib directly — not through the app's own verifier. */
async function reread(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

const sizesOf = (doc: PDFDocument): string[] =>
  doc.getPages().map((page) => {
    const size = page.getSize();
    return `${Math.round(size.width)}x${Math.round(size.height)}`;
  });

const rotationsOf = (doc: PDFDocument): number[] => doc.getPages().map((page) => page.getRotation().angle);

/** pdf-lib's Contents() is a PDFArray (not a JS array), so `.size()` is the real count. */
const contentsOf = (doc: PDFDocument, index: number): number => {
  const contents = doc.getPage(index).node.Contents();
  if (contents instanceof PDFArray) return contents.size();
  return contents ? 1 : 0;
};

/**
 * A page's content stream decoded back to text. pdf-lib deflates what it draws, so this is
 * the only way a test can see the operators that really reached the file.
 */
function contentOf(doc: PDFDocument, index: number): string {
  const contents = doc.getPage(index).node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  let out = '';
  for (const ref of refs) {
    const stream = doc.context.lookup(ref);
    if (stream instanceof PDFRawStream) out += new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }
  return out;
}

/** The hex pdf-lib writes for a piece of ASCII text (`hello` → `68656c6c6f`). */
const hexOf = (text: string): string =>
  [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** A real AcroForm built by pdf-lib: a nested text field and a checkbox, optionally prefilled. */
async function makeFormPdf(text = '', checked = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const form = doc.getForm();
  const name = form.createTextField('owner.name');
  name.addToPage(page, { x: 20, y: 220, width: 200, height: 24 });
  if (text) name.setText(text);
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 20, y: 180, width: 18, height: 18 });
  if (checked) agree.check();
  return Uint8Array.from(await doc.save({ useObjectStreams: false }));
}

/* ───────────────────────────── opening ───────────────────────────── */

describe('opening a file', () => {
  it('reads the page count, sizes, rotations and metadata of a real PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    const second = doc.addPage([400, 500]);
    second.setRotation(degrees(90));
    doc.setTitle('A report');
    doc.setAuthor('Faisal');
    const { info } = await opened(await doc.save({ useObjectStreams: false }));
    expect(info.pageCount).toBe(2);
    expect(info.pages[0]).toEqual({ width: 200, height: 300, rotation: 0, crop: { x: 0, y: 0, width: 200, height: 300 } });
    expect(info.pages[1].rotation).toBe(90);
    expect(info.title).toBe('A report');
    expect(info.author).toBe('Faisal');
  });

  it('refuses zero bytes as empty and text as not a PDF', async () => {
    const empty = await loadPdf(new Uint8Array(0));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('empty');
    const text = await loadPdf(bytesOf('hello, this is not a pdf'));
    expect(text.ok).toBe(false);
    if (!text.ok) expect(text.code).toBe('notPdf');
  });

  it('refuses a PDF whose body is broken, instead of reporting an empty success', async () => {
    const broken = await loadPdf(bytesOf('%PDF-1.7\nthis body is not a document at all\n'));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.code).toBe('corrupt');
    const valid = await makePdf([{ w: 200, h: 200 }]);
    const truncated = await loadPdf(valid.slice(0, 120));
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.code).toBe('corrupt');
  });

  it('refuses an encrypted document — and the same fixture without /Encrypt loads', async () => {
    // The control first: without /Encrypt this hand-built file is a readable 2-page PDF.
    const plain = await opened(handwrittenPdf([{ w: 100, h: 200 }, { w: 110, h: 210 }]));
    expect(plain.info.pageCount).toBe(2);
    const encrypted = await loadPdf(handwrittenPdf([{ w: 100, h: 200 }], true));
    expect(encrypted.ok).toBe(false);
    if (!encrypted.ok) {
      expect(encrypted.code).toBe('encrypted');
      expect(encrypted.detail).toMatch(/is encrypted/i);
    }
  });
});

/* ───────────────────────────── page operations ───────────────────────────── */

describe('extract and merge keep the order and the rotation', () => {
  it('extracts the pages in the order asked for', async () => {
    const source = await makePdf([{ w: 100, h: 100 }, { w: 200, h: 200, rotation: 90 }, { w: 300, h: 300 }]);
    const out = await reread(await produced(await extractPages(source, [2, 0])));
    expect(sizesOf(out)).toEqual(['300x300', '100x100']);
    expect(out.getPageCount()).toBe(2);
  });

  it('keeps each extracted page’s own rotation', async () => {
    const source = await makePdf([{ w: 100, h: 100 }, { w: 200, h: 200, rotation: 270 }]);
    const out = await reread(await produced(await extractPages(source, [1, 0])));
    expect(rotationsOf(out)).toEqual([270, 0]);
  });

  it('refuses an extraction of nothing', async () => {
    const source = await makePdf([{ w: 100, h: 100 }]);
    const result = await extractPages(source, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('emptyResult');
  });

  it('merges several documents in the order of the plan, rotation included', async () => {
    const a = await makePdf([{ w: 100, h: 100 }, { w: 110, h: 110, rotation: 90 }]);
    const b = await makePdf([{ w: 300, h: 300 }]);
    const plan = [{ source: 0, page: 1 }, { source: 1, page: 0 }, { source: 0, page: 0 }];
    const merged = await reread(await produced(await mergePdfs(
      [{ name: 'a.pdf', bytes: a }, { name: 'b.pdf', bytes: b }], plan,
    )));
    expect(sizesOf(merged)).toEqual(['110x110', '300x300', '100x100']);
    expect(rotationsOf(merged)).toEqual([90, 0, 0]);
  });

  it('refuses to merge an encrypted source and names it', async () => {
    const good = await makePdf([{ w: 100, h: 100 }]);
    const encrypted = handwrittenPdf([{ w: 100, h: 100 }], true);
    const result = await mergePdfs([{ name: 'good.pdf', bytes: good }, { name: 'locked.pdf', bytes: encrypted }],
      [{ source: 0, page: 0 }, { source: 1, page: 0 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('encrypted');
      expect(result.detail).toContain('locked.pdf');
    }
  });
});

describe('delete and reorder', () => {
  it('removes exactly the pages asked for', async () => {
    const source = await makePdf([{ w: 100, h: 100 }, { w: 200, h: 200 }, { w: 300, h: 300 }]);
    const out = await reread(await produced(await removePages(source, [1])));
    expect(sizesOf(out)).toEqual(['100x100', '300x300']);
  });

  it('refuses to delete every page rather than writing an empty document', async () => {
    const source = await makePdf([{ w: 100, h: 100 }, { w: 200, h: 200 }]);
    const result = await removePages(source, [0, 1]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('emptyResult');
  });

  it('reorders the pages and proves the new order in the bytes', async () => {
    const source = await makePdf([{ w: 100, h: 100 }, { w: 200, h: 200 }, { w: 300, h: 300 }]);
    const out = await reread(await produced(await reorderPages(source, [2, 0, 1])));
    expect(sizesOf(out)).toEqual(['300x300', '100x100', '200x200']);
  });

  it('refuses an order that is not a permutation of the pages', async () => {
    const source = await makePdf([{ w: 100, h: 100 }, { w: 200, h: 200 }]);
    expect((await reorderPages(source, [0, 0])).ok).toBe(false);
    expect((await reorderPages(source, [0])).ok).toBe(false);
    expect((await reorderPages(source, [0, 5])).ok).toBe(false);
  });
});

/* ───────────────────────────── rotate / crop ───────────────────────────── */

describe('rotate and crop', () => {
  it('rotates only the selected pages, on top of the rotation each page already had', async () => {
    const source = await makePdf([
      { w: 100, h: 100 }, { w: 100, h: 100, rotation: 90 }, { w: 100, h: 100, rotation: 270 },
    ]);
    const out = await reread(await produced(await rotatePages(source, [0, 2], 90)));
    expect(rotationsOf(out)).toEqual([90, 90, 0]);
  });

  it('sets the crop box on the selected pages only', async () => {
    const source = await makePdf([{ w: 200, h: 300 }, { w: 200, h: 300 }]);
    const out = await reread(await produced(await cropPages(source, [0], { top: 10, right: 20, bottom: 30, left: 40 })));
    expect(out.getPage(0).getCropBox()).toEqual({ x: 40, y: 30, width: 140, height: 260 });
    // The untouched page falls back to its media box, so it is not cropped.
    expect(out.getPage(1).getCropBox()).toEqual({ x: 0, y: 0, width: 200, height: 300 });
  });

  it('refuses a crop with no area left instead of writing a broken page', async () => {
    const source = await makePdf([{ w: 100, h: 100 }]);
    const result = await cropPages(source, [0], { top: 60, right: 0, bottom: 60, left: 0 });
    expect(result.ok).toBe(false);
  });

  it('reports a failed rotation instead of claiming success', async () => {
    const source = await makePdf([{ w: 100, h: 100 }]);
    const result = await rotatePages(source, [], 90);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('emptyResult');
  });
});

/* ───────────────────────────── watermark ───────────────────────────── */

describe('text watermark', () => {
  it('adds a content stream to every selected page and leaves the rest alone', async () => {
    const source = await makePdf([{ w: 300, h: 300, label: 'text' }, { w: 300, h: 300 }]);
    const before = await reread(source);
    const beforeCounts = [contentsOf(before, 0), contentsOf(before, 1)];
    const result = await addWatermark(source, [0, 1], { text: 'DRAFT', size: 40, opacity: 0.2, rotation: 45 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verified).toContain('contents[0]=');
    const out = await reread(result.bytes);
    expect(out.getPageCount()).toBe(2);
    // Real proof that something was drawn on each page: strictly more content streams.
    expect(contentsOf(out, 0)).toBeGreaterThan(beforeCounts[0]);
    expect(contentsOf(out, 1)).toBeGreaterThan(beforeCounts[1]);
    // The rotation of the pages themselves is untouched.
    expect(rotationsOf(out)).toEqual([0, 0]);
  });

  it('refuses Arabic text with the honest code, before writing anything', async () => {
    const source = await makePdf([{ w: 300, h: 300 }]);
    const result = await addWatermark(source, [0], { text: 'مسودة', size: 40, opacity: 0.2, rotation: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('textNotRenderable');
  });
});

/* ───────────────────────── added text ───────────────────────── */

describe('adding text to a page', () => {
  it('adds a text-showing operator, keeps the page count and still parses', async () => {
    const source = await makePdf([{ w: 300, h: 300 }, { w: 200, h: 200 }]);
    const before = await reread(source);
    expect(contentOf(before, 0)).not.toContain('Tj');

    const result = await addText(source, {
      page: 0, text: 'INVOICE 2026', size: 18, x: 30, y: 40, font: 'helveticaBold', color: '#ff0000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verified).toContain('content[0]=Tj');

    const out = await reread(result.bytes);
    expect(out.getPageCount()).toBe(2);
    const stream = contentOf(out, 0);
    expect(stream).toContain('Tj');
    expect(stream.toLowerCase()).toContain(hexOf('INVOICE 2026'));
    expect(stream).toContain('1 0 0 rg');
    // The untouched page gained no content stream at all.
    expect(contentsOf(out, 1)).toBe(contentsOf(before, 1));
  });

  it('refuses Arabic (the standard fonts cannot encode it) and writes nothing', async () => {
    const source = await makePdf([{ w: 300, h: 300 }]);
    const result = await addText(source, { page: 0, text: 'فاتورة', size: 18, x: 10, y: 10, font: 'helvetica', color: '#000000' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('textNotRenderable');
  });

  it('refuses a page that is not in the document and a point outside the page', async () => {
    const source = await makePdf([{ w: 300, h: 300 }]);
    const base = { text: 'hi', size: 18, font: 'helvetica', color: '#000000' } as const;
    expect((await addText(source, { ...base, page: 4, x: 10, y: 10 })).ok).toBe(false);
    expect((await addText(source, { ...base, page: 0, x: 900, y: 10 })).ok).toBe(false);
    expect((await addText(source, { ...base, page: 0, x: 10, y: 10 })).ok).toBe(true);
  });

  it('maps a non-PDF and a broken PDF to the same refusals opening uses', async () => {
    const base = { page: 0, text: 'hi', size: 18, x: 10, y: 10, font: 'helvetica', color: '#000000' } as const;
    const notPdf = await addText(bytesOf('hello, not a pdf'), base);
    expect(notPdf.ok).toBe(false);
    if (!notPdf.ok) expect(notPdf.code).toBe('notPdf');
    const broken = await addText(bytesOf('%PDF-1.7\nthis body is not a document at all\n'), base);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.code).toBe('corrupt');
  });
});

/* ─────────────────────── cover a region ─────────────────────── */

describe('covering a region', () => {
  it('draws a filled rectangle and the rectangle operator is in the produced stream', async () => {
    const source = await makePdf([{ w: 300, h: 300 }]);
    const result = await coverRegion(source, {
      page: 0, shape: 'rect', x: 20, y: 40, width: 120, height: 60, color: '#ffffff',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verified).toContain('content[0]=re');
    const out = await reread(result.bytes);
    expect(out.getPageCount()).toBe(1);
    const stream = contentOf(out, 0);
    expect(stream).toContain('20 40 120 60 re');
    expect(stream).toContain('f');
    expect(stream).toContain('1 1 1 rg');
  });

  it('draws an ellipse as a filled bezier path', async () => {
    const source = await makePdf([{ w: 300, h: 300 }]);
    const result = await coverRegion(source, {
      page: 0, shape: 'ellipse', x: 40, y: 40, width: 120, height: 80, color: '#000000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stream = contentOf(await reread(result.bytes), 0);
    expect(stream).toContain('c');
    expect(stream).toContain('f');
  });

  it('hides nothing away: the text under the cover is STILL in the file (not redaction)', async () => {
    const source = await makePdf([{ w: 300, h: 300, label: 'SECRET' }]);
    const result = await coverRegion(source, {
      page: 0, shape: 'rect', x: 0, y: 0, width: 300, height: 300, color: '#000000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stream = contentOf(await reread(result.bytes), 0);
    // The cover is drawn AND the original text is still extractable — which is why the window
    // calls this covering, never redaction.
    expect(stream).toContain('re');
    expect(stream.toLowerCase()).toContain(hexOf('SECRET'));
  });

  it('refuses a region outside the page and one with no area', async () => {
    const source = await makePdf([{ w: 300, h: 300 }]);
    expect((await coverRegion(source, { page: 0, shape: 'rect', x: 400, y: 10, width: 50, height: 50, color: '#000' })).ok).toBe(false);
    expect((await coverRegion(source, { page: 0, shape: 'rect', x: 10, y: 10, width: 0, height: 50, color: '#000' })).ok).toBe(false);
    expect((await coverRegion(source, { page: 9, shape: 'rect', x: 10, y: 10, width: 50, height: 50, color: '#000' })).ok).toBe(false);
  });
});

/* ──────────────── blank page and duplicate ──────────────── */

describe('blank page and duplicate', () => {
  it('inserts one blank page in the middle and at the end, taking the neighbour size', async () => {
    const source = await makePdf([{ w: 100, h: 100 }, { w: 200, h: 200 }, { w: 300, h: 300 }]);
    const middle = await reread(await produced(await insertBlankPage(source, 1)));
    expect(middle.getPageCount()).toBe(4);
    expect(sizesOf(middle)).toEqual(['100x100', '200x200', '200x200', '300x300']);
    const end = await reread(await produced(await insertBlankPage(source, 3)));
    expect(sizesOf(end)).toEqual(['100x100', '200x200', '300x300', '300x300']);
    // A position past the end is clamped to the end instead of failing.
    const beyond = await reread(await produced(await insertBlankPage(source, 99)));
    expect(sizesOf(beyond)).toEqual(['100x100', '200x200', '300x300', '300x300']);
  });

  it('duplicates the selected pages right after themselves, same size and rotation', async () => {
    const source = await makePdf([{ w: 100, h: 100 }, { w: 200, h: 200, rotation: 90 }, { w: 300, h: 300 }]);
    const result = await duplicatePages(source, [1]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = await reread(result.bytes);
    expect(out.getPageCount()).toBe(4);
    expect(sizesOf(out)).toEqual(['100x100', '200x200', '200x200', '300x300']);
    expect(rotationsOf(out)).toEqual([0, 90, 90, 0]);
  });

  it('duplicates several pages and asserts the exact new count', async () => {
    const source = await makePdf([{ w: 100, h: 100 }, { w: 200, h: 200 }, { w: 300, h: 300 }]);
    const out = await reread(await produced(await duplicatePages(source, [0, 2])));
    expect(out.getPageCount()).toBe(5);
    expect(sizesOf(out)).toEqual(['100x100', '100x100', '200x200', '300x300', '300x300']);
  });

  it('refuses to duplicate nothing', async () => {
    const source = await makePdf([{ w: 100, h: 100 }]);
    const result = await duplicatePages(source, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('emptyResult');
  });
});

/* ───────────────────────── form fields ───────────────────────── */

describe('reading and filling a form', () => {
  it('lists the text field and the checkbox with the values the file carries', async () => {
    const read = await readFormFields(await makeFormPdf('draft', true));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.hasForm).toBe(true);
    expect(read.fields).toEqual([
      { name: 'owner.name', kind: 'text', value: 'draft', checked: false, multiline: false, readOnly: false },
      { name: 'agree', kind: 'checkbox', value: '', checked: true, multiline: false, readOnly: false },
    ]);
  });

  it('says plainly that a document with no form has none', async () => {
    const read = await readFormFields(await makePdf([{ w: 200, h: 200 }]));
    expect(read).toEqual({ ok: true, hasForm: false, fields: [] });
  });

  it('fills the fields and reads the values back from the produced bytes', async () => {
    const source = await makeFormPdf();
    const result = await fillFormFields(source, [
      { name: 'owner.name', kind: 'text', value: 'Faisal' },
      { name: 'agree', kind: 'checkbox', checked: true },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verified).toContain('field[owner.name]="Faisal"');

    // Read back with pdf-lib directly, the way a reader would ask the file.
    const out = await reread(result.bytes);
    const form = out.getForm();
    expect(form.getTextField('owner.name').getText()).toBe('Faisal');
    expect(form.getCheckBox('agree').isChecked()).toBe(true);
    // A reader that does not rebuild appearances needs the field's own appearance stream.
    const widget = form.getTextField('owner.name').acroField.getWidgets()[0];
    expect(widget.dict.lookup(PDFName.of('AP'))).toBeTruthy();
  });

  it('can turn a checkbox off and clear a text field again', async () => {
    const source = await makeFormPdf('filled', true);
    const out = await reread(await produced(await fillFormFields(source, [
      { name: 'owner.name', kind: 'text', value: '' },
      { name: 'agree', kind: 'checkbox', checked: false },
    ])));
    const form = out.getForm();
    expect(form.getTextField('owner.name').getText() ?? '').toBe('');
    expect(form.getCheckBox('agree').isChecked()).toBe(false);
  });

  it('writes a value the standard fonts cannot draw and asks the reader to build the appearance', async () => {
    // Arabic in a form value: pdf-lib's appearance pass would throw on it, so the value is
    // written anyway and /NeedAppearances tells the reader to draw it from the value.
    const out = await reread(await produced(await fillFormFields(await makeFormPdf(), [
      { name: 'owner.name', kind: 'text', value: 'فيصل' },
    ])));
    expect(out.getForm().getTextField('owner.name').getText()).toBe('فيصل');
    expect(out.catalog.getAcroForm()?.dict.get(PDFName.of('NeedAppearances'))).toBeTruthy();
  });

  it('refuses a document with no AcroForm and an empty list of fills', async () => {
    const plain = await makePdf([{ w: 200, h: 200 }]);
    const noForm = await fillFormFields(plain, [{ name: 'x', kind: 'text', value: 'y' }]);
    expect(noForm.ok).toBe(false);
    if (!noForm.ok) expect(noForm.code).toBe('noForm');
    const empty = await fillFormFields(await makeFormPdf(), []);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('emptyResult');
  });

  it('maps a non-PDF and a broken PDF to the same refusals opening uses', async () => {
    const notPdf = await readFormFields(bytesOf('hello, not a pdf'));
    expect(notPdf.ok).toBe(false);
    if (!notPdf.ok) expect(notPdf.code).toBe('notPdf');
    const broken = await readFormFields(bytesOf('%PDF-1.7\nthis body is not a document at all\n'));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.code).toBe('corrupt');
  });
});

/* ───────────────────────── signature ───────────────────────── */

describe('signatures', () => {
  it('types a signature as large italic text, and the operator is in the produced file', async () => {
    const source = await makePdf([{ w: 300, h: 300 }]);
    const result = await addTypedSignature(source, {
      page: 0, text: 'Faisal', size: 36, x: 40, y: 60, color: '#12294f',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = await reread(result.bytes);
    expect(out.getPageCount()).toBe(1);
    const stream = contentOf(out, 0);
    expect(stream).toContain('Tj');
    expect(stream.toLowerCase()).toContain(hexOf('Faisal'));
    // The signature is drawn in the italic standard font, not the plain one.
    expect(stream).toContain('/Times-Italic');
  });

  it('draws a real PNG signature picture and keeps the page count', async () => {
    const source = await makePdf([{ w: 300, h: 300 }]);
    const result = await addImageSignature(source, {
      page: 0, x: 20, y: 20, width: 120, height: 90, image: { name: 'sign.png', bytes: png() },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verified).toContain('content[0]=Do');
    const out = await reread(result.bytes);
    expect(out.getPageCount()).toBe(1);
    expect(contentOf(out, 0)).toContain('Do');
  });

  it('refuses a picture that is not PNG/JPEG, a box off the page, and an empty typed signature', async () => {
    const source = await makePdf([{ w: 300, h: 300 }]);
    const gif = await addImageSignature(source, {
      page: 0, x: 20, y: 20, width: 100, height: 50, image: { name: 'sig.gif', bytes: bytesOf('GIF89a................') },
    });
    expect(gif.ok).toBe(false);
    if (!gif.ok) {
      expect(gif.code).toBe('imageUnsupported');
      expect(gif.detail).toContain('sig.gif');
    }
    // Half the signature off the right edge would be silently cut, so it is refused instead.
    const offPage = await addImageSignature(source, {
      page: 0, x: 260, y: 20, width: 100, height: 50, image: { name: 'sign.png', bytes: png() },
    });
    expect(offPage.ok).toBe(false);
    const empty = await addTypedSignature(source, { page: 0, text: '   ', size: 36, x: 10, y: 10, color: '#000000' });
    expect(empty.ok).toBe(false);
  });
});

/* ───────────────────────────── metadata ───────────────────────────── */

describe('metadata', () => {
  it('writes title, author, subject and keywords, and the produced bytes carry them', async () => {
    const source = await makePdf([{ w: 100, h: 100 }]);
    const out = await reread(await produced(await setMetadata(source, {
      title: 'تقرير', author: 'فيصل', subject: 'اختبار', keywords: 'one, two',
    })));
    expect(out.getTitle()).toBe('تقرير');
    expect(out.getAuthor()).toBe('فيصل');
    expect(out.getSubject()).toBe('اختبار');
    expect(out.getKeywords()).toBe('one two');
  });

  it('clears a field when the form is emptied', async () => {
    const source = await makePdf([{ w: 100, h: 100 }]);
    const withTitle = await produced(await setMetadata(source, { title: 'Old', author: 'A', subject: 'S', keywords: 'k' }));
    const cleared = await reread(await produced(await setMetadata(withTitle, {
      title: '', author: '', subject: '', keywords: '',
    })));
    expect(cleared.getTitle() ?? '').toBe('');
    expect(cleared.getAuthor() ?? '').toBe('');
    expect(cleared.getKeywords() ?? '').toBe('');
  });
});

/* ───────────────────────────── images → PDF ───────────────────────────── */

describe('images to PDF', () => {
  it('embeds a real PNG and uses the computed page size', async () => {
    const result = await imagesToPdf([{ name: 'tile.png', bytes: png() }], 'fit');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = await reread(result.bytes);
    expect(out.getPageCount()).toBe(1);
    const expected = imagePageLayout({ width: 4, height: 3 }, 'fit');
    expect(expected.page).toEqual({ width: 52, height: 51 });
    expect(out.getPage(0).getSize()).toEqual(expected.page);
  });

  it('accepts a JPEG header and puts one image on each page in the given order', async () => {
    const result = await imagesToPdf([
      { name: 'a.jpg', bytes: jpegHeader(4, 3) },
      { name: 'b.png', bytes: png() },
    ], 'a4');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = await reread(result.bytes);
    expect(out.getPageCount()).toBe(2);
    // Both A4 pages: the 4×3 JPEG is scaled up, the PNG scaled to fit.
    expect(out.getPage(0).getSize().width).toBeCloseTo(595.28, 1);
    expect(out.getPage(1).getSize().width).toBeCloseTo(595.28, 1);
  });

  it('puts the image on a Letter page when asked', async () => {
    const result = await imagesToPdf([{ name: 'b.png', bytes: png() }], 'letter');
    if (!result.ok) throw new Error(result.detail);
    const out = await reread(result.bytes);
    expect(out.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
  });

  it('keeps a broken PNG apart from an unsupported one, naming the file both times', async () => {
    const gif = bytesOf('GIF89a................');
    const gifResult = await imagesToPdf([{ name: 'anim.gif', bytes: gif }], 'a4');
    expect(gifResult.ok).toBe(false);
    if (!gifResult.ok) {
      expect(gifResult.code).toBe('imageUnsupported');
      expect(gifResult.detail).toContain('anim.gif');
    }
    // A real PNG signature with a broken body: @pdf-lib/upng throws a bare RangeError here,
    // which is why the app reports "damaged image" rather than "not a PNG".
    const broken = new Uint8Array(64);
    broken.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const brokenResult = await imagesToPdf([{ name: 'broken.png', bytes: broken }], 'a4');
    expect(brokenResult.ok).toBe(false);
    if (!brokenResult.ok) {
      expect(brokenResult.code).toBe('imageBroken');
      expect(brokenResult.detail).toContain('broken.png');
    }
  });

  it('refuses an empty image list', async () => {
    const result = await imagesToPdf([], 'a4');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('emptyResult');
  });
});

/* ───────────────────────────── verification ───────────────────────────── */

describe('verifyOutput — the check that makes a success believable', () => {
  it('passes when the bytes match what was promised', async () => {
    const source = await makePdf([{ w: 100, h: 100 }, { w: 200, h: 200, rotation: 90 }]);
    const check = await verifyOutput(source, {
      pageCount: 2,
      rotations: { 1: 90 },
      pageSizes: { 0: { width: 100, height: 100 } },
    });
    expect(check.ok).toBe(true);
    expect(check.summary).toContain('pages=2');
    expect(check.mismatches).toEqual([]);
  });

  it('fails a wrong page count, a wrong rotation and a wrong crop', async () => {
    const source = await makePdf([{ w: 100, h: 100 }]);
    const wrongCount = await verifyOutput(source, { pageCount: 9 });
    expect(wrongCount.ok).toBe(false);
    expect(wrongCount.mismatches.join(' ')).toContain('pageCount 1 != 9');
    const wrongRotation = await verifyOutput(source, { rotations: { 0: 90 } });
    expect(wrongRotation.ok).toBe(false);
    const wrongCrop = await verifyOutput(source, { cropBoxes: { 0: { x: 1, y: 1, width: 10, height: 10 } } });
    expect(wrongCrop.ok).toBe(false);
  });

  it('fails when the bytes cannot be re-opened at all', async () => {
    const check = await verifyOutput(bytesOf('not a pdf'), { pageCount: 1 });
    expect(check.ok).toBe(false);
    expect(check.mismatches.join(' ')).toContain('reload failed');
  });

  it('fails a watermark expectation that the page cannot meet', async () => {
    const source = await makePdf([{ w: 100, h: 100 }]);
    const check = await verifyOutput(source, { pageCount: 1, minContents: { 0: 1 } });
    expect(check.ok).toBe(false);
    expect(check.mismatches.join(' ')).toContain('contents[0] 0 < 1');
  });
});
