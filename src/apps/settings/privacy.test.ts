// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  AI_KEY_STORAGE, AI_PROVIDERS, BOOKMARKS_KEY, DEFAULT_ENGINE, ENGINE_KEY, GEOMETRY_KEY,
  NOTIFICATIONS_KEY, SETTINGS_KEY, clearedKeys, clearPrivacyItem, readPrivacyInventory,
  type WritableStorageLike,
} from './privacy';
import { LEGACY_STORAGE_KEYS, PROVIDERS, PROVIDER_STORAGE } from '../ai/providers';

const GROQ_KEY = 'faisal.groq.apiKey';
const DEEPSEEK_KEY = 'faisal.deepseek.apiKey';

interface FakeStore extends WritableStorageLike {
  values: Record<string, string>;
  removed: string[];
}

/** In-memory localStorage stand-in; `throwOnRemove` makes writes fail like private mode. */
function fakeStorage(values: Record<string, string> = {}, throwOnRemove = false): FakeStore {
  const state: FakeStore = {
    values: { ...values },
    removed: [],
    getItem: (key) => (Object.hasOwn(state.values, key) ? state.values[key] : null),
    removeItem: (key) => {
      if (throwOnRemove) throw new Error('storage blocked');
      state.removed.push(key);
      delete state.values[key];
    },
  };
  return state;
}

/** Storage that refuses even a read, as in a locked-down private window. */
const blockedReads: WritableStorageLike = {
  getItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};

const notification = (id: number) => JSON.stringify([{ id, title: `n${id}`, time: id }]);

