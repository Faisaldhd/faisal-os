/**
 * Cloud sync (المزامنة) — the client half of tools/cloud-sync.mjs.
 *
 * Keeps the web copy and the desktop app in step through the owner's own
 * Cloudflare D1 database:
 *   • files and folders under /home/user,
 *   • the OS settings (except device-only ones such as the open-window session),
 *   • a short allowlist of app lists (bookmarks, world-clock cities).
 * API keys, tokens, window geometry and the lock record NEVER leave the device.
 *
 * Model: every change marks a key dirty with its time. A sync run pulls what
 * changed on the server since the last cursor, applies it unless the local copy
 * is newer (on the very first run the server always wins, so a fresh device's
 * default files cannot overwrite real ones), then pushes what is still dirty.
 * Last writer wins.
 */
import type { SystemAPI } from '../kernel/types';
import { HOME } from '../kernel/types';

export const SYNC_TOKEN_KEY = 'faisal.sync.token';
export const SYNC_STATE_KEY = 'faisal.sync.state.v1';
export const PROD_SYNC_BASE = 'https://faisal-os.pages.dev/sync';
/** Files above this are left out of sync (the server caps an item at ~1 MB). */
export const MAX_SYNC_FILE = 1_000_000;
const PUSH_BATCH_ITEMS = 100;
const PUSH_BATCH_BYTES = 4 * 1024 * 1024;
const INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 4_000;

/** App lists that sync as whole values. Nothing secret belongs here. */
export const SYNCED_LOCAL_KEYS = ['faisal.browser.bookmarks', 'faisal.clock.cities'] as const;

/** Settings that describe THIS device, not the owner's preferences. */
export function isDeviceSetting(key: string): boolean {
  return key === 'shell.session' || /geometry|session/i.test(key);
}

export type SyncKind = 'file' | 'dir' | 'value';
export interface SyncItem { key: string; kind: SyncKind; mtime: number; deleted: boolean; data?: string | null; rev?: number }
interface DirtyEntry { mtime: number; deleted: boolean; kind: SyncKind }
export interface SyncState {
  cursor: number;
  initialDone: boolean;
  dirty: Record<string, DirtyEntry>;
  lsSnap: Record<string, string | null>;
  lastSync: number | null;
}
export type SyncError = 'unauthorized' | 'unconfigured' | 'network' | 'server' | null;
export interface SyncStatus {
  enabled: boolean;
  running: boolean;
  lastSync: number | null;
  error: SyncError;
  pending: number;
  skippedLarge: number;
}

/* ─────────────────────────────── pure helpers ─────────────────────────────── */

/** Where this page reaches the sync function: its own /sync on Cloudflare, else production. */
export function syncBaseFor(origin: string): string {
  return /^https:\/\/(?:[a-z0-9-]+\.)?faisal-os\.pages\.dev$/.test(origin) ? `${origin}/sync` : PROD_SYNC_BASE;
}

export function emptyState(): SyncState {
  return { cursor: 0, initialDone: false, dirty: {}, lsSnap: {}, lastSync: null };
}

/** Tolerant parse: anything unexpected falls back to a clean state. */
export function parseState(raw: string | null): SyncState {
  const base = emptyState();
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<SyncState>;
    if (!v || typeof v !== 'object') return base;
    return {
      cursor: Number.isFinite(v.cursor) && (v.cursor as number) >= 0 ? (v.cursor as number) : 0,
      initialDone: v.initialDone === true,
      dirty: v.dirty && typeof v.dirty === 'object' ? v.dirty : {},
      lsSnap: v.lsSnap && typeof v.lsSnap === 'object' ? v.lsSnap : {},
      lastSync: typeof v.lastSync === 'number' ? v.lastSync : null,
    };
  } catch {
    return base;
  }
}

/**
 * Pure: should a pulled item replace the local copy? On the first run the
 * server always wins; later, a local edit that is at least as new wins.
 */
