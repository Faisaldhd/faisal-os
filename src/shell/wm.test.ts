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
});
