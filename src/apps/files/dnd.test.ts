import { beforeEach, describe, expect, it } from 'vitest';
import { VFSError } from '../../kernel/types';
import type { Stat, VFS } from '../../kernel/types';
import { basename, dirname, normalize } from '../../kernel/path';
import {
  FILES_MIME,
  PATHS_MIME,
  PATHS_PLAIN_MIME,
  decideDrop,
  dropRefusedKey,
  hasExternalFiles,
  isInternalDrag,
  moveEntry,
  resolveDragPaths,
} from './dnd';

/* ── a small in-memory VFS, enough to exercise the mover ─────────────────── */

interface MemNode {
  type: 'file' | 'dir';
  data?: Uint8Array;
}

function createMemVFS(files: string[]): VFS & { list(): string[] } {
  const nodes = new Map<string, MemNode>();
  const enc = new TextEncoder();

  const mkdirp = (path: string) => {
    const p = normalize(path);
    if (p === '/') return;
    const parent = dirname(p);
    if (parent !== p) mkdirp(parent);
    if (!nodes.has(p)) nodes.set(p, { type: 'dir' });
  };

  const children = (dir: string): string[] =>
    [...nodes.keys()].filter((p) => p !== dir && dirname(p) === dir);

  const statOf = (p: string): Stat => {
    const path = normalize(p);
    const n = nodes.get(path);
    if (!n) throw new VFSError('ENOENT', path);
    return {
      path,
      name: basename(path),
      type: n.type,
      size: n.data?.length ?? 0,
      mode: n.type === 'dir' ? 0o755 : 0o644,
      mtime: 0,
      ctime: 0,
    };
  };

  for (const f of files) {
    const path = normalize(f);
    const isDir = f.endsWith('/');
    mkdirp(dirname(path));
    nodes.set(path, isDir ? { type: 'dir' } : { type: 'file', data: enc.encode(path) });
  }
  mkdirp('/');

  return {
    list: () => [...nodes.keys()].sort(),
    // The file system contract carries its limits; these tests do not exercise them.
    quota: { file: 1024 * 1024, total: 8 * 1024 * 1024, tier: 'desktop' },
    stat: async (p) => statOf(p),
    exists: async (p) => nodes.has(normalize(p)),
    readdir: async (p) => {
      if (!nodes.has(normalize(p))) throw new VFSError('ENOENT', normalize(p));
      return children(normalize(p)).map(statOf);
    },
    readFile: async (p) => {
      const n = nodes.get(normalize(p));
      if (!n || n.type === 'dir') throw new VFSError('EISDIR', normalize(p));
      return n.data ? new Uint8Array(n.data) : new Uint8Array(0);
    },
    readText: async (p) => {
      const n = nodes.get(normalize(p));
      if (!n || n.type === 'dir') throw new VFSError('EISDIR', normalize(p));
      return new TextDecoder().decode(n.data ?? new Uint8Array(0));
    },
    writeFile: async (p, data) => {
      const path = normalize(p);
      if (!nodes.has(dirname(path))) throw new VFSError('ENOENT', path);
      nodes.set(path, { type: 'file', data: typeof data === 'string' ? enc.encode(data) : data });
    },
    mkdir: async (p) => {
      const path = normalize(p);
      if (nodes.has(path)) throw new VFSError('EEXIST', path);
      if (!nodes.has(dirname(path))) throw new VFSError('ENOENT', path);
      nodes.set(path, { type: 'dir' });
    },
    remove: async (p, opts) => {
      const path = normalize(p);
      const n = nodes.get(path);
      if (!n) throw new VFSError('ENOENT', path);
      if (n.type === 'dir') {
        const kids = children(path);
        if (kids.length && !opts?.recursive) throw new VFSError('ENOTEMPTY', path);
        for (const k of kids) nodes.delete(k);
      }
      nodes.delete(path);
    },
    rename: async (from, to) => {
      const src = normalize(from);
      const dst = normalize(to);
      if (src === dst) throw new VFSError('EINVAL', dst);
      const n = nodes.get(src);
      if (!n) throw new VFSError('ENOENT', src);
      if (!nodes.has(dirname(dst))) throw new VFSError('ENOENT', dst);
      const moved = [...nodes.keys()].filter((p) => p === src || p.startsWith(src + '/'));
      for (const p of moved) {
        const next = dst + p.slice(src.length);
        nodes.set(next, nodes.get(p)!);
        nodes.delete(p);
      }
    },
    chmod: async (p) => { statOf(p); },
  };
}

