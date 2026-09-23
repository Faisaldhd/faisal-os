/**
 * Fai$al OS — the owner's CLOUD SYNC (المزامنة السحابية الخاصة).
 *
 * Keeps the web copy and the desktop app in step: files under /home/user, the
 * OS settings and a few app lists. Runs on Cloudflare Pages Functions
 * (functions/sync/[[route]].js) and stores everything in the owner's own D1
 * database, bound to the Pages project as SYNC_DB.
 *
 * SECURITY POSTURE
 *   • Owner-only: every call but /health needs `x-faisal-sync-token` to match
 *     FAISAL_SYNC_TOKEN (or, when that is unset, FAISAL_PROXY_TOKEN, so one
 *     secret can serve both). No secret or no database → sync is OFF.
 *   • Keys are an allowlist: `fs:/home/user/…`, `set:<setting>`, `ls:faisal.<key>`.
 *     No `..`, no NUL, bounded sizes. API keys are never sent by the client.
 *   • Last writer wins by the client's mtime; a deleted folder also retires
 *     every synced item under it.
 *
 * PROTOCOL (JSON)
 *   GET  /sync/health                  → { ok, version, configured: { token, db } }
 *   GET  /sync/pull?since=<rev>        → { items: Item[], rev, more }
 *   POST /sync/push { items: Item[] }  → { accepted: { key, rev }[], rev }
 *   Item = { key, kind: 'file'|'dir'|'value', mtime, deleted, data?: string, rev? }
 *   (`data` is base64 for files, JSON text for values.)
 */
import { allowedOrigin } from './proxy-guards.mjs';

export const SYNC_VERSION = '1.0.0';
export const SYNC_PREFIX = '/sync';
/** Largest single item payload (base64 of a ~1 MB file). */
export const MAX_ITEM_DATA = 1_400_000;
export const MAX_PUSH_ITEMS = 200;
export const MAX_PUSH_BYTES = 6 * 1024 * 1024;
/** A pull page stops at this many items or bytes, whichever comes first. */
export const PULL_LIMIT = 200;
export const PULL_BYTES = 4 * 1024 * 1024;
/** The desktop app's private origin (electron/main.cjs). */
const DESKTOP_ORIGIN = 'app://faisal-os';

const KEY_RE = /^(?:fs:\/home\/user(?:\/[^\0]*)?|set:[A-Za-z][A-Za-z0-9._-]{0,63}|ls:faisal\.[A-Za-z0-9._-]{1,64})$/;

/** Pure: is this a key the sync may store? */
export function isSyncKey(key) {
  if (typeof key !== 'string' || key.length > 1024 || !KEY_RE.test(key)) return false;
  if (key.startsWith('fs:')) {
    const parts = key.slice(3).split('/');
    if (parts.some((p, i) => i > 0 && (p === '' || p === '.' || p === '..'))) return false;
  }
  return true;
}

/** Pure: validate and normalise one pushed item, or return a reason. */
export function checkItem(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'item is not an object' };
  const { key, kind, mtime, deleted, data } = raw;
  if (!isSyncKey(key)) return { ok: false, reason: 'key not allowed' };
  if (kind !== 'file' && kind !== 'dir' && kind !== 'value') return { ok: false, reason: 'bad kind' };
  if (key.startsWith('fs:') === (kind === 'value')) return { ok: false, reason: 'kind does not match key' };
  if (!Number.isFinite(mtime) || mtime < 0) return { ok: false, reason: 'bad mtime' };
  const isDeleted = deleted === true;
  if (!isDeleted && kind !== 'dir' && typeof data !== 'string') return { ok: false, reason: 'missing data' };
  if (typeof data === 'string' && data.length > MAX_ITEM_DATA) return { ok: false, reason: 'item too large' };
  return {
    ok: true,
    item: { key, kind, mtime: Math.floor(mtime), deleted: isDeleted, data: isDeleted || kind === 'dir' ? null : data },
  };
}

/* ───────────────────────────────── stores ───────────────────────────────── */

