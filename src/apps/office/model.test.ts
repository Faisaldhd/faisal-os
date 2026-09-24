/**
 * Tests for the pure part: the verified format table, the edit operations, the
 * undo/redo history, the load/serialize round trip, and the one-backup save rule.
 */
import { describe, expect, it } from 'vitest';
import { MAX_COLS, MAX_ROWS } from '../viewer/formats';
import { utf8 } from './zip';
import {
  COALESCE_MS, HISTORY_LIMIT, History, VERIFIED_FORMATS, addColumnEdit, addRowEdit, canDeleteColumn,
  canDeleteRow, cellEdit, clearTruncated, deleteColumnEdit, deleteRowEdit, describeModel, emptyModel,
  gridAt, gridWidth, insertColumn, insertRow, isTruncated, paragraphEdit, planFor, removeColumn,
  removeRow, setCellValue, slideTextEdit, textEdit,
  type Edit, type Grid, type OfficeModel, type SheetsModel,
} from './model';
import { loadOfficeFile, serializeModel, writeDelimited } from './file';
import { BACKUP_SUFFIX, backupPathFor, saveWithBackup, withinHome } from './save';

const sheets = (rows: string[][]): SheetsModel =>
  ({ kind: 'xlsx', grids: [{ name: 'S', rows, truncated: false }], active: 0, delimiter: ',' });

const rowsOf = (model: OfficeModel): string[][] => (model.kind === 'xlsx' ? model.grids[0].rows : []);

/** A clock that jumps a second per call, so no two pushes ever coalesce by accident. */
function tickClock(): () => number {
  let clock = 0;
  return () => (clock += 1000);
}

/* ───────────────────────────── formats ───────────────────────────── */

describe('planFor', () => {
  it('maps the extensions the readers really handle', () => {
    expect(planFor('/home/user/a.docx')).toMatchObject({ kind: 'docx', refusal: null, readOnly: null });
    expect(planFor('/home/user/a.xlsx')).toMatchObject({ kind: 'xlsx', refusal: null, readOnly: null });
    expect(planFor('/home/user/a.pptx')).toMatchObject({ kind: 'pptx', refusal: null, readOnly: null });
    expect(planFor('/home/user/a.csv')).toMatchObject({ kind: 'csv', delimiter: ',' });
    expect(planFor('/home/user/a.tsv')).toMatchObject({ kind: 'csv', delimiter: '\t' });
    expect(planFor('/home/user/a.txt')).toMatchObject({ kind: 'text' });
    expect(planFor('/home/user/notes.MD')).toMatchObject({ kind: 'text' });
  });

  it('offers .xlsm read-only, because saving it would drop its macros', () => {
    expect(planFor('/home/user/a.xlsm')).toMatchObject({ kind: 'xlsx', readOnly: 'macros', refusal: null });
  });

  it('refuses the legacy binary formats by name', () => {
    for (const ext of ['.doc', '.xls', '.ppt']) {
      expect(planFor(`/home/user/a${ext}`)).toMatchObject({ kind: null, refusal: 'legacy' });
    }
    expect(planFor('/home/user/a.DOC')).toMatchObject({ refusal: 'legacy' }); // extension check is case-insensitive
  });

  it('refuses anything else as unknown', () => {
    expect(planFor('/home/user/a.zip')).toMatchObject({ kind: null, refusal: 'unknown' });
    expect(planFor('/home/user/a')).toMatchObject({ kind: null, refusal: 'unknown' });
    expect(planFor('/home/user/archive.tar.gz')).toMatchObject({ refusal: 'unknown' });
  });

  it('keeps its promise about every extension in the verified table', () => {
    expect(VERIFIED_FORMATS.length).toBeGreaterThanOrEqual(11);
    for (const row of VERIFIED_FORMATS) {
      const plan = planFor(`/home/user/file${row.ext}`);
      if (row.level === 'edit') {
        expect(plan.kind, row.ext).not.toBeNull();
        expect(plan.refusal, row.ext).toBeNull();
        expect(plan.readOnly, row.ext).toBeNull();
      } else if (row.level === 'read-only') {
        expect(plan.readOnly, row.ext).not.toBeNull();
        expect(plan.refusal, row.ext).toBeNull();
      } else {
        expect(plan.kind, row.ext).toBeNull();
        expect(plan.refusal, row.ext).not.toBeNull();
      }
    }
    // The extensions the manifest offers are exactly the ones that are not refused.
    expect(VERIFIED_FORMATS.filter((f) => f.level !== 'unsupported').map((f) => f.ext).sort())
      .toEqual(['.csv', '.docx', '.md', '.pptx', '.tsv', '.txt', '.xlsm', '.xlsx'].sort());
  });
});

