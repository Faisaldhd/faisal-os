import type { AppManifest, Stat, SystemAPI, SystemEvents, WindowManager } from '../kernel/types';
import { HOME } from '../kernel/types';
import { join, normalize } from '../kernel/path';
import { t } from '../kernel/i18n';
import { renderIcon } from './icon';
import { showContextMenu, wireContextMenu, type ContextMenuItem } from './contextmenu';
import { shellConfirm } from './dialog';

const DESKTOP_KEY = 'shell.desktop';
const DASH_KEY = 'shell.dash';
const DEFAULT_DESKTOP_IDS = ['org.faisal.Files', 'org.faisal.Browser', 'org.faisal.Terminal'];

const NOT_SET: unique symbol = Symbol('not-set');

/** The file manager: opens folders, and is the fallback for files with no registered handler. */
export const FILES_APP_ID = 'org.faisal.Files';

/** One VFS entry on the desktop surface: a file or a folder inside `~/Desktop`. */
export interface DesktopEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
}

/**
 * Pure: the desktop's file tiles, folders first and then by localized name.
 * `readdir` order is filesystem order, which is not a user-meaningful order.
 */
export function desktopEntries(stats: readonly Stat[], locale: string): DesktopEntry[] {
  return stats
    .filter((s) => s.type === 'file' || s.type === 'dir')
    .map((s) => ({ path: s.path, name: s.name, type: s.type }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, locale);
    });
}

/** Pure: whether `path` is `dir` itself or a direct child of it (never a deeper descendant). */
export function isDirectChild(dir: string, path: string): boolean {
  const d = normalize(dir);
  const p = normalize(path);
  if (p === d) return true;
  const prefix = d === '/' ? '/' : `${d}/`;
  if (!p.startsWith(prefix)) return false;
  return !p.slice(prefix.length).includes('/');
}

/**
 * Pure: whether an `fs:change` event affects the desktop's own folder.
 * A rename matters on both ends: a file moved into `~/Desktop` reports `path` there
 * while a file moved out of it only reports the old location.
 */
export function isDesktopChange(dir: string, ev: SystemEvents['fs:change']): boolean {
  return isDirectChild(dir, ev.path) || (ev.oldPath !== undefined && isDirectChild(dir, ev.oldPath));
}

/** Extensions that open in an image app, and ones treated as text documents. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const DOCUMENT_EXTENSIONS = new Set(['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'sh', 'conf', 'log', 'yml', 'yaml', 'csv']);

/** Pure: the built-in icon for a desktop entry, matched by folder or file extension. */
export function desktopIcon(entry: DesktopEntry): string {
  if (entry.type === 'dir') return ICON_FOLDER;
  const dot = entry.name.lastIndexOf('.');
  const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '';
  if (IMAGE_EXTENSIONS.has(ext)) return ICON_IMAGE;
  if (DOCUMENT_EXTENSIONS.has(ext)) return ICON_DOC;
  return ICON_FILE;
}

