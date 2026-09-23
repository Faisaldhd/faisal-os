import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppContext, SystemAPI, WindowHandle, WindowManager } from '../../kernel/types';
import { setLocale, t } from '../../kernel/i18n';
import app from './index';

/**
 * Component-level checks for the System tab and the FPS visibility fix: the pure
 * collector has its own suite, but these assertions only hold once the app is mounted.
 */

function fakeWindowHandle(content: HTMLElement): WindowHandle {
  return {
    id: 'win-1',
    appId: 'org.faisal.SystemMonitor',
    content,
    setTitle: () => {},
    focus: () => {},
    close: () => {},
    onClose: () => () => {},
    requestClose: async () => {},
    setCloseGuard: () => {},
    onResize: () => () => {},
  };
}

function mountMonitor(): { ctx: AppContext; content: HTMLElement; closed: () => void } {
  const content = document.createElement('div');
  document.body.appendChild(content);
  const windowHandle = fakeWindowHandle(content);
  const closeCallbacks: Array<() => void> = [];
  windowHandle.onClose = (cb: () => void) => {
    closeCallbacks.push(cb);
    return () => {};
  };
  const wm = {
    list: () => [windowHandle],
    open: () => windowHandle,
    get: () => windowHandle,
    focused: () => windowHandle,
    isMinimized: () => false,
    minimize: () => {},
    toggleMaximize: () => {},
  } as unknown as WindowManager;
  const sys = {
    bus: { on: () => () => {}, emit: () => {} },
    vfs: { readdir: async () => [] } as unknown as SystemAPI['vfs'],
    wm,
    apps: {
      running: () => [{ appId: 'org.faisal.SystemMonitor', windowId: 'win-1', startedAt: Date.now() }],
      catalog: () => [],
    } as unknown as SystemAPI['apps'],
    settings: { get: <T,>(_k: string, f: T) => f, set: () => {} },
    locale: () => 'en' as const,
    t,
    notify: () => {},
  } as unknown as SystemAPI;

  const ctx: AppContext = { sys, window: windowHandle, args: [] };
  app.launch(ctx);
  return { ctx, content, closed: () => closeCallbacks.forEach((cb) => cb()) };
}

/** Tabs are positional, so the helper cannot depend on the active locale. */
const TAB_INDEX = { processes: 0, resources: 1, filesystems: 2, system: 3 } as const;

/**
 * The heap card and the FPS card share the `.faisal-mon-chart-*` classes, so a plain
 * `querySelector` on the content returns the heap's cells. Scope the query to the FPS card.
 */
function fpsCardParts(content: HTMLElement): { status: HTMLElement | null; value: HTMLElement | null } {
  const cards = [...content.querySelectorAll<HTMLElement>('.faisal-mon-chart-card')];
  const card = cards.find((c) => (c.textContent ?? '').includes(t('monitor.fps'))) ?? null;
  return {
    status: card?.querySelector<HTMLElement>('.faisal-mon-chart-status') ?? null,
    value: card?.querySelector<HTMLElement>('.faisal-mon-chart-value') ?? null,
  };
}

function clickTab(content: HTMLElement, name: keyof typeof TAB_INDEX): void {
  const buttons = [...content.querySelectorAll<HTMLButtonElement>('.faisal-mon-tab')];
  const btn = buttons[TAB_INDEX[name]];
  if (!btn) throw new Error(`no tab button ${name}`);
  btn.click();
}

/** jsdom ships no ResizeObserver, and the app observes its body element. */
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** jsdom reports document.hidden === true; the app must be mounted in a visible document. */
let hiddenState = false;

beforeEach(() => {
  // Clean-up first: a previous test's stubs must not survive into this one.
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // jsdom has no canvas backend; the chart's getContext must not throw the render off.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  hiddenState = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hiddenState);
  setLocale('en');
});

afterEach(() => {
  setLocale('ar');
  document.body.replaceChildren();
});

