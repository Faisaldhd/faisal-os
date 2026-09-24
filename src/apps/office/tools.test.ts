/**
 * The four local-first additions, exercised through the real window in jsdom: the
 * live bottom bar, find & replace, the focus toggle, and local import / export.
 *
 * The harness is the same shape as `office.test.ts` (an in-memory VFS plus a window
 * handle); the shell's confirm dialog is the only mocked piece.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shell/dialog', () => ({ shellConfirm: vi.fn(async () => true) }));

import { shellConfirm } from '../../shell/dialog';
import { t } from '../../kernel/i18n';
import type { AppContext, SystemAPI, VFS, WindowHandle } from '../../kernel/types';
import officeApp from './index';
import { manifest } from './manifest';
import { serializeModel } from './file';
import { utf8 } from './zip';
import './strings';

function memVfs(seed: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(seed)) files.set(path, typeof value === 'string' ? utf8(value) : value);
  const vfs = {
    stat: async (p: string) => ({ path: p, name: p, type: 'file' as const, size: files.get(p)?.length ?? 0, mode: 0o644, mtime: 0, ctime: 0 }),
    exists: async (p: string) => files.has(p),
    readdir: async () => [],
    readFile: async (p: string) => {
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
  return { vfs: vfs as unknown as VFS, files };
}

function harness(vfs: VFS) {
  const content = document.createElement('div');
  document.body.append(content);
  let title = '';
  const win: WindowHandle = {
    id: 'w1',
    appId: manifest.id,
    content,
    setTitle: (next: string) => { title = next; },
    focus: () => {},
    close: () => {},
    onClose: () => () => {},
    requestClose: async () => {},
    setCloseGuard: () => {},
    onResize: () => () => {},
  };
  const launch = (target: string) => {
    const sys = { vfs, locale: () => 'ar' as const, t } as unknown as SystemAPI;
    officeApp.launch({ sys, window: win, args: [target] } as AppContext);
  };
  return { content, title: () => title, launch };
}

const CSV_FILE = '/home/user/test.csv';
const CSV = 'a,b\n1,2\n';
const DOCX_FILE = '/home/user/report.docx';
const DOCX = serializeModel({ kind: 'docx', paragraphs: ['مرحباً يا عالم', 'عالم ثانٍ'] });

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Waits for the window's own signal that an async action finished. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const root = (content: HTMLElement): HTMLElement => content.querySelector('.faisal-office') as HTMLElement;
const buttons = (content: HTMLElement): HTMLButtonElement[] => [...content.querySelectorAll('button')];
const button = (content: HTMLElement, label: string): HTMLButtonElement | undefined =>
  buttons(content).find((b) => b.textContent === label);
const stats = (content: HTMLElement): string => content.querySelector('.faisal-office-stats')?.textContent ?? '';
const status = (content: HTMLElement): string => content.querySelector('.faisal-office-status')?.textContent ?? '';
const note = (content: HTMLElement): string => content.querySelector('.faisal-office-notice')?.textContent ?? '';
const findResult = (content: HTMLElement): string => content.querySelector('.faisal-office-findcount')?.textContent ?? '';
const textareas = (content: HTMLElement): HTMLTextAreaElement[] => [...content.querySelectorAll('textarea')];
const cells = (content: HTMLElement): HTMLInputElement[] => [...content.querySelectorAll<HTMLInputElement>('input.faisal-office-cell')];
const cell = (content: HTMLElement, r: number, c: number): HTMLInputElement | undefined =>
  cells(content).find((i) => i.dataset.r === String(r) && i.dataset.c === String(c));

function typeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A real drop event carrying real `File` objects, as the browser would deliver them. */
function drop(content: HTMLElement, files: File[]): void {
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files, dropEffect: 'none' } });
  root(content).dispatchEvent(ev);
}

/** Fills the find panel (opening it when it is closed) without touching the model. */
function openFind(content: HTMLElement, query: string, replacement = ''): void {
  const panel = content.querySelector<HTMLElement>('.faisal-office-find');
  if (panel?.hidden) button(content, t('office.findOpen'))?.click();
  const inputs = [...content.querySelectorAll<HTMLInputElement>('input.faisal-office-findinput')];
  if (inputs[0]) inputs[0].value = query;
  if (inputs[1]) inputs[1].value = replacement;
}

