/**
 * Pure decisions for a Web App window: what a typed address means, and what the
 * iframe's load/timeout events mean.
 *
 * Keeping both decisions out of the DOM is what makes the security-relevant
 * part testable: the URL policy is applied here (via the Browser's existing
 * src/apps/browser/url.ts — this module does NOT re-implement it) and the
 * load/timeout → ok/blocked mapping is a plain function.
 */
import {
  isAllowedFrameUrl,
  isBlockedDomain,
  looksLikeDomain,
  resolveAddressInput,
  rewriteYouTubeEmbed,
} from '../browser/url';
import type { WebAppDef } from './registry';
import { webAppId } from './registry';

/** Why a navigation was refused. Rendered as a translated message, never as raw English. */
export type RefusalCode = 'not-embeddable' | 'blocked-domain' | 'unsafe-scheme' | 'empty';

export interface NavigationPlan {
  /** The URL to assign to the iframe, or null when the input must be refused. */
  embedUrl: string | null;
  /** What the user actually navigated to (shown in the address field). */
  displayUrl: string | null;
  /** Set when `embedUrl` differs from `displayUrl` because of a smart rewrite. */
  rewrittenFrom: string | null;
  /** Set when the input was not a URL and was turned into a Wikipedia search. */
  searchFor: string | null;
  refusal: RefusalCode | null;
}

/** Convenience constructor so callers never build a half-filled plan. */
function refuse(refusal: RefusalCode): NavigationPlan {
  return { embedUrl: null, displayUrl: null, rewrittenFrom: null, searchFor: null, refusal };
}

/** True when `raw` starts with an explicit URI scheme (`javascript:`, `https:`, …). */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Everything a Web App window may do with an address-bar string.
 *
 * The policy for a non-http(s) scheme is decided ONCE, here, and it is the same
 * rule the shared resolver already applies: `resolveAddressInput` refuses to
 * treat `javascript:` / `data:` / `vbscript:` / `blob:` / `file:` / `about:` as a
 * URL. This app goes one step further than the Browser and shows an explicit
 * in-window refusal instead of silently searching for the string, because a
 * pasted scheme is almost always a mistake or an attack attempt, not a query.
 * Either way the scheme is NEVER assigned to the frame.
 *
 *  - `google.com`            → https://google.com  (resolveAddressInput)
 *  - `http://…`              → upgraded to https
 *  - any other explicit scheme → refusal 'unsafe-scheme' (never navigated to)
 *  - the OS's own origin / a non-https URL → refusal 'not-embeddable'
 *  - a known frame-refusing host → refusal 'blocked-domain', EXCEPT when the
 *    shared rewriter can turn it into its embeddable form (youtube → /embed/)
 *  - plain words → a Wikipedia search inside the frame; Wikipedia is the only
 *    engine in IN_FRAME_ENGINES that permits framing, and the brief forbids
 *    proxying or bypassing anyone else's refusal. Other engines would have to
 *    be opened externally, which the external-open button already offers.
 */
