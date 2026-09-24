/**
 * PDF app — the "recent documents" list and naming of new documents (الملفات الأخيرة).
 *
 * The list is a per-viewer convenience kept in localStorage under one key this app owns (it has
 * no `settings` permission, so never `sys.settings`). Every read and write is wrapped: a private
 * window, a full quota or a corrupt value only means "no recent list", never a broken window.
 * Only paths inside /home/user are kept, and at most ten.
 */
export const RECENT_KEY = 'faisal.pdf.recent.v1';
export const RECENT_MAX = 10;
/** A thumbnail is a small JPEG data URL; anything bigger is dropped instead of filling storage. */
export const THUMB_MAX_CHARS = 24_000;

export interface RecentEntry {
  path: string;
  name: string;
  /** ms epoch of the last open. */
  time: number;
  pages?: number;
  /** `data:image/jpeg;base64,…` of page 1, or absent. */
  thumb?: string;
}

const insideHome = (path: string): boolean => path.startsWith('/home/user/') && !path.includes('/../');

function clean(entry: unknown): RecentEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.path !== 'string' || !insideHome(e.path)) return null;
  if (typeof e.name !== 'string' || typeof e.time !== 'number' || !Number.isFinite(e.time)) return null;
  const out: RecentEntry = { path: e.path, name: e.name.slice(0, 200), time: e.time };
  if (typeof e.pages === 'number' && Number.isInteger(e.pages) && e.pages > 0) out.pages = e.pages;
  if (typeof e.thumb === 'string' && e.thumb.startsWith('data:image/jpeg;base64,') && e.thumb.length <= THUMB_MAX_CHARS) {
    out.thumb = e.thumb;
  }
  return out;
}

export function parseRecent(raw: string | null): RecentEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RecentEntry[] = [];
    for (const item of parsed) {
      const entry = clean(item);
      if (entry && !out.some((o) => o.path === entry.path)) out.push(entry);
    }
    return out.sort((a, b) => b.time - a.time).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Puts `entry` first (replacing an older entry for the same path, keeping its thumbnail). */
export function addRecent(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  const valid = clean(entry);
  if (!valid) return [...list];
  const old = list.find((item) => item.path === valid.path);
  if (!valid.thumb && old?.thumb) valid.thumb = old.thumb;
  return [valid, ...list.filter((item) => item.path !== valid.path)].slice(0, RECENT_MAX);
}

export function removeRecent(list: readonly RecentEntry[], path: string): RecentEntry[] {
  return list.filter((item) => item.path !== path);
}

/** Rewrites a moved/renamed path, e.g. after "save as". */
export function setThumb(list: readonly RecentEntry[], path: string, thumb: string): RecentEntry[] {
  if (!thumb.startsWith('data:image/jpeg;base64,') || thumb.length > THUMB_MAX_CHARS) return [...list];
  return list.map((item) => (item.path === path ? { ...item, thumb } : item));
}

export function loadRecent(): RecentEntry[] {
  try {
    return parseRecent(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

export function storeRecent(list: readonly RecentEntry[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Private mode or a full quota: the list simply lives for this window only.
  }
}

/**
 * A name for a document that has never been saved: `<dir>/<stem>.pdf`, then `<stem>-2.pdf`…
 * The stem is cleaned of path separators and characters the file system rejects.
 */
export async function freePdfPath(dir: string, stem: string, isTaken: (path: string) => boolean | Promise<boolean>): Promise<string | null> {
  const safe = stem.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'document';
  for (let attempt = 1; attempt <= 500; attempt++) {
    const name = attempt === 1 ? `${safe}.pdf` : `${safe}-${attempt}.pdf`;
    const path = `${dir.replace(/\/+$/, '')}/${name}`;
    if (!(await isTaken(path))) return path;
  }
  return null;
}

/** A path typed in "save as" → a normalized absolute path ending in .pdf inside /home/user, or null. */
export function checkSaveAsPath(text: string): string | null {
  const raw = text.trim();
  if (!raw.startsWith('/')) return null;
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    if (/[\u0000-\u001f]/.test(part)) return null;
    parts.push(part);
  }
  if (!parts.length) return null;
  let path = `/${parts.join('/')}`;
  if (!/\.pdf$/i.test(path)) path += '.pdf';
  return insideHome(path) ? path : null;
}
