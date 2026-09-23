import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import { ACCENTS, BRAND_ACCENT_ID, applyTheme, applyAccent, type ThemeMode } from '../../shell/appearance';
import { BRAND, MARK_GLYPH_SVG } from '../../brand/logo';
import { brandLockup } from '../../shell/splash';
import { shellConfirm } from '../../shell/dialog';
import { RESTORE_KEY } from '../../shell/session';
import { OS_VERSION } from '../../kernel/version';
import {
  AI_PROVIDERS, clearedKeys, clearPrivacyItem, readPrivacyInventory,
  type ClearTarget, type PrivacyInventory,
} from './privacy';
import './strings';

const OS_NAME = BRAND.product;

const ICON_APPEARANCE =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3a9 9 0 000 18z" fill="currentColor"/></svg>';
const ICON_LANGUAGE =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 12h18M12 3c2.4 2.6 3.6 5.7 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.7-3.6-9S9.6 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

const ICON_SYSTEM =
  '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

const ICON_KEYBOARD =
  '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

const ICON_PRIVACY =
  '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5.5c0 4.3-2.8 7.4-7 8.5-4.2-1.1-7-4.2-7-8.5V6l7-3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9.2 12l2 2 3.6-3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

type SectionId = 'appearance' | 'language' | 'keyboard' | 'privacy' | 'system' | 'about';

/** Keyboard shortcuts handled by the shell and window manager. */
const SHORTCUTS: [keys: string, labelKey: string][] = [
  ['Super', 'settings.sc.overview'],
  ['Alt+F1', 'settings.sc.overview'],
  ['Ctrl+Alt+T', 'settings.sc.terminal'],
  ['Ctrl+Alt+W', 'settings.sc.close'],
  ['Ctrl+Alt+Tab', 'settings.sc.switchWindow'],
  ['Super+↑', 'settings.sc.maximize'],
  ['Super+↓', 'settings.sc.restore'],
  ['Super+← / →', 'settings.sc.snap'],
  ['Super+D', 'settings.sc.desktop'],
  ['Super+Shift+S', 'settings.sc.screenshot'],
];

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  // LRI…PDI keeps "18 KB" in order inside Arabic text.
  return `\u2066${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}\u2069`;
}

/**
 * Best-effort cleanup of the browser-managed storage Fai$al OS uses on top of
 * localStorage and IndexedDB: its offline cache and its service worker.
 * Every step is optional (older browsers and jsdom lack these APIs) and no
 * step may throw — a failure here must never abort the reset.
 */
async function clearServiceWorkerAndCaches(): Promise<void> {
  try {
    const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    const registrations = await container?.getRegistrations?.();
    if (registrations) {
      await Promise.all(registrations.map((reg) => reg.unregister().catch(() => false)));
    }
  } catch { /* service workers unavailable — nothing to unregister */ }

  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name).catch(() => false)));
    }
  } catch { /* cache storage unavailable or blocked — nothing to delete */ }
}

function row(labelKey: string, descKey?: string): { row: HTMLElement; control: HTMLElement } {
  const r = document.createElement('div');
  r.className = 'faisal-settings-row';
  const text = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'faisal-settings-row-label';
  label.textContent = t(labelKey);
  text.append(label);
  if (descKey) {
    const desc = document.createElement('div');
    desc.className = 'faisal-settings-row-desc';
    desc.textContent = t(descKey);
    text.append(desc);
  }
  const control = document.createElement('div');
  r.append(text, control);
  return { row: r, control };
}

function group(...rows: HTMLElement[]): HTMLElement {
  const g = document.createElement('div');
  g.className = 'faisal-settings-group';
  g.append(...rows);
  return g;
}

/** A muted read-only value inside a row's control slot. */
function valueNode(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'faisal-settings-value';
  span.textContent = text;
  return span;
}

function subhead(textKey: string): HTMLElement {
  const h3 = document.createElement('h3');
  h3.className = 'faisal-settings-subhead';
  h3.textContent = t(textKey);
  return h3;
}

function note(textKey: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'faisal-settings-note';
  p.textContent = t(textKey);
  return p;
}

function dangerButton(labelKey: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'faisal-settings-danger-btn';
  b.textContent = t(labelKey);
  return b;
}

/** "3" or "Nothing saved yet" — a count is never shown as an invented value. */
function countText(countKey: string, zeroKey: string, n: number): string {
  return n > 0 ? t(countKey, { n }) : t(zeroKey);
}

