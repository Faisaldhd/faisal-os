import type { AppManifest } from '../../kernel/types';
import { ICON_BROWSER } from './icon';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.Browser',
  name: { ar: 'المتصفح', en: 'Browser' },
  description: {
    ar: 'تصفّح الويب داخل النظام عبر إطار مضمّن آمن — بعض المواقع تمنع ذلك عمداً',
    en: 'Browse the web inside the OS via a safe embedded frame — some sites deliberately block this',
  },
  icon: ICON_BROWSER,
  permissions: ['network'],
  category: 'utilities',
  version: '1.0.0',
  core: false,
};
