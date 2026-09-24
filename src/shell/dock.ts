import type { SystemAPI } from '../kernel/types';
import { t } from '../kernel/i18n';
import { isCompactWidth, isCoarsePointer, NARROW_BREAKPOINT } from './device';
import { renderIcon } from './icon';
import { showContextMenu, wireContextMenu } from './contextmenu';
import { appTileMenuItems, getDashIds } from './desktop';

/**
 * Always-visible dock pinned to the bottom of the desktop. It sits in the desktop's
 * flex column after the window surface, so maximized windows stop above it.
 * It shows the pinned apps (the dash list), then any running app that isn't pinned.
 * Clicking a running app raises its windows, or minimizes them if it is already in front;
 * clicking an app with no windows launches it.
 * right-click opens the same menu as in Activities (pin, desktop, details, uninstall).
 *
 * Sizing is measured, never guessed: `dockMetrics` decides from the strip's real width how big
 * a launcher may be (never below the 44px touch minimum) and how many fit. Launchers that do
 * not fit are not cropped at the ends — they move behind one "more apps" button that opens
 * Activities, where the whole grid lives. `overview.ts` uses the same helpers, so the pinned
 * dock and the Activities dock behave identically on a phone and in a narrow desktop window.
 */

/** Smallest launcher the dock ever paints: the 44px touch minimum (AGENTS.md, G8). */
export const DOCK_MIN_ITEM = 44;
/** Largest launcher with a fine pointer. */
export const DOCK_MAX_ITEM = 56;
/** Largest launcher on a finger: the painted size the touch model already used. */
export const DOCK_TOUCH_ITEM = 60;
/** Strip spacing, wide and compact. Mirrored by the `--faisal-dock-gap/pad` tokens in theme.css. */
const GAP = 10;
const GAP_COMPACT = 6;
const PAD = 16;
const PAD_COMPACT = 8;

/** The "more apps" icon: a plain ellipsis, "there is more behind me". */
const ICON_MORE =
  '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.9" fill="currentColor"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/><circle cx="19" cy="12" r="1.9" fill="currentColor"/></svg>';

export interface DockMetrics {
  /** Launcher size in CSS px. */
  size: number;
  /** How many launchers fit at that size without cropping one. */
  capacity: number;
}

/**
 * PURE: the launcher size and the launcher count that fit in `available` CSS px.
 *
 * Two modes, in this order:
 *  1. Everything fits if the launchers shrink to `fit`, as long as `fit` is still at least
 *     `min`: then all `count` launchers show at `clamp(fit, min, max)`, which is what lets the
 *     desktop strip tighten itself instead of scrolling.
 *  2. Otherwise the launchers stay at `min` (the touch minimum is not negotiable) and only
 *     `capacity` of them fit; the caller shows that many and puts the rest behind "more".
 *
 * PURE, so both docks and the tests agree on the arithmetic without a browser.
 */
export function dockMetrics(input: {
  available: number;
  count: number;
  gap: number;
  padding: number;
  min?: number;
  max?: number;
}): DockMetrics {
  const min = input.min ?? DOCK_MIN_ITEM;
  const max = Math.max(min, input.max ?? DOCK_MAX_ITEM);
  if (input.count <= 0 || input.available <= 0) return { size: max, capacity: 0 };
  const room = input.available - 2 * input.padding - input.gap * (input.count - 1);
  const fit = Math.floor(room / input.count);
  if (fit >= min) return { size: Math.min(max, fit), capacity: input.count };
  // `available = n * min + (n - 1) * gap + 2 * padding`, solved for n.
  const capacity = Math.floor((input.available - 2 * input.padding + input.gap) / (min + input.gap));
  return { size: min, capacity: Math.max(0, capacity) };
}

/**
 * PURE: which launchers the strip shows, and which ones it leaves to "more".
 *
 * While everything fits, the given order is kept exactly as it is — a launcher must never jump
 * around just because its app was launched. Only when something has to be left out do running
 * apps move to the front (they are the user's current work, and the dock is how you get back to
 * them), followed by the owner's pinned order.
 */
