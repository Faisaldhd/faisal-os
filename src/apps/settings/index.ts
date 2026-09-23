import type { AppContext, AppModule } from '../../kernel/types';
import { t } from '../../kernel/i18n';
import { renderIcon } from '../../shell/icon';
import { ACCENTS, BRAND_ACCENT_ID, applyTheme, applyAccent, type ThemeMode } from '../../shell/appearance';
import { ICON_SETTINGS } from '../../brand/icons';
import { BRAND, MARK_GLYPH_SVG } from '../../brand/logo';
import { brandLockup } from '../../shell/splash';
import './strings';

const OS_NAME = BRAND.product;
const OS_VERSION = '0.1.0';

const ICON_APPEARANCE =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3a9 9 0 000 18z" fill="currentColor"/></svg>';
const ICON_LANGUAGE =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 12h18M12 3c2.4 2.6 3.6 5.7 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.7-3.6-9S9.6 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

type SectionId = 'appearance' | 'language' | 'about';

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
  manifest: {
    id: 'org.faisal.Settings',
    name: { ar: 'الإعدادات', en: 'Settings' },
    description: { ar: 'تخصيص مظهر النظام ولغته', en: 'Customize system appearance and language' },
    icon: ICON_SETTINGS,
    permissions: ['settings'],
    category: 'system',
    core: true,
    singleInstance: true,
  },
  launch,
};

export default app;
