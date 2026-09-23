import type { EventBus, Stat, VFS } from '../kernel/types';
import { VFSError } from '../kernel/types';
import { defineStrings, t } from '../kernel/i18n';
import { OS_VERSION } from '../kernel/version';
import { basename, dirname, normalize } from '../kernel/path';
import { createStorageBackend, type StorageBackend, type StoredNode } from './storage';

defineStrings('vfs', {
  ar: {
    'volatile.title': 'التخزين غير دائم',
    'volatile.body': 'تعذّر فتح تخزين المتصفح، لذا لن تُحفظ الملفات بعد إعادة تحميل الصفحة.',
    'error.title': 'خطأ في التخزين',
    'error.body': 'قد لا تُحفظ التغييرات بعد إعادة تحميل الصفحة.',
  },
  en: {
    'volatile.title': 'Storage is not persistent',
    'volatile.body': 'Browser storage could not be opened, so files will be lost when the page reloads.',
    'error.title': 'Storage error',
    'error.body': 'Changes may not be saved after a reload.',
  },
});

const TOTAL_QUOTA = 50 * 1024 * 1024; // 50 MB
const FILE_QUOTA = 20 * 1024 * 1024; // 20 MB per file

interface Node {
  stat: Stat;
  data?: Uint8Array;
}

function toStat(n: Node): Stat {
  return { ...n.stat };
}

/**
 * Persistent, IndexedDB-backed VFS with an in-memory index for fast reads.
 * Falls back to an in-memory-only backend when IndexedDB is unavailable.
 */
