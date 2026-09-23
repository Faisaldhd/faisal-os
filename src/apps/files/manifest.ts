import type { AppManifest } from '../../kernel/types';
import { ICON_FILES } from '../../brand/icons';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.Files',
  name: { ar: 'الملفات', en: 'Files' },
  description: { ar: 'استعرض وأدر ملفاتك', en: 'Browse and manage your files' },
  icon: ICON_FILES,
  permissions: ['fs:home'],
  category: 'system',
  core: true,
  singleInstance: false,
};
