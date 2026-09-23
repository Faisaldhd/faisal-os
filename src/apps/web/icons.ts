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

/**
 * The remaining tiles below follow the same grammar (squircle, sheen, hairline
 * rim, one glyph). Like the four above, each glyph is an interpretation of what
 * the site *does* rather than a copy of its logo artwork — the launcher never
 * ships third-party brand assets, and three of these sites (Archive.org, Open
 * Library, Project Gutenberg) have no single mark we could verify anyway.
 */

/** Wiktionary — a dictionary page with an entry headword and its definition line. */
export const ICON_WEB_WIKTIONARY = tile(
  ['#2C4686', '#12204A'],
  '#8FA6E0',
  '<rect x="17" y="16" width="30" height="33" rx="3" fill="#F7F1E3" fill-opacity=".95"/>' +
    '<path d="M22.5 16v33" stroke="#B8862B" stroke-width="1.6"/>' +
    '<path d="M26.5 24.5h14M26.5 31.5h16M26.5 38.5h11" stroke="#16264F" stroke-opacity=".62" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M32 20.5l1.9 3.9-1.9 1.9-1.9-1.9z" fill="#B8862B"/>',
  GOLD,
);

/** Wikibooks — a shelf of spines with one volume leaning out. */
export const ICON_WEB_WIKIBOOKS = tile(
  ['#20356B', '#0B1530'],
  '#8FA6E0',
  '<rect x="16" y="22" width="6.4" height="24" rx="1.6" fill="#B8862B"/>' +
    '<rect x="24" y="18.5" width="6.4" height="27.5" rx="1.6" fill="url(#fiGold)"/>' +
    '<rect x="32" y="24" width="6.4" height="22" rx="1.6" fill="#E3B650"/>' +
    '<path d="M41.2 21.4l5.6 1.9-7.4 23.6-5.6-1.9z" fill="#F7F1E3" fill-opacity=".9"/>' +
    '<path d="M42.6 23l3.6 1.2" stroke="#16264F" stroke-opacity=".45" stroke-width="1.6"/>',
  GOLD,
);

/** Archive.org — a classical portico: the arch(ive) as a building. */
export const ICON_WEB_ARCHIVE = tile(
  ['#FFFBF1', '#E3D6B4'],
  '#B8862B',
  '<path d="M15 21.5l17-7 17 7z" fill="#B8862B"/>' +
    '<path d="M15 23.6h34" stroke="#16264F" stroke-opacity=".5" stroke-width="2.4"/>' +
    '<g fill="#16264F" fill-opacity=".82">' +
    '<rect x="19" y="27" width="4" height="14" rx="1.2"/>' +
    '<rect x="26" y="27" width="4" height="14" rx="1.2"/>' +
    '<rect x="34" y="27" width="4" height="14" rx="1.2"/>' +
    '<rect x="41" y="27" width="4" height="14" rx="1.2"/>' +
    '</g>' +
    '<path d="M16 42.4h32" stroke="#B8862B" stroke-width="3"/>' +
    '<path d="M32 25.6l1.8 1.8-1.8 1.8-1.8-1.8z" fill="#B8862B"/>',
  GOLD,
);

/** Open Library — an open book, one page lifting off the spine. */
export const ICON_WEB_OPENLIBRARY = tile(
  ['#2C4686', '#0E1A3A'],
  '#8FA6E0',
  '<path d="M17 21.5c5-2.4 10-2.4 15 .6 5-3 10-3 15-.6v22c-5-2.4-10-2.4-15 .6-5-3-10-3-15-.6z" fill="#F7F1E3" fill-opacity=".95"/>' +
    '<path d="M32 22.1v22" stroke="#16264F" stroke-opacity=".4" stroke-width="1.8"/>' +
    '<path d="M21.5 27h7M21.5 32h7M35.5 27h7M35.5 32h7" stroke="#B8862B" stroke-width="1.9" stroke-linecap="round"/>' +
    '<path d="M32 44.6l2.2 2.2-2.2 2.2-2.2-2.2z" fill="#E3B650"/>',
  GOLD,
);

