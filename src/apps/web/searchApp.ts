/**
 * Fai$al OS — the in-OS Search app window (a native window, never a frame).
 *
 * It talks to one search provider's own API (see searchProviders.ts) and renders
 * the result list itself, with `createElement`/`textContent` only. There is no
 * iframe for the results, no proxy, and no injected HTML: a snippet is text, so
 * a snippet can never become markup.
 *
 * The user's options per result are the honest pair the brief asks for:
 *   • «افتح داخل النظام» — opens the page in an embedded web app window. For a
 *     Wikipedia hit that really works, because Wikipedia allows framing. For any
 *     other hit the window's own measured rules apply, and a site that refuses
 *     framing gets its fallback card there — the app never pretends otherwise.
 *   • «فتح في المتصفح» — the ordinary external tab, always available.
 *
 * Everything the user sees is a translation key from ./strings.ts (`web.*`).
 */
import type { AppContext, AppModule } from '../../kernel/types';
import { renderIcon } from '../../shell/icon';
import { t } from '../../kernel/i18n';
import {
  NO_STORAGE,
  WIRED_WEB_APPS,
  applyUrlTransform,
  localStorageOrNull,
  webAppManifest,
  webAppWindowTitle,
  type WebAppDef,
  type WebStorage,
} from './registry';
import {
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_STORAGE,
  SEARCH_QUERY_STORAGE,
  missingFields,
  providerConfig,
  savedSearchProvider,
  storedValue,
  type ProviderConfig,
  type ProviderField,
  type SearchProvider,
} from './searchProviders';
import {
  searchProvider,
  type SearchFailure,
  type SearchOutcome,
  type SearchResult,
} from './search';
import './strings';
import './web.css';
import './search.css';

/**
 * The store this window writes to. `StorageLike` (getItem) plus setItem, narrow
 * so a test can pass a plain object.
 */
interface SearchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function stored(store: SearchStorage, key: string): string {
  return storedValue(store, key);
}

/** Writes must never be able to break the window (private mode throws on setItem). */
function write(store: SearchStorage, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    /* best effort: a preference we cannot remember is not an error to show */
  }
}

function readProvider(store: SearchStorage): SearchProvider {
  return savedSearchProvider(store);
}

function readConfig(store: SearchStorage, provider: SearchProvider): ProviderConfig {
  return providerConfig(provider, store);
}

/** The missing credential keys, with the same meaning as searchProviders.missingFields. */
function missingKeys(config: ProviderConfig): string[] {
  return missingFields(config);
}

/** Every provider, in table order, for the picker. */
function allProviders(): readonly SearchProvider[] {
  return SEARCH_PROVIDERS;
}

/**
 * The provider the user picked in the `<select>`; an unknown value (a stale
 * option, a tampered DOM) resolves to the documented default, never throws.
 */
function readProviderFrom(id: string): SearchProvider {
  return savedSearchProvider({ getItem: (key) => (key === SEARCH_PROVIDER_STORAGE ? id : null) });
}

/** The host of a result link, for the honest "no embedded app for this host" line. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Where a result should open INSIDE the OS, or null when no embedded app can.
 *
 * Two cases, both decided by data already in the registry — never by a guess:
 *  • a Wikipedia article → the `wikipedia` web app, whose def we measured as
 *    embeddable;
 *  • a host we wired as an embeddable product (a map, a player) → that def.
 *
 * A Google result hits neither: google.com is recorded `blocked`, so the app
 * offers the external tab instead of framing a page that refuses to be framed.
 */
export function targetDefFor(
  result: SearchResult,
  apps: readonly WebAppDef[] = WIRED_WEB_APPS,
): WebAppDef | null {
  const host = hostOf(result.embedUrl);
  if (/(^|\.)wikipedia\.org$/.test(host)) {
    return apps.find((d) => d.id === 'wikipedia') ?? null;
  }
  // A provider-specific embeddable product, when one exists for that host.
  const exact = apps.find((d) => d.embedNote === 'allowed' && hostOf(d.url) === host);
  if (exact && exact.kind !== 'search') return exact;
  // Nothing embedded can show this host: the caller offers the external tab.
  return null;
}

/** The external fallback for a provider that cannot be searched in-app. */
export function externalSearchUrl(provider: SearchProvider, query: string): string {
  const q = encodeURIComponent(query);
  if (provider.id === 'google') return `https://www.google.com/search?q=${q}`;
  if (provider.id === 'wikipedia') return `https://www.wikipedia.org/w/index.php?search=${q}`;
  return `https://${provider.host}/?q=${q}`;
}

/* ───────────────────────────── toolbar icons ───────────────────────────── */

