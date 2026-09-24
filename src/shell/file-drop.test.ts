import { describe, it, expect } from 'vitest';
import { createBus } from '../kernel/bus';
import { createVFS } from '../vfs';
import type { VFS } from '../kernel/types';
import { collectFiles, dropPlace, safeSegment, saveDropped, isExternalFileDrag } from './file-drop';

async function memVFS(): Promise<VFS> {
  const g = globalThis as { indexedDB?: unknown };
  const saved = g.indexedDB;
  delete g.indexedDB; // force the in-memory backend
  try { return await createVFS(createBus()); } finally { if (saved) g.indexedDB = saved; }
}

const file = (name: string, text: string) => {
  const f = new File([text], name);
  // jsdom's File has no arrayBuffer(); the browser's does.
  if (typeof f.arrayBuffer !== 'function') {
    Object.defineProperty(f, 'arrayBuffer', { value: async () => new TextEncoder().encode(text).buffer });
  }
  return f;
};
const read = async (vfs: VFS, p: string) => new TextDecoder().decode(await vfs.readFile(p));

/* Minimal FileSystemEntry fakes, shaped like Chrome's webkitGetAsEntry() results. */
function fileEntry(name: string, text: string): FileSystemEntry {
  return { name, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(file(name, text)) } as unknown as FileSystemEntry;
}
function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    name, isFile: false, isDirectory: true,
    createReader: () => {
      let done = false; // one batch, then the empty batch that ends the listing
      return { readEntries: (ok: (e: FileSystemEntry[]) => void) => { ok(done ? [] : children); done = true; } };
    },
  } as unknown as FileSystemEntry;
}

describe('safeSegment', () => {
  it('keeps names inside one folder', () => {
    expect(safeSegment('تقرير.pdf')).toBe('تقرير.pdf');
    expect(safeSegment('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeSegment('..')).toBe('file');
    expect(safeSegment('  ')).toBe('file');
  });
});

describe('isExternalFileDrag', () => {
  it('is true only for drags that carry files', () => {
    expect(isExternalFileDrag({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
    expect(isExternalFileDrag({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
    expect(isExternalFileDrag(null)).toBe(false);
  });
});

describe('collectFiles + saveDropped', () => {
  it('saves plain files and never overwrites an existing name', async () => {
    const vfs = await memVFS();
    const dir = '/home/user/Desktop';
    await vfs.mkdir(dir, { recursive: true });
    await vfs.writeFile(`${dir}/a.txt`, 'old');
    const drop = await collectFiles({ files: [file('a.txt', 'new'), file('b.csv', 'x,y')], entries: [] });
    const r = await saveDropped(vfs, dir, drop, 'copy');
    expect(r.saved).toEqual([`${dir}/a (copy).txt`, `${dir}/b.csv`]);
    expect(r.failed).toBe(0);
    expect(await read(vfs, `${dir}/a.txt`)).toBe('old');
    expect(await read(vfs, `${dir}/a (copy).txt`)).toBe('new');
  });

  it('walks dropped folders, keeping their structure and empty subfolders', async () => {
    const vfs = await memVFS();
    const dir = '/home/user/Documents';
    const drop = await collectFiles({
      files: [],
      entries: [
        dirEntry('مشروع', [fileEntry('readme.md', '# hi'), dirEntry('src', [fileEntry('main.ts', 'x')]), dirEntry('empty', [])]),
        fileEntry('solo.txt', 'solo'),
      ],
    });
    const r = await saveDropped(vfs, dir, drop, 'copy');
    expect(r.saved).toEqual([`${dir}/مشروع`, `${dir}/solo.txt`]);
    expect(await read(vfs, `${dir}/مشروع/readme.md`)).toBe('# hi');
    expect(await read(vfs, `${dir}/مشروع/src/main.ts`)).toBe('x');
    expect((await vfs.stat(`${dir}/مشروع/empty`)).type).toBe('dir');
    expect(r.files).toHaveLength(3);
  });

  it('renames a dropped folder whose name is taken, and moves its contents with it', async () => {
    const vfs = await memVFS();
    const dir = '/home/user/Desktop';
    await vfs.mkdir(`${dir}/pics`, { recursive: true });
    const drop = await collectFiles({ files: [], entries: [dirEntry('pics', [fileEntry('1.png', 'p')])] });
    const r = await saveDropped(vfs, dir, drop, 'copy');
    expect(r.saved).toEqual([`${dir}/pics (copy)`]);
    expect(await read(vfs, `${dir}/pics (copy)/1.png`)).toBe('p');
  });

  it('counts files the VFS refuses (quota) without stopping the rest', async () => {
    const vfs = await memVFS();
    const big = file('big.bin', '');
    Object.defineProperty(big, 'arrayBuffer', { value: async () => new ArrayBuffer(21 * 1024 * 1024) });
    const r = await saveDropped(vfs, '/home/user', await collectFiles({ files: [big, file('ok.txt', 'ok')], entries: [] }), 'copy');
    expect(r.failed).toBe(1);
    expect(r.files).toEqual(['/home/user/ok.txt']);
  });
});

describe('dropPlace', () => {
  const dom = (html: string) => { document.body.innerHTML = html; };

  it('reads desktop tiles, windows and the Files view', () => {
    dom(`<div class="faisal-desktop-surface">
      <div class="faisal-desktop-icon" data-path="/home/user/Desktop/Work"><span id="f">x</span></div>
      <div class="faisal-desktop-icon" data-app-id="org.faisal.Editor"><span id="a">x</span></div>
      <div class="faisal-window" id="w1"><div id="in">x</div></div>
      <div class="faisal-window"><div class="faisal-files"><span id="files">x</span></div></div>
      <span id="bg">x</span></div>`);
    const at = (id: string) => dropPlace(document.getElementById(id));
    expect(at('f')).toEqual({ kind: 'desktopPath', path: '/home/user/Desktop/Work' });
    expect(at('a')).toEqual({ kind: 'desktopApp', appId: 'org.faisal.Editor' });
    expect(at('in')).toEqual({ kind: 'window', windowEl: document.getElementById('w1') });
    expect(at('files')).toEqual({ kind: 'ignore' });
    expect(at('bg')).toEqual({ kind: 'desktop' });
    expect(dropPlace(null)).toEqual({ kind: 'desktop' });
  });
});
