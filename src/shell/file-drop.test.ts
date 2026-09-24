import { describe, it, expect } from 'vitest';
import { createBus } from '../kernel/bus';
import { createVFS } from '../vfs';
import type { VFS } from '../kernel/types';
import {
  collectFiles, dragPaths, dropDirFor, dropPlace, dropTargetLabel, isExternalFileDrag,
  isInternalDrag, safeSegment, saveDropped, transferEntry,
} from './file-drop';

async function memVFS(opts?: { quota?: { file: number; total: number } }): Promise<VFS> {
  const g = globalThis as { indexedDB?: unknown };
  const saved = g.indexedDB;
  delete g.indexedDB; // force the in-memory backend
  try { return await createVFS(createBus(), opts); } finally { if (saved) g.indexedDB = saved; }
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
    const vfs = await memVFS({ quota: { file: 4096, total: 1024 * 1024 } });
    const big = file('big.bin', '');
    Object.defineProperty(big, 'arrayBuffer', { value: async () => new ArrayBuffer(4097) });
    const r = await saveDropped(vfs, '/home/user', await collectFiles({ files: [big, file('ok.txt', 'ok')], entries: [] }), 'copy');
    expect(r.failed).toBe(1);
    expect(r.files).toEqual(['/home/user/ok.txt']);
  });

  it('refuses an over-large file by its reported size, without reading it into memory', async () => {
    const vfs = await memVFS();
    let read = false;
    const huge = {
      name: 'huge.bin',
      size: vfs.quota.file + 1,
      arrayBuffer: async () => { read = true; return new ArrayBuffer(0); },
    } as unknown as File;
    const r = await saveDropped(vfs, '/home/user', { files: [{ segments: ['huge.bin'], file: huge }], dirs: [] }, 'copy');
    expect(r.failed).toBe(1);
    expect(read).toBe(false); // the point: nothing is allocated for a file that cannot be kept
    expect(r.files).toEqual([]);
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

describe('internal drag & drop (inside the OS)', () => {
  const PATHS = 'text/x-faisal-path';
  const dt = (types: string[], data: Record<string, string>) =>
    ({ types, getData: (format: string) => data[format] ?? '' } as unknown as DataTransfer);

  it('recognises an internal drag and reads its paths out', () => {
    const drag = dt([PATHS, 'text/plain'], { [PATHS]: '/home/user/a.txt\n/home/user/b.txt' });
    expect(isInternalDrag(drag)).toBe(true);
    expect(isExternalFileDrag(drag)).toBe(false);
    expect(dragPaths(drag)).toEqual(['/home/user/a.txt', '/home/user/b.txt']);

    expect(isInternalDrag(dt(['Files'], {}))).toBe(false);
    expect(isInternalDrag(null)).toBe(false);
  });

  it('lands on the desktop itself and on a folder icon, and nowhere else', () => {
    expect(dropDirFor({ kind: 'desktop' }, '/home/user/Desktop')).toBe('/home/user/Desktop');
    expect(dropDirFor({ kind: 'desktopPath', path: '/home/user/Pictures' }, '/home/user/Desktop'))
      .toBe('/home/user/Pictures');
    expect(dropDirFor({ kind: 'desktopApp', appId: 'org.faisal.Files' }, '/home/user/Desktop')).toBeNull();
    expect(dropDirFor({ kind: 'window', windowEl: document.createElement('div') }, '/home/user/Desktop')).toBeNull();
    expect(dropDirFor({ kind: 'ignore' }, '/home/user/Desktop')).toBeNull();
  });

  it('copies without touching the original, and a taken name gets the copy suffix', async () => {
    const vfs = await memVFS();
    await vfs.mkdir('/home/user/Desktop', { recursive: true });
    await vfs.mkdir('/home/user/Documents', { recursive: true });
    await vfs.writeFile('/home/user/Documents/a.txt', 'hello');
    await vfs.writeFile('/home/user/Desktop/a.txt', 'older');

    const r = await transferEntry(vfs, '/home/user/Documents/a.txt', '/home/user/Desktop', 'copy', 'copy');
    expect(r).toEqual({ ok: true, dest: '/home/user/Desktop/a (copy).txt' });
    expect(await read(vfs, '/home/user/Documents/a.txt')).toBe('hello'); // the original stays
    expect(await read(vfs, '/home/user/Desktop/a.txt')).toBe('older'); // and nothing was overwritten
    expect(await read(vfs, '/home/user/Desktop/a (copy).txt')).toBe('hello');
  });

  it('copies a whole folder tree, and moves only when move was chosen', async () => {
    const vfs = await memVFS();
    await vfs.mkdir('/home/user/Documents/Work', { recursive: true });
    await vfs.writeFile('/home/user/Documents/Work/note.txt', 'x');
    await vfs.mkdir('/home/user/Desktop', { recursive: true });

    const copied = await transferEntry(vfs, '/home/user/Documents/Work', '/home/user/Desktop', 'copy', 'copy');
    expect(copied.ok).toBe(true);
    expect(await read(vfs, '/home/user/Desktop/Work/note.txt')).toBe('x');
    expect(await vfs.exists('/home/user/Documents/Work')).toBe(true);

    const moved = await transferEntry(vfs, '/home/user/Documents/Work', '/home/user/Desktop', 'move', 'copy');
    expect(moved.ok).toBe(true);
    expect(await vfs.exists('/home/user/Documents/Work')).toBe(false);
    expect(await read(vfs, '/home/user/Desktop/Work (copy)/note.txt')).toBe('x');
  });

  it('refuses the no-op and unsafe destinations in both modes', async () => {
    const vfs = await memVFS();
    await vfs.mkdir('/home/user/Documents/Sub', { recursive: true });
    await vfs.writeFile('/home/user/Documents/a.txt', 'x');

    for (const mode of ['copy', 'move'] as const) {
      expect(await transferEntry(vfs, '/home/user/Documents/a.txt', '/home/user/Documents', mode, 'copy'))
        .toEqual({ ok: false, reason: 'sameParent' });
      expect(await transferEntry(vfs, '/home/user/Documents', '/home/user/Documents/Sub', mode, 'copy'))
        .toEqual({ ok: false, reason: 'subtree' });
      expect(await transferEntry(vfs, '/home/user/Documents/a.txt', '/home/user/Nope', mode, 'copy'))
        .toEqual({ ok: false, reason: 'missingTarget' });
    }
    expect(await vfs.exists('/home/user/Documents/a.txt')).toBe(true);
  });
});

describe('dropTargetLabel', () => {
  it('names a folder tile and a window by what they show', () => {
    document.body.innerHTML = `<div class="faisal-desktop-icon" id="tile">
        <span class="faisal-desktop-icon-label">مشروعي</span></div>
      <div class="faisal-window" id="win">
        <span class="faisal-titlebar-title">الملفات</span></div>`;
    const tile = document.getElementById('tile')!;
    const win = document.getElementById('win')!;
    expect(dropTargetLabel(tile, 'هنا')).toBe('مشروعي');
    expect(dropTargetLabel(win, 'هنا')).toBe('الملفات');
  });

  it('falls back when there is no label, or when it is blank', () => {
    expect(dropTargetLabel(null, 'هنا')).toBe('هنا');
    document.body.innerHTML = '<div class="faisal-desktop-icon" id="tile"><span class="faisal-desktop-icon-label">   </span></div>';
    expect(dropTargetLabel(document.getElementById('tile')!, 'هنا')).toBe('هنا');
  });
});
