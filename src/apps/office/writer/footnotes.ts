/**
 * Writer — footnotes and endnotes: the package side (pure, no DOM).
 *
 * Word keeps a note in two places: a *reference* run inside the paragraph and the note's own text
 * in a separate part (`word/footnotes.xml` or `word/endnotes.xml`). This module owns that split:
 * it reads a part into `NoteInfo` values, builds a part back out of them, and produces the
 * reference run the body needs. Everything else — the model, the editor, the save — treats a note
 * as `NoteInfo` sitting on an opaque run (`types.ts`).
 *
 * TWO RULES THIS FILE EXISTS TO KEEP:
 *  • a note part carries two STRUCTURAL notes — `w:type="separator"` and its continuation — and every
 *    other element is a real note. Word (and ECMA-376) number those two -1 and 0 and start real notes
 *    at 1, so the structure is recognised by its `w:type`, never by the id: an id-based rule reads a
 *    real Word file as if it had no notes at all, and the save would then drop their text.
 *  • a note the user did not edit is written back byte for byte from its original markup, so
 *    everything this app does not model (its style, its language, its nested fields) survives.
 */

export type NoteKind = 'footnote' | 'endnote';

import type { NoteInfo } from './types';

/**
 * The ids Word gives the two structural notes. Verified against a file Microsoft Word 16 wrote:
 * `<w:footnote w:type="separator" w:id="-1">` and
 * `<w:footnote w:type="continuationSeparator" w:id="0">`, with real notes starting at `w:id="1"`.
 */
export const NOTE_SEPARATOR_ID = -1;
export const NOTE_CONTINUATION_ID = 0;
/** The first id a note this app creates (and renumbers) uses, clear of the two structural ids. */
export const FIRST_NOTE_ID = 2;

export const NOTES_PART: Record<NoteKind, string> = {
  footnote: 'word/footnotes.xml',
  endnote: 'word/endnotes.xml',
};

export const NOTES_CONTENT_TYPE: Record<NoteKind, string> = {
  footnote: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  endnote: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
};

export const NOTES_REL_TYPE: Record<NoteKind, string> = {
  footnote: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
  endnote: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes',
};

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** The element a note lives in, per kind. */
const ELEMENT: Record<NoteKind, string> = { footnote: 'footnote', endnote: 'endnote' };
/** The element the body uses to point at it. */
const REFERENCE: Record<NoteKind, string> = { footnote: 'footnoteReference', endnote: 'endnoteReference' };

/** A note as the package holds it. */
export interface PackagedNote {
  id: number;
  text: string;
  /** The element's own markup, kept verbatim. */
  xml: string;
}

/** XML text escaping for the parts this module generates. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The plain text of a note's markup: `w:t`, tabs and breaks, in order. */
function textOf(xml: string): string {
  let out = '';
  const pattern = /<w:(t|tab|br|cr)(\s[^>]*)?(\/>|>([\s\S]*?)<\/w:\1>)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    if (match[1] === 't') out += unescapeXml(match[4] ?? '');
    else if (match[1] === 'tab') out += '\t';
    else out += '\n';
  }
  return out;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Every real note in a `footnotes.xml`/`endnotes.xml` part, in the order the part lists them.
 * The two structural notes — `w:type="separator"` / `continuationSeparator` / `continuationNotice` —
 * are skipped: they are structure, not notes. Everything else IS a note, whatever id it carries:
 * Word numbers its own from 1, so deciding by the id reads a real Word file as if it had no notes.
 */
export function readNotesPart(xml: string, kind: NoteKind): PackagedNote[] {
  const tag = ELEMENT[kind];
  const notes: PackagedNote[] = [];
  const element = new RegExp(`<w:${tag}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</w:${tag}>)`, 'g');
  let match: RegExpExecArray | null;
  while ((match = element.exec(xml))) {
    const attrs = match[1] ?? '';
    const typeMatch = /\bw:type\s*=\s*"([^"]*)"/.exec(attrs);
    // `w:type="normal"` is a real note written the long way; only the structural types are not notes.
    if (typeMatch && typeMatch[1] !== 'normal') continue;
    const idMatch = /\bw:id\s*=\s*"(-?\d+)"/.exec(attrs);
    if (!idMatch) continue;
    const id = Number(idMatch[1]);
    if (!Number.isFinite(id)) continue;
    const body = match[3] ?? '';
    const full = match[0];
    // A self-closing note has no text: it is still a note (it will be edited into one).
    notes.push({ id, text: textOf(body), xml: full });
  }
  return notes;
}

/** The lowest id ≥ 2 that no note uses. Reuse is legal, but a stable id is easier to follow. */
export function nextNoteId(ids: readonly number[]): number {
  const taken = new Set(ids.filter((id) => Number.isFinite(id)));
  let id = FIRST_NOTE_ID;
  while (taken.has(id)) id += 1;
  return id;
}

