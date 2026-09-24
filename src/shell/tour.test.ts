import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettings } from '../kernel/settings';
import type { EventBus } from '../kernel/types';
import { setLocale } from '../kernel/i18n';
import { escapeLayerCount } from './esc';
import {
  arrowAction, availableSteps, createTour, hasSeenTour, markTourSeen, placeTip, resetTour,
  SPOT_PAD, tourFlagKey, type TourHandle, type TourStep, type TourStore,
} from './tour';

/**
 * The shared first-run tour — the promises it makes to the owner.
 *
 * The geometry is tested as pure maths (the ONLY way to be sure the tip stays inside a 320px
 * window is to run the numbers at 320px, which jsdom cannot lay out), and the component is then
 * driven for real in jsdom: the step sequence, the "seen once" flag, the "?" replay, the focus
 * trap and the fact that a closed tour leaves nothing behind — no overlay, no listener, no
 * blocked app.
 */

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const rect = (top: number, left: number, width: number, height: number) => ({ top, left, width, height });

/** `sys.settings` is the real thing here: the flag keys must pass its own key rule. */
function realStore(): TourStore {
  const bus: EventBus = { on: () => () => {}, emit: () => {} };
  return createSettings(bus);
}

function memoryStore(): TourStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string, fallback: T): T => (data.has(key) ? (data.get(key) as T) : fallback),
    set: (key, value) => { data.set(key, value); },
  };
}

const STEPS: TourStep[] = [
  { target: '#a', title: 'العنوان أ', body: 'الشرح أ' },
  { target: '#b', title: 'العنوان ب', body: 'الشرح ب' },
  { title: 'العنوان ج', body: 'الشرح ج' },
];

