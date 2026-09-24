import { describe, expect, it } from 'vitest';
import {
  A4, FIT_MAX_SIDE, IMAGE_MARGIN, LETTER, TEXT_FONTS,
  backupPathFor, buildMergePlan, buildSplitPlan, checkAddedText, checkOpenable, checkWatermark, copyNameFor,
  coverRectFor, cropBoxFor, deletePages, duplicateOrder, hasPdfHeader, imagePageLayout, insertIndexFor,
  movePage, normalizeDigits, normalizeRotation, parseHexColor, parsePageRanges,
  parseRangeGroups, planSave, refusalFromError, rotatePages, sniff, unsupportedWatermarkChars, watermarkAnchor,
} from './ops';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const pdfBytes = (): Uint8Array => bytesOf('%PDF-1.7\n1 0 obj\n<< >>\nendobj\n%%EOF\n');
const taken = (...paths: string[]): ((path: string) => boolean) => {
  const set = new Set(paths);
  return (path) => set.has(path);
};

/* ───────────────────────────── page ranges ───────────────────────────── */

describe('page ranges', () => {
  it('reads 1-3,5,8- as pages 1,2,3,5,8…last (0-based result)', () => {
    expect(parsePageRanges('1-3,5,8-', 10)).toEqual({ ok: true, pages: [0, 1, 2, 4, 7, 8, 9] });
  });

  it('accepts an open start (-4), a single page and the word الكل', () => {
    expect(parsePageRanges('-4', 10)).toEqual({ ok: true, pages: [0, 1, 2, 3] });
    expect(parsePageRanges('7', 10)).toEqual({ ok: true, pages: [6] });
    expect(parsePageRanges('الكل', 3)).toEqual({ ok: true, pages: [0, 1, 2] });
    expect(parsePageRanges('*', 2)).toEqual({ ok: true, pages: [0, 1] });
  });

  it('reads Arabic-Indic digits, so a range typed on an Arabic keyboard parses', () => {
    expect(normalizeDigits('١٢٣')).toBe('123');
    expect(normalizeDigits('۱۲')).toBe('12');
    expect(parsePageRanges('١-٣', 5)).toEqual({ ok: true, pages: [0, 1, 2] });
  });

  it('keeps the first-seen order and never repeats a page', () => {
    expect(parsePageRanges('3,1,3', 5)).toEqual({ ok: true, pages: [2, 0] });
  });

  it('keeps each comma-separated part as its own group, in the typed order', () => {
    expect(parseRangeGroups('5,1', 5)).toEqual({ ok: true, groups: [[4], [0]] });
    expect(parseRangeGroups('1-2, 4', 5)).toEqual({ ok: true, groups: [[0, 1], [3]] });
  });

  it('refuses what it cannot honour, with the exact reason', () => {
    expect(parsePageRanges('', 3)).toEqual({ ok: false, error: { code: 'empty' } });
    expect(parsePageRanges('x', 3)).toEqual({ ok: false, error: { code: 'syntax', token: 'x' } });
    expect(parsePageRanges('3-1', 3)).toEqual({ ok: false, error: { code: 'reversed', from: 3, to: 1 } });
    expect(parsePageRanges('0', 3)).toEqual({ ok: false, error: { code: 'outOfRange', page: 0, count: 3 } });
    expect(parsePageRanges('9', 3)).toEqual({ ok: false, error: { code: 'outOfRange', page: 9, count: 3 } });
    // A range that runs past the end is an error, not a silent truncation.
    expect(parsePageRanges('2-9', 3)).toEqual({ ok: false, error: { code: 'outOfRange', page: 9, count: 3 } });
  });
});

/* ───────────────────────────── page order ───────────────────────────── */

describe('page order edits', () => {
  it('moves one page so it lands at the requested index', () => {
    expect(movePage([0, 1, 2, 3], 0, 2)).toEqual([1, 2, 0, 3]);
    expect(movePage([0, 1, 2, 3], 3, 0)).toEqual([3, 0, 1, 2]);
    expect(movePage([0, 1, 2], 1, 1)).toEqual([0, 1, 2]);
  });

  it('ignores an index that is not on the list instead of dropping a page', () => {
    expect(movePage([0, 1, 2], -1, 0)).toEqual([0, 1, 2]);
    expect(movePage([0, 1, 2], 0, 9)).toEqual([0, 1, 2]);
  });

  it('deletes a selection, and refuses to delete every page', () => {
    expect(deletePages([0, 1, 2], [0, 2])).toEqual({ ok: true, order: [1] });
    expect(deletePages([0, 1], [0, 1])).toEqual({ ok: false, error: 'allPages' });
    expect(deletePages([0, 1], [])).toEqual({ ok: false, error: 'none' });
  });
});

