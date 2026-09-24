/**
 * Fai$al OS — brand marks (trusted, static SVG constants).
 *
 * Everything here is original geometry: a monoline "$" built from two stacked
 * circles and a vertical stroke, crowned by a rhombus dot (the calligrapher's
 * nuqta), plus matching Latin ("Fai$al") and square-Kufi-inspired Arabic
 * ("فيصل") wordmarks drawn as stroked paths so no web font is needed.
 *
 * Classes inside the SVGs let the shell recolour parts per theme:
 *   .fb-gold-s / .fb-gold-f → gold details (the "$" stroke, the dots' fill)
 *   .fb-ink   → wordmark letters (use currentColor by default)
 * Gradient ids are made unique per instance by shell/icon.ts renderIcon().
 */

export const BRAND = {
  name: 'Fai$al',
  nameAr: 'فيصل',
  product: 'Fai$al OS',
  version: '0.3',
  colors: {
    midnight: '#0B1530',
    ink: '#0E1A3A',
    navy: '#16264F',
    royal: '#22386F',
    gold: '#E3B650',
    goldLight: '#F0CF7A',
    goldDeep: '#B8862B',
    antique: '#8F6412',
    ivory: '#F7F1E3',
  },
} as const;

const XMLNS = 'xmlns="http://www.w3.org/2000/svg"';

/* The glyph: S (two circles r=8), the bar, and the nuqta. 64×64 space. */
const GLYPH_S = 'M38.55 21.91A8 8 0 1 0 32 34.5A8 8 0 1 1 25.45 47.09';
const GLYPH_BAR = 'M32 16.2V55.6';
const GLYPH_DOT = 'M32 5.6L35.4 9L32 12.4L28.6 9Z';

function glyph(paint: string, sw = 5.4, bw = 3): string {
  return (
    `<path d="${GLYPH_BAR}" fill="none" stroke="${paint}" stroke-width="${bw}"/>` +
    `<path d="${GLYPH_S}" fill="none" stroke="${paint}" stroke-width="${sw}" stroke-linecap="butt"/>` +
    `<path d="${GLYPH_DOT}" fill="${paint}"/>`
  );
}

const GOLD_GRAD =
  '<linearGradient id="fbGold" x1="0" y1="6" x2="0" y2="56" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0" stop-color="#F6DB93"/><stop offset=".55" stop-color="#E3B650"/><stop offset="1" stop-color="#C08F2F"/></linearGradient>';
const NAVY_GRAD =
  '<linearGradient id="fbNavy" x1="8" y1="2" x2="56" y2="62" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0" stop-color="#26407D"/><stop offset=".5" stop-color="#16264F"/><stop offset="1" stop-color="#0B1530"/></linearGradient>';
const SHEEN =
  '<linearGradient id="fbSheen" x1="0" y1="2" x2="0" y2="34" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>';

/** Full-colour app mark: navy squircle, gold glyph, hairline gold rim. 16–512 px. */
export const MARK_SVG =
  `<svg ${XMLNS} viewBox="0 0 64 64" role="img" aria-label="Fai$al">` +
  `<defs>${NAVY_GRAD}${GOLD_GRAD}${SHEEN}</defs>` +
  '<rect x="2" y="2" width="60" height="60" rx="16" fill="url(#fbNavy)"/>' +
  '<rect x="2" y="2" width="60" height="60" rx="16" fill="url(#fbSheen)"/>' +
  '<rect x="3" y="3" width="58" height="58" rx="15" fill="none" stroke="#F0CF7A" stroke-opacity=".32" stroke-width=".9"/>' +
  `<g transform="translate(32 32.4) scale(.86) translate(-32 -30.6)">${glyph('url(#fbGold)')}</g>` +
  '</svg>';

/** Glyph only, single colour (currentColor) — top bar, small UI. */
export const MARK_GLYPH_SVG =
  `<svg ${XMLNS} viewBox="4 3 56 56" aria-hidden="true">${glyph('currentColor', 6, 3.4)}</svg>`;

