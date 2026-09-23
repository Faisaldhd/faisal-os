import type {
  AppCategory, AppModule, AppRegistry, AppManifest, EventBus, LazyAppModule, Permission, SystemAPI, SystemEvents,
  VFS, WindowHandle, WindowManager,
} from './types';
import { HOME, VFSError } from './types';
import { normalize } from './path';

const within = (p: string, root: string) => p === root || p.startsWith(root + '/');

/**
 * Restricts an app's file-system access to its permissions (enforced by the kernel, not by the app).
 *  - fs:system   → full read/write.
 *  - fs:home     → read/write under /home/user and /tmp.
 *  - fs:read-all → read anywhere (writes still follow fs:home).
 *  - none        → EACCES for every operation.
 */
export function fsAccess(perms: readonly Permission[]) {
  const all = perms.includes('fs:system');
  const canWrite = (p: string) => {
    const n = normalize(p);
    return all || (perms.includes('fs:home') && (within(n, HOME) || within(n, '/tmp')));
  };
  const canRead = (p: string) => all || perms.includes('fs:read-all') || canWrite(p);
  return { canRead, canWrite };
}

export function scopeVFS(vfs: VFS, perms: readonly Permission[]): VFS {
  if (perms.includes('fs:system')) return vfs;
  const { canRead, canWrite } = fsAccess(perms);
  const deny = (p: string) => { throw new VFSError('EACCES', normalize(p), `EACCES: permission denied: ${normalize(p)}`); };
  const r = (p: string) => { if (!canRead(p)) deny(p); };
  const w = (p: string) => { if (!canWrite(p)) deny(p); };

  return {
    async stat(p) { r(p); return vfs.stat(p); },
    async exists(p) { r(p); return vfs.exists(p); },
    async readdir(p) { r(p); return vfs.readdir(p); },
    async readFile(p) { r(p); return vfs.readFile(p); },
    async readText(p) { r(p); return vfs.readText(p); },
    async writeFile(p, d) { w(p); return vfs.writeFile(p, d); },
    async mkdir(p, o) { w(p); return vfs.mkdir(p, o); },
    async remove(p, o) { w(p); return vfs.remove(p, o); },
    async rename(a, b) { w(a); w(b); return vfs.rename(a, b); },
    async chmod(p, m) { w(p); return vfs.chmod(p, m); },
  };
}

/**
 * Apps may listen to events but only receive fs:change for paths they can read,
 * and may not emit system events (no spoofing of fs:change, notify, settings, app lifecycle).
 */
function scopeBus(bus: EventBus, canRead: (p: string) => boolean): EventBus {
  return {
    on(type, handler) {
      if (type !== 'fs:change') return bus.on(type, handler);
      const h = handler as (x: SystemEvents['fs:change']) => void;
      return bus.on('fs:change', (p) => {
        if (canRead(p.path) && (!p.oldPath || canRead(p.oldPath))) h(p);
      });
    },
    emit(type) { throw new Error(`EACCES: apps cannot emit system event '${String(type)}'`); },
  };
}

/** An app sees and controls only its own windows. */
function scopeWM(wm: WindowManager, appId: string): WindowManager {
  return {
    open: (opts) => wm.open({ ...opts, appId }),
    list: () => wm.list().filter((w) => w.appId === appId),
    get: (id) => { const w = wm.get(id); return w?.appId === appId ? w : undefined; },
    focused: () => { const w = wm.focused(); return w?.appId === appId ? w : undefined; },
    isMinimized: (id) => wm.get(id)?.appId === appId && wm.isMinimized(id),
    minimize: (id) => { if (wm.get(id)?.appId === appId) wm.minimize(id); },
    toggleMaximize: (id) => { if (wm.get(id)?.appId === appId) wm.toggleMaximize(id); },
  };
}

const INSTALL_KEY = 'apps.installState';
type InstallState = { removed: string[]; added: string[] };

const KNOWN_PERMISSIONS = new Set<Permission>([
  'fs:home', 'fs:read-all', 'fs:system', 'notifications', 'settings', 'apps:manage', 'system:monitor', 'network',
]);
const KNOWN_CATEGORIES = new Set<AppCategory>(['system', 'utilities', 'accessories', 'media', 'development']);

