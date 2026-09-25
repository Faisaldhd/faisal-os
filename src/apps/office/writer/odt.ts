/**
 * Writer — exporting a document as OpenDocument Text (تصدير `.odt`).
 *
 * An `.odt` is a ZIP whose **first entry is `mimetype`, stored uncompressed** — readers refuse the
 * file otherwise — followed by `META-INF/manifest.xml`, `content.xml`, `styles.xml` and `meta.xml`.
 * The archive is built with the app's own codec (`writeZip` stores every entry, method 0), so the
 * `mimetype` rule is satisfied by construction and no second ZIP path exists.
 *
 * This module is pure: the model goes in, bytes come out, no DOM. Everything the app cannot
 * honestly represent is left out rather than faked (see `toOdt`'s note), and the report says which
 * parts those are.
 *
 * ODF 1.2 is the target: the namespace declarations, `office:version`, the manifest
 * `manifest:version` and the container's media type are all written explicitly, because a reader
 * checks them.
 */
import type { DocModel, ParagraphAlign, ParagraphFormat } from '../model';
import { utf8, writeZip, type ZipInput } from '../zip';
import { headingLevel } from './export';
import { blockText, type DocBlock, type Run, type RunProps } from './types';

/** The container's media type — also the exact content of the first ZIP entry. */
export const ODT_MIME = 'application/vnd.oasis.opendocument.text';
/** The ODF version every part and the manifest declare. */
export const ODT_VERSION = '1.2';
/** What `meta:generator` says: this app's own name; no library credit is claimed. */
export const ODT_GENERATOR = 'Fai$al OS — Office (Writer)';

export interface OdtOptions {
  /** Written to `dc:title`, defaulted so the field always exists. */
  title?: string;
  /** ISO timestamp for `meta:creation-date`; passed in so the bytes stay reproducible in tests. */
  created?: string;
  /** Extra lines for `meta:keyword`. */
  keywords?: string[];
}

/* ─────────────────────────────── XML plumbing ─────────────────────────────── */

/**
 * The text of one XML document: the five predefined entities, plus the control characters XML 1.0
 * forbids (dropped rather than smuggled through, which would make the part unparseable).
 */
export function xmlEscape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A run's text as ODF character data: a tab becomes `<text:tab/>`, a line break `<text:line-break/>`
 * and a run of two or more spaces `<text:s text:c="n"/>` — XML would collapse plain spaces and the
 * document would lose its spacing.
 */
export function odtText(text: string): string {
  let out = '';
  for (const part of text.split(/(\t|\r\n|\n|\r| {2,})/)) {
    if (!part) continue;
    if (part === '\t') out += '<text:tab/>';
    else if (part === '\n' || part === '\r' || part === '\r\n') out += '<text:line-break/>';
    else if (/^ {2,}$/.test(part)) out += `<text:s text:c="${part.length}"/>`;
    else out += xmlEscape(part);
  }
  return out;
}

/** The alignment a reader must apply: ODF is logical, the model's align is what the owner sees. */
export function logicalAlign(align: ParagraphAlign | null | undefined, rtl: boolean): string | null {
  if (!align) return null;
  if (align === 'center' || align === 'justify') return align;
  if (!rtl) return align === 'left' ? 'start' : 'end';
  return align === 'left' ? 'end' : 'start';
}

/** The highlight colours this app knows, as ODF background colours (an unknown name is skipped). */
const HIGHLIGHTS: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff',
  red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000',
  darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080',
  lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

const HEADING_STYLES = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6'] as const;
const IMAGE_TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' } as const;

/** A picture name that cannot escape `Pictures/`, with its extension kept. */
export function safeImageName(name: string, ext: keyof typeof IMAGE_TYPES): string {
  const stem = (name || 'image').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'image';
  return `${stem}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

/* ────────────────────────────── the parts ────────────────────────────── */

/** A part of the package that the manifest must declare (everything except `mimetype`). */
export interface OdtPart { path: string; type: string }

/** The manifest lists the container itself plus each part with its media type. */
export function odtManifestXml(parts: readonly OdtPart[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">',
    `  <manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${ODT_MIME}"/>`,
  ];
  for (const part of parts) {
    lines.push(`  <manifest:file-entry manifest:full-path="${xmlEscape(part.path)}" manifest:media-type="${xmlEscape(part.type)}"/>`);
  }
  lines.push('</manifest:manifest>', '');
  return lines.join('\n');
}

