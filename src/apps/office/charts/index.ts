/**
 * Office charts — public API (الرسوم البيانية).
 *
 *   buildChart(spec) → ChartScene     DOM-free marks (render with createElementNS)
 *   renderSvg(scene, { title? })      the same scene as an escaped SVG string
 *   niceTicks · pieAngles · arcPath · textWidth · formatTick   geometry helpers
 *   CHART_THEMES · seriesColor         validated dark/light palettes (blue, copper, …)
 * See chart.ts for the ChartSpec fields (bar clustered/stacked/horizontal, line,
 * pie, doughnut, scatter; titles; legend; rtl).
 */
export { buildChart, type ChartScene, type ChartSpec, type ChartType, type Mark, type PointSeries, type ValueSeries } from './chart';
export { renderSvg, escapeXml } from './svg';
export { arcPath, formatTick, niceTicks, pieAngles, textWidth, type PieSlice, type Ticks } from './geometry';
export { CHART_THEMES, seriesColor, type ChartTheme } from './palette';
