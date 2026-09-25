/**
 * The Office window itself: its manifest, its string tables, and the real launch
 * path in jsdom over an in-memory VFS — opening a file, editing a cell, saving with
 * the one-backup rule, undo, revert, the read-only and refusal screens.
 *
 * The shell's confirm dialog is the only mocked piece: these tests are about what
 * the app does after the user answers, not about the shell's own dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shell/dialog', () => ({ shellConfirm: vi.fn(async () => true) }));

import { shellConfirm } from '../../shell/dialog';
import { registeredKeys, t } from '../../kernel/i18n';
import { validateManifest } from '../../kernel/apps';
import type { AppContext, SystemAPI, VFS, WindowHandle } from '../../kernel/types';
import { openZip, readDocx, readPptx, readXlsx, zipEntries } from '../viewer/formats';
import officeApp from './index';
import { manifest } from './manifest';
import { OFFICE_EXTENSIONS, SHEET_ROWS, VERIFIED_FORMATS } from './model';
import { serializeModel } from './file';
import { contentTypes } from './ooxml';
import { readRawZip, utf8, writeZip } from './zip';
import { newDeckPptx } from './pptx';
import { deckTexts, readDeck } from './impress/deck';
import './strings';

const HOME_FILE = '/home/user/test.csv';
const CSV = 'name,qty,note\nwidget,12,<b>bold</b>\n';

function memVfs(seed: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(seed)) files.set(path, typeof value === 'string' ? utf8(value) : value);
  const reads: string[] = [];
  const vfs = {
    stat: async (p: string) => ({ path: p, name: p, type: 'file' as const, size: files.get(p)?.length ?? 0, mode: 0o644, mtime: 0, ctime: 0 }),
    exists: async (p: string) => files.has(p),
    readdir: async () => [],
    readFile: async (p: string) => {
      reads.push(p);
      const data = files.get(p);
      if (!data) throw new Error(`ENOENT: ${p}`);
      return data;
    },
    readText: async (p: string) => new TextDecoder().decode(await vfs.readFile(p)),
    writeFile: async (p: string, data: string | Uint8Array) => {
      files.set(p, typeof data === 'string' ? utf8(data) : data);
    },
    mkdir: async () => undefined,
    remove: async () => undefined,
    rename: async () => undefined,
    chmod: async () => undefined,
  };
  return { vfs: vfs as unknown as VFS, files, reads };
}

interface Harness {
  content: HTMLElement;
  title: () => string;
  guard: () => boolean | Promise<boolean>;
  launch: (path?: string) => void;
}

function harness(vfs: VFS): Harness {
  const content = document.createElement('div');
  // Attached, so `focus()` and `document.activeElement` behave as in the real window.
  document.body.append(content);
  let title = '';
  let guard: (() => boolean | Promise<boolean>) | null = null;
  const win: WindowHandle = {
    id: 'w1',
    appId: manifest.id,
    content,
    setTitle: (next: string) => { title = next; },
    focus: () => {},
    close: () => {},
    onClose: () => () => {},
    requestClose: async () => {},
    setCloseGuard: (g) => { guard = g; },
    onResize: () => () => {},
  };
  const launch = (target?: string) => {
    const sys = { vfs, locale: () => 'ar' as const, t } as unknown as SystemAPI;
    const args = target === undefined ? [] : [target];
    officeApp.launch({ sys, window: win, args } as AppContext);
  };
  return {
    content,
    title: () => title,
    guard: () => Promise.resolve(guard ? guard() : true),
    launch,
  };
}

/** Lets the async open/save chains settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const buttons = (content: HTMLElement): HTMLButtonElement[] => [...content.querySelectorAll('button')];
const button = (content: HTMLElement, label: string): HTMLButtonElement | undefined =>
  buttons(content).find((b) => b.textContent === label);
const cells = (content: HTMLElement): HTMLInputElement[] =>
  [...content.querySelectorAll<HTMLInputElement>('input.faisal-office-cell')];
const cell = (content: HTMLElement, r: number, c: number): HTMLInputElement | undefined =>
  cells(content).find((i) => i.dataset.r === String(r) && i.dataset.c === String(c));
const textareas = (content: HTMLElement): HTMLTextAreaElement[] =>
  [...content.querySelectorAll<HTMLTextAreaElement>('textarea')];
const meta = (content: HTMLElement): string => content.querySelector('.faisal-office-meta')?.textContent ?? '';

function typeValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.mocked(shellConfirm).mockReset();
  vi.mocked(shellConfirm).mockResolvedValue(true);
});

afterEach(() => {
  document.body.textContent = '';
});

/* ───────────────────────────── manifest ───────────────────────────── */

