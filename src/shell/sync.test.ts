/**
 * Cloud sync end to end: two simulated devices (their own VFS, settings and
 * storage) talking to the REAL /sync handler over an in-memory store.
 */
import { describe, expect, it } from 'vitest';
import { createBus } from '../kernel/bus';
import type { EventBus, Settings, SystemAPI, VFS } from '../kernel/types';
import { createMemVFS } from '../apps/terminal/__tests__/memvfs';
import { createMemoryStore, handleCloudSync, isSyncKey, checkItem, type SyncStore } from '../../tools/cloud-sync.mjs';
import { createSyncService, fromBase64, parseState, remoteWins, syncBaseFor, toBase64, isDeviceSetting, SYNC_TOKEN_KEY } from './sync';

const TOKEN = 'owner-secret';
const BASE = 'https://faisal-os.pages.dev/sync';

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

/** A VFS that announces changes on the bus, like the real one. */
function eventedVFS(bus: EventBus, files: Record<string, string>): VFS {
  const v = createMemVFS(files);
  return {
    ...v,
    async writeFile(p, d) { const had = await v.exists(p); await v.writeFile(p, d); bus.emit('fs:change', { path: p, kind: had ? 'modify' : 'create' }); },
    async mkdir(p, o) { const had = await v.exists(p); await v.mkdir(p, o); if (!had) bus.emit('fs:change', { path: p, kind: 'create' }); },
    async remove(p, o) { await v.remove(p, o); bus.emit('fs:change', { path: p, kind: 'delete' }); },
    async rename(a, b) { await v.rename(a, b); bus.emit('fs:change', { path: b, oldPath: a, kind: 'rename' }); },
  };
}

function device(store: SyncStore, clock: { t: number }, files: Record<string, string> = {}) {
  const bus = createBus();
  const storage = new MemStorage();
  const vfs = eventedVFS(bus, { '/home/user/': '', ...files });
  const data: Record<string, unknown> = {};
  const settings: Settings = {
    get: <T,>(k: string, f: T) => (k in data ? (data[k] as T) : f),
    set: (k, val) => { data[k] = val; storage.setItem('faisal.settings.v1', JSON.stringify(data)); bus.emit('settings:change', { key: k, value: val }); },
  };
  const sys = { bus, vfs, settings } as unknown as SystemAPI;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handleCloudSync(new Request(String(input), init), { FAISAL_SYNC_TOKEN: TOKEN }, store)) as typeof fetch;
  const sync = createSyncService(sys, { fetch: fetchImpl, storage, base: BASE, now: () => clock.t });
  return { bus, vfs, settings, storage, sync, data };
}

const text = (vfs: VFS, p: string) => vfs.readText(p);

