/**
 * Writer — the note commands the editor runs: insert, edit, delete, renumber (pure, no DOM).
 *
 * A note is two halves that must never drift apart: the reference run inside a paragraph and the
 * note's text. Deleting the reference therefore deletes the note with it, and every command ends
 * by renumbering, so the ids stay in the order Word numbers them (1, 2, 3… per kind) and the
 * references in the body always point at a note that exists.
 *
 * Everything returns new objects: the editor keeps the previous document for undo.
 */
import { FIRST_NOTE_ID, nextNoteId } from './footnotes';
import type { DocBlock, NoteInfo, OpaqueRun, Run } from './types';

export type NoteKind = 'footnote' | 'endnote';

function isNote(run: Run): run is OpaqueRun & { note: NoteInfo } {
  return run.t === 'opaque' && run.kind === 'note' && !!run.note;
}

/** The note reference run for a freshly inserted note. */
function referenceRun(note: NoteInfo): Run {
  return { t: 'opaque', text: '', xml: '', kind: 'note', note };
}

/** The blocks with one run replaced, leaving every other object untouched. */
function withRun(blocks: readonly DocBlock[], blockId: number, runIndex: number, run: Run | null): DocBlock[] {
  return blocks.map((block) => {
    if (block.id !== blockId) return block;
    const runs = block.runs.slice();
    if (run) runs.splice(Math.max(0, Math.min(runIndex, runs.length)), 0, run);
    else runs.splice(runIndex, 1);
    return { ...block, runs };
  });
}

/**
 * Every note of the document numbered 1, 2, 3… per kind, in reading order — Word's own numbering.
 * The ids are rewritten to match, so a deletion closes the gap in the file as well as on screen.
 */
export function renumberNotes(blocks: readonly DocBlock[]): DocBlock[] {
  const next: Record<NoteKind, number> = { footnote: FIRST_NOTE_ID, endnote: FIRST_NOTE_ID };
  return blocks.map((block) => {
    let changed = false;
    const runs = block.runs.map((run) => {
      if (!isNote(run)) return run;
      const id = next[run.note.kind];
      next[run.note.kind] += 1;
      if (id === run.note.id) return run;
      changed = true;
      return { ...run, note: { ...run.note, id, fresh: true } };
    });
    return changed ? { ...block, runs } : block;
  });
}

/** Inserts a note at `runIndex` of `blockId`, and returns the document with the new reference. */
export function insertNote(
  blocks: readonly DocBlock[],
  blockId: number,
  runIndex: number,
  kind: NoteKind,
): { blocks: DocBlock[]; note: NoteInfo } {
  const note: NoteInfo = { kind, id: nextNoteId([...allNotes(blocks)].map((n) => n.id)), text: '', fresh: true };
  const out = withRun(blocks, blockId, runIndex, referenceRun(note));
  return { blocks: renumberNotes(out), note };
}

/** The text the user typed into a note. The original markup is dropped so it is rebuilt on save. */
export function setNoteText(
  blocks: readonly DocBlock[],
  blockId: number,
  runIndex: number,
  text: string,
): DocBlock[] {
  return blocks.map((block) => {
    if (block.id !== blockId) return block;
    return {
      ...block,
      runs: block.runs.map((run, i) => {
        if (i !== runIndex || !isNote(run)) return run;
        // `fresh` (and the dropped `xml`) is what makes the save regenerate the note's element.
        return { ...run, note: { ...run.note, text, xml: undefined, fresh: true } };
      }),
    };
  });
}

/** Deletes the reference — and with it the note, which cannot exist on its own. */
export function removeNote(blocks: readonly DocBlock[], blockId: number, runIndex: number): DocBlock[] {
  return renumberNotes(withRun(blocks, blockId, runIndex, null));
}

/** Every note in the document, in reading order. */
function* allNotes(blocks: readonly DocBlock[]): Generator<NoteInfo> {
  for (const block of blocks) {
    for (const run of block.runs) if (isNote(run)) yield run.note;
  }
}

/** The notes of one kind, in reading order — what a notes panel lists. */
export function notesOfKind(blocks: readonly DocBlock[], kind: NoteKind): NoteInfo[] {
  return [...allNotes(blocks)].filter((note) => note.kind === kind);
}
