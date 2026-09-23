import type {
  AppModule, AppRegistry, AppManifest, EventBus, Permission, SystemAPI, SystemEvents, VFS,
  WindowHandle, WindowManager,
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
  };
}

export function createAppRegistry(getSys: () => SystemAPI): AppRegistry {
  const apps = new Map<string, AppModule>();
  const running = new Map<string, WindowHandle[]>();

  const registry: AppRegistry = {
    register(app) {
      if (apps.has(app.manifest.id)) throw new Error(`App already registered: ${app.manifest.id}`);
      apps.set(app.manifest.id, Object.freeze({ ...app, manifest: Object.freeze({ ...app.manifest }) }));
    },
    list(): AppManifest[] {
      return [...apps.values()].map((a) => a.manifest);
    },
    appForFile(path) {
      const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
      return [...apps.values()].find((a) => a.manifest.opens?.includes(ext))?.manifest;
    },
    async launch(appId, args = []) {
      const app = apps.get(appId);
      if (!app) throw new Error(`Unknown app: ${appId}`);
      const sys = getSys();
      const open = running.get(appId) ?? [];
      if (app.manifest.singleInstance && open.length) { open[0].focus(); return open[0]; }

      const win = sys.wm.open({
        appId,
        title: app.manifest.name[sys.locale()],
        icon: app.manifest.icon,
      });
      running.set(appId, [...open, win]);
      win.onClose(() => {
        running.set(appId, (running.get(appId) ?? []).filter((w) => w !== win));
        sys.bus.emit('app:closed', { appId, windowId: win.id });
      });

      const perms = app.manifest.permissions;
      const vfs = scopeVFS(sys.vfs, perms);
      const scoped: SystemAPI = Object.freeze({
        vfs,
        bus: scopeBus(sys.bus, fsAccess(perms).canRead),
        wm: scopeWM(sys.wm, appId),
        apps: Object.freeze({
          list: registry.list,
          appForFile: registry.appForFile,
          launch: registry.launch,
          register: () => { throw new Error('EACCES: apps cannot register apps'); },
        }),
        settings: perms.includes('settings') ? sys.settings
          : Object.freeze({ get: sys.settings.get, set: () => { throw new Error('EACCES: settings'); } }),
        locale: sys.locale,
        t: sys.t,
        notify: perms.includes('notifications') ? sys.notify : () => {},
      });
      try {
        await app.launch({ sys: scoped, window: win, args: [...args] });
        sys.bus.emit('app:launched', { appId, windowId: win.id });
      } catch (err) {
        console.error(`[apps] ${appId} failed to launch`, err);
        win.content.textContent = String(err);
      }
      return win;
    },
  };
  return registry;
}
