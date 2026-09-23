/**
 * Fai$al OS — Web Apps registry (سجل تطبيقات الويب).
 *
 * The ONE place that lists external websites shipped as OS apps. Adding a site
 * is a single entry in `WIRED_WEB_APPS`; nothing else in the OS needs to change:
 *   • src/main.ts maps every def to a LazyAppModule (manifest at boot, code on
 *     first launch),
 *   • the Address/security policy is reused as-is from src/apps/browser/url.ts,
 *   • the window content is the shared, site-agnostic src/apps/web/index.ts.
 *
 * Everything in this file is pure (no DOM, no browser globals except the
 * guarded storage helpers), so it is unit-tested directly — see registry.test.ts.
 */
import type { AppManifest, Locale } from '../../kernel/types';
import { ICON_WEB, ICON_WEB_GOOGLE, ICON_WEB_WIKIPEDIA, ICON_WEB_YOUTUBE } from './icons';

/** Every web app id lives under the OS namespace. */
export const WEB_APP_NAMESPACE = 'org.faisal.Web';

/**
 * The only storage an app may touch here. `Storage` is injected (never read
 * from the global directly) so tests can pass a throwing or corrupt stub, and
 * so no part of this module depends on `window`.
 */
export type WebStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface WebAppDef {
  /** Stable, lowercase, dot-free key. Namespaces the app id and the settings key. */
  id: string;
  /** Bilingual launcher/window title. */
  title: { ar: string; en: string };
  /** Home URL. Always https; re-verified by isAllowedFrameUrl() before it is framed. */
  url: string;
  /** Brand tile for the dock/launcher/Store. Defaults to the shared globe. */
  icon?: string;
  description?: { ar: string; en: string };
  /**
   * What we measured about this site's framing headers:
   *   'allowed' — no X-Frame-Options / frame-ancestors, it really does embed
   *               (e.g. wikipedia.org).
   *   'blocked' — the site sends X-Frame-Options (SAMEORIGIN/DENY) or a
   *               frame-ancestors CSP that excludes us, so the frame will come
   *               up blank. The UI warns immediately instead of waiting for the
   *               load timeout, and offers "Open externally".
   * There is no way to detect this from the parent page (the response headers
   * of a cross-origin frame are invisible to us), so it is recorded data, not a
   * runtime check. We never try to bypass it.
   */
  embedNote?: 'allowed' | 'blocked';
}

/* ─────────────────────────── The wired sites ─────────────────────────── */
/*
 * `embedNote` below reflects headers measured on 2026-09-23:
 *   www.google.com  X-Frame-Options: SAMEORIGIN     → blocked
 *   www.youtube.com X-Frame-Options: SAMEORIGIN     → blocked
 *                     (https://www.youtube.com/embed/<id> IS allowed — the
 *                      rewriteYouTubeEmbed() path in the browser URL policy)
 *   www.wikipedia.org / en.wikipedia.org/wiki/…     → no XFO, no
 *                     frame-ancestors                  → allowed
 */
export const WIRED_WEB_APPS: readonly WebAppDef[] = [
  {
    id: 'google',
    title: { ar: 'جوجل', en: 'Google' },
    url: 'https://www.google.com/',
    icon: ICON_WEB_GOOGLE,
    description: {
      ar: 'بحث جوجل — يمنع العرض داخل إطار، لذا يفتح في تبويب خارجي',
      en: 'Google Search — refuses to be embedded, so it opens in an external tab',
    },
    embedNote: 'blocked',
  },
  {
    id: 'youtube',
    title: { ar: 'يوتيوب', en: 'YouTube' },
    url: 'https://www.youtube.com/',
    icon: ICON_WEB_YOUTUBE,
    description: {
      ar: 'يوتيوب — الصفحة الرئيسية تمنع العرض المضمّن، أما روابط /embed/ فتعمل',
      en: 'YouTube — the home page blocks embedding, but /embed/ links do work',
    },
    embedNote: 'blocked',
  },
  {
    id: 'wikipedia',
    title: { ar: 'ويكيبيديا', en: 'Wikipedia' },
    url: 'https://www.wikipedia.org/',
    icon: ICON_WEB_WIKIPEDIA,
    description: {
      ar: 'الموسوعة الحرة — تعمل بالكامل داخل نافذة النظام',
      en: 'The free encyclopedia — works fully inside an OS window',
    },
    embedNote: 'allowed',
  },
];

/* ─────────────────────────────── Helpers ─────────────────────────────── */

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `{ id: 'google' }` → `'org.faisal.Web.google'`. Throws on a malformed key. */
export function webAppId(def: WebAppDef): string {
  if (!ID_RE.test(def.id)) throw new Error(`Web app id must be a lowercase [a-z0-9-] key: "${def.id}"`);
  return `${WEB_APP_NAMESPACE}.${def.id}`;
}

/**
 * The launcher-visible manifest. Registered as a non-core, `defaultInstalled`
 * app on purpose: it shows up in the Store like any other app and can be
 * removed and reinstalled through the ordinary install/uninstall path.
 */
export function webAppManifest(def: WebAppDef): AppManifest {
  return {
    id: webAppId(def),
    name: { ...def.title },
    description: def.description ? { ...def.description } : undefined,
    icon: def.icon ?? ICON_WEB,
    permissions: ['network'],
    category: 'web',
    singleInstance: true,
    version: '1.0.0',
  };
}

/**
 * Settings key holding the last URL visited in this web app.
 *
 * It is a *local* app key, not an OS-wide setting: the Storage object passed to
 * the helpers is `localStorage`, exactly like `faisal.browser.bookmarks` and
 * `faisal.clock.cities`. This matters — the manifest grants only `network`, and
 * the kernel's scoped `sys.settings.set` throws EACCES without the `settings`
 * permission (which would let a website-backed app change OS-wide settings,
 * far broader than remembering its own last URL).
 */
export function lastUrlStorageKey(def: WebAppDef): string {
  return `faisal.web.${def.id}.url`;
}

/**
 * Storage must never break the app: a corrupt value, a blocked storage
 * partition or a private-mode `setItem` that throws are all normal outcomes,
 * so both helpers swallow every exception.
 */
export function savedUrl(def: WebAppDef, storage: WebStorage): string | null {
  try {
    const raw = storage.getItem(lastUrlStorageKey(def));
    return typeof raw === 'string' && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

export function saveUrl(def: WebAppDef, url: string, storage: WebStorage): void {
  try {
    storage.setItem(lastUrlStorageKey(def), url);
  } catch {
    /* best effort: a URL we cannot remember is not an error the user must see */
  }
}

/** Bookkeeping wrapper around saveUrl — one call site, one place that can fail. */
export const saveLastUrl = saveUrl;

/** The URL a window should start on: the remembered one, else the def's home. */
export function startingUrl(def: WebAppDef, storage: WebStorage): string {
  return savedUrl(def, storage) ?? def.url;
}

/**
 * The real store a web app remembers its URL in: the browser's own
 * `localStorage`. Returns null when the browser blocks it (private mode, or a
 * blocked partition) — a web app then simply starts on its home URL.
 */
export function localStorageOrNull(): WebStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A store that remembers nothing: used when localStorage is unavailable. */
export const NO_STORAGE: WebStorage = { getItem: () => null, setItem: () => {} };

/** Window title in the current locale: "Web App — YouTube". */
export function webAppWindowTitle(def: WebAppDef, locale: Locale, base: string): string {
  return `${base} — ${def.title[locale]}`;
}
