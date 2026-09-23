/**
 * Fai$al Browser — pure URL/search logic (no DOM, fully unit-testable).
 *
 * Everything the browser does with an address-bar string or a link before it
 * ever touches an <iframe> lives here: normalizing what the user typed,
 * deciding it's a search instead of a URL, rejecting dangerous schemes,
 * rewriting a few sites into their embeddable form, and recognizing sites
 * that are known to refuse being framed.
 */

import type { Locale } from '../../kernel/types';

export type SearchEngine = 'wikipedia' | 'duckduckgo' | 'google' | 'bing';

/** Only these engines can be shown inside the app's own <iframe>. The rest
 *  (DuckDuckGo, Google, Bing) send `X-Frame-Options`/`frame-ancestors` and
 *  must be opened as a real browser tab instead. */
export const IN_FRAME_ENGINES = new Set<SearchEngine>(['wikipedia']);

export type ResolvedInput =
  | { kind: 'url'; url: string }
  | { kind: 'search'; query: string };

/**
 * Very loose "does this look like a domain" check: no whitespace, at least
 * one label dot, and a plausible final label (2+ letters, or an IPv4-ish
 * numeric tail). Deliberately permissive — anything that doesn't match falls
 * back to a search, which is always a safe outcome.
 */
export function looksLikeDomain(input: string): boolean {
  if (!input || /\s/.test(input)) return false;
  const hostPart = input.split(/[/?#]/, 1)[0].split(':')[0];
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(hostPart);
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Turns whatever the user typed into the address bar into either a URL to
 * navigate to, or a search query. Rules:
 *  - trims whitespace
 *  - `example.com` (no scheme, domain-shaped) → `https://example.com`
 *  - `http://…` → rewritten to `https://…` (mixed content would be blocked
 *    by the page's CSP anyway; we only ever load https in the frame)
 *  - `https://…` passes through
 *  - any other explicit scheme (`javascript:`, `data:`, `blob:`, `file:`,
 *    `about:`, `chrome:`, …) is never treated as a URL — it is handed back
 *    as a search query so nothing dangerous is ever assigned to the frame
 *  - anything else (plain text, multiple words, no dot) → a search query
 */
export function resolveAddressInput(raw: string): ResolvedInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'search', query: '' };

  const scheme = SCHEME_RE.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme === 'https') return { kind: 'url', url: trimmed };
  if (scheme === 'http') return { kind: 'url', url: `https${trimmed.slice(4)}` };
  if (scheme) return { kind: 'search', query: trimmed }; // javascript:, data:, blob:, file:, about:, chrome:, ...

  if (looksLikeDomain(trimmed)) return { kind: 'url', url: `https://${trimmed}` };
  return { kind: 'search', query: trimmed };
}

/**
 * Whether `url` may ever be assigned as an <iframe src>. Only https is
 * allowed (no javascript:/data:/blob:/file:/about:/chrome:, and http is
 * rewritten before it gets here), and the OS's own origin is always
 * rejected — the browser app must never be able to frame itself (that
 * would let a "site" run as a full page inside the OS with the OS's own
 * permissions, and enables clickjacking against the OS UI).
 */
export function isAllowedFrameUrl(url: string, selfOrigin: string = defaultSelfOrigin()): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (selfOrigin && parsed.origin === selfOrigin) return false;
  return true;
}

function defaultSelfOrigin(): string {
  try {
    return typeof location !== 'undefined' ? location.origin : '';
  } catch {
    return '';
  }
}

/* ───────────────────────────── Smart rewrites ───────────────────────────── */

const YT_ID_RE = /^[a-zA-Z0-9_-]{6,}$/;

/**
 * Rewrites a YouTube watch/shorts/short-link URL into a youtube-nocookie.com
 * embed URL (the only form of YouTube that agrees to be framed). Returns
 * `null` when `url` isn't a recognizable YouTube video link — the caller
 * should treat those (e.g. https://www.youtube.com/ itself, a channel page)
 * as an ordinary URL, which the blocklist below then correctly refuses.
 */