export function remoteWins(local: DirtyEntry | undefined, remote: SyncItem, firstRun: boolean): boolean {
  if (!local || firstRun) return true;
  return remote.mtime > local.mtime;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const underHome = (path: string) => path === HOME || path.startsWith(`${HOME}/`);

/* ─────────────────────────────── the service ─────────────────────────────── */

export interface SyncService {
  status(): SyncStatus;
  onStatus(cb: (s: SyncStatus) => void): () => void;
  /** Verifies the token against the server, stores it and runs a first sync. */
  enable(token: string): Promise<'ok' | 'unauthorized' | 'unconfigured' | 'network'>;
  /** Forgets the token and the local sync state. Nothing is deleted anywhere. */
  disable(): void;
  syncNow(): Promise<void>;
}

interface Deps {
  fetch: typeof fetch;
  storage: Storage | null;
  now: () => number;
  base: string;
}

export function createSyncService(sys: SystemAPI, deps: Partial<Deps> = {}): SyncService {
  const storage: Storage | null = deps.storage !== undefined ? deps.storage : (() => { try { return localStorage; } catch { return null; } })();
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const now = deps.now ?? (() => Date.now());
  const base = deps.base ?? syncBaseFor(globalThis.location?.origin ?? '');

  const read = (k: string): string | null => { try { return storage?.getItem(k) ?? null; } catch { return null; } };
  const write = (k: string, v: string) => { try { storage?.setItem(k, v); } catch { /* full or blocked */ } };
  const drop = (k: string) => { try { storage?.removeItem(k); } catch { /* ignore */ } };

  let state = parseState(read(SYNC_STATE_KEY));
  let applying = false;
  let running: Promise<void> | null = null;
  let error: SyncError = null;
  let skippedLarge = 0;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  /** Revisions this device just pushed: their echo in the next pull is skipped. */
  const pushedRev = new Map<string, number>();
  const listeners = new Set<(s: SyncStatus) => void>();

  const token = () => read(SYNC_TOKEN_KEY);
  const save = () => write(SYNC_STATE_KEY, JSON.stringify(state));
  const status = (): SyncStatus => ({
    enabled: Boolean(token()),
    running: running !== null,
    lastSync: state.lastSync,
    error,
    pending: Object.keys(state.dirty).length,
    skippedLarge,
  });
  const emit = () => { const s = status(); listeners.forEach((cb) => { try { cb(s); } catch { /* ignore */ } }); };

  function mark(key: string, entry: DirtyEntry) {
    state.dirty[key] = entry;
    save();
    if (token()) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; void syncNow(); }, DEBOUNCE_MS);
    }
  }

  async function markTree(path: string) {
    let st;
    try { st = await sys.vfs.stat(path); } catch { return; }
    mark(`fs:${path}`, { mtime: st.mtime, deleted: false, kind: st.type === 'dir' ? 'dir' : 'file' });
    if (st.type === 'dir') {
      let entries: { name: string }[] = [];
      try { entries = await sys.vfs.readdir(path); } catch { /* unreadable: skip */ }
      for (const e of entries) await markTree(`${path}/${e.name}`);
    }
  }

  /* ── local change tracking ── */

  sys.bus.on('fs:change', ({ path, kind, oldPath }) => {
    if (applying) return;
    if (kind === 'rename') {
      if (oldPath && underHome(oldPath)) mark(`fs:${oldPath}`, { mtime: now(), deleted: true, kind: 'dir' });
      if (underHome(path)) void markTree(path);
      return;
    }
    if (!underHome(path) || path === HOME) return;
    if (kind === 'delete') mark(`fs:${path}`, { mtime: now(), deleted: true, kind: 'dir' });
    else void markTree(path);
  });

  sys.bus.on('settings:change', ({ key }) => {
    if (applying || isDeviceSetting(key)) return;
    mark(`set:${key}`, { mtime: now(), deleted: false, kind: 'value' });
  });

  function scanLocalKeys() {
    for (const k of SYNCED_LOCAL_KEYS) {
      const v = read(k);
      if (v !== (state.lsSnap[k] ?? null)) {
        state.dirty[`ls:${k}`] = { mtime: now(), deleted: v === null, kind: 'value' };
      }
    }
  }

  /* ── network ── */

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-faisal-sync-token', token() ?? '');
    return doFetch(`${base}${path}`, { ...init, headers, cache: 'no-store' });
  }

  function failFrom(res: Response): SyncError {
    if (res.status === 401) return 'unauthorized';
    if (res.status === 503) return 'unconfigured';
    return 'server';
  }

  /* ── applying remote items ── */

  async function apply(item: SyncItem) {
    applying = true;
    try {
      if (item.key.startsWith('fs:')) {
        const path = item.key.slice(3);
        if (!underHome(path) || path === HOME) return;
        if (item.deleted) {
          try { await sys.vfs.remove(path, { recursive: true }); } catch { /* already gone */ }
        } else if (item.kind === 'dir') {
          await sys.vfs.mkdir(path, { recursive: true });
        } else if (typeof item.data === 'string') {
          const parent = path.slice(0, path.lastIndexOf('/')) || '/';
          await sys.vfs.mkdir(parent, { recursive: true });
          await sys.vfs.writeFile(path, fromBase64(item.data));
        }
      } else if (item.key.startsWith('set:')) {
        const key = item.key.slice(4);
        if (isDeviceSetting(key) || item.deleted || typeof item.data !== 'string') return;
        sys.settings.set(key, JSON.parse(item.data));
      } else if (item.key.startsWith('ls:')) {
        const key = item.key.slice(3);
        if (!(SYNCED_LOCAL_KEYS as readonly string[]).includes(key)) return;
        if (item.deleted || typeof item.data !== 'string') drop(key);
        else write(key, item.data);
        state.lsSnap[key] = read(key);
      }
    } catch {
      /* one bad item must not stop the rest */
    } finally {
      applying = false;
    }
  }

  /* ── building pushed items ── */

  async function materialize(key: string, entry: DirtyEntry): Promise<SyncItem | null> {
    if (key.startsWith('fs:')) {
      const path = key.slice(3);
      let st;
      try { st = await sys.vfs.stat(path); } catch { st = null; }
      if (!st || entry.deleted) return { key, kind: 'dir', mtime: entry.mtime, deleted: true };
      if (st.type === 'dir') return { key, kind: 'dir', mtime: st.mtime, deleted: false };
      if (st.size > MAX_SYNC_FILE) { skippedLarge += 1; return null; }
      return { key, kind: 'file', mtime: st.mtime, deleted: false, data: toBase64(await sys.vfs.readFile(path)) };
    }
    if (key.startsWith('set:')) {
      const name = key.slice(4);
      const raw = read('faisal.settings.v1');
      let all: Record<string, unknown> = {};
      try { all = raw ? JSON.parse(raw) : {}; } catch { /* corrupt: nothing to send */ }
      if (!Object.hasOwn(all, name)) return null;
      return { key, kind: 'value', mtime: entry.mtime, deleted: false, data: JSON.stringify(all[name]) };
    }
    if (key.startsWith('ls:')) {
      const v = read(key.slice(3));
      return v === null
        ? { key, kind: 'value', mtime: entry.mtime, deleted: true }
        : { key, kind: 'value', mtime: entry.mtime, deleted: false, data: v };
    }
    return null;
  }

  /* ── one run ── */

  async function run(): Promise<void> {
    if (!token()) return;
    error = null;
    skippedLarge = 0;
    scanLocalKeys();
    const firstRun = !state.initialDone;
    try {
      // 1. Pull.
      for (let guard = 0; guard < 500; guard += 1) {
        const res = await call(`/pull?since=${state.cursor}`);
        if (!res.ok) { error = failFrom(res); return; }
        const body = (await res.json()) as { items?: SyncItem[]; more?: boolean };
        for (const item of body.items ?? []) {
          if (typeof item.rev === 'number' && pushedRev.get(item.key) === item.rev) {
            state.cursor = Math.max(state.cursor, item.rev);
            continue;
          }
          if (remoteWins(state.dirty[item.key], item, firstRun)) {
            await apply(item);
            delete state.dirty[item.key];
          }
          if (typeof item.rev === 'number') state.cursor = Math.max(state.cursor, item.rev);
        }
        save();
        if (!body.more) break;
      }

      // 2. Push what is still dirty, in batches.
      const keys = Object.keys(state.dirty);
      let batch: SyncItem[] = [];
      let bytes = 0;
      const sent = new Map<string, number>();
      const flush = async () => {
        if (!batch.length) return true;
        const res = await call('/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: batch }),
        });
        if (!res.ok) { error = failFrom(res); return false; }
        const body = (await res.json()) as { accepted?: { key: string; rev: number }[] };
        for (const a of body.accepted ?? []) {
          pushedRev.set(a.key, a.rev);
          // Only clear it if nothing changed again while the request was in flight.
          if (state.dirty[a.key]?.mtime === sent.get(a.key)) delete state.dirty[a.key];
          if (a.key.startsWith('ls:')) state.lsSnap[a.key.slice(3)] = read(a.key.slice(3));
        }
        // Items the server kept its newer copy of are no longer ours to send.
        for (const it of batch) if (!body.accepted?.some((a) => a.key === it.key) && state.dirty[it.key]?.mtime === sent.get(it.key)) delete state.dirty[it.key];
        batch = [];
        bytes = 0;
        save();
        return true;
      };
      for (const key of keys) {
        const entry = state.dirty[key];
        if (!entry) continue;
        const item = await materialize(key, entry);
        if (!item) { delete state.dirty[key]; continue; }
        sent.set(key, entry.mtime);
        const size = item.data?.length ?? 0;
        if (batch.length >= PUSH_BATCH_ITEMS || (batch.length && bytes + size > PUSH_BATCH_BYTES)) {
          if (!(await flush())) return;
        }
        batch.push(item);
        bytes += size;
      }
      if (!(await flush())) return;

      state.initialDone = true;
      state.lastSync = now();
      save();
    } catch {
      error = 'network';
    }
  }

  /** A second request while a run is in flight gets one follow-up run, not the old one. */
  let queued: Promise<void> | null = null;

  function syncNow(): Promise<void> {
    if (running) {
      queued ??= running.then(() => { queued = null; return syncNow(); });
      return queued;
    }
    running = run().finally(() => { running = null; emit(); });
    emit();
    return running;
  }

  async function enable(value: string) {
    const tok = value.trim();
    if (!tok) return 'unauthorized' as const;
    let res: Response;
    try {
      res = await doFetch(`${base}/pull?since=${Number.MAX_SAFE_INTEGER}`, { headers: { 'x-faisal-sync-token': tok }, cache: 'no-store' });
    } catch {
      return 'network' as const;
    }
    if (res.status === 401) return 'unauthorized' as const;
    if (res.status === 503) return 'unconfigured' as const;
    if (!res.ok) return 'network' as const;
    write(SYNC_TOKEN_KEY, tok);
    state = emptyState();
    // Everything this device has is a candidate; the first pull decides who wins.
    await markTree(HOME);
    delete state.dirty[`fs:${HOME}`];
    const raw = read('faisal.settings.v1');
    try {
      for (const k of Object.keys(raw ? JSON.parse(raw) : {})) {
        if (!isDeviceSetting(k)) state.dirty[`set:${k}`] = { mtime: 0, deleted: false, kind: 'value' };
      }
    } catch { /* corrupt settings: nothing to offer */ }
    for (const k of SYNCED_LOCAL_KEYS) state.lsSnap[k] = null;
    if (debounce) { clearTimeout(debounce); debounce = null; }
    save();
    void syncNow();
    return 'ok' as const;
  }

  function disable() {
    drop(SYNC_TOKEN_KEY);
    drop(SYNC_STATE_KEY);
    state = emptyState();
    error = null;
    if (debounce) { clearTimeout(debounce); debounce = null; }
    emit();
  }

  // Background rhythm: at boot, every minute while visible, and when back online.
  if (typeof window !== 'undefined') {
    sys.bus.on('system:ready', () => { if (token()) void syncNow(); });
    setInterval(() => {
      if (token() && (typeof document === 'undefined' || document.visibilityState === 'visible')) void syncNow();
    }, INTERVAL_MS);
    window.addEventListener('online', () => { if (token()) void syncNow(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && token()) void syncNow();
    });
  }

  return {
    status,
    onStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    enable,
    disable,
    syncNow,
  };
}

/* ─────────────────────────── the one per page ─────────────────────────── */

let current: SyncService | null = null;

/** Started once by the shell; the Settings app reads it. */
export function startSync(sys: SystemAPI): SyncService {
  current ??= createSyncService(sys);
  return current;
}

export function getSync(): SyncService | null {
  return current;
}
