/**
 * First-run tour — the one onboarding overlay the whole suite shares (جولة أول مرة).
 *
 * Office, PDF, Photo and Video each drop the owner into a dense editor with no explanation of
 * where anything is. Instead of four coach-mark implementations (four sets of geometry, four
 * focus traps, four "have I shown this yet?" flags that drift apart), the tour is written once
 * here and each app hands it its own three or four steps.
 *
 * What this module owns:
 *  • the step sequence (next / back / finish / skip) and the keyboard that drives it;
 *  • the placement maths — the tip is clamped INSIDE the window box, so on a 320px phone it can
 *    never slide under the dock or off the edge (the maths is pure and tested in tour.test.ts);
 *  • the spotlight that dims everything except the control a step is about;
 *  • the "already seen" flag, one per app, through the system settings store the shell exposes;
 *  • the "?" launcher each app puts in its own chrome, which replays the tour on demand.
 *
 * Rules this code keeps:
 *  • while the tour is CLOSED nothing of it is in the DOM and no listener is left behind, so the
 *    app is never blocked, slowed or measured by a tour that is not on screen;
 *  • every way out (Skip, ×, Escape, the last step's button) marks the app as seen, so the tour
 *    never comes back by itself — only "?" brings it back;
 *  • a step whose control is not in this window right now is dropped rather than pointing at
 *    nothing, and if that leaves no steps at all the flag is left alone for a later launch;
 *  • text is Arabic and English (step text comes from the app's own `strings.ts`, the chrome
 *    labels from `./strings`), and the tip follows the document direction, so it mirrors in RTL.
 *
 * The spotlight is a real hole, not a repaint: the hole is a small box carrying a 9999px shadow,
 * which is why the highlighted control stays crisp and clickable-looking while everything else
 * dims — and why the whole thing is one composited layer rather than four dark rectangles.
 */
import { t } from '../kernel/i18n';
import { pushEscapeLayer } from './esc';
import { renderIcon } from './icon';
import './strings';

/* ───────────────────────────── "seen once" flag ───────────────────────────── */

/**
 * Settings key prefix. It must satisfy the settings store's own key rule
 * (`/^[a-z][a-z0-9._-]{0,63}$/i`), which `tourFlagKey` is tested against, because
 * `settings.set` throws on anything else.
 */
export const TOUR_FLAG_PREFIX = 'tour.seen.';

