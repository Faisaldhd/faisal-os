import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBus } from '../kernel/bus';
import { VFSError } from '../kernel/types';
import { createVFS } from './index';

function freshDbName() {
  // fake-indexeddb persists per-name across the process, so give each
  // "same db" test group its own name and delete it before reuse.
  return `faisal-vfs-test-${Math.random().toString(36).slice(2)}`;
}

/**
 * Clears the shared test database between tests. We deliberately avoid
 * indexedDB.deleteDatabase() here: it blocks until every open connection
 * to the database is closed, and createVFS() (by design) keeps its
 * connection open for the app's lifetime, so a delete would hang forever
 * with a previous test's connection still alive. Opening a connection and
 * clearing the store works around any open connections.
 */
async function wipeDefaultDb() {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('faisal-vfs', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('nodes')) db.createObjectStore('nodes', { keyPath: 'path' });
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('nodes')) { db.close(); resolve(); return; }
      const tx = db.transaction('nodes', 'readwrite');
      tx.objectStore('nodes').clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

describe('VFS', () => {
  beforeEach(async () => {
    await wipeDefaultDb();
  });

  it('seeds a Linux-like tree on first boot', async () => {
    const bus = createBus();
    const vfs = await createVFS(bus);

    expect(await vfs.exists('/bin')).toBe(true);
    expect(await vfs.exists('/etc')).toBe(true);
    expect(await vfs.exists('/home/user')).toBe(true);
    expect(await vfs.exists('/tmp')).toBe(true);
    expect(await vfs.exists('/usr')).toBe(true);
    expect(await vfs.exists('/var')).toBe(true);
    expect(await vfs.exists('/home/user/Documents')).toBe(true);
    expect(await vfs.exists('/home/user/Downloads')).toBe(true);
    expect(await vfs.exists('/home/user/Pictures')).toBe(true);
    expect(await vfs.exists('/home/user/Music')).toBe(true);
    expect(await vfs.exists('/home/user/Desktop')).toBe(true);

    const osRelease = await vfs.readText('/etc/os-release');
    expect(osRelease).toContain('NAME="Faisal OS"');
    expect(osRelease).toContain('ID=faisal');
    expect(osRelease).toContain('ID_LIKE=fedora');

    expect((await vfs.readText('/etc/hostname')).trim()).toBe('faisal');
    expect(await vfs.exists('/etc/motd')).toBe(true);

    const welcome = await vfs.readText('/home/user/Documents/welcome.txt');
    expect(welcome.length).toBeGreaterThan(0);
    expect(await vfs.exists('/home/user/Documents/readme.md')).toBe(true);

    const binStat = await vfs.stat('/bin');
    expect(binStat.mode).toBe(0o755);
  });

  it('does not reseed on a second boot against the same store', async () => {
    const bus = createBus();
    const vfs1 = await createVFS(bus);
    await vfs1.writeFile('/home/user/Documents/welcome.txt', 'مرحباً معدّل');

    const vfs2 = await createVFS(createBus());
    expect(await vfs2.readText('/home/user/Documents/welcome.txt')).toBe('مرحباً معدّل');
  });

  describe('basic operations', () => {
    it('stat/exists/readdir', async () => {
      const vfs = await createVFS(createBus());
      const st = await vfs.stat('/home/user');
      expect(st.type).toBe('dir');
      expect(st.name).toBe('user');

      expect(await vfs.exists('/nope')).toBe(false);

      const kids = await vfs.readdir('/home/user');
      expect(kids.map((k) => k.name).sort()).toEqual(
        ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures'].sort(),
      );
    });

    it('stat on missing path throws ENOENT', async () => {
      const vfs = await createVFS(createBus());
      await expect(vfs.stat('/nope')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('readdir on a file throws ENOTDIR', async () => {
      const vfs = await createVFS(createBus());
      await vfs.writeFile('/home/user/a.txt', 'hi');
      await expect(vfs.readdir('/home/user/a.txt')).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it('readFile on a dir throws EISDIR', async () => {
      const vfs = await createVFS(createBus());
      await expect(vfs.readFile('/home/user')).rejects.toMatchObject({ code: 'EISDIR' });
    });

    it('writeFile requires an existing parent (ENOENT)', async () => {
      const vfs = await createVFS(createBus());
      await expect(vfs.writeFile('/home/user/nope/file.txt', 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('writeFile creates then modifies, emitting fs:change', async () => {
      const bus = createBus();
      const vfs = await createVFS(bus);
      const events: string[] = [];
      bus.on('fs:change', (e) => events.push(e.kind));

      await vfs.writeFile('/home/user/a.txt', 'one');
      expect(await vfs.readText('/home/user/a.txt')).toBe('one');
      await vfs.writeFile('/home/user/a.txt', 'two');
      expect(await vfs.readText('/home/user/a.txt')).toBe('two');

      expect(events).toContain('create');
      expect(events).toContain('modify');
    });

    it('writeFile accepts Uint8Array data', async () => {
      const vfs = await createVFS(createBus());
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await vfs.writeFile('/home/user/bin.dat', bytes);
      const read = await vfs.readFile('/home/user/bin.dat');
      expect([...read]).toEqual([1, 2, 3, 4]);
    });
  });

  describe('mkdir', () => {
    it('creates a directory; EEXIST if it already exists (non-recursive)', async () => {
      const vfs = await createVFS(createBus());
      await vfs.mkdir('/home/user/newdir');
      expect((await vfs.stat('/home/user/newdir')).type).toBe('dir');
      await expect(vfs.mkdir('/home/user/newdir')).rejects.toMatchObject({ code: 'EEXIST' });
    });

    it('non-recursive mkdir with missing parent throws ENOENT', async () => {
      const vfs = await createVFS(createBus());
      await expect(vfs.mkdir('/home/user/a/b')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('recursive mkdir creates intermediate directories', async () => {
      const vfs = await createVFS(createBus());
      await vfs.mkdir('/home/user/a/b/c', { recursive: true });
      expect((await vfs.stat('/home/user/a')).type).toBe('dir');
      expect((await vfs.stat('/home/user/a/b')).type).toBe('dir');
      expect((await vfs.stat('/home/user/a/b/c')).type).toBe('dir');
    });

    it('recursive mkdir on an existing dir is a no-op', async () => {
      const vfs = await createVFS(createBus());
      await vfs.mkdir('/home/user/a', { recursive: true });
      await expect(vfs.mkdir('/home/user/a', { recursive: true })).resolves.toBeUndefined();
    });

    it('mkdir over an existing file throws ENOTDIR (recursive)', async () => {
      const vfs = await createVFS(createBus());
      await vfs.writeFile('/home/user/a', 'x');
      await expect(vfs.mkdir('/home/user/a', { recursive: true })).rejects.toMatchObject({ code: 'ENOTDIR' });
    });
  });

  describe('remove', () => {
    it('removes a file', async () => {
      const vfs = await createVFS(createBus());
      await vfs.writeFile('/home/user/a.txt', 'x');
      await vfs.remove('/home/user/a.txt');
      expect(await vfs.exists('/home/user/a.txt')).toBe(false);
    });

    it('removing a missing path throws ENOENT', async () => {
      const vfs = await createVFS(createBus());
      await expect(vfs.remove('/home/user/nope')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('non-recursive remove of a non-empty dir throws ENOTEMPTY', async () => {
      const vfs = await createVFS(createBus());
      await vfs.mkdir('/home/user/d');
      await vfs.writeFile('/home/user/d/a.txt', 'x');
      await expect(vfs.remove('/home/user/d')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    });

    it('non-recursive remove of an empty dir succeeds', async () => {
      const vfs = await createVFS(createBus());
      await vfs.mkdir('/home/user/empty');
      await vfs.remove('/home/user/empty');
      expect(await vfs.exists('/home/user/empty')).toBe(false);
    });

    it('recursive remove deletes a whole subtree', async () => {
      const vfs = await createVFS(createBus());
      await vfs.mkdir('/home/user/d/e', { recursive: true });
      await vfs.writeFile('/home/user/d/a.txt', 'x');
      await vfs.writeFile('/home/user/d/e/b.txt', 'y');
      await vfs.remove('/home/user/d', { recursive: true });
      expect(await vfs.exists('/home/user/d')).toBe(false);
      expect(await vfs.exists('/home/user/d/a.txt')).toBe(false);
      expect(await vfs.exists('/home/user/d/e/b.txt')).toBe(false);
    });

    it('removing root throws EINVAL', async () => {
      const vfs = await createVFS(createBus());
      await expect(vfs.remove('/')).rejects.toMatchObject({ code: 'EINVAL' });
    });
  });

  describe('rename', () => {
    it('renames a file', async () => {
      const vfs = await createVFS(createBus());
      await vfs.writeFile('/home/user/a.txt', 'hi');
      await vfs.rename('/home/user/a.txt', '/home/user/b.txt');
      expect(await vfs.exists('/home/user/a.txt')).toBe(false);
      expect(await vfs.readText('/home/user/b.txt')).toBe('hi');
    });

    it('emits fs:change with kind rename and oldPath', async () => {
      const bus = createBus();
      const vfs = await createVFS(bus);
      await vfs.writeFile('/home/user/a.txt', 'hi');
      let seen: any = null;
      bus.on('fs:change', (e) => { if (e.kind === 'rename') seen = e; });
      await vfs.rename('/home/user/a.txt', '/home/user/b.txt');
      expect(seen).toMatchObject({ path: '/home/user/b.txt', oldPath: '/home/user/a.txt', kind: 'rename' });
    });

    it('moves a whole subtree and updates all descendants', async () => {
      const vfs = await createVFS(createBus());
      await vfs.mkdir('/home/user/src/inner', { recursive: true });
      await vfs.writeFile('/home/user/src/a.txt', 'A');
      await vfs.writeFile('/home/user/src/inner/b.txt', 'B');

      await vfs.rename('/home/user/src', '/home/user/dst');

      expect(await vfs.exists('/home/user/src')).toBe(false);
      expect(await vfs.exists('/home/user/src/a.txt')).toBe(false);
      expect(await vfs.exists('/home/user/src/inner/b.txt')).toBe(false);

      expect((await vfs.stat('/home/user/dst')).type).toBe('dir');
      expect(await vfs.readText('/home/user/dst/a.txt')).toBe('A');
      expect(await vfs.readText('/home/user/dst/inner/b.txt')).toBe('B');
    });

    it('renaming a dir into itself throws EINVAL', async () => {
      const vfs = await createVFS(createBus());
      await vfs.mkdir('/home/user/d');
      await expect(vfs.rename('/home/user/d', '/home/user/d')).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(vfs.rename('/home/user/d', '/home/user/d/sub')).rejects.toMatchObject({ code: 'EINVAL' });
    });

    it('renaming root throws EINVAL', async () => {
      const vfs = await createVFS(createBus());
      await expect(vfs.rename('/', '/home/user/x')).rejects.toMatchObject({ code: 'EINVAL' });
    });

    it('rename over an existing file replaces it', async () => {
      const vfs = await createVFS(createBus());
      await vfs.writeFile('/home/user/a.txt', 'A');
      await vfs.writeFile('/home/user/b.txt', 'B');
      await vfs.rename('/home/user/a.txt', '/home/user/b.txt');
      expect(await vfs.exists('/home/user/a.txt')).toBe(false);
      expect(await vfs.readText('/home/user/b.txt')).toBe('A');
    });

    it('renaming a dir onto an existing non-empty dir throws ENOTEMPTY', async () => {
      const vfs = await createVFS(createBus());
      await vfs.mkdir('/home/user/d1');
      await vfs.mkdir('/home/user/d2');
      await vfs.writeFile('/home/user/d2/x.txt', 'x');
      await expect(vfs.rename('/home/user/d1', '/home/user/d2')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    });

    it('renaming a dir onto an existing file throws ENOTDIR', async () => {
      const vfs = await createVFS(createBus());
      await vfs.mkdir('/home/user/d1');
      await vfs.writeFile('/home/user/f.txt', 'x');
      await expect(vfs.rename('/home/user/d1', '/home/user/f.txt')).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it('renaming a file onto an existing dir throws EISDIR', async () => {
      const vfs = await createVFS(createBus());
      await vfs.writeFile('/home/user/f.txt', 'x');
      await vfs.mkdir('/home/user/d1');
      await expect(vfs.rename('/home/user/f.txt', '/home/user/d1')).rejects.toMatchObject({ code: 'EISDIR' });
    });
  });

  describe('chmod', () => {
    it('updates mode', async () => {
      const vfs = await createVFS(createBus());
      await vfs.writeFile('/home/user/a.txt', 'x');
      await vfs.chmod('/home/user/a.txt', 0o600);
      expect((await vfs.stat('/home/user/a.txt')).mode).toBe(0o600);
    });
  });

  describe('quota', () => {
    it('rejects a single file larger than the per-file cap', async () => {
      const vfs = await createVFS(createBus());
      const big = new Uint8Array(20 * 1024 * 1024 + 1);
      await expect(vfs.writeFile('/home/user/big.bin', big)).rejects.toMatchObject({ code: 'EINVAL' });
    });

    it('rejects writes that would exceed the total quota', async () => {
      const vfs = await createVFS(createBus());
      const chunk = new Uint8Array(18 * 1024 * 1024); // under the per-file cap
      await vfs.writeFile('/home/user/c1.bin', chunk);
      await vfs.writeFile('/home/user/c2.bin', chunk); // 36 MB so far
      await expect(vfs.writeFile('/home/user/c3.bin', chunk)).rejects.toMatchObject({ code: 'EINVAL' }); // would hit 54 MB
    });
  });

  describe('persistence', () => {
    it('persists writes across two createVFS() calls on the same store', async () => {
      const vfs1 = await createVFS(createBus());
      await vfs1.mkdir('/home/user/persisted-dir');
      await vfs1.writeFile('/home/user/persisted-dir/note.txt', 'persist me');

      const vfs2 = await createVFS(createBus());
      expect(await vfs2.exists('/home/user/persisted-dir')).toBe(true);
      expect(await vfs2.readText('/home/user/persisted-dir/note.txt')).toBe('persist me');
    });

    it('persists deletes and renames across reloads', async () => {
      const vfs1 = await createVFS(createBus());
      await vfs1.writeFile('/home/user/to-delete.txt', 'x');
      await vfs1.writeFile('/home/user/to-rename.txt', 'y');
      await vfs1.remove('/home/user/to-delete.txt');
      await vfs1.rename('/home/user/to-rename.txt', '/home/user/renamed.txt');

      const vfs2 = await createVFS(createBus());
      expect(await vfs2.exists('/home/user/to-delete.txt')).toBe(false);
      expect(await vfs2.exists('/home/user/to-rename.txt')).toBe(false);
      expect(await vfs2.readText('/home/user/renamed.txt')).toBe('y');
    });
  });

  describe('fallback without IndexedDB', () => {
    it('still works fully when indexedDB is unavailable', async () => {
      const original = (globalThis as any).indexedDB;
      delete (globalThis as any).indexedDB;
      try {
        const bus = createBus();
        const vfs = await createVFS(bus);
        expect(await vfs.exists('/home/user')).toBe(true);
        await vfs.writeFile('/home/user/mem.txt', 'in memory');
        expect(await vfs.readText('/home/user/mem.txt')).toBe('in memory');
        await vfs.mkdir('/home/user/memdir');
        await vfs.rename('/home/user/mem.txt', '/home/user/mem2.txt');
        expect(await vfs.readText('/home/user/mem2.txt')).toBe('in memory');
        await vfs.remove('/home/user/memdir');
      } finally {
        (globalThis as any).indexedDB = original;
      }
    });
  });

  it('exposes VFSError instances with code/path', async () => {
    const vfs = await createVFS(createBus());
    try {
      await vfs.stat('/nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VFSError);
      expect((err as VFSError).code).toBe('ENOENT');
      expect((err as VFSError).path).toBe('/nope');
    }
  });
});