/**
 * Rejects malformed manifests at registration, so a typo or an unknown permission fails
 * loudly at boot instead of silently granting nothing (or something).
 */
export function validateManifest(m: AppManifest): void {
  const id = m?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`Invalid app id: ${String(id)}`);
  }
  if (typeof m.icon !== 'string') throw new Error(`App ${id}: icon must be a string`);
  for (const lang of ['ar', 'en'] as const) {
    if (typeof m.name?.[lang] !== 'string' || !m.name[lang].trim()) {
      throw new Error(`App ${id}: name.${lang} is required`);
    }
  }
  if (!Array.isArray(m.permissions)) throw new Error(`App ${id}: permissions must be an array`);
  for (const p of m.permissions) {
    if (!KNOWN_PERMISSIONS.has(p)) throw new Error(`App ${id}: unknown permission '${String(p)}'`);
  }
  if (m.category !== undefined && !KNOWN_CATEGORIES.has(m.category)) {
    throw new Error(`App ${id}: unknown category '${String(m.category)}'`);
  }
  if (m.opens !== undefined && (!Array.isArray(m.opens)
    || m.opens.some((e) => typeof e !== 'string' || !e.startsWith('.')))) {
    throw new Error(`App ${id}: opens must hold extensions like ".txt"`);
  }
}

