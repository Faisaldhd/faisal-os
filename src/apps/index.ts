/**
 * Built-in apps. Only manifests are imported here; each app's code (and its CSS)
 * is a separate chunk that loads the first time the app is launched.
 */
import type { LazyAppModule } from '../kernel/types';
import { manifest as files } from './files/manifest';
import { manifest as terminal } from './terminal/manifest';
import { manifest as editor } from './editor/manifest';
import { manifest as office } from './office/manifest';
import { manifest as pdf } from './pdf/manifest';
import { manifest as photo } from './photo/manifest';
import { manifest as video } from './video/manifest';
import { manifest as browser } from './browser/manifest';
import { manifest as ai } from './ai/manifest';
import { manifest as calculator } from './calculator/manifest';
import { manifest as images } from './images/manifest';
import { manifest as viewer } from './viewer/manifest';
import { manifest as clock } from './clock/manifest';
import { manifest as monitor } from './monitor/manifest';
import { manifest as store } from './store/manifest';
import { manifest as settings } from './settings/manifest';
import { manifest as vault } from './vault/manifest';
import { manifest as stream } from './stream/manifest';
import { manifest as dsh } from './dsh/manifest';

const lazy = (manifest: LazyAppModule['manifest'], load: () => Promise<{ default: import('../kernel/types').AppModule }>): LazyAppModule =>
  ({ manifest, load: () => load().then((m) => m.default) });

/** Registration order is the default dock order. */
export const BUILTIN_APPS: LazyAppModule[] = [
  lazy(files, () => import('./files')),
  lazy(terminal, () => import('./terminal')),
  lazy(editor, () => import('./editor')),
  /*
   * The four suite editors are registered BEFORE the plain viewers (images, viewer), because
   * `appForFile` picks the first INSTALLED app that declares a file extension
   * (src/kernel/apps.ts:192). All four are installed by default (the owner's decision,
   * 2026-09-25), so from the first run double-clicking a .docx or a .png opens the editor
   * rather than the viewer — and each one can still be removed from the Store.
   */
  lazy(office, () => import('./office')),
  lazy(pdf, () => import('./pdf')),
  lazy(photo, () => import('./photo')),
  lazy(video, () => import('./video')),
  lazy(browser, () => import('./browser')),
  lazy(ai, () => import('./ai')),
  lazy(calculator, () => import('./calculator')),
  lazy(images, () => import('./images')),
  lazy(viewer, () => import('./viewer')),
  lazy(clock, () => import('./clock')),
  lazy(monitor, () => import('./monitor')),
  lazy(store, () => import('./store')),
  lazy(settings, () => import('./settings')),
  lazy(vault, () => import('./vault')),
  lazy(stream, () => import('./stream')),
  lazy(dsh, () => import('./dsh')),
];