/** Pure: drops anything that is not a string id of an installed app, de-duplicated, order preserved. */
export function sanitizeAppIdList(raw: unknown, installedIds: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const installed = new Set(installedIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x === 'string' && installed.has(x) && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function installedIds(sys: SystemAPI): string[] {
  return sys.apps.list().map((a) => a.id);
}

/** Pinned desktop shortcuts. Defaults to Files, Browser, Terminal on first run. */
export function getDesktopIds(sys: SystemAPI): string[] {
  const ids = installedIds(sys);
  const raw = sys.settings.get<unknown>(DESKTOP_KEY, NOT_SET);
  if (raw === NOT_SET) return DEFAULT_DESKTOP_IDS.filter((id) => ids.includes(id));
  return sanitizeAppIdList(raw, ids);
}

export function setDesktopIds(sys: SystemAPI, ids: string[]): void {
  sys.settings.set(DESKTOP_KEY, sanitizeAppIdList(ids, installedIds(sys)));
}

export function isOnDesktop(sys: SystemAPI, appId: string): boolean {
  return getDesktopIds(sys).includes(appId);
}

export function addToDesktop(sys: SystemAPI, appId: string): void {
  const ids = getDesktopIds(sys);
  if (!ids.includes(appId)) setDesktopIds(sys, [...ids, appId]);
}

export function removeFromDesktop(sys: SystemAPI, appId: string): void {
  setDesktopIds(sys, getDesktopIds(sys).filter((id) => id !== appId));
}

/** Dock favourites. Defaults to the full installed-app list, in its current order. */
export function getDashIds(sys: SystemAPI): string[] {
  const ids = installedIds(sys);
  const raw = sys.settings.get<unknown>(DASH_KEY, NOT_SET);
  if (raw === NOT_SET) return ids;
  return sanitizeAppIdList(raw, ids);
}

export function setDashIds(sys: SystemAPI, ids: string[]): void {
  sys.settings.set(DASH_KEY, sanitizeAppIdList(ids, installedIds(sys)));
}

export function isInDash(sys: SystemAPI, appId: string): boolean {
  return getDashIds(sys).includes(appId);
}

export function addToDash(sys: SystemAPI, appId: string): void {
  const ids = getDashIds(sys);
  if (!ids.includes(appId)) setDashIds(sys, [...ids, appId]);
}

export function removeFromDash(sys: SystemAPI, appId: string): void {
  setDashIds(sys, getDashIds(sys).filter((id) => id !== appId));
}

/** Alphabetises the desktop grid by the app's localized name. */
export function arrangeDesktopIcons(sys: SystemAPI): void {
  const apps = new Map(sys.apps.list().map((a) => [a.id, a] as const));
  const loc = sys.locale();
  const ids = getDesktopIds(sys).slice().sort((a, b) => {
    const an = apps.get(a)?.name[loc] ?? a;
    const bn = apps.get(b)?.name[loc] ?? b;
    return an.localeCompare(bn, loc);
  });
  setDesktopIds(sys, ids);
}

/** Finds a non-conflicting name like "New folder", "New folder (2)", ... in `dir`. */
export async function uniqueFolderName(sys: SystemAPI, dir: string, base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await sys.vfs.exists(join(dir, candidate))) {
    candidate = `${base} (${n})`;
    n += 1;
  }
  return candidate;
}

/** Whether a running instance of the app already has a window open. */
function isRunning(sys: SystemAPI, appId: string): boolean {
  try {
    return sys.apps.running().some((r) => r.appId === appId);
  } catch {
    return false;
  }
}

const ICON_OPEN =
  '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.4 1.6H12.5A1.5 1.5 0 0 1 14 6.1v6.4A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const ICON_NEW_WINDOW =
  '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 6.2h11" stroke="currentColor" stroke-width="1.3"/></svg>';
const ICON_PIN =
  '<svg viewBox="0 0 16 16"><path d="M8 1.5l1.5 3.6 3.9.4-3 2.6.9 3.9L8 10l-3.3 2 .9-3.9-3-2.6 3.9-.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const ICON_UNPIN =
  '<svg viewBox="0 0 16 16"><path d="M8 1.5l1.5 3.6 3.9.4-3 2.6.9 3.9L8 10l-3.3 2 .9-3.9-3-2.6 3.9-.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2 2l12 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_INFO =
  '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.2v4M8 5.1v.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.3 4.5V3a1 1 0 0 1 1-1h1.4a1 1 0 0 1 1 1v1.5M4.3 4.5l.6 8.4a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FOLDER =
  '<svg viewBox="0 0 16 16"><path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.9l1.2 1.4H12.8A1.2 1.2 0 0 1 14 5.6v6.2A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const ICON_DOC =
  '<svg viewBox="0 0 16 16"><path d="M3.5 1.8h5.2L12.5 5.6v8.6a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8.5 2v3.8h3.8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5 8.4h6M5 10.6h6M5 12.8h3.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
const ICON_IMAGE =
  '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5.6" cy="6.2" r="1.1" fill="currentColor"/><path d="M2.6 11.6 6 8.4l2.2 2 2.1-1.8 3 2.9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const ICON_FILE =
  '<svg viewBox="0 0 16 16"><path d="M3.5 1.8h5.2L12.5 5.6v8.6a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8.5 2v3.8h3.8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

/** Opens the Store's app-detail page for `appId`, closing an already-open Store window first (singleInstance can't take new args otherwise). */
async function openAppDetails(sys: SystemAPI, appId: string): Promise<void> {
  try {
    for (const r of sys.apps.running()) {
      if (r.appId === 'org.faisal.Store') sys.apps.closeWindow(r.windowId);
    }
  } catch { /* no system:monitor in a scoped context; shell always has it */ }
  await sys.apps.launch('org.faisal.Store', ['app', appId]);
}

/** Builds the shared "Uninstall" confirm-and-act flow. Returns undefined if the app is core (no item shown). */
function uninstallItem(sys: SystemAPI, app: AppManifest, onDone?: () => void): ContextMenuItem | null {
  if (app.core) return null;
  return {
    label: t('shell.ctx.uninstall'),
    icon: ICON_TRASH,
    danger: true,
    action: () => {
      void (async () => {
        const ok = await shellConfirm({
          title: t('shell.uninstall.title', { name: app.name[sys.locale()] }),
          message: t('shell.uninstall.body', { name: app.name[sys.locale()] }),
          okLabel: t('shell.uninstall.confirm'),
          cancelLabel: t('shell.uninstall.cancel'),
          danger: true,
        });
        if (!ok) return;
        sys.apps.uninstall(app.id);
        removeFromDesktop(sys, app.id);
        removeFromDash(sys, app.id);
        sys.notify(t('shell.uninstall.done', { name: app.name[sys.locale()] }));
        onDone?.();
      })();
    },
  };
}

/** Context menu for an app tile (Activities grid or dock). */
export function appTileMenuItems(
  sys: SystemAPI,
  app: AppManifest,
  opts: { onChange?: () => void; onLaunch?: () => void } = {},
): ContextMenuItem[] {
  const onDesktop = isOnDesktop(sys, app.id);
  const inDash = isInDash(sys, app.id);
  const items: ContextMenuItem[] = [
    { label: t('shell.ctx.open'), icon: ICON_OPEN, action: () => { opts.onLaunch?.(); void sys.apps.launch(app.id); } },
    {
      label: t('shell.ctx.newWindow'),
      icon: ICON_NEW_WINDOW,
      disabled: !!app.singleInstance && isRunning(sys, app.id),
      action: () => { opts.onLaunch?.(); void sys.apps.launch(app.id); },
    },
    {
      label: t(onDesktop ? 'shell.ctx.removeFromDesktop' : 'shell.ctx.addToDesktop'),
      icon: onDesktop ? ICON_UNPIN : ICON_PIN,
      action: () => {
        if (onDesktop) removeFromDesktop(sys, app.id); else addToDesktop(sys, app.id);
        opts.onChange?.();
      },
    },
    {
      label: t(inDash ? 'shell.ctx.removeFromDash' : 'shell.ctx.addToDash'),
      icon: inDash ? ICON_UNPIN : ICON_PIN,
      action: () => {
        if (inDash) removeFromDash(sys, app.id); else addToDash(sys, app.id);
        opts.onChange?.();
      },
    },
    {
      label: t('shell.ctx.appDetails'),
      icon: ICON_INFO,
      action: () => { opts.onLaunch?.(); void openAppDetails(sys, app.id); },
    },
  ];
  const uninstall = uninstallItem(sys, app, opts.onChange);
  if (uninstall) items.push({ separator: true }, uninstall);
  return items;
}

/** Context menu for a desktop icon. */
export function desktopIconMenuItems(sys: SystemAPI, app: AppManifest, opts: { onChange?: () => void } = {}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: t('shell.ctx.open'), icon: ICON_OPEN, action: () => void sys.apps.launch(app.id) },
    {
      label: t('shell.ctx.removeFromDesktop'),
      icon: ICON_UNPIN,
      action: () => { removeFromDesktop(sys, app.id); opts.onChange?.(); },
    },
    { label: t('shell.ctx.appDetails'), icon: ICON_INFO, action: () => void openAppDetails(sys, app.id) },
  ];
  const uninstall = uninstallItem(sys, app, opts.onChange);
  if (uninstall) items.push(uninstall);
  return items;
}

