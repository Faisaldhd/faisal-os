import { describe, it, expect } from 'vitest';
import type { CatalogEntry } from '../../kernel/types';
import {
  CATEGORIES,
  FALLBACK_DESCRIPTIONS,
  describeApp,
  filterCatalog,
  isPowerfulPermission,
  permissionDescription,
  pickFeatured,
  sortedCatalog,
} from './model';

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'org.faisal.Widget',
    name: { ar: 'ودجت', en: 'Widget' },
    icon: '<svg></svg>',
    permissions: [],
    category: 'utilities',
    installed: false,
    ...overrides,
  };
}

describe('permission descriptions', () => {
  it('maps every permission to plain-language ar/en copy', () => {
    const permissions: Array<Parameters<typeof permissionDescription>[0]> = [
      'fs:home', 'fs:read-all', 'fs:system', 'notifications', 'settings', 'apps:manage', 'system:monitor', 'network',
    ];
    for (const p of permissions) {
      expect(permissionDescription(p, 'ar').length).toBeGreaterThan(0);
      expect(permissionDescription(p, 'en').length).toBeGreaterThan(0);
    }
  });

  it('flags only the powerful permissions', () => {
    expect(isPowerfulPermission('fs:system')).toBe(true);
    expect(isPowerfulPermission('apps:manage')).toBe(true);
    expect(isPowerfulPermission('system:monitor')).toBe(true);
    expect(isPowerfulPermission('fs:read-all')).toBe(true);
    expect(isPowerfulPermission('fs:home')).toBe(false);
    expect(isPowerfulPermission('notifications')).toBe(false);
    expect(isPowerfulPermission('settings')).toBe(false);
    expect(isPowerfulPermission('network')).toBe(false);
  });
});

describe('description fallback', () => {
  it('prefers the manifest description when present', () => {
    const app = entry({ id: 'org.faisal.Files', description: { ar: 'خاص', en: 'custom' } });
    expect(describeApp(app, 'ar')).toBe('خاص');
    expect(describeApp(app, 'en')).toBe('custom');
  });

  it('falls back to the known-id map when the manifest has none', () => {
    const app = entry({ id: 'org.faisal.Calculator', description: undefined });
    expect(describeApp(app, 'ar')).toBe(FALLBACK_DESCRIPTIONS['org.faisal.Calculator'].ar);
    expect(describeApp(app, 'en')).toBe(FALLBACK_DESCRIPTIONS['org.faisal.Calculator'].en);
  });

  it('covers all the known built-in app ids', () => {
    for (const id of [
      'org.faisal.Files', 'org.faisal.Terminal', 'org.faisal.TextEditor', 'org.faisal.Calculator',
      'org.faisal.ImageViewer', 'org.faisal.Clock', 'org.faisal.SystemMonitor', 'org.faisal.Store', 'org.faisal.Settings',
    ]) {
      expect(FALLBACK_DESCRIPTIONS[id]).toBeDefined();
    }
  });

  it('returns empty string for an unknown app with no description', () => {
    const app = entry({ id: 'org.example.Unknown', description: undefined });
    expect(describeApp(app, 'ar')).toBe('');
  });
});

describe('category filtering + search', () => {
  const catalog: CatalogEntry[] = [
    entry({ id: 'a', name: { ar: 'الآلة الحاسبة', en: 'Calculator' }, category: 'utilities' }),
    entry({ id: 'b', name: { ar: 'الملفات', en: 'Files' }, category: 'system', description: { ar: 'استعرض ملفاتك', en: 'browse your files' } }),
    entry({ id: 'c', name: { ar: 'عارض الصور', en: 'Image Viewer' }, category: 'media' }),
  ];

  it('lists every filter category including "all"', () => {
    expect(CATEGORIES).toContain('all');
    expect(CATEGORIES).toEqual(expect.arrayContaining(['system', 'utilities', 'accessories', 'media', 'development', 'web']));
  });

  it('filters the "web" category, so embedded web apps have a chip', () => {
    const catalog = [
      entry({ id: 'w', name: { ar: 'ويكيبيديا', en: 'Wikipedia' }, category: 'web' }),
      entry({ id: 'u', name: { ar: 'أدوات', en: 'Utilities' }, category: 'utilities' }),
    ];
    expect(filterCatalog(catalog, { category: 'web', query: '', locale: 'en' }).map((e) => e.id)).toEqual(['w']);
    expect(filterCatalog(catalog, { category: 'utilities', query: '', locale: 'en' }).map((e) => e.id)).toEqual(['u']);
  });

  it('filters by category', () => {
    const result = filterCatalog(catalog, { category: 'media', query: '', locale: 'en' });
    expect(result.map((e) => e.id)).toEqual(['c']);
  });

  it('"all" keeps every entry', () => {
    expect(filterCatalog(catalog, { category: 'all', query: '', locale: 'en' })).toHaveLength(3);
  });

  it('matches by name in either locale', () => {
    expect(filterCatalog(catalog, { category: 'all', query: 'files', locale: 'en' }).map((e) => e.id)).toEqual(['b']);
    expect(filterCatalog(catalog, { category: 'all', query: 'الصور', locale: 'ar' }).map((e) => e.id)).toEqual(['c']);
  });

  it('matches by description text', () => {
    expect(filterCatalog(catalog, { category: 'all', query: 'browse', locale: 'en' }).map((e) => e.id)).toEqual(['b']);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(filterCatalog(catalog, { category: 'all', query: '  CALCULATOR  ', locale: 'en' }).map((e) => e.id)).toEqual(['a']);
  });

  it('combines category and query', () => {
    expect(filterCatalog(catalog, { category: 'system', query: 'calculator', locale: 'en' })).toHaveLength(0);
  });
});

describe('featured pick + sorting', () => {
  it('picks the first non-installed app', () => {
    const catalog = [entry({ id: 'a', installed: true }), entry({ id: 'b', installed: false }), entry({ id: 'c', installed: false })];
    expect(pickFeatured(catalog)?.id).toBe('b');
  });

  it('falls back to the first app when everything is installed', () => {
    const catalog = [entry({ id: 'a', installed: true }), entry({ id: 'b', installed: true })];
    expect(pickFeatured(catalog)?.id).toBe('a');
  });

  it('returns undefined for an empty catalog', () => {
    expect(pickFeatured([])).toBeUndefined();
  });

  it('sorts by localized name', () => {
    const catalog = [
      entry({ id: 'z', name: { ar: 'ياء', en: 'Zebra' } }),
      entry({ id: 'a', name: { ar: 'ألف', en: 'Apple' } }),
    ];
    expect(sortedCatalog(catalog, 'en').map((e) => e.id)).toEqual(['a', 'z']);
  });
});
