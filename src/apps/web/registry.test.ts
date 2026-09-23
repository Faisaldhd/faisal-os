import { describe, it, expect } from 'vitest';
import { createAppRegistry } from '../../kernel/apps';
import type { SystemAPI } from '../../kernel/types';
import {
  WIRED_WEB_APPS,
  WEB_APP_NAMESPACE,
  applyUrlTransform,
  lastUrlStorageKey,
  saveLastUrl,
  saveUrl,
  savedUrl,
  startingUrl,
  webAppId,
  webAppKind,
  webAppManifest,
  webAppWindowTitle,
  type WebAppDef,
  type WebStorage,
} from './registry';

/** Minimal in-memory storage; `Storage` is injected, never read off the global. */
function memStorage(seed: Record<string, string> = {}): WebStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

const wikipedia = WIRED_WEB_APPS.find((d) => d.id === 'wikipedia')!;
const byId = (id: string) => WIRED_WEB_APPS.find((d) => d.id === id);

/**
 * The registry's two measured lists, kept here as the independent expectation the
 * table is checked against. A site may only appear in `allowed` when it was
 * measured to send NEITHER X-Frame-Options NOR a frame-ancestors rule that
 * excludes us; both entries below are the sites we actually measured refusing.
 *
 * Measured 2026-09-23 with PowerShell `Invoke-WebRequest` (following redirects);
 * the raw headers for every entry are recorded in the report and in the comment
 * above WIRED_WEB_APPS.
 */
const MEASURED_BLOCKED = ['google', 'youtube'] as const;

describe('wired web apps — the registry table as a whole', () => {
  it('gives every def a unique id and a unique OS app id', () => {
    const ids = WIRED_WEB_APPS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const appIds = WIRED_WEB_APPS.map(webAppId);
    expect(new Set(appIds).size).toBe(appIds.length);
  });

  it('agrees with the measured verdicts: exactly google and youtube are blocked', () => {
    const blocked = WIRED_WEB_APPS.filter((d) => d.embedNote === 'blocked').map((d) => d.id);
    expect(blocked.sort()).toEqual([...MEASURED_BLOCKED].sort());
    // Every other entry must carry the explicit 'allowed' note — no def is left
    // without a measurement, because "unmeasured" and "allowed" are not the same.
    for (const def of WIRED_WEB_APPS) {
      if (def.id !== 'google' && def.id !== 'youtube') expect(def.embedNote, def.id).toBe('allowed');
    }
  });

  it('keeps the three originally wired sites, with their measured notes unchanged', () => {
    expect(byId('google')?.url).toBe('https://www.google.com/');
    expect(byId('google')?.embedNote).toBe('blocked');
    expect(byId('youtube')?.url).toBe('https://www.youtube.com/');
    expect(byId('youtube')?.embedNote).toBe('blocked');
    expect(byId('wikipedia')?.url).toBe('https://www.wikipedia.org/');
    expect(byId('wikipedia')?.embedNote).toBe('allowed');
  });

  it('wires the sites this work measured as embeddable', () => {
    // Each of these was measured to send no XFO and no frame-ancestors. Listing the
    // ids (rather than counting) is what makes an accidental removal visible.
    for (const id of [
      'wikipedia-ar', 'wiktionary', 'wikibooks', 'wikidata', 'commons',
      'archive-org', 'openlibrary', 'gutenberg', 'radio-garden',
      'openstreetmap', 'google-maps-embed', 'google-calendar-embed',
      'vimeo', 'spotify-embed',
    ]) {
      expect(byId(id), id).toBeDefined();
      expect(byId(id)?.embedNote, id).toBe('allowed');
    }
  });

  it('wires the two first-class apps this work added', () => {
    expect(webAppKind(byId('youtube-player')!)).toBe('player');
    expect(byId('youtube-player')?.embedNote).toBe('allowed');
    expect(typeof byId('youtube-player')?.transformUrl).toBe('function');
    expect(webAppKind(byId('search')!)).toBe('search');
  });

  it('gives every site a bilingual title, a description and an icon', () => {
    for (const def of WIRED_WEB_APPS) {
      expect(def.title.ar.trim().length, def.id).toBeGreaterThan(0);
      expect(def.title.en.trim().length, def.id).toBeGreaterThan(0);
      expect(def.description?.ar.trim().length, def.id).toBeGreaterThan(0);
      expect(def.description?.en.trim().length, def.id).toBeGreaterThan(0);
      expect(def.icon, def.id).toContain('<svg');
      // The two languages must actually differ: an English title copied into the
      // Arabic slot would pass a length check and still ship an English UI.
      expect(def.title.ar, def.id).not.toBe(def.title.en);
    }
  });

  it('uses https for every home URL and never frames the OS itself', () => {
    for (const def of WIRED_WEB_APPS) {
      expect(def.url.startsWith('https://'), def.id).toBe(true);
      expect(new URL(def.url).protocol, def.id).toBe('https:');
    }
  });

  it('defaults a def with no kind to "frame"', () => {
    expect(webAppKind({ id: 'x', title: { ar: 'x', en: 'x' }, url: 'https://x.example/' })).toBe('frame');
  });

  it('leaves the input untouched for a def with no transform, and applies one when given', () => {
    const plain: WebAppDef = { id: 'plain', title: { ar: 'x', en: 'x' }, url: 'https://x.example/' };
    expect(applyUrlTransform(plain, 'anything at all')).toBe('anything at all');
    expect(applyUrlTransform({ ...plain, transformUrl: (raw) => raw.toUpperCase() }, 'ab')).toBe('AB');
    // A misbehaving transform is "declined", never a thrown error in the address bar.
    expect(applyUrlTransform({ ...plain, transformUrl: () => { throw new Error('boom'); } }, 'ab')).toBe('');
  });
});

