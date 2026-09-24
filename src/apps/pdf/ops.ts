/**
 * PDF app — the pure part (طبقة الحساب الصافية).
 *
 * Everything decided here is decided without pdf-lib, without the DOM and without
 * the VFS, so a test can pin it exactly: page ranges, page-order edits, the crop
 * rectangle, the watermark placement, added-text placement and colour, the region a
 * "cover" may draw into, blank-page and duplicate positions, the image layout, the
 * save policy (a new file by default, exactly one `.bak` when the owner asks to
 * overwrite) and the mapping from a thrown value to an honest refusal.
 *
 * The impure half lives in `pdfdoc.ts` (pdf-lib) and `save.ts` (VFS); neither makes
 * a decision that is not written down here.
 */
import { HOME } from '../../kernel/types';
import { basename, dirname, join, normalize } from '../../kernel/path';

export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** Why the app refuses to go on. Every code has one bilingual message (see `strings.ts`). */
export type PdfRefusalCode =
  | 'empty'             // zero bytes
  | 'notPdf'            // no %PDF- header (or not a PDF at all)
  | 'encrypted'         // pdf-lib refused it: /Encrypt in the trailer
  | 'corrupt'           // a PDF, but the parser fell over
  | 'imageUnsupported'  // not a PNG and not a JPEG (GIF/WebP/BMP/…)
  | 'imageBroken'       // a PNG/JPEG signature whose body cannot be decoded
  | 'textNotRenderable' // a character the standard PDF fonts cannot encode
  | 'noForm'            // the document carries no AcroForm to fill
  | 'emptyResult'       // the operation would leave zero pages
  | 'outsideHome'       // the target path is outside /home/user
  | 'writeFailed'       // the VFS said no
  | 'unknown';

/* ───────────────────────────── page ranges ───────────────────────────── */

export type RangeError =
  | { code: 'empty' }
  | { code: 'syntax'; token: string }
  | { code: 'reversed'; from: number; to: number }
  | { code: 'outOfRange'; page: number; count: number };

export type RangeGroups =
  | { ok: true; groups: number[][] }   // 0-based page indices, one list per comma-separated part
  | { ok: false; error: RangeError };

export type RangePages =
  | { ok: true; pages: number[] }      // 0-based, deduplicated, first-seen order kept
  | { ok: false; error: RangeError };

/** Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits become ASCII, so a range typed on an Arabic keyboard parses. */
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_INDIC = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const a = ARABIC_INDIC.indexOf(ch);
    const e = EXTENDED_INDIC.indexOf(ch);
    out += a >= 0 ? String(a) : e >= 0 ? String(e) : ch;
  }
  return out;
}

const EVERYTHING = /^(\*|all|الكل)$/i;

/**
 * One range box, split into groups. Accepts `1-3,5,8-`, `-4` (pages 1–4), `*` / `all` /
 * `الكل` (every page), Arabic digits, and Arabic comma/`;` as separators. Each group keeps
 * the order the owner typed, so `5,1` extracts page 5 first — that is how extraction also
 * serves as a reorder. Pages are 1-based in the text and 0-based in the result.
 */
export function parseRangeGroups(text: string, pageCount: number): RangeGroups {
  const tokens = normalizeDigits(text).split(/[,،;]/).map((s) => s.trim()).filter(Boolean);
  if (!tokens.length) return { ok: false, error: { code: 'empty' } };
  const groups: number[][] = [];
  const one = (n: number): RangeError | null =>
    n < 1 || n > pageCount ? { code: 'outOfRange', page: n, count: pageCount } : null;

  for (const token of tokens) {
    if (EVERYTHING.test(token)) {
      groups.push(Array.from({ length: pageCount }, (_, i) => i));
      continue;
    }
    const single = /^(\d+)$/.exec(token);
    if (single) {
      const n = Number(single[1]);
      const bad = one(n);
      if (bad) return { ok: false, error: bad };
      groups.push([n - 1]);
      continue;
    }
    const range = /^(\d*)\s*[-–—]\s*(\d*)$/.exec(token);
    if (!range) return { ok: false, error: { code: 'syntax', token } };
    const fromText = range[1];
    const toText = range[2];
    if (fromText === '' && toText === '') return { ok: false, error: { code: 'syntax', token } };
    const from = fromText === '' ? 1 : Number(fromText);
    const to = toText === '' ? pageCount : Number(toText);
    if (from > to) return { ok: false, error: { code: 'reversed', from, to } };
    const bad = one(from) ?? one(to);
    if (bad) return { ok: false, error: bad };
    groups.push(Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i));
  }
  return { ok: true, groups };
}

