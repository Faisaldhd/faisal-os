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
import { MAX_ROWS, readDocx } from '../viewer/formats';
import officeApp from './index';
import { manifest } from './manifest';
import { OFFICE_EXTENSIONS, VERIFIED_FORMATS } from './model';
import { serializeModel } from './file';
import { utf8 } from './zip';
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

  it('is store-only: not core, not installed by default', () => {
    expect(manifest.id).toBe('org.faisal.Office');
    expect(manifest.core).toBe(false);
    expect(manifest.defaultInstalled).toBe(false);
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

  it('confirms before overwriting a file the reader only read in part', async () => {
    const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => `${i},x`).join('\n');
    const store = memVfs({ [HOME_FILE]: rows });
    const { content, launch } = harness(store.vfs);
    launch(HOME_FILE);
    await settle();

    expect(meta(content)).toContain(t('office.truncatedBadge'));
    button(content, t('office.save'))?.click();
    await settle();

    expect(vi.mocked(shellConfirm)).toHaveBeenCalledWith(expect.objectContaining({ title: t('office.truncatedTitle') }));
    // The saved file holds only what was read; the .bak holds the whole original.
    expect(new TextDecoder().decode(store.files.get(HOME_FILE) ?? new Uint8Array()).split('\r\n').length).toBe(MAX_ROWS + 1);
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
