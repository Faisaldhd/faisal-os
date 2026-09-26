/**
 * Office — the suite's icon set (مجموعة الأيقونات).
 *
 * One style everywhere: a 24-unit grid, 1.75px stroke, round caps and joins,
 * `currentColor`, drawn at 20px. Every icon is a list of trusted path strings
 * that live in this file; the SVG is built with `createElementNS`, so nothing is
 * ever parsed from markup and no file content can reach it.
 *
 * `FLIPS` lists the icons that imply a direction (undo, indent, arrows): they are
 * mirrored in an RTL window, exactly like the chrome around them.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** A shape: a path `d`, or a filled path when it starts with "F:". */
export const ICONS = {
  save: ['M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z', 'M8 4v5h7V4', 'M8 20v-6h8v6'],
  undo: ['M9 7L5 11l4 4', 'M5 11h9a5 5 0 0 1 0 10h-3'],
  redo: ['M15 7l4 4-4 4', 'M19 11h-9a5 5 0 0 0 0 10h3'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  more: ['F:M6 12a1.6 1.6 0 1 0 0.01 0z', 'F:M12 12a1.6 1.6 0 1 0 0.01 0z', 'F:M18 12a1.6 1.6 0 1 0 0.01 0z'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  back: ['M15 5l-7 7 7 7'],
  chevronDown: ['M6 9l6 6 6-6'],
  chevronStart: ['M15 6l-6 6 6 6'],
  chevronEnd: ['M9 6l6 6-6 6'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.3-2.5 3.9', 'M12 17.2v.1'],
  doc: ['M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5', 'M9 13h6', 'M9 17h6'],
  sheet: ['M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M4 10h16', 'M4 15h16', 'M10 4v16'],
  slides: ['M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M12 16v4', 'M8 20h8', 'M7 8h6', 'M7 11h9'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M5 20h14'],
  download: ['M12 4v12', 'M7 11l5 5 5-5', 'M5 20h14'],
  print: ['M7 9V4h10v5', 'M6 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1', 'M7 14h10v7H7z'],
  pdf: ['M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5', 'M9 16v-4h1.5a1.3 1.3 0 0 1 0 2.6H9', 'M14 12v4'],
  revert: ['M4 12a8 8 0 1 0 2.4-5.7', 'M4 4v4h4'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  bold: ['M7 5h6a3.5 3.5 0 0 1 0 7H7z', 'M7 12h7a3.5 3.5 0 0 1 0 7H7z'],
  italic: ['M10 5h8', 'M6 19h8', 'M14 5l-4 14'],
  underline: ['M7 4v7a5 5 0 0 0 10 0V4', 'M5 20h14'],
  strike: ['M5 12h14', 'M16 7.5A3.9 3.9 0 0 0 12 5c-2.2 0-4 1.2-4 3 0 1.2.8 2.2 2.3 2.8', 'M8 16.5A4 4 0 0 0 12 19c2.3 0 4-1.3 4-3.2'],
  textColor: ['M6 17L12 4l6 13', 'M8.2 12.5h7.6', 'F:M4 19h16v2.5H4z'],
  highlight: ['M14 4l6 6-8.5 8.5H6v-5.5z', 'M11 7l6 6', 'F:M3 20h9v2H3z'],
  alignLeft: ['M4 6h16', 'M4 10h10', 'M4 14h16', 'M4 18h10'],
  alignCenter: ['M4 6h16', 'M7 10h10', 'M4 14h16', 'M7 18h10'],
  alignRight: ['M4 6h16', 'M10 10h10', 'M4 14h16', 'M10 18h10'],
  alignJustify: ['M4 6h16', 'M4 10h16', 'M4 14h16', 'M4 18h16'],
  rtl: ['M20 5H10a3 3 0 0 0 0 6h3', 'M13 5v14', 'M17 5v14', 'M8 17H3', 'M5 15l-2 2 2 2'],
  ltr: ['M4 5h10a3 3 0 0 1 0 6h-3', 'M11 5v14', 'M7 5v14', 'M16 17h5', 'M19 15l2 2-2 2'],
  bullets: ['F:M4.5 7a1.3 1.3 0 1 0 0.01 0z', 'F:M4.5 12a1.3 1.3 0 1 0 0.01 0z', 'F:M4.5 17a1.3 1.3 0 1 0 0.01 0z', 'M9 7h11', 'M9 12h11', 'M9 17h11'],
  numbers: ['M4 5h1.5v4', 'M4 9h3', 'M4 14.2c.4-.8 2.8-.9 2.8.6 0 1.2-2.8 1.8-2.8 3.2h3', 'M10 7h10', 'M10 12h10', 'M10 17h10'],
  indent: ['M4 5h16', 'M11 10h9', 'M11 14h9', 'M4 19h16', 'M4 9l3 3-3 3'],
  outdent: ['M4 5h16', 'M11 10h9', 'M11 14h9', 'M4 19h16', 'M7 9l-3 3 3 3'],
  lineSpacing: ['M11 6h9', 'M11 12h9', 'M11 18h9', 'M5 4v16', 'M3 6l2-2 2 2', 'M3 18l2 2 2-2'],
  styles: ['M4 19l5-14h1l5 14', 'M6 14h7', 'M16 19c0-2 4-2 4-4.5A2 2 0 0 0 16.2 14'],
  font: ['M4 19l5-14 5 14', 'M6 14h6', 'M15 19v-6a2.5 2.5 0 0 1 5 0v6', 'M15 15.5h5'],
  table: ['M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M4 9.5h16', 'M4 14.5h16', 'M9.5 9.5V20', 'M14.5 9.5V20'],
  image: ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M4 16l4.5-4.5a1.5 1.5 0 0 1 2 0L16 17', 'M14 14l1.5-1.5a1.5 1.5 0 0 1 2 0L20 15', 'M15 8.5v.1'],
  pageBreak: ['M6 3v5h12V3', 'M6 21v-5h12v5', 'M3 12h2', 'M8 12h2', 'M13 12h2', 'M18 12h3'],
  toc: ['M4 6h3', 'M10 6h10', 'M6 11h3', 'M12 11h8', 'M6 16h3', 'M12 16h8'],
  pageNumber: ['M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M11 15.5h2', 'M12 15.5V12l-1 .6'],
  date: ['M5 6h14v14H5z', 'M5 10h14', 'M9 3v4', 'M15 3v4'],
  symbol: ['M7 19h3v-2.5a6 6 0 1 1 4 0V19h3'],
  math: ['M4 12h5l2 7 4-15h5', 'M14 10l5 5', 'M19 10l-5 5'],
  columns: ['M4 5h7v14H4z', 'M13 5h7v14h-7z'],
  margins: ['M4 4h16v16H4z', 'M8 4v16', 'M16 4v16', 'M4 8h16', 'M4 16h16'],
  orientation: ['M7 3h8l4 4v13H7z', 'M3 15h9v6H3z'],
  pageSize: ['M6 3h9l4 4v14H6z', 'M15 3v4h4', 'M9 12h7', 'M12.5 9v6'],
  find: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M20 20l-4.8-4.8'],
  replace: ['M4 7h10', 'M11 4l3 3-3 3', 'M20 17H10', 'M13 14l-3 3 3 3'],
  wordCount: ['M4 6h10', 'M4 11h7', 'M4 16h5', 'M15 11l2 2 4-5', 'M14 19h7'],
  comment: ['M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M8 9.5h8', 'M8 12.5h5'],
  zoomIn: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M20 20l-4.8-4.8', 'M10.5 8v5', 'M8 10.5h5'],
  zoomOut: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M20 20l-4.8-4.8', 'M8 10.5h5'],
  fit: ['M4 9V5h4', 'M16 5h4v4', 'M20 15v4h-4', 'M8 19H4v-4'],
  draft: ['M5 5h14', 'M5 9h14', 'M5 13h14', 'M5 17h8'],
  pageView: ['M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M9 7h6', 'M9 10h6', 'M9 13h4'],
  sidebar: ['M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M15 4v16'],
  navigator: ['M4 6h4', 'M4 12h4', 'M4 18h4', 'M11 6h9', 'M13 12h7', 'M13 18h7'],
  rowAdd: ['M4 5h16v6H4z', 'M4 15h7', 'M17 14v6', 'M14 17h6'],
  rowDelete: ['M4 5h16v6H4z', 'M4 15h7', 'M14 17h6'],
  colAdd: ['M5 4h6v16H5z', 'M15 4v7', 'M17 14v6', 'M14 17h6'],
  colDelete: ['M5 4h6v16H5z', 'M15 4v7', 'M14 17h6'],
  sum: ['M17 5H7l5 7-5 7h10'],
  fx: ['M9 20c2 0 2.5-1.5 3-4l2-10c.5-2.5 1.5-3 3-3', 'M8 10h8', 'M14 14l5 5', 'M19 14l-5 5'],
  sortAsc: ['M7 4v16', 'M4 17l3 3 3-3', 'M13 6h4', 'M13 11h6', 'M13 16h8'],
  sortDesc: ['M7 4v16', 'M4 17l3 3 3-3', 'M13 6h8', 'M13 11h6', 'M13 16h4'],
  filter: ['M4 5h16l-6 7.5V19l-4 1.5v-8z'],
  freeze: ['M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M4 9h16', 'M9 4v16'],
  fill: ['M5 11l7-7 7 7-7 7z', 'M5 11h14', 'M20 15.5c0 1.5-1 2.5-1 2.5s-1-1-1-2.5 1-2.5 1-2.5 1 1 1 2.5z'],
  borders: ['M4 4h16v16H4z', 'M4 12h16', 'M12 4v16'],
  merge: ['M4 5h16v14H4z', 'M9 12h6', 'M13 10l2 2-2 2', 'M11 10l-2 2 2 2'],
  wrap: ['M4 6h16', 'M4 12h13a3 3 0 0 1 0 6h-4', 'M15 16l-2 2 2 2', 'M4 18h5'],
  percent: ['M19 5L5 19', 'M7 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  currency: ['M12 3v18', 'M16.5 7.5C16 6 14.3 5 12 5c-2.5 0-4.5 1.3-4.5 3.3S9.3 11 12 11.8s4.5 1.5 4.5 3.7-2 3.5-4.5 3.5c-2.4 0-4.2-1-4.7-2.8'],
  decimalAdd: ['M4 16v.1', 'M9.5 12a2.5 2.5 0 0 1 5 0v4a2.5 2.5 0 0 1-5 0z', 'M18 9v6', 'M15 12h6'],
  decimalRemove: ['M4 16v.1', 'M9.5 12a2.5 2.5 0 0 1 5 0v4a2.5 2.5 0 0 1-5 0z', 'M15 12h6'],
  chart: ['M4 20h16', 'M7 16v-5', 'M12 16V6', 'M17 16v-8'],
  csv: ['M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5', 'M9 13h6', 'M9 17h6', 'M12 11v8'],
  copy: ['M9 9h10v11H9z', 'M5 15V4h10'],
  paste: ['M9 4h6v3H9z', 'M8 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-2'],
  cut: ['M6 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M6 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M8 7.5L20 18', 'M8 16.5L20 6'],
  slideAdd: ['M3 6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M20 12v6', 'M17 15h6'],
  duplicate: ['M8 8h12v10H8z', 'M4 14V5h12'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  moveUp: ['M12 19V5', 'M6 11l6-6 6 6'],
  moveDown: ['M12 5v14', 'M6 13l6 6 6-6'],
  textBox: ['M4 5h16v14H4z', 'M8 9h8', 'M12 9v7'],
  play: ['F:M7 4.5v15a.8.8 0 0 0 1.2.7l12-7.5a.8.8 0 0 0 0-1.4l-12-7.5A.8.8 0 0 0 7 4.5z'],
  presenter: ['M3 4h18v11H3z', 'M8 20h8', 'M12 15v5', 'M7 8h6', 'M7 11h4'],
  layout: ['M4 4h16v16H4z', 'M4 9h16', 'M11 9v11'],
  shape: ['M4 14h7v7H4z', 'M17 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', 'M14 21l3.5-7 3.5 7z'],
  theme: ['M12 3a9 9 0 1 0 0 18c1.2 0 1.5-1 1-2-1-2 .5-3 2-3h2a4 4 0 0 0 4-4 9 9 0 0 0-9-9z', 'M7.5 12v.1', 'M9.5 7.5v.1', 'M14.5 7.5v.1'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v6', 'M12 7.5v.1'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  keyboard: ['M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M7 10v.1', 'M11 10v.1', 'M15 10v.1', 'M8 14h8'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  text: ['M5 6h14', 'M12 6v13', 'M9 19h6'],
  heading: ['M6 5v14', 'M16 5v14', 'M6 12h10'],
  quote: ['M5 11h4v6H5z', 'M5 11c0-3 1-5 4-6', 'M14 11h4v6h-4z', 'M14 11c0-3 1-5 4-6'],
  rect: ['M4 6h16v12H4z'],
  ellipse: ['M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z'],
  arrow: ['M4 10h9V6l7 6-7 6v-4H4z'],
  line: ['M5 19L19 5'],
  transition: ['M3 6h9v12H3z', 'M15 6h6', 'M15 12h6', 'M15 18h6'],
  sparkle: ['M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z'],
  timer: ['M12 8v5l3 2', 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M9 2h6'],
  // A note at the foot of the page: the page, its text, Word's own separator rule, and the number.
  footnote: ['M7 3h7l3 3v9H7z', 'M14 3v3h3', 'M10 8h4', 'M10 11h2', 'M4 16h16', 'M11 21v-4l-1 .6'],
  // A note at the end of the document: the page with its text, and the number after the last line.
  endnote: ['M6 3h12v18H6z', 'M9 7h6', 'M9 10h6', 'M9 13h3', 'M17 17v4', 'M16 18l1-.7'],
} as const;

export type IconName = keyof typeof ICONS;

/** Icons that point somewhere, and so mirror in a right-to-left window. */
export const FLIPS: ReadonlySet<IconName> = new Set<IconName>([
  'undo', 'redo', 'back', 'chevronStart', 'chevronEnd', 'indent', 'outdent',
]);

/** A fresh 20px icon for this name, as an SVG element built node by node. */
export function icon(name: IconName, size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('fo-icon');
  if (FLIPS.has(name)) svg.classList.add('fo-icon-flip');
  for (const shape of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    if (shape.startsWith('F:')) {
      path.setAttribute('d', shape.slice(2));
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('stroke', 'none');
    } else {
      path.setAttribute('d', shape);
    }
    svg.append(path);
  }
  return svg;
}
