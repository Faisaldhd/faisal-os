/**
 * Writer — pure operations on runs and paragraphs (عمليات النص الخالصة).
 *
 * Everything the editor does to text goes through here: typing (a text change
 * found by diffing the paragraph before and after), formatting a range, splitting
 * a paragraph on Enter, merging two on Backspace. No DOM, no XML: the functions
 * take runs and return new runs, and never mutate what they are given.
 */
import { RUN_KEYS, blockText, type DocBlock, type Run, type RunKey, type RunProps, type TextRun } from './types';

export function sameProps(a: RunProps | undefined, b: RunProps | undefined): boolean {
  return RUN_KEYS.every((key) => (a?.[key] ?? undefined) === (b?.[key] ?? undefined));
}

function cleanProps(props: RunProps): RunProps {
  const out: RunProps = {};
  for (const key of RUN_KEYS) {
    const value = props[key];
    if (value !== undefined && value !== null) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Two text runs that can become one without losing anything the save needs. */
function mergeable(a: TextRun, b: TextRun): boolean {
  return sameProps(a.props, b.props) && sameProps(a.styled, b.styled) && sameProps(a.base, b.base) && (a.rpr ?? '') === (b.rpr ?? '') && a.src === b.src;
}

/**
 * Drops empty text runs (keeping one when the paragraph would otherwise have no
 * text run to type into) and merges neighbours that say the same thing.
 */
export function normalizeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.t === 'text' && run.text === '') continue;
    const last = out[out.length - 1];
    if (run.t === 'text' && last?.t === 'text' && mergeable(last, run)) {
      out[out.length - 1] = { ...last, text: last.text + run.text };
    } else {
      out.push(run.t === 'text' ? { ...run } : run);
    }
  }
  if (!out.some((run) => run.t === 'text')) {
    const keep = runs.find((run): run is TextRun => run.t === 'text');
    if (keep) out.push({ ...keep, text: '' });
  }
  return out;
}

