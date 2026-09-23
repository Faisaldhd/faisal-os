/**
 * Fai$al OS — the search providers the in-OS Search app can talk to.
 *
 * Same shape as the AI app's `src/apps/ai/providers.ts`: everything that differs
 * between providers lives in this table — the API endpoint, the exact `host` the
 * request goes to, what credentials it needs, and its own localStorage keys. The
 * client (search.ts) and the UI (searchApp.ts) only read this table; neither
 * hardcodes a host or a storage key.
 *
 * HONESTY CONTRACT
 *  • A provider is NEVER described as searching the web on someone's servers: each
 *    one returns its own real result list, which the app renders verbatim (title,
 *    snippet, link). There is no ranking, no re-ordering and no invented snippet.
 *  • `host` is the one host an apiUrl for this provider may use. `search()` calls
 *    `assertProviderHost()` before every request, so a bad base URL can never send
 *    a user's query (or their key) somewhere else.
 *  • Nothing in this file is a proxy: the request goes straight from this page to
 *    the provider's own API. That is also why the page's CSP `connect-src` has to
 *    name each host — see docs/SECURITY_REVIEW.md and the note in search.ts.
 */
import type { Locale } from '../../kernel/types';

/** Provider name in both languages; Arabic is the default locale. */
export interface ProviderLabel { ar: string; en: string }

/** One credential the user has to supply before this provider can work. */
export interface ProviderField {
  /** localStorage key: always `faisal.web.search.…`. */
  storage: string;
  /** i18n key of the field's label. */
  labelKey: string;
  /** i18n key of the one-line hint under the field. */
  hintKey: string;
  /** Format hint for the input. Not translated: it is a literal prefix. */
  placeholder: string;
}

export interface SearchProvider {
  /** Stable id, also the value stored in `faisal.web.search.provider`. */
  id: string;
  label: ProviderLabel;
  /**
   * The ONLY host this provider's request may go to. Named in both languages'
   * setup copy, and enforced by `assertProviderHost()` at request time.
   */
  host: string;
  /**
   * Builds the request URL. Returned to `fetch` verbatim — except for the Google
   * key, which `redactUrl()` strips before any error message or log sees it.
   * `locale` picks the Wikipedia language subdomain, exactly like the browser's
   * `buildWikipediaSearchUrl()` does.
   */
  apiUrl(query: string, config: ProviderConfig, locale: Locale): string;
  /** Credentials the user must supply; empty for a keyless provider. */
  fields: readonly ProviderField[];
  /** i18n key of the paragraph shown on this provider's setup screen. */
  setupBodyKey: string;
  /** i18n key naming where the results come from, shown under the search box. */
  sourceKey: string;
  /**
   * True when the provider's `apiUrl` puts its credentials in the URL (Google
   * does, by design). The app then treats that URL as a secret: it is never
   * rendered, never put in a `title`, and only ever shown through `redactUrl()`.
   */
  credentialsInUrl?: boolean;
}

/** A provider plus whatever the user has saved for it. */
export interface ProviderConfig {
  provider: SearchProvider;
  /** Field storage key → saved value ('' when missing). */
  values: Readonly<Record<string, string>>;
}

/* ─────────────────────────────── storage keys ─────────────────────────────── */

/**
 * Every localStorage key this app writes. Collected here so the OS's Settings →
 * Privacy inventory can list exactly what the app keeps:
 *
 *   faisal.web.search.provider              which provider the user chose
 *   faisal.web.search.query                 last query typed (plain text)
 *   faisal.web.search.google.apiKey         Google Programmable Search API key
 *   faisal.web.search.google.cx             Google search-engine id (cx)
 *
 * The `faisal.web.<id>.url` keys written by the framed web apps (registry.ts) are
 * separate and hold a URL, never a page's content.
 *
 * A credential is only ever read back into the request URL for its own provider
 * and is never written to a link, a title, a notice or the console.
 */
export const GOOGLE_KEY_STORAGE = 'faisal.web.search.google.apiKey';
export const GOOGLE_CX_STORAGE = 'faisal.web.search.google.cx';
export const SEARCH_PROVIDER_STORAGE = 'faisal.web.search.provider';
export const SEARCH_QUERY_STORAGE = 'faisal.web.search.query';

/** Every key above, for the Settings → Privacy inventory and for tests. */
export const SEARCH_STORAGE_KEYS: readonly string[] = [
  SEARCH_PROVIDER_STORAGE,
  SEARCH_QUERY_STORAGE,
  GOOGLE_KEY_STORAGE,
  GOOGLE_CX_STORAGE,
];

/** How many results one page asks for. One page, no pagination: no fake depth. */
export const SEARCH_LIMIT = 10;

/* ─────────────────────────────── the providers ─────────────────────────────── */

/**
 * Wikipedia — Wikimedia's public REST API. No key, no account, and it answers
 * `Access-Control-Allow-Origin: *`, so it is the one provider that works the
 * moment the app is opened. Measured 2026-09-23:
 *   GET https://api.wikimedia.org/core/v1/wikipedia/en/search/page?q=…&limit=…
 *   200, no X-Frame-Options, no frame-ancestors, ACAO=*
 * (The `api.wikimedia.org` host is not the same as `en.wikipedia.org`: the
 * article host sends X-Frame-Options: DENY on /w/api.php, so it is never fetched.)
 */
const wikipedia: SearchProvider = {
  id: 'wikipedia',
  label: { ar: 'ويكيبيديا', en: 'Wikipedia' },
  host: 'api.wikimedia.org',
  apiUrl: (query, _config, locale) => {
    const sub = locale === 'ar' ? 'ar' : 'en';
    return `https://api.wikimedia.org/core/v1/wikipedia/${sub}/search/page` +
      `?q=${encodeURIComponent(query)}&limit=${String(SEARCH_LIMIT)}`;
  },
  fields: [],
  setupBodyKey: 'search.setupWikipedia',
  sourceKey: 'search.sourceWikipedia',
};

