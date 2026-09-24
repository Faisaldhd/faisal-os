/**
 * Office charts — a ChartScene as an SVG string, built safely: every text and
 * attribute value is XML-escaped, numbers are rounded, and only the fixed
 * element/attribute names below are ever written (no markup from data).
 *
 *   renderSvg(scene, { title? }) → '<svg xmlns=…>…</svg>'
 *
 * For live rendering prefer creating elements with createElementNS from
 * scene.marks (same attributes as here); this string is for export/thumbnails.
 */
import type { ChartScene, Mark } from './chart';

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' })[c]!);
}

const n = (v: number): string => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '0');

function attrs(pairs: Array<[string, string | number | undefined]>): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${typeof v === 'number' ? n(v) : escapeXml(v as string)}"`)
    .join('');
}

function markSvg(m: Mark): string {
  const title = m.label ? `<title>${escapeXml(m.label)}</title>` : '';
  const close = (tag: string, a: string): string => (title ? `<${tag}${a}>${title}</${tag}>` : `<${tag}${a}/>`);
  switch (m.kind) {
    case 'rect': return close('rect', attrs([['x', m.x], ['y', m.y], ['width', m.w], ['height', m.h], ['rx', m.rx], ['fill', m.fill]]));
    case 'path': return close('path', attrs([['d', m.d], ['fill', m.fill], ['stroke', m.stroke], ['stroke-width', m.strokeWidth], ['stroke-linejoin', m.role === 'line' ? 'round' : undefined], ['stroke-linecap', m.role === 'line' ? 'round' : undefined]]));
    case 'line': return close('line', attrs([['x1', m.x1], ['y1', m.y1], ['x2', m.x2], ['y2', m.y2], ['stroke', m.stroke], ['stroke-width', m.strokeWidth]]));
    case 'circle': return close('circle', attrs([['cx', m.cx], ['cy', m.cy], ['r', m.r], ['fill', m.fill], ['stroke', m.stroke], ['stroke-width', m.strokeWidth]]));
    default: {
      const baseline = m.baseline === 'middle' ? 'central' : m.baseline === 'hanging' ? 'hanging' : undefined;
      const a = attrs([
        ['x', m.x], ['y', m.y], ['fill', m.fill], ['font-size', m.size], ['font-weight', m.weight], ['text-anchor', m.anchor],
        ['dominant-baseline', baseline], ['direction', m.rtl ? 'rtl' : undefined], ['unicode-bidi', m.rtl ? 'plaintext' : undefined],
        ['transform', m.rotate ? `rotate(${n(m.rotate)} ${n(m.x)} ${n(m.y)})` : undefined],
      ]);
      return `<text${a}>${escapeXml(m.text)}${title}</text>`;
    }
  }
}

export function renderSvg(scene: ChartScene, opts: { title?: string } = {}): string {
  const head = `<svg xmlns="http://www.w3.org/2000/svg"${attrs([['width', scene.width], ['height', scene.height], ['viewBox', `0 0 ${n(scene.width)} ${n(scene.height)}`], ['role', 'img'], ['aria-label', opts.title], ['font-family', 'system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif']])}>`;
  const title = opts.title ? `<title>${escapeXml(opts.title)}</title>` : '';
  return `${head}${title}${scene.marks.map(markSvg).join('')}</svg>`;
}