/** Actions a desktop file tile's menu can invoke. */
export interface DesktopEntryActions {
  open: () => void;
  /** Omitted for folders, where Open already opens the file manager at that folder. */
  openInFiles?: () => void;
  remove: () => void;
}

/** Context menu for a file or folder tile on the desktop. */
export function desktopFileMenuItems(entry: DesktopEntry, actions: DesktopEntryActions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: t('shell.ctx.open'), icon: ICON_OPEN, action: actions.open },
  ];
  if (actions.openInFiles) items.push({ label: t('shell.ctx.openInFiles'), icon: ICON_FOLDER, action: actions.openInFiles });
  items.push(
    { separator: true },
    { label: t('shell.ctx.delete'), icon: ICON_TRASH, danger: true, action: actions.remove },
  );
  return items;
}

export interface Desktop {
  refresh(): void;
  dispose(): void;
}

export function mountDesktop(root: HTMLElement, sys: SystemAPI, _wm: WindowManager): Desktop {
  const surface = root.querySelector<HTMLElement>('.faisal-desktop-surface') ?? root;
  const dir = join(HOME, 'Desktop');

  const layer = document.createElement('div');
  layer.className = 'faisal-desktop-icons';
  layer.setAttribute('role', 'list');
  surface.prepend(layer);

  /** Selection key: `app:<id>` for a shortcut, `path:<absolute>` for a VFS entry. */
  let selected: string | null = null;
  let entries: Stat[] = [];
  /** Guards against an older `readdir` landing after a newer one (same pattern as apps/images). */
  let loadToken = 0;

  function appOf(id: string): AppManifest | undefined {
    return sys.apps.list().find((a) => a.id === id);
  }

  function tileKey(el: Element): string | null {
    const appId = el.getAttribute('data-app-id');
    if (appId) return `app:${appId}`;
    const path = el.getAttribute('data-path');
    return path ? `path:${path}` : null;
  }

  function selectOnly(key: string | null) {
    selected = key;
    for (const el of layer.querySelectorAll('.faisal-desktop-icon')) {
      el.classList.toggle('is-selected', tileKey(el) === key);
    }
  }

  const filesAppId = () => sys.apps.list().find((m) => m.id === FILES_APP_ID)?.id;

  /** Opens the file manager at `path` (a folder, or a file's folder when nothing handles it). */
  async function openInFiles(path: string): Promise<void> {
    const id = filesAppId();
    if (id) await sys.apps.launch(id, [path]);
  }

  async function openEntry(entry: DesktopEntry): Promise<void> {
    if (entry.type === 'dir') { await openInFiles(entry.path); return; }
    const handler = sys.apps.appForFile(entry.path)?.id;
    if (handler) { await sys.apps.launch(handler, [entry.path]); return; }
    // No app claims this extension: show the file in Files instead of doing nothing.
    await openInFiles(dir);
  }

  async function deleteEntry(entry: DesktopEntry): Promise<void> {
    const ok = await shellConfirm({
      title: t('shell.fileDelete.title', { name: entry.name }),
      message: t(entry.type === 'dir' ? 'shell.fileDelete.folderBody' : 'shell.fileDelete.fileBody'),
      okLabel: t('shell.ctx.delete'),
      cancelLabel: t('shell.uninstall.cancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      await sys.vfs.remove(entry.path, { recursive: entry.type === 'dir' });
    } catch {
      sys.notify(t('shell.fileDelete.failed', { name: entry.name }));
      return;
    }
    await loadEntries();
  }

  interface Tile {
    key: string;
    label: string;
    icon: string;
    dataset: Record<string, string>;
    extraClass?: string;
    onOpen: () => void;
    onMenu: (x: number, y: number, tile: HTMLElement) => void;
  }

  function addTile(opts: Tile): void {
    const item = document.createElement('div');
    item.className = 'faisal-desktop-icon'
      + (opts.extraClass ? ` ${opts.extraClass}` : '')
      + (opts.key === selected ? ' is-selected' : '');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    for (const [k, v] of Object.entries(opts.dataset)) item.dataset[k] = v;
    item.setAttribute('aria-label', opts.label);

    const iconWrap = document.createElement('span');
    iconWrap.className = 'faisal-desktop-icon-img';
    iconWrap.append(renderIcon(opts.icon));

    const label = document.createElement('span');
    label.className = 'faisal-desktop-icon-label';
    label.textContent = opts.label;

    item.append(iconWrap, label);

    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectOnly(opts.key);
    });
    item.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      opts.onOpen();
    });
    item.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        opts.onOpen();
      }
    });
    item.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      selectOnly(opts.key);
      opts.onMenu(ev.clientX, ev.clientY, item);
    });

    layer.append(item);
  }

  function render() {
    layer.textContent = '';
    const loc = sys.locale();

    for (const id of getDesktopIds(sys)) {
      const app = appOf(id);
      if (!app) continue;
      addTile({
        key: `app:${id}`,
        label: app.name[loc],
        icon: app.icon,
        dataset: { appId: id },
        onOpen: () => void sys.apps.launch(id),
        onMenu: (x, y, tile) => showContextMenu(x, y, desktopIconMenuItems(sys, app, { onChange: render }), { invoker: tile }),
      });
    }

    for (const entry of desktopEntries(entries, loc)) {
      addTile({
        key: `path:${entry.path}`,
        label: entry.name,
        icon: desktopIcon(entry),
        dataset: { path: entry.path },
        extraClass: entry.type === 'dir' ? 'is-folder' : 'is-file',
        onOpen: () => void openEntry(entry),
        onMenu: (x, y, tile) => showContextMenu(x, y, desktopFileMenuItems(entry, {
          open: () => void openEntry(entry),
          openInFiles: entry.type === 'dir' ? undefined : () => void openInFiles(dir),
          remove: () => void deleteEntry(entry),
        }), { invoker: tile }),
      });
    }
  }

  /** Re-reads `~/Desktop` and repaints. App shortcuts render first, so they never wait on the VFS. */
  async function loadEntries(): Promise<void> {
    const token = ++loadToken;
    let next: Stat[] = [];
    try {
      next = await sys.vfs.readdir(dir);
    } catch {
      next = []; // missing or unreadable Desktop: the pinned shortcuts still stand
    }
    if (token !== loadToken) return; // a newer refresh already landed
    entries = next;
    render();
  }

  layer.addEventListener('click', (ev) => {
    if (ev.target === layer) selectOnly(null);
  });

  const unsubApps = sys.bus.on('apps:changed', render);
  const unsubSettings = sys.bus.on('settings:change', ({ key }) => {
    if (key === DESKTOP_KEY) render();
  });
  // `~/Desktop` is a VFS folder: anything written to it (Files uploads, the Terminal,
  // "New folder" here) repaints the surface. Deeper descendants do not affect the grid.
  const unsubFs = sys.bus.on('fs:change', (ev) => {
    if (isDesktopChange(dir, ev)) void loadEntries();
  });

  // Right-click / long-press on the empty desktop (not on a window or an icon).
  const unwireMenu = wireContextMenu(
    surface,
    (x, y) => {
      selectOnly(null);
      showContextMenu(x, y, desktopBackgroundMenuItems(sys, { onArranged: render }), { invoker: surface });
    },
    { exclude: (target) => target instanceof Element && !!target.closest('.faisal-window, .faisal-desktop-icon') },
  );

  // Shortcuts paint synchronously; the folder's contents arrive with the first readdir.
  render();
  void loadEntries();

  return {
    refresh: () => void loadEntries(),
    dispose: () => { unsubApps(); unsubSettings(); unsubFs(); unwireMenu(); },
  };
}

