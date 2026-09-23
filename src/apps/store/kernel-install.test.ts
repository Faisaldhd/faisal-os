import { describe, it, expect } from 'vitest';
import { createBus } from '../../kernel/bus';
import { createSettings } from '../../kernel/settings';
import { createAppRegistry } from '../../kernel/apps';
import { createVFS } from '../../vfs';
import type { AppContext, SystemAPI, VFS, WindowHandle, WindowManager } from '../../kernel/types';

/** In-memory VFS harness (see src/kernel/security.test.ts). */
async function memVFS(bus = createBus()): Promise<VFS> {
  const g = globalThis as { indexedDB?: unknown };
  const saved = g.indexedDB;
  delete g.indexedDB; // force the in-memory backend
  try { return await createVFS(bus); } finally { if (saved) g.indexedDB = saved; }
}

function makeWM(): WindowManager {
  const wins: WindowHandle[] = [];
  const closed = new Set<string>();
  const wm: WindowManager = {
    open(o) {
      const closeCbs = new Set<() => void>();
      const h: WindowHandle = {
        id: `w${wins.length}`,
        appId: o.appId,
        content: document.createElement('div'),
        setTitle() {},
        setCloseGuard() {},
        focus() {},
        close() {
          closed.add(h.id);
          closeCbs.forEach((cb) => cb());
        },
        onClose: (cb) => { closeCbs.add(cb); return () => closeCbs.delete(cb); },
        onResize: () => () => {},
      };
      wins.push(h);
      return h;
    },
    list: () => wins.filter((w) => !closed.has(w.id)),
    get: (id) => wins.find((w) => w.id === id && !closed.has(w.id)),
    focused: () => undefined,
    isMinimized: () => false,
    minimize() {},
    toggleMaximize() {},
  };
  return wm;
}

async function setup() {
  const bus = createBus();
  const vfs = await memVFS(bus);
  const wm = makeWM();
  let sys!: SystemAPI;
  const apps = createAppRegistry(() => sys);
  sys = { bus, vfs, wm, apps, settings: createSettings(bus), locale: () => 'en', t: (k) => k, notify: () => {} };

  const ctxs: Record<string, AppContext> = {};
  const mk = (id: string, permissions: string[], core = false) => ({
    manifest: { id, name: { ar: id, en: id }, icon: '', permissions: permissions as never, core },
    launch(ctx: AppContext) { ctxs[id] = ctx; },
  });

  apps.register(mk('org.faisal.Manager', ['apps:manage']));
  apps.register(mk('org.faisal.NoPerms', []));
  apps.register(mk('org.faisal.Settings', ['settings']));
  apps.register(mk('org.faisal.Core', [], true));
  apps.register(mk('org.faisal.Plain', []));

  return { sys, apps, ctxs };
}

describe('kernel install/uninstall behaviour via createAppRegistry', () => {
  it('uninstall hides an app from list() and closes its windows', async () => {
    const { sys, apps } = await setup();
    const win = await apps.launch('org.faisal.Plain');
    expect(apps.list().some((m) => m.id === 'org.faisal.Plain')).toBe(true);
    expect(sys.wm.list().some((w) => w.id === win?.id)).toBe(true);

    apps.uninstall('org.faisal.Plain');

    expect(apps.list().some((m) => m.id === 'org.faisal.Plain')).toBe(false);
    expect(sys.wm.list().some((w) => w.id === win?.id)).toBe(false);
  });

  it('install restores a previously removed app', async () => {
    const { apps } = await setup();
    apps.uninstall('org.faisal.Plain');
    expect(apps.list().some((m) => m.id === 'org.faisal.Plain')).toBe(false);

    apps.install('org.faisal.Plain');
    expect(apps.list().some((m) => m.id === 'org.faisal.Plain')).toBe(true);
  });

  it('throws when uninstalling a core app', async () => {
    const { apps } = await setup();
    expect(() => apps.uninstall('org.faisal.Core')).toThrow(/core/i);
    expect(apps.list().some((m) => m.id === 'org.faisal.Core')).toBe(true);
  });

  it('throws when launching an app that is not installed', async () => {
    const { apps } = await setup();
    apps.uninstall('org.faisal.Plain');
    await expect(apps.launch('org.faisal.Plain')).rejects.toThrow(/not installed/i);
  });

  it('an app without apps:manage gets EACCES trying to install/uninstall', async () => {
    const { apps, ctxs } = await setup();
    await apps.launch('org.faisal.NoPerms');
    const scoped = ctxs['org.faisal.NoPerms'].sys;
    expect(() => scoped.apps.install('org.faisal.Plain')).toThrow(/EACCES/);
    expect(() => scoped.apps.uninstall('org.faisal.Plain')).toThrow(/EACCES/);
  });

  it('an app with apps:manage can install/uninstall through its scoped API', async () => {
    const { apps, ctxs } = await setup();
    await apps.launch('org.faisal.Manager');
    const scoped = ctxs['org.faisal.Manager'].sys;
    scoped.apps.uninstall('org.faisal.Plain');
    expect(apps.list().some((m) => m.id === 'org.faisal.Plain')).toBe(false);
    scoped.apps.install('org.faisal.Plain');
    expect(apps.list().some((m) => m.id === 'org.faisal.Plain')).toBe(true);
  });

  it('an app with only "settings" cannot write the kernel-owned apps.installState key', async () => {
    const { apps, ctxs } = await setup();
    await apps.launch('org.faisal.Settings');
    const scoped = ctxs['org.faisal.Settings'].sys;
    expect(() => scoped.settings.set('apps.installState', { removed: ['org.faisal.Plain'], added: [] })).toThrow(/EACCES/);
    // and it can't reach install()/uninstall() either, since it lacks apps:manage
    expect(() => scoped.apps.install('org.faisal.Plain')).toThrow(/EACCES/);
  });
});