const nameResolution = (taken: string[]) => (destDir: string, name: string) => {
  const full = `${destDir === '/' ? '' : destDir}/${name}`;
  const conflict = taken.includes(full);
  return { finalName: conflict ? `${name} (copy)` : name, conflict };
};

/* ── drag classification ─────────────────────────────────────────────────── */

describe('drag classification', () => {
  it('recognises the internal path marker', () => {
    expect(isInternalDrag([PATHS_MIME])).toBe(true);
    expect(isInternalDrag([PATHS_MIME, PATHS_PLAIN_MIME])).toBe(true);
    expect(isInternalDrag([PATHS_PLAIN_MIME])).toBe(false);
  });

  it('recognises an OS file drag', () => {
    expect(hasExternalFiles([FILES_MIME])).toBe(true);
    expect(hasExternalFiles([FILES_MIME, PATHS_PLAIN_MIME])).toBe(true);
    expect(hasExternalFiles([PATHS_MIME])).toBe(false);
  });
});

describe('resolveDragPaths', () => {
  it('returns [] when the drag carries no internal marker', () => {
    expect(resolveDragPaths([FILES_MIME], () => '/home/user/a.txt')).toEqual([]);
    expect(resolveDragPaths(['text/plain'], () => '/home/user/a.txt')).toEqual([]);
  });

  it('reads newline-separated absolute paths from the custom mime type', () => {
    const data: Record<string, string> = { [PATHS_MIME]: '/home/user/a.txt\n/home/user/b' };
    expect(resolveDragPaths([PATHS_MIME], (f) => data[f] ?? '')).toEqual(['/home/user/a.txt', '/home/user/b']);
  });

  it('falls back to text/plain and ignores empty or relative lines', () => {
    const data: Record<string, string> = { [PATHS_PLAIN_MIME]: '/home/user/a.txt\n\nrelative/x\n' };
    expect(resolveDragPaths([PATHS_MIME], (f) => data[f] ?? '')).toEqual(['/home/user/a.txt']);
  });
});

/* ── decideDrop ──────────────────────────────────────────────────────────── */

