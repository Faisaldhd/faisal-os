import { describe, expect, it } from 'vitest';
import { entryData, readRawZip } from '../zip';
import { rebuildDocxRich } from './docxpatch';
import { readDocxDocument } from './docxread';
import { blockText, type DocBlock, type NoteInfo, type Run } from './types';
import type { DocModel } from '../model';

/**
 * The decisive test for notes, on real bytes: what is saved must be read back the same way.
 *
 * A note is split across the package — a reference run in `document.xml`, the text in
 * `word/footnotes.xml` — so "the tag exists somewhere" would prove nothing. This writes a real
 * package through the real save path, reads it through the real read path, and then saves and
 * reads it once more, because the second save is where a note quietly loses its text.
 */
const note = (kind: 'footnote' | 'endnote', id: number, text: string): Run => ({
  t: 'opaque', text: '', xml: '', kind: 'note', note: { kind, id, text, fresh: true } satisfies NoteInfo,
});

function model(blocks: DocBlock[]): DocModel {
  return { kind: 'docx', paragraphs: blocks.map(blockText), blocks };
}

const TWO_NOTES: DocModel = model([
  { id: 0, runs: [{ t: 'text', text: 'جملة أولى', props: {} }, note('footnote', 2, 'الحاشية الأولى')] },
  { id: 1, runs: [{ t: 'text', text: 'جملة ثانية', props: {} }, note('footnote', 3, 'الحاشية الثانية')] },
  { id: 2, runs: [{ t: 'text', text: 'جملة أخيرة', props: {} }, note('endnote', 2, 'نهاية الوثيقة')] },
]);

/** Every note run of a document, in reading order, with the text the reader attached to it. */
function notesOf(blocks: readonly DocBlock[]): { kind: string; id: number; text: string }[] {
  const out: { kind: string; id: number; text: string }[] = [];
  for (const block of blocks) {
    for (const run of block.runs) {
      if (run.t === 'opaque' && run.kind === 'note' && run.note) {
        out.push({ kind: run.note.kind, id: run.note.id, text: run.note.text });
      }
    }
  }
  return out;
}

describe('footnotes in a real .docx', () => {
  it('writes the parts Word expects, with the separators and ids that are not reserved', async () => {
    const bytes = await rebuildDocxRich(TWO_NOTES);
    expect(bytes).toBeTruthy();
    const archive = readRawZip(bytes!);
    const part = await entryData(archive, 'word/footnotes.xml');
    expect(part).toBeTruthy();
    const xml = new TextDecoder().decode(part!);
    expect(xml).toContain('w:type="separator" w:id="0"');
    expect(xml).toContain('w:type="continuationSeparator" w:id="1"');
    expect(xml).toContain('الحاشية الأولى');
    expect(xml).toContain('الحاشية الثانية');
    // No real note may sit on the reserved ids.
    expect(/w:footnote w:id="[01]"(?![^>]*w:type=)/.test(xml)).toBe(false);
    // The endnote went to its own part, not into the footnote one.
    expect(xml).not.toContain('نهاية الوثيقة');
    const endnotes = await entryData(archive, 'word/endnotes.xml');
    expect(new TextDecoder().decode(endnotes!)).toContain('نهاية الوثيقة');
  });

  it('registers both parts in the content types and the document relationships', async () => {
    const bytes = await rebuildDocxRich(TWO_NOTES);
    const archive = readRawZip(bytes!);
    const types = new TextDecoder().decode((await entryData(archive, '[Content_Types].xml'))!);
    expect(types).toContain('/word/footnotes.xml');
    expect(types).toContain('wordprocessingml.footnotes+xml');
    expect(types).toContain('/word/endnotes.xml');
    const rels = new TextDecoder().decode((await entryData(archive, 'word/_rels/document.xml.rels'))!);
    expect(rels).toMatch(/relationships\/footnotes"/);
    expect(rels).toContain('Target="footnotes.xml"');
    expect(rels).toMatch(/relationships\/endnotes"/);
  });

  it('puts a reference in the body where the note was inserted', async () => {
    const bytes = await rebuildDocxRich(TWO_NOTES);
    const archive = readRawZip(bytes!);
    const body = new TextDecoder().decode((await entryData(archive, 'word/document.xml'))!);
    expect(body).toContain('<w:footnoteReference w:id="2"/>');
    expect(body).toContain('<w:footnoteReference w:id="3"/>');
    expect(body).toContain('<w:endnoteReference w:id="2"/>');
    // The references follow the text they belong to.
    expect(body.indexOf('جملة أولى')).toBeLessThan(body.indexOf('w:footnoteReference w:id="2"'));
  });

  it('reads the notes back with their text, kind, ids and order', async () => {
    const bytes = await rebuildDocxRich(TWO_NOTES);
    const read = await readDocxDocument(bytes!);
    expect(notesOf(read.blocks)).toEqual([
      { kind: 'footnote', id: 2, text: 'الحاشية الأولى' },
      { kind: 'footnote', id: 3, text: 'الحاشية الثانية' },
      { kind: 'endnote', id: 2, text: 'نهاية الوثيقة' },
    ]);
    // The body text is untouched by the notes around it.
    expect(read.blocks.map(blockText)).toEqual(['جملة أولى', 'جملة ثانية', 'جملة أخيرة']);
  });

  it('round-trips: save, read, save again, read again — the text is still there', async () => {
    const first = await rebuildDocxRich(TWO_NOTES);
    const readOnce = await readDocxDocument(first!);
    const second = await rebuildDocxRich(model(readOnce.blocks));
    expect(second).toBeTruthy();
    const readTwice = await readDocxDocument(second!);
    expect(notesOf(readTwice.blocks)).toEqual(notesOf(readOnce.blocks));
    expect(notesOf(readTwice.blocks).map((n) => n.text)).toEqual(['الحاشية الأولى', 'الحاشية الثانية', 'نهاية الوثيقة']);
  });

  it('keeps the text of an edited note, and carries a renumbered reference with it', async () => {
    const edited: DocModel = model([
      // The first note is gone: the surviving reference is renumbered by the model to id 3, while
      // its text changed in the editor.
      { id: 0, runs: [{ t: 'text', text: 'جملة أولى', props: {} }, note('footnote', 3, 'نص مُحرَّر')] },
    ]);
    const bytes = await rebuildDocxRich(edited);
    const read = await readDocxDocument(bytes!);
    expect(notesOf(read.blocks)).toEqual([{ kind: 'footnote', id: 3, text: 'نص مُحرَّر' }]);
    const body = new TextDecoder().decode((await entryData(readRawZip(bytes!), 'word/document.xml'))!);
    expect(body).toContain('<w:footnoteReference w:id="3"/>');
  });

  it('says nothing about notes for a document that has none', async () => {
    const bytes = await rebuildDocxRich(model([{ id: 0, runs: [{ t: 'text', text: 'بلا حواشٍ', props: {} }] }]));
    const archive = readRawZip(bytes!);
    expect(await entryData(archive, 'word/footnotes.xml')).toBeFalsy();
    const read = await readDocxDocument(bytes!);
    expect(notesOf(read.blocks)).toEqual([]);
    expect(read.blocks.map(blockText)).toEqual(['بلا حواشٍ']);
  });
});