/** One note's own element: verbatim when untouched, regenerated from its text when edited. */
export function noteElementXml(note: NoteInfo): string {
  // Verbatim only while the markup still says what the note says: the moment the editor changes
  // the text, the element is rebuilt — no flag to forget, and no stale text can be written back.
  if (note.xml && !note.fresh && textOf(note.xml) === note.text) return note.xml;
  const tag = ELEMENT[note.kind];
  const ref = note.kind === 'footnote' ? 'footnoteRef' : 'endnoteRef';
  const style = note.kind === 'footnote' ? 'FootnoteText' : 'EndnoteText';
  const refStyle = note.kind === 'footnote' ? 'FootnoteReference' : 'EndnoteReference';
  return `<w:${tag} w:id="${note.id}"><w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
    + `<w:r><w:rPr><w:rStyle w:val="${refStyle}"/></w:rPr><w:${ref}/></w:r>`
    + `<w:r><w:t xml:space="preserve">${escapeXml(note.text)}</w:t></w:r></w:p></w:${tag}>`;
}

/**
 * The pair of separator elements Word requires. Their ids are Word's own (-1 and 0) unless a real
 * note of this document already holds one: a file may number its notes any way it likes, and two
 * elements sharing an id would make the references point at the wrong one.
 */
function separatorsXml(kind: NoteKind, notes: readonly NoteInfo[]): string {
  const tag = ELEMENT[kind];
  const taken = new Set(notes.map((note) => note.id));
  let separator = NOTE_SEPARATOR_ID;
  while (taken.has(separator)) separator -= 1;
  let continuation = NOTE_CONTINUATION_ID;
  while (taken.has(continuation) || continuation === separator) continuation -= 1;
  return `<w:${tag} w:type="separator" w:id="${separator}"><w:p><w:r><w:separator/></w:r></w:p></w:${tag}>`
    + `<w:${tag} w:type="continuationSeparator" w:id="${continuation}"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>`;
}

/** A complete notes part: the separators first, then every note in ascending id order. */
export function buildNotesPart(kind: NoteKind, notes: readonly NoteInfo[]): string {
  const ordered = [...notes].sort((a, b) => a.id - b.id);
  const body = ordered.map((note) => noteElementXml(note)).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:${kind === 'footnote' ? 'footnotes' : 'endnotes'} xmlns:w="${W_NS}" xmlns:r="${R_NS}">`
    + separatorsXml(kind, ordered)
    + body
    + `</w:${kind === 'footnote' ? 'footnotes' : 'endnotes'}>`;
}

/** The run that goes in the body, reusing the reference run's own formatting when it has any. */
export function noteReferenceRunXml(note: NoteInfo, rprXml = ''): string {
  const rpr = rprXml ? `<w:rPr>${rprXml}</w:rPr>` : '';
  return `<w:r>${rpr}<w:${REFERENCE[note.kind]} w:id="${note.id}"/></w:r>`;
}

/** The shape these helpers need: a block of runs, where a run may carry a note. */
export interface NoteBearingBlock {
  id: number;
  runs: readonly unknown[];
}

/** A run seen as a possible note carrier. */
function asNoteRun(run: unknown): { kind?: string; note?: NoteInfo } {
  return (run ?? {}) as { kind?: string; note?: NoteInfo };
}

/** True when a run is a note reference of either kind. */
export function isNoteRun(run: unknown): boolean {
  const candidate = asNoteRun(run);
  return candidate.kind === 'note' && !!candidate.note;
}

/**
 * The note number the reader shows at a reference: 1, 2, 3… per kind, in document order — the
 * same order Word numbers them, so inserting or deleting a note renumbers the rest for free.
 * `blocks` is the document body in reading order.
 */
export function noteNumberAt(blocks: readonly NoteBearingBlock[], blockId: number, runIndex: number): number {
  let n = 0;
  for (const block of blocks) {
    for (let i = 0; i < block.runs.length; i++) {
      if (!isNoteRun(block.runs[i])) continue;
      n += 1;
      if (block.id === blockId && i === runIndex) return n;
    }
  }
  return 0;
}

/** Every note in the document, in reading order, with the number the reader shows for it. */
export function listNotes(
  blocks: readonly NoteBearingBlock[],
): { blockId: number; runIndex: number; note: NoteInfo; number: number }[] {
  const out: { blockId: number; runIndex: number; note: NoteInfo; number: number }[] = [];
  for (const block of blocks) {
    for (let i = 0; i < block.runs.length; i++) {
      const candidate = asNoteRun(block.runs[i]);
      if (candidate.kind !== 'note' || !candidate.note) continue;
      out.push({ blockId: block.id, runIndex: i, note: candidate.note, number: out.length + 1 });
    }
  }
  return out;
}
