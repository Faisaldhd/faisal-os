/**
 * Static, trusted SVG icon markup for the Image Viewer toolbar (never derived from file data).
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
  gallery: svg('<path d="M15 5l-7 7 7 7M8 12h9"/>'),
  prev: svg('<path d="M15 5l-7 7 7 7"/>'),
  next: svg('<path d="M9 5l7 7-7 7"/>'),
  zoomIn: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6"/>'),
  zoomOut: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  actual: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/>'),
  rotate: svg('<path d="M3 12a9 9 0 1 1 3 6.7"/><path d="M3 12v5h5"/>'),
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  exitFullscreen: svg('<path d="M9 4v5H4M20 9h-5V4M4 15h5v5M15 20v-5h5"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17l4.5-4.5 3 3L16 10l4 4"/>'),
};
