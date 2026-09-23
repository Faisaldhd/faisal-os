/** Tiny in-memory VFS used only by the terminal tests. */
import type { Stat, VFS } from '../../../kernel/types';
import { VFSError } from '../../../kernel/types';
import { basename, dirname, normalize } from '../../../kernel/path';

interface Node { type: 'file' | 'dir'; data: Uint8Array; mode: number; mtime: number; ctime: number }

export function createMemVFS(files: Record<string, string> = {}): VFS & { dump(): string[] } {
  const nodes = new Map<string, Node>();
  const now = () => Date.now();
  const mk = (type: Node['type'], data = new Uint8Array(), mode = type === 'dir' ? 0o755 : 0o644): Node =>
    ({ type, data, mode, mtime: now(), ctime: now() });
  nodes.set('/', mk('dir'));
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const get = (p: string) => {
    const n = nodes.get(normalize(p));
    if (!n) throw new VFSError('ENOENT', p);
    return n;
  };
  const parentDir = (p: string) => {
    const parent = nodes.get(dirname(p));
    if (!parent) throw new VFSError('ENOENT', p);
    if (parent.type !== 'dir') throw new VFSError('ENOTDIR', p);
  };
  const statOf = (p: string, n: Node): Stat => ({
    path: p, name: p === '/' ? '/' : basename(p), type: n.type, size: n.type === 'dir' ? 0 : n.data.length,
    mode: n.mode, mtime: n.mtime, ctime: n.ctime,
  });
  const children = (p: string) => [...nodes.keys()].filter((k) => k !== p && dirname(k) === p);

  const vfs: VFS & { dump(): string[] } = {
    async stat(p) { const n = normalize(p); return statOf(n, get(n)); },
    async exists(p) { return nodes.has(normalize(p)); },
    async readdir(p) {
      const n = normalize(p);
      const node = get(n);
      if (node.type !== 'dir') throw new VFSError('ENOTDIR', n);
      return children(n).map((c) => statOf(c, nodes.get(c)!));
    },
    async readFile(p) {
      const node = get(p);
      if (node.type === 'dir') throw new VFSError('EISDIR', p);
      return node.data.slice();
    },
    async readText(p) { return dec.decode(await vfs.readFile(p)); },
    async writeFile(p, data) {
      const n = normalize(p);
      parentDir(n);
      const existing = nodes.get(n);
      if (existing?.type === 'dir') throw new VFSError('EISDIR', n);
      const bytes = typeof data === 'string' ? enc.encode(data) : data.slice();
      if (existing) { existing.data = bytes; existing.mtime = now(); }
      else nodes.set(n, mk('file', bytes));
    },
    async mkdir(p, opts) {
      const n = normalize(p);
      if (nodes.has(n)) { if (opts?.recursive) return; throw new VFSError('EEXIST', n); }
      if (opts?.recursive && !nodes.has(dirname(n))) await vfs.mkdir(dirname(n), opts);
      parentDir(n);
      nodes.set(n, mk('dir'));
    },
    async remove(p, opts) {
      const n = normalize(p);
      const node = get(n);
      const kids = [...nodes.keys()].filter((k) => k.startsWith(n + '/'));
      if (node.type === 'dir' && kids.length && !opts?.recursive) throw new VFSError('ENOTEMPTY', n);
      kids.forEach((k) => nodes.delete(k));
      nodes.delete(n);
    },
    async rename(from, to) {
      const f = normalize(from), t = normalize(to);
      get(f);
      parentDir(t);
      if (nodes.has(t)) throw new VFSError('EEXIST', t);
      for (const k of [...nodes.keys()]) {
        if (k === f || k.startsWith(f + '/')) {
          nodes.set(t + k.slice(f.length), nodes.get(k)!);
          nodes.delete(k);
        }
      }
    },
    async chmod(p, mode) { get(p).mode = mode; },
    dump() { return [...nodes.keys()].sort(); },
  };

  // seed synchronously-ish: callers await `ready` via seed()
  for (const [path, content] of Object.entries(files)) {
    const parts = normalize(path).split('/').filter(Boolean);
    let cur = '';
    const isDir = path.endsWith('/');
    for (let i = 0; i < parts.length; i++) {
      cur += '/' + parts[i];
      const last = i === parts.length - 1;
      if (last && !isDir) nodes.set(cur, mk('file', enc.encode(content)));
      else if (!nodes.has(cur)) nodes.set(cur, mk('dir'));
    }
  }
  return vfs;
}