describe('the office manifest', () => {
  it('is a valid manifest the kernel accepts', () => {
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it('is installed by default but still removable (not core)', () => {
    expect(manifest.id).toBe('org.faisal.Office');
    expect(manifest.core).toBe(false);
    expect(manifest.defaultInstalled).toBe(true);
  });

  it('asks for fs:home and nothing else', () => {
    expect(manifest.permissions).toEqual(['fs:home']);
  });

  it('is bilingual and offers only the extensions it really handles', () => {
    expect(manifest.name.ar.trim()).not.toBe('');
    expect(manifest.name.en.trim()).not.toBe('');
    expect(manifest.description?.ar.trim()).not.toBe('');
    expect(manifest.description?.en.trim()).not.toBe('');
    expect(manifest.opens).toEqual([...OFFICE_EXTENSIONS]);
    expect(manifest.opens).not.toContain('*');
    for (const ext of ['.docx', '.xlsx', '.xlsm', '.pptx', '.csv', '.tsv', '.txt', '.md']) {
      expect(manifest.opens).toContain(ext);
    }
    expect(manifest.opens).not.toContain('.doc');
  });

  it('carries a brand-tile SVG icon', () => {
    expect(manifest.icon.startsWith('<svg')).toBe(true);
    expect(manifest.icon).toContain('viewBox="0 0 64 64"');
  });
});

/* ───────────────────────────── strings ───────────────────────────── */

describe('office strings', () => {
  it('has the same keys in Arabic and English', () => {
    const ar = registeredKeys('ar').filter((k) => k.startsWith('office.'));
    const en = registeredKeys('en').filter((k) => k.startsWith('office.'));
    expect(ar.length).toBeGreaterThan(40);
    expect(ar).toEqual(en);
  });

  it('names the verified formats in both languages', () => {
    expect(t('office.formatsEdit', { list: '.docx' })).toContain('.docx');
    expect(t('office.formatsUnsupported', { list: '.doc' })).toContain('.doc');
    expect(t('office.limitsTitle')).not.toBe('office.limitsTitle');
    expect(VERIFIED_FORMATS.some((f) => f.ext === '.xlsm' && f.level === 'read-only')).toBe(true);
  });
});

/* ───────────────────────────── window ───────────────────────────── */

describe('the office window', () => {
  it('asks for a file when it is launched without one', () => {
    const { content, launch } = harness(memVfs().vfs);
    launch();
    expect(content.textContent).toContain(t('office.noFile'));
    expect(content.querySelector('.faisal-office-limits')).not.toBeNull();
  });

  it('renders a CSV as editable cells, as text, never as markup', async () => {
    const { content, title, launch } = harness(memVfs({ [HOME_FILE]: CSV }).vfs);
    launch(HOME_FILE);
    await settle();

    expect(title()).toContain('test.csv');
    expect(cell(content, 0, 0)?.value).toBe('name');
    expect(cell(content, 1, 0)?.value).toBe('widget');
    expect(cell(content, 1, 2)?.value).toBe('<b>bold</b>');
    // The cell text is a value, not markup: nothing from the file became an element.
    expect(content.querySelector('b')).toBeNull();
    expect(meta(content)).toContain(t('office.clean'));
  });

  it('marks an edit dirty, saves with one .bak, and undoes the edit', async () => {
    const store = memVfs({ [HOME_FILE]: CSV });
    const { content, launch } = harness(store.vfs);
    launch(HOME_FILE);
    await settle();

    const first = cell(content, 1, 0);
    expect(first).toBeDefined();
    if (!first) return;
    typeValue(first, 'gadget');
    expect(meta(content)).toContain(t('office.dirty'));
    const saveBtn = button(content, t('office.save'));
    expect(saveBtn?.disabled).toBe(false);

    saveBtn?.click();
    await settle();

    expect(new TextDecoder().decode(store.files.get(`${HOME_FILE}.bak`) ?? new Uint8Array())).toBe(CSV);
    expect(new TextDecoder().decode(store.files.get(HOME_FILE) ?? new Uint8Array())).toBe('name,qty,note\r\ngadget,12,<b>bold</b>\r\n');
    expect(meta(content)).toContain(t('office.clean'));
    expect(content.textContent).toContain(t('office.savedWithBackup', { name: 'test.csv.bak' }));

    button(content, t('office.undo'))?.click();
    await settle();
    expect(cell(content, 1, 0)?.value).toBe('widget');
    expect(meta(content)).toContain(t('office.dirty'));
  });

  it('confirms before overwriting a file the sheet only read in part', async () => {
    // The sheet reads SHEET_ROWS rows (10 000), not the reader's preview-sized default, so the
    // file here is one row past THAT limit — the case the confirm exists for.
    const rows = Array.from({ length: SHEET_ROWS + 5 }, (_, i) => `${i},x`).join('\n');
    const store = memVfs({ [HOME_FILE]: rows });
    const { content, launch } = harness(store.vfs);
    launch(HOME_FILE);
    await settle();

    expect(meta(content)).toContain(t('office.truncatedBadge'));
    button(content, t('office.save'))?.click();
    await settle();

    expect(vi.mocked(shellConfirm)).toHaveBeenCalledWith(expect.objectContaining({ title: t('office.truncatedTitle') }));
    // The saved file holds only what was read; the .bak holds the whole original.
    expect(new TextDecoder().decode(store.files.get(HOME_FILE) ?? new Uint8Array()).split('\r\n').length).toBe(SHEET_ROWS + 1);
    expect(new TextDecoder().decode(store.files.get(`${HOME_FILE}.bak`) ?? new Uint8Array())).toBe(rows);
    expect(meta(content)).not.toContain(t('office.truncatedBadge'));
  });

  it('reverts to what is on disk, after asking when there are unsaved changes', async () => {
    const store = memVfs({ [HOME_FILE]: CSV });
    const { content, launch } = harness(store.vfs);
    launch(HOME_FILE);
    await settle();

    const first = cell(content, 1, 0);
    if (!first) return;
    typeValue(first, 'gadget');
    store.files.set(HOME_FILE, utf8('a,b\n1,2\n'));

    button(content, t('office.revert'))?.click();
    await settle();

    expect(vi.mocked(shellConfirm)).toHaveBeenCalledWith(expect.objectContaining({ title: t('office.revertTitle') }));
    expect(cell(content, 0, 0)?.value).toBe('a');
    expect(meta(content)).toContain(t('office.clean'));
  });

  it('shows an .xlsm read-only, because saving it would drop the macros', async () => {
    const model = { kind: 'xlsx' as const, grids: [{ name: 'S', rows: [['7', 'x']], truncated: false }], active: 0, delimiter: ',' as const };
    const store = memVfs({ '/home/user/macros.xlsm': serializeModel(model) });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/macros.xlsm');
    await settle();

    expect(meta(content)).toContain(t('office.readOnlyBadge'));
    expect(content.textContent).toContain(t('office.macrosBody'));
    expect(cell(content, 0, 0)?.readOnly).toBe(true);
    expect(button(content, t('office.save'))?.disabled).toBe(true);
  });

  it('edits paragraphs of a .docx with tab and line-break fidelity', async () => {
    const model = { kind: 'docx' as const, paragraphs: ['first', 'tab\there\nnext'] };
    const store = memVfs({ '/home/user/a.docx': serializeModel(model) });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/a.docx');
    await settle();

    const areas = textareas(content);
    expect(areas.map((a) => a.value)).toEqual(['first', 'tab\there\nnext']);
    const second = areas[1];
    if (!second) return;
    second.value = 'tab\tthere\nnext';
    second.dispatchEvent(new Event('input', { bubbles: true }));
    expect(meta(content)).toContain(t('office.dirty'));

    button(content, t('office.save'))?.click();
    await settle();
    const saved = store.files.get('/home/user/a.docx') ?? new Uint8Array();
    expect(await readDocx(saved)).toEqual(['first', 'tab\tthere\nnext']);
    expect(store.files.has('/home/user/a.docx.bak')).toBe(true);
  });

  it('refuses a legacy .doc and says why, with saving disabled', async () => {
    const store = memVfs({ '/home/user/old.doc': 'legacy bytes' });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/old.doc');
    await settle();

    expect(content.textContent).toContain(t('office.legacyTitle'));
    expect(button(content, t('office.save'))?.disabled).toBe(true);
    expect(store.files.has('/home/user/old.doc.bak')).toBe(false);
  });

  it('refuses a binary .txt without reading it as text', async () => {
    const store = memVfs({ '/home/user/bin.txt': new Uint8Array([0, 1, 2, 0, 3]) });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/bin.txt');
    await settle();
    expect(content.textContent).toContain(t('office.binaryTitle'));
    expect(button(content, t('office.save'))?.disabled).toBe(true);
  });

  it('never reads a path outside /home/user', async () => {
    const store = memVfs({ '/etc/passwd': 'root:x:0:0' });
    const { content, launch } = harness(store.vfs);
    launch('/etc/passwd');
    await settle();
    expect(content.textContent).toContain(t('office.outsideTitle'));
    expect(store.reads).toEqual([]);
  });

  it('guards the window: clean closes at once, dirty asks first', async () => {
    const { content, guard, launch } = harness(memVfs({ [HOME_FILE]: CSV }).vfs);
    launch(HOME_FILE);
    await settle();
    await expect(guard()).resolves.toBe(true);
    expect(vi.mocked(shellConfirm)).not.toHaveBeenCalled();

    const first = cell(content, 1, 1);
    if (!first) return;
    typeValue(first, '99');
    await expect(guard()).resolves.toBe(true);
    expect(vi.mocked(shellConfirm)).toHaveBeenCalledWith(expect.objectContaining({ title: t('office.discardTitle') }));
  });

  it('adds and removes rows and columns from the sheet tools', async () => {
    const { content, launch } = harness(memVfs({ [HOME_FILE]: CSV }).vfs);
    launch(HOME_FILE);
    await settle();

    // A1 is selected on load, so the row buttons work immediately; the focused cell
    // decides which row a delete acts on.
    const deleteRow = button(content, t('office.deleteRow'));
    expect(deleteRow?.disabled).toBe(false);
    const target = cell(content, 1, 1);
    target?.focus();
    expect(deleteRow?.disabled).toBe(false);

    button(content, t('office.addRow'))?.click();
    await settle();
    expect(cells(content).length).toBe(3 * 3);

    button(content, t('office.deleteRow'))?.click();
    await settle();
    expect(cells(content).length).toBe(2 * 3);

    button(content, t('office.addColumn'))?.click();
    await settle();
    expect(cells(content).length).toBe(2 * 4);

    button(content, t('office.undo'))?.click();
    await settle();
    expect(cells(content).length).toBe(2 * 3);
  });
});

/* ─────────────────── the surgical save, through the real window ─────────────────── */

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** A tiny PNG-shaped blob: binary content the text model can never represent. */
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff, 0xfe, 0x7f, 0x00, 0x80]);

