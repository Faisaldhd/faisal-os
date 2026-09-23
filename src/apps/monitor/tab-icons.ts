/**
 * Static, trusted SVG icon markup for the System Monitor UI (never derived from process data).
 * Safe to parse via DOMParser.
 */
const parser = new DOMParser();

export function icon(svg: string): SVGElement {
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  return doc.documentElement as unknown as SVGElement;
}

const svg = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS = {
  processes: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1"/>'),
  resources: svg('<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>'),
  filesystems: svg('<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/>'),
  system: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>'),
  refresh: svg('<path d="M3 12a9 9 0 1 1 3 6.7"/><path d="M3 12v5h5"/>'),
  app: svg('<rect x="3" y="3" width="18" height="18" rx="4"/>'),
};
