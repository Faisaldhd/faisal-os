/**
 * Brand-tile icons for the wired web apps.
 *
 * Same grammar as the rest of the app set (see src/brand/icons.ts): a 56×56
 * squircle on a 64×64 canvas, a top sheen, a hairline rim and one glyph. They
 * are plain static strings, so importing this module at boot costs nothing
 * beyond the strings themselves — the web app's *code* stays lazy.
 *
 * Each glyph is an interpretation of the site's mark rather than a copy of its
 * logo artwork, so the launcher never ships third-party brand assets.
 */
import { tile, GOLD } from '../../brand/icons';

/** Shared fallback glyph: a wireframe globe — "a window onto the web". */
export const ICON_WEB = tile(
  ['#2C4686', '#12204A'],
  '#8FA6E0',
  '<circle cx="32" cy="32" r="15" fill="none" stroke="url(#fiGold)" stroke-width="2.6"/>' +
    '<ellipse cx="32" cy="32" rx="6.4" ry="15" fill="none" stroke="url(#fiGold)" stroke-width="1.8"/>' +
    '<path d="M17 32h30" stroke="url(#fiGold)" stroke-width="2"/>' +
    '<path d="M20.5 24c3.6 1.9 19.4 1.9 23 0M20.5 40c3.6-1.9 19.4-1.9 23 0" fill="none" stroke="url(#fiGold)" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M32 24l2.6 5.4-2.6 2.6-2.6-2.6z" fill="#F7F1E3" fill-opacity=".9"/>',
  GOLD,
);

/** Google — a four-petal pinwheel in the brand's gold range on deep navy. */
export const ICON_WEB_GOOGLE = tile(
  ['#20356B', '#0B1530'],
  '#8FA6E0',
  '<path d="M30.5 17.5h3v13h-3z" fill="#F0CF7A"/>' +
    '<path d="M30.5 33.5h3v13h-3z" fill="#C9982F"/>' +
    '<path d="M17.5 30.5h13v3h-13z" fill="#E3B650"/>' +
    '<path d="M33.5 30.5h13v3h-13z" fill="#8F6412"/>' +
    '<circle cx="32" cy="32" r="5.2" fill="#F7F1E3" fill-opacity=".92"/>' +
    '<circle cx="32" cy="32" r="2.1" fill="#16264F"/>',
  GOLD,
);

/** YouTube — a gold rounded screen with a navy play triangle. */
export const ICON_WEB_YOUTUBE = tile(
  ['#2C4686', '#0E1A3A'],
  '#8FA6E0',
  '<rect x="15" y="21" width="34" height="22" rx="7" fill="url(#fiGold)"/>' +
    '<path d="M17.6 23.6h28.8" stroke="#fff" stroke-opacity=".38" stroke-width="2.2" stroke-linecap="round" fill="none"/>' +
    '<path d="M28.8 26.4l10.4 5.6-10.4 5.6z" fill="#16264F" fill-opacity=".88"/>',
  GOLD,
);

/** Wikipedia — an ivory page carrying a serif "W" and the brand nuqta below it. */
export const ICON_WEB_WIKIPEDIA = tile(
  ['#FFFBF1', '#E3D6B4'],
  '#B8862B',
  '<path d="M14.5 21.5h35" stroke="#16264F" stroke-opacity=".16" stroke-width="1.6"/>' +
    '<g stroke="#16264F" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
    '<path d="M18.5 25.5l5.2 16 5.3-11.5"/>' +
    '<path d="M29 30l5.3 11.5 5.2-16"/>' +
    '</g>' +
    '<g stroke="#B8862B" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
    '<path d="M39.7 25.5l3.9 16"/>' +
    '</g>' +
    '<path d="M32 46.2l2.4 2.4-2.4 2.4-2.4-2.4z" fill="#B8862B"/>',
  GOLD,
);
