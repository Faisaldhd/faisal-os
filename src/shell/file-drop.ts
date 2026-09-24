/**
 * Drag & drop from the real computer into Fai$al OS (السحب والإفلات من الجهاز).
 *
 * Drop files or whole folders anywhere:
 *   - on the desktop                → saved in ~/Desktop
 *   - on a folder icon on the desktop → saved inside that folder
 *   - on an app icon on the desktop → saved in ~/Desktop and opened with that app
 *   - on any app window            → saved in ~/Downloads and opened with the matching app
 *   - inside the Files app view    → that app saves them into the folder it shows
 * Files never replaces its own drop handling: an event it already handled is left alone.
 * The page itself never navigates to a dropped file (the browser's default), which
 * would close the whole OS.
 */
import type { SystemAPI, VFS } from '../kernel/types';
import { HOME } from '../kernel/types';
import { dirname, join } from '../kernel/path';
import { t } from '../kernel/i18n';
import { uniqueName } from '../apps/files/copy';

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

/* ─────────────────────────────── the service ─────────────────────────────── */

const DESKTOP = join(HOME, 'Desktop');
const DOWNLOADS = join(HOME, 'Downloads');
/** Opening more windows than this from one drop would bury the screen. */
const MAX_OPEN = 5;

export function mountFileDrop(sys: SystemAPI): void {
  let highlighted: HTMLElement | null = null;
  const highlight = (el: HTMLElement | null) => {
    if (highlighted === el) return;
    highlighted?.classList.remove('faisal-drop-target');
    highlighted = el;
    el?.classList.add('faisal-drop-target');
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
    if (!isExternalFileDrag(ev.dataTransfer)) return;
    // The Files app accepted it over its own view: it owns the effect and the highlight.
    if (ev.defaultPrevented) { highlight(null); return; }
    // Always accept: otherwise the browser would open the file in place of the whole OS.
    ev.preventDefault();
    const place = dropPlace(ev.target as Element | null);
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = place.kind === 'ignore' ? 'none' : 'copy';
    highlight(highlightFor(place));
  });
  window.addEventListener('dragleave', (ev) => {
    // Leaving the page (relatedTarget null) clears the highlight.
    if (!ev.relatedTarget) highlight(null);
  });
  window.addEventListener('dragend', () => highlight(null));

  window.addEventListener('drop', (ev) => {
    highlight(null);
    if (!isExternalFileDrag(ev.dataTransfer)) return;
    const handled = ev.defaultPrevented; // the Files app already took it
    ev.preventDefault();
    if (handled || !ev.dataTransfer) return;
    const place = dropPlace(ev.target as Element | null);
    if (place.kind === 'ignore') return;
    const src = captureDrop(ev.dataTransfer);
    void land(place, src);
  });

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
      if (result.failed) sys.notify(t('shell.drop.failed', { count: result.failed }), errorText(result.error));
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
      sys.notify(t('shell.drop.failed', { count: src.files.length || src.entries.length }), errorText(err));
    }
  }

  function placeName(dir: string): string {
    if (dir === DESKTOP) return t('shell.drop.desktop');
    if (dir === DOWNLOADS) return t('shell.drop.downloads');
    return dir.slice(dir.lastIndexOf('/') + 1);
  }
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /quota/i.test(msg) ? t('shell.drop.quota') : msg;
}
