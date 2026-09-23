import type { AppManifest } from '../../kernel/types';
import { ICON_SETTINGS } from '../../brand/icons';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.Settings',
  name: { ar: 'الإعدادات', en: 'Settings' },
  description: { ar: 'تخصيص مظهر النظام ولغته', en: 'Customize system appearance and language' },
  icon: ICON_SETTINGS,
  permissions: ['settings'],
  category: 'system',
  core: true,
  singleInstance: true,
};
