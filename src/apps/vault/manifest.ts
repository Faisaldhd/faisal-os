import type { AppManifest } from '../../kernel/types';
import { ICON_VAULT } from './icon';

/** Static app metadata: kept apart from the app code so the desktop can list the app without loading it. */
export const manifest: AppManifest = {
  id: 'org.faisal.Vault',
  name: { ar: 'الخزنة', en: 'Vault' },
  description: {
    ar: 'خزنة مشفّرة بكلمة مرور رئيسية (AES-GCM 256) لمحتواك الحسّاس',
    en: 'A passphrase-encrypted vault (AES-GCM 256) for your sensitive notes',
  },
  icon: ICON_VAULT,
  permissions: ['fs:home'],
  category: 'accessories',
  version: '1.0.0',
  singleInstance: true,
  opens: ['.vault'],
  core: false,
};
