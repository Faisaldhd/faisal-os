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
  desktopEntries,
  isDirectChild,
  isDesktopChange,
  desktopIcon,
  desktopFileMenuItems,
  mountDesktop,
  type DesktopEntry,
} from './desktop';
import type { AppManifest, Settings, Stat, SystemAPI } from '../kernel/types';

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

import { parseHistory } from './notifications';

describe('parseHistory', () => {
  it('keeps valid items newest first and drops junk', () => {
    const items = parseHistory([
      { id: 1, title: 'old', time: 1 },
      { id: 2, title: 'new', time: 5, body: 'b', appId: 'org.x' },
      { id: 3, title: 7, time: 9 },
      null,
      { id: 4, title: 'bad body', time: 3, body: 42 },
    ]);
    expect(items.map((i) => i.id)).toEqual([2, 4, 1]);
    expect(items[1]).not.toHaveProperty('body');
    expect(parseHistory({})).toEqual([]);
  });
});

/* ───────────────── Desktop entries (files and folders in ~/Desktop) ───────────────── */

function stat(path: string, type: 'file' | 'dir'): Stat {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    type,
    size: type === 'dir' ? 0 : 3,
    mode: type === 'dir' ? 0o755 : 0o644,
    mtime: 0,
    ctime: 0,
  };
}

function entry(path: string, type: 'file' | 'dir'): DesktopEntry {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), type };
}

/** Lets the mount's first `readdir` settle before the DOM is inspected. */
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function deskSys(opts: { children?: Stat[]; handlerId?: string } = {}) {
  // All three default shortcuts installed, so the pinned grid is the full default set.
  const base = fakeSys(['org.faisal.Files', 'org.faisal.Browser', 'org.faisal.Terminal', 'org.faisal.TextEditor']);
  const launched: Array<{ appId: string; args?: string[] }> = [];
  const sys: SystemAPI = {
    ...base,
    vfs: {
      readdir: async () => {
        if (!opts.children) throw new Error('ENOENT');
        return opts.children;
      },
    } as unknown as SystemAPI['vfs'],
    apps: {
      ...base.apps,
      appForFile: () => (opts.handlerId ? manifest(opts.handlerId) : undefined),
      launch: async (appId: string, args?: string[]) => { launched.push({ appId, args }); return undefined; },
    },
  };
  return { sys, launched };
}

function mountOn(sys: SystemAPI): { root: HTMLElement; dispose: () => void } {
  const root = document.createElement('div');
  root.className = 'faisal-desktop-surface';
  const desktop = mountDesktop(root, sys, {} as never);
  return { root, dispose: () => desktop.dispose() };
}

describe('desktopEntries', () => {
  it('puts folders first, then sorts by localized name', () => {
    const stats = [
      stat('/home/user/Desktop/b.txt', 'file'),
      stat('/home/user/Desktop/Zeta', 'dir'),
      stat('/home/user/Desktop/alpha', 'dir'),
    ];
    expect(desktopEntries(stats, 'en').map((e) => e.name)).toEqual(['alpha', 'Zeta', 'b.txt']);
  });

  it('maps path, name and type from the VFS stat', () => {
    expect(desktopEntries([stat('/home/user/Desktop/deepseekapi.txt', 'file')], 'ar'))
      .toEqual([{ path: '/home/user/Desktop/deepseekapi.txt', name: 'deepseekapi.txt', type: 'file' }]);
  });
});

describe('isDirectChild / isDesktopChange', () => {
  it('accepts the folder itself and its direct children only', () => {
    expect(isDirectChild('/home/user/Desktop', '/home/user/Desktop')).toBe(true);
    expect(isDirectChild('/home/user/Desktop', '/home/user/Desktop/a.txt')).toBe(true);
    expect(isDirectChild('/home/user/Desktop', '/home/user/Desktop/sub/a.txt')).toBe(false);
    expect(isDirectChild('/home/user/Desktop', '/home/user/Documents/a.txt')).toBe(false);
    expect(isDirectChild('/home/user/Desktop', '/home/user/DesktopX/a.txt')).toBe(false);
  });

  it('counts a rename on either end, and ignores unrelated paths', () => {
    const dir = '/home/user/Desktop';
    expect(isDesktopChange(dir, { path: `${dir}/a.txt`, kind: 'create' })).toBe(true);
    expect(isDesktopChange(dir, { path: '/home/user/Documents/a.txt', oldPath: `${dir}/a.txt`, kind: 'rename' })).toBe(true);
    expect(isDesktopChange(dir, { path: '/home/user/Documents/a.txt', kind: 'modify' })).toBe(false);
  });
});

