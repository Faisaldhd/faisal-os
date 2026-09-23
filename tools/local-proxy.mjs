/**
 * Fai$al OS — OPT-IN local proxy (الوسيط المحلي الاختياري).
 *
 * WHAT THIS IS
 *   A small, dependency-free HTTP server the owner runs BY HAND on his own
 *   machine:
 *
 *     node tools/local-proxy.mjs [--port 8787] [--token <value>] [--verbose] [--allow a,b]
 *
 *   It exists for exactly one reason: some sites send `X-Frame-Options` or a
 *   CSP `frame-ancestors` rule that forbids being shown inside a frame, and the
 *   owner may want to read one of those pages inside a Fai$al OS window anyway.
 *   That is a deliberate, owner-approved tradeoff: the traffic goes from his
 *   browser to his OWN loopback interface and back out from HIS machine, and the
 *   site's framing preference is bypassed for the one URL he asked for. Nothing
 *   is routed through a third party and nothing is persisted.
 *
 * SECURITY POSTURE (the guards below are the point of the file — do not simplify)
 *   • Loopback only: the listener binds 127.0.0.1. There is no flag to bind a
 *     public interface; `assertLoopbackHost()` refuses anything else.
 *   • Token required on /fetch and on /ticket (crypto.timingSafeEqual). /health is
 *     deliberately token-free: it carries no page data and no target URL.
 *   • /view is deliberately TOKEN-FREE because an <iframe> cannot send a request
 *     header, and raw mode has no other way to load anything. What authorises it
 *     is a single-use, short-lived ticket minted by /ticket: 32 random bytes,
 *     bound to one target and one mode, deleted BEFORE the upstream fetch, so it
 *     is already dead by the time the proxied page's own scripts run. A tampered
 *     `?url=`/`?mode=` on /view is ignored — the ticket alone decides the target.
 *     The token itself never appears in a URL, so it cannot leak through an
 *     iframe src, a referrer, a history entry or the framed page's own scripts.
 *   • Full SSRF guard *before* every request and again on every redirect hop:
 *     scheme allowlist, no IP literals in private/loopback/link-local/multicast/
 *     unspecified/reserved space, no `.local`/`.internal`/`localhost` names, and
 *     a DNS re-check of every resolved address.
 *   • No persistence, no caching, no injection, no `Set-Cookie` forwarding, and
 *     no URL logging unless --verbose.
 *
 * The module never starts a server on import: `start()` does that, and the CLI
 * entry point below calls it only when this file is the process entry point, so
 * tests can import `validateTargetUrl()` etc. directly.
 */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

export const PROXY_VERSION = '1.0.0';
export const DEFAULT_PORT = 8787;
/** The only interface this server may ever bind. */
export const LOOPBACK_HOST = '127.0.0.1';
/** Hard timeout for one upstream request. */
export const FETCH_TIMEOUT_MS = 10_000;
/** Hard cap on the upstream body we are willing to hand back. */
export const MAX_BYTES = 5 * 1024 * 1024;
/** Redirects are followed by hand, so every hop goes through validateTargetUrl(). */
export const MAX_REDIRECTS = 3;
/** A normal browser UA: the point is to fetch the page the user asked for, not to hide. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/**
 * Lifetime of one /view ticket. Long enough for the browser to start the frame
 * navigation, short enough that the ticket is dead almost immediately; it is
 * deleted on first use anyway, so this only bounds an UNUSED one.
 */
export const TICKET_TTL_MS = 60_000;
/** At most this many live tickets; the oldest is evicted beyond it. */
export const MAX_LIVE_TICKETS = 32;
/** A ticket is exactly 32 random bytes, lowercase hex. */
const TICKET_RE = /^[0-9a-f]{64}$/;

/* ──────────────────────────── SSRF guard: addresses ──────────────────────────── */

/** Parse a dotted-quad IPv4 literal into 4 octets, or null when it is not one. */
function parseIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Parse an IPv6 literal (as `URL.hostname` reports it: WITHOUT the brackets)
 * into 8 groups of 16 bits, or null.
 *
 * Supported: `::` compression, a trailing dotted-quad, IPv4-mapped/compatible
 * forms. A scope suffix (`fe80::1%eth0`) is stripped first, so it cannot be used
 * to smuggle an address past the range checks.
 */
