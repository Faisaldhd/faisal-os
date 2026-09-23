import { describe, it, expect } from 'vitest';
import { createAppRegistry } from '../../kernel/apps';
import type { SystemAPI } from '../../kernel/types';
import {
  WIRED_WEB_APPS,
  WEB_APP_NAMESPACE,
  lastUrlStorageKey,
  saveLastUrl,
  saveUrl,
  savedUrl,
  startingUrl,
  webAppId,
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

describe('wired web apps', () => {
  it('ships the three agreed sites with the measured embed notes', () => {
    const byId = new Map(WIRED_WEB_APPS.map((d) => [d.id, d] as const));
    expect(byId.get('google')?.url).toBe('https://www.google.com/');
    expect(byId.get('google')?.embedNote).toBe('blocked');
    expect(byId.get('youtube')?.url).toBe('https://www.youtube.com/');
    expect(byId.get('youtube')?.embedNote).toBe('blocked');
    expect(byId.get('wikipedia')?.url).toBe('https://www.wikipedia.org/');
    expect(byId.get('wikipedia')?.embedNote).toBe('allowed');
  });

  it('gives every site a bilingual title, a description and an icon', () => {
    for (const def of WIRED_WEB_APPS) {
      expect(def.title.ar.trim().length).toBeGreaterThan(0);
      expect(def.title.en.trim().length).toBeGreaterThan(0);
      expect(def.description?.ar.trim().length).toBeGreaterThan(0);
      expect(def.description?.en.trim().length).toBeGreaterThan(0);
      expect(def.icon).toContain('<svg');
    }
  });

  it('uses https for every home URL', () => {
    for (const def of WIRED_WEB_APPS) expect(def.url.startsWith('https://')).toBe(true);
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
      expect(m.id).toBe(webAppId(def));
      expect(m.category).toBe('web');
      expect(m.permissions).toEqual(['network']);
      expect(m.singleInstance).toBe(true);
      expect(m.icon).toBe(def.icon);
      expect(m.name.ar).toBe(def.title.ar);
      expect(m.name.en).toBe(def.title.en);
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

  it('passes the kernel manifest validator (category "web" is a known category)', () => {
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
      expect(() => registry.register({ manifest: webAppManifest(def), load: async () => ({ manifest: webAppManifest(def), launch() {} }) })).not.toThrow();
    }
    expect(registry.list().map((m) => m.category)).toEqual(['web', 'web', 'web']);
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
    expect(registry.list()).toHaveLength(3);
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
