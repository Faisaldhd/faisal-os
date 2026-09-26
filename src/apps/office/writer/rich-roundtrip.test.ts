/**
 * Writer — a new document keeps everything the owner made, on the first save AND the next ones
 * (حفظ المستند الجديد بكل تنسيقه).
 *
 * The audit that found this: new document → a heading, a bold phrase, a bullet list, a table, a
 * picture, an Arabic paragraph → Save → close → reopen: only the plain text was left, and a red
 * "rebuild" warning had appeared for a file that was brand new.
 *
 * The cause: the picture was inserted while the caret was still in the new table's first cell (the
 * table command leaves it there), so the picture's paragraph landed BETWEEN two cells of the table.
 * The save wrote the table in two halves, each padded with empty cells, the package no longer read
 * back as the model, and the surgical save refused — then the rebuild refused for the same reason,
 * and the window silently wrote the plain text.
 *
 * The models here are built with the same operations the Writer's own commands use (`replaceText`,
 * `formatRange`, `splitBlock`, `blockSplice`, `formatsEdit`), in the order the audit typed them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readDocx } from '../../viewer/formats';
import type { EditorContext } from '../editor';
import type { DocModel, OfficeModel, ParagraphFormat } from '../model';
import { patchPackage, snapshotModel } from '../patch';
import '../strings';
import { readDocxDocument } from './docxread';
import { emptyDocxPackage, isPristineDocx, rebuildDocxRich } from './docxpatch';
import { blockSplice, formatsEdit, sliceOf } from './docedits';
import { emptyBlock, formatRange, replaceText, splitBlock } from './docops';
import { blockText, type DocBlock, type OpaqueRun, type Run } from './types';
import { createWriter } from './view';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const ARABIC = 'مرحبا بالعالم';

/** What the window's `enrich` makes of a file: the rich model it edits. */
async function load(bytes: Uint8Array): Promise<DocModel> {
  const read = await readDocxDocument(bytes);
  const texts = await readDocx(bytes);
  expect(read.blocks.map(blockText)).toEqual(texts);
  return { kind: 'docx', paragraphs: texts, blocks: read.blocks, ...(Object.keys(read.formats).length ? { formats: read.formats } : {}) };
}

/** A tiny editing session over a model, with the Writer's own id counter. */
function session(start: DocModel) {
  let m: OfficeModel = start;
  let nextId = Math.max(-1, ...(start.blocks ?? []).map((b) => b.id)) + 1;
  const doc = (): DocModel => m as DocModel;
  const splice = (at: number, remove: number, blocks: DocBlock[], formats: Array<ParagraphFormat | undefined>): void => {
    m = blockSplice(at, sliceOf(doc(), at, remove), { blocks, formats }).apply(m);
  };
  return {
    doc,
    id: () => nextId++,
    type(b: number, text: string, at = blockText(doc().blocks?.[b] ?? { id: -1, runs: [] }).length): void {
      const block = (doc().blocks ?? [])[b];
      splice(b, 1, [{ ...block, runs: replaceText(block.runs, at, at, text) }], [doc().formats?.[b]]);
    },
    format(b: number, start: number, end: number, patch: Parameters<typeof formatRange>[3]): void {
      const block = (doc().blocks ?? [])[b];
      splice(b, 1, [{ ...block, runs: formatRange(block.runs, start, end, patch) }], [doc().formats?.[b]]);
    },
    para(b: number, change: ParagraphFormat): void {
      const before = doc().formats?.[b];
      m = formatsEdit([{ index: b, before, after: { ...(before ?? {}), ...change } }]).apply(m);
    },
    /** Enter at the end of a paragraph; a heading's next paragraph is Normal, as in the view. */
    enter(b: number): void {
      const block = (doc().blocks ?? [])[b];
      const [left, right] = splitBlock(block, blockText(block).length, nextId++);
      const format = doc().formats?.[b];
      const rightFormat = /^Heading/.test(format?.style ?? '') ? { ...format, style: 'Normal' } : format;
      splice(b, 1, [left, right], [format, rightFormat]);
    },
    insert(at: number, blocks: DocBlock[], formats: Array<ParagraphFormat | undefined>): void { splice(at, 0, blocks, formats); },
  };
}

