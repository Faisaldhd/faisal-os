import { describe, expect, it, vi } from 'vitest';
import {
  mapGoogleItems,
  mapWikipediaPages,
  searchProvider,
  toPlainText,
  wikipediaArticleUrl,
  wikipediaSubdomain,
  type SearchResult,
} from './search';
import {
  GOOGLE_CX_STORAGE,
  GOOGLE_KEY_STORAGE,
  SEARCH_PROVIDERS,
  SEARCH_STORAGE_KEYS,
  assertProviderHost,
  providerConfig,
  redactUrl,
  missingFields,
  searchProviderById,
  type ProviderConfig,
  type SearchProvider,
  type StorageLike,
} from './searchProviders';

/** A storage stub; nothing in these tests touches the real localStorage. */
function store(values: Record<string, string> = {}): StorageLike {
  return { getItem: (k) => values[k] ?? null };
}

const wikipedia = searchProviderById('wikipedia');
const google = searchProviderById('google');

/** The measured Wikipedia REST response, trimmed to two entries. */
const WIKI_PAYLOAD = {
  pages: [
    {
      id: 521681,
      key: 'Faisal',
      title: 'Faisal',
      description: 'Topics referred to by the same term',
      excerpt: 'name include: <span class="searchmatch">Faisal</span> of Saudi Arabia (1906–1975)',
    },
    { id: 194475, key: 'Faisal_I', title: 'Faisal I', excerpt: 'King of Iraq &amp; Syria' },
    // No key: it cannot be turned into an article, so it must be dropped.
    { id: 3, title: 'Broken', excerpt: 'no key at all' },
  ],
};

describe('Wikipedia response mapping', () => {
  it('maps the measured REST shape into results, in the provider own order', () => {
    const results = mapWikipediaPages(WIKI_PAYLOAD, 'en');
    expect(results.map((r) => r.title)).toEqual(['Faisal', 'Faisal I']);
    expect(results[0].pageUrl).toBe('https://en.wikipedia.org/wiki/Faisal');
    expect(results[0].embedUrl).toBe(results[0].pageUrl);
    expect(results[1].pageUrl).toBe('https://en.wikipedia.org/wiki/Faisal_I');
  });

  it('reduces the provider own markup to plain text instead of interpreting it', () => {
    const [first] = mapWikipediaPages(WIKI_PAYLOAD, 'en');
    // The <span class="searchmatch"> is dropped, not rendered: the snippet is text.
    expect(first.snippet).toContain('name include: Faisal of Saudi Arabia (1906–1975)');
    expect(first.snippet).not.toContain('<');
    expect(first.snippet).toContain('Topics referred to by the same term');
  });

  it('builds the article URL in the language the search ran in', () => {
    const [first] = mapWikipediaPages(WIKI_PAYLOAD, 'ar');
    expect(first.pageUrl).toBe('https://ar.wikipedia.org/wiki/Faisal');
    expect(wikipediaSubdomain('ar')).toBe('ar');
    expect(wikipediaSubdomain('en')).toBe('en');
  });

  it('encodes each path segment of a namespaced key', () => {
    // A space in a wiki title is a literal space too (Wikipedia serves
    // /wiki/Faisal_I as well), so the segment is percent-encoded, not underscored.
    expect(wikipediaArticleUrl('en', 'Wikipedia:Featured pictures'))
      .toBe('https://en.wikipedia.org/wiki/Wikipedia%3AFeatured%20pictures');
    // A key may contain a slash; each side is encoded separately so the path holds.
    expect(wikipediaArticleUrl('en', 'Foo/Bar')).toBe('https://en.wikipedia.org/wiki/Foo/Bar');
    // An empty key is not an article.
    expect(wikipediaArticleUrl('en', '')).toBe('');
  });

  it('is total: a wrong-shaped payload yields no results instead of throwing', () => {
    for (const payload of [null, undefined, 42, 'text', {}, { pages: 'nope' }, { pages: [null, 7] }]) {
      expect(mapWikipediaPages(payload, 'en')).toEqual([]);
    }
  });
});

