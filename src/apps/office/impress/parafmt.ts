/**
 * Impress — paragraph formatting: the model's look, applied to the XML of a paragraph.
 *
 * The slide editor keeps one `DeckPara` per paragraph (bold, italic, underline, size, colour,
 * alignment), and the surgical save edits the package in place. That patch path starts from the
 * bytes the file already has, so a formatting change has to be written *into* the existing
 * `<a:p>` — the text has not changed and a rebuild would throw away everything the model does
 * not carry (bullet characters, hyperlinks, language tags).
 *
 * Everything here is pure string work over one paragraph, which is what makes it testable
 * without a browser or a file:
 *   • `styleParagraphXml` rewrites `<a:pPr>` (alignment + Arabic direction) and every
 *     `<a:rPr>`/`<a:endParaRPr>` (b/i/u/sz + colour) and touches nothing else;
 *   • `sameParaStyle` is what the patch uses to notice that only the look changed;
 *   • `autoAlign` gives Arabic its right alignment without anyone asking.
 */
import { applyEdits, elements, parsePart, type XmlEdit } from '../xmlscan';
import { child, type Align, type DeckPara } from './deck';

/** Arabic (and Arabic Supplement/Extended) letters decide the paragraph's direction. */
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const hex = (c: string): string => c.replace('#', '').toUpperCase();

/**
 * A colour as the model keeps it: `#RRGGBB`.
 *
 * The ribbon's colour control speaks bare hex (`C00000`, the way Writer keeps its runs) and the
 * file reader speaks `#C00000`. The model keeps only the second, because that is the string every
 * painting path hands to CSS — a bare `C00000` is not a colour the browser accepts, so the run
 * silently kept the inherited one on screen while the saved file carried the right value.
 */
export function modelColor(value: string | null): string | null {
  const bare = value ? hex(value) : '';
  return /^[0-9A-F]{6}$/.test(bare) ? `#${bare}` : null;
}

/** The reverse: the bare `RRGGBB` a colour control reads, since it prefixes its own `#`. */
export function controlColor(value: string | null): string | null {
  return value ? hex(value) : null;
}

/** The run properties this editor owns. */
export type ParaStylePatch = Partial<Pick<DeckPara, 'bold' | 'italic' | 'underline' | 'size' | 'color' | 'align'>>;

/** One attribute of an open tag: set, replaced, or removed when `value` is null. */
export function setAttrText(attrs: string, name: string, value: string | null): string {
  const re = new RegExp(`\\s${name}="[^"]*"`);
  if (value === null) return re.test(attrs) ? attrs.replace(re, '') : attrs;
  const rest = attrs.trimEnd();
  if (re.test(rest)) return rest.replace(re, ` ${name}="${value}"`);
  return rest ? `${rest} ${name}="${value}"` : ` ${name}="${value}"`;
}

/** The attributes of a run-properties tag, carrying this paragraph's look. */
function runAttrs(attrs: string, p: DeckPara): string {
  const bare = attrs.trimEnd().replace(/\/$/, '');
  return setAttrText(
    setAttrText(
      setAttrText(
        setAttrText(bare, 'b', p.bold ? '1' : null),
        'i', p.italic ? '1' : null,
      ),
      'u', p.underline ? 'sng' : null,
    ),
    'sz', p.size ? String(Math.round(p.size * 100)) : null,
  );
}

/**
 * `<a:rPr …>` or `<a:endParaRPr …>` rewritten from the model: the four attributes this editor
 * owns are set or cleared, the colour child is replaced, and every other attribute and child
 * (language, dirty, latin/ea fonts, hyperlinks) is left exactly as the file had it.
 */
export function styleRunTag(tag: string, p: DeckPara): string {
  const open = /^<([A-Za-z0-9:_.-]+)([^>]*)>/.exec(tag);
  if (!open) return tag;
  const name = open[1];
  const selfClosing = open[2].trimEnd().endsWith('/');
  const attrs = runAttrs(open[2], p);
  const fill = p.color ? `<a:solidFill><a:srgbClr val="${hex(p.color)}"/></a:solidFill>` : '';
  if (selfClosing) return fill ? `<${name}${attrs}>${fill}</${name}>` : `<${name}${attrs}/>`;
  const body = tag.slice(open[0].length, tag.length - `</${name}>`.length)
    .replace(/<a:solidFill\b[^>]*\/>/g, '')
    .replace(/<a:solidFill\b[\s\S]*?<\/a:solidFill>/g, '');
  return `<${name}${attrs}>${fill}${body}</${name}>`;
}