/** The desktop background's own context menu (right-click on empty desktop). */
export async function newFolderOnDesktop(sys: SystemAPI): Promise<void> {
  const dir = join(HOME, 'Desktop');
  const base = t('shell.desktop.newFolder');
  const name = await uniqueFolderName(sys, dir, base);
  await sys.vfs.mkdir(join(dir, name));
}

const ICON_TERMINAL =
  '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 6.2 6.6 8 4 9.8M8 10.5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_NEW_FOLDER =
  '<svg viewBox="0 0 16 16"><path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.9l1.2 1.4H12.8A1.2 1.2 0 0 1 14 5.6v6.2A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 6.5v3.4M6.3 8.2h3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ICON_WALLPAPER =
  '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.2" cy="6" r="1.1" fill="currentColor"/><path d="M2.5 11.5 6 8l2.3 2.1L11 7l2.5 3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const ICON_DISPLAY =
  '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.8a5.2 5.2 0 0 1 0 10.4z" fill="currentColor"/></svg>';
const ICON_GRID =
  '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="4.6" height="4.6" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9.4" y="2" width="4.6" height="4.6" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="2" y="9.4" width="4.6" height="4.6" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9.4" y="9.4" width="4.6" height="4.6" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
const ICON_ABOUT =
  '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="5.3" r="0.9" fill="currentColor"/><path d="M8 7.6v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

