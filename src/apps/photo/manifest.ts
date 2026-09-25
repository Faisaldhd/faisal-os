import type { AppManifest } from '../../kernel/types';
import { ICON_PHOTO } from './icon';
import { MANIFEST_OPENS } from './formats';

/**
 * Static app metadata: kept apart from the app code so the desktop can list the app
 * without loading (or downloading) it.
 *
 * Installed by default (the owner's decision, 2026-09-25) with `core: false`: the editor is
 * on the desktop from the first run, so a double-clicked image opens here and not in the
 * read-only Image Viewer — and the owner can still remove it from the Store, which is
 * remembered in the `removed` list (`isInstalled`, src/kernel/apps.ts).
 *
 * `fs:home` only. No network, no settings, no notifications: every byte this app reads
 * and writes stays inside /home/user.
 *
 * `opens` comes from the format table itself (`MANIFEST_OPENS`), not from a hand-written copy,
 * so the list the kernel resolves a file against can never drift from the list the editor
 * really decodes. Without it the OS would never offer this editor for an image: the kernel
 * picks the first INSTALLED app that declares the extension (src/kernel/apps.ts:192).
 *
 * Being installed by default is what makes that extension list take effect on the first run,
 * which is the intended flow since the owner's decision: double-click an image, get the editor.
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
  defaultInstalled: true,
};
