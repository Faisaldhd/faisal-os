import type { AppManifest } from '../../kernel/types';
import { ICON_PHOTO } from './icon';
import { MANIFEST_OPENS } from './formats';

/**
 * Static app metadata: kept apart from the app code so the desktop can list the app
 * without loading (or downloading) it.
 *
 * This is a STORE-ONLY app. `defaultInstalled: false` and `core: false` are what make
 * that true: `isInstalled` in src/kernel/apps.ts:131 only counts an app whose
 * `defaultInstalled` is false once its id is in the owner's `added` list — i.e. after he
 * presses "Install" in the Store. It is therefore absent from the dock and the launcher
 * until then, and the Store shows it as available rather than pre-installed. Do not flip
 * either flag: a pre-installed editor would contradict the "install it yourself" rule.
 *
 * `fs:home` only. No network, no settings, no notifications: every byte this app reads
 * and writes stays inside /home/user.
 *
 * `opens` comes from the format table itself (`MANIFEST_OPENS`), not from a hand-written copy,
 * so the list the kernel resolves a file against can never drift from the list the editor
 * really decodes. Without it the OS would never offer this editor for an image: the kernel
 * picks the first INSTALLED app that declares the extension (src/kernel/apps.ts:192).
 *
 * `defaultInstalled: false` is deliberate: that extension list only takes effect once the
 * owner installs the app from the Store, which is the intended flow.
 */
export const manifest: AppManifest = {
  id: 'org.faisal.Photo',
  name: { ar: 'محرّر الصور', en: 'Photo Editor' },
  description: {
    ar: 'محرّر صور احترافي: قص وتدوير وتحجيم وتعديلات وأقلام وفلاتر، مع تراجع/إعادة وتصدير داخل النظام',
    en: 'A professional image editor: crop, rotate, resize, adjustments, brushes and filters, with undo/redo and export inside the OS',
  },
  icon: ICON_PHOTO,
  permissions: ['fs:home'],
  opens: MANIFEST_OPENS,
  category: 'media',
  version: '1.0.0',
  releasedAt: '2026-09-24',
  singleInstance: false,
  core: false,
  defaultInstalled: false,
};
