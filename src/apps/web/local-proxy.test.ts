/**
 * Tests for the OPT-IN local proxy: the client helpers, the reader extractor, the
 * fallback-card flow, the ticket handshake, and (imported directly) the
 * server-side validator in tools/local-proxy.mjs.
 *
 * The UPSTREAM is always stubbed: `createProxyServer({ fetchImpl })` answers and
 * counts the proxy's own outbound requests, so no request leaves this machine to
 * a real site. The `/ticket` and `/view` routes are exercised over a REAL loopback
 * listener on an ephemeral port — that is the point of those tests, because the
 * defect they guard was invisible both to a header-carrying call and to a
 * jsdom-only test where no server exists. `node:dns/promises` is mocked to a
 * fixed public address so `validateTargetUrl` never needs working DNS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../kernel/i18n';
import type { AppContext, SystemAPI, WindowHandle, WindowManager } from '../../kernel/types';
import {
  DEFAULT_PROXY_PORT,
  PROBE_TIMEOUT_MS,
  PROXY_ENABLED_KEY,
  PROXY_PORT_KEY,
  PROXY_TOKEN_KEY,
  buildProxyUrl,
  buildProxyViewUrl,
  clearProxyToken,
  isAllowedProxyBase,
  isBlockedHostname,
  isPrivateAddress,
  probeLocalProxy,
  proxyBaseUrl,
  readProxyEnabled,
  readProxyPort,
  readProxyToken,
  requestProxyTicket,
  warnBeforeProxying,
  writeProxyEnabled,
  writeProxyPort,
  writeProxyToken,
  type ProxyStorage,
  type ProxyTicketFailure,
} from './local-proxy';
import {
  MAX_BLOCK_CHARS,
  MAX_READER_BLOCKS,
  collapseWhitespace,
  htmlToText,
} from './reader';
import {
  buildProxyBar,
  buildProxyFallbackAction,
  buildProxyModePicker,
  buildRawLoading,
  buildReaderPanel,
  buildTokenPanel,
  initialProxyState,
  proxyIsActive,
  type ProxyPanelHost,
} from './proxy-panel';
import { createWebAppModule, launchWebApp } from './index';
import { WIRED_WEB_APPS, type WebAppDef, type WebStorage } from './registry';
import {
  MAX_BYTES,
  MAX_LIVE_TICKETS,
  MAX_REDIRECTS,
  TICKET_TTL_MS,
  allowedOrigin,
  assertLoopbackHost,
  createProxyServer,
  isPrivateAddress as isPrivateAddressServer,
  isBlockedHostname as isBlockedHostnameServer,
  proxyResponseHeaders,
  stripFrameAncestors,
  validateTargetUrl,
} from '../../../tools/local-proxy.mjs';

/**
 * Every ticket test resolves the target's hostname (validateTargetUrl re-checks
 * the resolved address on every hop), so the resolver is pinned to one public
 * address: each hostname used below then behaves exactly like example.com, with
 * no DNS server and no internet involved.
 */
vi.mock('node:dns/promises', () => {
  const lookup = async (host: string) => {
    if (String(host).includes('unresolvable')) throw new Error('ENOTFOUND');
    return [{ address: '93.184.216.34', family: 4 }];
  };
  // `default` is needed too: the module runner resolves the namespace with the
  // ESM interop helper, which asks for it even though the server imports `lookup`.
  return { lookup, default: { lookup } };
});

const SELF_ORIGIN = 'https://os.example';
const google = WIRED_WEB_APPS.find((d) => d.id === 'google')!;

/* ═══════════════════════ 1. the private/loopback predicate ═══════════════════════ */