function parseIpv6(host) {
  let rest = host;
  const pct = rest.indexOf('%'); // strip a zone id so it cannot smuggle a link-local past us
  if (pct !== -1) rest = rest.slice(0, pct);
  if (!rest.includes(':')) return null;

  // `::` is located FIRST, on the raw literal, and only then is a trailing
  // dotted-quad split off the tail half, AT ITS OWN COLON. Both details matter:
  // decoding the quad first (from the end of the whole literal) also removes the
  // second colon of the `::` in forms such as `64:ff9b::1.2.3.4`, and parsing the
  // tail half from its first colon would feed `ffff:192.168.1.1` to the IPv4
  // parser in `::ffff:192.168.1.1`.
  const double = rest.indexOf('::');
  let headPart = double === -1 ? rest : rest.slice(0, double);
  let tailPart = double === -1 ? '' : rest.slice(double + 2);

  let tail = [];
  if (tailPart.includes('.')) {
    const colon = tailPart.lastIndexOf(':');
    const v4 = parseIpv4(colon === -1 ? tailPart : tailPart.slice(colon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    tailPart = colon === -1 ? '' : tailPart.slice(0, colon);
  } else if (double === -1) {
    const headColon = headPart.lastIndexOf(':');
    const last = headPart.slice(headColon + 1);
    if (last.includes('.')) {
      const v4 = parseIpv4(last);
      if (!v4) return null;
      tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
      headPart = headPart.slice(0, headColon);
    }
  }

  const before = headPart === '' ? [] : headPart.split(':');
  const afterGroups = tailPart === '' ? [] : tailPart.split(':');
  for (const p of [...before, ...afterGroups]) {
    if (p === '' || !/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
  }

  if (double === -1) {
    if (before.length !== 8) return null;
    return before.map((p) => parseInt(p, 16));
  }
  if (before.length + afterGroups.length + tail.length > 7) return null; // "::" = >= 1 group
  const fill = 8 - before.length - afterGroups.length - tail.length;
  return [
    ...before.map((p) => parseInt(p, 16)),
    ...Array(fill).fill(0),
    ...afterGroups.map((p) => parseInt(p, 16)),
    ...tail,
  ];
}

/**
 * The full private/reserved range list, mirroring the client-side copy in
 * src/apps/web/local-proxy.ts. Returns true for anything that is NOT a public
 * unicast address — which includes every address we cannot parse at all
 * (fail closed).
 *
 *   IPv4: 0.0.0.0/8           "this network" / unspecified
 *         10.0.0.0/8          private
 *         100.64.0.0/10       CGNAT / shared address space
 *         127.0.0.0/8         loopback
 *         169.254.0.0/16      link-local
 *         172.16.0.0/12       private
 *         192.0.0.0/24        IETF protocol assignments
 *         192.0.2.0/24        TEST-NET-1
 *         192.88.99.0/24      6to4 relay anycast
 *         192.168.0.0/16      private
 *         198.18.0.0/15       benchmarking
 *         198.51.100.0/24     TEST-NET-2
 *         203.0.113.0/24      TEST-NET-3
 *         224.0.0.0/4         multicast
 *         240.0.0.0/4         reserved (incl. 255.255.255.255 broadcast)
 *   IPv6:  ::/128              unspecified
 *          ::1/128             loopback
 *          ::ffff:a.b.c.d/96   IPv4-mapped → re-checked as IPv4
 *          ::a.b.c.d/96        IPv4-compatible → re-checked as IPv4
 *          64:ff9b::/96        NAT64                     (reserved)
 *          100::/64            discard-only
 *          2001:2::/48         benchmarking
 *          2001:db8::/32       documentation
 *          2001:10::/28        ORCHID
 *          fc00::/7            unique local
 *          fe80::/10           link-local
 *          ff00::/8            multicast
 *          3fff::/20           documentation
 */
export function isPrivateAddress(host) {
  if (typeof host !== 'string' || host === '') return true;
  // A trailing dot is the same FQDN to DNS; strip it so `localhost.` is caught.
  let h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === '') return true;

  const v4 = parseIpv4(h);
  if (v4) return isPrivateV4(v4);

  const v6 = parseIpv6(h);
  if (v6) return isPrivateV6(v6);

  // A hostname that is not an address literal is not our job here (DNS lookup
  // and the name blocklist handle it), but a bare IPv4 in another notation
  // (decimal/hex/octal) must not slip through: refuse anything all-numeric.
  if (/^[0-9]+$/.test(h)) return true;
  if (/^0x[0-9a-f]+$/.test(h)) return true;
  return false;
}

function isPrivateV4(o) {
  const [a, b] = o;
  if (a === 0) return true;                                   // 0.0.0.0/8
  if (a === 10) return true;                                  // 10/8
  if (a === 127) return true;                                 // loopback
  if (a === 169 && b === 254) return true;                    // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
  if (a === 192 && b === 168) return true;                    // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
  if (a >= 224) return true;                                  // multicast + reserved
  if (a === 192 && b === 0 && o[2] === 0) return true;        // 192.0.0/24
  if (a === 192 && b === 0 && o[2] === 2) return true;        // TEST-NET-1
  if (a === 192 && b === 88 && o[2] === 99) return true;      // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return true;     // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true;      // TEST-NET-3
  return false;
}

function isPrivateV6(g) {
  const allZero = g.every((x) => x === 0);
  if (allZero) return true;                                   // ::
  const loopback = g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
  if (loopback) return true;                                  // ::1
  const top = g[0];
  if ((top & 0xfe00) === 0xfc00) return true;                 // fc00::/7
  if ((top & 0xffc0) === 0xfe80) return true;                 // fe80::/10
  if ((top & 0xff00) === 0xff00) return true;                 // ff00::/8 multicast
  if (top === 0x0064 && g[1] === 0xff9b) return true;         // 64:ff9b::/96 NAT64
  if (top === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  if (top === 0x2001 && g[1] === 0x0db8) return true;         // 2001:db8::/32 docs
  if (top === 0x2001 && (g[1] & 0xfff0) === 0x0010) return true; // 2001:10::/28 ORCHID
  if (top === 0x2001 && g[1] === 0x0002) return true;         // 2001:2::/48 benchmarking
  if (top === 0x3fff && (g[1] & 0xf000) === 0) return true;   // 3fff::/20 documentation
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): re-check as
  // IPv4, so ::ffff:192.168.1.1 and friends are caught as the IPv4 they are.
  const maskedV4Like = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
  if (maskedV4Like && isPrivateV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff])) return true;
  return false;
}