const ICON_SEARCH_GLYPH =
  '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke="currentColor" stroke-width="2.1"/><path d="M15.2 15.2l5.3 5.3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const ICON_EXTERNAL =
  '<svg viewBox="0 0 24 24"><path d="M9 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 4h6v6M20 4l-9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_SETTINGS =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3.6v2.2M12 18.2v2.2M4.6 12h2.2M17.2 12h2.2M6.8 6.8l1.6 1.6M15.6 15.6l1.6 1.6M17.2 6.8l-1.6 1.6M8.4 15.6l-1.6 1.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/* ──────────────────────────────── the window ──────────────────────────────── */

/** What this app needs from the environment, so a test can drive it directly. */
export interface SearchRuntime {
  /** Defaults to the browser's real localStorage (see registry.localStorageOrNull). */
  storage: WebStorage;
  /** Overrides the network call entirely; a test never touches the network. */
  runSearch?: (config: ProviderConfig, query: string, ctx: AppContext) => Promise<SearchOutcome>;
}

/** The same, after every default has been applied — the shape the window runs on. */
interface ResolvedSearchRuntime {
  storage: WebStorage;
  runSearch: (config: ProviderConfig, query: string, ctx: AppContext) => Promise<SearchOutcome>;
}

/** The default: the real provider call, with the real `fetch` inside search.ts. */
const realSearch = (config: ProviderConfig, query: string, ctx: AppContext): Promise<SearchOutcome> =>
  searchProvider(config, query, { locale: ctx.sys.locale() });