/** The union of `parseRangeGroups`, in first-seen order, with no page twice. */
export function parsePageRanges(text: string, pageCount: number): RangePages {
  const parsed = parseRangeGroups(text, pageCount);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const seen = new Set<number>();
  const pages: number[] = [];
  for (const group of parsed.groups) {
    for (const page of group) {
      if (seen.has(page)) continue;
      seen.add(page);
      pages.push(page);
    }
  }
  return { ok: true, pages };
}

/* ───────────────────────── page order edits ───────────────────────── */

/** Moves the element at `from` so that it ends up at index `to`; every other page keeps its relative order. */
export function movePage(order: readonly number[], from: number, to: number): number[] {
  const next = [...order];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export type DeleteResult = { ok: true; order: number[] } | { ok: false; error: 'none' | 'allPages' };

/** `pages` are 0-based indices into `order` (the current page positions), not page labels. */
export function deletePages(order: readonly number[], pages: readonly number[]): DeleteResult {
  const drop = new Set(pages);
  if (!drop.size) return { ok: false, error: 'none' };
  const left = order.filter((_, i) => !drop.has(i));
  // A PDF with zero pages is not a document: refuse instead of writing one.
  if (!left.length) return { ok: false, error: 'allPages' };
  return { ok: true, order: left };
}

/* ───────────────────────────── rotation ───────────────────────────── */

/** Any degree value (including negative) becomes 0 | 90 | 180 | 270. */
export function normalizeRotation(deg: number): number {
  const r = Math.round(deg / 90) * 90;
  return ((r % 360) + 360) % 360;
}

/** Absolute rotation after turning every page by `delta` degrees. `rotations` is per page, in page order. */
export function rotateAll(rotations: readonly number[], delta: number): number[] {
  return rotations.map((r) => normalizeRotation(r + delta));
}

/** Absolute rotation after turning only the pages at the given 0-based positions. */
export function rotatePages(rotations: readonly number[], pages: readonly number[], delta: number): number[] {
  const turn = new Set(pages);
  return rotations.map((r, i) => (turn.has(i) ? normalizeRotation(r + delta) : normalizeRotation(r)));
}

/* ──────────────────────── merge / split plans ──────────────────────── */

export interface MergeSource { path: string; pageCount: number; ranges: string }
export interface PageRef { source: number; page: number }

export type MergePlan = { ok: true; items: PageRef[] } | { ok: false; error: RangeError | { code: 'noSources' } };

/**
 * The final page sequence of a merge: sources in the order the owner listed them, and inside
 * each source only the pages its range box asks for (blank = all its pages).
 */
export function buildMergePlan(sources: readonly MergeSource[]): MergePlan {
  if (!sources.length) return { ok: false, error: { code: 'noSources' } };
  const items: PageRef[] = [];
  for (const [index, source] of sources.entries()) {
    if (source.pageCount < 1) return { ok: false, error: { code: 'outOfRange', page: 1, count: source.pageCount } };
    const text = source.ranges.trim() === '' ? '*' : source.ranges;
    const parsed = parsePageRanges(text, source.pageCount);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    for (const page of parsed.pages) items.push({ source: index, page });
  }
  return { ok: true, items };
}

export type SplitPlan = { ok: true; groups: number[][] } | { ok: false; error: RangeError };

/** One output PDF per comma-separated range of the working document: `1-3,7` writes two files. */
export function buildSplitPlan(order: readonly number[], text: string): SplitPlan {
  const parsed = parseRangeGroups(text, order.length);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, groups: parsed.groups.map((group) => group.map((p) => order[p])) };
}

