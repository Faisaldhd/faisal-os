import type { SystemAPI } from '../kernel/types';
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
 */
export function mountDock(root: HTMLElement, sys: SystemAPI): HTMLElement {
  const bar = document.createElement('nav');
  bar.className = 'faisal-dock-bar';
  const dock = document.createElement('div');
  dock.className = 'faisal-dock faisal-dock-pinned';
  bar.append(dock);
  root.append(bar);

  function render() {
    dock.textContent = '';
    const open = sys.wm.list();
    const running = new Set(open.map((w) => w.appId));
    const focusedApp = sys.wm.focused()?.appId;
    const byId = new Map(sys.apps.list().map((a) => [a.id, a] as const));
    const ids = getDashIds(sys);
    for (const id of running) if (!ids.includes(id)) ids.push(id);
    for (const id of ids) {
      const app = byId.get(id);
      if (!app) continue;
      // Web apps (category 'web') are deliberately kept OUT of the dock: there is
      // one per wired site, they would crowd out the real launchers on a phone,
      // and the Activities overview has a dedicated "Web Apps" group for them.
      // Everything else keeps the previous dock behaviour unchanged.
      if (app.category === 'web') continue;
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
        showContextMenu(x, y, appTileMenuItems(sys, app, { onChange: render }), { invoker: btn });
      });
      dock.append(btn);
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
  return bar;
}