describe('desktopIcon', () => {
  it('matches folders, images and documents, and falls back to a plain file', () => {
    const folder = desktopIcon(entry('/d/notes', 'dir'));
    expect(desktopIcon(entry('/d/a.png', 'file'))).toBe(desktopIcon(entry('/d/a.PNG', 'file')));
    expect(desktopIcon(entry('/d/a.txt', 'file'))).not.toBe(desktopIcon(entry('/d/a.bin', 'file')));
    // A dotfile has no extension: it must not be treated as one.
    expect(desktopIcon(entry('/d/.bashrc', 'file'))).toBe(desktopIcon(entry('/d/a.bin', 'file')));
    expect(new Set([folder, desktopIcon(entry('/d/a.png', 'file')), desktopIcon(entry('/d/a.txt', 'file'))]).size).toBe(3);
  });
});

describe('desktopFileMenuItems', () => {
  it('offers Open, an optional Open in Files, and a danger Delete', () => {
    const actions = { open: () => {}, remove: () => {} };
    const file = desktopFileMenuItems(entry('/d/a.txt', 'file'), { ...actions, openInFiles: () => {} });
    expect(file.filter((i) => i.label).map((i) => i.label)).toEqual(['shell.ctx.open', 'shell.ctx.openInFiles', 'shell.ctx.delete']);
    expect(file.some((i) => i.separator)).toBe(true);
    expect(file.at(-1)?.danger).toBe(true);

    const folder = desktopFileMenuItems(entry('/d/notes', 'dir'), actions);
    expect(folder.filter((i) => i.label).map((i) => i.label)).toEqual(['shell.ctx.open', 'shell.ctx.delete']);
  });
});

describe('mountDesktop', () => {
  it('renders a tile for every file and folder in ~/Desktop, folders first', async () => {
    const { sys } = deskSys({
      children: [stat('/home/user/Desktop/deepseekapi.txt', 'file'), stat('/home/user/Desktop/notes', 'dir')],
    });
    const { root, dispose } = mountOn(sys);
    await flush();

    const paths = [...root.querySelectorAll('.faisal-desktop-icon[data-path]')].map((el) => el.getAttribute('data-path'));
    expect(paths).toEqual(['/home/user/Desktop/notes', '/home/user/Desktop/deepseekapi.txt']);
    const labels = [...root.querySelectorAll('.faisal-desktop-icon[data-path] .faisal-desktop-icon-label')].map((el) => el.textContent);
    expect(labels).toEqual(['notes', 'deepseekapi.txt']);
    dispose();
  });

  it('keeps the pinned shortcuts when ~/Desktop cannot be read', async () => {
    const { sys } = deskSys(); // readdir rejects
    const { root, dispose } = mountOn(sys);
    await flush();

    expect(root.querySelectorAll('.faisal-desktop-icon[data-app-id]')).toHaveLength(3);
    expect(root.querySelectorAll('.faisal-desktop-icon[data-path]')).toHaveLength(0);
    dispose();
  });

  it('opens a file with the app registered for its extension', async () => {
    const { sys, launched } = deskSys({
      children: [stat('/home/user/Desktop/deepseekapi.txt', 'file')],
      handlerId: 'org.faisal.TextEditor',
    });
    const { root, dispose } = mountOn(sys);
    await flush();

    root.querySelector('.faisal-desktop-icon[data-path]')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();

    expect(launched).toEqual([{ appId: 'org.faisal.TextEditor', args: ['/home/user/Desktop/deepseekapi.txt'] }]);
    dispose();
  });

  it('falls back to Files on a folder, and for a file nothing claims', async () => {
    const { sys, launched } = deskSys({
      children: [stat('/home/user/Desktop/notes', 'dir'), stat('/home/user/Desktop/a.bin', 'file')],
    });
    const { root, dispose } = mountOn(sys);
    await flush();

    root.querySelector('.faisal-desktop-icon[data-path$="notes"]')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(launched).toEqual([{ appId: 'org.faisal.Files', args: ['/home/user/Desktop/notes'] }]);

    root.querySelector('.faisal-desktop-icon[data-path$="a.bin"]')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(launched[1]).toEqual({ appId: 'org.faisal.Files', args: ['/home/user/Desktop'] });
    dispose();
  });
});
