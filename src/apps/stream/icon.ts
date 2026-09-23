import { tile, GOLD } from '../../brand/icons';

/**
 * Streamed browser — an ivory screen showing a gold play glyph, on the brand
 * navy tile, with two gold broadcast arcs coming off the top corner: the
 * screen the OS is showing is rendered somewhere else and streamed here.
 */
export const ICON_STREAM = tile(
  ['#22386F', '#0E1A3A'],
  '#8FA6E0',
  '<path d="M24 49.5h16" stroke="#E3B650" stroke-width="3.2" stroke-linecap="round"/>' +
    '<rect x="12.5" y="17.5" width="39" height="26" rx="3.6" fill="#F7F1E3"/>' +
    '<rect x="15.5" y="20.5" width="33" height="20" rx="2" fill="#16264F"/>' +
    '<path d="M28.6 25.9v9.2l8-4.6z" fill="url(#fiGold)"/>' +
    '<path d="M45.4 8.6a8.4 8.4 0 0 1 0 11.9" fill="none" stroke="#E3B650" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M51.2 5a15 15 0 0 1 0 19.1" fill="none" stroke="#E3B650" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/>' +
    '<circle cx="42.1" cy="14.3" r="2.1" fill="#E3B650"/>',
  GOLD,
);