export function dockSelection(input: {
  ids: readonly string[];
  running: readonly string[];
  capacity: number;
}): { shown: string[]; hidden: string[] } {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of input.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  const capacity = Math.max(0, Math.floor(input.capacity));
  if (capacity >= ordered.length) return { shown: ordered, hidden: [] };
  const running = new Set(input.running);
  const ranked = [...ordered.filter((id) => running.has(id)), ...ordered.filter((id) => !running.has(id))];
  return { shown: ranked.slice(0, capacity), hidden: ranked.slice(capacity) };
}

/** The width a strip may use inside `host`, with the host's own inline padding taken off. */
function availableWidth(host: HTMLElement): number {
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(host) : null;
  const pad = style
    ? (parseFloat(style.paddingInlineStart) || 0) + (parseFloat(style.paddingInlineEnd) || 0)
    : 0;
  const width = host.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0) || NARROW_BREAKPOINT;
  return Math.max(0, width - pad);
}

/** Gap and padding the CSS uses at this width (mirrored as `--faisal-dock-gap/pad`). */
function stripSpacing(compact: boolean): { gap: number; padding: number } {
  return compact ? { gap: GAP_COMPACT, padding: PAD_COMPACT } : { gap: GAP, padding: PAD };
}

/**
 * Fits `strip` to the width it really has and publishes the result as `--faisal-dock-item`,
 * which the CSS uses for the launcher and its icon. Returns the metrics so the caller can
 * decide how many launchers to render.
 */
export function fitDockStrip(strip: HTMLElement, host: HTMLElement, count: number, compact: boolean): DockMetrics {
  const { gap, padding } = stripSpacing(compact);
  const metrics = dockMetrics({
    available: availableWidth(host),
    count,
    gap,
    padding,
    min: DOCK_MIN_ITEM,
    max: isCoarsePointer() ? DOCK_TOUCH_ITEM : DOCK_MAX_ITEM,
  });
  strip.style.setProperty('--faisal-dock-item', `${metrics.size}px`);
  return metrics;
}

/**
 * Keeps the shell's compact flag (`is-compact` on the desktop root) in step with the
 * *measured* width, and calls back whenever it changes. This is the container-query equivalent
 * for chrome that has to know how much room it has: a narrow desktop window takes the phone
 * layout too, not just a phone. Both docks call it; the flag itself is idempotent.
 *
 * Returns an unsubscribe function; a browser without ResizeObserver (jsdom) keeps the first
 * measurement, which is enough for the tests.
 */
export function watchShellWidth(root: HTMLElement, cb: (compact: boolean) => void): () => void {
  let last: boolean | null = null;
  const apply = () => {
    const width = root.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0) || NARROW_BREAKPOINT;
    const compact = isCompactWidth(width);
    if (compact !== last) {
      last = compact;
      root.classList.toggle('is-compact', compact);
    }
    cb(compact);
  };
  apply();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const obs = new ResizeObserver(apply);
  obs.observe(root);
  return () => obs.disconnect();
}

export interface DockOptions {
  /** Opens the full app list (Activities) for the launchers the strip has no room for. */
  onMore?: () => void;
}