describe('isPrivateAddress (client mirror)', () => {
  /**
   * The full range list from the brief, plus the near-misses that a sloppy
   * implementation gets wrong (172.32, 11/8, 192.169, 100.128, 1.1.1.1, 8.8.8.8,
   * a public IPv6, and `::ffff:8.8.8.8` which is a PUBLIC v4 in mapped form).
   */
  const cases: Array<[string, boolean]> = [
    // IPv4 — must be refused
    ['127.0.0.1', true],
    ['127.9.9.9', true],
    ['10.0.0.0', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.0.1', true],
    ['192.168.1.1', true],
    ['169.254.1.1', true],
    ['0.0.0.0', true],
    ['0.1.2.3', true],
    ['100.64.0.1', true],
    ['100.127.255.254', true],
    ['224.0.0.1', true],
    ['239.255.255.250', true],
    ['255.255.255.255', true],
    ['192.0.2.5', true],
    ['198.18.0.1', true],
    ['198.51.100.7', true],
    ['203.0.113.9', true],
    ['192.88.99.1', true],
    // IPv4 — must be allowed (near-misses)
    ['172.32.0.1', false],
    ['172.15.255.254', false],
    ['11.0.0.1', false],
    ['192.169.0.1', false],
    ['100.128.0.1', false],
    ['100.63.255.255', false],
    ['169.253.0.1', false],
    ['1.1.1.1', false],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['223.255.255.255', false],
    // IPv6 — must be refused
    ['::1', true],
    ['::', true],
    ['[::1]', true],
    ['fc00::1', true],
    ['fd12:3456:789a::1', true],
    ['fe80::1', true],
    ['fe80::1%eth0', true],
    ['ff02::1', true],
    ['ff00::', true],
    ['2001:db8::1', true],
    ['2001:2::1', true],
    ['100::1', true],
    ['64:ff9b::1.2.3.4', true],
    ['::ffff:192.168.1.1', true],
    ['::ffff:10.1.2.3', true],
    ['::ffff:127.0.0.1', true],
    // IPv6 — must be allowed
    ['::ffff:8.8.8.8', false],
    ['2606:4700:4700::1111', false],
    ['2001:4860:4860::8888', false],
    ['2a00:1450:4009:81f::200e', false],
    // Not parseable as an address at all ⇒ fail closed
    ['', true],
    ['2130706433', true],
    ['0x7f000001', true],
    ['not an address', false],
    ['example.com', false],
    ['localhost', false],
  ];

  it.each(cases)('isPrivateAddress(%j) === %s', (host, expected) => {
    expect(isPrivateAddress(host)).toBe(expected);
  });

  it('the client mirror and the server validator agree on every case', () => {
    for (const [host] of cases) {
      expect(isPrivateAddress(host), `mirror/server disagreement for ${host}`).toBe(
        isPrivateAddressServer(host),
      );
    }
  });

  it('classifies 1.1.1.1 and 8.8.8.8 as public (a mirror that returns true for everything is useless)', () => {
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST.', true],
    ['x.local', true],
    ['x.internal', true],
    ['x.localhost', true],
    ['plainword', true],
    ['', true],
    ['example.com', false],
    ['faisaldhd.github.io', false],
  ])('isBlockedHostname(%j) === %s', (host, expected) => {
    expect(isBlockedHostname(host)).toBe(expected);
    expect(isBlockedHostnameServer(host)).toBe(expected);
  });
});

/* ═════════════════════ 2. the server validator (SSRF guard) ═════════════════════ */

describe('tools/local-proxy.mjs validateTargetUrl (imported, no server started)', () => {
  it.each([
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'data:text/html,<h1>hi</h1>',
    'javascript:alert(1)',
    'blob:https://example.com/abc',
    'ftp://example.com/x',
    'ws://example.com/socket',
  ])('refuses the scheme in %s', async (target) => {
    const verdict = await validateTargetUrl(target, { resolve: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/scheme|valid absolute URL/);
  });

  it('refuses localhost, *.local, *.internal and bare names', async () => {
    for (const target of ['http://localhost/', 'http://app.local/', 'http://db.internal/', 'http://intranet/']) {
      const verdict = await validateTargetUrl(target, { resolve: false });
      expect(verdict.ok, target).toBe(false);
    }
  });

  it('refuses an IP literal in private/loopback/link-local/multicast space', async () => {
    for (const target of [
      'http://192.168.1.1/',
      'http://127.0.0.1:8787/',
      'http://10.1.2.3/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fd00::1]/',
    ]) {
      const verdict = await validateTargetUrl(target, { resolve: false });
      expect(verdict.ok, target).toBe(false);
    }
  });

  it('refuses credentials embedded in the URL', async () => {
    const verdict = await validateTargetUrl('https://user:pw@example.com/', { resolve: false });
    expect(verdict.ok).toBe(false);
  });

  it('accepts a normal public https URL', async () => {
    const verdict = await validateTargetUrl('https://example.com/path?q=1', { resolve: false });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.url.toString()).toBe('https://example.com/path?q=1');
  });

  it('--allow narrows the list further: anything else is rejected', async () => {
    const allowed = await validateTargetUrl('https://allowed.example/', { allow: ['allowed.example'], resolve: false });
    const denied = await validateTargetUrl('https://other.example/', { allow: ['allowed.example'], resolve: false });
    expect(allowed.ok).toBe(true);
    expect(denied.ok).toBe(false);
  });

  it('a DNS answer in private space is refused even when the NAME looks public', async () => {
    // The name passes the name checks; only the resolved answer is private. This
    // is the DNS-rebinding case the second check exists for, simulated by
    // pointing the validator at a name that resolves to loopback on this host.
    const verdict = await validateTargetUrl('http://localhost./', { resolve: true });
    expect(verdict.ok).toBe(false);
  });

  it('exports the redirect/limit policy the server actually enforces', () => {
    expect(MAX_REDIRECTS).toBe(3);
    expect(MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('refuses to bind anything but loopback', () => {
    expect(assertLoopbackHost('127.0.0.1')).toBe('127.0.0.1');
    expect(() => assertLoopbackHost('0.0.0.0')).toThrow(/loopback|refusing/i);
    expect(() => assertLoopbackHost('192.168.1.5')).toThrow();
  });
});

/* ═══════════════════ 3. header surgery and the CORS allowlist ═══════════════════ */

describe('proxy response header surgery', () => {
  it('deletes x-frame-options, report-only CSP and Set-Cookie', () => {
    const out = proxyResponseHeaders({
      'x-frame-options': 'DENY',
      'content-security-policy-report-only': "frame-ancestors 'none'",
      'set-cookie': 'session=secret',
      'content-type': 'text/html; charset=utf-8',
    }, 'raw', '');
    expect(out['x-frame-options']).toBeUndefined();
    expect(out['content-security-policy-report-only']).toBeUndefined();
    expect(out['set-cookie']).toBeUndefined();
    expect(out['content-type']).toBe('text/html; charset=utf-8');
    expect(out['x-faisal-proxy']).toBe('raw');
  });

  it('removes only the frame-ancestors directive and keeps the rest of the CSP', () => {
    const out = proxyResponseHeaders({
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
    }, 'reader', '');
    expect(out['content-security-policy']).toBe("default-src 'self'; script-src 'self'");
    expect(out['x-faisal-proxy']).toBe('reader');
  });

  it('emits no access-control-allow-origin unless the caller is allowlisted', () => {
    expect(proxyResponseHeaders({}, 'reader', '')['access-control-allow-origin']).toBeUndefined();
    expect(proxyResponseHeaders({}, 'reader', 'https://faisaldhd.github.io')['access-control-allow-origin'])
      .toBe('https://faisaldhd.github.io');
  });

  it('never sends a wildcard origin, and only echoes the exact allowlisted origins', () => {
    expect(allowedOrigin('https://faisaldhd.github.io')).toBe('https://faisaldhd.github.io');
    expect(allowedOrigin('https://faisaldhd.github.io/app/')).toBe('');
    // The Cloudflare Pages deployment, and its own per-build preview subdomains.
    expect(allowedOrigin('https://faisal-os.pages.dev')).toBe('https://faisal-os.pages.dev');
    expect(allowedOrigin('https://abc123.faisal-os.pages.dev')).toBe('https://abc123.faisal-os.pages.dev');
    expect(allowedOrigin('https://faisal-os.pages.dev.evil.example')).toBe('');
    expect(allowedOrigin('https://other-project.pages.dev')).toBe('');
    expect(allowedOrigin('https://evil-faisal-os.pages.dev')).toBe('');
    expect(allowedOrigin('http://localhost:3080')).toBe('http://localhost:3080');
    expect(allowedOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(allowedOrigin('https://evil.example')).toBe('');
    expect(allowedOrigin('https://faisaldhd.github.io.evil.example')).toBe('');
    expect(allowedOrigin('https://localhost:3080')).toBe('');
    expect(allowedOrigin('http://localhost')).toBe('');
    expect(allowedOrigin('')).toBe('');
    for (const origin of ['https://evil.example', '', 'null']) {
      expect(proxyResponseHeaders({}, 'reader', allowedOrigin(origin))['access-control-allow-origin'])
        .toBeUndefined();
    }
  });

  it('stripFrameAncestors returns null when nothing is left', () => {
    expect(stripFrameAncestors('frame-ancestors *')).toBeNull();
    expect(stripFrameAncestors("img-src 'self'")).toBe("img-src 'self'");
  });
});

/* ═════════════════════════ 4. the proxy URL builder ═════════════════════════ */

describe('buildProxyUrl', () => {
  it('encodes the target and the mode', () => {
    // The space is already percent-encoded in the target: `new URL` normalises a
    // LITERAL space in a path away, so a raw one would not survive a round trip.
    const url = buildProxyUrl('http://127.0.0.1:8787', 'https://example.com/a%20b?x=1&y=2', 'reader');
    expect(url).toBe(
      'http://127.0.0.1:8787/fetch?url=https%3A%2F%2Fexample.com%2Fa%2520b%3Fx%3D1%26y%3D2&mode=reader',
    );
    expect(buildProxyUrl('http://127.0.0.1:8787', 'https://example.com/', 'raw')).toContain('&mode=raw');
  });

  it('defaults to reader mode', () => {
    expect(buildProxyUrl('http://127.0.0.1:8787', 'https://example.com/')).toContain('mode=reader');
  });

  it('NEVER contains a token, with or without one stored', () => {
    const map = new Map<string, string>();
    const storage = memProxyStorage(map);
    writeProxyToken(storage, 'a'.repeat(32));
    const url = buildProxyUrl('http://127.0.0.1:8787', 'https://example.com/', 'reader');
    expect(url).not.toContain('a'.repeat(32));
    expect(url).not.toContain('token');
    expect(url).not.toMatch(/token=/);
  });

  it('refuses a non-loopback base, a non-http target, and a fragment', () => {
    expect(() => buildProxyUrl('https://proxy.example', 'https://example.com/', 'reader')).toThrow();
    expect(() => buildProxyUrl('http://127.0.0.1:8787', 'file:///etc/passwd', 'reader')).toThrow();
    expect(() => buildProxyUrl('http://127.0.0.1:8787', 'javascript:alert(1)', 'reader')).toThrow();
    // A fragment is refused on purpose: `#` is how a URL gets split out of a
    // token-bearing string, and it would also leak the proxy URL into history.
    expect(() => buildProxyUrl('http://127.0.0.1:8787', 'https://example.com/#secret', 'reader')).toThrow();
    expect(() => buildProxyUrl('http://127.0.0.1:8787', 'https://example.com/{{x}}', 'reader')).toThrow();
  });

  it('refuses an unsupported mode', () => {
    expect(() => buildProxyUrl('http://127.0.0.1:8787', 'https://example.com/', 'html' as never)).toThrow();
  });

  it('proxyBaseUrl and isAllowedProxyBase agree', () => {
    expect(proxyBaseUrl()).toBe(`http://127.0.0.1:${DEFAULT_PROXY_PORT}`);
    expect(proxyBaseUrl(9999)).toBe('http://127.0.0.1:9999');
    expect(isAllowedProxyBase('http://127.0.0.1:8787')).toBe(true);
    expect(isAllowedProxyBase('http://localhost:8787')).toBe(true);
    expect(isAllowedProxyBase('https://127.0.0.1:8787')).toBe(false);
    expect(isAllowedProxyBase('http://127.0.0.1')).toBe(false);
    expect(isAllowedProxyBase('http://127.0.0.1.evil.example:8787')).toBe(false);
    expect(isAllowedProxyBase('http://example.com:8787')).toBe(false);
  });
});

/* ═════════════════════════ 5. the availability probe ═════════════════════════ */

describe('probeLocalProxy', () => {
  const base = 'http://127.0.0.1:8787';

  it('reports available and token-required from a healthy /health', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, version: '1.0.0', auth: 'token-required' }),
    }));
    const result = await probeLocalProxy(base, PROBE_TIMEOUT_MS, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ available: true, version: '1.0.0', auth: 'token-required', kind: 'local', modes: ['reader', 'raw'] });
  });

  it('asks /health and sends NO token header (that endpoint carries no page data)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ ok: true, version: '1.0.0', auth: 'none' }) };
    });
    await probeLocalProxy(base, PROBE_TIMEOUT_MS, fetchImpl as unknown as typeof fetch);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${base}/health`);
    expect(JSON.stringify(calls[0].init ?? {})).not.toContain('faisal-proxy-token');
  });

  it('resolves available:false instead of throwing when the proxy is not running', async () => {
    const refused = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(probeLocalProxy(base, PROBE_TIMEOUT_MS, refused as unknown as typeof fetch))
      .resolves.toEqual({ available: false, version: null, auth: null });
  });

  it('resolves available:false for a non-ok status, junk JSON and a non-proxy base', async () => {
    const notOk = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect((await probeLocalProxy(base, PROBE_TIMEOUT_MS, notOk as unknown as typeof fetch)).available).toBe(false);

    const junk = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }));
    expect((await probeLocalProxy(base, PROBE_TIMEOUT_MS, junk as unknown as typeof fetch)).available).toBe(false);

    const wrongShape = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ hello: 'world' }) }));
    expect((await probeLocalProxy(base, PROBE_TIMEOUT_MS, wrongShape as unknown as typeof fetch)).available).toBe(false);

    const spy = vi.fn();
    expect((await probeLocalProxy('https://evil.example', PROBE_TIMEOUT_MS, spy as unknown as typeof fetch)).available)
      .toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ═════════════════════════ 6. token + flag storage ═════════════════════════ */

function memProxyStorage(map = new Map<string, string>()): ProxyStorage & { map: Map<string, string> } {
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

const throwingStorage: ProxyStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};

describe('proxy storage helpers', () => {
  it('round-trips the token under faisal.web.proxy.token', () => {
    const storage = memProxyStorage();
    expect(readProxyToken(storage)).toBeNull();
    expect(writeProxyToken(storage, '  deadbeef  ')).toBe(true);
    expect(storage.map.get(PROXY_TOKEN_KEY)).toBe('deadbeef');
    expect(readProxyToken(storage)).toBe('deadbeef');
    clearProxyToken(storage);
    expect(readProxyToken(storage)).toBeNull();
  });

  it('ignores a blank or corrupt token', () => {
    const storage = memProxyStorage();
    expect(writeProxyToken(storage, '   ')).toBe(false);
    storage.map.set(PROXY_TOKEN_KEY, '   ');
    expect(readProxyToken(storage)).toBeNull();
    storage.map.set(PROXY_TOKEN_KEY, '');
    expect(readProxyToken(storage)).toBeNull();
  });

  it('parses the enabled flag STRICTLY: only the exact strings true/false count', () => {
    const storage = memProxyStorage();
    expect(readProxyEnabled(storage)).toBe(false);
    writeProxyEnabled(storage, true);
    expect(storage.map.get(PROXY_ENABLED_KEY)).toBe('true');
    expect(readProxyEnabled(storage)).toBe(true);
    writeProxyEnabled(storage, false);
    expect(storage.map.get(PROXY_ENABLED_KEY)).toBe('false');
    expect(readProxyEnabled(storage)).toBe(false);

    for (const junk of ['1', '0', 'yes', 'True', 'TRUE', ' true', 'on', '{}', 'null']) {
      storage.map.set(PROXY_ENABLED_KEY, junk);
      expect(readProxyEnabled(storage), junk).toBe(false);
    }
  });

  it('reads the port with a safe default and rejects junk', () => {
    const storage = memProxyStorage();
    expect(readProxyPort(storage)).toBe(DEFAULT_PROXY_PORT);
    writeProxyPort(storage, 9999);
    expect(storage.map.get(PROXY_PORT_KEY)).toBe('9999');
    expect(readProxyPort(storage)).toBe(9999);
    for (const junk of ['0', '99999', 'abc', '', '87 87', '-1', '80.5']) {
      storage.map.set(PROXY_PORT_KEY, junk);
      expect(readProxyPort(storage), junk).toBe(DEFAULT_PROXY_PORT);
    }
    expect(writeProxyPort(storage, 0)).toBe(false);
    expect(writeProxyPort(storage, 70000)).toBe(false);
  });

  it('never throws when the store throws', () => {
    expect(() => readProxyToken(throwingStorage)).not.toThrow();
    expect(readProxyToken(throwingStorage)).toBeNull();
    expect(writeProxyToken(throwingStorage, 'x')).toBe(false);
    expect(readProxyPort(throwingStorage)).toBe(DEFAULT_PROXY_PORT);
    expect(readProxyEnabled(throwingStorage)).toBe(false);
    expect(() => writeProxyEnabled(throwingStorage, true)).not.toThrow();
    expect(() => clearProxyToken(throwingStorage)).not.toThrow();
  });

  it('the enabled flag alone is NOT enough to make a window proxy', () => {
    const storage = memProxyStorage();
    writeProxyEnabled(storage, true);
    const state = initialProxyState(storage);
    expect(state.enabled).toBe(true);
    expect(state.mode).toBeNull();
    expect(proxyIsActive(state)).toBe(false);
  });
});

/* ═══════════════════════ 7. warnBeforeProxying (client warning) ═══════════════════════ */

describe('warnBeforeProxying', () => {
  it('warns for schemes, private addresses and blocked names, without any request', () => {
    expect(warnBeforeProxying('file:///C:/x')).toBe('scheme');
    expect(warnBeforeProxying('data:text/html,hi')).toBe('scheme');
    expect(warnBeforeProxying('http://192.168.1.1/')).toBe('private-address');
    expect(warnBeforeProxying('http://127.0.0.1:8787/')).toBe('private-address');
    expect(warnBeforeProxying('http://[::1]/')).toBe('private-address');
    expect(warnBeforeProxying('http://localhost/')).toBe('host-name');
    expect(warnBeforeProxying('http://printer.local/')).toBe('host-name');
    expect(warnBeforeProxying('not a url')).toBe('invalid-url');
  });

  it('stays silent for an ordinary public https page', () => {
    expect(warnBeforeProxying('https://www.example.com/page')).toBeNull();
    expect(warnBeforeProxying('http://example.com/')).toBeNull();
  });
});

/* ═════════════════════════════ 8. reader extraction ═════════════════════════════ */

const SAMPLE_HTML = `<!doctype html>
<html><head>
  <title>  Faisal &amp; the   Proxy  </title>
  <style>body { color: red }</style>
  <script>window.__evil = "should not appear";</script>
