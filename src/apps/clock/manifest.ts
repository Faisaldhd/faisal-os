import type { AppManifest } from '../../kernel/types';
import { ICON_CLOCK } from './icon';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.Clock',
  name: { ar: 'الساعة', en: 'Clock' },
  description: { ar: 'الوقت العالمي، التقويم، ساعة الإيقاف والمؤقت', en: 'World time, calendar, stopwatch and timer' },
  icon: ICON_CLOCK,
  permissions: ['notifications'],
  category: 'utilities',
  core: false,
};