beforeEach(() => {
  vi.mocked(shellConfirm).mockReset();
  vi.mocked(shellConfirm).mockResolvedValue(true);
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:office-tools'), configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
});

afterEach(() => {
  document.body.textContent = '';
  vi.restoreAllMocks();
});

/* ─────────────────────────── the bottom status bar ─────────────────────────── */

describe('the bottom status bar', () => {
  it('counts words, characters and edits, and follows every keystroke', async () => {
    const { content, launch } = harness(memVfs({ '/home/user/note.txt': 'مرحبا بك' }).vfs);
    launch('/home/user/note.txt');
    await settle();

    expect(stats(content)).toContain(t('office.statWords', { n: 2 }));
    expect(stats(content)).toContain(t('office.statChars', { n: 8 }));
    expect(stats(content)).toContain(t('office.statEdits', { n: 0 }));

    const area = textareas(content)[0];
    if (!area) return;
    typeValue(area, 'مرحبا بك الثاني');
    expect(stats(content)).toContain(t('office.statWords', { n: 3 }));
    expect(stats(content)).toContain(t('office.statChars', { n: 15 }));
    expect(stats(content)).toContain(t('office.statEdits', { n: 1 }));
  });

  it('counts the cells of the active sheet, and a burst of typing as one edit', async () => {
    const { content, launch } = harness(memVfs({ [CSV_FILE]: CSV }).vfs);
    launch(CSV_FILE);
    await settle();

    expect(stats(content)).toContain(t('office.statWords', { n: 4 })); // a, b, 1, 2
    const target = cell(content, 0, 0);
    if (!target) return;
    typeValue(target, 'hello world');
    expect(stats(content)).toContain(t('office.statWords', { n: 5 }));
    expect(stats(content)).toContain(t('office.statEdits', { n: 1 }));
    typeValue(target, 'hello world!');
    await settle();
    expect(stats(content)).toContain(t('office.statEdits', { n: 1 })); // merged into the same step
  });

  it('is zero for a document that is empty', async () => {
    const { content, launch } = harness(memVfs({ '/home/user/empty.txt': '' }).vfs);
    launch('/home/user/empty.txt');
    await settle();
    expect(stats(content)).toContain(t('office.statWords', { n: 0 }));
    expect(stats(content)).toContain(t('office.statChars', { n: 0 }));
  });
});

/* ─────────────────────────── focus / dark reading ─────────────────────────── */

describe('focus mode', () => {
  it('hides the toolbars through one class, and comes back the same way', async () => {
    const { content, launch } = harness(memVfs({ [CSV_FILE]: CSV }).vfs);
    launch(CSV_FILE);
    await settle();

    const toggle = button(content, t('office.focusOn'));
    expect(toggle).toBeDefined();
    // It lives in the bottom bar, which is the only bar focus mode keeps.
    expect(toggle?.closest('.faisal-office-stats')).not.toBeNull();

    toggle?.click();
    expect(root(content).classList.contains('is-focus')).toBe(true);
    expect(button(content, t('office.focusOff'))?.getAttribute('aria-pressed')).toBe('true');
    expect(status(content)).toContain(t('office.focusNote'));

    button(content, t('office.focusOff'))?.click();
    expect(root(content).classList.contains('is-focus')).toBe(false);
    expect(button(content, t('office.focusOn'))?.getAttribute('aria-pressed')).toBe('false');
  });
});

/* ────────────────────────────── find & replace ────────────────────────────── */

