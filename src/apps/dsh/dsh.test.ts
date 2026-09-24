import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateManifest } from '../../kernel/apps';
import type { AppContext, SystemAPI } from '../../kernel/types';
import { t } from '../../kernel/i18n';
import dshApp from './index';
import { manifest } from './manifest';
import {
  DEFAULT_DSH_URL,
  DSH_DOC_PATH,
  DSH_DOC_URL,
  DSH_START_COMMANDS,
  DSH_URL_KEY,
  IFRAME_ALLOW,
  IFRAME_SANDBOX,
  PROBE_TIMEOUT_MS,
  dshEndpointPolicy,
  isLoopbackHostname,
  normalizeDshUrl,
  probeDsh,
  saveDshUrl,
  savedDshUrl,
  type DshStorage,
} from './config';

/** Minimal in-memory storage; `Storage` is injected, never read off the global. */
function memStorage(seed: Record<string, string> = {}): DshStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

/** A storage partition that is blocked (private mode) or hostile: both throw. */
const throwingStorage: DshStorage = {
  getItem: () => { throw new Error('SecurityError: storage blocked'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

/** A fetch stub that fails the test if the probe is not supposed to reach it. */
const neverCalled = (): never => { throw new Error('fetch must not be called'); };

describe('normalizeDshUrl', () => {
  it('accepts http and https with a port and keeps the path', () => {
    expect(normalizeDshUrl('http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080/');
    expect(normalizeDshUrl('https://dsh.example.com:8443/ui/')).toBe('https://dsh.example.com:8443/ui/');
  });

  it('accepts http and https without a port', () => {
    expect(normalizeDshUrl('http://192.168.1.5')).toBe('http://192.168.1.5/');
    expect(normalizeDshUrl('https://dsh.example.com')).toBe('https://dsh.example.com/');
  });

  it('KEEPS the query string, because the DSH token lives there', () => {
    // Dropping the query would frame a 401 page: DSH protects every path with a
    // token that travels in the URL, so `new URL(...).href` is the canonical form.
    expect(normalizeDshUrl('http://127.0.0.1:3080/?token=abc')).toBe('http://127.0.0.1:3080/?token=abc');
    expect(normalizeDshUrl('http://127.0.0.1:3080/?token=abc#/session/7'))
      .toBe('http://127.0.0.1:3080/?token=abc#/session/7');
    expect(normalizeDshUrl('https://dsh.example.com/ui?token=abc&x=1'))
      .toBe('https://dsh.example.com/ui?token=abc&x=1');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDshUrl('  http://127.0.0.1:3080/?token=abc  ')).toBe('http://127.0.0.1:3080/?token=abc');
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
      expect(normalizeDshUrl(bad), bad).toBeNull();
    }
  });

  it('rejects empty, blank, non-strings and garbage', () => {
    for (const bad of ['', '   ', 'not a url', '127.0.0.1:3080', '//127.0.0.1:3080', 'http://', 'https://', 'x', '<script>']) {
      expect(normalizeDshUrl(bad), bad).toBeNull();
    }
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(normalizeDshUrl(bad)).toBeNull();
    }
  });

  it('rejects credentials in the URL, so no password can leak into the frame src', () => {
    expect(normalizeDshUrl('http://user:pass@127.0.0.1:3080')).toBeNull();
    expect(normalizeDshUrl('https://user@dsh.example.com')).toBeNull();
  });
});

describe('dshEndpointPolicy', () => {
  it('passes any https endpoint', () => {
    expect(dshEndpointPolicy('https://dsh.example.com:8443')).toBe('https');
  });

  it('allows http only on loopback', () => {
    expect(dshEndpointPolicy('http://127.0.0.1:3080')).toBe('http-loopback');
    expect(dshEndpointPolicy('http://localhost:3080/?token=abc')).toBe('http-loopback');
    expect(dshEndpointPolicy('http://127.9.9.9:3080')).toBe('http-loopback');
    expect(dshEndpointPolicy('http://[::1]:3080')).toBe('http-loopback');
    expect(dshEndpointPolicy('http://192.168.1.5:3080')).toBe('http-remote');
    expect(dshEndpointPolicy('http://dsh.example.com')).toBe('http-remote');
    expect(dshEndpointPolicy(DEFAULT_DSH_URL)).toBe('http-loopback');
  });

  it('is null for anything that is not a usable endpoint', () => {
    expect(dshEndpointPolicy('javascript:alert(1)')).toBeNull();
    expect(dshEndpointPolicy('')).toBeNull();
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
  it('round-trips a saved endpoint — token and all — under its own key', () => {
    const storage = memStorage();
    expect(savedDshUrl(storage)).toBe(DEFAULT_DSH_URL);
    expect(saveDshUrl('http://127.0.0.1:3080/?token=abc', storage)).toBe(true);
    expect(storage.map.get(DSH_URL_KEY)).toBe('http://127.0.0.1:3080/?token=abc');
    expect(savedDshUrl(storage)).toBe('http://127.0.0.1:3080/?token=abc');
  });

  it('refuses to store anything it would not frame', () => {
    const storage = memStorage();
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', '', 'nonsense', 'http://user:pass@h']) {
      expect(saveDshUrl(bad, storage)).toBe(false);
    }
    expect(storage.map.size).toBe(0);
  });

  it('ignores a corrupt stored value and falls back to the default', () => {
    for (const corrupt of ['javascript:alert(1)', 'data:text/html,x', '   ', 'garbage', '']) {
      expect(savedDshUrl(memStorage({ [DSH_URL_KEY]: corrupt }))).toBe(DEFAULT_DSH_URL);
    }
  });

  it('never throws and falls back to the default when storage throws', () => {
    expect(savedDshUrl(throwingStorage)).toBe(DEFAULT_DSH_URL);
    expect(saveDshUrl('http://127.0.0.1:3080', throwingStorage)).toBe(false);
  });
});

describe('probeDsh', () => {
  it('resolves TRUE for an opaque 401-like response — "answered" is all it claims', async () => {
    // A DSH server without a token answers 401 on every path; in `no-cors` mode
    // that arrives as an opaque response, which resolves. That is the whole point:
    // the probe reports "something answered on that port", never "authorised".
    const opaque401 = { type: 'opaque', status: 0, ok: false, text: async () => '' };
    expect(await probeDsh('http://127.0.0.1:3080/?token=abc', 50, async () => opaque401)).toBe(true);
  });

  it('resolves true for an ordinary rendered page too — the body is never read', async () => {
    expect(await probeDsh('http://127.0.0.1:3080', 50, async () => ({ ok: true, text: async () => '<html>' }))).toBe(true);
  });

  it('resolves false, never throws, when fetch rejects', async () => {
    const failing = async () => { throw new TypeError('Failed to fetch'); };
    await expect(probeDsh('http://127.0.0.1:3080', 50, failing)).resolves.toBe(false);
  });

  it('resolves false when fetch throws synchronously', async () => {
    const explo = (() => { throw new Error('boom'); }) as unknown as (u: string) => Promise<unknown>;
    await expect(probeDsh('http://127.0.0.1:3080', 50, explo)).resolves.toBe(false);
  });

  it('gives up after the timeout — resolves false, never hangs on a silent server', async () => {
    const silent = () => new Promise<unknown>(() => { /* never settles */ });
    await expect(probeDsh('http://127.0.0.1:3080', 10, silent)).resolves.toBe(false);
  });

  it('resolves false on an abort, not just on a reject', async () => {
    const aborting = (_url: string, init?: RequestInit) => new Promise<unknown>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) { reject(new Error('no signal to abort')); return; }
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    await expect(probeDsh('http://127.0.0.1:3080', 10, aborting)).resolves.toBe(false);
  });

  it('never reaches fetch for a URL it would not frame', async () => {
    await expect(probeDsh('javascript:alert(1)', 50, neverCalled)).resolves.toBe(false);
    await expect(probeDsh('', 50, neverCalled)).resolves.toBe(false);
    await expect(probeDsh(null, 50, neverCalled)).resolves.toBe(false);
  });

  it('probes the tokenised URL itself, query string included', async () => {
    let seenUrl = '';
    await probeDsh('http://127.0.0.1:3080/?token=abc', 50, async (u) => { seenUrl = u; return {}; });
    expect(seenUrl).toBe('http://127.0.0.1:3080/?token=abc');
  });

  it('sends no credentials and asks for an opaque, uncached response', async () => {
    let seen: RequestInit | undefined;
    const spy = async (_url: string, init?: RequestInit) => { seen = init; return {}; };
    await probeDsh('http://127.0.0.1:3080', 50, spy);
    expect(seen?.mode).toBe('no-cors');
    expect(seen?.credentials).toBe('omit');
    expect(seen?.cache).toBe('no-store');
    expect(seen?.method).toBe('GET');
  });

  it('exposes a sane default timeout', () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(15000);
  });
});

