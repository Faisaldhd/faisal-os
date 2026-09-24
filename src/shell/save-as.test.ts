import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stat } from '../kernel/types';
import { setLocale, t } from '../kernel/i18n';
import {
  BACKUP_SUFFIX, childFolders, crumbTrail, effectiveFormat, extensionOfName, formatForName,
  planTarget, pinToHost, sameBytes, sanitizeName, saveAsDialog, stemOfName, uniqueName,
  usableFolder, withinHome, type SaveFormat, type SaveAsVFS,
} from './save-as';

/**
 * The shared Save as / Export dialog — the rules that protect the owner's files.
 *
 * The pure half is tested directly (paths, name uniqueness, the format decision, the overwrite
 * state); the DOM half is driven for real in jsdom against a small in-memory VFS, because the
 * promises this module makes are about WRITES: a cancelled save writes nothing, a replace keeps
 * exactly one `.bak`, and "saved" is only reported after the file was read back.
 */

const FORMATS: SaveFormat[] = [
  { value: 'docx', label: 'Word (.docx)', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { value: 'pdf', label: 'PDF (.pdf)', ext: 'pdf', mime: 'application/pdf' },
];

const stat = (path: string, name: string, type: 'file' | 'dir', size = 0): Stat => ({
  path, name, type, size, mode: type === 'dir' ? 0o755 : 0o644, mtime: 1, ctime: 1,
});

/** In-memory VFS: enough of the kernel's contract for the dialog, and it records every write. */
class FakeVFS implements SaveAsVFS {
  nodes = new Map<string, { type: 'file' | 'dir'; data: Uint8Array }>();
  writes: string[] = [];
  /** Set to the bytes the read-back should return, to test the verify step. */
  tamperRead: Uint8Array | null = null;

  constructor(seed: Record<string, string> = {}) {
    for (const d of ['/home', '/home/user', '/home/user/Documents', '/home/user/Pictures', '/home/user/Documents/Reports']) {
      this.nodes.set(d, { type: 'dir', data: new Uint8Array(0) });
    }
    for (const [path, text] of Object.entries(seed)) this.write(path, text);
  }

  write(path: string, text: string): void {
    this.nodes.set(path, { type: 'file', data: new TextEncoder().encode(text) });
  }

  text(path: string): string | null {
    const node = this.nodes.get(path);
    return node ? new TextDecoder().decode(node.data) : null;
  }

  async exists(path: string): Promise<boolean> { return this.nodes.has(path); }

  async readdir(path: string): Promise<Stat[]> {
    const node = this.nodes.get(path);
    if (!node || node.type !== 'dir') throw new Error(`ENOENT: ${path}`);
    const prefix = path === '/' ? '/' : `${path}/`;
    const out: Stat[] = [];
    for (const [p, n] of this.nodes) {
      if (p === path || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push(stat(p, rest, n.type, n.data.length));
    }
    return out;
  }

  async readFile(path: string): Promise<Uint8Array> {
    if (this.tamperRead) return this.tamperRead;
    const node = this.nodes.get(path);
    if (!node || node.type !== 'file') throw new Error(`ENOENT: ${path}`);
    return node.data;
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.writes.push(path);
    this.nodes.set(path, { type: 'file', data: typeof data === 'string' ? new TextEncoder().encode(data) : data });
  }

  async mkdir(path: string): Promise<void> {
    this.nodes.set(path, { type: 'dir', data: new Uint8Array(0) });
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const host = (): HTMLElement => {
  const node = document.createElement('div');
  node.style.position = 'relative';
  document.body.append(node);
  return node;
};

const confirmButtons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('.faisal-shell-dialog-btn')];

beforeEach(() => {
  document.body.replaceChildren();
  setLocale('en');
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ───────────────────────────── pure policy ───────────────────────────── */

describe('save-as — where a save may land', () => {
  it('accepts home and everything under it, and nothing else', () => {
    expect(withinHome('/home/user')).toBe(true);
    expect(withinHome('/home/user/Documents/a.docx')).toBe(true);
    expect(withinHome('/home/user2')).toBe(false);
    expect(withinHome('/etc/passwd')).toBe(false);
    expect(withinHome('/')).toBe(false);
    // Normalised first, so an escape written as `..` is still an escape.
    expect(withinHome('/home/user/../../etc/passwd')).toBe(false);
    expect(usableFolder('/etc')).toBeNull();
    expect(usableFolder('')).toBeNull();
    expect(usableFolder('/home/user/./Pictures')).toBe('/home/user/Pictures');
  });
});

describe('save-as — file names', () => {
  it('strips path separators, control characters, leading dots and trailing dot or space', () => {
    expect(sanitizeName('a/b\\c:d.docx')).toBe('a_b_c:d.docx');
    expect(sanitizeName('  report  final .docx ')).toBe('report final .docx');
    expect(sanitizeName('.hidden.txt')).toBe('hidden.txt');
    expect(sanitizeName('name.txt.')).toBe('name.txt');
    expect(sanitizeName('a\u0000b')).toBe('ab');
    expect(sanitizeName('...')).toBe('');
  });

  it('keeps Arabic names and their spaces intact', () => {
    expect(sanitizeName('تقرير الاجتماع.docx')).toBe('تقرير الاجتماع.docx');
  });

  it('splits a name into stem and extension, and only a REAL extension counts', () => {
    expect(extensionOfName('report.docx')).toBe('docx');
    expect(stemOfName('report.docx')).toBe('report');
    expect(extensionOfName('report')).toBe('');
    expect(stemOfName('.hidden')).toBe('.hidden');
    expect(stemOfName('a.b.c')).toBe('a.b');
  });
});

describe('save-as — the format decision', () => {
  it('reads the format out of a typed extension, case-insensitively', () => {
    expect(formatForName('a.PDF', FORMATS)?.value).toBe('pdf');
    expect(formatForName('a.docx', FORMATS)?.value).toBe('docx');
    expect(formatForName('a.unknown', FORMATS)).toBeNull();
    expect(formatForName('a', FORMATS)).toBeNull();
  });

  it('lets a typed extension win over the picker, and falls back to the picker otherwise', () => {
    expect(effectiveFormat('a.pdf', FORMATS[0], FORMATS)?.value).toBe('pdf');
    expect(effectiveFormat('a', FORMATS[1], FORMATS)?.value).toBe('pdf');
    expect(effectiveFormat('a', null, FORMATS)?.value).toBe('docx');
    expect(effectiveFormat('a', null, [])).toBeNull();
  });
});

describe('save-as — the target and its overwrite state', () => {
  const base = { dir: '/home/user/Documents', existing: [] as string[] };

  it('appends the picked extension when the name has none', () => {
    const plan = planTarget({ ...base, name: 'report', format: FORMATS[0] });
    expect(plan).toMatchObject({ ok: true, fileName: 'report.docx', path: '/home/user/Documents/report.docx', exists: false, backup: null });
  });

  it('keeps a typed extension instead of the picker', () => {
    const plan = planTarget({ ...base, name: 'report.pdf', format: FORMATS[0] });
    expect(plan).toMatchObject({ ok: true, fileName: 'report.pdf', ext: 'pdf' });
  });

  it('plans exactly one backup when the file is already there', () => {
    const plan = planTarget({ ...base, name: 'report', format: FORMATS[0], existing: ['report.docx', 'old.docx'] });
    expect(plan.ok && plan.exists).toBe(true);
    expect(plan.ok && plan.backup).toBe('/home/user/Documents/report.docx.bak');
    expect(plan.ok && plan.backup?.endsWith(BACKUP_SUFFIX)).toBe(true);
  });

  it('refuses a folder outside home, an empty name, a missing extension and a .bak target', () => {
    expect(planTarget({ dir: '/etc', name: 'a', format: FORMATS[0], existing: [] })).toEqual({ ok: false, error: 'out-of-home' });
    expect(planTarget({ ...base, name: '   ', format: FORMATS[0] })).toEqual({ ok: false, error: 'no-name' });
    expect(planTarget({ ...base, name: 'a.bak', format: FORMATS[0] })).toEqual({ ok: false, error: 'reserved-name' });
    expect(planTarget({ ...base, name: 'a', format: null })).toEqual({ ok: false, error: 'no-format' });
  });

  it('matches an existing file case-insensitively, so a rewrite is never silent', () => {
    const plan = planTarget({ ...base, name: 'REPORT', format: FORMATS[0], existing: ['report.docx'] });
    expect(plan.ok && plan.exists).toBe(true);
  });
});

describe('save-as — keeping both files', () => {
  it('suggests the first free name, inside the bracket, and never drops the extension', () => {
    expect(uniqueName('report.docx', [])).toBe('report.docx');
    expect(uniqueName('report.docx', ['report.docx'])).toBe('report (2).docx');
    expect(uniqueName('report.docx', ['report.docx', 'Report (2).docx'])).toBe('report (3).docx');
    expect(uniqueName('noext', ['noext'])).toBe('noext (2)');
  });
});

describe('save-as — folder listing and breadcrumbs', () => {
  it('never walks above home and keeps every segment', () => {
    expect(crumbTrail('/home/user')).toHaveLength(1);
    expect(crumbTrail('/home/user/Documents/Reports').map((c) => c.path)).toEqual([
      '/home/user', '/home/user/Documents', '/home/user/Documents/Reports',
    ]);
    // A path outside home is clamped to home instead of offering a folder that cannot be written.
    expect(crumbTrail('/etc').map((c) => c.path)).toEqual(['/home/user']);
    expect(crumbTrail('/home/user')[0].home).toBe(true);
  });

  it('lists folders only, sorted naturally and case-insensitively', () => {
    const entries = [
      stat('/home/user/a.txt', 'a.txt', 'file'),
      stat('/home/user/Report10', 'Report10', 'dir'),
      stat('/home/user/report2', 'report2', 'dir'),
      stat('/home/user/Zebra', 'Zebra', 'dir'),
    ];
    expect(childFolders(entries).map((e) => e.name)).toEqual(['report2', 'Report10', 'Zebra']);
  });

  it('compares bytes exactly, which is what the read-back before "saved" relies on', () => {
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

/* ──────────────────────────────── the dialog ──────────────────────────────── */

const open = (vfs: FakeVFS, overrides: Partial<Parameters<typeof saveAsDialog>[0]> = {}) =>
  saveAsDialog({
    vfs,
    host: host(),
    dir: '/home/user/Documents',
    name: 'report',
    formats: FORMATS,
    encode: async () => new TextEncoder().encode('hello'),
    ...overrides,
  });

describe('save-as — the dialog', () => {
  it('browses folders inside home, offers a new folder, and shows the target path', async () => {
    const vfs = new FakeVFS();
    const done = open(vfs);
    await flush();

    expect(document.querySelector('.faisal-saveas')).not.toBeNull();
    expect([...document.querySelectorAll('.faisal-saveas-folder')].map((b) => b.textContent)).toEqual(['Reports']);
    expect(document.querySelector('.faisal-saveas-target-path')?.textContent).toBe('/home/user/Documents/report.docx');
    expect(document.querySelector<HTMLInputElement>('.faisal-saveas-name')?.value).toBe('report');
    expect(document.querySelector<HTMLSelectElement>('.faisal-saveas-select')?.value).toBe('docx');
    // The dialog cannot leave home: no breadcrumb above it exists.
    expect([...document.querySelectorAll('.faisal-saveas-crumb')].map((b) => b.textContent)).toEqual(['Home', 'Documents']);

    // A new folder is created in the folder on screen, then it appears in the list.
    const input = document.querySelector<HTMLInputElement>('.faisal-saveas-newfolder input')!;
    input.value = 'Invoices';
    document.querySelector<HTMLButtonElement>('.faisal-saveas-newfolder button')!.click();
    await flush();
    expect(await vfs.exists('/home/user/Documents/Invoices')).toBe(true);
    expect([...document.querySelectorAll('.faisal-saveas-folder')].map((b) => b.textContent)).toEqual(['Invoices', 'Reports']);

    // Entering a folder updates the breadcrumb and the target path.
    [...document.querySelectorAll<HTMLButtonElement>('.faisal-saveas-folder')][1].click();
    await flush();
    expect(document.querySelector('.faisal-saveas-target-path')?.textContent).toBe('/home/user/Documents/Reports/report.docx');

    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    void done;
  });

  it('writes the file and reports saved with its path and byte count', async () => {
    const vfs = new FakeVFS();
    const done = open(vfs);
    await flush();
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    await flush();

    await expect(done).resolves.toEqual({
      status: 'saved', path: '/home/user/Documents/report.docx', backup: null, bytes: 5,
    });
    expect(vfs.text('/home/user/Documents/report.docx')).toBe('hello');
    // Nothing existed before, so there is nothing to back up — not even an empty .bak.
    expect(await vfs.exists('/home/user/Documents/report.docx.bak')).toBe(false);
    expect(document.querySelector('.faisal-saveas')).toBeNull();
  });

  it('asks before replacing and keeps EXACTLY one backup, however many times it is overwritten', async () => {
    const vfs = new FakeVFS({ '/home/user/Documents/report.docx': 'first' });
    let payload = 'second';
    const done = open(vfs, { encode: async () => new TextEncoder().encode(payload) });
    await flush();

    // The replace state is visible before anything is clicked.
    const note = document.querySelector('.faisal-saveas-replace');
    expect(note?.hasAttribute('hidden')).toBe(false);
    expect(note?.textContent).toContain('report.docx.bak');

    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    await flush();
    const buttons = confirmButtons();
    expect(buttons.map((b) => b.textContent)).toEqual([t('shell.saveas.cancel'), t('shell.saveas.replaceOk')]);
    buttons[1].click();
    await flush();

    await expect(done).resolves.toMatchObject({ status: 'saved', backup: '/home/user/Documents/report.docx.bak' });
    expect(vfs.text('/home/user/Documents/report.docx')).toBe('second');
    expect(vfs.text('/home/user/Documents/report.docx.bak')).toBe('first');
    // One backup file, and no `.bak.1` / `.bak.bak` chain was invented.
    expect([...vfs.nodes.keys()].filter((p) => p.includes('.bak'))).toEqual(['/home/user/Documents/report.docx.bak']);

    // A second save over the same file replaces the SAME backup rather than adding one.
    payload = 'third';
    const again = open(vfs, { encode: async () => new TextEncoder().encode(payload) });
    await flush();
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    await flush();
    confirmButtons()[1].click();
    await flush();
    await expect(again).resolves.toMatchObject({ status: 'saved' });
    expect(vfs.text('/home/user/Documents/report.docx')).toBe('third');
    expect(vfs.text('/home/user/Documents/report.docx.bak')).toBe('second');
    expect([...vfs.nodes.keys()].filter((p) => p.includes('.bak'))).toEqual(['/home/user/Documents/report.docx.bak']);
  });

  it('writes NOTHING when the replace question is answered with no', async () => {
    const vfs = new FakeVFS({ '/home/user/Documents/report.docx': 'original' });
    const done = open(vfs);
    await flush();
    const before = [...vfs.writes];

    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    await flush();
    confirmButtons()[0].click();                    // cancel on the shellConfirm
    await flush();

    expect(vfs.text('/home/user/Documents/report.docx')).toBe('original');
    expect(vfs.writes).toEqual(before);             // not one byte written, not even a backup
    expect(await vfs.exists('/home/user/Documents/report.docx.bak')).toBe(false);
    // The dialog stays open so the owner can pick another name.
    expect(document.querySelector('.faisal-saveas')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-plain')!.click();
    await expect(done).resolves.toEqual({ status: 'cancelled' });
  });

  it('writes nothing when the owner cancels or presses Escape, and gives focus back', async () => {
    const vfs = new FakeVFS();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const first = open(vfs);
    await flush();
    expect(document.activeElement).toBe(document.querySelector('.faisal-saveas-name'));
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-plain')!.click();
    await expect(first).resolves.toEqual({ status: 'cancelled' });
    expect(vfs.writes).toEqual([]);
    expect(document.activeElement).toBe(opener);

    const second = open(vfs);
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await expect(second).resolves.toEqual({ status: 'cancelled' });
    expect(vfs.writes).toEqual([]);
    expect(document.querySelector('.faisal-saveas')).toBeNull();
  });

  it('never shows "saved" when the read-back does not match', async () => {
    const vfs = new FakeVFS();
    // The write lands, but reading it back returns different bytes: the dialog must say so
    // rather than claim success (acceptance G10).
    const original = vfs.readFile.bind(vfs);
    let written = false;
    vi.spyOn(vfs, 'writeFile').mockImplementation(async (path, data) => {
      written = true;
      await FakeVFS.prototype.writeFile.call(vfs, path, data);
    });
    vi.spyOn(vfs, 'readFile').mockImplementation(async (path) => {
      if (written) return new TextEncoder().encode('different!');
      return original(path);
    });

    const done = open(vfs);
    await flush();
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    await flush();

    expect(document.querySelector('.faisal-saveas-status')?.textContent).toBe(t('shell.saveas.verifyFailed', { name: 'report.docx' }));
    expect(document.querySelector('.faisal-saveas')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-plain')!.click();
    await expect(done).resolves.toEqual({ status: 'cancelled' });
  });

  it('reports an encode failure without writing and without closing', async () => {
    const vfs = new FakeVFS();
    const done = open(vfs, { encode: async () => { throw new Error('encoder exploded'); } });
    await flush();
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    await flush();

    expect(vfs.writes).toEqual([]);
    expect(document.querySelector('.faisal-saveas-status')?.textContent).toContain('encoder exploded');
    expect(document.querySelector('.faisal-saveas')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-plain')!.click();
    await done;
  });

  it('keeps both files instead of replacing, from the state the replace line shows', async () => {
    const vfs = new FakeVFS({ '/home/user/Documents/report.docx': 'first' });
    const done = open(vfs);
    await flush();
    document.querySelector<HTMLButtonElement>('.faisal-saveas-replace button')!.click();
    await flush();

    expect(document.querySelector<HTMLInputElement>('.faisal-saveas-name')?.value).toBe('report (2)');
    expect(document.querySelector('.faisal-saveas-target-path')?.textContent).toBe('/home/user/Documents/report (2).docx');
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    await flush();

    await expect(done).resolves.toMatchObject({ status: 'saved', path: '/home/user/Documents/report (2).docx', backup: null });
    expect(vfs.text('/home/user/Documents/report.docx')).toBe('first');
    expect(vfs.text('/home/user/Documents/report (2).docx')).toBe('hello');
  });

  it('downloads to the device without writing to the file system', async () => {
    const vfs = new FakeVFS();
    const urls: string[] = [];
    const clicked: string[] = [];
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: (blob: Blob) => { urls.push(blob.type); return 'blob:test'; },
      revokeObjectURL: () => {},
    }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });

    const done = open(vfs);
    await flush();
    const download = [...document.querySelectorAll<HTMLButtonElement>('.faisal-saveas-actions button')]
      .find((b) => b.textContent === t('shell.saveas.download'))!;
    download.click();
    await flush();

    await expect(done).resolves.toMatchObject({ status: 'downloaded', path: 'report.docx', bytes: 5 });
    expect(clicked).toEqual(['report.docx']);
    expect(urls).toEqual([FORMATS[0].mime]);
    expect(vfs.writes).toEqual([]);
    expect(await vfs.exists('/home/user/Documents/report.docx')).toBe(false);
  });

  it('refuses a .bak name and an empty name without writing', async () => {
    const vfs = new FakeVFS();
    const done = open(vfs);
    await flush();
    const name = document.querySelector<HTMLInputElement>('.faisal-saveas-name')!;
    name.value = 'report.bak';
    name.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    await flush();
    expect(document.querySelector('.faisal-saveas-status')?.textContent).toBe(t('shell.saveas.reserved'));

    name.value = '  ';
    name.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    await flush();
    expect(document.querySelector('.faisal-saveas-status')?.textContent).toBe(t('shell.saveas.nameRequired'));
    expect(vfs.writes).toEqual([]);

    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-plain')!.click();
    await done;
  });

  it('reports a typed extension as the format it will encode with', async () => {
    const vfs = new FakeVFS();
    const seen: string[] = [];
    const done = open(vfs, { encode: async (target) => { seen.push(target.format); return new TextEncoder().encode('x'); } });
    await flush();
    const name = document.querySelector<HTMLInputElement>('.faisal-saveas-name')!;
    name.value = 'report.pdf';
    name.dispatchEvent(new Event('input'));
    await flush();
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-primary')!.click();
    await flush();

    expect(seen).toEqual(['pdf']);
    await expect(done).resolves.toMatchObject({ path: '/home/user/Documents/report.pdf' });
  });

  it('pins the overlay to the host window box instead of the scrolled content origin', () => {
    const box = document.createElement('div');
    document.body.append(box);
    const overlay = document.createElement('div');
    box.append(overlay);
    box.scrollTop = 40;
    box.scrollLeft = 8;
    const unpin = pinToHost(overlay, box);
    expect(overlay.style.top).toBe('40px');
    expect(overlay.style.left).toBe('8px');

    box.scrollTop = 100;
    box.dispatchEvent(new Event('scroll'));
    expect(overlay.style.top).toBe('100px');
    unpin();
    box.scrollTop = 200;
    box.dispatchEvent(new Event('scroll'));
    expect(overlay.style.top).toBe('100px');
  });

  it('falls back to the home folder when the requested one cannot be read', async () => {
    const vfs = new FakeVFS();
    const done = open(vfs, { dir: '/home/user/Gone' });
    await flush();
    expect(document.querySelector('.faisal-saveas-target-path')?.textContent).toBe('/home/user/report.docx');
    expect([...document.querySelectorAll('.faisal-saveas-crumb')].map((b) => b.textContent)).toEqual(['Home']);
    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-plain')!.click();
    await done;
  });

  it('lets an app render its own controls and re-render them when the format changes', async () => {
    const vfs = new FakeVFS();
    const states: string[] = [];
    const done = open(vfs, {
      extras: (node, api) => {
        const line = document.createElement('p');
        line.className = 'test-extra';
        node.append(line);
        api.onChange(() => { line.textContent = `${api.format()}:${api.name()}`; states.push(line.textContent); });
      },
    });
    await flush();
    expect(document.querySelector('.test-extra')?.textContent).toBe('docx:report');

    const select = document.querySelector<HTMLSelectElement>('.faisal-saveas-select')!;
    select.value = 'pdf';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(document.querySelector('.test-extra')?.textContent).toBe('pdf:report');

    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-plain')!.click();
    await done;
    expect(states).toContain('pdf:report');
  });

  it('labels every icon-only button and traps Tab inside the dialog', async () => {
    const vfs = new FakeVFS();
    const done = open(vfs);
    await flush();

    const iconButtons = [...document.querySelectorAll<HTMLButtonElement>('.faisal-saveas-iconbtn')];
    expect(iconButtons.length).toBeGreaterThanOrEqual(2);
    for (const b of iconButtons) {
      expect(b.getAttribute('aria-label')?.trim().length ?? 0).toBeGreaterThan(0);
      expect(b.title).toBe(b.getAttribute('aria-label'));
    }
    expect(document.querySelector('.faisal-saveas')?.getAttribute('role')).toBe('dialog');
    expect(document.querySelector('.faisal-saveas')?.getAttribute('aria-modal')).toBe('true');

    // Tab from the last control wraps to the first instead of leaving the dialog.
    const focusable = [...document.querySelectorAll<HTMLElement>(
      '.faisal-saveas button:not([disabled]), .faisal-saveas input, .faisal-saveas select',
    )];
    const last = focusable[focusable.length - 1];
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(focusable[0]);

    document.querySelector<HTMLButtonElement>('.faisal-saveas-btn.is-plain')!.click();
    await done;
  });
});
