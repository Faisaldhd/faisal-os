/**
 * Writer — importing OpenDocument Text (استيراد `.odt`).
 *
 * The mirror of `odt.ts`, built from the two tools the app already has: the ZIP reader
 * (`readRawZip` + `entryData`, which inflates a deflated part) and the namespace-agnostic XML
 * scanner (`parsePart`) — so no library is added and there is no second package reader.
 *
 * `content.xml` holds the document; the styles hold what the text MEANS. A paragraph's
 * `text:style-name` resolves to `style:writing-mode` (an Arabic paragraph must stay right-to-left,
 * not only aligned), to `fo:text-align`, to line spacing and to a heading level; a span's style
 * resolves to bold/italic/underline/strike/colour/size/font/highlight; a `text:list` becomes the
 * Writer's list format; a `table:table` becomes the cell blocks the Writer draws as a grid; a
 * `draw:frame` with `draw:image` becomes a picture whose bytes come from `Pictures/`.
 *
 * A document is a round trip: what `toOdt` writes, `readOdt` reads back into the same model.
 */
import type { ParagraphAlign, ParagraphFormat } from '../model';
import { entryData, readRawZip, type RawZip } from '../zip';
import { attr, attrLocal, elementText, localName, parsePart, type XmlDoc, type XmlElement } from '../xmlscan';
import type { DocBlock, Run, RunProps } from './types';

/** What the reader produced: the same shape the Writer's model already uses for a Word document. */
export interface OdtDocument {
  paragraphs: string[];
  formats: Record<number, ParagraphFormat>;
  blocks: DocBlock[];
}

/** Why an `.odt` could not be read: not an ODF text package at all, or its XML cannot be walked. */
export type OdtRefusal = 'notOdt' | 'damaged';

export type OdtReadResult = { ok: true; document: OdtDocument } | { ok: false; refusal: OdtRefusal };

const ODF_TEXT_TYPE = 'application/vnd.oasis.opendocument.text';

const HIGHLIGHT_NAMES: Record<string, string> = {
  '#ffff00': 'yellow', '#00ff00': 'green', '#00ffff': 'cyan', '#ff00ff': 'magenta', '#0000ff': 'blue',
  '#ff0000': 'red', '#000080': 'darkBlue', '#008080': 'darkCyan', '#008000': 'darkGreen',
  '#800080': 'darkMagenta', '#800000': 'darkRed', '#808000': 'darkYellow', '#808080': 'darkGray',
  '#c0c0c0': 'lightGray', '#000000': 'black', '#ffffff': 'white',
};

/** A style element together with the part it was read from, because attributes are read from text. */
interface StyleRef { element: XmlElement; xml: string }

