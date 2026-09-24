/**
 * Video Studio's icon set — the suite's single line style: a 24-unit grid drawn at
 * 20px, 1.75px stroke, round caps and joins, `currentColor`.
 *
 * Icons are built with `createElementNS` from the static path data below — no
 * markup parsing, and nothing here ever comes from a file or the user.
 *
 * `flip: true` marks icons that imply a reading direction (undo/redo, prev/next
 * arrows): CSS mirrors them in RTL. Media transport icons (play, frame step)
 * never flip, because time always runs left to right in this app.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

interface IconSpec {
  /** Stroked paths. */
  d: string[];
  /** Filled paths (drawn with the current colour, no stroke). */
  fill?: string[];
  flip?: boolean;
}

const I = (d: string[], fill?: string[], flip?: boolean): IconSpec => ({ d, fill, flip });

export const ICONS = {
  play: I([], ['M8 5.5v13a.8.8 0 0 0 1.2.7l10.2-6.5a.8.8 0 0 0 0-1.4L9.2 4.8A.8.8 0 0 0 8 5.5z']),
  pause: I([], ['M7 5h3.2v14H7zM13.8 5H17v14h-3.2z']),
  frameBack: I(['M11 7l-5 5 5 5', 'M18 7l-5 5 5 5']),
  frameForward: I(['M13 7l5 5-5 5', 'M6 7l5 5-5 5']),
  prev: I(['M18 6l-8 6 8 6z', 'M6 6v12']),
  next: I(['M6 6l8 6-8 6z', 'M18 6v12']),
  volume: I(['M4 9.5h3.5L12 6v12l-4.5-3.5H4z', 'M15.5 9a4 4 0 0 1 0 6', 'M18 6.5a7.5 7.5 0 0 1 0 11']),
  mute: I(['M4 9.5h3.5L12 6v12l-4.5-3.5H4z', 'M16 10l4 4M20 10l-4 4']),
  expand: I(['M4 9V4h5', 'M15 4h5v5', 'M20 15v5h-5', 'M9 20H4v-5']),
  shrink: I(['M9 4v5H4', 'M20 9h-5V4', 'M15 20v-5h5', 'M4 15h5v5']),
  gauge: I(['M4.5 16a8 8 0 1 1 15 0', 'M12 13l3.5-4']),
  split: I(['M6 4v16', 'M18 4v16', 'M12 3v18'], undefined, false),
  scissors: I(['M8.5 8.5L20 19', 'M8.5 15.5L20 5', 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z']),
  trash: I(['M4 7h16', 'M9 7V4.5h6V7', 'M6.5 7l1 12.5h9l1-12.5', 'M10 11v5.5M14 11v5.5']),
  duplicate: I(['M8 8h11v11H8z', 'M5 16V5h11']),
  detach: I(['M9 17H7a5 5 0 0 1 0-10h2', 'M15 7h2a5 5 0 0 1 0 10h-2', 'M4 4l16 16']),
  text: I(['M5 6V4.5h14V6', 'M12 4.5v15', 'M9 19.5h6']),
  undo: I(['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'], undefined, true),
  redo: I(['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'], undefined, true),
  zoomIn: I(['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.5 15.5L20 20', 'M10.5 7.5v6M7.5 10.5h6']),
  zoomOut: I(['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.5 15.5L20 20', 'M7.5 10.5h6']),
  fit: I(['M4 12h16', 'M7 9l-3 3 3 3', 'M17 9l3 3-3 3']),
  magnet: I(['M6 4v7a6 6 0 0 0 12 0V4', 'M6 8h3M15 8h3', 'M9 4v7a3 3 0 0 0 6 0V4']),
  loop: I(['M4 11V9a3 3 0 0 1 3-3h12', 'M16 3l3 3-3 3', 'M20 13v2a3 3 0 0 1-3 3H5', 'M8 21l-3-3 3-3']),
  plus: I(['M12 5v14M5 12h14']),
  folder: I(['M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z']),
  upload: I(['M12 15V4', 'M7.5 8.5L12 4l4.5 4.5', 'M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15']),
  film: I(['M4 5h16v14H4z', 'M8 5v14M16 5v14', 'M4 9h4M4 15h4M16 9h4M16 15h4']),
  music: I(['M9 18V6l10-2v12', 'M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z']),
  image: I(['M4 5h16v14H4z', 'M4 16l5-5 4 4 2.5-2.5L20 17', 'M15.5 9.5a1.5 1.5 0 1 0 0-.01']),
  layers: I(['M12 4l8 4.5-8 4.5-8-4.5z', 'M4 13l8 4.5 8-4.5']),
  eye: I(['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z']),
  eyeOff: I(['M4 4l16 16', 'M10 5.7A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.8', 'M6.6 7.1A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1']),
  chevronDown: I(['M6 9l6 6 6-6']),
  chevronStart: I(['M15 6l-6 6 6 6'], undefined, true),
  chevronEnd: I(['M9 6l6 6-6 6'], undefined, true),
  close: I(['M6 6l12 12M18 6L6 18']),
  help: I(['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6', 'M12 17h.01']),
  more: I([], ['M5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM19 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z']),
  save: I(['M5 4h11l3 3v13H5z', 'M8 4v5h7V4', 'M8 20v-6h8v6']),
  exportIcon: I(['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M5 19.5h14']),
  rotateLeft: I(['M4 4v5h5', 'M4.5 9A8 8 0 1 1 6 17'], undefined, false),
  rotateRight: I(['M20 4v5h-5', 'M19.5 9A8 8 0 1 0 18 17'], undefined, false),
  flipH: I(['M12 3v18', 'M9 6L3 18h6z', 'M15 6l6 12h-6z']),
  flipV: I(['M3 12h18', 'M6 9L18 3v6z', 'M6 15l12 6v-6z']),
  crop: I(['M6 3v15h15', 'M3 6h15v15']),
  playlist: I(['M4 6h11M4 11h11M4 16h7', 'M16 14.5v6l4.5-3z']),
  trim: I(['M8 4H5v16h3', 'M16 4h3v16h-3', 'M11 12h2']),
  check: I(['M5 12.5l4.5 4.5L19 7.5']),
  grip: I([], ['M9 6.5a1.3 1.3 0 1 1 0 .01zM15 6.5a1.3 1.3 0 1 1 0 .01zM9 12a1.3 1.3 0 1 1 0 .01zM15 12a1.3 1.3 0 1 1 0 .01zM9 17.5a1.3 1.3 0 1 1 0 .01zM15 17.5a1.3 1.3 0 1 1 0 .01z']),
  warning: I(['M12 4L2.5 20h19z', 'M12 10v4.5', 'M12 17.5h.01']),
  effects: I(['M12 3v4M12 17v4M3 12h4M17 12h4', 'M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18']),
  transition: I(['M4 5h7v14H4z', 'M13 5h7v14h-7z', 'M9 12h6', 'M13 10l2 2-2 2']),
  sliders: I(['M5 4v16M12 4v16M19 4v16', 'M3 9h4M10 15h4M17 7h4']),
  camera: I(['M4 8h3l1.5-2.5h7L17 8h3v11H4z', 'M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z']),
  link: I(['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1']),
  keyboard: I(['M3 7h18v11H3z', 'M7 11h.01M11 11h.01M15 11h.01M19 11h.01M8 14.5h8']),
  back: I(['M15 5l-7 7 7 7'], undefined, true),
  square: I(['M5 5h14v14H5z']),
  spark: I(['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z']),
} satisfies Record<string, IconSpec>;

export type IconName = keyof typeof ICONS;

/** A fresh SVG element for one icon; `aria-hidden` because the button carries the label. */
export function icon(name: IconName): SVGSVGElement {
  const spec: IconSpec = ICONS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', spec.flip ? 'fvs-icon is-flip' : 'fvs-icon');
  for (const d of spec.d) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.75');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  for (const d of spec.fill ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}