describe('readPrivacyInventory', () => {
  it('counts every item from the real keys', () => {
    const store = fakeStorage({
      [SETTINGS_KEY]: JSON.stringify({
        theme: 'dark', locale: 'en', accent: 'faisal', 'shell.dnd': true,
        'shell.session': ['org.faisal.Terminal', 'org.faisal.Files'],
      }),
      [NOTIFICATIONS_KEY]: JSON.stringify([
        { id: 3, title: 'c', time: 3 }, { id: 2, title: 'b', time: 2 }, { id: 1, title: 'a', time: 1 },
      ]),
      [GEOMETRY_KEY]: JSON.stringify({
        'org.faisal.Terminal': { left: 10, top: 20, width: 800, height: 500, maximized: false },
        'org.faisal.Files': { left: 40, top: 60, width: 900, height: 600 },
      }),
      [BOOKMARKS_KEY]: JSON.stringify(['https://a.test', 'https://b.test', 'http://insecure.test', 7]),
      [GROQ_KEY]: 'gsk_saved',
    });
    expect(readPrivacyInventory(store)).toEqual({
      settingsCount: 5,
      sessionCount: 2,
      notificationCount: 3,
      geometryCount: 2,
      bookmarkCount: 2,
      aiKeysSaved: { groq: true, deepseek: false },
    });
  });

  it('reports which provider has a key without ever exposing its value', () => {
    const store = fakeStorage({ [DEEPSEEK_KEY]: 'sk_secret_value', [GROQ_KEY]: '' });
    const inv = readPrivacyInventory(store);
    expect(inv.aiKeysSaved).toEqual({ groq: false, deepseek: true });
    expect(JSON.stringify(inv)).not.toContain('sk_secret_value');
  });

  it('reads a missing key as 0', () => {
    expect(readPrivacyInventory(fakeStorage())).toEqual({
      settingsCount: 0, sessionCount: 0, notificationCount: 0, geometryCount: 0, bookmarkCount: 0,
      aiKeysSaved: { groq: false, deepseek: false },
    });
  });

  it('reads corrupt JSON as 0 instead of throwing', () => {
    const store = fakeStorage({
      [SETTINGS_KEY]: '{not json',
      [NOTIFICATIONS_KEY]: '{"not":"an array"}',
      [GEOMETRY_KEY]: '[]',
      [BOOKMARKS_KEY]: 'null',
    });
    expect(readPrivacyInventory(store)).toEqual({
      settingsCount: 0, sessionCount: 0, notificationCount: 0, geometryCount: 0, bookmarkCount: 0,
      aiKeysSaved: { groq: false, deepseek: false },
    });
  });

  it('tolerates storage that throws (private mode) and a missing store', () => {
    for (const store of [blockedReads, null, undefined]) {
      expect(readPrivacyInventory(store)).toEqual({
        settingsCount: 0, sessionCount: 0, notificationCount: 0, geometryCount: 0, bookmarkCount: 0,
        aiKeysSaved: { groq: false, deepseek: false },
      });
    }
  });

  it('counts only settings keys the kernel would load', () => {
    const settings: Record<string, unknown> = { theme: 'dark', 'shell.dnd': true, '1bad': true };
    settings['a'.repeat(80)] = 'too long'; // outside the kernel's allowlist
    // Written as raw JSON: a literal '__proto__' key in an object body never becomes an own key.
    const json = `${JSON.stringify(settings).slice(0, -1)},"__proto__":"x","":"empty"}`;
    const store = fakeStorage({ [SETTINGS_KEY]: json });
    expect(JSON.parse(json)).toHaveProperty('__proto__');
    expect(readPrivacyInventory(store).settingsCount).toBe(2);
  });

  it('ignores session entries and notifications the shell would drop', () => {
    const store = fakeStorage({
      [SETTINGS_KEY]: JSON.stringify({ 'shell.session': ['a', 5, null, 'b'] }),
      [NOTIFICATIONS_KEY]: JSON.stringify([
        { id: 1, title: 'ok', time: 1 }, { id: 'x', title: 'bad id', time: 2 }, { title: 'no id', time: 3 },
        { id: 4, title: 'no time' }, null, 'nope',
      ]),
    });
    const inv = readPrivacyInventory(store);
    expect(inv.sessionCount).toBe(2);
    expect(inv.notificationCount).toBe(1);
  });

  it('caps counts at the limits the owning modules enforce', () => {
    const store = fakeStorage({
      [NOTIFICATIONS_KEY]: JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ id: i, title: 't', time: i }))),
      [BOOKMARKS_KEY]: JSON.stringify(Array.from({ length: 150 }, (_, i) => `https://b${i}.test`)),
      [SETTINGS_KEY]: JSON.stringify({ 'shell.session': Array.from({ length: 30 }, (_, i) => `app${i}`) }),
    });
    const inv = readPrivacyInventory(store);
    expect(inv.notificationCount).toBe(50);
    expect(inv.bookmarkCount).toBe(100);
    expect(inv.sessionCount).toBe(12);
  });
});

describe('clearedKeys', () => {
  it('names exactly the keys each action deletes', () => {
    expect(clearedKeys('notifications')).toEqual([NOTIFICATIONS_KEY]);
    expect(clearedKeys('browsing')).toEqual([BOOKMARKS_KEY, ENGINE_KEY]);
    expect(clearedKeys('groq')).toEqual([GROQ_KEY]);
    expect(clearedKeys('deepseek')).toEqual([DEEPSEEK_KEY]);
    // Nothing else may be listed — in particular not the settings object or the VFS.
    expect(clearedKeys('browsing')).not.toContain(SETTINGS_KEY);
  });
});

