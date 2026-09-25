import type { AppManifest } from '../../kernel/types';
import { ICON_VIDEO } from './icon';
import { VIDEO_EXTENSIONS } from './capabilities';

/**
 * Video Studio — static metadata, kept apart from the app code so the Store and
 * the launcher can list it without loading it.
 *
 * Installed by default (the owner's decision, 2026-09-25) with `core: false`: the studio is
 * on the desktop from the first run, so a double-clicked clip opens here; the owner can still
 * remove it from the Store, and that removal is remembered
 * (src/kernel/apps.ts keeps every default app installed unless its id is in `removed`).
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
  releasedAt: '2026-09-24',
  core: false,
  defaultInstalled: true,
  singleInstance: false,
};
