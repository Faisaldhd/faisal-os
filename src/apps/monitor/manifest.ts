import type { AppManifest } from '../../kernel/types';
import { ICON_MONITOR } from './icon';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.SystemMonitor',
  name: { ar: 'مراقب النظام', en: 'System Monitor' },
  description: { ar: 'راقب التطبيقات وأداء النظام والتخزين', en: 'Monitor apps, performance and storage' },
  icon: ICON_MONITOR,
  permissions: ['system:monitor', 'fs:read-all'],
  category: 'system',
  core: false,
  singleInstance: true,
};
