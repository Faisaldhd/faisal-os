/**
 * Office — saving, and the one-backup rule (سياسة الحفظ والنسخة الاحتياطية).
 *
 * The app overwrites the file it opened, so the rule is absolute: the previous
 * bytes are copied to `<path>.bak` first, and the save is aborted if that copy
 * cannot be written. Exactly one backup exists per file — the same path is
 * overwritten each time, never `.bak.1`, `.bak.2`, …
 *
 * Two refusals, both tested:
 *  • a path outside `/home/user` is never written (the app's own guard, on top of
 *    the kernel's `fs:home` scope), and
 *  • a path that already ends in `.bak` is never saved — backing that up would
 *    create a second-order copy and turn one backup into a chain.
 */
import { HOME, VFSError } from '../../kernel/types';
import { normalize } from '../../kernel/path';

export const BACKUP_SUFFIX = '.bak';

/** The file-system calls saving needs; the kernel's scoped VFS satisfies it. */
export interface SaveVFS {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
}

/** True when a path is `/home/user` itself or inside it. */
export function withinHome(path: string): boolean {
  const p = normalize(path);
  return p === HOME || p.startsWith(`${HOME}/`);
}

/** `/home/user/a.docx` → `/home/user/a.docx.bak`. */
export function backupPathFor(path: string): string {
  return `${normalize(path)}${BACKUP_SUFFIX}`;
}

export interface SaveResult {
  path: string;
  /** null when the file did not exist yet, so there was nothing to back up. */
  backup: string | null;
  bytes: number;
}

/** Why a write was refused, in words the owner can act on. */
export type SaveFailure = 'file-too-big' | 'storage-full' | 'outside-home' | 'write-failed';

/**
 * Turns a write failure into a reason the window can translate.
 *
 * The kernel refuses BOTH quota cases with the same `EINVAL` code and the message "quota" — one
 * file above the per-file limit, or a store that is full — so the reason is decided by comparing
 * the bytes with the limit the VFS reports right now. That is the only honest way to tell a
 * refusal the owner can fix ("make it smaller") from one they cannot ("delete something").
 * A refusal outside home carries its own code; anything else is a plain failure.
 */
export function saveFailure(err: unknown, bytes: number, quota: { file: number }): SaveFailure {
  if (!(err instanceof VFSError)) return 'write-failed';
  if (err.code === 'EACCES') return 'outside-home';
  if (err.code === 'EINVAL' || err.message === 'quota') {
    return bytes > quota.file ? 'file-too-big' : 'storage-full';
  }
  return 'write-failed';
}

/**
 * Writes `data` to `path`, keeping the previous content in one `.bak` file.
 *
 * Order matters: read the old bytes, write the backup, and only then overwrite the
 * file. A failure at any step throws before the original is touched.
 */
export async function saveWithBackup(vfs: SaveVFS, path: string, data: string | Uint8Array): Promise<SaveResult> {
  const target = normalize(path);
  if (!withinHome(target)) {
    throw new VFSError('EACCES', target, `EACCES: refusing to write outside ${HOME}: ${target}`);
  }
  if (target.endsWith(BACKUP_SUFFIX)) {
    throw new VFSError('EINVAL', target, `EINVAL: refusing to back up a backup: ${target}`);
  }

  let backup: string | null = null;
  if (await vfs.exists(target)) {
    const previous = await vfs.readFile(target);
    backup = backupPathFor(target);
    await vfs.writeFile(backup, previous);
  }
  await vfs.writeFile(target, data);
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data).length : data.length;
  return { path: target, backup, bytes };
}
