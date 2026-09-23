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
import './strings';

const OS_NAME = BRAND.product;

const ICON_APPEARANCE =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3a9 9 0 000 18z" fill="currentColor"/></svg>';
const ICON_LANGUAGE =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 12h18M12 3c2.4 2.6 3.6 5.7 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.7-3.6-9S9.6 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

const ICON_SYSTEM =
  '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

type SectionId = 'appearance' | 'language' | 'system' | 'about';

/** Keyboard shortcuts handled by the shell and window manager. */
const SHORTCUTS: [keys: string, labelKey: string][] = [
  ['Super', 'settings.sc.overview'],
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

function launch(ctx: AppContext) {
  const { sys, window: win, args } = ctx;
  win.content.textContent = '';

  const wrap = document.createElement('div');
  wrap.className = 'faisal-settings';

  const nav = document.createElement('nav');
  nav.className = 'faisal-settings-nav';

  const panel = document.createElement('div');
  panel.className = 'faisal-settings-panel';

  const sections: { id: SectionId; labelKey: string; icon: string; render: () => void }[] = [
    { id: 'appearance', labelKey: 'settings.nav.appearance', icon: ICON_APPEARANCE, render: renderAppearance },
    { id: 'language', labelKey: 'settings.nav.language', icon: ICON_LANGUAGE, render: renderLanguage },
    { id: 'system', labelKey: 'settings.nav.system', icon: ICON_SYSTEM, render: renderSystem },
    { id: 'about', labelKey: 'settings.nav.about', icon: MARK_GLYPH_SVG, render: renderAbout },
  ];

  const navButtons = new Map<SectionId, HTMLButtonElement>();
  let activeId: SectionId = (args[0] as SectionId) && sections.some((s) => s.id === args[0]) ? (args[0] as SectionId) : 'appearance';

  function selectSection(id: SectionId) {
    activeId = id;
    navButtons.forEach((btn, bid) => btn.classList.toggle('is-active', bid === id));
    sections.find((s) => s.id === id)?.render();
  }

  for (const section of sections) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'faisal-settings-nav-btn';
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
      b.textContent = t(`settings.theme.${mode}`);
      b.addEventListener('click', () => {
        sys.settings.set('theme', mode);
        applyTheme(mode);
        [...themeToggle.children].forEach((c) => c.classList.remove('is-active'));
        b.classList.add('is-active');
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
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'faisal-settings-danger-btn';
    resetBtn.textContent = t('settings.system.resetBtn');
    resetBtn.addEventListener('click', async () => {
      const ok = await shellConfirm({
        title: t('settings.system.resetTitle'),
        message: t('settings.system.resetBody'),
        okLabel: t('settings.system.resetConfirm'),
        cancelLabel: t('settings.system.cancel'),
        danger: true,
      });
      if (!ok) return;
      try {
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
    });
    resetRow.control.append(resetBtn);

    const shortcuts = group(...SHORTCUTS.map(([keys, labelKey]) => {
      const r = row(labelKey);
      const kbd = document.createElement('kbd');
      kbd.className = 'faisal-kbd';
      kbd.dir = 'ltr';
      kbd.textContent = keys;
      r.control.append(kbd);
      return r.row;
    }));
    const h3 = document.createElement('h3');
    h3.className = 'faisal-settings-subhead';
    h3.textContent = t('settings.system.shortcuts');
    const note = document.createElement('p');
    note.className = 'faisal-settings-note';
    note.textContent = t('settings.system.shortcutsNote');

    panel.append(group(restoreRow.row, storageRow.row), h3, shortcuts, note, group(resetRow.row));
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
