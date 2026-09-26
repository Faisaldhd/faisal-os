/**
 * Impress — design themes and the slide size (التصميم وحجم الشريحة).
 *
 * A theme is what PowerPoint keeps in two places, and both are written: the theme part holds the
 * colour scheme (text, background, six accents, links) and the heading/body fonts; the slide
 * master holds the background and the colour of the title and body text. Applying a theme is one
 * undoable edit of the deck, and every slide that inherits from the master changes at once.
 *
 * Everything here is pure: the canvas, the save and the tests all read the same data.
 */
import { type Deck, type DeckBox, type DeckMaster, type DeckShape } from './deck';
import { xmlText } from '../xml';

/** The twelve colours of a theme's `<a:clrScheme>`, in schema order. */
export const SCHEME_KEYS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'] as const;
export type SchemeKey = typeof SCHEME_KEYS[number];

export interface DeckTheme {
  id: string;
  /** The names shown in the gallery. */
  ar: string;
  en: string;
  /** #RRGGBB for every scheme slot. `dk1` is the body text colour and `lt1` the background. */
  colors: Record<SchemeKey, string>;
  /** Heading (major) and body (minor) Latin typefaces. */
  major: string;
  minor: string;
  /** The master's background and text colours. */
  bg: string;
  title: string;
  body: string;
}

/** The fonts a theme part names, when the file has them. */
export interface DeckFonts { major: string; minor: string }

const scheme = (c: [string, string, string, string, string, string, string, string, string, string, string, string]): Record<SchemeKey, string> =>
  Object.fromEntries(SCHEME_KEYS.map((k, i) => [k, c[i]])) as Record<SchemeKey, string>;

/**
 * The eight designs the Design tab offers. Each one is legible in both languages (the fonts all
 * carry Arabic on Windows, macOS and phones), and each has a light-on-dark or dark-on-light text
 * colour that passes 4.5:1 on its own background.
 */
