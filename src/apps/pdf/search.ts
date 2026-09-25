/**
 * PDF app — finding text in the document (البحث في النص), pure and testable.
 *
 * pdf.js hands every page's text as "items" (runs of text in logical order). This module joins
 * them into one searchable string, finds a query in it — ignoring case, Arabic diacritics,
 * tatweel and the alef/yaa/taa-marbuta spellings people type interchangeably — and maps every
 * hit back to the items (and the character offsets inside them) so the text layer can paint it.
 */

export interface TextItemLike { str: string; hasEOL?: boolean }

export interface PageText {
  /** The page's text: the items joined, with a newline after an item that ends a line. */
  text: string;
  /** Offset in `text` where each item starts. */
  starts: number[];
}

export interface ItemSpan { item: number; start: number; end: number }

export interface Hit { page: number; start: number; end: number }

export function buildPageText(items: readonly TextItemLike[]): PageText {
  const starts: number[] = [];
  let text = '';
  for (const item of items) {
    starts.push(text.length);
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return { text, starts };
}

const DIACRITICS = /[ً-ٰٟۖ-ۭـ‌-‏؜]/;
const FOLD: Record<string, string> = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ئ': 'ي', 'ؤ': 'و', 'ة': 'ه', 'ک': 'ك', 'ی': 'ي',
};

/**
 * The folded form of `text` and, for every character of it, the index of the character of
 * `text` it came from. Diacritics disappear, runs of whitespace become one space, presentation
 * forms (ﻻ) unfold to their letters, and case is ignored.
 */
export function foldForSearch(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let lastWasSpace = false;
  let index = 0;
  for (const ch of text) {
    const at = index;
    index += ch.length;
    if (DIACRITICS.test(ch)) continue;
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      folded += ' ';
      map.push(at);
      lastWasSpace = true;
      continue;
    }
    lastWasSpace = false;
    const expanded = ch.normalize('NFKC').toLocaleLowerCase();
    for (const part of expanded) {
      if (DIACRITICS.test(part)) continue;
      const out = FOLD[part] ?? part;
      folded += out;
      for (let k = 0; k < out.length; k++) map.push(at);
    }
  }
  return { folded, map };
}

/** Every [start, end) of `query` in `text` (offsets into `text`), not overlapping. */
export function findAll(text: string, query: string): [number, number][] {
  const q = foldForSearch(query).folded.trim();
  if (!q) return [];
  const { folded, map } = foldForSearch(text);
  const out: [number, number][] = [];
  let from = 0;
  while (from <= folded.length - q.length) {
    const at = folded.indexOf(q, from);
    if (at < 0) break;
    const start = map[at];
    const lastIndex = map[at + q.length - 1];
    // The end is past the last matched source character (a surrogate pair counts as two).
    const lastChar = String.fromCodePoint(text.codePointAt(lastIndex) ?? 0);
    out.push([start, lastIndex + lastChar.length]);
    from = at + q.length;
  }
  return out;
}

/** A hit in page-text offsets → the pieces of the items it covers (for the text layer). */
export function hitSpans(page: PageText, itemLengths: readonly number[], start: number, end: number): ItemSpan[] {
  const out: ItemSpan[] = [];
  for (let i = 0; i < page.starts.length; i++) {
    const s = page.starts[i];
    const e = s + (itemLengths[i] ?? 0);
    if (e <= start || s >= end) continue;
    const a = Math.max(start, s) - s;
    const b = Math.min(end, e) - s;
    if (b > a) out.push({ item: i, start: a, end: b });
  }
  return out;
}

/** A short excerpt around a hit, for the results list: the text before, the hit, the text after. */
export function snippet(text: string, start: number, end: number, radius = 32): { before: string; match: string; after: string } {
  const clean = (s: string): string => s.replace(/\s+/g, ' ');
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  return {
    before: (from > 0 ? '…' : '') + clean(text.slice(from, start)).trimStart(),
    match: clean(text.slice(start, end)),
    after: clean(text.slice(end, to)).trimEnd() + (to < text.length ? '…' : ''),
  };
}

/** The next/previous hit index, wrapping around; -1 when there are none. */
export function stepHit(count: number, current: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return dir > 0 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** The first hit at or after `page` (used when a search starts on the page being read). */
export function firstHitFrom(hits: readonly Hit[], page: number): number {
  if (!hits.length) return -1;
  const at = hits.findIndex((hit) => hit.page >= page);
  return at < 0 ? 0 : at;
}

/* ───────── positions: search-to-redact and the redaction check ───────── */

/** A pdf.js text item with its position (PDF user space, the unrotated page). */
export interface PositionedItem extends TextItemLike { transform: number[]; width: number; height: number; dir?: string }

export interface UserBox { x: number; y: number; width: number; height: number }

/**
 * The box (PDF user space) of characters `start..end` of one item. Characters are assumed to
 * share the item's width evenly — close enough to mark them, and the marks are shown before
 * anything is removed. RTL items are measured from the right. `pad` grows the box a little.
 */
export function spanBox(item: PositionedItem, start: number, end: number, pad = 0): UserBox | null {
  const len = item.str.length;
  const [a, b, c, d, e, f] = item.transform;
  const run = Math.hypot(a, b);
  const rise = Math.hypot(c, d);
  if (!len || !run || !rise || !(item.width > 0)) return null;
  const h = item.height > 0 ? item.height : rise;
  const rtl = item.dir === 'rtl';
  const s0 = (rtl ? 1 - end / len : start / len) * item.width;
  const s1 = (rtl ? 1 - start / len : end / len) * item.width;
  const ux = a / run; const uy = b / run; // along the baseline
  const vx = c / rise; const vy = d / rise; // up
  const xs: number[] = []; const ys: number[] = [];
  for (const s of [s0 - pad, s1 + pad]) {
    for (const t of [-0.25 * h - pad, 0.9 * h + pad]) { xs.push(e + ux * s + vx * t); ys.push(f + uy * s + vy * t); }
  }
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Every hit of `query` on one page as boxes to redact (one box per item piece). */
export function hitBoxes(items: readonly PositionedItem[], query: string, pad = 1): UserBox[] {
  const page = buildPageText(items);
  const lengths = items.map((i) => i.str.length);
  const out: UserBox[] = [];
  for (const [s, e] of findAll(page.text, query)) {
    for (const span of hitSpans(page, lengths, s, e)) {
      const box = spanBox(items[span.item], span.start, span.end, pad);
      if (box) out.push(box);
    }
  }
  return out;
}

/** How many visible characters of the items still sit (by their centre) inside the boxes. */
export function charsInBoxes(items: readonly PositionedItem[], boxes: readonly UserBox[]): number {
  let n = 0;
  for (const item of items) {
    for (let k = 0; k < item.str.length; k++) {
      if (!item.str[k].trim()) continue;
      const box = spanBox(item, k, k + 1);
      if (!box) continue;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      if (boxes.some((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height)) n++;
    }
  }
  return n;
}