/* ──────────────────────────── crop box ──────────────────────────── */

export interface Margins { top: number; right: number; bottom: number; left: number }
export type CropResult = { ok: true; box: Rect } | { ok: false; error: 'negative' | 'noArea' };

/** Margins in points, cut off each side of the page. PDF's origin is bottom-left, so `bottom` becomes `y`. */
export function cropBoxFor(size: Size, margins: Margins): CropResult {
  if (margins.top < 0 || margins.right < 0 || margins.bottom < 0 || margins.left < 0) {
    return { ok: false, error: 'negative' };
  }
  const width = size.width - margins.left - margins.right;
  const height = size.height - margins.top - margins.bottom;
  if (width <= 0 || height <= 0) return { ok: false, error: 'noArea' };
  return { ok: true, box: { x: margins.left, y: margins.bottom, width, height } };
}

/* ─────────────────────────── watermark ─────────────────────────── */

export interface WatermarkOptions { text: string; size: number; opacity: number; rotation: number }

export type WatermarkCheck =
  | { ok: true }
  | { ok: false; error: 'emptyText' | 'badSize' | 'badOpacity' | 'unsupportedChars'; chars?: string };

/**
 * The characters pdf-lib's built-in PDF fonts (WinAnsi / cp1252) can actually draw:
 * printable ASCII, Latin-1 letters and the cp1252 extras. Arabic, CJK and emoji are not
 * in the encoding, and embedding an Arabic font would mean shipping a font file — so the
 * app refuses them honestly instead of drawing boxes or throwing mid-operation.
 *
 * This list is deliberately conservative and `pdfdoc.ts` still catches the encoder's own
 * refusal, so a character that slips past here can never produce a half-written file.
 */
const CP1252_EXTRAS = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

export function unsupportedWatermarkChars(text: string): string[] {
  const extras = new Set(CP1252_EXTRAS);
  const bad: string[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const ascii = code >= 0x20 && code <= 0x7e;
    const latin1 = code >= 0xa0 && code <= 0xff;
    if (ascii || latin1 || ch === '\t' || extras.has(ch)) continue;
    if (!bad.includes(ch)) bad.push(ch);
  }
  return bad;
}

export function checkWatermark(o: WatermarkOptions): WatermarkCheck {
  if (!o.text.trim()) return { ok: false, error: 'emptyText' };
  if (!Number.isFinite(o.size) || o.size < 4 || o.size > 400) return { ok: false, error: 'badSize' };
  if (!Number.isFinite(o.opacity) || o.opacity <= 0 || o.opacity > 1) return { ok: false, error: 'badOpacity' };
  const bad = unsupportedWatermarkChars(o.text);
  if (bad.length) return { ok: false, error: 'unsupportedChars', chars: bad.join(' ') };
  return { ok: true };
}

/**
 * Where to start drawing a rotated watermark so that its box is centred on the page.
 * pdf-lib draws from the baseline's left edge, so half the text width moves back and the
 * leftover ascent (~0.36 em for Helvetica) moves up.
 */
export function watermarkAnchor(page: Size, textWidth: number, textSize: number, rotation: number): { x: number; y: number } {
  const rad = (normalizeRotation(rotation) * Math.PI) / 180;
  const half = textWidth / 2;
  const rise = textSize * 0.36;
  return {
    x: Math.round((page.width / 2 - half * Math.cos(rad) + rise * Math.sin(rad)) * 100) / 100,
    y: Math.round((page.height / 2 - half * Math.sin(rad) - rise * Math.cos(rad)) * 100) / 100,
  };
}

/* ──────────────────────── added text ──────────────────────── */

/**
 * The standard PDF fonts pdf-lib can draw with. They are not embedded as files — every
 * reader already has them — which is why an Arabic font is not in this list: shipping one
 * would mean a new dependency. The page's own embedded fonts cannot be reused safely, so
 * this is said plainly in the window instead of pretending otherwise.
 */
