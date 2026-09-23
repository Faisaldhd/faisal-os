import { describe, it, expect, afterEach } from 'vitest';
import {
  collectSystemInfo,
  collectSystemInfoAsync,
  fpsDisplay,
  isYesNoValue,
  LIVE_SYSTEM_ROW_IDS,
  type SystemInfoEnv,
  type SystemInfoRow,
} from './system-info';
import { t, setLocale } from '../../kernel/i18n';
// Importing the app registers its defineStrings table, so t() can resolve every label.
import './index';

/** A minimal environment: nothing beyond what the caller always knows. */
function baseEnv(over: Partial<SystemInfoEnv> = {}, source: Record<string, unknown> = {}): SystemInfoEnv {
  return {
    source: { ...source },
    appsOpen: 2,
    windowsOpen: 2,
    nowMs: 1_000,
    ...over,
  };
}

/** A fully-populated Chromium-like environment. */
function fullEnv(over: Partial<SystemInfoEnv> = {}): SystemInfoEnv {
  return baseEnv(over, {
    navigator: {
      userAgentData: {
        brands: [
          { brand: 'Chromium', version: '126' },
          { brand: 'Google Chrome', version: '126' },
        ],
        mobile: false,
        platform: 'Windows',
      },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0',
      platform: 'Win32',
      language: 'ar',
      languages: ['ar', 'en-US'],
      hardwareConcurrency: 8,
      deviceMemory: 8,
      connection: { effectiveType: '4g', downlink: 9.5, rtt: 50, saveData: false },
      storage: { persisted: async () => true },
    },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    devicePixelRatio: 1.25,
    innerWidth: 1280,
    innerHeight: 720,
    // navigator.onLine as read by the app, handed in as the plain value the collector takes
    onLine: true,
    timeOrigin: 0,
    timeZone: 'Asia/Riyadh',
  });
}

function byId(rows: SystemInfoRow[], id: string): SystemInfoRow {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
}

describe('fpsDisplay — the hidden-tab honesty rule', () => {
  it('reports paused whenever the document is hidden, whatever the samples say', () => {
    expect(fpsDisplay([], true)).toEqual({ state: 'paused' });
    expect(fpsDisplay([60, 58, 12], true)).toEqual({ state: 'paused' });
    // a throttled near-zero reading taken in the background must never be surfaced
    expect(fpsDisplay([0], true)).toEqual({ state: 'paused' });
  });

  it('reports measuring until one full window has been sampled', () => {
    expect(fpsDisplay([], false)).toEqual({ state: 'measuring' });
  });

  it('reports the latest sampled window when visible', () => {
    expect(fpsDisplay([60], false)).toEqual({ state: 'value', value: 60 });
    expect(fpsDisplay([60, 57, 59], false)).toEqual({ state: 'value', value: 59 });
    expect(fpsDisplay([0], false)).toEqual({ state: 'value', value: 0 });
  });

  it('treats a non-finite sample as not measured rather than as a value', () => {
    expect(fpsDisplay([Number.NaN], false)).toEqual({ state: 'measuring' });
    expect(fpsDisplay([Number.POSITIVE_INFINITY], false)).toEqual({ state: 'measuring' });
  });
});

describe('collectSystemInfo — available matrix', () => {
  it('reports every browser-API value when the environment provides it', () => {
    const rows = collectSystemInfo(fullEnv());
    expect(byId(rows, 'browser').value).toBe('Chromium 126, Google Chrome 126');
    expect(byId(rows, 'platform').value).toBe('Windows');
    expect(byId(rows, 'mobile').value).toBe('no');
    expect(byId(rows, 'language').value).toBe('ar');
    expect(byId(rows, 'languages').value).toBe('ar, en-US');
    expect(byId(rows, 'screen').value).toBe('1920 × 1080 px');
    expect(byId(rows, 'devicePixelRatio').value).toBe('1.25');
    expect(byId(rows, 'colorDepth').value).toBe('24 bit');
    expect(byId(rows, 'viewport').value).toBe('1280 × 720 px');
    expect(byId(rows, 'cpuThreads').value).toBe('8');
    expect(byId(rows, 'deviceMemory').value).toBe('8 GB');
    expect(byId(rows, 'online').value).toBe('yes');
    expect(byId(rows, 'connection').value).toBe('4g · 9.5 Mbit/s');
    expect(byId(rows, 'rtt').value).toBe('50 ms');
    expect(byId(rows, 'saveData').value).toBe('no');
    expect(byId(rows, 'pageUptime').value).toBe('1s');
    expect(byId(rows, 'timeZone').value).toBe('Asia/Riyadh');
    expect(byId(rows, 'appsWindows').value).toBe('2 / 2');
    for (const r of rows) {
      // persistence is a promise, so it is only ever known from the async collector
      if (r.id === 'storagePersisted') continue;
      expect(r.available, r.id).toBe(true);
    }
  });

  it('marks every row unavailable when the environment exposes nothing', () => {
    const rows = collectSystemInfo(baseEnv());
    // appsOpen/windowsOpen are supplied by the app, not the browser, so they stay available.
    for (const r of rows) {
      if (r.id === 'appsWindows') continue;
      expect(r.available, r.id).toBe(false);
      expect(r.value, r.id).toBeNull();
    }
    expect(byId(rows, 'appsWindows').value).toBe('2 / 2');
  });

  it('keeps the same row ids in the same order for every environment', () => {
    const sparse = collectSystemInfo(baseEnv()).map((r) => r.id);
    const full = collectSystemInfo(fullEnv()).map((r) => r.id);
    expect(full).toEqual(sparse);
  });
});