/** The part of `SystemAPI.settings` the tour needs — so tests can pass a plain object. */
export interface TourStore {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

/** `org.faisal.Video` → `tour.seen.org.faisal.Video`. */
export function tourFlagKey(appId: string): string {
  return `${TOUR_FLAG_PREFIX}${appId}`;
}

export function hasSeenTour(store: TourStore, appId: string): boolean {
  return store.get<boolean>(tourFlagKey(appId), false) === true;
}

export function markTourSeen(store: TourStore, appId: string): void {
  store.set(tourFlagKey(appId), true);
}

/** Turns the tour back on (a settings switch or a test). The "?" button does not need this. */
export function resetTour(store: TourStore, appId: string): void {
  store.set(tourFlagKey(appId), false);
}

/* ────────────────────────────── placement maths ────────────────────────────── */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Which side of the highlighted control the tip sits on. Physical, not logical: the maths works
 * in window pixels, and "end" would be ambiguous once the document flips to RTL.
 */
export type TourSide = 'below' | 'above' | 'right' | 'left';

export interface TipRequest {
  /** The highlighted control in window coordinates, or null for a centred tip. */
  target: Rect | null;
  /** The measured tip box. */
  tip: { width: number; height: number };
  /** Visible box of the window, origin at its top-left corner. */
  bounds: Rect;
  /** Space between the control and the tip. */
  gap?: number;
  /** Space kept between the tip and the window edge. */
  margin?: number;
}

export interface TipPlacement {
  top: number;
  left: number;
  side: TourSide;
  /** The highlight hole: the control grown by `SPOT_PAD`, clipped to the window. */
  spot: Rect | null;
  /** Where the arrow sits on the tip's edge, in tip-local pixels, or null when there is none. */
  arrow: { axis: 'x' | 'y'; offset: number } | null;
  /** True when a side had room; false when the tip had to be clamped into the window. */
  fits: boolean;
}

/** How far the spotlight hole is grown past the control it highlights. */
export const SPOT_PAD = 6;
/** Keeps the arrow clear of the tip's rounded corners. */
const ARROW_PAD = 16;

const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

/** Smallest rect that contains `r` and sits inside `b`. */
function clipRect(r: Rect, b: Rect): Rect {
  const left = clamp(r.left, b.left, b.left + b.width);
  const top = clamp(r.top, b.top, b.top + b.height);
  const right = clamp(r.left + r.width, left, b.left + b.width);
  const bottom = clamp(r.top + r.height, top, b.top + b.height);
  return { top, left, width: right - left, height: bottom - top };
}

/**
 * Where the tip goes, and where the highlight hole is.
 *
 * The tip is tried on the roomier vertical side of the control first, then the other one, then
 * the sides — a target low in the window is pointed at from above, the top app bar from below.
 * The first side with room wins. When no side has room (a 320px window with a full-width bar)
 * the roomiest side is used and the box is CLAMPED into the window: the tip stays fully visible
 * and readable rather than being pushed off the edge, and the arrow is dropped because it would
 * no longer point at anything true.
 */
export function placeTip(req: TipRequest): TipPlacement {
  const gap = req.gap ?? 8;
  const margin = req.margin ?? 8;
  const bounds = req.bounds;
  const tipW = Math.max(0, Math.min(req.tip.width, bounds.width - margin * 2));
  const tipH = Math.max(0, Math.min(req.tip.height, bounds.height - margin * 2));
  const minLeft = bounds.left + margin;
  const maxLeft = bounds.left + bounds.width - margin - tipW;
  const minTop = bounds.top + margin;
  const maxTop = bounds.top + bounds.height - margin - tipH;

  const target = req.target ? clipRect(req.target, bounds) : null;
  if (!target || target.width <= 0 || target.height <= 0) {
    // Nothing to point at: a centred tip inside the window, never off it.
    return {
      top: clamp(bounds.top + (bounds.height - tipH) / 2, minTop, maxTop),
      left: clamp(bounds.left + (bounds.width - tipW) / 2, minLeft, maxLeft),
      side: 'below',
      spot: null,
      arrow: null,
      fits: true,
    };
  }

  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  const rightEdge = bounds.left + bounds.width;
  const bottomEdge = bounds.top + bounds.height;

  const sideBox = (side: TourSide): { side: TourSide; top: number; left: number; room: number; fits: boolean } => {
    if (side === 'below') {
      const top = target.top + target.height + gap;
      return { side, top, left: cx - tipW / 2, room: bottomEdge - top, fits: top + tipH <= bottomEdge - margin };
    }
    if (side === 'above') {
      const top = target.top - gap - tipH;
      return { side, top, left: cx - tipW / 2, room: top - bounds.top, fits: top >= minTop };
    }
    if (side === 'right') {
      const left = target.left + target.width + gap;
      return { side, top: cy - tipH / 2, left, room: rightEdge - left, fits: left + tipW <= rightEdge - margin };
    }
    const left = target.left - gap - tipW;
    return { side, top: cy - tipH / 2, left, room: left - bounds.left, fits: left >= minLeft };
  };

  const order: TourSide[] = cy > bounds.top + bounds.height / 2
    ? ['above', 'below', 'right', 'left']
    : ['below', 'above', 'right', 'left'];

  let chosen = sideBox(order[0]);
  for (const side of order) {
    const candidate = sideBox(side);
    if (candidate.fits) { chosen = candidate; break; }
    if (candidate.room > chosen.room) chosen = candidate;
  }

  const top = clamp(chosen.top, minTop, maxTop);
  const left = clamp(chosen.left, minLeft, maxLeft);
  const fits = chosen.fits && top === chosen.top && left === chosen.left;

  const spot = clipRect({
    top: target.top - SPOT_PAD,
    left: target.left - SPOT_PAD,
    width: target.width + SPOT_PAD * 2,
    height: target.height + SPOT_PAD * 2,
  }, bounds);

  let arrow: TipPlacement['arrow'] = null;
  if (fits) {
    arrow = chosen.side === 'below' || chosen.side === 'above'
      ? { axis: 'x', offset: clamp(cx - left, ARROW_PAD, tipW - ARROW_PAD) }
      : { axis: 'y', offset: clamp(cy - top, ARROW_PAD, tipH - ARROW_PAD) };
  }

  return { top, left, side: chosen.side, spot, arrow, fits };
}

/* ─────────────────────────────── the step list ─────────────────────────────── */

export interface TourStep {
  /** CSS selector of the control to highlight, resolved inside the window. Omit to centre. */
  target?: string;
  /** Already localised by the app, from its own `strings.ts`. */
  title: string;
  body: string;
}

/**
 * The steps worth showing right now: one whose control is not in this window (a panel that is
 * closed, a start screen the owner already left) is dropped instead of pointing at nothing.
 */
export function availableSteps(host: ParentNode, steps: readonly TourStep[]): TourStep[] {
  return steps.filter((step) => !step.target || host.querySelector(step.target) !== null);
}

/**
 * Arrow keys follow the reading direction: forward is the arrow that points where "next" sits,
 * which is the LEFT arrow in Arabic and the right one in English.
 */
export function arrowAction(key: string, rtl: boolean): 'next' | 'back' | null {
  if (key === 'ArrowDown' || key === 'PageDown') return 'next';
  if (key === 'ArrowUp' || key === 'PageUp') return 'back';
  if (key === 'ArrowRight') return rtl ? 'back' : 'next';
  if (key === 'ArrowLeft') return rtl ? 'next' : 'back';
  return null;
}

/* ──────────────────────────────── the component ──────────────────────────────── */

export type TourEndReason = 'finished' | 'skipped';

/** The shell's own chrome labels; step text is the app's. */
export interface TourLabels {
  skip: string;
  next: string;
  back: string;
  done: string;
  close: string;
  /** `{n}` and `{total}` are substituted; both languages must keep the same placeholders. */
  step: string;
}

export interface TourOptions {
  /** App id, e.g. `org.faisal.Video` — the seen flag is stored per app. */
  appId: string;
  /** Where the app draws (`ctx.window.content`). The overlay lives inside it. */
  host: HTMLElement;
  /** The app's steps, or a function when the chrome is rebuilt (start screen → editor). */
  steps: readonly TourStep[] | (() => readonly TourStep[]);
  /** `sys.settings` — the tour never touches localStorage itself. */
  store: TourStore;
  /** Overrides for the shell's labels (tests, or an app with its own wording). */
  labels?: Partial<TourLabels>;
  /** Called once the tour closes, whatever closed it. */
  onEnd?: (reason: TourEndReason) => void;
}

export interface TourHandle {
  /** Opens only when this device has never seen the tour for this app. */
  autoStart(): void;
  /** Opens now whatever the flag says — what the "?" button calls. */
  replay(): void;
  /** The "?" launcher, already wired to `replay()`; the app places and styles it. */
  helpButton(opts?: { className?: string; label?: string }): HTMLButtonElement;
  isOpen(): boolean;
  /** Closes and cleans up WITHOUT marking the tour seen (the window is going away). */
  dispose(): void;
}

const ICON = {
  /** The suite's help glyph, same paths as the apps' own icon sets. */
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
} as const;

/** Sizes used before the tip has been measured (jsdom, or the very first frame). */
const FALLBACK_TIP = { width: 300, height: 168 };
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** One tour at a time per app, even when two windows of it are open. */
const live = new Map<string, HTMLElement>();
let idSeq = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An icon-only button: the label is the accessible name and the desktop tooltip. */
function iconButton(markup: string, label: string, cls: string): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  const svg = renderIcon(markup);
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  b.append(svg);
  return b;
}