export const TEXT_FONTS = ['helvetica', 'helveticaBold', 'timesRoman', 'timesRomanItalic', 'courier'] as const;
export type TextFont = (typeof TEXT_FONTS)[number];

export interface Rgb { r: number; g: number; b: number }

/**
 * `#rgb` / `#rrggbb`, with or without the `#`, → channels in 0..1. Anything else is `null`,
 * never a guess: a wrong colour that "looks close" is worse than refusing the value.
 */
export function parseHexColor(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(hex) ? [...hex].map((ch) => ch + ch).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const channel = (at: number): number => Math.round((parseInt(full.slice(at, at + 2), 16) / 255) * 100) / 100;
  return { r: channel(0), g: channel(2), b: channel(4) };
}

/** One added piece of text: where, how big, in which standard font and colour. */
export interface AddedText {
  text: string;
  size: number;
  x: number;
  y: number;
  font: TextFont;
  color: string;
}

export type AddedTextCheck =
  | { ok: true; color: Rgb; font: TextFont }
  | { ok: false; error: 'emptyText' | 'badSize' | 'badPoint' | 'badColor' | 'badFont' | 'unsupportedChars'; chars?: string };

/**
 * Decides whether the text can be drawn, before pdf-lib is asked. `page` is optional: with it
 * the point must fall inside the page, because text drawn outside the box would still "add a
 * content stream" while showing the owner nothing.
 */
export function checkAddedText(o: AddedText, page?: Size): AddedTextCheck {
  if (!o.text.trim()) return { ok: false, error: 'emptyText' };
  if (!Number.isFinite(o.size) || o.size < 4 || o.size > 400) return { ok: false, error: 'badSize' };
  if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || o.x < 0 || o.y < 0) return { ok: false, error: 'badPoint' };
  if (page && (o.x > page.width || o.y > page.height)) return { ok: false, error: 'badPoint' };
  if (!(TEXT_FONTS as readonly string[]).includes(o.font)) return { ok: false, error: 'badFont' };
  const color = parseHexColor(o.color);
  if (!color) return { ok: false, error: 'badColor' };
  const bad = unsupportedWatermarkChars(o.text);
  if (bad.length) return { ok: false, error: 'unsupportedChars', chars: bad.join(' ') };
  return { ok: true, color, font: o.font };
}

/* ───────────────────── blank pages and duplicates ───────────────────── */

/**
 * The 1-based "insert before page N" the window shows → a 0-based insert index inside
 * `0..pageCount`. `pageCount + 1` is "at the end", and anything absurd is clamped rather than
 * throwing: the position is a convenience, not a reason to fail an edit.
 */
export function insertIndexFor(pageNumber: number, pageCount: number): number {
  if (!Number.isFinite(pageNumber)) return pageCount;
  return Math.min(Math.max(Math.round(pageNumber) - 1, 0), pageCount);
}

/**
 * The reading order after every page at the given 0-based positions is repeated right after
 * itself: `[0,1,2]` + duplicate page 1 → `[0,1,1,2]`. `order` maps position → page, so the
 * duplicate lands next to its original instead of at the end of the document.
 */
export function duplicateOrder(order: readonly number[], pages: readonly number[]): number[] {
  const repeat = new Set(pages);
  const out: number[] = [];
  order.forEach((page, at) => {
    out.push(page);
    if (repeat.has(at)) out.push(page);
  });
  return out;
}

/* ─────────────────────── cover a region (hiding) ─────────────────────── */

export type CoverShape = 'rect' | 'ellipse';
export interface CoverRegion { x: number; y: number; width: number; height: number }
export type CoverCheck = { ok: true; rect: CoverRegion } | { ok: false; error: 'badRect' | 'outside' };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Clips the region to the page. A region with no area, or one that does not touch the page,
 * is refused — and no region can be drawn outside the page, so the window can never report a
 * cover that hides nothing.
 */
