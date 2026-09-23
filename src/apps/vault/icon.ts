import { tile, GOLD } from '../../brand/icons';

/** Vault — navy safe door, gold dial, ivory keyhole. */
export const ICON_VAULT = tile(
  ['#2C4686', '#0E1A3A'],
  '#8FA6E0',
  '<rect x="15" y="15" width="34" height="34" rx="5" fill="url(#fiGold)"/>' +
    '<rect x="19.5" y="19.5" width="25" height="25" rx="3.5" fill="#16264F" fill-opacity=".82"/>' +
    '<circle cx="32" cy="32" r="8.4" fill="none" stroke="#F6DB93" stroke-width="2.6"/>' +
    '<path d="M32 27.6v4.2M32 32l3.4 5.2" fill="none" stroke="#F7F1E3" stroke-width="2.4" stroke-linecap="round"/>' +
    '<circle cx="42.5" cy="21.5" r="1.7" fill="#16264F" fill-opacity=".65"/>',
  GOLD,
);