describe('cloud sync server', () => {
  it('only allows known keys', () => {
    expect(isSyncKey('fs:/home/user/notes.txt')).toBe(true);
    expect(isSyncKey('set:theme')).toBe(true);
    expect(isSyncKey('ls:faisal.browser.bookmarks')).toBe(true);
    for (const bad of ['fs:/etc/passwd', 'fs:/home/user/../../etc', 'fs:/home/userx/a', 'set:__proto__x!', 'ls:other', 'fs:/home/user//a']) {
      expect(isSyncKey(bad)).toBe(false);
    }
    expect(checkItem({ key: 'set:theme', kind: 'file', mtime: 1, deleted: false, data: '1' }).ok).toBe(false);
    expect(checkItem({ key: 'fs:/home/user/a', kind: 'file', mtime: 1, deleted: false, data: 'x'.repeat(2_000_000) }).ok).toBe(false);
  });

  it('needs the token and a database', async () => {
    const store = createMemoryStore();
    const pull = (env: Record<string, unknown>, tok?: string) => handleCloudSync(
      new Request(`${BASE}/pull?since=0`, { headers: tok ? { 'x-faisal-sync-token': tok } : {} }), env, store);
    expect((await pull({})).status).toBe(503);
    expect((await pull({ FAISAL_SYNC_TOKEN: TOKEN })).status).toBe(401);
    expect((await pull({ FAISAL_SYNC_TOKEN: TOKEN }, 'nope')).status).toBe(401);
    expect((await pull({ FAISAL_PROXY_TOKEN: TOKEN }, TOKEN)).status).toBe(200);
    const health = await (await handleCloudSync(new Request(`${BASE}/health`), {}, null)).json();
    expect(health).toMatchObject({ ok: false, configured: { token: false, db: false } });
  });

  it('keeps the newer write and retires a deleted folder\'s contents', async () => {
    const store = createMemoryStore();
    await store.put([{ key: 'fs:/home/user/d/a.txt', kind: 'file', mtime: 10, deleted: false, data: 'YQ==' }]);
    const older = await store.put([{ key: 'fs:/home/user/d/a.txt', kind: 'file', mtime: 5, deleted: false, data: 'Yg==' }]);
    expect(older.accepted).toEqual([]);
    await store.put([{ key: 'fs:/home/user/d', kind: 'dir', mtime: 20, deleted: true }]);
    const { items } = await store.since(0, 100, 1e9);
    expect(items.find((i) => i.key === 'fs:/home/user/d/a.txt')).toMatchObject({ deleted: true });
  });

  it('echoes the desktop app origin for CORS', async () => {
    const res = await handleCloudSync(new Request(`${BASE}/health`, { headers: { origin: 'app://faisal-os' } }), {}, null);
    expect(res.headers.get('access-control-allow-origin')).toBe('app://faisal-os');
    const evil = await handleCloudSync(new Request(`${BASE}/health`, { headers: { origin: 'https://evil.example' } }), {}, null);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('cloud sync client', () => {
  it('pure helpers', () => {
    expect(syncBaseFor('https://faisal-os.pages.dev')).toBe(BASE);
    expect(syncBaseFor('https://abc123.faisal-os.pages.dev')).toBe('https://abc123.faisal-os.pages.dev/sync');
    expect(syncBaseFor('app://faisal-os')).toBe(BASE);
    expect(syncBaseFor('https://evil.pages.dev')).toBe(BASE);
    expect(parseState('{broken')).toMatchObject({ cursor: 0, dirty: {} });
    expect(remoteWins({ mtime: 5, deleted: false, kind: 'file' }, { key: 'k', kind: 'file', mtime: 9, deleted: false }, false)).toBe(true);
    expect(remoteWins({ mtime: 9, deleted: false, kind: 'file' }, { key: 'k', kind: 'file', mtime: 5, deleted: false }, false)).toBe(false);
    expect(remoteWins({ mtime: 9, deleted: false, kind: 'file' }, { key: 'k', kind: 'file', mtime: 5, deleted: false }, true)).toBe(true);
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    expect(isDeviceSetting('shell.session')).toBe(true);
    expect(isDeviceSetting('theme')).toBe(false);
  });

  it('refuses a wrong token and stores nothing', async () => {
    const store = createMemoryStore();
    const a = device(store, { t: 1000 });
    expect(await a.sync.enable('wrong')).toBe('unauthorized');
    expect(a.storage.getItem(SYNC_TOKEN_KEY)).toBeNull();
  });

  it('syncs files, folders, settings, edits, renames and deletes both ways', async () => {
    const store = createMemoryStore();
    const clock = { t: Date.now() };
    const web = device(store, clock, { '/home/user/Documents/plan.md': '# خطة' });
    const desk = device(store, clock);

    web.settings.set('theme', 'dark');
    expect(await web.sync.enable(TOKEN)).toBe('ok');
    await web.sync.syncNow();
    expect(await desk.sync.enable(TOKEN)).toBe('ok');
    await desk.sync.syncNow();

    // Everything from the first device arrived.
    expect(await text(desk.vfs, '/home/user/Documents/plan.md')).toBe('# خطة');
    expect(desk.settings.get('theme', 'light')).toBe('dark');

    // An edit on the desktop reaches the web.
    clock.t = Date.now() + 5_000;
    await desk.vfs.writeFile('/home/user/Documents/plan.md', '# خطة 2');
    desk.settings.set('accent', 'blue');
    await desk.sync.syncNow();
    await web.sync.syncNow();
    expect(await text(web.vfs, '/home/user/Documents/plan.md')).toBe('# خطة 2');
    expect(web.settings.get('accent', '')).toBe('blue');

    // A rename and a delete on the web reach the desktop.
    clock.t = Date.now() + 9_000;
    await web.vfs.rename('/home/user/Documents', '/home/user/Docs');
    await web.sync.syncNow();
    await desk.sync.syncNow();
    expect(await desk.vfs.exists('/home/user/Documents')).toBe(false);
    expect(await text(desk.vfs, '/home/user/Docs/plan.md')).toBe('# خطة 2');

    clock.t = Date.now() + 12_000;
    await web.vfs.remove('/home/user/Docs', { recursive: true });
    await web.sync.syncNow();
    await desk.sync.syncNow();
    expect(await desk.vfs.exists('/home/user/Docs')).toBe(false);

    // Nothing is left pending and nothing loops back.
    expect(web.sync.status()).toMatchObject({ pending: 0, error: null });
    expect(desk.sync.status()).toMatchObject({ pending: 0, error: null });
  });

  it('never lets a fresh device overwrite the cloud copy on its first run', async () => {
    const store = createMemoryStore();
    const clock = { t: Date.now() };
    const a = device(store, clock, { '/home/user/notes.txt': 'real notes' });
    await a.sync.enable(TOKEN);
    await a.sync.syncNow();
    clock.t = Date.now() + 99_000; // the new device's default file is "newer"
    const b = device(store, clock, { '/home/user/notes.txt': 'default' });
    await b.sync.enable(TOKEN);
    await b.sync.syncNow();
    expect(await text(b.vfs, '/home/user/notes.txt')).toBe('real notes');
  });

  it('never syncs device-only settings or unlisted storage keys', async () => {
    const store = createMemoryStore();
    const clock = { t: Date.now() };
    const a = device(store, clock);
    await a.sync.enable(TOKEN);
    a.settings.set('shell.session', ['x']);
    a.storage.setItem('faisal.groq.apiKey', 'gsk_secret');
    a.storage.setItem('faisal.browser.bookmarks', '[{"url":"https://example.com"}]');
    await a.sync.syncNow();
    const { items } = await store.since(0, 1000, 1e9);
    const keys = items.map((i) => i.key);
    expect(keys).toContain('ls:faisal.browser.bookmarks');
    expect(keys.some((k) => k.includes('session') || k.includes('apiKey'))).toBe(false);
  });
});
