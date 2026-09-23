import type { SystemAPI, WindowManager, AppManifest } from '../kernel/types';
import { t } from '../kernel/i18n';
import { renderIcon } from './icon';
import { showContextMenu, wireContextMenu } from './contextmenu';
import { appTileMenuItems, getDashIds } from './desktop';

const ICON_WINDOW =
  '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="3" y1="8.5" x2="21" y2="8.5" stroke="currentColor" stroke-width="1.6"/></svg>';

export interface Overview {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

export function mountOverview(root: HTMLElement, sys: SystemAPI, wm: WindowManager): Overview {
  const overlay = document.createElement('div');
  overlay.className = 'faisal-overview';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'faisal-search';
  search.placeholder = t('shell.search.placeholder');
  search.autocomplete = 'off';
  search.spellcheck = false;

  const body = document.createElement('div');
  body.className = 'faisal-overview-body';

  const winSection = document.createElement('div');
  winSection.className = 'faisal-win-thumbs';

  const appGrid = document.createElement('div');
  appGrid.className = 'faisal-app-grid';

  const empty = document.createElement('div');
  empty.className = 'faisal-overview-empty';
  empty.textContent = t('shell.overview.empty');
  empty.hidden = true;

  body.append(winSection, appGrid, empty);

  const dock = document.createElement('div');
  dock.className = 'faisal-dock';

  overlay.append(search, body, dock);
  root.append(overlay);

  let open = false;
  let filtered: AppManifest[] = [];
  let selected = 0;

  function matches(app: AppManifest, query: string): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    return app.name.ar.toLowerCase().includes(q) || app.name.en.toLowerCase().includes(q);
  }

  function renderWindows() {
    winSection.textContent = '';
    const handles = wm.list();
    if (handles.length === 0) { winSection.hidden = true; return; }
    winSection.hidden = false;
    for (const win of handles) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'faisal-win-thumb';
      const barEl = document.createElement('div');
      barEl.className = 'faisal-win-thumb-bar';
      const app = sys.apps.list().find((a) => a.id === win.appId);
      barEl.append(renderIcon(app?.icon ?? ICON_WINDOW), document.createTextNode(app?.name[sys.locale()] ?? win.appId));
      const bodyEl = document.createElement('div');
      bodyEl.className = 'faisal-win-thumb-body';
      bodyEl.textContent = app?.name[sys.locale()] ?? win.appId;
      card.append(barEl, bodyEl);
      card.addEventListener('click', () => {
        win.focus();
        close();
      });
      winSection.append(card);
    }
  }

  function renderApps() {
    const query = search.value.trim();
    filtered = sys.apps.list().filter((a) => matches(a, query));
    selected = 0;
    appGrid.textContent = '';
    empty.hidden = filtered.length > 0;
    filtered.forEach((app, i) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'faisal-app-tile' + (i === selected ? ' is-selected' : '');
      const iconWrap = document.createElement('span');
      iconWrap.className = 'faisal-app-icon';
      iconWrap.append(renderIcon(app.icon));
      const label = document.createElement('span');
      label.className = 'faisal-app-tile-label';
      label.textContent = app.name[sys.locale()];
      tile.append(iconWrap, label);
      tile.addEventListener('click', () => {
        sys.apps.launch(app.id);
        close();
      });
      wireContextMenu(tile, (x, y) => {
        showContextMenu(x, y, appTileMenuItems(sys, app, { onChange: renderApps, onLaunch: close }), { invoker: tile });
      });
      appGrid.append(tile);
    });
  }

  function renderDock() {
    dock.textContent = '';
    const dashIds = getDashIds(sys);
    const byId = new Map(sys.apps.list().map((a) => [a.id, a] as const));
    for (const id of dashIds) {
      const app = byId.get(id);
      if (!app) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'faisal-dock-btn';
      btn.title = app.name[sys.locale()];
      btn.append(renderIcon(app.icon));
      btn.addEventListener('click', () => {
        sys.apps.launch(app.id);
        close();
      });
      wireContextMenu(btn, (x, y) => {
        showContextMenu(x, y, appTileMenuItems(sys, app, { onChange: renderDock, onLaunch: close }), { invoker: btn });
      });
      dock.append(btn);
    }
  }

  sys.bus.on('apps:changed', () => {
    if (!open) return;
    renderApps();
    renderDock();
  });
  sys.bus.on('settings:change', ({ key }) => {
    if (!open) return;
    if (key === 'shell.dash') renderDock();
  });

  search.addEventListener('input', renderApps);
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && filtered.length > 0) {
      sys.apps.launch(filtered[0].id);
      close();
    } else if (ev.key === 'Escape') {
      close();
    }
  });

  overlay.addEventListener('pointerdown', (ev) => {
    if (ev.target === overlay) close();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open) close();
  });

  function openFn() {
    open = true;
    overlay.classList.add('is-open');
    renderWindows();
    renderDock();
    search.value = '';
    renderApps();
    requestAnimationFrame(() => search.focus());
  }

  function close() {
    open = false;
    overlay.classList.remove('is-open');
  }

  function toggle() {
    if (open) close(); else openFn();
  }

  return { open: openFn, close, toggle, isOpen: () => open };
}
