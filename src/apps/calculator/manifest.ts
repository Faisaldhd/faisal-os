import type { AppManifest } from '../../kernel/types';
import { ICON_CALCULATOR } from './icon';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.Calculator',
  name: { ar: 'الآلة الحاسبة', en: 'Calculator' },
  description: { ar: 'آلة حاسبة أساسية ومتقدمة', en: 'Basic and advanced calculator' },
  icon: ICON_CALCULATOR,
  permissions: [],
  category: 'utilities',
  core: false,
};