/** The table the Insert ▸ Table command builds: rows × cols cells, then an empty paragraph. */
function tableBlocks(s: ReturnType<typeof session>, rows: number, cols: number): DocBlock[] {
  const table = s.id();
  const cells: DocBlock[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells.push({ id: table + r * cols + c + 1, runs: [{ t: 'text', text: '', props: {} }], cell: { table, row: r, col: c, rows, cols, rtl: false } });
  }
  for (let k = 0; k < rows * cols; k++) s.id();
  return [...cells, emptyBlock(s.id())];
}

/** The picture paragraph the Insert ▸ Picture command builds. */
function pictureBlock(s: ReturnType<typeof session>): DocBlock {
  const run: Run = { t: 'opaque', text: '', xml: '', kind: 'image', newImage: { data: PNG, ext: 'png', w: 40, h: 30, name: 'red.png' } };
  return { id: s.id(), runs: [run, { t: 'text', text: '', props: {} }] };
}

/**
 * The audit, step by step: heading · bold phrase · bullet list · Arabic paragraph · a 2×2 table
 * with text in its first cell · a picture. `pictureInCell` puts the picture right after the first
 * cell — where the caret was — which is exactly the model the Writer used to produce.
 */
async function auditDocument(pictureInCell: boolean): Promise<{ bytes: Uint8Array; disk: DocModel; s: ReturnType<typeof session> }> {
  const bytes = emptyDocxPackage(true);
  const disk = await load(bytes);
  const s = session(disk);
  s.type(0, 'My Heading');
  s.para(0, { style: 'Heading1' });
  s.enter(0);
  s.type(1, 'plain bold end');
  s.format(1, 6, 10, { b: true });
  s.enter(1);
  s.type(2, 'item one');
  s.para(2, { list: 'bullet' });
  s.enter(2);
  s.type(3, ARABIC);
  s.para(3, { list: null, dir: 'rtl' });
  const table = tableBlocks(s, 2, 2);
  s.insert(4, table, table.map(() => ({ dir: 'rtl' as const })));
  s.type(4, 'cell');
  s.insert(pictureInCell ? 5 : 4 + table.length - 1, [pictureBlock(s)], [{ align: 'center' }]);
  return { bytes, disk, s };
}

/** Everything the owner made, read back from the file the way a reopen reads it. */
async function expectRich(bytes: Uint8Array, heading = 'My Heading'): Promise<void> {
  const read = await readDocxDocument(bytes);
  const texts = await readDocx(bytes);
  const at = (text: string): number => texts.indexOf(text);
  expect(texts).toEqual(expect.arrayContaining([heading, 'plain bold end', 'item one', ARABIC, 'cell']));
  expect(read.formats[at(heading)]?.style).toBe('Heading1');
  const bold = read.blocks[at('plain bold end')].runs.filter((r) => r.t === 'text' && r.props.b).map((r) => r.text);
  expect(bold).toEqual(['bold']);
  expect(read.formats[at('item one')]?.list).toBe('bullet');
  expect(read.formats[at(ARABIC)]?.dir).toBe('rtl');
  expect(read.look.tables).toHaveLength(1);
  expect(read.look.tables[0].rows).toHaveLength(2);
  expect(read.look.tables[0].rows.every((row) => row.cells.length === 2)).toBe(true);
  const pictures = read.blocks.flatMap((b) => b.runs).filter((r): r is OpaqueRun => r.t === 'opaque' && r.kind === 'image');
  expect(pictures).toHaveLength(1);
  expect(read.look.media.get(pictures[0].image?.rid ?? '')?.bytes).toEqual(PNG);
}

