/**
 * PDF app — how pages fall into spreads (إقران الصفحات في انتشار). Pure maths, no DOM, no pdf.js.
 *
 * Readers pair the way a printed book falls open: the first page stands alone when it is a cover,
 * then 2‑3 · 4‑5 · 6‑7 … That is the default here too, and it is what the viewer draws.
 *
 * **RTL is a decision, not an accident.** In an Arabic document the pairs are NOT mirrored: page 2
 * stays on the LEFT of page 3, exactly as Acrobat, Chrome/PDFium and pdf.js show it, because the
 * page order of the file is the reading order and a viewer that re-orders it would disagree with
 * every other reader and with the text selection maths of the page itself. The app says this on
 * screen (`pdf.spreadHint`) instead of choosing silently — see the report.
 */

export interface SpreadOptions {
  /** Two pages side by side; `false` is the single-page view, one spread per page. */
  spread: boolean;
  /** The first page stands alone (a cover) before the pairs. Ignored when `spread` is false. */
  coverAlone?: boolean;
}

export interface Spread {
  /** 0-based spread number. */
  index: number;
  /** 0-based page indexes of this spread, in reading order (left to right). */
  pages: number[];
}

const pageInRange = (page: number, pageCount: number): number => {
  const count = Math.max(0, Math.floor(pageCount));
  const value = Math.floor(Number.isFinite(page) ? page : 0);
  return Math.max(0, Math.min(count - 1, value));
};

/**
 * The page groups, in reading order: `[0] [1 2] [3 4] …` in spread mode (or one page per group in
 * single-page mode). Every page of the document appears exactly once, even the last odd one.
 */
function groupsOf(pageCount: number, options: SpreadOptions): number[][] {
  const count = Math.max(0, Math.floor(pageCount));
  if (count <= 0) return [];
  if (!options.spread) return Array.from({ length: count }, (_, page) => [page]);
  const groups: number[][] = [];
  let at = 0;
  if (options.coverAlone !== false) {
    groups.push([0]);
    at = 1;
  }
  for (; at < count; at += 2) groups.push(at + 1 < count ? [at, at + 1] : [at]);
  return groups;
}

/** How many spreads the document has: 1 for the cover, then ceil(rest / 2). */
export function spreadCount(pageCount: number, options: SpreadOptions): number {
  return groupsOf(pageCount, options).length;
}

/** Every spread, in order. `[]` for a document with no pages. */
export function spreadsOf(pageCount: number, options: SpreadOptions): Spread[] {
  return groupsOf(pageCount, options).map((pages, index) => ({ index, pages }));
}

/** The 0-based spread that holds `page` (clamped into the document). */
export function spreadIndexOfPage(page: number, pageCount: number, options: SpreadOptions): number {
  const groups = groupsOf(pageCount, options);
  if (!groups.length) return 0;
  const wanted = pageInRange(page, pageCount);
  const found = groups.findIndex((pages) => pages.includes(wanted));
  return found < 0 ? 0 : found;
}

/** The pages of the spread that holds `page`, in reading order. */
export function pagesOfPage(page: number, pageCount: number, options: SpreadOptions): number[] {
  const groups = groupsOf(pageCount, options);
  if (!groups.length) return [];
  return [...groups[spreadIndexOfPage(page, pageCount, options)]];
}

/** The pages of spread number `index`, clamped into range. */
export function pagesOfSpread(index: number, pageCount: number, options: SpreadOptions): number[] {
  const groups = groupsOf(pageCount, options);
  if (!groups.length) return [];
  const at = Math.max(0, Math.min(groups.length - 1, Math.floor(Number.isFinite(index) ? index : 0)));
  return [...groups[at]];
}

/** The spread that holds `page` (its own index and pages), or null for an empty document. */
export function spreadForPage(page: number, pageCount: number, options: SpreadOptions): Spread | null {
  const groups = groupsOf(pageCount, options);
  if (!groups.length) return null;
  const index = spreadIndexOfPage(page, pageCount, options);
  return { index, pages: [...groups[index]] };
}

/**
 * The FIRST page of the spread `dir` spreads away from the one holding `page` — `dir` 1 is the next
 * spread, -1 the previous — clamped at both ends, so a key held down never leaves the document.
 */
export function neighbourPage(page: number, pageCount: number, options: SpreadOptions, dir: 1 | -1): number {
  const groups = groupsOf(pageCount, options);
  if (!groups.length) return 0;
  const at = spreadIndexOfPage(page, pageCount, options);
  const target = Math.max(0, Math.min(groups.length - 1, at + (dir < 0 ? -1 : 1)));
  return groups[target][0];
}

/** True when `page` is the first page of its spread (what the page box and the indicator show). */
export function isSpreadStart(page: number, pageCount: number, options: SpreadOptions): boolean {
  const groups = groupsOf(pageCount, options);
  if (!groups.length) return false;
  return groups[spreadIndexOfPage(page, pageCount, options)][0] === pageInRange(page, pageCount);
}

/** 1-based `"2–3"` label of a spread, or the single number when it holds one page. */
export function spreadLabelOf(spread: Spread): string {
  const first = spread.pages[0] + 1;
  const last = spread.pages[spread.pages.length - 1] + 1;
  return first === last ? String(first) : `${first}\u2013${last}`;
}
