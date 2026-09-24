/**
 * PDF engine — stamps, watermarks, headers/footers, page numbers, image stamps
 * (الأختام والعلامة المائية وأرقام الصفحات والرأس والتذييل).
 *
 * `addStamp` is a real /Stamp annotation (movable and removable later, like in Acrobat).
 * Everything else is page furniture drawn into the page content, laid out in VIEW space (the
 * page as the reader shows it), so a watermark stays centred and a footer stays at the bottom
 * on a page with /Rotate 90. All text goes through the shared Unicode layout (Arabic shaped).
 */
import {
  PDFDocument, concatTransformationMatrix, popGraphicsState, pushGraphicsState, setGraphicsState, type PDFImage,
  type PDFOperator, type PDFPage,
} from 'pdf-lib';
import { sniff } from '../ops';
import type { OpResult } from '../pdfdoc';
import { addAnnotation } from './annotations';
import { EngineRefusal, checkPage, clamp01, pageContent, requireColor, runOp, validBox, viewToUser, type Box } from './common';
import { blockOperators, embedTextFonts, layoutLine, opacityState, registerFonts, type Align, type TextFonts } from './text';

export interface StampInput {
  page: number;
  rect: Box;
  /** e.g. "APPROVED", "معتمد", "DRAFT / مسودة". */
  text: string;
  color: string;
  /** Extension: default 1. */
  opacity?: number;
}

/** A rubber stamp: a /Stamp annotation with a bordered, centred label (Arabic needs `opts.arabicFont`). */
export async function addStamp(bytes: Uint8Array, input: StampInput, opts: { arabicFont?: Uint8Array } = {}): Promise<OpResult> {
  return addAnnotation(bytes, {
    page: input.page, kind: 'stamp', rect: input.rect, contents: input.text, color: input.color,
    opacity: input.opacity ?? 1, width: 2,
  }, opts);
}

/* ───────────────────────────── shared ───────────────────────────── */

/** Pages the caller asked for, validated; default all. */
function targetPages(doc: PDFDocument, pages: readonly number[] | undefined): number[] {
  const count = doc.getPageCount();
  const list = pages === undefined ? [...Array(count).keys()] : [...new Set(pages)].filter((p) => Number.isInteger(p) && p >= 0 && p < count);
  if (!list.length) throw new EngineRefusal('emptyResult', 'no pages selected');
  return list.sort((a, b) => a - b);
}

/** Snapshot of every page's content, to prove afterwards that only the chosen pages changed. */
function snapshot(doc: PDFDocument): string[] {
  return doc.getPages().map((_, i) => pageContent(doc, i));
}

function verifyPages(before: () => string[], target: () => number[], operator: string): (doc: PDFDocument) => string[] {
  return (doc) => {
    const bad: string[] = [];
    const was = before();
    const chosen = new Set(target());
    doc.getPages().forEach((_, i) => {
      const now = pageContent(doc, i);
      if (chosen.has(i)) {
        if (now.length <= (was[i]?.length ?? 0)) bad.push(`page ${i + 1} did not change`);
        if (!now.includes(operator)) bad.push(`page ${i + 1} lacks ${operator}`);
      } else if (now !== was[i]) {
        bad.push(`page ${i + 1} changed but was not selected`);
      }
    });
    return bad;
  };
}

function withOpacity(doc: PDFDocument, page: PDFPage, opacity: number): PDFOperator[] {
  return opacity < 1 ? [setGraphicsState(page.node.newExtGState('GS', opacityState(doc, opacity)))] : [];
}

/* ───────────────────────────── watermark ───────────────────────────── */

export interface WatermarkInput {
  text: string;
  /** 0-based pages; default every page. */
  pages?: number[];
  /** Font size in points; default 60. */
  size?: number;
  /** 0..1; default 0.25. */
  opacity?: number;
  color?: string;
  /** Degrees counter-clockwise; default 45 (the diagonal). */
  rotation?: number;
}

