import { manifest } from './manifest';
import type { AppContext, AppModule, CatalogEntry, Locale, Permission } from '../../kernel/types';
import { t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import {
  CATEGORIES,
  describeApp,
  filterCatalog,
  isPowerfulPermission,
  permissionDescription,
  pickFeatured,
  sortedCatalog,
  type CategoryFilter,
  type StoreTab,
} from './model';
import './strings';
import './store.css';

const ICON_BACK =
  '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CATEGORY_KEY: Record<CategoryFilter, string> = {
  all: 'store.categoryAll',
  system: 'store.categorySystem',
  utilities: 'store.categoryUtilities',
  accessories: 'store.categoryAccessories',
  media: 'store.categoryMedia',
  development: 'store.categoryDevelopment',
  web: 'store.categoryWeb',
};

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, prefersReducedMotion() ? 0 : ms));
}

function launch(ctx: AppContext) {
  const { sys, window: win, args } = ctx;
  win.content.textContent = '';

  // `['app', <id>]` opens that app's detail page directly (used by the shell's
  // context-menu "App details" action). Since the Store is singleInstance, a
  // relaunch while a Store window is already open reuses that window and does
  // NOT re-run this function with the new args — the caller works around that
  // by closing the existing Store window (sys.apps.closeWindow) before
  // launching again, so args are always applied fresh here.
  const initialDetailId = args[0] === 'app' && typeof args[1] === 'string' ? args[1] : undefined;

  const root = document.createElement('div');
  root.className = 'faisal-store';

  const header = document.createElement('div');
  header.className = 'faisal-store-header';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'faisal-store-search';
  search.placeholder = t('store.searchPlaceholder');
  search.autocomplete = 'off';
  search.spellcheck = false;
  header.append(search);

  const tabsBar = document.createElement('div');
  tabsBar.className = 'faisal-store-tabs';

  const body = document.createElement('div');
  body.className = 'faisal-store-body';

  root.append(header, tabsBar, body);
  win.content.append(root);

  let tab: StoreTab = 'explore';
  let category: CategoryFilter = 'all';
  let detailId: string | undefined = initialDetailId && sys.apps.catalog().some((a) => a.id === initialDetailId)
    ? initialDetailId
    : undefined;
  let busy = false; // install/remove in progress
  let confirmingRemove = false;

  const locale = (): Locale => sys.locale();

  const tabs: { id: StoreTab; key: string }[] = [
    { id: 'explore', key: 'store.tabExplore' },
    { id: 'installed', key: 'store.tabInstalled' },
    { id: 'updates', key: 'store.tabUpdates' },
  ];
  const tabButtons = new Map<StoreTab, HTMLButtonElement>();
  for (const tb of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'faisal-store-tab';
    btn.textContent = t(tb.key);
    btn.addEventListener('click', () => {
      tab = tb.id;
      detailId = undefined;
      confirmingRemove = false;
      render();
    });
    tabButtons.set(tb.id, btn);
    tabsBar.append(btn);
  }

  search.addEventListener('input', () => {
    if (tab !== 'explore') { tab = 'explore'; }
    detailId = undefined;
    render();
  });

  function catalogEntry(id: string): CatalogEntry | undefined {
    return sys.apps.catalog().find((a) => a.id === id);
  }

  function makeIcon(svg: string, cls: string): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = cls;
    wrap.append(renderIcon(svg));
    return wrap;
  }

  function renderCard(entry: CatalogEntry): HTMLElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'faisal-store-card';
    card.addEventListener('click', () => { detailId = entry.id; confirmingRemove = false; render(); });

    const top = document.createElement('div');
    top.className = 'faisal-store-card-top';
    top.append(makeIcon(entry.icon, 'faisal-store-card-icon'));
    const nameWrap = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'faisal-store-card-name';
    name.textContent = entry.name[locale()];
    const cat = document.createElement('div');
    cat.className = 'faisal-store-card-cat';
    cat.textContent = t(CATEGORY_KEY[(entry.category ?? 'system') as CategoryFilter] ?? 'store.categorySystem');
    nameWrap.append(name, cat);
    top.append(nameWrap);

    const desc = document.createElement('div');
    desc.className = 'faisal-store-card-desc';
    desc.textContent = describeApp(entry, locale()) || t('store.noDescription');

    card.append(top, desc);

    if (entry.installed) {
      const badge = document.createElement('span');
      badge.className = 'faisal-store-badge is-installed';
      badge.textContent = t('store.installedBadge');
      card.append(badge);
    }

    return card;
  }

  function renderExplore() {
    const all = sys.apps.catalog();
    const featured = pickFeatured(all);

    if (featured && !search.value.trim()) {
      const banner = document.createElement('button');
      banner.type = 'button';
      banner.className = 'faisal-store-banner';
      banner.addEventListener('click', () => { detailId = featured.id; confirmingRemove = false; render(); });
      banner.append(makeIcon(featured.icon, 'faisal-store-banner-icon'));
      const text = document.createElement('div');
      text.className = 'faisal-store-banner-text';
      const eyebrow = document.createElement('div');
      eyebrow.className = 'faisal-store-banner-eyebrow';
      eyebrow.textContent = t('store.featuredBadge');
      const name = document.createElement('div');
      name.className = 'faisal-store-banner-name';
      name.textContent = featured.name[locale()];
      const desc = document.createElement('div');
      desc.className = 'faisal-store-banner-desc';
      desc.textContent = describeApp(featured, locale()) || t('store.noDescription');
      text.append(eyebrow, name, desc);
      const cta = document.createElement('span');
      cta.className = 'faisal-store-banner-cta';
      cta.textContent = t('store.bannerCta');
      banner.append(text, cta);
      body.append(banner);
    }

    const chips = document.createElement('div');
    chips.className = 'faisal-store-chips';
    for (const c of CATEGORIES) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'faisal-store-chip' + (c === category ? ' is-active' : '');
      chip.textContent = t(CATEGORY_KEY[c]);
      chip.addEventListener('click', () => { category = c; render(); });
      chips.append(chip);
    }
    body.append(chips);

    const filtered = sortedCatalog(
      filterCatalog(all, { category, query: search.value, locale: locale() }),
      locale(),
    );
    renderGrid(filtered, 'store.emptyExplore');
  }

  function renderInstalled() {
    const installed = sortedCatalog(
      filterCatalog(sys.apps.catalog().filter((a) => a.installed), { category: 'all', query: search.value, locale: locale() }),
      locale(),
    );
    renderGrid(installed, 'store.emptyInstalled');
  }

  function renderGrid(entries: CatalogEntry[], emptyKey: string) {
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'faisal-store-empty';
      empty.textContent = t(emptyKey);
      body.append(empty);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'faisal-store-grid';
    for (const entry of entries) grid.append(renderCard(entry));
    body.append(grid);
  }

  function renderUpdates() {
    // Fai$al OS ships no package source and no remote version metadata, so a
    // real update check is impossible. Say that plainly instead of claiming
    // every app is up to date or printing a version that implies a comparison.
    const panel = document.createElement('div');
    panel.className = 'faisal-store-uptodate';
    const title = document.createElement('div');
    title.className = 'faisal-store-uptodate-title';
    title.textContent = t('store.builtInTitle');
    const desc = document.createElement('div');
    desc.textContent = t('store.builtInBody');
    panel.append(title, desc);
    body.append(panel);
  }

  function renderPermissions(permissions: Permission[]) {
    const wrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'faisal-store-perm-title';
    title.textContent = t('store.permissionsTitle');
    wrap.append(title);

    if (permissions.length === 0) {
      const none = document.createElement('div');
      none.className = 'faisal-store-empty';
      none.style.padding = '0';
      none.style.textAlign = 'start';
      none.textContent = t('store.permissionsNone');
      wrap.append(none);
      return wrap;
    }

    const list = document.createElement('div');
    list.className = 'faisal-store-perm-list';
    for (const p of permissions) {
      const warn = isPowerfulPermission(p);
      const item = document.createElement('div');
      item.className = 'faisal-store-perm-item' + (warn ? ' is-warning' : '');
      const dot = document.createElement('span');
      dot.className = 'faisal-store-perm-dot';
      const textWrap = document.createElement('div');
      const desc = document.createElement('div');
      desc.textContent = permissionDescription(p, locale());
      textWrap.append(desc);
      if (warn) {
        const warning = document.createElement('div');
        warning.style.marginTop = '3px';
        warning.style.opacity = '0.85';
        warning.textContent = t('store.permissionWarning');
        textWrap.append(warning);
      }
      item.append(dot, textWrap);
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  async function doInstall(entry: CatalogEntry) {
    busy = true;
    render();
    try {
      await wait(600);
      sys.apps.install(entry.id);
      sys.notify(t('store.installedNotify', { name: entry.name[locale()] }));
    } finally {
      busy = false;
      render();
    }
  }

  async function doRemove(entry: CatalogEntry) {
    busy = true;
    confirmingRemove = false;
    render();
    try {
      await wait(600);
      sys.apps.uninstall(entry.id);
      sys.notify(t('store.removedNotify', { name: entry.name[locale()] }));
    } finally {
      busy = false;
      render();
    }
  }

  function renderDetail(container: HTMLElement, id: string) {
    const entry = catalogEntry(id);
    if (!entry) { detailId = undefined; render(); return; }

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'faisal-store-back';
    back.append(renderIcon(ICON_BACK), document.createTextNode(t('store.back')));
    back.addEventListener('click', () => { detailId = undefined; confirmingRemove = false; render(); });
    container.append(back);

    const head = document.createElement('div');
    head.className = 'faisal-store-detail-head';
    head.append(makeIcon(entry.icon, 'faisal-store-detail-icon'));
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'faisal-store-detail-name';
    name.textContent = entry.name[locale()];
    const meta = document.createElement('div');
    meta.className = 'faisal-store-detail-meta';
    // Only show a version the catalog actually carries; most apps have none,
    // and inventing a fallback version would be fabricated data.
    if (entry.version) {
      const version = document.createElement('span');
      version.textContent = `${t('store.versionLabel')}: ${entry.version}`;
      meta.append(version);
    }
    const cat = document.createElement('span');
    cat.textContent = `${t('store.categoryLabel')}: ${t(CATEGORY_KEY[(entry.category ?? 'system') as CategoryFilter] ?? 'store.categorySystem')}`;
    meta.append(cat);
    info.append(name, meta);
    head.append(info);
    container.append(head);

    const desc = document.createElement('div');
    desc.className = 'faisal-store-detail-desc';
    desc.textContent = describeApp(entry, locale()) || t('store.noDescription');
    container.append(desc);

    const actions = document.createElement('div');
    actions.className = 'faisal-store-detail-actions';

    if (busy) {
      const progress = document.createElement('div');
      progress.className = 'faisal-store-progress';
      const spinner = document.createElement('span');
      spinner.className = 'faisal-store-spinner';
      const label = document.createElement('span');
      label.textContent = entry.installed ? t('store.removing') : t('store.installing');
      progress.append(spinner, label);
      actions.append(progress);
    } else if (!entry.installed) {
      const installBtn = document.createElement('button');
      installBtn.type = 'button';
      installBtn.className = 'faisal-store-btn is-primary';
      installBtn.textContent = t('store.install');
      installBtn.addEventListener('click', () => doInstall(entry));
      actions.append(installBtn);
    } else {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'faisal-store-btn is-primary';
      openBtn.textContent = t('store.open');
      openBtn.addEventListener('click', () => sys.apps.launch(entry.id));
      actions.append(openBtn);

      if (entry.core) {
        const note = document.createElement('span');
        note.className = 'faisal-store-core-note';
        note.textContent = t('store.coreCantRemove');
        actions.append(note);
      } else if (!confirmingRemove) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'faisal-store-btn is-danger';
        removeBtn.textContent = t('store.remove');
        removeBtn.addEventListener('click', () => { confirmingRemove = true; render(); });
        actions.append(removeBtn);
      }
    }
    container.append(actions);

    if (confirmingRemove && !busy && entry.installed && !entry.core) {
      const confirm = document.createElement('div');
      confirm.className = 'faisal-store-confirm';
      const title = document.createElement('div');
      title.className = 'faisal-store-confirm-title';
      title.textContent = t('store.removeConfirmTitle', { name: entry.name[locale()] });
      const desc2 = document.createElement('div');
      desc2.className = 'faisal-store-confirm-body';
      desc2.textContent = t('store.removeConfirmBody');
      const cActions = document.createElement('div');
      cActions.className = 'faisal-store-confirm-actions';
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'faisal-store-btn is-danger';
      yes.textContent = t('store.removeConfirmYes');
      yes.addEventListener('click', () => doRemove(entry));
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'faisal-store-btn is-ghost';
      no.textContent = t('store.removeConfirmNo');
      no.addEventListener('click', () => { confirmingRemove = false; render(); });
      cActions.append(yes, no);
      confirm.append(title, desc2, cActions);
      container.append(confirm);
    }

    container.append(renderPermissions(entry.permissions));
  }

  function render() {
    tabButtons.forEach((btn, id) => btn.classList.toggle('is-active', id === tab));
    body.textContent = '';
    if (detailId) {
      const detailWrap = document.createElement('div');
      detailWrap.className = 'faisal-store-detail';
      body.append(detailWrap);
      renderDetail(detailWrap, detailId);
      return;
    }
    if (tab === 'explore') renderExplore();
    else if (tab === 'installed') renderInstalled();
    else renderUpdates();
  }

  const unsubscribe = sys.bus.on('apps:changed', () => render());
  win.onClose(() => unsubscribe());

  render();
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
