/**
 * Boot sequence (تسلسل الإقلاع) — ملك kernel. المسارات لا تعدّل هذا الملف؛
 * كل مسار يصدّر من نقطة الدخول الخاصة به بالتواقيع المحددة هنا.
 */
import { createBus } from './kernel/bus';
import { createSettings } from './kernel/settings';
import { createAppRegistry } from './kernel/apps';
import { getLocale, setLocale, t } from './kernel/i18n';
import type { Locale, SystemAPI } from './kernel/types';

import { createVFS } from './vfs';                           // Track B
import { createWindowManager, mountShell } from './shell';   // Track A
import { BUILTIN_APPS } from './apps';

async function boot() {
  const root = document.getElementById('faisal-root')!;
  const bus = createBus();
  const settings = createSettings(bus);
  setLocale(settings.get<Locale>('locale', 'ar'));

  const vfs = await createVFS(bus);
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
  mountShell(root, sys);
  bus.emit('system:ready', {});
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  document.body.textContent = `Boot failed: ${err}`;
});
