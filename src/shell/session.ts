import type { SystemAPI } from '../kernel/types';

/** Open apps (one entry per window, bottom to top) saved for the next start. */
const SESSION_KEY = 'shell.session';
/** Settings toggle; on by default. */
export const RESTORE_KEY = 'shell.restoreSession';
/** Don't reopen an unbounded number of windows after a crash loop or a runaway app. */
const MAX_RESTORED = 12;

/** Pure: the saved list, keeping only installed apps and capping its length. */
export function sessionToRestore(raw: unknown, installed: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const ok = new Set(installed);
  return raw.filter((id): id is string => typeof id === 'string' && ok.has(id)).slice(-MAX_RESTORED);
}

/**
 * Remembers which apps are open and reopens them on the next start, in the same
 * stacking order. Window sizes and positions come back through the window manager.
 */
export function mountSession(sys: SystemAPI): void {
  let restoring = true;
  let timer = 0;

  const save = () => {
    if (restoring) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      sys.settings.set(SESSION_KEY, sys.wm.list().map((w) => w.appId));
    }, 400);
  };
  sys.bus.on('app:launched', save);
  sys.bus.on('app:closed', save);
  sys.bus.on('window:focus', save);

  const ids = sys.settings.get<boolean>(RESTORE_KEY, true)
    ? sessionToRestore(sys.settings.get<unknown>(SESSION_KEY, []), sys.apps.list().map((a) => a.id))
    : [];
  void (async () => {
    for (const id of ids) {
      try { await sys.apps.launch(id); } catch (err) { console.warn('[session] could not reopen', id, err); }
    }
    restoring = false;
    save();
  })();
}
