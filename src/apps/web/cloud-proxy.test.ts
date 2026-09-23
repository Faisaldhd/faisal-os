/**
 * The owner's cloud proxy (tools/cloud-proxy.mjs), exercised through its real
 * request handler with an injected upstream fetch — no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleCloudProxy, validateCloudTarget, cloudTokenMatches } from '../../../tools/cloud-proxy.mjs';
import { cloudProxyBaseFor, isAllowedProxyBase, probeLocalProxy, buildProxyUrl, CLOUD_PROXY_BASE } from './local-proxy';

const ENV = { FAISAL_PROXY_TOKEN: 'owner-secret' };
const req = (path: string, init: RequestInit = {}) => new Request(`https://faisal-os.pages.dev${path}`, init);
const withToken = (token = 'owner-secret') => ({ headers: { 'x-faisal-proxy-token': token } });
const page = (body: string, init: ResponseInit = {}) => vi.fn(async () => new Response(body, { status: 200, ...init }));

describe('cloud proxy: /health', () => {
  it('is off until the owner sets the secret', async () => {
    const off = await (await handleCloudProxy(req('/proxy/health'), {})).json();
    expect(off).toMatchObject({ ok: false, kind: 'cloud', modes: ['reader'] });
    const on = await (await handleCloudProxy(req('/proxy/health'), ENV)).json();
    expect(on).toMatchObject({ ok: true, auth: 'token-required', kind: 'cloud', modes: ['reader'] });
  });
});

describe('cloud proxy: /fetch', () => {
  it('refuses without the right token and never calls upstream', async () => {
    const upstream = page('<p>hi</p>');
    expect((await handleCloudProxy(req('/proxy/fetch?url=https://example.com/'), ENV, upstream)).status).toBe(401);
    expect((await handleCloudProxy(req('/proxy/fetch?url=https://example.com/', withToken('nope')), ENV, upstream)).status).toBe(401);
    expect((await handleCloudProxy(req('/proxy/fetch?url=https://example.com/', withToken()), {}, upstream)).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('returns the page as sandboxed plain text', async () => {
    const res = await handleCloudProxy(req('/proxy/fetch?url=https://example.com/&mode=reader', withToken()), ENV, page('<h1>مرحبا</h1><script>x()</script>'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('مرحبا');
  });

  it('is reader-only: raw mode, /ticket and /view are refused', async () => {
    const upstream = page('x');
    expect((await handleCloudProxy(req('/proxy/fetch?url=https://example.com/&mode=raw', withToken()), ENV, upstream)).status).toBe(403);
    expect((await handleCloudProxy(req('/proxy/ticket?url=https://example.com/&mode=raw', withToken()), ENV, upstream)).status).toBe(403);
    expect((await handleCloudProxy(req('/proxy/view?ticket=' + 'a'.repeat(64)), ENV, upstream)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    'http://127.0.0.1/', 'http://10.0.0.1/', 'http://[::1]/', 'http://localhost:8080/',
    'http://printer.local/', 'file:///etc/passwd', 'https://user:pw@example.com/',
  ])('blocks %s before any request', async (target) => {
    const upstream = page('x');
    const res = await handleCloudProxy(req(`/proxy/fetch?url=${encodeURIComponent(target)}`, withToken()), ENV, upstream);
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('re-checks every redirect hop', async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
    const res = await handleCloudProxy(req('/proxy/fetch?url=https://example.com/', withToken()), ENV, upstream);
    expect(res.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('only echoes allowed origins and only allows GET', async () => {
    const good = await handleCloudProxy(req('/proxy/health', { headers: { origin: 'https://faisaldhd.github.io' } }), ENV);
    expect(good.headers.get('access-control-allow-origin')).toBe('https://faisaldhd.github.io');
    const evil = await handleCloudProxy(req('/proxy/health', { headers: { origin: 'https://evil.example' } }), ENV);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    expect((await handleCloudProxy(req('/proxy/fetch', { method: 'POST' }), ENV)).status).toBe(405);
  });
});

describe('cloud proxy helpers', () => {
  it('compares tokens exactly', async () => {
    expect(await cloudTokenMatches('abc', 'abc')).toBe(true);
    expect(await cloudTokenMatches('abc', 'abd')).toBe(false);
    expect(await cloudTokenMatches('', '')).toBe(false);
    expect(await cloudTokenMatches('abc', null)).toBe(false);
  });

  it('validates targets without DNS', () => {
    expect(validateCloudTarget('https://ar.wikipedia.org/wiki/x').ok).toBe(true);
    expect(validateCloudTarget('javascript:alert(1)').ok).toBe(false);
  });
});

describe('client: choosing and trusting the cloud base', () => {
  it('uses its own /proxy on Cloudflare, production from GitHub Pages, none elsewhere', () => {
    expect(cloudProxyBaseFor('https://faisal-os.pages.dev')).toBe(CLOUD_PROXY_BASE);
    expect(cloudProxyBaseFor('https://a290a232.faisal-os.pages.dev')).toBe('https://a290a232.faisal-os.pages.dev/proxy');
    expect(cloudProxyBaseFor('https://faisaldhd.github.io')).toBe(CLOUD_PROXY_BASE);
    expect(cloudProxyBaseFor('http://localhost:5173')).toBeNull();
    expect(cloudProxyBaseFor('https://evil.pages.dev')).toBeNull();
  });

  it('builds URLs only against the loopback or the cloud base', () => {
    expect(isAllowedProxyBase(CLOUD_PROXY_BASE)).toBe(true);
    expect(isAllowedProxyBase('https://faisal-os.pages.dev.evil.com/proxy')).toBe(false);
    expect(isAllowedProxyBase('https://evil.com/proxy')).toBe(false);
    expect(buildProxyUrl(CLOUD_PROXY_BASE, 'https://example.com/')).toBe(`${CLOUD_PROXY_BASE}/fetch?url=https%3A%2F%2Fexample.com%2F&mode=reader`);
  });

  it('reads the cloud health reply: reader-only, and never an open proxy', async () => {
    const fetchWith = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    const probe = await probeLocalProxy(CLOUD_PROXY_BASE, 1000, fetchWith({ ok: true, auth: 'token-required', kind: 'cloud', modes: ['reader'] }));
    expect(probe).toMatchObject({ available: true, kind: 'cloud', modes: ['reader'] });
    const open = await probeLocalProxy(CLOUD_PROXY_BASE, 1000, fetchWith({ ok: true, auth: 'none', kind: 'cloud', modes: ['reader'] }));
    expect(open.available).toBe(false);
    const local = await probeLocalProxy('http://127.0.0.1:8787', 1000, fetchWith({ ok: true, auth: 'token-required' }));
    expect(local).toMatchObject({ available: true, kind: 'local', modes: ['reader', 'raw'] });
  });
});