describe('decideDrop', () => {
  const currentDir = '/home/user';
  const resolveName = nameResolution([]);

  it('chooses upload for external files, whatever the target', () => {
    expect(decideDrop({
      types: [FILES_MIME],
      sources: [],
      target: null,
      resolveName,
    })).toEqual({ kind: 'upload' });
    expect(decideDrop({
      types: [FILES_MIME],
      sources: ['/home/user/a.txt'],
      target: { path: '/home/user/Documents', type: 'dir' },
      resolveName,
    })).toEqual({ kind: 'upload' });
  });

  it('chooses none for an unrelated drag (dragged text) without touching the VFS', () => {
    expect(decideDrop({
      types: ['text/plain', 'text/html'],
      sources: [],
      target: { path: '/home/user/Documents', type: 'dir' },
      resolveName: () => { throw new Error('resolveName must not run for unrelated drags'); },
    })).toEqual({ kind: 'none', reason: 'unknown' });
  });

  it('chooses none for an internal drag with no source paths (empty transfer)', () => {
    expect(decideDrop({ types: [PATHS_MIME], sources: [], target: { path: '/d', type: 'dir' }, resolveName }))
      .toEqual({ kind: 'none', reason: 'unknown' });
  });

  it('chooses none when the drop lands outside any row', () => {
    expect(decideDrop({ types: [PATHS_MIME], sources: ['/home/user/a.txt'], target: null, resolveName }))
      .toEqual({ kind: 'none', reason: 'missingTarget' });
  });

  it('chooses none when the target row is not a directory', () => {
    expect(decideDrop({
      types: [PATHS_MIME],
      sources: ['/home/user/a.txt'],
      target: { path: '/home/user/b.txt', type: 'file' },
      resolveName,
    })).toEqual({ kind: 'none', reason: 'notDirectory' });
  });

  it('refuses dropping an entry onto itself', () => {
    expect(decideDrop({
      types: [PATHS_MIME],
      sources: ['/home/user/Documents'],
      target: { path: '/home/user/Documents', type: 'dir' },
      resolveName,
    })).toEqual({ kind: 'none', reason: 'self' });
  });

  it('refuses dropping a directory into its own subtree', () => {
    expect(decideDrop({
      types: [PATHS_MIME],
      sources: ['/home/user/Documents'],
      target: { path: '/home/user/Documents/2026/reports', type: 'dir' },
      resolveName,
    })).toEqual({ kind: 'none', reason: 'subtree' });
  });

  it('refuses a drop into the same parent (a no-op), even when a sibling name is free', () => {
    expect(decideDrop({
      types: [PATHS_MIME],
      sources: ['/home/user/a.txt'],
      target: { path: currentDir, type: 'dir' },
      resolveName,
    })).toEqual({ kind: 'none', reason: 'sameParent' });
  });

  it('refuses a drop that would overwrite an existing name', () => {
    expect(decideDrop({
      types: [PATHS_MIME],
      sources: ['/home/user/a.txt'],
      target: { path: '/home/user/Documents', type: 'dir' },
      resolveName: nameResolution(['/home/user/Documents/a.txt']),
    })).toEqual({ kind: 'none', reason: 'nameConflict' });
  });

  it('chooses none when any entry of a multi-entry drop would overwrite', () => {
    expect(decideDrop({
      types: [PATHS_MIME, PATHS_PLAIN_MIME],
      sources: ['/home/user/a.txt', '/home/user/Documents'],
      target: { path: '/home/user/Archive', type: 'dir' },
      resolveName: nameResolution(['/home/user/Archive/a.txt']),
    })).toEqual({
      kind: 'none',
      reason: 'nameConflict',
    });
  });

  it('chooses move for a legal drop and keeps the destination directory', () => {
    expect(decideDrop({
      types: [PATHS_MIME, PATHS_PLAIN_MIME],
      sources: ['/home/user/a.txt', '/home/user/Documents'],
      target: { path: '/home/user/Archive', type: 'dir' },
      resolveName,
    })).toEqual({
      kind: 'move',
      sources: ['/home/user/a.txt', '/home/user/Documents'],
      destDir: '/home/user/Archive',
    });
  });

  it('treats a sibling-looking prefix as legal, not a subtree drop', () => {
    // "/home/user/Docs2" must not be mistaken for a child of "/home/user/Docs".
    expect(decideDrop({
      types: [PATHS_MIME],
      sources: ['/home/user/Docs'],
      target: { path: '/home/user/Docs2', type: 'dir' },
      resolveName,
    })).toEqual({ kind: 'move', sources: ['/home/user/Docs'], destDir: '/home/user/Docs2' });
  });
});

describe('dropRefusedKey', () => {
  it('maps every refusal reason to a namespaced files key', () => {
    const reasons = ['self', 'subtree', 'sameParent', 'notDirectory', 'missingTarget', 'nameConflict', 'notFound'] as const;
    for (const r of reasons) expect(dropRefusedKey(r)).toMatch(/^files\.dnd/);
    expect(new Set(reasons.map(dropRefusedKey)).size).toBe(reasons.length);
    expect(dropRefusedKey('unknown')).toBe('files.dndRefusedUnknown');
  });
});

/* ── moveEntry (shared mover) ────────────────────────────────────────────── */

