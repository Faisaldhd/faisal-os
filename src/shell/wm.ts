import type { EventBus, WindowHandle, WindowManager, WindowOptions } from '../kernel/types';
import { renderIcon } from './icon';
import { t } from '../kernel/i18n';
import { showContextMenu, wireContextMenu } from './contextmenu';

const NARROW_BREAKPOINT = 700;
const CASCADE_STEP = 28;
const CASCADE_MAX = 8;
/** Always-on-top windows use a z-index tier well above the normal stack. */
const PINNED_Z_BASE = 100_000;
/** How close (px) the pointer must get to a surface edge to offer a snap. */
const SNAP_EDGE = 8;
/** Last size/position per app, so an app reopens where the user left it. */
const GEOMETRY_KEY = 'faisal.wm.geometry.v1';

type Rect = { left: number; top: number; width: number; height: number };
type Snap = 'left' | 'right' | 'max';
type SavedGeometry = Rect & { maximized?: boolean };

interface WinRecord {
  handle: WindowHandle;
  el: HTMLElement;
  appId: string;
  minWidth: number;
  minHeight: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  /** Maximized only because the screen is narrow; undone when it widens again. */
  autoMaximized: boolean;
  snapped: 'left' | 'right' | null;
  alwaysOnTop: boolean;
  /** Size/position to return to when leaving maximized or snapped. */
  restoreRect: Rect | null;
}