/** Hostnames that are never a valid public target, whatever DNS says. */
export function isBlockedHostname(host) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  if (h === '' ) return true;
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.internal')) return true;
  // A name with no dot is a private/NetBIOS style name, never a public site.
  if (!h.includes('.')) return true;
  return false;
}

/**
 * The SSRF guard. Called BEFORE any request and again for every redirect hop.
 *
 * @param {string} raw            the candidate URL
 * @param {{ allow?: string[] | null, resolve?: boolean }} [opts]
 *   `allow`   — when non-empty, only these hostnames are permitted (--allow).
 *   `resolve` — when true (default), every DNS answer is checked too.
 * @returns {Promise<{ ok: true, url: URL } | { ok: false, reason: string }>}
 */
export async function validateTargetUrl(raw, opts = {}) {
  const allow = opts.allow && opts.allow.length ? opts.allow.map((h) => h.toLowerCase()) : null;
  const doResolve = opts.resolve !== false;

  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: 'target is not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme not allowed: ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'missing host' };
  if (allow && !allow.includes(host)) return { ok: false, reason: `host not in --allow list: ${host}` };
  // The address check comes BEFORE the name check: an IPv6 literal such as
  // `[::1]` has no dot, so the bare-name rule would otherwise report it as a
  // "host name not allowed" and hide the fact that it is loopback.
  if (isPrivateAddress(host)) return { ok: false, reason: `host resolves to a non-public address: ${host}` };
  if (isBlockedHostname(host)) return { ok: false, reason: `host name not allowed: ${host}` };

  if (doResolve) {
    let answers;
    try {
      answers = await lookup(host, { all: true });
    } catch {
      return { ok: false, reason: `DNS lookup failed: ${host}` };
    }
    if (!Array.isArray(answers) || answers.length === 0) {
      return { ok: false, reason: `DNS lookup returned nothing: ${host}` };
    }
    for (const a of answers) {
      if (!a || typeof a.address !== 'string') return { ok: false, reason: `unusable DNS answer: ${host}` };
      if (isPrivateAddress(a.address)) {
        return { ok: false, reason: `host resolves to a non-public address: ${host}` };
      }
    }
  }
  return { ok: true, url };
}

/* ──────────────────────────────── CORS allowlist ──────────────────────────────── */

