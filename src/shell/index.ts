import './theme.css';
import './strings';
import type { SystemAPI } from '../kernel/types';
import { isKey, cycleTarget } from './keys';
export { createWindowManager } from './wm';
import { wireAppearance } from './appearance';
import { mountTopbar } from './topbar';
import { mountOverview } from './overview';
import { mountDock } from './dock';
import { mountScreenshot } from './screenshot';
import { mountNotifications } from './notifications';
import { mountSplash } from './splash';
import { mountDesktop } from './desktop';
import { mountSession } from './session';
import { mountLock } from './lock';

export function mountShell(root: HTMLElement, sys: SystemAPI): void {
  wireAppearance(sys.bus, sys.settings);
  mountSplash(sys.bus);

  mountDesktop(root, sys, sys.wm);
  const overview = mountOverview(root, sys, sys.wm);
  const screenshot = mountScreenshot(sys);
  const lock = mountLock();
  const topbar = mountTopbar(
    root,
    sys,
    () => overview.toggle(),
    () => screenshot.capture(),
    () => ({ enabled: lock.isEnabled(), onLock: () => lock.lock(), onManage: () => lock.openManage() }),
  );
  mountDock(root, sys);
  mountNotifications(root, sys, topbar.querySelector<HTMLButtonElement>('.faisal-topbar-clock'));

  // GNOME behaviour: tapping the Super/Windows key alone toggles Activities; Alt+F1 does too.
  let superAlone = false;
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && overview.isOpen()) overview.close();
    if (ev.key === 'Meta' || ev.key === 'OS') { superAlone = !ev.repeat; ev.preventDefault(); return; }
    superAlone = false;
    if (ev.altKey && ev.key === 'F1') { ev.preventDefault(); overview.toggle(); }
    // Windows snipping shortcut. The OS takes Win+Shift+S unless the page is in full screen (Keyboard Lock).
    if (ev.metaKey && ev.shiftKey && isKey(ev, 'S')) { ev.preventDefault(); overview.close(); screenshot.capture(); }
  });
  window.addEventListener('keyup', (ev) => {
    if ((ev.key === 'Meta' || ev.key === 'OS') && superAlone) { superAlone = false; ev.preventDefault(); overview.toggle(); }
  });
  window.addEventListener('blur', () => { superAlone = false; });

  // Ctrl+Alt+T opens a terminal, as on most Linux desktops.
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.altKey && !ev.shiftKey && isKey(ev, 'T')) {
      ev.preventDefault();
      overview.close();
      void sys.apps.launch('org.faisal.Terminal').catch(() => {});
    }
  });

  // Ctrl+Alt+Tab replaces the desktop Alt+Tab, which the operating system never sends to a
  // page. Focusing a minimized window restores it, exactly like the desktop switcher.
  window.addEventListener('keydown', (ev) => {
    if (!ev.ctrlKey || !ev.altKey || (ev.key !== 'Tab' && ev.code !== 'Tab')) return;
    const windows = sys.wm.list();
    const target = cycleTarget(windows.map((w) => w.id), sys.wm.focused()?.id ?? null, ev.shiftKey);
    if (!target) return;
    ev.preventDefault();
    overview.close();
    sys.wm.get(target)?.focus();
  });

  // Ctrl+Alt+L locks the session. Guarded like the window manager's shortcuts: never while the
  // user is typing (a terminal is a real textarea) and never mid-IME composition.
  window.addEventListener('keydown', (ev) => {
    if (!ev.ctrlKey || !ev.altKey || ev.shiftKey || !isKey(ev, 'L')) return;
    const target = ev.target as HTMLElement | null;
    const typing = !!target && (target.isContentEditable
      || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
    if (typing || ev.isComposing || lock.isLocked() || !lock.isEnabled()) return;
    ev.preventDefault();
    overview.close();
    lock.lock();
  });

  mountSession(sys);

  // Boot gate: a configured password raises the curtain before anything becomes reachable.
  if (lock.isEnabled()) lock.lock();
}