export function planNavigation(raw: string, locale: 'ar' | 'en', selfOrigin?: string): NavigationPlan {
  const trimmed = raw.trim();
  if (!trimmed) return refuse('empty');

  const scheme = SCHEME_RE.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'https' && scheme !== 'http') {
    return { ...refuse('unsafe-scheme'), displayUrl: trimmed };
  }

  const resolved = resolveAddressInput(trimmed);
  if (resolved.kind === 'search') {
    const query = resolved.query.trim();
    if (!query) return refuse('empty');
    // Plain words (no dot, no scheme) become an in-frame Wikipedia search.
    // A real-looking URL we refused to frame falls through to blocked-domain.
    if (looksLikeDomain(query)) {
      return { ...refuse('blocked-domain'), displayUrl: query };
    }
    const embedUrl = `https://${locale === 'ar' ? 'ar' : 'en'}.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
    return { embedUrl, displayUrl: embedUrl, rewrittenFrom: null, searchFor: query, refusal: null };
  }

  const displayUrl = resolved.url;
  if (!isAllowedFrameUrl(displayUrl, selfOrigin)) {
    return { ...refuse('not-embeddable'), displayUrl };
  }

  // Smart rewrite first: it is the only thing that can rescue a blocked host.
  const rewritten = rewriteYouTubeEmbed(displayUrl);
  if (rewritten && isAllowedFrameUrl(rewritten, selfOrigin)) {
    return { embedUrl: rewritten, displayUrl, rewrittenFrom: displayUrl, searchFor: null, refusal: null };
  }

  if (isBlockedDomain(displayUrl)) {
    return { ...refuse('blocked-domain'), displayUrl };
  }

  return { embedUrl: displayUrl, displayUrl, rewrittenFrom: null, searchFor: null, refusal: null };
}

/* ───────────────────── deciding what the registry told us ───────────────────── */

/** The frame's observable state: nothing has happened yet, it loaded, or it timed out. */
export type LoadSignal = 'pending' | 'loaded' | 'timed-out';

export type ViewState =
  /** Render the iframe; the site is believed to embed (or the user overrode the note). */
  | { kind: 'frame' }
  /** Render the respectful fallback panel with "Open externally". */
  | { kind: 'blocked-fallback' }
  /** Render the in-window refusal message; no iframe at all. */
  | { kind: 'refused' };

/**
 * Who decided that the frame should be attempted.
 *  'registry' — the def has no evidence against it (or says 'allowed').
 *  'user'     — the user pressed "Try embedding anyway" on a site the registry
 *               recorded as blocked. `embedNote` is measured data that can go
 *               stale, so it warns and offers the external route up front, but
 *               it must never be a permanent hard block.
 */
export type EmbedAttempt = 'registry' | 'user';

/** Everything the decision needs: what was planned, what the def says, what we saw. */
export interface OutcomeInput {
  refusal: RefusalCode | null;
  embedNote?: WebAppDef['embedNote'];
  signal: LoadSignal;
  /** Omitted means 'registry'. */
  attempt?: EmbedAttempt;
}

/**
 * A refusal that the user is allowed to override.
 *
 * `planNavigation` refuses a known frame-blocking host with 'blocked-domain',
 * and the registry independently records exactly that host as `embedNote:
 * 'blocked'`. They are the same measured fact and both are overridable — the
 * fallback card explains it, offers the external tab and still lets the user
 * spend one attempt. Every other refusal code is hard.
 */
function overridableRefusal(
  refusal: RefusalCode | null,
  embedNote?: WebAppDef['embedNote'],
  attempt?: EmbedAttempt,
): boolean {
  if (attempt === 'user') return false;
  return embedNote === 'blocked' || refusal === 'blocked-domain';
}

/** The refusal that still stands after the user's override is taken into account. */
function effectiveRefusal(
  refusal: RefusalCode | null,
  embedNote?: WebAppDef['embedNote'],
  attempt?: EmbedAttempt,
): RefusalCode | null {
  // A blocked-domain refusal the user overrode is no longer a refusal at all:
  // the frame is attempted exactly as it would be for any other site.
  if (refusal === 'blocked-domain' && attempt === 'user') return null;
  return refusal;
}

/**
 * The whole load/blocked decision, as one pure table:
 *
 *   an overridable block, not overridden → blocked-fallback immediately: no
 *                                          iframe and no timeout wait
 *   any hard refusal (unsafe scheme,
 *   not embeddable, empty, an unwired
 *   blocked host)                        → refused (nothing is framed)
 *   an overridable block, user overrode  → frame, then the ordinary flow
 *                                          (loading → load, or silence → fallback)
 *   load event observed                  → frame ('ok')
 *   no load within the limit             → blocked-fallback (timed out)
 *   still waiting                        → frame with the loading indicator
 *
 * `load` is deliberately not treated as proof that the site embedded: a frame
 * that is refused by X-Frame-Options still fires `load` (the browser paints its
 * own error page into it), which is exactly why the registry carries
 * `embedNote` and why the silence timeout exists.
 */
export function decideOutcome(input: OutcomeInput): ViewState {
  if (overridableRefusal(input.refusal, input.embedNote, input.attempt)) return { kind: 'blocked-fallback' };
  if (effectiveRefusal(input.refusal, input.embedNote, input.attempt)) return { kind: 'refused' };
  if (input.signal === 'timed-out') return { kind: 'blocked-fallback' };
  if (input.signal === 'loaded') return { kind: 'frame' };
  // pending, and the frame is allowed to be attempted: show it behind a spinner,
  // because a slow real site must not be replaced by a failure panel.
  return { kind: 'frame' };
}

/** True while the spinner should be visible. */
export function isLoading(input: OutcomeInput): boolean {
  if (overridableRefusal(input.refusal, input.embedNote, input.attempt)) return false;
  if (effectiveRefusal(input.refusal, input.embedNote, input.attempt)) return false;
  return input.signal === 'pending';
}

/** True when the user should be offered "Open externally" right now. */
export function offersExternal(input: OutcomeInput): boolean {
  if (overridableRefusal(input.refusal, input.embedNote, input.attempt)) return true;
  return input.signal !== 'loaded';
}

/** Stable key for the refusal copy table (kept out of the DOM for testing). */
export function refusalMessageKey(code: RefusalCode): string {
  return `web.refused.${code}`;
}

/** Diagnostics label, never shown to the user. */
export function debugLabel(def: WebAppDef): string {
  return webAppId(def);
}
