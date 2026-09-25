import { describe, expect, it } from 'vitest';
import {
  isSpreadStart, neighbourPage, pagesOfPage, pagesOfSpread, spreadCount, spreadForPage,
  spreadIndexOfPage, spreadLabelOf, spreadsOf, type SpreadOptions,
} from './spread';

/*
 * The pairing rule every reader follows: a cover stands alone, then 2‑3 · 4‑5 … This module is
 * pure maths, so these tests are the contract the viewer draws from — including the RTL decision
 * (the pairs are NOT mirrored; page 2 stays on the left of page 3 in an Arabic document).
 */
const SPREAD: SpreadOptions = { spread: true };
const SINGLE: SpreadOptions = { spread: false };
const PAIRS: SpreadOptions = { spread: true, coverAlone: false };

const pages = (pageCount: number, options: SpreadOptions): number[][] =>
  spreadsOf(pageCount, options).map((spread) => spread.pages);

describe('spread pairing', () => {
  it('lets the cover stand alone, then pairs 2‑3 · 4‑5', () => {
    expect(pages(0, SPREAD)).toEqual([]);
    expect(pages(1, SPREAD)).toEqual([[0]]);
    expect(pages(2, SPREAD)).toEqual([[0], [1]]);
    expect(pages(3, SPREAD)).toEqual([[0], [1, 2]]);
    expect(pages(4, SPREAD)).toEqual([[0], [1, 2], [3]]);
    expect(pages(5, SPREAD)).toEqual([[0], [1, 2], [3, 4]]);
    expect(pages(6, SPREAD)).toEqual([[0], [1, 2], [3, 4], [5]]);
    expect(pages(12, SPREAD)).toEqual([[0], [1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11]]);
  });

  it('can pair from the first page when there is no cover to stand alone', () => {
    expect(pages(4, PAIRS)).toEqual([[0, 1], [2, 3]]);
    expect(pages(5, PAIRS)).toEqual([[0, 1], [2, 3], [4]]);
    expect(pages(1, PAIRS)).toEqual([[0]]);
  });

  it('gives every page its own spread in single-page mode', () => {
    expect(pages(3, SINGLE)).toEqual([[0], [1], [2]]);
    expect(spreadCount(3, SINGLE)).toBe(3);
    expect(spreadCount(3, SPREAD)).toBe(2);
    expect(spreadCount(0, SPREAD)).toBe(0);
  });

  it('never loses or repeats a page, whatever the count', () => {
    for (let count = 1; count <= 40; count++) {
      const flat = pages(count, SPREAD).flat().sort((a, b) => a - b);
      expect(flat, `count ${count}`).toEqual(Array.from({ length: count }, (_, i) => i));
    }
  });
});

describe('finding the spread of a page', () => {
  it('maps every page to the spread that holds it', () => {
    expect(spreadIndexOfPage(0, 5, SPREAD)).toBe(0);
    expect(spreadIndexOfPage(1, 5, SPREAD)).toBe(1);
    expect(spreadIndexOfPage(2, 5, SPREAD)).toBe(1);
    expect(spreadIndexOfPage(3, 5, SPREAD)).toBe(2);
    expect(spreadIndexOfPage(4, 5, SPREAD)).toBe(2);
    expect(pagesOfPage(2, 5, SPREAD)).toEqual([1, 2]);
    expect(spreadForPage(2, 5, SPREAD)).toEqual({ index: 1, pages: [1, 2] });
  });

  it('clamps a page number that is outside the document', () => {
    expect(spreadIndexOfPage(-5, 4, SPREAD)).toBe(0);
    expect(spreadIndexOfPage(99, 4, SPREAD)).toBe(2);
    expect(pagesOfPage(99, 4, SPREAD)).toEqual([3]);
    expect(spreadForPage(0, 0, SPREAD)).toBeNull();
    expect(pagesOfPage(0, 0, SPREAD)).toEqual([]);
  });

  it('returns the pages of a spread by number, clamped at both ends', () => {
    expect(pagesOfSpread(0, 5, SPREAD)).toEqual([0]);
    expect(pagesOfSpread(1, 5, SPREAD)).toEqual([1, 2]);
    expect(pagesOfSpread(9, 5, SPREAD)).toEqual([3, 4]);
    expect(pagesOfSpread(-3, 5, SPREAD)).toEqual([0]);
    expect(pagesOfSpread(0, 0, SPREAD)).toEqual([]);
  });
});

describe('moving between spreads', () => {
  it('lands on the first page of the next and previous spread, and stops at the ends', () => {
    // 6 pages: [0] [1 2] [3 4] [5]
    expect(neighbourPage(0, 6, SPREAD, 1)).toBe(1);
    expect(neighbourPage(1, 6, SPREAD, 1)).toBe(3);
    expect(neighbourPage(2, 6, SPREAD, 1)).toBe(3);       // from the right page of a pair too
    expect(neighbourPage(4, 6, SPREAD, 1)).toBe(5);
    expect(neighbourPage(5, 6, SPREAD, 1)).toBe(5);       // the last spread does not run past
    expect(neighbourPage(5, 6, SPREAD, -1)).toBe(3);
    expect(neighbourPage(1, 6, SPREAD, -1)).toBe(0);
    expect(neighbourPage(0, 6, SPREAD, -1)).toBe(0);      // nor before the first
    expect(neighbourPage(0, 0, SPREAD, 1)).toBe(0);
  });

  it('moves one page at a time in single-page mode', () => {
    expect(neighbourPage(0, 3, SINGLE, 1)).toBe(1);
    expect(neighbourPage(2, 3, SINGLE, 1)).toBe(2);
    expect(neighbourPage(0, 3, SINGLE, -1)).toBe(0);
  });

  it('knows which page starts a spread', () => {
    expect(isSpreadStart(0, 5, SPREAD)).toBe(true);
    expect(isSpreadStart(1, 5, SPREAD)).toBe(true);
    expect(isSpreadStart(2, 5, SPREAD)).toBe(false);
    expect(isSpreadStart(3, 5, SPREAD)).toBe(true);
    expect(isSpreadStart(1, 5, SINGLE)).toBe(true);
    expect(isSpreadStart(0, 0, SPREAD)).toBe(false);
  });
});

describe('the label a reader shows', () => {
  it('prints one number for a lone page and a range for a pair', () => {
    expect(spreadLabelOf({ index: 0, pages: [0] })).toBe('1');
    expect(spreadLabelOf({ index: 1, pages: [1, 2] })).toBe('2\u20133');
    expect(spreadLabelOf({ index: 3, pages: [5, 6] })).toBe('6\u20137');
  });

  it('agrees with the pages of every spread in a real document', () => {
    expect(spreadsOf(6, SPREAD).map(spreadLabelOf)).toEqual(['1', '2\u20133', '4\u20135', '6']);
  });
});