function button(label: string, cls: string): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  return b;
}

/** `shell.tour.step` = "الخطوة {n} من {total}" — the same placeholders in both languages. */
function fillStep(template: string, n: number, total: number): string {
  return template.split('{n}').join(String(n)).split('{total}').join(String(total));
}

/** The window's visible box, in the coordinates the overlay children use (origin 0,0). */
function hostBox(host: HTMLElement): Rect {
  return { top: 0, left: 0, width: Math.max(0, host.clientWidth), height: Math.max(0, host.clientHeight) };
}

/** A control's box in overlay coordinates: the overlay is panned with the host's scroll. */
function rectInHost(host: HTMLElement, node: Element): Rect {
  const r = node.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  return { top: r.top - h.top, left: r.left - h.left, width: r.width, height: r.height };
}

function defaultLabels(): TourLabels {
  return {
    skip: t('shell.tour.skip'),
    next: t('shell.tour.next'),
    back: t('shell.tour.back'),
    done: t('shell.tour.done'),
    close: t('shell.tour.close'),
    step: t('shell.tour.step'),
  };
}

/**
 * Keeps the overlay exactly over the window's visible box however the app scrolls, and reports
 * that box. The same 12 lines as `pinToHost` in save-as.ts, repeated on purpose: importing the
 * save dialog here would drag its whole module graph (dialog, icons, its strings) into every
 * app that only wanted a tour.
 */
