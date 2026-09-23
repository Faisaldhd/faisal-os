import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateManifest } from '../../kernel/apps';
import type { AppContext, SystemAPI } from '../../kernel/types';
import { t } from '../../kernel/i18n';
import streamApp from './index';
import { manifest } from './manifest';
import {
  DEFAULT_STREAM_URL,
  DOCKER_NEKO_COMMAND,
  DOCKER_SELKIES_COMMAND,
  IFRAME_ALLOW,
  IFRAME_SANDBOX,
  PROBE_TIMEOUT_MS,
  STREAM_DOC_PATH,
  STREAM_DOC_URL,
  STREAM_URL_KEY,
  isLoopbackHostname,
  normalizeStreamUrl,
  probeStream,
  saveStreamUrl,
  savedStreamUrl,
  streamEndpointPolicy,
  type StreamStorage,
} from './config';

/** Minimal in-memory storage; `Storage` is injected, never read off the global. */
function memStorage(seed: Record<string, string> = {}): StreamStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

/** A storage partition that is blocked (private mode) or hostile: both throw. */
const throwingStorage: StreamStorage = {
  getItem: () => { throw new Error('SecurityError: storage blocked'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

/** A fetch stub that fails the test if the probe is not supposed to reach it. */
const neverCalled = (): never => { throw new Error('fetch must not be called'); };

describe('normalizeStreamUrl', () => {
  it('accepts http and https with a port and keeps the path', () => {
    expect(normalizeStreamUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(normalizeStreamUrl('https://stream.example.com:8443/neko/')).toBe('https://stream.example.com:8443/neko/');
    expect(normalizeStreamUrl('http://localhost:3001/?a=1#b')).toBe('http://localhost:3001/?a=1#b');
  });

  it('accepts http and https without a port', () => {
    expect(normalizeStreamUrl('http://192.168.1.5')).toBe('http://192.168.1.5/');
    expect(normalizeStreamUrl('https://neko.example.com')).toBe('https://neko.example.com/');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeStreamUrl('  http://127.0.0.1:8080  ')).toBe('http://127.0.0.1:8080/');
  });

  it('rejects every scheme that could execute, embed or read something', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<b>x</b>',
      'blob:https://example.com/1234',
      'file:///C:/Windows/System32/',
      'about:blank',
      'chrome://settings',
    ]) {
      expect(normalizeStreamUrl(bad)).toBeNull();
    }
  });

  it('rejects empty, blank, non-strings and garbage', () => {
    for (const bad of ['', '   ', 'not a url', '127.0.0.1:8080', '//127.0.0.1:8080', 'http://', 'https://', 'x', '<script>']) {
      expect(normalizeStreamUrl(bad)).toBeNull();
    }
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(normalizeStreamUrl(bad)).toBeNull();
    }
  });

  it('rejects credentials in the URL, so no password can leak into the frame src', () => {
    expect(normalizeStreamUrl('http://user:pass@127.0.0.1:8080')).toBeNull();
    expect(normalizeStreamUrl('https://user@stream.example.com')).toBeNull();
  });
});

describe('streamEndpointPolicy', () => {
  it('passes any https endpoint', () => {
    expect(streamEndpointPolicy('https://neko.example.com:8443')).toBe('https');
  });

  it('allows http only on loopback', () => {
    expect(streamEndpointPolicy('http://127.0.0.1:8080')).toBe('http-loopback');
    expect(streamEndpointPolicy('http://localhost:3001')).toBe('http-loopback');
    expect(streamEndpointPolicy('http://127.9.9.9:8080')).toBe('http-loopback');
    expect(streamEndpointPolicy('http://[::1]:8080')).toBe('http-loopback');
    expect(streamEndpointPolicy('http://192.168.1.5:8080')).toBe('http-remote');
    expect(streamEndpointPolicy('http://stream.example.com')).toBe('http-remote');
  });

  it('is null for anything that is not a usable endpoint', () => {
    expect(streamEndpointPolicy('javascript:alert(1)')).toBeNull();
    expect(streamEndpointPolicy('')).toBeNull();
  });

  it('classifies loopback hostnames without a URL', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHostname('localhost.evil.com')).toBe(false);
    expect(isLoopbackHostname('10.0.0.1')).toBe(false);
  });
});

