import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWindowManager } from './wm';
import { createBus } from '../kernel/bus';
import type { EventBus, WindowOptions } from '../kernel/types';

function opts(title = 'Test'): WindowOptions {
  return { appId: 'org.faisal.Test', title, icon: '<svg viewBox="0 0 24 24"></svg>' };
}

/**
 * jsdom has no matchMedia, so the shell behaves as a fine-pointer device by default.
 * `stubPointer` simulates the (pointer: coarse) media query for the touch-policy tests;
 * `stubPointerChange` also lets a test flip the pointer kind at runtime.
 */
function stubPointer(coarse: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: coarse && query === '(pointer: coarse)', media: query, addEventListener: () => {} }),
  });
}

function stubPointerChange(): { emit: (coarse: boolean) => void; liveListeners: () => number } {
  const listeners = new Set<() => void>();
  const state = { coarse: false };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() { return state.coarse && query === '(pointer: coarse)'; },
      media: query,
      addEventListener: (_: 'change', l: () => void) => { listeners.add(l); },
      removeEventListener: (_: 'change', l: () => void) => { listeners.delete(l); },
    }),
  });
  return {
    emit: (coarse) => { state.coarse = coarse; listeners.forEach((l) => l()); },
    liveListeners: () => listeners.size,
  };
}

function restoreMatchMedia(original: PropertyDescriptor | undefined) {
  if (original) Object.defineProperty(window, 'matchMedia', original);
  else delete (window as { matchMedia?: unknown }).matchMedia;
}

describe('window manager', () => {
  let root: HTMLElement;
  let bus: EventBus;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
    bus = createBus();
  });

  it('opens a window and lists it', () => {
    const wm = createWindowManager(root, bus);
    const win = wm.open(opts('Hello'));
    expect(wm.list()).toHaveLength(1);
    expect(wm.get(win.id)).toBe(win);
    expect(win.appId).toBe('org.faisal.Test');
  });

  it('closes a window and removes it from the list', () => {
    const wm = createWindowManager(root, bus);
    const win = wm.open(opts());
    let closed = false;
    win.onClose(() => { closed = true; });
    win.close();
    expect(closed).toBe(true);
    expect(wm.list()).toHaveLength(0);
    expect(wm.get(win.id)).toBeUndefined();
  });

  it('lets multiple windows coexist and get/list stay consistent', () => {
    const wm = createWindowManager(root, bus);
    const a = wm.open(opts('A'));
    const b = wm.open(opts('B'));
    expect(wm.list().map((w) => w.id).sort()).toEqual([a.id, b.id].sort());
    a.close();
    expect(wm.list()).toEqual([b]);
  });

  it('emits window:focus and raises the focused window above others in z-order', () => {
    const wm = createWindowManager(root, bus);
    const focusEvents: string[] = [];
    bus.on('window:focus', ({ windowId }) => focusEvents.push(windowId));

    const a = wm.open(opts('A'));
    const b = wm.open(opts('B'));
    expect(focusEvents).toEqual([a.id, b.id]); // opening focuses

    a.focus();
    expect(focusEvents.at(-1)).toBe(a.id);

    // Compare z-index of the two window elements directly via the DOM.
    const windows = [...root.querySelectorAll<HTMLElement>('.faisal-window')];
    expect(windows).toHaveLength(2);
    const zA = Number(windows.find((w) => w.contains(a.content))!.style.zIndex);
    const zB = Number(windows.find((w) => w.contains(b.content))!.style.zIndex);
    expect(zA).toBeGreaterThan(zB);
  });

  it('setTitle updates the titlebar text', () => {
    const wm = createWindowManager(root, bus);
    const win = wm.open(opts('Original'));
    win.setTitle('Renamed');
    const titleEl = root.querySelector('.faisal-titlebar-title');
    expect(titleEl?.textContent).toBe('Renamed');
  });

  it('moves focus to the next window when the focused one closes or minimizes', () => {
    const wm = createWindowManager(root, bus);
    const a = wm.open(opts('A'));
    const b = wm.open(opts('B'));
    const c = wm.open(opts('C'));
    expect(wm.focused()).toBe(c);
    c.close();
    expect(wm.focused()).toBe(b);
    wm.minimize(b.id);
    expect(wm.isMinimized(b.id)).toBe(true);
    expect(wm.focused()).toBe(a);
    wm.minimize(a.id);
    expect(wm.focused()).toBeUndefined();
    b.focus(); // focusing restores a minimized window
    expect(wm.isMinimized(b.id)).toBe(false);
    expect(wm.focused()).toBe(b);
  });

  it('lists windows bottom to top and emits window:change on state changes', () => {
    const wm = createWindowManager(root, bus);
    const changes: string[] = [];
    bus.on('window:change', ({ windowId }) => changes.push(windowId));
    const a = wm.open(opts('A'));
    const b = wm.open(opts('B'));
    a.focus();
    expect(wm.list().map((w) => w.id)).toEqual([b.id, a.id]);
    wm.toggleMaximize(a.id);
    wm.minimize(b.id);
    a.close();
    expect(changes).toEqual([a.id, b.id, a.id]);
  });

  it('reopens an app with its last saved size and maximized state', () => {
    localStorage.removeItem('faisal.wm.geometry.v1');
    const wm = createWindowManager(root, bus);
    const a = wm.open({ ...opts('A'), width: 500, height: 300 });
    wm.toggleMaximize(a.id);
    a.close();
    const saved = JSON.parse(localStorage.getItem('faisal.wm.geometry.v1')!);
    expect(saved['org.faisal.Test']).toMatchObject({ width: 500, height: 300, maximized: true });
    const again = wm.open(opts('A'));
    const el = [...root.querySelectorAll<HTMLElement>('.faisal-window')].find((w) => w.contains(again.content))!;
    expect(el.classList.contains('is-maximized')).toBe(true);
  });

  it('ignores corrupt saved geometry', () => {
    localStorage.setItem('faisal.wm.geometry.v1', '{"org.faisal.Test":{"left":"x"},"__proto__":{"polluted":1}}');
    const wm = createWindowManager(root, bus);
    expect(() => wm.open(opts('A'))).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('asks the close guard before a user close, but not for close()', async () => {
    const wm = createWindowManager(root, bus);
    const win = wm.open(opts('A'));
    let allow = false;
    win.setCloseGuard(() => allow);
    const btn = () => [...root.querySelectorAll<HTMLElement>('.faisal-window')].find((w) => w.contains(win.content))?.querySelector<HTMLButtonElement>('.faisal-win-close');
    btn()!.click();
    await Promise.resolve();
    expect(wm.get(win.id)).toBe(win); // guard said no
    allow = true;
    btn()!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(wm.get(win.id)).toBeUndefined();
    const other = wm.open(opts('B'));
    other.setCloseGuard(() => false);
    other.close(); // programmatic close is never blocked
    expect(wm.get(other.id)).toBeUndefined();
  });
});