function pinToWindow(overlay: HTMLElement, host: HTMLElement): () => void {
  const apply = (): void => {
    overlay.style.top = `${host.scrollTop}px`;
    overlay.style.left = `${host.scrollLeft}px`;
    overlay.style.width = `${host.clientWidth}px`;
    overlay.style.height = `${host.clientHeight}px`;
  };
  apply();
  host.addEventListener('scroll', apply, { passive: true });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
  observer?.observe(host);
  return () => {
    host.removeEventListener('scroll', apply);
    observer?.disconnect();
  };
}

interface OpenTour {
  close(reason: TourEndReason | null): void;
}

/**
 * The tour for one app window. `autoStart()` is what an app calls on launch; `helpButton()` is
 * what it hangs in its chrome for the "?" replay.
 */
export function createTour(opts: TourOptions): TourHandle {
  const { appId, host, store } = opts;
  let open: OpenTour | null = null;

  const stepsNow = (): TourStep[] => {
    const list = typeof opts.steps === 'function' ? opts.steps() : opts.steps;
    return availableSteps(host, list);
  };

  function start(): void {
    if (open) return;
    // Another window of the same app is already showing its tour — one is enough. A window that
    // went away without calling `dispose()` (host no longer in the document) must not lock the
    // tour out for the rest of the session, so a dead entry is dropped here.
    const other = live.get(appId);
    if (other && other.isConnected) return;
    const list = stepsNow();
    // Nothing to point at: leave the flag alone so a later launch still gets its tour.
    if (!list.length) return;
    live.set(appId, host);
    open = mountTour({
      appId, host, list,
      labels: { ...defaultLabels(), ...opts.labels },
      onClose: (reason) => {
        if (live.get(appId) === host) live.delete(appId);
        open = null;
        if (reason) {
          markTourSeen(store, appId);
          opts.onEnd?.(reason);
        }
      },
    });
  }

  return {
    autoStart(): void {
      if (!hasSeenTour(store, appId)) start();
    },
    replay(): void {
      start();
    },
    helpButton(buttonOpts = {}): HTMLButtonElement {
      const label = buttonOpts.label ?? t('shell.tour.replay');
      const cls = buttonOpts.className ? `faisal-tour-help ${buttonOpts.className}` : 'faisal-tour-help';
      const help = iconButton(ICON.help, label, cls);
      help.addEventListener('click', () => start());
      return help;
    },
    isOpen(): boolean {
      return open !== null;
    },
    dispose(): void {
      open?.close(null);
    },
  };
}