/** A centred, rotated, translucent text watermark on the chosen pages only. */
export async function addTextWatermark(bytes: Uint8Array, input: WatermarkInput, opts: { arabicFont?: Uint8Array } = {}): Promise<OpResult> {
  const text = input.text.trim();
  if (!text) return { ok: false, code: 'unknown', detail: 'emptyText' };
  const size = input.size ?? 60;
  if (!Number.isFinite(size) || size < 4 || size > 400) return { ok: false, code: 'unknown', detail: 'badSize' };
  let before: string[] = [];
  let pages: number[] = [];
  return runOp(bytes, async (doc) => {
    const color = requireColor(input.color ?? '#808080');
    pages = targetPages(doc, input.pages);
    before = snapshot(doc);
    const fonts = await embedTextFonts(doc, text, opts.arabicFont);
    const angle = (((input.rotation ?? 45) % 360) * Math.PI) / 180;
    const opacity = clamp01(input.opacity, 0.25);
    for (const index of pages) {
      const page = doc.getPage(index);
      const keys = registerFonts(fonts, (tag, ref) => page.node.newFontDictionary(tag, ref));
      const view = viewToUser(page);
      const lines = text.split('\n').map((l) => layoutLine(fonts, l, size));
      const width = Math.max(...lines.map((l) => l.width));
      const lh = size * 1.2;
      const height = lines.length * lh;
      const block = blockOperators(fonts, keys, text, {
        x: -width / 2, y: height / 2 - size * 0.8, size, color, maxWidth: width, align: 'center', lineHeight: lh,
      });
      page.pushOperators(
        pushGraphicsState(),
        ...withOpacity(doc, page, opacity),
        concatTransformationMatrix(...view.matrix),
        concatTransformationMatrix(1, 0, 0, 1, view.width / 2, view.height / 2),
        concatTransformationMatrix(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0),
        ...block.ops,
        popGraphicsState(),
      );
    }
    return `watermark pages=${pages.map((p) => p + 1).join(',')}`;
  }, verifyPages(() => before, () => pages, 'TJ'));
}

/* ───────────────────────────── header / footer / page numbers ───────────────────────────── */

export interface Slots { left?: string; center?: string; right?: string }

export interface HeaderFooterInput {
  header?: Slots;
  footer?: Slots;
  /** 0-based pages; default every page. */
  pages?: number[];
  /** Default 10. */
  size?: number;
  color?: string;
  /** Distance from the page edge in points; default 28. */
  margin?: number;
  /** The number `{n}` shows for the first page of the document; default 1. `{total}` = page count. */
  startAt?: number;
  opacity?: number;
}

/** `{n}` and `{total}` in a slot → the real numbers. Pure. */
export function fillTokens(template: string, n: number, total: number): string {
  return template.replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(total));
}

/**
 * Header and/or footer text in three slots (left, centre, right) on the chosen pages. Slots may
 * carry `{n}` and `{total}`; a slot that is empty after filling is skipped.
 */