describe('a new document saved with a heading, bold, a list, a table, a picture and Arabic', () => {
  it('is the empty package the window creates, so it owes no rebuild warning', () => {
    expect(isPristineDocx(emptyDocxPackage(true))).toBe(true);
    expect(isPristineDocx(emptyDocxPackage(false))).toBe(true);
    expect(isPristineDocx(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isPristineDocx(null)).toBe(false);
  });

  for (const pictureInCell of [true, false]) {
    const where = pictureInCell ? 'a picture inserted with the caret in a table cell' : 'a picture after the table';
    it(`keeps everything on the first save and the second one (${where})`, async () => {
      const { bytes, disk, s } = await auditDocument(pictureInCell);

      // First save: the surgical path the window tries first must take it — no rebuild.
      const first = await patchPackage('docx', bytes, snapshotModel(disk), s.doc());
      expect(first).not.toBeNull();
      if (!first) return;
      await expectRich(first.bytes);

      // The window adopts the generated picture markup, and the second save sees it that way.
      const saved = snapshotModel(s.doc()) as DocModel;
      for (const m of first.materialized ?? []) { m.run.xml = m.xml; delete m.run.newImage; }
      s.type(0, ' again');
      const second = await patchPackage('docx', first.bytes, saved, s.doc());
      expect(second).not.toBeNull();
      if (!second) return;
      await expectRich(second.bytes, 'My Heading again');

      // Close and reopen: a third save over the file as read keeps it all too.
      const reopened = await load(second.bytes);
      const again = session(reopened);
      again.type(0, '!');
      const third = await patchPackage('docx', second.bytes, snapshotModel(reopened), again.doc());
      expect(third).not.toBeNull();
      if (third) await expectRich(third.bytes, 'My Heading again!');
    });

    it(`rebuilds into a fresh package without losing anything, twice (${where})`, async () => {
      const { s } = await auditDocument(pictureInCell);
      const first = await rebuildDocxRich(s.doc());
      expect(first).not.toBeNull();
      if (!first) return;
      await expectRich(first);
      // The picture and the table of a file that was read (or that a save wrote) are carried into
      // the rebuild — the path Save As and the recovery copy take.
      const reopened = await load(first);
      const second = await rebuildDocxRich(reopened, [], first);
      expect(second).not.toBeNull();
      if (second) await expectRich(second);
    });
  }
});

/* ───────────────────────── the Writer's insert commands ───────────────────────── */

const live: Array<{ dispose(): void }> = [];
afterEach(() => {
  while (live.length) live.pop()?.dispose();
  document.body.textContent = '';
});

describe('inserting with the caret in a cell of a new table', () => {
  it('puts what is inserted after the table, never between two of its cells', () => {
    const cells: DocBlock[] = [0, 1, 2, 3].map((k) => ({
      id: 10 + k, runs: [{ t: 'text', text: `c${k}`, props: {} }], cell: { table: 9, row: k >> 1, col: k & 1, rows: 2, cols: 2 },
    }));
    const blocks: DocBlock[] = [{ id: 0, runs: [{ t: 'text', text: 'before', props: {} }] }, ...cells, { id: 20, runs: [{ t: 'text', text: 'after', props: {} }] }];
    let model: DocModel = { kind: 'docx', paragraphs: blocks.map(blockText), blocks };
    const host = document.createElement('div');
    document.body.append(host);
    const ctx: EditorContext = {
      model: () => model,
      commit: (edit) => { model = edit.apply(model) as DocModel; },
      undo: () => undefined, redo: () => undefined, editable: () => true, refresh: () => undefined,
      setStatus: () => undefined, host: () => host, filePath: () => null,
      fileTab: () => ({ id: 'file', label: 'File', groups: [] }), exportFile: async () => undefined, print: () => undefined,
    };
    Element.prototype.scrollIntoView = () => undefined;
    const editor = createWriter(ctx, null);
    host.append(editor.element);
    editor.render();
    live.push(editor);

    // The caret in the first cell, the way a click puts it there.
    const first = [...editor.element.querySelectorAll<HTMLElement>('.fo-flow .fo-p')].find((p) => p.textContent === 'c0');
    const node = first?.querySelector('.fo-r')?.firstChild;
    if (!node) throw new Error('the first cell was not drawn');
    const range = document.createRange();
    range.setStart(node, 1);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    const command = editor.tabs().flatMap((tab) => tab.groups).flatMap((g) => g.controls).find((c) => c.id === 'pagebreak') as { run(): void } | undefined;
    command?.run();

    const ids = (model.blocks ?? []).map((b) => b.id);
    const lastCell = ids.indexOf(13);
    expect(ids.slice(1, lastCell + 1)).toEqual([10, 11, 12, 13]);
    expect((model.blocks ?? [])[lastCell + 1].runs[0]).toMatchObject({ t: 'opaque', kind: 'page' });
  });
});