describe('rotation', () => {
  it('normalises any angle to 0/90/180/270, negatives included', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(720)).toBe(0);
  });

  it('adds 90 to the pages selected and leaves the rest alone, on top of their own rotation', () => {
    expect(rotatePages([0, 90, 180, 270], [0, 1], 90)).toEqual([90, 180, 180, 270]);
    expect(rotatePages([270, 0], [0], 90)).toEqual([0, 0]);
    expect(rotatePages([0, 180], [], 90)).toEqual([0, 180]);
  });
});

/* ───────────────────────────── merge / split ───────────────────────────── */

describe('merge and split plans', () => {
  it('walks the sources in order and each source’s range, blank meaning all its pages', () => {
    expect(buildMergePlan([
      { path: '/home/user/a.pdf', pageCount: 2, ranges: '' },
      { path: '/home/user/b.pdf', pageCount: 3, ranges: '3,1' },
    ])).toEqual({
      ok: true,
      items: [{ source: 0, page: 0 }, { source: 0, page: 1 }, { source: 1, page: 2 }, { source: 1, page: 0 }],
    });
  });

  it('refuses an empty source list and a range that does not fit its source', () => {
    expect(buildMergePlan([])).toEqual({ ok: false, error: { code: 'noSources' } });
    expect(buildMergePlan([{ path: '/a.pdf', pageCount: 2, ranges: '5' }])).toEqual({
      ok: false, error: { code: 'outOfRange', page: 5, count: 2 },
    });
  });

  it('makes one output group per comma-separated range, translating positions to pages', () => {
    // The working document's pages are already reordered upstream; `order` maps position → page.
    expect(buildSplitPlan([0, 1, 2, 3, 4], '1-2,5')).toEqual({ ok: true, groups: [[0, 1], [4]] });
    expect(buildSplitPlan([2, 0, 1], '1,3')).toEqual({ ok: true, groups: [[2], [1]] });
    expect(buildSplitPlan([0, 1], '4')).toEqual({ ok: false, error: { code: 'outOfRange', page: 4, count: 2 } });
  });
});

/* ───────────────────────────── crop ───────────────────────────── */

describe('crop box', () => {
  it('turns margins into the PDF rectangle, with the origin at the bottom-left', () => {
    expect(cropBoxFor({ width: 200, height: 300 }, { top: 10, right: 20, bottom: 30, left: 40 }))
      .toEqual({ ok: true, box: { x: 40, y: 30, width: 140, height: 260 } });
  });

  it('refuses negative margins and margins that eat the whole page', () => {
    expect(cropBoxFor({ width: 100, height: 100 }, { top: 0, right: 0, bottom: 0, left: -1 }))
      .toEqual({ ok: false, error: 'negative' });
    expect(cropBoxFor({ width: 100, height: 100 }, { top: 50, right: 0, bottom: 50, left: 0 }))
      .toEqual({ ok: false, error: 'noArea' });
  });
});

/* ───────────────────────────── watermark ───────────────────────────── */

