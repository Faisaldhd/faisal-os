/**
 * Drag & drop decision logic for the Files app (منطق السحب والإفلات).
 *
 * This module is deliberately DOM-free: it only decides *what* a drag should do and *why*
 * it must be refused, so every branch can be unit tested (see dnd.test.ts).
 * The app performs the actual UI highlight, upload and move.
 *
 * Two drags are recognised:
 *   - internal: one or more entries dragged from an item row. They carry `PATHS_MIME`.
 *   - external: files dragged in from the OS/desktop. `DataTransfer.types` then contains
 *     'Files', and the app uploads them into the folder currently shown.
 * Anything else (a text selection dragged around the page) is left untouched.
 */

import type { Stat, VFS } from '../../kernel/types';
import { VFSError } from '../../kernel/types';
import { basename, dirname, join } from '../../kernel/path';
import { uniqueName } from './copy';

/** Custom MIME type carrying the dragged absolute paths, newline-separated. */
export const PATHS_MIME = 'text/x-faisal-path';
/** Fallback MIME type for browsers that ignore custom types on drop. */
export const PATHS_PLAIN_MIME = 'text/plain';
/** MIME type the OS uses for dragged files. */
export const FILES_MIME = 'Files';

/** Why a drop was refused. The UI maps these onto localized status messages. */
export type DropRefusal =
  | 'self'
  | 'subtree'
  | 'sameParent'
  | 'notDirectory'
  | 'missingTarget'
  | 'nameConflict'
  | 'notFound'
  | 'unknown';

export interface DropTarget {
  /** Absolute path of the drop target (a directory row, or the view itself). */
  path: string;
  /** stat().type of the drop target. */
  type: Stat['type'];
}

export type DragDecision =
  | { kind: 'upload' }
  | { kind: 'move'; sources: string[]; destDir: string }
  | { kind: 'none'; reason: DropRefusal };

export type MoveRefusal = DropRefusal;

export type MoveResult =
  | { ok: true; dest: string; renamedTo?: string }
  | { ok: false; reason: MoveRefusal };

export interface MoveOptions {
  /**
   * What to do when the destination directory already holds an entry with the source name.
   * Defaults to `'error'` (matches the rename path: "that name already exists"); clipboard
   * paste and drag & drop pass `'uniquify'` so a drop never silently overwrites a file.
   */
  onConflict?: 'error' | 'uniquify';
  /** Suffix used by `uniqueName` when `onConflict` is `'uniquify'` ("name (copy 2).ext"). */
  copySuffix?: string;
}

/** The result of resolving a possible name clash in the destination directory. */
export interface NameResolution {
  /** The name the entry will actually get. */
  finalName: string;
  /** True when the original name was already taken (the move renames instead of overwriting). */
  conflict: boolean;
}

/** True when a drag carries the internal path marker. */
export function isInternalDrag(types: readonly string[]): boolean {
  return types.includes(PATHS_MIME);
}

/** True when a drag carries files from outside the app (the OS/desktop). */
export function hasExternalFiles(types: readonly string[]): boolean {
  return types.includes(FILES_MIME);
}

/**
 * Decides what a drop does, before anything touches the VFS.
 * `resolveName` is consulted only for an otherwise legal move; it reports whether the name
 * was taken, so a call that refuses overwrites can refuse the drop instead.
 */
export function decideDrop(args: {
  types: readonly string[];
  sources: readonly string[];
  target: DropTarget | null;
  resolveName: (destDir: string, name: string) => NameResolution;
}): DragDecision {
  const { types, sources, target, resolveName } = args;

  // External files first: an OS drag carries no internal path marker.
  if (hasExternalFiles(types)) return { kind: 'upload' };
  if (!isInternalDrag(types)) return { kind: 'none', reason: 'unknown' };
  if (sources.length === 0) return { kind: 'none', reason: 'unknown' };
  if (!target) return { kind: 'none', reason: 'missingTarget' };

  const destDir = target.path;
  if (target.type !== 'dir') return { kind: 'none', reason: 'notDirectory' };

  for (const src of sources) {
    if (src === destDir) return { kind: 'none', reason: 'self' };
    if (destDir.startsWith(src + '/')) return { kind: 'none', reason: 'subtree' };
    if (dirname(src) === destDir) return { kind: 'none', reason: 'sameParent' };
    if (resolveName(destDir, basename(src)).conflict) return { kind: 'none', reason: 'nameConflict' };
  }

  return { kind: 'move', sources: [...sources], destDir };
}

/**
 * Reads the dragged paths out of a data transfer. Returns [] when the drag carries no
 * internal path marker (an external file drag, or unrelated selected text).
 */
export function resolveDragPaths(
  types: readonly string[],
  getData: (format: string) => string,
): string[] {
  if (!isInternalDrag(types)) return [];
  const raw = getData(PATHS_MIME) || getData(PATHS_PLAIN_MIME);
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('/'));
}

/** Maps a refusal onto the i18n key the app shows in its status line. */
export function dropRefusedKey(reason: DropRefusal): string {
  switch (reason) {
    case 'self': return 'files.dndRefusedSelf';
    case 'subtree': return 'files.dndRefusedSubtree';
    case 'sameParent': return 'files.dndRefusedSameParent';
    case 'notDirectory': return 'files.dndRefusedNotDirectory';
    case 'missingTarget': return 'files.dndRefusedNoTarget';
    case 'nameConflict': return 'files.dndRefusedNameTaken';
    case 'notFound': return 'files.dndRefusedMissing';
    default: return 'files.dndRefusedUnknown';
  }
}

function refuse(code: 'EEXIST', path: string, message: string): never {
  throw new VFSError(code, path, message);
}

/** Resolves a possible name clash in `destDir` the way `MoveOptions.onConflict` asks. */
async function resolveConflict(
  vfs: VFS,
  destDir: string,
  name: string,
  onConflict: 'error' | 'uniquify',
  copySuffix: string,
): Promise<NameResolution> {
  if (!(await vfs.exists(join(destDir, name)))) return { finalName: name, conflict: false };
  if (onConflict === 'error') {
    refuse('EEXIST', join(destDir, name), `EEXIST: ${join(destDir, name)}`);
  }
  return { finalName: await uniqueName(vfs, destDir, name, copySuffix), conflict: true };
}

/**
 * The single mover used by clipboard paste-cut, drag & drop and "Move to…".
 * Every refusal guard runs before the VFS is mutated:
 *   drop on itself, move into its own subtree, move into the same parent (a no-op),
 *   missing target, target that is not a directory, and name conflicts.
 */
export async function moveEntry(
  vfs: VFS,
  src: string,
  destDir: string,
  opts: MoveOptions = {},
): Promise<MoveResult> {
  const onConflict = opts.onConflict ?? 'error';
  const copySuffix = opts.copySuffix ?? 'copy';
  const name = basename(src);

  if (src === destDir) return { ok: false, reason: 'self' };
  if (destDir.startsWith(src + '/')) return { ok: false, reason: 'subtree' };
  if (dirname(src) === destDir) return { ok: false, reason: 'sameParent' };

  let st: Stat;
  try {
    st = await vfs.stat(destDir);
  } catch {
    return { ok: false, reason: 'missingTarget' };
  }
  if (st.type !== 'dir') return { ok: false, reason: 'notDirectory' };

  const resolved = await resolveConflict(vfs, destDir, name, onConflict, copySuffix);
  const dest = join(destDir, resolved.finalName);
  if (dest === src) return { ok: false, reason: 'sameParent' };

  await vfs.rename(src, dest);
  return resolved.conflict ? { ok: true, dest, renamedTo: resolved.finalName } : { ok: true, dest };
}