describe('collectSystemInfo — userAgentData preference', () => {
  it('prefers client hints over the raw UA string and platform', () => {
    const rows = collectSystemInfo(fullEnv());
    expect(byId(rows, 'browser').value).not.toContain('Mozilla/5.0');
    expect(byId(rows, 'platform').value).toBe('Windows');
    expect(byId(rows, 'browser').noteKey).toBe('monitor.noteClientHints');
  });

  it('falls back to the raw UA/platform strings and says so', () => {
    const rows = collectSystemInfo(
      baseEnv({}, { navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' } }),
    );
    expect(byId(rows, 'browser').value).toBe('Mozilla/5.0 (X11; Linux x86_64)');
    expect(byId(rows, 'browser').noteKey).toBe('monitor.noteRawUserAgent');
    expect(byId(rows, 'platform').value).toBe('Linux x86_64');
    // mobile only comes from client hints
    expect(byId(rows, 'mobile').available).toBe(false);
  });

  it('falls back to the raw UA when client hints carry no brands', () => {
    const rows = collectSystemInfo(
      baseEnv({}, { navigator: { userAgentData: { platform: 'Windows' }, userAgent: 'Mozilla/5.0 (raw)' } }),
    );
    expect(byId(rows, 'browser').value).toBe('Mozilla/5.0 (raw)');
    expect(byId(rows, 'platform').value).toBe('Windows');
  });

  it('never invents a version number when a brand has none', () => {
    const rows = collectSystemInfo(baseEnv({}, { navigator: { userAgentData: { brands: [{ brand: 'Chromium' }] } } }));
    expect(byId(rows, 'browser').value).toBe('Chromium');
  });
});

describe('collectSystemInfo — Chromium-only APIs', () => {
  it('deviceMemory absent ⇒ unavailable, present ⇒ reported with the approximate note', () => {
    const absent = collectSystemInfo(baseEnv({}, { navigator: { hardwareConcurrency: 4 } }));
    expect(byId(absent, 'deviceMemory').available).toBe(false);
    expect(byId(absent, 'deviceMemory').value).toBeNull();

    const present = collectSystemInfo(baseEnv({}, { navigator: { deviceMemory: 4 } }));
    expect(byId(present, 'deviceMemory')).toMatchObject({ available: true, value: '4 GB' });
    expect(byId(present, 'deviceMemory').noteKey).toBe('monitor.noteApproximate');
  });

  it('rejects a non-numeric or non-positive deviceMemory instead of coercing it', () => {
    for (const bad of ['8', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, true]) {
      const rows = collectSystemInfo(baseEnv({}, { navigator: { deviceMemory: bad } }));
      expect(byId(rows, 'deviceMemory').available, String(bad)).toBe(false);
    }
  });

  it('connection absent ⇒ unavailable, present ⇒ reported', () => {
    const absent = collectSystemInfo(baseEnv({}, { navigator: {} }));
    expect(byId(absent, 'connection').available).toBe(false);
    expect(byId(absent, 'rtt').available).toBe(false);
    expect(byId(absent, 'saveData').available).toBe(false);

    const partial = collectSystemInfo(baseEnv({}, { navigator: { connection: { effectiveType: '3g' } } }));
    expect(byId(partial, 'connection')).toMatchObject({ available: true, value: '3g' });
    expect(byId(partial, 'rtt').available).toBe(false);

    const present = collectSystemInfo(baseEnv({}, { navigator: { connection: { rtt: 0, saveData: true } } }));
    expect(byId(present, 'rtt')).toMatchObject({ available: true, value: '0 ms' });
    expect(byId(present, 'saveData')).toMatchObject({ available: true, value: 'yes' });
  });

  it('never reads a heap figure from the environment — memory rows are not part of this collector', () => {
    const env = fullEnv();
    (env.source as Record<string, unknown>).jsHeapUsedBytes = 123_456;
    const rows = collectSystemInfo(env);
    expect(rows.some((r) => r.id.toLowerCase().includes('heap'))).toBe(false);
  });
});

describe('collectSystemInfo — CPU, viewport, online, uptime', () => {
  it('reports hardwareConcurrency only when it is a positive finite number', () => {
    for (const bad of [0, -2, Number.NaN, '8', null, undefined]) {
      const rows = collectSystemInfo(baseEnv({}, { navigator: { hardwareConcurrency: bad } }));
      expect(byId(rows, 'cpuThreads').available, String(bad)).toBe(false);
    }
  });

  it('derives page uptime from performance.timeOrigin and the supplied clock', () => {
    const rows = collectSystemInfo(baseEnv({ nowMs: 61_000 }, { timeOrigin: 1_000 }));
    expect(byId(rows, 'pageUptime').value).toBe('1m 00s');
  });

  it('does not report a negative uptime when the clock is behind the origin', () => {
    const rows = collectSystemInfo(baseEnv({ nowMs: 1_000 }, { timeOrigin: 5_000 }));
    expect(byId(rows, 'pageUptime').value).toBe('0s');
  });

  it('online state is only reported when the caller supplies a boolean', () => {
    expect(byId(collectSystemInfo(baseEnv({}, { onLine: false })), 'online').value).toBe('no');
    expect(byId(collectSystemInfo(baseEnv({}, {})), 'online').available).toBe(false);
  });

  it('exposes exactly the live row ids the app refreshes: viewport, online, pageUptime', () => {
    expect([...LIVE_SYSTEM_ROW_IDS]).toEqual(['viewport', 'online', 'pageUptime']);
  });
});

describe('collectSystemInfo — throwing getters never take the tab down', () => {
  const boom = () => {
    throw new Error('blocked by policy');
  };

  it('survives a navigator whose properties all throw', () => {
    const hostile: Record<string, unknown> = {};
    for (const key of ['userAgentData', 'userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'onLine', 'connection', 'storage']) {
      Object.defineProperty(hostile, key, { get: boom, enumerable: true });
    }
    const rows = collectSystemInfo({ source: { navigator: hostile }, appsOpen: 1, windowsOpen: 1, nowMs: 0 });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      if (r.id === 'appsWindows') continue;
      expect(r.available, r.id).toBe(false);
      expect(r.value, r.id).toBeNull();
    }
  });

  it('survives a navigator that throws on every access and still awaits storage', async () => {
    const hostile = {
      get storage(): never {
        throw new Error('blocked');
      },
    };
    const rows = await collectSystemInfoAsync({ source: { navigator: hostile }, appsOpen: 0, windowsOpen: 0, nowMs: 0 });
    expect(byId(rows, 'storagePersisted').available).toBe(false);
  });

  it('degrades a single throwing getter to just that row', () => {
    const nav: Record<string, unknown> = { hardwareConcurrency: 4 };
    Object.defineProperty(nav, 'deviceMemory', { get: boom, enumerable: true });
    const rows = collectSystemInfo(baseEnv({}, { navigator: nav }));
    expect(byId(rows, 'cpuThreads').value).toBe('4');
    expect(byId(rows, 'deviceMemory').available).toBe(false);
  });

  it('survives a screen whose getters throw', () => {
    const screen: Record<string, unknown> = {};
    Object.defineProperty(screen, 'width', { get: boom, enumerable: true });
    Object.defineProperty(screen, 'height', { get: boom, enumerable: true });
    Object.defineProperty(screen, 'colorDepth', { get: boom, enumerable: true });
    const rows = collectSystemInfo(baseEnv({}, { screen }));
    expect(byId(rows, 'screen').available).toBe(false);
    expect(byId(rows, 'colorDepth').available).toBe(false);
  });
});

describe('collectSystemInfo — storage persistence', () => {
  it('the sync collector never claims to know persistence', () => {
    const rows = collectSystemInfo(fullEnv());
    expect(byId(rows, 'storagePersisted').available).toBe(false);
    expect(byId(rows, 'storagePersisted').value).toBeNull();
  });

  it('reports persisted() true/false and points at the File Systems tab for the estimate', async () => {
    const yes = await collectSystemInfoAsync(baseEnv({}, { navigator: { storage: { persisted: async () => true } } }));
    expect(byId(yes, 'storagePersisted')).toMatchObject({ available: true, value: 'yes' });
    expect(byId(yes, 'storagePersisted').noteKey).toBe('monitor.noteEstimateInFileSystems');

    const no = await collectSystemInfoAsync(baseEnv({}, { navigator: { storage: { persisted: async () => false } } }));
    expect(byId(no, 'storagePersisted')).toMatchObject({ available: true, value: 'no' });
  });

  it('stays unavailable when persisted() is missing, rejects, or answers a non-boolean', async () => {
    const missing = await collectSystemInfoAsync(baseEnv({}, { navigator: { storage: {} } }));
    expect(byId(missing, 'storagePersisted').available).toBe(false);

    const rejects = await collectSystemInfoAsync(
      baseEnv({}, { navigator: { storage: { persisted: async () => { throw new Error('denied'); } } } }),
    );
    expect(byId(rejects, 'storagePersisted').available).toBe(false);

    const weird = await collectSystemInfoAsync(baseEnv({}, { navigator: { storage: { persisted: async () => 'maybe' } } }));
    expect(byId(weird, 'storagePersisted').available).toBe(false);
  });

  it('does not duplicate the browser storage estimate the File Systems tab shows', () => {
    const rows = collectSystemInfo(fullEnv());
    expect(rows.map((r) => r.id)).not.toContain('storageEstimate');
  });
});

describe('collectSystemInfo — the never-fabricate rule', () => {
  const FORBIDDEN = /temp|temperature|fan|sensor|thermal|cpu usage|gpu/i;
  /** Physical-memory wording that must never describe a browser-reported approximate value. */
  const PHYSICAL_MEMORY = /physical|hardware memory|system ram|\bram\b/i;

  it('has no row id or label mentioning temperature, fan, sensor or physical memory', () => {
    setLocale('en');
    const rows = collectSystemInfo(fullEnv());
    for (const r of rows) {
      const label = t(r.labelKey);
      expect(r.id).not.toMatch(FORBIDDEN);
      expect(label).not.toMatch(FORBIDDEN);
      expect(r.id).not.toMatch(PHYSICAL_MEMORY);
      // The one memory row is explicitly an approximate browser-reported value.
      if (r.id === 'deviceMemory') {
        expect(label).toMatch(/approximate/i);
        expect(label).toMatch(/browser-reported/i);
        expect(label).not.toMatch(PHYSICAL_MEMORY);
      } else {
        expect(label).not.toMatch(PHYSICAL_MEMORY);
      }
    }
  });

  it('produces only values the environment actually provided', () => {
    const rows = collectSystemInfo(baseEnv({}, { navigator: { hardwareConcurrency: 4 }, onLine: true }));
    const values = rows.filter((r) => r.available).map((r) => `${r.id}=${r.value}`);
    expect(new Set(values)).toEqual(new Set(['cpuThreads=4', 'online=yes', 'appsWindows=2 / 2']));
  });

  it('never renders a zero or an empty string for an unavailable value', () => {
    const rows = collectSystemInfo(baseEnv());
    for (const r of rows) {
      if (r.available) continue;
      expect(r.value, r.id).not.toBe('0');
      expect(r.value, r.id).not.toBe('');
      expect(r.value, r.id).toBeNull();
    }
  });

  it('emits no gauge-like numbers: values are strings or null, never raw numbers', () => {
    for (const r of collectSystemInfo(fullEnv())) {
      expect(typeof r.value === 'string' || r.value === null, r.id).toBe(true);
    }
  });

  it('only uses the yes/no tokens for boolean rows', () => {
    for (const r of collectSystemInfo(fullEnv())) {
      if (r.value !== null && isYesNoValue(r.value)) {
        expect(['mobile', 'online', 'saveData']).toContain(r.id);
      }
    }
  });
});

describe('collectSystemInfo — translations', () => {
  afterEach(() => setLocale('ar'));

  for (const locale of ['ar', 'en'] as const) {
    it(`every label and note key resolves to a real ${locale} translation`, () => {
      setLocale(locale);
      const rows = collectSystemInfo(fullEnv());
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(t(r.labelKey), r.labelKey).not.toBe(r.labelKey);
        expect(t(r.labelKey).trim()).not.toBe('');
        if (r.noteKey) {
          expect(t(r.noteKey), r.noteKey).not.toBe(r.noteKey);
          expect(t(r.noteKey).trim()).not.toBe('');
        }
      }
    });
  }

  it('the two locales really differ, so the table is not English-only', () => {
    setLocale('ar');
    const ar = t('monitor.sysCpuThreads');
    setLocale('en');
    const en = t('monitor.sysCpuThreads');
    expect(ar).not.toBe(en);
  });

  it('uses flat namespaced keys, so no key can silently miss the string table', () => {
    for (const r of collectSystemInfo(fullEnv())) {
      expect(r.labelKey, r.id).toMatch(/^monitor\.[A-Za-z0-9]+$/);
      if (r.noteKey) expect(r.noteKey, r.id).toMatch(/^monitor\.[A-Za-z0-9]+$/);
    }
  });

  it('the unavailable string is explicit in both locales', () => {
    setLocale('ar');
    expect(t('monitor.unavailable')).toContain('غير متاح');
    setLocale('en');
    expect(t('monitor.unavailable')).toBe('Not available in this browser');
  });
});
