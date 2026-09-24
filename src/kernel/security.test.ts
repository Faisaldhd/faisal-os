import { describe, it, expect, beforeEach } from 'vitest';
import { createBus } from './bus';
import { createSettings } from './settings';
import { createAppRegistry, scopeVFS } from './apps';
import { createProcessTable } from './process';
import { createVFS } from '../vfs';
import { renderIcon } from '../shell/icon';
import type { AppContext, SystemAPI, VFS, WindowHandle, WindowManager } from './types';

async function memVFS(bus = createBus()): Promise<VFS> {
  const g = globalThis as { indexedDB?: unknown };
  const saved = g.indexedDB;
  delete g.indexedDB; // force the in-memory backend
  try { return await createVFS(bus); } finally { if (saved) g.indexedDB = saved; }
}

const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => e.code ?? e.message);

describe('scopeVFS', () => {
  let vfs: VFS;
  beforeEach(async () => {
    vfs = await memVFS();
    await vfs.mkdir('/home/user2', { recursive: true });
  });

  it('fs:home blocks traversal, prefix tricks and writes outside home/tmp', async () => {
    const s = scopeVFS(vfs, ['fs:home']);
    expect(await code(s.readText('/etc/os-release'))).toBe('EACCES');
    expect(await code(s.readText('/home/user/../../etc/os-release'))).toBe('EACCES');
    expect(await code(s.readdir('/home/user2'))).toBe('EACCES');
    expect(await code(s.readdir('/home/user/./../user2'))).toBe('EACCES');
    expect(await code(s.writeFile('/etc/evil', 'x'))).toBe('EACCES');
    expect(await code(s.rename('/home/user/Documents', '/etc/docs'))).toBe('EACCES');
    expect(await code(s.rename('/etc/os-release', '/home/user/os'))).toBe('EACCES');
    expect(await code(s.writeFile('/home/user/ok.txt', 'x'))).toBe('OK');
    expect(await code(s.writeFile('/tmp/ok.txt', 'x'))).toBe('OK');
  });

  it('fs:read-all reads everywhere but writes only home/tmp', async () => {
    const s = scopeVFS(vfs, ['fs:home', 'fs:read-all']);
    expect(await code(s.readText('/etc/os-release'))).toBe('OK');
    expect(await code(s.writeFile('/etc/os-release', 'pwned'))).toBe('EACCES');
    expect(await code(s.remove('/etc', { recursive: true }))).toBe('EACCES');
    expect(await code(s.chmod('/etc/hostname', 0o777))).toBe('EACCES');
  });

  it('no permission means no access at all', async () => {
    const s = scopeVFS(vfs, []);
    expect(await code(s.readdir('/home/user'))).toBe('EACCES');
  });
});

describe('app sandbox (kernel capabilities)', () => {
  it('apps cannot emit system events, see other apps windows, register apps, or get fs events outside scope', async () => {
    const bus = createBus();
    const vfs = await memVFS(bus);
    const wins: WindowHandle[] = [];
    const wm: WindowManager = {
      open(o) {
        const h: WindowHandle = {
          id: `w${wins.length}`, appId: o.appId, content: document.createElement('div'),
          setTitle() {}, focus() {}, close() {}, setCloseGuard() {}, onClose: () => () => {}, onResize: () => () => {},
          requestClose: async () => {},
        };
        wins.push(h);
        return h;
      },
      list: () => wins,
      get: (id) => wins.find((w) => w.id === id),
      focused: () => undefined,
      isMinimized: () => false,
      minimize() {},
      toggleMaximize() {},
    };
    let sys!: SystemAPI;
    const apps = createAppRegistry(() => sys);
    sys = { bus, vfs, wm, apps, settings: createSettings(bus), locale: () => 'en', t: (k) => k, notify: () => {},
      proc: createProcessTable(bus, { requestClose: () => {}, killClose: () => {}, isMinimized: () => false }) };

    const ctxs: Record<string, AppContext> = {};
    const mk = (id: string, permissions: string[]) => ({
      manifest: { id, name: { ar: id, en: id }, icon: '', permissions: permissions as never },
      launch(ctx: AppContext) { ctxs[id] = ctx; },
    });
    apps.register(mk('a', ['fs:home']));
    apps.register(mk('b', []));
    await apps.launch('a');
    await apps.launch('b');

    const a = ctxs.a.sys;
    expect(() => a.bus.emit('notify', { title: 'spoof' })).toThrow(/EACCES/);
    expect(() => a.bus.emit('fs:change', { path: '/x', kind: 'create' })).toThrow(/EACCES/);
    expect(() => a.apps.register(mk('evil', ['fs:system']))).toThrow(/EACCES/);
    expect(a.wm.list().map((w) => w.appId)).toEqual(['a']);
    expect(a.wm.get(wins[1].id)).toBeUndefined();
    expect(() => a.settings.set('theme', 'dark')).toThrow(/EACCES/);

    const seen: string[] = [];
    a.bus.on('fs:change', (p) => seen.push(p.path));
    await vfs.writeFile('/etc/secret', 's');
    await vfs.writeFile('/home/user/visible', 'v');
    expect(seen).toEqual(['/home/user/visible']);
  });
});

describe('settings', () => {
  it('rejects prototype pollution keys and ignores them on load', () => {
    localStorage.setItem('faisal.settings.v1', '{"__proto__":{"polluted":1},"theme":"dark"}');
    const s = createSettings(createBus());
    expect(s.get('theme', 'light')).toBe('dark');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => s.set('__proto__', { x: 1 })).toThrow();
    expect(() => s.set('constructor', 1)).toThrow();
    expect(s.get('toString', 'fallback')).toBe('fallback');
  });
});

describe('SVG icon sanitizer', () => {
  it('strips scripts, event handlers, links, animation, foreignObject and external urls', () => {
    const svg = renderIcon(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script>
      <a href="javascript:alert(1)"><rect width="1" height="1"/></a>
      <use href="data:image/svg+xml,evil"/>
      <animate attributeName="href" to="javascript:alert(1)"/>
      <set attributeName="onmouseover" to="alert(1)"/>
      <foreignObject><div>x</div></foreignObject>
      <image href="https://evil.example/x.png"/>
      <rect width="2" height="2" fill="url(https://evil.example/#g)" style="background:url(//evil)"/>
      <circle r="1" fill="url(#ok)"/>
    </svg>`);
    const html = svg.outerHTML;
    for (const bad of ['script', 'onload', 'javascript', '<a', '<use', 'animate', '<set', 'foreignObject', '<image', 'evil.example', 'style=']) {
      expect(html).not.toContain(bad);
    }
    expect(html).toContain('<circle');
  });
});
