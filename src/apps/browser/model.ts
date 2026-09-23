/**
 * Local, per-browser (private-by-default) storage: bookmarks and the search
 * engine preference. Nothing here is a system setting — the browser app has
 * no `settings` permission, and history is never written anywhere.
 */
import type { SearchEngine } from './url';

const BOOKMARKS_KEY = 'faisal.browser.bookmarks';
const ENGINE_KEY = 'faisal.browser.engine';
const MAX_BOOKMARKS = 100;

export function loadBookmarks(): string[] {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter((x): x is string => typeof x === 'string' && x.startsWith('https://'));
    return valid.slice(0, MAX_BOOKMARKS);
  } catch {
    return [];
  }
}

export function saveBookmarks(list: string[]): void {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list.slice(0, MAX_BOOKMARKS)));
  } catch { /* ignore (private mode / quota) */ }
}

/** `fallback` applies until the user picks an engine (Google in the desktop build). */
export function loadEngine(fallback: SearchEngine = 'wikipedia'): SearchEngine {
  try {
    const raw = localStorage.getItem(ENGINE_KEY);
    if (raw === 'wikipedia' || raw === 'duckduckgo' || raw === 'google' || raw === 'bing') return raw;
  } catch { /* ignore */ }
  return fallback;
}

const DESKTOP_GOOGLE_KEY = 'faisal.browser.engine.desktopGoogle';

/**
 * Desktop build, once per install: switch to Google even if an engine was saved
 * earlier (most were saved when only Wikipedia could load in-page). Later
 * choices are kept. Returns the engine to use.
 */
export function adoptDesktopGoogleOnce(current: SearchEngine): SearchEngine {
  try {
    if (localStorage.getItem(DESKTOP_GOOGLE_KEY)) return current;
    localStorage.setItem(DESKTOP_GOOGLE_KEY, '1');
    saveEngine('google');
    return 'google';
  } catch {
    return current;
  }
}

export function saveEngine(engine: SearchEngine): void {
  try { localStorage.setItem(ENGINE_KEY, engine); } catch { /* ignore */ }
}
