import { describe, it, expect, beforeEach } from 'vitest';
import {
  sanitizeAppIdList,
  getDesktopIds,
  setDesktopIds,
  addToDesktop,
  removeFromDesktop,
  isOnDesktop,
  getDashIds,
  setDashIds,
  addToDash,
  removeFromDash,
  isInDash,
} from './desktop';
import type { AppManifest, Settings, SystemAPI } from '../kernel/types';

function manifest(id: string): AppManifest {
  return {
    id,
    name: { ar: id, en: id },
    icon: '<svg viewBox="0 0 24 24"></svg>',
    permissions: [],
  };
}

function fakeSettings(): Settings {
  const store: Record<string, unknown> = {};
  return {
    get: <T,>(key: string, fallback: T): T => (Object.hasOwn(store, key) ? (store[key] as T) : fallback),
    set: (key: string, value: unknown) => { store[key] = value; },
  };
}

function fakeSys(installedIds: string[]): SystemAPI {
  const manifests = installedIds.map(manifest);
  const settings = fakeSettings();
  return {
    bus: { on: () => () => {}, emit: () => {} },
    vfs: {} as any,
    wm: {} as any,
    apps: {
      register: () => {},
      list: () => manifests,
      catalog: () => manifests.map((m) => ({ ...m, installed: true })),
      install: () => {},
      uninstall: () => {},
      running: () => [],
      closeWindow: () => {},
      launch: async () => undefined,
      appForFile: () => undefined,
    },
    settings,
    locale: () => 'ar',
    t: (k: string) => k,
    notify: () => {},
  };
}

describe('sanitizeAppIdList', () => {
  it('drops non-strings, unknown/uninstalled ids and duplicates, preserving order', () => {
    const installed = ['org.faisal.Files', 'org.faisal.Terminal'];
    const raw = ['org.faisal.Files', 42, 'org.faisal.Ghost', 'org.faisal.Terminal', 'org.faisal.Files', null];
    expect(sanitizeAppIdList(raw, installed)).toEqual(['org.faisal.Files', 'org.faisal.Terminal']);
  });

  it('returns an empty array for a non-array value', () => {
    expect(sanitizeAppIdList('not-an-array', ['a'])).toEqual([]);
    expect(sanitizeAppIdList(undefined, ['a'])).toEqual([]);
    expect(sanitizeAppIdList(null, ['a'])).toEqual([]);
  });
});

describe('desktop pins', () => {
  let sys: SystemAPI;

  beforeEach(() => {
    sys = fakeSys(['org.faisal.Files', 'org.faisal.Browser', 'org.faisal.Terminal', 'org.faisal.Calculator']);
  });

  it('defaults to Files, Browser, Terminal on first run', () => {
    expect(getDesktopIds(sys)).toEqual(['org.faisal.Files', 'org.faisal.Browser', 'org.faisal.Terminal']);
  });

  it('omits default ids that are not installed', () => {
    sys = fakeSys(['org.faisal.Files', 'org.faisal.Calculator']);
    expect(getDesktopIds(sys)).toEqual(['org.faisal.Files']);
  });

  it('validates a stored list on read: unknown/uninstalled ids are dropped', () => {
    sys.settings.set('shell.desktop', ['org.faisal.Calculator', 'org.faisal.NotInstalled', 123, 'org.faisal.Files']);
    expect(getDesktopIds(sys)).toEqual(['org.faisal.Calculator', 'org.faisal.Files']);
  });

  it('addToDesktop / removeFromDesktop / isOnDesktop', () => {
    addToDesktop(sys, 'org.faisal.Calculator');
    expect(isOnDesktop(sys, 'org.faisal.Calculator')).toBe(true);
    expect(getDesktopIds(sys)).toContain('org.faisal.Calculator');

    removeFromDesktop(sys, 'org.faisal.Calculator');
    expect(isOnDesktop(sys, 'org.faisal.Calculator')).toBe(false);
  });

  it('addToDesktop is a no-op when already pinned (no duplicates)', () => {
    addToDesktop(sys, 'org.faisal.Files');
    expect(getDesktopIds(sys).filter((id) => id === 'org.faisal.Files')).toHaveLength(1);
  });

  it('setDesktopIds sanitizes whatever is passed in', () => {
    setDesktopIds(sys, ['org.faisal.Calculator', 'org.faisal.Ghost']);
    expect(getDesktopIds(sys)).toEqual(['org.faisal.Calculator']);
  });
});

describe('dash (dock favourites)', () => {
  let sys: SystemAPI;

  beforeEach(() => {
    sys = fakeSys(['org.faisal.Files', 'org.faisal.Browser', 'org.faisal.Terminal']);
  });

  it('defaults to the full installed-app list in order', () => {
    expect(getDashIds(sys)).toEqual(['org.faisal.Files', 'org.faisal.Browser', 'org.faisal.Terminal']);
  });

  it('addToDash / removeFromDash / isInDash', () => {
    setDashIds(sys, ['org.faisal.Files']);
    expect(isInDash(sys, 'org.faisal.Browser')).toBe(false);
    addToDash(sys, 'org.faisal.Browser');
    expect(getDashIds(sys)).toEqual(['org.faisal.Files', 'org.faisal.Browser']);
    removeFromDash(sys, 'org.faisal.Files');
    expect(getDashIds(sys)).toEqual(['org.faisal.Browser']);
  });

  it('drops an uninstalled id from a stored dash list', () => {
    sys.settings.set('shell.dash', ['org.faisal.Files', 'org.faisal.Uninstalled']);
    expect(getDashIds(sys)).toEqual(['org.faisal.Files']);
  });
});

import { sessionToRestore } from './session';

describe('sessionToRestore', () => {
  it('keeps installed app ids in order and drops junk', () => {
    expect(sessionToRestore(['a', 'x', 3, 'b', 'a'], ['a', 'b'])).toEqual(['a', 'b', 'a']);
    expect(sessionToRestore('nope', ['a'])).toEqual([]);
  });
  it('caps how many windows are reopened', () => {
    expect(sessionToRestore(Array(30).fill('a'), ['a'])).toHaveLength(12);
  });
});