export async function createVFS(bus: EventBus): Promise<VFS> {
  const backend: StorageBackend = await createStorageBackend();
  const nodes = new Map<string, Node>();

  // The shell is mounted after the VFS is created, so wait for it before telling the
  // user that nothing they save will survive a reload.
  if (!backend.persistent) {
    const off = bus.on('system:ready', () => {
      off();
      bus.emit('notify', { title: t('vfs.volatile.title'), body: t('vfs.volatile.body') });
    });
  }

  const stored = await backend.loadAll();
  for (const s of stored) {
    nodes.set(s.path, {
      stat: { path: s.path, name: s.name, type: s.type, size: s.size, mode: s.mode, mtime: s.mtime, ctime: s.ctime },
      data: s.data,
    });
  }

  const totalSize = () => {
    let sum = 0;
    for (const n of nodes.values()) if (n.stat.type === 'file') sum += n.stat.size;
    return sum;
  };

  const toStored = (n: Node): StoredNode => ({ ...n.stat, data: n.data });

  // Persistence runs in the background; failures must never be silent (data would be lost on reload).
  let warned = false;
  const onPersistError = (err: unknown) => {
    console.error('[vfs] persistence failed', err);
    if (!warned) {
      warned = true;
      bus.emit('notify', { title: t('vfs.error.title'), body: t('vfs.error.body') });
    }
  };
  const persistNode = (n: Node) => { backend.put(toStored(n)).catch(onPersistError); };
  const persistDelete = (path: string) => { backend.delete(path).catch(onPersistError); };
  const persistDeleteMany = (paths: string[]) => { backend.deleteMany(paths).catch(onPersistError); };
  const persistMany = (ns: Node[]) => { backend.putMany(ns.map(toStored)).catch(onPersistError); };

  const mkNode = (path: string, type: 'file' | 'dir', opts: { data?: Uint8Array; mode?: number; ctime?: number } = {}): Node => {
    const now = Date.now();
    const existing = nodes.get(path);
    const ctime = opts.ctime ?? existing?.stat.ctime ?? now;
    const node: Node = {
      stat: {
        path,
        name: basename(path),
        type,
        size: opts.data?.length ?? 0,
        mode: opts.mode ?? existing?.stat.mode ?? (type === 'dir' ? 0o755 : 0o644),
        mtime: now,
        ctime,
      },
      data: opts.data,
    };
    nodes.set(path, node);
    return node;
  };

  const get = (p: string): Node => {
    const path = normalize(p);
    const n = nodes.get(path);
    if (!n) throw new VFSError('ENOENT', path);
    return n;
  };

  const getDir = (p: string): Node => {
    const n = get(p);
    if (n.stat.type !== 'dir') throw new VFSError('ENOTDIR', p);
    return n;
  };

  const children = (dir: string): Node[] =>
    [...nodes.values()].filter((n) => n.stat.path !== dir && dirname(n.stat.path) === dir);

  const descendants = (dir: string): Node[] => {
    const prefix = dir === '/' ? '/' : dir + '/';
    return [...nodes.values()].filter((n) => n.stat.path !== dir && n.stat.path.startsWith(prefix));
  };

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const vfs: VFS = {
    async stat(p) {
      return toStat(get(p));
    },

    async exists(p) {
      return nodes.has(normalize(p));
    },

    async readdir(p) {
      const dir = normalize(p);
      getDir(dir);
      return children(dir).map(toStat);
    },

    async readFile(p) {
      const n = get(p);
      if (n.stat.type === 'dir') throw new VFSError('EISDIR', p);
      return n.data ? new Uint8Array(n.data) : new Uint8Array(0);
    },

    async readText(p) {
      const data = await vfs.readFile(p);
      return dec.decode(data);
    },

    async writeFile(p, data) {
      const path = normalize(p);
      if (path === '/') throw new VFSError('EISDIR', path);
      const parent = dirname(path);
      getDir(parent);
      const existing = nodes.get(path);
      if (existing && existing.stat.type === 'dir') throw new VFSError('EISDIR', path);

      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      if (bytes.length > FILE_QUOTA) throw new VFSError('EINVAL', path, 'quota');
      const prevSize = existing?.stat.size ?? 0;
      const projected = totalSize() - prevSize + bytes.length;
      if (projected > TOTAL_QUOTA) throw new VFSError('EINVAL', path, 'quota');

      const node = mkNode(path, 'file', { data: bytes });
      persistNode(node);
      bus.emit('fs:change', { path, kind: existing ? 'modify' : 'create' });
    },

    async mkdir(p, opts) {
      const path = normalize(p);
      if (path === '/') {
        if (!nodes.has('/')) { const n = mkNode('/', 'dir'); persistNode(n); }
        return;
      }
      const existing = nodes.get(path);
      if (existing) {
        if (!opts?.recursive) throw new VFSError('EEXIST', path);
        if (existing.stat.type !== 'dir') throw new VFSError('ENOTDIR', path);
        return;
      }
      const parent = dirname(path);
      if (!nodes.has(parent)) {
        if (!opts?.recursive) throw new VFSError('ENOENT', path);
        await vfs.mkdir(parent, { recursive: true });
      } else {
        getDir(parent);
      }
      const node = mkNode(path, 'dir');
      persistNode(node);
      bus.emit('fs:change', { path, kind: 'create' });
    },

    async remove(p, opts) {
      const path = normalize(p);
      if (path === '/') throw new VFSError('EINVAL', path, 'cannot remove root');
      const n = get(path);
      if (n.stat.type === 'dir') {
        const kids = children(path);
        if (kids.length > 0 && !opts?.recursive) throw new VFSError('ENOTEMPTY', path);
        const all = descendants(path);
        const paths = [path, ...all.map((d) => d.stat.path)];
        for (const pp of paths) nodes.delete(pp);
        persistDeleteMany(paths);
      } else {
        nodes.delete(path);
        persistDelete(path);
      }
      bus.emit('fs:change', { path, kind: 'delete' });
    },

    async rename(from, to) {
      const src = normalize(from);
      const dst = normalize(to);
      // Refused rather than silently treated as a no-op: the replace path would delete the
      // record while keeping the node, so the file would vanish on the next reload.
      if (src === dst) throw new VFSError('EINVAL', dst, 'cannot rename a path onto itself');
      if (src === '/') throw new VFSError('EINVAL', src, 'cannot rename root');
      const n = get(src);

      if (n.stat.type === 'dir' && (dst === src || dst.startsWith(src + '/'))) {
        throw new VFSError('EINVAL', dst, 'cannot rename a directory into itself');
      }

      const dstParent = dirname(dst);
      getDir(dstParent);

      const existingDst = nodes.get(dst);
      if (existingDst) {
        if (existingDst.stat.type === 'dir') {
          if (n.stat.type !== 'dir') throw new VFSError('EISDIR', dst);
          const kids = children(dst);
          if (kids.length > 0) throw new VFSError('ENOTEMPTY', dst);
        } else if (n.stat.type === 'dir') {
          throw new VFSError('ENOTDIR', dst);
        }
        // replace existing file (or empty dir) at dst
        const removedPaths = existingDst.stat.type === 'dir'
          ? [dst, ...descendants(dst).map((d) => d.stat.path)]
          : [dst];
        for (const pp of removedPaths) nodes.delete(pp);
        persistDeleteMany(removedPaths);
      }

      if (n.stat.type === 'dir') {
        const subtree = descendants(src);
        const toPersist: Node[] = [];
        const oldPaths = [src, ...subtree.map((d) => d.stat.path)];

        // move the directory itself
        nodes.delete(src);
        const moved = mkNode(dst, 'dir', { mode: n.stat.mode, ctime: n.stat.ctime });
        toPersist.push(moved);

        // move every descendant, rewriting its path prefix
        for (const child of subtree) {
          const rest = child.stat.path.slice(src.length); // starts with '/'
          const newPath = dst + rest;
          nodes.delete(child.stat.path);
          const movedChild = mkNode(newPath, child.stat.type, {
            data: child.data,
            mode: child.stat.mode,
            ctime: child.stat.ctime,
          });
          toPersist.push(movedChild);
        }
        persistMany(toPersist);
        persistDeleteMany(oldPaths.filter((p) => p !== dst)); // old paths no longer exist
      } else {
        nodes.delete(src);
        const moved = mkNode(dst, 'file', { data: n.data, mode: n.stat.mode, ctime: n.stat.ctime });
        persistNode(moved);
        persistDelete(src);
      }

      bus.emit('fs:change', { path: dst, oldPath: src, kind: 'rename' });
    },

    async chmod(p, mode) {
      const n = get(p);
      n.stat = { ...n.stat, mode };
      persistNode(n);
      bus.emit('fs:change', { path: n.stat.path, kind: 'modify' });
    },
  };

  if (nodes.size === 0) {
    await seed(vfs);
  }

  return vfs;
}