describe('find & replace in the window', () => {
  it('counts matches in a Word document and replaces them all, as undoable edits', async () => {
    const { content, launch } = harness(memVfs({ [DOCX_FILE]: DOCX }).vfs);
    launch(DOCX_FILE);
    await settle();

    openFind(content, 'عالم', 'دنيا');
    button(content, t('office.findCountAction'))?.click();
    expect(findResult(content)).toBe(t('office.findFound', { n: 2 }));

    button(content, t('office.replaceAll'))?.click();
    await settle();
    expect(findResult(content)).toBe(t('office.replaced', { n: 2 }));
    expect(textareas(content).map((area) => area.value)).toEqual(['مرحباً يا دنيا', 'دنيا ثانٍ']);
    expect(stats(content)).toContain(t('office.statEdits', { n: 2 }));

    // Each replacement is one ordinary edit, so undo walks back one at a time.
    button(content, t('office.undo'))?.click();
    await settle();
    expect(textareas(content).map((area) => area.value)).toEqual(['مرحباً يا دنيا', 'عالم ثانٍ']);
  });

  it('replaces the first occurrence only in one mode, and says nothing was found otherwise', async () => {
    const { content, launch } = harness(memVfs({ [DOCX_FILE]: DOCX }).vfs);
    launch(DOCX_FILE);
    await settle();

    openFind(content, 'عالم', 'دنيا');
    button(content, t('office.replaceOne'))?.click();
    await settle();
    expect(findResult(content)).toBe(t('office.replaced', { n: 1 }));
    expect(textareas(content).map((area) => area.value)).toEqual(['مرحباً يا دنيا', 'عالم ثانٍ']);

    openFind(content, 'لا يوجد', 'x');
    button(content, t('office.findCountAction'))?.click();
    expect(findResult(content)).toBe(t('office.findNone'));
    button(content, t('office.replaceAll'))?.click();
    expect(findResult(content)).toBe(t('office.replaceNone'));

    openFind(content, '', 'x');
    button(content, t('office.replaceAll'))?.click();
    expect(findResult(content)).toBe(t('office.findEmptyQuery'));
  });

  it('asks for a query before it counts anything', async () => {
    const { content, launch } = harness(memVfs({ [DOCX_FILE]: DOCX }).vfs);
    launch(DOCX_FILE);
    await settle();
    button(content, t('office.findOpen'))?.click();
    button(content, t('office.findCountAction'))?.click();
    expect(findResult(content)).toBe(t('office.findEmptyQuery'));
  });

  it('edits a formula cell as a formula, exactly as typing in it would', async () => {
    const sheet = serializeModel({
      kind: 'xlsx',
      grids: [{ name: 'Sheet1', rows: [['1', '2', '']], truncated: false }],
      active: 0,
      delimiter: ',',
    });
    const { content, launch } = harness(memVfs({ '/home/user/calc.xlsx': sheet }).vfs);
    launch('/home/user/calc.xlsx');
    await settle();

    const target = cell(content, 0, 2);
    if (!target) return;
    typeValue(target, '=SUM(A1:B1)');
    await settle();
    expect(target.value).toBe('=SUM(A1:B1)');

    openFind(content, 'SUM', 'AVERAGE');
    button(content, t('office.replaceAll'))?.click();
    await settle();
    // The formula text was replaced and re-evaluated by the same shared rule.
    expect(cell(content, 0, 2)?.value).toBe('=AVERAGE(A1:B1)');
    expect(findResult(content)).toBe(t('office.replaced', { n: 1 }));
  });

  it('opens with Ctrl+F and closes with Escape', async () => {
    const { content, launch } = harness(memVfs({ [DOCX_FILE]: DOCX }).vfs);
    launch(DOCX_FILE);
    await settle();

    root(content).dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(content.querySelector<HTMLElement>('.faisal-office-find')?.hidden).toBe(false);
    expect(button(content, t('office.findClose'))).toBeDefined();

    root(content).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(content.querySelector<HTMLElement>('.faisal-office-find')?.hidden).toBe(true);
    expect(button(content, t('office.findOpen'))).toBeDefined();
  });
});

/* ──────────────────────────── local import ──────────────────────────── */

