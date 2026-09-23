/**
 * Boot sequence (تسلسل الإقلاع) — ملك kernel. المسارات لا تعدّل هذا الملف؛
 * كل مسار يصدّر من نقطة الدخول الخاصة به بالتواقيع المحددة هنا.
 */
import { nativeWeb } from './shell/native-web';
import { createBus } from './kernel/bus';
import { createSettings } from './kernel/settings';
import { createAppRegistry } from './kernel/apps';
import { defineStrings, getLocale, setLocale, t } from './kernel/i18n';
import type { LazyAppModule, Locale, SystemAPI } from './kernel/types';

import { createVFS, lazyVFS } from './vfs';                    // Track B
import { createWindowManager, mountShell } from './shell';    // Track A
import { BUILTIN_APPS } from './apps';
import { WIRED_WEB_APPS, webAppManifest } from './apps/web/registry';

defineStrings('kernel', {
  ar: {
    'boot.failed.title': 'تعذّر إقلاع Fai$al OS',
    'boot.failed.body': 'حدث خطأ غير متوقّع أثناء التحميل. يمكنك إعادة المحاولة.',
    'boot.retry': 'إعادة المحاولة',
  },
  en: {
    'boot.failed.title': 'Fai$al OS could not start',
    'boot.failed.body': 'Something went wrong while loading. You can try again.',
    'boot.retry': 'Try again',
  },
});

async function boot() {
  const root = document.getElementById('faisal-root')!;
  const bus = createBus();
  const settings = createSettings(bus);
  setLocale(settings.get<Locale>('locale', 'ar'));

  // The file system starts opening now, but the desktop does not wait for it: every call
  // goes through a handle that resolves the store on first use, so a slow or large
  // IndexedDB delays file operations instead of the whole shell.
  const vfsReady = createVFS(bus);
  const vfs = lazyVFS(vfsReady);
  const wm = createWindowManager(root, bus);

  let sys!: SystemAPI;
  const apps = createAppRegistry(() => sys);
  sys = {
    bus, vfs, wm, apps, settings,
    locale: getLocale,
    t,
    notify: (title, body) => bus.emit('notify', { title, body }),
  };

  BUILTIN_APPS.forEach((a) => apps.register(a));
  // Embedded web apps (src/apps/web/registry.ts): the manifest is registered now,
  // the window code loads on first launch and is shared by every site.
  for (const def of WIRED_WEB_APPS) {
    const webApp: LazyAppModule = {
      manifest: webAppManifest(def),
      load: () => import('./apps/web').then((m) => m.createWebAppModule(def)),
    };
    apps.register(webApp);
  }
  mountShell(root, sys);
  // The static boot screen in index.html has done its job once the shell is mounted.
  document.getElementById('faisal-boot')?.remove();

  // Announce readiness only after the store resolved: the VFS reports a non-persistent
  // file system on this event, and the notice would be lost if nobody were listening yet.
  try {
    await vfsReady;
  } catch (err) {
    console.error('[boot] file system failed', err);
  }
  bus.emit('system:ready', {});
  registerServiceWorker(sys);
}

/** Offline support and install-as-app (production builds only; see build/pwa.ts). */
function registerServiceWorker(sys: SystemAPI) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  // The desktop build ships its files locally and updates with the app itself.
  if (nativeWeb()) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        // A new version is ready; it takes over once every Fai$al OS tab is closed.
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          sys.notify(t('shell.update.title'), t('shell.update.body'));
        }
      });
    });
  }).catch((err) => console.warn('[sw] registration failed', err));
}

/** A readable, translated failure screen instead of a raw English string on a blank page. */
function showBootFailure(err: unknown): void {
  console.error('[boot] failed', err);
  const host = document.getElementById('faisal-boot') ?? document.body;
  const box = document.createElement('div');
  box.className = 'faisal-boot-error';

  const title = document.createElement('b');
  title.textContent = t('kernel.boot.failed.title');
  const body = document.createElement('p');
  body.textContent = t('kernel.boot.failed.body');
  const detail = document.createElement('code');
  detail.textContent = err instanceof Error ? err.message : String(err);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = t('kernel.boot.retry');
  retry.addEventListener('click', () => window.location.reload());

  box.append(title, body, detail, retry);
  host.replaceChildren(box);
}

boot().catch(showBootFailure);
