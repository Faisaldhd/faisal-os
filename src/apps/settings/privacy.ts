/**
 * Privacy inventory for the Settings app.
 *
 * Everything here reads or clears the exact storage keys the rest of Fai$al OS
 * really uses — no key is invented and no value is ever shown, only how many
 * items are stored (and, for an AI key, whether one is saved).
 *
 * Keys and their owners:
 *   faisal.settings.v1            kernel/settings.ts   — settings values, including
 *                                                       shell.session and shell.dnd
 *   faisal.notifications.v1       shell/notifications.ts — notification history (cap 50)
 *   faisal.wm.geometry.v1         shell/wm.ts          — one entry per app's last size/position
 *   faisal.browser.bookmarks      apps/browser/model.ts — bookmarks (cap 100)
 *   faisal.browser.engine         apps/browser/model.ts — remembered search engine
 *   faisal.groq.apiKey            apps/ai/providers.ts — Groq key
 *   faisal.deepseek.apiKey        apps/ai/providers.ts — DeepSeek key
 */

export interface StorageLike {
  getItem(key: string): string | null;
}

/** The extra bit a clearing action needs. */
export interface WritableStorageLike extends StorageLike {
  removeItem(key: string): void;
}

export const SETTINGS_KEY = 'faisal.settings.v1';
export const NOTIFICATIONS_KEY = 'faisal.notifications.v1';
export const GEOMETRY_KEY = 'faisal.wm.geometry.v1';
export const BOOKMARKS_KEY = 'faisal.browser.bookmarks';
export const ENGINE_KEY = 'faisal.browser.engine';
/** The default the browser falls back to when `faisal.browser.engine` is gone. */
export const DEFAULT_ENGINE = 'wikipedia';

/** Mirrors the caps the owning modules enforce, so a count can never exceed what is read. */
const NOTIFICATIONS_MAX = 50;
const SESSION_MAX = 12;
const BOOKMARKS_MAX = 100;
/** Settings keys the kernel's allowlist accepts, copied from kernel/settings.ts. */
const VALID_SETTINGS_KEY = /^[a-z][a-z0-9._-]{0,63}$/i;
const FORBIDDEN_SETTINGS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The AI providers whose saved keys this OS can see, in the app's own order.
 * `keyStorage` is duplicated from apps/ai/providers.ts on purpose: the Settings
 * app must not import (and therefore load) the AI app. A test pins the strings.
 */
export const AI_PROVIDERS = [
  // `t()` resolves through the 'settings' namespace, so the keys need its prefix here.
  { id: 'groq', labelKey: 'settings.privacy.ai.groq', keyStorage: 'faisal.groq.apiKey' },
  { id: 'deepseek', labelKey: 'settings.privacy.ai.deepseek', keyStorage: 'faisal.deepseek.apiKey' },
] as const;

export type AiProviderId = (typeof AI_PROVIDERS)[number]['id'];

/** The AI key the given provider's own app reads. */
export const AI_KEY_STORAGE: Record<AiProviderId, string> = {
  groq: 'faisal.groq.apiKey',
  deepseek: 'faisal.deepseek.apiKey',
};

/** What a Privacy action deletes: one app's stored data, or one provider's key. */
export type ClearTarget = 'notifications' | 'browsing' | AiProviderId;

export interface PrivacyInventory {
  /** Values stored in the shared settings object (theme, locale, session, DND…). */
  settingsCount: number;
  /** App ids remembered in `shell.session` inside the settings object. */
  sessionCount: number;
  /** Notifications kept in the history, capped like the shell caps it. */
  notificationCount: number;
  /** Apps with a remembered window size/position. */
  geometryCount: number;
  /** Bookmarked URLs the browser app will load. */
  bookmarkCount: number;
  /** Per provider: true when a non-empty key is saved. Never the key itself. */
  aiKeysSaved: Record<AiProviderId, boolean>;
}

/** A missing, blocked, empty or corrupt value reads as 0 — never throws. */
function raw(store: StorageLike | null | undefined, key: string): string | null {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}

function parsed(store: StorageLike | null | undefined, key: string): unknown {
  const text = raw(store, key);
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

/** Plain data objects only: not null, not an array, not something exotic. */
function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** How many settings values the kernel would actually load (same allowlist). */
function countSettings(rawSettings: unknown): number {
  const data = recordOf(rawSettings);
  if (!data) return 0;
  let n = 0;
  for (const key of Object.keys(data)) {
    if (VALID_SETTINGS_KEY.test(key) && !FORBIDDEN_SETTINGS_KEYS.has(key)) n++;
  }
  return n;
}

/** How many apps the session would reopen, under the shell's own cap. */
function countSession(rawSession: unknown): number {
  if (!Array.isArray(rawSession)) return 0;
  return Math.min(rawSession.filter((id) => typeof id === 'string').length, SESSION_MAX);
}

function countNotifications(rawHistory: unknown): number {
  if (!Array.isArray(rawHistory)) return 0;
  // e.g. null entries, corrupt objects — count what the shell can really show.
  const shown = rawHistory.filter((item) => {
    const n = recordOf(item);
    return !!n && typeof n.id === 'number' && typeof n.title === 'string' && typeof n.time === 'number';
  });
  return Math.min(shown.length, NOTIFICATIONS_MAX);
}

function countBookmarks(rawBookmarks: unknown): number {
  if (!Array.isArray(rawBookmarks)) return 0;
  return Math.min(rawBookmarks.filter((url) => typeof url === 'string' && url.startsWith('https://')).length, BOOKMARKS_MAX);
}

function countGeometry(rawGeometry: unknown): number {
  const data = recordOf(rawGeometry);
  return data ? Object.keys(data).length : 0;
}

function keySaved(store: StorageLike | null | undefined, key: string): boolean {
  const value = raw(store, key);
  return typeof value === 'string' && value.trim().length > 0;
}

/** What the browser currently stores for Fai$al OS, counted item by item. */
export function readPrivacyInventory(store: StorageLike | null | undefined): PrivacyInventory {
  const settings = parsed(store, SETTINGS_KEY);
  const settingsRecord = recordOf(settings);
  return {
    settingsCount: countSettings(settings),
    sessionCount: countSession(settingsRecord?.['shell.session']),
    notificationCount: countNotifications(parsed(store, NOTIFICATIONS_KEY)),
    geometryCount: countGeometry(parsed(store, GEOMETRY_KEY)),
    bookmarkCount: countBookmarks(parsed(store, BOOKMARKS_KEY)),
    aiKeysSaved: {
      groq: keySaved(store, AI_KEY_STORAGE.groq),
      deepseek: keySaved(store, AI_KEY_STORAGE.deepseek),
    },
  };
}

/** Every storage key an action deletes, in a stable order. Drives the confirm text. */
export function clearedKeys(target: ClearTarget): string[] {
  if (target === 'notifications') return [NOTIFICATIONS_KEY];
  if (target === 'browsing') return [BOOKMARKS_KEY, ENGINE_KEY];
  return [AI_KEY_STORAGE[target]];
}

/**
 * Deletes exactly one Privacy item and returns the keys it removed. Only keys this
 * module owns are touched, so clearing one item can never disturb another.
 */
export function clearPrivacyItem(store: WritableStorageLike | null | undefined, target: ClearTarget): string[] {
  const keys = clearedKeys(target);
  for (const key of keys) {
    try { store?.removeItem(key); } catch { /* storage blocked: nothing was stored */ }
  }
  return keys;
}