describe('frame policy constants', () => {
  it('ships exactly the documented sandbox, and no way out of it', () => {
    expect(IFRAME_SANDBOX).toBe('allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
    expect(IFRAME_SANDBOX).not.toContain('allow-top-navigation');
    expect(IFRAME_SANDBOX).not.toContain('allow-popups-to-escape-sandbox');
    expect(IFRAME_SANDBOX).not.toContain('allow-modals');
    expect(IFRAME_SANDBOX).not.toContain('allow-presentation');
  });

  it('GRANTS the clipboard here, unlike the Streamed Browser — pinned so nobody "fixes" it by accident', () => {
    // This frame is the owner's own local tool on his own machine, and a chat UI
    // without paste is unusable; the Streamed Browser frames a remote session and
    // therefore refuses the clipboard (src/apps/stream/config.ts). If a future
    // change removes it here, that is a decision, not a cleanup.
    expect(IFRAME_ALLOW).toBe('clipboard-read; clipboard-write; fullscreen');
    expect(IFRAME_ALLOW).toContain('clipboard-read');
    expect(IFRAME_ALLOW).toContain('clipboard-write');
    expect(IFRAME_ALLOW).toContain('fullscreen');
  });

  it('documents the doc path and a repository URL, because `docs` is not published', () => {
    expect(DSH_DOC_PATH).toBe('docs/DSH.md');
    expect(DSH_DOC_URL).toMatch(/^https:\/\/github\.com\//);
    expect(DSH_DOC_URL).toContain(DSH_DOC_PATH);
    expect(DSH_DOC_URL).not.toMatch(/^\./);
  });

  it('ships start commands that are ASCII-only, one line each, with no continuation', () => {
    // A shell command is not prose: Arabic text inside it is a second way to fail
    // before Node starts, a newline silently truncates a paste, and a trailing `\`
    // is bash syntax that PowerShell does not have. `<...>` placeholders are
    // deliberately absent too.
    expect(DSH_START_COMMANDS.length).toBeGreaterThanOrEqual(3);
    const commands = DSH_START_COMMANDS.map((c) => c.command);
    expect(commands).toContain('corepack pnpm dsh web');
    expect(commands).toContain('npx @deepseek-ai/dsh web');
    for (const { id, labelKey, command } of DSH_START_COMMANDS) {
      expect(command, id).not.toContain('\n');
      expect(command, id).not.toContain('\\\n');
      expect(command, id).not.toMatch(/[^\x00-\x7F]/);
      expect(command, id).not.toContain('<');
      expect(command.trim(), id).toBe(command);
      expect(command.length, id).toBeGreaterThan(0);
      expect(labelKey, id).toMatch(/^dsh\./);
    }
    // The PowerShell pair: change into the owner's checkout, then start the web UI.
    const windows = DSH_START_COMMANDS.find((c) => c.id === 'windows');
    expect(windows?.command).toBe(
      'cd $HOME' + '\\' + 'Projects' + '\\' + 'deepseek-harness; corepack pnpm dsh web',
    );
  });
});

describe('DeepSeek Harness manifest', () => {
  it('is a valid manifest the kernel accepts', () => {
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it('is bilingual, asks only for network, and is a single instance', () => {
    expect(manifest.id).toBe('org.faisal.DSH');
    expect(manifest.name.ar.trim()).not.toBe('');
    expect(manifest.name.en.trim()).not.toBe('');
    expect(manifest.name.ar).not.toBe(manifest.name.en);
    expect(manifest.name.ar).toBe('ديب سيك هارنس');
    expect(manifest.name.en).toBe('DeepSeek Harness');
    expect(manifest.description?.ar.trim()).not.toBe('');
    expect(manifest.description?.en.trim()).not.toBe('');
    expect(manifest.permissions).toEqual(['network']);
    expect(manifest.singleInstance).toBe(true);
    expect(manifest.core).toBe(false);
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

describe('the DeepSeek Harness window', () => {
  it('shows the honest setup screen — never a blank frame — when nothing answers', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const { ctx, content, title } = fakeContext();
    dshApp.launch(ctx);
    expect(title()).toBe(t('dsh.title'));
    await settle();

    expect(content.querySelector('iframe')).toBeNull();
    // The permanent badge names the app, and never claims a connection.
    expect(content.textContent).toContain(t('dsh.badge'));
    expect(content.textContent).toContain(t('dsh.notReachableTitle'));
    // It says plainly that it cannot start the harness itself.
    expect(content.textContent).toContain(t('dsh.outsideNote'));
    // Every copy-ready start command is real text in the DOM.
    for (const { command } of DSH_START_COMMANDS) expect(content.textContent).toContain(command);
    expect(content.textContent).toContain(t('dsh.limitsTitle'));
    expect(content.querySelector('.faisal-dsh-input')).not.toBeNull();
  });

  it('frames the pasted URL — token included — with the documented sandbox when it answers', async () => {
    const tokenised = 'http://127.0.0.1:3080/?token=abc';
    // The full URL DSH prints (token and all) is what the owner saves and what the
    // window must frame, byte for byte.
    localStorage.setItem(DSH_URL_KEY, tokenised);
    vi.stubGlobal('fetch', async () => ({ type: 'opaque', status: 0 }));
    const { ctx, content } = fakeContext();
    dshApp.launch(ctx);
    await settle();

    const frames = content.querySelectorAll('iframe');
    expect(frames.length).toBe(1);
    const frame = frames[0];
    expect(frame.getAttribute('src')).toBe(tokenised);
    expect(frame.getAttribute('sandbox')).toBe(IFRAME_SANDBOX);
    expect(frame.getAttribute('allow')).toBe(IFRAME_ALLOW);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    // The clipboard grant is on purpose here (see config.ts): pin it.
    expect(frame.getAttribute('allow')).toContain('clipboard-write');
    // The badge stays, and no failure text is invented.
    expect(content.textContent).toContain(t('dsh.badge'));
    expect(content.querySelector('.faisal-dsh-notice')).toBeNull();
  });

  it('frames the unchanged default address while the toolbar still names the app, not a connection', async () => {
    vi.stubGlobal('fetch', async () => ({ type: 'opaque', status: 0 }));
    const { ctx, content } = fakeContext();
    dshApp.launch(ctx);
    await settle();

    expect(content.querySelector('iframe')?.getAttribute('src')).toBe(DEFAULT_DSH_URL);
    // A 401 resolves the probe, so the frame really loads — and the badge still
    // says only what the app is.
    expect(content.textContent).toContain(t('dsh.badge'));
    expect(content.textContent).not.toContain(t('dsh.notReachableTitle'));
  });

  it('refuses a malformed paste in the field, then frames a valid one without storing the bad value', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls += 1; return { type: 'opaque', status: 0 }; });
    const { ctx, content } = fakeContext();
    dshApp.launch(ctx);
    await settle();
    expect(calls).toBe(1);
    expect(content.querySelector('iframe')).not.toBeNull();

    // "Change address" only *hides* the frame — a live chat survives it. The setup
    // form exists only in that view, so it is looked up after the switch.
    const change = [...content.querySelectorAll('button')].find((b) => b.textContent === t('dsh.changeUrl'));
    change?.click();

    const field = content.querySelector<HTMLInputElement>('.faisal-dsh-input');
    const form = content.querySelector('form');
    const submit = (): void => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
    expect(field).not.toBeNull();
    expect(form).not.toBeNull();

    field!.value = 'javascript:alert(1)';
    submit();
    await settle();
    expect(content.textContent).toContain(t('dsh.badUrl'));
    // Nothing invalid was probed or stored.
    expect(calls).toBe(1);
    expect(localStorage.getItem(DSH_URL_KEY)).toBeNull();

    const tokenised = 'http://127.0.0.1:3080/?token=xyz';
    field!.value = tokenised;
    submit();
    await settle();
    expect(calls).toBe(2);
    expect(localStorage.getItem(DSH_URL_KEY)).toBe(tokenised);
    expect(content.querySelectorAll('iframe').length).toBe(1);
    expect(content.querySelector('iframe')?.getAttribute('src')).toBe(tokenised);
  });

  it('opens the frame on request without a successful probe, and says so', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const { ctx, content } = fakeContext();
    dshApp.launch(ctx);
    await settle();

    const anyway = [...content.querySelectorAll('button')]
      .find((b) => b.textContent === t('dsh.openAnyway'));
    expect(anyway).toBeDefined();
    anyway?.click();

    expect(content.querySelector('iframe')).not.toBeNull();
    expect(content.querySelector('.faisal-dsh-notice')?.textContent).toBe(t('dsh.unconfirmedNotice'));
  });

  it('refuses a remote http endpoint by policy instead of framing it, and sends no probe', async () => {
    localStorage.setItem(DSH_URL_KEY, 'http://192.168.1.50:3080');
    const fetchSpy = vi.fn(async () => ({ type: 'opaque', status: 0 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { ctx, content } = fakeContext();
    dshApp.launch(ctx);
    await settle();

    expect(content.querySelector('iframe')).toBeNull();
    expect(content.textContent).toContain(t('dsh.insecureRemoteTitle'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
