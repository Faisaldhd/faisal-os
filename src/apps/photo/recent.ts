/**
 * Photo Editor — the "Recent" list on the start screen. The list logic is pure; storage is a
 * per-browser convenience in localStorage, wrapped in try/catch because it can be missing or
 * blocked (private windows), in which case the list is simply empty.
 */
export interface RecentItem { path: string; name: string; at: number }

export const RECENT_KEY = 'faisal.photo.recent.v1';
export const RECENT_MAX = 10;

/** Moves `path` to the front, drops duplicates, keeps at most `max`. */
export function pushRecent(list: readonly RecentItem[], path: string, at: number, max = RECENT_MAX): RecentItem[] {
  const name = path.slice(path.lastIndexOf('/') + 1) || path;
  return [{ path, name, at }, ...list.filter((r) => r.path !== path)].slice(0, max);
}

export function removeRecent(list: readonly RecentItem[], path: string): RecentItem[] {
  return list.filter((r) => r.path !== path);
}

/** Validates whatever came out of storage; anything malformed is dropped. */
export function parseRecent(raw: string | null): RecentItem[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((r): r is RecentItem => !!r && typeof r === 'object'
        && typeof (r as RecentItem).path === 'string' && (r as RecentItem).path.startsWith('/home/user/')
        && typeof (r as RecentItem).at === 'number')
      .map((r) => ({ path: r.path, name: r.path.slice(r.path.lastIndexOf('/') + 1), at: r.at }))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function loadRecent(): RecentItem[] {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

export function saveRecent(list: readonly RecentItem[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage blocked: the recent list is a convenience, nothing else depends on it.
  }
}
