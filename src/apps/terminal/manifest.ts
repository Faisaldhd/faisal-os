import type { AppManifest } from '../../kernel/types';
import { ICON_TERMINAL } from '../../brand/icons';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.Terminal',
  name: { ar: 'الطرفية', en: 'Terminal' },
  description: { ar: 'سطر أوامر شبيه بـ bash، ولينكس حقيقي عبر v86', en: 'A bash-like command line, plus real Linux via v86' },
  icon: ICON_TERMINAL,
  // fs:system so users can read /etc/os-release etc. The shell itself refuses
  // writes outside /home/user and /tmp, like an unprivileged Linux user.
  permissions: ['fs:home', 'fs:read-all'],
  category: 'system',
  core: true,
};
