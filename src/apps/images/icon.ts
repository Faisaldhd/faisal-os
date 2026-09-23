import { tile, GOLD } from '../../brand/icons';

/** Image Viewer — a gold mountain/sun photograph on navy, matching the Fai$al OS icon grammar. */
export const ICON_IMAGES = tile(
  ['#1B2B5A', '#0E1A3A'],
  '#8FA6E0',
  '<rect x="14" y="16" width="36" height="30" rx="4" fill="#0E1A3A" stroke="url(#fiGold)" stroke-width="2"/>' +
    '<circle cx="24" cy="25" r="4" fill="url(#fiGold)"/>' +
    '<path d="M17 42l10-11 7 7 6-8 10 12z" fill="#22386F"/>' +
    '<path d="M17 42l10-11 7 7 6-8 10 12" fill="none" stroke="#F0CF7A" stroke-width="1.4" stroke-linejoin="round" stroke-opacity=".7"/>',
  GOLD,
);
