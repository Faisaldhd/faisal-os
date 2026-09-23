/**
 * Fai$al OS — the proxy guards shared by BOTH proxies:
 *   • tools/local-proxy.mjs  (the owner's opt-in loopback proxy, Node), and
 *   • functions/proxy/[[route]].js (the owner's token-gated cloud proxy on
 *     Cloudflare Pages Functions).
 *
 * Pure, dependency-free JavaScript with no Node or Workers API, so the same
 * checks run unchanged in both runtimes. Moved here verbatim from
 * tools/local-proxy.mjs, which re-exports everything for its existing callers.
 */
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

/* ──────────────────────────────── CORS allowlist ──────────────────────────────── */

/**
 * The published origins of the OS itself. Adding a host here is what lets a page
 * served from it talk to this proxy at all; anything else gets no CORS header and
 * the browser blocks the call. `faisal-os.pages.dev` is the Cloudflare Pages
 * deployment, added after the owner moved there because GitHub Pages' address
 * range became unreachable from his network.
 */
export const ALLOWED_APP_ORIGINS = [
  'https://faisaldhd.github.io',
  'https://faisal-os.pages.dev',
];

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
  if (ALLOWED_APP_ORIGINS.includes(u.origin)) return u.origin;
  // Cloudflare Pages preview deployments get a per-build subdomain of the
  // project's own pages.dev domain. Only this project's previews match, and the
  // token is still required for anything real.
  if (/^https:\/\/[a-z0-9-]+\.faisal-os\.pages\.dev$/.test(u.origin)) return u.origin;
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