describe('endpoint storage', () => {
  it('round-trips a saved endpoint', () => {
    const storage = memStorage();
    expect(savedStreamUrl(storage)).toBe(DEFAULT_STREAM_URL);
    expect(saveStreamUrl('https://neko.example.com:8443/x', storage)).toBe(true);
    expect(storage.map.get(STREAM_URL_KEY)).toBe('https://neko.example.com:8443/x');
    expect(savedStreamUrl(storage)).toBe('https://neko.example.com:8443/x');
  });

  it('refuses to store anything it would not frame', () => {
    const storage = memStorage();
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', '', 'nonsense', 'http://user:pass@h']) {
      expect(saveStreamUrl(bad, storage)).toBe(false);
    }
    expect(storage.map.size).toBe(0);
  });

  it('ignores a corrupt stored value and falls back to the default', () => {
    for (const corrupt of ['javascript:alert(1)', 'data:text/html,x', '   ', 'garbage', '']) {
      expect(savedStreamUrl(memStorage({ [STREAM_URL_KEY]: corrupt }))).toBe(DEFAULT_STREAM_URL);
    }
  });

  it('never throws and falls back to the default when storage throws', () => {
    expect(savedStreamUrl(throwingStorage)).toBe(DEFAULT_STREAM_URL);
    expect(saveStreamUrl('http://127.0.0.1:8080', throwingStorage)).toBe(false);
  });
});

describe('probeStream', () => {
  it('returns true when the client answers with an opaque, empty body', async () => {
    const opaque = { type: 'opaque', status: 0, ok: false, text: async () => '' };
    expect(await probeStream('http://127.0.0.1:8080', 50, async () => opaque)).toBe(true);
  });

  it('returns true for a JSON answer too — the body is never read', async () => {
    expect(await probeStream('http://127.0.0.1:8080', 50, async () => ({ ok: true, json: async () => ({}) }))).toBe(true);
  });

  it('returns false, never throws, when fetch rejects', async () => {
    const failing = async () => { throw new TypeError('Failed to fetch'); };
    await expect(probeStream('http://127.0.0.1:8080', 50, failing)).resolves.toBe(false);
  });

  it('returns false when fetch throws synchronously', async () => {
    const explo = (() => { throw new Error('boom'); }) as unknown as (u: string) => Promise<unknown>;
    await expect(probeStream('http://127.0.0.1:8080', 50, explo)).resolves.toBe(false);
  });

  it('never reaches fetch for a URL it would not frame', async () => {
    await expect(probeStream('javascript:alert(1)', 50, neverCalled)).resolves.toBe(false);
    await expect(probeStream('', 50, neverCalled)).resolves.toBe(false);
    await expect(probeStream(null, 50, neverCalled)).resolves.toBe(false);
  });

  it('gives up after the timeout instead of hanging on a silent endpoint', async () => {
    const silent = () => new Promise<unknown>(() => { /* never settles */ });
    await expect(probeStream('http://127.0.0.1:8080', 10, silent)).resolves.toBe(false);
  });

  it('sends no credentials and asks for an opaque, uncached response', async () => {
    let seen: RequestInit | undefined;
    const spy = async (_url: string, init?: RequestInit) => { seen = init; return {}; };
    await probeStream('http://127.0.0.1:8080', 50, spy);
    expect(seen?.mode).toBe('no-cors');
    expect(seen?.credentials).toBe('omit');
    expect(seen?.cache).toBe('no-store');
  });

  it('exposes a sane default timeout', () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(15000);
  });
});

