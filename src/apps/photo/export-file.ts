/**
 * Photo Editor — the pure file policy: where writes are allowed, what "save a copy" is
 * called, and exactly how an overwrite keeps ONE `.bak`.
 *
 * Nothing here touches the VFS. It returns a *plan* — an ordered list of the two or three
 * operations the UI then performs — so the rule can be tested without a file system, and so
 * the UI cannot accidentally invent a third backup file.
 */
import type { ExportFormat } from './formats';
import { canonicalExtension } from './formats';

export const HOME_ROOT = '/home/user';

/** POSIX normalisation, kept local so this module does not depend on the kernel. */
export function normalisePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/**
 * The permission rule in code: `fs:home` allows /home/user and nothing else. The check is on
 * the NORMALISED path, so "/home/user/../../etc/passwd" is refused like the escape it is.
 */
export function isWithinHome(path: string): boolean {
  const p = normalisePath(path);
  return p === HOME_ROOT || p.startsWith(`${HOME_ROOT}/`);
}

export function assertWithinHome(path: string): void {
  if (!isWithinHome(path)) throw new Error(`photo editor: refusing to write outside ${HOME_ROOT}: ${path}`);
}

export function dirnameOf(path: string): string {
  const n = normalisePath(path);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

export function basenameOf(path: string): string {
  const n = normalisePath(path);
  return n === '/' ? '/' : n.slice(n.lastIndexOf('/') + 1);
}

/** `a/photo.png` → `photo` (the part an export name is built from). */
export function stemOf(path: string): string {
  const name = basenameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The single backup path for an original: `<original>.bak`, always exactly one. */
export function backupPathFor(path: string): string {
  return `${normalisePath(path)}.bak`;
}

/** `<dir>/<stem><suffix><ext>` — the extension comes from the export format, not the input. */
export function exportFileName(originalPath: string, format: ExportFormat, suffix = ''): string {
  return `${stemOf(originalPath)}${suffix}${canonicalExtension(format)}`;
}

export function exportPathFor(originalPath: string, format: ExportFormat, suffix = ''): string {
  return `${dirnameOf(originalPath)}/${exportFileName(originalPath, format, suffix)}`;
}
/**
 * A free copy path: the first of `name (edited).png`, `name (edited 2).png`, … that is not
 * already taken. `taken` is the list of paths the caller knows exist. `suffix` is overridable
 * so an untitled document is simply `untitled.png` until that name is taken.
 */
export function nextCopyPath(
  dir: string, stem: string, format: ExportFormat, taken: readonly string[], suffix = ' (edited)',
): string {
  const ext = canonicalExtension(format);
  const used = new Set(taken.map((p) => normalisePath(p)));
  const base = `${normalisePath(dir)}/${stem}`;
  const nameFor = (n: number) => {
    if (n === 1) return `${base}${suffix}${ext}`;
    // `suffix` is built as ` (edited)`, so the counter goes INSIDE the bracket.
    const withCounter = suffix.endsWith(')')
      ? `${base}${suffix.slice(0, -1)} ${n})${ext}`
      : `${base}${suffix} ${n}${ext}`;
    return withCounter;
  };
  for (let n = 1; n < 1000; n++) {
    const candidate = nameFor(n);
    if (!used.has(candidate)) return candidate;
  }
  return `${base}${suffix} ${Date.now()}${ext}`;
}

export type ExportPlanStep = 'write-target' | 'backup-original' | 'write-original' | 'remove';

export interface ExportPlan {
  /** Where the bytes go. */
  target: string;
  format: ExportFormat | null;
  /** Runs in this order. */
  steps: ExportPlanStep[];
  /** True when the plan replaces the original file. */
  overwritesOriginal: boolean;
  /** True when the plan creates/replaces the single `.bak`. */
  backup: boolean;
  /** Set when the request cannot be honoured; the UI shows this instead of writing. */
  error?: 'out-of-home' | 'cannot-export' | 'no-target';
}

export interface PlanRequest {
  /** The file the window opened, or null for an untitled document. */
  original: string | null;
  /** Which button was pressed. */
  action: 'copy' | 'overwrite';
  format: ExportFormat;
  /** Every path the caller can see already present (used for the copy suffix). */
  existing: readonly string[];
}

/**
 * The whole write rule in one function:
 *  • copy      → always a NEW file (never the original), suffixed when the name is taken;
 *  • overwrite → the original path itself, preceded by exactly one rename to `<original>.bak`.
 *
 * The backup is a rename, not a copy: the VFS replaces an existing destination, so a second
 * overwrite leaves the previous `.bak` replaced as well — one backup file, never two. A
 * backup is only planned when the original actually exists in `existing`.
 */
export function planExport(request: PlanRequest): ExportPlan {
  const { original, action, format, existing } = request;
  const dir = original ? dirnameOf(original) : HOME_ROOT;
  if (!isWithinHome(dir)) {
    return { target: '', format: null, steps: [], overwritesOriginal: false, backup: false, error: 'out-of-home' };
  }
  const has = (p: string) => existing.some((e) => normalisePath(e) === normalisePath(p));

  if (action === 'copy') {
    // The original is excluded from "taken": a copy must never land on the file the window
    // opened, or "save a copy" would quietly become "overwrite the original".
    const taken = original ? existing.filter((e) => !sameTarget(e, original)) : existing;
    const target = original
      ? nextCopyPath(dir, stemOf(original), format, taken)
      : nextCopyPath(dir, 'untitled', format, taken, '');
    return {
      target, format, steps: ['write-target'],
      overwritesOriginal: false, backup: false,
    };
  }

  if (!original) {
    // "Overwrite the original" with no original is impossible; refusing is the honest answer
    // (the UI disables the button in that case as well).
    return { target: '', format: null, steps: [], overwritesOriginal: false, backup: false, error: 'no-target' };
  }

  const target = normalisePath(original);
  const steps: ExportPlanStep[] = [];
  const backup = has(target);
  if (backup) steps.push('backup-original');
  steps.push('write-original');
  return { target, format, steps, overwritesOriginal: true, backup };
}

/**
 * The format an export target name implies, so a copy named `x.jpg` is really encoded as
 * JPEG. Kept as a re-export because the write rule and the format table must agree: a name
 * the editor cannot encode is reported as null and the caller keeps the picked format.
 */
export { formatOfTarget } from './formats';

/** True when two paths would write the same file (used to stop a copy overwriting itself). */
export function sameTarget(a: string, b: string): boolean {
  return normalisePath(a) === normalisePath(b);
}
