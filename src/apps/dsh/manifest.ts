import type { AppManifest } from '../../kernel/types';
import { ICON_DSH } from './icon';

/**
 * Static app metadata: kept apart from the app code so the launcher can list the
 * app without loading (or downloading) it.
 *
 * `category: 'utilities'` — the same category as the Browser and Streamed
 * Browser apps, and for the same reason. `'web'` is reserved for the packaged
 * websites in src/apps/web/registry.ts: the shell deliberately keeps that
 * category OUT of the dock (src/shell/dock.ts:37) and out of the main launcher
 * grid (src/shell/overview.ts:105), putting it in a separate "Web Apps" group.
 * This is one first-class app, not a per-site entry, so it belongs with the
 * ordinary apps and changes nothing about the launcher.
 *
 * Only `network` is requested: the app has no file system, settings, or
 * notification needs — it reads one URL from its own localStorage key and frames
 * it. It never starts the harness and never touches the machine: it can only show
 * a server the owner already started.
 */
export const manifest: AppManifest = {
  id: 'org.faisal.DSH',
  name: { ar: 'ديب سيك هارنس', en: 'DeepSeek Harness' },
  description: {
    ar: 'واجهة ديب سيك هارنس (DSH) المحلية — وكيل المحادثة والبرمجة الذي تشغّله أنت على جهازك — معروضة داخل نافذة عادية في النظام من خادم محلي تبدأه بنفسك',
    en: 'The local DeepSeek Harness (DSH) interface — the agent/chat harness you run on your own machine — shown inside an ordinary OS window, framed from a local server you start yourself',
  },
  icon: ICON_DSH,
  permissions: ['network'],
  category: 'utilities',
  version: '1.0.0',
  singleInstance: true,
  core: false,
};