export interface DesktopBackgroundMenuOptions {
  onArranged?: () => void;
}

/** Builds the context-menu items for a right-click on the desktop background itself. */
export function desktopBackgroundMenuItems(sys: SystemAPI, opts: DesktopBackgroundMenuOptions = {}): ContextMenuItem[] {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.hasAttribute('data-theme')
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return [
    { label: t('shell.ctx.openFiles'), icon: ICON_FOLDER, action: () => void sys.apps.launch('org.faisal.Files') },
    { label: t('shell.ctx.openTerminal'), icon: ICON_TERMINAL, action: () => void sys.apps.launch('org.faisal.Terminal') },
    { label: t('shell.ctx.newFolder'), icon: ICON_NEW_FOLDER, action: () => void newFolderOnDesktop(sys) },
    {
      label: t('shell.ctx.changeBackground'),
      icon: ICON_WALLPAPER,
      action: () => void sys.apps.launch('org.faisal.Settings', ['appearance']),
    },
    {
      label: t(isDark ? 'shell.ctx.displayLight' : 'shell.ctx.displayDark'),
      icon: ICON_DISPLAY,
      action: () => sys.settings.set('theme', isDark ? 'light' : 'dark'),
    },
    {
      label: t('shell.ctx.arrangeIcons'),
      icon: ICON_GRID,
      action: () => { arrangeDesktopIcons(sys); opts.onArranged?.(); },
    },
    { separator: true },
    { label: t('shell.ctx.about'), icon: ICON_ABOUT, action: () => void sys.apps.launch('org.faisal.Settings', ['about']) },
  ];
}