export function rewriteYouTubeEmbed(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id: string | null = null;

  if (host === 'youtu.be') {
    id = parsed.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (parsed.pathname === '/watch') {
      id = parsed.searchParams.get('v');
    } else if (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live') {
      id = segments[1] ?? null;
    }
  }

  if (!id || !YT_ID_RE.test(id)) return null;
  return `https://www.youtube-nocookie.com/embed/${id}`;
}

/** Default map view (Riyadh) for the OpenStreetMap home-page shortcut. */
export const DEFAULT_MAP_BBOX = '46.5,24.5,46.9,24.9';

export function buildOpenStreetMapEmbedUrl(bbox: string = DEFAULT_MAP_BBOX): string {
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik`;
}

/* ─────────────────────────────── Search URLs ─────────────────────────────── */

/** Wikipedia search, embeddable in the frame. Locale picks ar/en Wikipedia. */
export function buildWikipediaSearchUrl(query: string, locale: Locale): string {
  const sub = locale === 'ar' ? 'ar' : 'en';
  return `https://${sub}.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
}

/** DuckDuckGo/Google/Bing block framing entirely — these are only ever
 *  opened in a real new tab, never assigned to the <iframe>. */
export function buildExternalSearchUrl(query: string, engine: Exclude<SearchEngine, 'wikipedia'>): string {
  const q = encodeURIComponent(query);
  if (engine === 'google') return `https://www.google.com/search?q=${q}`;
  if (engine === 'bing') return `https://www.bing.com/search?q=${q}`;
  return `https://duckduckgo.com/?q=${q}`;
}

export function buildSearchUrl(query: string, engine: SearchEngine, locale: Locale): string {
  return engine === 'wikipedia' ? buildWikipediaSearchUrl(query, locale) : buildExternalSearchUrl(query, engine as Exclude<SearchEngine, 'wikipedia'>);
}

/* ─────────────────────────── Known frame-blocking sites ─────────────────────────── */

/**
 * Base domains known to send `X-Frame-Options: DENY/SAMEORIGIN` or a
 * `frame-ancestors` CSP that excludes us. There is no reliable way to detect
 * this from the parent page (the iframe load is cross-origin, so its
 * response headers are invisible to us) — this is a maintained allow-list of
 * "don't even try", matched against the hostname and its subdomains
 * (`m.facebook.com` matches `facebook.com`; `notfacebook.com` does not).
 */
export const BLOCKED_DOMAINS: readonly string[] = [
  // Google properties (search results pages also block; Search is handled separately)
  'google.com',
  'youtube.com', // non-embed pages only — /embed/<id> and youtube-nocookie.com are exempt
  // Social / messaging
  'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com',
  'linkedin.com', 'whatsapp.com', 'reddit.com',
  // Dev / commerce / media
  'github.com', 'amazon.com', 'netflix.com',
  // Microsoft / Apple accounts
  'microsoft.com', 'live.com', 'outlook.com', 'apple.com',
  // AI assistants
  'chatgpt.com', 'openai.com', 'claude.ai', 'anthropic.com',
  // Banks / payment (representative examples — banking sites near-universally block framing)
  'paypal.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'hsbc.com',
];

/** Extra brand patterns that span many country TLDs (google.co.uk, google.de, …). */
const BLOCKED_PATTERNS: readonly RegExp[] = [
  /(^|\.)google\.[a-z.]{2,24}$/i,
  /(^|\.)amazon\.[a-z.]{2,24}$/i,
];

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** True if `url`'s host is a known frame-blocking site (or a subdomain of
 *  one). youtube-nocookie.com embeds are always exempt. */
export function isBlockedDomain(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) return false;
  if (BLOCKED_DOMAINS.some((d) => hostMatchesDomain(host, d))) return true;
  if (BLOCKED_PATTERNS.some((re) => re.test(host))) return true;
  return false;
}
