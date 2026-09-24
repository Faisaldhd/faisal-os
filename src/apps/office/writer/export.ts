/**
 * Writer — exporters to HTML and Markdown (التصدير).
 *
 * Both are built from the model as text, with every character escaped: the
 * document's content never becomes markup by accident. PDF goes through the
 * print path (the browser's own "Save as PDF"), which prints only the pages.
 */
import type { DocModel, ParagraphFormat } from '../model';
import { blockText, type DocBlock, type RunProps } from './types';

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function headingLevel(format: ParagraphFormat | undefined, outline: number | undefined): number {
  const style = format?.style ?? '';
  const m = /^Heading([1-6])$/.exec(style);
  if (m) return Number(m[1]);
  if (style === 'Title') return 1;
  return outline !== undefined && outline < 6 ? outline + 1 : 0;
}

function runHtml(text: string, p: RunProps): string {
  let html = escapeHtml(text).replace(/\n/g, '<br>');
  if (!html) return '';
  const css: string[] = [];
  if (p.color) css.push(`color:#${p.color}`);
  if (p.sz) css.push(`font-size:${p.sz}pt`);
  if (p.font) css.push(`font-family:'${p.font.replace(/'/g, '')}'`);
  if (p.b) html = `<strong>${html}</strong>`;
  if (p.i) html = `<em>${html}</em>`;
  if (p.u) html = `<u>${html}</u>`;
  if (p.strike) html = `<s>${html}</s>`;
  if (p.hl) html = `<mark>${html}</mark>`;
  if (p.va === 'superscript') html = `<sup>${html}</sup>`;
  if (p.va === 'subscript') html = `<sub>${html}</sub>`;
  return css.length ? `<span style="${css.join(';')}">${html}</span>` : html;
}

/** A standalone HTML page of the document (paragraphs, headings, lists, run formatting). */
export function toHtml(model: DocModel, title: string, outlines: ReadonlyArray<number | undefined> = []): string {
  const blocks: DocBlock[] = model.blocks ?? model.paragraphs.map((text, id) => ({ id, runs: [{ t: 'text', text, props: {} }] }));
  const body: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  blocks.forEach((block, i) => {
    const format = model.formats?.[i];
    const want = format?.list === 'bullet' ? 'ul' : format?.list === 'number' ? 'ol' : null;
    if (list && list !== want) { body.push(`</${list}>`); list = null; }
    if (want && !list) { body.push(`<${want}>`); list = want; }
    const inner = block.runs.map((r) => (r.t === 'text' ? runHtml(r.text, r.props) : escapeHtml(r.text))).join('');
    const dir = format?.dir ? ` dir="${format.dir}"` : ' dir="auto"';
    const align = format?.align ? ` style="text-align:${format.align}"` : '';
    const level = headingLevel(format, outlines[i]);
    if (want) body.push(`<li${dir}${align}>${inner}</li>`);
    else if (level) body.push(`<h${level}${dir}${align}>${inner}</h${level}>`);
    else body.push(`<p${dir}${align}>${inner || '<br>'}</p>`);
  });
  if (list) body.push(`</${list}>`);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    '<style>body{max-width:760px;margin:40px auto;padding:0 16px;font:16px/1.6 system-ui,"Noto Naskh Arabic",sans-serif}</style>' +
    `</head><body>\n${body.join('\n')}\n</body></html>\n`;
}

function mdEscape(text: string): string {
  return text.replace(/([\\`*_[\]#>|])/g, '\\$1');
}

/** Markdown of the document: headings, lists, bold/italic/strike runs. */
export function toMarkdown(model: DocModel, outlines: ReadonlyArray<number | undefined> = []): string {
  const blocks: DocBlock[] = model.blocks ?? model.paragraphs.map((text, id) => ({ id, runs: [{ t: 'text', text, props: {} }] }));
  const lines: string[] = [];
  let n = 0;
  blocks.forEach((block, i) => {
    const format = model.formats?.[i];
    let inner = block.runs.map((r) => {
      if (r.t !== 'text') return mdEscape(r.text);
      let s = mdEscape(r.text);
      if (!s.trim()) return s;
      if (r.props.b) s = `**${s}**`;
      if (r.props.i) s = `*${s}*`;
      if (r.props.strike) s = `~~${s}~~`;
      return s;
    }).join('').replace(/\n/g, '  \n');
    const level = headingLevel(format, outlines[i]);
    if (format?.list === 'number') { n++; inner = `${n}. ${inner}`; } else n = 0;
    if (format?.list === 'bullet') inner = `- ${inner}`;
    else if (level) inner = `${'#'.repeat(level)} ${inner}`;
    lines.push(inner);
    if (!format?.list) lines.push('');
  });
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Plain text of a document, one paragraph per line. */
export function toPlainText(model: DocModel): string {
  return `${(model.blocks ?? []).map(blockText).join('\n')}\n`;
}
