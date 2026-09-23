import type { VFS } from '../../kernel/types';
import { basename, dirname, join } from '../../kernel/path';

/** Finds a non-conflicting name like "name (copy)", "name (copy 2)", ... in `dir`. */
export async function uniqueName(vfs: VFS, dir: string, name: string, copySuffix: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';

  let candidate = name;
  if (await vfs.exists(join(dir, candidate))) {
    candidate = `${base} (${copySuffix})${ext}`;
    let n = 2;
    while (await vfs.exists(join(dir, candidate))) {
      candidate = `${base} (${copySuffix} ${n})${ext}`;
      n++;
    }
  }
  return candidate;
}

/** Recursively copies a file or directory tree to a new path (which must not already exist). */
export async function copyRecursive(vfs: VFS, from: string, to: string): Promise<void> {
  const st = await vfs.stat(from);
  if (st.type === 'dir') {
    await vfs.mkdir(to, { recursive: true });
    const kids = await vfs.readdir(from);
    for (const kid of kids) {
      await copyRecursive(vfs, kid.path, join(to, kid.name));
    }
  } else {
    const data = await vfs.readFile(from);
    await vfs.writeFile(to, data);
  }
}

export function targetPathFor(srcPath: string, destDir: string): string {
  return join(destDir, basename(srcPath));
}

export function sameOrDescendant(a: string, b: string): boolean {
  return b === a || b.startsWith(a + '/');
}

export { dirname };