/** name → the whole local record (header + name + data), i.e. what "byte-for-byte" means. */
function recordsOf(bytes: Uint8Array): Map<string, Uint8Array> {
  const archive = readRawZip(bytes);
  return new Map(archive.entries.map((entry) => [entry.name, bytes.slice(entry.recordStart, entry.recordEnd)]));
}

function identicalBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Every XML part of the package parses: the "the package still opens" check. */
async function everyPartParses(bytes: Uint8Array): Promise<boolean> {
  const zip = openZip(bytes);
  for (const name of zip.names()) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const data = await zip.read(name);
    if (!data) return false;
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return false;
  }
  return true;
}

async function partText(bytes: Uint8Array, name: string): Promise<string> {
  const data = await openZip(bytes).read(name);
  return new TextDecoder().decode(data ?? new Uint8Array());
}

/** Waits for the window's own signal that the save finished. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A .docx with a custom style, a real image part and a header — none of which the reader models. */
function docxFixture(): Uint8Array {
  const document =
    `${DECL}<w:document xmlns:w="${W_NS}" xmlns:r="${DOC_REL}"><w:body>` +
    '<w:p><w:pPr><w:pStyle w:val="Fancy"/></w:pPr>' +
    '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello </w:t></w:r>' +
    '<w:r><w:rPr><w:i/></w:rPr><w:t>world</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Fancy"/></w:pPr><w:r><w:t>second paragraph</w:t></w:r></w:p>' +
    '<w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>' +
    '</w:body></w:document>';
  const styles =
    `${DECL}<w:styles xmlns:w="${W_NS}">` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Fancy"><w:name w:val="Fancy"/><w:rPr><w:color w:val="C00000"/></w:rPr></w:style>' +
    '</w:styles>';
  const header = `${DECL}<w:hdr xmlns:w="${W_NS}"><w:p><w:r><w:t>Confidential — {Faisal}</w:t></w:r></w:p></w:hdr>`;
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: utf8(contentTypes([
        '<Default Extension="png" ContentType="image/png"/>',
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
        '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>',
      ])),
    },
    {
      name: '_rels/.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="word/document.xml"/></Relationships>`),
    },
    { name: 'word/document.xml', data: utf8(document) },
    { name: 'word/styles.xml', data: utf8(styles) },
    { name: 'word/header1.xml', data: utf8(header) },
    { name: 'word/media/image1.png', data: IMAGE },
    {
      name: 'word/_rels/document.xml.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId9" Type="${DOC_REL}/header" Target="header1.xml"/></Relationships>`),
    },
  ]);
}