export const THEMES: readonly DeckTheme[] = [
  {
    id: 'copper', ar: 'نحاسي', en: 'Copper', major: 'Segoe UI Semibold', minor: 'Segoe UI',
    bg: '#FBF7F1', title: '#7A4515', body: '#3A3129',
    colors: scheme(['#3A3129', '#FBF7F1', '#7A4515', '#F1E6D6', '#C8894B', '#5B8DEF', '#3DA37A', '#E0A96D', '#7A5CC4', '#D9534F', '#2F6FD6', '#8A5A9E']),
  },
  {
    id: 'midnight', ar: 'منتصف الليل', en: 'Midnight', major: 'Segoe UI Semibold', minor: 'Segoe UI',
    bg: '#0F1B33', title: '#F5F7FB', body: '#C9D3E6',
    colors: scheme(['#C9D3E6', '#0F1B33', '#F5F7FB', '#1C2B4A', '#E0A96D', '#5B8DEF', '#3DD68C', '#F2C14E', '#B08CFF', '#FF7A7A', '#8FB4FF', '#C8A2FF']),
  },
  {
    id: 'office', ar: 'كلاسيكي', en: 'Classic', major: 'Calibri Light', minor: 'Calibri',
    bg: '#FFFFFF', title: '#1F2937', body: '#374151',
    colors: scheme(['#374151', '#FFFFFF', '#1F2937', '#E7E6E6', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#0563C1', '#954F72']),
  },
  {
    id: 'ocean', ar: 'محيط', en: 'Ocean', major: 'Tahoma', minor: 'Tahoma',
    bg: '#EAF4FB', title: '#0B4F79', body: '#1E3A4C',
    colors: scheme(['#1E3A4C', '#EAF4FB', '#0B4F79', '#D3E8F5', '#1480C4', '#17A2A2', '#F28C28', '#5A6ACF', '#2BB673', '#E4572E', '#0B6EB4', '#6C4F99']),
  },
  {
    id: 'forest', ar: 'غابة', en: 'Forest', major: 'Georgia', minor: 'Verdana',
    bg: '#F1F6EF', title: '#24502F', body: '#2E3B2F',
    colors: scheme(['#2E3B2F', '#F1F6EF', '#24502F', '#DCE9D6', '#3E8E4F', '#A3B83A', '#C98A3A', '#4F7CAC', '#8C6D46', '#C0504D', '#2E7D4F', '#6B5B95']),
  },
  {
    id: 'slate', ar: 'أردوازي', en: 'Slate', major: 'Arial', minor: 'Arial',
    bg: '#1F2328', title: '#FFFFFF', body: '#D0D7DE',
    colors: scheme(['#D0D7DE', '#1F2328', '#FFFFFF', '#2D333B', '#3DD68C', '#5B8DEF', '#F2C14E', '#FF7A7A', '#B08CFF', '#56D4DD', '#79B8FF', '#D2A8FF']),
  },
  {
    id: 'sunset', ar: 'غروب', en: 'Sunset', major: 'Trebuchet MS', minor: 'Trebuchet MS',
    bg: '#FFF4EC', title: '#A1303D', body: '#4A2C2A',
    colors: scheme(['#4A2C2A', '#FFF4EC', '#A1303D', '#FBE1D1', '#E4572E', '#F3A712', '#A1303D', '#29335C', '#669BBC', '#8F2D56', '#C0392B', '#8E44AD']),
  },
  {
    id: 'royal', ar: 'ملكي', en: 'Royal', major: 'Times New Roman', minor: 'Arial',
    bg: '#F4F1FA', title: '#4B2A86', body: '#2F2447',
    colors: scheme(['#2F2447', '#F4F1FA', '#4B2A86', '#E4DCF3', '#6A3FB5', '#C8894B', '#2E86AB', '#D1495B', '#3DA37A', '#EDAE49', '#5B3FB5', '#8E5A9E']),
  },
];

export const DEFAULT_THEME: DeckTheme = THEMES[0]!;

export function themeById(id: string | null | undefined): DeckTheme | null {
  return THEMES.find((t) => t.id === id) ?? null;
}

/** The theme a deck is showing, when its colours and fonts are exactly one of ours. */
export function currentTheme(deck: Deck): DeckTheme | null {
  return THEMES.find((t) =>
    SCHEME_KEYS.every((k) => (deck.scheme[k] ?? '').toUpperCase() === t.colors[k].toUpperCase())
    && (!deck.fonts || (deck.fonts.major === t.major && deck.fonts.minor === t.minor))) ?? null;
}

/**
 * The deck in this design: the theme's colours and fonts, and every master's background and text
 * colours. A master's font is cleared so its text follows the theme's fonts (what `+mj-lt` and
 * `+mn-lt` mean in the file); its sizes, footer and slide number are left alone. A slide with a
 * background of its own keeps it; one that inherits (from its layout or its master) repaints.
 */
export function applyTheme(deck: Deck, theme: DeckTheme): Deck {
  const masters: DeckMaster[] = deck.masters.map((m) => ({
    ...m,
    bg: theme.bg,
    title: { ...m.title, font: null, color: theme.title },
    body: { ...m.body, font: null, color: theme.body },
  }));
  const slides = deck.slides.map((s) => {
    if (s.bgOwn) return s;
    // A layout that overrides the master's background is given the same colour in the file
    // (`layoutBgEdits`), so the model says so too.
    return { ...s, bg: theme.bg, bgLayout: s.bgLayout ? theme.bg : null };
  });
  return { ...deck, scheme: { ...deck.scheme, ...theme.colors }, fonts: { major: theme.major, minor: theme.minor }, masters, slides };
}

/* ───────────────────────────────── slide size ───────────────────────────────── */

export type SlideSizeKind = 'wide' | 'standard';
export const SLIDE_SIZES: Record<SlideSizeKind, { cx: number; cy: number }> = {
  wide: { cx: 12192000, cy: 6858000 },
  standard: { cx: 9144000, cy: 6858000 },
};

export function slideSizeOf(deck: Deck): SlideSizeKind | null {
  for (const k of Object.keys(SLIDE_SIZES) as SlideSizeKind[]) {
    if (SLIDE_SIZES[k].cx === deck.cx && SLIDE_SIZES[k].cy === deck.cy) return k;
  }
  return null;
}

/**
 * A new slide size, with everything on the slides scaled into it (PowerPoint's "Scale" choice).
 * A locked shape (one this editor cannot write) is left where it is, because the save could not
 * move it either; the master's footer and number boxes are scaled with the slides.
 */
export function setSlideSize(deck: Deck, cx: number, cy: number): Deck {
  if (cx === deck.cx && cy === deck.cy) return deck;
  const sx = cx / deck.cx;
  const sy = cy / deck.cy;
  const box = <T extends DeckBox>(b: T): T => ({ ...b, x: Math.round(b.x * sx), y: Math.round(b.y * sy), w: Math.round(b.w * sx), h: Math.round(b.h * sy) });
  const shape = (s: DeckShape): DeckShape => (s.locked ? s : box(s));
  const slides = deck.slides.map((s) => ({ ...s, shapes: s.shapes.map(shape) }));
  const masters = deck.masters.map((m) => ({
    ...m,
    footerBox: m.footerBox ? box(m.footerBox) : null,
    numberBox: m.numberBox ? box(m.numberBox) : null,
  }));
  return { ...deck, cx, cy, slides, masters };
}

/* ───────────────────────────────── the theme part ───────────────────────────────── */

const hex = (c: string): string => c.replace('#', '').toUpperCase();

/** `<a:clrScheme>` for these colours. */
export function clrSchemeXml(name: string, colors: Record<string, string>): string {
  const slot = (k: SchemeKey): string => `<a:${k}><a:srgbClr val="${hex(colors[k] ?? '#000000')}"/></a:${k}>`;
  return `<a:clrScheme name="${xmlText(name)}">${SCHEME_KEYS.map(slot).join('')}</a:clrScheme>`;
}

/** `<a:majorFont>`/`<a:minorFont>` bodies. */
export function fontXml(tag: 'majorFont' | 'minorFont', latin: string): string {
  return `<a:${tag}><a:latin typeface="${xmlText(latin)}"/><a:ea typeface=""/><a:cs typeface=""/></a:${tag}>`;
}
