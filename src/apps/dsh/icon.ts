import { tile, GOLD } from '../../brand/icons';

/**
 * DeepSeek Harness — an ivory chat bubble with three gold prompt dots, on the
 * brand navy tile, with a small gold angle-bracket pair in the corner: the
 * harness is a chat/agent tool that the OS only *shows*, it does not run it.
 */
export const ICON_DSH = tile(
  ['#22386F', '#0E1A3A'],
  '#8FA6E0',
  '<path d="M16 22.5a4 4 0 0 1 4-4h24a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H28.6L20.4 46a1.6 1.6 0 0 1-2.4-1.4v-4.9a4 4 0 0 1-2-3.5z" fill="#F7F1E3"/>' +
    '<circle cx="24.5" cy="29.5" r="2.4" fill="#16264F"/>' +
    '<circle cx="32" cy="29.5" r="2.4" fill="#B8862B"/>' +
    '<circle cx="39.5" cy="29.5" r="2.4" fill="#16264F"/>' +
    '<path d="M25.5 52.5l4-3.5-4-3.5" fill="none" stroke="#E3B650" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M33.5 52.5h7" stroke="#E3B650" stroke-width="2.4" stroke-linecap="round" stroke-opacity=".7"/>',
  GOLD,
);
