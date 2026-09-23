/**
 * Fai$al OS — shared Web App window content.
 *
 * ONE implementation for every site in src/apps/web/registry.ts: the code is
 * lazy-loaded the first time any web app is launched and reused by all of them.
 * The only thing that differs per site is the `WebAppDef` handed to
 * `createWebAppModule`, so adding a site never touches this file.
 *
 * Security posture (the framed site is fully untrusted):
 *  • The URL/security policy is NOT re-implemented here — every address goes
 *    through the Browser's existing src/apps/browser/url.ts helpers
 *    (resolveAddressInput / isAllowedFrameUrl / isBlockedDomain /
 *    rewriteYouTubeEmbed) via the pure planner in ./outcome.ts.
 *  • Nothing about the OS is ever handed to the frame: no postMessage in either
 *    direction, no contentWindow access, no reading its DOM, no eval / new
 *    Function. All user-visible text is built with createElement/textContent.
 *  • A refusal (X-Frame-Options / frame-ancestors) is respected by default and
 *    explained, with the external tab offered. The ONE thing that can bypass it
 *    is the owner's own OPT-IN local proxy (./local-proxy.ts +
 *    tools/local-proxy.mjs): never enabled by default, never enabled silently,
 *    and never offered at all unless the tool is already running on 127.0.0.1.
 *    The cards live in ./proxy-panel.ts.
 */
