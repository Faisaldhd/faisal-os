import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DOCK_MIN_ITEM,
  dockMetrics,
  dockSelection,
  fitDockStrip,
  mountDock,
  watchShellWidth,
} from './dock';
import type { AppManifest, Settings, SystemAPI } from '../kernel/types';

/** A width the fake shell reports for the dock row and the shell root. */
let shellWidth = 1280;

beforeEach(() => {
  shellWidth = 1280;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      const cls = typeof this.className === 'string' ? this.className : '';
      return cls.includes('faisal-dock-bar') || cls.includes('faisal-desktop') ? shellWidth : 0;
    },
  });
});

afterEach(() => {
  delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
});

function manifest(id: string, category?: AppManifest['category']): AppManifest {
  return { id, name: { ar: id, en: id }, icon: '<svg viewBox="0 0 24 24"></svg>', permissions: [], category };
}

function fakeSettings(): Settings {
  const store: Record<string, unknown> = {};
  return {
    get: <T,>(key: string, fallback: T): T => (Object.hasOwn(store, key) ? (store[key] as T) : fallback),
    set: (key: string, value: unknown) => { store[key] = value; },
  };
}

function fakeSys(apps: AppManifest[]): SystemAPI {
  return {
    bus: { on: () => () => {}, emit: () => {} },
    vfs: {} as never,
    wm: {
      list: () => [], focused: () => undefined, get: () => undefined,
      isMinimized: () => false, minimize: () => {}, toggleMaximize: () => {}, open: () => ({}) as never,
    } as never,
    proc: {} as never,
    apps: {
      register: () => {}, list: () => apps, catalog: () => apps.map((m) => ({ ...m, installed: true })),
      install: () => {}, uninstall: () => {}, running: () => [], closeWindow: () => {},
      launch: async () => undefined, appForFile: () => undefined,
    },
    settings: fakeSettings(),
    locale: () => 'ar',
    t: (k: string) => k,
    notify: () => {},
  };
}

describe('dockMetrics', () => {
  const base = { gap: 10, padding: 16, min: DOCK_MIN_ITEM, max: 56 };

  it('keeps every launcher when they can shrink to fit', () => {
    // 15 launchers in 900px: 900 - 32 - 140 = 728 -> 48px each, above the 44px floor.
    expect(dockMetrics({ ...base, available: 900, count: 15 })).toEqual({ size: 48, capacity: 15 });
  });

  it('never grows past `max` and never shrinks past `min`', () => {
    expect(dockMetrics({ ...base, available: 4000, count: 3 })).toEqual({ size: 56, capacity: 3 });
    // 390px cannot fit 15 launchers at 44px, so the size stays at the touch minimum.
    expect(dockMetrics({ ...base, available: 390, count: 15 }).size).toBe(44);
  });

  it('reports how many launchers fit at the minimum size', () => {
    // (390 - 32 + 10) / (44 + 10) = 6.8 -> 6 launchers, none of them cropped.
    expect(dockMetrics({ ...base, available: 390, count: 15 }).capacity).toBe(6);
    // 320 -> (320 - 32 + 10) / 54 = 5.5 -> 5.
    expect(dockMetrics({ ...base, available: 320, count: 15 }).capacity).toBe(5);
  });

  it('uses the compact spacing it is given', () => {
    expect(dockMetrics({ available: 390, count: 15, gap: 6, padding: 8, min: 44, max: 60 }))
      .toEqual({ size: 44, capacity: 7 });
  });

  it('answers for an empty strip and for a surface with no room', () => {
    expect(dockMetrics({ ...base, available: 1280, count: 0 })).toEqual({ size: 56, capacity: 0 });
    expect(dockMetrics({ ...base, available: 0, count: 15 })).toEqual({ size: 56, capacity: 0 });
    expect(dockMetrics({ ...base, available: 120, count: 15 }).capacity).toBe(1);
  });
});

describe('dockSelection', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];

  it('keeps everything when it all fits, in the owner order', () => {
    expect(dockSelection({ ids, running: ['d'], capacity: 5 })).toEqual({ shown: ids, hidden: [] });
  });

  it('puts running apps first, then the rest of the pinned order', () => {
    expect(dockSelection({ ids, running: ['d', 'b'], capacity: 3 })).toEqual({ shown: ['b', 'd', 'a'], hidden: ['c', 'e'] });
  });

  it('keeps the given order while everything fits, and drops duplicates', () => {
    expect(dockSelection({ ids: ['a', 'b', 'a'], running: ['b'], capacity: 5 })).toEqual({ shown: ['a', 'b'], hidden: [] });
  });

  it('hides everything when there is no room, and nothing when capacity is huge', () => {
    expect(dockSelection({ ids, running: [], capacity: 0 })).toEqual({ shown: [], hidden: ids });
    expect(dockSelection({ ids, running: [], capacity: 99 }).hidden).toEqual([]);
  });
});