/**
 * The ONLY origins we ever echo back. Returns '' when the origin is not
 * allowed, and the caller then sends NO `access-control-allow-origin` header at
 * all — so a hostile page's fetch fails instead of silently reading the reply.
 * `*` is never sent.
 */
export function allowedOrigin(reqOrigin) {
  if (typeof reqOrigin !== 'string' || reqOrigin === '') return '';
  let u;
  try {
    u = new URL(reqOrigin);
  } catch {
    return '';
  }
  if (reqOrigin !== u.origin) return ''; // no trailing slash / path / junk
  if (u.origin === 'https://faisaldhd.github.io') return u.origin;
  if ((u.protocol === 'http:' && u.hostname === 'localhost') || (u.protocol === 'http:' && u.hostname === '127.0.0.1')) {
    return /^\d+$/.test(u.port) ? u.origin : '';
  }
  return '';
}

/* ──────────────────────────────── header surgery ─────────────────────────────── */

/**
 * Remove the `frame-ancestors` directive from a CSP value, keeping every other
 * directive intact. Returns null when nothing is left.
 */
export function stripFrameAncestors(csp) {
  const kept = String(csp)
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '' && !/^frame-ancestors(\s|$)/i.test(d));
  return kept.length ? kept.join('; ') : null;
}

/**
 * The response headers the proxied reply may carry.
 *
 *  • `x-frame-options`                     — deleted (this is the whole point)
 *  • `frame-ancestors` inside the CSP      — deleted, other directives kept
 *  • `content-security-policy-report-only` — deleted entirely
 *  • `content-type`                        — kept
 *  • `access-control-allow-origin`         — ONLY the allowlisted caller origin
 *  • `x-faisal-proxy`                      — 'raw' or 'reader'
 *  • Set-Cookie is never forwarded; `no-store` keeps anything off disk.
 */
