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
import { formatReleaseDate, isNewRelease } from './release';
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

/**
 * The three tabs are real tabs: one tablist, and one panel per tab so the panel
 * a tab claims in `aria-controls` is a panel that really exists. Every panel is
 * keyed here because a top-level tab is not a fixed set.
 */
const TABS: { id: StoreTab; key: string; panelId: string }[] = [
  { id: 'explore', key: 'store.tabExplore', panelId: 'faisal-store-panel-explore' },
  { id: 'installed', key: 'store.tabInstalled', panelId: 'faisal-store-panel-installed' },
  { id: 'updates', key: 'store.tabUpdates', panelId: 'faisal-store-panel-updates' },
];

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, prefersReducedMotion() ? 0 : ms));
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
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

  const root = element('div', 'faisal-store');

  /*
   * The search field and the category chips share ONE wrapping row (`.faisal-store-controls`)
   * inside the header, so at 320px they wrap onto a second line instead of fighting for space.
   * The row is part of the header, which the window's flex column keeps at the top; only the
   * panel below it scrolls.
   */
  const header = element('div', 'faisal-store-header');
  const controls = element('div', 'faisal-store-controls');

  const search = element('input', 'faisal-store-search');
  search.type = 'search';
  search.placeholder = t('store.searchPlaceholder');
  search.setAttribute('aria-label', t('store.searchLabel'));
  search.autocomplete = 'off';
  search.spellcheck = false;

  const chips = element('div', 'faisal-store-chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', t('store.filterLabel'));
  chips.setAttribute('aria-controls', TABS[0].panelId);

  controls.append(search, chips);
  header.append(controls);

  const tabsBar = element('div', 'faisal-store-tabs');
  tabsBar.setAttribute('role', 'tablist');
  tabsBar.setAttribute('aria-label', t('store.title'));

  const panels = new Map<StoreTab, HTMLElement>();
  for (const tb of TABS) {
    const panel = element('div', 'faisal-store-body');
    panel.id = tb.panelId;
    panel.setAttribute('role', 'tabpanel');
    panel.tabIndex = 0;
    panels.set(tb.id, panel);
  }

  root.append(header, tabsBar);
  for (const tb of TABS) root.append(panels.get(tb.id) as HTMLElement);
  win.content.append(root);

  let tab: StoreTab = 'explore';
  let category: CategoryFilter = 'all';
  let detailId: string | undefined = initialDetailId && sys.apps.catalog().some((a) => a.id === initialDetailId)
    ? initialDetailId
    : undefined;
  let busy = false; // install/remove in progress
  let confirmingRemove = false;
  let renderedCategory: CategoryFilter | undefined; // the category the chips currently show

  const locale = (): Locale => sys.locale();

  const tabButtons = new Map<StoreTab, HTMLButtonElement>();
  for (const tb of TABS) {
    const btn = element('button', 'faisal-store-tab', t(tb.key));
    btn.type = 'button';
    btn.id = `faisal-store-tab-${tb.id}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', tb.panelId);
    btn.setAttribute('aria-selected', 'false');
    btn.addEventListener('click', () => selectTab(tb.id));
    // Roving tabindex: exactly one tab is in the page tab order, and the arrow keys move
    // between them (Left/Right follow the writing direction, Home/End jump to the ends).
    btn.addEventListener('keydown', (event) => onTabKeydown(event, tb.id));
    tabButtons.set(tb.id, btn);
    tabsBar.append(btn);
  }

  /**
   * Move the selection: every render re-declares which panel each tab claims, so
   * `aria-controls` never points at a panel that is not the one on screen. `focusTab`
   * is used by the keyboard path, where the focus must follow the selection.
   */
  function selectTab(next: StoreTab, focusTab = false) {
    tab = next;
    detailId = undefined;
    confirmingRemove = false;
    render();
    if (focusTab) tabButtons.get(next)?.focus();
  }

  function tabStep(id: StoreTab, delta: number, wrap: boolean): StoreTab {
    const index = TABS.findIndex((tb) => tb.id === id);
    let next = index + delta;
    if (wrap) next = (next + TABS.length) % TABS.length;
    return TABS[Math.min(TABS.length - 1, Math.max(0, next))].id;
  }

  function onTabKeydown(event: KeyboardEvent, id: StoreTab) {
    const rtl = document.documentElement.dir === 'rtl' || (document.documentElement.dir !== 'ltr' && locale() === 'ar');
    switch (event.key) {
      case 'ArrowRight': event.preventDefault(); selectTab(tabStep(id, rtl ? -1 : 1, true), true); break;
      case 'ArrowLeft': event.preventDefault(); selectTab(tabStep(id, rtl ? 1 : -1, true), true); break;
      case 'Home': event.preventDefault(); selectTab(TABS[0].id, true); break;
      case 'End': event.preventDefault(); selectTab(TABS[TABS.length - 1].id, true); break;
      default: break;
    }
  }

  search.addEventListener('input', () => {
    // Searching always lands on Explore: typing while on another tab should show results
    // rather than appear to do nothing.
    selectTab('explore');
  });

  function catalogEntry(id: string): CatalogEntry | undefined {
    return sys.apps.catalog().find((a) => a.id === id);
  }

  function categoryLabel(entry: CatalogEntry): string {
    return t(CATEGORY_KEY[(entry.category ?? 'system') as CategoryFilter] ?? 'store.categorySystem');
  }

  function makeIcon(svg: string, cls: string): HTMLElement {
    const wrap = element('span', cls);
    wrap.setAttribute('aria-hidden', 'true');
    wrap.append(renderIcon(svg));
    return wrap;
  }

  function controlsEnabled(enabled: boolean) {
    controls.hidden = !enabled;
    search.disabled = !enabled;
    chips.setAttribute('aria-hidden', enabled ? 'false' : 'true');
  }

  /**
   * The chips are rebuilt only when the selection really changed: rebuilding them on every
   * render would throw away the chip the keyboard is standing on (an install re-renders).
   */
  function renderChips() {
    if (renderedCategory === category) return;
    renderedCategory = category;
    chips.textContent = '';
    for (const c of CATEGORIES) {
      const active = c === category;
      const chip = element('button', 'faisal-store-chip' + (active ? ' is-active' : ''), t(CATEGORY_KEY[c]));
      chip.type = 'button';
      // The colour of the active chip is never the only signal: `aria-pressed` says the
      // same thing to assistive tech, and the label names what the chip filters.
      chip.setAttribute('aria-pressed', String(active));
      chip.setAttribute('aria-label', `${t('store.filterLabel')}: ${t(CATEGORY_KEY[c])}`);
      chip.addEventListener('click', () => { category = c; render(); });
      chips.append(chip);
    }
  }

  /**
   * One card, always the same anatomy in the same order: icon, name, category,
   * description, the released line when the manifest really carries one, and a
   * `.faisal-store-badges` row that is rendered even when it holds no badge — so a
   * card with nothing to say is exactly as tall as one that has a badge.
   */
  function renderCard(entry: CatalogEntry): HTMLElement {
    const card = element('button', 'faisal-store-card');
    card.type = 'button';
    // A card's visible text is the app's own name plus a category word, which reads as
    // two unrelated strings; the label states name, category and install state in order.
    card.setAttribute('aria-label', t('store.cardLabel', {
      name: entry.name[locale()],
      category: categoryLabel(entry),
      state: t(entry.installed ? 'store.cardStateInstalled' : 'store.cardStateNotInstalled'),
    }));
    card.addEventListener('click', () => { detailId = entry.id; confirmingRemove = false; render(); });

    const top = element('div', 'faisal-store-card-top');
    top.append(makeIcon(entry.icon, 'faisal-store-card-icon'));
    const head = element('div', 'faisal-store-card-head');
    head.append(
      element('div', 'faisal-store-card-name', entry.name[locale()]),
      element('div', 'faisal-store-card-cat', categoryLabel(entry)),
    );
    top.append(head);

    const desc = element('div', 'faisal-store-card-desc', describeApp(entry, locale()) || t('store.noDescription'));
    card.append(top, desc);

    // The release date is shown only when the manifest really carries one, and the "new"
    // badge only while it is recent, so nothing here is invented for older apps.
    const released = formatReleaseDate(entry.releasedAt, locale());
    if (released) {
      card.append(element('div', 'faisal-store-card-released', t('store.releasedOn', { date: released })));
    }

    const badges = element('div', 'faisal-store-badges');
    if (isNewRelease(entry.releasedAt, Date.now())) {
      badges.append(element('span', 'faisal-store-badge is-new', t('store.newBadge')));
    }
    if (entry.installed) {
      badges.append(element('span', 'faisal-store-badge is-installed', t('store.installedBadge')));
    }
    card.append(badges);

    return card;
  }

  function renderExplore(panel: HTMLElement) {
    const all = sys.apps.catalog();
    const featured = pickFeatured(all);

    if (featured && !search.value.trim()) {
      const banner = element('button', 'faisal-store-banner');
      banner.type = 'button';
      banner.addEventListener('click', () => { detailId = featured.id; confirmingRemove = false; render(); });
      banner.append(makeIcon(featured.icon, 'faisal-store-banner-icon'));
      const text = element('div', 'faisal-store-banner-text');
      text.append(
        element('div', 'faisal-store-banner-eyebrow', t('store.featuredBadge')),
        element('div', 'faisal-store-banner-name', featured.name[locale()]),
        element('div', 'faisal-store-banner-desc', describeApp(featured, locale()) || t('store.noDescription')),
      );
      banner.append(text, element('span', 'faisal-store-banner-cta', t('store.bannerCta')));
      panel.append(banner);
    }

    const filtered = sortedCatalog(
      filterCatalog(all, { category, query: search.value, locale: locale() }),
      locale(),
    );
    renderGrid(panel, filtered, search.value.trim() ? { kind: 'search', query: search.value.trim() } : { kind: 'none' });
  }

  function renderInstalled(panel: HTMLElement) {
    const installed = sortedCatalog(
      filterCatalog(sys.apps.catalog().filter((a) => a.installed), { category: 'all', query: search.value, locale: locale() }),
      locale(),
    );
    renderGrid(panel, installed, { kind: 'installed' });
  }

  type EmptyKind = { kind: 'none' } | { kind: 'search'; query: string } | { kind: 'installed' };

  /**
   * The empty state says what actually happened: a search that matched nothing names the
   * term that was searched, and the installed tab says no extra app is installed. A grid
   * that is empty without a search (an empty category) gets the plain line.
   */
  function emptyMessage(empty: EmptyKind): string {
    if (empty.kind === 'search') return t('store.emptySearch', { query: empty.query });
    if (empty.kind === 'installed') return t('store.emptyInstalled');
    return t('store.emptyExplore');
  }

  function renderGrid(panel: HTMLElement, entries: CatalogEntry[], empty: EmptyKind) {
    if (entries.length === 0) {
      const box = element('div', 'faisal-store-empty', emptyMessage(empty));
      // An empty result is a change caused by the search/filter, so it is announced.
      box.setAttribute('role', 'status');
      panel.append(box);
      return;
    }
    const grid = element('div', 'faisal-store-grid');
    for (const entry of entries) grid.append(renderCard(entry));
    panel.append(grid);
  }

  function renderUpdates(panel: HTMLElement) {
    // Fai$al OS ships no package source and no remote version metadata, so a
    // real update check is impossible. Say that plainly instead of claiming
    // every app is up to date or printing a version that implies a comparison.
    const box = element('div', 'faisal-store-uptodate');
    box.append(
      element('div', 'faisal-store-uptodate-title', t('store.builtInTitle')),
      element('div', undefined, t('store.builtInBody')),
    );
    panel.append(box);
  }

  function renderPermissions(section: HTMLElement, permissions: Permission[]) {
    if (permissions.length === 0) {
      section.append(element('div', 'faisal-store-empty', t('store.permissionsNone')));
      return;
    }

    const list = element('div', 'faisal-store-perm-list');
    for (const p of permissions) {
      const warn = isPowerfulPermission(p);
      const item = element('div', 'faisal-store-perm-item' + (warn ? ' is-warning' : ''));
      const dot = element('span', 'faisal-store-perm-dot');
      dot.setAttribute('aria-hidden', 'true');
      const body = element('div', 'faisal-store-perm-text');
      body.append(element('div', 'faisal-store-perm-desc', permissionDescription(p, locale())));
      if (warn) {
        // The warning is a sentence, not just a red dot, so the meaning survives without colour.
        body.append(element('div', 'faisal-store-perm-warning', t('store.permissionWarning')));
      }
      item.append(dot, body);
      list.append(item);
    }
    section.append(list);
  }

  function sectionTitle(text: string): HTMLElement {
    return element('div', 'faisal-store-detail-section-title', text);
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

  /**
   * The buttons for one app, plus the confirm step when a removal is being confirmed:
   * `confirmingRemove` swaps the Remove button out and puts the question in its place,
   * so the prompt and the button that opened it never appear on screen at once.
   */
  function renderActions(section: HTMLElement, entry: CatalogEntry) {
    const actions = element('div', 'faisal-store-detail-actions');
    if (confirmingRemove && !busy && entry.installed && !entry.core) {
      actions.classList.add('is-confirming');
      renderConfirm(actions, entry);
      section.append(actions);
      return;
    }
    if (busy) {
      const progress = element('div', 'faisal-store-progress');
      // Install/remove is asynchronous: the "Installing…" line is the status.
      progress.setAttribute('role', 'status');
      const spinner = element('span', 'faisal-store-spinner');
      // Decorative only: the label beside it carries the meaning for screen readers.
      spinner.setAttribute('aria-hidden', 'true');
      progress.append(spinner, element('span', undefined, entry.installed ? t('store.removing') : t('store.installing')));
      actions.append(progress);
    } else if (!entry.installed) {
      const installBtn = element('button', 'faisal-store-btn is-primary', t('store.install'));
      installBtn.type = 'button';
      installBtn.addEventListener('click', () => doInstall(entry));
      actions.append(installBtn);
    } else {
      const openBtn = element('button', 'faisal-store-btn is-primary', t('store.open'));
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => sys.apps.launch(entry.id));
      actions.append(openBtn);

      // A core app is never removable, so it offers no Remove button at all.
      if (!entry.core && !confirmingRemove) {
        const removeBtn = element('button', 'faisal-store-btn is-danger', t('store.remove'));
        removeBtn.type = 'button';
        removeBtn.addEventListener('click', () => { confirmingRemove = true; render(); });
        actions.append(removeBtn);
      }
    }
    section.append(actions);
  }

  function renderConfirm(section: HTMLElement, entry: CatalogEntry) {
    const confirm = element('div', 'faisal-store-confirm');
    confirm.append(
      element('div', 'faisal-store-confirm-title', t('store.removeConfirmTitle', { name: entry.name[locale()] })),
      element('div', 'faisal-store-confirm-body', t('store.removeConfirmBody')),
    );
    const actions = element('div', 'faisal-store-confirm-actions');
    const yes = element('button', 'faisal-store-btn is-danger', t('store.removeConfirmYes'));
    yes.type = 'button';
    yes.addEventListener('click', () => doRemove(entry));
    const no = element('button', 'faisal-store-btn is-ghost', t('store.removeConfirmNo'));
    no.type = 'button';
    no.addEventListener('click', () => { confirmingRemove = false; render(); });
    actions.append(yes, no);
    confirm.append(actions);
    section.append(confirm);
  }

  /**
   * The detail pane is four `.faisal-store-detail-section`s in a fixed order — about,
   * actions, permissions, limits — so every app reads the same way and nothing moves
   * around between apps. The action buttons live inside their section; the confirm
   * block sits in the actions section right under the button that opened it.
   */
  function renderDetail(container: HTMLElement, id: string) {
    const entry = catalogEntry(id);
    if (!entry) { detailId = undefined; render(); return; }

    const back = element('button', 'faisal-store-back');
    back.type = 'button';
    back.append(renderIcon(ICON_BACK), document.createTextNode(t('store.back')));
    back.addEventListener('click', () => { detailId = undefined; confirmingRemove = false; render(); });
    container.append(back);

    // ── about ─────────────────────────────────────────────────────────
    const about = element('div', 'faisal-store-detail-section');
    about.setAttribute('aria-labelledby', 'faisal-store-about-title');
    const aboutTitle = sectionTitle(t('store.aboutTitle'));
    aboutTitle.id = 'faisal-store-about-title';
    about.append(aboutTitle);

    const head = element('div', 'faisal-store-detail-head');
    head.append(makeIcon(entry.icon, 'faisal-store-detail-icon'));
    const info = element('div', 'faisal-store-detail-info');
    const meta = element('div', 'faisal-store-detail-meta');
    // Only show a version the catalog actually carries; most apps have none,
    // and inventing a fallback version would be fabricated data.
    if (entry.version) {
      meta.append(element('span', 'faisal-store-detail-version', `${t('store.versionLabel')}: ${entry.version}`));
    }
    meta.append(element('span', 'faisal-store-detail-category', `${t('store.categoryLabel')}: ${categoryLabel(entry)}`));
    const released = formatReleaseDate(entry.releasedAt, locale());
    if (released) {
      meta.append(element('span', 'faisal-store-detail-released', t('store.releasedOn', { date: released })));
    }
    info.append(element('div', 'faisal-store-detail-name', entry.name[locale()]), meta);
    head.append(info);
    about.append(head, element('div', 'faisal-store-detail-desc', describeApp(entry, locale()) || t('store.noDescription')));
    container.append(about);

    // ── actions ───────────────────────────────────────────────────────
    const actions = element('div', 'faisal-store-detail-section');
    actions.setAttribute('aria-labelledby', 'faisal-store-actions-title');
    const actionsTitle = sectionTitle(t('store.actionsTitle'));
    actionsTitle.id = 'faisal-store-actions-title';
    actions.append(actionsTitle);
    renderActions(actions, entry);
    container.append(actions);

    // ── permissions ───────────────────────────────────────────────────
    const permissions = element('div', 'faisal-store-detail-section faisal-store-permissions');
    permissions.setAttribute('aria-labelledby', 'faisal-store-permissions-title');
    const permissionsTitle = sectionTitle(t('store.permissionsTitle'));
    permissionsTitle.id = 'faisal-store-permissions-title';
    permissions.append(permissionsTitle);
    renderPermissions(permissions, entry.permissions);
    container.append(permissions);

    // ── limits ────────────────────────────────────────────────────────
    const limits = element('div', 'faisal-store-detail-section');
    limits.setAttribute('aria-labelledby', 'faisal-store-limits-title');
    const limitsTitle = sectionTitle(t('store.limitsTitle'));
    limitsTitle.id = 'faisal-store-limits-title';
    limits.append(limitsTitle);
    // "No known restrictions" is only claimed for apps that really are not core; a core app
    // says it cannot be removed. Kept as a visible sentence so it never depends on colour.
    limits.append(element('div', 'faisal-store-detail-limits', entry.core ? t('store.coreCantRemove') : t('store.limitsNone')));
    container.append(limits);
  }

  function render() {
    // The visual `is-active` class is not exposed to assistive tech, so the tab
    // state is mirrored into aria-selected and the panel names its active tab.
    tabButtons.forEach((btn, id) => {
      const active = id === tab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    });

    for (const tb of TABS) {
      const panel = panels.get(tb.id) as HTMLElement;
      const active = tb.id === tab;
      panel.hidden = !active;
      panel.textContent = '';
      const btn = tabButtons.get(tb.id);
      if (btn) panel.setAttribute('aria-labelledby', btn.id);
    }

    controlsEnabled(!detailId);
    chips.setAttribute('aria-controls', TABS.find((tb) => tb.id === tab)?.panelId ?? TABS[0].panelId);
    renderChips();

    const panel = panels.get(tab) as HTMLElement;
    if (detailId) {
      const detail = element('div', 'faisal-store-detail');
      detail.setAttribute('aria-label', t('store.aboutTitle'));
      panel.append(detail);
      renderDetail(detail, detailId);
      return;
    }
    if (tab === 'explore') renderExplore(panel);
    else if (tab === 'installed') renderInstalled(panel);
    else renderUpdates(panel);
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