/** Glyph only, gold gradient — for dark backgrounds (splash, top bar). */
export const MARK_GLYPH_GOLD_SVG =
  `<svg ${XMLNS} viewBox="4 3 56 56" aria-hidden="true"><defs>${GOLD_GRAD}</defs>${glyph('url(#fbGold)', 5.8, 3.2)}</svg>`;

/* ───────────── Wordmarks: monoline, stroke 6.4, x-height 32, baseline 58 ───────────── */

const W = 6.4;

/** "Fai$al" — letters use currentColor, the "$" and the i-dot use gold. */
export const WORDMARK_LATIN_SVG =
  `<svg ${XMLNS} viewBox="-2 0 156 68" role="img" aria-label="Fai$al">` +
  `<g fill="none" stroke="currentColor" stroke-width="${W}" class="fb-ink">` +
  // F
  '<path d="M3.2 58V14H25" stroke-linejoin="miter"/><path d="M3.2 35.2H21"/>' +
  // a
  '<circle cx="44.5" cy="45" r="10.3"/><path d="M54.8 32V58"/>' +
  // i
  '<path d="M68.2 32V58"/>' +
  // a
  '<circle cx="123.5" cy="45" r="10.3"/><path d="M133.8 32V58"/>' +
  // l
  '<path d="M147.2 8V58"/>' +
  '</g>' +
  '<g class="fb-gold-s" fill="none" stroke="#D9A94A">' +
  // $ — elliptical S + bar
  `<path d="M99.51 18.5A9.6 10.6 0 1 0 91.2 34.4A9.6 10.6 0 1 1 82.89 50.3" stroke-width="${W}"/>` +
  '<path d="M91.2 4.5V64" stroke-width="3.4"/>' +
  '</g>' +
  // i-dot as nuqta
  '<path class="fb-gold-f" d="M68.2 17.4L72.4 21.6L68.2 25.8L64 21.6Z" fill="#D9A94A"/>' +
  '</svg>';

/**
 * "فيصل" — geometric Kufi-style monoline, same stroke and x-height as the Latin.
 * Right to left: ف (loop + dot) · ي (tooth + two dots) · ص (stadium + tooth) · ل (tall stem + bowl).
 */
export const WORDMARK_ARABIC_SVG =
  `<svg ${XMLNS} viewBox="16 0 138 76" role="img" aria-label="فيصل">` +
  `<g fill="none" stroke="currentColor" stroke-width="${W}" class="fb-ink" stroke-linejoin="round">` +
  // baseline from fa to lam, then lam bowl + terminal
  '<path d="M140 54.8H46"/>' +
  '<path d="M46 10.8V54.8A12 12 0 0 1 22 54.8V43"/>' +
  // fa loop (tangent to the baseline)
  '<circle cx="140" cy="46.3" r="8.5"/>' +
  // ya tooth
  '<path d="M118 54.8V33"/>' +
  // sad loop + its denticle
  '<path d="M82 54.8A8 8 0 0 1 82 38.8H96A8 8 0 0 1 96 54.8"/>' +
  '<path d="M66 54.8V41"/>' +
  '</g>' +
  '<g class="fb-gold-f" fill="#D9A94A">' +
  '<path d="M140 17.6L144.2 21.8L140 26L135.8 21.8Z"/>' +
  '<path d="M113 62.6L117.2 66.8L113 71L108.8 66.8Z"/>' +
  '<path d="M123 62.6L127.2 66.8L123 71L118.8 66.8Z"/>' +
  '</g>' +
  '</svg>';

/**
 * Favicon: the mark with heavier strokes so it survives 16 px. URL-encoded for a data: URI.
 * (Kept in sync by hand with the `<link rel="icon">` in index.html.)
 */
export const FAVICON_SVG =
  `<svg ${XMLNS} viewBox="0 0 64 64">` +
  '<rect x="2" y="2" width="60" height="60" rx="16" fill="#16264F"/>' +
  `<g transform="translate(32 32.4) scale(.9) translate(-32 -30.6)">${glyph('#E3B650', 7.2, 4.2)}</g>` +
  '</svg>';
