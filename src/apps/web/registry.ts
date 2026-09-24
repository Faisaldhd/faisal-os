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
import {
  ICON_WEB,
  ICON_WEB_ARCHIVE,
  ICON_WEB_CALENDAR,
  ICON_WEB_COMMONS,
  ICON_WEB_GOOGLE,
  ICON_WEB_GUTENBERG,
  ICON_WEB_MAP,
  ICON_WEB_OPENLIBRARY,
  ICON_WEB_RADIO,
  ICON_WEB_SEARCH,
  ICON_WEB_SPOTIFY,
  ICON_WEB_VIMEO,
  ICON_WEB_WIKIBOOKS,
  ICON_WEB_WIKIDATA,
  ICON_WEB_WIKIPEDIA,
  ICON_WEB_WIKTIONARY,
  ICON_WEB_YOUTUBE,
} from './icons';
import { YOUTUBE_PLAYER } from './youtube';

/** Every web app id lives under the OS namespace. */
export const WEB_APP_NAMESPACE = 'org.faisal.Web';

/**
 * The only storage an app may touch here. `Storage` is injected (never read
 * from the global directly) so tests can pass a throwing or corrupt stub, and
 * so no part of this module depends on `window`.
 */
export type WebStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * What a web app window actually is:
 *   'frame'  — the shared window in ./index.ts frames one site (the default).
 *   'player' — the shared window too, but with a `transformUrl` that turns what
 *              the user typed (a bare video id) into the site's embeddable form.
 *   'search' — a native window (./searchApp.ts): it has no iframe at all, it
 *              renders its own results inside the window.
 * The shared window file stays site-agnostic; this field is the only switch.
 */
export type WebAppKind = 'frame' | 'player' | 'search';