export function mountDock(root: HTMLElement, sys: SystemAPI, opts: DockOptions = {}): HTMLElement {
  const bar = document.createElement('nav');
  bar.className = 'faisal-dock-bar';
  const dock = document.createElement('div');
  dock.className = 'faisal-dock faisal-dock-pinned faisal-dock-strip';
  bar.append(dock);
  root.append(bar);

  let compact = false;
  /** The last painted state, so a resize that changes nothing does not repaint the strip. */
  let painted = '';

  function render() {
    const { gap, padding } = stripSpacing(compact);
    const open = sys.wm.list();
    const running = new Set(open.map((w) => w.appId));
    const focusedApp = sys.wm.focused()?.appId;
    const byId = new Map(sys.apps.list().map((a) => [a.id, a] as const));
    const ids = getDashIds(sys).slice();
    for (const id of running) if (!ids.includes(id)) ids.push(id);
    // Web apps (category 'web') are deliberately kept OUT of the dock: there is one per wired
    // site, they would crowd out the real launchers on a phone, and the Activities overview has
    // a dedicated "Web Apps" group for them. Everything else keeps the previous dock behaviour.
    const visible = ids.filter((id) => byId.get(id)?.category !== 'web');
    const metrics = fitDockStrip(dock, bar, visible.length, compact);
    // "More" is a launcher too: it takes one slot, so one fewer real launcher shows.
    const overflows = visible.length > metrics.capacity;
    const needsMore = overflows && !!opts.onMore;
    const capacity = needsMore ? Math.max(0, metrics.capacity - 1) : metrics.capacity;
    const { shown } = dockSelection({ ids: visible, running: [...running], capacity });

    // Minimized/running state is part of the fingerprint: the little dot and the dimmed icon
    // must follow `window:change`, not only a change of the id list.
    const state = open.map((w) => `${w.appId}${sys.wm.isMinimized(w.id) ? '!' : ''}`).join(',');
    const key = [metrics.size, compact, shown.join(','), focusedApp ?? '', state, needsMore ? '1' : '0'].join('|');
    if (key === painted) return;
    painted = key;
    dock.style.setProperty('--faisal-dock-gap', `${gap}px`);
    dock.style.setProperty('--faisal-dock-pad', `${padding}px`);

    dock.textContent = '';
    for (const id of shown) {
      const app = byId.get(id);
      if (!app) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      const appWins = open.filter((w) => w.appId === app.id);
      const allHidden = appWins.length > 0 && appWins.every((w) => sys.wm.isMinimized(w.id));
      btn.className = 'faisal-dock-btn'
        + (running.has(app.id) ? ' is-running' : '')
        + (focusedApp === app.id ? ' is-active' : '')
        + (allHidden ? ' is-hidden' : '');
      if (focusedApp === app.id) btn.setAttribute('aria-current', 'true');
      btn.title = app.name[sys.locale()];
      btn.setAttribute('aria-label', btn.title);
      btn.append(renderIcon(app.icon));
      btn.addEventListener('click', () => {
        const wins = sys.wm.list().filter((w) => w.appId === app.id); // bottom to top
        if (!wins.length) { void sys.apps.launch(app.id); return; }
        if (sys.wm.focused()?.appId === app.id) wins.forEach((w) => sys.wm.minimize(w.id));
        else wins.forEach((w) => w.focus()); // raises all, topmost last
      });
      wireContextMenu(btn, (x, y) => {
        showContextMenu(x, y, appTileMenuItems(sys, app, { onChange: () => { painted = ''; render(); } }), { invoker: btn });
      });
      dock.append(btn);
    }

    if (needsMore) {
      // Never a cropped launcher: whatever does not fit is one tap away in Activities.
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'faisal-dock-btn faisal-dock-more';
      more.title = t('shell.dock.more');
      more.setAttribute('aria-label', more.title);
      more.append(renderIcon(ICON_MORE));
      more.addEventListener('click', () => opts.onMore?.());
      dock.append(more);
    }
  }

  render();
  sys.bus.on('apps:changed', render);
  sys.bus.on('app:launched', render);
  sys.bus.on('app:closed', render);
  // Coalesce bursts (show desktop minimizes many windows at once) into one repaint.
  let queued = false;
  const soon = () => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; render(); }); } };
  sys.bus.on('window:focus', soon);
  sys.bus.on('window:change', soon);
  sys.bus.on('settings:change', ({ key }) => { if (key === 'shell.dash') render(); });
  watchShellWidth(root, (next) => { compact = next; render(); });
  return bar;
}