export function proxyResponseHeaders(upstreamHeaders, mode, origin) {
  const out = {};
  for (const [rawName, rawValue] of Object.entries(upstreamHeaders ?? {})) {
    const name = rawName.toLowerCase();
    if (rawValue === undefined || rawValue === null) continue;
    if (name === 'x-frame-options') continue;
    if (name === 'content-security-policy-report-only') continue;
    if (name === 'set-cookie') continue;
    if (name === 'content-security-policy') {
      const stripped = stripFrameAncestors(Array.isArray(rawValue) ? rawValue.join('; ') : rawValue);
      if (stripped) out['content-security-policy'] = stripped;
      continue;
    }
    if (name === 'access-control-allow-origin' || name === 'access-control-allow-credentials') continue;
    out[name] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  out['x-faisal-proxy'] = mode;
  out['cache-control'] = 'no-store';
  if (origin) out['access-control-allow-origin'] = origin;
  return out;
}

/** Request headers sent upstream: identity encoding so the byte cap is honest. */
export function upstreamRequestHeaders(target) {
  return {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'ar,en;q=0.8',
    'accept-encoding': 'identity',
    host: target.host,
  };
}

/* ──────────────────────────────── upstream fetch ─────────────────────────────── */

/** Read a body stream, aborting the moment it exceeds MAX_BYTES. */
async function readCapped(body, limit) {
  if (!body) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks = [];
  let total = 0;
  let truncated = false;
  // eslint-disable-next-line no-unreachable-loop
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buf.length > limit) {
      chunks.push(buf.subarray(0, limit - total));
      truncated = true;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  if (truncated && typeof body.destroy === 'function') body.destroy();
  return { buffer: Buffer.concat(chunks), truncated };
}

/**
 * Fetch `rawUrl` with the SSRF guard applied to the first URL and to every
 * redirect hop, following at most MAX_REDIRECTS hops by hand.
 *
 * @returns {Promise<{ status:number, headers:object, buffer:Buffer, truncated:boolean,
 *                     finalUrl:string, contentType:string }>}
 * @throws {Error & { code?: string, status?: number }}
 */
export async function fetchGuarded(rawUrl, opts = {}) {
  const allow = opts.allow ?? null;
  const fetcher = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new Error('no fetch implementation available');

  let current = rawUrl;
  let hops = 0;
  for (;;) {
    const verdict = await validateTargetUrl(current, { allow });
    if (!verdict.ok) {
      const err = new Error(verdict.reason);
      err.code = 'E_TARGET';
      throw err;
    }
    const target = verdict.url;
    let res;
    try {
      res = await fetcher(target.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: upstreamRequestHeaders(target),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      const err = new Error(`upstream request failed: ${e && e.message ? e.message : 'unknown error'}`);
      err.code = 'E_UPSTREAM';
      throw err;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      // Drain the redirect body so the socket is released.
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      if (!location) {
        const err = new Error('upstream redirect without a Location header');
        err.code = 'E_UPSTREAM';
        throw err;
      }
      if (hops >= MAX_REDIRECTS) {
        const err = new Error(`too many redirects (>${MAX_REDIRECTS})`);
        err.code = 'E_REDIRECT';
        throw err;
      }
      hops += 1;
      let next;
      try {
        next = new URL(location, target).toString();
      } catch {
        const err = new Error('upstream redirect to an invalid Location');
        err.code = 'E_REDIRECT';
        throw err;
      }
      // Re-validated at the top of the loop — that is the point of doing this by hand.
      current = next;
      continue;
    }

    const { buffer, truncated } = await readCapped(res.body, MAX_BYTES);
    const headers = {};
    res.headers.forEach((value, name) => { headers[name] = value; });
    return {
      status: res.status,
      headers,
      buffer,
      truncated,
      finalUrl: target.toString(),
      contentType: headers['content-type'] ?? 'application/octet-stream',
    };
  }
}

/* ─────────────────────────────────── server ─────────────────────────────────── */

/** Loopback or nothing: there is no supported way to bind a public interface. */
export function assertLoopbackHost(host) {
  const h = String(host ?? '').trim();
  if (h === LOOPBACK_HOST || h === '::1') return h;
  throw new Error(`refusing to bind ${h}: this proxy only ever listens on ${LOOPBACK_HOST}`);
}

const json = (res, status, body, origin, extra = {}) => {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
};

/** Constant-time token comparison; never throws on a length mismatch. */
function tokenMatches(expected, provided) {
  if (!expected) return true; // auth: 'none' — the owner chose to run without a token
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Build (without listening) the proxy server. `start()` wraps this; tests can
 * use it with an injected fetch on an ephemeral port.
 *
 * `ticketTtlMs` (optional) overrides TICKET_TTL_MS for /ticket — the only reason
 * it exists is that a test must be able to expire one deterministically.
 */
export function createProxyServer(options = {}) {
  const token = options.token === undefined ? null : options.token;
  const allow = options.allow && options.allow.length ? options.allow.map((h) => h.toLowerCase()) : null;
  const verbose = options.verbose === true;
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  const ticketTtlMs = Number.isFinite(options.ticketTtlMs) && options.ticketTtlMs >= 0
    ? options.ticketTtlMs
    : TICKET_TTL_MS;

  /**
   * Live tickets, per server instance: ticket → { target, mode, expiresAt }.
   * In memory only, never written anywhere, and never logged — not even with
   * --verbose — because the ticket is a bearer credential for one fetch.
   */
  const tickets = new Map();

  /**
   * Run one guarded upstream fetch and answer EXACTLY like /fetch has always
   * answered: same header surgery, same per-mode content type, same truncation
   * marker, same status passthrough. Shared by /fetch (token in a header) and by
   * /view (single-use ticket) so the two replies can never drift apart.
   */
  async function serveTarget(req, res, target, mode, origin) {
    if (verbose) console.log(`[faisal-proxy] ${mode} ${target}`);

    let result;
    try {
      result = await fetchGuarded(target, { allow, fetchImpl: fetcher });
    } catch (e) {
      const status = e && e.code === 'E_TARGET' ? 403 : e && e.code === 'E_REDIRECT' ? 502 : 502;
      json(res, status, { error: e && e.message ? e.message : 'fetch failed' }, origin);
      return;
    }

    const headers = proxyResponseHeaders(result.headers, mode, origin);
    headers['content-type'] = mode === 'reader'
      ? 'text/plain; charset=utf-8'
      : (result.contentType || 'application/octet-stream');
    if (result.truncated) headers['x-faisal-proxy-truncated'] = '1';
    res.writeHead(result.status, headers);
    if (req.method === 'HEAD') {
      res.end();
    } else if (mode === 'reader') {
      // UTF-8 text of the same page; the CLIENT extracts the text. The proxy
      // never injects, rewrites or extracts anything.
      res.end(result.buffer.toString('utf8'));
    } else {
      res.end(result.buffer);
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'proxy error' }));
      } else {
        res.end();
      }
      if (verbose) console.error('[faisal-proxy] unhandled:', e && e.message ? e.message : e);
    });
  });
  server.headersTimeout = FETCH_TIMEOUT_MS + 5_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;

  async function handle(req, res) {
    const origin = allowedOrigin(req.headers.origin);
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }

    if (req.method === 'OPTIONS') {
      // Preflight. Answered for EVERY path, not only the token routes, because of
      // Chrome's Private Network Access rule: a request from a public page
      // (https://faisaldhd.github.io) to a loopback address is preflighted even
      // when it is a "simple" GET, and the preflight must carry
      // `Access-Control-Allow-Private-Network: true` or the browser refuses the
      // call. The probe hits /health, so a 405 there would have made the app
      // report "no proxy running" while the proxy was running perfectly.
      //
      // This grants nothing on its own: the header only says "yes, this is my own
      // loopback service"; Chrome may still show its own local-network permission
      // prompt, which the user answers. The token (and the ticket) remain the
      // real gates, and an origin that is not on the list still gets NO
      // allow-origin header at all, so the browser blocks the call.
      const headers = {
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': 'x-faisal-proxy-token',
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      };
      if (origin) {
        headers['access-control-allow-origin'] = origin;
        headers.vary = 'origin';
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'method not allowed' }, origin, { allow: 'GET, OPTIONS' });
      return;
    }

    if (url.pathname === '/health') {
      // Deliberately token-free: no page data and no target URL ever appears here.
      json(res, 200, { ok: true, version: PROXY_VERSION, auth: token ? 'token-required' : 'none' }, origin);
      return;
    }

    if (url.pathname === '/ticket') {
      // The iframe cannot send a header, so it gets a ticket for ONE fetch
      // instead. Minting is the token-gated step; /view then needs no token.
      if (!tokenMatches(token, req.headers['x-faisal-proxy-token'])) {
        json(res, 401, { error: 'invalid or missing token' }, origin);
        return;
      }
      const target = url.searchParams.get('url');
      const mode = url.searchParams.get('mode') ?? 'reader';
      if (mode !== 'reader' && mode !== 'raw') {
        json(res, 400, { error: 'mode must be reader or raw' }, origin);
        return;
      }
      if (!target) {
        json(res, 400, { error: 'missing url parameter' }, origin);
        return;
      }
      // Validate now, fetch never: the target is checked here so a refusal costs
      // no upstream request, and the ticket only ever names a target that already
      // passed the guard. fetchGuarded() re-checks it (and every redirect hop)
      // again at /view time — nothing here replaces that.
      const verdict = await validateTargetUrl(target, { allow });
      if (!verdict.ok) {
        json(res, 403, { error: verdict.reason }, origin);
        return;
      }
      const now = Date.now();
      // Drop what has already expired, then keep the store under the cap by
      // evicting the oldest (Map is in insertion order).
      for (const [key, entry] of tickets) {
        if (entry.expiresAt <= now) tickets.delete(key);
      }
      const ticket = randomBytes(32).toString('hex');
      tickets.set(ticket, { target: verdict.url.toString(), mode, expiresAt: now + ticketTtlMs });
      while (tickets.size > MAX_LIVE_TICKETS) {
        const oldest = tickets.keys().next().value;
        if (oldest === undefined || oldest === ticket) break;
        tickets.delete(oldest);
      }
      // The ticket itself is NEVER logged, whatever --verbose says: it is a
      // one-fetch bearer credential and a log file is a place it must not be.
      if (verbose) console.log(`[faisal-proxy] ticket minted for ${mode} (single use, ${ticketTtlMs} ms)`);
      json(res, 200, { ticket, expiresIn: ticketTtlMs }, origin);
      return;
    }

    if (url.pathname === '/view') {
      // Deliberately TOKEN-FREE (an <iframe> src cannot carry a header), and the
      // ticket is the only thing that authorises the fetch. Single use: it is
      // removed from the store HERE, before any upstream request, so a second use
      // — or any page whose script sees this URL — finds nothing. An expired
      // entry is deleted as well and reported as missing.
      //
      // Any `?url=` or `?mode=` on this request is IGNORED on purpose: the ticket
      // alone decides the target and the mode, so a tampered URL cannot retarget
      // a live ticket.
      const ticket = url.searchParams.get('ticket');
      if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) {
        json(res, 410, { error: 'ticket expired or already used' }, origin);
        return;
      }
      const entry = tickets.get(ticket) ?? null;
      if (entry) tickets.delete(ticket);
      if (!entry || entry.expiresAt <= Date.now()) {
        json(res, 410, { error: 'ticket expired or already used' }, origin);
        return;
      }
      await serveTarget(req, res, entry.target, entry.mode, origin);
      return;
    }

    if (url.pathname === '/fetch') {
      if (!tokenMatches(token, req.headers['x-faisal-proxy-token'])) {
        json(res, 401, { error: 'invalid or missing token' }, origin);
        return;
      }
      const target = url.searchParams.get('url');
      const mode = url.searchParams.get('mode') ?? 'reader';
      if (mode !== 'reader' && mode !== 'raw') {
        json(res, 400, { error: 'mode must be reader or raw' }, origin);
        return;
      }
      if (!target) {
        json(res, 400, { error: 'missing url parameter' }, origin);
        return;
      }
      await serveTarget(req, res, target, mode, origin);
      return;
    }

    json(res, 404, { error: 'not found' }, origin);
  }

  return server;
}

