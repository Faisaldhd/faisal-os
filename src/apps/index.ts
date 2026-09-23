/**
 * Built-in apps. Only manifests are imported here; each app's code (and its CSS)
 * is a separate chunk that loads the first time the app is launched.
 */
import type { LazyAppModule } from '../kernel/types';
import { manifest as files } from './files/manifest';
import { manifest as terminal } from './terminal/manifest';
import { manifest as editor } from './editor/manifest';
import { manifest as browser } from './browser/manifest';
import { manifest as ai } from './ai/manifest';
import { manifest as calculator } from './calculator/manifest';
import { manifest as images } from './images/manifest';
import { manifest as clock } from './clock/manifest';
import { manifest as monitor } from './monitor/manifest';
import { manifest as store } from './store/manifest';
import { manifest as settings } from './settings/manifest';

const lazy = (manifest: LazyAppModule['manifest'], load: () => Promise<{ default: import('../kernel/types').AppModule }>): LazyAppModule =>
  ({ manifest, load: () => load().then((m) => m.default) });

/** Registration order is the default dock order. */
export const BUILTIN_APPS: LazyAppModule[] = [
  lazy(files, () => import('./files')),
  lazy(terminal, () => import('./terminal')),
  lazy(editor, () => import('./editor')),
  lazy(browser, () => import('./browser')),
  lazy(ai, () => import('./ai')),
  lazy(calculator, () => import('./calculator')),
  lazy(images, () => import('./images')),
  lazy(clock, () => import('./clock')),
  lazy(monitor, () => import('./monitor')),
  lazy(store, () => import('./store')),
  lazy(settings, () => import('./settings')),
];
