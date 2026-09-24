/**
 * Static, trusted SVG markup for the editor's tool strip. Never derived from file data, so it
 * is safe to parse through the shell's `renderIcon` (which strips scripts and on* handlers).
 */
const svg = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS = {
  move: svg('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
  select: svg('<rect x="4" y="4" width="16" height="16" rx="1.5" stroke-dasharray="4 3"/>'),
  crop: svg('<path d="M6 3v15h15M3 6h15v15"/>'),
  brush: svg('<path d="M15.5 3.5l5 5L9 20H4v-5z"/><path d="M12 7l5 5"/>'),
  line: svg('<path d="M4 20L20 4"/>'),
  rect: svg('<rect x="4" y="5" width="16" height="14" rx="1.5"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="8" ry="7"/>'),
  arrow: svg('<path d="M4 20L19 5M19 5h-8M19 5v8"/>'),
  text: svg('<path d="M5 6h14M12 6v13M9 19h6"/>'),
  zoomIn: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6"/>'),
  zoomOut: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6"/>'),
};

export type IconName = keyof typeof ICONS;
