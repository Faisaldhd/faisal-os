/**
 * The OS drag & drop service (السحب والإفلات).
 *
 * Two kinds of drags land here:
 *
 * 1. Files dragged in from the real computer — always saved, never moved:
 *    - on the desktop                   → saved in ~/Desktop
 *    - on a folder icon on the desktop  → saved inside that folder
 *    - on an app icon on the desktop    → saved in ~/Desktop and opened with that app
 *    - on any app window                → saved in ~/Downloads and opened with the matching app
 *    - inside the Files app view        → that app saves them into the folder it shows
 *
 * 2. Files dragged *inside* Fai$al OS (the `text/x-faisal-path` marker the Files app's rows and
 *    the desktop icons set). They can be dropped where files live — the desktop itself, a folder
 *    icon, a folder open in the Files app — and the shell asks first: a copy (the original stays)
 *    or a move. Nothing is touched until the owner answers, and cancelling changes nothing.
 *
 * Files never replaces its own drop handling: an event it already handled is left alone.
 * The page itself never navigates to a dropped file (the browser's default), which
 * would close the whole OS.
 */
import type { SystemAPI, VFS } from '../kernel/types';
import { HOME, VFSError } from '../kernel/types';
import { basename, dirname, join } from '../kernel/path';
import { t } from '../kernel/i18n';
import { formatBytes } from '../kernel/bytes';
import { copyRecursive, uniqueName } from '../apps/files/copy';
import { PATHS_MIME, moveEntry, resolveDragPaths, type DropRefusal } from '../apps/files/dnd';
import { shellChoice } from './dialog';

/* ─────────────────────────────── reading a drop ─────────────────────────────── */

export interface DroppedFile {
  /** Path segments relative to the drop point, the file name last ("folder/sub/a.txt"). */
  segments: string[];
  file: File;
}

/** What a drop carried, captured synchronously (a DataTransfer is empty once the event ends). */
export interface DropSource {
  files: File[];
  entries: FileSystemEntry[];
}

/** True when a drag carries files from the real computer. */
export function isExternalFileDrag(dt: DataTransfer | null): boolean {
  return !!dt && [...dt.types].includes('Files');
}

export function captureDrop(dt: DataTransfer): DropSource {
  const entries: FileSystemEntry[] = [];
  const files: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    const f = item.getAsFile();
    if (f) files.push(f);
  }
  if (!files.length) files.push(...Array.from(dt.files ?? []));
  return { files, entries };
}

