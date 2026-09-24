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
