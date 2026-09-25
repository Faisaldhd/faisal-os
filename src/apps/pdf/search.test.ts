import { describe, expect, it } from 'vitest';
import { buildPageText, charsInBoxes, findAll, firstHitFrom, foldForSearch, hitBoxes, hitSpans, snippet, spanBox, stepHit } from './search';

describe('pdf search', () => {
  it('joins items and remembers where each starts', () => {
    const page = buildPageText([{ str: 'Hello ' }, { str: 'world', hasEOL: true }, { str: 'next' }]);
    expect(page.text).toBe('Hello world\nnext');
    expect(page.starts).toEqual([0, 6, 12]);
  });

  it('ignores case and collapses whitespace', () => {
    expect(findAll('The Quick  brown fox', 'quick brown')).toEqual([[4, 16]]);
    expect(findAll('abc abc', 'ABC')).toEqual([[0, 3], [4, 7]]);
    expect(findAll('anything', '   ')).toEqual([]);
  });

  it('finds Arabic regardless of diacritics, tatweel and alef/yaa/taa-marbuta spellings', () => {
    expect(findAll('مُحَمَّد رسول', 'محمد')).toEqual([[0, 8]]);
    expect(findAll('إدارة المشاريع', 'اداره')).toEqual([[0, 5]]);
    expect(findAll('مستشفـــى', 'مستشفي')).toHaveLength(1);
  });

  it('unfolds presentation forms so a ligature still matches its letters', () => {
    // U+FEFB is the lam-alef ligature.
    const { folded } = foldForSearch('ﻻ');
    expect(folded).toBe('لا');
    expect(findAll('سﻻم', 'سلام')).toEqual([[0, 3]]);
  });

  it('maps a hit that crosses items back to each item', () => {
    const items = [{ str: 'Hel' }, { str: 'lo wor' }, { str: 'ld' }];
    const page = buildPageText(items);
    const [[start, end]] = findAll(page.text, 'lo world');
    expect(hitSpans(page, items.map((i) => i.str.length), start, end)).toEqual([
      { item: 1, start: 0, end: 6 },
      { item: 2, start: 0, end: 2 },
    ]);
  });

  it('builds a short excerpt and walks the hits', () => {
    const s = snippet('a'.repeat(50) + 'KEY' + 'b'.repeat(50), 50, 53, 5);
    expect(s).toEqual({ before: '…aaaaa', match: 'KEY', after: 'bbbbb…' });
    expect(stepHit(3, 2, 1)).toBe(0);
    expect(stepHit(3, 0, -1)).toBe(2);
    expect(stepHit(0, 0, 1)).toBe(-1);
    expect(stepHit(3, -1, -1)).toBe(2);
    expect(firstHitFrom([{ page: 0, start: 0, end: 1 }, { page: 4, start: 0, end: 1 }], 2)).toBe(1);
    expect(firstHitFrom([{ page: 0, start: 0, end: 1 }], 9)).toBe(0);
  });
});

describe('search-to-redact positions', () => {
  const item = { str: 'ab SECRET cd', transform: [12, 0, 0, 12, 100, 500], width: 120, height: 12, hasEOL: false };
  it('boxes a hit inside an item, in PDF user space', () => {
    const boxes = hitBoxes([item], 'secret', 0);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].x).toBeCloseTo(130);
    expect(boxes[0].width).toBeCloseTo(60);
    expect(boxes[0].y).toBeCloseTo(497);
  });
  it('measures RTL items from the right', () => {
    const b = spanBox({ ...item, dir: 'rtl' }, 0, 2)!;
    expect(b.x).toBeCloseTo(200);
    expect(b.width).toBeCloseTo(20);
  });
  it('counts the characters left inside boxes', () => {
    const boxes = hitBoxes([item], 'secret', 0);
    expect(charsInBoxes([item], boxes)).toBe(6);
    expect(charsInBoxes([{ ...item, str: 'ab          cd' }], boxes)).toBe(0);
  });
});