/**
 * Google — the official Programmable Search Engine JSON API
 * (https://developers.google.com/custom-search/v1/overview). It needs the user's
 * own API key AND their search-engine id (`cx`); both are typed in the app and
 * kept only in localStorage, and neither is ever rendered, logged or put in a
 * link. This is Google's supported way to run a Google search from an
 * application — it is NOT the google.com results page, which refuses framing and
 * which this app never tries to embed or proxy.
 */
const google: SearchProvider = {
  id: 'google',
  label: { ar: 'جوجل (واجهة برمجية)', en: 'Google (Programmable Search)' },
  host: 'www.googleapis.com',
  apiUrl: (query, config) => {
    const key = config.values[GOOGLE_KEY_STORAGE] ?? '';
    const cx = config.values[GOOGLE_CX_STORAGE] ?? '';
    const qs = new URLSearchParams({
      key,
      cx,
      q: query,
      num: String(SEARCH_LIMIT),
      // Only the three fields the UI actually renders, so no extra data is fetched.
      fields: 'items(title,snippet,link)',
    });
    return `https://www.googleapis.com/customsearch/v1?${qs.toString()}`;
  },
  fields: [
    {
      storage: GOOGLE_KEY_STORAGE,
      labelKey: 'search.googleApiKey',
      hintKey: 'search.googleApiKeyHint',
      placeholder: 'AIza…',
    },
    {
      storage: GOOGLE_CX_STORAGE,
      labelKey: 'search.googleCx',
      hintKey: 'search.googleCxHint',
      placeholder: '0123456789:abcdef…',
    },
  ],
  setupBodyKey: 'search.setupGoogle',
  sourceKey: 'search.sourceGoogle',
  credentialsInUrl: true,
};

/** Every provider the app offers, default first. */
export const SEARCH_PROVIDERS: readonly SearchProvider[] = [wikipedia, google];
export const DEFAULT_SEARCH_PROVIDER = 'wikipedia';

/** The part of localStorage this module needs; narrow so tests can fake it. */
export interface StorageLike { getItem(key: string): string | null }

/** Reads one stored value; '' when nothing is stored or the browser blocks storage. */
export function storedValue(store: StorageLike | null | undefined, key: string): string {
  try {
    return store?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/** Pure: an unknown, missing or garbled id resolves to the default provider, never throws. */
export function searchProviderById(id: string | null | undefined): SearchProvider {
  return SEARCH_PROVIDERS.find((p) => p.id === id)
    ?? SEARCH_PROVIDERS.find((p) => p.id === DEFAULT_SEARCH_PROVIDER)!;
}

/** The provider the user last chose; an unknown or missing value falls back to the default. */
export function savedSearchProvider(store: StorageLike | null | undefined): SearchProvider {
  return searchProviderById(storedValue(store, SEARCH_PROVIDER_STORAGE));
}

/** Wraps a provider with the credentials saved for it. */
export function providerConfig(provider: SearchProvider, store: StorageLike | null | undefined): ProviderConfig {
  const values: Record<string, string> = {};
  for (const field of provider.fields) values[field.storage] = storedValue(store, field.storage).trim();
  return { provider, values };
}

/**
 * Pure: which required credentials are still missing (as field storage keys).
 * Empty means the provider is ready to be called. A keyless provider is always ready.
 */
export function missingFields(config: ProviderConfig): string[] {
  return config.provider.fields
    .filter((field) => !(config.values[field.storage] ?? '').trim())
    .map((field) => field.storage);
}

/** Pure: true when every credential this provider needs is present. */
export function isProviderReady(config: ProviderConfig): boolean {
  return missingFields(config).length === 0;
}

/* ─────────────────────────── request-time host guard ─────────────────────────── */

/**
 * Pure: the parsed host of `url`, or null when it is not a URL.
 * Used by `assertProviderHost` and by the tests that pin every provider's host.
 */
export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Throws unless `url` is https on exactly `provider.host`. This is the one place
 * that decides where a query may travel, so a future edit to an `apiUrl` cannot
 * quietly point a provider (and its API key) at another server.
 */
export function assertProviderHost(provider: SearchProvider, url: string): void {
  const host = urlHost(url);
  if (host !== provider.host) {
    throw new Error(`Search provider "${provider.id}" must call ${provider.host}, refused ${host ?? 'an unparseable URL'}`);
  }
  if (!url.startsWith('https://')) {
    throw new Error(`Search provider "${provider.id}" must use https`);
  }
}

/**
 * Pure: a URL that is safe to show or log — the value of every query parameter
 * whose name looks like a credential is replaced with `***`.
 *
 * Google's API takes its key as a `key=` parameter (that is its documented
 * design, and the only way to call it), so a raw URL must never reach a message,
 * a title, an error or `console`. The key is still sent to Google — it has to be
 * — but it stops here as far as the rest of the OS is concerned.
 *
 * The substitution is textual on purpose. Going through `URLSearchParams` would
 * re-encode every other parameter as a side effect (`+` for spaces, `%2A` for the
 * mask itself), so the URL shown to the user would no longer be the URL that was
 * actually requested — which is exactly what a diagnostic must not do.
 */
export function redactUrl(url: string): string {
  try {
    new URL(url);
  } catch {
    return '***';
  }
  return url.replace(
    /([?&][^=&#]*(?:key|token|secret|password|signature|api)[^=&#]*=)([^&#]*)/gi,
    '$1***',
  );
}