/** Project Gutenberg — a printed page and a quill, the free-ebook press. */
export const ICON_WEB_GUTENBERG = tile(
  ['#FFFBF1', '#E9DDBF'],
  '#B8862B',
  '<rect x="17" y="16" width="24" height="32" rx="2.4" fill="#F7F1E3"/>' +
    '<rect x="17" y="16" width="24" height="32" rx="2.4" fill="none" stroke="#16264F" stroke-opacity=".22"/>' +
    '<path d="M21.5 24h15M21.5 29.5h15M21.5 35h10" stroke="#16264F" stroke-opacity=".5" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M40 45.5c2.4-6.6 6.4-11.4 10.4-14.2" stroke="#B8862B" stroke-width="2.6" stroke-linecap="round"/>' +
    '<path d="M47.6 27.4c1.4-1.2 3.2-1 4.4.4 1.2 1.4 1 3.2-.4 4.4z" fill="#E3B650"/>',
  GOLD,
);

/** OpenStreetMap — a folded map with a pin. Used for the map-embed products. */
export const ICON_WEB_MAP = tile(
  ['#20356B', '#0B1530'],
  '#8FA6E0',
  '<path d="M15 21.5l11-3.5 12 3.5 11-3.5v24.5l-11 3.5-12-3.5-11 3.5z" fill="#F7F1E3" fill-opacity=".92"/>' +
    '<path d="M26 18v24.5M38 21.5V46" stroke="#16264F" stroke-opacity=".3" stroke-width="1.6"/>' +
    '<path d="M32 24.5c-3.2 0-5.8 2.7-5.8 5.9 0 4.4 5.8 10.1 5.8 10.1s5.8-5.7 5.8-10.1c0-3.2-2.6-5.9-5.8-5.9z" fill="#B8862B"/>' +
    '<circle cx="32" cy="30.2" r="2.1" fill="#F7F1E3"/>',
  GOLD,
);

/** Vimeo — a film-screen tile with a play triangle (a video player product). */
export const ICON_WEB_VIMEO = tile(
  ['#1B2B5A', '#070E22'],
  '#8FA6E0',
  '<rect x="15" y="20" width="34" height="24" rx="6" fill="#F7F1E3" fill-opacity=".94"/>' +
    '<path d="M17.4 22.6h29.2" stroke="#16264F" stroke-opacity=".18" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M28.6 25.2l11 6.8-11 6.8z" fill="#B8862B"/>',
  GOLD,
);

/** Spotify — a broadcast mark: a disc with three signal arcs. */
export const ICON_WEB_SPOTIFY = tile(
  ['#20356B', '#0B1530'],
  '#8FA6E0',
  '<circle cx="32" cy="32" r="15" fill="#12224C"/>' +
    '<circle cx="32" cy="32" r="15" fill="none" stroke="#E3B650" stroke-opacity=".5" stroke-width="2"/>' +
    '<g stroke="url(#fiGold)" stroke-width="3.1" stroke-linecap="round" fill="none">' +
    '<path d="M22.5 26.5c6.6-1.8 13.6-1.2 19 1.8"/>' +
    '<path d="M23.8 32.4c5.4-1.4 11-.9 15.4 1.5"/>' +
    '<path d="M25.2 38c4.1-1 8.3-.6 11.6 1.1"/>' +
    '</g>' +
    '<path d="M32 15.5l1.9 1.9-1.9 1.9-1.9-1.9z" fill="#E3B650"/>',
  GOLD,
);

/** Radio Garden — a mast radiating a ring, for the live-radio globe. */
export const ICON_WEB_RADIO = tile(
  ['#1B2B5A', '#070E22'],
  '#E3B650',
  '<circle cx="32" cy="32" r="13" fill="none" stroke="#E3B650" stroke-opacity=".3" stroke-width="1.6"/>' +
    '<path d="M32 32V17.5M32 32l10.5-6" stroke="url(#fiGold)" stroke-width="3" stroke-linecap="round"/>' +
    '<circle cx="32" cy="32" r="3.4" fill="#F7F1E3"/>' +
    '<circle cx="45.5" cy="19.5" r="1.8" fill="#B8862B"/>' +
    '<circle cx="19.5" cy="43.5" r="1.8" fill="#B8862B"/>',
  GOLD,
);

