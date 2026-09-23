import './theme.css';
import './strings';
import type { SystemAPI } from '../kernel/types';
export { createWindowManager } from './wm';
import { wireAppearance } from './appearance';
import { mountTopbar } from './topbar';
import { mountOverview } from './overview';
import { mountNotifications } from './notifications';
import { mountSplash } from './splash';

export function mountShell(root: HTMLElement, sys: SystemAPI): void {
  wireAppearance(sys.bus, sys.settings);
  mountSplash(sys.bus);

  const overview = mountOverview(root, sys, sys.wm);
  mountTopbar(root, sys, () => overview.toggle());
  mountNotifications(root, sys.bus);

  // GNOME behaviour: tapping the Super/Windows key alone toggles Activities; Alt+F1 does too.
  let superAlone = false;
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && overview.isOpen()) overview.close();
    if (ev.key === 'Meta' || ev.key === 'OS') { superAlone = !ev.repeat; ev.preventDefault(); return; }
    superAlone = false;
    if (ev.altKey && ev.key === 'F1') { ev.preventDefault(); overview.toggle(); }
  });
  window.addEventListener('keyup', (ev) => {
    if ((ev.key === 'Meta' || ev.key === 'OS') && superAlone) { superAlone = false; ev.preventDefault(); overview.toggle(); }
  });
  window.addEventListener('blur', () => { superAlone = false; });
}