describe('clearPrivacyItem', () => {
  it('clears only the notification history', () => {
    const store = fakeStorage({ [NOTIFICATIONS_KEY]: notification(1), [BOOKMARKS_KEY]: '["https://a.test"]' });
    expect(clearPrivacyItem(store, 'notifications')).toEqual([NOTIFICATIONS_KEY]);
    expect(store.values[NOTIFICATIONS_KEY]).toBeUndefined();
    expect(readPrivacyInventory(store).notificationCount).toBe(0);
    expect(store.values[BOOKMARKS_KEY]).toBe('["https://a.test"]');
  });

  it('clears bookmarks and the remembered engine, leaving the settings object alone', () => {
    const store = fakeStorage({
      [BOOKMARKS_KEY]: '["https://a.test"]', [ENGINE_KEY]: 'duckduckgo',
      [SETTINGS_KEY]: JSON.stringify({ theme: 'dark' }), [NOTIFICATIONS_KEY]: notification(1),
    });
    expect(clearPrivacyItem(store, 'browsing')).toEqual([BOOKMARKS_KEY, ENGINE_KEY]);
    const inv = readPrivacyInventory(store);
    expect(inv.bookmarkCount).toBe(0);
    expect(store.values[ENGINE_KEY]).toBeUndefined();
    // The engine falls back to the browser app's default, not to something invented here.
    expect(DEFAULT_ENGINE).toBe('wikipedia');
    expect(inv.settingsCount).toBe(1);
    expect(inv.notificationCount).toBe(1);
  });

  it('forgetting one provider keeps the other provider and every unrelated key', () => {
    const store = fakeStorage({
      [GROQ_KEY]: 'gsk_saved', [DEEPSEEK_KEY]: 'sk_saved',
      'faisal.groq.model': 'llama-3.3-70b-versatile', [PROVIDER_STORAGE]: 'deepseek',
      [SETTINGS_KEY]: JSON.stringify({ theme: 'dark' }), [BOOKMARKS_KEY]: '["https://a.test"]',
      [NOTIFICATIONS_KEY]: notification(1), [GEOMETRY_KEY]: '{"app":{}}',
    });
    expect(clearPrivacyItem(store, 'groq')).toEqual([GROQ_KEY]);
    expect(readPrivacyInventory(store)).toMatchObject({
      aiKeysSaved: { groq: false, deepseek: true },
      settingsCount: 1, bookmarkCount: 1, notificationCount: 1, geometryCount: 1,
    });
    expect(store.values[DEEPSEEK_KEY]).toBe('sk_saved');
    expect(store.values['faisal.groq.model']).toBe('llama-3.3-70b-versatile');
    expect(store.values[PROVIDER_STORAGE]).toBe('deepseek');
  });

  it('forgetting DeepSeek keeps the Groq key', () => {
    const store = fakeStorage({ [GROQ_KEY]: 'gsk_saved', [DEEPSEEK_KEY]: 'sk_saved' });
    clearPrivacyItem(store, 'deepseek');
    expect(readPrivacyInventory(store).aiKeysSaved).toEqual({ groq: true, deepseek: false });
    expect(store.values[GROQ_KEY]).toBe('gsk_saved');
  });

  it('never throws when storage blocks writes, and reports what it tried to delete', () => {
    // A store that refuses every write, as in a locked-down private window.
    const blocked = fakeStorage({ [GROQ_KEY]: 'gsk_saved' }, true);
    for (const store of [blocked, blockedReads, null, undefined]) {
      expect(() => clearPrivacyItem(store, 'notifications')).not.toThrow();
      expect(() => clearPrivacyItem(store, 'browsing')).not.toThrow();
      expect(() => clearPrivacyItem(store, 'groq')).not.toThrow();
    }
    // The keys it would have deleted are still reported, so the UI can be honest about it.
    expect(clearPrivacyItem(blocked, 'browsing')).toEqual([BOOKMARKS_KEY, ENGINE_KEY]);
    expect(clearPrivacyItem(null, 'groq')).toEqual([GROQ_KEY]);
  });
});

describe('provider key registry', () => {
  it('matches the storage keys the AI app actually reads, for every provider', () => {
    expect(AI_PROVIDERS.map((p) => p.id)).toEqual(PROVIDERS.map((p) => p.id));
    for (const provider of PROVIDERS) {
      expect(provider.keyStorage).toBe(AI_KEY_STORAGE[provider.id as keyof typeof AI_KEY_STORAGE]);
    }
    // One key per provider, no duplicates, and never a legacy or selected-provider key.
    const keys = Object.values(AI_KEY_STORAGE);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(PROVIDER_STORAGE);
    for (const legacy of LEGACY_STORAGE_KEYS) expect(keys).not.toContain(legacy);
  });
});
