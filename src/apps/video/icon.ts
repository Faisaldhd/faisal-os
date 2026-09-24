import { tile, GOLD } from '../../brand/icons';

/**
 * Video Studio — a midnight-navy tile with a gold play triangle over a film strip
 * and a gold cut line: the same icon grammar as the rest of the OS (56×56 squircle,
 * brand palette, hairline rim).
 */
export const ICON_VIDEO = tile(
  ['#1B2B5A', '#0E1A3A'],
  '#8FA6E0',
  '<rect x="15" y="19" width="34" height="26" rx="4" fill="#0B1430" stroke="url(#fiGold)" stroke-width="2"/>' +
    '<path d="M15 25.5h-3.5M15 32h-3.5M15 38.5h-3.5M49 25.5h3.5M49 32h3.5M49 38.5h3.5" stroke="#8FA6E0" stroke-width="2" stroke-linecap="round" stroke-opacity=".7"/>' +
    '<path d="M27.5 27.5l9.5 5.5-9.5 5.5z" fill="url(#fiGold)"/>' +
    '<path d="M38 21v22" stroke="#F7F1E3" stroke-width="2" stroke-linecap="round" stroke-opacity=".85"/>',
  GOLD,
);
