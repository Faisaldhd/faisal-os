/**
 * Writer — a rich save that fails is never turned into a plain-text save (لا حفظ نصي صامت).
 *
 * The in-place save used to write `rebuildDocxRich(...) ?? serializeModel(model)`: whenever the rich
 * path could not express the document, the owner's .docx was silently overwritten with its plain
 * text, and every heading, bold word, list, table and picture was gone on reopen. This suite drives
 * the real window over an in-memory VFS with BOTH rich paths forced to fail, and pins what must
 * happen instead: nothing is written, the owner is told (ar + en), and a plain-text copy is written
 * only when asked for — as a separate .txt, never over the document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shell/dialog', () => ({ shellConfirm: vi.fn(async () => true) }));
vi.mock('../patch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../patch')>()),
  patchPackage: vi.fn(async () => null),
}));
vi.mock('./docxpatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./docxpatch')>()),
  rebuildDocxRich: vi.fn(async () => null),
}));

import { shellConfirm } from '../../../shell/dialog';
import { t } from '../../../kernel/i18n';
import type { AppContext, SystemAPI, VFS, WindowHandle } from '../../../kernel/types';
import officeApp from '../index';
import { manifest } from '../manifest';
import { utf8 } from '../zip';
import '../strings';
import { emptyDocxPackage, rebuildDocxRich } from './docxpatch';

const PATH = '/home/user/Documents/report.docx';

function memVfs(seed: Record<string, Uint8Array>) {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
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
    writeFile: async (p: string, data: string | Uint8Array) => { files.set(p, typeof data === 'string' ? utf8(data) : data); },
    mkdir: async () => undefined,
    remove: async () => undefined,
    rename: async () => undefined,
    chmod: async () => undefined,
  };
  return { vfs: vfs as unknown as VFS, files };
}

function launch(vfs: VFS, path: string): HTMLElement {
  const content = document.createElement('div');
  document.body.append(content);
  const win = {
    id: 'w1', appId: manifest.id, content,
    setTitle: () => {}, focus: () => {}, close: () => {}, onClose: () => () => {},
    requestClose: async () => {}, setCloseGuard: () => {}, onResize: () => () => {},
  } as unknown as WindowHandle;
  const sys = { vfs, locale: () => 'ar' as const, t } as unknown as SystemAPI;
  officeApp.launch({ sys, window: win, args: [path] } as AppContext);
  return content;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const statusOf = (content: HTMLElement): string => content.querySelector('.faisal-office-status')?.textContent ?? '';

async function openAndType(content: HTMLElement, text: string): Promise<void> {
  await until(() => !!content.querySelector('textarea.faisal-office-para'));
  const area = content.querySelector<HTMLTextAreaElement>('textarea.faisal-office-para');
  if (!area) throw new Error('the Writer did not open');
  area.value = text;
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

function save(content: HTMLElement): void {
  const btn = [...content.querySelectorAll('button')].find((b) => b.textContent === t('office.save'));
  if (!btn) throw new Error('no save button');
  btn.click();
}

beforeEach(() => {
  vi.mocked(shellConfirm).mockReset();
  vi.mocked(rebuildDocxRich).mockClear();
});

afterEach(() => { document.body.textContent = ''; });

describe('a Word save whose rich paths both fail', () => {
  it('writes NOTHING and says so, instead of overwriting the file with plain text', async () => {
    vi.mocked(shellConfirm).mockResolvedValue(false);
    const original = emptyDocxPackage(false);
    const store = memVfs({ [PATH]: original });
    const content = launch(store.vfs, PATH);
    await openAndType(content, 'A heading the owner formatted');

    save(content);
    await until(() => vi.mocked(shellConfirm).mock.calls.length > 0);
    await until(() => statusOf(content).includes(t('office.richFailedStatus', { name: 'report.docx' })));

    expect(rebuildDocxRich).toHaveBeenCalled();
    // The owner is asked about a COPY — not warned about a rebuild and then overwritten.
    expect(vi.mocked(shellConfirm)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(shellConfirm)).toHaveBeenCalledWith(expect.objectContaining({
      title: t('office.richFailedTitle'), okLabel: t('office.richFailedOk'),
    }));
    expect(vi.mocked(shellConfirm)).not.toHaveBeenCalledWith(expect.objectContaining({ title: t('office.rebuildTitle') }));
    // The file is byte-for-byte what it was; no backup rotated, no copy written.
    expect(store.files.get(PATH)).toBe(original);
    expect([...store.files.keys()]).toEqual([PATH]);
  });

  it('writes a plain-text copy beside the document only when asked, and leaves the document alone', async () => {
    vi.mocked(shellConfirm).mockResolvedValue(true);
    const original = emptyDocxPackage(true);
    const store = memVfs({ [PATH]: original });
    const content = launch(store.vfs, PATH);
    await openAndType(content, 'مرحبا بالعالم');

    save(content);
    const copy = `/home/user/Documents/report (${t('office.plainCopySuffix')}).txt`;
    await until(() => store.files.has(copy));

    expect(new TextDecoder().decode(store.files.get(copy))).toBe('مرحبا بالعالم');
    expect(store.files.get(PATH)).toBe(original);
    expect(store.files.has(`${PATH}.bak`)).toBe(false);
    await until(() => statusOf(content).includes(t('office.plainCopySaved', { name: `report (${t('office.plainCopySuffix')}).txt` })));
    expect(statusOf(content)).toContain(t('office.plainCopySaved', { name: `report (${t('office.plainCopySuffix')}).txt` }));
  });
});