export async function addHeaderFooter(bytes: Uint8Array, input: HeaderFooterInput, opts: { arabicFont?: Uint8Array } = {}): Promise<OpResult> {
  const size = input.size ?? 10;
  if (!Number.isFinite(size) || size < 4 || size > 72) return { ok: false, code: 'unknown', detail: 'badSize' };
  const slots = [input.header, input.footer].flatMap((s) => (s ? [s.left, s.center, s.right] : [])).filter((t): t is string => !!t && !!t.trim());
  if (!slots.length) return { ok: false, code: 'unknown', detail: 'emptyText' };
  let before: string[] = [];
  let pages: number[] = [];
  return runOp(bytes, async (doc) => {
    const color = requireColor(input.color ?? '#333333');
    pages = targetPages(doc, input.pages);
    before = snapshot(doc);
    const total = doc.getPageCount();
    const start = Number.isInteger(input.startAt) ? (input.startAt as number) : 1;
    // Fonts are embedded once, for every character any page will show.
    const sample = `${slots.join(' ')} 0123456789`;
    const fonts: TextFonts = await embedTextFonts(doc, sample, opts.arabicFont);
    const margin = input.margin ?? 28;
    for (const index of pages) {
      const page = doc.getPage(index);
      const keys = registerFonts(fonts, (tag, ref) => page.node.newFontDictionary(tag, ref));
      const view = viewToUser(page);
      const ops: PDFOperator[] = [];
      const place = (slotsOf: Slots | undefined, baseline: number): void => {
        if (!slotsOf) return;
        const entries: [string | undefined, Align][] = [[slotsOf.left, 'left'], [slotsOf.center, 'center'], [slotsOf.right, 'right']];
        for (const [template, align] of entries) {
          if (!template) continue;
          const t = fillTokens(template, start + index, total + start - 1).trim();
          if (!t) continue;
          const block = blockOperators(fonts, keys, t, {
            x: margin, y: baseline, size, color, maxWidth: Math.max(1, view.width - 2 * margin), align,
          });
          ops.push(...block.ops);
        }
      };
      place(input.header, view.height - margin - size * 0.8);
      place(input.footer, margin);
      page.pushOperators(pushGraphicsState(), ...withOpacity(doc, page, clamp01(input.opacity, 1)),
        concatTransformationMatrix(...view.matrix), ...ops, popGraphicsState());
    }
    return `header/footer pages=${pages.length}`;
  }, verifyPages(() => before, () => pages, 'TJ'));
}

export type NumberPosition = 'bottom-center' | 'bottom-left' | 'bottom-right' | 'top-center' | 'top-left' | 'top-right';

export interface PageNumbersInput {
  /** Default `'{n} / {total}'`. */
  format?: string;
  position?: NumberPosition;
  pages?: number[];
  size?: number;
  color?: string;
  margin?: number;
  startAt?: number;
}

/** "x / y" page numbers: a header/footer with one slot. */
export async function addPageNumbers(bytes: Uint8Array, input: PageNumbersInput = {}, opts: { arabicFont?: Uint8Array } = {}): Promise<OpResult> {
  const format = input.format ?? '{n} / {total}';
  const [where, side] = (input.position ?? 'bottom-center').split('-') as ['top' | 'bottom', 'left' | 'center' | 'right'];
  const slots: Slots = { [side]: format };
  return addHeaderFooter(bytes, {
    header: where === 'top' ? slots : undefined,
    footer: where === 'bottom' ? slots : undefined,
    pages: input.pages, size: input.size, color: input.color, margin: input.margin, startAt: input.startAt,
  }, opts);
}

/* ───────────────────────────── image stamp ───────────────────────────── */

export interface ImageStampInput {
  /** 0-based pages. */
  pages: number[];
  rect: Box;
  /** PNG or JPEG bytes (decided by the bytes, never a name). */
  image: Uint8Array;
  opacity?: number;
}

/** A picture (logo, scanned seal) drawn at `rect` on the chosen pages. */
export async function addImageStamp(bytes: Uint8Array, input: ImageStampInput): Promise<OpResult> {
  const kind = sniff(input.image);
  if (kind !== 'png' && kind !== 'jpeg') return { ok: false, code: 'imageUnsupported', detail: kind };
  if (!validBox(input.rect)) return { ok: false, code: 'unknown', detail: 'bad rect' };
  let before: string[] = [];
  let pages: number[] = [];
  return runOp(bytes, async (doc) => {
    pages = targetPages(doc, input.pages);
    before = snapshot(doc);
    let img: PDFImage;
    try {
      img = kind === 'png' ? await doc.embedPng(input.image) : await doc.embedJpg(input.image);
    } catch (error) {
      throw new EngineRefusal('imageBroken', error instanceof Error ? error.message : 'image');
    }
    for (const index of pages) {
      checkPage(doc, index).drawImage(img, { ...input.rect, opacity: clamp01(input.opacity, 1) });
    }
    return `image pages=${pages.length}`;
  }, verifyPages(() => before, () => pages, 'Do'));
}