describe('System Monitor — System tab', () => {
  it('renders the always-available rows with real values and never a placeholder', async () => {
    const { content } = mountMonitor();
    clickTab(content, 'system');
    await vi.waitFor(() => {
      expect(content.querySelectorAll('.faisal-mon-sys-value').length).toBeGreaterThan(0);
    });
    const values = [...content.querySelectorAll<HTMLElement>('.faisal-mon-sys-value')].map((el) => el.textContent ?? '');
    // apps/windows and the viewport are supplied by the app itself, so they must be real
    expect(values.some((v) => /^\d+ \/ \d+$/.test(v))).toBe(true);
    expect(values.some((v) => /^\d+ × \d+ px$/.test(v))).toBe(true);
    for (const v of values) {
      expect(v).not.toBe('0');
      expect(v.trim()).not.toBe('');
    }
  });

  it('labels every field jsdom cannot provide with the explicit unavailable string', async () => {
    const { content } = mountMonitor();
    clickTab(content, 'system');
    await vi.waitFor(() => {
      expect(content.querySelectorAll('.faisal-mon-sys-value').length).toBeGreaterThan(0);
    });
    const unavailable = [...content.querySelectorAll<HTMLElement>('.faisal-mon-sys-value.is-unavailable')];
    expect(unavailable.length).toBeGreaterThan(0);
    for (const el of unavailable) expect(el.textContent).toBe(t('monitor.unavailable'));
    // jsdom exposes neither of these Chromium-only APIs, so both must say so.
    const notes = [...content.querySelectorAll<HTMLElement>('.faisal-mon-sys-note')].map((el) => el.textContent ?? '');
    expect(notes.some((n) => n.includes('userAgentData'))).toBe(true);
  });

  it('shows the honesty note about temperature, fans and hardware memory', async () => {
    const { content } = mountMonitor();
    clickTab(content, 'system');
    await vi.waitFor(() => {
      expect(content.querySelector('.faisal-mon-honesty-title')).not.toBeNull();
    });
    const body = content.querySelector<HTMLElement>('.faisal-mon-honesty-body');
    const title = content.querySelector<HTMLElement>('.faisal-mon-honesty-title');
    expect(title?.textContent).toBe(t('monitor.systemHonestyTitle'));
    expect(body?.textContent).toMatch(/temperature/i);
    expect(body?.textContent).toMatch(/fan speed/i);
    expect(body?.textContent).toMatch(/hardware memory/i);
    // the toggle reveals the other language in place
    const toggle = content.querySelector<HTMLButtonElement>('.faisal-mon-honesty-lang');
    expect(toggle?.textContent).toBe('العربية');
    toggle?.click();
    expect(content.querySelector<HTMLElement>('.faisal-mon-honesty-body')?.textContent).toMatch(/حرارة المعالج/);
    expect(content.querySelector<HTMLElement>('.faisal-mon-honesty-body')?.getAttribute('dir')).toBe('rtl');
  });
});

describe('System Monitor — FPS and heap honesty', () => {
  // The FPS pause/resume *decision* is a pure function with its own deterministic
  // suite; jsdom cannot run a real rAF clock, so only the DOM wiring is asserted here.
  it('paints the paused state when the document becomes hidden and clears it on resume', () => {
    const { content, closed } = mountMonitor();
    clickTab(content, 'resources');
    // `.faisal-mon-chart-status` also exists on the heap card, so scope to the FPS card.
    const { status, value } = fpsCardParts(content);
    expect(status).not.toBeNull();
    expect(status?.classList.contains('is-paused')).toBe(false);
    expect(status?.textContent).toBe(t('monitor.fpsMeasuring'));

    hiddenState = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(status?.classList.contains('is-paused')).toBe(true);
    expect(status?.textContent).toBe(t('monitor.fpsPaused'));
    expect(value?.textContent).toBe('—');

    hiddenState = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(status?.classList.contains('is-paused')).toBe(false);
    expect(status?.textContent).toBe(t('monitor.fpsMeasuring'));

    closed();
  });

  it('shows the explicit unavailable string for the heap when performance.memory is absent', () => {
    const { content } = mountMonitor();
    clickTab(content, 'resources');
    const heapValue = content.querySelector<HTMLElement>('.faisal-mon-chart-value');
    const charts = [...content.querySelectorAll<HTMLElement>('.faisal-mon-chart-card')];
    const heapCard = charts.find((c) => c.textContent?.includes(t('monitor.heap')));
    expect(heapCard).toBeDefined();
    expect(heapValue?.textContent).toBe(t('monitor.heapUnavailable'));
    // no page-heap note may be claimed when there is no heap figure at all
    expect(heapCard?.textContent).not.toContain(t('monitor.heapNotePageOnly'));
  });

  it('releases the fps loop, interval, observer and listeners when the window closes', () => {
    const cancel = vi.fn();
    const disconnect = vi.fn();
    // stub before mounting: the app resolves these globals at launch
    vi.stubGlobal('cancelAnimationFrame', cancel);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      },
    );
    const clearSpy = vi.spyOn(window, 'clearInterval');

    const { content, closed } = mountMonitor();
    clickTab(content, 'resources');
    // the visibility listener is only reachable while the window is mounted
    hiddenState = true;
    document.dispatchEvent(new Event('visibilitychange'));
    const { status } = fpsCardParts(content);
    expect(status?.classList.contains('is-paused')).toBe(true);

    closed();
    expect(cancel).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();

    // after the close the listener must be gone: toggling visibility changes nothing
    hiddenState = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(status?.classList.contains('is-paused')).toBe(true);
  });
});
