import type { SystemAPI } from '../kernel/types';
import { renderIcon } from './icon';

/**
 * Always-visible dock pinned to the bottom of the desktop. It sits in the desktop's
 * flex column after the window surface, so maximized windows stop above it.
 * Clicking an app focuses its newest window if one is open, otherwise launches it.
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
    for (const app of sys.apps.list()) {
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
      dock.append(btn);
    }
  }

  render();
  sys.bus.on('apps:changed', render);
  sys.bus.on('app:launched', render);
  sys.bus.on('app:closed', render);
  return bar;
}