describe('Google response mapping', () => {
  const payload = {
    items: [
      { title: 'Fai&#231;al', snippet: 'A <b>king</b> of Saudi Arabia', link: 'https://example.org/a' },
      { title: 'No link', snippet: 'dropped' },
      { title: 'Not https', link: 'http://insecure.example/' },
    ],
  };

  it('keeps Google own order, decodes entities and drops unusable links', () => {
    const results = mapGoogleItems(payload);
    expect(results.map((r) => r.title)).toEqual(['Faiçal']);
    expect(results[0].snippet).toBe('A king of Saudi Arabia');
    expect(results[0].pageUrl).toBe('https://example.org/a');
    // Only the https entry with a link survives.
    expect(results).toHaveLength(1);
  });

  it('treats a missing items array as an empty result set, not an error', () => {
    expect(mapGoogleItems({})).toEqual([]);
    expect(mapGoogleItems(null)).toEqual([]);
  });
});

describe('plain-text extraction', () => {
  it('removes tags, decodes entities and collapses whitespace', () => {
    expect(toPlainText('<b>a</b>  <span>b</span>')).toBe('a b');
    expect(toPlainText('&quot;quoted&quot; &amp; more')).toBe('"quoted" & more');
    expect(toPlainText('&#8211;')).toBe('–');
    expect(toPlainText('&#x2013;')).toBe('–');
    // An unknown entity is left exactly as the provider wrote it.
    expect(toPlainText('&unknownthing;')).toBe('&unknownthing;');
    expect(toPlainText('  padded  ')).toBe('padded');
  });
});

describe('provider table', () => {
  it('offers wikipedia first as the default and never invents a host', () => {
    expect(SEARCH_PROVIDERS[0].id).toBe('wikipedia');
    expect(searchProviderById(undefined).id).toBe('wikipedia');
    expect(searchProviderById('nonsense').id).toBe('wikipedia');
    expect(searchProviderById('google').id).toBe('google');
  });

  it('pins each provider to exactly one host, and refuses any other', () => {
    for (const provider of SEARCH_PROVIDERS) {
      expect(/^[a-z0-9.-]+$/.test(provider.host)).toBe(true);
      expect(() => assertProviderHost(provider, `https://${provider.host}/x`)).not.toThrow();
      expect(() => assertProviderHost(provider, 'https://evil.example/x')).toThrow(/must call/);
      expect(() => assertProviderHost(provider, 'http://' + provider.host + '/x')).toThrow(/https/);
      expect(() => assertProviderHost(provider, 'not a url')).toThrow();
    }
  });

  it('reports the credentials a provider still needs', () => {
    expect(missingFields(providerConfig(wikipedia, store()))).toEqual([]);
    expect(missingFields(providerConfig(google, store())))
      .toEqual([GOOGLE_KEY_STORAGE, GOOGLE_CX_STORAGE]);
    expect(missingFields(providerConfig(google, store({ [GOOGLE_KEY_STORAGE]: 'k' }))))
      .toEqual([GOOGLE_CX_STORAGE]);
    expect(missingFields(providerConfig(google, store({ [GOOGLE_KEY_STORAGE]: 'k', [GOOGLE_CX_STORAGE]: 'c' }))))
      .toEqual([]);
    // Whitespace is not a credential.
    expect(missingFields(providerConfig(google, store({ [GOOGLE_KEY_STORAGE]: '   ', [GOOGLE_CX_STORAGE]: 'c' }))))
      .toEqual([GOOGLE_KEY_STORAGE]);
  });

  it('uses the locale to pick the Wikipedia subdomain', () => {
    const ar = wikipedia.apiUrl('فيصل', providerConfig(wikipedia, store()), 'ar');
    expect(ar).toContain('/wikipedia/ar/search/page');
    expect(ar).toContain(encodeURIComponent('فيصل'));
    const en = wikipedia.apiUrl('faisal', providerConfig(wikipedia, store()), 'en');
    expect(en).toContain('/wikipedia/en/search/page');
  });

  it('never puts a credential in a URL that could be rendered or logged', () => {
    const config = providerConfig(google, store({ [GOOGLE_KEY_STORAGE]: 'AIzaSECRET', [GOOGLE_CX_STORAGE]: 'cx:1' }));
    const url = google.apiUrl('faisal', config, 'en');
    expect(url).toContain('AIzaSECRET'); // it has to be sent to Google…
    const safe = redactUrl(url);
    expect(safe).not.toContain('AIzaSECRET'); // …but never shown or logged
    expect(safe).toContain('key=***');
    // The engine id is not a credential, so it is left readable.
    expect(safe).toContain('cx=cx%3A1');
    // …and the rest of the URL is untouched, so a diagnostic stays accurate.
    expect(safe).toContain('q=faisal');
    expect(redactUrl('not a url')).toBe('***');
  });

  it('lists every storage key it writes, for the Settings privacy inventory', () => {
    expect(SEARCH_STORAGE_KEYS).toContain('faisal.web.search.provider');
    expect(SEARCH_STORAGE_KEYS).toContain('faisal.web.search.query');
    expect(SEARCH_STORAGE_KEYS).toContain('faisal.web.search.google.apiKey');
    expect(SEARCH_STORAGE_KEYS).toContain('faisal.web.search.google.cx');
  });
});