interface MountOptions {
  appId: string;
  host: HTMLElement;
  list: readonly TourStep[];
  labels: TourLabels;
  onClose: (reason: TourEndReason | null) => void;
}

function mountTour(o: MountOptions): OpenTour {
  const { host, list, labels } = o;
  const id = `faisal-tour-${++idSeq}`;
  const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Read per keypress, not once at mount: switching AR/EN while the tour is open must not leave
  // the arrow keys pointing the wrong way.
  const isRtl = (): boolean =>
    document.documentElement.dir === 'rtl' || getComputedStyle(document.documentElement).direction === 'rtl';

  const overlay = el('div', 'faisal-tour-overlay');
  overlay.dataset.tour = o.appId;
  const dim = el('div', 'faisal-tour-dim');
  const spot = el('div', 'faisal-tour-spot');
  const tip = el('div', 'faisal-tour-tip');
  tip.tabIndex = -1;
  tip.setAttribute('role', 'dialog');
  tip.setAttribute('aria-modal', 'true');

  const title = el('h2', 'faisal-tour-title');
  title.id = `${id}-title`;
  const body = el('p', 'faisal-tour-body');
  body.id = `${id}-body`;
  tip.setAttribute('aria-labelledby', title.id);
  tip.setAttribute('aria-describedby', body.id);

  const closeBtn = iconButton(ICON.close, labels.close, 'faisal-tour-x');
  const head = el('div', 'faisal-tour-head');
  head.append(title, closeBtn);

  const counter = el('p', 'faisal-tour-count');
  counter.setAttribute('role', 'status');
  const skipBtn = button(labels.skip, 'faisal-tour-btn is-plain');
  const backBtn = button(labels.back, 'faisal-tour-btn');
  const nextBtn = button(labels.next, 'faisal-tour-btn is-primary');
  const foot = el('div', 'faisal-tour-foot');
  foot.append(skipBtn, counter, backBtn, nextBtn);

  const arrow = el('div', 'faisal-tour-arrow');
  tip.append(head, body, foot, arrow);
  overlay.append(dim, spot, tip);

  let index = 0;
  let scrolledFor = -1;
  let done = false;
  let releaseEsc: (() => void) | null = null;
  let unpin: (() => void) | null = null;
  let onResize: (() => void) | null = null;

  /* ── placing ── */

  function sync(): void {
    const bounds = hostBox(host);
    const step = list[index];
    const node = step.target ? host.querySelector<HTMLElement>(step.target) : null;

    // Bring the control into view once per step: a toolbar can live inside its own scroller,
    // and a spotlight on something the owner cannot see teaches nothing.
    if (node && scrolledFor !== index && typeof node.scrollIntoView === 'function') {
      const r = rectInHost(host, node);
      if (r.top < 0 || r.left < 0 || r.top + r.height > bounds.height || r.left + r.width > bounds.width) {
        scrolledFor = index;
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }

    const target = node ? rectInHost(host, node) : null;
    const measured = tip.getBoundingClientRect();
    const size = {
      width: measured.width || FALLBACK_TIP.width,
      height: measured.height || FALLBACK_TIP.height,
    };
    const place = placeTip({ target: target && target.width > 0 && target.height > 0 ? target : null, tip: size, bounds });

    tip.style.top = `${Math.round(place.top)}px`;
    tip.style.left = `${Math.round(place.left)}px`;
    tip.dataset.side = place.side;
    spot.hidden = place.spot === null;
    if (place.spot) {
      spot.style.top = `${Math.round(place.spot.top)}px`;
      spot.style.left = `${Math.round(place.spot.left)}px`;
      spot.style.width = `${Math.round(place.spot.width)}px`;
      spot.style.height = `${Math.round(place.spot.height)}px`;
    }
    dim.hidden = place.spot !== null;
    arrow.hidden = place.arrow === null;
    if (place.arrow) {
      if (place.arrow.axis === 'x') {
        arrow.style.left = `${Math.round(place.arrow.offset)}px`;
        arrow.style.top = '';
      } else {
        arrow.style.top = `${Math.round(place.arrow.offset)}px`;
        arrow.style.left = '';
      }
    }
    // The tip is invisible until it has been placed, so it never flashes at the window's corner.
    if (tip.dataset.ready !== 'true') tip.dataset.ready = 'true';
  }

  /* ── steps ── */

  function render(): void {
    const step = list[index];
    title.textContent = step.title;
    body.textContent = step.body;
    counter.textContent = fillStep(labels.step, index + 1, list.length);
    skipBtn.hidden = list.length < 2;
    backBtn.hidden = list.length < 2;
    backBtn.disabled = index === 0;
    nextBtn.textContent = index === list.length - 1 ? labels.done : labels.next;
    // A new step starts at the top of its text: the body scrolls when a phone window is short.
    body.scrollTop = 0;
    sync();
  }

  function go(delta: number): void {
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    if (next !== index) scrolledFor = -1;
    index = next;
    render();
  }

  function finish(reason: TourEndReason): void {
    teardown();
    if (invoker?.isConnected) invoker.focus({ preventScroll: true });
    o.onClose(reason);
  }

  /** Removes every trace of the tour. Called by both exits, so nothing can be left behind. */
  function teardown(): void {
    if (done) return;
    done = true;
    overlay.remove();
    releaseEsc?.();
    releaseEsc = null;
    unpin?.();
    unpin = null;
    if (onResize) window.removeEventListener('resize', onResize);
    onResize = null;
  }

  /* ── wiring ── */

  skipBtn.addEventListener('click', () => finish('skipped'));
  closeBtn.addEventListener('click', () => finish('skipped'));
  backBtn.addEventListener('click', () => go(-1));
  nextBtn.addEventListener('click', () => {
    if (index === list.length - 1) finish('finished');
    else go(1);
  });
  // Tapping the dimmed area continues; the tip itself never advances by accident.
  overlay.addEventListener('click', (ev) => {
    if (tip.contains(ev.target as Node)) return;
    if (index === list.length - 1) finish('finished');
    else go(1);
  });

  /**
   * The tour is modal, so the app must not act on keys pressed while it is open: a stray Space
   * would start the video behind the overlay. Escape is deliberately NOT handled here — it goes
   * to the shell's own layer stack (`esc.ts`), which is listening on `window` in the capture
   * phase and therefore runs before this one. Tab, Enter and Space keep their browser defaults
   * (stopPropagation does not cancel a default action), so the tip stays fully keyboard-driven.
   */
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab') {
      const items = Array.from(tip.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !n.hidden);
      if (items.length) {
        const first = items[0];
        const last = items[items.length - 1];
        if (ev.shiftKey && (document.activeElement === first || document.activeElement === tip)) {
          ev.preventDefault();
          last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
          ev.preventDefault();
          first.focus();
        }
      }
    } else if (ev.key === 'Enter' && document.activeElement === tip) {
      ev.preventDefault();
      if (index === list.length - 1) finish('finished');
      else go(1);
    } else {
      const action = arrowAction(ev.key, isRtl());
      if (action) {
        ev.preventDefault();
        go(action === 'next' ? 1 : -1);
      }
    }
    ev.stopPropagation();
  }, true);
  overlay.addEventListener('keyup', (ev) => ev.stopPropagation(), true);

  releaseEsc = pushEscapeLayer(() => finish('skipped'));

  host.append(overlay);
  unpin = pinToWindow(overlay, host);
  onResize = () => sync();
  window.addEventListener('resize', onResize);

  render();
  queueMicrotask(() => {
    if (!done) tip.focus({ preventScroll: true });
  });

  return {
    close(reason: TourEndReason | null): void {
      teardown();
      o.onClose(reason);
    },
  };
}
