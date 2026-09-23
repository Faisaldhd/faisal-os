import type { SystemAPI } from '../kernel/types';
import { t } from '../kernel/i18n';
import { renderIcon } from './icon';
import { MARK_GLYPH_GOLD_SVG, MARK_GLYPH_SVG } from '../brand/logo';
import { ACCENTS, BRAND_ACCENT_ID, applyTheme, applyAccent, type ThemeMode } from './appearance';

const ICON_SYSTEM =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.4" fill="currentColor"/><path d="M4 20c1.2-4.2 4.6-6 8-6s6.8 1.8 8 6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';

export interface LockMenuHooks {
  enabled: boolean;
  onLock: () => void;
  onManage: () => void;
}

export function mountTopbar(
  root: HTMLElement,
  sys: SystemAPI,
  onToggleOverview: () => void,
  onScreenshot?: () => void,
  lock?: () => LockMenuHooks,
): HTMLElement {
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
  // The clock doubles as the notification center button (as in GNOME).
  const clockBtn = document.createElement('button');
  clockBtn.type = 'button';
  clockBtn.className = 'faisal-topbar-btn faisal-topbar-clock';
  clockBtn.setAttribute('aria-haspopup', 'dialog');
  clockBtn.setAttribute('aria-expanded', 'false');
  const clock = document.createElement('span');
  const unreadDot = document.createElement('span');
  unreadDot.className = 'faisal-notif-dot';
  unreadDot.hidden = true;
  clockBtn.append(clock, unreadDot);
  center.append(clockBtn);

  const end = document.createElement('div');
  end.className = 'faisal-topbar-side faisal-topbar-end';
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'faisal-topbar-btn';
  menuBtn.setAttribute('aria-haspopup', 'true');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.append(renderIcon(ICON_SYSTEM));

  // Dedicated full-screen button (full screen is also what lets the Windows key reach the page).
  const fsBtn = document.createElement('button');
  fsBtn.type = 'button';
  fsBtn.className = 'faisal-topbar-btn faisal-topbar-fullscreen';
  const syncFs = () => {
    const on = !!document.fullscreenElement;
    const label = t(on ? 'shell.menu.exitFullscreen' : 'shell.menu.fullscreen');
    fsBtn.title = label;
    fsBtn.setAttribute('aria-label', label);
    fsBtn.setAttribute('aria-pressed', String(on));
    fsBtn.replaceChildren(renderIcon(on ? ICON_FS_EXIT : ICON_FS_ENTER));
  };
  syncFs();
  fsBtn.hidden = !document.fullscreenEnabled;
  fsBtn.addEventListener('click', () => { void toggleFullscreen(); });
  document.addEventListener('fullscreenchange', syncFs);

  end.append(fsBtn, menuBtn);

  bar.append(start, center, end);
  root.prepend(bar);

  function updateClock() {
    const now = new Date();
    const locale = sys.locale() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US';
    const timeFmt = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
    const dateFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' });
    clock.textContent = `${dateFmt.format(now)}  ${timeFmt.format(now)}`;
  }
  // Tick on the minute boundary, so the time never lags behind the real clock.
  const tick = () => {
    updateClock();
    window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  };
  tick();

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

    // Session lock: the entry point that sets a password, and the one that locks right now.
    const lockHooks = lock?.();
    const lockSection = document.createElement('div');
    lockSection.className = 'faisal-menu-section';
    if (lockHooks?.enabled) {
      const lockBtn = document.createElement('button');
      lockBtn.type = 'button';
      lockBtn.className = 'faisal-menu-item';
      lockBtn.textContent = t('shell.lock.now');
      lockBtn.addEventListener('click', () => { closeMenu(); lockHooks.onLock(); });
      lockSection.append(lockBtn);
    }
    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'faisal-menu-item';
    manageBtn.textContent = t(lockHooks?.enabled ? 'shell.lock.change' : 'shell.lock.setTitle');
    manageBtn.addEventListener('click', () => { closeMenu(); lockHooks?.onManage(); });
    lockSection.append(manageBtn);
    menu.append(lockSection);

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
    // Full screen: also captures the Windows/Super key (Keyboard Lock only works in full screen).
    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'faisal-menu-item';
    fsBtn.textContent = t(document.fullscreenElement ? 'shell.menu.exitFullscreen' : 'shell.menu.fullscreen');
    fsBtn.addEventListener('click', () => {
      closeMenu();
      void toggleFullscreen();
    });
    const shotBtn = document.createElement('button');
    shotBtn.type = 'button';
    shotBtn.className = 'faisal-menu-item';
    shotBtn.textContent = t('shell.menu.screenshot');
    shotBtn.addEventListener('click', () => {
      closeMenu();
      onScreenshot?.();
    });
    aboutSection.append(shotBtn, fsBtn, aboutBtn);
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

type KeyboardLock = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };

async function toggleFullscreen(): Promise<void> {
  const kb = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
  try {
    if (document.fullscreenElement) {
      kb?.unlock?.();
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
    // Lets the page receive the Windows/Super key instead of the OS Start menu (Chromium only).
    await kb?.lock?.(['MetaLeft', 'MetaRight']).catch(() => {});
  } catch { /* full screen refused by the browser or frame: nothing to do */ }
}

const ICON_FS_ENTER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<path d="M1.5 1.5h5v2h-3v3h-2zM9.5 1.5h5v5h-2v-3h-3zM1.5 9.5h2v3h3v2h-5zM12.5 9.5h2v5h-5v-2h3z"/></svg>';
const ICON_FS_EXIT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<path d="M4.5 1.5h2v5h-5v-2h3zM9.5 1.5h2v3h3v2h-5zM1.5 9.5h5v5h-2v-3h-3zM9.5 9.5h5v2h-3v3h-2z"/></svg>';
