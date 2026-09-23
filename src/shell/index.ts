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

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && overview.isOpen()) overview.close();
  });
}