describe('frame policy constants', () => {
  it('grants the least a cross-origin client needs, and no way out of the sandbox', () => {
    expect(IFRAME_SANDBOX).toBe('allow-scripts allow-same-origin allow-forms allow-popups allow-presentation');
    expect(IFRAME_SANDBOX).not.toContain('allow-top-navigation');
    expect(IFRAME_SANDBOX).not.toContain('allow-popups-to-escape-sandbox');
    expect(IFRAME_SANDBOX).not.toContain('allow-modals');
    expect(IFRAME_SANDBOX).not.toContain('allow-downloads');
  });

  it('delegates fullscreen and media only — and no clipboard in this version', () => {
    expect(IFRAME_ALLOW).toBe('fullscreen; encrypted-media; picture-in-picture');
    expect(IFRAME_ALLOW).not.toMatch(/clipboard/);
  });

  it('documents both run commands and the doc path', () => {
    expect(DOCKER_NEKO_COMMAND).toContain('ghcr.io/m1k1o/neko/chromium:latest');
    expect(DOCKER_NEKO_COMMAND).toContain('127.0.0.1:8080:8080');
    expect(DOCKER_NEKO_COMMAND).toContain('/udp');
    expect(DOCKER_NEKO_COMMAND).toContain('<password>');
    expect(DOCKER_SELKIES_COMMAND).toContain('lscr.io/linuxserver/chromium:latest');
    expect(STREAM_DOC_PATH).toBe('docs/STREAM_BROWSER.md');
    // The published site is `dist` only, so a relative docs link would 404 for
    // every user of the live OS: the link must be the repository URL.
    expect(STREAM_DOC_URL).toMatch(/^https:\/\/github\.com\//);
    expect(STREAM_DOC_URL).toContain(STREAM_DOC_PATH);
    expect(STREAM_DOC_URL).not.toMatch(/^\./);
  });
});

describe('streamed browser manifest', () => {
  it('is a valid manifest the kernel accepts', () => {
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it('is bilingual, asks only for network, and is a single instance', () => {
    expect(manifest.id).toBe('org.faisal.Stream');
    expect(manifest.name.ar.trim()).not.toBe('');
    expect(manifest.name.en.trim()).not.toBe('');
    expect(manifest.name.ar).not.toBe(manifest.name.en);
    expect(manifest.description?.ar.trim()).not.toBe('');
    expect(manifest.description?.en.trim()).not.toBe('');
    expect(manifest.permissions).toEqual(['network']);
    expect(manifest.singleInstance).toBe(true);
  });

  it('stays out of the "web" category the dock and launcher grid exclude', () => {
    expect(manifest.category).toBe('utilities');
  });

  it('carries a brand-tile SVG icon', () => {
    expect(typeof manifest.icon).toBe('string');
    expect(manifest.icon.startsWith('<svg')).toBe(true);
    expect(manifest.icon).toContain('viewBox="0 0 64 64"');
  });
});

/* ───────────────────────── the window itself (jsdom) ───────────────────────── */

/** The window half of an AppContext; only `content` and `setTitle` are used. */
function fakeContext(): { ctx: AppContext; content: HTMLElement; title: () => string } {
  const content = document.createElement('div');
  let title = '';
  const win = {
    id: 'w1',
    appId: manifest.id,
    content,
    setTitle: (next: string) => { title = next; },
    focus: () => {},
    close: () => {},
    onClose: () => () => {},
    requestClose: async () => {},
    setCloseGuard: () => {},
    onResize: () => () => {},
  };
  return {
    content,
    title: () => title,
    ctx: { sys: {} as SystemAPI, window: win, args: [] } as unknown as AppContext,
  };
}

/** Lets the probe promise chain settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = '';
  try { localStorage.clear(); } catch { /* storage blocked: nothing to clear */ }
});

describe('the streamed browser window', () => {
  it('shows the honest setup screen — never a blank frame — when nothing answers', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const { ctx, content, title } = fakeContext();
    streamApp.launch(ctx);
    expect(title()).toBe(t('stream.title'));
    await settle();

    expect(content.querySelector('iframe')).toBeNull();
    expect(content.textContent).toContain(t('stream.badge'));
    expect(content.textContent).toContain(t('stream.notReachableTitle'));
    expect(content.textContent).toContain(t('stream.limitsTitle'));
    // The copy-ready command and its password note are real text in the DOM.
    expect(content.textContent).toContain(DOCKER_NEKO_COMMAND);
    expect(content.querySelector('.faisal-stream-input')).not.toBeNull();
  });

  it('frames the client with the minimal sandbox when the endpoint answers', async () => {
    vi.stubGlobal('fetch', async () => ({ type: 'opaque', status: 0 }));
    const { ctx, content } = fakeContext();
    streamApp.launch(ctx);
    await settle();

    const frame = content.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('src')).toBe(DEFAULT_STREAM_URL);
    expect(frame?.getAttribute('sandbox')).toBe(IFRAME_SANDBOX);
    expect(frame?.getAttribute('allow')).toBe(IFRAME_ALLOW);
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.getAttribute('allow')).not.toMatch(/clipboard/);
    // The badge stays, and no failure text is invented.
    expect(content.textContent).toContain(t('stream.badge'));
    expect(content.querySelector('.faisal-stream-notice')).toBeNull();
  });

  it('opens the frame on request without a successful probe, and says so', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const { ctx, content } = fakeContext();
    streamApp.launch(ctx);
    await settle();

    const anyway = [...content.querySelectorAll('button')]
      .find((b) => b.textContent === t('stream.openAnyway'));
    expect(anyway).toBeDefined();
    anyway?.click();

    expect(content.querySelector('iframe')).not.toBeNull();
    expect(content.querySelector('.faisal-stream-notice')?.textContent).toBe(t('stream.unconfirmedNotice'));
  });

  it('names a remote http endpoint as refused by policy instead of framing it', async () => {
    localStorage.setItem(STREAM_URL_KEY, 'http://192.168.1.50:8080');
    const fetchSpy = vi.fn(async () => ({ type: 'opaque', status: 0 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { ctx, content } = fakeContext();
    streamApp.launch(ctx);
    await settle();

    expect(content.querySelector('iframe')).toBeNull();
    expect(content.textContent).toContain(t('stream.insecureRemoteTitle'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