/** The smallest change that turns `before` into `after`: a common prefix and suffix. */
export function diffText(before: string, after: string): { start: number; del: number; ins: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < max - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  // Never split a UTF-16 surrogate pair between the kept and the changed part.
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  if (tail > 0 && isLowSurrogate(before.charCodeAt(before.length - tail))) tail--;
  return { start, del: before.length - start - tail, ins: after.slice(start, after.length - tail) };
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** The text run whose formatting new text typed at `offset` takes (the one before it, like Word). */
export function runAt(runs: readonly Run[], offset: number): TextRun | null {
  let at = 0;
  let before: TextRun | null = null;
  let after: TextRun | null = null;
  for (const run of runs) {
    const end = at + run.text.length;
    if (run.t === 'text') {
      if (offset > at && offset <= end) return run;
      if (end <= offset) before = run;
      else if (!after) after = run;
    }
    at = end;
  }
  return before ?? after;
}

/**
 * Replaces the characters `[start, end)` with `text`. The new text takes the
 * formatting of the run before it, or `props` when the caller has a pending
 * format (bold switched on with nothing selected). An opaque element that is
 * partly or wholly inside the range goes with it; a zero-width one (a bookmark)
 * is removed only when it lies strictly inside.
 */
export function replaceText(runs: readonly Run[], start: number, end: number, text: string, props?: RunProps): Run[] {
  // Typing over a selection takes the formatting of its first character (like Word);
  // typing at a caret takes the formatting of the character before it.
  const template = end > start ? runAt(runs, start + 1) : runAt(runs, start);
  const pieces = splitAt(splitAt(runs, start), end);
  const before: Run[] = [];
  const after: Run[] = [];
  let at = 0;
  for (const run of pieces) {
    const s = at;
    const e = at + run.text.length;
    at = e;
    if (run.text.length === 0) {
      if (run.t === 'text') continue;
      if (s <= start) before.push(run);
      else if (s >= end) after.push(run);
      continue; // a zero-width element strictly inside the range goes with it
    }
    if (e <= start) before.push(run);
    else if (s >= end) after.push(run);
    // anything overlapping the range is removed (an opaque element as a whole)
  }
  const mid: Run[] = [];
  if (text) {
    const base: TextRun = template ? { ...template, text } : { t: 'text', text, props: {} };
    if (props) base.props = cleanProps(props);
    mid.push(base);
  }
  return normalizeRuns([...before, ...mid, ...after]);
}

/** Splits runs so that `offset` falls on a run boundary. */
function splitAt(runs: readonly Run[], offset: number): Run[] {
  const out: Run[] = [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.text.length;
    if (run.t === 'text' && offset > at && offset < end) {
      out.push({ ...run, text: run.text.slice(0, offset - at) }, { ...run, text: run.text.slice(offset - at) });
    } else {
      out.push(run);
    }
    at = end;
  }
  return out;
}

export type PropsPatch = { [K in RunKey]?: RunProps[K] | null };

/** Applies a formatting patch (null = back to the style's value) to `[start, end)`. */
export function formatRange(runs: readonly Run[], start: number, end: number, patch: PropsPatch): Run[] {
  if (end <= start) return [...runs];
  const pieces = splitAt(splitAt(runs, start), end);
  let at = 0;
  const out = pieces.map((run) => {
    const runStart = at;
    at += run.text.length;
    if (run.t !== 'text' || runStart < start || at > end || !run.text) return run;
    const props: RunProps = { ...run.props };
    for (const [key, value] of Object.entries(patch) as Array<[RunKey, unknown]>) {
      if (value === null || value === undefined) delete props[key];
      else (props as Record<string, unknown>)[key] = value;
    }
    return { ...run, props };
  });
  return normalizeRuns(out);
}

/** Formatting shown for a range: a value when every run in it agrees, else undefined. */
export function propsInRange(runs: readonly Run[], start: number, end: number): RunProps {
  if (end <= start) {
    const run = runAt(runs, start);
    return run ? { ...run.styled, ...run.props } : {};
  }
  let seen: RunProps | null = null;
  let at = 0;
  for (const run of runs) {
    const runStart = at;
    at += run.text.length;
    if (run.t !== 'text' || at <= start || runStart >= end || !run.text) continue;
    const mine: RunProps = { ...run.styled, ...run.props };
    if (!seen) { seen = mine; continue; }
    const merged: RunProps = {};
    for (const key of RUN_KEYS) if (seen[key] === mine[key] && seen[key] !== undefined) (merged as Record<string, unknown>)[key] = seen[key];
    seen = merged;
  }
  return seen ?? {};
}

/** Splits a paragraph at `offset` (Enter). The new right half gets `newId` and copies the left's properties. */
export function splitBlock(block: DocBlock, offset: number, newId: number): [DocBlock, DocBlock] {
  const runs = splitAt(block.runs, offset);
  const left: Run[] = [];
  const right: Run[] = [];
  let at = 0;
  for (const run of runs) {
    const runStart = at;
    at += run.text.length;
    if (runStart < offset || (run.text.length === 0 && runStart === offset && run.t === 'opaque' && offset > 0)) left.push(run);
    else right.push(run);
  }
  const lastText = [...left].reverse().find((run): run is TextRun => run.t === 'text') ?? block.runs.find((run): run is TextRun => run.t === 'text');
  const seed = (): TextRun => (lastText ? { ...lastText, text: '' } : { t: 'text', text: '', props: {} });
  const leftRuns = normalizeRuns(left.length ? left : [seed()]);
  const rightRuns = normalizeRuns(right.length ? right : [seed()]);
  // The new paragraph's own text runs are new: they no longer point at an
  // original run of the paragraph they were split from.
  const fresh = rightRuns.map((run) => (run.t === 'text' ? { ...run, src: undefined } : run));
  const newBlock: DocBlock = { id: newId, runs: normalizeRuns(fresh), tpl: block.tpl ?? block.id };
  if (block.cell) newBlock.cell = { ...block.cell };
  return [{ ...block, runs: leftRuns.length ? leftRuns : [seed()] }, newBlock];
}

/** Joins `b` onto the end of `a` (Backspace at the start of `b`). */
export function mergeBlocks(a: DocBlock, b: DocBlock): DocBlock {
  const tail = b.runs.map((run) => (run.t === 'text' && run.src !== undefined ? { ...run, src: undefined } : run));
  return { ...a, runs: normalizeRuns([...a.runs, ...tail]) };
}

/** A fresh paragraph with one empty run in the given formatting. */
export function emptyBlock(id: number, tpl?: number, props: RunProps = {}): DocBlock {
  return { id, runs: [{ t: 'text', text: '', props: cleanProps(props) }], ...(tpl === undefined ? {} : { tpl }) };
}

/** Text of a range that may span paragraphs, joined with newlines (for copy and find). */
export function textOfRange(blocks: readonly DocBlock[], from: { b: number; o: number }, to: { b: number; o: number }): string {
  if (from.b === to.b) return blockText(blocks[from.b] ?? { id: -1, runs: [] }).slice(from.o, to.o);
  const parts: string[] = [];
  for (let i = from.b; i <= to.b; i++) {
    const text = blockText(blocks[i] ?? { id: -1, runs: [] });
    parts.push(i === from.b ? text.slice(from.o) : i === to.b ? text.slice(0, to.o) : text);
  }
  return parts.join('\n');
}

/** Words and characters, the way the status bar counts them (Arabic and Latin alike). */
export function countText(texts: readonly string[]): { words: number; chars: number; charsNoSpaces: number } {
  let words = 0;
  let chars = 0;
  let charsNoSpaces = 0;
  for (const text of texts) {
    for (const ch of text) {
      if (ch === '\n') continue;
      chars++;
      if (!/\s/.test(ch)) charsNoSpaces++;
    }
    const found = text.match(/[\p{L}\p{N}\p{M}]+(?:['’\-][\p{L}\p{N}\p{M}]+)*/gu);
    words += found ? found.length : 0;
  }
  return { words, chars, charsNoSpaces };
}

/** True when a string's first strong character is right-to-left (Arabic, Hebrew…). */
export function startsRtl(text: string): boolean | null {
  for (const ch of text) {
    if (/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(ch)) return true;
    if (/\p{L}/u.test(ch)) return false;
  }
  return null;
}

/** True when a string holds any Arabic-script letter. */
export function hasArabic(text: string): boolean {
  return /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(text);
}