export function coverRectFor(region: CoverRegion, page: Size): CoverCheck {
  const { x, y, width, height } = region;
  if (![x, y, width, height].every((n) => Number.isFinite(n)) || width <= 0 || height <= 0) {
    return { ok: false, error: 'badRect' };
  }
  const left = Math.max(x, 0);
  const bottom = Math.max(y, 0);
  const right = Math.min(x + width, page.width);
  const top = Math.min(y + height, page.height);
  if (right - left <= 0 || top - bottom <= 0) return { ok: false, error: 'outside' };
  return { ok: true, rect: { x: round2(left), y: round2(bottom), width: round2(right - left), height: round2(top - bottom) } };
}

/* ──────────────────────── images → PDF ──────────────────────── */

export type ImagePageMode = 'a4' | 'letter' | 'fit';

export const A4: Size = { width: 595.28, height: 841.89 };
export const LETTER: Size = { width: 612, height: 792 };
export const IMAGE_MARGIN = 24;
/** Longest side a "fit to image" page may reach, in points (A4 height). */
export const FIT_MAX_SIDE = 841.89;

export interface ImageLayout { page: Size; x: number; y: number; width: number; height: number }

/**
 * Where an image of `img` *pixels* lands on a page. Points are 1/72 inch; a pixel is not a
 * point, so "fit to image" scales by at most 1:1 and caps the longest side, while A4 and
 * Letter fit the image inside the page with a margin on every side.
 */
export function imagePageLayout(img: Size, mode: ImagePageMode, margin: number = IMAGE_MARGIN): ImageLayout {
  const iw = Math.max(1, img.width);
  const ih = Math.max(1, img.height);
  if (mode === 'fit') {
    const scale = Math.min(1, (FIT_MAX_SIDE - 2 * margin) / Math.max(iw, ih));
    const width = Math.round(iw * scale * 100) / 100;
    const height = Math.round(ih * scale * 100) / 100;
    return {
      page: { width: Math.round((width + 2 * margin) * 100) / 100, height: Math.round((height + 2 * margin) * 100) / 100 },
      x: margin, y: margin, width, height,
    };
  }
  const base = mode === 'letter' ? LETTER : A4;
  const scale = Math.min((base.width - 2 * margin) / iw, (base.height - 2 * margin) / ih);
  const width = Math.round(iw * scale * 100) / 100;
  const height = Math.round(ih * scale * 100) / 100;
  return {
    page: base,
    x: Math.round(((base.width - width) / 2) * 100) / 100,
    y: Math.round(((base.height - height) / 2) * 100) / 100,
    width, height,
  };
}

/* ─────────────────────── file kind sniffing ─────────────────────── */

export type SniffKind = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'unknown';

const sig = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

function matches(bytes: Uint8Array, at: number, signature: readonly number[]): boolean {
  if (bytes.length < at + signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[at + i] !== signature[i]) return false;
  return true;
}

/** The file's real type from its own bytes — never from its name (a `.png` can hold a WebP). */
export function sniff(bytes: Uint8Array): SniffKind {
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (matches(bytes, 0, sig('GIF8'))) return 'gif';
  if (matches(bytes, 0, sig('RIFF')) && matches(bytes, 8, sig('WEBP'))) return 'webp';
  if (matches(bytes, 0, sig('BM'))) return 'bmp';
  if (hasPdfHeader(bytes)) return 'pdf';
  return 'unknown';
}

/** The PDF header may be preceded by up to 1024 bytes of junk (the spec allows it). */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024);
  const needle = sig('%PDF-');
  for (let at = 0; at + needle.length <= limit; at++) if (matches(bytes, at, needle)) return true;
  return false;
}

/** The refusal for a file the owner asked to open, or `null` when it looks like a PDF. */
export function checkOpenable(bytes: Uint8Array): PdfRefusalCode | null {
  if (bytes.length === 0) return 'empty';
  return hasPdfHeader(bytes) ? null : 'notPdf';
}

/* ─────────────────────── refusal mapping ─────────────────────── */

export interface Refusal { code: PdfRefusalCode; detail: string }