describe('importing a local file', () => {
  it('writes a dropped .csv into /home/user and opens it here', async () => {
    const store = memVfs({ [CSV_FILE]: CSV });
    const { content, launch } = harness(store.vfs);
    launch(CSV_FILE);
    await settle();

    drop(content, [new File(['name,qty\r\nwidget,12\r\n'], 'from-drop.csv', { type: 'text/csv' })]);
    await until(() => status(content).includes(t('office.ioImported', { name: 'from-drop.csv', path: '/home/user/from-drop.csv' })));

    expect(store.files.has('/home/user/from-drop.csv')).toBe(true);
    expect(new TextDecoder().decode(store.files.get('/home/user/from-drop.csv') ?? new Uint8Array()))
      .toBe('name,qty\r\nwidget,12\r\n');
    expect(cell(content, 1, 0)?.value).toBe('widget');
    expect(content.querySelector('.faisal-office-path')?.textContent).toBe('/home/user/from-drop.csv');
    // The file that was open is untouched, and no .bak was made for a new name.
    expect(new TextDecoder().decode(store.files.get(CSV_FILE) ?? new Uint8Array())).toBe(CSV);
  });

  it('refuses an extension it does not import, with an honest note', async () => {
    const { content, launch } = harness(memVfs({ [CSV_FILE]: CSV }).vfs);
    launch(CSV_FILE);
    await settle();

    drop(content, [new File(['# title'], 'notes.md', { type: 'text/markdown' })]);
    await settle();
    expect(note(content)).toBe(t('office.ioImportUnsupported', { name: 'notes.md' }));
  });

  it('refuses a .txt that is really binary, and asks before discarding unsaved changes', async () => {
    const store = memVfs({ [CSV_FILE]: CSV });
    const { content, launch } = harness(store.vfs);
    launch(CSV_FILE);
    await settle();

    const target = cell(content, 0, 0);
    if (!target) return;
    typeValue(target, 'changed'); // now dirty

    drop(content, [new File([new Uint8Array([0, 1, 2, 0])], 'binary.txt')]);
    await settle();
    expect(note(content)).toBe(t('office.ioImportBinary', { name: 'binary.txt' }));

    vi.mocked(shellConfirm).mockResolvedValueOnce(false); // the owner says no
    drop(content, [new File(['سطر'], 'keep.txt')]);
    await settle();
    const asked = vi.mocked(shellConfirm).mock.calls.some(([options]) => options.title === t('office.ioImportDirtyTitle'));
    expect(asked).toBe(true);
    expect(store.files.has('/home/user/keep.txt')).toBe(false);
    expect(cell(content, 0, 0)?.value).toBe('changed');
  });

  it('says so when a drop carried no file at all', async () => {
    const { content, launch } = harness(memVfs({ [CSV_FILE]: CSV }).vfs);
    launch(CSV_FILE);
    await settle();
    drop(content, []);
    await settle();
    expect(note(content)).toBe(t('office.ioImportNone'));
  });
});

/* ──────────────────────────── local export ──────────────────────────── */

describe('exporting from the window', () => {
  it('downloads the document with the right name and type, and says so', async () => {
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const { content, launch } = harness(memVfs({ [CSV_FILE]: CSV }).vfs);
    launch(CSV_FILE);
    await settle();

    button(content, t('office.ioExportTxt'))?.click();
    expect(downloads).toEqual(['test.txt']);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob | undefined;
    expect(blob?.type).toBe('text/plain;charset=utf-8');
    expect(await blob?.text()).toBe('a\tb\n1\t2');

    button(content, t('office.ioExportHtml'))?.click();
    expect(downloads).toEqual(['test.txt', 'test.html']);
    expect(status(content)).toContain(t('office.ioExported', { name: 'test.html' }));
  });

  it('hands the print-ready page to the browser for a PDF, and labels it as such', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { content, launch } = harness(memVfs({ [DOCX_FILE]: DOCX }).vfs);
    launch(DOCX_FILE);
    await settle();

    // The button says who exports the PDF, and the panel says what is in it.
    expect(button(content, t('office.ioExportPdf'))).toBeDefined();
    button(content, t('office.ioExportPdf'))?.click();
    const frame = document.querySelector<HTMLIFrameElement>('iframe.faisal-office-printframe');
    expect(frame?.srcdoc).toContain('مرحباً يا عالم');
    expect(frame?.srcdoc).toContain('@media print');
    expect(status(content)).toContain(t('office.ioPrint'));
    expect(content.textContent).toContain(t('office.ioPdfNote'));
  });

  it('shows what every export really contains, and how import works', async () => {
    const { content, launch } = harness(memVfs({ [CSV_FILE]: CSV }).vfs);
    launch(CSV_FILE);
    await settle();
    const text = content.textContent ?? '';
    for (const key of ['office.ioImportHint', 'office.ioDropHint', 'office.ioTextNote', 'office.ioCsvNote', 'office.ioHtmlNote', 'office.ioPdfNote']) {
      expect(text, key).toContain(t(key));
    }
    // A real file input, not a fake one.
    const input = content.querySelector<HTMLInputElement>('input.faisal-office-fileinput');
    expect(input?.type).toBe('file');
    expect(input?.accept).toContain('.csv');
  });
});
