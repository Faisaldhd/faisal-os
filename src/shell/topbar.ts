import type { SystemAPI } from '../kernel/types';
import { t } from '../kernel/i18n';
import { renderIcon } from './icon';
import { MARK_GLYPH_GOLD_SVG, MARK_GLYPH_SVG } from '../brand/logo';
import { ACCENTS, BRAND_ACCENT_ID, applyTheme, applyAccent, type ThemeMode } from './appearance';

const ICON_SYSTEM =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.4" fill="currentColor"/><path d="M4 20c1.2-4.2 4.6-6 8-6s6.8 1.8 8 6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';

export function mountTopbar(root: HTMLElement, sys: SystemAPI, onToggleOverview: () => void): HTMLElement {
  const bar = document.createElement('header');
  bar.className = 'faisal-topbar';

  const start = document.createElement('div');
  start.className = 'faisal-topbar-side faisal-topbar-start';
  const activitiesBtn = document.createElement('button');
  activitiesBtn.type = 'button';
  activitiesBtn.className = 'faisal-topbar-btn faisal-topbar-activities';
  const mark = document.createElement('span');
  mark.className = 'faisal-topbar-mark';
  mark.append(renderIcon(MARK_GLYPH_GOLD_SVG));
  activitiesBtn.append(mark, document.createTextNode(t('shell.activities')));
  activitiesBtn.addEventListener('click', onToggleOverview);
  start.append(activitiesBtn);

  const center = document.createElement('div');
  center.className = 'faisal-topbar-center';
  const clock = document.createElement('span');
  center.append(clock);

  const end = document.createElement('div');
  end.className = 'faisal-topbar-side faisal-topbar-end';
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'faisal-topbar-btn';
  menuBtn.setAttribute('aria-haspopup', 'true');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.append(renderIcon(ICON_SYSTEM));
  end.append(menuBtn);

  bar.append(start, center, end);
  root.prepend(bar);

  function updateClock() {
    const now = new Date();
    const locale = sys.locale() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US';
    const timeFmt = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
    const dateFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' });
    clock.textContent = `${dateFmt.format(now)}  ${timeFmt.format(now)}`;
  }
  updateClock();
  const clockTimer = window.setInterval(updateClock, 15_000);
  window.addEventListener('beforeunload', () => window.clearInterval(clockTimer));

  let menuEl: HTMLElement | null = null;

  function closeMenu() {
    menuEl?.remove();
    menuEl = null;
    menuBtn.setAttribute('aria-expanded', 'false');
  }

  function buildMenu(): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'faisal-menu';
    menu.setAttribute('role', 'menu');

    // Appearance section: theme + accent
    const appearance = document.createElement('div');
    appearance.className = 'faisal-menu-section';
    const themeLabel = document.createElement('div');
    themeLabel.className = 'faisal-menu-label';
    themeLabel.textContent = t('shell.menu.appearance');
    appearance.append(themeLabel);

    const themeRow = document.createElement('div');
    themeRow.className = 'faisal-toggle-row';
    const currentTheme = sys.settings.get<ThemeMode>('theme', 'system');
    (['light', 'dark', 'system'] as ThemeMode[]).forEach((mode) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'faisal-toggle-btn' + (mode === currentTheme ? ' is-active' : '');
      b.textContent = t(`shell.menu.theme.${mode}`);
      b.addEventListener('click', () => {
        sys.settings.set('theme', mode);
        applyTheme(mode);
        [...themeRow.children].forEach((c) => c.classList.remove('is-active'));
        b.classList.add('is-active');
      });
      themeRow.append(b);
    });
    appearance.append(themeRow);

    const accentRow = document.createElement('div');
    accentRow.className = 'faisal-accent-row';
    accentRow.style.marginBlockStart = '10px';
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
        [...accentRow.children].forEach((c) => c.classList.remove('is-active'));
        dot.classList.add('is-active');
      });
      accentRow.append(dot);
    });
    appearance.append(accentRow);
    menu.append(appearance);

    // Language section
    const langSection = document.createElement('div');
    langSection.className = 'faisal-menu-section';
    const langLabel = document.createElement('div');
    langLabel.className = 'faisal-menu-label';
    langLabel.textContent = t('shell.menu.language');
    langSection.append(langLabel);

    const langRow = document.createElement('div');
    langRow.className = 'faisal-toggle-row';
    (['ar', 'en'] as const).forEach((loc) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'faisal-toggle-btn' + (loc === sys.locale() ? ' is-active' : '');
      b.textContent = t(`shell.menu.language.${loc}`);
      b.addEventListener('click', () => {
        sys.settings.set('locale', loc);
        location.reload();
      });
      langRow.append(b);
    });
    langSection.append(langRow);
    menu.append(langSection);

    // About
    const aboutSection = document.createElement('div');
    aboutSection.className = 'faisal-menu-section';
    const aboutBtn = document.createElement('button');
    aboutBtn.type = 'button';
    aboutBtn.className = 'faisal-menu-item';
    aboutBtn.append(renderIcon(MARK_GLYPH_SVG), document.createTextNode(t('shell.menu.about')));
    aboutBtn.addEventListener('click', () => {
      closeMenu();
      sys.apps.launch('org.faisal.Settings', ['about']);
    });
    aboutSection.append(aboutBtn);
    menu.append(aboutSection);

    return menu;
  }

  menuBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (menuEl) { closeMenu(); return; }
    menuEl = buildMenu();
    document.body.append(menuEl);
    menuBtn.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('pointerdown', (ev) => {
    if (menuEl && !menuEl.contains(ev.target as Node) && ev.target !== menuBtn && !menuBtn.contains(ev.target as Node)) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && menuEl) closeMenu();
  });

  return bar;
}