/** `meta.xml`: title, generator and dates — the fields a reader shows in its properties dialog. */
export function odtMetaXml(options: OdtOptions = {}): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    '  xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"',
    '  xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">',
    '  <office:meta>',
    `    <dc:title>${xmlEscape(options.title?.trim() || 'Untitled')}</dc:title>`,
    `    <meta:generator>${xmlEscape(ODT_GENERATOR)}</meta:generator>`,
  ];
  if (options.created) lines.push(`    <meta:creation-date>${xmlEscape(options.created)}</meta:creation-date>`);
  for (const keyword of options.keywords ?? []) lines.push(`    <meta:keyword>${xmlEscape(keyword)}</meta:keyword>`);
  lines.push('  </office:meta>', '</office:document-meta>', '');
  return lines.join('\n');
}

/**
 * `styles.xml`: the named styles a reader resolves — the standard paragraph style, the six heading
 * levels, and the two list styles the Writer's list buttons map to. Without the list styles the
 * lists would be plain paragraphs; without `style:writing-mode` an Arabic paragraph would be laid
 * out left-to-right however its characters are aligned.
 */
export function odtStylesXml(): string {
  const heading = (level: number, size: number): string[] => [
    `    <style:style style:name="Heading${level}" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="${level}">`,
    '      <style:paragraph-properties fo:margin-top="0.35cm" fo:margin-bottom="0.18cm" fo:keep-with-next-page="always"/>',
    `      <style:text-properties fo:font-size="${size}pt" fo:font-weight="bold"/>`,
    '    </style:style>',
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    '  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
    '  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
    '  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
    `  office:version="${ODT_VERSION}">`,
    '  <office:styles>',
    '    <style:default-style style:family="paragraph">',
    '      <style:paragraph-properties fo:orphans="2" fo:widows="2" style:writing-mode="page"/>',
    '      <style:text-properties fo:font-size="12pt" fo:language="ar" fo:country="SA"/>',
    '    </style:default-style>',
    '    <style:style style:name="Standard" style:family="paragraph" style:class="text"/>',
    ...heading(1, 20), ...heading(2, 17), ...heading(3, 15),
    ...heading(4, 13), ...heading(5, 12), ...heading(6, 11),
    '    <text:list-style style:name="LBullet">',
    '      <text:list-level-style-bullet text:level="1" text:bullet-char="•">',
    '        <style:list-level-properties text:space-before="0.6cm" text:min-label-width="0.6cm"/>',
    '      </text:list-level-style-bullet>',
    '    </text:list-style>',
    '    <text:list-style style:name="LNumber">',
    '      <text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix=".">',
    '        <style:list-level-properties text:space-before="0.6cm" text:min-label-width="0.6cm"/>',
    '      </text:list-level-style-number>',
    '    </text:list-style>',
    '  </office:styles>',
    '</office:document-styles>',
    '',
  ].join('\n');
}

/* ─────────────────────── the body and its automatic styles ─────────────────────── */

/**
 * Collects the automatic styles the body asks for, numbering them by first use so the same document
 * always produces the same bytes (which is what makes them testable).
 */
class StyleBook {
  private readonly auto: string[] = [];
  private readonly names = new Map<string, string>();

  private nameFor(kind: string, key: string): string {
    const existing = this.names.get(`${kind}:${key}`);
    if (existing) return existing;
    const name = `${kind}${this.names.size + 1}`;
    this.names.set(`${kind}:${key}`, name);
    return name;
  }

