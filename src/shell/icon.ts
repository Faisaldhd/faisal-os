/**
 * Safe rendering of trusted, built-in SVG markup coming from AppManifest.icon.
 * Parses with DOMParser (image/svg+xml) and strips <script>, on* attributes
 * and <foreignObject> before inserting into the DOM. Never used for
 * untrusted/dynamic strings (file names, file contents, etc.).
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * `image/svg+xml` is parsed as plain XML: elements only land in the SVG
 * namespace when the markup declares `xmlns` itself. Manifest icons often
 * omit it (it is optional in an inline <svg> embedded in HTML), so without
 * this the parsed nodes come back with a null namespace and never paint.
 */
function ensureSvgNamespace(svgMarkup: string): string {
  if (/<svg[^>]*\sxmlns\s*=/.test(svgMarkup)) return svgMarkup;
  return svgMarkup.replace(/<svg/, `<svg xmlns="${SVG_NS}"`);
}

export function renderIcon(svgMarkup: string, fallback?: () => SVGElement): SVGElement {
  try {
    const doc = new DOMParser().parseFromString(ensureSvgNamespace(svgMarkup), 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
      throw new Error('invalid svg');
    }
    sanitizeNode(svg);
    uniquifyIds(svg);
    return svg as unknown as SVGElement;
  } catch {
    return fallback ? fallback() : defaultIcon();
  }
}

/** Allowlist sanitizer: only static drawing elements and presentation attributes survive. */
const ALLOWED_TAGS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'filter', 'fegaussianblur', 'feoffset',
  'feblend', 'fecolormatrix', 'feflood', 'fecomposite', 'femerge', 'femergenode', 'fedropshadow', 'text', 'tspan',
]);
const ALLOWED_ATTRS = new Set([
  'xmlns', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy',
  'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-opacity', 'opacity', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
  'spreadmethod', 'id', 'class', 'clip-path', 'mask', 'filter', 'stddeviation', 'dx', 'dy', 'in', 'in2', 'mode',
  'result', 'values', 'type', 'operator', 'flood-color', 'flood-opacity', 'font-size', 'font-weight',
  'font-family', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'preserveaspectratio', 'aria-hidden',
  'role', 'aria-label', 'focusable', 'vector-effect', 'paint-order', 'shape-rendering', 'filterunits', 'maskunits',
  'clippathunits', 'color-interpolation-filters',
]);
/** url(...) may only reference same-document fragments. */
const hasExternalUrl = (v: string) => /url\s*\(\s*['"]?\s*(?!#)/i.test(v);

function sanitizeNode(node: Element): void {
  const walker = [node, ...Array.from(node.querySelectorAll('*'))];
  for (const el of walker) {
    if (!el.isConnected && el !== node) continue; // already removed with an ancestor
    if (!ALLOWED_TAGS.has(el.nodeName.toLowerCase())) { el.remove(); continue; }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!ALLOWED_ATTRS.has(name) || hasExternalUrl(attr.value)) el.removeAttribute(attr.name);
    }
  }
}

let idSeq = 0;

/**
 * Icons are inserted many times per page (dock, grid, title bars). Gradient ids
 * must be unique per document or every copy paints with the first definition
 * (and breaks entirely when that copy is hidden), so suffix them per instance.
 */
function uniquifyIds(svg: Element): void {
  const withId = Array.from(svg.querySelectorAll('[id]'));
  if (withId.length === 0) return;
  const suffix = `-fi${++idSeq}`;
  const ids = new Set<string>();
  for (const el of withId) {
    ids.add(el.id);
    el.id = el.id + suffix;
  }
  for (const el of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      const v = attr.value;
      if (!v.includes('#')) continue;
      const next = v.replace(/url\(#([^)]+)\)/g, (m, id: string) => (ids.has(id) ? `url(#${id}${suffix})` : m))
        .replace(/^#(.+)$/, (m, id: string) => (ids.has(id) ? `#${id}${suffix}` : m));
      if (next !== v) el.setAttribute(attr.name, next);
    }
  }
}

export function defaultIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', '3'); rect.setAttribute('y', '3');
  rect.setAttribute('width', '18'); rect.setAttribute('height', '18');
  rect.setAttribute('rx', '5'); rect.setAttribute('fill', 'currentColor');
  svg.append(rect);
  return svg;
}

/** Small helper for icons authored directly by the shell (trusted, static, literal strings only). */
export function svgIcon(container: HTMLElement, markup: string): void {
  const el = renderIcon(markup);
  container.append(el);
}
