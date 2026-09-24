/**
 * Tests for the surgical save, one layer under the window: the ZIP layer that
 * copies every untouched entry byte-for-byte, the per-format rules, and the
 * refusals that send a save to the rebuild path.
 *
 * The end-to-end tests ("edit in the window, press حفظ") live in `office.test.ts`;
 * here the failure modes are visible directly — a recompressed entry, a rewritten
 * shared-string table, a patcher that must say no.
 */
import { describe, expect, it } from 'vitest';
import { t } from '../../kernel/i18n';
import { openZip, readDocx, readXlsx, zipEntries } from '../viewer/formats';
import { patchPackage, readDocxFormats, snapshotModel, textParts } from './patch';
import { readRawZip, rebuildZip, utf8, writeZip, type RawZipEntry } from './zip';
import type { DocModel, SheetsModel } from './model';
import './strings';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** One part of a patched package, as text. */
async function partText(bytes: Uint8Array, name: string): Promise<string> {
  const data = await openZip(bytes).read(name);
  return new TextDecoder().decode(data ?? new Uint8Array());
}

/** name → the whole local record (header + name + data): what "byte-for-byte" means. */
function records(bytes: Uint8Array): Map<string, Uint8Array> {
  const archive = readRawZip(bytes);
  return new Map(archive.entries.map((entry) => [entry.name, bytes.slice(entry.recordStart, entry.recordEnd)]));
}

function identical(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((value, i) => value === b[i]);
}