/** A two-sheet .xlsx with shared strings, a styled cell and an image part. */
function xlsxFixture(opts: { definedName?: boolean } = {}): Uint8Array {
  const sheet1 =
    `${DECL}<worksheet xmlns="${S_NS}"><sheetData>` +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>10</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="2"><v>20</v></c></row>' +
    '<row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3"><v>30</v></c></row>' +
    '</sheetData></worksheet>';
  const sheet2 = `${DECL}<worksheet xmlns="${S_NS}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: utf8(contentTypes([
        '<Default Extension="png" ContentType="image/png"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
      ])),
    },
    {
      name: '_rels/.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: 'xl/workbook.xml',
      data: utf8(`${DECL}<workbook xmlns="${S_NS}" xmlns:r="${DOC_REL}"><sheets>` +
        '<sheet name="First" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/>' +
        `</sheets>${opts.definedName ? '<definedNames><definedName name="Total">First!$B$1:$B$3</definedName></definedNames>' : ''}</workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${DOC_REL}/worksheet" Target="worksheets/sheet2.xml"/>` +
        '</Relationships>'),
    },
    { name: 'xl/sharedStrings.xml', data: utf8(`${DECL}<sst xmlns="${S_NS}" count="3" uniqueCount="2"><si><t>Alpha</t></si><si><t>Beta</t></si></sst>`) },
    { name: 'xl/styles.xml', data: utf8(`${DECL}<styleSheet xmlns="${S_NS}"><cellXfs count="3"><xf/><xf/><xf/></cellXfs></styleSheet>`) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(sheet1) },
    { name: 'xl/worksheets/sheet2.xml', data: utf8(sheet2) },
    { name: 'xl/media/image1.png', data: IMAGE },
  ]);
}