describe('watermark', () => {
  it('accepts Latin text and the cp1252 letters pdf-lib can encode, and refuses Arabic', () => {
    expect(checkWatermark({ text: 'DRAFT', size: 60, opacity: 0.2, rotation: 45 })).toEqual({ ok: true });
    expect(checkWatermark({ text: 'Confidentiel é 20€', size: 60, opacity: 0.2, rotation: 45 })).toEqual({ ok: true });
    const arabic = checkWatermark({ text: 'مسودة', size: 60, opacity: 0.2, rotation: 45 });
    expect(arabic.ok).toBe(false);
    if (!arabic.ok) {
      expect(arabic.error).toBe('unsupportedChars');
      expect(arabic.chars).toContain('م');
    }
  });

  it('names every unsupported character once', () => {
    expect(unsupportedWatermarkChars('abc ✓✓')).toEqual(['✓']);
    expect(unsupportedWatermarkChars('نص')).toHaveLength(2);
    expect(unsupportedWatermarkChars('plain ASCII 123')).toEqual([]);
  });

  it('refuses an empty text, an absurd size and an impossible opacity', () => {
    expect(checkWatermark({ text: '   ', size: 60, opacity: 0.2, rotation: 0 })).toEqual({ ok: false, error: 'emptyText' });
    expect(checkWatermark({ text: 'x', size: 2, opacity: 0.2, rotation: 0 })).toEqual({ ok: false, error: 'badSize' });
    expect(checkWatermark({ text: 'x', size: 60, opacity: 0, rotation: 0 })).toEqual({ ok: false, error: 'badOpacity' });
    expect(checkWatermark({ text: 'x', size: 60, opacity: 1.5, rotation: 0 })).toEqual({ ok: false, error: 'badOpacity' });
  });

  it('centres the rotated text by moving half its width back from the page centre', () => {
    const page = { width: 200, height: 300 };
    // No rotation: half the 100pt text left of centre, and the ascent below the true middle.
    expect(watermarkAnchor(page, 100, 20, 0)).toEqual({ x: 50, y: 142.8 });
    expect(watermarkAnchor(page, 100, 20, 90)).toEqual({ x: 107.2, y: 100 });
    expect(watermarkAnchor(page, 100, 20, 180)).toEqual({ x: 150, y: 157.2 });
    expect(watermarkAnchor(page, 100, 20, 270)).toEqual({ x: 92.8, y: 200 });
  });
});

/* ───────────────────────── added text ───────────────────────── */

