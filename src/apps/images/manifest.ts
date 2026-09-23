import type { AppManifest } from '../../kernel/types';
import { ICON_IMAGES } from './icon';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.ImageViewer',
  name: { ar: 'عارض الصور', en: 'Image Viewer' },
  description: { ar: 'تصفّح صورك وشاهدها', en: 'Browse and view your pictures' },
  icon: ICON_IMAGES,
  permissions: ['fs:home'],
  opens: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'],
  category: 'media',
  core: false,
  singleInstance: false,
};