/* ─────────────────────────── the network call, stubbed ─────────────────────────── */

/** Builds a `fetch` stub that answers once, with no network anywhere. */
function fetchStub(init: { status?: number; body?: unknown; throws?: boolean }): typeof fetch {
  return (async () => {
    if (init.throws) throw new TypeError('Failed to fetch');
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => init.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const wikiConfig = (): ProviderConfig => providerConfig(wikipedia, store());
const googleConfig = (values: Record<string, string> = {}): ProviderConfig =>
  providerConfig(google, store(values));

describe('searchProvider — the honest outcome table', () => {
  it('maps a stubbed Wikipedia response into results and echoes the provider', async () => {
    const outcome = await searchProvider(wikiConfig(), 'faisal', {
      locale: 'en',
      fetchImpl: fetchStub({ body: WIKI_PAYLOAD }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.provider.id).toBe('wikipedia');
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0].pageUrl).toBe('https://en.wikipedia.org/wiki/Faisal');
  });

  it('calls the provider own host with the query, and no credentials', async () => {
    const calls: string[] = [];
    const spy = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => WIKI_PAYLOAD } as unknown as Response;
    }) as unknown as typeof fetch;
    await searchProvider(wikiConfig(), 'faisal os', { locale: 'en', fetchImpl: spy });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).hostname).toBe('api.wikimedia.org');
    expect(calls[0]).toContain(encodeURIComponent('faisal os'));
  });

  it('asks for configuration instead of searching without a key', async () => {
    const spy = vi.fn();
    const outcome = await searchProvider(googleConfig(), 'faisal', {
      locale: 'en',
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(outcome).toEqual({
      ok: false,
      code: 'config',
      missing: [GOOGLE_KEY_STORAGE, GOOGLE_CX_STORAGE],
      host: 'www.googleapis.com',
    });
    // And critically: no request was attempted with an empty key.
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports a refused/unreachable request as "network", never as no results', async () => {
    // This is the path the page's CSP produces today for both providers: the
    // request never completes. It must not look like a legitimate empty search.
    const outcome = await searchProvider(wikiConfig(), 'faisal', {
      locale: 'en',
      fetchImpl: fetchStub({ throws: true }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('network');
    expect(outcome.host).toBe('api.wikimedia.org');
    // The query is in the URL, but no credential ever is.
    expect(outcome.url).toContain('api.wikimedia.org');
  });

  it('reports a non-2xx status as "http" with the status, not as an empty list', async () => {
    const key = 'AIzaNOTAREALSECRET';
    const outcome = await searchProvider(googleConfig({ [GOOGLE_KEY_STORAGE]: key, [GOOGLE_CX_STORAGE]: 'c' }), 'faisal', {
      locale: 'en',
      fetchImpl: fetchStub({ status: 403, body: { error: { code: 403 } } }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('http');
    expect(outcome.status).toBe(403);
    // The redacted URL is what surfaces; the key itself appears nowhere in it.
    expect(outcome.url).toContain('www.googleapis.com');
    expect(outcome.url).not.toContain(key);
  });

  it('reports an unexpected body as "shape" rather than inventing results', async () => {
    // An array is an object in JS, and a wrong-but-object body previously slipped
    // through as a legitimate empty result set; both must now be "shape".
    for (const body of [[1, 2, 3], { error: 'quota exceeded' }, 'nope', 42]) {
      const outcome = await searchProvider(wikiConfig(), 'faisal', {
        locale: 'en',
        fetchImpl: fetchStub({ status: 200, body }),
      });
      expect(outcome.ok, JSON.stringify(body)).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code, JSON.stringify(body)).toBe('shape');
    }
  });

  it('accepts an empty result set as a real answer from either provider', async () => {
    // Wikipedia: an empty pages array. Google: the items field omitted entirely.
    const wiki = await searchProvider(wikiConfig(), 'zzz', {
      locale: 'en',
      fetchImpl: fetchStub({ status: 200, body: { pages: [] } }),
    });
    expect(wiki.ok).toBe(true);
    const g = await searchProvider(googleConfig({ [GOOGLE_KEY_STORAGE]: 'k2', [GOOGLE_CX_STORAGE]: 'c2' }), 'zzz', {
      locale: 'en',
      fetchImpl: fetchStub({ status: 200, body: { searchInformation: { totalResults: '0' } } }),
    });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.results).toEqual([]);
  });

  it('treats a real empty result set as success with zero results', async () => {
    const outcome = await searchProvider(wikiConfig(), 'zzzzzzzz', {
      locale: 'en',
      fetchImpl: fetchStub({ body: { pages: [] } }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results).toEqual([]);
  });

  it('an empty query never reaches the network', async () => {
    const spy = vi.fn();
    const outcome = await searchProvider(wikiConfig(), '   ', {
      locale: 'en',
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ ok: true, results: [], provider: wikipedia });
    expect(spy).not.toHaveBeenCalled();
  });

  it('never sends the request to a host other than the provider one', async () => {
    // A provider table entry is data; this proves the guard is what decides.
    const rogue: SearchProvider = {
      ...wikipedia,
      id: 'rogue',
      host: 'api.wikimedia.org',
      apiUrl: () => 'https://evil.example/steal',
    };
    const spy = vi.fn();
    const outcome = await searchProvider({ provider: rogue, values: {} }, 'faisal', {
      locale: 'en',
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('config');
    expect(outcome.host).toBe('api.wikimedia.org');
    // And above all: the request was never made to the rogue host.
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps the Arabic locale onto ar.wikipedia articles', async () => {
    const outcome = await searchProvider(wikiConfig(), 'فيصل', {
      locale: 'ar',
      fetchImpl: fetchStub({ body: WIKI_PAYLOAD }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results[0].pageUrl.startsWith('https://ar.wikipedia.org/wiki/')).toBe(true);
  });
});

describe('result shape', () => {
  it('always carries an embedUrl equal to pageUrl for a provider that is not framed by us', () => {
    const results: SearchResult[] = mapWikipediaPages(WIKI_PAYLOAD, 'en');
    for (const r of results) expect(r.embedUrl).toBe(r.pageUrl);
  });
});
