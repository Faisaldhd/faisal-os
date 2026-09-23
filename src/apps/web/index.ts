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
 *  • A refusal (X-Frame-Options / frame-ancestors) is respected, explained and
 *    offered externally. We never detect-and-bypass it and never proxy content.
 */
import type { AppContext, AppModule } from '../../kernel/types';
import { t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
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
import {
  NO_STORAGE,
  localStorageOrNull,
  saveLastUrl,
  savedUrl,
  webAppManifest,
  webAppWindowTitle,
  type WebAppDef,
  type WebStorage,
} from './registry';
import './strings';
import './web.css';

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
}

/** Opens the requested URL in a real browser tab — the only sanctioned escape hatch. */
function openExternally(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
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
    launchWebApp(def, ctx, storage);
  };
}

/**
 * Lazy-loaded module factory: the registry hands each def here from src/main.ts,
 * so one chunk serves every site in the registry.
 */
export function createWebAppModule(def: WebAppDef, runtime?: Partial<WebRuntime>): AppModule {
  return { manifest: webAppManifest(def), launch: launchWith(def, runtime) };
}

export function launchWebApp(def: WebAppDef, ctx: AppContext, storage: WebStorage): void {
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
    ui.back.disabled = !canGoBack(history);
    ui.forward.disabled = !canGoForward(history);
    ui.openExternal.disabled = !url;
  }

  /* ── the frame ── */
  function renderFrame(): void {
    clearTimer();
    ui.body.textContent = '';
    frame = null;

    const state = decideOutcome(currentPlan());
    if (state.kind === 'refused') {
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
    const next = planNavigation(raw, ctx.sys.locale());
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
    history = goBack(history);
    const url = currentUrl(history);
    if (url) navigate(url);
  });
  ui.forward.addEventListener('click', () => {
    history = goForward(history);
    const url = currentUrl(history);
    if (url) navigate(url);
  });
  ui.reload.addEventListener('click', () => {
    signal = 'pending';
    renderFrame();
  });
  ui.openExternal.addEventListener('click', () => {
    openExternally(plan.displayUrl ?? currentUrl(history) ?? def.url);
  });
  // A form means Enter and the Go button share one code path.
  ui.root.addEventListener('submit', (ev) => {
    ev.preventDefault();
    navigate(ui.address.value);
  });
  ui.address.addEventListener('focus', () => ui.address.select());
  // Without this, arrow keys/backspace in the address field reach the shell and
  // can move window focus instead of editing the text.
  ui.address.addEventListener('keydown', (ev) => ev.stopPropagation());

  win.onClose(() => clearTimer());

  // Start on the remembered/home URL, with no new history entry.
  plan = planNavigation(startUrl, ctx.sys.locale());
  syncChrome();
  renderFrame();
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