/** A two-slide .pptx with run properties and an image part. */
function pptxFixture(): Uint8Array {
  const slide = (body: string): string =>
    `${DECL}<p:sld xmlns:a="${A_NS}" xmlns:p="${P_NS}"><p:cSld><p:spTree><p:sp><p:txBody>` +
    `<a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return writeZip([
    { name: '[Content_Types].xml', data: utf8(contentTypes(['<Default Extension="png" ContentType="image/png"/>'])) },
    {
      name: 'ppt/slides/slide1.xml',
      data: utf8(slide('<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ar-SA" b="1"/><a:t>العنوان</a:t></a:r></a:p>')),
    },
    {
      name: 'ppt/slides/slide2.xml',
      data: utf8(slide(
        '<a:p><a:r><a:rPr lang="en-US" i="1"/><a:t xml:space="preserve">First </a:t></a:r>' +
        '<a:r><a:rPr lang="en-US"/><a:t>slide</a:t></a:r></a:p>' +
        '<a:p><a:r><a:t>Second</a:t></a:r></a:p>',
      )),
    },
    { name: 'ppt/media/image1.png', data: IMAGE },
    { name: 'ppt/theme/theme1.xml', data: utf8(`${DECL}<a:theme xmlns:a="${A_NS}" name="Office Theme"/>`) },
  ]);
}

describe('the office surgical save', () => {
  it('patches one .docx paragraph and leaves every other entry byte-for-byte', async () => {
    const fixture = docxFixture();
    const store = memVfs({ '/home/user/report.docx': fixture });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/report.docx');
    await settle();

    const areas = textareas(content);
    expect(areas.map((area) => area.value)).toEqual(['Hello world', 'second paragraph']);
    const first = areas[0];
    if (!first) return;
    first.value = 'مرحباً بالعالم';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    button(content, t('office.save'))?.click();
    await until(() => meta(content).includes(t('office.clean')) && store.files.has('/home/user/report.docx.bak'));

    const saved = store.files.get('/home/user/report.docx') ?? new Uint8Array();
    // (a) every ZIP entry except word/document.xml is byte-identical to the original.
    const before = recordsOf(fixture);
    const after = recordsOf(saved);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, record] of before) {
      if (name === 'word/document.xml') continue;
      expect(identicalBytes(record, after.get(name)), name).toBe(true);
    }
    // (b) the edited text reads back through the reader, and only it changed.
    expect(await readDocx(saved)).toEqual(['مرحباً بالعالم', 'second paragraph']);
    // (c) the package still opens, and what the reader never modelled is still in it.
    expect(await everyPartParses(saved)).toBe(true);
    const xml = await partText(saved, 'word/document.xml');
    expect(xml).toContain('<w:pStyle w:val="Fancy"/>');
    expect(xml).toContain('<w:rPr><w:b/></w:rPr>');
    expect(xml).toContain('<w:rPr><w:i/></w:rPr>');
    expect(xml).toContain('<w:p><w:pPr><w:pStyle w:val="Fancy"/></w:pPr><w:r><w:t>second paragraph</w:t></w:r></w:p>');
    expect(xml).not.toContain('world');
    // A patched file grows or shrinks a little; it does not collapse to a minimal package.
    expect(saved.length).toBeGreaterThan(fixture.length / 2);
    expect(store.files.get('/home/user/report.docx.bak')).toEqual(fixture);
  });

  it('patches one .xlsx cell pair and touches only that sheet and the shared strings', async () => {
    const fixture = xlsxFixture();
    const store = memVfs({ '/home/user/table.xlsx': fixture });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/table.xlsx');
    await settle();

    expect(cell(content, 1, 0)?.value).toBe('Beta');
    const text = cell(content, 1, 0);
    const number = cell(content, 1, 1);
    if (!text || !number) return;
    typeValue(text, 'Gamma');
    typeValue(number, '25');
    button(content, t('office.save'))?.click();
    await until(() => meta(content).includes(t('office.clean')) && store.files.has('/home/user/table.xlsx.bak'));

    const saved = store.files.get('/home/user/table.xlsx') ?? new Uint8Array();
    const before = recordsOf(fixture);
    const after = recordsOf(saved);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    const changed = [...before.keys()].filter((name) => !identicalBytes(before.get(name), after.get(name)));
    expect(changed.sort()).toEqual(['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']);

    const sheets = await readXlsx(saved);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['First', 'Second']);
    expect(sheets[0]?.rows[1]).toEqual(['Gamma', '25']);
    expect(sheets[1]?.rows[0]).toEqual(['Alpha']);
    expect(await everyPartParses(saved)).toBe(true);

    // The shared string was appended; the existing entries kept their bytes, and the
    // cell kept its style attribute.
    const shared = await partText(saved, 'xl/sharedStrings.xml');
    expect(shared).toContain('<si><t>Alpha</t></si><si><t>Beta</t></si>');
    expect(shared).toContain('<si><t xml:space="preserve">Gamma</t></si>');
    expect(shared).toContain('uniqueCount="3"');
    expect(await partText(saved, 'xl/worksheets/sheet1.xml')).toContain('<c r="B2" s="2"><v>25</v></c>');
  });

  it('patches the edited slide of a .pptx and keeps its run properties', async () => {
    const fixture = pptxFixture();
    const store = memVfs({ '/home/user/deck.pptx': fixture });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/deck.pptx');
    await settle();

    const areas = textareas(content);
    expect(areas.map((area) => area.value)).toEqual(['العنوان', 'First slide', 'Second']);
    const second = areas[2];
    if (!second) return;
    second.value = 'الثاني';
    second.dispatchEvent(new Event('input', { bubbles: true }));
    button(content, t('office.save'))?.click();
    await until(() => meta(content).includes(t('office.clean')) && store.files.has('/home/user/deck.pptx.bak'));

    const saved = store.files.get('/home/user/deck.pptx') ?? new Uint8Array();
    const before = recordsOf(fixture);
    const after = recordsOf(saved);
    const changed = [...before.keys()].filter((name) => !identicalBytes(before.get(name), after.get(name)));
    expect(changed).toEqual(['ppt/slides/slide2.xml']);
    expect(await readPptx(saved)).toEqual([['العنوان'], ['First slide', 'الثاني']]);
    expect(await everyPartParses(saved)).toBe(true);
    const xml = await partText(saved, 'ppt/slides/slide2.xml');
    expect(xml).toContain('<a:rPr lang="en-US" i="1"/>');
    expect(xml).toContain('First ');
    expect(xml).not.toContain('Second');
  });

  it('draws a complete presentation at its real layout and saves a duplicated slide surgically', async () => {
    const fixture = newDeckPptx('Opening', 'Subtitle');
    const store = memVfs({ '/home/user/show.pptx': fixture });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/show.pptx');
    await settle();

    expect(content.querySelector('.fo-impress.is-rich')).not.toBeNull();
    const stage = content.querySelector('.fo-slidestage .fo-canvas');
    expect(stage?.querySelectorAll('.fo-sh').length).toBe(2);
    expect(stage?.textContent).toContain('Opening');
    expect(content.querySelectorAll('.fo-rail-list .fo-thumb').length).toBe(1);

    button(content, t('office.impDuplicate'))?.click();
    await settle();
    expect(content.querySelectorAll('.fo-rail-list .fo-thumb').length).toBe(2);
    vi.mocked(shellConfirm).mockClear();
    button(content, t('office.save'))?.click();
    await until(() => meta(content).includes(t('office.clean')) && store.files.has('/home/user/show.pptx.bak'));
    // A surgical save: no rebuild warning, and the theme kept its bytes.
    expect(vi.mocked(shellConfirm).mock.calls.some(([o]) => o.title === t('office.rebuildTitle'))).toBe(false);
    const saved = store.files.get('/home/user/show.pptx') ?? new Uint8Array();
    expect(identicalBytes(recordsOf(fixture).get('ppt/theme/theme1.xml'), recordsOf(saved).get('ppt/theme/theme1.xml'))).toBe(true);
    const deck = await readDeck(saved);
    expect(deckTexts(deck)).toEqual([['Opening', 'Subtitle'], ['Opening', 'Subtitle']]);
  });

  it('adds a row inside the file itself: no rebuild, the other parts kept', async () => {
    const fixture = xlsxFixture();
    const store = memVfs({ '/home/user/rows.xlsx': fixture });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/rows.xlsx');
    await settle();
    vi.mocked(shellConfirm).mockClear();
    button(content, t('office.addRow'))?.click();
    await settle();
    button(content, t('office.save'))?.click();
    await until(() => store.files.has('/home/user/rows.xlsx.bak'));
    await settle();
    expect(vi.mocked(shellConfirm).mock.calls.find(([options]) => options.title === t('office.rebuildTitle'))).toBeUndefined();
    const saved = store.files.get('/home/user/rows.xlsx') ?? new Uint8Array();
    expect(zipEntries(saved).map((entry) => entry.name)).toContain('xl/media/image1.png');
    expect(zipEntries(saved).map((entry) => entry.name)).toContain('xl/sharedStrings.xml');
    const sheets = await readXlsx(saved);
    expect(sheets[0].rows.map((r) => r[1] ?? '')).toEqual(['', '10', '20', '30']); // inserted above the active A1
    expect(sheets[0].rows[2]?.[0]).toBe('Beta');
  });

  it('warns before a structural edit rebuilds the file, and keeps the original in the .bak', async () => {
    // A defined name holds references the surgical row move does not rewrite: this one rebuilds.
    const fixture = xlsxFixture({ definedName: true });
    const store = memVfs({ '/home/user/table.xlsx': fixture });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/table.xlsx');
    await settle();

    button(content, t('office.addRow'))?.click(); // a row added: not expressible surgically here
    await settle();
    button(content, t('office.save'))?.click();
    await until(() => store.files.has('/home/user/table.xlsx.bak'));

    const call = vi.mocked(shellConfirm).mock.calls.find(([options]) => options.title === t('office.rebuildTitle'));
    expect(call, 'the rebuild warning').toBeDefined();
    expect(call?.[0].okLabel).toBe(t('office.rebuildOk'));
    expect(call?.[0].message).toContain('table.xlsx.bak');
    expect(t('office.rebuildBody', { name: 'x' })).not.toBe('office.rebuildBody');

    const saved = store.files.get('/home/user/table.xlsx') ?? new Uint8Array();
    // The rebuild wrote a fresh minimal package: the image part is gone from it...
    expect(zipEntries(saved).map((entry) => entry.name)).not.toContain('xl/media/image1.png');
    expect(zipEntries(saved).map((entry) => entry.name)).not.toContain('xl/sharedStrings.xml');
    // ...and the .bak is the only copy of the original.
    expect(store.files.get('/home/user/table.xlsx.bak')).toEqual(fixture);

    // Cancelling the warning writes nothing at all.
    const other = memVfs({ '/home/user/cancel.xlsx': fixture });
    const second = harness(other.vfs);
    second.launch('/home/user/cancel.xlsx');
    await settle();
    vi.mocked(shellConfirm).mockResolvedValueOnce(false);
    button(second.content, t('office.addRow'))?.click();
    await settle();
    button(second.content, t('office.save'))?.click();
    await settle();
    expect(other.files.get('/home/user/cancel.xlsx')).toEqual(fixture);
  });

  it('writes paragraph formatting into the .docx from the toolbar, and reads it back on reopen', async () => {
    const fixture = docxFixture();
    const store = memVfs({ '/home/user/format.docx': fixture });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/format.docx');
    await settle();

    // The second paragraph has no formatting of its own, so every toggle is an "on".
    const area = textareas(content)[1];
    if (!area) return;
    area.focus();
    const bold = button(content, t('office.formatBold'));
    expect(bold?.disabled).toBe(false);
    bold?.click();
    button(content, t('office.formatAlignRight'))?.click();
    const size = content.querySelector<HTMLSelectElement>('select.faisal-office-fsize');
    if (!size) return;
    size.value = '14';
    size.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(bold?.getAttribute('aria-pressed')).toBe('true');
    expect(content.querySelector('[data-align="right"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(meta(content)).toContain(t('office.dirty'));

    button(content, t('office.save'))?.click();
    await until(() => meta(content).includes(t('office.clean')) && store.files.has('/home/user/format.docx.bak'));

    const saved = store.files.get('/home/user/format.docx') ?? new Uint8Array();
    const xml = await partText(saved, 'word/document.xml');
    expect(xml).toContain('<w:rPr><w:b/></w:rPr>');
    expect(xml).toContain('<w:jc w:val="right"/>');
    expect(xml).toContain('<w:sz w:val="28"/>');
    // Only the document part changed; the styles, header and image travelled along.
    const before = recordsOf(fixture);
    const after = recordsOf(saved);
    expect([...before.keys()].filter((name) => !identicalBytes(before.get(name), after.get(name)))).toEqual(['word/document.xml']);
    expect(await readDocx(saved)).toEqual(['Hello world', 'second paragraph']);

    // Reopening shows the same formatting, because the toolbar reads the file.
    const reopened = harness(memVfs({ '/home/user/format.docx': saved }).vfs);
    reopened.launch('/home/user/format.docx');
    await settle();
    textareas(reopened.content)[1]?.focus(); // the formatting belongs to paragraph 2
    await settle();
    expect(button(reopened.content, t('office.formatBold'))?.getAttribute('aria-pressed')).toBe('true');
    expect(reopened.content.querySelector('[data-align="right"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(reopened.content.querySelector<HTMLSelectElement>('select.faisal-office-fsize')?.value).toBe('14');
  });

  it('computes a formula typed into a cell, shows it, and writes it with its result', async () => {
    const fixture = xlsxFixture();
    const store = memVfs({ '/home/user/calc.xlsx': fixture });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/calc.xlsx');
    await settle();

    const target = cell(content, 2, 1); // B3
    if (!target) return;
    typeValue(target, '=SUM(B1:B2)');
    await settle();
    expect(target.value).toBe('=SUM(B1:B2)'); // the cell shows the formula
    expect(content.querySelector('.faisal-office-status')?.textContent).toContain('30'); // 10 + 20

    button(content, t('office.save'))?.click();
    await until(() => meta(content).includes(t('office.clean')) && store.files.has('/home/user/calc.xlsx.bak'));

    const saved = store.files.get('/home/user/calc.xlsx') ?? new Uint8Array();
    const sheet = await partText(saved, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<c r="B3"><f>SUM(B1:B2)</f><v>30</v></c>');
    expect((await readXlsx(saved))[0]?.rows[2]).toEqual(['Alpha', '30']);
    // Only the sheet changed: the second sheet and the image part are byte-identical.
    const before = recordsOf(fixture);
    const after = recordsOf(saved);
    expect([...before.keys()].filter((name) => !identicalBytes(before.get(name), after.get(name)))).toEqual(['xl/worksheets/sheet1.xml']);
  });

  it('keeps a formula when a structural edit takes the rebuild path', async () => {
    const store = memVfs({ '/home/user/calc.xlsx': xlsxFixture({ definedName: true }) });
    const { content, launch } = harness(store.vfs);
    launch('/home/user/calc.xlsx');
    await settle();

    const target = cell(content, 2, 1); // B3
    if (!target) return;
    typeValue(target, '=AVERAGE(B1:B2)'); // 15
    await settle();
    button(content, t('office.addRow'))?.click(); // a row added above B3 (a defined name: the rebuild path)
    await settle();
    button(content, t('office.save'))?.click();
    await until(() => store.files.has('/home/user/calc.xlsx.bak'));

    expect(vi.mocked(shellConfirm)).toHaveBeenCalledWith(expect.objectContaining({ title: t('office.rebuildTitle') }));
    const saved = store.files.get('/home/user/calc.xlsx') ?? new Uint8Array();
    // The rebuilt package writes the formula and the value this app computed.
    expect(await partText(saved, 'xl/worksheets/sheet1.xml')).toContain('<f>AVERAGE(B1:B2)</f><v>15</v>');
    expect((await readXlsx(saved))[0]?.rows[3]?.[1]).toBe('15'); // the formula moved down with its cell
  });
});