/** Wikidata — a small linked graph: the item and its statements. */
export const ICON_WEB_WIKIDATA = tile(
  ['#20356B', '#0B1530'],
  '#8FA6E0',
  '<path d="M24 24.5L40 40M40 24.5L24 40M20 32h24" stroke="#E3B650" stroke-opacity=".55" stroke-width="1.8"/>' +
    '<circle cx="20" cy="32" r="4.6" fill="#F7F1E3"/>' +
    '<circle cx="24" cy="20.5" r="4" fill="#E3B650"/>' +
    '<circle cx="40" cy="43.5" r="4" fill="#C9982F"/>' +
    '<circle cx="42.5" cy="23.5" r="3.2" fill="#B8862B"/>' +
    '<circle cx="24" cy="41" r="3.2" fill="#B8862B"/>',
  GOLD,
);

/** Wikimedia Commons — a framed picture, for the shared media library. */
export const ICON_WEB_COMMONS = tile(
  ['#FFFBF1', '#E3D6B4'],
  '#B8862B',
  '<rect x="15" y="18" width="34" height="28" rx="3" fill="#16264F" fill-opacity=".88"/>' +
    '<path d="M18.5 41.5l8.5-10.5 6.5 7.5 5.5-6 8.5 9z" fill="#E3B650"/>' +
    '<circle cx="24" cy="25.5" r="3" fill="#F7F1E3"/>' +
    '<path d="M15 47.5h34" stroke="#B8862B" stroke-width="2.6" stroke-linecap="round"/>' +
    '<path d="M32 14.5l1.8 1.8-1.8 1.8-1.8-1.8z" fill="#B8862B"/>',
  GOLD,
);

/** Google Calendar — an ivory leaf with a bound edge and date dots. */
export const ICON_WEB_CALENDAR = tile(
  ['#FFFBF1', '#E3D6B4'],
  '#B8862B',
  '<rect x="16" y="18" width="32" height="29" rx="3.5" fill="#F7F1E3" stroke="#16264F" stroke-opacity=".2"/>' +
    '<path d="M16 24.5h32" stroke="#B8862B" stroke-width="3.4"/>' +
    '<path d="M23 15.5v5M41 15.5v5" stroke="#16264F" stroke-opacity=".6" stroke-width="2.6" stroke-linecap="round"/>' +
    '<g fill="#16264F" fill-opacity=".55">' +
    '<rect x="21.5" y="29" width="5.4" height="5.4" rx="1.4"/>' +
    '<rect x="29.3" y="29" width="5.4" height="5.4" rx="1.4"/>' +
    '<rect x="37.1" y="29" width="5.4" height="5.4" rx="1.4"/>' +
    '<rect x="21.5" y="36.4" width="5.4" height="5.4" rx="1.4"/>' +
    '<rect x="29.3" y="36.4" width="5.4" height="5.4" rx="1.4"/>' +
    '</g>' +
    '<rect x="37.1" y="36.4" width="5.4" height="5.4" rx="1.4" fill="#B8862B"/>',
  GOLD,
);

/**
 * The in-OS search app (a native window, never a frame): a spyglass over the
 * linked globe, so it reads as "search the wired web" next to ICON_WEB.
 */
export const ICON_WEB_SEARCH = tile(
  ['#2C4686', '#12204A'],
  '#8FA6E0',
  '<circle cx="29.5" cy="29.5" r="11" fill="none" stroke="url(#fiGold)" stroke-width="3.2"/>' +
    '<path d="M37.8 37.8l8.4 8.4" stroke="#F7F1E3" stroke-width="3.6" stroke-linecap="round"/>' +
    '<path d="M29.5 22.5l1.8 4.4 4.4 1.8-4.4 1.8-1.8 4.4-1.8-4.4-4.4-1.8 4.4-1.8z" fill="#E3B650" fill-opacity=".95"/>',
  GOLD,
);