describe('emptyModel and describeModel', () => {
  it('starts one paragraph, one sheet, one slide or an empty text for an empty file', () => {
    expect(emptyModel(planFor('a.docx'))).toEqual({ kind: 'docx', paragraphs: [''] });
    expect(emptyModel(planFor('a.xlsx')).kind).toBe('xlsx');
    expect(emptyModel(planFor('a.pptx'))).toEqual({ kind: 'pptx', slides: [['']] });
    expect(emptyModel(planFor('a.txt'))).toEqual({ kind: 'text', text: '' });
    const csv = emptyModel(planFor('a.tsv'), 'a.tsv');
    expect(csv.kind === 'csv' && csv.delimiter).toBe('\t');
    expect(csv.kind === 'csv' && csv.grids[0].name).toBe('a.tsv');
  });

  it('summarizes a model with a number only', () => {
    expect(describeModel(sheets([['a'], ['b']]))).toBe('1');
    expect(describeModel({ kind: 'docx', paragraphs: ['a', 'b'] })).toBe('2');
    expect(describeModel({ kind: 'text', text: 'abcd' })).toBe('4');
  });
});

/* ─────────────────────────── edit operations ─────────────────────────── */

describe('sheet operations', () => {
  it('writes a cell, growing the row and the grid as needed', () => {
    const model = setCellValue(sheets([['a']]), 0, 2, 3, 'late');
    expect(rowsOf(model)).toEqual([['a'], [], ['', '', '', 'late']]);
  });

  it('inserts and removes rows without losing the rest', () => {
    const base = sheets([['a', 'b'], ['c', 'd']]);
    const inserted = insertRow(base, 0, 1);
    expect(rowsOf(inserted)).toEqual([['a', 'b'], ['', ''], ['c', 'd']]);
    expect(rowsOf(removeRow(inserted, 0, 1))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('inserts and removes columns across ragged rows', () => {
    const base = sheets([['a'], ['b', 'c']]);
    const inserted = insertColumn(base, 0, 1);
    expect(rowsOf(inserted)).toEqual([['a', ''], ['b', '', 'c']]);
    expect(rowsOf(removeColumn(inserted, 0, 1))).toEqual([['a'], ['b', 'c']]);
  });

  it('knows when deleting is impossible, so the button can be disabled', () => {
    expect(canDeleteRow(sheets([['a']]), 0)).toBe(false);
    expect(canDeleteRow(sheets([['a'], ['b']]), 0)).toBe(true);
    expect(canDeleteColumn(sheets([['a']]), 0)).toBe(false);
    expect(canDeleteColumn(sheets([['a', 'b']]), 0)).toBe(true);
    const ragged: Grid = { name: 'S', rows: [['a'], ['b', 'c', 'd']], truncated: false };
    expect(gridWidth(ragged)).toBe(3);
    expect(canDeleteColumn({ kind: 'xlsx', grids: [ragged], active: 0, delimiter: ',' }, 0)).toBe(true);
  });

  it('reads a grid out of a model only for sheet-shaped files', () => {
    expect(gridAt(sheets([['a']]), 0)?.name).toBe('S');
    expect(gridAt(sheets([['a']]), 5)).toBeNull();
    expect(gridAt({ kind: 'text', text: '' }, 0)).toBeNull();
  });
});

describe('every edit is its own inverse', () => {
  it('reverts a mixed sequence of edits back to the original', () => {
    const original = sheets([['a', 'b'], ['c', 'd']]);
    let model: OfficeModel = original;
    const edits: Edit[] = [];
    const push = (edit: Edit) => { model = edit.apply(model); edits.push(edit); };

    push(cellEdit(0, 0, 0, 'a', 'z'));
    push(addRowEdit(0, 2));
    push(cellEdit(0, 2, 0, '', 'new'));
    push(addColumnEdit(0, 2));
    const beforeRow = gridAt(model, 0);
    if (beforeRow) push(deleteRowEdit(0, 1, beforeRow.rows[1] ?? []));
    const beforeCol = gridAt(model, 0);
    if (beforeCol) push(deleteColumnEdit(0, 0, beforeCol.rows.map((r) => r[0] ?? '')));
    push(paragraphEdit(0, 'x', 'y'));
    push(slideTextEdit(0, 0, 'p', 'q'));

    expect(edits).toHaveLength(8);
    expect(model).not.toEqual(original);
    for (const edit of [...edits].reverse()) model = edit.revert(model);
    expect(model).toEqual(original);
  });

  it('restores a deleted row and column with its cells', () => {
    const original = sheets([['a', 'b'], ['c', 'd']]);
    const afterRow = deleteRowEdit(0, 0, ['a', 'b']).apply(original);
    expect(rowsOf(afterRow)).toEqual([['c', 'd']]);
    expect(deleteRowEdit(0, 0, ['a', 'b']).revert(afterRow)).toEqual(original);
    const afterCol = deleteColumnEdit(0, 1, ['b', 'd']).apply(original);
    expect(rowsOf(afterCol)).toEqual([['a'], ['c']]);
    expect(deleteColumnEdit(0, 1, ['b', 'd']).revert(afterCol)).toEqual(original);
  });

  it('reverts paragraph, slide and text edits', () => {
    const doc: OfficeModel = { kind: 'docx', paragraphs: ['one', 'two'] };
    expect(paragraphEdit(1, 'two', 'TWO').revert(paragraphEdit(1, 'two', 'TWO').apply(doc))).toEqual(doc);
    const deck: OfficeModel = { kind: 'pptx', slides: [['a'], ['b']] };
    const deckEdit = slideTextEdit(1, 0, 'b', 'B');
    expect(deckEdit.revert(deckEdit.apply(deck))).toEqual(deck);
    const text: OfficeModel = { kind: 'text', text: 'hello' };
    const textEditStep = textEdit('hello', 'hello world');
    expect(textEditStep.apply(text)).toEqual({ kind: 'text', text: 'hello world' });
    expect(textEditStep.revert(textEditStep.apply(text))).toEqual(text);
  });
});

/* ───────────────────────────── history ───────────────────────────── */

describe('History', () => {
  it('walks back and forward every edit', () => {
    const history = new History(HISTORY_LIMIT, tickClock());
    const original = sheets([['0']]);
    let model: OfficeModel = original;
    for (let i = 0; i < 40; i++) {
      const edit = cellEdit(0, 0, 0, String(i), String(i + 1));
      model = edit.apply(model);
      history.push(edit);
    }
    expect(history.undoSteps).toBe(40);
    expect(history.dirty).toBe(true);
    for (let i = 0; i < 40; i++) model = history.undo(model);
    expect(model).toEqual(original);
    expect(history.undoSteps).toBe(0);
    expect(history.redoSteps).toBe(40);
    expect(history.undo(model)).toEqual(original); // nothing left to undo
    for (let i = 0; i < 40; i++) model = history.redo(model);
    expect(model).toEqual(sheets([['40']]));
    expect(history.redo(model)).toEqual(model); // nothing left to redo
  });

  it('offers at least the 30 steps the task asks for', () => {
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(30);
    const history = new History(HISTORY_LIMIT, tickClock());
    let model: OfficeModel = sheets([['0']]);
    for (let i = 0; i < 35; i++) {
      const edit = cellEdit(0, 0, 0, String(i), String(i + 1));
      model = edit.apply(model);
      history.push(edit);
    }
    for (let i = 0; i < 35; i++) model = history.undo(model);
    expect(history.undoSteps).toBe(0);
    expect(model).toEqual(sheets([['0']]));
  });

  it('merges a burst of typing in one cell into one undo step', () => {
    let clock = 0;
    const history = new History(HISTORY_LIMIT, () => clock);
    const original: OfficeModel = { kind: 'text', text: 'a' };
    let model: OfficeModel = original;
    let text = 'a';
    for (const value of ['ab', 'abc', 'abcd']) {
      const edit = textEdit(text, value);
      text = value;
      model = edit.apply(model);
      history.push(edit);
      clock += 100;
    }
    expect(history.undoSteps).toBe(1);

    // A pause ends the burst: the next keystroke is its own undo step.
    clock += COALESCE_MS + 1;
    const later = textEdit(text, 'abcde');
    model = later.apply(model);
    history.push(later);
    expect(history.undoSteps).toBe(2);
    expect(history.undo(model)).toEqual({ kind: 'text', text: 'abcd' });
    expect(history.undo(model)).toEqual(original);
  });

  it('never merges edits that target different places', () => {
    let clock = 0;
    const history = new History(HISTORY_LIMIT, () => clock);
    let model: OfficeModel = sheets([['a', 'b']]);
    for (const [row, col, from, to] of [[0, 0, 'a', 'z'], [0, 1, 'b', 'y']] as const) {
      const edit = cellEdit(0, row, col, from, to);
      model = edit.apply(model);
      history.push(edit);
      clock += 10;
    }
    expect(history.undoSteps).toBe(2);
  });

  it('caps the stack and stops claiming the disk state is reachable', () => {
    const history = new History(10, tickClock());
    let model: OfficeModel = sheets([['0']]);
    for (let i = 0; i < 25; i++) {
      const edit = cellEdit(0, 0, 0, String(i), String(i + 1));
      model = edit.apply(model);
      history.push(edit);
    }
    expect(history.undoSteps).toBe(10);
    expect(history.redoSteps).toBe(0);
    // The state that was saved at step 0 fell off the stack: still dirty, honestly.
    expect(history.dirty).toBe(true);
    for (let i = 0; i < 10; i++) model = history.undo(model);
    expect(history.undoSteps).toBe(0);
    expect(history.dirty).toBe(true);
    history.markSaved();
    expect(history.dirty).toBe(false);
  });

  it('tracks dirty through save, a new edit and undo', () => {
    const history = new History(HISTORY_LIMIT, tickClock());
    expect(history.dirty).toBe(false);
    const edit = cellEdit(0, 0, 0, 'a', 'b');
    const model = edit.apply(sheets([['a']]));
    history.push(edit);
    expect(history.dirty).toBe(true);
    history.markSaved();
    expect(history.dirty).toBe(false);
    history.undo(model);
    expect(history.dirty).toBe(true);
    history.reset();
    expect(history.dirty).toBe(false);
    expect(history.undoSteps).toBe(0);
    expect(history.redoSteps).toBe(0);
  });

  it('drops the redo branch when a new edit follows an undo', () => {
    const history = new History(HISTORY_LIMIT, tickClock());
    const first = cellEdit(0, 0, 0, 'a', 'b');
    let model: OfficeModel = first.apply(sheets([['a']]));
    history.push(first);
    model = history.undo(model);
    const second = cellEdit(0, 0, 0, 'a', 'c');
    model = second.apply(model);
    history.push(second);
    expect(history.redoSteps).toBe(0);
    expect(history.undoSteps).toBe(1);
    expect(model).toEqual(sheets([['c']]));
  });
});

describe('truncation helpers', () => {
  it('flags a partially read sheet and clears the flag after a save', () => {
    const cut: SheetsModel = { kind: 'xlsx', grids: [{ name: 'S', rows: [['a']], truncated: true }], active: 0, delimiter: ',' };
    expect(isTruncated(cut)).toBe(true);
    expect(isTruncated(sheets([['a']]))).toBe(false);
    expect(isTruncated({ kind: 'docx', paragraphs: [] })).toBe(false);
    expect(isTruncated(clearTruncated(cut))).toBe(false);
    expect(clearTruncated({ kind: 'text', text: 'x' })).toEqual({ kind: 'text', text: 'x' });
  });
});

/* ─────────────────────────── load and serialize ─────────────────────────── */

describe('loadOfficeFile', () => {
  it('loads a Word, Excel and PowerPoint file that this app just wrote', async () => {
    const models: OfficeModel[] = [
      { kind: 'docx', paragraphs: ['Title', 'Body\twith tab'] },
      { kind: 'xlsx', grids: [{ name: 'S', rows: [['1', 'two'], ['3.5', 'عربي']], truncated: false }], active: 0, delimiter: ',' },
      { kind: 'pptx', slides: [['Slide one'], ['Slide two']] },
      { kind: 'csv', grids: [{ name: 'a.csv', rows: [['x', 'y,z'], ['quote "here"', 'line\nbreak']], truncated: false }], active: 0, delimiter: ',' },
      { kind: 'text', text: 'plain text\nsecond line' },
    ];
    const paths = ['/home/user/a.docx', '/home/user/a.xlsx', '/home/user/a.pptx', '/home/user/a.csv', '/home/user/a.txt'];
    for (const [i, model] of models.entries()) {
      const result = await loadOfficeFile(paths[i], serializeModel(model));
      expect(result.ok, paths[i]).toBe(true);
      if (result.ok) expect(result.model).toEqual(model);
    }
  });

  it('reads a tab-separated file with its own delimiter', async () => {
    const result = await loadOfficeFile('/home/user/a.tsv', utf8('a\tb\nc\td\n'));
    expect(result.ok && result.model.kind === 'csv' && result.model.delimiter).toBe('\t');
    if (result.ok && result.model.kind === 'csv') expect(result.model.grids[0].rows).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('flags a CSV that is longer than the reader limit', async () => {
    const csv = Array.from({ length: MAX_ROWS + 5 }, (_, i) => `${i},x`).join('\n');
    const result = await loadOfficeFile('/home/user/big.csv', utf8(csv));
    expect(result.ok).toBe(true);
    if (result.ok && result.model.kind === 'csv') {
      expect(result.model.grids[0].rows.length).toBe(MAX_ROWS);
      expect(result.model.grids[0].truncated).toBe(true);
      expect(isTruncated(result.model)).toBe(true);
    }
  });

  it('refuses a legacy, unknown, binary or damaged file by name', async () => {
    const legacy = await loadOfficeFile('/home/user/old.doc', utf8('junk'));
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.refusal).toBe('legacy');
    const unknown = await loadOfficeFile('/home/user/old.zip', utf8('junk'));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.refusal).toBe('unknown');
    const binary = await loadOfficeFile('/home/user/bin.txt', new Uint8Array([0x00, 0x01, 0x02, 0x00]));
    expect(binary.ok).toBe(false);
    if (!binary.ok) expect(binary.refusal).toBe('binary');
    const damaged = await loadOfficeFile('/home/user/broken.docx', utf8('this is not a zip'));
    expect(damaged.ok).toBe(false);
    if (!damaged.ok) expect(damaged.refusal).toBe('damaged');
    const emptyZip = await loadOfficeFile('/home/user/empty.xlsx', new Uint8Array(0));
    expect(emptyZip.ok && emptyZip.empty).toBe(true);
  });

  it('never touches the bytes it is given', async () => {
    const bytes = serializeModel({ kind: 'text', text: 'as-is' });
    const copy = bytes.slice();
    await loadOfficeFile('/home/user/a.txt', bytes);
    expect(bytes).toEqual(copy);
  });
});

describe('writeDelimited', () => {
  it('quotes only what must be quoted, and accepts the round trip', async () => {
    const text = writeDelimited([['a,b', 'say "hi"', 'l1\nl2'], ['plain']], ',');
    expect(text).toBe('"a,b","say ""hi""","l1\nl2"\r\nplain\r\n');
    const result = await loadOfficeFile('/home/user/x.csv', utf8(text));
    expect(result.ok).toBe(true);
    if (result.ok && result.model.kind === 'csv') {
      expect(result.model.grids[0].rows).toEqual([['a,b', 'say "hi"', 'l1\nl2'], ['plain']]);
    }
  });

  it('writes a tab-separated file for .tsv', () => {
    expect(writeDelimited([['a', 'b'], ['c', '']], '\t')).toBe('a\tb\r\nc\t\r\n');
  });

  it('writes nothing for no rows', () => {
    expect(writeDelimited([], ',')).toBe('');
  });
});

/* ────────────────────────────── saving ────────────────────────────── */

function fakeVfs(seed: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(seed).map(([k, v]) => [k, utf8(v)]));
  const writes: string[] = [];
  return {
    files,
    writes,
    exists: async (path: string) => files.has(path),
    readFile: async (path: string) => {
      const data = files.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      return data;
    },
    writeFile: async (path: string, data: string | Uint8Array) => {
      writes.push(path);
      files.set(path, typeof data === 'string' ? utf8(data) : data);
    },
  };
}

describe('saveWithBackup', () => {
  it('keeps exactly one .bak copy, replaced on every save', async () => {
    const vfs = fakeVfs({ '/home/user/a.txt': 'first' });
    const one = await saveWithBackup(vfs, '/home/user/a.txt', 'second');
    expect(one.backup).toBe('/home/user/a.txt.bak');
    expect(vfs.writes).toEqual(['/home/user/a.txt.bak', '/home/user/a.txt']);
    expect(new TextDecoder().decode(vfs.files.get('/home/user/a.txt.bak'))).toBe('first');
    expect(new TextDecoder().decode(vfs.files.get('/home/user/a.txt'))).toBe('second');
    expect([...vfs.files.keys()].filter((k) => k.endsWith(BACKUP_SUFFIX))).toHaveLength(1);

    await saveWithBackup(vfs, '/home/user/a.txt', 'third');
    expect([...vfs.files.keys()].filter((k) => k.endsWith(BACKUP_SUFFIX))).toHaveLength(1);
    expect(new TextDecoder().decode(vfs.files.get('/home/user/a.txt.bak'))).toBe('second');
  });

  it('writes no backup for a file that does not exist yet', async () => {
    const vfs = fakeVfs();
    const result = await saveWithBackup(vfs, '/home/user/new.txt', 'hello');
    expect(result.backup).toBeNull();
    expect(vfs.writes).toEqual(['/home/user/new.txt']);
  });

  it('refuses any path outside /home/user', async () => {
    const vfs = fakeVfs({ '/etc/passwd': 'root:x:0:0' });
    await expect(saveWithBackup(vfs, '/etc/passwd', 'nope')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(saveWithBackup(vfs, '/home/other/a.txt', 'nope')).rejects.toMatchObject({ code: 'EACCES' });
    expect(vfs.writes).toEqual([]);
    expect(withinHome('/home/user')).toBe(true);
    expect(withinHome('/home/user/a/b.txt')).toBe(true);
    expect(withinHome('/home/user2/a.txt')).toBe(false);
    expect(backupPathFor('/home/user/a.docx')).toBe('/home/user/a.docx.bak');
  });

  it('refuses to make a backup of a backup', async () => {
    const vfs = fakeVfs({ '/home/user/a.txt.bak': 'old' });
    await expect(saveWithBackup(vfs, '/home/user/a.txt.bak', 'x')).rejects.toMatchObject({ code: 'EINVAL' });
    expect(vfs.writes).toEqual([]);
  });

  it('does not touch the file when the backup cannot be written', async () => {
    const vfs = fakeVfs({ '/home/user/a.txt': 'first' });
    const failing = {
      ...vfs,
      writeFile: async (path: string, data: string | Uint8Array) => {
        if (path.endsWith(BACKUP_SUFFIX)) throw new Error('ENOSPC: backup failed');
        return vfs.writeFile(path, data);
      },
    };
    await expect(saveWithBackup(failing, '/home/user/a.txt', 'second')).rejects.toThrow(/backup failed/);
    expect(new TextDecoder().decode(vfs.files.get('/home/user/a.txt'))).toBe('first');
  });

  it('does not touch the file when the old bytes cannot be read', async () => {
    const vfs = fakeVfs({ '/home/user/a.txt': 'first' });
    const failing = { ...vfs, readFile: async () => { throw new Error('EACCES: no read'); } };
    await expect(saveWithBackup(failing, '/home/user/a.txt', 'second')).rejects.toThrow(/no read/);
    expect(vfs.writes).toEqual([]);
  });
});
