import type { AppManifest } from '../../kernel/types';
import { ICON_STREAM } from './icon';

/**
 * Static app metadata: kept apart from the app code so the launcher can list
 * the app without loading (or downloading) it.
 *
 * `category: 'utilities'` — the same category as the Browser app, and for the
 * same reason. `'web'` is reserved for the packaged websites in
 * src/apps/web/registry.ts: the shell deliberately keeps that category OUT of
 * the dock (src/shell/dock.ts:37) and out of the main launcher grid
 * (src/shell/overview.ts:105), putting it in a separate "Web Apps" group.
 * The streamed browser is one first-class app, not a per-site entry, so it
 * belongs with the ordinary apps and changes nothing about the launcher.
 *
 * Only `network` is requested: the app has no file system, settings, or
 * notification needs — it reads one URL from its own localStorage key and
 * frames it.
 */
export const manifest: AppManifest = {
  id: 'org.faisal.Stream',
  name: { ar: 'المتصفح المُبثّ', en: 'Streamed Browser' },
  description: {
    ar: 'متصفح حقيقي يعمل داخل حاوية Docker تملكها، وتُعرض شاشته داخل نافذة النظام — فتفتح المواقع التي ترفض العرض داخل إطار (جوجل، يوتيوب)',
    en: 'A real browser running in a Docker container you own, its screen shown inside an OS window — so sites that refuse framing (Google, YouTube) work fully here',
  },
  icon: ICON_STREAM,
  permissions: ['network'],
  category: 'utilities',
  version: '1.0.0',
  singleInstance: true,
  core: false,
};