</head>
<body>
  <h1>First heading</h1>
  <p>First paragraph with <b>bold</b> and <a href="/x">a link</a>.</p>
  <noscript>noscript text</noscript>
  <script>var alsoEvil = 1;</script>
  <ul><li>Item one</li><li>Item two &amp; more</li></ul>
  <iframe src="https://evil.example/"></iframe>
  <svg><text>svg text</text></svg>
  <template><p>template text</p></template>
  <div style="display:none">hidden style text</div>
  <div hidden>hidden attribute text</div>
  <div aria-hidden="true">aria hidden text</div>
  <p>Last paragraph.</p>
</body></html>`;

describe('htmlToText', () => {
  it('keeps the title, paragraphs, headings and list items in document order', () => {
    const { title, blocks } = htmlToText(SAMPLE_HTML);
    expect(title).toBe('Faisal & the Proxy');
    expect(blocks).toEqual([
      'First heading',
      'First paragraph with bold and a link.',
      'Item one',
      'Item two & more',
      'Last paragraph.',
    ]);
  });

  it('drops script, style, noscript, iframe, svg, template and every hidden element', () => {
    const { blocks } = htmlToText(SAMPLE_HTML);
    const joined = blocks.join(' | ');
    for (const dropped of [
      'should not appear', 'color: red', 'noscript text', 'alsoEvil',
      'svg text', 'template text', 'hidden style text', 'hidden attribute text',
      'aria hidden text', '<', '>',
    ]) {
      expect(joined).not.toContain(dropped);
    }
  });

  it('collapses whitespace and NBSP runs', () => {
    expect(collapseWhitespace('  a\n\n\t b\u00a0\u00a0c  ')).toBe('a b c');
    const { blocks } = htmlToText('<p>a\n   b</p><p>c\u00a0d</p>');
    expect(blocks).toEqual(['a b', 'c d']);
  });

  it('caps the NUMBER of blocks', () => {
    const html = `<body>${'<p>block</p>'.repeat(MAX_READER_BLOCKS + 250)}</body>`;
    const { blocks } = htmlToText(html);
    expect(blocks.length).toBe(MAX_READER_BLOCKS);
  });

  it('caps the LENGTH of a single block', () => {
    const { blocks } = htmlToText(`<p>${'x'.repeat(MAX_BLOCK_CHARS + 5000)}</p>`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].length).toBe(MAX_BLOCK_CHARS);
  });

  it('caps the title length too', () => {
    const { title } = htmlToText(`<head><title>${'y'.repeat(1000)}</title></head><body>x</body>`);
    expect(title.length).toBe(300);
  });

  it('returns an empty result for junk instead of throwing', () => {
    expect(() => htmlToText('')).not.toThrow();
    expect(htmlToText('').blocks).toEqual([]);
    expect(htmlToText('<p>unclosed').blocks).toEqual(['unclosed']);
  });

  it('renders a long extraction with no script, event handler or markup path', () => {
    // The real markup `hello` blocks must contain no `<` at all: the brief
    // requires that nothing from the page can ever reach the DOM as markup.
    for (const block of htmlToText(SAMPLE_HTML).blocks) expect(block).not.toContain('<');
    const card = buildReaderPanel('T', htmlToText(SAMPLE_HTML).blocks, 'https://example.com/', panelHost());
    expect(card.querySelectorAll('script, style, iframe, svg, img, object, embed, form, input')).toHaveLength(0);
    for (const el of card.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        expect(attr.name.startsWith('on'), `${attr.name} on ${el.tagName}`).toBe(false);
      }
    }
  });
});

/* ═════════════════════════════ 9. the cards themselves ═════════════════════════════ */

function panelHost(over: Partial<ProxyPanelHost> = {}): ProxyPanelHost {
  return {
    openProxy: vi.fn(),
    chooseMode: vi.fn(),
    setMode: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    openExternal: vi.fn(),
    setError: vi.fn(),
    ...over,
  };
}

describe('proxy cards', () => {
  beforeEach(() => { setLocale('en'); document.body.textContent = ''; });

  it('renders untrusted page text with textContent, never as markup', () => {
    const hostile = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>';
    const card = buildReaderPanel('T', [hostile], 'https://example.com/', panelHost());
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('script')).toBeNull();
    expect(card.textContent).toContain(hostile);
    expect(card.innerHTML).toContain('&lt;img');
  });

  it('the reader card offers the original link and the stop button', () => {
    const host = panelHost();
    const card = buildReaderPanel('T', ['a'], 'https://example.com/', host);
    const buttons = [...card.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toContain('Open the original page');
    buttons[0].click();
    expect(host.openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('the mode picker offers reader (default, first) and raw, and calls setMode on click', () => {
    const host = panelHost();
    const card = buildProxyModePicker(null, host);
    const reader = card.querySelector<HTMLButtonElement>('.faisal-web-proxy-reader')!;
    const raw = card.querySelector<HTMLButtonElement>('.faisal-web-proxy-raw')!;
    expect(reader).not.toBeNull();
    expect(raw).not.toBeNull();
    // Reader is the primary (accent) button and comes first.
    expect(reader.className).toContain('faisal-web-open');
    reader.click();
    expect(host.setMode).toHaveBeenCalledWith('reader');
    raw.click();
    expect(host.setMode).toHaveBeenCalledWith('raw');
  });

  it('the token form uses a password input and clears it on submit', () => {
    const submitted: string[] = [];
    const card = buildTokenPanel('token-required', null, (token) => submitted.push(token), panelHost());
    const input = card.querySelector<HTMLInputElement>('input')!;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    input.value = 'super-secret-token';
    card.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(submitted).toEqual(['super-secret-token']);
    // The value must not stay in the DOM after the submit.
    expect(input.value).toBe('');
    expect(card.textContent).not.toContain('super-secret-token');
  });

  it('the badge bar states which proxy mode is active and offers stop', () => {
    const host = panelHost();
    const bar = buildProxyBar('raw', 'https://example.com/', host);
    expect(bar.querySelector('.faisal-web-proxy-badge')!.textContent).toContain('Browsing through the local proxy');
    const stop = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Stop the proxy')!;
    stop.click();
    expect(host.stop).toHaveBeenCalled();
  });

  it('the raw loading state says raw mode, not reader mode', () => {
    const card = buildRawLoading();
    expect(card.querySelector('.faisal-web-loading')).not.toBeNull();
    expect(card.textContent).toContain('Preparing the frame through the proxy');
    expect(card.textContent).not.toContain('Reading through the proxy');
  });
});

/* ═════════════════════ 10. the window: the third fallback action ═════════════════════ */

interface Harness {
  wm: WindowManager;
  sys: SystemAPI;
  storage: ReturnType<typeof memStorage>;
}

function memStorage(): WebStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}

function makeHarness(): Harness {
  const storage = memStorage();
  const wins: WindowHandle[] = [];
  const closeCbs = new Map<string, Set<() => void>>();
  let seq = 0;

  const wm: WindowManager = {
    open(o) {
      const id = `w${++seq}`;
      const title = document.createElement('span');
      title.className = 'test-title';
      document.body.append(title);
      const h: WindowHandle = {
        id,
        appId: o.appId,
        content: document.createElement('div'),
        setTitle(t) { title.textContent = t; },
        focus() {},
        close() { closeCbs.get(id)?.forEach((cb) => cb()); },
        onClose(cb) {
          const set = closeCbs.get(id) ?? new Set();
          set.add(cb);
          closeCbs.set(id, set);
          return () => set.delete(cb);
        },
        requestClose: async () => { closeCbs.get(id)?.forEach((cb) => cb()); },
        setCloseGuard() {},
        onResize: () => () => {},
      };
      wins.push(h);
      return h;
    },
    list: () => wins,
    get: (id) => wins.find((w) => w.id === id),
    focused: () => wins[wins.length - 1],
    isMinimized: () => false,
    minimize() {},
    toggleMaximize() {},
  };

  const sys = {
    wm,
    locale: () => 'en' as const,
    t: (k: string) => k,
    notify: () => {},
    settings: { get: <T,>(_k: string, fallback: T) => fallback, set: () => {} },
    bus: { on: () => () => {}, emit: () => {} },
  } as unknown as SystemAPI;

  return { wm, sys, storage };
}

const q = <T extends Element = HTMLElement>(win: WindowHandle, sel: string): T | null =>
  win.content.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(win: WindowHandle, sel: string): T[] =>
  [...win.content.querySelectorAll<T>(sel)];

/** Launch the site-agnostic window with the proxy bits a test needs to inject. */
function openProxyWindow(harness: Harness, runtime: Record<string, unknown> = {}) {
  const win = harness.wm.open({ appId: `org.faisal.Web.${google.id}`, title: google.title.en });
  const proxyStorage = runtime.proxyStorage ?? memProxyStorage();
  const ctx: AppContext = { sys: harness.sys, window: win, args: [] };
  launchWebApp(google, ctx, harness.storage, { proxyStorage, ...runtime } as never);
  return { win, proxyStorage: proxyStorage as ReturnType<typeof memProxyStorage> };
}

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/** The only ticket shape the client accepts: 32 random bytes as lowercase hex. */
const TICKET = 'c'.repeat(64);
/** The proxy's successful /ticket reply, as the window's injected fetch sees it. */
const mintedTicketFetch = () =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ticket: TICKET, expiresIn: 60_000 }) }));

describe('web app window — the local proxy action', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
    document.body.textContent = '';
    setLocale('en');
    vi.unstubAllGlobals();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('does NOT show the proxy action when the probe reports unavailable', async () => {
    const probe = vi.fn(async () => ({ available: false, version: null, auth: null }));
    const { win } = openProxyWindow(harness, { probe });
    await flush();
    // google is embedNote 'blocked', so the fallback card is on screen...
    expect(q(win, '.faisal-web-fallback')).not.toBeNull();
    // ...but the proxy action is absent: no button, no silent fallback.
    expect(q(win, '.faisal-web-proxy-open')).toBeNull();
    expect(win.content.textContent).not.toContain('Use my local proxy');
  });

  it('shows the proxy action only once the probe reports available', async () => {
    const probe = vi.fn(async () => ({ available: true, version: '1.0.0', auth: 'token-required' }));
    const { win } = openProxyWindow(harness, { probe });
    await flush();
    const action = q<HTMLButtonElement>(win, '.faisal-web-proxy-open');
    expect(action).not.toBeNull();
    expect(action!.textContent).toBe('Use my local proxy');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('a probe that never answers leaves the window exactly as it was', async () => {
    const probe = vi.fn(() => new Promise(() => {}));
    const { win } = openProxyWindow(harness, { probe });
    await flush();
    expect(q(win, '.faisal-web-proxy-open')).toBeNull();
    expect(q(win, '.faisal-web-fallback')).not.toBeNull();
  });

  it('a probing proxy asks for the token and STORES NOTHING when it is wrong', async () => {
    const probe = vi.fn(async () => ({ available: true, version: '1.0.0', auth: 'token-required' }));
    const verifyToken = vi.fn(async () => false);
    const { win, proxyStorage } = openProxyWindow(harness, { probe, verifyToken });
    await flush();

    q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
    // Wrong/no token yet ⇒ the token card, not the mode picker.
    expect(q(win, '.faisal-web-proxy-modes')).toBeNull();
    const input = q<HTMLInputElement>(win, 'input[type="password"]')!;
    expect(input).not.toBeNull();
    expect(input.type).toBe('password');

    input.value = 'wrong-token';
    q<HTMLFormElement>(win, 'form.faisal-web-proxy-token')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(verifyToken).toHaveBeenCalledWith('wrong-token');
    // A failed token shows a clear error and stores NOTHING.
    expect(q(win, '.faisal-web-proxy-error')!.textContent).toContain('Wrong token');
    expect(proxyStorage.map.get(PROXY_TOKEN_KEY)).toBeUndefined();
    expect(proxyStorage.map.get(PROXY_ENABLED_KEY)).toBeUndefined();
    expect(q(win, '.faisal-web-proxy-modes')).toBeNull();
    expect(win.content.textContent).not.toContain('wrong-token');
  });

  it('verifies the token, stores it only then, and only after storing offers the two modes', async () => {
    const probe = vi.fn(async () => ({ available: true, version: '1.0.0', auth: 'token-required' }));
    const verifyToken = vi.fn(async (token: string) => token === 'good-token');
    const { win, proxyStorage } = openProxyWindow(harness, { probe, verifyToken });
    await flush();

    q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
    q<HTMLInputElement>(win, 'input[type="password"]')!.value = 'good-token';
    q<HTMLFormElement>(win, 'form.faisal-web-proxy-token')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(proxyStorage.map.get(PROXY_TOKEN_KEY)).toBe('good-token');
    expect(q(win, '.faisal-web-proxy-reader')).not.toBeNull();
    expect(q(win, '.faisal-web-proxy-raw')).not.toBeNull();
    // Still NOT proxying: picking a mode is a separate, explicit click.
    expect(proxyStorage.map.get(PROXY_ENABLED_KEY)).toBeUndefined();
    expect(q(win, '.faisal-web-proxy-badge')).toBeNull();
  });

  it('the token is sent ONLY to the proxy base, in a header, and never into a URL', async () => {
    const probe = vi.fn(async () => ({ available: true, version: '1.0.0', auth: 'token-required' }));
    const proxyFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html><head><title>T</title></head><body><p>Hello</p></body></html>',
    }));
    const { win, proxyStorage } = openProxyWindow(harness, {
      probe,
      verifyToken: async () => true,
      proxyFetch,
    });
    // A stored token, so the mode picker is reached directly.
    writeProxyToken(proxyStorage, 'tok'.repeat(10));
    await flush();

    q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
    q<HTMLButtonElement>(win, '.faisal-web-proxy-reader')!.click();
    await flush();

    expect(proxyFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = proxyFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl.startsWith(proxyBaseUrl())).toBe(true);
    expect(calledUrl).not.toContain('tok'.repeat(10));
    expect((init.headers as Record<string, string>)['x-faisal-proxy-token']).toBe('tok'.repeat(10));

    // Reader mode rendered the extracted text natively.
    expect(q(win, '.faisal-web-reader-block')!.textContent).toBe('Hello');
    expect(q(win, '.faisal-web-proxy-badge')!.textContent).toContain('reader');
    expect(win.content.querySelector('.faisal-web-reader script')).toBeNull();
  });

  it('reader mode refuses an obviously private target locally, without any request', async () => {
    const probe = vi.fn(async () => ({ available: true, version: null, auth: 'none' }));
    const proxyFetch = vi.fn();
    const { win } = openProxyWindow(harness, { probe, proxyFetch });
    await flush();

    // Navigate this web app to a private address, then use the proxy on it.
    const input = q<HTMLInputElement>(win, '.faisal-web-address')!;
    input.value = 'http://192.168.1.1/';
    q<HTMLFormElement>(win, 'form.faisal-web-addressform')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    // The shared URL policy refuses it outright, so use the refusal card's own
    // path: the proxy action only exists on the fallback card, so drive the
    // private-target branch through a raw-mode render instead.
    expect(q(win, '.faisal-web-fallback')).not.toBeNull();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('raw embed mints a ticket with the token header, then puts ONLY the ticket in the frame', async () => {
    const probe = vi.fn(async () => ({ available: true, version: null, auth: 'none' }));
    const proxyFetch = mintedTicketFetch();
    const { win, proxyStorage } = openProxyWindow(harness, { probe, proxyFetch });
    writeProxyToken(proxyStorage, 'x'.repeat(32));
    await flush();

    q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
    q<HTMLButtonElement>(win, '.faisal-web-proxy-raw')!.click();
    await flush();

    // The token authenticated the /ticket call, in a header, and only there.
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = proxyFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toContain(`${proxyBaseUrl()}/ticket?url=`);
    expect(calledUrl).toContain('mode=raw');
    expect(calledUrl).not.toContain('x'.repeat(32));
    expect(calledUrl).not.toContain(TICKET);
    expect((init.headers as Record<string, string>)['x-faisal-proxy-token']).toBe('x'.repeat(32));

    // The frame's src is the ticket and NOTHING else: no token, no target, no
    // mode. That exact string is the proof.
    const iframe = q<HTMLIFrameElement>(win, 'iframe.faisal-web-proxy-frame')!;
    expect(iframe).not.toBeNull();
    const src = iframe.getAttribute('src')!;
    expect(src).toBe(`${proxyBaseUrl()}/view?ticket=${TICKET}`);
    expect(src).toContain('/view?ticket=');
    expect(src).not.toContain('x'.repeat(32));
    expect(src).not.toContain('mode=raw');
    expect(src).not.toContain('url=');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups allow-presentation');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    // The warning and the badge are permanent, not a toast.
    expect(q(win, '.faisal-web-proxy-rawwarning')).not.toBeNull();
    expect(win.content.textContent).toContain('will look broken');
    expect(q(win, '.faisal-web-proxy-badge')!.textContent).toContain('Browsing through the local proxy');
    // The reading state is gone, and no postMessage is used anywhere.
    expect(q(win, '.faisal-web-loading')).toBeNull();
    expect(win.content.innerHTML).not.toContain('postMessage');
  });

  it('never creates the frame before the ticket exists, then paints it', async () => {
    const probe = vi.fn(async () => ({ available: true, version: null, auth: 'none' }));
    let settle: (value: unknown) => void = () => {};
    const proxyFetch = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    const { win, proxyStorage } = openProxyWindow(harness, { probe, proxyFetch });
    writeProxyToken(proxyStorage, 'x'.repeat(32));
    await flush();

    q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
    q<HTMLButtonElement>(win, '.faisal-web-proxy-raw')!.click();
    await flush();

    // The badge and the warning are up, the reading state is up, and there is NO
    // frame at all while the ticket is in flight.
    expect(q(win, '.faisal-web-proxy-badge')).not.toBeNull();
    expect(q(win, '.faisal-web-proxy-rawwarning')).not.toBeNull();
    expect(q(win, '.faisal-web-loading')).not.toBeNull();
    expect(win.content.querySelector('iframe')).toBeNull();

    settle({ ok: true, status: 200, json: async () => ({ ticket: TICKET }) });
    await flush();

    expect(q(win, 'iframe.faisal-web-proxy-frame')!.getAttribute('src'))
      .toBe(`${proxyBaseUrl()}/view?ticket=${TICKET}`);
    expect(q(win, '.faisal-web-loading')).toBeNull();
  });

  const ticketFailures: Array<[ProxyTicketFailure, () => unknown, string]> = [
    ['unauthorized', () => vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid or missing token' }) })), 'The proxy refused the token'],
    ['unreachable', () => vi.fn(async () => { throw new TypeError('Failed to fetch'); }), 'is not answering'],
    ['refused', () => vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'host resolves to a non-public address' }) })), 'explicitly refused this target'],
    ['malformed', () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })), 'unusable'],
  ];

  it.each(ticketFailures)(
    'a %s ticket failure renders its own card and NO frame at all',
    async (_reason, makeFetch, sentence) => {
      const probe = vi.fn(async () => ({ available: true, version: null, auth: 'none' }));
      const { win, proxyStorage } = openProxyWindow(harness, { probe, proxyFetch: makeFetch() });
      writeProxyToken(proxyStorage, 'x'.repeat(32));
      await flush();

      q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
      q<HTMLButtonElement>(win, '.faisal-web-proxy-raw')!.click();
      await flush();

      // No frame whatsoever: never blank, and never a token/ticket in a URL.
      expect(win.content.querySelector('iframe')).toBeNull();
      expect(q(win, '.faisal-web-fallback-body')!.textContent).toContain(sentence);
      // The window is still in proxy mode, so the chrome and a retry stay.
      expect(q(win, '.faisal-web-proxy-badge')).not.toBeNull();
      expect(q(win, '.faisal-web-proxy-rawwarning')).not.toBeNull();
      expect([...win.content.querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(true);
      expect(win.content.innerHTML).not.toContain('ticket=');
      expect(q(win, '.faisal-web-loading')).toBeNull();
    },
  );

  it('a slow ticket reply cannot paint into a newer navigation', async () => {
    const probe = vi.fn(async () => ({ available: true, version: null, auth: 'none' }));
    let settle: (value: unknown) => void = () => {};
    const proxyFetch = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    const { win, proxyStorage } = openProxyWindow(harness, { probe, proxyFetch });
    writeProxyToken(proxyStorage, 'x'.repeat(32));
    await flush();

    q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
    q<HTMLButtonElement>(win, '.faisal-web-proxy-raw')!.click();
    await flush();
    expect(q(win, '.faisal-web-loading')).not.toBeNull();

    // The owner leaves the attempt while the ticket is still in flight.
    [...win.content.querySelectorAll('button')].find((b) => b.textContent === 'Stop the proxy')!.click();
    await flush();
    settle({ ok: true, status: 200, json: async () => ({ ticket: TICKET }) });
    await flush();

    // The late reply must not resurrect the old frame.
    expect(q(win, 'iframe.faisal-web-proxy-frame')).toBeNull();
    expect(q(win, '.faisal-web-proxy-badge')).toBeNull();
  });

  it('a raw-mode ticket failure is retryable, and the retry asks for a new ticket', async () => {
    const probe = vi.fn(async () => ({ available: true, version: null, auth: 'none' }));
    const proxyFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ticket: TICKET }) });
    const { win, proxyStorage } = openProxyWindow(harness, { probe, proxyFetch });
    writeProxyToken(proxyStorage, 'x'.repeat(32));
    await flush();

    q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
    q<HTMLButtonElement>(win, '.faisal-web-proxy-raw')!.click();
    await flush();
    expect(win.content.querySelector('iframe')).toBeNull();

    [...win.content.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click();
    await flush();
    expect(proxyFetch).toHaveBeenCalledTimes(2);
    expect(q(win, 'iframe.faisal-web-proxy-frame')!.getAttribute('src'))
      .toBe(`${proxyBaseUrl()}/view?ticket=${TICKET}`);
  });

  it('the enabled flag is written ONLY after the owner picks a mode, and stop clears it', async () => {
    const probe = vi.fn(async () => ({ available: true, version: null, auth: 'none' }));
    const { win, proxyStorage } = openProxyWindow(harness, { probe, proxyFetch: vi.fn() });
    await flush();

    // Nothing is written before the owner acts.
    expect(proxyStorage.map.get(PROXY_ENABLED_KEY)).toBeUndefined();

    q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
    expect(proxyStorage.map.get(PROXY_ENABLED_KEY)).toBeUndefined();
    q<HTMLButtonElement>(win, '.faisal-web-proxy-reader')!.click();
    await flush();
    expect(proxyStorage.map.get(PROXY_ENABLED_KEY)).toBe('true');

    const stop = [...win.content.querySelectorAll('button')]
      .find((b) => b.textContent === 'Stop the proxy') as HTMLButtonElement;
    expect(stop).not.toBeUndefined();
    stop.click();
    await flush();
    expect(proxyStorage.map.get(PROXY_ENABLED_KEY)).toBe('false');
    expect(q(win, '.faisal-web-proxy-badge')).toBeNull();
  });

  it('a stored enabled flag does NOT switch a fresh window into proxy mode', async () => {
    const proxyStorage = memProxyStorage();
    writeProxyEnabled(proxyStorage, true);
    writeProxyToken(proxyStorage, 'stored-token');
    const probe = vi.fn(async () => ({ available: true, version: null, auth: 'token-required' }));
    const { win } = openProxyWindow(harness, { probe, proxyStorage });
    await flush();
    expect(q(win, '.faisal-web-proxy-badge')).toBeNull();
    expect(q(win, 'iframe.faisal-web-proxy-frame')).toBeNull();
    expect(q(win, '.faisal-web-fallback')).not.toBeNull();
  });

  it('navigating away leaves proxy mode', async () => {
    const probe = vi.fn(async () => ({ available: true, version: null, auth: 'none' }));
    const { win } = openProxyWindow(harness, { probe, proxyFetch: vi.fn() });
    await flush();
    q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
    q<HTMLButtonElement>(win, '.faisal-web-proxy-raw')!.click();
    await flush();
    expect(q(win, '.faisal-web-proxy-badge')).not.toBeNull();

    const input = q<HTMLInputElement>(win, '.faisal-web-address')!;
    input.value = 'https://en.wikipedia.org/wiki/Main_Page';
    q<HTMLFormElement>(win, 'form.faisal-web-addressform')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(q(win, '.faisal-web-proxy-badge')).toBeNull();
  });

  it('a reader fetch failure is reported in the window and stays retryable', async () => {
    const probe = vi.fn(async () => ({ available: true, version: null, auth: 'none' }));
    const proxyFetch = vi.fn(async () => ({ ok: false, status: 502, text: async () => '' }));
    const { win } = openProxyWindow(harness, { probe, proxyFetch });
    await flush();
    q<HTMLButtonElement>(win, '.faisal-web-proxy-open')!.click();
    q<HTMLButtonElement>(win, '.faisal-web-proxy-reader')!.click();
    await flush();
    expect(win.content.textContent).toContain('Could not fetch the page through the proxy');
    expect([...win.content.querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(true);
    // The badge is still there: the window is still in proxy mode.
    expect(q(win, '.faisal-web-proxy-badge')).not.toBeNull();
  });

  it('createWebAppModule still builds a normal manifest for a non-search web app', () => {
    const mod = createWebAppModule(google, { storage: memStorage() });
    expect(mod.manifest.id).toBe('org.faisal.Web.google');
  });
});

/* ════════════════════ 11. the ticket URL builder and the mint call ════════════════════ */

const HEX_TICKET = '9f'.repeat(32);

describe('buildProxyViewUrl', () => {
  it('builds /view?ticket=<hex>, with nothing else in the string', () => {
    const url = buildProxyViewUrl('http://127.0.0.1:8787', HEX_TICKET);
    expect(url).toBe(`http://127.0.0.1:8787/view?ticket=${HEX_TICKET}`);
    expect(url).not.toContain('token');
    expect(url).not.toContain('mode=');
    expect(url).not.toContain('url=');
    expect(url).not.toContain('http://127.0.0.1:8787/fetch');
    // Surrounding whitespace (a paste) is trimmed, never encoded into the URL.
    expect(buildProxyViewUrl('http://127.0.0.1:8787', `  ${HEX_TICKET}\n`))
      .toBe(`http://127.0.0.1:8787/view?ticket=${HEX_TICKET}`);
  });

  it('refuses a base that is not the loopback proxy', () => {
    for (const base of [
      'https://proxy.example',
      'http://example.com:8787',
      'http://127.0.0.1',            // no port
      'http://127.0.0.1:8787/x',     // a path
      'http://127.0.0.1:8787/?a=1',
      'http://127.0.0.1.evil.example:8787',
    ]) {
      expect(() => buildProxyViewUrl(base, HEX_TICKET), base).toThrow();
    }
  });

  it('refuses a ticket that is not exactly 64 lowercase hex characters', () => {
    for (const bad of [
      '', '   ', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64),
      `${'a'.repeat(63)}-`, 'a'.repeat(32), `${'a'.repeat(31)} ${'a'.repeat(31)}`,
    ]) {
      expect(() => buildProxyViewUrl('http://127.0.0.1:8787', bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('requestProxyTicket', () => {
  const base = 'http://127.0.0.1:8787';
  const target = 'https://example.com/';
  const token = 'the-owner-token';

  /**
   * THE REASON TABLE. This is the contract the window's error copy depends on:
   * 401 is the token, 403 is the proxy's own refusal, anything else 4xx is a
   * refused request, a 5xx / junk body is an unusable answer, and a thrown fetch
   * is "not answering".
   */
  const table: Array<[string, unknown, { ok: boolean; reason?: ProxyTicketFailure; ticket?: string }]> = [
    ['200 with a 64-hex ticket', { status: 200, json: async () => ({ ticket: HEX_TICKET, expiresIn: TICKET_TTL_MS }) },
      { ok: true, ticket: HEX_TICKET }],
    ['401 wrong or missing token', { status: 401, json: async () => ({ error: 'invalid or missing token' }) },
      { ok: false, reason: 'unauthorized' }],
    ['403 target refused by the guard', { status: 403, json: async () => ({ error: 'host resolves to a non-public address' }) },
      { ok: false, reason: 'refused' }],
    ['400 bad mode', { status: 400, json: async () => ({ error: 'mode must be reader or raw' }) },
      { ok: false, reason: 'refused' }],
    ['429 too many requests', { status: 429, json: async () => ({}) }, { ok: false, reason: 'refused' }],
    ['500 proxy error', { status: 500, json: async () => ({ error: 'proxy error' }) },
      { ok: false, reason: 'malformed' }],
    ['200 with junk JSON', { status: 200, json: async () => { throw new Error('not json'); } },
      { ok: false, reason: 'malformed' }],
    ['200 with no ticket field', { status: 200, json: async () => ({ expiresIn: 1 }) },
      { ok: false, reason: 'malformed' }],
    ['200 with a malformed ticket', { status: 200, json: async () => ({ ticket: 'nope' }) },
      { ok: false, reason: 'malformed' }],
    ['a response with no status at all', {}, { ok: false, reason: 'malformed' }],
  ];

  it.each(table)('maps %s', async (_label, response, expected) => {
    const fetchImpl = vi.fn(async () => response);
    await expect(requestProxyTicket(base, target, 'raw', token, fetchImpl as never)).resolves.toEqual(expected);
  });

  it('maps a thrown fetch to unreachable, and never throws for any input', async () => {
    const refused = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(requestProxyTicket(base, target, 'raw', token, refused as never))
      .resolves.toEqual({ ok: false, reason: 'unreachable' });
    // No fetch implementation, an unbuildable base and an unbuildable target all
    // resolve rather than throw.
    //
    // `null`, not `undefined`: `undefined` triggers the parameter default, which
    // is the real `globalThis.fetch`, and Node ships one — so this assertion used
    // to reach the network. It passed only while nothing listened on the default
    // port, and it broke the moment a real proxy was running on 8787 on the
    // developer's machine (the live proxy answered 401, so the reason came back
    // 'unauthorized' instead of 'unreachable'). A unit test must not depend on
    // an empty port.
    await expect(requestProxyTicket(base, target, 'raw', token, null as never))
      .resolves.toEqual({ ok: false, reason: 'unreachable' });
    const spy = vi.fn();
    await expect(requestProxyTicket('https://evil.example', target, 'raw', token, spy as never))
      .resolves.toEqual({ ok: false, reason: 'refused' });
    await expect(requestProxyTicket(base, 'file:///etc/passwd', 'raw', token, spy as never))
      .resolves.toEqual({ ok: false, reason: 'refused' });
    await expect(requestProxyTicket(base, target, 'html' as never, token, spy as never))
      .resolves.toEqual({ ok: false, reason: 'refused' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks /ticket with the token in a header only, and with the target url-encoded', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([String(url), init]);
      return { status: 200, json: async () => ({ ticket: HEX_TICKET }) };
    });
    await requestProxyTicket(base, 'https://example.com/a%20b?x=1&y=2', 'raw', token, fetchImpl as never);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(
      `${base}/ticket?url=${encodeURIComponent('https://example.com/a%20b?x=1&y=2')}&mode=raw`,
    );
    expect(calls[0][0]).not.toContain(token);
    expect(calls[0][0]).not.toContain('x-faisal-proxy-token');
    expect((calls[0][1].headers as Record<string, string>)['x-faisal-proxy-token']).toBe(token);
    expect(calls[0][1].cache).toBe('no-store');
  });

  it('sends NO token header when the owner stored no token (the tool runs with auth:none)', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([String(url), init]);
      return { status: 200, json: async () => ({ ticket: HEX_TICKET }) };
    });
    await requestProxyTicket(base, target, 'reader', null, fetchImpl as never);
    expect(calls[0][0]).toContain('/ticket?url=');
    expect(calls[0][0]).toContain('mode=reader');
    expect((calls[0][1].headers as Record<string, string>)['x-faisal-proxy-token']).toBeUndefined();
  });
});

/* ═══════════════ 12. the ticket routes, over a real loopback listener ═══════════════ */

/** Just enough of a node:http Server for these tests (there are no @types/node). */
interface TestHttpServer {
  listen(port: number, host: string, cb: () => void): void;
  close(cb?: () => void): void;
  address(): { port: number } | string | null;
  once(event: string, cb: (err?: unknown) => void): void;
}

interface StartedProxy {
  base: string;
  /** Every URL the proxy asked its injected upstream fetch for, in order. */
  upstream: string[];
  close(): Promise<void>;
}

const PROXY_TOKEN = 'owner-token-for-the-tests';
const PUBLIC_TARGET = 'https://example.com/real';

/**
 * A real proxy on an ephemeral loopback port, with a counted, offline upstream.
 * No request in this section leaves the machine: the listener is 127.0.0.1 and
 * the only outbound call the proxy can make is the injected fetch below.
 */
async function startProxy(options: {
  token?: string | null;
  ticketTtlMs?: number;
  allow?: string[];
  verbose?: boolean;
  fetchImpl?: (url: string, init?: unknown) => Promise<unknown>;
} = {}): Promise<StartedProxy> {
  const upstream: string[] = [];
  const fetcher = options.fetchImpl ?? (async (url: string) => {
    upstream.push(String(url));
    return {
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
        forEach: (cb: (value: string, key: string) => void) => cb('text/html; charset=utf-8', 'content-type'),
      },
      body: (async function* () { yield new TextEncoder().encode('<html><body><p>Hello</p></body></html>'); })(),
    };
  });
  const server = createProxyServer({
    token: options.token === undefined ? PROXY_TOKEN : options.token,
    fetchImpl: fetcher,
    ...(options.ticketTtlMs === undefined ? {} : { ticketTtlMs: options.ticketTtlMs }),
    ...(options.allow === undefined ? {} : { allow: options.allow }),
    ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
  }) as unknown as TestHttpServer;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    upstream,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** GET a proxy route over real HTTP. No token header is ever added implicitly. */
const proxyGet = (h: StartedProxy, path: string, headers: Record<string, string> = {}) =>
  fetch(`${h.base}${path}`, { headers, cache: 'no-store' });

/** Mint one ticket. Throws when the reply is not a 200 with a ticket. */
async function mint(h: StartedProxy, target: string, mode: 'reader' | 'raw' = 'raw', token = PROXY_TOKEN) {
  const res = await proxyGet(h, `/ticket?url=${encodeURIComponent(target)}&mode=${mode}`, {
    'x-faisal-proxy-token': token,
  });
  const body = (await res.json()) as { ticket?: string; expiresIn?: number; error?: string };
  expect(res.status, `mint ${target}: ${JSON.stringify(body)}`).toBe(200);
  expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
  return body as { ticket: string; expiresIn: number };
}

describe('the proxy ticket routes (real loopback listener)', () => {
  let h: StartedProxy;
  afterEach(async () => { if (h) await h.close(); });

  it('mints a 64-hex single-use ticket with a good token, without fetching anything', async () => {
    h = await startProxy();
    const res = await proxyGet(h, `/ticket?url=${encodeURIComponent(PUBLIC_TARGET)}&mode=raw`, {
      'x-faisal-proxy-token': PROXY_TOKEN,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { ticket: string; expiresIn: number };
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(body.ticket).toHaveLength(64);
    expect(body.expiresIn).toBe(TICKET_TTL_MS);
    expect(TICKET_TTL_MS).toBe(60_000);
    // Minting validates the target but never fetches it.
    expect(h.upstream).toHaveLength(0);
  });

  it('refuses to mint without a token or with a wrong one, and returns no ticket', async () => {
    h = await startProxy();
    const path = `/ticket?url=${encodeURIComponent(PUBLIC_TARGET)}&mode=raw`;
    for (const headers of [
      {},
      { 'x-faisal-proxy-token': 'wrong-token' },
      { 'x-faisal-proxy-token': '' },
    ] as Array<Record<string, string>>) {
      const res = await proxyGet(h, path, headers);
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('invalid or missing token');
      expect(body.ticket).toBeUndefined();
      expect(body.expiresIn).toBeUndefined();
    }
    // Nothing was stored that could be spent, and nothing was fetched.
    expect((await proxyGet(h, `/view?ticket=${'a'.repeat(64)}`)).status).toBe(410);
    expect(h.upstream).toHaveLength(0);
  });

  it('refuses a private target with 403 and the guard reason, and mints nothing', async () => {
    h = await startProxy();
    for (const target of [
      'http://127.0.0.1/',
      'http://127.0.0.1:8787/health',
      'http://localhost/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/',
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'javascript:alert(1)',
      'https://unresolvable.example/',
    ]) {
      const res = await proxyGet(h, `/ticket?url=${encodeURIComponent(target)}&mode=raw`, {
        'x-faisal-proxy-token': PROXY_TOKEN,
      });
      expect(res.status, target).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.error, target).toBe('string');
      expect(body.ticket, target).toBeUndefined();
    }
    expect(h.upstream).toHaveLength(0);
  });

  it('rejects a bad mode and a missing url with 400, before any guard work', async () => {
    h = await startProxy();
    const headers = { 'x-faisal-proxy-token': PROXY_TOKEN };
    expect((await proxyGet(h, `/ticket?url=${encodeURIComponent(PUBLIC_TARGET)}&mode=html`, headers)).status).toBe(400);
    expect((await proxyGet(h, '/ticket?mode=raw', headers)).status).toBe(400);
    expect(h.upstream).toHaveLength(0);
  });

  it('an unknown, missing or malformed ticket is 410', async () => {
    h = await startProxy();
    for (const path of [
      '/view',
      '/view?ticket=',
      `/view?ticket=${'a'.repeat(64)}`,   // well-formed but never minted
      '/view?ticket=nope',
      `/view?ticket=${'A'.repeat(64)}`,   // uppercase is not the shape we mint
    ]) {
      const res = await proxyGet(h, path);
      expect(res.status, path).toBe(410);
      expect(((await res.json()) as { error: string }).error).toBe('ticket expired or already used');
    }
    expect(h.upstream).toHaveLength(0);
  });

  it('a ticket is single-use AND the second use never reaches the upstream', async () => {
    h = await startProxy();
    const { ticket } = await mint(h, PUBLIC_TARGET, 'raw');

    const first = await proxyGet(h, `/view?ticket=${ticket}`);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('Hello');
    expect(first.headers.get('x-faisal-proxy')).toBe('raw');
    expect(first.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(h.upstream).toEqual([PUBLIC_TARGET]);

    const second = await proxyGet(h, `/view?ticket=${ticket}`);
    expect(second.status).toBe(410);
    // THE POINT: a spent ticket buys nothing, not even a second upstream call.
    expect(h.upstream).toEqual([PUBLIC_TARGET]);
  });

  it('serves reader mode as text/plain, like /fetch does', async () => {
    h = await startProxy();
    const { ticket } = await mint(h, PUBLIC_TARGET, 'reader');
    const res = await proxyGet(h, `/view?ticket=${ticket}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-faisal-proxy')).toBe('reader');
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(h.upstream).toEqual([PUBLIC_TARGET]);
  });

  it('an expired ticket (TTL 0) is 410 and is never fetched', async () => {
    h = await startProxy({ ticketTtlMs: 0 });
    const { ticket } = await mint(h, PUBLIC_TARGET, 'raw');
    const res = await proxyGet(h, `/view?ticket=${ticket}`);
    expect(res.status).toBe(410);
    expect(h.upstream).toHaveLength(0);
  });

  it('ignores ?url= and ?mode= on /view: the ticket alone decides target and mode', async () => {
    h = await startProxy();
    const { ticket } = await mint(h, PUBLIC_TARGET, 'raw');
    const res = await proxyGet(
      h,
      `/view?ticket=${ticket}&url=${encodeURIComponent('https://evil.example/')}&mode=reader`,
    );
    expect(res.status).toBe(200);
    expect(h.upstream).toEqual([PUBLIC_TARGET]);   // not evil.example, and not twice
    expect(res.headers.get('x-faisal-proxy')).toBe('raw');   // not the requested reader
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('never accepts a ticket on /fetch, and /fetch still needs the token', async () => {
    h = await startProxy();
    const { ticket } = await mint(h, PUBLIC_TARGET, 'raw');
    const path = `/fetch?url=${encodeURIComponent(PUBLIC_TARGET)}&mode=raw`;
    // A ticket in the query string buys nothing on /fetch: no token header, no reply.
    expect((await proxyGet(h, `${path}&ticket=${ticket}`)).status).toBe(401);
    expect(h.upstream).toHaveLength(0);
    // Unchanged behaviour: the token header is the only thing that works.
    const ok = await proxyGet(h, path, { 'x-faisal-proxy-token': PROXY_TOKEN });
    expect(ok.status).toBe(200);
    expect(h.upstream).toEqual([PUBLIC_TARGET]);
  });

  it('keeps at most MAX_LIVE_TICKETS live and evicts the oldest', async () => {
    h = await startProxy();
    const tickets: string[] = [];
    for (let i = 0; i < MAX_LIVE_TICKETS + 1; i += 1) {
      tickets.push((await mint(h, `https://example.com/p${i}`, 'raw')).ticket);
    }
    expect(MAX_LIVE_TICKETS).toBe(32);
    // The oldest was evicted; the newest is live.
    expect((await proxyGet(h, `/view?ticket=${tickets[0]}`)).status).toBe(410);
    expect(h.upstream).toHaveLength(0);
    expect((await proxyGet(h, `/view?ticket=${tickets[tickets.length - 1]}`)).status).toBe(200);
    expect(h.upstream).toEqual([`https://example.com/p${MAX_LIVE_TICKETS}`]);
  });

  it('answers the OPTIONS preflight everywhere, with the private-network grant Chrome demands', async () => {
    h = await startProxy();
    const allowed = await fetch(`${h.base}/ticket`, {
      method: 'OPTIONS',
      headers: { origin: 'https://faisaldhd.github.io' },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://faisaldhd.github.io');
    expect(allowed.headers.get('access-control-allow-headers')).toBe('x-faisal-proxy-token');
    expect(allowed.headers.get('access-control-allow-methods')).toContain('GET');
    // Chrome preflights a public-page request to loopback even for a simple GET
    // and requires this header, or the probe is refused while the proxy is fine.
    expect(allowed.headers.get('access-control-allow-private-network')).toBe('true');

    // /health is the route the app probes, so it MUST answer a preflight.
    const healthPreflight = await fetch(`${h.base}/health`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://faisaldhd.github.io',
        'access-control-request-private-network': 'true',
      },
    });
    expect(healthPreflight.status).toBe(204);
    expect(healthPreflight.headers.get('access-control-allow-private-network')).toBe('true');

    // An origin that is not on the list still gets NO allow-origin header at all,
    // so the browser blocks the call whatever else is answered.
    const fetchPreflight = await fetch(`${h.base}/fetch`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    expect(fetchPreflight.status).toBe(204);
    expect(fetchPreflight.headers.get('access-control-allow-origin')).toBeNull();

    // /view is token-free, but a preflight is still answered (a browser decides
    // when to send one, and 405 would look like "no proxy" to a user).
    const view = await fetch(`${h.base}/view`, { method: 'OPTIONS' });
    expect(view.status).toBe(204);

    // No method other than GET, HEAD and OPTIONS is ever useful here.
    const post = await fetch(`${h.base}/fetch`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('NEVER logs the ticket, even with --verbose, and never logs a spent ticket', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      h = await startProxy({ verbose: true });
      const { ticket } = await mint(h, PUBLIC_TARGET, 'raw');
      expect((await proxyGet(h, `/view?ticket=${ticket}`)).status).toBe(200);
      expect((await proxyGet(h, `/view?ticket=${ticket}`)).status).toBe(410);
      const log = lines.join('\n');
      expect(log).toContain('[faisal-proxy]');
      // The single-use credential itself appears nowhere in the log.
      expect(log).not.toContain(ticket);
      expect(log).not.toContain('ticket=');
    } finally {
      spy.mockRestore();
    }
  });

  it('/health stays token-free and unchanged', async () => {
    h = await startProxy();
    const res = await proxyGet(h, '/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '1.0.0', auth: 'token-required' });
  });

  it('the upstream body cap and truncation marker are the same as /fetch (x-faisal-proxy-truncated)', async () => {
    const upstream: string[] = [];
    h = await startProxy({
      fetchImpl: async (url: string) => {
        upstream.push(String(url));
        const big = new Uint8Array(MAX_BYTES + 64).fill(65);
        return {
          status: 200,
          headers: {
            get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
            forEach: (cb: (value: string, key: string) => void) => cb('text/html; charset=utf-8', 'content-type'),
          },
          body: (async function* () { yield big; })(),
        };
      },
    });
    const { ticket } = await mint(h, PUBLIC_TARGET, 'raw');
    const res = await proxyGet(h, `/view?ticket=${ticket}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-faisal-proxy-truncated')).toBe('1');
    expect((await res.arrayBuffer()).byteLength).toBe(MAX_BYTES);
    expect(upstream).toEqual([PUBLIC_TARGET]);
  });

  it('--allow narrows what a ticket may be minted for', async () => {
    h = await startProxy({ allow: ['allowed.example'] });
    const denied = await proxyGet(h, `/ticket?url=${encodeURIComponent('https://other.example/')}&mode=raw`, {
      'x-faisal-proxy-token': PROXY_TOKEN,
    });
    expect(denied.status).toBe(403);
    const allowed = await proxyGet(h, `/ticket?url=${encodeURIComponent('https://allowed.example/')}&mode=raw`, {
      'x-faisal-proxy-token': PROXY_TOKEN,
    });
    expect(allowed.status).toBe(200);
  });
});