/** Opens a URL in a real tab — the only sanctioned escape hatch, as in ./index.ts. */
function openExternally(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function iconButton(svg: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'faisal-web-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.append(renderIcon(svg));
  return btn;
}

/**
 * The lazy module for a `kind: 'search'` def. `main.ts` calls
 * `createWebAppModule(def)`, which routes here for this kind, so registration
 * stays the single registry entry it is for every other web app.
 */
export function createSearchAppModule(def: WebAppDef, runtime?: Partial<SearchRuntime>): AppModule {
  return {
    manifest: webAppManifest(def),
    launch: createSearchLauncher(def, runtime),
  };
}

/** The launch function only — used by createWebAppModule to avoid a second manifest. */
export function createSearchLauncher(def: WebAppDef, runtime?: Partial<SearchRuntime>) {
  return (ctx: AppContext): void => {
    // `runSearch` is left undefined here on purpose: launchSearchApp substitutes
    // the real provider call, so a test can inject its own and this stays the
    // only place that decides what "the environment" means.
    launchSearchApp(def, ctx, { storage: runtime?.storage ?? localStorageOrNull() ?? NO_STORAGE });
  };
}

export function launchSearchApp(def: WebAppDef, ctx: AppContext, runtime: SearchRuntime): void {
  const { window: win } = ctx;
  win.content.textContent = '';
  win.setTitle(webAppWindowTitle(def, ctx.sys.locale(), t('web.windowTitle')));

  const locale = ctx.sys.locale();
  /** The provider call, resolved once — `runSearch` is optional in the input type. */
  const runProviderSearch = runtime.runSearch ?? realSearch;
  let provider = readProvider(runtime.storage);
  let config = readConfig(runtime.storage, provider);
  /** Bumped per search so a slow earlier response can never overwrite a newer one. */
  let seq = 0;

  /* ── chrome ── */
  const root = document.createElement('div');
  root.className = 'faisal-web faisal-search';

  const toolbar = document.createElement('div');
  toolbar.className = 'faisal-web-toolbar';

  const form = document.createElement('form');
  form.className = 'faisal-search-form';
  // `form-action 'none'` is in the OS CSP, so the form must never submit: the
  // submit event is always cancelled and only the search below runs.
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'faisal-web-address faisal-search-input';
  input.placeholder = t('search.placeholder');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', t('search.placeholder'));
  input.value = stored(runtime.storage, SEARCH_QUERY_STORAGE);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'faisal-web-go';
  submit.textContent = t('search.go');
  form.append(input, submit);

  const providerSelect = document.createElement('select');
  providerSelect.className = 'faisal-search-provider';
  providerSelect.setAttribute('aria-label', t('search.providerLabel'));
  for (const p of allProviders()) {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.label[locale];
    if (p.id === provider.id) option.selected = true;
    providerSelect.append(option);
  }

  const setupBtn = iconButton(ICON_SETTINGS, t('search.setupOpen'));
  const externalBtn = iconButton(ICON_EXTERNAL, t('web.openExternalHint'));

  toolbar.append(form, providerSelect, setupBtn, externalBtn);
  root.append(toolbar);

  const body = document.createElement('div');
  body.className = 'faisal-search-body';
  root.append(body);

  const status = document.createElement('p');
  status.className = 'faisal-search-status';
  status.setAttribute('role', 'status');
  root.append(status);

  win.content.append(root);

  /* ── rendering ── */

  function setStatus(text: string, kind?: 'error'): void {
    status.textContent = text;
    status.classList.toggle('is-error', kind === 'error');
    status.hidden = !text;
  }

  /** The provider's own name for the list — never "our ranking" or "best match". */
  function sourceLine(cfg: ProviderConfig): HTMLElement {
    const line = document.createElement('p');
    line.className = 'faisal-search-source';
    line.textContent = `${t(cfg.provider.sourceKey)} — ${cfg.provider.host}`;
    return line;
  }

  /**
   * One result row: title, the provider's snippet verbatim, and the two actions.
   * Nothing here is reordered, scored, merged or embellished.
   */
  function renderResult(result: SearchResult): HTMLElement {
    const item = document.createElement('li');
    item.className = 'faisal-search-result';

    const title = document.createElement('h3');
    title.className = 'faisal-search-result-title';
    title.textContent = result.title;

    const link = document.createElement('div');
    link.className = 'faisal-search-result-link';
    link.dir = 'ltr';
    // The URL is provider output: rendered as text, and only ever handed to the
    // frame policy / window.open — never to `href`, so it stays inert here.
    link.textContent = result.pageUrl;

    const actions = document.createElement('div');
    actions.className = 'faisal-search-result-actions';

    const embed = document.createElement('button');
    embed.type = 'button';
    embed.className = 'faisal-web-btn is-plain';
    embed.textContent = t('search.openInside');
    embed.addEventListener('click', () => openInsideOS(result));
    actions.append(embed);

    const external = document.createElement('button');
    external.type = 'button';
    external.className = 'faisal-web-btn is-plain';
    external.textContent = t('web.openResultExternal');
    external.addEventListener('click', () => openExternally(result.pageUrl));
    actions.append(external);

    item.append(title);
    if (result.snippet) {
      const snippet = document.createElement('p');
      snippet.className = 'faisal-search-result-snippet';
      snippet.textContent = result.snippet;
      item.append(snippet);
    }
    item.append(link, actions);
    return item;
  }

  /**
   * "Open inside the OS": asks the app registry to open the embedded Wikipedia
   * web app with this article as its argument. That app owns the frame policy
   * and its measured notes, so a page that refuses framing is explained there —
   * this window never frames anything itself.
   */
  function openInsideOS(result: SearchResult): void {
    const target = targetDefFor(result);
    if (!target) {
      // No embedded app can show this result (it is not a Wikipedia article and
      // the site is not one we measured as embeddable): say so and offer the tab.
      setStatus(t('search.noInsideApp', { host: hostOf(result.pageUrl) }), 'error');
      return;
    }
    const url = applyUrlTransform(target, result.embedUrl) || result.embedUrl;
    // The target app's own URL policy and measured notes still apply; the argument
    // is the page the user picked, exactly as the Browser would hand it over.
    Promise.resolve(ctx.sys.apps.launch(`org.faisal.Web.${target.id}`, [url]))
      .catch(() => setStatus(t('search.openFailed'), 'error'));
  }

  /* ── the search itself ── */

  async function runSearch(query: string): Promise<void> {
    const trimmed = query.trim();
    body.textContent = '';
    if (!trimmed) {
      input.value = '';
      setStatus(t('search.emptyQuery'));
      return;
    }
    write(runtime.storage, SEARCH_QUERY_STORAGE, trimmed);
    input.value = trimmed;

    const missing = missingKeys(config);
    if (missing.length) {
      renderSetup(missing);
      return;
    }

    setStatus(t('search.searching', { provider: config.provider.label[locale] }));
    submit.disabled = true;
    const mine = ++seq;
    let outcome: SearchOutcome;
    try {
      outcome = await runProviderSearch(config, trimmed, ctx);
    } catch {
      outcome = { ok: false, code: 'network', host: config.provider.host };
    } finally {
      submit.disabled = false;
    }
    // A newer search has started: this answer is stale, so drop it silently.
    if (mine !== seq) return;
    render(outcome, trimmed);
  }

  function render(outcome: SearchOutcome, query: string): void {
    body.textContent = '';
    if (!outcome.ok) {
      renderFailure(outcome, query);
      return;
    }
    if (outcome.results.length === 0) {
      // Said plainly: no matches, no suggestions invented to fill the space.
      setStatus(t('search.noResults', { query }));
      return;
    }
    setStatus('');
    const list = document.createElement('ol');
    list.className = 'faisal-search-results';
    for (const result of outcome.results) list.append(renderResult(result));
    body.append(sourceLine(config), list);
  }

  /**
   * Every failure is its own sentence — and a fault is never dressed up as an
   * empty result set. `network` explicitly covers the page CSP refusing the host,
   * which is reported as "could not be reached", with no claim about why.
   */
  function renderFailure(failure: SearchFailure, query: string): void {
    const key = failure.code === 'config' ? 'search.errorConfig'
      : failure.code === 'http' ? 'search.errorHttp'
        : failure.code === 'shape' ? 'search.errorShape'
          : 'search.errorNetwork';
    const host = failure.host ?? '—';
    setStatus(t(key, { host, query }), 'error');
    if (failure.code === 'config') renderSetup(failure.missing ?? missingKeys(config));
  }

  /**
   * The setup screen, mirroring how Faisal AI asks for its key: the fields this
   * provider needs, where to get them, and nothing about the user's other data.
   */
  function renderSetup(missing: string[]): void {
    body.textContent = '';
    const card = document.createElement('div');
    card.className = 'faisal-search-setup';

    const heading = document.createElement('h2');
    heading.className = 'faisal-search-setup-title';
    heading.textContent = t('search.setupTitle', { provider: config.provider.label[locale] });

    const intro = document.createElement('p');
    intro.className = 'faisal-search-setup-body';
    intro.textContent = t(config.provider.setupBodyKey, { host: config.provider.host });

    card.append(heading, intro);

    if (config.provider.fields.length === 0) {
      // A keyless provider has nothing to configure: an empty setup screen would
      // be a lie about what is missing, so say the honest thing instead.
      const note = document.createElement('p');
      note.className = 'faisal-search-setup-body';
      note.textContent = t('search.setupKeyless', { host: config.provider.host });
      card.append(note);
      body.append(card);
      return;
    }

    const formEl = document.createElement('div');
    formEl.className = 'faisal-search-setup-form';
    for (const field of config.provider.fields) {
      formEl.append(setupField(field, missing.includes(field.storage)));
    }

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'faisal-web-go';
    save.textContent = t('search.setupSave');
    save.addEventListener('click', () => {
      for (const field of config.provider.fields) {
        const el = formEl.querySelector<HTMLInputElement>(`[data-storage="${field.storage}"]`);
        if (el) write(runtime.storage, field.storage, el.value.trim());
      }
      config = readConfig(runtime.storage, provider);
      // The typed value is never echoed back into the DOM: the field is cleared
      // once it is stored, so a shoulder-surfer cannot read it off the screen.
      for (const el of formEl.querySelectorAll<HTMLInputElement>('input')) el.value = '';
      renderSetup(missingKeys(config));
    });
    formEl.append(save);
    card.append(formEl);
    body.append(card);
  }

  function setupField(field: ProviderField, missing: boolean): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'faisal-search-field' + (missing ? ' is-missing' : '');
    const label = document.createElement('span');
    label.className = 'faisal-search-field-label';
    label.textContent = t(field.labelKey);
    const hint = document.createElement('span');
    hint.className = 'faisal-search-field-hint';
    hint.textContent = t(field.hintKey, { host: config.provider.host });
    const control = document.createElement('input');
    control.type = 'password';
    control.dir = 'ltr';
    control.autocomplete = 'off';
    control.spellcheck = false;
    control.dataset.storage = field.storage;
    control.placeholder = field.placeholder;
    // The saved value is deliberately NOT put back in the input: it stays in
    // localStorage where the user put it, out of the DOM.
    wrap.append(label, control, hint);
    return wrap;
  }

  /* ── wiring ── */
  form.addEventListener('submit', (ev) => {
    // `form-action 'none'`: never let the browser navigate, only search.
    ev.preventDefault();
    void runSearch(input.value);
  });
  providerSelect.addEventListener('change', () => {
    provider = readProviderFrom(providerSelect.value);
    write(runtime.storage, SEARCH_PROVIDER_STORAGE, provider.id);
    config = readConfig(runtime.storage, provider);
    body.textContent = '';
    if (!input.value.trim()) {
      setStatus(t('search.idle', { provider: provider.label[locale] }));
      return;
    }
    void runSearch(input.value);
  });
  setupBtn.addEventListener('click', () => renderSetup(missingKeys(config)));
  externalBtn.addEventListener('click', () => {
    const q = input.value.trim();
    // The fallback search for a provider that is not configured: hand the query
    // to the real site in a real tab. This app never scrapes or proxies it.
    openExternally(externalSearchUrl(provider, q));
  });
  input.addEventListener('keydown', (ev) => ev.stopPropagation());

  // Start honest: nothing has been searched yet.
  setStatus(t('search.idle', { provider: provider.label[locale] }));
  if (input.value.trim()) void runSearch(input.value);
}
