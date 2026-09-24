import type { AppManifest } from '../../kernel/types';
import { ICON_VIDEO } from './icon';
import { VIDEO_EXTENSIONS } from './capabilities';

/**
 * Video Studio — static metadata, kept apart from the app code so the Store and
 * the launcher can list it without loading it.
 *
 * STORE-ONLY BY DESIGN: `defaultInstalled: false` and `core: false`, so the app is
 * not on the desktop until the owner installs it from the Store himself
 * (src/kernel/apps.ts:131 asks `settings` for an explicit install in that case).
 *
 * Only `fs:home` is requested: the app reads the file the user opened, writes the
 * exported file and the captured PNG, and nothing else. No network, no settings —
 * everything it remembers lives in this window's own state.
 */
export const manifest: AppManifest = {
  id: 'org.faisal.VideoStudio',
  name: { ar: 'استوديو الفيديو', en: 'Video Studio' },
  description: {
    ar: 'مشغّل فيديو وصوت كامل مع قصّ ودوران وقلب وإطار قصّ وتلاشٍ صوتي، وتصدير الملف المعدّل داخل النظام',
    en: 'A full video and audio player with trim, rotate, flip, crop and audio fades, and exports the edited result inside the system',
  },
  icon: ICON_VIDEO,
  permissions: ['fs:home'],
  opens: [...VIDEO_EXTENSIONS],
  category: 'media',
  version: '1.0.0',
  core: false,
  defaultInstalled: false,
  singleInstance: false,
};
