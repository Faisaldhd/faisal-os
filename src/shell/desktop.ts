import type { AppManifest, SystemAPI, WindowManager } from '../kernel/types';
import { HOME } from '../kernel/types';
import { join } from '../kernel/path';
import { t } from '../kernel/i18n';
import { renderIcon } from './icon';
import { showContextMenu, wireContextMenu, type ContextMenuItem } from './contextmenu';
import { shellConfirm } from './dialog';

const DESKTOP_KEY = 'shell.desktop';
const DASH_KEY = 'shell.dash';
const DEFAULT_DESKTOP_IDS = ['org.faisal.Files', 'org.faisal.Browser', 'org.faisal.Terminal'];

const NOT_SET: unique symbol = Symbol('not-set');

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

export interface Desktop {
  refresh(): void;
  dispose(): void;
}

export function mountDesktop(root: HTMLElement, sys: SystemAPI, _wm: WindowManager): Desktop {
  const surface = root.querySelector<HTMLElement>('.faisal-desktop-surface') ?? root;

  const layer = document.createElement('div');
  layer.className = 'faisal-desktop-icons';
  layer.setAttribute('role', 'list');
  surface.prepend(layer);

  let selected: string | null = null;

  function appOf(id: string): AppManifest | undefined {
    return sys.apps.list().find((a) => a.id === id);
  }

  function selectOnly(id: string | null) {
    selected = id;
    for (const el of layer.querySelectorAll('.faisal-desktop-icon')) {
      el.classList.toggle('is-selected', el.getAttribute('data-app-id') === id);
    }
  }

  function render() {
    layer.textContent = '';
    const ids = getDesktopIds(sys);
    ids.forEach((id) => {
      const app = appOf(id);
      if (!app) return;
      const item = document.createElement('div');
      item.className = 'faisal-desktop-icon' + (id === selected ? ' is-selected' : '');
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.dataset.appId = id;
      item.setAttribute('aria-label', app.name[sys.locale()]);

      const iconWrap = document.createElement('span');
      iconWrap.className = 'faisal-desktop-icon-img';
      iconWrap.append(renderIcon(app.icon));

      const label = document.createElement('span');
      label.className = 'faisal-desktop-icon-label';
      label.textContent = app.name[sys.locale()];

      item.append(iconWrap, label);

      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectOnly(id);
      });
      item.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        void sys.apps.launch(id);
      });
      item.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          void sys.apps.launch(id);
        }
      });
      item.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        selectOnly(id);
        showContextMenu(ev.clientX, ev.clientY, desktopIconMenuItems(sys, app, { onChange: render }), { invoker: item });
      });

      layer.append(item);
    });
  }

  layer.addEventListener('click', (ev) => {
    if (ev.target === layer) selectOnly(null);
  });

  const unsubApps = sys.bus.on('apps:changed', render);
  const unsubSettings = sys.bus.on('settings:change', ({ key }) => {
    if (key === DESKTOP_KEY) render();
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

  render();

  return {
    refresh: render,
    dispose: () => { unsubApps(); unsubSettings(); unwireMenu(); },
  };
}

/** The desktop background's own context menu (right-click on empty desktop). */
export async function newFolderOnDesktop(sys: SystemAPI): Promise<void> {
  const dir = join(HOME, 'Desktop');
  const base = t('shell.desktop.newFolder');
  const name = await uniqueFolderName(sys, dir, base);
  await sys.vfs.mkdir(join(dir, name));
}

const ICON_FOLDER =
  '<svg viewBox="0 0 16 16"><path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.9l1.2 1.4H12.8A1.2 1.2 0 0 1 14 5.6v6.2A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
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
