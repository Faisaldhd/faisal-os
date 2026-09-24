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

import { createVFS, lazyVFS, storageTierFor } from './vfs';                    // Track B
import { createProcessTable } from './kernel/process';        // Kernel
import { createWindowManager, mountShell } from './shell';    // Track A
import { isCoarsePointer } from './shell/device';
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
  // Storage limits follow the platform (see src/vfs/quota.ts): the desktop app, a phone, and a
  // desktop browser each get the budget that was measured to be safe for them. Only this layer
  // knows which one we are, so it decides the tier and hands it to the file system.
  const tier = storageTierFor({
    desktop: nativeWeb() !== null,
    coarsePointer: isCoarsePointer(),
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  });
  const vfsReady = createVFS(bus, { tier });
  const vfs = lazyVFS(vfsReady, tier);
  const wm = createWindowManager(root, bus);
  // The process table only listens: it turns the lifecycle events the kernel already emits into
  // the PID/state view that `ps`, `kill`, the System Monitor and the AI agent read.
  const proc = createProcessTable(bus, {
    requestClose: (windowId) => { void wm.get(windowId)?.requestClose(); },
    killClose: (windowId) => { wm.get(windowId)?.close(); },
    isMinimized: (windowId) => wm.isMinimized(windowId),
  });

  let sys!: SystemAPI;
  const apps = createAppRegistry(() => sys);
  sys = {
    bus, vfs, wm, apps, proc, settings,
    locale: getLocale,
    t,
    notify: (title, body) => bus.emit('notify', { title, body }),
  };

  BUILTIN_APPS.forEach((a) => apps.register(a));
  // Embedded web apps (src/apps/web/registry.ts) are listed in the Store but not installed:
  // the owner installs the ones he wants. The window code loads on first launch.
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
  // `updateViaCache: 'none'` keeps the browser from answering the update check from its
  // own HTTP cache: with a cached sw.js the browser can go days without noticing a new
  // build, which is how a fix that is live stays invisible in an open tab.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    void reg.update().catch(() => {});
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        // A new version is ready; it takes over once every Fai$al OS tab is closed.
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          sys.notify(t('shell.update.title'), t('shell.update.body'));
        }
      });
    });
    // The new worker has taken control of this page: it is now serving a different
    // build than the one this document started with, so reload once to match. The
    // first registration has no previous controller and must NOT reload.
    let hadController = navigator.serviceWorker.controller !== null;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      hadController = false;
      reloadOnce('new-service-worker');
    });
  }).catch((err) => console.warn('[sw] registration failed', err));
  void refreshIfStale();
}

/**
 * Makes a deployed fix reach an already-open tab.
 *
 * The service worker serves hashed chunks cache-first and the HTML network-first, but a
 * browser HTTP cache can still answer the navigation with yesterday's `index.html`, which
 * points at yesterday's chunk names — so the running page keeps executing old code no
 * matter how often the user reloads normally. This compares the entry chunk the DEPLOYED
 * HTML names with the one this document actually loaded, and reloads once when they
 * differ. `sessionStorage` holds the entry name we already reloaded for, so a build that
 * fails to start can never produce a reload loop, and being offline is simply ignored.
 */
async function refreshIfStale(): Promise<void> {
  try {
    const running = [...document.querySelectorAll('script[type="module"][src]')]
      .map((s) => (s as HTMLScriptElement).getAttribute('src') ?? '')
      .join(' ');
    if (!running) return;
    const res = await fetch('./index.html', { cache: 'no-store' });
    if (!res.ok) return;
    const deployed = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(await res.text())?.[0];
    if (!deployed || running.includes(deployed)) return;
    reloadOnce(deployed);
  } catch {
    // Offline, or a host that does not serve index.html: keep running what we have.
  }
}

/** Reloads at most once per named build, so a boot failure cannot become a loop. */
function reloadOnce(build: string): void {
  try {
    const KEY = 'faisal.reload.for';
    if (sessionStorage.getItem(KEY) === build) return;
    sessionStorage.setItem(KEY, build);
  } catch {
    // No sessionStorage (private mode): reloading once is still the right move here.
  }
  window.location.reload();
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