/** A single safe path segment: no separators, never "." or "..", never empty. */
export function safeSegment(name: string): string {
  const clean = name.replace(/[/\\]/g, '_').trim();
  return !clean || clean === '.' || clean === '..' ? 'file' : clean;
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

async function readDir(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];
  // readEntries returns the listing in batches; an empty batch ends it.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/** Every file of the drop, with dropped folders walked recursively (`dirs` keeps empty folders too). */
export async function collectFiles(src: DropSource): Promise<{ files: DroppedFile[]; dirs: string[][] }> {
  if (!src.entries.length) return { files: src.files.map((file) => ({ segments: [safeSegment(file.name)], file })), dirs: [] };
  const files: DroppedFile[] = [];
  const dirs: string[][] = [];
  const walk = async (entry: FileSystemEntry, parent: string[]) => {
    const segments = [...parent, safeSegment(entry.name)];
    if (entry.isFile) {
      files.push({ segments, file: await fileOf(entry as FileSystemFileEntry) });
    } else if (entry.isDirectory) {
      dirs.push(segments);
      for (const child of await readDir(entry as FileSystemDirectoryEntry)) await walk(child, segments);
    }
  };
  for (const entry of src.entries) await walk(entry, []);
  return { files, dirs };
}

export interface SaveResult {
  /** Absolute paths of what landed at the top of `dir` (files and folders), in drop order. */
  saved: string[];
  /** Absolute paths of every file written. */
  files: string[];
  failed: number;
  error?: unknown;
}

/**
 * Writes a drop into `dir`. Top-level names never overwrite: a taken name becomes
 * "name (copy).ext"; everything inside a dropped folder keeps its own names.
 */
export async function saveDropped(
  vfs: VFS, dir: string, drop: { files: DroppedFile[]; dirs: string[][] }, copySuffix: string,
): Promise<SaveResult> {
  const result: SaveResult = { saved: [], files: [], failed: 0 };
  const renamed = new Map<string, string>();
  const topName = async (name: string) => {
    let final = renamed.get(name);
    if (!final) {
      final = await uniqueName(vfs, dir, name, copySuffix);
      renamed.set(name, final);
      result.saved.push(join(dir, final));
    }
    return final;
  };
  const target = async (segments: string[]) => join(dir, await topName(segments[0]), ...segments.slice(1));

  for (const segments of drop.dirs) {
    try {
      await vfs.mkdir(await target(segments), { recursive: true });
    } catch (err) { result.failed++; result.error ??= err; }
  }
  for (const { segments, file } of drop.files) {
    try {
      // Refuse on size BEFORE reading: `arrayBuffer()` pulls the whole file into memory, so a
      // huge drop would freeze the tab (or crash a phone) only to be rejected afterwards.
      if (file.size > vfs.quota.file) {
        throw new VFSError('EINVAL', segments[segments.length - 1] ?? 'file', 'quota');
      }
      const path = await target(segments);
      if (segments.length > 1) await vfs.mkdir(dirname(path), { recursive: true });
      await vfs.writeFile(path, new Uint8Array(await file.arrayBuffer()));
      result.files.push(path);
    } catch (err) { result.failed++; result.error ??= err; }
  }
  return result;
}

/* ─────────────────────────────── where it lands ─────────────────────────────── */

export type DropPlace =
  | { kind: 'desktop' }
  | { kind: 'desktopPath'; path: string }
  | { kind: 'desktopApp'; appId: string }
  | { kind: 'window'; windowEl: HTMLElement }
  | { kind: 'ignore' };

/** Decides what a drop at `el` means. The Files app's own view is handled by that app. */
export function dropPlace(el: Element | null): DropPlace {
  if (!el) return { kind: 'desktop' };
  const tile = el.closest<HTMLElement>('.faisal-desktop-icon');
  if (tile?.dataset.path) return { kind: 'desktopPath', path: tile.dataset.path };
  if (tile?.dataset.appId) return { kind: 'desktopApp', appId: tile.dataset.appId };
  const win = el.closest<HTMLElement>('.faisal-window');
  if (win) return win.querySelector('.faisal-files') ? { kind: 'ignore' } : { kind: 'window', windowEl: win };
  // Top bar, dock and the desktop itself all mean "put it on the desktop".
  return { kind: 'desktop' };
}

/* ─────────────────────── internal drags (inside the OS) ─────────────────────── */

/**
 * Where an internal drag lands: the folder it was dropped on, or the desktop for the desktop
 * itself, the top bar and the dock. An app tile or someone else's window is not a place that can
 * hold files, so dropping there is ignored.
 */
export function dropDirFor(place: DropPlace, desktopDir: string): string | null {
  if (place.kind === 'desktopPath') return place.path;
  if (place.kind === 'desktop') return desktopDir;
  return null;
}

/** True when the drag carries files dragged inside the OS. */
export function isInternalDrag(dt: DataTransfer | null): boolean {
  return !!dt && [...dt.types].includes(PATHS_MIME);
}

/** The absolute paths an internal drag carries (empty for any other drag). */
export function dragPaths(dt: DataTransfer): string[] {
  return resolveDragPaths([...dt.types], (format) => dt.getData(format));
}

export type TransferMode = 'copy' | 'move';

export type TransferResult =
  | { ok: true; dest: string }
  | { ok: false; reason: DropRefusal };

/**
 * Copies or moves one entry into `destDir`. Both modes run the same guards — an entry into
 * itself, into its own subtree, or into the folder it already sits in — and neither ever
 * overwrites: a taken name becomes "name (copy)…", using the localized word for "copy".
 */
export async function transferEntry(
  vfs: VFS, src: string, destDir: string, mode: TransferMode, copySuffix: string,
): Promise<TransferResult> {
  if (src === destDir) return { ok: false, reason: 'self' };
  if (destDir.startsWith(src + '/')) return { ok: false, reason: 'subtree' };
  if (dirname(src) === destDir) return { ok: false, reason: 'sameParent' };

  let st;
  try { st = await vfs.stat(destDir); } catch { return { ok: false, reason: 'missingTarget' }; }
  if (st.type !== 'dir') return { ok: false, reason: 'notDirectory' };

  if (mode === 'move') {
    const r = await moveEntry(vfs, src, destDir, { onConflict: 'uniquify', copySuffix });
    return r.ok ? { ok: true, dest: r.dest } : { ok: false, reason: r.reason };
  }
  try {
    const name = await uniqueName(vfs, destDir, basename(src), copySuffix);
    const dest = join(destDir, name);
    if (dest === src) return { ok: false, reason: 'sameParent' };
    await copyRecursive(vfs, src, dest);
    return { ok: true, dest };
  } catch {
    return { ok: false, reason: 'unknown' };
  }
}

/** Maps a refusal onto the shell string that explains it. */
function refusedKey(reason: DropRefusal): string {
  switch (reason) {
    case 'self': return 'shell.dnd.refusedSelf';
    case 'subtree': return 'shell.dnd.refusedSubtree';
    case 'sameParent': return 'shell.dnd.refusedSameParent';
    case 'nameConflict': return 'shell.dnd.refusedNameTaken';
    case 'notDirectory': return 'shell.dnd.refusedNotDirectory';
    case 'missingTarget': return 'shell.dnd.refusedMissing';
    default: return 'shell.dnd.refusedUnknown';
  }
}

/**
 * The copy-or-move question, asked before anything touches the file system. Cancelling resolves
 * `null`, and nothing may be written after that. Shared with the Files app, so a drop inside its
 * view asks exactly the same question as a drop on the desktop.
 */
export function askTransfer(paths: readonly string[]): Promise<TransferMode | null> {
  const name = paths.length === 1 ? basename(paths[0]) : t('shell.dnd.countFiles', { count: paths.length });
  return shellChoice<TransferMode>({
    title: t('shell.dnd.askTitle'),
    message: t('shell.dnd.askBody', { name }),
    options: [
      { value: 'copy', label: t('shell.drop.copy') },
      { value: 'move', label: t('shell.dnd.move'), primary: true },
    ],
    cancelLabel: t('shell.dnd.cancel'),
  });
}

/**
 * The name the drop chip shows: the destination's own label when it has one (a folder icon or a
 * window title), otherwise the caller's fallback. Exported so the wording per place stays pinned
 * by a test instead of living only in the browser.
 */
export function dropTargetLabel(el: HTMLElement | null, fallback: string): string {
  const text = el
    ?.querySelector<HTMLElement>('.faisal-desktop-icon-label, .faisal-titlebar-title')
    ?.textContent?.trim();
  return text || fallback;
}

/* ─────────────────────────────── the service ─────────────────────────────── */

const DESKTOP = join(HOME, 'Desktop');
const DOWNLOADS = join(HOME, 'Downloads');
/** Opening more windows than this from one drop would bury the screen. */
const MAX_OPEN = 5;

export function mountFileDrop(sys: SystemAPI): void {
  let highlighted: HTMLElement | null = null;
  let badge: HTMLElement | null = null;

  /** The chip that names the destination. Decorative: the notification reports the outcome. */
  const badgeEl = (): HTMLElement => {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'faisal-drop-badge';
      badge.setAttribute('aria-hidden', 'true');
    }
    return badge;
  };

  const showBadge = (el: HTMLElement, name: string, at?: { x: number; y: number }) => {
    const b = badgeEl();
    b.textContent = t('shell.drop.into', { name });
    if (!b.isConnected) document.body.append(b);
    // The chip rides with the pointer, which is where the eye already is; a touch drag has no
    // pointer coordinates, so it falls back to the target's own centre.
    const r = el.getBoundingClientRect();
    const x = at?.x ?? r.left + r.width / 2;
    const y = at?.y ?? r.top + Math.min(r.height / 2, 72);
    // Clamped to the viewport: on a phone the target can sit right against the edge.
    b.style.left = `${Math.round(Math.min(Math.max(x, 16), window.innerWidth - 16))}px`;
    b.style.top = `${Math.round(Math.min(Math.max(y - 26, 16), window.innerHeight - 16))}px`;
  };

  const hideBadge = () => { badge?.remove(); };

  const highlight = (el: HTMLElement | null, name?: string, at?: { x: number; y: number }) => {
    if (highlighted === el) {
      if (el && name) showBadge(el, name, at); // the label can change while the ring stays put
      return;
    }
    highlighted?.classList.remove('faisal-drop-target');
    highlighted = el;
    if (!el) { hideBadge(); return; }
    el.classList.add('faisal-drop-target');
    showBadge(el, name ?? t('shell.drop.here'), at);
  };
  const surface = () => document.querySelector<HTMLElement>('.faisal-desktop-surface');

  const highlightFor = (place: DropPlace): HTMLElement | null => {
    switch (place.kind) {
      case 'window': return place.windowEl;
      case 'desktop': return surface();
      case 'desktopPath':
      case 'desktopApp': return document.querySelector<HTMLElement>(
        place.kind === 'desktopPath'
          ? `.faisal-desktop-icon[data-path="${CSS.escape(place.path)}"]`
          : `.faisal-desktop-icon[data-app-id="${CSS.escape(place.appId)}"]`);
      default: return null;
    }
  };

  window.addEventListener('dragover', (ev) => {
    const internal = isInternalDrag(ev.dataTransfer);
    if (!internal && !isExternalFileDrag(ev.dataTransfer)) return;
    // The Files app accepted it over its own view: it owns the effect and the highlight.
    if (ev.defaultPrevented) { highlight(null); return; }
    const place = dropPlace(ev.target as Element | null);
    // An internal drag only lands where files live; an OS drop keeps its old "everything lands"
    // rule, so the browser can never navigate to the dropped file in place of the whole OS.
    if (internal && !dropDirFor(place, DESKTOP)) {
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'none';
      highlight(null);
      return;
    }
    ev.preventDefault();
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = internal ? 'move' : (place.kind === 'ignore' ? 'none' : 'copy');
    }
    if (place.kind === 'ignore') { highlight(null); return; }
    const el = highlightFor(place);
    if (!el) { highlight(null); return; }
    // The chip names where the files would land, so the drop is readable without a cursor.
    const name = place.kind === 'desktop' ? t('shell.drop.desktop') : dropTargetLabel(el, t('shell.drop.here'));
    highlight(el, name, { x: ev.clientX, y: ev.clientY });
  });
  window.addEventListener('dragleave', (ev) => {
    // Leaving the page (relatedTarget null) clears the highlight.
    if (!ev.relatedTarget) highlight(null);
  });
  window.addEventListener('dragend', () => highlight(null));

  window.addEventListener('drop', (ev) => {
    highlight(null);
    const dt = ev.dataTransfer;
    if (!dt) return;
    const internal = isInternalDrag(dt);
    if (!internal && !isExternalFileDrag(dt)) return;
    const handled = ev.defaultPrevented; // the Files app already took it
    ev.preventDefault();
    if (handled) return;
    const place = dropPlace(ev.target as Element | null);
    if (internal) {
      const dir = dropDirFor(place, DESKTOP);
      if (!dir) return;
      const paths = dragPaths(dt);
      if (paths.length) void transferInto(dir, paths);
      return;
    }
    if (place.kind === 'ignore') return;
    const src = captureDrop(dt);
    void land(place, src);
  });

  /**
   * An internal drop: ask what the owner wants *before* touching anything, then copy or move
   * every dragged entry into `dir`. Cancelling leaves the file system exactly as it was.
   */
  async function transferInto(dir: string, paths: string[]): Promise<void> {
    const st = await sys.vfs.stat(dir).catch(() => null);
    if (st?.type !== 'dir') {
      sys.notify(t('shell.dnd.refused'), t('shell.dnd.refusedNotDirectory'));
      return;
    }
    const mode = await askTransfer(paths);
    if (!mode) return; // cancelled: nothing moved, nothing copied

    const suffix = t('shell.drop.copy');
    let done = 0;
    let refused: DropRefusal | null = null;
    for (const path of paths) {
      const r = await transferEntry(sys.vfs, path, dir, mode, suffix);
      if (r.ok) done++; else refused ??= r.reason;
    }
    const names = paths.map((p) => basename(p)).join(sys.locale() === 'ar' ? '، ' : ', ');
    if (done) sys.notify(t(mode === 'copy' ? 'shell.dnd.copied' : 'shell.dnd.moved', { place: placeName(dir) }), names);
    if (refused) sys.notify(t('shell.dnd.refused'), t(refusedKey(refused)));
  }

  async function land(place: DropPlace, src: DropSource): Promise<void> {
    let dir = DESKTOP;
    let openWith: string | null = null;
    let openEach = false;
    if (place.kind === 'desktopPath') {
      const st = await sys.vfs.stat(place.path).catch(() => null);
      if (st?.type === 'dir') dir = place.path;
    } else if (place.kind === 'desktopApp') {
      openWith = place.appId;
    } else if (place.kind === 'window') {
      dir = DOWNLOADS;
      openEach = true;
    }
    try {
      await sys.vfs.mkdir(dir, { recursive: true });
      const result = await saveDropped(sys.vfs, dir, await collectFiles(src), t('shell.drop.copy'));
      const count = result.saved.length;
      if (count) sys.notify(t('shell.drop.saved', { place: placeName(dir) }), result.saved.map((p) => p.slice(dir.length + 1)).join(sys.locale() === 'ar' ? '، ' : ', '));
      if (result.failed) sys.notify(t('shell.drop.failed', { count: result.failed }), errorText(result.error, sys.vfs.quota));
      if (openWith) {
        const first = result.files[0];
        if (first) await sys.apps.launch(openWith, [first]).catch(() => {});
      } else if (openEach) {
        for (const path of result.saved.slice(0, MAX_OPEN)) {
          const app = sys.apps.appForFile(path);
          if (app && result.files.includes(path)) await sys.apps.launch(app.id, [path]).catch(() => {});
        }
      }
    } catch (err) {
      sys.notify(t('shell.drop.failed', { count: src.files.length || src.entries.length }), errorText(err, sys.vfs.quota));
    }
  }

  function placeName(dir: string): string {
    if (dir === DESKTOP) return t('shell.drop.desktop');
    if (dir === DOWNLOADS) return t('shell.drop.downloads');
    return dir.slice(dir.lastIndexOf('/') + 1);
  }
}

function errorText(err: unknown, quota: VFS['quota']): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  // Name the limit the user actually hit, using the numbers in force on this platform.
  return /quota/i.test(msg)
    ? t('shell.drop.quota', { file: formatBytes(quota.file), total: formatBytes(quota.total) })
    : msg;
}