  paragraphStyle(format: ParagraphFormat | undefined, outline: number | undefined): string {
    const level = headingLevel(format, outline);
    const rtl = format?.dir === 'rtl';
    const align = logicalAlign(format?.align, rtl);
    const line = typeof format?.line === 'number' && format.line > 1 ? Math.round(format.line * 100) : 0;
    const parent = level ? HEADING_STYLES[Math.min(6, level) - 1] : 'Standard';
    const key = `${parent}|${rtl ? 'rtl' : 'ltr'}|${align ?? ''}|${line}`;
    const found = this.names.get(`P:${key}`);
    if (found) return found;
    const name = this.nameFor('P', key);
    const properties = [
      rtl ? 'style:writing-mode="rl-tb"' : 'style:writing-mode="lr-tb"',
      align ? `fo:text-align="${align}"` : '',
      line ? `fo:line-height="${line}%"` : '',
    ].filter(Boolean).join(' ');
    this.auto.push(
      `    <style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${parent}">`,
      `      <style:paragraph-properties ${properties}/>`,
      '    </style:style>',
    );
    return name;
  }

  spanStyle(props: RunProps): string | null {
    const parts: string[] = [];
    if (props.b) parts.push('fo:font-weight="bold"');
    if (props.i) parts.push('fo:font-style="italic"');
    if (props.u) parts.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
    if (props.strike) parts.push('style:text-line-through-style="solid"');
    if (props.va === 'superscript') parts.push('style:text-position="super 58%"');
    if (props.va === 'subscript') parts.push('style:text-position="sub 58%"');
    if (props.color && /^[0-9a-fA-F]{6}$/.test(props.color)) parts.push(`fo:color="#${props.color.toLowerCase()}"`);
    if (props.sz && props.sz > 0) parts.push(`fo:font-size="${Math.round(props.sz * 100) / 100}pt"`);
    if (props.font) parts.push(`fo:font-family="${xmlEscape(props.font)}"`);
    const highlight = props.hl ? HIGHLIGHTS[props.hl] : undefined;
    if (highlight) parts.push(`fo:background-color="${highlight}"`);
    if (!parts.length) return null;
    const key = parts.join(' ');
    const found = this.names.get(`T:${key}`);
    if (found) return found;
    const name = this.nameFor('T', key);
    this.auto.push(
      `    <style:style style:name="${name}" style:family="text">`,
      `      <style:text-properties ${key}/>`,
      '    </style:style>',
    );
    return name;
  }

  frameStyle(width: number, height: number): string {
    const key = `${width}x${height}`;
    const found = this.names.get(`F:${key}`);
    if (found) return found;
    const name = this.nameFor('Frame', key);
    this.auto.push(
      `    <style:style style:name="${name}" style:family="graphic">`,
      '      <style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline" style:horizontal-pos="center" style:horizontal-rel="paragraph"/>',
      '    </style:style>',
    );
    return name;
  }

  /** The table styles, always defined so a table can be written without a second pass. */
  tableStyles(): void {
    this.auto.push(
      '    <style:style style:name="TableGrid" style:family="table">',
      '      <style:table-properties table:border-model="collapsing" fo:margin-top="0.2cm" fo:margin-bottom="0.2cm"/>',
      '    </style:style>',
      '    <style:style style:name="TableCell" style:family="table-cell">',
      '      <style:table-cell-properties fo:border="0.75pt solid #000000" fo:padding="0.1cm"/>',
      '    </style:style>',
    );
  }

  get markup(): string { return this.auto.join('\n'); }
}

interface Picture { name: string; type: string; data: Uint8Array }

/** One run as ODF: character data, wrapped in a span when it carries formatting. */
function runXml(run: Run, book: StyleBook, pictures: Picture[]): string {
  if (run.t === 'text') {
    const body = odtText(run.text);
    if (!body) return '';
    const style = book.spanStyle(run.props);
    return style ? `<text:span text:style-name="${style}">${body}</text:span>` : body;
  }
  if (run.newImage) {
    const name = safeImageName(run.newImage.name, run.newImage.ext);
    if (!pictures.some((picture) => picture.name === name)) {
      pictures.push({ name, type: IMAGE_TYPES[run.newImage.ext], data: run.newImage.data });
    }
    const style = book.frameStyle(run.newImage.w, run.newImage.h);
    return `<draw:frame draw:style-name="${style}" draw:name="${xmlEscape(name)}" text:anchor-type="as-char"` +
      ` svg:width="${run.newImage.w}pt" svg:height="${run.newImage.h}pt">` +
      `<draw:image xlink:href="Pictures/${xmlEscape(name)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>` +
      '</draw:frame>';
  }
  // An opaque run that is not a picture: its words are kept, its markup (a field, a bookmark, a
  // link's target, a break) is not translated. See `toOdt`'s note.
  return odtText(run.text);
}