/**
 * In-memory store with the same contract as the D1 one (tests, local dev).
 * put() applies last-writer-wins and returns the accepted keys with their revs.
 */
export function createMemoryStore() {
  const rows = new Map();
  let rev = 0;
  return {
    async init() {},
    async put(items) {
      const accepted = [];
      for (const it of items) {
        const cur = rows.get(it.key);
        if (cur && cur.mtime > it.mtime) continue;
        rev += 1;
        rows.set(it.key, { ...it, rev });
        accepted.push({ key: it.key, rev });
        if (it.deleted && it.kind === 'dir') {
          for (const [k, row] of rows) {
            if (k.startsWith(`${it.key}/`) && !row.deleted) {
              rev += 1;
              rows.set(k, { ...row, deleted: true, data: null, mtime: it.mtime, rev });
            }
          }
        }
      }
      return { accepted, rev };
    },
    async since(after, limit, maxBytes) {
      const out = [];
      let bytes = 0;
      const sorted = [...rows.values()].filter((r) => r.rev > after).sort((a, b) => a.rev - b.rev);
      for (const r of sorted) {
        if (out.length >= limit || (out.length && bytes + (r.data?.length ?? 0) > maxBytes)) break;
        out.push({ ...r });
        bytes += r.data?.length ?? 0;
      }
      return { items: out, rev, more: out.length < sorted.length };
    },
  };
}

/** The D1-backed store. Revisions come from a single counter row. */
export function createD1Store(db) {
  let ready = null;
  async function nextRevs(n) {
    const row = await db.prepare("UPDATE sync_meta SET v = v + ?1 WHERE k = 'rev' RETURNING v").bind(n).first();
    const end = Number(row?.v ?? 0);
    return end - n + 1;
  }
  return {
    init() {
      ready ??= db.batch([
        db.prepare('CREATE TABLE IF NOT EXISTS sync_items (key TEXT PRIMARY KEY, kind TEXT NOT NULL, mtime INTEGER NOT NULL, deleted INTEGER NOT NULL, data TEXT, rev INTEGER NOT NULL)'),
        db.prepare('CREATE INDEX IF NOT EXISTS sync_items_rev ON sync_items(rev)'),
        db.prepare('CREATE TABLE IF NOT EXISTS sync_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)'),
        db.prepare("INSERT OR IGNORE INTO sync_meta (k, v) VALUES ('rev', 0)"),
      ]);
      return ready;
    },
    async put(items) {
      const accepted = [];
      for (const it of items) {
        const cur = await db.prepare('SELECT mtime FROM sync_items WHERE key = ?1').bind(it.key).first();
        if (cur && Number(cur.mtime) > it.mtime) continue;
        const rev = await nextRevs(1);
        await db.prepare(
          'INSERT INTO sync_items (key, kind, mtime, deleted, data, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6) '
          + 'ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, mtime = excluded.mtime, deleted = excluded.deleted, data = excluded.data, rev = excluded.rev',
        ).bind(it.key, it.kind, it.mtime, it.deleted ? 1 : 0, it.data, rev).run();
        accepted.push({ key: it.key, rev });
        if (it.deleted && it.kind === 'dir') {
          const { results } = await db.prepare(
            'SELECT key FROM sync_items WHERE deleted = 0 AND substr(key, 1, ?1) = ?2',
          ).bind(it.key.length + 1, `${it.key}/`).all();
          if (results?.length) {
            const first = await nextRevs(results.length);
            await db.batch(results.map((r, i) => db.prepare(
              'UPDATE sync_items SET deleted = 1, data = NULL, mtime = ?1, rev = ?2 WHERE key = ?3',
            ).bind(it.mtime, first + i, r.key)));
          }
        }
      }
      const top = await db.prepare("SELECT v FROM sync_meta WHERE k = 'rev'").first();
      return { accepted, rev: Number(top?.v ?? 0) };
    },
    async since(after, limit, maxBytes) {
      const { results } = await db.prepare(
        'SELECT key, kind, mtime, deleted, data, rev FROM sync_items WHERE rev > ?1 ORDER BY rev LIMIT ?2',
      ).bind(after, limit + 1).all();
      const out = [];
      let bytes = 0;
      for (const r of results ?? []) {
        if (out.length >= limit || (out.length && bytes + (r.data?.length ?? 0) > maxBytes)) break;
        out.push({ key: r.key, kind: r.kind, mtime: Number(r.mtime), deleted: Number(r.deleted) === 1, data: r.data ?? null, rev: Number(r.rev) });
        bytes += r.data?.length ?? 0;
      }
      const top = await db.prepare("SELECT v FROM sync_meta WHERE k = 'rev'").first();
      return { items: out, rev: Number(top?.v ?? 0), more: (results?.length ?? 0) > out.length };
    },
  };
}