/** `<a:pPr …>` attributes for this paragraph: its alignment and, for Arabic, `rtl="1"`. */
function paraAttrs(p: DeckPara, raw: string): string {
  const withAlign = setAttrText(raw.trimEnd().replace(/\/$/, ''), 'algn', p.align ?? null);
  return setAttrText(withAlign, 'rtl', ARABIC.test(p.text) ? '1' : null);
}

/** One element with its own attributes replaced, its children untouched. */
function withAttrs(elementXml: string, attrs: string): string {
  const open = /^<([A-Za-z0-9:_.-]+)([^>]*)>/.exec(elementXml);
  if (!open) return elementXml;
  const name = open[1];
  if (open[2].trimEnd().endsWith('/')) return attrs ? `<${name} ${attrs}/>` : `<${name}/>`;
  const body = elementXml.slice(open[0].length, elementXml.length - `</${name}>`.length);
  return attrs ? `<${name} ${attrs}>${body}</${name}>` : `<${name}>${body}</${name}>`;
}

/**
 * One `<a:p>` with this paragraph's look, everything else preserved.
 *
 * The paragraph's own `<a:pPr>` is rewritten when it exists (its bullet and spacing children
 * stay); when the paragraph has none and the model asks for something, an empty one is added so
 * PowerPoint sees the alignment.
 */
export function styleParagraphXml(xml: string, p: DeckPara): string {
  const doc = parsePart(xml);
  const root = doc.roots[0];
  if (!root) return xml;
  const edits: XmlEdit[] = [];
  for (const tag of [...elements(doc, 'rPr'), ...elements(doc, 'endParaRPr')]) {
    edits.push({ start: tag.start, end: tag.end, xml: styleRunTag(xml.slice(tag.start, tag.end), p) });
  }
  const pPr = child(root, 'pPr');
  const wanted = p.align !== null || ARABIC.test(p.text);
  if (pPr) {
    const open = /^<[A-Za-z0-9:_.-]+([^>]*)>/.exec(xml.slice(pPr.start, pPr.end));
    edits.push({ start: pPr.start, end: pPr.end, xml: withAttrs(xml.slice(pPr.start, pPr.end), paraAttrs(p, open?.[1] ?? '')) });
  } else if (wanted) {
    const open = /^<[A-Za-z0-9:_.-]+[^>]*>/.exec(xml);
    if (open) edits.push({ start: open[0].length, end: open[0].length, xml: `<a:pPr${paraAttrs(p, '')}/>` });
  }
  return edits.length ? applyEdits(xml, edits) : xml;
}

/** True when two paragraphs look the same, whatever their text says. */
export function sameParaStyle(a: DeckPara, b: DeckPara): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline
    && a.size === b.size && a.align === b.align && hex(a.color ?? '') === hex(b.color ?? '');
}

/**
 * The alignment a paragraph gets as it is typed: an explicit choice always wins, and otherwise
 * Arabic text is right-aligned — the owner's "Arabic first" rule, applied where it is seen.
 */
export function autoAlign(text: string, align: Align | null): Align | null {
  if (align !== null) return align;
  return ARABIC.test(text) ? 'r' : null;
}

/** The look shared by a shape's paragraphs, and whether they disagree (`mixed`). */
export interface ParaStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  size: number | null;
  color: string | null;
  align: Align | null;
  mixed: boolean;
}

/**
 * What the ribbon shows for a selection: the first paragraph's look, with `mixed` telling the
 * truth when the paragraphs differ (a shape holds one paragraph today, a table cell may not).
 */
export function paraStyleOf(paras: readonly DeckPara[]): ParaStyle | null {
  const first = paras[0];
  if (!first) return null;
  const mixed = paras.some((p) => p.bold !== first.bold || p.italic !== first.italic
    || p.underline !== first.underline || p.size !== first.size || p.color !== first.color || p.align !== first.align);
  return {
    bold: first.bold, italic: first.italic, underline: first.underline,
    size: first.size, color: first.color, align: first.align, mixed,
  };
}
