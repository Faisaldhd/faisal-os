/**
 * PDF app — the line icon set (أيقونات الشريط).
 *
 * Static, trusted SVG markup written here by hand — never built from file or user data — and
 * rendered through the shell's sanitizing `renderIcon`. One style for the whole suite: a 24 grid
 * drawn at 20px, 1.75 stroke, round caps and joins, `currentColor`, outline only.
 */
import { renderIcon } from '../../shell/icon';

const svg = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

export const ICONS = {
  save: svg('<path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  print: svg('<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  open: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  device: svg('<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  zoomIn: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6"/>'),
  zoomOut: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6"/>'),
  fitWidth: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 12h10M7 12l2-2M7 12l2 2M17 12l-2-2M17 12l-2 2"/>'),
  fitPage: svg('<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M12 7v10M12 7l-2 2M12 7l2 2M12 17l-2-2M12 17l2-2"/>'),
  actual: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9v6M14 9v6M11.5 10v.01M11.5 14v.01"/>'),
  rotateLeft: svg('<path d="M4 4v5h5"/><path d="M4.6 9A8 8 0 1 1 6 16.5"/>'),
  rotateRight: svg('<path d="M20 4v5h-5"/><path d="M19.4 9A8 8 0 1 0 18 16.5"/>'),
  hand: svg('<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3 15.5a1.5 1.5 0 0 1 2.3-1.9L8 16"/>'),
  select: svg('<path d="M9 4h6M9 20h6M12 4v16"/>'),
  highlight: svg('<path d="M14.5 4.5l5 5L11 18H6v-5z"/><path d="M4 21h16" stroke-width="2.5"/>'),
  underline: svg('<path d="M7 4v6a5 5 0 0 0 10 0V4M5 20h14"/>'),
  strike: svg('<path d="M16 6.5A4 4 0 0 0 12.5 5h-1a3.5 3.5 0 0 0 0 7h1a3.5 3.5 0 0 1 0 7h-1A4 4 0 0 1 8 17.5M4 12h16"/>'),
  note: svg('<path d="M5 4h14a1 1 0 0 1 1 1v11l-5 4H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M15 20v-4h5M8 9h8M8 13h5"/>'),
  pen: svg('<path d="M4 20c3-1 5-6 8-6s2 4 5 4 3-3 3-3"/><path d="M14.5 3.5l3 3-7 7H7.5v-3z"/>'),
  rect: svg('<rect x="4" y="5" width="16" height="14" rx="1.5"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>'),
  line: svg('<path d="M5 19L19 5"/>'),
  arrow: svg('<path d="M5 19L19 5M19 5h-8M19 5v8"/>'),
  textbox: svg('<rect x="3" y="5" width="18" height="14" rx="1.5" stroke-dasharray="3 2.5"/><path d="M8 9h8M12 9v7"/>'),
  text: svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  stamp: svg('<path d="M9 13V9a3 3 0 1 1 6 0v4"/><path d="M4 16a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v1H4zM6 20h12"/>'),
  signature: svg('<path d="M3 17c2-5 4-9 6-9 2.5 0-1.5 9 1 9 1.8 0 2.4-4 4-4 1.2 0 .8 3 2.5 3 1 0 1.9-1 2.5-2"/><path d="M3 21h18"/>'),
  cover: svg('<rect x="4" y="7" width="16" height="10" rx="1.5"/><path d="M4 12h16" stroke-dasharray="2 2.5"/>'),
  watermark: svg('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><path d="M9.5 15a2.5 2.5 0 0 0 2.5 2.5"/>'),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>'),
  pages: svg('<rect x="7" y="3" width="12" height="15" rx="1.5"/><path d="M5 7v12a2 2 0 0 0 2 2h9"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
  duplicate: svg('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  blank: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>'),
  extract: svg('<path d="M6 3h8l4 4v5M14 3v4h4M6 3v18h7"/><path d="M16 15v6M13 18l3 3 3-3"/>'),
  merge: svg('<path d="M4 4h6v7H4zM14 13h6v7h-6z"/><path d="M10 7.5h4a2 2 0 0 1 2 2V13M14 11l2 2 2-2"/>'),
  images: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.75"/><path d="M21 16l-5-5-8 8"/>'),
  crop: svg('<path d="M6 3v15h15M3 6h15v15"/>'),
  form: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h4M14 13h3M7 17h10"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  certificate: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><circle cx="15.5" cy="15" r="3"/><path d="M14 17.5V21l1.5-1 1.5 1v-3.5M7 8h8M7 11h4"/>'),
  sidebar: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'),
  panel: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
  thumbs: svg('<rect x="4" y="3" width="7" height="8" rx="1"/><rect x="13" y="3" width="7" height="8" rx="1"/><rect x="4" y="13" width="7" height="8" rx="1"/><rect x="13" y="13" width="7" height="8" rx="1"/>'),
  bookmark: svg('<path d="M7 3h10v18l-5-4-5 4z"/>'),
  comments: svg('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'),
  chevronPrev: svg('<path d="M15 6l-6 6 6 6"/>'),
  chevronNext: svg('<path d="M9 6l6 6-6 6"/>'),
  chevronDown: svg('<path d="M6 9l6 6 6-6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  help: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.01"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  grip: svg('<circle cx="9" cy="6" r=".9"/><circle cx="15" cy="6" r=".9"/><circle cx="9" cy="12" r=".9"/><circle cx="15" cy="12" r=".9"/><circle cx="9" cy="18" r=".9"/><circle cx="15" cy="18" r=".9"/>'),
  external: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  file: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h4"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  keyboard: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>'),
  palette: svg('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.1 0 1.5-.8 1.5-1.5 0-1.3-1-1.5-1-2.5 0-.8.7-1.5 1.5-1.5h2a4.5 4.5 0 0 0 4.5-4.5c0-4-3.8-7-8.5-7z"/><circle cx="8" cy="11" r=".9"/><circle cx="11" cy="7.5" r=".9"/><circle cx="15.5" cy="8.5" r=".9"/>'),
  back: svg('<path d="M15 6l-6 6 6 6"/>'),
} as const;

export type IconName = keyof typeof ICONS;

/** Directional icons that mirror in right-to-left layouts (media icons never do). */
export const MIRRORED: ReadonlySet<IconName> = new Set<IconName>([
  'undo', 'redo', 'chevronPrev', 'chevronNext', 'back', 'arrow',
]);

export function icon(name: IconName): SVGElement {
  const node = renderIcon(ICONS[name]);
  node.classList.add('faisal-pdf-icon');
  if (MIRRORED.has(name)) node.classList.add('is-mirrored');
  return node;
}
