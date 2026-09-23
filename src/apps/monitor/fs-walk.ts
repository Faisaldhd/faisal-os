import type { VFS } from '../../kernel/types';
import type { FsNode } from './helpers';

/** Recursively walks the VFS from `root`, collecting a flat list of file/dir nodes with sizes. */
export async function walkVFS(vfs: VFS, root: string): Promise<FsNode[]> {
  const out: FsNode[] = [];
  async function visit(path: string): Promise<void> {
    let entries;
    try {
      entries = await vfs.readdir(path);
    } catch {
      return;
    }
    for (const st of entries) {
      out.push({ path: st.path, type: st.type, size: st.size });
      if (st.type === 'dir') await visit(st.path);
    }
  }
  await visit(root);
  return out;
}