describe('fitDockStrip', () => {
  it('publishes the measured launcher size as --faisal-dock-item', () => {
    const host = document.createElement('div');
    host.className = 'faisal-dock-bar';
    const strip = document.createElement('div');
    host.append(strip);
    shellWidth = 320;
    expect(fitDockStrip(strip, host, 15, true).size).toBe(44);
    expect(strip.style.getPropertyValue('--faisal-dock-item')).toBe('44px');
    shellWidth = 1280;
    expect(fitDockStrip(strip, host, 15, false).size).toBe(56);
    expect(strip.style.getPropertyValue('--faisal-dock-item')).toBe('56px');
  });
});

describe('watchShellWidth', () => {
  it('flags the compact layout from the measured width and reports it', () => {
    const root = document.createElement('div');
    root.className = 'faisal-desktop';
    const seen: boolean[] = [];
    shellWidth = 390;
    watchShellWidth(root, (compact) => seen.push(compact));
    expect(seen).toEqual([true]);
    expect(root.classList.contains('is-compact')).toBe(true);
    // A narrow desktop window is the same decision as a phone: measured, not assumed.
    shellWidth = 1280;
    watchShellWidth(root, (compact) => seen.push(compact));
    expect(seen).toEqual([true, false]);
    expect(root.classList.contains('is-compact')).toBe(false);
  });
});

describe('mountDock', () => {
  const apps = [
    'org.faisal.Files', 'org.faisal.Terminal', 'org.faisal.TextEditor', 'org.faisal.Browser',
    'org.faisal.Claude', 'org.faisal.Calculator', 'org.faisal.ImageViewer', 'org.faisal.FileViewer',
    'org.faisal.Clock', 'org.faisal.Office', 'org.faisal.Pdf', 'org.faisal.Photo',
    'org.faisal.Settings', 'org.faisal.Store', 'org.faisal.SystemMonitor',
  ].map((id) => manifest(id));

  function launchers(root: HTMLElement): HTMLButtonElement[] {
    return [...root.querySelectorAll<HTMLButtonElement>('.faisal-dock-btn')];
  }

  it('shows every launcher on a wide desktop, with no "more" button', () => {
    const root = document.createElement('div');
    root.className = 'faisal-desktop';
    shellWidth = 1280;
    mountDock(root, fakeSys(apps));
    expect(launchers(root)).toHaveLength(15);
    expect(root.querySelector('.faisal-dock-more')).toBeNull();
  });

  it('on a phone keeps the 44px floor and moves the extras behind "more"', () => {
    const root = document.createElement('div');
    root.className = 'faisal-desktop';
    shellWidth = 320;
    const opened: number[] = [];
    mountDock(root, fakeSys(apps), { onMore: () => opened.push(1) });
    const strip = root.querySelector<HTMLElement>('.faisal-dock-strip')!;
    expect(strip.style.getPropertyValue('--faisal-dock-item')).toBe('44px');
    // 6 slots at 320px: five launchers and the "more" button.
    expect(launchers(root)).toHaveLength(6);
    const more = root.querySelector<HTMLButtonElement>('.faisal-dock-more')!;
    expect(more.getAttribute('aria-label')).toBeTruthy();
    expect(more.title).toBeTruthy();
    more.click();
    expect(opened).toEqual([1]);
  });

  it('keeps a running app on the strip even when it is far down the dash order', () => {
    const root = document.createElement('div');
    root.className = 'faisal-desktop';
    shellWidth = 320;
    const sys = fakeSys(apps);
    sys.wm.list = () => [{ id: 'w1', appId: 'org.faisal.SystemMonitor' }] as never;
    mountDock(root, sys);
    const labels = launchers(root).map((b) => b.getAttribute('aria-label'));
    expect(labels[0]).toBe('org.faisal.SystemMonitor');
  });

  it('leaves web apps out of the strip', () => {
    const root = document.createElement('div');
    root.className = 'faisal-desktop';
    shellWidth = 1280;
    mountDock(root, fakeSys([...apps, manifest('org.faisal.WebX', 'web')]));
    expect(launchers(root)).toHaveLength(15);
  });
});
