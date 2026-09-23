/**
 * Fai$al OS — app icon set (trusted, static SVG constants).
 *
 * One grammar for every icon: a 56×56 squircle tile (rx 14) inside a 64×64
 * canvas, a soft top sheen, a hairline rim, and a single glyph drawn from the
 * brand palette (midnight navy, gold, ivory). The rhombus "nuqta" from the
 * logo reappears as a detail where it makes sense.
 */

const XMLNS = 'xmlns="http://www.w3.org/2000/svg"';

export function tile(grad: [string, string], rim: string, body: string, defs = ''): string {
  return (
    `<svg ${XMLNS} viewBox="0 0 64 64">` +
    '<defs>' +
    `<linearGradient id="fiBg" x1="10" y1="4" x2="54" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${grad[0]}"/><stop offset="1" stop-color="${grad[1]}"/></linearGradient>` +
    '<linearGradient id="fiSheen" x1="0" y1="4" x2="0" y2="34" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
    defs +
    '</defs>' +
    '<rect x="4" y="4" width="56" height="56" rx="14" fill="url(#fiBg)"/>' +
    '<rect x="4" y="4" width="56" height="56" rx="14" fill="url(#fiSheen)"/>' +
    `<rect x="4.5" y="4.5" width="55" height="55" rx="13.5" fill="none" stroke="${rim}" stroke-opacity=".35"/>` +
    body +
    '</svg>'
  );
}

export const GOLD =
  '<linearGradient id="fiGold" x1="0" y1="18" x2="0" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#F6DB93"/><stop offset="1" stop-color="#D4A03A"/></linearGradient>';

/** Files — gold folder on royal navy. */
export const ICON_FILES = tile(
  ['#2C4686', '#12204A'],
  '#8FA6E0',
  '<path d="M15 22.5a3.5 3.5 0 0 1 3.5-3.5h8.2l3.6 3.6h15.2a3.5 3.5 0 0 1 3.5 3.5V29H15z" fill="#B8862B"/>' +
    '<rect x="15" y="26.5" width="34" height="21" rx="3.5" fill="url(#fiGold)"/>' +
    '<path d="M15 30h34" stroke="#fff" stroke-opacity=".35" stroke-width="1"/>' +
    '<path d="M32 33.6l2.6 2.6-2.6 2.6-2.6-2.6z" fill="#16264F" fill-opacity=".55"/>',
  GOLD,
);

/** Text Editor — ivory page, navy lines, gold caret. */
export const ICON_EDITOR = tile(
  ['#FFFBF1', '#E9DDBF'],
  '#B8862B',
  '<g stroke="#16264F" stroke-width="3.2" stroke-linecap="round">' +
    '<path d="M17 21h30"/><path d="M17 28.5h24"/><path d="M17 36h30"/><path d="M17 43.5h14"/>' +
    '</g>' +
    '<path d="M35.5 39.8v7.4" stroke="#C08F2F" stroke-width="3" stroke-linecap="round"/>',
);

/** Terminal — midnight console, gold prompt, ivory cursor. */
export const ICON_TERMINAL = tile(
  ['#1B2B5A', '#070E22'],
  '#E3B650',
  '<path d="M17 25l8 6.5-8 6.5" fill="none" stroke="url(#fiGold)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M29.5 40.5h14" stroke="#F7F1E3" stroke-width="3.6" stroke-linecap="round"/>' +
    '<circle cx="47.5" cy="16.5" r="2" fill="#E3B650" fill-opacity=".85"/>',
  GOLD,
);

/** Settings — navy gear on a gold tile. */
export const ICON_SETTINGS = tile(
  ['#F3D68A', '#C38F2C'],
  '#fff',
  '<path fill="#16264F" fill-rule="evenodd" d="M44.15 33.13L47.70 35.06L45.27 40.94L41.39 39.79A12.2 12.2 0 0 1 39.79 41.39L40.94 45.27L35.06 47.70L33.13 44.15A12.2 12.2 0 0 1 30.87 44.15L28.94 47.70L23.06 45.27L24.21 41.39A12.2 12.2 0 0 1 22.61 39.79L18.73 40.94L16.30 35.06L19.85 33.13A12.2 12.2 0 0 1 19.85 30.87L16.30 28.94L18.73 23.06L22.61 24.21A12.2 12.2 0 0 1 24.21 22.61L23.06 18.73L28.94 16.30L30.87 19.85A12.2 12.2 0 0 1 33.13 19.85L35.06 16.30L40.94 18.73L39.79 22.61A12.2 12.2 0 0 1 41.39 24.21L45.27 23.06L47.70 28.94L44.15 30.87A12.2 12.2 0 0 1 44.15 33.13Z M32 26.2A5.8 5.8 0 1 0 32 37.8A5.8 5.8 0 1 0 32 26.2Z"/>' +
    '<path d="M32 29.4l2.6 2.6-2.6 2.6-2.6-2.6z" fill="#E3B650"/>',
);
