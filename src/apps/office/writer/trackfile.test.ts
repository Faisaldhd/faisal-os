import { describe, expect, it } from 'vitest';
import { parsePart, paragraphElements } from '../xmlscan';
import type { DocModel } from '../model';
import { entryData, readRawZip } from '../zip';
import type { DocBlock } from './types';
import { blockText } from './types';
import { emptyLog, record, type RevisionLog } from './revisions';
import { rebuildDocxRich } from './docxpatch';
import { readDocxDocument } from './docxread';
import { readTrackedRevisions, revisionAttrs, textBody, trackSegments, trackedRevisionsIn } from './trackfile';

/*
 * Tracked changes must survive the file, in both directions:
 *  • OUT — a paragraph with a pending insertion and a pending deletion becomes `w:ins` / `w:del`
 *    markup with w:id, w:author and w:date, and the deleted words go into `w:delText` (a reader that
 *    looked for `w:t` would show deleted text as kept text, which is the whole trap).
 *  • IN — that same markup comes back as the same revision log, ready for the panel.
 * The round trip is the contract, so it is what these tests assert.
 */

const AT = Date.parse('2026-09-25T10:11:12.000Z');

const block = (text: string): DocBlock => ({ id: 7, runs: [{ t: 'text', text, props: {} }] });

/** A log with one insertion and one deletion in block 7, the way an edit records them. */
function logWith(): RevisionLog {
  let log = emptyLog();
  log = record(log, { kind: 'delete', block: 7, at: 4, text: 'قديم', author: 'فيصل', time: AT }, { mergeMs: 0 });
  log = record(log, { kind: 'insert', block: 7, at: 4, text: 'جديد', author: 'فيصل', time: AT + 1000 }, { mergeMs: 0 });
  return log;
}

/** The paragraph markup `patchDocxRich` writes for a block: runs, with the marks around them. */
function paragraphMarkup(blockToWrite: DocBlock, log: RevisionLog): string {
  const segments = trackSegments(blockToWrite, log.items);
  let out = '';
  let open: 'insert' | 'delete' | null = null;
  let openRevision = 0;
  const close = (): void => { if (open) { out += open === 'insert' ? '</w:ins>' : '</w:del>'; open = null; } };
  for (const segment of segments) {
    const want = segment.mark === 'none' ? null : segment.mark;
    const id = segment.revision?.id ?? 0;
    if (want !== open || id !== openRevision) {
      close();
      if (want) {
        const attrs = segment.revision ? revisionAttrs(segment.revision) : '';
        out += want === 'insert' ? `<w:ins${attrs}>` : `<w:del${attrs}>`;
        open = want;
        openRevision = id;
      }
    }
    if (want === 'delete') out += `<w:r>${textBody(segment.text, 'w:delText')}</w:r>`;
    else out += `<w:r>${textBody(segment.text, 'w:t')}</w:r>`;
  }
  close();
  return `<w:p>${out}</w:p>`;
}

