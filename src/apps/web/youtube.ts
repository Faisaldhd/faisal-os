/**
 * Fai$al OS — the YouTube player web app.
 *
 * YouTube's home page, a channel page and a watch page all send
 * `X-Frame-Options: SAMEORIGIN` and cannot be framed. YouTube's OWN supported
 * framing endpoint — `/embed/<id>` — can, and that is the one thing this app
 * frames. Measured 2026-09-23:
 *   https://www.youtube.com/embed/dQw4w9WgXcQ  200, no XFO, no frame-ancestors
 *   https://www.youtube-nocookie.com/embed/…   200, no XFO, no frame-ancestors
 *
 * The address field accepts a full YouTube link OR a bare video id, and both go
 * through the SAME rewriter the Browser app already uses
 * (`rewriteYouTubeEmbed` in src/apps/browser/url.ts) — there is deliberately no
 * second parser here. Anything that is not a video (the home page, a channel, a
 * playlist of a channel, a search) gets '' so the shared window shows its honest
 * fallback card with "open in browser"; no workaround is invented for it.
 */
import { rewriteYouTubeEmbed } from '../browser/url';
import { ICON_WEB_YOUTUBE } from './icons';
import type { WebAppDef } from './registry';

/**
 * Pure: whatever the user typed → the URL to plan a navigation for.
 *
 *  - a bare id (`dQw4w9WgXcQ`) → `https://www.youtube.com/watch?v=<id>`
 *  - a watch / shorts / live / youtu.be / already-embedded link → that link,
 *    unchanged; the shared planner's rewrite step turns it into the embed form
 *    (so the user still sees the real link in the address field, which is why
 *    this does not pre-rewrite it)
 *  - anything else (a channel, the home page, plain words) → `''`, the marker
 *    for "this app has no video to play here"
 *
 * Taking an id (or a URL) and returning a URL is a total function, so it is
 * unit-tested directly — see youtube.test.ts.
 */
export function youtubePlayerInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Not URL-shaped at all: the only thing it can be is a bare video id, and the
  // shared rewriter is the single authority on what id is well-formed.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.includes('/') && !trimmed.includes('.')) {
    return rewriteYouTubeEmbed(`https://www.youtube.com/watch?v=${trimmed}`) ? trimmed : '';
  }

  // A link, a `youtube.com`-shaped word, or something with a dot in it: plan it as
  // an ordinary address and let the shared URL policy decide.
  const asUrl = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;
  try {
    new URL(asUrl);
  } catch {
    return '';
  }
  // A URL now, but still possibly not a video: the home page, a channel, a search.
  // Only a link the shared rewriter can resolve to an id counts as playable, so
  // "youtube.com/@someChannel" honestly reports that it has nothing to play
  // instead of framing a page that never agreed to be framed.
  return rewriteYouTubeEmbed(asUrl) ? asUrl : '';
}

/**
 * The player is a `kind: 'player'` def rather than a `kind: 'frame'` def: it
 * frames the site like any other web app, but the shared window applies
 * `transformUrl` (above) to whatever is typed, and shows a `<video>`-shaped
 * loading treatment instead of the plain site spinner.
 */
export const YOUTUBE_PLAYER: WebAppDef = {
  id: 'youtube-player',
  kind: 'player',
  title: { ar: 'مشغّل يوتيوب', en: 'YouTube Player' },
  // The home URL is the embed of a video everyone can play, so the app is useful
  // the moment it is opened rather than showing an error first.
  url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  icon: ICON_WEB_YOUTUBE,
  description: {
    ar: 'شغّل أي فيديو من يوتيوب داخل نافذة النظام — الصق رابطاً كاملاً أو معرّف الفيديو، ويُحوَّل تلقائياً إلى صيغة /embed/ الرسمية',
    en: 'Play any YouTube video inside an OS window — paste a full link or just the video id and it is rewritten to the official /embed/ form',
  },
  embedNote: 'allowed',
  transformUrl: youtubePlayerInput,
};