function entry(bytes: Uint8Array, name: string): RawZipEntry {
  const found = readRawZip(bytes).entries.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no entry ${name}`);
  return found;
}

function sharedBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x11, 0xff, 0x00, 0x7f, 0x80]);
}

/** A documents-only .docx, valid as OOXML: the reader's own reader is the judge. */
function wordArchive(document: string): Uint8Array {
  return writeZip([
    { name: '[Content_Types].xml', data: utf8('<Types/>') },
    { name: 'word/document.xml', data: utf8(document) },
  ]);
}

/* ───────────────────────────────── the zip layer ───────────────────────────────── */

describe('copying an archive instead of rebuilding it', () => {
  const parts = [
    { name: '[Content_Types].xml', data: utf8('<Types/>') },
    { name: 'word/document.xml', data: utf8(`${DECL}<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r><w:t>one</w:t></w:r></w:p></w:body></w:document>`) },
    { name: 'word/media/image1.png', data: sharedBytes() },
  ];

  it('copies a stored entry verbatim and deflates the replaced part', async () => {
    const stored = writeZip(parts);
    const patched = await rebuildZip(readRawZip(stored), new Map([
      ['word/document.xml', utf8(`${DECL}<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r><w:t>two</w:t></w:r></w:p></w:body></w:document>`)],
    ]));

    expect(entry(patched, 'word/document.xml').method).toBe(8); // the changed part is deflated
    expect(entry(patched, 'word/media/image1.png').method).toBe(0); // copied as it was
    expect(identical(records(stored).get('word/media/image1.png'), records(patched).get('word/media/image1.png'))).toBe(true);
    expect(identical(records(stored).get('[Content_Types].xml'), records(patched).get('[Content_Types].xml'))).toBe(true);
    // It still reads: the reader's own inflate path is the proof.
    expect(await readDocx(patched)).toEqual(['two']);
  });

  it('keeps a deflated entry deflated, and its bytes identical', async () => {
    const stored = writeZip(parts);
    const allDeflated = await rebuildZip(readRawZip(stored), new Map(parts.map((part) => [part.name, part.data])));
    expect(entry(allDeflated, 'word/media/image1.png').method).toBe(8);

    const patched = await rebuildZip(readRawZip(allDeflated), new Map([
      ['[Content_Types].xml', utf8('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ]));
    for (const name of ['word/document.xml', 'word/media/image1.png']) {
      expect(entry(patched, name).method, name).toBe(8);
      expect(entry(patched, name).size, name).toBe(parts.find((part) => part.name === name)?.data.length);
    }
    expect(identical(records(allDeflated).get('word/media/image1.png'), records(patched).get('word/media/image1.png'))).toBe(true);
    expect(await readDocx(patched)).toEqual(['one']);
  });

  it('refuses a file that is not a readable archive, so the save can fall back', async () => {
    expect(() => readRawZip(utf8('this is not a zip file at all'))).toThrow(/zip/);
    expect(() => readRawZip(new Uint8Array(0))).toThrow(/zip/);
    await expect(rebuildZip(readRawZip(writeZip(parts)), new Map([['nope.xml', utf8('x')]]))).rejects.toThrow(/no such entry/);
  });
});

/* ──────────────────────────────── the word rule ──────────────────────────────── */

const DOCX_DOC =
  `${DECL}<w:document xmlns:w="${W_NS}"><w:body>` +
  '<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>' +
  '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello </w:t></w:r>' +
  '<w:r><w:rPr><w:i/></w:rPr><w:t>world</w:t></w:r>' +
  '<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>!</w:t></w:r>' +
  '</w:p>' +
  '<w:p><w:r><w:t>untouched</w:t></w:r></w:p>' +
  '</w:body></w:document>';

function docxFixture(): Uint8Array {
  return writeZip([
    { name: '[Content_Types].xml', data: utf8('<Types/>') },
    { name: 'word/styles.xml', data: utf8(`${DECL}<w:styles xmlns:w="${W_NS}"/>`) },
    { name: 'word/document.xml', data: utf8(DOCX_DOC) },
  ]);
}

const DOC_BASELINE: DocModel = { kind: 'docx', paragraphs: ['Hello world!', 'untouched'] };

describe('the word paragraph rule', () => {
  it('writes the whole text through the first run and keeps every run property', async () => {
    const patched = await patchPackage('docx', docxFixture(), snapshotModel(DOC_BASELINE), snapshotModel({
      kind: 'docx', paragraphs: ['مرحباً', 'untouched'],
    }));
    expect(patched).not.toBeNull();
    if (!patched) return;
    expect(patched.changed).toEqual(['word/document.xml']);
    expect(await readDocx(patched.bytes)).toEqual(['مرحباً', 'untouched']);
    const part = await partText(patched.bytes, 'word/document.xml');
    expect(part).toContain('<w:pStyle w:val="Quote"/>');
    expect(part).toContain('<w:rPr><w:b/></w:rPr>');
    expect(part).toContain('<w:rPr><w:i/></w:rPr>'); // the split runs keep their properties
    expect(part).toContain('<w:rPr><w:u w:val="single"/></w:rPr>');
    expect(part).not.toContain('world');
    expect(part).toContain('<w:p><w:r><w:t>untouched</w:t></w:r></w:p>'); // the other paragraph is untouched
  });

  it('turns tabs and line breaks into w:tab and w:br inside that run', async () => {
    const patched = await patchPackage('docx', docxFixture(), snapshotModel(DOC_BASELINE), snapshotModel({
      kind: 'docx', paragraphs: ['a\tb\nc', 'untouched'],
    }));
    expect(patched).not.toBeNull();
    if (!patched) return;
    expect(await readDocx(patched.bytes)).toEqual(['a\tb\nc', 'untouched']);
    const part = await partText(patched.bytes, 'word/document.xml');
    expect(part).toContain('a</w:t><w:tab/><w:t xml:space="preserve">b</w:t><w:br/><w:t xml:space="preserve">c');
  });

  it('splits new text into text, tab and break pieces the way the writers do', () => {
    expect(textParts('a\tb\nc')).toEqual([
      { kind: 'text', value: 'a' }, { kind: 'tab' }, { kind: 'text', value: 'b' }, { kind: 'br' }, { kind: 'text', value: 'c' },
    ]);
    expect(textParts('')).toEqual([]);
    expect(textParts('plain')).toEqual([{ kind: 'text', value: 'plain' }]);
    expect(textParts('a\r\nb')).toEqual([{ kind: 'text', value: 'a' }, { kind: 'br' }, { kind: 'text', value: 'b' }]);
  });

  it('refuses a paragraph added or removed instead of patching it', async () => {
    const longer: DocModel = { kind: 'docx', paragraphs: [...DOC_BASELINE.paragraphs, 'extra'] };
    await expect(patchPackage('docx', docxFixture(), snapshotModel(DOC_BASELINE), snapshotModel(longer))).resolves.toBeNull();
  });

  it('returns the original bytes untouched when nothing was edited', async () => {
    const original = docxFixture();
    const patched = await patchPackage('docx', original, snapshotModel(DOC_BASELINE), snapshotModel(DOC_BASELINE));
    expect(patched?.bytes).toBe(original);
    expect(patched?.changed).toEqual([]);
  });
});

/* ────────────────────────── the word formatting rule ────────────────────────── */

describe('the word formatting rule', () => {
  it('writes bold, italic, underline, size and alignment into the paragraph', async () => {
    const original = docxFixture();
    const current: DocModel = {
      kind: 'docx', paragraphs: [...DOC_BASELINE.paragraphs],
      formats: { 0: { bold: true, italic: true, underline: false, size: 14, align: 'right' } },
    };
    const patched = await patchPackage('docx', original, snapshotModel(DOC_BASELINE), snapshotModel(current));
    expect(patched).not.toBeNull();
    if (!patched) return;
    const part = await partText(patched.bytes, 'word/document.xml');
    expect(part).toContain('<w:b/>');
    expect(part).toContain('<w:i/>');
    expect(part).toContain('<w:u w:val="none"/>'); // underline off is written explicitly
    expect(part).toContain('<w:sz w:val="28"/>');
    expect(part).toContain('<w:szCs w:val="28"/>');
    expect(part).toContain('<w:jc w:val="right"/>');
    expect(part).toContain('<w:pStyle w:val="Quote"/>'); // the paragraph's own pPr is kept
    expect(part).toContain('<w:t xml:space="preserve">Hello </w:t>'); // and its text is untouched
    // It reads back through the reader the app loads a file with.
    expect(await readDocx(patched.bytes)).toEqual([...DOC_BASELINE.paragraphs]);
    expect(await readDocxFormats(patched.bytes)).toEqual({
      0: { bold: true, italic: true, underline: false, size: 14, align: 'right' },
    });
  });

  it('turns a toggle off explicitly, and clears a size by removing it', async () => {
    const original = docxFixture();
    const current: DocModel = {
      kind: 'docx', paragraphs: [...DOC_BASELINE.paragraphs],
      // The file's paragraph 0 is already bold (its first run has <w:b/>).
      formats: { 0: { bold: false, size: null, align: null } },
    };
    const patched = await patchPackage('docx', original, snapshotModel({ ...DOC_BASELINE, formats: { 0: { bold: true } } }), snapshotModel(current));
    expect(patched).not.toBeNull();
    if (!patched) return;
    const part = await partText(patched.bytes, 'word/document.xml');
    expect(part).toContain('<w:b w:val="0"/>');
    expect(part).not.toContain('<w:b/>');
    expect(await readDocxFormats(patched.bytes)).toEqual({ 0: { bold: false } });
  });

  it('formats a paragraph that had no text at all, and one with no pPr', async () => {
    const original = writeZip([
      { name: 'word/document.xml', data: utf8(`${DECL}<w:document xmlns:w="${W_NS}"><w:body><w:p/><w:p><w:r><w:t>two</w:t></w:r></w:p></w:body></w:document>`) },
    ]);
    const baseline: DocModel = { kind: 'docx', paragraphs: ['', 'two'] };
    const current: DocModel = {
      kind: 'docx', paragraphs: ['one', 'two'],
      formats: { 0: { bold: true, align: 'center' }, 1: { align: 'justify' } },
    };
    const patched = await patchPackage('docx', original, snapshotModel(baseline), snapshotModel(current));
    expect(patched).not.toBeNull();
    if (!patched) return;
    const part = await partText(patched.bytes, 'word/document.xml');
    expect(part).toContain('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr>');
    expect(part).toContain('<w:jc w:val="both"/>'); // justify is Word's "both"
    expect(await readDocx(patched.bytes)).toEqual(['one', 'two']);
    expect(await readDocxFormats(patched.bytes)).toEqual({ 0: { bold: true, align: 'center' }, 1: { align: 'justify' } });
  });
});

/* ─────────────────────────────── the excel rule ─────────────────────────────── */

function xlsxFixture(): Uint8Array {
  const sheet =
    `${DECL}<worksheet xmlns="${S_NS}"><sheetData>` +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>10</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="2"><v>20</v></c></row>' +
    '</sheetData></worksheet>';
  return writeZip([
    { name: '[Content_Types].xml', data: utf8('<Types/>') },
    { name: 'xl/workbook.xml', data: utf8(`${DECL}<workbook xmlns="${S_NS}"><sheets><sheet name="First" sheetId="1"/></sheets></workbook>`) },
    { name: 'xl/sharedStrings.xml', data: utf8(`${DECL}<sst xmlns="${S_NS}" count="2" uniqueCount="2"><si><t>Alpha</t></si><si><t>Beta</t></si></sst>`) },
    { name: 'xl/styles.xml', data: utf8(`${DECL}<styleSheet xmlns="${S_NS}"/>`) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(sheet) },
  ]);
}

const SHEET_BASELINE: SheetsModel = {
  kind: 'xlsx', active: 0, delimiter: ',',
  grids: [{ name: 'First', truncated: false, rows: [['Alpha', '10'], ['Beta', '20']] }],
};

describe('the excel cell rule', () => {
  it('appends one shared string and leaves the existing table entries alone', async () => {
    const patched = await patchPackage('xlsx', xlsxFixture(), snapshotModel(SHEET_BASELINE), snapshotModel({
      ...SHEET_BASELINE, grids: [{ name: 'First', truncated: false, rows: [['Alpha', '10'], ['Gamma', '20']] }],
    }));
    expect(patched).not.toBeNull();
    if (!patched) return;
    expect(patched.changed.sort()).toEqual(['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']);
    const shared = await partText(patched.bytes, 'xl/sharedStrings.xml');
    expect(shared).toContain('<si><t>Alpha</t></si><si><t>Beta</t></si>');
    expect(shared).toContain('<si><t xml:space="preserve">Gamma</t></si>');
    expect(shared).toContain('uniqueCount="3"');
    expect(await readXlsx(patched.bytes)).toEqual([{ name: 'First', truncated: false, rows: [['Alpha', '10'], ['Gamma', '20']] }]);
  });

  it('reuses an existing shared string instead of growing the table', async () => {
    const patched = await patchPackage('xlsx', xlsxFixture(), snapshotModel(SHEET_BASELINE), snapshotModel({
      ...SHEET_BASELINE, grids: [{ name: 'First', truncated: false, rows: [['Alpha', '10'], ['Alpha', '20']] }],
    }));
    expect(patched?.changed).toEqual(['xl/worksheets/sheet1.xml']); // sharedStrings.xml is not touched at all
    expect(await readXlsx(patched?.bytes ?? new Uint8Array())).toEqual([
      { name: 'First', truncated: false, rows: [['Alpha', '10'], ['Alpha', '20']] },
    ]);
  });

  it('writes a number as <v> and keeps the cell style attribute', async () => {
    const patched = await patchPackage('xlsx', xlsxFixture(), snapshotModel(SHEET_BASELINE), snapshotModel({
      ...SHEET_BASELINE, grids: [{ name: 'First', truncated: false, rows: [['Alpha', '10'], ['Beta', '25.5']] }],
    }));
    const part = await partText(patched?.bytes ?? new Uint8Array(), 'xl/worksheets/sheet1.xml');
    expect(part).toContain('<c r="B2" s="2"><v>25.5</v></c>');
  });

  it('refuses an added row and an added column', async () => {
    const original = xlsxFixture();
    const base = snapshotModel(SHEET_BASELINE);
    const rowAdded = snapshotModel({
      ...SHEET_BASELINE, grids: [{ name: 'First', truncated: false, rows: [['Alpha', '10'], ['Beta', '20'], ['', '']] }],
    });
    const columnAdded = snapshotModel({
      ...SHEET_BASELINE, grids: [{ name: 'First', truncated: false, rows: [['Alpha', '10', ''], ['Beta', '20', '']] }],
    });
    await expect(patchPackage('xlsx', original, base, rowAdded)).resolves.toBeNull();
    await expect(patchPackage('xlsx', original, base, columnAdded)).resolves.toBeNull();
  });

  it('writes a formula and its result into <f>/<v>, and drops <f> when it is replaced', async () => {
    const sheet = (cell: string): Uint8Array => writeZip([
      { name: 'xl/workbook.xml', data: utf8(`${DECL}<workbook xmlns="${S_NS}"><sheets><sheet name="First" sheetId="1"/></sheets></workbook>`) },
      { name: 'xl/worksheets/sheet1.xml', data: utf8(`${DECL}<worksheet xmlns="${S_NS}"><sheetData><row r="1">${cell}</row></sheetData></worksheet>`) },
    ]);
    const withFormula: SheetsModel = {
      kind: 'xlsx', active: 0, delimiter: ',',
      grids: [{ name: 'First', truncated: false, rows: [['18']] }],
    };
    const computed: SheetsModel = {
      ...withFormula,
      grids: [{ name: 'First', truncated: false, rows: [['2']] }],
      formulas: { '0:0:0': '=1+1' },
    };
    const patched = await patchPackage('xlsx', sheet('<c r="A1"><f>9+9</f><v>18</v></c>'), snapshotModel(withFormula), snapshotModel(computed));
    expect(patched).not.toBeNull();
    if (!patched) return;
    // The formula the app computed is what Excel will see, with its cached result.
    expect(await partText(patched.bytes, 'xl/worksheets/sheet1.xml')).toContain('<c r="A1"><f>1+1</f><v>2</v></c>');
    expect(await readXlsx(patched.bytes)).toEqual([{ name: 'First', truncated: false, rows: [['2']] }]);

    // Typing a plain value over a formula takes the formula out of the file.
    const plain = await patchPackage('xlsx', sheet('<c r="A1"><f>1+1</f><v>2</v></c>'), snapshotModel(computed), snapshotModel({
      ...withFormula, grids: [{ name: 'First', truncated: false, rows: [['5']] }],
    }));
    expect(plain).not.toBeNull();
    expect(await partText(plain?.bytes ?? new Uint8Array(), 'xl/worksheets/sheet1.xml')).toContain('<c r="A1"><v>5</v></c>');
  });
});

/* ──────────────────────────────────── strings ──────────────────────────────────── */

describe('the rebuild warning', () => {
  it('exists in Arabic and English and names the backup', () => {
    expect(t('office.rebuildTitle')).not.toBe('office.rebuildTitle');
    expect(t('office.rebuildOk')).not.toBe('office.rebuildOk');
    for (const key of ['office.rebuildBody', 'office.rebuildTitle', 'office.rebuildOk']) {
      expect(t(key).trim().length, key).toBeGreaterThan(0);
    }
    expect(t('office.rebuildBody', { name: 'a.docx.bak' })).toContain('a.docx.bak');
  });
});

/* ────────────────────────────────── zip entries ────────────────────────────────── */

describe('the archive a patch leaves behind', () => {
  it('keeps the entry list and order of the original', async () => {
    const original = xlsxFixture();
    const patched = await patchPackage('xlsx', original, snapshotModel(SHEET_BASELINE), snapshotModel({
      ...SHEET_BASELINE, grids: [{ name: 'First', truncated: false, rows: [['Alpha', '10'], ['Gamma', '20']] }],
    }));
    const before = zipEntries(original).map((e) => e.name);
    const after = zipEntries(patched?.bytes ?? new Uint8Array()).map((e) => e.name);
    expect(after).toEqual(before);
  });
});
