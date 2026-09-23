import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { t, getLocale } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import { loadBookmarks, saveBookmarks, loadEngine, saveEngine } from './model';
import {
  resolveAddressInput,
  isAllowedFrameUrl,
  rewriteYouTubeEmbed,
  isBlockedDomain,
  refusesFraming,
  buildSearchUrl,
  buildOpenStreetMapEmbedUrl,
  type SearchEngine,
} from './url';
import './strings';
import './browser.css';

/* ───────────────────────────── small toolbar icons ───────────────────────────── */

const ICON_BACK =
  '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FORWARD =
  '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_RELOAD =
  '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17 4v4h-4M7 20v-4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_HOME =
  '<svg viewBox="0 0 24 24"><path d="M4 11.5 12 4l8 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10v9h12v-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const ICON_STAR_OUTLINE =
  '<svg viewBox="0 0 24 24"><path d="M12 4.5l2.4 5 5.4.6-4 3.8 1 5.4L12 16.7 7.2 19.3l1-5.4-4-3.8 5.4-.6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_STAR_FILLED =
  '<svg viewBox="0 0 24 24"><path d="M12 4.5l2.4 5 5.4.6-4 3.8 1 5.4L12 16.7 7.2 19.3l1-5.4-4-3.8 5.4-.6z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_EXTERNAL =
  '<svg viewBox="0 0 24 24"><path d="M9 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 4h6v6M20 4l-9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

let tabSeq = 0;

interface Tab {
  id: string;
  /** URLs (or `null` for the home page) this tab has navigated to, oldest first. */
  history: (string | null)[];
  index: number;
  tabEl: HTMLButtonElement;
  labelEl: HTMLElement;
  bodyEl: HTMLElement;
  hintTimer: ReturnType<typeof setTimeout> | null;
}

