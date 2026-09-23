import type { AppManifest } from '../../kernel/types';
import { ICON_AI } from './icon';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  // Kept from the app's first version so installed state and pins carry over.
  id: 'org.faisal.Claude',
  name: { ar: 'Faisal AI', en: 'Faisal AI' },
  description: { ar: 'مساعد ذكي سريع عبر GroqCloud يبحث في الإنترنت', en: 'A fast AI assistant on GroqCloud that can search the web' },
  icon: ICON_AI,
  permissions: ['network'],
  singleInstance: true,
  category: 'utilities',
  core: false,
};
