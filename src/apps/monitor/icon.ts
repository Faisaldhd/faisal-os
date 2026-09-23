import { tile, GOLD } from '../../brand/icons';

/** System Monitor — a gold activity/heartbeat line over a navy gauge. */
export const ICON_MONITOR = tile(
  ['#2C4686', '#12204A'],
  '#8FA6E0',
  '<circle cx="32" cy="32" r="16" fill="none" stroke="#8FA6E0" stroke-opacity=".45" stroke-width="2.4"/>' +
    '<path d="M18 33h6l3-8 5 15 4-11 3 4h7" fill="none" stroke="url(#fiGold)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="32" cy="16" r="2.4" fill="#E3B650"/>',
  GOLD,
);
