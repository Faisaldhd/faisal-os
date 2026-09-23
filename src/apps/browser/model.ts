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

export function loadEngine(): SearchEngine {
  try {
    const raw = localStorage.getItem(ENGINE_KEY);
    if (raw === 'wikipedia' || raw === 'duckduckgo' || raw === 'google' || raw === 'bing') return raw;
  } catch { /* ignore */ }
  return 'wikipedia';
}

export function saveEngine(engine: SearchEngine): void {
  try { localStorage.setItem(ENGINE_KEY, engine); } catch { /* ignore */ }
}
