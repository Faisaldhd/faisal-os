/**
 * Fai$al OS — the owner's CLOUD proxy (الوسيط السحابي الخاص).
 *
 * The same idea as tools/local-proxy.mjs, but it runs on Cloudflare Pages
 * Functions (functions/proxy/[[route]].js) next to the site, so reader mode
 * works on a phone or any browser without running anything locally.
 *
 * SECURITY POSTURE (do not simplify)
 *   • Owner-only: every page fetch needs the `x-faisal-proxy-token` header to
 *     match the FAISAL_PROXY_TOKEN secret set in the Cloudflare dashboard.
 *     Without that secret the proxy is OFF: /health reports ok:false and /fetch
 *     answers 503. The token is compared as SHA-256 digests in constant time.
 *   • READER ONLY. The reply is the page's HTML as `text/plain`, which the
 *     client parses into text blocks itself (src/apps/web/reader.ts). Raw mode
 *     would serve a third-party page from the OS's own origin, where its scripts
 *     could read the OS's storage, so /ticket, /view and mode=raw are refused.
 *     The reply also carries `nosniff` and a `sandbox` CSP, so even opening the
 *     URL directly can never run the fetched page.
 *   • SSRF guard before the first request and on every redirect hop (the same
 *     address and host-name checks as the local proxy, from proxy-guards.mjs).
 *     Workers cannot reach private networks anyway, and there is no DNS API to
 *     re-check answers, so the name/literal checks are the guard here.
 *   • GET only, no cookies forwarded either way, 2 MB cap, 10 s timeout,
 *     `no-store`, nothing logged or persisted.
 */
import { allowedOrigin, isBlockedHostname, isPrivateAddress } from './proxy-guards.mjs';

export const CLOUD_PROXY_VERSION = '1.0.0';
export const CLOUD_FETCH_TIMEOUT_MS = 10_000;
export const CLOUD_MAX_BYTES = 2 * 1024 * 1024;
export const CLOUD_MAX_REDIRECTS = 3;
/** The mount point under the site: /proxy/health, /proxy/fetch. */
export const CLOUD_PREFIX = '/proxy';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 FaisalOS-CloudProxy/1.0';

/** The SSRF guard for one URL, without DNS (Workers have no resolver API). */
export function validateCloudTarget(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: 'target is not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme not allowed: ${url.protocol}` };
  }
  if (url.username || url.password) return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'missing host' };
  if (isPrivateAddress(host)) return { ok: false, reason: `host resolves to a non-public address: ${host}` };
  if (isBlockedHostname(host)) return { ok: false, reason: `host name not allowed: ${host}` };
  return { ok: true, url };
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Constant-time comparison of the configured and the presented token. */
export async function cloudTokenMatches(expected, provided) {
  if (typeof expected !== 'string' || expected === '' || typeof provided !== 'string' || provided === '') return false;
  const [a, b] = await Promise.all([sha256(expected), sha256(provided)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function baseHeaders(origin) {
  const h = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (origin) {
    h['access-control-allow-origin'] = origin;
    h.vary = 'origin';
  }
  return h;
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders(origin), 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Read at most `limit` bytes of a body; the rest is cancelled. */
async function readCapped(body, limit) {
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return { bytes, truncated };
}

/** One guarded fetch with redirects followed by hand, each hop re-validated. */
export async function cloudFetchGuarded(rawUrl, fetchImpl = globalThis.fetch) {
  let current = rawUrl;
  for (let hops = 0; ; hops += 1) {
    const verdict = validateCloudTarget(current);
    if (!verdict.ok) return { error: verdict.reason, status: 403 };
    let res;
    try {
      res = await fetchImpl(verdict.url.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'ar,en;q=0.8' },
        signal: AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      return { error: `upstream request failed: ${e && e.message ? e.message : 'unknown error'}`, status: 502 };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (!location) return { error: 'upstream redirect without a Location header', status: 502 };
      if (hops >= CLOUD_MAX_REDIRECTS) return { error: `too many redirects (>${CLOUD_MAX_REDIRECTS})`, status: 502 };
      try {
        current = new URL(location, verdict.url).toString();
      } catch {
        return { error: 'upstream redirect to an invalid Location', status: 502 };
      }
      continue;
    }
    const { bytes, truncated } = await readCapped(res.body, CLOUD_MAX_BYTES);
    return { status: res.status, bytes, truncated, finalUrl: verdict.url.toString() };
  }
}

/**
 * Handle one request under /proxy. `env.FAISAL_PROXY_TOKEN` is the owner's
 * secret; `fetchImpl` is injectable for tests.
 */
export async function handleCloudProxy(request, env = {}, fetchImpl = globalThis.fetch) {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(CLOUD_PREFIX) ? url.pathname.slice(CLOUD_PREFIX.length) || '/' : url.pathname;
  const origin = allowedOrigin(request.headers.get('origin'));
  const token = typeof env.FAISAL_PROXY_TOKEN === 'string' ? env.FAISAL_PROXY_TOKEN.trim() : '';

  if (request.method === 'OPTIONS') {
    const headers = {
      ...baseHeaders(origin),
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'x-faisal-proxy-token',
      'access-control-max-age': '600',
    };
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { error: 'method not allowed' }, origin);
  }

  if (path === '/health') {
    // No page data and no target here, so no token either. ok:false while the
    // owner has not set the secret keeps the proxy action hidden in the OS.
    return json(200, {
      ok: token !== '',
      version: CLOUD_PROXY_VERSION,
      auth: token ? 'token-required' : null,
      kind: 'cloud',
      modes: ['reader'],
    }, origin);
  }

  if (path === '/ticket' || path === '/view') {
    return json(403, { error: 'raw mode is not available on the cloud proxy' }, origin);
  }

  if (path === '/fetch') {
    if (!token) return json(503, { error: 'the cloud proxy is not configured' }, origin);
    if (!(await cloudTokenMatches(token, request.headers.get('x-faisal-proxy-token')))) {
      return json(401, { error: 'invalid or missing token' }, origin);
    }
    const mode = url.searchParams.get('mode') ?? 'reader';
    if (mode !== 'reader') return json(403, { error: 'raw mode is not available on the cloud proxy' }, origin);
    const target = url.searchParams.get('url');
    if (!target) return json(400, { error: 'missing url parameter' }, origin);

    const result = await cloudFetchGuarded(target, fetchImpl);
    if (result.error) return json(result.status, { error: result.error }, origin);

    const headers = {
      ...baseHeaders(origin),
      'content-type': 'text/plain; charset=utf-8',
      // Belt and braces: opened directly, the text can still never run as a page.
      'content-security-policy': "sandbox; default-src 'none'",
      'x-faisal-proxy': 'reader',
    };
    if (result.truncated) headers['x-faisal-proxy-truncated'] = '1';
    const text = new TextDecoder('utf-8').decode(result.bytes);
    return new Response(request.method === 'HEAD' ? null : text, { status: result.status, headers });
  }

  return json(404, { error: 'not found' }, origin);
}
