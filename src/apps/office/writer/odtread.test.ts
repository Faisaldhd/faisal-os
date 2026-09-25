import { describe, expect, it } from 'vitest';
import type { DocModel } from '../model';
import { OFFICE_EXTENSIONS, planFor, VERIFIED_FORMATS } from '../model';
import { loadOfficeFile } from '../file';
import { toOdt, ODT_MIME } from './odt';
import { readOdt } from './odtread';
import { utf8, writeZip } from '../zip';
import type { DocBlock, Run } from './types';

/*
 * The mirror of `odt.test.ts`, and the contract the task asks for: **export then import gives the
 * same model**. The document below carries everything both directions claim to handle — Arabic text
 * with an RTL paragraph, a heading, bold/italic/underline/colour, a bulleted and a numbered list,
 * and a table — so a single round trip pins the whole mapping.
 */

const model = (): DocModel => {
  const blocks: DocBlock[] = [
    { id: 0, runs: [{ t: 'text', text: 'خطة العمل 2026', props: {} }] },
    { id: 1, runs: [
      { t: 'text', text: 'مقدمة: ', props: {} },
      { t: 'text', text: 'عريض', props: { b: true } },
      { t: 'text', text: ' ومائل', props: { i: true } },
      { t: 'text', text: ' ومسطّر', props: { u: true } },
      { t: 'text', text: ' وملوّن', props: { color: 'C8894B', sz: 14 } },
    ] },
    { id: 2, runs: [{ t: 'text', text: 'بند أول', props: {} }] },
    { id: 3, runs: [{ t: 'text', text: 'بند ثانٍ', props: {} }] },
    { id: 4, runs: [{ t: 'text', text: 'خطوة واحدة', props: {} }] },
    { id: 5, runs: [{ t: 'text', text: 'خلية أ', props: {} }], cell: { table: 0, row: 0, col: 0, rows: 1, cols: 2 } },
    { id: 6, runs: [{ t: 'text', text: 'خلية ب', props: {} }], cell: { table: 0, row: 0, col: 1, rows: 1, cols: 2 } },
  ];
  return {
    kind: 'docx',
    paragraphs: blocks.map((block) => block.runs.map((run) => run.text).join('')),
    blocks,
    formats: {
      0: { style: 'Heading1', dir: 'rtl', align: 'right' },
      1: { dir: 'rtl', align: 'right', line: 1.5 },
      2: { list: 'bullet', dir: 'rtl' },
      3: { list: 'bullet', dir: 'rtl' },
      4: { list: 'number', dir: 'rtl' },
    },
  };
};

/** The text of a block, without typing an Arabic literal twice. */
const textOf = (block: DocBlock): string => block.runs.map((run: Run) => run.text).join('');

/** A run known to be text (the reader must not have produced an opaque run where text belongs). */
const asText = (run: Run): Extract<Run, { t: 'text' }> => {
  expect(run.t, 'expected a text run').toBe('text');
  return run as Extract<Run, { t: 'text' }>;
};