/** One paragraph or heading element. */
function paragraphXml(block: DocBlock, format: ParagraphFormat | undefined, outline: number | undefined, book: StyleBook, pictures: Picture[]): string {
  const level = headingLevel(format, outline);
  const style = book.paragraphStyle(format, outline);
  const inner = block.runs.map((run) => runXml(run, book, pictures)).join('');
  // The heading's level belongs to the OPENING tag only: a closing tag may carry no attributes,
  // and `</text:h text:outline-level="1">` would make the whole part unparseable.
  const heading = level > 0;
  const open = heading ? `<text:h text:outline-level="${Math.min(6, level)}"` : '<text:p';
  return `${open} text:style-name="${style}">${inner}</${heading ? 'text:h' : 'text:p'}>`;
}

interface TableRun { id: number; rows: number; cols: number; rtl: boolean; start: number; end: number }

/** One `table:table` for the blocks of one inserted table: the grid the Writer draws, as ODF. */
function tableXml(blocks: readonly DocBlock[], model: DocModel, table: TableRun, outlines: ReadonlyArray<number | undefined>, book: StyleBook, pictures: Picture[]): string {
  const rows: string[] = [];
  for (let row = 0; row < table.rows; row++) {
    const cells: string[] = [];
    for (let col = 0; col < table.cols; col++) {
      const inside: string[] = [];
      for (let i = table.start; i <= table.end; i++) {
        const cell = blocks[i].cell;
        if (!cell || cell.row !== row || cell.col !== col) continue;
        inside.push(paragraphXml(blocks[i], model.formats?.[i], outlines[i], book, pictures));
      }
      cells.push(`<table:table-cell table:style-name="TableCell" office:value-type="string">${inside.join('') || '<text:p/>'}</table:table-cell>`);
    }
    rows.push(`<table:table-row>${cells.join('')}</table:table-row>`);
  }
  return [
    `<table:table table:name="Table${table.id + 1}" table:style-name="TableGrid"${table.rtl ? ' table:align="right"' : ''}>`,
    `<table:table-column table:number-columns-repeated="${table.cols}"/>`,
    ...rows,
    '</table:table>',
  ].join('\n');
}

export interface OdtBody {
  /** The `office:text` element's contents. */
  body: string;
  /** The automatic styles the body asked for. */
  styles: string;
  /** The pictures that must travel in `Pictures/`, in the order they were first met. */
  pictures: Picture[];
}

/**
 * The document body: paragraphs, headings, lists (grouped exactly the way the Writer's list buttons
 * mean them), the tables the model carries, and the pictures inserted in this session.
 */
