/**
 * Fai$al OS — client side of the OPT-IN local proxy (الوسيط المحلي الاختياري).
 *
 * This module is the browser half of tools/local-proxy.mjs. It is deliberately
 * pure where it can be: the URL builder, the address mirror and the storage
 * helpers know nothing about the DOM, so they are unit-tested directly.
 *
 * Security posture:
 *  • The token is stored ONLY under `faisal.web.proxy.token` in localStorage and
 *    is sent ONLY to the proxy base URL, in the `x-faisal-proxy-token` header.
 *    It never enters an address bar, a history entry, a logged string or a URL
 *    that is rendered anywhere.
 *  • An iframe cannot send a request header at all, so the frame NEVER gets the
 *    token: `requestProxyTicket()` authenticates the token on `GET /ticket`, and
 *    the frame then loads `GET /view?ticket=<64 hex>`, which is deliberately
 *    token-free and single-use and decides the target and mode by itself.
 *  • `isPrivateAddress()` is a CLIENT-SIDE MIRROR used to warn before we call.
 *    It is NOT a guard: the proxy re-validates every target and every redirect
 *    hop itself (tools/local-proxy.mjs `validateTargetUrl`). A compromised
 *    client cannot widen the server's SSRF policy, because the server never
 *    trusts anything but `--allow` and its own address checks.
 *  • Nothing here is enabled silently: `writeProxyEnabled(storage, true)` is
 *    called only from the window, after the owner picks the proxy action.
 */

/** Default port of tools/local-proxy.mjs. */
export const DEFAULT_PROXY_PORT = 8787;
/** How long a /health probe may take before the proxy counts as unreachable. */
export const PROBE_TIMEOUT_MS = 1200;

export const PROXY_TOKEN_KEY = 'faisal.web.proxy.token';
export const PROXY_PORT_KEY = 'faisal.web.proxy.port';
export const PROXY_ENABLED_KEY = 'faisal.web.proxy.enabled';

/** What the window should show for the proxy action. */
export interface ProxyProbe {
  available: boolean;
  version: string | null;
  auth: 'none' | 'token-required' | null;
  /** Which proxy answered; the local tool predates the field and means 'local'. */
  kind?: 'local' | 'cloud';
  /** The sub-modes it serves; the local tool serves both. */
  modes?: ProxyMode[];
}

/** The one storage surface the helpers touch: injected, never read globally. */
export interface ProxyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ProxyMode = 'reader' | 'raw';

/* ─────────────────────────────── base URL + probe ─────────────────────────────── */

/** The loopback base every proxy call goes to. Always 127.0.0.1, never a remote host. */
export function proxyBaseUrl(port: number = DEFAULT_PROXY_PORT): string {
  return `http://127.0.0.1:${port}`;
}

/* ─────────────────────────────── the cloud proxy ─────────────────────────────── */

/**
 * The owner's token-gated cloud proxy (tools/cloud-proxy.mjs, served by
 * functions/proxy on Cloudflare Pages). Reader mode only. These are the ONLY
 * remote bases a proxy URL may ever be built against.
 */
export const CLOUD_PROXY_BASE = 'https://faisal-os.pages.dev/proxy';
const CLOUD_BASE_RE = /^https:\/\/(?:[a-z0-9-]+\.)?faisal-os\.pages\.dev\/proxy$/;

export function isCloudProxyBase(base: string): boolean {
  return CLOUD_BASE_RE.test(String(base));
}

/**
 * The cloud proxy to use from a page served at `origin`: its own /proxy on the
 * Cloudflare site (production or a preview build), the production one from the
 * GitHub Pages mirror, and none anywhere else (local dev, the desktop build).
 */
export function cloudProxyBaseFor(origin: string): string | null {
  const candidate = `${origin}/proxy`;
  if (isCloudProxyBase(candidate)) return candidate;
  if (origin === 'https://faisaldhd.github.io') return CLOUD_PROXY_BASE;
  return null;
}

/**
 * The origins the proxy is allowed to be loaded from. Kept here (not only in the
 * proxy) so the client can refuse to build a URL against something else, and so
 * the values are easy to review side by side with `allowedOrigin()` in the tool.
 */
