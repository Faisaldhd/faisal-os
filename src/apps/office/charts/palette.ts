/**
 * Office charts — colours. The first two series use the suite's accents
 * (--app-blue, --app-copper); the other six are chosen to sit with them.
 * Each theme's eight colours were checked with a palette validator against its
 * surface (lightness band, chroma, colour-blind separation of neighbours ≥ 6.6
 * with legend + 2px gaps as the secondary cue, normal-vision separation ≥ 18,
 * contrast ≥ 3:1). Copper is a hair darker than the UI token (#C8894B) so it
 * stays in the readable band on the dark canvas. Series take colours in this
 * fixed order and never cycle: a 9th series reuses nothing and should be folded
 * into "Other" by the caller (buildChart greys it out).
 */

export interface ChartTheme {
  surface: string;
  text: string;
  text2: string;
  text3: string;
  grid: string;
  axis: string;
  series: readonly string[];
  /** For series past the eighth. */
  other: string;
}

export const CHART_THEMES: Readonly<Record<'dark' | 'light', ChartTheme>> = {
  dark: {
    surface: '#0d1220',
    text: '#E8ECF4',
    text2: '#A7B0C2',
    text3: '#6E7890',
    grid: 'rgba(255,255,255,0.08)',
    axis: 'rgba(255,255,255,0.14)',
    series: ['#5B8DEF', '#BD7E42', '#1C9E88', '#8D6BE3', '#D65C80', '#A88A1C', '#3A93C9', '#B0629F'],
    other: '#6E7890',
  },
  light: {
    surface: '#ffffff',
    text: '#1a1d26',
    text2: '#4A5263',
    text3: '#6E7890',
    grid: 'rgba(26,29,38,0.08)',
    axis: 'rgba(26,29,38,0.18)',
    series: ['#3F73DB', '#B5733A', '#16907B', '#7E5CD6', '#C94C72', '#957A12', '#2F84BA', '#A1528F'],
    other: '#8E96A8',
  },
};

/** The colour of series `i` in a theme. */
export function seriesColor(i: number, theme: 'dark' | 'light' = 'dark'): string {
  const t = CHART_THEMES[theme];
  return t.series[i] ?? t.other;
}