export interface WebAppDef {
  /** Stable, lowercase, dot-free key. Namespaces the app id and the settings key. */
  id: string;
  /** Defaults to 'frame'. See WebAppKind. */
  kind?: WebAppKind;
  /** Bilingual launcher/window title. */
  title: { ar: string; en: string };
  /** Home URL. Always https; re-verified by isAllowedFrameUrl() before it is framed. */
  url: string;
  /** Brand tile for the dock/launcher/Store. Defaults to the shared globe. */
  icon?: string;
  description?: { ar: string; en: string };
  /**
   * Generic per-def hook the shared window applies to what the user typed, before
   * the ordinary URL policy runs. It is deliberately site-agnostic: the shared
   * window knows nothing about YouTube, it only knows that some app wants its
   * input normalised first. Returning '' means "this app cannot use that input",
   * and the window then shows its honest fallback card rather than a blank frame.
   *
   * A def without it (every plain site) passes the user's input through unchanged.
   */
  transformUrl?: (raw: string) => string;
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
 * `embedNote` below reflects headers measured with PowerShell `Invoke-WebRequest`
 * (following redirects) on 2026-09-23 — the raw evidence for every entry, and
 * for the candidates that were rejected, is in docs/… and in the task report.
 * Recorded per host:
 *
 *   www.google.com            X-Frame-Options: SAMEORIGIN     → blocked
 *   www.youtube.com           X-Frame-Options: SAMEORIGIN     → blocked
 *                             (its /embed/<id> endpoint sends neither header,
 *                              which is the whole point of YOUTUBE_PLAYER)
 *   www.wikipedia.org
 *   en/ar.wikipedia.org       no XFO, no frame-ancestors      → allowed
 *   www.wiktionary.org        no XFO, no frame-ancestors      → allowed
 *   www.wikibooks.org         no XFO, no frame-ancestors      → allowed
 *   archive.org               no XFO, no frame-ancestors      → allowed
 *   openlibrary.org           no XFO, no frame-ancestors      → allowed
 *   www.gutenberg.org         no XFO, no frame-ancestors      → allowed
 *   www.openstreetmap.org     no XFO, no frame-ancestors      → allowed
 *   player.vimeo.com          no XFO, no frame-ancestors      → allowed
 *   open.spotify.com          no XFO, no frame-ancestors      → allowed
 *   radio.garden              no XFO, no frame-ancestors      → allowed
 *   www.wikidata.org          no XFO, no frame-ancestors      → allowed
 *   commons.wikimedia.org     no XFO, no frame-ancestors      → allowed
 *   www.youtube.com/embed/…   no XFO, no frame-ancestors      → allowed
 *   www.youtube-nocookie.com/embed/…  no XFO, no frame-ancestors → allowed
 *   www.google.com/maps/embed?pb=…    no XFO, no frame-ancestors → allowed
 *   calendar.google.com/calendar/embed?src=…  no XFO, no frame-ancestors → allowed
 *   drive.google.com/file/d/<id>/preview      no XFO, no frame-ancestors → allowed
 *   docs.google.com/forms/d/e/<id>/viewform?embedded=true
 *                                             no XFO, no frame-ancestors → allowed
 *
 *   duckduckgo.com            X-Frame-Options: SAMEORIGIN
 *                             + frame-ancestors 'self' https://html.duckduckgo.com
 *                                                              → blocked (not added)
 *   html.duckduckgo.com       X-Frame-Options: SAMEORIGIN
 *                             + frame-ancestors 'self'         → blocked (not added)
 */
export const WIRED_WEB_APPS: readonly WebAppDef[] = [
  /* ── measured as refusing to be framed: explained up front, never bypassed ── */
  {
    id: 'google',
    title: { ar: 'جوجل', en: 'Google' },
    url: 'https://www.google.com/',
    icon: ICON_WEB_GOOGLE,
    description: {
      ar: 'بحث جوجل — يمنع العرض داخل إطار، لذا يفتح في تبويب خارجي. للبحث داخل النظام استخدم تطبيق «بحث»',
      en: 'Google Search — refuses to be embedded, so it opens in an external tab. For in-OS search use the Search app',
    },
    embedNote: 'blocked',
  },
  {
    id: 'youtube',
    title: { ar: 'يوتيوب', en: 'YouTube' },
    url: 'https://www.youtube.com/',
    icon: ICON_WEB_YOUTUBE,
    description: {
      ar: 'موقع يوتيوب — الصفحة الرئيسية والقنوات تمنع العرض المضمّن؛ لتشغيل فيديو استخدم «مشغّل يوتيوب»',
      en: 'The YouTube site — its home and channel pages refuse embedding; use “YouTube Player” to play a video',
    },
    embedNote: 'blocked',
  },

  /* ── the OS's own first-class web apps (see kind above) ── */
  YOUTUBE_PLAYER,
  {
    id: 'search',
    kind: 'search',
    title: { ar: 'بحث', en: 'Search' },
    // No third-party page is framed by this app; it talks to a search API and
    // renders the results itself. The URL is the app's own origin-less marker and
    // is never assigned to an iframe.
    url: 'https://api.wikimedia.org/',
    icon: ICON_WEB_SEARCH,
    description: {
      ar: 'ابحث في ويكيبيديا أو جوجل داخل نافذة النظام، وتُعرض النتائج نصّاً حقيقياً من مزوّد البحث نفسه — بدون إطارات ولا وسطاء',
      en: 'Search Wikipedia or Google inside an OS window; results are shown as real text from the provider itself — no frames and no middleman',
    },
    embedNote: 'allowed',
  },

  /* ── measured embeddable: these really do work inside an OS window ── */
  {
    id: 'wikipedia',
    title: { ar: 'ويكيبيديا', en: 'Wikipedia' },
    url: 'https://www.wikipedia.org/',
    icon: ICON_WEB_WIKIPEDIA,
    description: {
      ar: 'الموسوعة الحرة — تعمل بالكامل داخل نافذة النظام، وبكل اللغات',
      en: 'The free encyclopedia — works fully inside an OS window, in every language',
    },
    embedNote: 'allowed',
  },
  {
    id: 'wikipedia-ar',
    title: { ar: 'ويكيبيديا العربية', en: 'Arabic Wikipedia' },
    url: 'https://ar.wikipedia.org/wiki/',
    icon: ICON_WEB_WIKIPEDIA,
    description: {
      ar: 'النسخة العربية من ويكيبيديا — تفتح مباشرة على الصفحة الرئيسية العربية',
      en: 'The Arabic Wikipedia — opens straight on its main page',
    },
    embedNote: 'allowed',
  },
  {
    id: 'wiktionary',
    title: { ar: 'ويكاموس', en: 'Wiktionary' },
    url: 'https://www.wiktionary.org/',
    icon: ICON_WEB_WIKTIONARY,
    description: {
      ar: 'القاموس الحر وكل اللغات — يعمل داخل نافذة النظام',
      en: 'The free dictionary of every language — works inside an OS window',
    },
    embedNote: 'allowed',
  },
  {
    id: 'wikibooks',
    title: { ar: 'ويكي الكتب', en: 'Wikibooks' },
    url: 'https://www.wikibooks.org/',
    icon: ICON_WEB_WIKIBOOKS,
    description: {
      ar: 'كتب ومراجع حرّة يكتبها المجتمع — تعمل داخل نافذة النظام',
      en: 'Free community-written textbooks and manuals — work inside an OS window',
    },
    embedNote: 'allowed',
  },
  {
    id: 'wikidata',
    title: { ar: 'ويكي بيانات', en: 'Wikidata' },
    url: 'https://www.wikidata.org/',
    icon: ICON_WEB_WIKIDATA,
    description: {
      ar: 'قاعدة البيانات المعرفية المفتوحة — تعمل داخل نافذة النظام',
      en: 'The open knowledge base — works inside an OS window',
    },
    embedNote: 'allowed',
  },
  {
    id: 'commons',
    title: { ar: 'ويكيميديا كومنز', en: 'Wikimedia Commons' },
    url: 'https://commons.wikimedia.org/',
    icon: ICON_WEB_COMMONS,
    description: {
      ar: 'مكتبة الوسائط الحرة: صور وأصوات وفيديو — تعمل داخل نافذة النظام',
      en: 'The free media library of images, sound and video — works inside an OS window',
    },
    embedNote: 'allowed',
  },
  {
    id: 'archive-org',
    title: { ar: 'أرشيف الإنترنت', en: 'Internet Archive' },
    url: 'https://archive.org/',
    icon: ICON_WEB_ARCHIVE,
    description: {
      ar: 'أرشيف الإنترنت — كتب ومواقع ووسائط محفوظة، تعمل داخل نافذة النظام',
      en: 'The Internet Archive — books, saved websites and media, working inside an OS window',
    },
    embedNote: 'allowed',
  },
  {
    id: 'openlibrary',
    title: { ar: 'المكتبة المفتوحة', en: 'Open Library' },
    url: 'https://openlibrary.org/',
    icon: ICON_WEB_OPENLIBRARY,
    description: {
      ar: 'فهرس كتب يمكن استعارتها وقراءتها — يعمل داخل نافذة النظام',
      en: 'A catalogue of books you can borrow and read — works inside an OS window',
    },
    embedNote: 'allowed',
  },
  {
    id: 'gutenberg',
    title: { ar: 'مشروع غوتنبرغ', en: 'Project Gutenberg' },
    url: 'https://www.gutenberg.org/',
    icon: ICON_WEB_GUTENBERG,
    description: {
      ar: 'أكثر من ٧٠ ألف كتاب مجاني بلا حقوق — يعمل داخل نافذة النظام',
      en: 'Over 70,000 free public-domain ebooks — works inside an OS window',
    },
    embedNote: 'allowed',
  },
  {
    id: 'radio-garden',
    title: { ar: 'راديو غاردن', en: 'Radio Garden' },
    url: 'https://radio.garden/',
    icon: ICON_WEB_RADIO,
    description: {
      ar: 'استمع إلى محطات راديو حيّة من كل أنحاء العالم — يعمل داخل نافذة النظام',
      en: 'Listen to live radio stations from around the world — works inside an OS window',
    },
    embedNote: 'allowed',
  },

  /* ── the sites' own supported embed products: a player or a map, not the site ── */
  {
    id: 'vimeo',
    title: { ar: 'فيميو (مشغّل مضمَّن)', en: 'Vimeo (embedded player)' },
    url: 'https://player.vimeo.com/video/76979871',
    icon: ICON_WEB_VIMEO,
    description: {
      ar: 'مشغّل فيميو الرسمي المضمَّن — يعرض الفيديو فقط، لا موقع فيميو كاملاً',
      en: 'Vimeo’s official embedded player — it shows the video only, not the whole Vimeo site',
    },
    embedNote: 'allowed',
  },
  {
    id: 'spotify-embed',
    title: { ar: 'سبوتيفاي (مشغّل مضمَّن)', en: 'Spotify (embedded player)' },
    url: 'https://open.spotify.com/embed/episode/',
    icon: ICON_WEB_SPOTIFY,
    description: {
      ar: 'مشغّل سبوتيفاي الرسمي المضمَّن لحلقة أو مقطع — وليس موقع سبوتيفاي كاملاً',
      en: 'Spotify’s official embedded player for one episode or track — not the whole Spotify site',
    },
    embedNote: 'allowed',
  },
  {
    id: 'openstreetmap',
    title: { ar: 'خرائط مفتوحة (مضمَّنة)', en: 'OpenStreetMap (embedded map)' },
    url: 'https://www.openstreetmap.org/export/embed.html?bbox=46.5,24.5,46.9,24.9&layer=mapnik',
    icon: ICON_WEB_MAP,
    description: {
      ar: 'خريطة الرياض المضمَّنة من OpenStreetMap — خريطة فقط بلا واجهة التحرير',
      en: 'The embedded OpenStreetMap map of Riyadh — the map only, without the editing interface',
    },
    embedNote: 'allowed',
  },
  {
    id: 'google-maps-embed',
    title: { ar: 'خرائط جوجل (مضمَّنة)', en: 'Google Maps (embedded map)' },
    url: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3624.0!2d46.7!3d24.7!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zMjTCsDQyJzAwLjAiTiA0NsKwNDInMDAuMCJF!5e0!3m2!1sar!2ssa!4v1700000000000',
    icon: ICON_WEB_MAP,
    description: {
      ar: 'خريطة جوجل الرسمية المضمَّنة — منتج الخرائط القابل للتضمين، وليس موقع خرائط جوجل كاملاً',
      en: 'Google’s official embeddable map — the Maps embed product, not the full Google Maps site',
    },
    embedNote: 'allowed',
  },
  {
    id: 'google-calendar-embed',
    title: { ar: 'تقويم جوجل (مضمَّن)', en: 'Google Calendar (embedded)' },
    url: 'https://calendar.google.com/calendar/embed?src=en.usa%23holiday%40group.v.calendar.google.com',
    icon: ICON_WEB_CALENDAR,
    description: {
      ar: 'تقويم جوجل الرسمي المضمَّن (تقويم العطلات مثالاً) — منتج التقويم القابل للتضمين، وليس واجهة تقويم جوجل كاملة',
      en: 'Google’s official embeddable calendar (holidays as the example) — the Calendar embed product, not the full Calendar UI',
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

/** The def's kind, with the documented default. */
export function webAppKind(def: WebAppDef): WebAppKind {
  return def.kind ?? 'frame';
}

/**
 * Applies the def's `transformUrl` hook to what the user typed — one generic
 * wrapper, so the shared window never touches a site's rule directly.
 *
 * It is total on purpose: a def's transform is a small pure function that could
 * still be handed something it does not expect, and a thrown error in the
 * address bar must never break the window. A transform that throws is treated
 * exactly like one that declined the input (''), which the window already turns
 * into an honest fallback card.
 */
export function applyUrlTransform(def: WebAppDef, raw: string): string {
  if (!def.transformUrl) return raw;
  try {
    return def.transformUrl(raw);
  } catch {
    return '';
  }
}

/**
 * The launcher-visible manifest. Registered as a non-core app that is NOT
 * installed by default (the owner's choice): it is listed in the Store and
 * installed, removed and reinstalled through the ordinary install path.
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
    // In the Store only: the owner installs the sites he wants (Store → Install).
    defaultInstalled: false,
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
