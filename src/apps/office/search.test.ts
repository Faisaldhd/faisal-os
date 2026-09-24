/**
 * Find & replace resolution: one occurrence vs all, overlapping patterns, a query
 * that is not there, and the two case rules — Arabic exactly as written, Latin
 * case-insensitively by default.
 */
import { describe, expect, it } from 'vitest';
import { countOccurrences, planReplace, replaceOccurrences, usesCaseFolding } from './search';

describe('case handling', () => {
  it('folds case only for a query that carries Latin letters', () => {
    expect(usesCaseFolding('hello')).toBe(true);
    expect(usesCaseFolding('Hello World')).toBe(true);
    expect(usesCaseFolding('مرحبا')).toBe(false);
    expect(usesCaseFolding('مرحبا 123')).toBe(false);
    expect(usesCaseFolding('')).toBe(false);
  });

  it('matches Latin case-insensitively by default', () => {
    expect(replaceOccurrences('Hello hello HELLO', 'hello', 'x', 'all', true)).toEqual({ text: 'x x x', count: 3 });
    expect(replaceOccurrences('Hello', 'hello', 'x', 'all', false)).toEqual({ text: 'Hello', count: 0 });
  });

  it('never folds a non-ASCII letter, so match positions can never drift', () => {
    // 'İ'.toLowerCase() is two code units; the ASCII-only fold leaves it alone.
    expect(replaceOccurrences('İzmir', 'i', 'X', 'all', true)).toEqual({ text: 'İzmXr', count: 1 });
  });

  it('matches Arabic exactly as written, with no folding at all', () => {
    expect(replaceOccurrences('مرحباً يا عالم', 'عالم', 'دنيا', 'all', false))
      .toEqual({ text: 'مرحباً يا دنيا', count: 1 });
    // Matching is on the string, so a word inside a word matches too — said plainly here.
    expect(replaceOccurrences('مرحباً بالعالم', 'بالعالم', 'بالدنيا', 'all', false))
      .toEqual({ text: 'مرحباً بالدنيا', count: 1 });
    // A vowelized word is a different string: no normalisation is invented here.
    expect(replaceOccurrences('مَرْحَبًا', 'مرحبا', 'x', 'all', false)).toEqual({ text: 'مَرْحَبًا', count: 0 });
  });
});

describe('one occurrence or all of them', () => {
  it('replaces only the first occurrence in one mode', () => {
    expect(replaceOccurrences('a b a b a', 'a', 'X', 'one', false)).toEqual({ text: 'X b a b a', count: 1 });
  });

  it('replaces every non-overlapping occurrence in all mode', () => {
    expect(replaceOccurrences('a b a b a', 'a', 'X', 'all', false)).toEqual({ text: 'X b X b X', count: 3 });
    expect(replaceOccurrences('aaaa', 'aa', 'b', 'all', false)).toEqual({ text: 'bb', count: 2 });
    expect(replaceOccurrences('ababa', 'aba', 'X', 'all', false)).toEqual({ text: 'Xba', count: 1 });
  });

  it('does nothing when the query is not there, and reports zero', () => {
    expect(replaceOccurrences('مرحبا', 'وداعاً', 'x', 'all', false)).toEqual({ text: 'مرحبا', count: 0 });
    expect(replaceOccurrences('', 'a', 'x', 'all', false)).toEqual({ text: '', count: 0 });
  });

  it('treats an empty query as matching nothing, never as matching everything', () => {
    expect(replaceOccurrences('abc', '', 'X', 'all', false)).toEqual({ text: 'abc', count: 0 });
    expect(countOccurrences(['abc'], '')).toBe(0);
    expect(planReplace(['abc'], '', 'X', 'all')).toEqual({ changes: [], count: 0, folded: false });
  });

  it('does not re-replace text it just inserted', () => {
    expect(replaceOccurrences('aaa', 'a', 'aa', 'all', false)).toEqual({ text: 'aaaaaa', count: 3 });
  });
});

describe('resolving a replacement across the document', () => {
  const paragraphs = ['مرحباً يا عالم', 'عالم ثانٍ', 'لا شيء هنا'];

  it('replaces the first occurrence only, across all the values, in one mode', () => {
    const plan = planReplace(paragraphs, 'عالم', 'دنيا', 'one');
    expect(plan).toEqual({
      changes: [{ index: 0, before: 'مرحباً يا عالم', after: 'مرحباً يا دنيا', count: 1 }],
      count: 1,
      folded: false,
    });
  });

  it('replaces everywhere and reports the total in all mode', () => {
    const plan = planReplace(paragraphs, 'عالم', 'دنيا', 'all');
    expect(plan.count).toBe(2);
    expect(plan.changes.map((change) => change.index)).toEqual([0, 1]);
    expect(plan.changes.map((change) => change.after)).toEqual(['مرحباً يا دنيا', 'دنيا ثانٍ']);
  });

  it('leaves values that do not match out of the plan entirely', () => {
    const plan = planReplace(paragraphs, 'لا يوجد', 'x', 'all');
    expect(plan.changes).toEqual([]);
    expect(plan.count).toBe(0);
  });

  it('says when Latin letters turned the search case-insensitive', () => {
    expect(planReplace(['Alpha', 'beta'], 'alpha', 'A', 'all').folded).toBe(true);
    expect(planReplace(['مرحبا'], 'مرحبا', 'أهلاً', 'all').folded).toBe(false);
  });

  it('counts occurrences without changing anything', () => {
    expect(countOccurrences(paragraphs, 'عالم')).toBe(2);
    expect(countOccurrences(paragraphs, 'x')).toBe(0);
    expect(countOccurrences(['a a a'], 'a')).toBe(3);
  });
});
