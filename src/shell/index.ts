import './theme.css';
import './strings';
import type { SystemAPI } from '../kernel/types';
export { createWindowManager } from './wm';
import { wireAppearance } from './appearance';
import { mountTopbar } from './topbar';
import { mountOverview } from './overview';
import { mountDock } from './dock';
import { mountScreenshot } from './screenshot';
import { mountNotifications } from './notifications';
import { mountSplash } from './splash';

export function mountShell(root: HTMLElement, sys: SystemAPI): void {
  wireAppearance(sys.bus, sys.settings);
  mountSplash(sys.bus);

  const overview = mountOverview(root, sys, sys.wm);
  const screenshot = mountScreenshot(sys);
  mountTopbar(root, sys, () => overview.toggle(), () => screenshot.capture());
  mountDock(root, sys);
  mountNotifications(root, sys.bus);

  // GNOME behaviour: tapping the Super/Windows key alone toggles Activities; Alt+F1 does too.
  let superAlone = false;
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && overview.isOpen()) overview.close();
    if (ev.key === 'Meta' || ev.key === 'OS') { superAlone = !ev.repeat; ev.preventDefault(); return; }
    superAlone = false;
    if (ev.altKey && ev.key === 'F1') { ev.preventDefault(); overview.toggle(); }
    // Windows snipping shortcut. The OS takes Win+Shift+S unless the page is in full screen (Keyboard Lock).
    if (ev.metaKey && ev.shiftKey && ev.code === 'KeyS') { ev.preventDefault(); overview.close(); screenshot.capture(); }
  });
  window.addEventListener('keyup', (ev) => {
    if ((ev.key === 'Meta' || ev.key === 'OS') && superAlone) { superAlone = false; ev.preventDefault(); overview.toggle(); }
  });
  window.addEventListener('blur', () => { superAlone = false; });
}