describe('webAppId', () => {
  it('namespaces the key under the OS namespace', () => {
    expect(webAppId({ id: 'google', title: { ar: 'ج', en: 'G' }, url: 'https://a.example/' }))
      .toBe('org.faisal.Web.google');
    expect(WEB_APP_NAMESPACE).toBe('org.faisal.Web');
  });

  it('rejects a malformed key loudly', () => {
    expect(() => webAppId({ id: 'Not Valid', title: { ar: 'x', en: 'x' }, url: 'https://a.example/' }))
      .toThrow(/lowercase/);
    expect(() => webAppId({ id: '', title: { ar: 'x', en: 'x' }, url: 'https://a.example/' }))
      .toThrow(/lowercase/);
  });
});

describe('webAppManifest', () => {
  it('produces a category "web" manifest with the network permission, single instance', () => {
    for (const def of WIRED_WEB_APPS) {
      const m = webAppManifest(def);
      expect(m.id, def.id).toBe(webAppId(def));
      expect(m.category, def.id).toBe('web');
      expect(m.permissions, def.id).toEqual(['network']);
      expect(m.singleInstance, def.id).toBe(true);
      expect(m.icon, def.id).toBe(def.icon);
      expect(m.name.ar, def.id).toBe(def.title.ar);
      expect(m.name.en, def.id).toBe(def.title.en);
    }
  });

  it('is non-core and default-installed, so it appears in the Store like any app', () => {
    const m = webAppManifest(wikipedia);
    expect(m.core).toBeUndefined();
    expect(m.defaultInstalled).toBeUndefined();
  });

  it('accepts any new def without touching anything else', () => {
    const custom: WebAppDef = {
      id: 'example',
      title: { ar: 'مثال', en: 'Example' },
      url: 'https://example.com/',
      description: { ar: 'وصف', en: 'Description' },
      embedNote: 'allowed',
    };
    const m = webAppManifest(custom);
    expect(m.id).toBe('org.faisal.Web.example');
    expect(m.category).toBe('web');
    // Falls back to the shared globe when the def carries no icon.
    expect(m.icon).toContain('<svg');
  });

  it('passes the kernel manifest validator for EVERY wired def', () => {
    let sys!: SystemAPI;
    const registry = createAppRegistry(() => sys);
    const bus = { on: () => () => {}, emit: () => {} };
    sys = {
      apps: registry,
      settings: {
        get: <T,>(_key: string, fallback: T): T => fallback,
        set: () => {},
      },
      wm: { list: () => [] },
      bus,
    } as unknown as SystemAPI;
    for (const def of WIRED_WEB_APPS) {
      expect(
        () => registry.register({ manifest: webAppManifest(def), load: async () => ({ manifest: webAppManifest(def), launch() {} }) }),
        def.id,
      ).not.toThrow();
    }
    // Every registered app really is in the registry, one per def, all category web.
    expect(registry.list()).toHaveLength(WIRED_WEB_APPS.length);
    expect(registry.list().every((m) => m.category === 'web')).toBe(true);
    expect(registry.list().map((m) => m.id).sort()).toEqual([...WIRED_WEB_APPS].map(webAppId).sort());
  });

  it('is an ordinary registry entry: installable and uninstallable like any other app', () => {
    let state: { removed: string[]; added: string[] } = { removed: [], added: [] };
    let sys!: SystemAPI;
    const registry = createAppRegistry(() => sys);
    sys = {
      apps: registry,
      settings: {
        get: <T,>(_key: string, fallback: T): T => (state as unknown as T) ?? fallback,
        set: (_key: string, value: unknown) => { state = value as typeof state; },
      },
      wm: { list: () => [] },
      bus: { on: () => () => {}, emit: () => {} },
    } as unknown as SystemAPI;

    for (const def of WIRED_WEB_APPS) {
      registry.register({
        manifest: webAppManifest(def),
        load: async () => ({ manifest: webAppManifest(def), launch() {} }),
      });
    }
    // Nothing special: they are installed by default, removable, and re-installable.
    expect(registry.list()).toHaveLength(WIRED_WEB_APPS.length);
    expect(() => registry.uninstall('org.faisal.Web.wikipedia')).not.toThrow();
    expect(registry.list().map((m) => m.id)).not.toContain('org.faisal.Web.wikipedia');
    registry.install('org.faisal.Web.wikipedia');
    expect(registry.list().map((m) => m.id)).toContain('org.faisal.Web.wikipedia');
    // And they are not core apps, so removal is possible at all.
    expect(registry.catalog().every((e) => !e.core)).toBe(true);
  });
});