export function odtBodyXml(model: DocModel, outlines: ReadonlyArray<number | undefined> = []): OdtBody {
  const blocks: DocBlock[] = model.blocks ?? model.paragraphs.map((text, id) => ({ id, runs: [{ t: 'text', text, props: {} }] }));
  const book = new StyleBook();
  const pictures: Picture[] = [];
  const out: string[] = [];
  book.tableStyles();
  let list: 'bullet' | 'number' | null = null;
  let table: TableRun | null = null;

  const closeList = (): void => { if (list) { out.push('</text:list>'); list = null; } };
  const closeTable = (): void => {
    if (!table) return;
    out.push(tableXml(blocks, model, table, outlines, book, pictures));
    table = null;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const format = model.formats?.[i];
    const cell = block.cell;

    if (!cell) {
      closeTable();
      const want = format?.list === 'bullet' ? 'bullet' : format?.list === 'number' ? 'number' : null;
      if (list && list !== want) closeList();
      const paragraph = paragraphXml(block, format, outlines[i], book, pictures);
      if (want) {
        if (!list) { out.push(`<text:list text:style-name="${want === 'bullet' ? 'LBullet' : 'LNumber'}">`); list = want; }
        out.push(`<text:list-item>${paragraph}</text:list-item>`);
      } else {
        out.push(paragraph);
      }
      continue;
    }

    // A table cell: group the whole run of blocks that belong to the same inserted table.
    closeList();
    if (table && table.id !== cell.table) closeTable();
    if (!table) table = { id: cell.table, rows: cell.rows, cols: cell.cols, rtl: Boolean(cell.rtl), start: i, end: i };
    table.end = i;
    table.rows = Math.max(table.rows, cell.rows);
    table.cols = Math.max(table.cols, cell.cols);
    table.rtl = table.rtl || Boolean(cell.rtl);
  }
  closeTable();
  closeList();
  return { body: out.join('\n'), styles: book.markup, pictures };
}

/** `content.xml`: the automatic styles the body asked for, then the body itself. */
export function odtContentXml(model: DocModel, outlines: ReadonlyArray<number | undefined> = []): string {
  const { body, styles } = odtBodyXml(model, outlines);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    '  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
    '  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
    '  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
    '  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
    '  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
    '  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
    '  xmlns:xlink="http://www.w3.org/1999/xlink"',
    `  office:version="${ODT_VERSION}">`,
    '  <office:automatic-styles>',
    styles,
    '  </office:automatic-styles>',
    '  <office:body>',
    '    <office:text>',
    body,
    '    </office:text>',
    '  </office:body>',
    '</office:document-content>',
    '',
  ].join('\n');
}

/** The document's own first line, for `dc:title` when the owner did not name the file. */
export function odtTitleOf(model: DocModel, fallback: string): string {
  const first = (model.blocks ?? [])[0];
  return (first ? blockText(first).trim() : '') || fallback;
}

/**
 * The `.odt` bytes of a document.
 *
 * Exported: paragraphs with their alignment and direction (`style:writing-mode="rl-tb"` on an RTL
 * paragraph, so an Arabic document is not laid out left-to-right), heading levels, run formatting
 * (bold, italic, underline, strike, colour, size, font, highlight, super/subscript), bullet and
 * numbered lists as real `text:list`s, the tables inserted in this session, and the pictures
 * inserted in this session (their bytes travel with the model).
 *
 * NOT exported, stated rather than faked: hyperlink targets, fields, bookmarks and comments (their
 * words are kept, their markup is not translated), pictures that live only in the original `.docx`
 * (the model carries no bytes for them), and the structure the app itself cannot rewrite (a text
 * box's host, `DocBlock.locked`).
 */
export function toOdt(model: DocModel, options: OdtOptions = {}): Uint8Array {
  const { pictures } = odtBodyXml(model);
  const parts: OdtPart[] = [
    { path: 'content.xml', type: 'text/xml' },
    { path: 'styles.xml', type: 'text/xml' },
    { path: 'meta.xml', type: 'text/xml' },
    { path: 'META-INF/manifest.xml', type: 'text/xml' },
    ...pictures.map((picture) => ({ path: `Pictures/${picture.name}`, type: picture.type })),
  ];
  const entries: ZipInput[] = [
    // FIRST and stored — `writeZip` never compresses, which is exactly what the ODF rule demands.
    { name: 'mimetype', data: utf8(ODT_MIME) },
    { name: 'META-INF/manifest.xml', data: utf8(odtManifestXml(parts)) },
    { name: 'content.xml', data: utf8(odtContentXml(model)) },
    { name: 'styles.xml', data: utf8(odtStylesXml()) },
    { name: 'meta.xml', data: utf8(odtMetaXml(options)) },
    ...pictures.map((picture) => ({ name: `Pictures/${picture.name}`, data: picture.data })),
  ];
  return writeZip(entries);
}
