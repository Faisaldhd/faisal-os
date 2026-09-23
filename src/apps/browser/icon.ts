/**
 * Browser app icon — follows the shared grammar in src/brand/icons.ts
 * (56×56 squircle, top sheen, hairline rim, one glyph). Drawn locally
 * because src/brand is off-limits to this track; built only from the
 * exported `tile()` / `GOLD` helpers.
 *
 * A globe (meridians/parallels) with a compass needle across it, gold on
 * midnight navy — "a window onto the world, carefully aimed".
 */
import { tile, GOLD } from '../../brand/icons';

export const ICON_BROWSER = tile(
  ['#2C4686', '#12204A'],
  '#8FA6E0',
  '<circle cx="32" cy="31" r="15.5" fill="none" stroke="url(#fiGold)" stroke-width="2.6"/>' +
    '<ellipse cx="32" cy="31" rx="6.6" ry="15.5" fill="none" stroke="url(#fiGold)" stroke-width="2"/>' +
    '<path d="M16.5 31h31" stroke="url(#fiGold)" stroke-width="2"/>' +
    '<path d="M20 22.5c3.4 2 20.6 2 24 0M20 39.5c3.4-2 20.6-2 24 0" fill="none" stroke="url(#fiGold)" stroke-width="1.6" stroke-linecap="round"/>' +
    '<path d="M32 22l4.4 6.6L32 40l-4.4-11.4z" fill="#F7F1E3" fill-opacity=".92"/>' +
    '<path d="M32 22l4.4 6.6L32 31z" fill="#16264F" fill-opacity=".4"/>' +
    '<circle cx="32" cy="31" r="2.1" fill="#16264F"/>',
  GOLD,
);
