/**
 * Office — find & replace (بحث واستبدال), the pure part.
 *
 * The window hands in the strings it is showing — a Word document's paragraphs, a
 * slide's paragraphs, a sheet's cells or the whole text buffer — and gets back a
 * list of changes, each with the text before and after and how many occurrences it
 * covers. Nothing here touches the DOM or the model, so the resolution rules are
 * provable on their own: one occurrence vs all, overlapping matches, not-found, and
 * Arabic text.
 *
 * Case handling, stated honestly:
 *  • Arabic has no letter case, so an Arabic query is matched **exactly** as written.
 *  • A query that contains Latin letters is matched case-insensitively by default,
 *    because that is what a reader expects of "hello" vs "Hello". The window shows a
 *    note when this applies (`ReplacePlan.folded`), so nobody has to guess.
 *  • Folding lower-cases ASCII A–Z only. That keeps the folded haystack the *same
 *    length* as the original, so a match index can never drift and Arabic (or any
 *    non-ASCII letter) is never folded.
 */

export type ReplaceMode = 'one' | 'all';

/** One target string that the plan replaces something in. */
export interface Change {
  /** Index into the values the plan was given. */
  index: number;
  before: string;
  after: string;
  /** How many occurrences this target contributed. */
  count: number;
}

export interface ReplacePlan {
  changes: Change[];
  /** The total number of occurrences replaced (or that would be). */
  count: number;
  /** True when Latin letters made the search case-insensitive. */
  folded: boolean;
}

/** Lower-cases ASCII A–Z only, so the string keeps its exact length. */
function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** True when a query holds Latin letters, i.e. when case folding is offered. */
export function usesCaseFolding(query: string): boolean {
  return /[A-Za-z]/.test(query);
}

/**
 * Replaces in one string, left to right and never overlapping: "aa" in "aaaa" is two
 * matches ("bb"), and "aba" in "ababa" is one, because the scan continues after the
 * match it just took. An empty query matches nothing rather than everything.
 */
export function replaceOccurrences(
  text: string,
  query: string,
  replacement: string,
  mode: ReplaceMode,
  folded: boolean,
): { text: string; count: number } {
  if (!query) return { text, count: 0 };
  const haystack = folded ? foldAscii(text) : text;
  const needle = folded ? foldAscii(query) : query;
  let out = '';
  let from = 0;
  let count = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    out += text.slice(from, at) + replacement;
    from = at + needle.length;
    count++;
    if (mode === 'one') break;
  }
  if (count === 0) return { text, count: 0 };
  return { text: out + text.slice(from), count };
}

/** How many occurrences a query has across every value, without replacing anything. */
export function countOccurrences(values: readonly string[], query: string): number {
  if (!query) return 0;
  const folded = usesCaseFolding(query);
  let count = 0;
  for (const value of values) count += replaceOccurrences(value, query, '', 'all', folded).count;
  return count;
}

/**
 * Resolves a find & replace into the changes to apply.
 *
 * `one` replaces the first occurrence in document order and stops, whichever value
 * it is in; `all` replaces every occurrence everywhere. Values that do not contain
 * the query produce no change at all, so the caller never commits an empty edit.
 */
export function planReplace(
  values: readonly string[],
  query: string,
  replacement: string,
  mode: ReplaceMode,
): ReplacePlan {
  const folded = usesCaseFolding(query);
  const changes: Change[] = [];
  if (!query) return { changes, count: 0, folded };
  let count = 0;
  for (let index = 0; index < values.length; index++) {
    if (mode === 'one' && count > 0) break;
    const before = values[index] ?? '';
    // In `one` mode a single value can contribute only its first occurrence, so the
    // total is exactly one however many values were handed in.
    const result = replaceOccurrences(before, query, replacement, mode, folded);
    if (result.count === 0) continue;
    changes.push({ index, before, after: result.text, count: result.count });
    count += result.count;
  }
  return { changes, count, folded };
}