import type { AppContext, AppModule } from '../../kernel/types';
import { t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import {
  nativeWeb,
  createWebview,
  isWebUrl,
  openInRealBrowser,
  safeCall,
  type NavigateEvent,
  type WebviewElement,
} from '../../shell/native-web';
import { buildExternalSearchUrl, resolveAddressInput } from '../browser/url';
import {
  createHistory,
  canGoBack,
  canGoForward,
  currentUrl,
  goBack,
  goForward,
  pushUrlUnlessSame,
  replaceUrl,
  type HistoryState,
} from './history';
import { decideOutcome, isLoading, planNavigation, type EmbedAttempt } from './outcome';
import { createSearchLauncher } from './searchApp';
import {
  DEFAULT_PROXY_PORT,
  NO_PROXY_STORAGE,
  buildProxyUrl,
  buildProxyViewUrl,
  probeLocalProxy,
  proxyBaseUrl,
  proxyStorageOrNull,
  readProxyPort,
  readProxyToken,
  requestProxyTicket,
  writeProxyPort,
  writeProxyToken,
  type ProxyProbe,
  type ProxyStorage,
  type ProxyTicketFailure,
} from './local-proxy';
import {
  buildProxyBar,
  buildProxyFallbackAction,
  buildProxyModePicker,
  buildRawLoading,
  buildRawWarning,
  buildReaderError,
  buildReaderLoading,
  buildReaderPanel,
  buildTokenPanel,
  initialProxyState,
  markProxyEnabled,
  proxyIsActive,
  proxyTargetOf,
  targetIsObviouslyPrivate,
  type ProxyMode,
  type ProxyPanelHost,
  type ProxyUiState,
} from './proxy-panel';
import { htmlToText } from './reader';
import {
  NO_STORAGE,
  applyUrlTransform,
  localStorageOrNull,
  saveLastUrl,
  savedUrl,
  webAppKind,
  webAppManifest,
  webAppWindowTitle,
  type WebAppDef,
  type WebStorage,
} from './registry';
import './strings';
import './web.css';

/* PROXY_PANEL: proxy flow lives in ./proxy-panel.ts; imports added additively. */

/* ───────────────────────────── toolbar icons ───────────────────────────── */

const ICON_BACK =
  '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FORWARD =
  '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_RELOAD =
  '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17 4v4h-4M7 20v-4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_EXTERNAL =
  '<svg viewBox="0 0 24 24"><path d="M9 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 4h6v6M20 4l-9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ───────────────────────────── sandbox policy ───────────────────────────── */

/**
 * The LEAST a real site needs, and a deliberate exclusion list:
 *
 *  included — `allow-scripts` (every modern site), `allow-same-origin` (without
 *  it the frame's own cookies/storage break and most sites log you out or fail),
 *  `allow-forms` (search and login boxes), `allow-popups` (target=_blank links,
 *  which open as real browser tabs), `allow-presentation` (media sites).
 *
 *  `allow-same-origin` is safe to combine with `allow-scripts` here ONLY because
 *  isAllowedFrameUrl() guarantees the frame is never same-origin with this OS
 *  page, so there is no same-origin sandbox escape back into the OS document.
 *
 *  left out — `allow-popups-to-escape-sandbox` (the security review flagged it
 *  for the old Browser app: it hands an unsandboxed window to third-party
 *  content; the Browser still carries it, this app deliberately does not),
 *  `allow-top-navigation*` (a framed site must never be able to navigate the OS
 *  itself away), `allow-modals`, `allow-downloads`, `allow-pointer-lock`,
 *  `allow-storage-access-by-user-activation`.
 */
export const IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation';

/** Media sites need these; nothing else is delegated to the frame. */
export const IFRAME_ALLOW = 'fullscreen; encrypted-media; picture-in-picture';

/** How long a frame may stay silent before we offer the external fallback. */
export const FRAME_TIMEOUT_MS = 6000;

/* ────────────────────────────── the app itself ────────────────────────────── */

interface WebUi {
  root: HTMLElement;
  body: HTMLElement;
  address: HTMLInputElement;
  back: HTMLButtonElement;
  forward: HTMLButtonElement;
  reload: HTMLButtonElement;
  openExternal: HTMLButtonElement;
}

/** Injectable bits, so the window can be driven from a test without the whole OS. */
interface WebRuntime {
  def: WebAppDef;
  /** Defaults to the browser's real localStorage (see registry.localStorageOrNull). */
  storage: WebStorage;
  /**
   * The proxy's own store. Defaults to the real localStorage. Injected so a test
   * can prove that a WRONG token writes nothing at all.
   */
  proxyStorage?: ProxyStorage;
  /**
   * The proxy availability probe. Defaults to ./local-proxy.ts `probeLocalProxy`
   * against `proxyBaseUrl`. Injected so a test can decide, WITHOUT any network,
   * whether the third fallback action appears.
   */
  probe?: () => Promise<ProxyProbe>;
  /**
   * Verifies a typed token against the local proxy. Defaults to a real /fetch
   * call on the proxy base.
   */
  verifyToken?: (token: string) => Promise<boolean>;
  /** The fetch reader mode uses. Injected in tests. */
  proxyFetch?: typeof fetch;
}

/** Opens the requested URL in a real browser tab — the only sanctioned escape hatch. */
function openExternally(url: string): void {
  openInRealBrowser(url);
}

function iconButton(svg: string, label: string, extraClass?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'faisal-web-btn' + (extraClass ? ` ${extraClass}` : '');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.append(renderIcon(svg));
  return btn;
}

function launchWith(def: WebAppDef, runtime?: Partial<WebRuntime>) {
  return (ctx: AppContext): void => {
    // localStorage, not sys.settings: this app has no `settings` permission and
    // must not ask for one just to remember its own last URL.
    const storage = runtime?.storage ?? localStorageOrNull() ?? NO_STORAGE;
    launchWebApp(def, ctx, storage, runtime);
  };
}

/**
 * Lazy-loaded module factory: the registry hands each def here from src/main.ts,
 * so one chunk serves every site in the registry — and the one `kind: 'search'`
 * def gets the native search window from ./searchApp.ts instead. Both live in
 * this same chunk, so nothing extra is ever downloaded.
 */
export function createWebAppModule(def: WebAppDef, runtime?: Partial<WebRuntime>): AppModule {
  if (webAppKind(def) === 'search') {
    return { manifest: webAppManifest(def), launch: createSearchLauncher(def, runtime) };
  }
  return { manifest: webAppManifest(def), launch: launchWith(def, runtime) };
}

export function launchWebApp(
  def: WebAppDef,
  ctx: AppContext,
  storage: WebStorage,
  runtime?: Partial<WebRuntime>,
): void {
  const { window: win } = ctx;
  win.content.textContent = '';

  const ui = buildUi();
  win.content.append(ui.root);
  win.setTitle(webAppWindowTitle(def, ctx.sys.locale(), t('web.windowTitle')));

  // Restore the last URL this web app visited, else its home. Only the URL is
  // remembered — never any page content.
  const startUrl = savedUrl(def, storage) ?? def.url;
  let history: HistoryState = createHistory(startUrl);

  /** The plan currently on screen; drives the refusal/fallback copy. */
  let plan = planNavigation(startUrl, ctx.sys.locale());
  let signal: 'pending' | 'loaded' | 'timed-out' = 'pending';
  /**
   * Whether this frame attempt was authorised by the user. The registry's
   * `embedNote: 'blocked'` shows the fallback card immediately (no wasted blank
   * frame), but it is measured data that can go stale, so "Try embedding
   * anyway" hands over to the ordinary loading/timeout flow.
   */
  let attempt: EmbedAttempt = 'registry';
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every navigation so a stale load/timeout callback is ignored. */
  let navSeq = 0;
  /** The one and only iframe in the window; null while a refusal card is shown. */
  let frame: HTMLIFrameElement | null = null;
  /** Desktop build: pages load in a real <webview>, so framing refusals do not apply. */
  const native = nativeWeb();
  let view: WebviewElement | null = null;

  /* ───────────────────────── the opt-in local proxy ─────────────────────────
   * Inert until BOTH hold: (a) the owner's tool answered the probe, and (b) the
   * owner clicked the proxy action and picked a sub-mode in THIS window.
   * `proxy.mode === null` means "not proxying", whatever the stored
   * `faisal.web.proxy.enabled` flag happens to say — so the flag can never
   * switch a window on by itself.
   */
  const proxyStorage: ProxyStorage = runtime?.proxyStorage ?? proxyStorageOrNull() ?? NO_PROXY_STORAGE;
  const proxyPort = readProxyPort(proxyStorage);
  const proxyBase = proxyBaseUrl(proxyPort);
  /** The probe result; null until it answers. */
  let proxyProbe: ProxyProbe | null = null;
  /** The per-window proxy state (mode is what actually turns proxying on). */
  let proxy: ProxyUiState = initialProxyState(proxyStorage);
  /** Bumped by every proxy render so a stale /fetch reply is dropped. */
  let proxySeq = 0;
  /** The target the open token/mode panel is about. */
  let proxyTarget: string | null = null;
  function currentTargetUrl(): string {
    return proxyTargetOf(plan.displayUrl ?? currentUrl(history) ?? null, def.url);
  }

  /**
   * Ask the owner's proxy whether it is running. A failure is simply "not
   * available": the proxy action stays hidden and NOTHING falls back to a direct
   * embed. The probe sends no token and requests no page.
   */
  function refreshProxyProbe(): void {
    const probe = runtime?.probe ?? (() => probeLocalProxy(proxyBase));
    void Promise.resolve()
      .then(probe)
      .catch(() => ({ available: false, version: null, auth: null }) as ProxyProbe)
      .then((result) => {
        proxyProbe = result && typeof result === 'object' ? result : null;
        renderFrame();
      });
  }

  /**
   * Verify a typed token with a /fetch call that is DESIGNED to answer 401 when
   * the token is wrong. Nothing is written before this resolves true — a failed
   * token must leave the store exactly as it was.
   */
  async function verifyProxyToken(token: string): Promise<boolean> {
    if (runtime?.verifyToken) return runtime.verifyToken(token);
    const fetcher = runtime?.proxyFetch ?? globalThis.fetch;
    if (typeof fetcher !== 'function') return false;
    // /health needs no token, so a token can only be proven against /fetch.
    let probeUrl: string;
    try {
      probeUrl = buildProxyUrl(proxyBase, 'https://example.com/', 'reader');
    } catch {
      return false;
    }
    try {
      const res = await fetcher(probeUrl, {
        method: 'GET',
        headers: { 'x-faisal-proxy-token': token },
        cache: 'no-store',
      });
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }

  function clearTimer(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  function currentPlan() {
    return { refusal: plan.refusal, embedNote: def.embedNote, signal, attempt };
  }

  /* ── chrome sync: address field + back/forward state ── */
  function syncChrome(): void {
    const url = plan.displayUrl ?? currentUrl(history) ?? '';
    if (document.activeElement !== ui.address) ui.address.value = url;
    ui.address.title = url;
    const v = view;
    ui.back.disabled = !canGoBack(history) && !(v && safeCall(() => v.canGoBack(), false));
    ui.forward.disabled = !canGoForward(history) && !(v && safeCall(() => v.canGoForward(), false));
    ui.openExternal.disabled = !url;
  }

  /* ── proxy flow ── */

  const proxyHost: ProxyPanelHost = {
    // The proxy action: a token is asked for only when the running tool wants one.
    openProxy: () => {
      proxyTarget = currentTargetUrl();
      proxy.error = null;
      const stored = readProxyToken(proxyStorage);
      if (proxyProbe?.auth === 'none' || stored) {
        proxy.panel = 'modes';
      } else {
        proxy.panel = 'token';
      }
      renderFrame();
    },
    chooseMode: () => {
      proxyTarget = currentTargetUrl();
      proxy.panel = 'modes';
      proxy.error = null;
      renderFrame();
    },
    setMode: (mode: ProxyMode) => {
      // THE ONE PLACE the proxy is switched on: an explicit click in this window.
      proxy.mode = mode;
      proxy.panel = 'none';
      proxy.error = null;
      proxy.enabled = true;
      markProxyEnabled(proxyStorage, true);
      writeProxyPort(proxyStorage, proxyPort);
      signal = 'loaded';
      renderFrame();
    },
    stop: () => {
      proxy = { enabled: false, mode: null, panel: 'none', error: null };
      proxyProbe = null;
      proxySeq += 1;
      proxyTarget = null;
      markProxyEnabled(proxyStorage, false);
      signal = 'loaded';
      renderFrame();
      refreshProxyProbe();
    },
    cancel: () => {
      proxy.panel = 'none';
      proxy.error = null;
      proxyTarget = null;
      renderFrame();
    },
    openExternal: (url: string) => openExternally(url),
    setError: (message: string | null) => { proxy.error = message; },
  };

  /** The proxy action: a token is asked for only when the tool requires one. */
  function openProxy(): void {
    proxyTarget = currentTargetUrl();
    proxy.error = null;
    const stored = readProxyToken(proxyStorage);
    if (proxyProbe?.auth === 'none' || stored) {
      proxy.panel = 'modes';
    } else {
      proxy.panel = 'token';
    }
    renderFrame();
  }

  function submitProxyToken(raw: string): void {
    const token = raw.trim();
    proxyTarget = proxyTarget ?? currentTargetUrl();
    if (!token) {
      proxy.error = t('web.proxyTokenRejected');
      renderFrame();
      return;
    }
    // Capture the sequence BEFORE rendering: renderFrame() bumps it, and a
    // stale-check against the post-render value would drop every reply.
    const seq = proxySeq;
    renderFrame();
    void verifyProxyToken(token)
      .then((ok) => {
        if (seq !== proxySeq) return;
        // WRONG (or unusable) TOKEN: store NOTHING and say so plainly.
        if (!ok || !writeProxyToken(proxyStorage, token)) {
          proxy.error = t('web.proxyTokenRejected');
          renderFrame();
          return;
        }
        // Only a VERIFIED token is ever written, and only to our own store.
        proxy.error = null;
        proxy.panel = 'modes';
        renderFrame();
      })
      .catch(() => {
        if (seq !== proxySeq) return;
        proxy.error = t('web.proxyTokenRejected');
        renderFrame();
      });
  }

  /** Reader mode: the proxy returns TEXT, WE extract it, WE render the blocks. */
  function renderProxyReader(seq: number): void {
    const target = currentTargetUrl();
    ui.body.append(buildProxyBar('reader', target, proxyHost));

    if (targetIsObviouslyPrivate(target)) {
      // Obvious mistake (an intranet address, a non-http scheme): refuse locally,
      // send NOTHING. The proxy would refuse it too, this just saves the round trip.
      ui.body.append(buildReaderError(t('web.proxyBlockedTarget'), target, () => renderFrame(), proxyHost));
      syncChrome();
      return;
    }

    ui.body.append(buildReaderLoading());

    let url: string;
    try {
      url = buildProxyUrl(proxyBase, target, 'reader');
    } catch {
      ui.body.textContent = '';
      ui.body.append(buildProxyBar('reader', target, proxyHost));
      ui.body.append(buildReaderError(t('web.proxyBlockedTarget'), target, () => renderFrame(), proxyHost));
      syncChrome();
      return;
    }

    const fetcher = runtime?.proxyFetch ?? globalThis.fetch;
    const token = readProxyToken(proxyStorage);
    const headers: Record<string, string> = {};
    // The token goes to the proxy base and NOWHERE else — never into `url`, so
    // it cannot end up in an iframe src, a history entry, a title or a log.
    if (token) headers['x-faisal-proxy-token'] = token;

    void Promise.resolve()
      .then(() => fetcher(url, { method: 'GET', headers, cache: 'no-store' }))
      .then(async (res) => {
        if (seq !== proxySeq) return null;
        if (!res.ok) throw new Error(`proxy status ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (seq !== proxySeq || typeof text !== 'string') return;
        const extracted = htmlToText(text);
        ui.body.textContent = '';
        ui.body.append(buildProxyBar('reader', target, proxyHost));
        // title/blocks are untrusted page text; proxy-panel writes them with
        // textContent only, so there is no markup path from the site to the OS.
        ui.body.append(buildReaderPanel(extracted.title, extracted.blocks, target, proxyHost));
        syncChrome();
      })
      .catch(() => {
        if (seq !== proxySeq) return;
        ui.body.textContent = '';
        ui.body.append(buildProxyBar('reader', target, proxyHost));
        ui.body.append(buildReaderError(t('web.proxyReaderError'), target, () => renderFrame(), proxyHost));
        syncChrome();
      });
  }

  /** The bilingual sentence for one failed ticket request. */
  function rawTicketError(reason: ProxyTicketFailure): string {
    if (reason === 'unauthorized') return t('web.proxyRawTicketUnauthorized');
    if (reason === 'unreachable') return t('web.proxyRawTicketUnreachable', { port: proxyPort });
    if (reason === 'refused') return t('web.proxyRawTicketRefused');
    return t('web.proxyRawTicketMalformed');
  }

  /** The permanent chrome of raw mode: badge, honest warning, then `extra`. */
  function paintRawShell(target: string, extra: HTMLElement | null): void {
    ui.body.textContent = '';
    ui.body.append(buildProxyBar('raw', target, proxyHost));
    ui.body.append(buildRawWarning());
    if (extra) ui.body.append(extra);
    syncChrome();
  }

  /**
   * Raw embed: best effort, and the ONE path that cannot authenticate with a
   * header. An <iframe> sends no `x-faisal-proxy-token` at all, so the frame is
   * never given the token: we first ask the proxy for a SINGLE-USE ticket with
   * an ordinary `fetch` (token in the header, exactly like reader mode), and only
   * once that ticket exists do we create the frame, pointed at
   * `/view?ticket=<hex>`. The proxy deletes the ticket BEFORE its upstream fetch,
   * so it is already dead by the time the framed page's own scripts run — that,
   * and nothing else, is what makes this src safe to leak. The sequence guard is
   * checked after the round trip, so a slow ticket can never paint into a newer
   * navigation. There is no fallback path that puts a token in a URL, and no
   * frame is ever created for a request that failed: a failure renders a card.
   */
  function renderProxyRaw(seq: number): void {
    const target = currentTargetUrl();

    if (targetIsObviouslyPrivate(target)) {
      // Obvious mistake (an intranet address, a non-http scheme): refuse locally
      // and send NOTHING, exactly like reader mode. The proxy would refuse it
      // too; this only saves a round trip and shows the honest reason.
      paintRawShell(target, buildReaderError(t('web.proxyBlockedTarget'), target, () => renderFrame(), proxyHost));
      return;
    }

    // The badge and the honest warning are on screen from the first moment,
    // before any request: the loading state below replaces nothing.
    paintRawShell(target, null);
    ui.body.append(buildRawLoading());

    const token = readProxyToken(proxyStorage);
    const fetcher = runtime?.proxyFetch ?? globalThis.fetch;
    const failed = (reason: ProxyTicketFailure): void => {
      if (seq !== proxySeq) return;
      paintRawShell(target, buildReaderError(rawTicketError(reason), target, () => renderFrame(), proxyHost));
    };

    // requestProxyTicket() never rejects; the catch below is belt-and-braces so
    // that no outcome whatsoever can leave the loading state stuck on screen.
    void requestProxyTicket(proxyBase, target, 'raw', token, fetcher)
      .then((result) => {
        if (seq !== proxySeq) return;
        if (!result.ok) {
          failed(result.reason);
          return;
        }
        let url: string;
        try {
          url = buildProxyViewUrl(proxyBase, result.ticket);
        } catch {
          failed('malformed');
          return;
        }

        paintRawShell(target, null);
        const stage = document.createElement('div');
        stage.className = 'faisal-web-stage';
        const iframe = document.createElement('iframe');
        iframe.className = 'faisal-web-frame faisal-web-proxy-frame';
        iframe.setAttribute('sandbox', IFRAME_SANDBOX);
        iframe.setAttribute('allow', IFRAME_ALLOW);
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.loading = 'eager';
        // The src carries ONLY the single-use ticket: no token, no target URL and
        // no mode. One leaked URL buys exactly one already-spent fetch.
        iframe.src = url;
        stage.append(iframe);
        frame = iframe;
        ui.body.append(stage);
        syncChrome();
      })
      .catch(() => failed('malformed'));
  }

  /* ── the frame ── */
  function renderFrame(): void {
    clearTimer();
    ui.body.textContent = '';
    frame = null;
    view = null;
    if (native) {
      renderNative();
      return;
    }

    // A proxy card is the current view: it wins over the fallback card.
    if (proxyIsActive(proxy)) {
      proxySeq += 1;
      if (proxy.mode === 'raw') renderProxyRaw(proxySeq);
      else renderProxyReader(proxySeq);
      syncChrome();
      return;
    }
    if (proxy.panel === 'token') {
      ui.body.append(buildTokenPanel(
        proxyProbe?.auth ?? null,
        proxy.error,
        (token) => submitProxyToken(token),
        proxyHost,
      ));
      syncChrome();
      return;
    }
    if (proxy.panel === 'modes') {
      ui.body.append(buildProxyModePicker(proxy.error, proxyHost));
      syncChrome();
      return;
    }

    const state = decideOutcome(currentPlan());
    if (state.kind === 'refused') {
      // An empty embedUrl with no refusal is the def's own transform declining the
      // input (`transformUrl` returned ''): a YouTube channel where a video was
      // expected, say. It gets its own honest card with the same external offer.
      if (!plan.refusal && !plan.embedUrl) {
        ui.body.append(buildUnusableInputCard());
        syncChrome();
        return;
      }
      ui.body.append(buildRefusal(plan.refusal ?? 'empty'));
      syncChrome();
      return;
    }
    if (state.kind === 'blocked-fallback') {
      // `signal === 'timed-out'` means we really tried and the frame stayed
      // silent; otherwise this is the up-front warning from the registry.
      ui.body.append(buildFallback(signal === 'timed-out' ? 'timedout' : 'blocked'));
      syncChrome();
      return;
    }

    if (plan.rewrittenFrom && plan.embedUrl) ui.body.append(buildNotice(t('web.rewrittenNotice')));
    if (plan.searchFor) ui.body.append(buildNotice(t('web.searchNotice', { query: plan.searchFor })));
    // Only when the frame was actually attempted against the measured note.
    if (def.embedNote === 'blocked' && attempt === 'user') {
      ui.body.append(buildNotice(t('web.embedWarningBody')));
    }

    const stage = document.createElement('div');
    stage.className = 'faisal-web-stage';

    const iframe = document.createElement('iframe');
    iframe.className = 'faisal-web-frame';
    iframe.setAttribute('sandbox', IFRAME_SANDBOX);
    iframe.setAttribute('allow', IFRAME_ALLOW);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.loading = 'eager';
    // `src` is set last, after every restriction above is in place.
    iframe.src = plan.embedUrl ?? startUrl;
    stage.append(iframe);
    frame = iframe;

    if (isLoading(currentPlan())) {
      const spinner = document.createElement('div');
      spinner.className = 'faisal-web-loading';
      spinner.setAttribute('role', 'status');
      const ring = document.createElement('span');
      ring.className = 'faisal-web-spinner';
      const label = document.createElement('span');
      label.textContent = t('web.loadingSite', { site: def.title[ctx.sys.locale()] });
      spinner.append(ring, label);
      stage.append(spinner);
    }

    ui.body.append(stage);
    watchFrame(iframe, ++navSeq);
    syncChrome();
  }

  /**
   * Desktop build: the site itself in a <webview>. Its own navigation (links,
   * redirects) updates the address field and the remembered URL; back/forward
   * ask the webview first.
   */
  function renderNative(): void {
    const url = plan.displayUrl ?? currentUrl(history) ?? def.url;
    const stage = document.createElement('div');
    stage.className = 'faisal-web-stage';
    const v = createWebview(url, 'faisal-web-frame faisal-web-webview');
    const follow = (e: Event) => {
      const ev = e as NavigateEvent;
      if (ev.isMainFrame === false || !isWebUrl(ev.url)) return;
      plan = { ...plan, displayUrl: ev.url };
      history = replaceUrl(history, ev.url);
      saveLastUrl(def, ev.url, storage);
      syncChrome();
    };
    v.addEventListener('did-navigate', follow);
    v.addEventListener('did-navigate-in-page', follow);
    v.addEventListener('dom-ready', () => syncChrome());
    stage.append(v);
    ui.body.append(stage);
    view = v;
    syncChrome();
  }

  /** Desktop build: any http(s) address loads as-is; words search Google. */
  function planNative(raw: string) {
    const resolved = resolveAddressInput(raw);
    const url = resolved.kind === 'url'
      ? resolved.url
      : resolved.query.trim() ? buildExternalSearchUrl(resolved.query.trim(), 'google') : null;
    return url && isWebUrl(url)
      ? { embedUrl: url, displayUrl: url, rewrittenFrom: null, searchFor: null, refusal: null }
      : planNavigation(raw, ctx.sys.locale());
  }

  /**
   * A cross-origin frame gives us exactly one observable signal: `load`. It is
   * NOT proof the site embedded — a frame refused by X-Frame-Options also fires
   * `load` (the browser paints its own error page) — so it only hides the
   * spinner, and the registry's `embedNote` plus the timeout below carry the
   * real decision. We never look inside the frame to find out more.
   */
  function watchFrame(iframe: HTMLIFrameElement, seq: number): void {
    iframe.addEventListener('load', () => {
      if (seq !== navSeq) return;
      clearTimer();
      signal = 'loaded';
      const spinner = ui.body.querySelector('.faisal-web-loading');
      spinner?.remove();
      // The frame may have redirected (e.g. wikipedia.org → en.wikipedia.org);
      // the iframe's own history is unreadable cross-origin, so remember what
      // we asked for and keep our own stack authoritative.
    });
    iframe.addEventListener('error', () => {
      if (seq !== navSeq) return;
      clearTimer();
      signal = 'timed-out';
      renderFrame();
    });
    timer = setTimeout(() => {
      if (seq !== navSeq) return;
      signal = 'timed-out';
      renderFrame();
    }, FRAME_TIMEOUT_MS);
  }

  /* ── fallback panels (respectful, no bypass) ── */
  function buildFallback(kind: 'blocked' | 'timedout'): HTMLElement {
    const card = document.createElement('div');
    card.className = 'faisal-web-fallback';

    const title = document.createElement('div');
    title.className = 'faisal-web-fallback-title';
    title.textContent = t(kind === 'blocked' ? 'web.blockedTitle' : 'web.timedOutTitle');
    const body = document.createElement('div');
    body.className = 'faisal-web-fallback-body';
    body.textContent = t(kind === 'blocked' ? 'web.blockedBody' : 'web.timedOutBody');
    const urlLine = document.createElement('div');
    urlLine.className = 'faisal-web-fallback-url';
    urlLine.dir = 'ltr';
    urlLine.textContent = plan.displayUrl ?? '';

    const actions = document.createElement('div');
    actions.className = 'faisal-web-fallback-actions';
    actions.append(buildOpenButton(t('web.openExternal')));
    if (kind === 'blocked') {
      // The registry's note is measured data, not a permanent hard block: let
      // the user spend the attempt if they want to. Nothing is bypassed — the
      // frame is created exactly as it would be for any other site, and if the
      // site refuses we simply show this card again.
      actions.append(buildTryAnywayButton());
    } else {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'faisal-web-btn is-plain';
      retry.textContent = t('web.retry');
      retry.addEventListener('click', () => { signal = 'pending'; renderFrame(); });
      actions.append(retry);
    }
    // THIRD ACTION, and only while the owner's own proxy answers the probe. When
    // the tool is not running this is simply absent: no button, no attempt, and
    // no silent fallback to a direct embed.
    if (proxyProbe?.available === true) {
      actions.append(buildProxyFallbackAction(proxyHost));
    }

    card.append(title, body, urlLine, actions);
    return card;
  }

  function buildTryAnywayButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'faisal-web-btn is-plain faisal-web-try';
    btn.textContent = t('web.tryAnyway');
    btn.addEventListener('click', () => {
      attempt = 'user';
      signal = 'pending';
      renderFrame();
    });
    return btn;
  }

  function buildOpenButton(label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'faisal-web-open';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      const url = plan.displayUrl ?? currentUrl(history) ?? def.url;
      openExternally(url);
    });
    return btn;
  }

  function buildRefusal(code: string): HTMLElement {
    const card = document.createElement('div');
    card.className = 'faisal-web-fallback is-refusal';
    const title = document.createElement('div');
    title.className = 'faisal-web-fallback-title';
    title.textContent = t('web.blockedTitle');
    const body = document.createElement('div');
    body.className = 'faisal-web-fallback-body';
    body.textContent = t(`web.refused.${code}`);
    const actions = document.createElement('div');
    actions.className = 'faisal-web-fallback-actions';
    const home = document.createElement('button');
    home.type = 'button';
    home.className = 'faisal-web-btn is-plain';
    home.textContent = def.title[ctx.sys.locale()];
    home.addEventListener('click', () => navigate(def.url));
    actions.append(home);
    card.append(title, body, actions);
    return card;
  }

  /**
   * Shown when the def's own `transformUrl` declined the input — it is not a
   * refusal by the site, it is "this app has nothing to open here". The text
   * names the app, never the site, and stays true whatever the app is.
   */
  function buildUnusableInputCard(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'faisal-web-fallback';
    const title = document.createElement('div');
    title.className = 'faisal-web-fallback-title';
    title.textContent = t('web.unusableInputTitle');
    const body = document.createElement('div');
    body.className = 'faisal-web-fallback-body';
    body.textContent = t('web.unusableInputBody', { site: def.title[ctx.sys.locale()] });
    const urlLine = document.createElement('div');
    urlLine.className = 'faisal-web-fallback-url';
    urlLine.dir = 'ltr';
    urlLine.textContent = plan.displayUrl ?? '';
    const actions = document.createElement('div');
    actions.className = 'faisal-web-fallback-actions';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'faisal-web-btn is-plain';
    back.textContent = t('web.backToHome');
    back.addEventListener('click', () => navigate(def.url));
    actions.append(back, buildOpenButton(t('web.openExternal')));
    card.append(title, body, urlLine, actions);
    return card;
  }

  function buildNotice(text: string, heading?: string): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'faisal-web-notice';
    if (heading) {
      const strong = document.createElement('b');
      strong.textContent = `${heading} `;
      bar.append(strong);
    }
    bar.append(document.createTextNode(text));
    return bar;
  }

  /* ── navigation ── */
  function navigate(raw: string): void {
    // A fresh address leaves proxy mode: the escape hatch is per attempt and per
    // page, and must be re-chosen. Nothing about it survives a navigation.
    proxy = { enabled: proxy.enabled, mode: null, panel: 'none', error: null };
    proxySeq += 1;
    proxyTarget = null;

    // The def's own input rule (`transformUrl`), applied before the shared URL
    // policy. This is what lets a "player" app accept a bare video id: the def
    // normalises it, the policy below then treats the result like any address.
    // The shared window stays site-agnostic — it only knows a def may decline
    // input by returning ''.
    const transformed = applyUrlTransform(def, raw.trim());
    if (!transformed.trim()) {
      // The def cannot use this input (e.g. a YouTube channel where a video id was
      // expected). Say so honestly and offer the tab; never frame a page that
      // never agreed to be framed, and never invent a workaround.
      plan = { embedUrl: null, displayUrl: raw.trim(), rewrittenFrom: null, searchFor: null, refusal: null };
      signal = 'loaded';
      attempt = 'registry';
      renderFrame();
      return;
    }

    // Both plans receive the TRANSFORMED address: on the desktop build the
    // native path loads any http(s) address as-is, and a bare video id must
    // still become its embed URL before it gets there.
    const next = native ? planNative(transformed) : planNavigation(transformed, ctx.sys.locale());
    plan = next;
    signal = next.refusal ? 'loaded' : 'pending';
    // A fresh address means a fresh decision: the escape hatch is per attempt.
    attempt = 'registry';
    if (next.displayUrl && !next.refusal) {
      history = pushUrlUnlessSame(history, next.displayUrl);
      saveLastUrl(def, next.displayUrl, storage);
    } else if (next.displayUrl) {
      history = replaceUrl(history, next.displayUrl);
    }
    renderFrame();
  }

  /* ── wiring ── */
  ui.back.addEventListener('click', () => {
    const v = view;
    if (v && safeCall(() => v.canGoBack(), false)) { v.goBack(); return; }
    history = goBack(history);
    const url = currentUrl(history);
    if (url) navigate(url);
  });
  ui.forward.addEventListener('click', () => {
    const v = view;
    if (v && safeCall(() => v.canGoForward(), false)) { v.goForward(); return; }
    history = goForward(history);
    const url = currentUrl(history);
    if (url) navigate(url);
  });
  ui.reload.addEventListener('click', () => {
    const v = view;
    if (v) { safeCall(() => v.reload(), undefined); return; }
    signal = 'pending';
    renderFrame();
  });
  ui.openExternal.addEventListener('click', () => {
    openExternally(plan.displayUrl ?? currentUrl(history) ?? def.url);
  });
  // A form means Enter and the Go button share one code path — but ONLY for the
  // address form. Other forms in the window (the proxy token form) own their own
  // submit events; handling them here would navigate away and destroy their card.
  ui.root.addEventListener('submit', (ev) => {
    if (ev.target !== ui.address.form) return;
    ev.preventDefault();
    navigate(ui.address.value);
  });
  ui.address.addEventListener('focus', () => ui.address.select());
  // Without this, arrow keys/backspace in the address field reach the shell and
  // can move window focus instead of editing the text.
  ui.address.addEventListener('keydown', (ev) => ev.stopPropagation());

  win.onClose(() => clearTimer());

  // Start on the remembered/home URL, with no new history entry.
  plan = native ? planNative(startUrl) : planNavigation(startUrl, ctx.sys.locale());
  syncChrome();
  renderFrame();
  // Ask whether the owner's proxy is running. Purely additive: until it answers,
  // nothing in the window mentions the proxy at all.
  refreshProxyProbe();
}

/** Toolbar + content shell. Deliberately site-agnostic: nothing from `def` leaks into the DOM. */
function buildUi(): WebUi {
  const root = document.createElement('div');
  root.className = 'faisal-web';

  const toolbar = document.createElement('div');
  toolbar.className = 'faisal-web-toolbar';

  const back = iconButton(ICON_BACK, t('web.back'), 'faisal-web-nav');
  const forward = iconButton(ICON_FORWARD, t('web.forward'), 'faisal-web-nav');
  const reload = iconButton(ICON_RELOAD, t('web.reload'));
  const openExternal = iconButton(ICON_EXTERNAL, t('web.openExternalHint'), 'faisal-web-external');
  back.disabled = true;
  forward.disabled = true;

  const form = document.createElement('form');
  form.className = 'faisal-web-addressform';
  const address = document.createElement('input');
  address.type = 'text';
  address.dir = 'ltr';
  address.className = 'faisal-web-address';
  address.placeholder = t('web.addressPlaceholder');
  address.autocomplete = 'off';
  address.spellcheck = false;
  address.setAttribute('aria-label', t('web.addressPlaceholder'));
  const go = document.createElement('button');
  go.type = 'submit';
  go.className = 'faisal-web-go';
  go.textContent = t('web.go');
  form.append(address, go);

  toolbar.append(back, forward, reload, form, openExternal);

  const body = document.createElement('div');
  body.className = 'faisal-web-body';

  root.append(toolbar, body);
  return { root, body, address, back, forward, reload, openExternal };
}