describe('an exported .odt is imported back as the same model', () => {
  it('round-trips the text, the Arabic direction, the runs, the lists and the table', async () => {
    const before = model();
    const bytes = toOdt(before, { title: 'خطة العمل', created: '2026-09-25T00:00:00.000Z' });
    const read = await readOdt(bytes);
    expect(read.ok, read.ok ? '' : `refused: ${read.refusal}`).toBe(true);
    if (!read.ok) return;
    const after = read.document;

    // 1. The same blocks, with the same text — including the Arabic, character for character.
    expect(after.blocks).toHaveLength(before.blocks!.length);
    expect(after.paragraphs).toEqual(before.paragraphs);
    for (const [index, block] of before.blocks!.entries()) {
      expect(textOf(after.blocks[index]), `block ${index}`).toBe(textOf(block));
    }

    // 2. Headings, direction and alignment survive.
    expect(after.formats[0]?.style).toBe('Heading1');
    expect(after.formats[0]?.dir).toBe('rtl');
    expect(after.formats[0]?.align).toBe('right');
    expect(after.formats[1]?.dir).toBe('rtl');
    expect(after.formats[1]?.line).toBe(1.5);

    // 3. Run formatting survives on the second paragraph: bold, italic, underline, colour + size.
    const runs = after.blocks[1].runs;
    expect(asText(runs[1]).props.b).toBe(true);
    expect(asText(runs[2]).props.i).toBe(true);
    expect(asText(runs[3]).props.u).toBe(true);
    expect(asText(runs[4]).props.color).toBe('C8894B');
    expect(asText(runs[4]).props.sz).toBe(14);

    // 4. Bullet and numbered lists come back as lists, not as ordinary paragraphs.
    expect(after.formats[2]?.list).toBe('bullet');
    expect(after.formats[3]?.list).toBe('bullet');
    expect(after.formats[4]?.list).toBe('number');

    // 5. The table keeps its grid: two cells, one row, in the same columns.
    const cells = after.blocks.slice(5).map((block) => block.cell);
    expect(cells[0]).toMatchObject({ table: 0, row: 0, col: 0, rows: 1, cols: 2 });
    expect(cells[1]).toMatchObject({ table: 0, row: 0, col: 1, rows: 1, cols: 2 });

    // 6. A second round trip is stable: export what was imported and read it again.
    const again = await readOdt(toOdt({ ...after, kind: 'docx' }, {}));
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.document.paragraphs).toEqual(after.paragraphs);
      expect(again.document.blocks.map(textOf)).toEqual(after.blocks.map(textOf));
    }
  });

  it('refuses what is not an OpenDocument text package, and keeps a picture it can carry', async () => {
    // A ZIP that is not ODF at all.
    const notOdf = await readOdt(utf8('this is not a zip'));
    expect(notOdf.ok).toBe(false);
    if (!notOdf.ok) expect(notOdf.refusal).toBe('notOdt');

    // An ODF package of the wrong type (a spreadsheet's media type) is refused, not shown empty.
    const sheet = writeZip([
      { name: 'mimetype', data: utf8('application/vnd.oasis.opendocument.spreadsheet') },
      { name: 'content.xml', data: utf8('<?xml version="1.0"?><office:document-content/>') },
    ]);
    const wrongType = await readOdt(sheet);
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.refusal).toBe('notOdt');

    // A DOCX zip (a valid archive, but not ODF) is refused too.
    const docxish = writeZip([
      { name: '[Content_Types].xml', data: utf8('<?xml version="1.0"?><Types/>') },
      { name: 'word/document.xml', data: utf8('<?xml version="1.0"?><w:document/>') },
    ]);
    expect((await readOdt(docxish)).ok).toBe(false);

    // A picture inserted in this session travels: its bytes are written into Pictures/ and read back.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const withImage: DocModel = {
      kind: 'docx',
      paragraphs: ['صورة'],
      blocks: [
        { id: 0, runs: [{ t: 'text', text: 'صورة', props: {} }] },
        { id: 1, runs: [{ t: 'opaque', text: '', xml: '', kind: 'image', newImage: { data: png, ext: 'png', w: 40, h: 30, name: 'shot.png' } }] },
      ],
    };
    const back = await readOdt(toOdt(withImage, {}));
    expect(back.ok).toBe(true);
    if (back.ok) {
      const run = back.document.blocks[1].runs[0];
      expect(run.t).toBe('opaque');
      const image = (run as Extract<Run, { t: 'opaque' }>).newImage;
      expect(image?.data).toEqual(png);
      expect(image?.ext).toBe('png');
      expect(image?.w).toBe(40);
      expect(image?.h).toBe(30);
    }
    // The media type the reader demands is the one the writer writes.
    expect(new TextDecoder().decode(utf8(ODT_MIME))).toBe('application/vnd.oasis.opendocument.text');
  });

  it('is wired into the app: an .odt path is an editable Writer document that saves as ODF', async () => {
    // The extension alone decides: an editable Word-family document whose save writes ODF back.
    expect(planFor('/home/user/Documents/plan.odt')).toMatchObject({ kind: 'docx', odf: true, refusal: null, readOnly: null });
    expect(OFFICE_EXTENSIONS).toContain('.odt');
    expect(VERIFIED_FORMATS.some((row) => row.ext === '.odt' && row.level === 'edit')).toBe(true);

    // Loading the bytes the exporter produced gives the Writer the same paragraphs and formatting.
    const before = model();
    const loaded = await loadOfficeFile('/home/user/Documents/plan.odt', toOdt(before, { title: 'خطة' }));
    expect(loaded.ok, loaded.ok ? '' : `refused: ${loaded.refusal}`).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.model.kind).toBe('docx');
    if (loaded.model.kind !== 'docx') return;
    expect(loaded.model.paragraphs).toEqual(before.paragraphs);
    expect(loaded.model.blocks?.map(textOf)).toEqual(before.blocks!.map(textOf));
    expect(loaded.model.formats?.[0]?.style).toBe('Heading1');
    expect(loaded.model.formats?.[2]?.list).toBe('bullet');

    // A file that claims the extension but is not ODF is refused, never shown as an empty document.
    const wrong = await loadOfficeFile('/home/user/Documents/plan.odt', utf8('not a package'));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.refusal).toBe('damaged');
  });
});
