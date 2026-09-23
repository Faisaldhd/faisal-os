import type { SystemAPI } from '../kernel/types';
import { renderIcon } from './icon';
import { showContextMenu, wireContextMenu } from './contextmenu';
import { appTileMenuItems, getDashIds } from './desktop';

/**
 * Always-visible dock pinned to the bottom of the desktop. It sits in the desktop's
 * flex column after the window surface, so maximized windows stop above it.
 * It shows the pinned apps (the dash list), then any running app that isn't pinned.
 * Clicking an app focuses its newest window if one is open, otherwise launches it;
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
    const running = new Set(sys.wm.list().map((w) => w.appId));
    const byId = new Map(sys.apps.list().map((a) => [a.id, a] as const));
    const ids = getDashIds(sys);
    for (const id of running) if (!ids.includes(id)) ids.push(id);
    for (const id of ids) {
      const app = byId.get(id);
      if (!app) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'faisal-dock-btn' + (running.has(app.id) ? ' is-running' : '');
      btn.title = app.name[sys.locale()];
      btn.setAttribute('aria-label', btn.title);
      btn.append(renderIcon(app.icon));
      btn.addEventListener('click', () => {
        const wins = sys.wm.list().filter((w) => w.appId === app.id);
        if (wins.length) wins[wins.length - 1].focus();
        else sys.apps.launch(app.id);
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
  sys.bus.on('settings:change', ({ key }) => { if (key === 'shell.dash') render(); });
  return bar;
}