function launch(ctx: AppContext): void {
  const { window: win } = ctx;
  win.content.textContent = '';

  const root = document.createElement('div');
  root.className = 'faisal-browser';

  // ── tab strip ──
  const tabStrip = document.createElement('div');
  tabStrip.className = 'faisal-browser-tabstrip';
  const tabList = document.createElement('div');
  tabList.className = 'faisal-browser-tablist';
  // Every window tab is a real tab; the page area below is their shared panel.
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', t('browser.title'));
  const newTabBtn = iconButton(ICON_PLUS, t('browser.newTab'));
  newTabBtn.classList.add('faisal-browser-newtab');
  tabStrip.append(tabList, newTabBtn);

  // ── toolbar ──
  const toolbar = document.createElement('div');
  toolbar.className = 'faisal-browser-toolbar';
  const backBtn = iconButton(ICON_BACK, t('browser.backHint'));
  const fwdBtn = iconButton(ICON_FORWARD, t('browser.forwardHint'));
  const reloadBtn = iconButton(ICON_RELOAD, t('browser.reload'));
  const homeBtn = iconButton(ICON_HOME, t('browser.home'));
  backBtn.classList.add('faisal-browser-navbtn');
  fwdBtn.classList.add('faisal-browser-navbtn');

  const addressForm = document.createElement('form');
  addressForm.className = 'faisal-browser-addressform';
  const addressInput = document.createElement('input');
  addressInput.type = 'text';
  addressInput.dir = 'ltr';
  addressInput.className = 'faisal-browser-address';
  addressInput.placeholder = t('browser.addressPlaceholder');
  addressInput.setAttribute('aria-label', t('browser.addressPlaceholder'));
  addressInput.autocomplete = 'off';
  addressInput.spellcheck = false;
  addressForm.append(addressInput);

  const starBtn = iconButton(ICON_STAR_OUTLINE, t('browser.star'));
  const openTabBtn = iconButton(ICON_EXTERNAL, t('browser.openInTab'));
  const engineSelect = document.createElement('select');
  engineSelect.className = 'faisal-browser-engine';
  engineSelect.title = t('browser.engineLabel');
  engineSelect.setAttribute('aria-label', t('browser.engineLabel'));
  const engineOptions: { id: SearchEngine; key: string }[] = [
    { id: 'wikipedia', key: 'browser.engineWikipedia' },
    { id: 'duckduckgo', key: 'browser.engineDuckDuckGo' },
    { id: 'google', key: 'browser.engineGoogle' },
    { id: 'bing', key: 'browser.engineBing' },
  ];
  for (const opt of engineOptions) {
    const o = document.createElement('option');
    o.value = opt.id;
    o.textContent = t(opt.key);
    engineSelect.append(o);
  }
  let engine: SearchEngine = loadEngine();
  engineSelect.value = engine;
  engineSelect.addEventListener('change', () => {
    engine = (engineSelect.value as SearchEngine) ?? 'wikipedia';
    saveEngine(engine);
  });

  toolbar.append(backBtn, fwdBtn, reloadBtn, homeBtn, addressForm, starBtn, openTabBtn, engineSelect);

  // ── page area (one body per tab, only the active one visible) ──
  const pageArea = document.createElement('div');
  pageArea.className = 'faisal-browser-pagearea';
  pageArea.id = 'faisal-browser-panel';
  pageArea.setAttribute('role', 'tabpanel');

  root.append(tabStrip, toolbar, pageArea);
  win.content.append(root);

  let bookmarks = new Set(loadBookmarks());
  const tabs: Tab[] = [];
  let activeId = '';

  function iconButtonEl(svg: string): HTMLElement {
    return renderIcon(svg) as unknown as HTMLElement;
  }

  function activeTab(): Tab | undefined {
    return tabs.find((tb) => tb.id === activeId);
  }

  function currentUrl(tab: Tab): string | null {
    return tab.history[tab.index] ?? null;
  }

  /* ───────────────────────────── home page ───────────────────────────── */

  function renderHome(tab: Tab): void {
    const home = document.createElement('div');
    home.className = 'faisal-browser-home';

    const hero = document.createElement('div');
    hero.className = 'faisal-browser-home-hero';
    const heroTitle = document.createElement('div');
    heroTitle.className = 'faisal-browser-home-title';
    heroTitle.textContent = t('browser.homeTitle');
    const heroSub = document.createElement('div');
    heroSub.className = 'faisal-browser-home-sub';
    heroSub.textContent = t('browser.homeSubtitle');

    const searchForm = document.createElement('form');
    searchForm.className = 'faisal-browser-home-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'faisal-browser-home-search-input';
    searchInput.placeholder = t('browser.homeSearchPlaceholder');
    searchInput.setAttribute('aria-label', t('browser.homeSearchPlaceholder'));
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    const searchBtn = document.createElement('button');
    searchBtn.type = 'submit';
    searchBtn.className = 'faisal-browser-home-search-btn';
    // Icon-only control: it needs a name of its own (the sibling input's label is
    // not enough for a screen reader).
    searchBtn.setAttribute('aria-label', t('browser.go'));
    searchBtn.append(iconButtonEl(ICON_SEARCH));
    searchForm.append(searchInput, searchBtn);
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (searchInput.value.trim()) navigate(tab, searchInput.value);
    });

    hero.append(heroTitle, heroSub, searchForm);

    const shortcutsTitle = document.createElement('h3');
    shortcutsTitle.className = 'faisal-browser-home-heading';
    shortcutsTitle.textContent = t('browser.shortcuts');

    const grid = document.createElement('div');
    grid.className = 'faisal-browser-home-grid';

    interface ShortcutDef { labelKey: string; url: string; descKey?: string }
    const shortcuts: ShortcutDef[] = [
      { labelKey: 'browser.tileWikipediaAr', url: 'https://ar.wikipedia.org/' },
      { labelKey: 'browser.tileWikipediaEn', url: 'https://en.wikipedia.org/' },
      { labelKey: 'browser.tileOsm', url: buildOpenStreetMapEmbedUrl() },
      { labelKey: 'browser.tileYouTube', url: 'https://www.youtube.com/', descKey: 'browser.tileYouTubeDesc' },
      { labelKey: 'browser.tileArchive', url: 'https://archive.org/' },
      { labelKey: 'browser.tileMdn', url: 'https://developer.mozilla.org/' },
      { labelKey: 'browser.tileBbc', url: 'https://www.bbc.com/arabic' },
    ];
    for (const sc of shortcuts) {
      const blocked = isBlockedDomain(sc.url);
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'faisal-browser-tile';
      const label = document.createElement('div');
      label.className = 'faisal-browser-tile-label';
      label.textContent = t(sc.labelKey);
      tile.append(label);
      if (sc.descKey) {
        const desc = document.createElement('div');
        desc.className = 'faisal-browser-tile-desc';
        desc.textContent = t(sc.descKey);
        tile.append(desc);
      }
      if (blocked) {
        const badge = document.createElement('div');
        badge.className = 'faisal-browser-tile-badge';
        badge.textContent = t('browser.opensInTab');
        tile.append(badge);
        tile.addEventListener('click', () => window.open(sc.url, '_blank', 'noopener,noreferrer'));
      } else {
        tile.addEventListener('click', () => navigate(tab, sc.url));
      }
      grid.append(tile);
    }

    home.append(hero, shortcutsTitle, grid);

    const bmTitle = document.createElement('h3');
    bmTitle.className = 'faisal-browser-home-heading';
    bmTitle.textContent = t('browser.bookmarks');
    home.append(bmTitle);

    if (bookmarks.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'faisal-browser-home-empty';
      empty.textContent = t('browser.noBookmarks');
      home.append(empty);
    } else {
      const bmGrid = document.createElement('div');
      bmGrid.className = 'faisal-browser-home-grid';
      for (const url of bookmarks) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'faisal-browser-tile';
        const label = document.createElement('div');
        label.className = 'faisal-browser-tile-label';
        label.textContent = url;
        label.dir = 'ltr';
        tile.append(label);
        tile.addEventListener('click', () => navigate(tab, url));
        bmGrid.append(tile);
      }
      home.append(bmGrid);
    }

    tab.bodyEl.append(home);
    searchInput.focus();
  }

  /* ───────────────────────────── page (iframe) ───────────────────────────── */

  function renderBlockedCard(tab: Tab, url: string): void {
    const card = document.createElement('div');
    card.className = 'faisal-browser-blocked';
    const title = document.createElement('div');
    title.className = 'faisal-browser-blocked-title';
    title.textContent = t('browser.blockedTitle');
    const body = document.createElement('div');
    body.className = 'faisal-browser-blocked-body';
    body.textContent = t('browser.blockedBody');
    const urlLine = document.createElement('div');
    urlLine.className = 'faisal-browser-blocked-url';
    urlLine.textContent = url;
    urlLine.dir = 'ltr';
    const link = document.createElement('a');
    link.className = 'faisal-browser-blocked-open';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('browser.openReal');
    card.append(title, body, urlLine, link);
    tab.bodyEl.append(card);
  }

  /**
   * Honest fallback for hosts measured to refuse framing: shown *instead of*
   * an empty frame. The explanation matches the wording the Web app uses for
   * the same situation, and the two actions are the only ones available — we
   * cannot display the page, so we either hand it to the real browser or let
   * the user spend one attempt.
   */
  function renderRefusalCard(tab: Tab, url: string, srcUrl: string): void {
    const card = document.createElement('div');
    card.className = 'faisal-browser-blocked faisal-browser-refusal';
    const title = document.createElement('div');
    title.className = 'faisal-browser-blocked-title';
    title.textContent = t('browser.refusesTitle');
    const body = document.createElement('div');
    body.className = 'faisal-browser-blocked-body';
    body.textContent = t('browser.refusesBody');
    const urlLine = document.createElement('div');
    urlLine.className = 'faisal-browser-blocked-url';
    urlLine.textContent = url;
    urlLine.dir = 'ltr';

    const actions = document.createElement('div');
    actions.className = 'faisal-browser-blocked-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'faisal-browser-blocked-btn is-primary';
    openBtn.textContent = t('browser.refusesOpen');
    openBtn.addEventListener('click', () => window.open(url, '_blank', 'noopener,noreferrer'));

    const tryBtn = document.createElement('button');
    tryBtn.type = 'button';
    tryBtn.className = 'faisal-browser-blocked-btn is-plain';
    tryBtn.textContent = t('browser.refusesTry');
    // No bypass: this builds the very same sandboxed frame every other site
    // gets, then hands control back to the normal loading path (including the
    // delayed silence hint). If the site refuses, the frame stays blank and
    // the hint still offers the real browser.
    tryBtn.addEventListener('click', () => {
      tab.bodyEl.textContent = '';
      renderFrame(tab, url, srcUrl);
    });

    actions.append(openBtn, tryBtn);
    card.append(title, body, urlLine, actions);
    tab.bodyEl.append(card);
  }

  function renderPage(tab: Tab, url: string): void {
    const srcUrl = rewriteYouTubeEmbed(url) ?? url;
    if (isBlockedDomain(srcUrl) || !isAllowedFrameUrl(srcUrl)) {
      renderBlockedCard(tab, url);
      return;
    }
    // Measured refusers (X-Frame-Options: SAMEORIGIN) would only ever paint a
    // blank grey area, so we explain that up front instead of wasting the
    // attempt. Nothing is bypassed here — no proxy, no header tricks — and
    // "Try embedding anyway" below creates exactly the same frame as always.
    if (refusesFraming(srcUrl)) {
      renderRefusalCard(tab, url, srcUrl);
      return;
    }
    renderFrame(tab, url, srcUrl);
  }

  /** The one and only place an <iframe> is created for a navigation. */
  function renderFrame(tab: Tab, url: string, srcUrl: string): void {
    const frameWrap = document.createElement('div');
    frameWrap.className = 'faisal-browser-framewrap';

    const iframe = document.createElement('iframe');
    iframe.className = 'faisal-browser-iframe';
    // `allow-same-origin` is safe to combine with `allow-scripts` here ONLY
    // because `isAllowedFrameUrl()` guarantees `srcUrl` is never same-origin
    // with this OS page — the frame is always a different origin, so
    // same-origin sandbox escape back into the OS document is impossible.
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation',
    );
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('allow', 'fullscreen; picture-in-picture; encrypted-media');
    iframe.loading = 'eager';
    iframe.src = srcUrl;
    frameWrap.append(iframe);

    const hint = document.createElement('div');
    hint.className = 'faisal-browser-hint';
    const hintText = document.createElement('span');
    hintText.textContent = t('browser.blankHint');
    const hintOpen = document.createElement('a');
    hintOpen.href = url;
    hintOpen.target = '_blank';
    hintOpen.rel = 'noopener noreferrer';
    hintOpen.textContent = t('browser.openReal');
    const hintClose = document.createElement('button');
    hintClose.type = 'button';
    hintClose.className = 'faisal-browser-hint-close';
    hintClose.setAttribute('aria-label', t('browser.dismiss'));
    hintClose.textContent = '×';
    hintClose.addEventListener('click', () => hint.remove());
    hint.append(hintText, hintOpen, hintClose);
    frameWrap.append(hint);

    if (tab.hintTimer) clearTimeout(tab.hintTimer);
    tab.hintTimer = setTimeout(() => hint.classList.add('is-visible'), 1400);

    tab.bodyEl.append(frameWrap);
  }

  function renderTabBody(tab: Tab): void {
    tab.bodyEl.textContent = '';
    if (tab.hintTimer) { clearTimeout(tab.hintTimer); tab.hintTimer = null; }
    const url = currentUrl(tab);
    if (url === null) renderHome(tab);
    else renderPage(tab, url);
    if (tab.id === activeId) updateChrome(tab);
  }

  /* ───────────────────────────── navigation ───────────────────────────── */

  function pushHistory(tab: Tab, urlOrNull: string | null): void {
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(urlOrNull);
    tab.index = tab.history.length - 1;
  }

  function navigate(tab: Tab, rawInput: string): void {
    const resolved = resolveAddressInput(rawInput);
    if (resolved.kind === 'search') {
      if (!resolved.query) return;
      if (engine === 'wikipedia') {
        pushHistory(tab, buildSearchUrl(resolved.query, 'wikipedia', getLocale()));
      } else {
        window.open(buildSearchUrl(resolved.query, engine, getLocale()), '_blank', 'noopener,noreferrer');
        return; // active tab's own history is untouched
      }
    } else {
      if (!isAllowedFrameUrl(resolved.url)) return; // same-origin / non-https — refuse silently, address bar keeps its value
      pushHistory(tab, resolved.url);
    }
    renderTabBody(tab);
  }

  function goBack(tab: Tab): void {
    if (tab.index <= 0) return;
    tab.index -= 1;
    renderTabBody(tab);
  }

  function goForward(tab: Tab): void {
    if (tab.index >= tab.history.length - 1) return;
    tab.index += 1;
    renderTabBody(tab);
  }

  function goHome(tab: Tab): void {
    pushHistory(tab, null);
    renderTabBody(tab);
  }

  /* ───────────────────────────── chrome (toolbar/tab strip) sync ───────────────────────────── */

  function updateChrome(tab: Tab): void {
    if (tab.id !== activeId) return;
    const url = currentUrl(tab);
    addressInput.value = url ?? '';
    backBtn.disabled = tab.index <= 0;
    fwdBtn.disabled = tab.index >= tab.history.length - 1;
    starBtn.disabled = url === null;
    openTabBtn.disabled = url === null;
    const isStarred = url !== null && bookmarks.has(url);
    starBtn.textContent = '';
    starBtn.append(iconButtonEl(isStarred ? ICON_STAR_FILLED : ICON_STAR_OUTLINE));
    starBtn.classList.toggle('is-active', isStarred);
    starBtn.title = isStarred ? t('browser.unstar') : t('browser.star');

    const label = url ? hostnameOf(url) : t('browser.home');
    tab.labelEl.textContent = label;
    tab.labelEl.title = url ?? t('browser.home');
    win.setTitle(`${t('browser.title')} — ${label}`);
  }

  function hostnameOf(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  /* ───────────────────────────── tabs ───────────────────────────── */

  function makeTab(): Tab {
    const id = `t${++tabSeq}`;
    const tabEl = document.createElement('button');
    tabEl.type = 'button';
    tabEl.className = 'faisal-browser-tab';
    tabEl.id = `faisal-browser-tab-${id}`;
    tabEl.setAttribute('role', 'tab');
    tabEl.setAttribute('aria-controls', 'faisal-browser-panel');
    tabEl.setAttribute('aria-selected', 'false');
    const labelEl = document.createElement('span');
    labelEl.className = 'faisal-browser-tab-label';
    labelEl.textContent = t('browser.home');
    const closeBtn = document.createElement('span');
    closeBtn.className = 'faisal-browser-tab-close';
    closeBtn.setAttribute('role', 'button');
    closeBtn.setAttribute('aria-label', t('browser.closeTab'));
    closeBtn.append(iconButtonEl(ICON_CLOSE));
    tabEl.append(labelEl, closeBtn);
    tabEl.addEventListener('click', (e) => {
      if (e.target === closeBtn || closeBtn.contains(e.target as Node)) return;
      activateTab(id);
    });
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });

    const bodyEl = document.createElement('div');
    bodyEl.className = 'faisal-browser-body';

    const tab: Tab = { id, history: [null], index: 0, tabEl, labelEl, bodyEl, hintTimer: null };
    tabList.append(tabEl);
    pageArea.append(bodyEl);
    tabs.push(tab);
    return tab;
  }

  function activateTab(id: string): void {
    activeId = id;
    for (const tb of tabs) {
      const active = tb.id === id;
      tb.tabEl.classList.toggle('is-active', active);
      tb.bodyEl.classList.toggle('is-active', active);
      // The `is-active` class is invisible to assistive tech: mirror it into
      // aria-selected / the roving tabindex, and keep the hidden bodies out of the
      // accessibility tree alongside their `display: none`.
      tb.tabEl.setAttribute('aria-selected', String(active));
      tb.tabEl.tabIndex = active ? 0 : -1;
      tb.bodyEl.setAttribute('aria-hidden', String(!active));
    }
    const tab = activeTab();
    if (tab) {
      pageArea.setAttribute('aria-labelledby', tab.tabEl.id);
      updateChrome(tab);
    }
  }

  function closeTab(id: string): void {
    const idx = tabs.findIndex((tb) => tb.id === id);
    if (idx === -1) return;
    const [removed] = tabs.splice(idx, 1);
    if (removed.hintTimer) clearTimeout(removed.hintTimer);
    removed.tabEl.remove();
    removed.bodyEl.remove();
    if (tabs.length === 0) {
      win.close();
      return;
    }
    if (activeId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      activateTab(next.id);
    }
  }

  function openNewTab(): void {
    const tab = makeTab();
    activateTab(tab.id);
  }

  newTabBtn.addEventListener('click', () => openNewTab());
  backBtn.addEventListener('click', () => { const tab = activeTab(); if (tab) goBack(tab); });
  fwdBtn.addEventListener('click', () => { const tab = activeTab(); if (tab) goForward(tab); });
  reloadBtn.addEventListener('click', () => { const tab = activeTab(); if (tab) renderTabBody(tab); });
  homeBtn.addEventListener('click', () => { const tab = activeTab(); if (tab) goHome(tab); });
  starBtn.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab) return;
    const url = currentUrl(tab);
    if (!url) return;
    if (bookmarks.has(url)) bookmarks.delete(url);
    else bookmarks.add(url);
    saveBookmarks([...bookmarks]);
    updateChrome(tab);
  });
  openTabBtn.addEventListener('click', () => {
    const tab = activeTab();
    const url = tab ? currentUrl(tab) : null;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  });
  addressForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const tab = activeTab();
    if (tab) navigate(tab, addressInput.value);
  });

  root.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 't') { e.preventDefault(); openNewTab(); }
    else if (key === 'w') { e.preventDefault(); if (activeId) closeTab(activeId); }
    else if (key === 'l') { e.preventDefault(); addressInput.focus(); addressInput.select(); }
  });

  win.onClose(() => {
    for (const tb of tabs) if (tb.hintTimer) clearTimeout(tb.hintTimer);
  });

  function iconButton(svg: string, title: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'faisal-browser-iconbtn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.append(renderIcon(svg));
    return btn;
  }

  const first = makeTab();
  activateTab(first.id);
  renderTabBody(first);
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