describe('added text', () => {
  it('reads a hex colour as 0..1 channels, with and without the #, and refuses a guess', () => {
    expect(parseHexColor('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHexColor('ff0000')).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseHexColor('#fff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseHexColor('#1a2b3c')).toEqual({ r: 0.1, g: 0.17, b: 0.24 });
    expect(parseHexColor('red')).toBeNull();
    expect(parseHexColor('#12345')).toBeNull();
    expect(parseHexColor('')).toBeNull();
  });

  it('accepts Latin text in a standard font and reports the colour it resolved', () => {
    const check = checkAddedText({ text: 'INVOICE 2026', size: 18, x: 24, y: 30, font: 'helvetica', color: '#1a1a1a' });
    expect(check).toEqual({ ok: true, color: { r: 0.1, g: 0.1, b: 0.1 }, font: 'helvetica' });
    for (const font of TEXT_FONTS) {
      expect(checkAddedText({ text: 'x', size: 12, x: 0, y: 0, font, color: '#000' }).ok, font).toBe(true);
    }
  });

  it('refuses empty text, an absurd size, a bad font, a bad colour and Arabic', () => {
    const base = { text: 'hi', size: 18, x: 10, y: 10, font: 'helvetica', color: '#000000' } as const;
    expect(checkAddedText({ ...base, text: '   ' })).toEqual({ ok: false, error: 'emptyText' });
    expect(checkAddedText({ ...base, size: 2 })).toEqual({ ok: false, error: 'badSize' });
    expect(checkAddedText({ ...base, size: 900 })).toEqual({ ok: false, error: 'badSize' });
    expect(checkAddedText({ ...base, x: -1 })).toEqual({ ok: false, error: 'badPoint' });
    expect(checkAddedText({ ...base, y: Number.NaN })).toEqual({ ok: false, error: 'badPoint' });
    expect(checkAddedText({ ...base, color: 'blue' })).toEqual({ ok: false, error: 'badColor' });
    // A font name the window never offers must not reach pdf-lib.
    expect(checkAddedText({ ...base, font: 'comic' as never })).toEqual({ ok: false, error: 'badFont' });
    const arabic = checkAddedText({ ...base, text: 'فاتورة' });
    expect(arabic.ok).toBe(false);
    if (!arabic.ok) {
      expect(arabic.error).toBe('unsupportedChars');
      expect(arabic.chars).toContain('ف');
    }
  });

  it('refuses a point outside the page, because that text would be invisible', () => {
    const base = { text: 'hi', size: 18, font: 'helvetica', color: '#000000' } as const;
    expect(checkAddedText({ ...base, x: 20, y: 20 }, { width: 200, height: 300 }).ok).toBe(true);
    expect(checkAddedText({ ...base, x: 250, y: 20 }, { width: 200, height: 300 })).toEqual({ ok: false, error: 'badPoint' });
    expect(checkAddedText({ ...base, x: 20, y: 400 }, { width: 200, height: 300 })).toEqual({ ok: false, error: 'badPoint' });
  });
});

/* ───────────────── blank pages and duplicates ───────────────── */

describe('blank page and duplicate positions', () => {
  it('turns the 1-based “insert before page N” into a 0-based insert index', () => {
    expect(insertIndexFor(1, 3)).toBe(0);
    expect(insertIndexFor(2, 3)).toBe(1);
    expect(insertIndexFor(4, 3)).toBe(3);
    // Clamped rather than throwing: the position is a convenience, not an edit that can fail.
    expect(insertIndexFor(0, 3)).toBe(0);
    expect(insertIndexFor(99, 3)).toBe(3);
    expect(insertIndexFor(Number.NaN, 3)).toBe(3);
  });

  it('repeats each selected page right after itself', () => {
    expect(duplicateOrder([0, 1, 2], [1])).toEqual([0, 1, 1, 2]);
    expect(duplicateOrder([0, 1, 2], [0, 2])).toEqual([0, 0, 1, 2, 2]);
    expect(duplicateOrder([0, 1], [])).toEqual([0, 1]);
    // `order` maps position → page, so a reordered document still duplicates in place.
    expect(duplicateOrder([2, 0, 1], [0])).toEqual([2, 2, 0, 1]);
  });
});

/* ─────────────────────── cover a region ─────────────────────── */

describe('cover region', () => {
  const page = { width: 200, height: 300 };

  it('clips a region to the page it is drawn on', () => {
    expect(coverRectFor({ x: 10, y: 20, width: 50, height: 40 }, page))
      .toEqual({ ok: true, rect: { x: 10, y: 20, width: 50, height: 40 } });
    // Half off the right edge and past the top: the drawn rectangle is the visible part only.
    expect(coverRectFor({ x: 150, y: 250, width: 100, height: 100 }, page))
      .toEqual({ ok: true, rect: { x: 150, y: 250, width: 50, height: 50 } });
    expect(coverRectFor({ x: -20, y: -20, width: 60, height: 60 }, page))
      .toEqual({ ok: true, rect: { x: 0, y: 0, width: 40, height: 40 } });
  });

  it('refuses a region with no area and one that does not touch the page', () => {
    expect(coverRectFor({ x: 0, y: 0, width: 0, height: 40 }, page)).toEqual({ ok: false, error: 'badRect' });
    expect(coverRectFor({ x: 0, y: 0, width: 50, height: -5 }, page)).toEqual({ ok: false, error: 'badRect' });
    expect(coverRectFor({ x: 400, y: 10, width: 50, height: 50 }, page)).toEqual({ ok: false, error: 'outside' });
    expect(coverRectFor({ x: 10, y: 900, width: 50, height: 50 }, page)).toEqual({ ok: false, error: 'outside' });
  });
});

/* ───────────────────────── images → PDF ───────────────────────── */

describe('image page layout', () => {
  it('fits an image inside A4 with a margin and centres it', () => {
    const layout = imagePageLayout({ width: 192, height: 192 }, 'a4');
    expect(layout.page).toEqual(A4);
    expect(layout.width).toBeCloseTo(layout.height, 6);
    expect(layout.width).toBeLessThanOrEqual(A4.width - 2 * IMAGE_MARGIN + 0.01);
    // The layout is rounded to two decimals, so centring is asserted to that tolerance.
    expect(Math.abs(layout.x - (A4.width - layout.width) / 2)).toBeLessThan(0.01);
    expect(Math.abs(layout.y - (A4.height - layout.height) / 2)).toBeLessThan(0.01);
  });

  it('keeps the aspect ratio on Letter', () => {
    const layout = imagePageLayout({ width: 400, height: 200 }, 'letter');
    expect(layout.page).toEqual(LETTER);
    expect(layout.width / layout.height).toBeCloseTo(2, 3);
  });

  it('gives a small image its own page at 1:1, and caps a large one', () => {
    expect(imagePageLayout({ width: 100, height: 50 }, 'fit')).toEqual({
      page: { width: 148, height: 98 }, x: 24, y: 24, width: 100, height: 50,
    });
    const large = imagePageLayout({ width: 2000, height: 1000 }, 'fit');
    expect(large.page.width).toBeCloseTo(FIT_MAX_SIDE, 1);
    expect(large.width).toBeCloseTo(FIT_MAX_SIDE - 2 * IMAGE_MARGIN, 1);
    expect(large.width / large.height).toBeCloseTo(2, 2);
  });
});

/* ───────────────────────── file sniffing ───────────────────────── */

describe('file sniffing', () => {
  const withPrefix = (prefix: number[], tail = 40): Uint8Array => {
    const out = new Uint8Array(prefix.length + tail);
    out.set(prefix, 0);
    return out;
  };

  it('reads the real type from the bytes, not the name', () => {
    expect(sniff(pdfBytes())).toBe('pdf');
    expect(sniff(withPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniff(withPrefix([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniff(bytesOf('GIF89a....'))).toBe('gif');
    expect(sniff(bytesOf('RIFF....WEBPVP8 '))).toBe('webp');
    expect(sniff(bytesOf('BM......'))).toBe('bmp');
    expect(sniff(bytesOf('just text'))).toBe('unknown');
    // A WebP called .png still sniffs as WebP: the image path trusts the bytes.
    expect(sniff(bytesOf('RIFF....WEBP'))).not.toBe('png');
  });

  it('finds the %PDF- header inside the first 1024 bytes but not beyond', () => {
    expect(hasPdfHeader(pdfBytes())).toBe(true);
    const junk = new Uint8Array(500 + 8);
    junk.set(bytesOf('%PDF-1.7'), 500);
    expect(hasPdfHeader(junk)).toBe(true);
    const late = new Uint8Array(1500 + 8);
    late.set(bytesOf('%PDF-1.7'), 1500);
    expect(hasPdfHeader(late)).toBe(false);
  });

  it('classifies what the owner asked to open', () => {
    expect(checkOpenable(new Uint8Array(0))).toBe('empty');
    expect(checkOpenable(bytesOf('hello'))).toBe('notPdf');
    expect(checkOpenable(withPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('notPdf');
    expect(checkOpenable(pdfBytes())).toBeNull();
  });
});

/* ───────────────────────── refusal mapping ───────────────────────── */

describe('refusal mapping', () => {
  it('maps what pdf-lib 1.17.1 really throws for an encrypted document', () => {
    // The exact message the library throws; EncryptedPDFError never sets `.name`.
    const thrown = new Error('Input document to `PDFDocument.load` is encrypted. You can use `PDFDocument.load(..., { ignoreEncryption: true })` if you wish to load the document anyways.');
    expect(refusalFromError(thrown)).toEqual({ code: 'encrypted', detail: thrown.message });
    const named = Object.assign(new Error('whatever'), { name: 'EncryptedPDFError' });
    expect(refusalFromError(named).code).toBe('encrypted');
  });

  it('maps a broken body to corrupt, in both shapes pdf-lib reports it', () => {
    expect(refusalFromError(new Error('Failed to parse PDF document (line:6 col:16 offset=16): Failed to parse invalid PDF object')).code).toBe('corrupt');
    expect(refusalFromError(new Error("Cannot read properties of undefined (reading 'Pages')")).code).toBe('corrupt');
  });

  it('maps the image throws, including the string pdf-lib throws for a bad PNG', () => {
    // `embedPng` does not throw an Error at all: `error.message` is undefined there.
    expect(refusalFromError('The input is not a PNG file!')).toEqual({ code: 'imageUnsupported', detail: 'The input is not a PNG file!' });
    expect(refusalFromError(new Error('SOI not found in JPEG')).code).toBe('imageUnsupported');
  });

  it('maps the font encoder refusal to textNotRenderable', () => {
    expect(refusalFromError(new Error('WinAnsi cannot encode "م" (0x0645)')).code).toBe('textNotRenderable');
  });

  it('never invents a success for an unknown value', () => {
    expect(refusalFromError(undefined).code).toBe('unknown');
    expect(refusalFromError(null).code).toBe('unknown');
    expect(refusalFromError(new Error('something else entirely')).code).toBe('unknown');
    expect(refusalFromError({ weird: true }).code).toBe('unknown');
  });
});

/* ───────────────────────── save policy ───────────────────────── */

describe('save policy — never overwrite silently', () => {
  it('defaults to a new sibling file and never the source', async () => {
    const planned = await planSave(
      { sourcePath: '/home/user/report.pdf', suffix: '-copy', overwrite: false },
      taken(),
    );
    expect(planned).toEqual({
      ok: true,
      plan: { source: '/home/user/report.pdf', target: '/home/user/report-copy.pdf', backup: null, isCopy: true },
    });
  });

  it('walks to -copy-2, -copy-3… while the name is taken', async () => {
    const planned = await planSave(
      { sourcePath: '/home/user/report.pdf', suffix: '-copy', overwrite: false },
      taken('/home/user/report-copy.pdf', '/home/user/report-copy-2.pdf'),
    );
    expect(planned.ok && planned.plan.target).toBe('/home/user/report-copy-3.pdf');
  });

  it('names the copy from the source name, in the requested directory', async () => {
    expect(copyNameFor('report.pdf', '-copy')).toBe('report-copy.pdf');
    expect(copyNameFor('report.pdf', '-copy', 2)).toBe('report-copy-2.pdf');
    expect(copyNameFor('archive.tar.pdf', '-1')).toBe('archive.tar-1.pdf');
    expect(copyNameFor('noext', '-1')).toBe('noext-1');
    expect(copyNameFor('report.pdf', '')).toBe('report-copy.pdf');
    const planned = await planSave(
      { sourcePath: '/home/user/report.pdf', suffix: '-copy', overwrite: false, dir: '/home/user/Documents' },
      taken(),
    );
    expect(planned.ok && planned.plan.target).toBe('/home/user/Documents/report-copy.pdf');
  });

  it('keeps every write inside /home/user, falling back from a foreign directory', async () => {
    const foreignDir = await planSave(
      { sourcePath: '/tmp/report.pdf', suffix: '-copy', overwrite: false, dir: '/etc' },
      taken(),
    );
    expect(foreignDir.ok && foreignDir.plan.target).toBe('/home/user/report-copy.pdf');
    const foreignSource = await planSave(
      { sourcePath: '/tmp/report.pdf', suffix: '-copy', overwrite: false },
      taken(),
    );
    expect(foreignSource.ok && foreignSource.plan.target).toBe('/home/user/report-copy.pdf');
  });

  it('replacing the original needs the explicit flag and one .bak', async () => {
    const planned = await planSave(
      { sourcePath: '/home/user/report.pdf', suffix: '-copy', overwrite: true },
      taken('/home/user/report.pdf'),
    );
    expect(planned).toEqual({
      ok: true,
      plan: {
        source: '/home/user/report.pdf',
        target: '/home/user/report.pdf',
        backup: '/home/user/report.pdf.bak',
        isCopy: false,
      },
    });
  });

  it('the backup name never grows a second .bak, even when one already exists', async () => {
    expect(backupPathFor('/home/user/report.pdf')).toBe('/home/user/report.pdf.bak');
    const planned = await planSave(
      { sourcePath: '/home/user/report.pdf', suffix: '-copy', overwrite: true },
      taken('/home/user/report.pdf', '/home/user/report.pdf.bak'),
    );
    expect(planned.ok && planned.plan.backup).toBe('/home/user/report.pdf.bak');
    expect(planned.ok && planned.plan.backup?.endsWith('.bak.bak')).toBe(false);
  });

  it('refuses to replace a file outside /home/user', async () => {
    expect(await planSave(
      { sourcePath: '/tmp/report.pdf', suffix: '-copy', overwrite: true },
      taken('/tmp/report.pdf'),
    )).toEqual({ ok: false, error: 'outsideHome' });
  });

  it('gives up with an error rather than looping for ever when every name is taken', async () => {
    const planned = await planSave(
      { sourcePath: '/home/user/a.pdf', suffix: '-copy', overwrite: false },
      () => true,
    );
    expect(planned).toEqual({ ok: false, error: 'writeFailed' });
  });
});