/* ──────────────────────────────── handler ──────────────────────────────── */

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function tokenMatches(expected, provided) {
  if (!expected || typeof provided !== 'string' || !provided) return false;
  const [a, b] = await Promise.all([sha256(expected), sha256(provided)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function corsOrigin(raw) {
  return raw === DESKTOP_ORIGIN ? DESKTOP_ORIGIN : allowedOrigin(raw);
}

function reply(status, body, origin) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Handle one request under /sync. `store` is injectable for tests; in
 * production it is the D1 store over `env.SYNC_DB`.
 */
export async function handleCloudSync(request, env = {}, store = null) {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(SYNC_PREFIX) ? url.pathname.slice(SYNC_PREFIX.length) || '/' : url.pathname;
  const origin = corsOrigin(request.headers.get('origin'));
  const token = String(env.FAISAL_SYNC_TOKEN || env.FAISAL_PROXY_TOKEN || '').trim();
  const db = store ?? (env.SYNC_DB ? createD1Store(env.SYNC_DB) : null);

  if (request.method === 'OPTIONS') {
    const headers = {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'x-faisal-sync-token, content-type',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
    };
    if (origin) { headers['access-control-allow-origin'] = origin; headers.vary = 'origin'; }
    return new Response(null, { status: 204, headers });
  }

  if (path === '/health' && request.method === 'GET') {
    return reply(200, { ok: Boolean(token && db), version: SYNC_VERSION, configured: { token: Boolean(token), db: Boolean(db) } }, origin);
  }
  if (path !== '/pull' && path !== '/push') return reply(404, { error: 'not found' }, origin);
  if (!token || !db) return reply(503, { error: 'sync is not configured' }, origin);
  if (!(await tokenMatches(token, request.headers.get('x-faisal-sync-token')))) {
    return reply(401, { error: 'invalid or missing token' }, origin);
  }

  try {
    await db.init();
    if (path === '/pull' && request.method === 'GET') {
      const since = Math.max(0, Math.floor(Number(url.searchParams.get('since') ?? 0)) || 0);
      return reply(200, await db.since(since, PULL_LIMIT, PULL_BYTES), origin);
    }
    if (path === '/push' && request.method === 'POST') {
      const text = await request.text();
      if (text.length > MAX_PUSH_BYTES) return reply(413, { error: 'push too large' }, origin);
      let body;
      try { body = JSON.parse(text); } catch { return reply(400, { error: 'body is not JSON' }, origin); }
      const raw = Array.isArray(body?.items) ? body.items : null;
      if (!raw || raw.length > MAX_PUSH_ITEMS) return reply(400, { error: `items must be an array of at most ${MAX_PUSH_ITEMS}` }, origin);
      const items = [];
      const rejected = [];
      for (const r of raw) {
        const v = checkItem(r);
        if (v.ok) items.push(v.item);
        else rejected.push({ key: typeof r?.key === 'string' ? r.key.slice(0, 200) : null, reason: v.reason });
      }
      const result = await db.put(items);
      return reply(200, { ...result, rejected }, origin);
    }
    return reply(405, { error: 'method not allowed' }, origin);
  } catch (e) {
    return reply(500, { error: 'sync storage error', detail: e && e.message ? String(e.message).slice(0, 200) : undefined }, origin);
  }
}
