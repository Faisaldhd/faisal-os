/**
 * Writer — cross-references (الإحالات المرجعية).
 *
 * A cross-reference is a REAL Word field, not text that happens to read "see section 3": a bookmark
 * marks the target and a `REF` field points at it, so Word updates the text when the target moves.
 *
 * Everything here follows what a file **Word itself wrote** contains, measured with Word COM and
 * read out of its bytes (see `refs.test.ts`, which pins the measured markup):
 *
 *   target:  <w:bookmarkStart w:id="0" w:name="_Ref11111111"/><w:r><w:t>Section One</w:t></w:r>
 *            (the start sits inside the paragraph, the matching <w:bookmarkEnd> follows it)
 *   field:   <w:r><w:fldChar w:fldCharType="begin"/></w:r>
 *            <w:r><w:instrText xml:space="preserve"> REF _Ref11111111 \h \* MERGEFORMAT </w:instrText></w:r>
 *            <w:r><w:fldChar w:fldCharType="separate"/></w:r>
 *            <w:r><w:t>Section One</w:t></w:r>
 *            <w:r><w:fldChar w:fldCharType="end"/></w:r>
 *
 * The instruction keeps Word's own spelling: a leading space, `\h` (the reference is a hyperlink)
 * and `\* MERGEFORMAT`, and the result text between `separate` and `end` is the cached value the
 * document shows before Word recalculates. Reading gives the field back as { target, text }, so an
 * opened file keeps its live reference instead of turning it into dead text.
 */
import type { DocBlock, Run } from './types';

/** Word's own bookmark prefix for cross-reference targets (`_Ref` + eight digits). */
export const REF_BOOKMARK_PREFIX = '_Ref';
/** The bookmark ids Word uses are 0-based per document part; we only need uniqueness. */
export const REF_BOOKMARK_DIGITS = 8;

export interface RefField {
  /** The bookmark the field points at. */
  target: string;
  /** The cached result text the document shows. */
  text: string;
  /** `\h` was present: the reference is a hyperlink to the target. */
  hyperlink: boolean;
}

/** The instruction text, spelled exactly the way Word writes it. */
export function refInstruction(target: string, hyperlink = true): string {
  return ` REF ${target} ${hyperlink ? '\\h ' : ''}\\* MERGEFORMAT `;
}

/** Parses an instruction like ` REF _Ref11111111 \h \* MERGEFORMAT ` (spacing tolerant). */
export function parseRefInstruction(instr: string): RefField | null {
  const m = /^\s*REF\s+(\S+)([\s\S]*)$/i.exec(instr ?? '');
  if (!m) return null;
  const rest = m[2] ?? '';
  return { target: m[1], text: '', hyperlink: /(^|\s)\\h(\s|$)/.test(rest) };
}

const xmlEscape = (s: string): string => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A bookmark around a target: the start goes inside the paragraph, the end after its runs. */
export function bookmarkStartMarkup(id: number, name: string): string {
  return `<w:bookmarkStart w:id="${id}" w:name="${xmlEscape(name)}"/>`;
}

export function bookmarkEndMarkup(id: number): string {
  return `<w:bookmarkEnd w:id="${id}"/>`;
}

/** The whole `REF` field, in the complex form Word wrote, including its cached result. */
export function refFieldMarkup(target: string, cachedText: string, hyperlink = true): string {
  const instr = refInstruction(target, hyperlink);
  return '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    + `<w:r><w:instrText xml:space="preserve">${xmlEscape(instr)}</w:instrText></w:r>`
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    + `<w:r><w:t xml:space="preserve">${xmlEscape(cachedText)}</w:t></w:r>`
    + '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
}

/** The visible text of a field: what sits between `separate` and `end`, in order. */
function cachedResultText(xml: string): string {
  const parts = xml.split(/<w:fldChar[^>]*w:fldCharType="(?:begin|separate|end)"[^>]*\/>/);
  // parts: [before-begin, between begin..separate, between separate..end, after end].
  // A reader may hand over only the instruction run of a field (Word splits a complex field across
  // runs), in which case the cached result is whatever text follows the instruction.
  const fromInstr = xml.indexOf('</w:instrText>');
  const middle = parts.length >= 3 ? parts[2] : (fromInstr >= 0 ? xml.slice(fromInstr + 1) : '');
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(middle))) out += m[1];
  return out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** Reads a `REF` field back out of its markup; `null` for anything that is not one. */