export function createAppRegistry(getSys: () => SystemAPI): AppRegistry {
  /** manifest is frozen at register time; code() loads (once) and returns the app's launch function. */
  type Entry = { manifest: AppManifest; code(): Promise<AppModule['launch']> };
  const apps = new Map<string, Entry>();
  const running = new Map<string, { win: WindowHandle; startedAt: number }[]>();

  const state = (): InstallState => {
    const raw = getSys().settings.get<Partial<InstallState>>(INSTALL_KEY, {});
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { removed: ids(raw.removed), added: ids(raw.added) };
  };
  const saveState = (st: InstallState) => {
    const sys = getSys();
    sys.settings.set(INSTALL_KEY, st);
    sys.bus.emit('apps:changed', {});
  };
  const isInstalled = (m: AppManifest, st = state()) =>
    !!m.core || (m.defaultInstalled === false ? st.added.includes(m.id) : !st.removed.includes(m.id));
  const manifestOf = (id: string) => {
    const a = apps.get(id);
    if (!a) throw new Error(`Unknown app: ${id}`);
    return a.manifest;
  };
  const windowsOf = (id: string) => getSys().wm.list().filter((w) => w.appId === id);

  const registry: AppRegistry = {
    register(app) {
      validateManifest(app.manifest);
      if (apps.has(app.manifest.id)) throw new Error(`App already registered: ${app.manifest.id}`);
      const manifest = Object.freeze({ ...app.manifest });
      let pending: Promise<AppModule['launch']> | null = null;
      const code = 'launch' in app
        ? () => Promise.resolve(app.launch)
        : () => (pending ??= (app as LazyAppModule).load().then((m) => m.launch, (err) => { pending = null; throw err; }));
      apps.set(manifest.id, Object.freeze({ manifest, code }));
    },
    list(): AppManifest[] {
      const st = state();
      return [...apps.values()].map((a) => a.manifest).filter((m) => isInstalled(m, st));
    },
    catalog() {
      const st = state();
      return [...apps.values()].map((a) => ({ ...a.manifest, installed: isInstalled(a.manifest, st) }));
    },
    install(appId) {
      const m = manifestOf(appId);
      const st = state();
      if (isInstalled(m, st)) return;
      saveState({
        removed: st.removed.filter((x) => x !== appId),
        added: m.defaultInstalled === false ? [...st.added, appId] : st.added,
      });
    },
    uninstall(appId) {
      const m = manifestOf(appId);
      if (m.core) throw new Error(`Cannot remove core app: ${appId}`);
      const st = state();
      if (!isInstalled(m, st)) return;
      // Closing the way the user would: an app with unsaved work may refuse.
      windowsOf(appId).forEach((w) => void w.requestClose());
      saveState({
        removed: m.defaultInstalled === false ? st.removed : [...st.removed, appId],
        added: st.added.filter((x) => x !== appId),
      });
    },
    running() {
      return [...running.entries()].flatMap(([appId, rs]) =>
        rs.map((r) => ({ appId, windowId: r.win.id, startedAt: r.startedAt })));
    },
    closeWindow(windowId) {
      const win = getSys().wm.list().find((w) => w.id === windowId);
      void win?.requestClose();
    },
    appForFile(path) {
      const dot = path.lastIndexOf('.');
      const ext = dot > path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : '';
      if (!ext) return undefined;
      return registry.list().find((m) => m.opens?.includes(ext));
    },
    async launch(appId, args = []) {
      const app = apps.get(appId);
      if (!app) throw new Error(`Unknown app: ${appId}`);
      if (!isInstalled(app.manifest)) throw new Error(`App not installed: ${appId}`);
      const sys = getSys();
      const open = running.get(appId) ?? [];
      if (app.manifest.singleInstance && open.length) {
        const win = open[0].win;
        win.focus();
        // Hand the new arguments to the window that is already open instead of dropping them.
        if (args.length) sys.bus.emit('app:activate', { appId, windowId: win.id, args: [...args] });
        return win;
      }

      const win = sys.wm.open({
        appId,
        title: app.manifest.name[sys.locale()],
        icon: app.manifest.icon,
      });
      running.set(appId, [...open, { win, startedAt: Date.now() }]);
      win.onClose(() => {
        running.set(appId, (running.get(appId) ?? []).filter((r) => r.win !== win));
        sys.bus.emit('app:closed', { appId, windowId: win.id });
      });

      const perms = app.manifest.permissions;
      const vfs = scopeVFS(sys.vfs, perms);
      const denied = (what: string) => () => { throw new Error(`EACCES: ${what}`); };
      const scoped: SystemAPI = Object.freeze({
        vfs,
        bus: scopeBus(sys.bus, fsAccess(perms).canRead),
        wm: scopeWM(sys.wm, appId),
        apps: Object.freeze({
          list: registry.list,
          catalog: registry.catalog,
          appForFile: registry.appForFile,
          launch: registry.launch,
          register: denied('apps cannot register apps'),
          install: perms.includes('apps:manage') ? registry.install : denied('apps:manage'),
          uninstall: perms.includes('apps:manage') ? registry.uninstall : denied('apps:manage'),
          running: perms.includes('system:monitor') ? registry.running : denied('system:monitor'),
          closeWindow: perms.includes('system:monitor') ? registry.closeWindow : denied('system:monitor'),
        }),
        // 'apps.*' keys are kernel-owned (install state): only reachable through apps:manage.
        settings: perms.includes('settings')
          ? Object.freeze({
            get: sys.settings.get,
            set: (k: string, v: unknown) => {
              if (k.startsWith('apps.')) throw new Error('EACCES: kernel-owned setting');
              sys.settings.set(k, v);
            },
          })
          : Object.freeze({ get: sys.settings.get, set: denied('settings') }),
        locale: sys.locale,
        t: sys.t,
        // Tagged with the app, so the notification shows its icon and opens it on click.
        notify: perms.includes('notifications') ? (title: string, body?: string) => sys.bus.emit('notify', { title, body, appId }) : () => {},
      });
      try {
        // First launch downloads the app's chunk; show a spinner in the window meanwhile.
        win.content.classList.add('is-loading');
        const launchApp = await app.code().finally(() => win.content.classList.remove('is-loading'));
        await launchApp({ sys: scoped, window: win, args: [...args] });
        sys.bus.emit('app:launched', { appId, windowId: win.id });
      } catch (err) {
        console.error(`[apps] ${appId} failed to launch`, err);
        // A deploy removed the chunk this page was built with: the fix is a reload.
        const stale = /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(String(err));
        win.content.textContent = stale ? sys.t('shell.update.reload') : String(err);
      }
      return win;
    },
  };
  return registry;
}
