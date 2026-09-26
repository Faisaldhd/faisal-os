import { describe, expect, it } from 'vitest';
import { insertNote, notesOfKind, removeNote, renumberNotes, setNoteText } from './notemodel';
import { listNotes, noteNumberAt } from './footnotes';
import { blockText, type DocBlock } from './types';

const text = (t: string) => ({ t: 'text' as const, text: t, props: {} });

/** Two paragraphs of text, ready for a note to be inserted at the caret. */
function doc(): DocBlock[] {
  return [
    { id: 0, runs: [text('أولاً'), text('ثانياً')] },
    { id: 1, runs: [text('ثالثاً')] },
  ];
}

/** The note's text as the save would write it (through the part builder). */
function texts(blocks: readonly DocBlock[]): string[] {
  return listNotes(blocks).map((n) => n.note.text);
}

describe('inserting a note', () => {
  it('puts the reference where the caret is, and numbers it 1', () => {
    const { blocks, note } = insertNote(doc(), 0, 1, 'footnote');
    expect(note.kind).toBe('footnote');
    expect(note.id).toBe(2);
    // The reference sits between the two runs of the paragraph.
    expect(blocks[0].runs.map((r) => r.t)).toEqual(['text', 'opaque', 'text']);
    expect(noteNumberAt(blocks, 0, 1)).toBe(1);
    expect(blockText(blocks[0])).toBe('أولاًثانياً');
  });

  it('numbers the following notes 2, 3… in document order', () => {
    let blocks = insertNote(doc(), 0, 0, 'footnote').blocks;
    blocks = insertNote(blocks, 1, 1, 'footnote').blocks;
    blocks = insertNote(blocks, 0, 2, 'footnote').blocks;
    const list = listNotes(blocks);
    expect(list.map((n) => n.number)).toEqual([1, 2, 3]);
    expect(list.map((n) => n.blockId)).toEqual([0, 0, 1]);
    expect(blocks).not.toBe(doc());
  });

  it('keeps footnotes and endnotes apart, each numbered from 1', () => {
    let blocks = insertNote(doc(), 0, 0, 'footnote').blocks;
    blocks = insertNote(blocks, 1, 0, 'endnote').blocks;
    blocks = insertNote(blocks, 1, 1, 'footnote').blocks;
    expect(notesOfKind(blocks, 'footnote')).toHaveLength(2);
    expect(notesOfKind(blocks, 'endnote')).toHaveLength(1);
    expect(notesOfKind(blocks, 'endnote')[0].kind).toBe('endnote');
    // The ids of each kind are their own sequence, and none of them is 0 or 1.
    expect(notesOfKind(blocks, 'footnote').map((n) => n.id)).toEqual([2, 3]);
    expect(notesOfKind(blocks, 'endnote').map((n) => n.id)).toEqual([2]);
  });

  it('inserts at the end of a paragraph when the caret is past the last run', () => {
    const { blocks } = insertNote(doc(), 0, 99, 'footnote');
    expect(listNotes(blocks)[0].runIndex).toBe(2);
  });
});

describe('editing a note', () => {
  it('writes the text and drops the original markup, so the save rebuilds the note', () => {
    const { blocks } = insertNote(doc(), 0, 1, 'footnote');
    const edited = setNoteText(blocks, 0, 1, 'نص الحاشية');
    expect(texts(edited)).toEqual(['نص الحاشية']);
    expect(listNotes(edited)[0].note.xml).toBeUndefined();
    expect(listNotes(edited)[0].note.fresh).toBe(true);
  });

  it('carries the original note markup until the text really changes', () => {
    const original: DocBlock[] = [
      { id: 0, runs: [{ t: 'text', text: 'نص', props: {} }] },
      {
        id: 1,
        runs: [{
          t: 'opaque', text: '', xml: '<w:r><w:footnoteReference w:id="2"/></w:r>', kind: 'note',
          note: { kind: 'footnote', id: 2, text: 'قديمة', xml: '<w:footnote w:id="2"><w:p><w:r><w:t>قديمة</w:t></w:r></w:p></w:footnote>' },
        }],
      },
    ];
    expect(listNotes(original)[0].note.xml).toContain('<w:footnote w:id="2">');
    const edited = setNoteText(original, 1, 0, 'جديدة');
    expect(listNotes(edited)[0].note.xml).toBeUndefined();
    expect(texts(edited)).toEqual(['جديدة']);
  });

  it('does nothing to a run that is not a note', () => {
    const blocks = doc();
    expect(texts(setNoteText(blocks, 0, 0, 'س'))).toEqual([]);
    expect(texts(setNoteText(blocks, 9, 0, 'س'))).toEqual([]);
  });
});

describe('deleting a note', () => {
  it('removes the reference and the note with it, and renumbers the rest', () => {
    let blocks = insertNote(doc(), 0, 0, 'footnote').blocks;
    blocks = insertNote(blocks, 1, 1, 'footnote').blocks;
    expect(listNotes(blocks).map((n) => n.number)).toEqual([1, 2]);

    const after = removeNote(blocks, 0, 0);
    expect(listNotes(after)).toHaveLength(1);
    // The survivor is now number 1 and carries the first id, so the file matches the screen.
    expect(noteNumberAt(after, 1, 1)).toBe(1);
    expect(listNotes(after)[0].note.id).toBe(2);
    expect(blockText(after[0])).toBe('أولاًثانياً');
  });

  it('leaves a document with no notes exactly as it was', () => {
    const blocks = doc();
    expect(removeNote(blocks, 0, 5)).toEqual(blocks);
  });
});

describe('renumbering', () => {
  it('closes the gaps the ids left behind, per kind, and touches nothing else', () => {
    const blocks: DocBlock[] = [
      {
        id: 0,
        runs: [
          { t: 'opaque', text: '', xml: '', kind: 'note', note: { kind: 'footnote', id: 9, text: 'أ' } },
          { t: 'opaque', text: '', xml: '', kind: 'note', note: { kind: 'endnote', id: 7, text: 'ب' } },
        ],
      },
      { id: 1, runs: [{ t: 'opaque', text: '', xml: '', kind: 'note', note: { kind: 'footnote', id: 4, text: 'ج' } }] },
    ];
    const out = renumberNotes(blocks);
    expect(listNotes(out).map((n) => `${n.note.kind}:${n.note.id}`)).toEqual(['footnote:2', 'endnote:2', 'footnote:3']);
    expect(listNotes(out).map((n) => n.note.text)).toEqual(['أ', 'ب', 'ج']);
    // A document that is already numbered is left alone: no run object is rebuilt.
    const again = renumberNotes(out);
    expect(again).toEqual(out);
    expect(again[0].runs[0]).toBe(out[0].runs[0]);
    expect(again[1].runs[0]).toBe(out[1].runs[0]);
  });
});
