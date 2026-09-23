import type { AppManifest } from '../../kernel/types';
import { ICON_CLAUDE } from './icon';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.Claude',
  name: { ar: 'Faisal AI', en: 'Faisal AI' },
  description: { ar: 'مساعد ذكي يبحث في الإنترنت ويقرأ الروابط', en: 'An AI assistant that can search the web and read links' },
  icon: ICON_CLAUDE,
  permissions: ['network'],
  singleInstance: true,
  category: 'utilities',
  core: false,
};
