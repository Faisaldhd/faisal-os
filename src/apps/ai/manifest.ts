import type { AppManifest } from '../../kernel/types';
import { ICON_AI } from './icon';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  // Kept from the app's first version so installed state and pins carry over.
  id: 'org.faisal.Claude',
  name: { ar: 'Faisal AI', en: 'Faisal AI' },
  description: { ar: 'وكيل ذكي عبر GroqCloud يدير ملفاتك وتطبيقاتك وينفّذ الأوامر بإذنك', en: 'An AI agent on GroqCloud that manages your files and apps and runs commands, with your OK' },
  icon: ICON_AI,
  // Agent mode acts on the whole system; every change is confirmed by the user first.
  permissions: ['network', 'fs:home', 'fs:read-all', 'system:monitor', 'settings', 'notifications'],
  singleInstance: true,
  category: 'utilities',
  core: false,
};