describe('moveEntry', () => {
  let vfs: ReturnType<typeof createMemVFS>;

  beforeEach(() => {
    vfs = createMemVFS([
      '/home/user/a.txt',
      '/home/user/b.txt',
      '/home/user/Documents/',
      '/home/user/Documents/report.md',
      '/home/user/Documents/2026/',
    ]);
  });

  it('moves a file into a directory', async () => {
    const res = await moveEntry(vfs, '/home/user/a.txt', '/home/user/Documents');
    expect(res).toEqual({ ok: true, dest: '/home/user/Documents/a.txt' });
    expect(await vfs.exists('/home/user/a.txt')).toBe(false);
    expect(await vfs.exists('/home/user/Documents/a.txt')).toBe(true);
  });

  it('moves a directory (with its contents) into another directory', async () => {
    const vfs2 = createMemVFS(['/home/user/Reports/2026/', '/home/user/Archive/']);
    const res = await moveEntry(vfs2, '/home/user/Reports', '/home/user/Archive');
    expect(res).toEqual({ ok: true, dest: '/home/user/Archive/Reports' });
    expect(await vfs2.exists('/home/user/Archive/Reports/2026')).toBe(true);
    expect(await vfs2.exists('/home/user/Reports')).toBe(false);
    expect(await moveEntry(vfs2, '/home/user/Archive', '/home/user/Archive/Reports')).toEqual({ ok: false, reason: 'subtree' });
  });

  it('refuses self, subtree, same-parent and non-directory targets without touching the VFS', async () => {
    const before = vfs.list();
    expect(await moveEntry(vfs, '/home/user/Documents', '/home/user/Documents')).toEqual({ ok: false, reason: 'self' });
    expect(await moveEntry(vfs, '/home/user/Documents', '/home/user/Documents/2026')).toEqual({ ok: false, reason: 'subtree' });
    expect(await moveEntry(vfs, '/home/user/a.txt', '/home/user')).toEqual({ ok: false, reason: 'sameParent' });
    expect(await moveEntry(vfs, '/home/user/a.txt', '/home/user/b.txt')).toEqual({ ok: false, reason: 'notDirectory' });
    expect(await moveEntry(vfs, '/home/user/a.txt', '/home/user/nope')).toEqual({ ok: false, reason: 'missingTarget' });
    expect(vfs.list()).toEqual(before);
  });

  it('refuses an overwrite by default, and throws EEXIST for the rename path', async () => {
    const vfs2 = createMemVFS(['/home/user/x/a.txt', '/home/user/y/', '/home/user/y/a.txt']);
    await expect(moveEntry(vfs2, '/home/user/x/a.txt', '/home/user/y')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await vfs2.exists('/home/user/x/a.txt')).toBe(true);
    expect(await vfs2.readText('/home/user/y/a.txt')).not.toBe('');
  });

  it('never overwrites in uniquify mode and reports the new name', async () => {
    const vfs2 = createMemVFS(['/home/user/x/a.txt', '/home/user/y/', '/home/user/y/a.txt']);
    const res = await moveEntry(vfs2, '/home/user/x/a.txt', '/home/user/y', { onConflict: 'uniquify', copySuffix: 'copy' });
    expect(res).toEqual({ ok: true, dest: '/home/user/y/a (copy).txt', renamedTo: 'a (copy).txt' });
    expect(await vfs2.exists('/home/user/y/a.txt')).toBe(true);
    expect(await vfs2.exists('/home/user/y/a (copy).txt')).toBe(true);
  });

  it('does not rename when the destination name is free', async () => {
    const res = await moveEntry(vfs, '/home/user/a.txt', '/home/user/Documents', { onConflict: 'uniquify' });
    expect(res).toEqual({ ok: true, dest: '/home/user/Documents/a.txt' });
  });

  it('refuses a same-parent move even in uniquify mode (no "(copy)" of itself)', async () => {
    const before = vfs.list();
    expect(await moveEntry(vfs, '/home/user/a.txt', '/home/user', { onConflict: 'uniquify', copySuffix: 'copy' }))
      .toEqual({ ok: false, reason: 'sameParent' });
    expect(vfs.list()).toEqual(before);
  });

  it('uses the localized suffix when uniquifying', async () => {
    const vfs2 = createMemVFS(['/home/user/x/a.txt', '/home/user/y/', '/home/user/y/a.txt']);
    const res = await moveEntry(vfs2, '/home/user/x/a.txt', '/home/user/y', { onConflict: 'uniquify', copySuffix: 'نسخة' });
    expect(res).toEqual({ ok: true, dest: '/home/user/y/a (نسخة).txt', renamedTo: 'a (نسخة).txt' });
  });
});