/** Bind and start listening. Rejects (never silently re-binds) on a bad host. */
export function start(options = {}) {
  const host = assertLoopbackHost(options.host ?? LOOPBACK_HOST);
  const port = options.port ?? DEFAULT_PORT;
  const token = options.token === undefined || options.token === null
    ? randomBytes(16).toString('hex')
    : String(options.token);
  const server = createProxyServer({ ...options, token });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({ server, host, port: actualPort, token, auth: 'token-required', base: `http://${host}:${actualPort}` });
    });
  });
}

/* ────────────────────────────────── CLI entry ────────────────────────────────── */

export function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, token: null, verbose: false, allow: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === '--port' || arg === '-p') {
      const raw = next();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid port: ${raw}`);
      opts.port = n;
    } else if (arg === '--token' || arg === '-t') {
      opts.token = next();
    } else if (arg === '--verbose' || arg === '-v') {
      opts.verbose = true;
    } else if (arg === '--allow' || arg === '-a') {
      const list = next().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!list.length) throw new Error('--allow needs at least one host');
      opts.allow = list;
    } else if (arg === '--host') {
      const h = next();
      if (h !== LOOPBACK_HOST) throw new Error(`--host is fixed at ${LOOPBACK_HOST}: this proxy is loopback-only`);
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * Only when this file is the process entry point — importing it starts nothing.
 * `pathToFileURL` (not string concatenation) is used because `process.argv[1]`
 * is a Windows path on this machine, and `file://D:\...` would never match
 * `import.meta.url`.
 */
export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`[faisal-proxy] ${e.message}`);
    console.error('usage: node tools/local-proxy.mjs [--port 8787] [--token <value>] [--verbose] [--allow host1,host2]');
    process.exitCode = 2;
    return null;
  }
  if (opts.help) {
    console.log('usage: node tools/local-proxy.mjs [--port 8787] [--token <value>] [--verbose] [--allow host1,host2]');
    return null;
  }

  let started;
  try {
    started = await start(opts);
  } catch (e) {
    console.error(`[faisal-proxy] could not start: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
    return null;
  }

  const origin = `http://${started.host}:${started.port}`;
  console.log('');
  console.log('  Fai$al OS — local proxy (OPT-IN / اختياري)');
  console.log(`  iframe / fetch base : ${origin}`);
  console.log(`  reader endpoint     : ${origin}/fetch?url=<encoded>&mode=reader`);
  console.log(`  raw endpoint        : ${origin}/fetch?url=<encoded>&mode=raw`);
  console.log(`  ticket endpoint     : ${origin}/ticket?url=<encoded>&mode=raw  (token required)`);
  console.log(`  view endpoint       : ${origin}/view?ticket=<64 hex>          (single use, ${TICKET_TTL_MS / 1000} s, token-free)`);
  console.log(`  health              : ${origin}/health`);
  console.log(`  token               : ${started.token}`);
  if (opts.allow) console.log(`  --allow             : ${opts.allow.join(', ')}`);
  console.log('  WARNING: opt-in escape hatch — it bypasses a site’s own framing preference for');
  console.log('           sites you choose, and sites may still break (heavy JavaScript, logins).');
  console.log('  Listening on 127.0.0.1 only. Ctrl+C to stop. Nothing is written to disk.');
  console.log('');
  return started;
}

const isEntryPoint = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  // Fire-and-forget: main() handles its own errors and exit codes.
  void main();
}
