import { describe, expect, it } from 'vitest';
import {
  NOTE_CONTINUATION_ID, NOTE_SEPARATOR_ID, buildNotesPart, escapeXml, isNoteRun, listNotes,
  nextNoteId, noteElementXml, noteNumberAt, noteReferenceRunXml, readNotesPart,
} from './footnotes';
import type { NoteInfo } from './types';

const note = (patch: Partial<NoteInfo> = {}): NoteInfo => ({ kind: 'footnote', id: 2, text: 'ملاحظة', fresh: true, ...patch });

/** What Word really writes, separators included. */
const REAL_PART = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:footnote w:type="separator" w:id="0"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
  + '<w:footnote w:type="continuationSeparator" w:id="1"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
  + '<w:footnote w:id="2"><w:p><w:r><w:t>الأولى</w:t></w:r></w:p></w:footnote>'
  + '<w:footnote w:id="3"><w:p><w:r><w:t xml:space="preserve">الثانية </w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>وتابعة</w:t></w:r></w:p></w:footnote>'
  + '</w:footnotes>';

describe('reading a notes part', () => {
  it('takes the real notes and skips the two separators', () => {
    const notes = readNotesPart(REAL_PART, 'footnote');
    expect(notes.map((n) => n.id)).toEqual([2, 3]);
    expect(notes[0].text).toBe('الأولى');
    expect(notes[1].text).toBe('الثانية \tوتابعة');
    // The markup travels with the note: the save can write it back untouched.
    expect(notes[0].xml).toContain('w:id="2"');
  });

  it('reads an endnotes part through the same door', () => {
    const part = '<w:endnotes xmlns:w="x"><w:endnote w:id="0"><w:p/></w:endnote>'
      + '<w:endnote w:id="2"><w:p><w:r><w:t>نهاية</w:t></w:r></w:p></w:endnote></w:endnotes>';
    const notes = readNotesPart(part, 'endnote');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('نهاية');
  });

  it('returns nothing for a part with no notes or no ids, instead of inventing one', () => {
    expect(readNotesPart('<w:footnotes/>', 'footnote')).toEqual([]);
    expect(readNotesPart('<w:footnotes><w:footnote w:id="0"><w:p/></w:footnote></w:footnotes>', 'footnote')).toEqual([]);
    expect(readNotesPart('', 'footnote')).toEqual([]);
  });
});

describe('building a notes part', () => {
  it('always writes the separators Word expects, with ids 0 and 1 first', () => {
    const empty = buildNotesPart('footnote', []);
    expect(empty).toContain(`w:type="separator" w:id="${NOTE_SEPARATOR_ID}"`);
    expect(empty).toContain(`w:type="continuationSeparator" w:id="${NOTE_CONTINUATION_ID}"`);
    const withNote = buildNotesPart('footnote', [note({ id: 2 })]);
    expect(withNote.indexOf('w:id="0"')).toBeLessThan(withNote.indexOf('w:id="2"'));
    expect(withNote.indexOf('w:id="1"')).toBeLessThan(withNote.indexOf('w:id="2"'));
  });

  it('writes the notes in ascending id order, with the reference mark and the text', () => {
    const xml = buildNotesPart('footnote', [note({ id: 5, text: 'خمسة' }), note({ id: 2, text: 'اثنان' })]);
    expect(xml.indexOf('w:id="2"')).toBeLessThan(xml.indexOf('w:id="5"'));
    expect(xml).toContain('<w:footnoteRef/>');
    expect(xml).toContain('xml:space="preserve"');
    expect(xml).toContain('اثنان');
    expect(xml).toContain('خمسة');
  });

  it('writes an untouched note back byte for byte, and an edited one from its text', () => {
    const original = '<w:footnote w:id="2"><w:p><w:r><w:t>كما كانت</w:t></w:r></w:p></w:footnote>';
    const untouched = noteElementXml({ kind: 'footnote', id: 2, text: 'كما كانت', xml: original });
    expect(untouched).toBe(original);
    const edited = noteElementXml({ kind: 'footnote', id: 2, text: 'بعد التحرير', xml: original });
    expect(edited).not.toBe(original);
    expect(edited).toContain('بعد التحرير');
  });

  it('escapes the text so a note cannot break the file', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
    const xml = buildNotesPart('footnote', [note({ id: 2, text: 'خطر & <w:p>' })]);
    expect(xml).toContain('خطر &amp; &lt;w:p&gt;');
    expect(readNotesPart(xml, 'footnote')[0].text).toBe('خطر & <w:p>');
  });

  it('builds an endnote part with endnote elements', () => {
    const xml = buildNotesPart('endnote', [note({ kind: 'endnote', id: 2, text: 'النهاية' })]);
    expect(xml).toContain('<w:endnotes');
    expect(xml).toContain('<w:endnote w:id="2">');
    expect(xml).toContain('<w:endnoteRef/>');
    expect(xml).not.toContain('<w:footnote ');
  });

  it('round-trips through its own reader — the text that goes in is the text that comes out', () => {
    const notes = [note({ id: 2, text: 'أولى' }), note({ id: 7, text: 'ثانية & أخرى' })];
    const back = readNotesPart(buildNotesPart('footnote', notes), 'footnote');
    expect(back.map((n) => [n.id, n.text])).toEqual([[2, 'أولى'], [7, 'ثانية & أخرى']]);
  });
});

