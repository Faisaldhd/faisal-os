import type { AppManifest } from '../../kernel/types';
import { ICON_STORE } from './icon';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.Store',
  name: { ar: 'المتجر', en: 'Store' },
  description: { ar: 'ثبّت التطبيقات وأزلها', en: 'Install and remove apps' },
  icon: ICON_STORE,
  permissions: ['apps:manage', 'notifications'],
  category: 'system',
  version: '1.0.0',
  core: true,
  defaultInstalled: true,
  singleInstance: true,
  /*
   * A catalogue of ~40 tiles needs room: the window manager default (640x440) showed a
   * cramped three-column grid with a horizontal scrollbar on a 1440px screen. These are
   * honoured by `src/kernel/apps.ts` (see `windowSizeFor`) and clamped by the window
   * manager to whatever the screen allows, so a small display still gets a usable window.
   */
  width: 960,
  height: 680,
  minWidth: 320,
  minHeight: 400,
};
