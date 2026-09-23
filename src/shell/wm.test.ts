import { describe, it, expect, beforeEach } from 'vitest';
import { createWindowManager } from './wm';
import { createBus } from '../kernel/bus';
import type { EventBus, WindowOptions } from '../kernel/types';

function opts(title = 'Test'): WindowOptions {
  return { appId: 'org.faisal.Test', title, icon: '<svg viewBox="0 0 24 24"></svg>' };
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