/**
 * What a thrown value from pdf-lib means, honestly.
 *
 * pdf-lib 1.17.1 is inconsistent: `EncryptedPDFError` is thrown without a `name`, and
 * `embedPng` throws a *string* ("The input is not a PNG file!"), so `error.message` is
 * undefined there. This reads the value defensively and never guesses a success.
 */
export function refusalFromError(error: unknown): Refusal {
  const text = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : error === undefined || error === null ? '' : String(error);
  const name = error instanceof Error ? error.name : '';

  if (name === 'EncryptedPDFError' || /is encrypted/i.test(text)) return { code: 'encrypted', detail: text };
  // pdf-lib reports a broken body in more than one way: a parser error, or a TypeError
  // on the half-built document ("Cannot read properties of undefined (reading 'Pages')").
  if (/no pdf header|failed to parse pdf document|cannot read propert/i.test(text)) {
    return { code: 'corrupt', detail: text };
  }
  if (/winansi cannot encode|unsupported encoding/i.test(text)) return { code: 'textNotRenderable', detail: text };
  if (/png|jpe?g|image|soi not found|embed/i.test(text)) return { code: 'imageUnsupported', detail: text };
  return { code: 'unknown', detail: text };
}

/* ─────────────────────────── save policy ─────────────────────────── */

export type SaveErrorCode = 'outsideHome' | 'noBytes' | 'writeFailed';

export interface SaveRequest {
  /** The file that was opened; the default target is a sibling copy, never this file. */
  sourcePath: string;
  /** Inserted before the extension: `report.pdf` + `-copy` → `report-copy.pdf`. Empty means `-copy`. */
  suffix: string;
  /** true only when the owner explicitly asked to replace the original. */
  overwrite: boolean;
  /** Directory for the new copy; ignored (HOME is used) when it is outside /home/user. */
  dir?: string;
}

export interface SavePlan {
  source: string;
  target: string;
  /** Exactly one `.bak` path, or null when nothing is replaced. */
  backup: string | null;
  isCopy: boolean;
}

export type SavePlanResult = { ok: true; plan: SavePlan } | { ok: false; error: SaveErrorCode };

/** The one backup name: `report.pdf` → `report.pdf.bak`. It never grows a second `.bak`. */
export function backupPathFor(sourcePath: string): string {
  return `${sourcePath}.bak`;
}

/** `report.pdf` + `-copy` → `report-copy.pdf`; attempt 2 → `report-copy-2.pdf`. */
export function copyNameFor(name: string, suffix: string, attempt = 1): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const tag = suffix && suffix.length ? suffix : '-copy';
  return attempt <= 1 ? `${stem}${tag}${ext}` : `${stem}${tag}-${attempt}${ext}`;
}

const insideHome = (path: string, home: string): boolean => path === home || path.startsWith(home + '/');

/**
 * Where a save goes and whether a backup is needed. Nothing is ever written outside
 * `/home/user`, and the default never touches the file that was opened:
 *
 *  • copy (default): `<dir>/<name><suffix>.pdf`, then `-2`, `-3`… while that name is taken.
 *  • overwrite (explicit): the source itself, after exactly one `.bak` copy of it.
 *
 * `isTaken` may be synchronous (tests) or asynchronous (the real VFS checks `exists`).
 */
export async function planSave(
  request: SaveRequest,
  isTaken: (path: string) => boolean | Promise<boolean>,
  home: string = HOME,
): Promise<SavePlanResult> {
  const source = join(dirname(request.sourcePath), basename(request.sourcePath));
  if (request.overwrite) {
    if (!insideHome(source, home)) return { ok: false, error: 'outsideHome' };
    return { ok: true, plan: { source, target: source, backup: backupPathFor(source), isCopy: false } };
  }
  const wanted = request.dir ? normalize(request.dir) : dirname(source);
  const dir = insideHome(wanted, home) ? wanted : home;
  for (let attempt = 1; attempt <= 500; attempt++) {
    const target = join(dir, copyNameFor(basename(source), request.suffix, attempt));
    if (!(await isTaken(target))) {
      return { ok: true, plan: { source, target, backup: null, isCopy: true } };
    }
  }
  return { ok: false, error: 'writeFailed' };
}