const wrap = (inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`;

describe('tracked changes are written into the file and read back', () => {
  it('writes w:ins and w:del with author, date and id, the deleted words in w:delText', () => {
    const log = logWith();
    // The document now holds the inserted text and not the deleted one — that is what the model is.
    const markup = paragraphMarkup(block('نصّ جديد هنا'), log);

    expect(markup).toContain('<w:ins w:id="2" w:author="فيصل" w:date="2026-09-25T10:11:13.000Z">');
    expect(markup).toContain('<w:del w:id="1" w:author="فيصل" w:date="2026-09-25T10:11:12.000Z">');
    expect(markup).toContain('<w:delText xml:space="preserve">قديم</w:delText>');
    // Never `w:t` for deleted text, and never `w:delText` for kept text.
    expect(markup).not.toMatch(/<w:del[^>]*>(?:(?!<\/w:del>).)*<w:t[ >]/s);
    expect(markup).toContain('<w:t xml:space="preserve">جديد</w:t>');
    // The kept text is what the paragraph already says.
    expect(markup).toContain('نصّ ');
    // The deletion sits where the revision says: right after the first four characters.
    expect(markup.indexOf('نصّ ')).toBeLessThan(markup.indexOf('<w:del '));
  });

  it('reads the same markup back as the same log, so a round trip is stable', () => {
    const log = logWith();
    const xml = wrap(paragraphMarkup(block('نصّ جديد هنا'), log));
    // The caller maps a paragraph index to the block id the model uses (index 0 → block 7 here).
    const back = readTrackedRevisions(xml, parsePart(xml), [7]);

    expect(back.items).toHaveLength(2);
    // Deletion first (it was recorded first), then the insertion — both still pending.
    expect(back.items.map((rev) => rev.kind)).toEqual(['delete', 'insert']);
    expect(back.items.map((rev) => rev.id)).toEqual([1, 2]);
    expect(back.items.map((rev) => rev.text)).toEqual(['قديم', 'جديد']);
    expect(back.items.every((rev) => rev.author === 'فيصل' && rev.status === 'pending')).toBe(true);
    expect(back.items.map((rev) => rev.time)).toEqual([AT, AT + 1000]);
    // Both sit at offset 4 of the paragraph's text ("نصّ " is four characters, the deletion is gone
    // from that text and the insertion is in it — the offsets the panel needs to draw them).
    expect(back.items.map((rev) => rev.at)).toEqual([4, 4]);
    expect(back.items.map((rev) => rev.block)).toEqual([7, 7]);
    expect(back.nextId).toBe(3);

    // Writing what was read gives the same markup: export ⇒ import ⇒ export is stable.
    const again = paragraphMarkup(block('نصّ جديد هنا'), back);
    expect(again).toBe(paragraphMarkup(block('نصّ جديد هنا'), log));
  });

  it('marks the right characters, and gives block ids back when the caller maps them', () => {
    // Two runs, an insertion covering the start of the second one: the mark crosses the run boundary.
    const twoRuns: DocBlock = {
      id: 3,
      runs: [
        { t: 'text', text: 'مرحبا ', props: { b: true } },
        { t: 'text', text: 'بكم بالعالم', props: {} },
      ],
    };
    let log = emptyLog();
    log = record(log, { kind: 'insert', block: 3, at: 6, text: 'بكم ', author: 'Faisal OS', time: AT }, { mergeMs: 0 });
    const segments = trackSegments(twoRuns, log.items);
    expect(JSON.stringify(segments.map((segment) => [segment.mark, segment.text, segment.runIndex])))
      .toBe(JSON.stringify([
        ['none', 'مرحبا ', 0],
        ['insert', 'بكم ', 1],
        ['none', 'بالعالم', 1],
      ]));

    // A paragraph with no pending revision comes back as its own runs, unmarked.
    expect(JSON.stringify(trackSegments(twoRuns, [])))
      .toBe(JSON.stringify([
        { mark: 'none', text: 'مرحبا ', runIndex: 0 },
        { mark: 'none', text: 'بكم بالعالم', runIndex: 1 },
      ]));

    // A revision whose text no longer matches is skipped, exactly as the panel skips it.
    const stale = record(emptyLog(), { kind: 'insert', block: 3, at: 0, text: 'غير موجود', author: 'A', time: AT }, { mergeMs: 0 });
    expect(trackSegments(twoRuns, stale.items).every((segment) => segment.mark === 'none')).toBe(true);

    // The block id the model uses is applied to what was read (index 0 → block 42).
    const xml = wrap(paragraphMarkup(block('نصّ جديد هنا'), logWith()));
    const mapped = readTrackedRevisions(xml, parsePart(xml), [42]);
    expect(mapped.items.map((rev) => rev.block)).toEqual([42, 42]);
  });

  it('ignores a file with no tracked changes, and never invents them', () => {
    const plain = wrap('<w:p><w:r><w:t>نص عادي</w:t></w:r></w:p>');
    const none = readTrackedRevisions(plain, parsePart(plain));
    expect(none.items).toEqual([]);
    expect(none.nextId).toBe(1);

    // A paragraph element list is what the reader walks; the count must match the model's blocks.
    const two = wrap('<w:p><w:r><w:t>أ</w:t></w:r></w:p><w:p><w:r><w:ins w:id="9" w:author="Z" w:date="2026-09-25T10:11:12.000Z"><w:t>ب</w:t></w:ins></w:r></w:p>');
    const doc = parsePart(two);
    expect(paragraphElements(doc)).toHaveLength(2);
    const read = readTrackedRevisions(two, doc);
    expect(read.items).toHaveLength(1);
    expect(read.items[0]).toMatchObject({ kind: 'insert', at: 0, text: 'ب', author: 'Z', block: 1 });
  });

  it('writes a real .docx and reads the same tracked changes back out of it', async () => {
    // The document as the Writer holds it after a tracked edit: the typed words are in the text,
    // the deleted ones are gone from it — both are in the log.
    const blockTextNow = 'مرحبا جديد بالعالم';
    const blocks: DocBlock[] = [
      { id: 0, runs: [{ t: 'text', text: 'عنوان', props: {} }] },
      { id: 1, runs: [{ t: 'text', text: blockTextNow, props: {} }] },
    ];
    const model: DocModel = { kind: 'docx', paragraphs: ['عنوان', blockTextNow], blocks };
    let log = emptyLog();
    log = record(log, { kind: 'delete', block: 1, at: 6, text: 'قديم', author: 'فيصل', time: AT }, { mergeMs: 0 });
    log = record(log, { kind: 'insert', block: 1, at: 6, text: 'جديد', author: 'فيصل', time: AT + 1000 }, { mergeMs: 0 });

    const bytes = await rebuildDocxRich(model, log.items);
    expect(bytes, 'the package was written').not.toBeNull();
    if (!bytes) return;
    const xml = new TextDecoder().decode((await entryData(readRawZip(bytes), 'word/document.xml')) ?? new Uint8Array(0));

    // The file really carries tracked markup: w:ins, w:del, the author/date/id, and w:delText.
    expect(xml).toContain('<w:ins w:id="2" w:author="فيصل"');
    expect(xml).toContain('<w:del w:id="1" w:author="فيصل"');
    expect(xml).toContain('<w:delText xml:space="preserve">قديم</w:delText>');
    expect(xml).toMatch(/w:date="2026-09-25T10:11:1[23]\.000Z"/);

    // Opened again, the document says the same thing and the log is the same log.
    const read = await readDocxDocument(bytes);
    expect(read.blocks.map(blockText)).toEqual(['عنوان', blockTextNow]);
    const back = trackedRevisionsIn(xml, read.blocks.map((block) => block.id));
    expect(back.items.map((rev) => [rev.kind, rev.text, rev.at, rev.id])).toEqual([
      ['delete', 'قديم', 6, 1],
      ['insert', 'جديد', 6, 2],
    ]);
    expect(back.items.every((rev) => rev.author === 'فيصل' && rev.status === 'pending')).toBe(true);
    expect(back.nextId).toBe(3);

    // …and accepting the deletion turns the file into a document without it: the text is written
    // plainly and the mark is gone, which is what accepting means.
    const accepted = log.items.map((rev) => (rev.kind === 'delete' ? { ...rev, status: 'accepted' as const } : rev));
    const plainBytes = await rebuildDocxRich(model, accepted);
    const plainXml = new TextDecoder().decode((await entryData(readRawZip(plainBytes ?? new Uint8Array(0)), 'word/document.xml')) ?? new Uint8Array(0));
    expect(plainXml).not.toContain('<w:delText');
    expect(trackedRevisionsIn(plainXml, [0, 1]).items.map((rev) => rev.kind)).toEqual(['insert']);
  });
});
