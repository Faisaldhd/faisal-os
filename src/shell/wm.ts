import type { EventBus, WindowHandle, WindowManager, WindowOptions } from '../kernel/types';
import { renderIcon } from './icon';
import { t } from '../kernel/i18n';
import { showContextMenu, wireContextMenu } from './contextmenu';

const NARROW_BREAKPOINT = 700;
const CASCADE_STEP = 28;
const CASCADE_MAX = 8;
/** Always-on-top windows use a z-index tier well above the normal stack. */
const PINNED_Z_BASE = 100_000;

interface WinRecord {
  handle: WindowHandle;
  el: HTMLElement;
  minimized: boolean;
  maximized: boolean;
  alwaysOnTop: boolean;
  restoreRect: { left: number; top: number; width: number; height: number } | null;
}

export function createWindowManager(root: HTMLElement, bus: EventBus): WindowManager {
  root.classList.add('faisal-desktop');
  const surface = document.createElement('div');
  surface.className = 'faisal-desktop-surface';
  root.append(surface);

  const wins = new Map<string, WinRecord>();
  let counter = 0;
  let zTop = 10;
  let zTopPinned = PINNED_Z_BASE;
  let cascadeIndex = 0;

  function isNarrow(): boolean {
    return surface.clientWidth > 0 ? surface.clientWidth < NARROW_BREAKPOINT : window.innerWidth < NARROW_BREAKPOINT;
  }

  function clampToViewport(rec: WinRecord, left: number, top: number, width: number, height: number) {
    const sw = surface.clientWidth || window.innerWidth;
    const sh = surface.clientHeight || window.innerHeight;
    const maxLeft = Math.max(0, sw - Math.min(width, sw));
    const maxTop = Math.max(0, sh - Math.min(height, sh));
    left = Math.min(Math.max(0, left), maxLeft);
    top = Math.min(Math.max(0, top), maxTop);
    return { left, top };
  }

  function focusWindow(id: string) {
    const rec = wins.get(id);
    if (!rec) return;
    if (rec.alwaysOnTop) {
      zTopPinned += 1;
      rec.el.style.zIndex = String(zTopPinned);
    } else {
      zTop += 1;
      rec.el.style.zIndex = String(zTop);
    }
    for (const [otherId, other] of wins) {
      other.el.classList.toggle('is-focused', otherId === id);
    }
    bus.emit('window:focus', { windowId: id });
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
    const width = opts.width ?? 640;
    const height = opts.height ?? 440;
    const minWidth = opts.minWidth ?? 220;
    const minHeight = opts.minHeight ?? 140;
    const resizable = opts.resizable !== false;

    const el = document.createElement('section');
    el.className = 'faisal-window';
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.minWidth = `${minWidth}px`;
    el.style.minHeight = `${minHeight}px`;

    const idx = cascadeIndex % CASCADE_MAX;
    cascadeIndex += 1;
    const startLeft = 60 + idx * CASCADE_STEP;
    const startTop = 40 + idx * CASCADE_STEP;
    const { left, top } = clampToViewport({ handle: null as any, el, minimized: false, maximized: false, alwaysOnTop: false, restoreRect: null }, startLeft, startTop, width, height);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

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
        const handle = document.createElement('div');
        handle.className = `faisal-resize-handle faisal-resize-${dir}`;
        el.append(handle);
        handle.addEventListener('pointerdown', (ev) => startResize(ev, dir));
      }
    }

    surface.append(el);

    const closeCbs = new Set<() => void>();
    const resizeCbs = new Set<(size: { width: number; height: number }) => void>();

    const rec: WinRecord = { handle: null as any, el, minimized: false, maximized: false, alwaysOnTop: false, restoreRect: null };
    wins.set(id, rec);

    const handle: WindowHandle = {
      id,
      appId: opts.appId,
      content,
      setTitle: (title: string) => { titleEl.textContent = title; },
      focus: () => { rec.minimized = false; el.classList.remove('is-minimized'); focusWindow(id); },
      close: () => {
        el.remove();
        wins.delete(id);
        ro.disconnect();
        closeCbs.forEach((cb) => cb());
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
      if ((ev.target as HTMLElement).closest('.faisal-win-btn')) return;
      focusWindow(id);
      if (rec.maximized) return;
      startDrag(ev);
    });
    titlebar.addEventListener('dblclick', (ev) => {
      if ((ev.target as HTMLElement).closest('.faisal-win-btn')) return;
      toggleMaximize();
    });

    wireContextMenu(titlebar, (x, y) => {
      showContextMenu(x, y, [
        { label: t('shell.ctx.minimize'), action: () => { rec.minimized = true; el.classList.add('is-minimized'); } },
        {
          label: t(rec.maximized ? 'shell.ctx.restoreWindow' : 'shell.ctx.maximizeWindow'),
          action: () => toggleMaximize(),
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

    minBtn.addEventListener('click', () => {
      rec.minimized = true;
      el.classList.add('is-minimized');
    });
    maxBtn.addEventListener('click', () => toggleMaximize());
    closeBtn.addEventListener('click', () => handle.close());

    el.addEventListener('pointerdown', () => focusWindow(id));

    function toggleMaximize() {
      if (rec.maximized) {
        rec.maximized = false;
        el.classList.remove('is-maximized');
        if (rec.restoreRect) {
          el.style.left = `${rec.restoreRect.left}px`;
          el.style.top = `${rec.restoreRect.top}px`;
          el.style.width = `${rec.restoreRect.width}px`;
          el.style.height = `${rec.restoreRect.height}px`;
        }
      } else {
        rec.restoreRect = {
          left: parseFloat(el.style.left) || 0,
          top: parseFloat(el.style.top) || 0,
          width: el.offsetWidth,
          height: el.offsetHeight,
        };
        rec.maximized = true;
        el.classList.add('is-maximized');
      }
      focusWindow(id);
    }

    function startDrag(startEv: PointerEvent) {
      const startX = startEv.clientX;
      const startY = startEv.clientY;
      const originLeft = parseFloat(el.style.left) || 0;
      const originTop = parseFloat(el.style.top) || 0;
      titlebar.setPointerCapture(startEv.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const { left, top } = clampToViewport(rec, originLeft + dx, originTop + dy, el.offsetWidth, el.offsetHeight);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
      };
      const onUp = (ev: PointerEvent) => {
        titlebar.releasePointerCapture(ev.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    function startResize(startEv: PointerEvent, dir: string) {
      if (rec.maximized) return;
      startEv.stopPropagation();
      focusWindow(id);
      const startX = startEv.clientX;
      const startY = startEv.clientY;
      const originLeft = parseFloat(el.style.left) || 0;
      const originTop = parseFloat(el.style.top) || 0;
      const originW = el.offsetWidth;
      const originH = el.offsetHeight;
      const target = startEv.target as HTMLElement;
      target.setPointerCapture(startEv.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let left = originLeft, top = originTop, w = originW, h = originH;
        if (dir.includes('e')) w = Math.max(minWidth, originW + dx);
        if (dir.includes('s')) h = Math.max(minHeight, originH + dy);
        if (dir.includes('w')) {
          w = Math.max(minWidth, originW - dx);
          left = originLeft + (originW - w);
        }
        if (dir.includes('n')) {
          h = Math.max(minHeight, originH - dy);
          top = originTop + (originH - h);
        }
        const sw = surface.clientWidth || window.innerWidth;
        const sh = surface.clientHeight || window.innerHeight;
        left = Math.max(0, Math.min(left, sw - minWidth));
        top = Math.max(0, Math.min(top, sh - minHeight));
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
      };
      const onUp = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    if (isNarrow()) {
      rec.restoreRect = { left, top, width, height };
      rec.maximized = true;
      el.classList.add('is-maximized');
    }

    focusWindow(id);
    return handle;
  }

  function makeWinButton(kind: string, svg: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'faisal-win-btn';
    btn.dataset.kind = kind;
    btn.setAttribute('aria-label', t(`shell.win.${kind}`));
    btn.append(renderIcon(svg));
    return btn;
  }

  // Ctrl+Alt+W closes the focused window.
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.altKey && (ev.key === 'w' || ev.key === 'W')) {
      const focused = [...wins.entries()].find(([, r]) => r.el.classList.contains('is-focused'));
      if (focused) {
        ev.preventDefault();
        focused[1].handle.close();
      }
    }
  });

  return {
    open,
    list: () => [...wins.values()].map((r) => r.handle),
    get: (id) => wins.get(id)?.handle,
  };
}