// Device policy wiring (Phase 6). jsdom has no matchMedia, so without a stub the shell is a
// fine-pointer device and these tests would silently pass; each one stubs the media query.
describe('window manager on a coarse (touch) pointer', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  let root: HTMLElement;
  let bus: EventBus;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
    bus = createBus();
  });
  afterEach(() => restoreMatchMedia(original));

  const elFor = (win: { content: HTMLElement }): HTMLElement =>
    [...root.querySelectorAll<HTMLElement>('.faisal-window')].find((w) => w.contains(win.content))!;

  it('fills the screen on a coarse pointer even when the surface is desktop-wide', () => {
    const fine = createWindowManager(root, bus);
    const floating = fine.open(opts('Fine'));
    expect(window.innerWidth).toBeGreaterThanOrEqual(700); // the surface itself is not narrow
    expect(elFor(floating).classList.contains('is-maximized')).toBe(false);

    stubPointer(true);
    const touch = createWindowManager(root, bus);
    const filled = touch.open(opts('Touch'));
    expect(elFor(filled).classList.contains('is-maximized')).toBe(true);
  });

  it('creates zero resize grips for a window opened on a coarse pointer', () => {
    stubPointer(true);
    const wm = createWindowManager(root, bus);
    const win = wm.open(opts('Touch'));
    expect(elFor(win).querySelectorAll('.faisal-resize-handle')).toHaveLength(0);
  });

  it('still creates the eight resize grips for a fine pointer', () => {
    stubPointer(false);
    const wm = createWindowManager(root, bus);
    const win = wm.open(opts('Mouse'));
    expect(elFor(win).querySelectorAll('.faisal-resize-handle')).toHaveLength(8);
  });

  it('adapts when the pointer kind changes: a pointerless tablet opens floating', async () => {
    const media = stubPointerChange();
    const wm = createWindowManager(root, bus);
    expect(media.liveListeners()).toBe(1); // watchPointerKind is registered

    const win = wm.open(opts('Tablet'));
    expect(elFor(win).classList.contains('is-maximized')).toBe(false);

    media.emit(true); // a finger touches the screen: windows must fill it
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(elFor(win).classList.contains('is-maximized')).toBe(true);

    media.emit(false); // the mouse comes back: auto-maximize is undone
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(elFor(win).classList.contains('is-maximized')).toBe(false);
  });
});
