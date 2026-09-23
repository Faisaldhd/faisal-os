import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../kernel/i18n';
import type { AppContext, SystemAPI, WindowHandle, WindowManager } from '../../kernel/types';
import {
  canGoBack,
  canGoForward,
  createHistory,
  currentUrl,
  goBack,
  goForward,
  pushUrl,
  pushUrlUnlessSame,
  replaceUrl,
} from './history';
import { decideOutcome, isLoading, offersExternal, planNavigation } from './outcome';
import {
  IFRAME_ALLOW,
  IFRAME_SANDBOX,
  FRAME_TIMEOUT_MS,
  createWebAppModule,
  launchWebApp,
} from './index';
import { WIRED_WEB_APPS, type WebAppDef, type WebStorage } from './registry';

const SELF_ORIGIN = 'https://os.example';
const WIKI = 'https://www.wikipedia.org/';

const wikipedia = WIRED_WEB_APPS.find((d) => d.id === 'wikipedia')!;
const google = WIRED_WEB_APPS.find((d) => d.id === 'google')!;

// The window copy is produced by the real i18n table, so pin the locale.
beforeEach(() => setLocale('en'));

function memStorage(): WebStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}

/* ═════════════════════════ 1. URL handling (shared policy) ═════════════════════════ */

describe('web app URL handling', () => {
  it('turns a plain domain into https', () => {
    const plan = planNavigation('en.wikipedia.org/wiki/Main_Page', 'en', SELF_ORIGIN);
    expect(plan.embedUrl).toBe('https://en.wikipedia.org/wiki/Main_Page');
    expect(plan.displayUrl).toBe('https://en.wikipedia.org/wiki/Main_Page');
    expect(plan.refusal).toBeNull();
  });

  it('upgrades http to https', () => {
    expect(planNavigation('http://example.com/a', 'en', SELF_ORIGIN).embedUrl).toBe('https://example.com/a');
  });

  it('refuses javascript:, data:, vbscript:, blob: and file: outright — never navigates to them', () => {
    for (const raw of ['javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'vbscript:msgbox(1)', 'blob:https://x/y', 'file:///C:/secret.txt']) {
      const plan = planNavigation(raw, 'en', SELF_ORIGIN);
      // The one agreed policy: a non-http(s) scheme is refused in-window.
      // It is not a URL, it is not a search, and it is never assigned to the frame.
      expect(plan.refusal).toBe('unsafe-scheme');
      expect(plan.embedUrl).toBeNull();
      expect(plan.searchFor).toBeNull();
    }
  });

  it('still turns plain words (no scheme) into a Wikipedia search', () => {
    const plan = planNavigation('faisal os', 'en', SELF_ORIGIN);
    expect(plan.refusal).toBeNull();
    expect(plan.searchFor).toBe('faisal os');
  });

  it('refuses a URL on the OS own origin', () => {
    const plan = planNavigation(`${SELF_ORIGIN}/index.html`, 'en', SELF_ORIGIN);
    expect(plan.embedUrl).toBeNull();
    expect(plan.refusal).toBe('not-embeddable');
  });

  it('refuses a known frame-blocking host', () => {
    const plan = planNavigation('https://www.google.com/search?q=x', 'en', SELF_ORIGIN);
    expect(plan.embedUrl).toBeNull();
    expect(plan.refusal).toBe('blocked-domain');
    expect(plan.displayUrl).toBe('https://www.google.com/search?q=x');
  });

  it('offers the YouTube /embed/ rewrite where it applies', () => {
    const watch = planNavigation('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'en', SELF_ORIGIN);
    expect(watch.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(watch.displayUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(watch.rewrittenFrom).toBe(watch.displayUrl);
    expect(watch.refusal).toBeNull();

    expect(planNavigation('https://youtu.be/dQw4w9WgXcQ', 'en', SELF_ORIGIN).embedUrl)
      .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');

    // The YouTube home page has no id to rewrite, so it stays blocked.
    expect(planNavigation('https://www.youtube.com/', 'en', SELF_ORIGIN).refusal).toBe('blocked-domain');
  });

  it('turns plain words into an in-frame Wikipedia search in the current locale', () => {
    const en = planNavigation('faisal os', 'en', SELF_ORIGIN);
    expect(en.searchFor).toBe('faisal os');
    expect(en.embedUrl).toBe('https://en.wikipedia.org/w/index.php?search=faisal%20os');
    expect(planNavigation('فيصل', 'ar', SELF_ORIGIN).embedUrl)
      .toBe('https://ar.wikipedia.org/w/index.php?search=%D9%81%D9%8A%D8%B5%D9%84');
  });

  it('refuses an empty address', () => {
    expect(planNavigation('   ', 'en', SELF_ORIGIN).refusal).toBe('empty');
  });
});

/* ═════════════════════════ 2. back/forward stack (pure) ═════════════════════════ */

describe('visited-URL history stack', () => {
  it('starts on the first URL with nowhere to go', () => {
    const h = createHistory('https://a.example/');
    expect(currentUrl(h)).toBe('https://a.example/');
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
    expect(goBack(h)).toBe(h);
    expect(goForward(h)).toBe(h);
  });

  it('walks back and forward through visited URLs', () => {
    let h = createHistory('https://a.example/');
    h = pushUrl(h, 'https://b.example/');
    h = pushUrl(h, 'https://c.example/');
    expect(canGoBack(h)).toBe(true);
    h = goBack(h);
    expect(currentUrl(h)).toBe('https://b.example/');
    expect(canGoForward(h)).toBe(true);
    h = goForward(h);
    expect(currentUrl(h)).toBe('https://c.example/');
    expect(canGoForward(h)).toBe(false);
  });

  it('drops the entries ahead when navigating after going back', () => {
    let h = createHistory('a');
    h = pushUrl(h, 'b');
    h = pushUrl(h, 'c');
    h = goBack(goBack(h));
    expect(currentUrl(h)).toBe('a');
    h = pushUrl(h, 'd');
    expect(h.entries).toEqual(['a', 'd']);
    expect(canGoForward(h)).toBe(false);
  });

  it('does not add an entry when the URL is already showing', () => {
    const h = createHistory('a');
    expect(pushUrlUnlessSame(h, 'a')).toBe(h);
    expect(pushUrlUnlessSame(h, 'b').entries).toEqual(['a', 'b']);
  });

  it('replaces the current entry without growing the stack', () => {
    const h = replaceUrl(createHistory('a'), 'a2');
    expect(h.entries).toEqual(['a2']);
    expect(h.index).toBe(0);
  });
});

/* ═══════════════════ 3. load/blocked outcome decision (pure) ═══════════════════ */

describe('load/blocked outcome decision', () => {
  it('loaded ⇒ the frame is shown ("ok")', () => {
    expect(decideOutcome({ refusal: null, embedNote: 'allowed', signal: 'loaded' })).toEqual({ kind: 'frame' });
    expect(isLoading({ refusal: null, embedNote: 'allowed', signal: 'loaded' })).toBe(false);
  });

  it('timed out ⇒ blocked, with the external offer', () => {
    expect(decideOutcome({ refusal: null, embedNote: 'allowed', signal: 'timed-out' }))
      .toEqual({ kind: 'blocked-fallback' });
    expect(offersExternal({ refusal: null, embedNote: 'allowed', signal: 'timed-out' })).toBe(true);
  });

  it('embedNote "blocked" ⇒ an immediate warning, no timeout wait', () => {
    // signal is still 'pending': the decision must not depend on the timeout.
    expect(decideOutcome({ refusal: null, embedNote: 'blocked', signal: 'pending' }))
      .toEqual({ kind: 'blocked-fallback' });
    expect(offersExternal({ refusal: null, embedNote: 'blocked', signal: 'pending' })).toBe(true);
  });

  it('a hard refusal (scheme / not embeddable / empty) ⇒ refused, whatever else is true', () => {
    for (const signal of ['pending', 'loaded', 'timed-out'] as const) {
      expect(decideOutcome({ refusal: 'not-embeddable', embedNote: 'allowed', signal })).toEqual({ kind: 'refused' });
      expect(decideOutcome({ refusal: 'unsafe-scheme', embedNote: 'allowed', signal })).toEqual({ kind: 'refused' });
      expect(decideOutcome({ refusal: 'empty', embedNote: 'allowed', signal })).toEqual({ kind: 'refused' });
    }
    expect(isLoading({ refusal: 'empty', embedNote: 'allowed', signal: 'pending' })).toBe(false);
    expect(offersExternal({ refusal: 'empty', embedNote: 'allowed', signal: 'pending' })).toBe(true);
  });

  it('a known blocked host ⇒ the fallback card, not the terse refusal', () => {
    // The URL policy refuses the host and the registry records it as blocked —
    // the same measured fact. The card (explain + external + try anyway) wins,
    // whether or not the def carries its own note.
    expect(decideOutcome({ refusal: 'blocked-domain', embedNote: 'blocked', signal: 'pending' }))
      .toEqual({ kind: 'blocked-fallback' });
    expect(decideOutcome({ refusal: 'blocked-domain', embedNote: 'allowed', signal: 'pending' }))
      .toEqual({ kind: 'blocked-fallback' });
    expect(offersExternal({ refusal: 'blocked-domain', embedNote: 'blocked', signal: 'pending' })).toBe(true);
  });

  it('the try-anyway override rescues even a blocked-domain refusal', () => {
    // Otherwise "Try embedding anyway" would be dead on the sites that need it.
    expect(decideOutcome({ refusal: 'blocked-domain', embedNote: 'blocked', signal: 'pending', attempt: 'user' }))
      .toEqual({ kind: 'frame' });
    expect(isLoading({ refusal: 'blocked-domain', embedNote: 'blocked', signal: 'pending', attempt: 'user' })).toBe(true);
  });

  it('the user override hands the blocked site to the ordinary frame flow', () => {
    expect(decideOutcome({ refusal: null, embedNote: 'blocked', signal: 'pending', attempt: 'user' }))
      .toEqual({ kind: 'frame' });
    expect(isLoading({ refusal: null, embedNote: 'blocked', signal: 'pending', attempt: 'user' })).toBe(true);
    // And if it then stays silent, the fallback card comes back.
    expect(decideOutcome({ refusal: null, embedNote: 'blocked', signal: 'timed-out', attempt: 'user' }))
      .toEqual({ kind: 'blocked-fallback' });
  });

  it('a pending, believed-embeddable site shows the frame behind a spinner', () => {
    expect(decideOutcome({ refusal: null, embedNote: 'allowed', signal: 'pending' })).toEqual({ kind: 'frame' });
    expect(isLoading({ refusal: null, embedNote: 'allowed', signal: 'pending' })).toBe(true);
  });
});

/* ═════════════════════ 4. DOM harness (fake WM + SystemAPI) ═════════════════════ */

interface Harness {
  wm: WindowManager;
  sys: SystemAPI;
  storage: ReturnType<typeof memStorage>;
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

function openWindow(harness: Harness, def: WebAppDef, storage: WebStorage = harness.storage) {
  const win = harness.wm.open({ appId: `org.faisal.Web.${def.id}`, title: def.title.en });
  const ctx: AppContext = { sys: harness.sys, window: win, args: [] };
  createWebAppModule(def, { storage }).launch(ctx);
  return win;
}

const q = <T extends Element = HTMLElement>(win: WindowHandle, sel: string): T | null =>
  win.content.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(win: WindowHandle, sel: string): T[] =>
  [...win.content.querySelectorAll<T>(sel)];

function submitAddress(win: WindowHandle, value: string): void {
  const input = win.content.querySelector<HTMLInputElement>('.faisal-web-address')!;
  input.value = value;
  const form = win.content.querySelector('form')!;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('web app window (DOM harness)', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
    document.body.textContent = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the toolbar and an iframe on the def URL with the minimal sandbox', () => {
    const win = openWindow(harness, wikipedia);

    expect(q(win, '.faisal-web')).not.toBeNull();
    expect(q(win, '.faisal-web-toolbar')).not.toBeNull();
    // back, forward, reload, external + the Go button = five controls.
    expect(qa(win, '.faisal-web-btn')).toHaveLength(4);
    expect(q(win, '.faisal-web-go')).not.toBeNull();
    expect(q(win, '.faisal-web-address')).not.toBeNull();

    const frame = q<HTMLIFrameElement>(win, 'iframe.faisal-web-frame')!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('src')).toBe(WIKI);
    expect(frame.getAttribute('sandbox')).toBe(IFRAME_SANDBOX);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('allow')).toBe(IFRAME_ALLOW);
  });

  it('uses the least sandbox: no popups-to-escape-sandbox, no top navigation', () => {
    const win = openWindow(harness, wikipedia);
    const sandbox = q<HTMLIFrameElement>(win, 'iframe')!.getAttribute('sandbox')!;
    expect(sandbox.split(' ')).toEqual([
      'allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-presentation',
    ]);
    expect(sandbox).not.toContain('allow-popups-to-escape-sandbox');
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-modals');
    expect(sandbox).not.toContain('allow-downloads');
    // No OS state is ever handed to the frame, in either direction.
    expect(win.content.querySelector('iframe')!.outerHTML).not.toContain('postMessage');
  });

  it('navigating through the address field updates the frame', () => {
    const win = openWindow(harness, wikipedia);
    submitAddress(win, 'en.wikipedia.org/wiki/Faisal_OS');
    const frame = q<HTMLIFrameElement>(win, 'iframe')!;
    expect(frame.getAttribute('src')).toBe('https://en.wikipedia.org/wiki/Faisal_OS');
    expect(q<HTMLInputElement>(win, '.faisal-web-address')!.value).toBe('https://en.wikipedia.org/wiki/Faisal_OS');
    expect(harness.storage.map.get('faisal.web.wikipedia.url'))
      .toBe('https://en.wikipedia.org/wiki/Faisal_OS');
  });

  it('a refused URL shows an in-window message instead of navigating', () => {
    const win = openWindow(harness, wikipedia);
    submitAddress(win, 'javascript:alert(1)');
    // The agreed policy: a scheme is refused, never framed and never searched.
    expect(q(win, 'iframe')).toBeNull();
    expect(q(win, '.faisal-web-fallback.is-refusal')).not.toBeNull();
    expect(win.content.textContent).toContain('never opened or displayed here');

    submitAddress(win, 'https://www.google.com/search?q=x');
    // A known frame-blocking host: the fallback card explains it and offers the
    // external tab, so no iframe is created and nothing is navigated to.
    expect(q(win, 'iframe')).toBeNull();
    expect(q(win, '.faisal-web-fallback')).not.toBeNull();
    expect(q(win, '.faisal-web-open')).not.toBeNull();
    expect(win.content.textContent).toContain('asks browsers not to display it inside a frame');
  });

  it('a site marked embedNote "blocked" warns immediately and offers Open externally', () => {
    const win = openWindow(harness, google);
    expect(q(win, 'iframe')).toBeNull();
    expect(q(win, '.faisal-web-fallback')).not.toBeNull();
    expect(q(win, '.faisal-web-open')).not.toBeNull();
    expect(q(win, '.faisal-web-try')).not.toBeNull();
    expect(win.content.textContent).toContain('This site cannot be shown in a window');
  });

  it('"Try embedding anyway" creates the frame for a site the registry marked blocked', () => {
    const win = openWindow(harness, google);
    expect(q(win, 'iframe')).toBeNull();
    q<HTMLButtonElement>(win, '.faisal-web-try')!.click();
    const frame = q<HTMLIFrameElement>(win, 'iframe')!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('src')).toBe(google.url);
    expect(frame.getAttribute('sandbox')).toBe(IFRAME_SANDBOX);
    // The user is told up front that this site normally refuses embedding.
    expect(win.content.textContent).toContain('This site may not appear here');
  });

  it('after the escape hatch, a normal load keeps the frame', () => {
    vi.useFakeTimers();
    const win = openWindow(harness, google);
    q<HTMLButtonElement>(win, '.faisal-web-try')!.click();
    q<HTMLIFrameElement>(win, 'iframe')!.dispatchEvent(new Event('load'));
    expect(q(win, '.faisal-web-loading')).toBeNull();
    vi.advanceTimersByTime(FRAME_TIMEOUT_MS + 1);
    expect(q(win, 'iframe')).not.toBeNull();
    expect(q(win, '.faisal-web-fallback')).toBeNull();
  });

  it('after the escape hatch, silence returns the user to the fallback card', () => {
    vi.useFakeTimers();
    const win = openWindow(harness, google);
    q<HTMLButtonElement>(win, '.faisal-web-try')!.click();
    expect(q(win, 'iframe')).not.toBeNull();
    vi.advanceTimersByTime(FRAME_TIMEOUT_MS + 1);
    expect(q(win, 'iframe')).toBeNull();
    expect(q(win, '.faisal-web-fallback')).not.toBeNull();
    expect(win.content.textContent).toContain('The site did not appear');
  });

  it('a new address resets the escape hatch, so the warning comes back', () => {
    const win = openWindow(harness, google);
    q<HTMLButtonElement>(win, '.faisal-web-try')!.click();
    expect(q(win, 'iframe')).not.toBeNull();
    submitAddress(win, 'https://www.google.com/search?q=again');
    expect(q(win, 'iframe')).toBeNull();
    expect(q(win, '.faisal-web-try')).not.toBeNull();
  });

  it('the external button opens a real tab with noopener,noreferrer', () => {
    const win = openWindow(harness, google);
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    q<HTMLButtonElement>(win, '.faisal-web-open')!.click();
    expect(spy).toHaveBeenCalledWith(google.url, '_blank', 'noopener,noreferrer');
    spy.mockRestore();
  });

  it('falls back to the external panel when no load event arrives in time', () => {
    vi.useFakeTimers();
    const win = openWindow(harness, wikipedia);
    expect(q<HTMLIFrameElement>(win, 'iframe')).not.toBeNull();
    expect(q(win, '.faisal-web-loading')).not.toBeNull();

    vi.advanceTimersByTime(FRAME_TIMEOUT_MS + 1);

    expect(q(win, 'iframe')).toBeNull();
    expect(q(win, '.faisal-web-fallback')).not.toBeNull();
    expect(q(win, '.faisal-web-open')).not.toBeNull();
    expect(win.content.textContent).toContain('The site did not appear');
  });

  it('a load event hides the spinner and keeps the frame', () => {
    vi.useFakeTimers();
    const win = openWindow(harness, wikipedia);
    q<HTMLIFrameElement>(win, 'iframe')!.dispatchEvent(new Event('load'));
    expect(q(win, '.faisal-web-loading')).toBeNull();
    // The timeout must not fire after a successful load.
    vi.advanceTimersByTime(FRAME_TIMEOUT_MS + 1);
    expect(q(win, 'iframe')).not.toBeNull();
    expect(q(win, '.faisal-web-fallback')).toBeNull();
  });

  it('restores the last visited URL from storage on open', () => {
    harness.storage.setItem('faisal.web.wikipedia.url', 'https://en.wikipedia.org/wiki/Faisal');
    const win = openWindow(harness, wikipedia);
    expect(q<HTMLIFrameElement>(win, 'iframe')!.getAttribute('src')).toBe('https://en.wikipedia.org/wiki/Faisal');
    expect(q<HTMLInputElement>(win, '.faisal-web-address')!.value).toBe('https://en.wikipedia.org/wiki/Faisal');
  });

  it('starts on the def URL when storage throws', () => {
    const throwing: WebStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    const win = openWindow(harness, wikipedia, throwing);
    expect(q<HTMLIFrameElement>(win, 'iframe')!.getAttribute('src')).toBe(WIKI);
    expect(() => submitAddress(win, 'en.wikipedia.org/')).not.toThrow();
  });

  it('back/forward drive the app own stack and disable when there is nowhere to go', () => {
    const win = openWindow(harness, wikipedia);
    const back = q<HTMLButtonElement>(win, '.faisal-web-btn')!;
    const forward = qa<HTMLButtonElement>(win, '.faisal-web-btn')[1];
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);

    submitAddress(win, 'https://en.wikipedia.org/wiki/A');
    submitAddress(win, 'https://en.wikipedia.org/wiki/B');
    expect(back.disabled).toBe(false);

    back.click();
    expect(q<HTMLIFrameElement>(win, 'iframe')!.getAttribute('src')).toBe('https://en.wikipedia.org/wiki/A');
    expect(forward.disabled).toBe(false);
    forward.click();
    expect(q<HTMLIFrameElement>(win, 'iframe')!.getAttribute('src')).toBe('https://en.wikipedia.org/wiki/B');
    expect(forward.disabled).toBe(true);
  });

  it('rewrites a YouTube watch URL into the embeddable form and says so', () => {
    const win = openWindow(harness, wikipedia);
    submitAddress(win, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(q<HTMLIFrameElement>(win, 'iframe')!.getAttribute('src'))
      .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(win.content.textContent).toContain('The link was rewritten to its /embed/ form');
  });

  it('opens two different web apps as two independent windows', () => {
    const a = openWindow(harness, wikipedia);
    const b = openWindow(harness, google);

    expect(harness.wm.list()).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
    expect(q<HTMLIFrameElement>(a, 'iframe')!.getAttribute('src')).toBe(WIKI);
    expect(q(b, 'iframe')).toBeNull();

    // Navigating one window must not touch the other.
    submitAddress(a, 'https://en.wikipedia.org/wiki/Only_A');
    expect(q<HTMLIFrameElement>(a, 'iframe')!.getAttribute('src')).toBe('https://en.wikipedia.org/wiki/Only_A');
    expect(q(b, 'iframe')).toBeNull();
    expect(harness.storage.map.get('faisal.web.google.url')).toBeUndefined();
    expect(harness.storage.map.get('faisal.web.wikipedia.url')).toBe('https://en.wikipedia.org/wiki/Only_A');
  });

  it('gives the window a site-specific title', () => {
    openWindow(harness, wikipedia);
    expect([...document.querySelectorAll('.test-title')].at(-1)?.textContent).toContain('Web App — Wikipedia');
  });

  it('clears its pending timer when the window closes', () => {
    vi.useFakeTimers();
    const win = openWindow(harness, wikipedia);
    win.close();
    expect(() => vi.advanceTimersByTime(FRAME_TIMEOUT_MS + 1)).not.toThrow();
  });

  it('launchWebApp is usable directly with an injected storage', () => {
    const storage = memStorage();
    const win = harness.wm.open({ appId: 'org.faisal.Web.wikipedia', title: 'w' });
    launchWebApp(wikipedia, { sys: harness.sys, window: win, args: [] }, storage);
    expect(q<HTMLIFrameElement>(win, 'iframe')!.getAttribute('src')).toBe(WIKI);
  });
});

