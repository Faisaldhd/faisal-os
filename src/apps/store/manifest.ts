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
};