function makeHost(width = 1280, height = 800): HTMLElement {
  const host = document.createElement('div');
  host.className = 'faisal-window-content';
  document.body.append(host);
  Object.defineProperty(host, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(host, 'clientHeight', { value: height, configurable: true });
  host.getBoundingClientRect = () => domRect(0, 0, width, height);
  return host;
}

function domRect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top, left, width, height, x: left, y: top,
    right: left + width, bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Gives an element a real box in jsdom, where every measurement is otherwise zero. */
function stubBox(el: Element, box: { top: number; left: number; width: number; height: number }): void {
  (el as HTMLElement).getBoundingClientRect = () => domRect(box.top, box.left, box.width, box.height);
}

function addTarget(host: HTMLElement, id: string, box: { top: number; left: number; width: number; height: number }): HTMLElement {
  const node = document.createElement('button');
  node.id = id;
  host.append(node);
  stubBox(node, box);
  return node;
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

const overlayIn = (host: HTMLElement): HTMLElement | null => host.querySelector('.faisal-tour-overlay');
const tipIn = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('.faisal-tour-tip')!;
const btn = (host: HTMLElement, cls: string): HTMLButtonElement => host.querySelector<HTMLButtonElement>(cls)!;

/** Every handle a test builds, so a half-finished tour cannot leak into the next test. */
const opened: TourHandle[] = [];
function track(tour: TourHandle): TourHandle {
  opened.push(tour);
  return tour;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dir = 'ltr';
  setLocale('en');
});

afterEach(() => {
  for (const tour of opened) tour.dispose();
  opened.length = 0;
  document.body.textContent = '';
  document.documentElement.dir = 'ltr';
  setLocale('ar');
});

/* ─────────────────────────────── the flag ─────────────────────────────── */

describe('the "seen once" flag', () => {
  it('is off until the tour is finished or skipped, and can be turned back on', () => {
    const store = realStore();
    expect(hasSeenTour(store, 'org.faisal.Video')).toBe(false);
    markTourSeen(store, 'org.faisal.Video');
    expect(hasSeenTour(store, 'org.faisal.Video')).toBe(true);
    resetTour(store, 'org.faisal.Video');
    expect(hasSeenTour(store, 'org.faisal.Video')).toBe(false);
  });

  it('keeps one flag per app', () => {
    const store = realStore();
    markTourSeen(store, 'org.faisal.Office');
    expect(hasSeenTour(store, 'org.faisal.Office')).toBe(true);
    expect(hasSeenTour(store, 'org.faisal.Pdf')).toBe(false);
    expect(hasSeenTour(store, 'org.faisal.Photo')).toBe(false);
  });

  it('produces a key the settings store accepts (it throws on anything else)', () => {
    for (const appId of ['org.faisal.Office', 'org.faisal.Pdf', 'org.faisal.Photo', 'org.faisal.Video']) {
      const key = tourFlagKey(appId);
      expect(key).toBe(`tour.seen.${appId}`);
      expect(key.length).toBeLessThanOrEqual(64);
      const store = realStore();
      expect(() => store.set(key, true)).not.toThrow();
    }
  });
});

/* ───────────────────────────── the placement ───────────────────────────── */

describe('placeTip', () => {
  const window390 = rect(0, 0, 390, 844);
  const tip = { width: 374, height: 168 };

  it('centres the tip, inside the window, when there is nothing to point at', () => {
    const out = placeTip({ target: null, tip: { width: 300, height: 160 }, bounds: window390 });
    expect(out.spot).toBeNull();
    expect(out.arrow).toBeNull();
    expect(out.left).toBeGreaterThanOrEqual(8);
    expect(out.left + 300).toBeLessThanOrEqual(390 - 8);
    expect(out.top).toBeGreaterThanOrEqual(8);
    expect(out.top + 160).toBeLessThanOrEqual(844 - 8);
  });

  it('points at a control low in the window from above, and stays inside', () => {
    const out = placeTip({ target: rect(560, 8, 374, 44), tip, bounds: window390 });
    expect(out.side).toBe('above');
    expect(out.fits).toBe(true);
    expect(out.top + tip.height).toBeLessThanOrEqual(560);
    expect(out.top).toBeGreaterThanOrEqual(8);
    // The arrow lines up with the middle of the control it points at.
    expect(out.arrow?.axis).toBe('x');
    expect(out.left + out.arrow!.offset).toBeCloseTo(8 + 374 / 2, 0);
  });

  it('aims the arrow at an off-centre control', () => {
    const out = placeTip({ target: rect(600, 400, 100, 44), tip: { width: 300, height: 168 }, bounds: rect(0, 0, 1280, 800) });
    expect(out.side).toBe('above');
    expect(out.fits).toBe(true);
    expect(out.arrow!.axis).toBe('x');
    expect(out.left + out.arrow!.offset).toBeCloseTo(450, 0);
  });

  it('points at the top app bar from below', () => {
    const out = placeTip({ target: rect(0, 0, 390, 44), tip, bounds: window390 });
    expect(out.side).toBe('below');
    expect(out.top).toBe(44 + 8);
  });

  it('moves to the side of a tall panel instead of covering it', () => {
    const out = placeTip({ target: rect(0, 0, 260, 800), tip: { width: 300, height: 160 }, bounds: rect(0, 0, 1280, 800) });
    expect(out.side).toBe('right');
    expect(out.left).toBe(260 + 8);
    expect(out.arrow?.axis).toBe('y');
  });

  it('stays inside a 320x640 window with a full-width bottom bar (the phone case)', () => {
    const bounds = rect(0, 0, 320, 640);
    const out = placeTip({ target: rect(596, 0, 320, 44), tip: { width: 304, height: 200 }, bounds });
    expect(out.fits).toBe(true);
    expect(out.top).toBeGreaterThanOrEqual(8);
    expect(out.top + 200).toBeLessThanOrEqual(640 - 8);
    expect(out.left).toBeGreaterThanOrEqual(8);
    expect(out.left + 304).toBeLessThanOrEqual(320 - 8);
  });

  it('clamps into the window when no side has room, and drops the arrow', () => {
    const bounds = rect(0, 0, 320, 200);
    const out = placeTip({ target: rect(160, 0, 320, 40), tip: { width: 300, height: 168 }, bounds });
    expect(out.fits).toBe(false);
    expect(out.arrow).toBeNull();
    expect(out.top).toBeGreaterThanOrEqual(8);
    expect(out.top + 168).toBeLessThanOrEqual(200 - 8);
    expect(out.left).toBeGreaterThanOrEqual(8);
    expect(out.left + 300).toBeLessThanOrEqual(320 - 8);
  });

  it('clips the spotlight hole to the window', () => {
    const bounds = rect(0, 0, 390, 844);
    const out = placeTip({ target: rect(2, 0, 390, 44), tip, bounds });
    // The control touches three edges, so the padded hole is cut back to the window box:
    // y from -4..52 becomes 0..52, x from -6..396 becomes 0..390.
    expect(out.spot).toEqual({ top: 0, left: 0, width: 390, height: 52 });
  });

  it('never places the tip outside the window, whatever the target is', () => {
    const bounds = rect(0, 0, 320, 640);
    for (const target of [rect(-40, -40, 60, 60), rect(600, 0, 320, 44), rect(300, 300, 20, 20), rect(10, 10, 1, 1)]) {
      const out = placeTip({ target, tip: { width: 304, height: 180 }, bounds });
      expect(out.top, JSON.stringify(target)).toBeGreaterThanOrEqual(8);
      expect(out.left, JSON.stringify(target)).toBeGreaterThanOrEqual(8);
      expect(out.top + 180, JSON.stringify(target)).toBeLessThanOrEqual(640 - 8);
      expect(out.left + 304, JSON.stringify(target)).toBeLessThanOrEqual(320 - 8);
    }
  });

  it('treats a control that is entirely off-screen as no anchor at all', () => {
    const out = placeTip({ target: rect(-300, -300, 100, 40), tip, bounds: rect(0, 0, 390, 844) });
    expect(out.spot).toBeNull();
    expect(out.arrow).toBeNull();
  });
});

/* ───────────────────────────── the step list ───────────────────────────── */

describe('the step list', () => {
  it('drops a step whose control is not in this window', () => {
    const host = makeHost();
    addTarget(host, 'a', rect(0, 0, 40, 40));
    // #b is not here (its panel is closed), and the third step has no target at all so it stays.
    expect(availableSteps(host, STEPS).map((s) => s.title)).toEqual(['العنوان أ', 'العنوان ج']);
  });

  it('drops every targeted step when the chrome is not built yet', () => {
    const host = makeHost();
    expect(availableSteps(host, STEPS).map((s) => s.title)).toEqual(['العنوان ج']);
  });

  it('keeps a step that has no target (a centred tip)', () => {
    const host = makeHost();
    expect(availableSteps(host, [{ title: 't', body: 'b' }])).toHaveLength(1);
  });

  it('follows the reading direction for the arrow keys', () => {
    expect(arrowAction('ArrowRight', false)).toBe('next');
    expect(arrowAction('ArrowLeft', false)).toBe('back');
    expect(arrowAction('ArrowRight', true)).toBe('back');
    expect(arrowAction('ArrowLeft', true)).toBe('next');
    expect(arrowAction('PageDown', false)).toBe('next');
    expect(arrowAction('Enter', false)).toBeNull();
  });
});

/* ────────────────────────────── the component ────────────────────────────── */

interface Setup {
  host: HTMLElement;
  store: TourStore & { data: Map<string, unknown> };
  onEnd: ReturnType<typeof vi.fn>;
  tour: ReturnType<typeof createTour>;
}

function setup(width = 1280, height = 800, steps: readonly TourStep[] = STEPS, appId = 'org.faisal.Video'): Setup {
  const host = makeHost(width, height);
  addTarget(host, 'a', rect(0, 0, 120, 44));
  addTarget(host, 'b', rect(height - 60, 0, width, 44));
  const store = memoryStore();
  const onEnd = vi.fn();
  const tour = track(createTour({ appId, host, store, steps, onEnd }));
  return { host, store, onEnd, tour };
}

describe('the tour component', () => {
  it('starts on its own the first time and walks through the steps', async () => {
    const { host, tour } = setup();
    expect(overlayIn(host)).toBeNull();
    tour.autoStart();
    await tick();
    expect(tour.isOpen()).toBe(true);
    expect(overlayIn(host)).not.toBeNull();
    expect(host.querySelector('.faisal-tour-title')!.textContent).toBe('العنوان أ');
    expect(btn(host, '.faisal-tour-count').textContent).toBe('Step 1 of 3');
    expect(btn(host, '.faisal-tour-btn.is-plain').textContent).toBe('Skip');
    expect(btn(host, '.faisal-tour-btn:not(.is-plain):not(.is-primary)').disabled).toBe(true);

    btn(host, '.faisal-tour-btn.is-primary').click();
    expect(host.querySelector('.faisal-tour-title')!.textContent).toBe('العنوان ب');
    expect(btn(host, '.faisal-tour-count').textContent).toBe('Step 2 of 3');
    expect(btn(host, '.faisal-tour-btn:not(.is-plain):not(.is-primary)').disabled).toBe(false);

    btn(host, '.faisal-tour-btn.is-primary').click();
    expect(host.querySelector('.faisal-tour-title')!.textContent).toBe('العنوان ج');
    expect(btn(host, '.faisal-tour-btn.is-primary').textContent).toBe('Done');
  });

  it('goes back a step', () => {
    const { host, tour } = setup();
    tour.autoStart();
    btn(host, '.faisal-tour-btn.is-primary').click();
    btn(host, '.faisal-tour-btn:not(.is-plain):not(.is-primary)').click();
    expect(host.querySelector('.faisal-tour-title')!.textContent).toBe('العنوان أ');
  });

  it('marks the app seen on the last step and never comes back by itself', async () => {
    const { host, store, onEnd, tour } = setup();
    tour.autoStart();
    btn(host, '.faisal-tour-btn.is-primary').click();
    btn(host, '.faisal-tour-btn.is-primary').click();
    btn(host, '.faisal-tour-btn.is-primary').click(); // Done
    expect(overlayIn(host)).toBeNull();
    expect(tour.isOpen()).toBe(false);
    expect(onEnd).toHaveBeenCalledWith('finished');
    expect(hasSeenTour(store, 'org.faisal.Video')).toBe(true);

    // A fresh launch of the same app does not show it again.
    const again = track(createTour({ appId: 'org.faisal.Video', host, store, steps: STEPS }));
    again.autoStart();
    expect(again.isOpen()).toBe(false);
    expect(overlayIn(host)).toBeNull();
  });

  it('marks the app seen when the owner skips', () => {
    const { host, store, onEnd, tour } = setup();
    tour.autoStart();
    btn(host, '.faisal-tour-btn.is-plain').click();
    expect(overlayIn(host)).toBeNull();
    expect(onEnd).toHaveBeenCalledWith('skipped');
    expect(hasSeenTour(store, 'org.faisal.Video')).toBe(true);
  });

  it('marks the app seen when the tour is closed with × or with Escape', () => {
    const first = setup();
    first.tour.autoStart();
    btn(first.host, '.faisal-tour-x').click();
    expect(hasSeenTour(first.store, 'org.faisal.Video')).toBe(true);
    expect(escapeLayerCount()).toBe(0);

    const second = setup();
    second.tour.autoStart();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlayIn(second.host)).toBeNull();
    expect(hasSeenTour(second.store, 'org.faisal.Video')).toBe(true);
    expect(escapeLayerCount()).toBe(0);
  });

  it('replays on demand from the "?" button, whatever the flag says', async () => {
    const { host, store, tour } = setup();
    markTourSeen(store, 'org.faisal.Video');
    const help = tour.helpButton({ className: 'app-tool' });
    host.append(help);
    expect(help.className).toContain('faisal-tour-help');
    expect(help.className).toContain('app-tool');
    expect(help.getAttribute('aria-label')).toBeTruthy();
    expect(help.title).toBe(help.getAttribute('aria-label'));

    tour.autoStart();
    expect(tour.isOpen()).toBe(false);

    help.focus();
    help.click();
    await tick();
    expect(tour.isOpen()).toBe(true);
    expect(overlayIn(host)).not.toBeNull();

    // Closing returns focus to the "?" that opened it, and replay works again.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.activeElement).toBe(help);
    help.click();
    expect(tour.isOpen()).toBe(true);
  });

  it('leaves nothing behind when it is closed: no overlay, no escape layer, no blocked app', () => {
    const { host, tour } = setup();
    const before = host.childElementCount;
    tour.autoStart();
    expect(host.childElementCount).toBe(before + 1);
    expect(escapeLayerCount()).toBe(1);
    btn(host, '.faisal-tour-btn.is-plain').click();
    expect(host.childElementCount).toBe(before);
    expect(host.querySelector('.faisal-tour-overlay')).toBeNull();
    expect(escapeLayerCount()).toBe(0);
  });

  it('does not start when the app has nothing to point at, and keeps the flag off', () => {
    const host = makeHost();
    const store = memoryStore();
    const tour = track(createTour({
      appId: 'org.faisal.Pdf', host, store,
      steps: [{ target: '#missing', title: 't', body: 'b' }],
    }));
    tour.autoStart();
    expect(tour.isOpen()).toBe(false);
    expect(overlayIn(host)).toBeNull();
    expect(hasSeenTour(store, 'org.faisal.Pdf')).toBe(false);
  });

  it('leaves the flag alone when the window goes away mid-tour', () => {
    const { host, store, tour } = setup();
    tour.autoStart();
    tour.dispose();
    expect(overlayIn(host)).toBeNull();
    expect(escapeLayerCount()).toBe(0);
    expect(hasSeenTour(store, 'org.faisal.Video')).toBe(false);
  });

  it('does not open twice at once (two windows of one app)', () => {
    const { host, tour } = setup();
    tour.autoStart();
    tour.replay();
    expect(host.querySelectorAll('.faisal-tour-overlay')).toHaveLength(1);
  });

  it('reads the step list again on every open, so a rebuilt chrome is picked up', () => {
    const host = makeHost();
    addTarget(host, 'a', rect(0, 0, 40, 40));
    const store = memoryStore();
    const lists: TourStep[][] = [
      [{ target: '#a', title: 'واحد', body: 'أ' }],
      [{ target: '#a', title: 'واحد', body: 'أ' }, { title: 'اثنان', body: 'ب' }],
    ];
    let call = 0;
    const tour = track(createTour({ appId: 'org.faisal.Photo', host, store, steps: () => lists[Math.min(call++, 1)] }));
    tour.autoStart();
    expect(btn(host, '.faisal-tour-count').textContent).toBe('Step 1 of 1');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    tour.replay();
    expect(btn(host, '.faisal-tour-count').textContent).toBe('Step 1 of 2');
  });

  it('anchors the spotlight on the real control and keeps the tip inside the window', () => {
    const host = makeHost(390, 844);
    addTarget(host, 'a', rect(10, 20, 100, 44));
    addTarget(host, 'b', rect(756, 0, 390, 44));
    const store = memoryStore();
    const tour = track(createTour({ appId: 'org.faisal.Photo', host, store, steps: STEPS }));
    tour.autoStart();

    const spot = host.querySelector<HTMLElement>('.faisal-tour-spot')!;
    expect(spot.hidden).toBe(false);
    expect(spot.style.top).toBe(`${10 - SPOT_PAD}px`);
    expect(spot.style.left).toBe(`${20 - SPOT_PAD}px`);
    expect(spot.style.width).toBe(`${100 + SPOT_PAD * 2}px`);

    const tip = tipIn(host);
    expect(tip.dataset.ready).toBe('true');
    expect(tip.dataset.side).toBe('below');
    // The tip sits just under the control (10 + 44 + 8), never over it.
    expect(tip.style.top).toBe('62px');
    // jsdom has no layout, so the component falls back to a 300px-wide tip — still inside 390.
    expect(parseFloat(tip.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(tip.style.left) + 300).toBeLessThanOrEqual(390 - 8);

    // Second step: the control is at the bottom of the phone window, so the tip flips above it.
    btn(host, '.faisal-tour-btn.is-primary').click();
    expect(tip.dataset.side).toBe('above');
    expect(tip.style.top).toBe(`${756 - 8 - 168}px`);
    expect(parseFloat(tip.style.top)).toBeGreaterThanOrEqual(8);
  });

  it('shows a centred tip with a full dim when a step has no target', () => {
    const host = makeHost(390, 844);
    const store = memoryStore();
    const tour = track(createTour({ appId: 'org.faisal.Pdf', host, store, steps: [{ title: 't', body: 'b' }] }));
    tour.autoStart();
    expect(host.querySelector<HTMLElement>('.faisal-tour-spot')!.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>('.faisal-tour-dim')!.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>('.faisal-tour-arrow')!.hidden).toBe(true);
  });

  it('advances when the dimmed area is tapped, but not when the tip is', () => {
    const { host, tour } = setup();
    tour.autoStart();
    const tip = tipIn(host);
    tip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.querySelector('.faisal-tour-title')!.textContent).toBe('العنوان أ');
    host.querySelector('.faisal-tour-dim')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.querySelector('.faisal-tour-title')!.textContent).toBe('العنوان ب');
  });

  it('drives the steps with the arrow keys, mirrored in Arabic', () => {
    const { host, tour } = setup();
    tour.autoStart();
    const tip = tipIn(host);
    document.documentElement.dir = 'rtl';
    tip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(host.querySelector('.faisal-tour-title')!.textContent).toBe('العنوان ب');
    tip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(host.querySelector('.faisal-tour-title')!.textContent).toBe('العنوان أ');
  });

  it('keeps the app from acting on keys pressed while the tour is open', () => {
    const { host, tour } = setup();
    tour.autoStart();
    const appSaw: string[] = [];
    const spy = (ev: KeyboardEvent): void => { appSaw.push(ev.key); };
    window.addEventListener('keydown', spy);
    const contentSaw: string[] = [];
    host.addEventListener('keydown', (ev) => { contentSaw.push(ev.key); });
    try {
      tipIn(host).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      tipIn(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Space', code: 'Space', bubbles: true }));
      tipIn(host).dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    } finally {
      window.removeEventListener('keydown', spy);
    }
    expect(appSaw).toEqual([]);
    expect(contentSaw).toEqual([]);
  });

  it('traps Tab inside the tip', () => {
    const { host, tour } = setup();
    tour.autoStart();
    const tip = tipIn(host);
    const last = btn(host, '.faisal-tour-btn.is-primary');
    last.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    tip.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(btn(host, '.faisal-tour-x'));
  });

  it('focuses the tip when it opens so the step is announced', async () => {
    const { host, tour } = setup();
    tour.autoStart();
    await tick();
    expect(document.activeElement).toBe(tipIn(host));
    expect(tipIn(host).getAttribute('role')).toBe('dialog');
    expect(tipIn(host).getAttribute('aria-labelledby')).toBe(host.querySelector('.faisal-tour-title')!.id);
  });

  it('hides Skip and Back on a one-step tour', () => {
    const host = makeHost();
    addTarget(host, 'a', rect(0, 0, 40, 40));
    const store = memoryStore();
    const tour = track(createTour({ appId: 'org.faisal.Office', host, store, steps: [{ target: '#a', title: 't', body: 'b' }] }));
    tour.autoStart();
    expect(btn(host, '.faisal-tour-btn.is-plain').hidden).toBe(true);
    expect(btn(host, '.faisal-tour-btn:not(.is-plain):not(.is-primary)').hidden).toBe(true);
    expect(btn(host, '.faisal-tour-btn.is-primary').textContent).toBe('Done');
  });

  it('uses the shell chrome labels with the step text the app supplies', async () => {
    setLocale('ar');
    const { host, tour } = setup();
    tour.autoStart();
    expect(btn(host, '.faisal-tour-btn.is-plain').textContent).toBe('تخطي');
    expect(btn(host, '.faisal-tour-btn.is-primary').textContent).toBe('التالي');
    expect(btn(host, '.faisal-tour-count').textContent).toBe('الخطوة 1 من 3');
    expect(host.querySelector('.faisal-tour-title')!.textContent).toBe('العنوان أ');
  });
});