/**
 * The REAL store, with no injected stub: this is what catches the bug where the
 * URL was written through `sys.settings.set` (EACCES without the `settings`
 * permission) and silently never persisted in the running OS.
 */
describe('web app persistence across close and reopen (real localStorage)', () => {
  beforeEach(() => { setLocale('en'); localStorage.clear(); });

  function launchReal(def: WebAppDef) {
    const harness = makeHarness();
    const win = harness.wm.open({ appId: `org.faisal.Web.${def.id}`, title: def.title.en });
    const ctx: AppContext = { sys: harness.sys, window: win, args: [] };
    createWebAppModule(def).launch(ctx);
    return { harness, win };
  }

  it('remembers the last URL under faisal.web.<id>.url and restores it on reopen', () => {
    const first = launchReal(wikipedia);
    expect(q<HTMLIFrameElement>(first.win, 'iframe')!.getAttribute('src')).toBe(WIKI);

    submitAddress(first.win, 'https://en.wikipedia.org/wiki/Faisal_OS');
    expect(localStorage.getItem('faisal.web.wikipedia.url')).toBe('https://en.wikipedia.org/wiki/Faisal_OS');

    // Close the window, then open the app again from the launcher.
    first.win.close();
    const second = launchReal(wikipedia);
    expect(q<HTMLIFrameElement>(second.win, 'iframe')!.getAttribute('src'))
      .toBe('https://en.wikipedia.org/wiki/Faisal_OS');
    expect(q<HTMLInputElement>(second.win, '.faisal-web-address')!.value)
      .toBe('https://en.wikipedia.org/wiki/Faisal_OS');
  });

  it('keeps each web app own URL separate', () => {
    launchReal(google);
    expect(localStorage.getItem('faisal.web.google.url')).toBeNull();

    const wiki = launchReal(wikipedia);
    submitAddress(wiki.win, 'https://en.wikipedia.org/wiki/Only_Wikipedia');
    // The other web app's key stays untouched, and no shared key is written.
    expect(localStorage.getItem('faisal.web.wikipedia.url')).toBe('https://en.wikipedia.org/wiki/Only_Wikipedia');
    expect(localStorage.getItem('faisal.web.google.url')).toBeNull();
  });
});
