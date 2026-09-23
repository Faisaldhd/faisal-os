import { tile, GOLD } from '../../brand/icons';

/** Clock — ivory dial on navy tile, gold hands and hour ticks. */
export const ICON_CLOCK = tile(
  ['#22386F', '#0E1A3A'],
  '#8FA6E0',
  '<circle cx="32" cy="32" r="18.5" fill="#F7F1E3"/>' +
    '<circle cx="32" cy="32" r="18.5" fill="none" stroke="#16264F" stroke-opacity=".25" stroke-width="1.4"/>' +
    '<g stroke="#16264F" stroke-opacity=".45" stroke-width="1.6" stroke-linecap="round">' +
    '<path d="M32 16.5v3"/><path d="M32 44.5v3"/><path d="M16.5 32h3"/><path d="M44.5 32h3"/>' +
    '</g>' +
    '<path d="M32 32V20.5" stroke="#16264F" stroke-width="2.6" stroke-linecap="round"/>' +
    '<path d="M32 32l8 5.5" stroke="url(#fiGold)" stroke-width="2.6" stroke-linecap="round"/>' +
    '<circle cx="32" cy="32" r="2.2" fill="#B8862B"/>',
  GOLD,
);
