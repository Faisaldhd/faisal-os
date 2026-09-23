/**
 * Store app icon — follows the shared grammar in src/brand/icons.ts
 * (56×56 squircle, top sheen, hairline rim, one glyph). Drawn locally
 * because src/brand is off-limits to this track; built only from the
 * exported `tile()` / `GOLD` helpers.
 */
import { tile, GOLD } from '../../brand/icons';

/** Store — gold shopping bag on royal navy, with the "nuqta" rhombus detail. */
export const ICON_STORE = tile(
  ['#2C4686', '#12204A'],
  '#8FA6E0',
  '<path d="M22 26c0-6 4.5-10 10-10s10 4 10 10" fill="none" stroke="url(#fiGold)" stroke-width="3.6" stroke-linecap="round"/>' +
    '<rect x="15.5" y="26" width="33" height="22" rx="5" fill="url(#fiGold)"/>' +
    '<path d="M15.5 33.2h33" stroke="#16264F" stroke-opacity=".18" stroke-width="1.4"/>' +
    '<path d="M32 34.4l2.6 2.6-2.6 2.6-2.6-2.6z" fill="#16264F" fill-opacity=".55"/>',
  GOLD,
);