describe('ids and the reference run', () => {
  it('never hands out 0 or 1, and never reuses a taken id', () => {
    expect(nextNoteId([])).toBe(2);
    expect(nextNoteId([0, 1])).toBe(2);
    expect(nextNoteId([2])).toBe(3);
    expect(nextNoteId([2, 3, 5])).toBe(4);
    expect(nextNoteId([0, 1, 2, 3, 4])).toBe(5);
  });

  it('points at the note with the right element per kind, keeping the run formatting', () => {
    expect(noteReferenceRunXml(note({ id: 4 }), '<w:rtl/>'))
      .toBe('<w:r><w:rPr><w:rtl/></w:rPr><w:footnoteReference w:id="4"/></w:r>');
    expect(noteReferenceRunXml(note({ kind: 'endnote', id: 9 })))
      .toBe('<w:r><w:endnoteReference w:id="9"/></w:r>');
  });

  it('knows a note run from any other opaque run', () => {
    expect(isNoteRun({ kind: 'note', note: note() })).toBe(true);
    expect(isNoteRun({ kind: 'note' })).toBe(false);
    expect(isNoteRun({ kind: 'image' })).toBe(false);
  });
});

describe('numbering the references in the body', () => {
  const blocks = [
    { id: 1, runs: [{ kind: 'text' }, { kind: 'note', note: note({ id: 2 }) }, { kind: 'note', note: note({ id: 3 }) }] },
    { id: 2, runs: [{ kind: 'text' }] },
    { id: 3, runs: [{ kind: 'note', note: note({ id: 4 }) }, { kind: 'image' }] },
  ];

  it('numbers the notes 1, 2, 3 in document order — Word\'s own order', () => {
    expect(noteNumberAt(blocks, 1, 1)).toBe(1);
    expect(noteNumberAt(blocks, 1, 2)).toBe(2);
    expect(noteNumberAt(blocks, 3, 0)).toBe(3);
    expect(noteNumberAt(blocks, 1, 0)).toBe(0);
  });

  it('numbers again from scratch, so deleting a note renumbers the rest', () => {
    const without = [{ id: 1, runs: [{ kind: 'note', note: note({ id: 3 }) }] }, blocks[2]];
    expect(noteNumberAt(without, 1, 0)).toBe(1);
    expect(noteNumberAt(without, 3, 0)).toBe(2);
  });

  it('lists every note with its number and where it lives', () => {
    const list = listNotes(blocks);
    expect(list.map((n) => n.number)).toEqual([1, 2, 3]);
    expect(list.map((n) => n.blockId)).toEqual([1, 1, 3]);
    expect(list[1].runIndex).toBe(2);
    expect(listNotes([])).toEqual([]);
  });
});