export function readRefField(xml: string): RefField | null {
  if (!xml || !/w:instrText/.test(xml)) return null;
  const instr = /<w:instrText(?:\s[^>]*)?>([\s\S]*?)<\/w:instrText>/.exec(xml);
  if (!instr) return null;
  const parsed = parseRefInstruction(instr[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  if (!parsed) return null;
  return { ...parsed, text: cachedResultText(xml) };
}

/** True when the model run is a cross-reference field (as opposed to any other field). */
export function isRefField(run: Run): boolean {
  return run.t === 'opaque' && run.kind === 'field' && readRefField(run.xml ?? '') !== null;
}

export interface RefTarget {
  /** The paragraph that can be pointed at. */
  blockId: number;
  /** Its bookmark name, when it already has one. */
  bookmark: string | null;
  /** The text a person would recognise it by. */
  label: string;
}

const LABEL_MAX = 48;

/** A short, single-line label for a target paragraph. */
export function refLabel(text: string): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= LABEL_MAX) return clean;
  return `${clean.slice(0, LABEL_MAX - 1)}…`;
}

/** The bookmark a run set already uses, if any (read from the `mark` opaques). */
export function bookmarkNameIn(runs: readonly Run[]): string | null {
  for (const run of runs) {
    if (run.t !== 'opaque') continue;
    const m = /<w:bookmarkStart[^>]*w:name="([^"]+)"/.exec(run.xml ?? '');
    if (m && !m[1].startsWith('_GoBack')) return m[1];
  }
  return null;
}

/** Every paragraph a reference can point at, with its existing bookmark when it has one. */
export function refTargets(blocks: readonly DocBlock[]): RefTarget[] {
  return blocks.map((b) => {
    let text = '';
    for (const run of b.runs) text += run.text;
    return { blockId: b.id, bookmark: bookmarkNameIn(b.runs), label: refLabel(text) };
  });
}

/** A bookmark name that is not taken yet: `_Ref` + eight digits, as Word names them. */
export function nextBookmarkName(used: Iterable<string>, seed = 1): string {
  const taken = new Set(used);
  let n = Math.max(1, Math.floor(seed));
  for (;;) {
    const name = `${REF_BOOKMARK_PREFIX}${String(n).padStart(REF_BOOKMARK_DIGITS, '0')}`;
    if (!taken.has(name)) return name;
    n += 1;
  }
}

/** Every bookmark name a document already uses. */
export function usedBookmarks(blocks: readonly DocBlock[]): string[] {
  const out: string[] = [];
  const re = /<w:bookmarkStart[^>]*w:name="([^"]+)"/g;
  for (const b of blocks) for (const run of b.runs) {
    if (run.t !== 'opaque') continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(run.xml ?? ''))) out.push(m[1]);
    re.lastIndex = 0;
  }
  return out;
}

export interface InsertedRef {
  blocks: DocBlock[];
  /** The bookmark that now marks the target. */
  bookmark: string;
}

const markXml = (startEnd: 'start' | 'end', id: number, name: string): string =>
  (startEnd === 'start' ? bookmarkStartMarkup(id, name) : bookmarkEndMarkup(id));

/**
 * Inserts a cross-reference: a bookmark on the target paragraph (if it has none) and a `REF` field
 * at the end of the referring paragraph, whose cached text is the target's own text — so the
 * document reads "see <target>" before Word ever recalculates it.
 *
 * Pure: returns a new block list, and the original runs the save writes verbatim stay untouched.
 */
export function insertCrossReference(
  blocks: readonly DocBlock[],
  fromId: number,
  targetId: number,
  result = true,
): InsertedRef {
  const used = usedBookmarks(blocks);
  const target = blocks.find((b) => b.id === targetId);
  if (!target || !blocks.some((b) => b.id === fromId)) return { blocks: [...blocks], bookmark: '' };
  const existing = bookmarkNameIn(target.runs);
  const bookmark = existing ?? nextBookmarkName(used, used.length + 1);
  let targetText = '';
  for (const run of target.runs) targetText += run.text;
  const next = blocks.map((b) => {
    if (b.id === targetId && !existing) {
      const runs: Run[] = [
        { t: 'opaque', text: '', xml: markXml('start', used.length, bookmark), kind: 'mark' },
        ...b.runs,
        { t: 'opaque', text: '', xml: markXml('end', used.length, bookmark), kind: 'mark' },
      ];
      return { ...b, runs };
    }
    if (b.id === fromId) {
      const field: Run = {
        t: 'opaque', text: result ? refLabel(targetText) : '', xml: refFieldMarkup(bookmark, refLabel(targetText)), kind: 'field',
      };
      return { ...b, runs: [...b.runs, field] };
    }
    return b;
  });
  return { blocks: next, bookmark };
}