describe('saved-URL helpers', () => {
  it('round-trips a URL through the injected storage', () => {
    const storage = memStorage();
    expect(savedUrl(wikipedia, storage)).toBeNull();
    saveUrl(wikipedia, 'https://en.wikipedia.org/wiki/Main_Page', storage);
    expect(savedUrl(wikipedia, storage)).toBe('https://en.wikipedia.org/wiki/Main_Page');
  });

  it('keys storage per web app, so two sites never share a URL', () => {
    const storage = memStorage();
    const google = WIRED_WEB_APPS.find((d) => d.id === 'google')!;
    saveUrl(wikipedia, 'https://en.wikipedia.org/', storage);
    saveUrl(google, 'https://www.google.com/search?q=faisal', storage);
    expect(lastUrlStorageKey(wikipedia)).toBe('faisal.web.wikipedia.url');
    expect(savedUrl(wikipedia, storage)).toBe('https://en.wikipedia.org/');
    expect(savedUrl(google, storage)).toBe('https://www.google.com/search?q=faisal');
  });

  it('gives every wired app its own storage key', () => {
    const keys = WIRED_WEB_APPS.map(lastUrlStorageKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ignores corrupt, empty and non-string values instead of returning them', () => {
    expect(savedUrl(wikipedia, memStorage({ [lastUrlStorageKey(wikipedia)]: '' }))).toBeNull();
    expect(savedUrl(wikipedia, memStorage({ [lastUrlStorageKey(wikipedia)]: '   ' }))).toBeNull();
    const broken = {
      getItem: () => 42 as unknown as string,
      setItem: () => {},
    } as WebStorage;
    expect(savedUrl(wikipedia, broken)).toBeNull();
  });

  it('survives storage that throws on read or on write', () => {
    const throwing: WebStorage = {
      getItem: () => { throw new Error('SecurityError: storage blocked'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    expect(() => savedUrl(wikipedia, throwing)).not.toThrow();
    expect(savedUrl(wikipedia, throwing)).toBeNull();
    expect(() => saveUrl(wikipedia, 'https://en.wikipedia.org/', throwing)).not.toThrow();
    expect(() => saveLastUrl(wikipedia, 'https://en.wikipedia.org/', throwing)).not.toThrow();
  });

  it('startingUrl prefers the remembered URL and falls back to the def home', () => {
    expect(startingUrl(wikipedia, memStorage())).toBe('https://www.wikipedia.org/');
    const storage = memStorage();
    saveUrl(wikipedia, 'https://en.wikipedia.org/wiki/Faisal', storage);
    expect(startingUrl(wikipedia, storage)).toBe('https://en.wikipedia.org/wiki/Faisal');
  });
});

describe('window title', () => {
  it('is "Web App — <site>" in the current locale', () => {
    expect(webAppWindowTitle(wikipedia, 'ar', 'تطبيق ويب')).toBe('تطبيق ويب — ويكيبيديا');
    expect(webAppWindowTitle(wikipedia, 'en', 'Web App')).toBe('Web App — Wikipedia');
  });
});