/** Local `Storage`, or null when the browser blocks it (private mode). */
function storage(): Storage | null {
  try { return localStorage; } catch { return null; }
}

/** The launch section may be given as an argument; fall back to Appearance. */
function launch(ctx: AppContext) {
  const { sys, window: win, args } = ctx;
  win.content.textContent = '';

  const wrap = document.createElement('div');
  wrap.className = 'faisal-settings';

  const nav = document.createElement('nav');
  nav.className = 'faisal-settings-nav';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', t('settings.title'));

  const panel = document.createElement('div');
  panel.className = 'faisal-settings-panel';
  panel.id = 'faisal-settings-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.tabIndex = 0;

  const sections: { id: SectionId; labelKey: string; icon: string; render: () => void }[] = [
    { id: 'appearance', labelKey: 'settings.nav.appearance', icon: ICON_APPEARANCE, render: renderAppearance },
    { id: 'language', labelKey: 'settings.nav.language', icon: ICON_LANGUAGE, render: renderLanguage },
    { id: 'keyboard', labelKey: 'settings.nav.keyboard', icon: ICON_KEYBOARD, render: renderKeyboard },
    { id: 'privacy', labelKey: 'settings.nav.privacy', icon: ICON_PRIVACY, render: renderPrivacy },
    { id: 'system', labelKey: 'settings.nav.system', icon: ICON_SYSTEM, render: renderSystem },
    { id: 'about', labelKey: 'settings.nav.about', icon: MARK_GLYPH_SVG, render: renderAbout },
  ];

  const navButtons = new Map<SectionId, HTMLButtonElement>();
  let activeId: SectionId = (args[0] as SectionId) && sections.some((s) => s.id === args[0]) ? (args[0] as SectionId) : 'appearance';

  function selectSection(id: SectionId) {
    activeId = id;
    navButtons.forEach((btn, bid) => {
      const active = bid === id;
      btn.classList.toggle('is-active', active);
      // The `is-active` class is invisible to a screen reader: mirror the active
      // section into aria-selected (the standard state for the tab pattern) plus the
      // roving tabindex, and point the panel at the tab that owns it.
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    });
    const activeBtn = navButtons.get(id);
    if (activeBtn) panel.setAttribute('aria-labelledby', activeBtn.id);
    sections.find((s) => s.id === id)?.render();
  }

  for (const section of sections) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'faisal-settings-nav-btn';
    btn.id = `faisal-settings-tab-${section.id}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', 'faisal-settings-panel');
    btn.setAttribute('aria-selected', 'false');
    btn.append(renderIcon(section.icon), document.createTextNode(t(section.labelKey)));
    btn.addEventListener('click', () => selectSection(section.id));
    navButtons.set(section.id, btn);
    nav.append(btn);
  }

  function renderAppearance() {
    panel.textContent = '';
    const h2 = document.createElement('h2');
    h2.textContent = t('settings.nav.appearance');
    panel.append(h2);

    const themeRow = row('settings.appearance.theme', 'settings.appearance.themeDesc');
    const themeToggle = document.createElement('div');
    themeToggle.className = 'faisal-toggle-row';
    themeToggle.style.width = '220px';
    const currentTheme = sys.settings.get<ThemeMode>('theme', 'system');
    (['light', 'dark', 'system'] as ThemeMode[]).forEach((mode) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'faisal-toggle-btn' + (mode === currentTheme ? ' is-active' : '');
      b.setAttribute('aria-pressed', String(mode === currentTheme));
      b.textContent = t(`settings.theme.${mode}`);
      b.addEventListener('click', () => {
        sys.settings.set('theme', mode);
        applyTheme(mode);
        [...themeToggle.children].forEach((c) => {
          c.classList.remove('is-active');
          c.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('is-active');
        b.setAttribute('aria-pressed', 'true');
      });
      themeToggle.append(b);
    });
    themeRow.control.append(themeToggle);

    const accentRow = row('settings.appearance.accent', 'settings.appearance.accentDesc');
    const accentPicker = document.createElement('div');
    accentPicker.className = 'faisal-accent-row';
    const currentAccent = sys.settings.get<string>('accent', BRAND_ACCENT_ID);
    ACCENTS.forEach((preset) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'faisal-accent-dot' + (preset.id === currentAccent ? ' is-active' : '');
      dot.style.background = preset.swatch ?? preset.hex;
      dot.title = preset.id === BRAND_ACCENT_ID ? 'Fai$al' : preset.id;
      dot.setAttribute('aria-label', dot.title);
      dot.addEventListener('click', () => {
        sys.settings.set('accent', preset.id);
        applyAccent(preset.id);
        [...accentPicker.children].forEach((c) => c.classList.remove('is-active'));
        dot.classList.add('is-active');
      });
      accentPicker.append(dot);
    });
    accentRow.control.append(accentPicker);

    panel.append(group(themeRow.row, accentRow.row));
  }

  function renderLanguage() {
    panel.textContent = '';
    const h2 = document.createElement('h2');
    h2.textContent = t('settings.nav.language');
    panel.append(h2);

    const langRow = row('settings.language.label', 'settings.language.desc');
    const langToggle = document.createElement('div');
    langToggle.className = 'faisal-toggle-row';
    langToggle.style.width = '200px';
    (['ar', 'en'] as const).forEach((loc) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'faisal-toggle-btn' + (loc === sys.locale() ? ' is-active' : '');
      b.setAttribute('aria-pressed', String(loc === sys.locale()));
      b.textContent = loc === 'ar' ? 'العربية' : 'English';
      b.addEventListener('click', () => {
        sys.settings.set('locale', loc);
        location.reload();
      });
      langToggle.append(b);
    });
    langRow.control.append(langToggle);

    panel.append(group(langRow.row));
  }

  /** Read-only reference: every entry here is handled by src/shell/index.ts or src/shell/wm.ts. */
  function renderKeyboard() {
    panel.textContent = '';
    const h2 = document.createElement('h2');
    h2.textContent = t('settings.nav.keyboard');
    panel.append(h2);

    const shortcuts = group(...SHORTCUTS.map(([keys, labelKey]) => {
      const r = row(labelKey);
      const kbd = document.createElement('kbd');
      kbd.className = 'faisal-kbd';
      kbd.textContent = keys;
      // Key names are Latin: keep them LTR even when the interface is Arabic.
      r.control.dir = 'ltr';
      r.control.append(kbd);
      return r.row;
    }));

    panel.append(subhead('settings.system.shortcuts'), shortcuts, note('settings.system.shortcutsNote'));
  }

  function renderPrivacy() {
    panel.textContent = '';
    const h2 = document.createElement('h2');
    h2.textContent = t('settings.nav.privacy');
    panel.append(h2);

    const inv: PrivacyInventory = readPrivacyInventory(storage());

    // ── What is stored, counted from the real keys ──
    const stored: HTMLElement[] = [];

    const settingsRow = row('settings.privacy.settings', 'settings.privacy.settingsDesc');
    settingsRow.control.append(valueNode(countText('settings.privacy.count', 'settings.privacy.none', inv.settingsCount)));
    stored.push(settingsRow.row);

    const notifRow = row('settings.privacy.notifications', 'settings.privacy.notificationsDesc');
    notifRow.control.append(valueNode(countText('settings.privacy.count', 'settings.privacy.none', inv.notificationCount)));
    stored.push(notifRow.row);

    const windowsRow = row('settings.privacy.windows', 'settings.privacy.windowsDesc');
    windowsRow.control.append(valueNode(countText('settings.privacy.count', 'settings.privacy.none', inv.geometryCount + inv.sessionCount)));
    stored.push(windowsRow.row);

    const bookmarksRow = row('settings.privacy.bookmarks', 'settings.privacy.bookmarksDesc');
    bookmarksRow.control.append(valueNode(countText('settings.privacy.count', 'settings.privacy.none', inv.bookmarkCount)));
    stored.push(bookmarksRow.row);

    for (const provider of AI_PROVIDERS) {
      const providerRow = row(provider.labelKey, 'settings.privacy.aiKeyDesc');
      providerRow.control.append(valueNode(t(inv.aiKeysSaved[provider.id]
        ? 'settings.privacy.aiSaved'
        : 'settings.privacy.aiNotSaved')));
      stored.push(providerRow.row);
    }

    // Files live in IndexedDB, not localStorage: a count would mean opening the
    // database, so this row reuses the browser's own estimate — the same estimate
    // the System section shows, rather than a second guess at the size.
    const filesRow = row('settings.privacy.files', 'settings.privacy.filesDesc');
    const filesValue = valueNode(t('settings.system.storageUnknown'));
    // Resolved asynchronously from navigator.storage.estimate(): role=status announces it.
    filesValue.setAttribute('role', 'status');
    filesRow.control.append(filesValue);
    void (navigator.storage?.estimate?.() ?? Promise.reject(new Error('unsupported')))
      .then((est) => {
        filesValue.textContent = typeof est.usage === 'number' && typeof est.quota === 'number'
          ? t('settings.system.storageUsed', { used: formatBytes(est.usage), quota: formatBytes(est.quota) })
          : t('settings.system.storageUnknown');
      })
      .catch(() => { filesValue.textContent = t('settings.system.storageUnknown'); });
    stored.push(filesRow.row);

    // ── Actions: each one deletes exactly the keys named in clearedKeys() ──
    const keyList = (keys: string[]) => keys.join(', ');

    async function confirmClear(target: ClearTarget, titleKey: string, body: string, okKey: string): Promise<boolean> {
      const ok = await shellConfirm({
        title: t(titleKey),
        message: body,
        okLabel: t(okKey),
        cancelLabel: t('settings.system.cancel'),
        danger: true,
      });
      if (!ok) return false;
      clearPrivacyItem(storage(), target);
      renderPrivacy();
      return true;
    }

    const notificationsRow = row('settings.privacy.clearNotifications', 'settings.privacy.clearNotificationsDesc');
    const notificationsBtn = dangerButton('settings.privacy.clearNotificationsBtn');
    notificationsBtn.addEventListener('click', () => {
      void confirmClear(
        'notifications',
        'settings.privacy.clearNotificationsTitle',
        t('settings.privacy.clearNotificationsBody', { keys: keyList(clearedKeys('notifications')) }),
        'settings.privacy.clearNotificationsConfirm',
      );
    });
    notificationsRow.control.append(notificationsBtn);

    const actions: HTMLElement[] = [notificationsRow.row];

    for (const provider of AI_PROVIDERS) {
      if (!inv.aiKeysSaved[provider.id]) continue; // nothing saved — no button to offer
      const forgetRow = row('settings.privacy.forgetKey', 'settings.privacy.forgetKeyDesc');
      const forgetBtn = dangerButton('settings.privacy.forgetKeyBtn');
      forgetBtn.setAttribute('aria-label', t('settings.privacy.forgetKeyAria', { provider: t(provider.labelKey) }));
      forgetBtn.addEventListener('click', () => {
        void confirmClear(
          provider.id,
          'settings.privacy.forgetKeyTitle',
          t('settings.privacy.forgetKeyBody', { provider: t(provider.labelKey), keys: keyList(clearedKeys(provider.id)) }),
          'settings.privacy.forgetKeyConfirm',
        );
      });
      forgetRow.control.append(forgetBtn);
      actions.push(forgetRow.row);
    }

    const browsingRow = row('settings.privacy.clearBrowser', 'settings.privacy.clearBrowserDesc');
    const browsingBtn = dangerButton('settings.privacy.clearBrowserBtn');
    browsingBtn.addEventListener('click', () => {
      void confirmClear(
        'browsing',
        'settings.privacy.clearBrowserTitle',
        t('settings.privacy.clearBrowserBody', { keys: keyList(clearedKeys('browsing')) }),
        'settings.privacy.clearBrowserConfirm',
      );
    });
    browsingRow.control.append(browsingBtn);
    actions.push(browsingRow.row);

    const resetLink = row('settings.privacy.fullReset', 'settings.privacy.fullResetDesc');
    const resetLinkBtn = document.createElement('button');
    resetLinkBtn.type = 'button';
    resetLinkBtn.className = 'faisal-settings-danger-btn';
    resetLinkBtn.textContent = t('settings.system.resetBtn');
    resetLinkBtn.addEventListener('click', () => runFullReset());
    resetLink.control.append(resetLinkBtn);
    actions.push(resetLink.row);

    panel.append(
      subhead('settings.privacy.storedHeading'),
      group(...stored),
      note('settings.privacy.filesNote'),
      subhead('settings.privacy.actionsHeading'),
      group(...actions),
      note('settings.privacy.vsResetNote'),
    );
  }

  function renderSystem() {
    panel.textContent = '';
    const h2 = document.createElement('h2');
    h2.textContent = t('settings.nav.system');
    panel.append(h2);

    const restoreRow = row('settings.system.restore', 'settings.system.restoreDesc');
    const toggle = document.createElement('div');
    toggle.className = 'faisal-toggle-row';
    toggle.style.width = '160px';
    const on = sys.settings.get<boolean>(RESTORE_KEY, true);
    for (const value of [true, false]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'faisal-toggle-btn' + (value === on ? ' is-active' : '');
      b.textContent = t(value ? 'settings.system.on' : 'settings.system.off');
      b.setAttribute('aria-pressed', String(value === on));
      b.addEventListener('click', () => {
        sys.settings.set(RESTORE_KEY, value);
        for (const c of toggle.children) { c.classList.toggle('is-active', c === b); c.setAttribute('aria-pressed', String(c === b)); }
      });
      toggle.append(b);
    }
    restoreRow.control.append(toggle);

    const storageRow = row('settings.system.storage', 'settings.system.storageDesc');
    const usage = document.createElement('span');
    usage.className = 'faisal-settings-value';
    // The browser reports the estimate asynchronously; announce the answer when it lands.
    usage.setAttribute('role', 'status');
    usage.textContent = '…';
    storageRow.control.append(usage);
    void (navigator.storage?.estimate?.() ?? Promise.reject(new Error('unsupported')))
      .then((est) => {
        // Never invent a number: some browsers resolve the estimate with no usage/quota.
        usage.textContent = typeof est.usage === 'number' && typeof est.quota === 'number'
          ? t('settings.system.storageUsed', { used: formatBytes(est.usage), quota: formatBytes(est.quota) })
          : t('settings.system.storageUnknown');
      })
      .catch(() => { usage.textContent = t('settings.system.storageUnknown'); });

    const resetRow = row('settings.system.reset', 'settings.system.resetDesc');
    const resetBtn = dangerButton('settings.system.resetBtn');
    resetBtn.addEventListener('click', () => { void runFullReset(); });
    resetRow.control.append(resetBtn);

    panel.append(
      group(restoreRow.row, storageRow.row),
      group(resetRow.row),
      note('settings.system.shortcutsMoved'),
    );
  }

  /**
   * The full reset, shared by System and by the Privacy link: every `faisal.*`
   * localStorage key (settings, notification history, bookmarks, AI keys), the
   * VFS IndexedDB database, service workers and caches — then a reload.
   */
  async function runFullReset(): Promise<void> {
    const ok = await shellConfirm({
      title: t('settings.system.resetTitle'),
      message: t('settings.system.resetBody'),
      okLabel: t('settings.system.resetConfirm'),
      cancelLabel: t('settings.system.cancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      // Enumerated live rather than from a fixed list, so a key added later is covered.
      for (const k of Object.keys(localStorage)) if (k.startsWith('faisal.')) localStorage.removeItem(k);
    } catch { /* storage unavailable: nothing to clear */ }
    // Best-effort and time-boxed: a stalled unregister/delete must never
    // stop the reload below.
    await Promise.race([
      clearServiceWorkerAndCaches(),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
    const done = () => location.reload();
    try {
      const req = indexedDB.deleteDatabase('faisal-vfs');
      req.onsuccess = req.onerror = req.onblocked = done;
    } catch { done(); }
  }

  function renderAbout() {
    panel.textContent = '';
    const h2 = document.createElement('h2');
    h2.textContent = t('settings.nav.about');
    panel.append(h2);

    const block = document.createElement('div');
    block.className = 'faisal-about-block';
    const { mark, wordmarks } = brandLockup();
    mark.className = 'faisal-about-logo';
    const name = document.createElement('div');
    name.className = 'faisal-about-name';
    name.dir = 'ltr';
    name.textContent = `${OS_NAME} ${BRAND.version}`;
    const arName = document.createElement('div');
    arName.className = 'faisal-about-sub';
    arName.textContent = t('settings.about.arabicName', { name: BRAND.nameAr });
    const tagline = document.createElement('div');
    tagline.className = 'faisal-about-sub';
    tagline.textContent = t('settings.about.tagline');
    block.append(mark, wordmarks, name, arName, tagline);

    const versionRow = row('settings.about.versionLabel');
    const versionValue = document.createElement('span');
    versionValue.className = 'faisal-about-version';
    versionValue.dir = 'ltr';
    versionValue.textContent = OS_VERSION;
    versionRow.control.append(versionValue);

    const uaRow = row('settings.about.browser');
    const ua = document.createElement('div');
    ua.className = 'faisal-about-ua';
    ua.textContent = navigator.userAgent;

    panel.append(block, group(versionRow.row, uaRow.row), ua);
  }

  wrap.append(nav, panel);
  win.content.append(wrap);
  selectSection(activeId);
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