async function seed(vfs: VFS): Promise<void> {
  const dirs = [
    '/bin', '/etc', '/home', '/home/user', '/tmp', '/usr', '/var',
    '/home/user/Documents', '/home/user/Downloads', '/home/user/Pictures',
    '/home/user/Music', '/home/user/Desktop',
  ];
  for (const d of dirs) {
    await vfs.mkdir(d, { recursive: true });
    await vfs.chmod(d, 0o755);
  }

  const osRelease = [
    'NAME="Faisal OS"',
    `VERSION="${OS_VERSION}"`,
    'ID=faisal',
    'ID_LIKE=fedora',
    'PRETTY_NAME="Faisal OS 0.1"',
    '',
  ].join('\n');
  await vfs.writeFile('/etc/os-release', osRelease);
  await vfs.writeFile('/etc/hostname', 'faisal\n');
  await vfs.writeFile(
    '/etc/motd',
    'مرحباً بك في فيصل\nWelcome to Fai$al OS\n',
  );

  const welcome = [
    'مرحباً بك في نظام فيصل!',
    '',
    'فيصل هو نظام تشغيل افتراضي يعمل بالكامل داخل متصفحك، مستوحى من فيدورا/جنوم.',
    'يمكنك استكشاف الملفات، تحرير النصوص، واستخدام الطرفية.',
    '',
    '---',
    '',
    'Welcome to Fai$al OS!',
    '',
    'Faisal is a virtual desktop OS that runs entirely inside your browser,',
    'inspired by Fedora and GNOME. Explore the Files app, edit text files,',
    'and try the terminal.',
    '',
  ].join('\n');
  await vfs.writeFile('/home/user/Documents/welcome.txt', welcome);

  const readme = [
    '# Fai$al OS',
    '',
    'نظام تشغيل افتراضي يعمل في المتصفح.',
    '',
    'A browser-based virtual operating system.',
    '',
  ].join('\n');
  await vfs.writeFile('/home/user/Documents/readme.md', readme);
}

/**
 * VFS handle that resolves the real backend on first use.
 *
 * Opening IndexedDB and reading every stored node takes time, and the desktop does not need
 * the file system to draw itself: the boot sequence hands this handle to the shell, mounts it
 * immediately, and lets the first real file operation wait for the store. Every method is
 * still async, so callers cannot tell the difference.
 */
export function lazyVFS(ready: Promise<VFS>): VFS {
  const run = <T>(fn: (vfs: VFS) => Promise<T>): Promise<T> => ready.then(fn);
  return {
    stat: (path) => run((v) => v.stat(path)),
    exists: (path) => run((v) => v.exists(path)),
    readdir: (path) => run((v) => v.readdir(path)),
    readFile: (path) => run((v) => v.readFile(path)),
    readText: (path) => run((v) => v.readText(path)),
    writeFile: (path, data) => run((v) => v.writeFile(path, data)),
    mkdir: (path, opts) => run((v) => v.mkdir(path, opts)),
    remove: (path, opts) => run((v) => v.remove(path, opts)),
    rename: (from, to) => run((v) => v.rename(from, to)),
    chmod: (path, mode) => run((v) => v.chmod(path, mode)),
  };
}