function loadGeometry(): Record<string, SavedGeometry> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(GEOMETRY_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, SavedGeometry> = Object.create(null);
    for (const [id, g] of Object.entries(raw as Record<string, unknown>)) {
      const v = g as Partial<SavedGeometry>;
      if ([v.left, v.top, v.width, v.height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
        out[id] = { left: v.left!, top: v.top!, width: v.width!, height: v.height!, maximized: v.maximized === true };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveGeometry(all: Record<string, SavedGeometry>) {
  try { localStorage.setItem(GEOMETRY_KEY, JSON.stringify(all)); } catch { /* private mode: not remembered */ }
}

export function createWindowManager(root: HTMLElement, bus: EventBus): WindowManager {
  root.classList.add('faisal-desktop');
  const surface = document.createElement('div');
  surface.className = 'faisal-desktop-surface';
  root.append(surface);

  const snapPreview = document.createElement('div');
  snapPreview.className = 'faisal-snap-preview';
  snapPreview.hidden = true;
  surface.append(snapPreview);

  const wins = new Map<string, WinRecord>();
  const geometry = loadGeometry();
  let counter = 0;
  let zTop = 10;
  let zTopPinned = PINNED_Z_BASE;
  let cascadeIndex = 0;
  let focusedId: string | null = null;
  /** Windows hidden by "show desktop", restored by the next toggle. */
  let desktopShown: string[] | null = null;

  const surfaceSize = () => ({
    width: surface.clientWidth || window.innerWidth,
    height: surface.clientHeight || window.innerHeight,
  });
  const isNarrow = () => surfaceSize().width < NARROW_BREAKPOINT;

  function readRect(el: HTMLElement): Rect {
    return {
      left: parseFloat(el.style.left) || 0,
      top: parseFloat(el.style.top) || 0,
      width: el.offsetWidth || parseFloat(el.style.width) || 0,
      height: el.offsetHeight || parseFloat(el.style.height) || 0,
    };
  }

  function writeRect(el: HTMLElement, r: Rect) {
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
  }

  /** Shrinks a rect to fit the surface and moves it fully inside. */
  function clampRect(r: Rect, minW = 0, minH = 0): Rect {
    const { width: sw, height: sh } = surfaceSize();
    const width = Math.max(Math.min(minW, sw), Math.min(r.width, sw));
    const height = Math.max(Math.min(minH, sh), Math.min(r.height, sh));
    return {
      width,
      height,
      left: Math.min(Math.max(0, r.left), Math.max(0, sw - width)),
      top: Math.min(Math.max(0, r.top), Math.max(0, sh - height)),
    };
  }

  function snapRect(side: 'left' | 'right'): Rect {
    const { width: sw, height: sh } = surfaceSize();
    const half = Math.round(sw / 2);
    return { left: side === 'left' ? 0 : sw - half, top: 0, width: half, height: sh };
  }

  const changed = (id: string) => bus.emit('window:change', { windowId: id });

  function remember(rec: WinRecord) {
    if (rec.autoMaximized) return; // the narrow-screen layout isn't a user choice
    const base = rec.maximized || rec.snapped ? rec.restoreRect : readRect(rec.el);
    if (!base) return;
    geometry[rec.appId] = { ...base, maximized: rec.maximized };
    saveGeometry(geometry);
  }

  function setFocusClass(id: string | null) {
    focusedId = id;
    for (const [otherId, other] of wins) other.el.classList.toggle('is-focused', otherId === id);
  }

  function focusWindow(id: string) {
    const rec = wins.get(id);
    if (!rec) return;
    if (rec.minimized) {
      rec.minimized = false;
      rec.el.classList.remove('is-minimized');
      changed(id);
    }
    desktopShown = null;
    rec.z = rec.alwaysOnTop ? ++zTopPinned : ++zTop;
    rec.el.style.zIndex = String(rec.z);
    setFocusClass(id);
    bus.emit('window:focus', { windowId: id });
  }

  /** Focuses the highest visible window, or clears focus when none is left. */
  function focusTopmost() {
    let best: WinRecord | undefined;
    for (const rec of wins.values()) if (!rec.minimized && (!best || rec.z > best.z)) best = rec;
    if (best) focusWindow(best.handle.id);
    else setFocusClass(null);
  }

  function minimize(id: string) {
    const rec = wins.get(id);
    if (!rec || rec.minimized) return;
    rec.minimized = true;
    rec.el.classList.add('is-minimized');
    changed(id);
    if (focusedId === id) focusTopmost();
  }

  function setMaximized(rec: WinRecord, on: boolean, auto = false) {
    if (on === rec.maximized) return;
    if (on) {
      if (!rec.snapped) rec.restoreRect = readRect(rec.el);
      rec.maximized = true;
      rec.autoMaximized = auto;
      rec.el.classList.add('is-maximized');
    } else {
      rec.maximized = false;
      rec.autoMaximized = false;
      rec.el.classList.remove('is-maximized');
      if (rec.snapped) writeRect(rec.el, snapRect(rec.snapped));
      else if (rec.restoreRect) writeRect(rec.el, clampRect(rec.restoreRect, rec.minWidth, rec.minHeight));
    }
    changed(rec.handle.id);
  }

  function toggleMaximize(id: string) {
    const rec = wins.get(id);
    if (!rec) return;
    if (rec.snapped && !rec.maximized) unsnap(rec);
    setMaximized(rec, !rec.maximized);
    remember(rec);
    focusWindow(id);
  }

  function snap(rec: WinRecord, side: 'left' | 'right') {
    if (rec.maximized) setMaximized(rec, false);
    if (!rec.snapped) rec.restoreRect = readRect(rec.el);
    rec.snapped = side;
    rec.el.classList.add('is-snapped');
    writeRect(rec.el, snapRect(side));
    changed(rec.handle.id);
  }

  function unsnap(rec: WinRecord) {
    if (!rec.snapped) return;
    rec.snapped = null;
    rec.el.classList.remove('is-snapped');
    if (rec.restoreRect) writeRect(rec.el, clampRect(rec.restoreRect, rec.minWidth, rec.minHeight));
    changed(rec.handle.id);
  }

  function setAlwaysOnTop(id: string, on: boolean) {
    const rec = wins.get(id);
    if (!rec) return;
    rec.alwaysOnTop = on;
    rec.el.classList.toggle('is-pinned', on);
    focusWindow(id);
  }

  function open(opts: WindowOptions): WindowHandle {
    const id = `w${++counter}`;
    const minWidth = opts.minWidth ?? 220;
    const minHeight = opts.minHeight ?? 140;
    const resizable = opts.resizable !== false;

    const el = document.createElement('section');
    el.className = 'faisal-window is-opening';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', opts.title);
    el.style.minWidth = `${minWidth}px`;
    el.style.minHeight = `${minHeight}px`;
    el.addEventListener('animationend', () => el.classList.remove('is-opening'), { once: true });

    // Reopen where the user left this app, unless another of its windows is already there.
    const saved = [...wins.values()].some((r) => r.appId === opts.appId) ? undefined : geometry[opts.appId];
    let start: Rect;
    if (saved) {
      start = clampRect(saved, minWidth, minHeight);
    } else {
      const idx = cascadeIndex++ % CASCADE_MAX;
      start = clampRect({
        left: 60 + idx * CASCADE_STEP,
        top: 40 + idx * CASCADE_STEP,
        width: opts.width ?? 640,
        height: opts.height ?? 440,
      }, minWidth, minHeight);
    }
    writeRect(el, start);

    // Titlebar
    const titlebar = document.createElement('div');
    titlebar.className = 'faisal-titlebar';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'faisal-titlebar-icon';
    iconWrap.append(renderIcon(opts.icon ?? ''));

    const titleEl = document.createElement('span');
    titleEl.className = 'faisal-titlebar-title';
    titleEl.textContent = opts.title;

    const controls = document.createElement('div');
    controls.className = 'faisal-titlebar-controls';
    const minBtn = makeWinButton('minimize', '<svg viewBox="0 0 12 12"><rect x="2" y="5.2" width="8" height="1.6" fill="currentColor"/></svg>');
    const maxBtn = makeWinButton('maximize', '<svg viewBox="0 0 12 12"><rect x="2.2" y="2.2" width="7.6" height="7.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>');
    const closeBtn = makeWinButton('close', '<svg viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>');
    closeBtn.classList.add('faisal-win-close');
    controls.append(minBtn, maxBtn, closeBtn);

    titlebar.append(iconWrap, titleEl, controls);

    const content = document.createElement('div');
    content.className = 'faisal-window-content';

    el.append(titlebar, content);

    if (resizable) {
      for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        const grip = document.createElement('div');
        grip.className = `faisal-resize-handle faisal-resize-${dir}`;
        el.append(grip);
        grip.addEventListener('pointerdown', (ev) => startResize(ev, dir));
      }
    }

    surface.append(el);

    const closeCbs = new Set<() => void>();
    const resizeCbs = new Set<(size: { width: number; height: number }) => void>();

    const rec: WinRecord = {
      handle: null as unknown as WindowHandle, el, appId: opts.appId, minWidth, minHeight, z: 0,
      minimized: false, maximized: false, autoMaximized: false, snapped: null, alwaysOnTop: false, restoreRect: null,
    };
    wins.set(id, rec);

    let closed = false;
    const handle: WindowHandle = {
      id,
      appId: opts.appId,
      content,
      setTitle: (title: string) => { titleEl.textContent = title; el.setAttribute('aria-label', title); },
      focus: () => focusWindow(id),
      close: () => {
        if (closed) return;
        closed = true;
        remember(rec);
        el.remove();
        wins.delete(id);
        ro.disconnect();
        closeCbs.forEach((cb) => cb());
        changed(id);
        if (focusedId === id) focusTopmost();
      },
      onClose: (cb) => { closeCbs.add(cb); return () => closeCbs.delete(cb); },
      onResize: (cb) => { resizeCbs.add(cb); return () => resizeCbs.delete(cb); },
    };
    rec.handle = handle;

    const ro: { disconnect(): void } = typeof ResizeObserver !== 'undefined'
      ? (() => {
          const obs = new ResizeObserver(() => {
            resizeCbs.forEach((cb) => cb({ width: content.clientWidth, height: content.clientHeight }));
          });
          obs.observe(content);
          return obs;
        })()
      : { disconnect() {} };

    // Dragging
    titlebar.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || (ev.target as HTMLElement).closest('.faisal-win-btn')) return;
      focusWindow(id);
      if (rec.autoMaximized) return; // narrow screens keep windows full size
      startDrag(ev);
    });
    titlebar.addEventListener('dblclick', (ev) => {
      if ((ev.target as HTMLElement).closest('.faisal-win-btn')) return;
      toggleMaximize(id);
    });

    wireContextMenu(titlebar, (x, y) => {
      showContextMenu(x, y, [
        { label: t('shell.ctx.minimize'), action: () => minimize(id) },
        {
          label: t(rec.maximized ? 'shell.ctx.restoreWindow' : 'shell.ctx.maximizeWindow'),
          action: () => toggleMaximize(id),
        },
        {
          label: t('shell.ctx.alwaysOnTop'),
          checked: rec.alwaysOnTop,
          action: () => setAlwaysOnTop(id, !rec.alwaysOnTop),
        },
        { separator: true },
        { label: t('shell.ctx.closeWindow'), danger: true, action: () => handle.close() },
      ], { invoker: titlebar });
    }, { exclude: (target) => target instanceof Element && !!target.closest('.faisal-win-btn') });

    minBtn.addEventListener('click', () => minimize(id));
    maxBtn.addEventListener('click', () => toggleMaximize(id));
    closeBtn.addEventListener('click', () => handle.close());

    el.addEventListener('pointerdown', () => { if (focusedId !== id) focusWindow(id); });

    function startDrag(startEv: PointerEvent) {
      const startX = startEv.clientX;
      const startY = startEv.clientY;
      let origin = readRect(el);
      let detached = !(rec.maximized || rec.snapped);
      let pending: PointerEvent | null = null;
      let raf = 0;
      let snapTo: Snap | null = null;
      titlebar.setPointerCapture(startEv.pointerId);

      const apply = () => {
        raf = 0;
        const ev = pending!;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!detached) {
          // Pulling a maximized/snapped window out restores its size under the pointer.
          if (Math.hypot(dx, dy) < 6) return;
          const back = rec.restoreRect ?? origin;
          const ratio = (startX - el.getBoundingClientRect().left) / (el.offsetWidth || 1);
          if (rec.maximized) setMaximized(rec, false);
          if (rec.snapped) { rec.snapped = null; el.classList.remove('is-snapped'); changed(id); }
          const s = surface.getBoundingClientRect();
          origin = clampRect({ ...back, left: startX - s.left - back.width * ratio, top: 0 }, minWidth, minHeight);
          writeRect(el, origin);
          detached = true;
        }
        const next = clampRect({ ...origin, left: origin.left + dx, top: origin.top + dy });
        el.style.left = `${next.left}px`;
        el.style.top = `${next.top}px`;

        const s = surface.getBoundingClientRect();
        const x = ev.clientX - s.left;
        const y = ev.clientY - s.top;
        snapTo = isNarrow() ? null
          : y <= SNAP_EDGE ? 'max'
          : x <= SNAP_EDGE ? 'left'
          : x >= s.width - SNAP_EDGE ? 'right'
          : null;
        if (snapTo) {
          writeRect(snapPreview, snapTo === 'max' ? { left: 0, top: 0, width: s.width, height: s.height } : snapRect(snapTo));
          snapPreview.hidden = false;
        } else {
          snapPreview.hidden = true;
        }
      };
      const onMove = (ev: PointerEvent) => {
        pending = ev;
        if (!raf) raf = requestAnimationFrame(apply);
      };
      const onUp = (ev: PointerEvent) => {
        if (raf) { cancelAnimationFrame(raf); apply(); }
        titlebar.releasePointerCapture(ev.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        snapPreview.hidden = true;
        if (!detached) return; // a click on a maximized/snapped titlebar
        if (snapTo === 'max') setMaximized(rec, true);
        else if (snapTo) snap(rec, snapTo);
        remember(rec);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    function startResize(startEv: PointerEvent, dir: string) {
      if (rec.maximized) return;
      startEv.stopPropagation();
      focusWindow(id);
      if (rec.snapped) { rec.snapped = null; el.classList.remove('is-snapped'); changed(id); }
      const startX = startEv.clientX;
      const startY = startEv.clientY;
      const o = readRect(el);
      const target = startEv.target as HTMLElement;
      target.setPointerCapture(startEv.pointerId);
      let pending: PointerEvent | null = null;
      let raf = 0;

      const apply = () => {
        raf = 0;
        const ev = pending!;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let { left, top, width: w, height: h } = o;
        if (dir.includes('e')) w = Math.max(minWidth, o.width + dx);
        if (dir.includes('s')) h = Math.max(minHeight, o.height + dy);
        if (dir.includes('w')) { w = Math.max(minWidth, o.width - dx); left = o.left + (o.width - w); }
        if (dir.includes('n')) { h = Math.max(minHeight, o.height - dy); top = o.top + (o.height - h); }
        const { width: sw, height: sh } = surfaceSize();
        left = Math.max(0, Math.min(left, sw - minWidth));
        top = Math.max(0, Math.min(top, sh - minHeight));
        writeRect(el, { left, top, width: Math.min(w, sw - left), height: Math.min(h, sh - top) });
      };
      const onMove = (ev: PointerEvent) => {
        pending = ev;
        if (!raf) raf = requestAnimationFrame(apply);
      };
      const onUp = (ev: PointerEvent) => {
        if (raf) { cancelAnimationFrame(raf); apply(); }
        target.releasePointerCapture(ev.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        remember(rec);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    if (isNarrow()) setMaximized(rec, true, true);
    else if (saved?.maximized) setMaximized(rec, true);

    focusWindow(id);
    return handle;
  }

  function makeWinButton(kind: string, svg: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'faisal-win-btn';
    btn.dataset.kind = kind;
    btn.setAttribute('aria-label', t(`shell.win.${kind}`));
    btn.title = t(`shell.win.${kind}`);
    btn.append(renderIcon(svg));
    return btn;
  }

  /** Minimizes every visible window; the next call brings the same windows back. */
  function toggleShowDesktop() {
    if (desktopShown) {
      const ids = desktopShown;
      desktopShown = null;
      ids.forEach((wid) => { if (wins.has(wid)) focusWindow(wid); });
      return;
    }
    const visible = [...wins.values()].filter((r) => !r.minimized).sort((a, b) => a.z - b.z).map((r) => r.handle.id);
    visible.forEach(minimize);
    desktopShown = visible.length ? visible : null;
  }

  // Keep windows usable when the browser window or phone orientation changes.
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      const narrow = isNarrow();
      for (const rec of wins.values()) {
        if (narrow && !rec.maximized) setMaximized(rec, true, true);
        else if (!narrow && rec.autoMaximized) setMaximized(rec, false);
        else if (rec.snapped && !rec.maximized) writeRect(rec.el, snapRect(rec.snapped));
        else if (!rec.maximized) writeRect(rec.el, clampRect(readRect(rec.el), rec.minWidth, rec.minHeight));
      }
    });
  });

  window.addEventListener('keydown', (ev) => {
    const rec = focusedId ? wins.get(focusedId) : undefined;
    // Ctrl+Alt+W closes the focused window.
    if (ev.ctrlKey && ev.altKey && ev.code === 'KeyW') {
      if (rec) { ev.preventDefault(); rec.handle.close(); }
      return;
    }
    // Super (Windows key) shortcuts; the OS only passes them through in full screen.
    if (!ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.code === 'KeyD') { ev.preventDefault(); toggleShowDesktop(); return; }
    if (!rec || ev.shiftKey) return;
    switch (ev.key) {
      case 'ArrowUp':
        ev.preventDefault();
        if (!rec.maximized) toggleMaximize(rec.handle.id);
        break;
      case 'ArrowDown':
        ev.preventDefault();
        if (rec.maximized && !rec.autoMaximized) toggleMaximize(rec.handle.id);
        else if (rec.snapped) { unsnap(rec); remember(rec); }
        else minimize(rec.handle.id);
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (isNarrow()) return;
        ev.preventDefault();
        // Arrow keys are physical: Left always means the left half, even in RTL.
        const side = ev.key === 'ArrowLeft' ? 'left' : 'right';
        if (rec.snapped === side) { unsnap(rec); } else { snap(rec, side); }
        remember(rec);
        focusWindow(rec.handle.id);
        break;
      }
    }
  });

  return {
    open,
    list: () => [...wins.values()].sort((a, b) => a.z - b.z).map((r) => r.handle),
    get: (id) => wins.get(id)?.handle,
    focused: () => (focusedId ? wins.get(focusedId)?.handle : undefined),
    isMinimized: (id) => wins.get(id)?.minimized ?? false,
    minimize,
    toggleMaximize,
  };
}