export function isAllowedProxyBase(base: string): boolean {
  if (isCloudProxyBase(base)) return true;
  let u: URL;
  try {
    u = new URL(String(base));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:') return false;
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
  if (!/^\d+$/.test(u.port)) return false;
  // No path, query or credentials may sneak into the base we build on.
  return (u.pathname === '/' || u.pathname === '') && u.search === '' && u.hash === '' && !u.username && !u.password;
}

/**
 * Ask the local proxy whether it is running. NEVER throws: a missing proxy, a
 * refused connection, a timeout or junk JSON all come back as `available:false`,
 * which is what keeps the fallback card's third action hidden until the owner
 * has actually started the tool.
 */
export async function probeLocalProxy(
  base: string = proxyBaseUrl(),
  timeoutMs: number = PROBE_TIMEOUT_MS,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProxyProbe> {
  const unavailable: ProxyProbe = { available: false, version: null, auth: null };
  if (!isAllowedProxyBase(base)) return unavailable;
  if (typeof fetchImpl !== 'function') return unavailable;
  // /health needs no token — it carries no page data and no target URL.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs)) : null;
  try {
    const res = await fetchImpl(`${base}/health`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
      cache: 'no-store',
    });
    if (!res.ok) return unavailable;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object') return unavailable;
    const record = body as Record<string, unknown>;
    if (record.ok !== true) return unavailable;
    const auth = record.auth === 'token-required' || record.auth === 'none' ? record.auth : null;
    const kind = record.kind === 'cloud' ? 'cloud' : 'local';
    const modes = Array.isArray(record.modes)
      ? record.modes.filter((m): m is ProxyMode => m === 'reader' || m === 'raw')
      : (['reader', 'raw'] as ProxyMode[]);
    // A cloud proxy is never "open": it must ask for the owner's token.
    if (kind === 'cloud' && auth !== 'token-required') return unavailable;
    if (!modes.length) return unavailable;
    return {
      available: true,
      version: typeof record.version === 'string' ? record.version : null,
      auth,
      kind,
      modes,
    };
  } catch {
    return unavailable;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/* ──────────────────────────────── token storage ──────────────────────────────── */

/** A store that remembers nothing, so a blocked localStorage degrades quietly. */
export const NO_PROXY_STORAGE: ProxyStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/** localStorage when the browser allows it, else a no-op store. Never throws. */
export function proxyStorageOrNull(): ProxyStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readProxyToken(storage: ProxyStorage): string | null {
  try {
    const raw = storage.getItem(PROXY_TOKEN_KEY);
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

/** Returns true only when the value actually landed in the store. */
export function writeProxyToken(storage: ProxyStorage, token: string): boolean {
  const value = String(token ?? '').trim();
  if (!value) return false;
  try {
    storage.setItem(PROXY_TOKEN_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function clearProxyToken(storage: ProxyStorage): void {
  try {
    storage.removeItem(PROXY_TOKEN_KEY);
  } catch {
    /* best effort */
  }
}

/** The port the owner last used, or the default. Junk falls back to the default. */
export function readProxyPort(storage: ProxyStorage): number {
  try {
    const raw = storage.getItem(PROXY_PORT_KEY);
    if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return DEFAULT_PROXY_PORT;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PROXY_PORT;
  } catch {
    return DEFAULT_PROXY_PORT;
  }
}

export function writeProxyPort(storage: ProxyStorage, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    storage.setItem(PROXY_PORT_KEY, String(port));
    return true;
  } catch {
    return false;
  }
}

/**
 * Strict flag parsing: ONLY the exact strings `'true'` and `'false'` count.
 * Anything else (missing, `'1'`, `'yes'`, a corrupt value) reads as `false`, so
 * an unreadable store can never switch the proxy on by accident.
 */
export function readProxyEnabled(storage: ProxyStorage): boolean {
  try {
    const raw = storage.getItem(PROXY_ENABLED_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return false;
  } catch {
    return false;
  }
}

export function writeProxyEnabled(storage: ProxyStorage, enabled: boolean): void {
  try {
    storage.setItem(PROXY_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    /* best effort: the flag is a nicety, never a gate */
  }
}

/* ─────────────────────────────── URL construction ─────────────────────────────── */

/**
 * /fetch ignores the fragment (it is never sent to a server anyway) but its
 * PRESENCE would expose the token-bearing URL to the browser's own history and
 * referrer machinery, so a `#fragment` target is refused outright — and `#`
 * itself is refused because it is exactly how `<script src="#">`-style
 * exfiltration splits a URL out of a token; the proxy URL must never end early.
 */
const UNSAFE_TARGET_RE = /[\s<>"'`\\\u0000-\u001f\u007f]|#|\{\{|\}\}/;

/**
 * The one place a `/fetch` or `/ticket` URL is built. The token is NEVER part of
 * it: it travels in a header, so this string is safe to hand to an iframe `src`
 * and safe to keep out of any log.
 *
 * @throws when the target or the mode is malformed, or when `base` is not the
 *         loopback proxy — a caller must never be able to point this elsewhere.
 */
function buildProxyEndpointUrl(
  base: string,
  endpoint: '/fetch' | '/ticket',
  targetUrl: string,
  mode: ProxyMode,
): string {
  if (mode !== 'reader' && mode !== 'raw') throw new Error(`unsupported proxy mode: ${mode}`);
  if (!isAllowedProxyBase(base)) throw new Error(`refusing to build a proxy URL for base: ${base}`);
  const target = String(targetUrl ?? '').trim();
  if (!/^https?:\/\/[^/?#\s]+/i.test(target)) throw new Error(`refusing to proxy a non-http(s) target: ${target}`);
  if (UNSAFE_TARGET_RE.test(target)) throw new Error('refusing to proxy a target containing whitespace, quotes or a fragment');
  return `${base}${endpoint}?url=${encodeURIComponent(target)}&mode=${mode}`;
}

/** Build the `/fetch` URL for one target. Kept exactly as it always was. */
export function buildProxyUrl(base: string, targetUrl: string, mode: ProxyMode = 'reader'): string {
  return buildProxyEndpointUrl(base, '/fetch', targetUrl, mode);
}

/** A ticket is exactly 32 random bytes as lowercase hex (64 characters). */
export const PROXY_TICKET_RE = /^[0-9a-f]{64}$/;

/**
 * The URL an iframe may load: `/view?ticket=<hex>`.
 *
 * This is the ONLY proxy URL that can ever end up in an iframe `src`, because an
 * iframe cannot send the `x-faisal-proxy-token` header at all. Its ticket is
 * single-use and already dead before the framed page's own scripts run, and it
 * carries no token, no target and no mode — so this string is safe to expose to
 * the browser's own referrer/history machinery and to the page it frames.
 *
 * @throws when `base` is not the loopback proxy, or the ticket is not 64 hex
 *         characters — the same strictness as `buildProxyUrl`.
 */
export function buildProxyViewUrl(base: string, ticket: string): string {
  if (!isAllowedProxyBase(base)) throw new Error(`refusing to build a proxy view URL for base: ${base}`);
  const value = String(ticket ?? '').trim();
  if (!PROXY_TICKET_RE.test(value)) throw new Error('refusing to build a proxy view URL without a well-formed ticket');
  return `${base}/view?ticket=${encodeURIComponent(value)}`;
}

/** Why a ticket could not be obtained; each maps to its own sentence in the UI. */
export type ProxyTicketFailure = 'unauthorized' | 'unreachable' | 'refused' | 'malformed';

export type ProxyTicketResult =
  | { ok: true; ticket: string }
  | { ok: false; reason: ProxyTicketFailure };

/**
 * Ask the proxy for a single-use ticket to ONE target+mode. This is what lets an
 * iframe load anything at all: the token authenticates THIS call, in the
 * `x-faisal-proxy-token` header and nowhere else, and the ticket it returns is
 * what the frame's URL will carry.
 *
 * NEVER throws — every failure is one of four reasons, because a raw embed must
 * render an honest error card instead of a blank frame. The mapping is pinned by
 * a table in local-proxy.test.ts:
 *
 *   401             → 'unauthorized' (wrong or missing token)
 *   403 or other 4xx→ 'refused'      (the proxy refused this request/target)
 *   5xx or junk body→ 'malformed'    (it answered, but not usably)
 *   network failure → 'unreachable'  (the proxy is not answering there)
 *   unbuildable URL → 'refused'      (we refuse to ask our own proxy at all)
 *
 * 403 is deliberately NOT folded into 'unauthorized': the proxy uses 401 for a
 * bad token and 403 for a target its SSRF guard refuses (the guard's reason is
 * in the body), and telling a user with a correct token that his token is wrong
 * would be a lie about which thing failed.
 */
export async function requestProxyTicket(
  base: string,
  targetUrl: string,
  mode: ProxyMode,
  token: string | null,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProxyTicketResult> {
  let url: string;
  try {
    url = buildProxyEndpointUrl(base, '/ticket', targetUrl, mode);
  } catch {
    return { ok: false, reason: 'refused' };
  }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'unreachable' };
  const headers: Record<string, string> = { accept: 'application/json' };
  // The token goes to the proxy base and NOWHERE else — never into `url`, so it
  // cannot end up in an iframe src, a history entry, a title or a log.
  if (token) headers['x-faisal-proxy-token'] = token;

  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', headers, cache: 'no-store' });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!res || typeof res.status !== 'number') return { ok: false, reason: 'malformed' };
  if (res.status === 401) return { ok: false, reason: 'unauthorized' };
  if (res.status >= 400 && res.status < 500) return { ok: false, reason: 'refused' };
  if (res.status < 200 || res.status >= 300) return { ok: false, reason: 'malformed' };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!body || typeof body !== 'object') return { ok: false, reason: 'malformed' };
  const ticket = (body as Record<string, unknown>).ticket;
  if (typeof ticket !== 'string' || !PROXY_TICKET_RE.test(ticket)) return { ok: false, reason: 'malformed' };
  return { ok: true, ticket };
}

/* ──────────────────────────── address mirror (warn only) ──────────────────────────── */

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/**
 * Parse an IPv6 literal (as `URL.hostname` reports it: without the brackets)
 * into 8 groups of 16 bits, or null.
 *
 * Kept deliberately parallel to the tool's copy. `::` is located FIRST, on the
 * raw literal, and only then is a trailing dotted-quad split off the tail half:
 * decoding the quad first also removes the second colon of the `::` in forms
 * like `64:ff9b::1.2.3.4`, which is exactly the kind of mapped address this
 * check exists to catch.
 */
function parseIpv6(host: string): number[] | null {
  let rest = host;
  const pct = rest.indexOf('%');
  if (pct !== -1) rest = rest.slice(0, pct);
  if (!rest.includes(':')) return null;

  const double = rest.indexOf('::');
  let headPart = double === -1 ? rest : rest.slice(0, double);
  let tailPart = double === -1 ? '' : rest.slice(double + 2);

  let tail: number[] = [];
  if (tailPart.includes('.')) {
    // Split the quad off at ITS OWN colon: the tail half of `::ffff:192.168.1.1`
    // is `ffff:192.168.1.1`, and the IPv4 parser must not see the `ffff:` part.
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
  if (before.length + afterGroups.length + tail.length > 7) return null;
  const fill = 8 - before.length - afterGroups.length - tail.length;
  return [
    ...before.map((p) => parseInt(p, 16)),
    ...Array(fill).fill(0),
    ...afterGroups.map((p) => parseInt(p, 16)),
    ...tail,
  ];
}

function isPrivateV4(o: number[]): boolean {
  const [a, b] = o;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  if (a === 192 && b === 0 && o[2] === 0) return true;
  if (a === 192 && b === 0 && o[2] === 2) return true;
  if (a === 192 && b === 88 && o[2] === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && o[2] === 100) return true;
  if (a === 203 && b === 0 && o[2] === 113) return true;
  return false;
}

function isPrivateV6(g: number[]): boolean {
  if (g.every((x) => x === 0)) return true;                                     // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;           // ::1
  const top = g[0];
  if ((top & 0xfe00) === 0xfc00) return true;                                   // fc00::/7
  if ((top & 0xffc0) === 0xfe80) return true;                                   // fe80::/10
  if ((top & 0xff00) === 0xff00) return true;                                   // ff00::/8
  if (top === 0x0064 && g[1] === 0xff9b) return true;                           // NAT64
  if (top === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;    // 100::/64
  if (top === 0x2001 && g[1] === 0x0db8) return true;                           // 2001:db8::/32
  if (top === 0x2001 && (g[1] & 0xfff0) === 0x0010) return true;                // 2001:10::/28
  if (top === 0x2001 && g[1] === 0x0002) return true;                           // 2001:2::/48
  if (top === 0x3fff && (g[1] & 0xf000) === 0) return true;                     // 3fff::/20
  const maskedV4Like = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
  if (maskedV4Like && isPrivateV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff])) return true;
  return false;
}

/**
 * CLIENT-SIDE MIRROR of the proxy's range check — used to warn before calling,
 * never as the guard itself. The full list is in tools/local-proxy.mjs.
 * Unparseable values return true (fail closed), which is what makes a bad
 * address a warning rather than a silent attempt.
 */
export function isPrivateAddress(host: string): boolean {
  if (typeof host !== 'string' || host === '') return true;
  let h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === '') return true;

  const v4 = parseIpv4(h);
  if (v4) return isPrivateV4(v4);
  const v6 = parseIpv6(h);
  if (v6) return isPrivateV6(v6);
  // Bare decimal/hex IPv4 spellings must not slip through as "hostnames".
  if (/^[0-9]+$/.test(h)) return true;
  if (/^0x[0-9a-f]+$/.test(h)) return true;
  return false;
}

/** Hostnames the proxy refuses outright; mirrored here for the same warning. */
export function isBlockedHostname(host: string): boolean {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  if (h === '') return true;
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.internal')) return true;
  if (!h.includes('.')) return true;
  return false;
}

/**
 * Would the proxy refuse this target? Used to show the warning BEFORE the
 * request, so an obvious mistake (an intranet address, a non-http scheme) never
 * leaves the window. The proxy still decides for real, including DNS answers.
 */
export function warnBeforeProxying(targetUrl: string): string | null {
  const raw = String(targetUrl ?? '').trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'invalid-url';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'scheme';
  // `new URL('not a url')` SUCCEEDS (it resolves against the page's base), so an
  // absolute scheme must be present in the raw text as well.
  if (!/^https?:\/\//i.test(raw)) return 'invalid-url';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return 'invalid-url';
  // Address first: an IPv6 literal like `[::1]` has no dot and would otherwise be
  // misreported as a bare host name.
  if (isPrivateAddress(host)) return 'private-address';
  if (isBlockedHostname(host)) return 'host-name';
  return null;
}