/** Every element with this local name under `root`, in document order. */
function elementsOf(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (element: XmlElement): void => {
    for (const child of element.children) {
      if (localName(child.name) === name) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Every `style:style` and `text:list-style` of one part, keyed by its `style:name`. */
function stylesOf(doc: XmlDoc, xml: string): Map<string, StyleRef> {
  const out = new Map<string, StyleRef>();
  for (const root of doc.roots) {
    for (const style of [...elementsOf(root, 'style'), ...elementsOf(root, 'list-style')]) {
      const name = attrLocal(xml, style, 'name');
      if (name) out.set(name, { element: style, xml });
    }
  }
  return out;
}

/** The first element with this local name anywhere in the part, or null. */
function firstElement(doc: XmlDoc, name: string): XmlElement | null {
  for (const root of doc.roots) {
    if (localName(root.name) === name) return root;
    const found = elementsOf(root, name)[0];
    if (found) return found;
  }
  return null;
}

const childrenNamed = (element: XmlElement, name: string): XmlElement[] =>
  element.children.filter((child) => localName(child.name) === name);

/** The text inside an element's own tags, with the predefined entities decoded. */
function decoded(xml: string, element: XmlElement): string {
  return elementText(xml, element)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Direction, alignment, line spacing and heading level a paragraph style states. */
function paragraphFacts(style: StyleRef | undefined): Pick<ParagraphFormat, 'dir' | 'align' | 'line' | 'style'> {
  const facts: Pick<ParagraphFormat, 'dir' | 'align' | 'line' | 'style'> = {};
  if (!style) return facts;
  let rtl = false;
  for (const properties of elementsOf(style.element, 'paragraph-properties')) {
    const writing = attrLocal(style.xml, properties, 'writing-mode');
    if (writing === 'rl-tb') rtl = true;
    if (writing === 'lr-tb') rtl = false;
    const align = attrLocal(style.xml, properties, 'text-align');
    if (align === 'center' || align === 'justify' || align === 'left' || align === 'right') facts.align = align;
    // ODF is logical: "start" is the right edge of a right-to-left paragraph, which is what the
    // Writer's align means (it stores what the owner sees).
    else if (align === 'start') facts.align = rtl ? 'right' : 'left';
    else if (align === 'end') facts.align = rtl ? 'left' : 'right';
    const line = attrLocal(style.xml, properties, 'line-height');
    if (line?.endsWith('%')) {
      const value = Math.round((Number(line.slice(0, -1)) / 100) * 100) / 100;
      if (value > 1) facts.line = value;
    }
  }
  facts.dir = rtl ? 'rtl' : 'ltr';
  const level = attrLocal(style.xml, style.element, 'default-outline-level');
  if (level && Number(level) >= 1) facts.style = `Heading${Math.min(6, Number(level))}`;
  return facts;
}

/** The run properties a text style states. */
function runFacts(style: StyleRef | undefined): RunProps {
  const props: RunProps = {};
  if (!style) return props;
  for (const properties of elementsOf(style.element, 'text-properties')) {
    const weight = attrLocal(style.xml, properties, 'font-weight');
    if (weight === 'bold' || weight === '700') props.b = true;
    const fontStyle = attrLocal(style.xml, properties, 'font-style');
    if (fontStyle === 'italic' || fontStyle === 'oblique') props.i = true;
    const underline = attrLocal(style.xml, properties, 'text-underline-style');
    if (underline && underline !== 'none') props.u = true;
    const strike = attrLocal(style.xml, properties, 'text-line-through-style');
    if (strike && strike !== 'none') props.strike = true;
    const color = attrLocal(style.xml, properties, 'color');
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) props.color = color.slice(1).toUpperCase();
    const size = attrLocal(style.xml, properties, 'font-size');
    if (size?.endsWith('pt')) {
      const value = Number(size.slice(0, -2));
      if (value > 0) props.sz = value;
    }
    const font = attrLocal(style.xml, properties, 'font-family');
    if (font) props.font = font;
    const position = attrLocal(style.xml, properties, 'text-position');
    if (position?.startsWith('super')) props.va = 'superscript';
    else if (position?.startsWith('sub')) props.va = 'subscript';
    const background = attrLocal(style.xml, properties, 'background-color');
    const named = background ? HIGHLIGHT_NAMES[background.toLowerCase()] : undefined;
    if (named) props.hl = named;
  }
  return props;
}

/** The Writer's list kind a `text:list-style` means. */
function listKind(style: StyleRef | undefined): 'bullet' | 'number' | null {
  if (!style) return null;
  for (const child of style.element.children) {
    const local = localName(child.name);
    if (local === 'list-level-style-bullet') return 'bullet';
    if (local === 'list-level-style-number') return 'number';
  }
  return null;
}

/** The predefined entities and numeric character references, decoded. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Where an element's closing tag starts (the scanner reports just past it). */
const closeStartOf = (element: XmlElement): number =>
  element.selfClosing ? element.openEnd : Math.max(element.openEnd, element.end - element.name.length - 3);

/**
 * The runs of one paragraph, in order.
 *
 * The scanner reports ELEMENTS, so the text of a paragraph is the text between its children (a bare
 * text node has no element of its own) — that is what `at` walks, child by child. A `text:span`
 * carries formatting and hands it down to whatever it contains (a nested span's own style wins);
 * `text:s`, `text:tab` and `text:line-break` become the spacing they mean; a frame becomes a picture.
 */
function walkInline(
  parent: XmlElement,
  xml: string,
  inherited: RunProps,
  out: Run[],
  styles: Map<string, StyleRef>,
  pictures: Pictures,
): void {
  const push = (text: string, props: RunProps): void => {
    if (text) out.push({ t: 'text', text, props: { ...props } });
  };
  let at = parent.openEnd;
  for (const child of parent.children) {
    push(decodeEntities(xml.slice(at, child.start)), inherited);
    const local = localName(child.name);
    if (local === 'span' || local === 'a') {
      const name = attrLocal(xml, child, 'style-name') ?? '';
      walkInline(child, xml, { ...inherited, ...runFacts(styles.get(name)) }, out, styles, pictures);
    } else if (local === 's') {
      push(' '.repeat(Math.max(1, Number(attr(xml, child, 'text:c') ?? '1') || 1)), inherited);
    } else if (local === 'tab') {
      push('\t', inherited);
    } else if (local === 'line-break') {
      push('\n', inherited);
    } else if (local === 'frame') {
      const run = readFrame(child, xml, pictures);
      if (run) out.push(run);
    } else {
      walkInline(child, xml, inherited, out, styles, pictures);
    }
    at = Math.max(at, child.end);
  }
  push(decodeEntities(xml.slice(at, closeStartOf(parent))), inherited);
}

interface Pictures { get(href: string): { data: Uint8Array; type: string } | undefined }

/** A `draw:frame` with a `draw:image`: a picture run, its bytes taken from `Pictures/`. */
function readFrame(frame: XmlElement, xml: string, pictures: Pictures): Run | null {
  const image = elementsOf(frame, 'image')[0];
  if (!image) return null;
  const href = attrLocal(xml, image, 'href') ?? '';
  const points = (value: string | null): number => {
    const number = Number((value ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : 0;
  };
  const width = points(attrLocal(xml, frame, 'width'));
  const height = points(attrLocal(xml, frame, 'height'));
  const stored = pictures.get(href);
  const run: Run = { t: 'opaque', text: '', xml: '', kind: 'image', image: { w: width, h: height } };
  if (stored) {
    const ext = stored.type === 'image/jpeg' ? 'jpeg' : stored.type === 'image/gif' ? 'gif' : 'png';
    run.newImage = { data: stored.data, ext, w: width, h: height, name: href.replace(/^Pictures\//, '') };
  }
  return run;
}

/** One paragraph (or heading) as runs + its format. */
function readParagraph(
  element: XmlElement,
  xml: string,
  contentStyles: Map<string, StyleRef>,
  namedStyles: Map<string, StyleRef>,
  pictures: Pictures,
  extra: Partial<ParagraphFormat> = {},
): { block: DocBlock; format: ParagraphFormat } {
  const styleName = attrLocal(xml, element, 'style-name') ?? '';
  const style = contentStyles.get(styleName) ?? namedStyles.get(styleName);
  const format: ParagraphFormat = { ...paragraphFacts(style), ...extra };
  const level = localName(element.name) === 'h'
    ? Math.min(6, Number(attrLocal(xml, element, 'outline-level') ?? '1') || 1)
    : undefined;
  if (level) format.style = `Heading${level}`;

  const runs: Run[] = [];
  walkInline(element, xml, {}, runs, new Map([...contentStyles, ...namedStyles]), pictures);
  // Adjacent unformatted pieces (the text before and after a span, a wrapped line) are one run:
  // an edit in the Writer should not have to scroll through fragments that mean nothing.
  const merged: Run[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (run.t === 'text' && previous?.t === 'text' && !Object.keys(run.props).length && !Object.keys(previous.props).length) previous.text += run.text;
    else merged.push(run);
  }
  return { block: { id: 0, runs: merged }, format };
}

/**
 * Reads an `.odt` package into the Writer's model.
 *
 * `notOdt` when the archive is not an OpenDocument TEXT package (no `mimetype`, or its media type is
 * a spreadsheet/deck, or `content.xml` is missing) — a `.ods` opened here would otherwise be shown
 * as an empty document. `damaged` when the XML cannot be walked.
 */
export async function readOdt(bytes: Uint8Array): Promise<OdtReadResult> {
  let archive: RawZip;
  try {
    archive = readRawZip(bytes);
  } catch {
    return { ok: false, refusal: 'notOdt' };
  }
  if (!archive.entries.some((entry) => entry.name === 'mimetype')) return { ok: false, refusal: 'notOdt' };
  try {
    const mime = new TextDecoder().decode((await entryData(archive, 'mimetype')) ?? new Uint8Array(0)).trim();
    if (mime !== ODF_TEXT_TYPE) return { ok: false, refusal: 'notOdt' };
    const contentBytes = await entryData(archive, 'content.xml');
    if (!contentBytes) return { ok: false, refusal: 'notOdt' };

    const contentXml = new TextDecoder().decode(contentBytes);
    const content = parsePart(contentXml);
    const contentStyles = stylesOf(content, contentXml);
    const stylesBytes = await entryData(archive, 'styles.xml');
    const stylesXml = stylesBytes ? new TextDecoder().decode(stylesBytes) : '';
    const namedStyles = stylesXml ? stylesOf(parsePart(stylesXml), stylesXml) : new Map<string, StyleRef>();

    const pictures = new Map<string, { data: Uint8Array; type: string }>();
    for (const entry of archive.entries) {
      if (!entry.name.startsWith('Pictures/')) continue;
      const data = await entryData(archive, entry.name);
      if (!data) continue;
      const type = /\.jpe?g$/i.test(entry.name) ? 'image/jpeg' : /\.gif$/i.test(entry.name) ? 'image/gif' : 'image/png';
      pictures.set(entry.name, { data, type });
    }

    const body = firstElement(content, 'text');
    if (!body) return { ok: false, refusal: 'notOdt' };

    const blocks: DocBlock[] = [];
    const formats: Record<number, ParagraphFormat> = {};
    const add = (read: { block: DocBlock; format: ParagraphFormat }): void => {
      read.block.id = blocks.length;
      blocks.push(read.block);
      if (Object.keys(read.format).length) formats[read.block.id] = read.format;
    };
    const readInto = (element: XmlElement, extra: Partial<ParagraphFormat> = {}): void =>
      add(readParagraph(element, contentXml, contentStyles, namedStyles, pictures, extra));

    let table = 0;
    for (const child of body.children) {
      switch (localName(child.name)) {
        case 'p':
        case 'h':
          readInto(child);
          break;
        case 'list': {
          const styleName = attrLocal(contentXml, child, 'style-name') ?? '';
          const kind = listKind(contentStyles.get(styleName) ?? namedStyles.get(styleName)) ?? 'bullet';
          for (const item of childrenNamed(child, 'list-item')) {
            for (const paragraph of item.children) {
              if (localName(paragraph.name) === 'p' || localName(paragraph.name) === 'h') readInto(paragraph, { list: kind });
            }
          }
          break;
        }
        case 'table': {
          const rows = childrenNamed(child, 'table-row');
          const rtl = attrLocal(contentXml, child, 'align') === 'right';
          const cols = Math.max(1, ...rows.map((row) => childrenNamed(row, 'table-cell').length));
          rows.forEach((row, rowIndex) => {
            childrenNamed(row, 'table-cell').forEach((cell, colIndex) => {
              const inner = cell.children.filter((node) => localName(node.name) === 'p' || localName(node.name) === 'h');
              // Every cell must exist as a block: the Writer's grid is drawn from its cell blocks,
              // so an empty cell keeps its place instead of shifting the row.
              if (!inner.length) {
                add({ block: { id: 0, runs: [{ t: 'text', text: '', props: {} }] }, format: {} });
              } else {
                for (const paragraph of inner) readInto(paragraph);
              }
              blocks[blocks.length - 1].cell = { table, row: rowIndex, col: colIndex, rows: rows.length, cols, rtl };
            });
          });
          table++;
          break;
        }
        default:
          // A section, a soft page break, anything else at body level: its paragraphs are kept, so a
          // structure this writer does not model is never silently emptied.
          for (const paragraph of elementsOf(child, 'p')) readInto(paragraph);
          break;
      }
    }

    const paragraphs = blocks.map((block) => block.runs.map((run) => run.text).join(''));
    return { ok: true, document: { paragraphs, formats, blocks } };
  } catch {
    return { ok: false, refusal: 'damaged' };
  }
}
